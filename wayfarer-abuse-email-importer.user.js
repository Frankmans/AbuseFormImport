// ==UserScript==
// @name         Wayfarer Map Mods - Abuse Email Importer
// @namespace    https://github.com/Frankmans/AbuseFormImport
// @version      4.11.0
// @description  Imports Niantic Support "Reporting Abuse in Wayfarer" tickets from Gmail via OAuth, or from .eml files -- using a port of bilde2910/OPR-Tools' email parser -- and stores them for the Abuse Report Extractor script (and other consumers) to search.
// @author       Frankmans
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @match        https://wayfarer.scopely.com/*
// @connect      gmail.googleapis.com
// @connect      accounts.google.com
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wst-storage.js
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js
// ==/UserScript==
// NOTE: deliberately NOT adding @inject-into page here, unlike the
// extractor's matching header -- that directive forces page-context
// execution, and GM_xmlhttpRequest (this script's whole reason for being
// sandboxed rather than @grant none like the extractor) is a sandbox-
// only API; forcing page context would very likely make it disappear
// out from under this script and break Gmail sync entirely. Every other
// field here mirrors the extractor's new header (namespace, author,
// broadened @match, document-start) -- this is the one deliberate
// exception, not an oversight.

(function () {
  'use strict';

  // @grant GM_xmlhttpRequest (needed for the Gmail API calls) sandboxes
  // this script -- its own `window` is a SEPARATE object from the real
  // page window, so a bare `WFMM`/`window.WFMM` reference from in here
  // would resolve to nothing, or to a stale sandboxed copy, never the
  // real page's window.WFMM the suite actually assigns to. unsafeWindow
  // reaches through the sandbox to the real page window -- see the
  // v4.6.1 changelog note further up for the fuller story (and why it
  // needs its own explicit @grant unsafeWindow entry, unlike @grant none
  // where window already IS unsafeWindow). Declared once, here, and
  // reused for every wfmmWindow.WFMM.* call in this file, not just the
  // Plugin Manager registration bootstrap at the bottom.
  const wfmmWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  // Niantic Support's Helpshift ticket threads, e.g. "Reporting Abuse in
  // Wayfarer" (confirmed real From address) -- see opr-email-lib.js's
  // Style.SUPPORT / Type.ABUSE_REPORT_* for how they're classified once
  // imported. Nomination-status notification senders (notices@recon.
  // nianticspatial.com, nominations@portals.ingress.com, etc.) were
  // dropped from here in v4.4.0 -- this script now only screens for
  // abuse-report tickets, not general Wayfarer/Spatial/Ingress mail.
  //
  // support-explore@scopely.com added in v4.7.4 -- confirmed real ticket
  // reply from that address, "Scopely Explore Support" as the display
  // name, otherwise using the exact same Helpshift transcript format
  // (pipe-separated "Author | Date | Time" header between rule lines) as
  // support@nianticlabs.com's own tickets, so nothing in opr-email-lib.js
  // needed to change for it to classify and extract correctly -- this is
  // purely about widening which senders Gmail sync searches for.
  // support@nianticlabs.com kept alongside it rather than replaced --
  // nothing confirms Niantic's own address has stopped sending, and
  // dropping it outright would risk missing tickets if it's still in use
  // for some accounts/regions.
  //
  // support@scopelyexplore.mail.helpshift.com added afterward, confirmed
  // via a real ticket where the only email actually received was a named
  // agent's decision reply ("Jaxson", ACTIONED) -- distinct from
  // support-explore@scopely.com above, which per that same confirmed
  // example is only where the automated "Thank you for contacting..."
  // acknowledgment comes from. This is the address actual human agent
  // replies -- the ones carrying a ticket's real Actioned/Denied/Pending
  // outcome -- send from under the Scopely+Helpshift setup, i.e. almost
  // certainly the more consequential of the two to have missing: without
  // it, Gmail sync could reliably capture that a ticket was opened but
  // never *what happened to it*, regardless of whether the reporter's
  // own copy of the opening email survives (see wae.js's own README/
  // changelog note on why a missing original submission doesn't block
  // classification or extraction on its own -- Helpshift quotes the full
  // thread in every reply, so the earlier messages are still recoverable
  // from a later one's own quoted history, AS LONG AS that later one is
  // actually being fetched in the first place).
  const SUPPORTED_SENDERS = [
    'support@nianticlabs.com',
    'support-explore@scopely.com',
    'support@scopelyexplore.mail.helpshift.com',
  ];
  const CLIENT_ID_KEY = 'wei_gmail_client_id';
  const LAST_SYNC_KEY = 'wei_gmail_last_sync_ms';
  const CONCURRENCY = 5;

  // Only what WFMM.ui's own base styles (injected via ui.injectStyle()/
  // ui.openModal() itself) don't already cover -- the modal shell,
  // buttons, text inputs, checkboxes, selects, and section headers all
  // come from the suite's own wfmm-* classes now (WFMM.ui.createElement/
  // button/textInput/checkboxRow/selectInput/section), so there's much
  // less left to define here than the old hand-copied .wfmapmods-modal-*
  // lookalike needed. See wae.js's own v1.22.0 changelog note for the
  // fuller story -- same change, applied here.
  const STYLE = `
    #wei-panel .wfmapmods-modal-dialog{ width:480px; max-width:calc(100vw - 24px); }
    .wei-sub{ font-size:11px; color:var(--wfmm-muted-text, #667085); margin-bottom:8px; }
    #wei-dropzone{
      border:2px dashed #d1d5db; border-radius:6px; padding:20px 10px; text-align:center;
      color:#6b7280; margin:6px 0; cursor:pointer; font-size:12px;
    }
    #wei-dropzone.drag{ border-color:#2563eb; color:#2563eb; }
    .wei-autosync-row{ display:flex; align-items:center; gap:6px; font-size:12px; color:#374151; margin:6px 0; cursor:default; }
    .wei-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    .wei-log{
      margin-top:8px; max-height:180px; overflow-y:auto; font-size:11px; line-height:1.5;
    }
    .wei-log div.ok{ color:#16a34a; }
    .wei-log div.skip{ color:#6b7280; }
    .wei-log div.err{ color:#dc2626; }
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
            catch (e) { reject(Object.assign(new Error('Gmail API returned something that wasn\u2019t valid JSON'), { status: res.status })); }
          } else if (res.status === 401) {
            reject(Object.assign(new Error('Gmail token expired or was revoked'), { authExpired: true, status: 401 }));
          } else {
            // status/retryAfter tagged on here (not just folded into the
            // message string) so fetchMessagesRaw()'s retry logic and
            // runSync()'s error-breakdown logging can both act on the
            // status code directly, rather than each having to re-parse
            // it back out of a formatted string -- see BUGFIX note below.
            reject(Object.assign(new Error(`Gmail API error ${res.status}: ${res.responseText.slice(0, 300)}`), {
              status: res.status,
              retryAfter: Number(res.responseHeaders?.match(/retry-after:\s*(\d+)/i)?.[1]) || null,
            }));
          }
        },
        onerror: () => reject(Object.assign(new Error('Network error calling the Gmail API'), { status: null })),
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

  // BUGFIX (not upstream): a large sync (thousands of messages) could
  // come back with a large fraction failed -- reported as 2806 out of a
  // batch failing with zero visibility into why beyond a bare count.
  // gmApiGet() itself already produced a real, specific error for each
  // failure (an HTTP status, a message), fetchMessagesRaw() just never
  // gave any of that to its caller -- see runSync()'s own updated
  // logging below for the other half of this fix. Root cause for a
  // failure spike this size is almost certainly Gmail API rate-limiting
  // (429, or occasionally 403 with a rate-limit reason instead) --
  // CONCURRENCY=5 with no backoff at all on a batch of thousands can
  // easily outrun Gmail's own per-user quota, and every single one of
  // those was being treated as a permanent failure rather than "try
  // again shortly". Retried now (exponential backoff, capped at 3
  // attempts total per message) specifically for the status codes where
  // retrying is actually the right move -- 429/403 (rate limit) and
  // 500/502/503/504 (transient server-side) -- honoring a Retry-After
  // header when Gmail sends one rather than guessing. 401 (token
  // expired) and anything else (a genuinely malformed request, a
  // permissions issue, etc.) still fail immediately, same as before --
  // retrying those would just waste time on something backoff can't fix.
  //
  // BUGFIX (not upstream): a DAILY quota error (403, reason
  // dailyLimitExceeded) is a real case that fits "backoff can't fix it"
  // just as much as a permissions error does, even though it's still a
  // quota/rate issue in the general sense -- confirmed via a real sync
  // where 2823/2823 fetches failed identically, which the short-backoff
  // retry path (meant for per-second limits that often clear within
  // seconds) would have just wasted several seconds per message on, for
  // thousands of messages, before giving up anyway -- a quota that won't
  // reset for potentially hours doesn't care how many times or how long
  // you wait within the same sync run. Split out from the short-term
  // rate-limit check below so it's identified and labeled the same way
  // (still clearly a quota issue, not a bare unexplained "HTTP 403",
  // and still excluded from being treated as instantly, permanently
  // broken) but is deliberately NOT included in what
  // weiIsRetryableError() will actually retry.
  const WEI_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
  function weiIsDailyLimitError(e) {
    return e?.status === 403 && /dailyLimitExceeded/i.test(e?.message || '');
  }
  function weiIsRateLimitError(e) {
    if (e?.status === 429) return true;
    if (weiIsDailyLimitError(e)) return false;
    // Gmail sometimes returns 403 for a rate/quota issue instead of 429 --
    // the distinguishing "reason" only shows up in the response body, not
    // the status code, so a plain 403 (an actual permissions problem) has
    // to be told apart by checking for that text rather than the status
    // alone.
    //
    // BUGFIX (not upstream): \s* between "quota" and "exceeded" -- a
    // literal quotaExceeded (no space, the older Gmail-specific reason
    // enum this already checked for) does NOT match a real confirmed
    // message using Google's newer, more generic quota-error wording
    // instead: "Quota exceeded for quota metric 'Total Query Cost' and
    // limit 'Units per minute per user'..." -- note the space. That's a
    // plain per-MINUTE quota (about as short-term as a rate limit gets),
    // but fell all the way through to an unhelpful bare "HTTP 403" with
    // zero retries, since neither this check nor weiIsDailyLimitError's
    // matched it.
    return /rateLimitExceeded|userRateLimitExceeded/i.test(e?.message || '') || /quota\s*exceeded/i.test(e?.message || '');
  }
  function weiIsRetryableError(e) {
    if (weiIsDailyLimitError(e)) return false;
    return weiIsRateLimitError(e) || WEI_RETRYABLE_STATUSES.has(e?.status);
  }
  function weiSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function weiDescribeFetchError(e) {
    if (weiIsDailyLimitError(e)) return `daily quota exceeded (HTTP ${e.status})`;
    if (weiIsRateLimitError(e)) return `rate limited (HTTP ${e.status})`;
    if (WEI_RETRYABLE_STATUSES.has(e?.status)) return `transient server error (HTTP ${e.status})`;
    if (e?.status) return `HTTP ${e.status}`;
    return 'network error';
  }

  // BUGFIX (not upstream): even with weiIsRateLimitError() now correctly
  // catching this, a per-MESSAGE retry alone isn't enough for a "Units
  // per minute per user" quota specifically -- confirmed via a real sync
  // where 3274/3274 fetches failed the same way. That quota is shared
  // across every concurrent request this script makes, not per-message,
  // so with CONCURRENCY=5 workers all still firing new requests the
  // instant one of them backs off, the other four just re-hit the exact
  // same still-exhausted quota within milliseconds -- individually
  // backing off one message at a time can never actually let a shared
  // per-minute budget recover. weiQuotaCooldownUntil is a MODULE-level
  // gate every worker checks before its next request (not just the one
  // that got the 403) -- whichever worker hits this error first pauses
  // ALL of them for WEI_QUOTA_COOLDOWN_MS, rather than each discovering
  // the same exhausted quota independently, one 403 at a time. 65s
  // (rather than a flat 60s) intentionally overshoots a per-minute
  // window rather than racing its exact edge, in case this fetch's own
  // "now" and Google's own quota-window boundary aren't perfectly
  // aligned.
  const WEI_QUOTA_COOLDOWN_MS = 65000;
  let weiQuotaCooldownUntil = 0;

  // Bounded-concurrency fetch of each message's raw RFC822 content.
  async function fetchMessagesRaw(ids, token, onProgress) {
    const results = new Array(ids.length);
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < ids.length) {
        const i = cursor++;
        if (Date.now() < weiQuotaCooldownUntil) {
          await weiSleep(weiQuotaCooldownUntil - Date.now());
        }
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ids[i]}?format=raw`;
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const msg = await gmApiGet(url, token);
            results[i] = { id: ids[i], raw: msg.raw, error: null };
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            if (weiIsRateLimitError(e)) {
              // Shared cooldown, not just this one message's own retry
              // delay -- see WEI_QUOTA_COOLDOWN_MS's own comment. Only
              // ever pushes the deadline further out, never back in, so
              // several workers hitting this around the same time don't
              // each reset it to a shorter wait than what's already
              // in effect.
              weiQuotaCooldownUntil = Math.max(weiQuotaCooldownUntil, Date.now() + (e.retryAfter ? e.retryAfter * 1000 : WEI_QUOTA_COOLDOWN_MS));
            }
            if (attempt < 2 && weiIsRetryableError(e)) {
              if (weiIsRateLimitError(e)) {
                await weiSleep(Math.max(0, weiQuotaCooldownUntil - Date.now()));
              } else {
                await weiSleep(e.retryAfter ? e.retryAfter * 1000 : 500 * Math.pow(2, attempt));
              }
              continue;
            }
            break;
          }
        }
        if (lastError) results[i] = { id: ids[i], raw: null, error: lastError };
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

  // BUGFIX (not upstream, better-integration pass): auto-sync's
  // enabled/interval used to live in raw localStorage
  // (wei_autosync_enabled/wei_autosync_interval_min) -- invisible to
  // WFMM's own Settings > Backups export/import, unlike every setting a
  // bundled plugin registers through WFMM.settings.registerPlugin().
  // Moved into that same registry (see startPlugin(), which registers
  // WEI_SETTINGS_DEFAULTS under this plugin's own id and migrates
  // whatever was in the old keys the first time this runs) so it's
  // backed up/restored the same way. CLIENT_ID_KEY deliberately stays in
  // localStorage -- see its own comment further up; it's a per-browser
  // OAuth client id, not really a "preference" in the sense Backups is
  // for, and LAST_SYNC_KEY is internal sync bookkeeping, not a setting
  // at all.
  const WEI_SETTINGS_DEFAULTS = Object.freeze({
    autoSync: { enabled: false, intervalMin: 15 },
    // Added in v4.11.0 -- see this file's own changelog entry above.
    scanAfterImport: false,
  });
  function loadAutoSyncSettings() {
    const saved = wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'autoSync', WEI_SETTINGS_DEFAULTS.autoSync) || {};
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : WEI_SETTINGS_DEFAULTS.autoSync.enabled,
      intervalMin: Number(saved.intervalMin) || WEI_SETTINGS_DEFAULTS.autoSync.intervalMin,
    };
  }
  function saveAutoSyncSettings(enabled, intervalMin) {
    wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'autoSync', {
      enabled: !!enabled,
      intervalMin: Number(intervalMin) || WEI_SETTINGS_DEFAULTS.autoSync.intervalMin,
    });
  }
  function loadScanAfterImport() {
    return !!wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'scanAfterImport', WEI_SETTINGS_DEFAULTS.scanAfterImport);
  }
  function saveScanAfterImport(enabled) {
    wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'scanAfterImport', !!enabled);
  }

  // WFMM.ui, set while the panel is open, and the currently-open panel's
  // live DOM refs -- same pattern as the extractor script's own waeUiApi/
  // waeUI (see its v1.22.0 changelog note). Both null while the panel is
  // closed, since WFMM.ui.openModal() tears the dialog down on close
  // instead of just hiding it, the way the old backdrop did.
  let weiUiApi = null;
  let weiUI = null;
  let weiPanelController = null;

  // Auto-sync keeps running in the background whether or not the panel is
  // open (that was already true before this refactor -- the old backdrop
  // just stayed in the DOM hidden). Logging and progress text now have to
  // tolerate the panel being closed: weiLog() below buffers into
  // weiPendingLog (oldest-first, capped) when there's no logEl to write
  // into, and flushes it into the fresh logEl next time the panel opens,
  // so nothing a background tick logged gets silently lost.
  let weiPendingLog = [];

  function weiLog(msg, cls) {
    if (weiUI) {
      weiUI.logEl.prepend(weiUiApi.createElement('div', { className: cls || '', text: msg }));
      while (weiUI.logEl.children.length > 200) weiUI.logEl.removeChild(weiUI.logEl.lastChild);
      return;
    }
    weiPendingLog.push({ msg, cls });
    if (weiPendingLog.length > 50) weiPendingLog.shift();
  }

  function weiSetProgress(text) {
    if (weiUI) weiUI.progressEl.textContent = text;
  }

  async function refreshCount() {
    if (!weiUI) return;
    try {
      const n = await WSTStorage.countEmails();
      weiUI.countEl.textContent = `${n} email(s) stored. Open Abuse Reports to scan them.`;
    } catch (e) {
      weiUI.countEl.textContent = 'Could not read the email store.';
    }
  }

  function updateGmailStatus() {
    if (!weiUI) return;
    const lastSync = localStorage.getItem(LAST_SYNC_KEY);
    const auto = loadAutoSyncSettings();
    const autoSuffix = auto.enabled ? ` Auto-sync: every ${auto.intervalMin} min.` : '';
    if (accessToken) {
      weiUI.gmailStatusEl.textContent = (lastSync
        ? `Connected. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
        : 'Connected. Never synced yet.') + autoSuffix;
    } else {
      weiUI.gmailStatusEl.textContent = (lastSync
        ? `Not connected this session. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
        : 'Not connected.') + autoSuffix;
    }
  }

  // Feature request (v4.11.0): with the "Also scan for reports after
  // importing" checkbox on, every import path below (Gmail sync, .eml
  // drop/pick, backup-JSON restore) calls this right after actually
  // storing at least one new/updated email, asking the companion Abuse
  // Report Extractor script to scan immediately rather than leaving that
  // as a separate manual step in that script's own panel. One shared
  // function rather than the setting check and the bridge call duplicated
  // at each of those call sites. Warns once (not on every import) if the
  // companion script isn't installed/hasn't loaded, same restraint
  // publishPoiToMap()'s own no-op warning already uses for a missing
  // Base -- this checks wfmmWindow.WayfarerAbuseReportExtractor, that
  // script's own new external entry point (see its v1.53.7 changelog),
  // published on wfmmWindow for the identical sandboxing reason this
  // file's own wfmmWindow.WayfarerAbuseEmailImporter assignment further
  // down exists (see that assignment's own comment) -- just reached in
  // the opposite direction here.
  let weiScanBridgeWarned = false;
  async function weiTriggerScanIfEnabled() {
    if (!loadScanAfterImport()) return;
    const bridge = wfmmWindow.WayfarerAbuseReportExtractor;
    if (!bridge || typeof bridge.scanImportedEmails !== 'function') {
      if (!weiScanBridgeWarned) {
        weiScanBridgeWarned = true;
        weiLog('Scan-after-import is on, but the Abuse Report Extractor script wasn\u2019t detected -- skipping.', 'skip');
      }
      return;
    }
    try {
      await bridge.scanImportedEmails();
      weiLog('\u2713 Scanned for abuse reports.', 'ok');
    } catch (e) {
      weiLog(`Scan-after-import failed: ${e.message || e}`, 'err');
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
        weiLog(`✗ ${file.name}: could not read file`, 'err');
        parseErrors++;
        continue;
      }
      try {
        records.push(emlToRecord(text, file.name));
      } catch (e) {
        weiLog(`✗ ${file.name}: ${e.message || e}`, 'err');
        parseErrors++;
      }
    }

    if (records.length) {
      const { inserted, updated } = await WSTStorage.putEmails(records);
      const abuseCount = countAbuseReports(records);
      const abuseSuffix = abuseCount ? `, ${abuseCount} abuse report ticket${abuseCount === 1 ? '' : 's'}` : '';
      weiLog(`✓ Imported ${records.length} file(s): ${inserted} new, ${updated} updated${abuseSuffix}`, 'ok');
      await weiTriggerScanIfEnabled();
    }
    if (parseErrors) weiLog(`${parseErrors} file(s) could not be parsed as MIME email`, 'err');
    await refreshCount();
  }

  // ---- Gmail sync ----
  //
  // Moved to module scope (used to live inside buildPanel(), closed over
  // that one persistent panel's elements). Now reads the OAuth Client ID
  // from localStorage directly rather than a live input -- this needs to
  // keep working from a background auto-sync tick even while the panel is
  // closed and no such input exists. weiSetProgress()/weiUI-guarded button
  // toggling below are no-ops in that case; see weiLog()'s comment above
  // for the same reasoning applied to logging.
  async function runSync(forceFull, opts) {
    const auto = !!(opts && opts.auto);
    const clientId = (localStorage.getItem(CLIENT_ID_KEY) || '').trim();
    if (!clientId) {
      if (!auto) weiLog('Paste your OAuth Client ID first', 'err');
      return;
    }

    if (weiUI) { weiUI.syncBtn.disabled = true; weiUI.fullResyncBtn.disabled = true; }
    weiSetProgress(auto ? 'Auto-sync: connecting to Gmail\u2026' : 'Connecting to Gmail\u2026');

    const lastSyncMs = forceFull ? null : Number(localStorage.getItem(LAST_SYNC_KEY)) || null;
    const syncStartedAt = Date.now();

    try {
      let token;
      try {
        token = await getValidToken(clientId, { forceNonInteractive: auto });
      } catch (e) {
        if (auto) {
          weiLog('Auto-sync skipped this round: Gmail sign-in needed -- click "Sync new emails" once to reconnect', 'skip');
          return;
        }
        throw e;
      }
      updateGmailStatus();

      const query = buildGmailQuery(lastSyncMs);
      weiSetProgress('Listing matching messages\u2026');
      const ids = await listAllMessageIds(query, token, (n) => {
        weiSetProgress(`Found ${n} matching message(s) so far\u2026`);
      });

      if (ids.length === 0) {
        weiLog(auto ? 'Auto-sync: no new messages found' : 'No new messages found', 'skip');
        localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
        updateGmailStatus();
        return;
      }

      weiSetProgress(`Fetching ${ids.length} message(s)\u2026`);
      const raws = await fetchMessagesRaw(ids, token, (done, total) => {
        weiSetProgress(`Fetching messages\u2026 ${done}/${total}`);
      });

      const records = [];
      let parseErrors = 0;
      // Grouped by a readable label rather than logged once per message --
      // with a failure count in the thousands, one line per message would
      // both flood the 200-line log cap and bury everything else in it,
      // Grouped by a readable label rather than logged once per message --
      // with a failure count in the thousands, one line per message would
      // both flood the 200-line log cap and bury everything else in it.
      // A sample of the actual error TEXT for each label (not just the
      // label itself) is kept alongside the count -- BUGFIX (not
      // upstream): the first version of this only showed a guessed label
      // ("HTTP 403") with nothing else, which turned out not to be enough
      // to actually diagnose a real case (2823/2823 failing with the same
      // status, consistently -- not the scattered pattern per-second rate-
      // limiting would produce, and not matched by the rateLimitExceeded/
      // quotaExceeded text this already checked for, so it fell through
      // to a bare, unhelpful "HTTP 403"). Rather than keep guessing at
      // every possible reason string Gmail might send back, showing
      // Gmail's own actual message text directly answers it without
      // another guess-and-check round trip.
      const fetchErrorCounts = new Map();
      const fetchErrorSamples = new Map();
      let authExpiredSeen = false;
      for (const r of raws) {
        if (r.error) {
          if (r.error.authExpired) {
            authExpiredSeen = true;
          } else {
            const label = weiDescribeFetchError(r.error);
            fetchErrorCounts.set(label, (fetchErrorCounts.get(label) || 0) + 1);
            if (!fetchErrorSamples.has(label)) fetchErrorSamples.set(label, r.error.message || String(r.error));
          }
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
        weiLog(`✓ ${auto ? 'Auto-sync: synced' : 'Synced'} ${records.length} message(s) from Gmail: ${inserted} new, ${updated} updated${abuseSuffix}`, 'ok');
        await weiTriggerScanIfEnabled();
      }
      if (authExpiredSeen) weiLog('Gmail token expired mid-sync -- run Sync again to resume', 'err');
      const totalFetchErrors = Array.from(fetchErrorCounts.values()).reduce((a, b) => a + b, 0);
      if (totalFetchErrors) {
        const breakdown = Array.from(fetchErrorCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => `${count} ${label}`)
          .join(', ');
        weiLog(`✗ ${totalFetchErrors} message(s) failed to fetch: ${breakdown}`, 'err');
        for (const [label, sample] of fetchErrorSamples.entries()) {
          weiLog(`  ${label} sample: ${sample}`, 'err');
        }
        if (Array.from(fetchErrorCounts.keys()).some((label) => label.startsWith('rate limited'))) {
          weiLog('Most/all of those were rate-limited by Gmail -- already retried automatically a couple of times each. If some are still missing, try Sync again in a few minutes, or turn down how often Auto-sync runs.', 'skip');
        }
        if (Array.from(fetchErrorCounts.keys()).some((label) => label.startsWith('daily quota exceeded'))) {
          weiLog('Those hit a DAILY Gmail API quota -- unlike a per-second rate limit, that won\u2019t clear for potentially hours, so retrying again soon (today) will very likely fail the same way. Try again tomorrow, or check/raise the quota on the Google Cloud project this OAuth Client ID belongs to.', 'skip');
        }
      }
      if (parseErrors) weiLog(`${parseErrors} message(s) could not be parsed as MIME email`, 'err');

      localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
    } catch (e) {
      weiLog(`${auto ? 'Auto-sync failed: ' : 'Gmail sync failed: '}${e.message || e}`, 'err');
    } finally {
      weiSetProgress('');
      if (weiUI) { weiUI.syncBtn.disabled = false; weiUI.fullResyncBtn.disabled = false; }
      updateGmailStatus();
      await refreshCount();
    }
  }

  // ---- Auto-sync ----
  // Also moved to module scope -- this has to keep ticking for the page's
  // lifetime regardless of whether the panel is currently mounted.

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

  // Builds the panel's BODY content into an already-open WFMM.ui modal --
  // called as openModal()'s buildContent(modalController). See wae.js's
  // own buildPanelContent() for the fuller explanation of this pattern;
  // same shape here.
  function buildPanelContent(modal) {
    const ui = modal.ui;
    weiUiApi = ui;

    const countEl = ui.createElement('div', { className: 'wei-sub', text: 'Loading...' });

    // Feature request (v4.11.0): saved via loadScanAfterImport()/
    // saveScanAfterImport() (own small wrapper around the same
    // WFMM.settings registry autoSync already uses -- see
    // WEI_SETTINGS_DEFAULTS' own comment), read by weiTriggerScanIfEnabled(),
    // which every import path below (Gmail sync, .eml drop/pick, backup
    // restore) already calls. Placed above every section rather than
    // inside just one of them since it applies to all of those paths, not
    // only Gmail or only .eml.
    const scanAfterImportToggle = ui.checkboxRow({
      label: 'Also scan for reports after importing',
      checked: loadScanAfterImport(),
      onChange: (checked) => saveScanAfterImport(checked),
    });

    // -- Connect Gmail --
    const clientIdInput = ui.textInput({
      className: 'wfmm-input wfmm-input-large',
      placeholder: 'OAuth Client ID (ends in .apps.googleusercontent.com)',
      value: localStorage.getItem(CLIENT_ID_KEY) || '',
    });
    clientIdInput.addEventListener('change', () => {
      localStorage.setItem(CLIENT_ID_KEY, clientIdInput.value.trim());
    });

    const gmailStatusEl = ui.createElement('div', { className: 'wei-sub', text: 'Not connected.' });
    const progressEl = ui.createElement('div', { className: 'wei-progress' });

    const syncBtn = ui.button({
      text: 'Sync new emails',
      variant: 'primary',
      onClick: () => runSync(false),
    });
    const fullResyncBtn = ui.button({
      text: 'Force full re-sync',
      onClick: () => {
        if (confirm('Re-fetch your entire matching mailbox history from Gmail, not just what\u2019s new since last sync?')) {
          runSync(true);
        }
      },
    });
    const syncBtnRow = ui.buttonRow([syncBtn, fullResyncBtn]);

    const savedAutoSync = loadAutoSyncSettings();
    const autoSyncInterval = ui.selectInput({
      options: [
        { value: '5', label: '5 min' },
        { value: '15', label: '15 min' },
        { value: '30', label: '30 min' },
        { value: '60', label: '60 min' },
      ],
      value: String(savedAutoSync.intervalMin),
      onChange: (value) => {
        const intervalMin = Number(value);
        saveAutoSyncSettings(autoSyncToggle.input.checked, intervalMin);
        if (autoSyncToggle.input.checked) startAutoSync(intervalMin);
      },
    });
    const autoSyncToggle = ui.checkboxRow({
      label: 'Auto-sync every',
      checked: savedAutoSync.enabled,
      onChange: (checked) => {
        const intervalMin = Number(autoSyncInterval.value);
        saveAutoSyncSettings(checked, intervalMin);
        if (checked) {
          // This click IS a direct user gesture, so an interactive consent
          // popup is allowed here if needed -- establishes the session that
          // subsequent silent background ticks can then reuse.
          runSync(false, { auto: false });
          startAutoSync(intervalMin);
          weiLog(`Auto-sync enabled -- syncing every ${intervalMin} minute(s)`, 'ok');
        } else {
          stopAutoSync();
          weiLog('Auto-sync disabled', 'skip');
        }
      },
    });
    // checkboxRow()'s own label only covers "Auto-sync every" -- the
    // interval select belongs in the same row, after it.
    autoSyncToggle.row.appendChild(autoSyncInterval);

    const gmailSection = ui.section({
      title: 'Connect Gmail',
      children: [clientIdInput, gmailStatusEl, progressEl, syncBtnRow, autoSyncToggle.row],
    });

    // -- Or drop .eml files --
    const dropzone = ui.createElement('div', { id: 'wei-dropzone', text: 'Drop .eml files here, or click to choose' });
    const fileInput = ui.createElement('input', {
      attrs: { type: 'file', accept: '.eml', multiple: true },
      style: { display: 'none' },
    });
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.eml'));
      if (files.length) importFiles(files);
      else weiLog('No .eml files found in the drop', 'skip');
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      fileInput.value = '';
      if (files.length) importFiles(files);
    });
    const emlSection = ui.section({
      title: 'Or drop .eml files',
      children: [dropzone, fileInput],
    });

    // -- Backup / maintenance --
    const exportBtn = ui.button({
      text: 'Export backup JSON',
      onClick: async () => {
        const all = await WSTStorage.getAllEmails();
        const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), emails: all })], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `wst-email-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        weiLog(`Exported ${all.length} email(s) to a backup file`, 'ok');
      },
    });
    const backupInput = ui.createElement('input', {
      attrs: { type: 'file', accept: '.json,application/json' },
      style: { display: 'none' },
    });
    const importBackupBtn = ui.button({ text: 'Import backup JSON', onClick: () => backupInput.click() });
    backupInput.addEventListener('change', async () => {
      const file = backupInput.files[0];
      backupInput.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const emails = Array.isArray(parsed) ? parsed : parsed.emails;
        if (!Array.isArray(emails)) { weiLog('That file doesn\u2019t look like a valid backup', 'err'); return; }
        const { inserted, updated } = await WSTStorage.putEmails(emails);
        weiLog(`✓ Restored backup: ${inserted} new, ${updated} updated`, 'ok');
        if (inserted || updated) await weiTriggerScanIfEnabled();
        await refreshCount();
      } catch (e) {
        weiLog(`Could not read that backup file: ${e.message || e}`, 'err');
      }
    });
    const clearBtn = ui.button({
      text: 'Clear all stored emails',
      variant: 'danger',
      onClick: async () => {
        if (!confirm('Delete every stored email from this browser? This cannot be undone (export a backup first if unsure).')) return;
        await WSTStorage.clearAll();
        weiLog('All stored emails cleared', 'skip');
        await refreshCount();
      },
    });
    const backupBtnRow = ui.buttonRow([exportBtn, importBackupBtn, clearBtn]);
    const logEl = ui.createElement('div', { className: 'wei-log' });
    const backupSection = ui.section({
      title: 'Backup / maintenance',
      noBorder: true,
      children: [backupBtnRow, backupInput, logEl],
    });

    modal.body.append(countEl, scanAfterImportToggle.row, gmailSection, emlSection, backupSection);

    weiUI = { countEl, gmailStatusEl, progressEl, syncBtn, fullResyncBtn, logEl };

    // Flush anything logged while the panel was closed (a background
    // auto-sync tick, most likely) -- see weiLog()'s comment above.
    for (const entry of weiPendingLog) {
      logEl.prepend(ui.createElement('div', { className: entry.cls || '', text: entry.msg }));
    }
    weiPendingLog = [];

    refreshCount();
    updateGmailStatus();

    return {
      onClose() {
        weiUI = null;
        weiPanelController = null;
      },
    };
  }

  function openPanel() {
    if (weiPanelController) return; // already open
    weiPanelController = wfmmWindow.WFMM.ui.openModal({
      id: 'wei-panel',
      title: 'Wayfarer Map Mods - Abuse Email Importer',
      className: 'wei-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      // See wae.js's own openPanel() comment -- same story here.
      // Draggable/resizable already work automatically through
      // openModal() once the user turns on "Make modals draggable"/"Make
      // modals resizeable" in Base's Side Panel settings; a plugin can't
      // force it on for just its own modal. minWidth/minHeight only
      // matter once resizing is on.
      desktopInteractions: { minWidth: 360, minHeight: 280 },
      buildContent: buildPanelContent,
    });
  }

  function closePanel() {
    weiPanelController?.close();
  }

  function togglePanel() {
    if (weiPanelController) closePanel();
    else openPanel();
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
    // BUGFIX (not upstream, better-integration pass): this used to sniff
    // for the #wfmapmods-side-panel DOM element directly -- an internal
    // implementation detail of Base's own side panel, not anything it
    // exposes as a contract. Base's real, public "am I here" signal is
    // window.WFMM itself (assigned once Base's core has bootstrapped,
    // confirmed against its source -- this same wfmmWindow.WFMM is what
    // registerOrSelfStart() below already polls for). Checking for
    // WFMM.sidePanel specifically -- rather than just truthy WFMM --
    // matches what this function is actually used to gate (whether
    // appendSettingsAction()/onReady()/onCleared() below have anything to
    // attach to), and stays accurate even in the hypothetical case where
    // WFMM exists but hasn't populated sidePanel yet.
    return !!wfmmWindow.WFMM?.sidePanel;
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
      console.warn('[Wayfarer Map Mods - Abuse Email Importer] publishPoiToMap() is a no-op: Map Mods - Base v4.0.0 removed the POI bridge this used to write to. Use the Abuse Report Extractor\'s own "Show on Map" instead.');
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

  // BUGFIX (v4.10.1, not caught in the v4.10.0 pass that added
  // openPanel/closePanel/togglePanel/isPanelOpen to this object): this
  // used bare `window.WayfarerAbuseEmailImporter = ...` here, but this
  // whole script is sandboxed (@grant GM_xmlhttpRequest/unsafeWindow --
  // see wfmmWindow's own comment near the top of this file), so its own
  // `window` is NOT the real page window, the same distinction that
  // comment already exists to explain for reading wfmmWindow.WFMM. The
  // assignment was landing on this script's own sandbox object the whole
  // time -- invisible to the real page, and so invisible to the
  // Abuse Report Extractor's own page-context @inject-into page code
  // (confirmed in the field: its panel showed "Abuse Email Importer
  // script not detected" even with this script loaded and running with
  // no errors of its own). getAbuseReportRecords/publishPoiToMap/
  // isMapModsBaseActive were exposed the same broken way before this
  // version too -- just never actually consumed by anything external
  // until the extractor's own v1.44.0 tried to call in, which is what
  // surfaced it. Fixed by publishing on wfmmWindow instead, the same
  // object every WFMM.* call in this file already goes through.
  wfmmWindow.WayfarerAbuseEmailImporter = {
    getAbuseReportRecords,
    publishPoiToMap,
    isMapModsBaseActive,
    // Added so the Abuse Report Extractor's own panel can open this
    // script's panel directly -- see the removed attachSettingsAction()/
    // detachSettingsAction() section below (right after
    // registerWithMapModsBase()) for why that's now the only entry point
    // into this UI.
    openPanel,
    closePanel,
    togglePanel,
    isPanelOpen: () => !!weiPanelController,
  };

  function registerWithMapModsBase() {
    if (isMapModsBaseActive()) {
      console.info('[Wayfarer Map Mods - Abuse Email Importer] Map Mods - Base detected -- window.WayfarerAbuseEmailImporter is available.');
    } else {
      // Not necessarily an error -- Base uses @run-at document-start and
      // we're document-idle, so this is usually just "hasn't run yet".
      // Re-check once after a beat rather than only logging a possibly-
      // stale negative result.
      setTimeout(() => {
        console.info(
          isMapModsBaseActive()
            ? '[Wayfarer Map Mods - Abuse Email Importer] Map Mods - Base detected -- window.WayfarerAbuseEmailImporter is available.'
            : '[Wayfarer Map Mods - Abuse Email Importer] Map Mods - Base not detected on this page. window.WayfarerAbuseEmailImporter is still available, but publishPoiToMap() will have nothing to show until Base loads.'
        );
      }, 2000);
    }
  }

  // ---------------------------------------------------------------------
  // BUGFIX (not upstream, feature request): this used to have its own
  // separate "Import Abuse Report Emails" entry in Base's Settings side-
  // panel list (appendSettingsAction(), replacing an even older hand-
  // rolled MutationObserver version -- see the v4.9.0 changelog note at
  // the top for that whole history). Removed outright, not just hidden:
  // the companion Abuse Report Extractor script now has its own small
  // envelope icon, next to its Marker Style cog, in its own panel's
  // header row -- calling window.WayfarerAbuseEmailImporter.togglePanel()
  // (exposed above) directly -- so there is exactly one entry in the
  // native Settings list ("Abuse Report Extractor") rather than two
  // separate ones a reviewer would have to already know to look for
  // individually. Same reasoning the extractor's own v1.x applied when
  // its Marker Style settings dropped their own separate Settings entry
  // in favor of a cog button inside its panel (see that script's
  // buildPanelContent(), the comment on its own markerStyleBtn).
  // openPanel()/closePanel()/togglePanel() themselves are unchanged --
  // still this script's own real panel, just no longer self-adding a
  // second link to reach it from.
  // ---------------------------------------------------------------------

  // One-time migration from the old raw-localStorage keys (removed from
  // this file as of v4.9.1, see WEI_SETTINGS_DEFAULTS' own comment) into
  // WFMM.settings -- only runs if this plugin id has genuinely never been
  // registered with WFMM.settings before (get() with no fallback comes
  // back undefined only in that case; registerPlugin() itself always
  // leaves AT LEAST {} behind after the first call, so this can't
  // accidentally re-run and clobber a real choice made after upgrading).
  // Old keys are removed once migrated so this doesn't leave two sources
  // of truth lying around, silently disagreeing, forever.
  function weiMigrateLegacySettingsIfNeeded() {
    if (wfmmWindow.WFMM.settings.get(PLUGIN_ID) !== undefined) return; // already registered -- nothing to migrate
    const legacyEnabled = localStorage.getItem('wei_autosync_enabled');
    const legacyIntervalMin = localStorage.getItem('wei_autosync_interval_min');
    if (legacyEnabled === null && legacyIntervalMin === null) return; // fresh install -- defaults are already correct
    wfmmWindow.WFMM.settings.setPlugin(PLUGIN_ID, {
      autoSync: {
        enabled: legacyEnabled === 'true',
        intervalMin: Number(legacyIntervalMin) || WEI_SETTINGS_DEFAULTS.autoSync.intervalMin,
      },
    });
    localStorage.removeItem('wei_autosync_enabled');
    localStorage.removeItem('wei_autosync_interval_min');
  }

  function startPlugin() {
    registerWithMapModsBase();
    // Registering as an external plugin already implies WFMM.ui exists --
    // see wae.js's own startPlugin() comment for why. injectStyle() is
    // idempotent (replaces by id), safe to call on every startPlugin().
    wfmmWindow.WFMM.ui.injectStyle('wei-extra-styles', STYLE);
    // Migrate BEFORE registering defaults -- registerPlugin() itself is
    // what makes get(PLUGIN_ID) stop looking "never registered" to the
    // check above, so migration has to run against whatever's already
    // there first.
    weiMigrateLegacySettingsIfNeeded();
    wfmmWindow.WFMM.settings.registerPlugin(PLUGIN_ID, WEI_SETTINGS_DEFAULTS);
    // No more attachSettingsAction()/onReady()/onCleared() here -- see
    // the comment right above registerWithMapModsBase() for why this no
    // longer adds its own Settings side-panel entry at all.
    // Auto-sync used to only start the first time buildPanel() ever ran
    // (which happened here too, since startPlugin() called it eagerly).
    // Now that the panel's DOM is only built on open, this has moved out
    // on its own -- auto-sync should begin as soon as the plugin starts,
    // whether or not anyone ever opens the panel.
    const savedAutoSync = loadAutoSyncSettings();
    if (savedAutoSync.enabled) startAutoSync(savedAutoSync.intervalMin);
  }

  function stopPlugin() {
    closePanel(); // no-op if the panel isn't open; openModal's own close() tears its DOM down
    stopAutoSync();
  }

  // ---------------------------------------------------------------------
  // Map Mods plugin manager registration -- v4.0.0 of the consolidated
  // suite added a real external-plugin API (confirmed against its source:
  // window.WFMM.plugins.registerExternal()), which makes this show up as
  // a normal entry in the suite's own Plugin Manager settings screen
  // (#wfmm-plugin-manager-modal) with a name/description/enable-toggle,
  // same as any of its own bundled features. WFMM calls create().start()
  // for us once registered (as part of its own startup sequence, or
  // immediately if the suite already finished starting) -- we must NOT
  // also call startPlugin() ourselves after a successful registration, or
  // it would start twice. stop() runs if the user disables it from that
  // screen.
  //
  // Falls back to the old self-starting behavior (no Plugin Manager
  // entry, just the settings-link-in-side-panel approach from earlier
  // versions) if window.WFMM.plugins never becomes available within 5s --
  // covers an older Base version, or this script's own document-idle
  // timing landing before the suite has run at all.
  // ---------------------------------------------------------------------

  const PLUGIN_ID = 'wayfarer-abuse-email-importer';
  const PLUGIN_DEFINITION = {
    id: PLUGIN_ID,
    name: (typeof GM_info !== 'undefined' && GM_info.script?.name) || 'Wayfarer Map Mods - Abuse Email Importer',
    description: 'Imports Niantic Support "Reporting Abuse in Wayfarer" tickets from Gmail or .eml files, for the Abuse Report Extractor to scan.',
    source: 'external',
    requirement: 'optional',
    author: (typeof GM_info !== 'undefined' && GM_info.script?.author) || 'unknown',
    version: (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0.0.0',
    namespace: (typeof GM_info !== 'undefined' && GM_info.script?.namespace) || undefined,
    apiVersion: 1,
    create() {
      return { start: startPlugin, stop: stopPlugin };
    },
  };

  // wfmmWindow is declared once, near the top of this file (see that
  // comment for why) -- reused here unchanged from earlier versions. This
  // is the confirmed cause of "script works standalone, but the suite's
  // Plugin Manager shows nothing under External plugins" if it's ever
  // missing: registration silently never happens, the 5s timeout below
  // always elapses, and self-start quietly takes over every time.
  function registerOrSelfStart(attemptsLeft) {
    const plugins = wfmmWindow.WFMM && wfmmWindow.WFMM.plugins;
    if (plugins && typeof plugins.registerExternal === 'function') {
      try {
        plugins.registerExternal(PLUGIN_DEFINITION);
        return; // registered -- WFMM owns calling start()/stop() from here
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Email Importer] Plugin Manager registration failed, self-starting instead:', e);
        startPlugin();
        return;
      }
    }
    if (attemptsLeft > 0) {
      setTimeout(() => registerOrSelfStart(attemptsLeft - 1), 250);
      return;
    }
    console.warn('[Wayfarer Map Mods - Abuse Email Importer] Map Mods plugin manager not detected after 5s -- self-starting instead.');
    startPlugin();
  }

  registerOrSelfStart(20); // 20 * 250ms = 5s
})();
