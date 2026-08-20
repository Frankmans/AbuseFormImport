// ==UserScript==
// @name         Wayfarer Abuse Report Extractor
// @namespace    https://wayfarer.nianticlabs.com/new
// @version      1.1.0
// @description  Scans emails already imported by Wayfarer Abuse Email Importer for Niantic Support "Reporting Abuse" tickets, extracts the reported Wayspot name + coordinates, stores them locally, and exports as CSV.
// @author       you
// @match        https://wayfarer.nianticlabs.com/new/mapview*
// @require      https://gitlab.com/Tntnnbltn/wayfarer-addons/-/raw/main/wayfarer-map-mods-base.user.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wst-storage.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js
// ==/UserScript==

/*
 * Companion to wayfarer-abuse-email-importer.user.js. That script's job
 * stops at storing raw, unclassified emails; this one is the "different
 * plugin" mentioned while building it -- it does the actual work:
 *
 *   1. Reads every email already stored by the importer (WSTStorage.
 *      getAllEmails() -- same shared IndexedDB store, read-only from here).
 *   2. Classifies each with OPREmail.classify() and keeps only the ones
 *      that come back ABUSE_REPORT_* (Niantic Support's "Reporting Abuse
 *      in Wayfarer" Helpshift tickets -- see opr-email-lib.js's
 *      Style.SUPPORT section for how that classification works).
 *   3. Runs OPREmail.helpshift.parseAbuseReportEmail() on each one to pull
 *      out a best-guess Wayspot name + coordinate (see locationName /
 *      primaryCoordinate in that function -- *** BEST-EFFORT, only
 *      confirmed against one real sample *** -- the raw locationDetails/
 *      reportDetails text is kept alongside every row specifically so you
 *      can sanity-check or correct it by hand in the exported CSV).
 *   4. Stores the extracted rows in their OWN IndexedDB database (
 *      "wf-abuse-report-extract-db", separate from the importer's raw-
 *      email store, and from Tntnnbltn's own "wayfarer-tools-db" -- there
 *      was no reason to risk a version conflict opening a database this
 *      script doesn't own), keyed by conversation ID so re-scanning after
 *      importing more mail just updates rows in place rather than
 *      duplicating them.
 *   5. Exports everything currently stored as a CSV file (via a plain
 *      Blob + <a download>, no server round-trip).
 *
 * Deliberately NOT done here (out of scope for "extract + store + CSV"):
 *   - No map-plotting / Map Mods - Base integration. The importer script
 *     already exposes what you'd need for that
 *     (window.WayfarerAbuseEmailImporter.publishPoiToMap), so wiring a
 *     "show on map" button up here later is a small addition if you want
 *     it, not a redesign.
 *   - No editing UI for the extracted name/coordinates -- the raw text
 *     columns in the CSV are there so corrections happen in a spreadsheet,
 *     not in-page. Say the word if you'd rather have inline editing.
 *
 * v1.1.0 CHANGE FROM v1.0.0: this no longer has its own floating button.
 * Confirmed against Report Wayspots v3.3.0's real source -- how it adds its
 * own "Reporting History" / "Reporting Settings" entries -- Map Mods -
 * Base's side panel has a settings-links section
 * (".wfmapmods-settings-links") that any script sharing the page can just
 * appendChild a plain <a> into, once "#wfmapmods-side-panel" exists (found
 * via the same debounced MutationObserver pattern Report Wayspots uses).
 * There's no dedicated modal API to go with it, though -- Report Wayspots'
 * own openModal() is that script's local helper, not something Base
 * exposes -- so the panel itself is unchanged (same fixed-position box,
 * same Scan/Export/Clear buttons and table), just opened via that new
 * "Abuse Report Extractor" link in Base's settings section instead, with a
 * close (✕) button added since there's no toggle button to click again.
 */

