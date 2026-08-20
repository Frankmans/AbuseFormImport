// ==UserScript==
// @name         Wayfarer Abuse Email Importer
// @namespace    https://wayfarer.nianticlabs.com/new
// @version      4.0.0
// @description  Imports Niantic Wayfarer/Spatial/OPR emails -- including Niantic Support "Reporting Abuse" tickets -- directly from Gmail via OAuth, or from .eml files -- using a port of bilde2910/OPR-Tools' email parser, and stores them for the Spatial Nominations Panel script (and other consumers) to search.
// @author       you
// @match        https://wayfarer.nianticlabs.com/new/nominations*
// @grant        GM_xmlhttpRequest
// @connect      gmail.googleapis.com
// @connect      accounts.google.com
// @require      https://gitlab.com/Tntnnbltn/wayfarer-addons/-/raw/main/wayfarer-map-mods-base.user.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wst-storage.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-abuse-email-importer.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-abuse-email-importer.user.js
// ==/UserScript==

/*
 * Companion to wayfarer-spatial-nominations-panel.user.js. This script's
 * ONLY job is getting your raw emails into the shared IndexedDB store
 * ("wst_email_store", see wst-storage.js) as parsed-but-unclassified
 * records -- headers + body, nothing more. It does NOT try to figure out
 * what kind of email something is, match decisions to nominations, or build
 * a submissions list -- that's the panel script's job (wst-business-logic.js).
 *
 * TWO WAYS IN:
 *   1. Connect Gmail -- OAuth (read-only) + the Gmail API, fetches matching
 *      messages directly. No manual export step, incremental after the
 *      first sync. Needs a one-time Google Cloud OAuth Client ID -- see the
 *      setup steps you were given alongside this script.
 *   2. Drop .eml files -- unchanged from before, useful as a fallback (a
 *      work computer where you can't/won't set up OAuth, a handful of
 *      one-off messages, etc).
 *
 * v3 CHANGE FROM v2: @grant went from "none" to "GM_xmlhttpRequest" so the
 * Gmail API calls run through Tampermonkey's own request machinery instead
 * of the page's fetch() -- that sidesteps Wayfarer's page CSP, which would
 * otherwise likely block a page-context request to googleapis.com. This
 * shouldn't change anything about the .eml/backup features below; @require'd
 * scripts and this script still share one execution context either way.
 *
 * v4 CHANGES FROM v3:
 *   - support@nianticlabs.com added to SUPPORTED_SENDERS, so Gmail sync now
 *     also picks up Niantic Support's Helpshift ticket threads (e.g.
 *     "Reporting Abuse in Wayfarer"), not just the templated per-submission
 *     notification emails. Requires the updated opr-email-lib.js that knows
 *     how to classify ABUSE_REPORT_* / Style.SUPPORT emails -- @require
 *     still points at the same URL, so just make sure that file itself has
 *     been updated. Records are stored exactly as before (raw headers +
 *     body, still deliberately unclassified) -- a separate plugin is
 *     expected to call OPREmail.classify() / OPREmail.helpshift.* on them
 *     later to pull out the reported name/coordinates. This script only
 *     uses classify() itself, transiently, to add a per-import count of how
 *     many abuse-report messages came in -- that count is never stored.
 *   - @namespace changed to https://wayfarer.nianticlabs.com/new and a
 *     @require for Tntnnbltn's wayfarer-map-mods-base.user.js was added, at
 *     your request, to integrate with that base plugin.
 *     *** INTEGRATION, NOW CONFIRMED AGAINST v3.15.0 ***: there's no formal
 *     "register your plugin" API -- Base doesn't expose one. What it does
 *     expose, for any userscript sharing the page, is a pair of DOM "bridge"
 *     elements it watches with a MutationObserver:
 *       #wfmapmods-poi-bridge    (attr data-payload)    -- write a POI's
 *         {guid, title, description, lat, lng, imageUrl, status, source}
 *         as JSON and Base will show/select it in its own side panel.
 *       #wfmapmods-submit-bridge (attr data-submission)  -- write
 *         {mode, source, poi:{...}, images:{...}} as JSON and Base opens
 *         its resubmission modal for it.
 *     This script has no POI/coordinate data of its own to push -- that's
 *     the "different plugin" you're building next. So what's actually wired
 *     up here (see registerWithMapModsBase() near the bottom) is: presence
 *     detection (logged, so it's obvious if Base isn't loaded), plus a
 *     small public API, window.WayfarerAbuseEmailImporter, so that next plugin
 *     doesn't have to re-derive which stored emails are abuse reports or
 *     re-implement the POI-bridge JSON contract itself -- it can call
 *     getAbuseReportRecords() to get the stored {record, email} pairs (each
 *     email already an OPREmail.Email, ready for
 *     OPREmail.helpshift.parseAbuseReportEmail(email)), then hand the title
 *     + coordinates it extracts to publishPoiToMap() to put a pin on the
 *     map through Base's real bridge.
 *
 * GMAIL OAUTH DESIGN NOTES:
 * Uses Google Identity Services' token client (a popup-based implicit OAuth
 * flow) rather than a redirect flow, specifically because it needs no
 * redirect_uri / backend of any kind -- the token comes back to this page's
 * JS directly. The access token lives in memory only (a page variable, never
 * persisted) and is re-requested each time this page is loaded; that's a
 * deliberate simplicity/security tradeoff for a personal tool, not an
 * oversight. Your Client ID (not a secret -- it's fine to store) is kept in
 * localStorage so you don't have to repaste it constantly.
 */

