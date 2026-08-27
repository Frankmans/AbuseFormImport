// ==UserScript==
// @name         Wayfarer Abuse Email Importer
// @namespace    https://wayfarer.scopely.com/new
// @version      4.5.0
// @description  Imports Niantic Support "Reporting Abuse in Wayfarer" tickets from Gmail via OAuth, or from .eml files -- using a port of bilde2910/OPR-Tools' email parser -- and stores them for the Abuse Report Extractor script (and other consumers) to search.
// @author       you
// @match        https://wayfarer.scopely.com/new/mapview*
// @grant        GM_xmlhttpRequest
// @connect      gmail.googleapis.com
// @connect      accounts.google.com
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wst-storage.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js
// ==/UserScript==

/*
 * Companion to wayfarer-abuse-report-extractor.user.js. This script's ONLY
 * job is getting your raw emails into the shared IndexedDB store
 * ("wst_email_store", see wst-storage.js) as parsed-but-unclassified
 * records -- headers + body, nothing more. It does NOT try to figure out
 * what kind of email something is or extract a Wayspot name/coordinates
 * from it -- that's the extractor script's job.
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
 * v4.5.0 CHANGE FROM v4.4.0: adapted for Wayfarer's move to
 * wayfarer.scopely.com and Tntnnbltn's new consolidated
 * wayfarer-map-mods.user.js suite (v4.0.0, replacing the old separate
 * wayfarer-map-mods-base.user.js + Report Wayspots scripts this was
 * previously confirmed against). @namespace/@match updated to the new
 * domain. Verified the new suite's actual source line by line against
 * everything this script depends on:
 *   - #wfmapmods-side-panel, .wfmapmods-settings-links, and all the
 *     .wfmapmods-modal-* classes this uses for its own panel are
 *     unchanged.
 *   - The map-lookup code below (confirmed against Report Wayspots
 *     v3.15.0) is still accurate -- looksLikeGoogleMap()/
 *     extractMapFromCtxEntry()'s componentRef.map pattern and the
 *     "app-submit-wayspot-map nia-map, app-wf-base-map" selectors are
 *     byte-for-byte what the new suite's own internal map resolution
 *     uses too.
 *   - #wfmapmods-poi-bridge/#wfmapmods-submit-bridge, however, are GONE
 *     -- replaced internally with a private "component bridge"
 *     abstraction with no stable public DOM contract. isMapModsBaseActive()
 *     now checks for #wfmapmods-side-panel instead (see that function),
 *     and publishPoiToMap() is now a documented no-op with a one-time
 *     console warning rather than silently writing to a throwaway
 *     element nothing reads -- see that function's own comment. This
 *     doesn't affect real map-plotting either way; that was always the
 *     extractor script's own "Show on Map" (native markers), never this
 *     bridge.
 *   - .wfmapmods-modal-checkbox is also gone (only context-specific
 *     .wfmapmods-layers-checkbox/.wfmapmods-filters-checkbox remain,
 *     neither fitting an unrelated auto-sync toggle) -- swapped for a
 *     small self-contained .wei-checkbox rule instead.
 * NOT changed: SUPPORTED_SENDERS still filters on support@nianticlabs.com
 * -- that's Niantic Support's own email address, a separate concern from
 * which website domain Wayfarer itself is hosted at, and nothing
 * indicated it changed too. Worth confirming if abuse-report tickets
 * start arriving from a different address.
 *
 * v4.4.0 CHANGE FROM v4.3.0: SUPPORTED_SENDERS narrowed to just
 * support@nianticlabs.com. Gmail sync now only screens for Niantic
 * Support's Helpshift "Reporting Abuse in Wayfarer" ticket threads --
 * dropped the general nomination/notification senders (notices@recon.
 * nianticspatial.com, notices@wayfarer.nianticlabs.com, nominations@
 * portals.ingress.com, hello@pokemongolive.com, ingress-support@
 * nianticlabs.com, ingress-support@google.com). If you want those back for
 * a different consumer later, they're in the version history, not gone
 * from Gmail -- this only changes what this script's own sync pulls in.
 * The .eml drop path is untouched: it still accepts whatever file you
 * drop, since that's already a deliberate per-file choice, not a search.
 *
 * v4.3.0 CHANGE FROM v4.2.0: the panel is now a real modal, styled with
 * Base's own .wfmapmods-modal-* classes (backdrop, dialog, title, close
 * button, buttons) instead of the old custom fixed-position dark/monospace
 * box. Centered, white, blocks the rest of the page while open (click
 * outside the dialog, Escape, or the × all close it) -- matching every
 * other Map Mods - Base panel instead of looking like a standalone widget.
 *
 * v4.2.0 CHANGE FROM v4.1.0: dropped the @require for Tntnnbltn's
 * wayfarer-map-mods-base.user.js that v4.0.0 added. @require doesn't share
 * a running instance across scripts -- it re-fetches and re-executes the
 * whole file separately inside *each* userscript that lists it. With both
 * this script and the Abuse Report Extractor requiring it, that meant two
 * independent copies of Base running side by side on the same page, each
 * building its own "#wfmapmods-side-panel" (Base has no re-init guard
 * against a *second*, separately-required copy). Base's real companion
 * script, Report Wayspots, never @requires it either -- it's installed
 * once, standalone, and every other script just assumes exactly one copy
 * is already running and talks to it purely through the DOM contract
 * (.wfmapmods-settings-links, the two bridge elements). This script now
 * does the same: Map Mods - Base needs to be installed separately for the
 * "Import Abuse Report Emails" link and publishPoiToMap() to have
 * anywhere to go, but this script no longer bundles a copy of it in.
 *
 * v4.1.0 CHANGE FROM v4.0.0: this no longer has its own floating "Import
 * Emails" button. Same move the Abuse Report Extractor script made in its
 * own v1.1.0 -- the panel now opens via an "Import Abuse Report Emails"
 * link injected into Map Mods - Base's side panel settings section
 * (".wfmapmods-settings-links"), found the same debounced-MutationObserver
 * way. The panel itself (Gmail connect, .eml dropzone, backup/maintenance)
 * is unchanged -- only how it's opened changed, plus the existing Close
 * button is now the only way to dismiss it since there's no toggle button
 * to click a second time.
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
 *     + coordinates it extracts to publishPoiToMap() to write onto Base's
 *     real bridge.
 *     *** CORRECTION, confirmed against Report Wayspots v3.3.0's real
 *     source ***: publishPoiToMap() does NOT put a pin on the map -- Base
 *     only shows/selects a bridge-sourced POI in its own side panel (see
 *     that function's own code comment). The extractor script's actual
 *     map-plotting (added in its own v1.6.0, "Show on Map") doesn't use
 *     this bridge at all -- it ports Report Wayspots' real map-lookup code
 *     and builds its own self-contained pulse-overlay layer instead, the
 *     only approach actually confirmed to draw a marker. This function and
 *     getAbuseReportRecords() are left in place as a small convenience API
 *     regardless -- still useful for a future consumer that only wants
 *     "the abuse-report emails already parsed" or "hand one POI to Base's
 *     side panel" -- just not for map-plotting.
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
  // Niantic Support's Helpshift ticket threads, e.g. "Reporting Abuse in
  // Wayfarer" (confirmed real From address) -- see opr-email-lib.js's
  // Style.SUPPORT / Type.ABUSE_REPORT_* for how they're classified once
  // imported. Nomination-status notification senders (notices@recon.
  // nianticspatial.com, nominations@portals.ingress.com, etc.) were
  // dropped from here in v4.4.0 -- this script now only screens for
  // abuse-report tickets, not general Wayfarer/Spatial/Ingress mail.
  const SUPPORTED_SENDERS = [
    'support@nianticlabs.com',
  ];
  const CLIENT_ID_KEY = 'wei_gmail_client_id';
  const LAST_SYNC_KEY = 'wei_gmail_last_sync_ms';
  const AUTOSYNC_ENABLED_KEY = 'wei_autosync_enabled';
  const AUTOSYNC_INTERVAL_KEY = 'wei_autosync_interval_min';
  const CONCURRENCY = 5;

  const STYLE = `
    #wei-panel .wei-dialog{
      width:480px; max-width:calc(100vw - 24px);
    }
    #wei-panel .wei-sub{ font-size:11px; color:#6b7280; margin-bottom:8px; }
    #wei-dropzone{
      border:2px dashed #d1d5db; border-radius:6px; padding:20px 10px; text-align:center;
      color:#6b7280; margin:6px 0; cursor:pointer; font-size:12px;
    }
    #wei-dropzone.drag{ border-color:#2563eb; color:#2563eb; }
    .wei-text-input{
      width:100%; box-sizing:border-box; border:1px solid #d1d5db; border-radius:4px;
      padding:5px 8px; font-size:12px; margin-bottom:6px; font-family:inherit;
    }
    .wei-btn-row{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:6px 0; }
    .wei-btn-row .wfmapmods-modal-btn{ margin:0; }
    .wei-btn-danger{ color:#dc2626; border-color:#dc2626; }
    #wei-panel button:disabled{ opacity:0.5; cursor:default; }
    .wei-autosync-row{ display:flex; align-items:center; gap:6px; font-size:12px; color:#374151; margin:6px 0; cursor:default; }
    .wei-checkbox{ width:16px; height:16px; margin:0; }
    #wei-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    #wei-log{
      margin-top:8px; max-height:180px; overflow-y:auto; font-size:11px; line-height:1.5;
    }
    #wei-log div.ok{ color:#16a34a; }
    #wei-log div.skip{ color:#6b7280; }
    #wei-log div.err{ color:#dc2626; }
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

  async function refreshCount() {
    const countEl = document.getElementById('wei-count');
    if (!countEl) return;
    try {
      const n = await WSTStorage.countEmails();
      countEl.textContent = `${n} email(s) stored. Open the Abuse Report Extractor to scan them.`;
    } catch (e) {
      countEl.textContent = 'Could not read the email store.';
    }
  }

  function updateGmailStatus() {
    const gmailStatusEl = document.getElementById('wei-gmail-status');
    if (!gmailStatusEl) return;
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

  function buildPanel() {
    if (document.getElementById('wei-panel')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wei-panel';
    panel.className = 'wfmapmods-modal-backdrop';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="wfmapmods-modal-dialog wei-dialog">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div class="wfmapmods-modal-title">Wayfarer Abuse Email Importer</div>
          <button type="button" id="wei-close" class="wfmapmods-close-btn" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="wei-sub" id="wei-count">Loading...</div>

        <div class="wfmapmods-modal-section">
          <div class="wfmapmods-modal-section-header">Connect Gmail</div>
          <input type="text" id="wei-client-id" class="wei-text-input" placeholder="OAuth Client ID (ends in .apps.googleusercontent.com)">
          <div class="wei-sub" id="wei-gmail-status">Not connected.</div>
          <div class="wei-sub" id="wei-progress"></div>
          <div class="wei-btn-row">
            <button id="wei-sync" class="wfmapmods-modal-btn wfmapmods-modal-btn-primary">Sync new emails</button>
            <button id="wei-full-resync" class="wfmapmods-modal-btn">Force full re-sync</button>
          </div>
          <label class="wei-autosync-row">
            <input type="checkbox" id="wei-autosync-toggle" class="wei-checkbox"> Auto-sync every
            <select id="wei-autosync-interval" class="wfmapmods-modal-select">
              <option value="5">5 min</option>
              <option value="15">15 min</option>
              <option value="30">30 min</option>
              <option value="60">60 min</option>
            </select>
          </label>
        </div>

        <div class="wfmapmods-modal-section">
          <div class="wfmapmods-modal-section-header">Or drop .eml files</div>
          <div id="wei-dropzone">Drop .eml files here, or click to choose</div>
          <input type="file" id="wei-file-input" accept=".eml" multiple style="display:none;">
        </div>

        <div class="wfmapmods-modal-section" style="border-bottom:none; margin-bottom:0; padding-bottom:0;">
          <div class="wfmapmods-modal-section-header">Backup / maintenance</div>
          <div class="wei-btn-row">
            <button id="wei-export" class="wfmapmods-modal-btn">Export backup JSON</button>
            <button id="wei-import-backup" class="wfmapmods-modal-btn">Import backup JSON</button>
            <input type="file" id="wei-backup-input" accept=".json,application/json" style="display:none;">
            <button id="wei-clear" class="wfmapmods-modal-btn wei-btn-danger">Clear all stored emails</button>
          </div>
          <div id="wei-log"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const dropzone = panel.querySelector('#wei-dropzone');
    const fileInput = panel.querySelector('#wei-file-input');
    const backupInput = panel.querySelector('#wei-backup-input');
    const logEl = panel.querySelector('#wei-log');
    const clientIdInput = panel.querySelector('#wei-client-id');
    const progressEl = panel.querySelector('#wei-progress');
    const syncBtn = panel.querySelector('#wei-sync');
    const fullResyncBtn = panel.querySelector('#wei-full-resync');

    clientIdInput.value = localStorage.getItem(CLIENT_ID_KEY) || '';
    clientIdInput.addEventListener('change', () => {
      localStorage.setItem(CLIENT_ID_KEY, clientIdInput.value.trim());
    });

    function log(msg, cls) {
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = msg;
      logEl.prepend(div);
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
    // deliberately-unclassified {headers, body} shape described up top, so
    // the extractor script re-classifies from the raw email itself, the
    // same way this helper does.
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

    let pointerDownOnBackdrop = false;
    panel.addEventListener('pointerdown', (ev) => {
      pointerDownOnBackdrop = (ev.target === panel);
    });
    panel.addEventListener('pointerup', (ev) => {
      if (pointerDownOnBackdrop && ev.target === panel) closePanel();
      pointerDownOnBackdrop = false;
    });
    panel.addEventListener('pointercancel', () => { pointerDownOnBackdrop = false; });

    panel.querySelector('#wei-close').addEventListener('click', closePanel);

    refreshCount();
    updateGmailStatus();
  }

  function weiEscHandler(ev) {
    if (ev.key === 'Escape') closePanel();
  }

  function openPanel() {
    buildPanel();
    const panel = document.getElementById('wei-panel');
    panel.style.display = 'flex';
    document.addEventListener('keydown', weiEscHandler);
    refreshCount();
    updateGmailStatus();
  }

  function closePanel() {
    const panel = document.getElementById('wei-panel');
    if (panel) panel.style.display = 'none';
    document.removeEventListener('keydown', weiEscHandler);
  }

  function togglePanel() {
    buildPanel();
    const panel = document.getElementById('wei-panel');
    if (panel.style.display === 'none') openPanel();
    else closePanel();
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
  function isMapModsBaseActive() {
    // v4.0.0 of the consolidated wayfarer-map-mods.user.js suite removed
    // the #wfmapmods-poi-bridge/#wfmapmods-submit-bridge DOM elements this
    // used to check for entirely (confirmed against its real source --
    // zero matches for either id; replaced internally with a private
    // "component bridge" abstraction that isn't exposed via any stable
    // public DOM contract). #wfmapmods-side-panel is still created the
    // same way, so that's the reliable "is Base loaded and running here"
    // signal now -- the same element this script's own settings-link
    // watcher already depends on.
    return !!document.getElementById('wfmapmods-side-panel');
  }

  let poiBridgeWarned = false;

  // Writes a POI onto Map Mods - Base's POI bridge -- the exact payload
  // shape its old handleBridgePoiPayload() read (confirmed against
  // v3.15.0). That bridge no longer exists as of v4.0.0 of the
  // consolidated suite (see isMapModsBaseActive() above) -- this is now a
  // documented no-op rather than silently writing to a throwaway element
  // nothing reads, which would give false confidence that something
  // happened. Kept in place (not removed, not throwing) since it's part
  // of window.WayfarerAbuseEmailImporter's public API and some external
  // caller may still invoke it; warns once, not on every call. Base
  // shows/selects a bridge-sourced POI in its own side panel when the
  // bridge existed -- it never dropped a map marker for one regardless.
  // The extractor script's own "Show on Map" (native google.maps.Marker,
  // not this bridge) is the actual working map-plotting mechanism.
  function publishPoiToMap({ guid, title, description, lat, lng, imageUrl, status, source } = {}) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('publishPoiToMap: lat/lng must be finite numbers');
    }
    if (!poiBridgeWarned) {
      poiBridgeWarned = true;
      console.warn('[Wayfarer Abuse Email Importer] publishPoiToMap() is a no-op: Map Mods - Base v4.0.0 removed the POI bridge this used to write to. Use the Abuse Report Extractor\'s own "Show on Map" instead.');
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

  // ---------------------------------------------------------------------
  // Map Mods - Base side panel integration -- same pattern as the Abuse
  // Report Extractor script (and Report Wayspots' real
  // insertReportingHistoryLinkIfReady()/insertReportingSettingsLinkIfReady()):
  // appendChild a plain <a> into ".wfmapmods-settings-links" the first time
  // it exists, found via a debounced MutationObserver gated on
  // "#wfmapmods-side-panel". Replaces the old standalone floating button --
  // the panel now opens from this link instead.
  // ---------------------------------------------------------------------

  const SETTINGS_LINK_ID = 'wei-settings-link';
  let sidePanelObserver = null;
  let sidePanelMutationScheduled = false;

  function insertSettingsLinkIfReady() {
    const settingsBody = document.querySelector('.wfmapmods-settings-links');
    if (!settingsBody) return false;
    if (document.getElementById(SETTINGS_LINK_ID)) return true;

    const link = document.createElement('a');
    link.id = SETTINGS_LINK_ID;
    link.textContent = 'Import Abuse Report Emails';
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

  registerWithMapModsBase();
  buildPanel();
  startSidePanelWatcher();
})();