(function () {
  'use strict';

  const EXTRACT_DB_NAME = 'wf-abuse-report-extract-db';
  const EXTRACT_DB_VERSION = 1;
  const EXTRACT_STORE_NAME = 'extractedReports';

  // ---------------------------------------------------------------------
  // Storage -- a small, self-contained IndexedDB store. Not reusing
  // WSTStorage for this: that library's schema (see the importer script)
  // is shaped around raw {headers, body} email records, not structured
  // extraction rows, and its source wasn't shared here to extend safely.
  // ---------------------------------------------------------------------

  function openExtractDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(EXTRACT_DB_NAME, EXTRACT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(EXTRACT_STORE_NAME)) {
          db.createObjectStore(EXTRACT_STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putExtractedRecords(records) {
    if (!records.length) return { inserted: 0, updated: 0 };
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EXTRACT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(EXTRACT_STORE_NAME);
      let inserted = 0, updated = 0;
      for (const rec of records) {
        const getReq = store.get(rec.id);
        getReq.onsuccess = () => {
          if (getReq.result) updated++; else inserted++;
          store.put(rec);
        };
        // If the existence check itself fails, still attempt the write --
        // worst case this row's inserted/updated count is off by one, not
        // worth losing the row over.
        getReq.onerror = () => store.put(rec);
      }
      tx.oncomplete = () => resolve({ inserted, updated });
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllExtractedRecords() {
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EXTRACT_STORE_NAME, 'readonly');
      const req = tx.objectStore(EXTRACT_STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearExtractedRecords() {
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EXTRACT_STORE_NAME, 'readwrite');
      tx.objectStore(EXTRACT_STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------------------------------------------------------------------
  // Scan: raw imported emails -> extracted rows
  // ---------------------------------------------------------------------

  async function scanImportedEmails(onProgress) {
    const allEmails = await WSTStorage.getAllEmails();
    const extracted = [];
    let scanned = 0;

    for (const record of allEmails) {
      scanned++;
      if (onProgress) onProgress(scanned, allEmails.length);

      let email;
      try {
        email = new OPREmail.Email(record.headers, record.body);
      } catch (e) { continue; }

      let classification;
      try {
        classification = email.classify();
      } catch (e) { continue; }
      if (!classification || typeof classification.type !== 'string' || !classification.type.startsWith('ABUSE_REPORT_')) {
        continue;
      }

      let parsed;
      try {
        parsed = OPREmail.helpshift.parseAbuseReportEmail(email);
      } catch (e) { continue; }

      const coord = parsed.primaryCoordinate;
      const id = parsed.conversationId ? `conv:${parsed.conversationId}` : `email:${record.id}`;

      extracted.push({
        id,
        conversationId: parsed.conversationId || null,
        ticketStatus: classification.type,
        wayspotName: parsed.locationName || null,
        latitude: coord ? Number(coord.latitude) : null,
        longitude: coord ? Number(coord.longitude) : null,
        issueType: parsed.issueType || null,
        locationDetails: parsed.locationDetails || null,
        reportDetails: parsed.reportDetails || null,
        sourceEmailId: record.id,
        sourceFilename: record.filename || null,
        scannedAt: Date.now(),
      });
    }

    return extracted;
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------

  const CSV_COLUMNS = [
    ['conversationId', 'Conversation ID'],
    ['ticketStatus', 'Ticket Status'],
    ['wayspotName', 'Wayspot Name (best guess)'],
    ['latitude', 'Latitude'],
    ['longitude', 'Longitude'],
    ['issueType', 'Issue Type'],
    ['locationDetails', 'Location Details (raw)'],
    ['reportDetails', 'Report Details (raw)'],
    ['sourceEmailId', 'Source Email ID'],
    ['sourceFilename', 'Source Filename'],
  ];

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function recordsToCsv(records) {
    const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
    const rows = records.map((r) => CSV_COLUMNS.map(([key]) => csvEscape(r[key])).join(','));
    return [header, ...rows].join('\r\n');
  }

  function downloadCsv(records) {
    // Leading BOM so Excel opens the UTF-8 file correctly instead of
    // guessing a legacy codepage and mangling any accented characters.
    const csv = '\uFEFF' + recordsToCsv(records);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `wayfarer-abuse-reports-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------------
  // UI -- same dark/monospace look as the importer script, "wae-" prefix
  // so nothing collides with its "wei-" ids/classes. The panel itself is
  // unchanged from before; what changed is how it's opened: instead of its
  // own floating button, a link is injected into Map Mods - Base's own
  // side panel settings section (.wfmapmods-settings-links), the same way
  // Report Wayspots adds its "Reporting History" / "Reporting Settings"
  // links -- confirmed against that real script (insertReportingHistory
  // LinkIfReady / insertReportingSettingsLinkIfReady, both appending a
  // plain <a> to that container). There's no dedicated modal API to reuse
  // from Base -- Report Wayspots' openModal() is that script's own local
  // helper, not something Base exposes -- so the panel keeps its own
  // fixed-position box rather than becoming a true modal; only the trigger
  // moved into Base's panel, plus a close button since there's no toggle
  // button to click a second time anymore.
  // ---------------------------------------------------------------------

  const STYLE = `
    #wae-panel{
      position:fixed; bottom:20px; right:20px; z-index:9999;
      background:#0a0e0c; color:#d7f5e6; border:1px solid #223026; border-radius:8px;
      font-family:monospace; font-size:12.5px; padding:16px; width:520px; max-height:75vh;
      overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,.5); display:none;
    }
    #wae-panel.open{ display:block; }
    #wae-panel-header{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    #wae-panel h3{ margin:0 0 4px; font-size:14px; color:#d7f5e6; }
    #wae-panel h4{ margin:14px 0 4px; font-size:12px; color:#a8c9b8; border-top:1px solid #223026; padding-top:10px; }
    #wae-panel .wae-sub{ font-size:11px; color:#6b8579; margin-bottom:10px; }
    #wae-close-btn{
      background:none; border:none; color:#6b8579; cursor:pointer; font-family:monospace;
      font-size:16px; line-height:1; padding:0 2px; margin:0;
    }
    #wae-close-btn:hover{ color:#d7f5e6; }
    #wae-panel button{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:6px 10px; cursor:pointer; font-family:monospace; font-size:11.5px; margin-right:6px; margin-top:6px;
    }
    #wae-panel button.primary{ background:#00e08a; color:#04140d; border-color:#00e08a; }
    #wae-panel button.danger{ color:#ff5d5d; border-color:#ff5d5d; }
    #wae-panel button:disabled{ opacity:0.5; cursor:default; }
    #wae-progress{ font-size:11px; color:#3ec6ff; margin:4px 0; min-height:14px; }
    #wae-log{ margin-top:10px; max-height:120px; overflow-y:auto; font-size:11px; line-height:1.5; }
    #wae-log div.ok{ color:#00e08a; }
    #wae-log div.warn{ color:#e0c200; }
    #wae-log div.err{ color:#ff5d5d; }
    #wae-table-wrap{ margin-top:10px; max-height:260px; overflow:auto; border:1px solid #223026; border-radius:4px; }
    #wae-table{ width:100%; border-collapse:collapse; font-size:11px; }
    #wae-table th{
      position:sticky; top:0; background:#10160f; color:#a8c9b8; text-align:left;
      padding:5px 6px; border-bottom:1px solid #223026; white-space:nowrap;
    }
    #wae-table td{
      padding:5px 6px; border-bottom:1px solid #161d19; white-space:nowrap;
      max-width:160px; overflow:hidden; text-overflow:ellipsis;
    }
    #wae-table td.wae-missing{ color:#6b8579; font-style:italic; }
    #wae-table tr:hover td{ background:#10160f; }
  `;

  function log(container, msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    container.prepend(line);
    while (container.children.length > 50) container.removeChild(container.lastChild);
  }

  function renderTable(records) {
    if (!records.length) {
      return '<div class="wae-sub">No abuse reports extracted yet -- click "Scan Imported Emails".</div>';
    }
    const rows = records
      .slice()
      .sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0))
      .map((r) => {
        const name = r.wayspotName
          ? `<td title="${escapeHtml(r.wayspotName)}">${escapeHtml(r.wayspotName)}</td>`
          : '<td class="wae-missing">(none found)</td>';
        const lat = r.latitude !== null ? r.latitude.toFixed(6) : '<span class="wae-missing">-</span>';
        const lng = r.longitude !== null ? r.longitude.toFixed(6) : '<span class="wae-missing">-</span>';
        return `<tr>
          <td>${escapeHtml(r.conversationId || r.sourceEmailId)}</td>
          ${name}
          <td>${lat}</td>
          <td>${lng}</td>
          <td>${escapeHtml(r.ticketStatus.replace('ABUSE_REPORT_', ''))}</td>
        </tr>`;
      })
      .join('');
    return `
      <div id="wae-table-wrap">
        <table id="wae-table">
          <thead><tr><th>Conversation</th><th>Wayspot Name</th><th>Lat</th><th>Lng</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function refreshPanel() {
    const countEl = document.getElementById('wae-count');
    const tableEl = document.getElementById('wae-table-container');
    let extracted = [];
    try {
      extracted = await getAllExtractedRecords();
    } catch (e) {
      if (countEl) countEl.textContent = 'Could not read extracted-report storage.';
      return;
    }
    const withCoords = extracted.filter((r) => r.latitude !== null && r.longitude !== null).length;
    const withName = extracted.filter((r) => r.wayspotName).length;
    if (countEl) {
      countEl.textContent = `${extracted.length} abuse report(s) extracted -- ${withCoords} with coordinates, ${withName} with a name guess.`;
    }
    if (tableEl) tableEl.innerHTML = renderTable(extracted);
    const exportBtn = document.getElementById('wae-export-btn');
    if (exportBtn) exportBtn.disabled = extracted.length === 0;
    const clearBtn = document.getElementById('wae-clear-btn');
    if (clearBtn) clearBtn.disabled = extracted.length === 0;
  }

  function buildPanel() {
    if (document.getElementById('wae-panel')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wae-panel';
    panel.innerHTML = `
      <div id="wae-panel-header">
        <h3>Wayfarer Abuse Report Extractor</h3>
        <button id="wae-close-btn" title="Close">✕</button>
      </div>
      <div class="wae-sub" id="wae-count">Loading...</div>

      <button id="wae-scan-btn" class="primary">Scan Imported Emails</button>
      <button id="wae-export-btn" disabled>⬇ Export CSV</button>
      <button id="wae-clear-btn" class="danger" disabled>Clear Extracted Data</button>
      <div id="wae-progress"></div>

      <div id="wae-table-container"></div>
      <div id="wae-log"></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#wae-close-btn').addEventListener('click', () => {
      panel.classList.remove('open');
    });

    const progressEl = panel.querySelector('#wae-progress');
    const logEl = panel.querySelector('#wae-log');
    const scanBtn = panel.querySelector('#wae-scan-btn');
    const exportBtn = panel.querySelector('#wae-export-btn');
    const clearBtn = panel.querySelector('#wae-clear-btn');

    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      progressEl.textContent = 'Scanning imported emails...';
      try {
        const extracted = await scanImportedEmails((done, total) => {
          progressEl.textContent = `Scanning imported emails... ${done}/${total}`;
        });
        const { inserted, updated } = await putExtractedRecords(extracted);
        progressEl.textContent = '';
        log(logEl, `✓ Scanned: found ${extracted.length} abuse report ticket(s) -- ${inserted} new, ${updated} updated.`, 'ok');
        const missingCoords = extracted.filter((r) => r.latitude === null).length;
        if (missingCoords) {
          log(logEl, `⚠ ${missingCoords} report(s) had no parseable coordinates -- check the raw columns in the CSV.`, 'warn');
        }
      } catch (e) {
        progressEl.textContent = '';
        log(logEl, `✗ Scan failed: ${e.message || e}`, 'err');
      } finally {
        scanBtn.disabled = false;
        refreshPanel();
      }
    });

    exportBtn.addEventListener('click', async () => {
      try {
        const extracted = await getAllExtractedRecords();
        if (!extracted.length) return;
        downloadCsv(extracted);
        log(logEl, `✓ Exported ${extracted.length} row(s) to CSV.`, 'ok');
      } catch (e) {
        log(logEl, `✗ Export failed: ${e.message || e}`, 'err');
      }
    });

    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear all extracted abuse-report data? The original imported emails are untouched -- you can re-scan any time.')) return;
      try {
        await clearExtractedRecords();
        log(logEl, '✓ Cleared extracted-report storage.', 'ok');
      } catch (e) {
        log(logEl, `✗ Clear failed: ${e.message || e}`, 'err');
      } finally {
        refreshPanel();
      }
    });
  }

  function togglePanel() {
    buildPanel();
    const panel = document.getElementById('wae-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) refreshPanel();
  }

  // ---------------------------------------------------------------------
  // Map Mods - Base side panel integration -- confirmed against Report
  // Wayspots v3.3.0's own insertReportingHistoryLinkIfReady() /
  // insertReportingSettingsLinkIfReady(): both just appendChild a plain
  // <a> into ".wfmapmods-settings-links" the first time it exists, found
  // via a MutationObserver on document.documentElement (childList+subtree,
  // debounced 50ms) that fires until "#wfmapmods-side-panel" is present.
  // That script disconnects its observer once its links are in; this one
  // does the same, since the settings section persists for the rest of
  // the SPA session once Base has rendered it once.
  // ---------------------------------------------------------------------

  const SETTINGS_LINK_ID = 'wae-settings-link';
  let sidePanelObserver = null;
  let sidePanelMutationScheduled = false;

  function insertSettingsLinkIfReady() {
    const settingsBody = document.querySelector('.wfmapmods-settings-links');
    if (!settingsBody) return false;
    if (document.getElementById(SETTINGS_LINK_ID)) return true;

    const link = document.createElement('a');
    link.id = SETTINGS_LINK_ID;
    link.textContent = 'Abuse Report Extractor';
    link.style.cursor = 'pointer';

    settingsBody.appendChild(link);

    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      togglePanel();
    });

    return true;
  }

  function sidePanelMutationHandler() {
    if (!document.querySelector('#wfmapmods-side-panel')) return;
    if (insertSettingsLinkIfReady()) stopSidePanelWatcher();
  }

  function startSidePanelWatcher() {
    if (sidePanelObserver) return;

    sidePanelMutationHandler(); // covers the case it's already there

    sidePanelObserver = new MutationObserver(() => {
      if (sidePanelMutationScheduled) return;
      sidePanelMutationScheduled = true;
      setTimeout(() => {
        sidePanelMutationScheduled = false;
        sidePanelMutationHandler();
      }, 50);
    });

    sidePanelObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopSidePanelWatcher() {
    if (sidePanelObserver) {
      sidePanelObserver.disconnect();
      sidePanelObserver = null;
    }
  }

  buildPanel();
  startSidePanelWatcher();
})();
