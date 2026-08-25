// ==UserScript==
// @name         Wayfarer Abuse Report Extractor
// @namespace    https://wayfarer.nianticlabs.com/new
// @version      1.15.0
// @description  Scans emails already imported by Wayfarer Abuse Email Importer for Niantic Support "Reporting Abuse" tickets, extracts every reported Wayspot's name + coordinates (a ticket can report several, across the original submission and later replies), stores them locally, plots them on the Wayfarer map, and exports as CSV.
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
 * v1.15.0 CHANGE FROM v1.14.0: the Status column is now a friendly,
 * color-coded badge (Received/Pending Review/Actioned/Denied/Updated)
 * instead of a raw ABUSE_REPORT_* enum suffix -- reflects opr-email-
 * lib.js's confirmed-accurate three-way resolution classification (see
 * that file's own changelog note): Actioned and Denied both mean nothing
 * further to do here, Pending Review means revisit later. Also included
 * in search (querying "pending" now matches) and the CSV export.
 *
 * v1.14.0 CHANGE FROM v1.13.0: fixed markers not showing (or vanishing)
 * once you'd zoomed into a specific Wayspot -- Wayfarer's zoomed-in
 * submit/edit view uses a genuinely different map component
 * (app-submit-wayspot-map) with its own separate google.maps.Map object
 * than the general mapview (app-wf-base-map); waeGetWfMap() already had
 * to query for both. A Marker only ever renders on the one Map object it
 * was created against, so switching between those views made every
 * marker silently disappear, with nothing re-attaching automatically
 * until "Show on Map" was manually toggled off and on again. Added a
 * lightweight watch (2s interval, only running while pins are toggled
 * on) that notices the map object going stale and re-attaches + rebuilds
 * on its own. Cheap by design -- waeIsMapStale() is a trivial DOM check,
 * and real work only happens on the rare tick where the map actually
 * changed -- so this doesn't reintroduce the per-pan/zoom cost the
 * v1.12.0/v1.13.0 fixes removed.
 *
 * v1.13.0 CHANGE FROM v1.12.0: fixed the panel hanging (visible as a
 * white screen while it's blocked mid-open) once enough data had
 * accumulated. Two compounding causes:
 *   1. refreshPanel() recomputed the nearby-duplicate map unconditionally
 *      -- including on every plain panel OPEN, not just when data
 *      actually changed. With a few thousand accumulated rows (easy to
 *      reach given one ticket can extract 15-20+ locations) that
 *      recompute alone measured ~2.4s at 10,000 rows. It's now skipped
 *      unless the record set's fingerprint (count + latest scannedAt)
 *      actually changed since last time -- opening the panel again with
 *      nothing new to show now does zero duplicate-detection work.
 *   2. waeFindNearbyDuplicates() itself was a full O(n^2) pairwise scan.
 *      Rewritten to bucket records into a ~111m lat/lng grid and only
 *      compare each record against its 3x3 cell neighborhood -- real
 *      locations spread across a country mean most pairs are nowhere
 *      near each other, so this is close to O(n) in practice. Confirmed:
 *      same output as the old pairwise version on a known test case,
 *      ~37x faster at 10,000 rows (2.4s -> 65ms), and a dense
 *      1000-point same-cell cluster still resolves in ~30ms.
 *
 * v1.12.0 CHANGE FROM v1.11.0: fixed "Show on Map" getting slow with more
 * than a couple dozen markers. Two separate causes, both fixed:
 *   1. waeRefreshPulses() called getAllExtractedRecords() (a full
 *      IndexedDB read) itself, and ran on every 'idle' AND 'zoom_changed'
 *      map event -- i.e. a full DB read + marker rebuild on every single
 *      pan/zoom. It now reads from waeAllRecords (already kept in sync by
 *      refreshPanel() after every scan/clear) instead, and the 'idle'
 *      listener is gone entirely -- see point 2, it's no longer needed
 *      for anything.
 *   2. Markers were a custom google.maps.OverlayView (own div, manual
 *      draw()/projection math). An OverlayView's draw() runs on every
 *      projection update for every instance -- including continuously
 *      during a drag, not just once per pan -- so with dozens of markers
 *      that's dozens of synchronous DOM writes per drag frame. Switched
 *      to native google.maps.Marker (own SVG icon, same red-X look) --
 *      positioned by the Maps SDK itself, no per-frame JS callback
 *      involved, and no pan/zoom listener needed at all to stay correctly
 *      placed. zoom_changed now only toggles .setMap() on already-built
 *      markers for the <8-zoom clutter gate -- cheap, no data fetch, no
 *      marker recreation.
 *
 * v1.11.0 CHANGE FROM v1.10.0: the ⚠️ nearby-duplicate flag is now
 * clickable instead of just a hover tooltip -- opens a small popover
 * listing each nearby ticket by name/distance, and clicking one jumps the
 * map straight to THAT specific match (same waeGoToLocation() a table row
 * click uses), so you can actually go compare the two rather than just
 * being told they're close. A plain title="..." can't hold clickable
 * content, so this is a real floating element (position:fixed, appended
 * to document.body, since the table's own scroll container would clip
 * anything positioned inside it) -- closes on an outside click, Escape,
 * picking an item, or the panel itself closing.
 *
 * v1.10.0 CHANGE FROM v1.9.0: rows are now flagged (\u26A0\uFE0F, plus a subtle
 * row highlight) when their coordinates fall within 20m (Haversine,
 * WAE_NEARBY_THRESHOLD_METERS) of a location extracted from a DIFFERENT
 * ticket -- the same spot reported more than once, independently.
 * Deliberately NOT flagged against each other: multiple locations within
 * one ticket's own thread -- that's the expected multi-location shape
 * this tool already handles, not a duplicate to notice. Computed once
 * per data refresh (scan/clear), not per search keystroke -- it's O(n^2)
 * over records-with-coordinates, cheap at this tool's usual scale but no
 * reason to redo it on every filter change. Also exposed as a new
 * "Nearby Tickets" CSV column, computed at export time.
 *
 * v1.9.0 CHANGE FROM v1.8.0: added a search box above the table. Filters
 * in-memory against the already-fetched record list (no IndexedDB
 * round-trip per keystroke) across name, conversation ID, comment, issue
 * type, both raw text fields, and the source filename/email id -- not
 * just the visible columns, since a query is more likely to hit the raw
 * locationDetails/reportDetails text than the best-guess name. Filtering
 * only changes what's displayed; Export CSV, Show on Map, and the
 * summary counts still reflect everything, not just the visible rows.
 *
 * v1.8.0 CHANGE FROM v1.7.0: every table row with coordinates is now
 * clickable -- jumps the map to that location (centers, zooms in to 17 if
 * more zoomed out than that) and shows the InfoWindow there, regardless
 * of whether "Show on Map" pins are toggled on. Since the panel is a
 * full-screen backdrop, clicking a row also closes it -- otherwise the
 * map you just navigated would be sitting invisible behind the modal.
 * Rows with no parseable coordinates aren't clickable (nothing to jump
 * to). Reuses the same map-attachment code "Show on Map" already ported
 * from Report Wayspots -- no new map-detection logic needed.
 *
 * v1.7.0 CHANGE FROM v1.6.0: markers are now a static red X (two rotated
 * bars, class .wae-report-marker) instead of the animated expanding-ring
 * pulse v1.6.0 shipped with -- at your request. No animation/keyframes
 * left in the CSS. Same OverlayView plumbing, click-for-InfoWindow
 * behavior, and localStorage-persisted toggle as before -- only the
 * marker's own look changed.
 *
 * v1.6.0 CHANGE FROM v1.5.0: added a "Show on Map" toggle that plots
 * every extracted location as a red cross marker directly on the Wayfarer
 * map -- the same thing Report Wayspots does for its own reported-
 * wayspot history, but for what THIS script extracted from imported
 * emails, and without needing Report Wayspots installed at all. Base
 * itself has no marker-plotting API (its own map-lookup is module-scoped,
 * same as Report Wayspots' copy), so this ports Report Wayspots'
 * confirmed-working getWfMap()/extractMapFromCtxEntry() map-detection
 * code and builds a self-contained google.maps.OverlayView marker layer
 * (own CSS classes/color, kept distinct from Report Wayspots' so the two
 * don't read as the same layer). Unlike Report Wayspots' pulses, these
 * are clickable -- shows name/coordinates/comment/ticket in an
 * InfoWindow, since dozens of nearby entries would otherwise be
 * indistinguishable. The toggle's on/off state persists in localStorage
 * and re-attaches automatically on page load if it was left on; pins stay
 * in sync automatically after every scan or clear while it's on.
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
  // Map attachment -- ported from Report Wayspots v3.15.0's own
  // getWfMap()/extractMapFromCtxEntry(), confirmed against that real
  // script. Base has no public API for "give me the live map instance"
  // (its own getMap() is module-scoped, same as Report Wayspots' copy),
  // so every companion script that needs the map reaches into Angular's
  // __ngContext__ on the map component the same way. Kept here rather
  // than shared, for the same reason nothing @requires Base anymore --
  // see the v1.2.0 changelog note above.
  // ---------------------------------------------------------------------

  function waeLooksLikeGoogleMap(obj) {
    return !!(obj &&
              typeof obj.getCenter === 'function' &&
              typeof obj.addListener === 'function' &&
              typeof obj.getDiv === 'function');
  }

  function waeExtractMapFromCtxEntry(entry) {
    if (!entry) return null;
    if (waeLooksLikeGoogleMap(entry)) return entry; // mapview
    const m = entry?.componentRef?.map;             // submit
    return waeLooksLikeGoogleMap(m) ? m : null;
  }

  function waeGetWfMap() {
    return new Promise((resolve) => {
      let attempts = 80;
      function tryFindMap() {
        const candidates = document.querySelectorAll('app-submit-wayspot-map nia-map, app-wf-base-map');
        for (const el of candidates) {
          const ctx = el && el.__ngContext__;
          if (!ctx) continue;
          for (const entry of ctx) {
            try {
              const map = waeExtractMapFromCtxEntry(entry);
              if (map) return resolve(map);
            } catch (e) { /* ignore */ }
          }
        }
        if (attempts-- <= 0) return resolve(null);
        setTimeout(tryFindMap, 250);
      }
      tryFindMap();
    });
  }

  function waeIsMapStale(map) {
    try {
      const div = map && map.getDiv && map.getDiv();
      return !div || !div.isConnected;
    } catch (e) {
      return true;
    }
  }

  // ---------------------------------------------------------------------
  // Cross-ticket proximity flagging -- "was this same spot reported more
  // than once, in a different ticket". Multiple locations within ONE
  // ticket's own thread are expected (that's the whole multi-location
  // feature) and never flagged against each other here; this is
  // specifically about two different conversationIds landing on
  // (near-)identical coordinates, which is the pattern worth a human
  // actually noticing -- repeat/recurring spam locations, or the same
  // Wayspot reported independently by someone else.
  // ---------------------------------------------------------------------

  const WAE_NEARBY_THRESHOLD_METERS = 20;

  function waeHaversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ~0.001 degrees is ~111m at the equator -- comfortably bigger than
  // WAE_NEARBY_THRESHOLD_METERS, so two points within the threshold of
  // each other always land in the same cell or an immediately adjacent
  // one. Only checking the 3x3 neighborhood instead of every other record
  // is what turns this from O(n^2) into close to O(n) for realistically
  // spread-out real-world locations -- see the v1.13.0 changelog note for
  // why this mattered (600+ accumulated rows made the naive full-pairwise
  // version measurably slow, and it was re-running on every panel open).
  const WAE_GRID_DEG = 0.001;
  function waeGridKey(lat, lon) {
    return `${Math.floor(lat / WAE_GRID_DEG)}:${Math.floor(lon / WAE_GRID_DEG)}`;
  }

  // Returns a Map from record.id -> array of { record, distanceMeters },
  // one entry per OTHER record (from a different ticket) found within
  // WAE_NEARBY_THRESHOLD_METERS.
  function waeFindNearbyDuplicates(records) {
    const withCoords = records.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));

    const buckets = new Map();
    for (const r of withCoords) {
      const key = waeGridKey(r.latitude, r.longitude);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }

    const result = new Map();
    const addMatch = (id, entry) => {
      if (!result.has(id)) result.set(id, []);
      result.get(id).push(entry);
    };
    const seenPairs = new Set();

    for (const r of withCoords) {
      const cellLat = Math.floor(r.latitude / WAE_GRID_DEG);
      const cellLon = Math.floor(r.longitude / WAE_GRID_DEG);
      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          const neighbors = buckets.get(`${cellLat + dLat}:${cellLon + dLon}`);
          if (!neighbors) continue;
          for (const other of neighbors) {
            if (other === r) continue;
            // Each unordered pair can turn up from both records' own
            // neighborhood scans -- skip the second time.
            const pairKey = r.id < other.id ? `${r.id}|${other.id}` : `${other.id}|${r.id}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);

            const rTicket = r.conversationId || r.sourceEmailId;
            const oTicket = other.conversationId || other.sourceEmailId;
            if (rTicket === oTicket) continue;

            const distanceMeters = waeHaversineMeters(r.latitude, r.longitude, other.latitude, other.longitude);
            if (distanceMeters <= WAE_NEARBY_THRESHOLD_METERS) {
              addMatch(r.id, { record: other, distanceMeters });
              addMatch(other.id, { record: r, distanceMeters });
            }
          }
        }
      }
    }
    return result;
  }

  function waeSortedNearbyMatches(nearby) {
    return (nearby || []).slice().sort((x, y) => x.distanceMeters - y.distanceMeters);
  }

  function waeFormatNearbyForCsv(nearby) {
    if (!nearby || !nearby.length) return null;
    return waeSortedNearbyMatches(nearby)
      .map((n) => `${n.record.conversationId || n.record.sourceEmailId} (${Math.round(n.distanceMeters)}m)`)
      .join('; ');
  }

  // ---------------------------------------------------------------------
  // Nearby-flag popover -- clicking a ⚠️ lists the specific ticket(s) it's
  // near, each as its own clickable item that jumps straight to THAT
  // match's location (via waeGoToLocation, same as clicking a table row
  // directly) rather than just naming it in a hover tooltip with nowhere
  // to go.
  // ---------------------------------------------------------------------

  let waeNearbyPopoverEl = null;

  function waeCloseNearbyPopover() {
    if (!waeNearbyPopoverEl) return;
    waeNearbyPopoverEl.remove();
    waeNearbyPopoverEl = null;
    document.removeEventListener('click', waeNearbyPopoverOutsideClick, true);
    document.removeEventListener('keydown', waeNearbyPopoverEscHandler);
  }

  function waeNearbyPopoverEscHandler(ev) {
    if (ev.key === 'Escape') waeCloseNearbyPopover();
  }

  function waeNearbyPopoverOutsideClick(ev) {
    if (waeNearbyPopoverEl && !waeNearbyPopoverEl.contains(ev.target)) waeCloseNearbyPopover();
  }

  function waeOpenNearbyPopover(anchorEl, nearby) {
    waeCloseNearbyPopover();

    const items = waeSortedNearbyMatches(nearby).map((n) => {
      const label = `${n.record.wayspotName || '(unnamed)'} \u2014 ${Math.round(n.distanceMeters)}m \u2014 ticket ${n.record.conversationId || n.record.sourceEmailId}`;
      return `<button type="button" class="wae-nearby-item" data-id="${escapeHtml(n.record.id)}">${escapeHtml(label)}</button>`;
    }).join('');

    const pop = document.createElement('div');
    pop.id = 'wae-nearby-popover';
    pop.innerHTML = `<div class="wae-nearby-popover-title">Within ${WAE_NEARBY_THRESHOLD_METERS}m, other ticket(s) -- click to go there:</div>${items}`;
    document.body.appendChild(pop);

    const anchorRect = anchorEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - pop.offsetWidth - 8));
    const top = Math.min(anchorRect.bottom + 4, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    pop.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.wae-nearby-item');
      if (!btn) return;
      const target = waeAllRecords.find((r) => r.id === btn.dataset.id);
      waeCloseNearbyPopover();
      if (target) waeGoToLocation(target);
    });

    waeNearbyPopoverEl = pop;
    // Deferred so the click that opened the popover doesn't immediately
    // bubble into the outside-click listener and close it again.
    setTimeout(() => {
      document.addEventListener('click', waeNearbyPopoverOutsideClick, true);
      document.addEventListener('keydown', waeNearbyPopoverEscHandler);
    }, 0);
  }

  // ---------------------------------------------------------------------
  // Map plotting -- extracted locations as native google.maps.Marker
  // objects, NOT a custom OverlayView (see v1.12.0 changelog note: an
  // OverlayView with many instances forces a JS-driven DOM reposition on
  // every single drag frame, for every marker, which is what made this
  // laggy once there were more than a couple dozen -- native Markers are
  // positioned by the Maps SDK itself, no per-frame JS callback involved,
  // and don't need any pan/zoom listener at all to stay correctly placed.
  // Own icon/color so this doesn't read as the same layer as Report
  // Wayspots' own reported-wayspot history markers -- this shows
  // *extracted* reports, not Report Wayspots' own submission history, and
  // doesn't require that script to be installed at all. Clickable --
  // with dozens of nearby entries otherwise looking identical, a click
  // naming which ticket a marker belongs to earns its keep here.
  // ---------------------------------------------------------------------

  const WAE_MAP_VISIBLE_KEY = 'wae_map_pulses_visible';
  const WAE_PULSES = { map: null, markersById: new Map(), infoWindow: null };
  let waeAllRecords = [];
  let waeNearbyMap = new Map();
  let waeSearchQuery = '';

  // Search matches across everything a person might actually search by --
  // not just the visible name/conversation columns, but the raw
  // locationDetails/reportDetails text too, since a query like a street
  // name or an issue keyword is more likely to hit those than the
  // best-guess Wayspot name.
  function waeMatchesQuery(r, q) {
    if (!q) return true;
    const haystack = [
      r.wayspotName, r.conversationId, r.comment, r.issueType,
      r.locationDetails, r.reportDetails, r.sourceFilename, r.sourceEmailId,
      waeStatusLabel(r.ticketStatus),
    ].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(q);
  }
  // Built lazily (needs `google` to already be loaded) and cached --
  // same icon object reused for every marker instead of rebuilt per-call.
  let WAE_MARKER_ICON = null;
  function waeGetMarkerIcon() {
    if (WAE_MARKER_ICON) return WAE_MARKER_ICON;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
      + '<line x1="3" y1="3" x2="17" y2="17" stroke="#dc2626" stroke-width="4" stroke-linecap="round"/>'
      + '<line x1="17" y1="3" x2="3" y2="17" stroke="#dc2626" stroke-width="4" stroke-linecap="round"/>'
      + '</svg>';
    WAE_MARKER_ICON = {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(20, 20),
      anchor: new google.maps.Point(10, 10),
    };
    return WAE_MARKER_ICON;
  }

  function waeShowPulseInfoWindow(record, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_PULSES.map) return;
    if (!WAE_PULSES.infoWindow) WAE_PULSES.infoWindow = new google.maps.InfoWindow();
    const name = escapeHtml(record.wayspotName || '(unnamed report)');
    const parts = [`<div style="font-size:12px;max-width:260px;"><strong>${name}</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    if (record.comment) parts.push(`<div style="margin-top:4px;color:#6b7280;word-break:break-all;">${escapeHtml(record.comment)}</div>`);
    if (record.conversationId) parts.push(`<div style="margin-top:4px;color:#9ca3af;">Ticket ${escapeHtml(record.conversationId)}</div>`);
    parts.push('</div>');
    WAE_PULSES.infoWindow.setContent(parts.join(''));
    WAE_PULSES.infoWindow.setPosition(latLng);
    WAE_PULSES.infoWindow.open(WAE_PULSES.map);
  }

  function waeClearPulses() {
    for (const marker of WAE_PULSES.markersById.values()) {
      try { marker.setMap(null); } catch (e) { /* ignore */ }
    }
    WAE_PULSES.markersById.clear();
    if (WAE_PULSES.infoWindow) WAE_PULSES.infoWindow.close();
  }

  // Hide below this zoom level so a fully zoomed-out view of the
  // Netherlands doesn't try to show every marker at once. Purely a
  // clutter/legibility gate now, not a performance one -- native markers
  // are cheap enough that this isn't load-bearing the way it was for the
  // old OverlayView version.
  function waeShouldShowPulses(map) {
    if (!map || typeof map.getZoom !== 'function') return true;
    const z = map.getZoom();
    return (typeof z === 'number') && z >= 8;
  }

  // Cheap: just toggles .setMap() on markers that already exist, no data
  // fetch or marker (re)creation. Safe to call on every zoom_changed.
  function waeApplyZoomGate() {
    const map = WAE_PULSES.map;
    if (!map) return;
    const show = waeShouldShowPulses(map);
    for (const marker of WAE_PULSES.markersById.values()) {
      marker.setMap(show ? map : null);
    }
  }

  // Rebuilds the marker set from whatever's currently in waeAllRecords --
  // NOT from IndexedDB. This used to call getAllExtractedRecords() itself
  // and ran on every pan ('idle') and zoom step, which meant a full DB
  // read plus a rebuild-vs-diff pass on every single map interaction --
  // that was the actual cause of the slowdown, independent of the
  // OverlayView-vs-Marker question. waeAllRecords is already kept in sync
  // by refreshPanel() after every scan/clear, so this only needs to run
  // when that data changes or the map is first attached -- never on
  // pan/zoom, which is why there's no 'idle' listener anymore at all.
  function waeRefreshPulses() {
    const map = WAE_PULSES.map;
    if (!map || waeIsMapStale(map)) return;
    if (typeof google === 'undefined' || !google.maps?.Marker) return;

    const wanted = waeAllRecords.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    const wantedIds = new Set(wanted.map((r) => r.id));

    for (const [id, marker] of WAE_PULSES.markersById.entries()) {
      if (!wantedIds.has(id)) {
        try { marker.setMap(null); } catch (e) { /* ignore */ }
        WAE_PULSES.markersById.delete(id);
      }
    }

    const show = waeShouldShowPulses(map);
    for (const record of wanted) {
      const position = { lat: record.latitude, lng: record.longitude };
      let marker = WAE_PULSES.markersById.get(record.id);
      if (!marker) {
        marker = new google.maps.Marker({ icon: waeGetMarkerIcon() });
        // Read from the marker itself, not a closed-over `record`, so a
        // later re-scan that updates this same marker's data (name,
        // comment, etc.) is reflected even though the click listener
        // below was only attached once at creation time.
        marker.addListener('click', () => waeShowPulseInfoWindow(marker.waeRecord, marker.getPosition()));
        WAE_PULSES.markersById.set(record.id, marker);
      }
      marker.waeRecord = record;
      marker.setPosition(position);
      marker.setTitle(record.wayspotName || '(unnamed report)');
      marker.setMap(show ? map : null);
    }
  }

  async function waeAttachToMapIfNeeded() {
    if (WAE_PULSES.map && !waeIsMapStale(WAE_PULSES.map)) return true;
    const map = await waeGetWfMap();
    if (!map) return false;
    if (WAE_PULSES.map !== map) waeClearPulses();
    WAE_PULSES.map = map;
    // Only listener needed: native markers reposition themselves on
    // pan/zoom with no app code involved at all. zoom_changed here is
    // just the clutter gate (waeApplyZoomGate), not a data refresh.
    map.addListener?.('zoom_changed', () => waeApplyZoomGate());
    return true;
  }

  // Wayfarer uses a different map component -- and a different underlying
  // google.maps.Map object -- for its zoomed-in submit/edit view
  // (app-submit-wayspot-map) than for the general mapview
  // (app-wf-base-map); waeGetWfMap() above already has to check both.
  // A Marker only ever renders on the one Map object it was created
  // against, so switching between those views used to make every marker
  // silently vanish until "Show on Map" was manually toggled off and on
  // again, or a scan/clear happened to call waeResyncMapIfVisible(). This
  // watches for exactly that swap (waeIsMapStale catching the old map's
  // div getting detached) and re-attaches + rebuilds automatically.
  // Cheap by design -- waeIsMapStale() is a trivial DOM check, and real
  // work (re-fetching the map, rebuilding markers) only happens on the
  // rare tick where something actually changed -- so this doesn't
  // reintroduce the per-pan/zoom cost the v1.12.0/v1.13.0 fixes removed.
  let waeStaleWatchTimer = null;

  function waeStartStaleWatch() {
    if (waeStaleWatchTimer) return;
    waeStaleWatchTimer = setInterval(async () => {
      if (!isMapPulsesEnabled()) return;
      if (WAE_PULSES.map && !waeIsMapStale(WAE_PULSES.map)) return;
      const attached = await waeAttachToMapIfNeeded();
      if (attached) waeRefreshPulses();
    }, 2000);
  }

  function waeStopStaleWatch() {
    if (waeStaleWatchTimer) {
      clearInterval(waeStaleWatchTimer);
      waeStaleWatchTimer = null;
    }
  }

  // Panel-row click -> jump the map to that location. The panel is a
  // full-screen backdrop, so the map isn't visible until it closes -- this
  // closes it as part of navigating, the same way clicking a location is
  // expected to actually show it rather than just move something behind
  // the modal. Shows the InfoWindow on arrival too, as immediate visual
  // confirmation regardless of whether "Show on Map" pins are toggled on.
  async function waeGoToLocation(record) {
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude)) return;
    const attached = await waeAttachToMapIfNeeded();
    if (!attached) {
      const logEl = document.getElementById('wae-log');
      if (logEl) log(logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview.', 'err');
      return;
    }
    const map = WAE_PULSES.map;
    const latLng = new google.maps.LatLng(record.latitude, record.longitude);
    map.setCenter(latLng);
    const z = map.getZoom();
    if (typeof z === 'number' && z < 17) map.setZoom(17);
    closePanel();
    google.maps.event.addListenerOnce(map, 'idle', () => waeShowPulseInfoWindow(record, latLng));
  }

  function isMapPulsesEnabled() {
    return localStorage.getItem(WAE_MAP_VISIBLE_KEY) === 'true';
  }

  // Re-syncs the map layer with whatever's currently in storage, but only
  // if the toggle is actually on -- called after scan/clear so the map
  // doesn't silently drift out of date while "Show on Map" is active, and
  // at bootstrap so a persisted-on toggle re-attaches on page load. Also
  // starts the stale-map watch so a later view switch recovers on its own.
  async function waeResyncMapIfVisible() {
    if (!isMapPulsesEnabled()) return;
    const attached = await waeAttachToMapIfNeeded();
    if (attached) {
      waeRefreshPulses();
      waeStartStaleWatch();
    }
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
    ['nearbyTickets', 'Nearby Tickets (<20m, other tickets)'],
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
    .wae-text-input{
      width:100%; box-sizing:border-box; border:1px solid #d1d5db; border-radius:4px;
      padding:5px 8px; font-size:12px; margin:6px 0; font-family:inherit;
    }
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
    #wae-table td.wae-nearby-flag{ text-align:center; cursor:help; max-width:24px; }
    .wae-status-badge{
      display:inline-block; border:1px solid; border-radius:9999px;
      padding:1px 8px; font-size:10.5px; font-weight:600; white-space:nowrap;
    }
    #wae-table tr.wae-row-nearby td{ background:#fffbeb; }
    #wae-table tr.wae-row-clickable{ cursor:pointer; }
    #wae-table tr.wae-row-clickable:hover td{ background:#fff7ed; }

    #wae-nearby-popover{
      position:fixed; z-index:2100; background:#fff; border:1px solid #e5e7eb;
      border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.18);
      padding:6px; max-width:320px; font-family:Roboto, Arial, sans-serif;
    }
    .wae-nearby-popover-title{
      font-size:11px; color:#6b7280; padding:2px 6px 6px; white-space:normal;
    }
    .wae-nearby-item{
      display:block; width:100%; text-align:left; background:none; border:none;
      border-radius:4px; padding:6px; font-size:12px; color:#111827; cursor:pointer;
      white-space:normal;
    }
    .wae-nearby-item:hover{ background:#fffbeb; }
  `;

  function log(container, msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    container.prepend(line);
    while (container.children.length > 50) container.removeChild(container.lastChild);
  }

  // Friendly label + color per ticket status -- matches Niantic Support's
  // three confirmed canned closing replies (see opr-email-lib.js's
  // HELPSHIFT_TEMPLATES disambiguate()): ACTIONED means the report was
  // reviewed and acted on (nothing more to do here), PENDING means it's
  // still being looked into (revisit later), DENIED means it was
  // reviewed but didn't meet the removal criteria (also nothing more to
  // do, but distinct from ACTIONED). RECEIVED is just the initial
  // auto-ack; UPDATED is the catch-all for anything that isn't one of
  // those three canned replies (a custom reply, the reporter's own
  // follow-up being the newest message, etc.).
  const WAE_STATUS_BADGES = {
    ABUSE_REPORT_RECEIVED: { label: 'Received', color: '#2563eb' },
    ABUSE_REPORT_PENDING: { label: 'Pending Review', color: '#b45309' },
    ABUSE_REPORT_ACTIONED: { label: 'Actioned', color: '#16a34a' },
    ABUSE_REPORT_DENIED: { label: 'Denied', color: '#6b7280' },
    ABUSE_REPORT_UPDATED: { label: 'Updated', color: '#6b7280' },
  };

  function waeStatusLabel(ticketStatus) {
    const info = WAE_STATUS_BADGES[ticketStatus];
    return info ? info.label : String(ticketStatus).replace('ABUSE_REPORT_', '');
  }

  function waeStatusBadge(ticketStatus) {
    const info = WAE_STATUS_BADGES[ticketStatus] || { label: waeStatusLabel(ticketStatus), color: '#6b7280' };
    return `<span class="wae-status-badge" style="color:${info.color};border-color:${info.color};">${escapeHtml(info.label)}</span>`;
  }

  function renderTable(records, hasQuery, nearbyMap) {
    if (!records.length) {
      return hasQuery
        ? '<div class="wae-sub">No rows match that search.</div>'
        : '<div class="wae-sub">No abuse reports extracted yet -- click "Scan Imported Emails".</div>';
    }
    const rows = records
      .slice()
      .sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0))
      .map((r) => {
        const name = r.wayspotName
          ? `<td title="${escapeHtml(r.wayspotName)}">${escapeHtml(r.wayspotName)}</td>`
          : '<td class="wae-missing">(none found)</td>';
        const hasCoords = r.latitude !== null && r.longitude !== null;
        const lat = hasCoords ? r.latitude.toFixed(6) : '<span class="wae-missing">-</span>';
        const lng = hasCoords ? r.longitude.toFixed(6) : '<span class="wae-missing">-</span>';
        const comment = r.comment
          ? `<td class="wae-comment" title="${escapeHtml(r.comment)}">\uD83D\uDCAC</td>`
          : '<td></td>';
        const nearby = nearbyMap && nearbyMap.get(r.id);
        const nearbyCell = nearby && nearby.length
          ? `<td class="wae-nearby-flag" data-nearby-id="${escapeHtml(r.id)}" title="Click to see nearby ticket(s)">\u26A0\uFE0F</td>`
          : '<td></td>';
        const classes = [];
        if (hasCoords) classes.push('wae-row-clickable');
        if (nearby && nearby.length) classes.push('wae-row-nearby');
        const rowAttrs = (classes.length ? ` class="${classes.join(' ')}"` : '') +
          (hasCoords ? ` data-id="${escapeHtml(r.id)}" title="Click to locate on the map"` : '');
        return `<tr${rowAttrs}>
          <td>${escapeHtml(r.conversationId || r.sourceEmailId)}</td>
          ${name}
          <td>${lat}</td>
          <td>${lng}</td>
          ${comment}
          ${nearbyCell}
          <td>${waeStatusBadge(r.ticketStatus)}</td>
        </tr>`;
      })
      .join('');
    return `
      <div id="wae-table-wrap">
        <table id="wae-table">
          <thead><tr><th>Conversation</th><th>Wayspot Name</th><th>Lat</th><th>Lng</th><th></th><th></th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function waeRenderFilteredTable() {
    const countEl = document.getElementById('wae-count');
    const tableEl = document.getElementById('wae-table-container');
    const q = waeSearchQuery.trim().toLowerCase();
    const filtered = q ? waeAllRecords.filter((r) => waeMatchesQuery(r, q)) : waeAllRecords;

    if (tableEl) tableEl.innerHTML = renderTable(filtered, !!q, waeNearbyMap);

    const withCoords = waeAllRecords.filter((r) => r.latitude !== null && r.longitude !== null).length;
    const withName = waeAllRecords.filter((r) => r.wayspotName).length;
    const ticketCount = new Set(waeAllRecords.map((r) => r.conversationId || r.sourceEmailId)).size;
    const nearbyCount = waeNearbyMap.size;
    if (countEl) {
      let base = `${waeAllRecords.length} location(s) extracted from ${ticketCount} ticket(s) -- ${withCoords} with coordinates, ${withName} with a name guess.`;
      if (nearbyCount) base += ` \u26A0\uFE0F ${nearbyCount} within ${WAE_NEARBY_THRESHOLD_METERS}m of a report from another ticket.`;
      countEl.textContent = q ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'} -- ${base}` : base;
    }

    const exportBtn = document.getElementById('wae-export-btn');
    if (exportBtn) exportBtn.disabled = waeAllRecords.length === 0;
    const clearBtn = document.getElementById('wae-clear-btn');
    if (clearBtn) clearBtn.disabled = waeAllRecords.length === 0;
    const mapToggleBtn = document.getElementById('wae-map-toggle-btn');
    if (mapToggleBtn) {
      mapToggleBtn.disabled = withCoords === 0;
      mapToggleBtn.textContent = isMapPulsesEnabled() ? 'Hide from Map' : 'Show on Map';
    }
  }

  let waeNearbyMapFingerprint = null;

  // Cheap "did the underlying record set change" check -- count alone
  // would miss a rescan that happens to produce the same number of rows,
  // but the scan handler always clears and rewrites the whole store with
  // a fresh Date.now() scannedAt on every row (see its own v1.4.0 note),
  // so the latest scannedAt changes on every real scan even when the
  // count doesn't.
  function waeRecordsFingerprint(records) {
    let maxScannedAt = 0;
    for (const r of records) if (r.scannedAt > maxScannedAt) maxScannedAt = r.scannedAt;
    return `${records.length}:${maxScannedAt}`;
  }

  async function refreshPanel() {
    const countEl = document.getElementById('wae-count');
    try {
      waeAllRecords = await getAllExtractedRecords();
    } catch (e) {
      if (countEl) countEl.textContent = 'Could not read extracted-report storage.';
      return;
    }
    // This used to recompute unconditionally, which meant a full O(n^2)
    // (now grid-bucketed, but still real work) nearby-duplicate scan on
    // every single panel open, not just when data actually changed --
    // with a few thousand accumulated rows that was slow enough to
    // visibly hang the page right as the panel opened. Skipping it when
    // nothing changed since last time is what actually fixes that.
    const fp = waeRecordsFingerprint(waeAllRecords);
    if (fp !== waeNearbyMapFingerprint) {
      waeNearbyMap = waeFindNearbyDuplicates(waeAllRecords);
      waeNearbyMapFingerprint = fp;
    }
    waeRenderFilteredTable();
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
          <button id="wae-map-toggle-btn" class="wfmapmods-modal-btn" disabled>Show on Map</button>
          <button id="wae-export-btn" class="wfmapmods-modal-btn" disabled>Export CSV</button>
          <button id="wae-clear-btn" class="wfmapmods-modal-btn wae-btn-danger" disabled>Clear Extracted Data</button>
        </div>
        <div id="wae-progress"></div>

        <input type="text" id="wae-search-input" class="wae-text-input" placeholder="Search name, ticket, location/report text...">

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

    const tableContainerEl = panel.querySelector('#wae-table-container');
    tableContainerEl.addEventListener('click', (ev) => {
      const flagCell = ev.target.closest('.wae-nearby-flag[data-nearby-id]');
      if (flagCell) {
        ev.stopPropagation();
        const nearby = waeNearbyMap.get(flagCell.dataset.nearbyId);
        if (nearby && nearby.length) waeOpenNearbyPopover(flagCell, nearby);
        return;
      }
      const tr = ev.target.closest('tr[data-id]');
      if (!tr) return;
      const record = waeAllRecords.find((r) => r.id === tr.dataset.id);
      if (record) waeGoToLocation(record);
    });

    const searchInput = panel.querySelector('#wae-search-input');
    searchInput.addEventListener('input', () => {
      waeSearchQuery = searchInput.value;
      waeRenderFilteredTable();
    });

    const progressEl = panel.querySelector('#wae-progress');
    const logEl = panel.querySelector('#wae-log');
    const scanBtn = panel.querySelector('#wae-scan-btn');
    const mapToggleBtn = panel.querySelector('#wae-map-toggle-btn');
    const exportBtn = panel.querySelector('#wae-export-btn');
    const clearBtn = panel.querySelector('#wae-clear-btn');

    mapToggleBtn.addEventListener('click', async () => {
      const turningOn = !isMapPulsesEnabled();
      if (turningOn) {
        mapToggleBtn.disabled = true;
        mapToggleBtn.textContent = 'Attaching to map...';
        const attached = await waeAttachToMapIfNeeded();
        mapToggleBtn.disabled = false;
        if (!attached) {
          log(logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview.', 'err');
          mapToggleBtn.textContent = 'Show on Map';
          return;
        }
        localStorage.setItem(WAE_MAP_VISIBLE_KEY, 'true');
        await waeRefreshPulses();
        waeStartStaleWatch();
        mapToggleBtn.textContent = 'Hide from Map';
      } else {
        localStorage.setItem(WAE_MAP_VISIBLE_KEY, 'false');
        waeStopStaleWatch();
        waeClearPulses();
        mapToggleBtn.textContent = 'Show on Map';
      }
    });

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
        waeResyncMapIfVisible();
      }
    });

    exportBtn.addEventListener('click', async () => {
      try {
        const extracted = await getAllExtractedRecords();
        if (!extracted.length) return;
        const nearby = waeFindNearbyDuplicates(extracted);
        const withNearby = extracted.map((r) => ({
          ...r,
          nearbyTickets: waeFormatNearbyForCsv(nearby.get(r.id)),
          ticketStatus: waeStatusLabel(r.ticketStatus),
        }));
        downloadCsv(withNearby);
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
        waeResyncMapIfVisible();
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
    waeCloseNearbyPopover();
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
  waeResyncMapIfVisible();
})();
