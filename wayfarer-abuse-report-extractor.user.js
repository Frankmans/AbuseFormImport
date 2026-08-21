// ==UserScript==
// @name         Wayfarer Abuse Report Extractor
// @namespace    https://wayfarer.nianticlabs.com/new
// @version      1.5.0
// @description  Scans emails already imported by Wayfarer Abuse Email Importer for Niantic Support "Reporting Abuse" tickets, extracts every reported Wayspot's name + coordinates (a ticket can report several, across the original submission and later replies), stores them locally, and exports as CSV.
// @author       you
// @match        https://wayfarer.nianticlabs.com/new/mapview*
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
 *      out every reported Wayspot's name + coordinate (see `locations` in
 *      that function -- *** BEST-EFFORT, only confirmed against a
 *      handful of real samples *** -- the raw locationDetails/
 *      reportDetails text is kept alongside every row specifically so you
 *      can sanity-check or correct it by hand in the exported CSV). One
 *      ticket can report several Wayspots at once, or have more added in
 *      a later reply -- each becomes its own row, sharing the ticket's
 *      conversationId/issueType/raw-text columns.
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
 * v1.5.0 CHANGE FROM v1.4.0: Street View / Maps links found near a
 * location in a reply (real example: "'t Zudn, <lat,lng> (is here:
 * <corrected lat,lng>, shows on street view: <url>)") used to be dropped
 * outright as unreliable "new location" noise. They're kept now -- folded
 * into a new `comment` field on whichever named location they were
 * providing context for (see opr-email-lib.js's extractLocationLines) --
 * and exposed as a new "Comment" CSV column, plus a hover-for-full-text
 * 💬 indicator in the panel's table.
 *
 * v1.4.0 CHANGE FROM v1.3.0: a ticket reporting several Wayspots at once,
 * or with more added in a later reply ("I see I missed some: ..."), now
 * produces one CSV row per Wayspot instead of just one row for the
 * ticket. This follows from opr-email-lib.js's parseAbuseReportEmail()
 * now returning a `locations` array (deduped by coordinate) instead of a
 * single locationName/primaryCoordinate guess -- see that file's own
 * comments for how it's built (the original form's locationDetails field,
 * split per line, plus every reply message scanned the same way).
 * Because a ticket's row count can now change between scans, "Scan
 * Imported Emails" rebuilds the extracted-data store from scratch each
 * time (clearExtractedRecords() then a fresh write) rather than upserting
 * -- upserting alone would've left old single-row ids behind as stale
 * duplicates once a ticket started producing several rows.
 *
 * v1.3.0 CHANGE FROM v1.2.0: the panel is now a real modal, styled with
 * Base's own .wfmapmods-modal-* classes (backdrop, dialog, title, close
 * button, buttons) instead of the old custom fixed-position dark/monospace
 * box. Centered, white, blocks the rest of the page while open (click
 * outside the dialog, Escape, or the × all close it) -- matching every
 * other Map Mods - Base panel (Map options, Manual marker options, etc.)
 * instead of looking and behaving like a standalone floating widget.
 *
 * v1.2.0 CHANGE FROM v1.1.0: dropped the @require for Tntnnbltn's
 * wayfarer-map-mods-base.user.js that pulled Base in directly. @require
 * re-executes the whole required file separately inside *each* userscript
 * that lists it, rather than sharing one running instance -- with both this
 * script and the Abuse Email Importer requiring it, that meant two
 * independent copies of Base on the same page, each building its own
 * "#wfmapmods-side-panel" (Base has no re-init guard against a second,
 * separately-required copy). Report Wayspots -- Base's real companion
 * script -- never @requires it either: it's installed once, standalone,
 * and talks to whatever single copy is already running purely through the
 * DOM contract (.wfmapmods-settings-links, the bridge elements). This
 * script now does the same -- Map Mods - Base needs to be installed
 * separately for the settings-link and side panel to have anywhere to go.
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

      const idBase = parsed.conversationId ? `conv:${parsed.conversationId}` : `email:${record.id}`;
      // parsed.locations is every Wayspot found anywhere in the thread --
      // the original report can list several at once, and later replies
      // ("I see I missed some: ...") can add more. One row per location,
      // all sharing conversationId/ticketStatus/issueType/raw fields so
      // they're still recognizable as one ticket in the CSV. A ticket
      // with no parseable location at all still gets exactly one row (so
      // it's not silently dropped from the scan), with everything
      // location-related left null.
      const locations = parsed.locations && parsed.locations.length ? parsed.locations : [null];

      locations.forEach((loc, i) => {
        extracted.push({
          id: locations.length > 1 ? `${idBase}:${i}` : idBase,
          conversationId: parsed.conversationId || null,
          ticketStatus: classification.type,
          wayspotName: loc ? loc.name : null,
          latitude: loc ? Number(loc.latitude) : null,
          longitude: loc ? Number(loc.longitude) : null,
          comment: loc ? (loc.comment || null) : null,
          issueType: parsed.issueType || null,
          locationDetails: parsed.locationDetails || null,
          reportDetails: parsed.reportDetails || null,
          sourceEmailId: record.id,
          sourceFilename: record.filename || null,
          scannedAt: Date.now(),
        });
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
    ['comment', 'Comment'],
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
  // UI -- opened via a link injected into Map Mods - Base's own side panel
  // settings section (.wfmapmods-settings-links), the same way Report
  // Wayspots adds its "Reporting History" / "Reporting Settings" links
  // (insertReportingHistoryLinkIfReady / insertReportingSettingsLinkIfReady
  // -- both appendChild a plain <a>, found via a debounced MutationObserver
  // gated on "#wfmapmods-side-panel"). The panel itself is now a real
  // modal built from Base's own CSS classes (.wfmapmods-modal-backdrop /
  // -dialog / -title / -btn etc., confirmed against openModal() in Base's
  // real source) instead of a custom floating box -- centered, white,
  // blocks the rest of the page while open, closes on the × button,
  // Escape, or a click on the backdrop outside the dialog, matching every
  // other Map Mods - Base panel. "wae-" prefix throughout so nothing
  // collides with the importer script's "wei-" ids/classes.
  // ---------------------------------------------------------------------

  const STYLE = `
    #wae-panel .wae-dialog{
      width:560px; max-width:calc(100vw - 24px);
    }
    #wae-panel .wae-sub{ font-size:11px; color:#6b7280; margin-bottom:8px; }
    .wae-btn-row{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:6px 0; }
    .wae-btn-row .wfmapmods-modal-btn{ margin:0; }
    .wae-btn-danger{ color:#dc2626; border-color:#dc2626; }
    #wae-panel button:disabled{ opacity:0.5; cursor:default; }
    #wae-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    #wae-log{ margin-top:8px; max-height:110px; overflow-y:auto; font-size:11px; line-height:1.5; }
    #wae-log div.ok{ color:#16a34a; }
    #wae-log div.warn{ color:#b45309; }
    #wae-log div.err{ color:#dc2626; }
    #wae-table-wrap{ margin-top:8px; max-height:260px; overflow:auto; border:1px solid #e5e7eb; border-radius:4px; }
    #wae-table{ width:100%; border-collapse:collapse; font-size:11px; }
    #wae-table th{
      position:sticky; top:0; background:#f9fafb; color:#374151; text-align:left;
      padding:5px 6px; border-bottom:1px solid #e5e7eb; white-space:nowrap;
    }
    #wae-table td{
      padding:5px 6px; border-bottom:1px solid #f3f4f6; white-space:nowrap;
      max-width:160px; overflow:hidden; text-overflow:ellipsis; color:#111827;
    }
    #wae-table td.wae-missing{ color:#9ca3af; font-style:italic; }
    #wae-table td.wae-comment{ text-align:center; cursor:help; max-width:24px; }
    #wae-table tr:hover td{ background:#f9fafb; }
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
        const comment = r.comment
          ? `<td class="wae-comment" title="${escapeHtml(r.comment)}">\uD83D\uDCAC</td>`
          : '<td></td>';
        return `<tr>
          <td>${escapeHtml(r.conversationId || r.sourceEmailId)}</td>
          ${name}
          <td>${lat}</td>
          <td>${lng}</td>
          ${comment}
          <td>${escapeHtml(r.ticketStatus.replace('ABUSE_REPORT_', ''))}</td>
        </tr>`;
      })
      .join('');
    return `
      <div id="wae-table-wrap">
        <table id="wae-table">
          <thead><tr><th>Conversation</th><th>Wayspot Name</th><th>Lat</th><th>Lng</th><th></th><th>Status</th></tr></thead>
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
    const ticketCount = new Set(extracted.map((r) => r.conversationId || r.sourceEmailId)).size;
    if (countEl) {
      countEl.textContent = `${extracted.length} location(s) extracted from ${ticketCount} ticket(s) -- ${withCoords} with coordinates, ${withName} with a name guess.`;
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
    panel.className = 'wfmapmods-modal-backdrop';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="wfmapmods-modal-dialog wae-dialog">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div class="wfmapmods-modal-title">Wayfarer Abuse Report Extractor</div>
          <button type="button" id="wae-close-btn" class="wfmapmods-close-btn" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="wae-sub" id="wae-count">Loading...</div>

        <div class="wae-btn-row">
          <button id="wae-scan-btn" class="wfmapmods-modal-btn wfmapmods-modal-btn-primary">Scan Imported Emails</button>
          <button id="wae-export-btn" class="wfmapmods-modal-btn" disabled>Export CSV</button>
          <button id="wae-clear-btn" class="wfmapmods-modal-btn wae-btn-danger" disabled>Clear Extracted Data</button>
        </div>
        <div id="wae-progress"></div>

        <div id="wae-table-container"></div>
        <div id="wae-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    let pointerDownOnBackdrop = false;
    panel.addEventListener('pointerdown', (ev) => {
      pointerDownOnBackdrop = (ev.target === panel);
    });
    panel.addEventListener('pointerup', (ev) => {
      if (pointerDownOnBackdrop && ev.target === panel) closePanel();
      pointerDownOnBackdrop = false;
    });
    panel.addEventListener('pointercancel', () => { pointerDownOnBackdrop = false; });

    panel.querySelector('#wae-close-btn').addEventListener('click', closePanel);

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
        // Rebuild from scratch rather than upsert: a ticket's row count can
        // change between scans (a multi-location ticket now yields several
        // "conv:X:0" / "conv:X:1" / ... rows instead of one "conv:X" row),
        // and upserting alone would leave the old id's row behind as a
        // stale duplicate. Source data is the already-imported emails, so
        // a full rebuild is cheap and side-steps that entirely.
        await clearExtractedRecords();
        await putExtractedRecords(extracted);
        progressEl.textContent = '';
        const ticketCount = new Set(extracted.map((r) => r.conversationId || r.sourceEmailId)).size;
        log(logEl, `✓ Scanned: found ${extracted.length} location(s) across ${ticketCount} abuse report ticket(s).`, 'ok');
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

  function waeEscHandler(ev) {
    if (ev.key === 'Escape') closePanel();
  }

  function openPanel() {
    buildPanel();
    const panel = document.getElementById('wae-panel');
    panel.style.display = 'flex';
    document.addEventListener('keydown', waeEscHandler);
    refreshPanel();
  }

  function closePanel() {
    const panel = document.getElementById('wae-panel');
    if (panel) panel.style.display = 'none';
    document.removeEventListener('keydown', waeEscHandler);
  }

  function togglePanel() {
    buildPanel();
    const panel = document.getElementById('wae-panel');
    if (panel.style.display === 'none') openPanel();
    else closePanel();
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