(function () {
  'use strict';

  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const SUPPORTED_SENDERS = [
    'notices@recon.nianticspatial.com',
    'notices@wayfarer.nianticlabs.com',
    'nominations@portals.ingress.com',
    'hello@pokemongolive.com',
    'ingress-support@nianticlabs.com',
    'ingress-support@google.com',
    // Niantic Support's Helpshift ticket threads, e.g. "Reporting Abuse in
    // Wayfarer" (confirmed real From address). These are freeform support
    // conversations rather than templated notifications -- see
    // opr-email-lib.js's Style.SUPPORT / Type.ABUSE_REPORT_* for how
    // they're classified once imported.
    'support@nianticlabs.com',
  ];
  const CLIENT_ID_KEY = 'wei_gmail_client_id';
  const LAST_SYNC_KEY = 'wei_gmail_last_sync_ms';
  const AUTOSYNC_ENABLED_KEY = 'wei_autosync_enabled';
  const AUTOSYNC_INTERVAL_KEY = 'wei_autosync_interval_min';
  const CONCURRENCY = 5;

  const STYLE = `
    #wei-btn{
      position:fixed; bottom:20px; right:20px; z-index:9999;
      background:#0a0e0c; color:#00e08a; border:1px solid #00e08a;
      font-family:monospace; font-size:13px; padding:10px 16px; border-radius:6px;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.4);
    }
    #wei-btn:hover{ background:#10160f; }
    #wei-panel{
      position:fixed; bottom:70px; right:20px; z-index:9999;
      background:#0a0e0c; color:#d7f5e6; border:1px solid #223026; border-radius:8px;
      font-family:monospace; font-size:12.5px; padding:16px; width:420px; max-height:75vh;
      overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,.5); display:none;
    }
    #wei-panel.open{ display:block; }
    #wei-panel h3{ margin:0 0 4px; font-size:14px; color:#d7f5e6; }
    #wei-panel h4{ margin:14px 0 4px; font-size:12px; color:#a8c9b8; border-top:1px solid #223026; padding-top:10px; }
    #wei-panel .wei-sub{ font-size:11px; color:#6b8579; margin-bottom:10px; }
    #wei-dropzone{
      border:2px dashed #223026; border-radius:6px; padding:24px 10px; text-align:center;
      color:#6b8579; margin-bottom:10px; cursor:pointer;
    }
    #wei-dropzone.drag{ border-color:#00e08a; color:#00e08a; }
    #wei-panel input[type=text]{
      width:100%; box-sizing:border-box; background:#161d19; color:#d7f5e6;
      border:1px solid #223026; border-radius:4px; padding:6px 8px; font-family:monospace;
      font-size:12px; margin-bottom:6px;
    }
    #wei-panel button{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:6px 10px; cursor:pointer; font-family:monospace; font-size:11.5px; margin-right:6px; margin-top:6px;
    }
    #wei-panel button.primary{ background:#00e08a; color:#04140d; border-color:#00e08a; }
    #wei-panel button.danger{ color:#ff5d5d; border-color:#ff5d5d; }
    #wei-panel button:disabled{ opacity:0.5; cursor:default; }
    #wei-gmail-status{ font-size:11px; color:#6b8579; margin:4px 0; }
    .wei-autosync-row{ display:flex; align-items:center; gap:8px; font-size:11px; color:#d7f5e6; margin:6px 0; }
    .wei-autosync-row select{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:3px 6px; font-family:monospace; font-size:11px;
    }
    #wei-progress{ font-size:11px; color:#3ec6ff; margin:4px 0; min-height:14px; }
    #wei-log{
      margin-top:10px; max-height:220px; overflow-y:auto; font-size:11px; line-height:1.5;
    }
    #wei-log div.ok{ color:#00e08a; }
    #wei-log div.skip{ color:#6b8579; }
    #wei-log div.err{ color:#ff5d5d; }
  `;

  // ---------------------------------------------------------------------
  // Gmail OAuth + API helpers
  // ---------------------------------------------------------------------

  let accessToken = null;
  let tokenExpiryMs = 0;
  let tokenClient = null;
  let autoSyncTimer = null;
  let autoSyncInProgress = false;

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(
        'Could not load Google\u2019s sign-in script. If this keeps happening, Wayfarer\u2019s ' +
        'page security policy may be blocking accounts.google.com from loading here.'
      ));
      document.head.appendChild(s);
    });
  }

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message || 'Timed out')), ms)),
    ]);
  }

  function requestAccessToken(clientId, interactive) {
    return new Promise((resolve, reject) => {
      loadGis().then(() => {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: GMAIL_SCOPE,
          callback: (resp) => {
            if (resp.error) { reject(new Error(resp.error)); return; }
            accessToken = resp.access_token;
            tokenExpiryMs = Date.now() + (resp.expires_in * 1000) - 60000;
            resolve(accessToken);
          },
        });
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      }).catch(reject);
    });
  }

  // forceNonInteractive is used by background auto-sync ticks -- a timer
  // callback is never a "user gesture", so browsers will block any popup
  // it tries to open. A non-interactive (prompt: '') request either
  // silently renews via an existing Google session with no visible popup,
  // or fails -- it never falls back to an interactive popup on its own.
  async function getValidToken(clientId, opts) {
    const forceNonInteractive = !!(opts && opts.forceNonInteractive);
    if (accessToken && Date.now() < tokenExpiryMs) return accessToken;
    const interactive = forceNonInteractive ? false : !accessToken;
    const request = requestAccessToken(clientId, interactive);
    // Silent renewal can hang indefinitely (rather than reject) if
    // third-party cookies are blocked -- only relevant for the
    // non-interactive path, since the interactive path legitimately waits
    // on the user to finish a popup.
    return forceNonInteractive ? withTimeout(request, 10000, 'Silent token refresh timed out') : request;
  }

  function gmApiGet(url, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${token}` },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('Gmail API returned something that wasn\u2019t valid JSON')); }
          } else if (res.status === 401) {
            reject(Object.assign(new Error('Gmail token expired or was revoked'), { authExpired: true }));
          } else {
            reject(new Error(`Gmail API error ${res.status}: ${res.responseText.slice(0, 300)}`));
          }
        },
        onerror: () => reject(new Error('Network error calling the Gmail API')),
      });
    });
  }

  function buildGmailQuery(lastSyncMs) {
    const senderClause = '(' + SUPPORTED_SENDERS.map((s) => `from:${s}`).join(' OR ') + ')';
    if (!lastSyncMs) return senderClause;
    // 1-day safety buffer -- same as gmail_wayspot_export.py's incremental
    // sync, since Gmail's after: operator only has day granularity.
    const buffered = new Date(lastSyncMs - 24 * 60 * 60 * 1000);
    const y = buffered.getUTCFullYear();
    const m = String(buffered.getUTCMonth() + 1).padStart(2, '0');
    const d = String(buffered.getUTCDate()).padStart(2, '0');
    return `${senderClause} after:${y}/${m}/${d}`;
  }

  function base64UrlToText(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function listAllMessageIds(query, token, onProgress) {
    const ids = [];
    let pageToken = null;
    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await gmApiGet(url.toString(), token);
      for (const m of (page.messages || [])) ids.push(m.id);
      pageToken = page.nextPageToken || null;
      if (onProgress) onProgress(ids.length);
    } while (pageToken);
    return ids;
  }

  // Bounded-concurrency fetch of each message's raw RFC822 content.
  async function fetchMessagesRaw(ids, token, onProgress) {
    const results = new Array(ids.length);
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < ids.length) {
        const i = cursor++;
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ids[i]}?format=raw`;
        try {
          const msg = await gmApiGet(url, token);
          results[i] = { id: ids[i], raw: msg.raw, error: null };
        } catch (e) {
          results[i] = { id: ids[i], raw: null, error: e };
        }
        done++;
        if (onProgress) onProgress(done, ids.length);
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  function injectUI() {
    if (document.getElementById('wei-btn')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'wei-btn';
    btn.textContent = '📥 Import Emails';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'wei-panel';
    panel.innerHTML = `
      <h3>Wayfarer Abuse Email Importer</h3>
      <div class="wei-sub" id="wei-count">Loading...</div>

      <h4>Connect Gmail</h4>
      <input type="text" id="wei-client-id" placeholder="OAuth Client ID (ends in .apps.googleusercontent.com)">
      <div id="wei-gmail-status">Not connected.</div>
      <div id="wei-progress"></div>
      <div>
        <button id="wei-sync" class="primary">Sync new emails</button>
        <button id="wei-full-resync">Force full re-sync</button>
      </div>
      <div class="wei-autosync-row">
        <label><input type="checkbox" id="wei-autosync-toggle"> Auto-sync every</label>
        <select id="wei-autosync-interval">
          <option value="5">5 min</option>
          <option value="15">15 min</option>
          <option value="30">30 min</option>
          <option value="60">60 min</option>
        </select>
      </div>

      <h4>Or drop .eml files</h4>
      <div id="wei-dropzone">Drop .eml files here, or click to choose</div>
      <input type="file" id="wei-file-input" accept=".eml" multiple style="display:none;">

      <h4>Backup / maintenance</h4>
      <div>
        <button id="wei-export">Export backup JSON</button>
        <button id="wei-import-backup">Import backup JSON</button>
        <input type="file" id="wei-backup-input" accept=".json,application/json" style="display:none;">
        <button id="wei-clear" class="danger">Clear all stored emails</button>
        <button id="wei-close">Close</button>
      </div>
      <div id="wei-log"></div>
    `;
    document.body.appendChild(panel);

    const dropzone = panel.querySelector('#wei-dropzone');
    const fileInput = panel.querySelector('#wei-file-input');
    const backupInput = panel.querySelector('#wei-backup-input');
    const logEl = panel.querySelector('#wei-log');
    const countEl = panel.querySelector('#wei-count');
    const clientIdInput = panel.querySelector('#wei-client-id');
    const gmailStatusEl = panel.querySelector('#wei-gmail-status');
    const progressEl = panel.querySelector('#wei-progress');
    const syncBtn = panel.querySelector('#wei-sync');
    const fullResyncBtn = panel.querySelector('#wei-full-resync');

    clientIdInput.value = localStorage.getItem(CLIENT_ID_KEY) || '';
    clientIdInput.addEventListener('change', () => {
      localStorage.setItem(CLIENT_ID_KEY, clientIdInput.value.trim());
    });

    function updateGmailStatus() {
      const lastSync = localStorage.getItem(LAST_SYNC_KEY);
      const auto = loadAutoSyncSettings();
      const autoSuffix = auto.enabled ? ` Auto-sync: every ${auto.intervalMin} min.` : '';
      if (accessToken) {
        gmailStatusEl.textContent = (lastSync
          ? `Connected. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
          : 'Connected. Never synced yet.') + autoSuffix;
      } else {
        gmailStatusEl.textContent = (lastSync
          ? `Not connected this session. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
          : 'Not connected.') + autoSuffix;
      }
    }

    function log(msg, cls) {
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = msg;
      logEl.prepend(div);
    }

    async function refreshCount() {
      try {
        const n = await WSTStorage.countEmails();
        countEl.textContent = `${n} email(s) stored. Open the Spatial Nominations Panel to search them.`;
      } catch (e) {
        countEl.textContent = 'Could not read the email store.';
      }
    }

    // ---- .eml import (unchanged from v2) ----

    function normalizeEml(text) {
      return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }

    function emlToRecord(text, fallbackName) {
      const email = OPREmail.parseMIME(normalizeEml(text));
      const messageId = email.getFirstHeaderValue('Message-ID', null);
      const id = messageId || `synthetic:${fallbackName}:${text.length}`;
      return { id, filename: fallbackName, ts: Date.now(), headers: email.headers, body: email.body };
    }

    // Transient-only: used to add an "N abuse report ticket(s)" count to the
    // import log line. Never persisted -- stored records stay the
    // deliberately-unclassified {headers, body} shape described up top, so a
    // downstream plugin re-classifies from the raw email itself, the same
    // way wst-business-logic.js already does.
    function isAbuseReportRecord(record) {
      try {
        // record.headers/body are already the decoded {name, value} pairs
        // and raw body that emlToRecord() stored, in exactly the shape
        // OPREmail.Email's constructor expects -- no need to re-serialize
        // and re-parse the whole MIME message just to classify it.
        const email = new OPREmail.Email(record.headers, record.body);
        const { type } = email.classify();
        return typeof type === 'string' && type.startsWith('ABUSE_REPORT_');
      } catch (e) {
        return false;
      }
    }

    function countAbuseReports(records) {
      return records.reduce((n, r) => n + (isAbuseReportRecord(r) ? 1 : 0), 0);
    }

    async function importFiles(files) {
      const records = [];
      let parseErrors = 0;
      for (const file of files) {
        let text;
        try {
          text = await file.text();
        } catch (e) {
          log(`✗ ${file.name}: could not read file`, 'err');
          parseErrors++;
          continue;
        }
        try {
          records.push(emlToRecord(text, file.name));
        } catch (e) {
          log(`✗ ${file.name}: ${e.message || e}`, 'err');
          parseErrors++;
        }
      }

      if (records.length) {
        const { inserted, updated } = await WSTStorage.putEmails(records);
        const abuseCount = countAbuseReports(records);
        const abuseSuffix = abuseCount ? `, ${abuseCount} abuse report ticket${abuseCount === 1 ? '' : 's'}` : '';
        log(`✓ Imported ${records.length} file(s): ${inserted} new, ${updated} updated${abuseSuffix}`, 'ok');
      }
      if (parseErrors) log(`${parseErrors} file(s) could not be parsed as MIME email`, 'err');
      await refreshCount();
    }

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.eml'));
      if (files.length) importFiles(files);
      else log('No .eml files found in the drop', 'skip');
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      fileInput.value = '';
      if (files.length) importFiles(files);
    });

    // ---- Gmail sync ----

    async function runSync(forceFull, opts) {
      const auto = !!(opts && opts.auto);
      const clientId = clientIdInput.value.trim();
      if (!clientId) {
        if (!auto) log('Paste your OAuth Client ID first', 'err');
        return;
      }
      localStorage.setItem(CLIENT_ID_KEY, clientId);

      syncBtn.disabled = true;
      fullResyncBtn.disabled = true;
      progressEl.textContent = auto ? 'Auto-sync: connecting to Gmail\u2026' : 'Connecting to Gmail\u2026';

      const lastSyncMs = forceFull ? null : Number(localStorage.getItem(LAST_SYNC_KEY)) || null;
      const syncStartedAt = Date.now();

      try {
        let token;
        try {
          token = await getValidToken(clientId, { forceNonInteractive: auto });
        } catch (e) {
          if (auto) {
            log('Auto-sync skipped this round: Gmail sign-in needed -- click "Sync new emails" once to reconnect', 'skip');
            return;
          }
          throw e;
        }
        updateGmailStatus();

        const query = buildGmailQuery(lastSyncMs);
        progressEl.textContent = 'Listing matching messages\u2026';
        const ids = await listAllMessageIds(query, token, (n) => {
          progressEl.textContent = `Found ${n} matching message(s) so far\u2026`;
        });

        if (ids.length === 0) {
          log(auto ? 'Auto-sync: no new messages found' : 'No new messages found', 'skip');
          localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
          updateGmailStatus();
          return;
        }

        progressEl.textContent = `Fetching ${ids.length} message(s)\u2026`;
        const raws = await fetchMessagesRaw(ids, token, (done, total) => {
          progressEl.textContent = `Fetching messages\u2026 ${done}/${total}`;
        });

        const records = [];
        let fetchErrors = 0, parseErrors = 0;
        for (const r of raws) {
          if (r.error) {
            fetchErrors++;
            if (r.error.authExpired) log('Gmail token expired mid-sync -- run Sync again to resume', 'err');
            continue;
          }
          try {
            const text = base64UrlToText(r.raw);
            records.push(emlToRecord(text, `gmail:${r.id}`));
          } catch (e) {
            parseErrors++;
          }
        }

        if (records.length) {
          const { inserted, updated } = await WSTStorage.putEmails(records);
          const abuseCount = countAbuseReports(records);
          const abuseSuffix = abuseCount ? `, ${abuseCount} abuse report ticket${abuseCount === 1 ? '' : 's'}` : '';
          log(`✓ ${auto ? 'Auto-sync: synced' : 'Synced'} ${records.length} message(s) from Gmail: ${inserted} new, ${updated} updated${abuseSuffix}`, 'ok');
        }
        if (fetchErrors) log(`${fetchErrors} message(s) failed to fetch (see above)`, 'err');
        if (parseErrors) log(`${parseErrors} message(s) could not be parsed as MIME email`, 'err');

        localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
      } catch (e) {
        log(`${auto ? 'Auto-sync failed: ' : 'Gmail sync failed: '}${e.message || e}`, 'err');
      } finally {
        progressEl.textContent = '';
        syncBtn.disabled = false;
        fullResyncBtn.disabled = false;
        updateGmailStatus();
        await refreshCount();
      }
    }

    syncBtn.addEventListener('click', () => runSync(false));
    fullResyncBtn.addEventListener('click', () => {
      if (confirm('Re-fetch your entire matching mailbox history from Gmail, not just what\u2019s new since last sync?')) {
        runSync(true);
      }
    });

    // ---- Auto-sync ----

    const autoSyncToggle = panel.querySelector('#wei-autosync-toggle');
    const autoSyncInterval = panel.querySelector('#wei-autosync-interval');

    function loadAutoSyncSettings() {
      return {
        enabled: localStorage.getItem(AUTOSYNC_ENABLED_KEY) === 'true',
        intervalMin: Number(localStorage.getItem(AUTOSYNC_INTERVAL_KEY)) || 15,
      };
    }
    function saveAutoSyncSettings(enabled, intervalMin) {
      localStorage.setItem(AUTOSYNC_ENABLED_KEY, String(enabled));
      localStorage.setItem(AUTOSYNC_INTERVAL_KEY, String(intervalMin));
    }

    function stopAutoSync() {
      if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    }

    async function runAutoSyncTick() {
      if (autoSyncInProgress) return; // don't overlap with an in-flight sync
      autoSyncInProgress = true;
      try {
        await runSync(false, { auto: true });
      } finally {
        autoSyncInProgress = false;
      }
    }

    function startAutoSync(intervalMin) {
      stopAutoSync();
      autoSyncTimer = setInterval(runAutoSyncTick, intervalMin * 60 * 1000);
    }

    const savedAutoSync = loadAutoSyncSettings();
    autoSyncToggle.checked = savedAutoSync.enabled;
    autoSyncInterval.value = String(savedAutoSync.intervalMin);
    if (savedAutoSync.enabled) startAutoSync(savedAutoSync.intervalMin);

    autoSyncToggle.addEventListener('change', () => {
      const intervalMin = Number(autoSyncInterval.value);
      saveAutoSyncSettings(autoSyncToggle.checked, intervalMin);
      if (autoSyncToggle.checked) {
        // This click IS a direct user gesture, so an interactive consent
        // popup is allowed here if needed -- establishes the session that
        // subsequent silent background ticks can then reuse.
        runSync(false, { auto: false });
        startAutoSync(intervalMin);
        log(`Auto-sync enabled -- syncing every ${intervalMin} minute(s)`, 'ok');
      } else {
        stopAutoSync();
        log('Auto-sync disabled', 'skip');
      }
    });

    autoSyncInterval.addEventListener('change', () => {
      const intervalMin = Number(autoSyncInterval.value);
      saveAutoSyncSettings(autoSyncToggle.checked, intervalMin);
      if (autoSyncToggle.checked) startAutoSync(intervalMin);
    });

    // ---- Backup / maintenance (unchanged from v2) ----

    panel.querySelector('#wei-export').addEventListener('click', async () => {
      const all = await WSTStorage.getAllEmails();
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), emails: all })], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wst-email-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      log(`Exported ${all.length} email(s) to a backup file`, 'ok');
    });

    panel.querySelector('#wei-import-backup').addEventListener('click', () => backupInput.click());
    backupInput.addEventListener('change', async () => {
      const file = backupInput.files[0];
      backupInput.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const emails = Array.isArray(parsed) ? parsed : parsed.emails;
        if (!Array.isArray(emails)) { log('That file doesn\u2019t look like a valid backup', 'err'); return; }
        const { inserted, updated } = await WSTStorage.putEmails(emails);
        log(`✓ Restored backup: ${inserted} new, ${updated} updated`, 'ok');
        await refreshCount();
      } catch (e) {
        log(`Could not read that backup file: ${e.message || e}`, 'err');
      }
    });

    panel.querySelector('#wei-clear').addEventListener('click', async () => {
      if (!confirm('Delete every stored email from this browser? This cannot be undone (export a backup first if unsure).')) return;
      await WSTStorage.clearAll();
      log('All stored emails cleared', 'skip');
      await refreshCount();
    });

    panel.querySelector('#wei-close').addEventListener('click', () => panel.classList.remove('open'));
    btn.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) { refreshCount(); updateGmailStatus(); }
    });

    refreshCount();
    updateGmailStatus();
  }

  // ---------------------------------------------------------------------
  // Map Mods - Base integration -- confirmed against the real base script
  // (v3.15.0) you shared. See the v4 CHANGES note at the top for the full
  // explanation; short version: Base has no formal plugin-registration
  // hook, just two DOM "bridge" elements it watches with a
  // MutationObserver. This script doesn't have POI/coordinate data of its
  // own to push, so it exposes a small public API for the future
  // extraction plugin to use instead of re-deriving/reimplementing this.
  // ---------------------------------------------------------------------
  const POI_BRIDGE_ID = 'wfmapmods-poi-bridge';

  function isMapModsBaseActive() {
    // Base creates both bridge elements itself, from createBridges() in
    // its own init(); their mere presence is a reasonable proxy for
    // "Base is loaded and running here", without needing to guess at any
    // internal state of its own.
    return !!(document.getElementById(POI_BRIDGE_ID) || document.getElementById('wfmapmods-submit-bridge'));
  }

  function ensurePoiBridgeElement() {
    let el = document.getElementById(POI_BRIDGE_ID);
    if (!el) {
      // Base normally creates this first (document-start vs. our
      // document-idle), so this is only a fallback for the unlikely case
      // this script's publishPoiToMap() gets called before Base has run
      // its own createBridges() -- same id/shape Base itself uses, so
      // Base's own MutationObserver picks it up transparently either way.
      el = document.createElement('div');
      el.id = POI_BRIDGE_ID;
      el.style.display = 'none';
      el.setAttribute('data-wfmapmods-bridge', '1');
      document.body.appendChild(el);
    }
    return el;
  }

  // Writes a POI onto Map Mods - Base's POI bridge -- the exact payload
  // shape its handleBridgePoiPayload() reads (confirmed against v3.15.0).
  // Base shows/selects it in its own side panel; it does not itself drop a
  // map marker for bridge-sourced POIs beyond that side-panel selection.
  function publishPoiToMap({ guid, title, description, lat, lng, imageUrl, status, source } = {}) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('publishPoiToMap: lat/lng must be finite numbers');
    }
    const bridge = ensurePoiBridgeElement();
    const payload = {
      guid: guid || null,
      title: title || '(untitled)',
      description: description || '',
      lat,
      lng,
      imageUrl: imageUrl || '',
      status: status || '',
      source: source || 'Wayfarer Abuse Email Importer',
    };
    try {
      bridge.setAttribute('data-payload', JSON.stringify(payload));
    } catch (e) {
      console.warn('[Wayfarer Abuse Email Importer] Failed to publish POI to Map Mods - Base bridge:', e, payload);
    }
  }

  // For the future extraction plugin: every currently-stored email that
  // classifies as an abuse-report ticket, already reconstructed as an
  // OPREmail.Email (so classify()/getBody()/etc. are all available without
  // re-fetching from storage or re-parsing headers by hand).
  async function getAbuseReportRecords() {
    const all = await WSTStorage.getAllEmails();
    const out = [];
    for (const record of all) {
      try {
        const email = new OPREmail.Email(record.headers, record.body);
        const { type } = email.classify();
        if (typeof type === 'string' && type.startsWith('ABUSE_REPORT_')) {
          out.push({ record, email });
        }
      } catch (e) {
        // Skip anything that doesn't parse/classify; not this function's
        // job to surface parse errors, callers can inspect the record
        // directly if they need to know why one was skipped.
      }
    }
    return out;
  }

  window.WayfarerAbuseEmailImporter = {
    getAbuseReportRecords,
    publishPoiToMap,
    isMapModsBaseActive,
  };

  function registerWithMapModsBase() {
    if (isMapModsBaseActive()) {
      console.info('[Wayfarer Abuse Email Importer] Map Mods - Base detected -- window.WayfarerAbuseEmailImporter is available.');
    } else {
      // Not necessarily an error -- Base uses @run-at document-start and
      // we're document-idle, so this is usually just "hasn't run yet".
      // Re-check once after a beat rather than only logging a possibly-
      // stale negative result.
      setTimeout(() => {
        console.info(
          isMapModsBaseActive()
            ? '[Wayfarer Abuse Email Importer] Map Mods - Base detected -- window.WayfarerAbuseEmailImporter is available.'
            : '[Wayfarer Abuse Email Importer] Map Mods - Base not detected on this page. window.WayfarerAbuseEmailImporter is still available, but publishPoiToMap() will have nothing to show until Base loads.'
        );
      }, 2000);
    }
  }

  registerWithMapModsBase();
  injectUI();
  setInterval(injectUI, 2000);
})();
