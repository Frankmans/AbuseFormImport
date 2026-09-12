// ==UserScript==
// @name         Wayfarer Map Mods - Abuse Report Extractor
// @namespace    https://github.com/Frankmans/AbuseFormImport
// @version      1.29.4
// @description  Scans emails already imported by Wayfarer Abuse Email Importer for Niantic Support "Reporting Abuse" tickets, extracts every reported Wayspot's name + coordinates (a ticket can report several, across the original submission and later replies), stores them locally, plots them on the Wayfarer map, and exports as CSV.
// @author       Frankmans
// @grant        none
// @match        https://wayfarer.scopely.com/*
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wst-storage.js
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js
// @inject-into  page
// ==/UserScript==

/*
 * v1.29.4 CHANGE FROM v1.29.3: yes -- confirmed and fixed. Even after the
 * zoom-debounce and cached-projection fixes (v1.29.0), every recompute
 * was still clustering/diffing markers against the ENTIRE dataset with
 * coordinates, worldwide, regardless of how small a slice of the map was
 * actually visible -- zoomed into one city out of a countrywide dataset
 * was still full-dataset work for a screen that could only ever show a
 * city's worth of it. waeGetPaddedBounds()/waeWithinPaddedBounds() (right
 * above waeRefreshPulses()) now filter to the current viewport (padded
 * 75% in every direction, so a small pan doesn't immediately show a gap
 * at the edge before the next idle catches up) before clustering runs at
 * all -- the biggest win of the three zoom-performance fixes so far for
 * anyone with a large dataset who's normally zoomed into one area of it,
 * not looking at the whole thing at once.
 *
 * v1.29.3 CHANGE FROM v1.29.2: markers still weren't showing up
 * consistently on the submit-Wayspot page specifically, even after the
 * route-level WFMM.map fixes from v1.26.x -- see the WAE_MAP_PERIODIC_
 * RECHECK_MS block (right above waeStartMapTracking()) for the full
 * explanation and the honest caveat that the exact cause isn't confirmed
 * against Base's own source. Short version: unlike the general mapview,
 * /new/submit/new is a single route from start to finish, and if its
 * underlying map object gets torn down and recreated partway through
 * that flow, nothing here had a way to notice -- route-change events
 * don't fire without an actual route change, and the not-found retry
 * only fires from a failed search, not an already-attached map quietly
 * going stale under it. Added a periodic (5s) safety-net
 * WFMM.map.refresh() call, gated on pulses actually being on, to catch
 * this regardless of the exact cause -- negligible cost when nothing's
 * changed (refresh()'s fast path is just a staleness check against a
 * cached value), real work only on the tick where something actually
 * did.
 *
 * v1.29.2 CHANGE FROM v1.29.1: fixes the Status/Last Response columns
 * visually overlapping -- see the STYLE block's own "BUGFIX v1.29.2"
 * comment (right above the column-width rules) for the full explanation.
 * Short version: the per-column width percentages were tuned for 7
 * columns and never revisited when Last Response was added, leaving it
 * and Status too narrow for a status pill and a date + sort-arrow header
 * to actually fit -- and since overflow:hidden only applied to the two
 * free-text columns at the time, that content visually spilled out past
 * its own cell into its neighbor instead of wrapping or clipping.
 * Rebalanced the widths and extended overflow:hidden to every column, so
 * the same thing clips instead of bleeding into a neighbor if a future
 * column ever ends up undersized the same way.
 *
 * v1.29.1 CHANGE FROM v1.29.0: fixes the plugin becoming permanently
 * unreachable ("unavailable") after swapping between different pages on
 * the same domain -- see the "Map Mods - Base side panel integration"
 * section comment (right above insertSettingsLinkIfReady()) for the full
 * explanation. Short version: the settings-link MutationObserver used to
 * disconnect itself the moment it successfully inserted the link, on the
 * assumption Base's own side panel section persists for the whole SPA
 * session -- if Angular's router ever tears down and rebuilds that
 * section on client-side navigation between Wayfarer's own routed views
 * (which nothing here fully confirms against Base's own source, but
 * matches both ordinary Angular behavior and what was actually reported),
 * an already-disconnected observer had no way to notice the link was
 * gone and put it back, silently losing the only way to reach this
 * plugin's panel even though its own background logic kept running the
 * whole time. Left running for the plugin's whole lifetime now instead.
 *
 * v1.29.0 CHANGE FROM v1.28.0: fixes "zooming becomes very slow while
 * abuse markers are rendered" -- two compounding causes, both in the
 * marker-clustering path (waeComputeClusters()/waeSetCurrentMap()):
 * (1) cluster recomputation was wired to zoom_changed with no debounce
 * at all, and Google Maps fires that once per discrete zoom LEVEL, not
 * once per gesture -- a fast scroll-wheel zoom or a double-click zoom
 * (which animates through intermediate levels on its own) could trigger
 * several expensive synchronous recomputes back to back, each blocking
 * the main thread while the map itself was trying to animate. Moved to
 * a debounced idle listener instead (200ms, trailing-edge) -- idle fires
 * once after the map actually settles, so a fast zoom now triggers
 * exactly one recompute instead of several stacked mid-animation ones.
 * (2) every recompute re-ran the full lat/lng-to-world-point Mercator
 * projection for every single record, even though that result never
 * actually depends on zoom (only the subsequent `* scale` step does) --
 * real, avoidable per-record work, scaling with dataset size, redone
 * from scratch on every call for no reason. Cached per record id now
 * (waeWorldPointCache), invalidated only when the map instance itself
 * changes.
 *
 * v1.28.0 CHANGE FROM v1.27.0: adds a "Last Response" column -- the
 * ticket's most recent message across every source email that fed into
 * it (merged.messages[0], since mergeThreads() already re-sorts newest-
 * first by actual parsed timestamp -- see that function's own comment),
 * not just whichever single email happened to be scanned. Sortable, same
 * as Conversation/Status; missing/unparseable timestamps sort last
 * regardless of direction rather than being treated as oldest. Also in
 * the CSV export, as an ISO 8601 string (unambiguous regardless of which
 * spreadsheet app/locale opens the file) rather than the locale-
 * formatted date the table itself shows. Computed at scan time and
 * stored per-ticket (lastResponseAt) -- rows extracted before this
 * version won't have it until re-scanned, and show "-" until then, same
 * as any other field a row is missing.
 *
 * v1.27.0 CHANGE FROM v1.26.3: adds a "Close this panel when a row jumps
 * the map to its location" checkbox -- previously this was the one
 * hardcoded behavior, closing the panel was never optional. Off, a row
 * click still centers/zooms the map and opens the same info popup as
 * before, it just leaves the panel itself open too (which, since it's a
 * full-screen backdrop, means the map you just jumped to stays hidden
 * behind it until closed manually) -- useful for clicking through
 * several rows in a row without the panel closing out from under you
 * each time. Defaults to on, matching every prior version's only
 * behavior. Setting lives in localStorage
 * (WAE_AUTOCLOSE_ON_NAVIGATE_KEY), not tied to any one panel session.
 *
 * v1.26.3 CHANGE FROM v1.26.2: fixes "abuse crosses don't show on the
 * submit map AT ALL" for real this time -- v1.26.0's WFMM.map switch got
 * the map-LOOKUP half of that working, but waeShouldShowPulses()'s
 * "hide below zoom 8" check (added long before the submit map was ever
 * supported, to keep a fully-zoomed-out mapview from trying to render
 * hundreds of markers at once) was being applied there too, completely
 * unconditionally -- and the submit-Wayspot page commonly lands on a
 * wide default view, well below zoom 8, before the user has picked a
 * location. Every marker was getting silently hidden by that check on
 * every single visit, not just occasionally. Now skipped entirely when
 * WFMM.map's own context says surface === "submit" (context.surface,
 * confirmed against the real source -- resolveSubmitMapContext() sets it
 * explicitly, and the fallback resolver derives the same value from the
 * route name either way) -- tracked alongside WAE_PULSES.map now,
 * populated via WFMM.map.getContext() after refresh() (which only ever
 * returns the bare map, not its surrounding context) and via the
 * context onReady() already hands over directly.
 *
 * v1.26.2 CHANGE FROM v1.26.1: fixes "Show on Map" left toggled on from a
 * previous session not showing its markers on a fresh page load until
 * toggled off and back on -- see the WAE_MAP_RETRY_LIMIT block (right
 * above waeStartMapTracking()) for the full root-cause explanation.
 * Short version: @run-at document-start (v1.26.1) means the initial
 * resync's WFMM.map.refresh() call can race ahead of Angular/Google Maps
 * actually finishing initialization; that single attempt's own internal
 * ~20s search could exhaust itself before the map ever appeared, with
 * nothing making it try again afterward. Now subscribes to WFMM's own
 * "map:not-found" event and retries (up to 3 times, 3s apart) for the
 * two background/silent triggers that can hit this -- the initial
 * bootstrap resync and a route change -- without touching the "Show on
 * Map" button's own click handler, which keeps its existing immediate
 * error message on failure rather than gaining a delayed silent retry
 * underneath it too.
 *
 * v1.26.1 CHANGE FROM v1.26.0: metadata header overhaul -- @namespace now
 * points at the GitHub repo rather than a Wayfarer URL, @author is the
 * real name rather than the "you" placeholder, @match broadened from
 * just /new/mapview* to the whole site (the submit-Wayspot page this
 * plugin now supports, see v1.26.0's own WFMM.map fix, lives at a
 * different path -- the old narrow match would have kept this script
 * from even loading there, independent of that fix), and @run-at moved
 * from document-idle to document-start. @version itself was briefly
 * dropped in the change this entry replaces and has been restored --
 * that was a mistake, not intentional; Tampermonkey needs it to compare
 * against @updateURL and decide whether an update is actually available.
 *
 * v1.26.0 CHANGE FROM v1.25.1: fixes "abuse crosses don't show on the
 * submit map" -- switched the whole map-attachment layer over to
 * WFMM.map, the suite's own shared map-lookup service, in place of this
 * plugin's own from-scratch Angular __ngContext__ reflection (ported
 * from a different, unrelated script, Report Wayspots v3.15.0 -- see the
 * "Map attachment" section comment above, near where waeGetWfMap() used
 * to live). WFMM.map has dedicated, actually-maintained adapters
 * for both the mapview AND the submit-new-Wayspot map -- confirmed
 * against the real source, and the exact thing Report History (part of
 * this same suite) already relies on to work on both pages -- where this
 * plugin's own hand-rolled selector had only really been exercised
 * against mapview. Also replaces the old setInterval-based "stale map"
 * polling (waeStartStaleWatch()/waeStopStaleWatch(), every 2s) with
 * WFMM.map.onReady()/onCleared() plus WFMM.routes.onEnterMapRoute()/
 * onChangeMapRoute() -- event-driven off the suite's own map/route
 * lifecycle rather than polling for a DOM node going stale.
 *
 * v1.25.1 CHANGE FROM v1.25.0: the sort column/direction chosen via the
 * Conversation/Status headers (see v1.24.0) is now saved to localStorage
 * (WAE_SORT_STORAGE_KEY) and reloaded on next use -- previously
 * waeSortKey/waeSortDirection were module-level only, so the choice
 * survived closing and reopening the panel within the same page load, but
 * reset back to newest-scanned-first on every fresh page load. Loaded
 * once up front (waeInitialSortState) rather than on each panel open,
 * same as every other setting in this file; saved right alongside the
 * existing in-memory update in the header's onSort() handler.
 *
 * v1.25.0 CHANGE FROM v1.24.1: restores the table column-width/truncation
 * constraint the old hand-rolled #wae-table had (max-width + ellipsis)
 * that quietly didn't carry over when the table switched to
 * WFMM.ui.table() -- see the STYLE block's own comment right above
 * ".wae-table{ table-layout: fixed; }" for the mechanics. Long content in
 * the Conversation/Wayspot Name columns (most commonly a URL that ended
 * up in the name field -- see the companion fix in opr-email-lib.js's
 * extractLocationLines() for that root cause) could otherwise blow a
 * column out wide enough to push Status/the nearby-flag column out of
 * view.
 *
 * v1.24.1 CHANGE FROM v1.24.0: renamed to "Wayfarer Map Mods - Abuse
 * Report Extractor" (@name, modal title, Plugin Manager listing, console
 * log prefixes) so it reads as clearly WFMM-affiliated wherever it shows
 * up standalone (Tampermonkey's dashboard, Plugin Manager's own list,
 * devtools console) -- not changed: @downloadURL/@updateURL/@require,
 * which point at actual filenames in the GitHub repo this is hosted from
 * and would break auto-update if renamed here without also renaming the
 * files there; the short in-panel settings-link text ("Abuse Report
 * Extractor"), left alone since it already sits inside a WFMM-branded
 * settings list where the full prefix would just be redundant; and every
 * internal identifier this doesn't actually display to a user -- PLUGIN_ID,
 * localStorage/IndexedDB keys, element ids -- since changing any of those
 * would orphan existing users' already-stored data.
 *
 * v1.24.0 CHANGE FROM v1.23.1: the "Conversation" and "Status" table
 * columns are now sortable -- using table()'s own built-in sortable-
 * header support (column.sortable/options.sortState/options.onSort,
 * confirmed against the real source), the same clickable-header-with-
 * \u25B2/\u25BC-marker look the suite's own tables use, rather than
 * anything custom-built here. Status sorts by pipeline stage (Received ->
 * Pending Review -> a settled state), not alphabetically -- see
 * WAE_STATUS_SORT_RANK just below WAE_STATUS_BADGES. The original
 * newest-scanned-first order is still what you get before either header's
 * been clicked; there's no third header to click back to it. Persisted
 * across page reloads too as of v1.25.1, not just panel close/reopen --
 * see that entry.
 *
 * v1.23.1 CHANGE FROM v1.23.0: adds a "Clickable markers" toggle to the
 * same Marker Style section -- backed by google.maps.Marker's own
 * setClickable(), not a WFMM.markerAppearance field (that registry is
 * about appearance, not interactivity, so this one setting is saved/
 * normalized alongside the appearance fields for convenience but isn't
 * part of what gets handed to registerStyle()'s resolve() -- harmless
 * either way, since normalizeResolvedStyle() only reads the six fields it
 * knows about and ignores extras, but kept the resolve() payload to just
 * those six for clarity). Turning it off drops the pointer cursor and
 * lets clicks reach whatever's underneath a marker instead of opening its
 * popup/zooming into its cluster.
 *
 * v1.23.0 CHANGE FROM v1.22.1: adds a "Marker Style" section to this
 * panel, letting the color/size/opacity of the map markers this plugin
 * draws be changed, backed by a real WFMM.markerAppearance.registerStyle()
 * registration (confirmed against the real source, src/core/marker-
 * appearance.js) rather than the hardcoded #dc2626 X/circle from earlier
 * versions. See the WAE_APPEARANCE_* block (just above waeGetMarkerIcon())
 * for the full "why this isn't a literal new row in Wayspot Overlay's own
 * Wayspots/Pok\u00e9stops/Gyms/Power Spots settings grid" explanation --
 * short version: that specific grid is hardcoded to those four kinds with
 * no third-party registration point, but the underlying styling ENGINE it
 * sits on top of is genuinely plugin-facing, and this now uses it.
 *
 * v1.22.0 CHANGE FROM v1.21.2: the panel was previously a hand-rolled
 * lookalike of a Map Mods modal -- its own "#wae-panel"/backdrop/dialog
 * DOM built from an innerHTML string, styled by reverse-engineering
 * (guessing at, then copying) the suite's own .wfmapmods-modal-* class
 * names rather than calling anything the suite actually exposes. Now that
 * the real suite source is available (Wayfarer_Map_Mods-4_1_20.txt),
 * confirmed it exposes a full UI service at window.WFMM.ui --
 * createElement/section/emptyState/table/pager/button/textInput/etc, and
 * critically a real openModal({id, title, buildContent, ...}) that builds
 * and manages the entire modal shell itself (backdrop, dialog, header,
 * close button, Escape/backdrop-click handling, focus return -- all of
 * it). Switched to that entirely -- buildPanel()'s manual backdrop/dialog
 * construction is gone; openPanel() now just calls WFMM.ui.openModal()
 * and builds the body content in buildContent() using WFMM.ui.createElement/
 * section/button/buttonRow/textInput/table/pager/emptyState/notice, and
 * closePanel()/togglePanel() work through the modalController it returns
 * instead of toggling a hidden panel's display style. Since openModal tears
 * the whole dialog down again on close (rather than just hiding it, the
 * way the old backdrop did), the panel's live DOM refs (count/table/log/
 * buttons) are now only valid while it's actually open -- tracked via a
 * single waeUI object, set in buildContent() and cleared in the onClose
 * hook, with refreshPanel()/waeRenderFilteredTable() now no-ops if it's
 * null instead of assuming document.getElementById() will find anything.
 *
 * Only the panel-*building* code changed -- scanning/matching (opr-email-
 * lib.js), the nearby-duplicate grid search, native-Marker map plotting,
 * and CSV export are untouched, since none of that is UI-service surface.
 * The nearby-ticket popover is still a manually-positioned floating
 * element (WFMM.ui has no floating-popover primitive to hand off to), but
 * its contents are now built with WFMM.ui.createElement instead of an
 * innerHTML string. The Google Maps InfoWindow content (waeShowPulseInfoWindow)
 * is deliberately left as a plain HTML string -- that's the Maps SDK's own
 * setContent() API, not this suite's modal system, so there's nothing to
 * hand off there.
 *
 * wfmmWindow (the unsafeWindow-vs-window resolution the Plugin Manager
 * registration already depended on) moved up to the top of the file so
 * the same reference can be reused for every WFMM.ui.* call in the panel,
 * not just the registration bootstrap at the bottom.
 *
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
 * v1.21.2 CHANGE FROM v1.21.1: fixed Plugin Manager registration silently
 * never happening -- same underlying issue as the importer script's own
 * v4.6.1 (see that file for the fuller explanation), except here the
 * cause was ambiguity rather than confirmed sandboxing: this script had
 * no @grant line at all, and while that's usually inferred as "none"
 * (unsandboxed), that inference isn't guaranteed identical across
 * userscript managers/versions. Added an explicit @grant none (removing
 * the ambiguity outright) and switched to reading through unsafeWindow
 * instead of window, same as the importer -- under @grant none these are
 * literally the same object per Tampermonkey's own docs, so this is
 * effectively a no-op safety net here, not a functional fix on its own,
 * but keeps both scripts' registration code identical and correct
 * regardless of which usage mode ends up applying.
 *
 * Same caveat as the importer script's v4.6.1: real userscript-manager
 * sandboxing can't be reproduced in this project's Node/jsdom test
 * harness, so this is grounded in Tampermonkey's documented behavior and
 * the specific reported symptom, not end-to-end verified. Worth
 * confirming directly against the real Plugin Manager screen.
 *
 * v1.21.1 CHANGE FROM v1.21.0: cluster markers (the numbered-badge
 * circles for multiple nearby reports) shrunk from 32x32 to 22x22, closer
 * to the 20x20 single-report marker, with a smaller count label to match.
 * Purely visual -- WAE_CLUSTER_PIXEL_RADIUS (the screen-pixel distance
 * that decides whether nearby reports group into one cluster at all)
 * is untouched, so this doesn't change *when* markers cluster, only how
 * big the resulting circle is.
 *
 * v1.21.0 CHANGE FROM v1.20.1: issueType/locationDetails/reportDetails
 * are genuinely per-TICKET, not per-location, but every location row was
 * storing its own full copy -- a 12-location ticket duplicated the same
 * raw text 12 times. Measured at a realistic 15,000-row/1,250-ticket
 * scale (matching a real report of this exact slowdown): storage dropped
 * from raw-JSON sizes of ~35MB estimated to a measured 7.06MB actual
 * (3.99MB extractedReports + 3.07MB the new ticketDetails store) once
 * split apart.
 *
 * New IndexedDB object store, ticketDetails (EXTRACT_DB_VERSION bumped to
 * 2), keyed by the same ticketKey every location row for that ticket now
 * carries (previously each row just duplicated the values directly).
 * getAllExtractedRecords() transparently joins the two stores back
 * together into the exact same record shape every existing caller
 * already expected -- search, table rendering, CSV export, nearby-
 * duplicate detection all needed zero changes, and there's no migration
 * step needed either, since Scan already rebuilds both stores from
 * scratch every time.
 *
 * Verified end-to-end through the real scan button, not just the
 * storage functions in isolation: confirmed ticketDetails ends up with
 * exactly one row per ticket (1,250, not 15,000), confirmed a location
 * row no longer stores locationDetails directly, and -- the part that
 * actually mattered for correctness -- searched for text that exists
 * ONLY in reportDetails and confirmed all 15,000 rows still matched,
 * proving the join correctly hydrates every row rather than only the
 * one row that happens to "own" the ticketDetails record. CSV export
 * also confirmed still includes the full raw text per row.
 *
 * v1.20.1 CHANGE FROM v1.20.0: replaced two remaining O(n) .find() calls
 * (the nearby-popover item click and the table row click) with O(1)
 * lookups against a new waeRecordsById Map, kept in sync alongside
 * waeAllRecords in refreshPanel(). Checked whether waeRefreshPulses()'s
 * per-zoom_changed coordinate filter was also worth caching -- benchmarked
 * at 0.8ms/pass over 15,000 records, ~16ms across 20 rapid zoom events --
 * genuinely negligible, left as-is rather than adding cache complexity
 * with no real benefit.
 *
 * v1.20.0 CHANGE FROM v1.19.0: fixed the panel itself (not the map) going
 * very slow once a real accumulated history got into the many thousands
 * of rows (real report: 15,000+). Benchmarked every piece of the
 * pipeline at that scale before touching anything -- nearby-duplicate
 * detection (75ms), clustering (35ms), and building the row HTML as a
 * plain string (78ms) all stayed fast; the actual cost was the browser
 * parsing/laying out that many real DOM rows at once (a ~3MB HTML
 * string via one innerHTML assignment), plus the search box recomputing
 * a fresh per-record searchable-text string AND re-rendering the entire
 * table on every single keystroke (measured ~180ms per keystroke
 * uncached at 15,000 rows).
 *
 * Fixes, in the order they matter:
 *   1. The table is now paginated -- WAE_PAGE_SIZE (200) rows rendered
 *      at a time regardless of how many total rows exist, with Prev/Next
 *      controls and a "Page X of Y (rows A-B of N)" label. This is the
 *      one that actually matters -- verified DOM row count stays at 200
 *      even with 15,000 records loaded, instead of all 15,000.
 *   2. Search input is now debounced (200ms) instead of filtering and
 *      re-rendering on every keystroke, and resets to page 1 on a new
 *      query so filtering never leaves you stranded on an out-of-range
 *      page.
 *   3. Each record's searchable text is now cached on first use
 *      (`r._waeHaystack`) instead of rebuilt from scratch on every
 *      filter pass -- naturally invalidates itself since a real data
 *      reload always produces fresh record objects from IndexedDB.
 *   4. The filtered+sorted view and the summary stats (location/ticket/
 *      coordinate counts) are now cached too, invalidated only when the
 *      underlying data or the search query actually changes (compared by
 *      array reference, cheap) -- confirmed via direct instrumentation
 *      that a plain Prev/Next page turn now hits this cache and does
 *      zero refiltering/resorting of the full dataset, rather than
 *      redoing that work to show 200 already-known rows.
 * Scan/Clear both reset to page 1, since the data (and likely the total
 * row count) just changed.
 *
 * v1.19.0 CHANGE FROM v1.18.0: fixed "Show on Map" getting slow again
 * once a real dataset grew into the hundreds -- the v1.12.0 native-Marker
 * fix and v1.13.0/v1.14.0 no-DB-read-on-pan fixes removed the WRONG
 * things (custom OverlayView repositioning, redundant IndexedDB reads);
 * they didn't address the actual remaining ceiling, which is that
 * rendering hundreds of individual Marker objects simultaneously has
 * real linear overhead (positioning, event listeners) no matter how
 * cheap any one of them is on its own -- confirmed this by checking
 * whether the suite's own map rendering does anything fundamentally
 * different for its own POI pins at scale; it doesn't (also plain
 * google.maps.Marker in the couple of spots that use one), which pointed
 * at the real fix being to render fewer markers at once, not a faster
 * marker technology.
 *
 * Added screen-pixel clustering: nearby records are grouped into a
 * single numbered-badge marker based on actual on-screen pixel distance
 * at the CURRENT zoom (not a fixed lat/lng radius, since the same real-
 * world distance covers wildly different pixel distances depending on
 * zoom) -- same grid-bucketing technique as the v1.13.0 nearby-duplicate
 * fix, just in pixel space. Clicking a cluster zooms in on it instead of
 * opening the info popup; a single-record "cluster" behaves exactly like
 * before. Recomputed on zoom_changed (a discrete, infrequent event, not
 * pan/drag) and after data changes -- diffed by a key derived from each
 * cluster's sorted member ids, so re-rendering at the same zoom with the
 * same data doesn't recreate markers needlessly.
 *
 * Verified with a synthetic 450-location dataset (30 tickets x 15
 * locations each, matching the real scale multi-location extraction
 * produces) through the actual button-click code path, not just the
 * clustering function in isolation: 21 markers rendered at a zoomed-out
 * level vs. 447 once zoomed in close enough to tell them apart -- and
 * confirmed the underlying clustering function alone handles 5,000
 * scattered records in ~125ms and a dense 750-record/50-cluster scenario
 * in single-digit milliseconds.
 *
 * v1.18.0 CHANGE FROM v1.17.0: two changes, same as the importer script's
 * own v4.6.0 (see that file for the fuller explanation of both).
 *   1. Added padding to the dialog -- .wfmapmods-modal-dialog itself
 *      provides none, confirmed against the real suite CSS, so content
 *      sat flush against the edges. Also overflow-y:auto so tall content
 *      scrolls instead of being clipped.
 *   2. Now registers as a real entry in the suite's Plugin Manager
 *      settings screen via window.WFMM.plugins.registerExternal(),
 *      falling back to the old self-start if that API never appears
 *      within 5s. stop() tears down the settings link, panel, side-panel
 *      watcher, map markers, and stale-map watch; start() rebuilds
 *      everything and resyncs the map if "Show on Map" was left on.
 *      Verified the full register+start+stop+restart cycle and the
 *      fallback path through a simulated DOM.
 *
 * v1.17.0 CHANGE FROM v1.16.0: adapted for Wayfarer's move to
 * wayfarer.scopely.com and Tntnnbltn's new consolidated
 * wayfarer-map-mods.user.js suite (v4.0.0, replacing the old separate
 * wayfarer-map-mods-base.user.js + Report Wayspots scripts this was
 * previously confirmed against). @namespace/@match updated to the new
 * domain. Verified the new suite's actual source line by line against
 * everything this script depends on -- #wfmapmods-side-panel,
 * .wfmapmods-settings-links, every .wfmapmods-modal-* class this uses,
 * and the map-lookup code's componentRef.map pattern + "app-submit-
 * wayspot-map nia-map, app-wf-base-map" selectors are all unchanged
 * (the last two are byte-for-byte what the new suite's own internal map
 * resolution uses too). No code changes needed in this file -- unlike
 * the importer script, this one never depended on the POI/submit bridge
 * (removed in the new suite) or the modal checkbox class (also removed).
 *
 * v1.16.0 CHANGE FROM v1.15.1: fixed long-running tickets losing data --
 * a ticket active enough to generate several separate email notifications
 * over time was only ever scanned from whichever single stored email
 * happened to be processed, even though each individual export only
 * contains THAT email's own quoted-history window, not the complete
 * conversation. Confirmed against two real exports of the same ticket a
 * week apart: the later one's quoted history didn't even reach back to
 * the original form submission anymore (its structured fields came back
 * completely empty), and each export's 10-message window covered
 * entirely different, non-overlapping stretches of an actively
 * back-and-forth conversation -- scanning either alone found 11 or 12
 * locations; scanning both together and merging finds the true 23.
 *
 * This was also silently DESTRUCTIVE, not just incomplete: every row's id
 * was based on conversationId alone ("conv:<id>:<index>"), so two
 * separate emails for the same ticket produced colliding ids, and
 * whichever one got written to storage second would silently overwrite
 * the other's rows at the same index rather than adding to them.
 *
 * Fixed by restructuring scanImportedEmails() into two passes: first
 * parse every stored email into its own thread and group by
 * conversationId, then merge each group's messages (opr-email-lib.js's
 * new mergeThreads() -- dedupes identical messages and re-sorts the
 * union newest-first by actual timestamp) before running extraction
 * (parseAbuseReportThread) and status classification
 * (classifyAbuseReportStatus) on that complete merged picture. One row
 * group per ticket now, never per individual email, so the id-collision
 * possibility is gone entirely rather than just less likely.
 * sourceEmailId/sourceFilename now list every contributing email
 * (semicolon-joined) instead of just one, since a row's data can
 * genuinely come from several. Verified through the actual scan button
 * click handler (not just the parsing functions in isolation) against
 * both real emails on hand, using a real IndexedDB implementation.
 *
 * v1.15.1 CHANGE FROM v1.15.0 (opr-email-lib.js fix, no code change in
 * this file, only the classification results it depends on): every
 * ticket was coming back Updated regardless of its actual reply text.
 * Cause: the "is the newest message from support" check tested for the
 * literal string "niantic support" in the author field, but that only
 * ever appears on the automated auto-ack -- a real human agent's reply
 * (including the actual decision messages this exists to classify) is
 * authored under their own name ("Jaxson", "Graham", ...), so it never
 * matched and every real closing reply fell through to the Updated
 * catch-all. Fixed to check for a non-blank author instead (the reliable
 * signal, per the blank-author fix elsewhere in that file: the REPORTER's
 * own messages have a blank author, every Niantic-side reply doesn't).
 * Confirmed against both real sample tickets on hand -- both now
 * correctly classify as Actioned instead of Updated -- plus all three
 * canned replies via synthetic transcripts. Deliberately still only
 * checks the single newest message, not previous replies in the thread,
 * per how this is meant to work: if the reporter sends a follow-up
 * *after* the real decision (e.g. a "thanks!"), status reads Updated
 * again since the newest message genuinely isn't one of the three
 * canned replies at that point -- a known limitation, not a bug.
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

  // @grant none (see this script's header) means window already IS
  // unsafeWindow -- no sandbox -- per Tampermonkey's own docs, so this is
  // a no-op indirection here, not a functional necessity the way it is in
  // the importer script (which runs sandboxed under @grant
  // GM_xmlhttpRequest). Kept anyway and used everywhere WFMM.ui is
  // touched, not just the Plugin Manager registration at the bottom of
  // this file, so both scripts share the exact same access pattern
  // regardless of which one you're reading.
  const wfmmWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const EXTRACT_DB_NAME = 'wf-abuse-report-extract-db';
  const EXTRACT_DB_VERSION = 2;
  const EXTRACT_STORE_NAME = 'extractedReports';
  // v1.21.0: split out of extractedReports. issueType/locationDetails/
  // reportDetails are genuinely per-TICKET, not per-location -- storing
  // them on every location row meant a 12-location ticket duplicated the
  // same ~2.4KB of raw text 12 times. Measured at a real 15,000-row/
  // 1,250-ticket scale: ~92% of stored bytes were pure duplication (~32MB
  // of ~35MB). Each location row now just carries a `ticketKey` pointing
  // at its one shared record here.
  const TICKET_DETAILS_STORE_NAME = 'ticketDetails';

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
        if (!db.objectStoreNames.contains(TICKET_DETAILS_STORE_NAME)) {
          db.createObjectStore(TICKET_DETAILS_STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putRecordsToStore(storeName, records) {
    if (!records.length) return { inserted: 0, updated: 0 };
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
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

  async function getAllFromStore(storeName) {
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearStore(storeName) {
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function putExtractedRecords(records) { return putRecordsToStore(EXTRACT_STORE_NAME, records); }
  function putTicketDetails(records) { return putRecordsToStore(TICKET_DETAILS_STORE_NAME, records); }
  function clearExtractedRecords() { return clearStore(EXTRACT_STORE_NAME); }
  function clearTicketDetails() { return clearStore(TICKET_DETAILS_STORE_NAME); }

  // Transparently joins the two stores back into the same record shape
  // every existing caller (search, table render, CSV export, nearby-
  // duplicate detection) already expects -- issueType/locationDetails/
  // reportDetails just get hydrated from the shared per-ticket record
  // instead of being stored on the row itself. Nothing downstream of this
  // function needed to change.
  async function getAllExtractedRecords() {
    const [rows, details] = await Promise.all([
      getAllFromStore(EXTRACT_STORE_NAME),
      getAllFromStore(TICKET_DETAILS_STORE_NAME),
    ]);
    const detailsById = new Map(details.map((d) => [d.id, d]));
    return rows.map((r) => {
      const d = detailsById.get(r.ticketKey) || {};
      return {
        ...r,
        issueType: d.issueType ?? null,
        locationDetails: d.locationDetails ?? null,
        reportDetails: d.reportDetails ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Map attachment -- v1.26.0 switched this over to WFMM.map, the
  // suite's own shared map-lookup service (confirmed against the real
  // source, src/core/map/service.js) -- the same one Report History and
  // every other official WFMM plugin uses. Earlier versions here were
  // wrong that "Base has no public API for this" -- that was true of an
  // older Base version this was originally ported against (Report
  // Wayspots v3.15.0's own hand-rolled Angular __ngContext__ reflection,
  // copied here since nothing better was known to exist at the time), but
  // the now-consolidated suite's WFMM.map has had one for a while: get(),
  // isReady(), refresh({reason, force}) (a Promise<map|null>, cached and
  // shared across every plugin that calls it -- cheap to call liberally),
  // onReady(cb)/onCleared(cb) events, all backed by dedicated per-route
  // adapters (COMPONENT_ADAPTERS["mapview"]/["submit-new"] in
  // src/core/map/adapters/index.js) rather than one hand-rolled selector
  // trying to cover both. Concretely fixes the "abuse crosses don't show
  // on the submit map" report: this plugin's OWN reflection hack only
  // ever really got exercised against the mapview page in practice, while
  // WFMM.map's dedicated submit-new adapter is the exact thing Report
  // History relies on to work correctly there -- using the same service
  // instead of a parallel from-scratch reimplementation of "find the
  // Wayfarer map" means this plugin now gets that same, actually-
  // maintained submit-map support for free, and stays covered if
  // Wayfarer's own markup changes again later (WFMM's own adapters would
  // need updating either way, for every plugin that depends on them, not
  // just this one).
  //
  // waeMapReadyUnsub/waeMapClearedUnsub/waeRouteEnterUnsub/
  // waeRouteChangeUnsub (subscribed once in startPlugin(), unsubscribed
  // in stopPlugin()) replace the old polling-based "stale watch"
  // (waeStartStaleWatch()/waeStopStaleWatch(), setInterval every 2s)
  // entirely -- WFMM.map.refresh() already checks staleness internally,
  // and WFMM.routes.onEnterMapRoute()/onChangeMapRoute() firing exactly
  // when the user actually navigates onto or between mapview/submit-new
  // is a strictly better trigger than polling ever was, not just a
  // like-for-like swap.
  // ---------------------------------------------------------------------

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

    const titleEl = waeUiApi.createElement('div', {
      className: 'wae-nearby-popover-title',
      text: `Within ${WAE_NEARBY_THRESHOLD_METERS}m, other ticket(s) -- click to go there:`,
    });
    const itemEls = waeSortedNearbyMatches(nearby).map((n) => waeUiApi.createElement('button', {
      className: 'wae-nearby-item',
      text: `${n.record.wayspotName || '(unnamed)'} \u2014 ${Math.round(n.distanceMeters)}m \u2014 ticket ${n.record.conversationId || n.record.sourceEmailId}`,
      attrs: { type: 'button' },
      dataset: { id: n.record.id },
    }));

    // The popover itself is still a manually-positioned floating element,
    // not something built or managed by WFMM.ui -- the suite's UI service
    // has no equivalent of an anchored popover (only full dialogs via
    // openModal()), so this stays outside it, same as before. Only its
    // CONTENTS (title + items above) are now built with ui.createElement
    // instead of an innerHTML string.
    const pop = waeUiApi.createElement('div', {
      id: 'wae-nearby-popover',
      children: [titleEl, ...itemEls],
    });
    document.body.appendChild(pop);

    const anchorRect = anchorEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - pop.offsetWidth - 8));
    const top = Math.min(anchorRect.bottom + 4, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    pop.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.wae-nearby-item');
      if (!btn) return;
      const target = waeRecordsById.get(btn.dataset.id);
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
  // Whether clicking a table row (waeGoToLocation()) closes this panel as
  // part of jumping the map to that location. Defaults to on (matches
  // every version before this setting existed) -- since the panel is a
  // full-screen backdrop, leaving it open would mean the map you just
  // navigated to stays hidden behind it, which is why that was the only
  // behavior originally. Some people would rather keep the panel open
  // (e.g. clicking through several rows in a row to compare locations)
  // and re-open it themselves when they're done looking, hence this
  // being a real setting rather than the one hardcoded behavior.
  const WAE_AUTOCLOSE_ON_NAVIGATE_KEY = 'wae_autoclose_on_navigate';
  function waeAutoCloseOnNavigateEnabled() {
    return localStorage.getItem(WAE_AUTOCLOSE_ON_NAVIGATE_KEY) !== 'false';
  }
  const WAE_PULSES = { map: null, surface: null, markersById: new Map(), infoWindow: null };
  let waeAllRecords = [];
  let waeRecordsById = new Map();
  let waeNearbyMap = new Map();
  let waeSearchQuery = '';
  let waeCurrentPage = 1;
  // null waeSortKey = the original default (newest-scanned first).
  // 'conversation'/'status'/'lastResponse' match the sortable column keys
  // in buildTableSection() below -- table()'s own onSort(key) callback
  // hands back exactly one of those. Persisted to localStorage (see
  // waeLoadSortState()/waeSaveSortState() below) so the chosen sort
  // survives a full page reload, not just closing/reopening the panel --
  // module-level state alone already covered that part, same as before.
  const WAE_SORT_STORAGE_KEY = 'wae_sort_state';
  const WAE_SORTABLE_KEYS = ['conversation', 'status', 'lastResponse'];
  function waeLoadSortState() {
    try {
      const saved = JSON.parse(localStorage.getItem(WAE_SORT_STORAGE_KEY) || 'null');
      if (saved && WAE_SORTABLE_KEYS.includes(saved.key) && (saved.direction === 'asc' || saved.direction === 'desc')) {
        return saved;
      }
    } catch (e) { /* fall through to default below */ }
    return { key: null, direction: 'desc' };
  }
  function waeSaveSortState() {
    localStorage.setItem(WAE_SORT_STORAGE_KEY, JSON.stringify({ key: waeSortKey, direction: waeSortDirection }));
  }
  const waeInitialSortState = waeLoadSortState();
  let waeSortKey = waeInitialSortState.key;
  let waeSortDirection = waeInitialSortState.direction;

  // ---------------------------------------------------------------------
  // Marker appearance -- v1.23.0. Registered with WFMM.markerAppearance
  // (confirmed against the real source, src/core/marker-appearance.js) so
  // this plugin's marker style is a genuine, discoverable entry in the
  // suite's own marker-styling engine, not just an internal constant. Kept
  // in the exact same shape WFMM.markerAppearance itself normalizes
  // "generic" styles to -- {markerSize, borderColor, borderWidth,
  // borderOpacity, fillColor, fillOpacity} -- so a resolve() lookup
  // against our style key returns something any WFMM-aware code already
  // knows how to interpret.
  //
  // IMPORTANT HONESTY NOTE, since this was asked for as "add ours to
  // that [Wayspots/Pok\u00e9stops/Gyms/Power Spots] system": the actual
  // settings SCREEN with that grid (wayspot-overlay's own marker-settings-
  // modal.js) is hardcoded to those four built-in kinds -- STYLE_KINDS in
  // src/plugins/wayspot-overlay/settings.js is a frozen array, with no
  // registration point for a third-party plugin to add a new row/column.
  // There's no real API path to literally insert into that specific grid.
  // What IS real and plugin-facing is the underlying engine that grid is
  // built on (WFMM.markerAppearance.registerStyle()/.resolve()) -- so
  // this plugin registers its own style bucket there (a legitimate use of
  // real public API, confirmed against source) and gets its OWN "Marker
  // Style" section in this panel to edit it, using the same
  // colorInput/numberInput/rangeInput controls the suite's own settings
  // screens use. Same underlying engine, same look, own section -- not a
  // literal new row in that one hardcoded grid.
  const WAE_APPEARANCE_STYLE_KEY = 'wae:abuse-report';
  const WAE_APPEARANCE_STORAGE_KEY = 'wae_marker_appearance';
  const WAE_APPEARANCE_DEFAULTS = Object.freeze({
    markerSize: 9,
    fillColor: '#dc2626',
    fillOpacity: 1,
    borderColor: '#ffffff',
    borderWidth: 2,
    borderOpacity: 1,
    clickable: true,
  });
  // Set once at startPlugin() (WFMM.markerAppearance.registerStyle()'s
  // return value) and called at stopPlugin() -- registerStyle() throws
  // "already registered" if called twice for the same key without an
  // unregister in between, which matters here since startPlugin() can run
  // again if the plugin is toggled off and back on in Plugin Manager.
  let waeUnregisterAppearance = null;

  function waeClampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  function waeNormalizeHexColor(value, fallback) {
    const s = String(value || '').trim();
    return /^#[0-9a-f]{3}$/i.test(s) || /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
  }
  function waeNormalizeAppearance(raw) {
    const a = raw || {};
    return {
      markerSize: waeClampNumber(a.markerSize, 4, 24, WAE_APPEARANCE_DEFAULTS.markerSize),
      fillColor: waeNormalizeHexColor(a.fillColor, WAE_APPEARANCE_DEFAULTS.fillColor),
      fillOpacity: waeClampNumber(a.fillOpacity, 0, 1, WAE_APPEARANCE_DEFAULTS.fillOpacity),
      borderColor: waeNormalizeHexColor(a.borderColor, WAE_APPEARANCE_DEFAULTS.borderColor),
      borderWidth: waeClampNumber(a.borderWidth, 0, 8, WAE_APPEARANCE_DEFAULTS.borderWidth),
      borderOpacity: waeClampNumber(a.borderOpacity, 0, 1, WAE_APPEARANCE_DEFAULTS.borderOpacity),
      // Not a marker-appearance field WFMM.markerAppearance itself knows
      // about (that registry is purely about how a marker looks, not
      // whether it responds to clicks) -- kept alongside it here anyway
      // since it's still a per-marker Google Maps option this same
      // Marker Style section is the natural place to expose, and it's
      // simplest to save/normalize/reset together with the rest rather
      // than as a separate localStorage key.
      clickable: typeof a.clickable === 'boolean' ? a.clickable : WAE_APPEARANCE_DEFAULTS.clickable,
    };
  }
  function waeLoadAppearance() {
    try {
      return waeNormalizeAppearance(JSON.parse(localStorage.getItem(WAE_APPEARANCE_STORAGE_KEY) || '{}'));
    } catch (e) {
      return { ...WAE_APPEARANCE_DEFAULTS };
    }
  }
  function waeSaveAppearance(appearance) {
    localStorage.setItem(WAE_APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    // Cached SVG icons (WAE_MARKER_ICON/WAE_CLUSTER_ICON, see below) are
    // built from these values -- stale otherwise until the next full page
    // load.
    WAE_MARKER_ICON = null;
    WAE_CLUSTER_ICON = null;
    // Only live-redraw if pulses are actually already visible -- editing
    // colors shouldn't be what makes the map attach/show pulses if the
    // user never turned "Show on Map" on.
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeRefreshPulses();
  }

  const WAE_PAGE_SIZE = 200;

  // WFMM.ui, set while the panel is open (buildPanelContent()) and used by
  // every DOM-building helper below (log(), the nearby popover, the
  // table). Not just wfmmWindow.WFMM.ui directly everywhere, so those
  // helpers don't need to know or care whether they're being called from
  // inside openModal's buildContent() callback (which is handed its own
  // `ui` reference) or from further down the call stack (a scan/clear
  // handler, a table row click) where only this module-level reference is
  // in scope.
  let waeUiApi = null;
  // Live refs into the currently-open panel's DOM -- null whenever the
  // panel is closed, since WFMM.ui.openModal() tears the dialog down on
  // close instead of just hiding it (unlike the old hand-rolled backdrop,
  // which stayed in the DOM with display:none). Every render/refresh
  // function below checks this first and no-ops if the panel isn't open.
  let waeUI = null;
  let waePanelController = null;

  // Search matches across everything a person might actually search by --
  // not just the visible name/conversation columns, but the raw
  // locationDetails/reportDetails text too, since a query like a street
  // name or an issue keyword is more likely to hit those than the
  // best-guess Wayspot name.
  function waeMatchesQuery(r, q) {
    if (!q) return true;
    if (!r._waeHaystack) {
      r._waeHaystack = [
        r.wayspotName, r.conversationId, r.comment, r.issueType,
        r.locationDetails, r.reportDetails, r.sourceFilename, r.sourceEmailId,
        waeStatusLabel(r.ticketStatus),
      ].filter(Boolean).join('\n').toLowerCase();
    }
    return r._waeHaystack.includes(q);
  }
  // Built lazily and cached -- same icon object reused for every marker
  // instead of rebuilt per-call. Invalidated (set back to null) by
  // waeSaveAppearance() whenever the user changes a marker-style setting.
  let WAE_MARKER_ICON = null;
  function waeGetMarkerIcon() {
    if (WAE_MARKER_ICON) return WAE_MARKER_ICON;
    const a = waeLoadAppearance();
    // Kept as a distinct X glyph (not the same filled-circle look as a
    // regular Wayspot/Pok\u00e9stop/Gym marker) so an abuse-report location
    // still reads as "a problem here", not just another POI dot -- only
    // its color/size are what's user-configurable via fillColor/
    // markerSize. borderColor/borderWidth/borderOpacity/fillOpacity don't
    // apply to this shape (an X has no fill region or ring) -- they only
    // affect the cluster icon below, which IS a filled circle with a
    // ring, matching WFMM's own "generic" marker shape exactly.
    const size = a.markerSize * 2;
    const half = size / 2;
    const arm = size * 0.35;
    const stroke = Math.max(2, Math.round(a.markerSize * 0.45));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<line x1="${half - arm}" y1="${half - arm}" x2="${half + arm}" y2="${half + arm}" stroke="${a.fillColor}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + `<line x1="${half + arm}" y1="${half - arm}" x2="${half - arm}" y2="${half + arm}" stroke="${a.fillColor}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + '</svg>';
    WAE_MARKER_ICON = {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(size, size),
      anchor: new google.maps.Point(half, half),
    };
    return WAE_MARKER_ICON;
  }

  // Same color as the single-report marker, just as a filled circle
  // (matching WFMM's own "generic" POI marker shape) with room for a
  // count label -- reads as "many of the same thing" rather than a
  // different kind of marker. Every field here (fillColor/fillOpacity/
  // borderColor/borderWidth/borderOpacity/markerSize) is user-
  // configurable through the Marker Style section.
  let WAE_CLUSTER_ICON = null;
  function waeGetClusterIcon() {
    if (WAE_CLUSTER_ICON) return WAE_CLUSTER_ICON;
    const a = waeLoadAppearance();
    const r = a.markerSize * 1.15;
    const size = (r + a.borderWidth) * 2;
    const c = size / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<circle cx="${c}" cy="${c}" r="${r}" fill="${a.fillColor}" fill-opacity="${a.fillOpacity}" stroke="${a.borderColor}" stroke-width="${a.borderWidth}" stroke-opacity="${a.borderOpacity}"/>`
      + '</svg>';
    WAE_CLUSTER_ICON = {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(size, size),
      anchor: new google.maps.Point(c, c),
      labelOrigin: new google.maps.Point(c, c),
    };
    return WAE_CLUSTER_ICON;
  }

  const WAE_CLUSTER_PIXEL_RADIUS = 45;

  // Groups records into clusters based on screen-pixel distance at the
  // CURRENT zoom -- not a fixed lat/lng radius, since the same physical
  // distance covers wildly different pixel distances depending on how
  // zoomed in the map is. Same grid-bucketing technique as
  // waeFindNearbyDuplicates (O(n) amortized, not O(n^2)), just in pixel
  // space: project each record to world coordinates, scale by 2^zoom to
  // get actual screen pixels, bucket into cells sized to the cluster
  // radius, then greedily merge each point with unassigned neighbors in
  // its own and adjacent cells that fall within the radius. Not a
  // perfectly optimal clustering, but visually solid and cheap enough to
  // rerun on every recompute -- see waeSetCurrentMap()'s own comment for
  // how often that actually happens now (debounced, off idle rather than
  // every zoom_changed).
  //
  // waeWorldPointCache (keyed by record.id) -- BUGFIX (not upstream): the
  // projection.fromLatLngToPoint() call is the same for a given record
  // every single time, regardless of zoom -- only the `* scale` step
  // actually depends on it -- but this used to redo that projection
  // (plus constructing a fresh google.maps.LatLng to feed it) for EVERY
  // record on EVERY call, i.e. real, avoidable per-record work that
  // scales with dataset size and was being repeated on every recompute
  // for no reason. Cached per record id now, invalidated only when the
  // map instance itself changes (a different map could, in principle,
  // have a different projection, even though in practice Google's
  // standard Mercator projection is the same for every normal map) --
  // NOT when waeAllRecords changes, since a record's own lat/lng is
  // immutable once extracted and the cache is keyed by id, so a scan
  // that adds new records just adds new cache entries rather than
  // invalidating everything already computed.
  let waeWorldPointCache = new Map();
  let waeWorldPointCacheMap = null;

  function waeComputeClusters(map, records) {
    const projection = map.getProjection();
    const zoom = map.getZoom();
    if (!projection || typeof zoom !== 'number') {
      return records.map((r) => ({ recordIds: [r.id], records: [r], lat: r.latitude, lng: r.longitude }));
    }

    if (waeWorldPointCacheMap !== map) {
      waeWorldPointCache = new Map();
      waeWorldPointCacheMap = map;
    }

    const scale = Math.pow(2, zoom);
    const points = records.map((r) => {
      let world = waeWorldPointCache.get(r.id);
      if (!world) {
        world = projection.fromLatLngToPoint(new google.maps.LatLng(r.latitude, r.longitude));
        waeWorldPointCache.set(r.id, world);
      }
      return { record: r, x: world.x * scale, y: world.y * scale };
    });

    const cellSize = WAE_CLUSTER_PIXEL_RADIUS;
    const buckets = new Map();
    for (const p of points) {
      const key = `${Math.floor(p.x / cellSize)}:${Math.floor(p.y / cellSize)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    const assigned = new Set();
    const clusters = [];
    for (const p of points) {
      if (assigned.has(p.record.id)) continue;
      const cellX = Math.floor(p.x / cellSize);
      const cellY = Math.floor(p.y / cellSize);
      const group = [p];
      assigned.add(p.record.id);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbors = buckets.get(`${cellX + dx}:${cellY + dy}`);
          if (!neighbors) continue;
          for (const q of neighbors) {
            if (assigned.has(q.record.id)) continue;
            if (Math.hypot(p.x - q.x, p.y - q.y) <= WAE_CLUSTER_PIXEL_RADIUS) {
              group.push(q);
              assigned.add(q.record.id);
            }
          }
        }
      }
      clusters.push({
        recordIds: group.map((g) => g.record.id).sort(),
        records: group.map((g) => g.record),
        lat: group.reduce((s, g) => s + g.record.latitude, 0) / group.length,
        lng: group.reduce((s, g) => s + g.record.longitude, 0) / group.length,
      });
    }
    return clusters;
  }

  function waeClusterKey(cluster) {
    return cluster.recordIds.join(',');
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
  // Netherlands doesn't try to show every marker/cluster at once -- but
  // ONLY on the general mapview. BUGFIX (not upstream): this was applied
  // unconditionally, including on the submit-Wayspot map (see v1.26.0's
  // WFMM.map integration), which reported as "crosses don't show on the
  // submit map AT ALL" -- that page commonly lands on a wide default
  // view (below zoom 8) before the user has picked a location, and this
  // check silently hid every marker there too, for exactly the same
  // "avoid overwhelming a world-zoomed-out view" reason that makes sense
  // on the country/region-wide mapview but not on a page whose whole
  // point is narrowing in on one precise spot -- abuse-report context is
  // arguably MORE useful there at a wide zoom, not less, since that's
  // exactly when a user hasn't yet zoomed in enough to notice a cluster
  // of prior reports near where they're about to submit. `surface` comes
  // from WFMM.map's own context (`context.surface`, "mapview" or
  // "submit" -- see waeSetCurrentMap()) rather than anything this script
  // determines itself.
  function waeShouldShowPulses(map, surface) {
    if (surface === 'submit') return true;
    if (!map || typeof map.getZoom !== 'function') return true;
    const z = map.getZoom();
    return (typeof z === 'number') && z >= 8;
  }

  // Rebuilds the marker set from whatever's currently in waeAllRecords --
  // NOT from IndexedDB (see v1.13.0 changelog note: that used to be the
  // actual cause of a different slowdown, fixed by reading from this
  // already-fetched cache instead). Clusters nearby records together at
  // the current zoom (see v1.19.0 changelog note) rather than rendering
  // one marker per record unconditionally -- that was the remaining
  // performance ceiling once a real dataset grew into the hundreds, since
  // each individually-rendered Marker has real linear overhead
  // (positioning, event listeners) regardless of how cheap any one of
  // them is. Diffs cluster markers by a key derived from their sorted
  // member record ids, so re-running at the SAME zoom with the SAME data
  // (e.g. after a scan that didn't change anything) doesn't recreate
  // markers needlessly -- only a genuine zoom change or data change does.
  // BUGFIX (not upstream): even after the zoom-debounce and cached-
  // projection fixes (v1.29.0), zoom could still be slow with a large
  // dataset -- every recompute was still clustering/diffing markers for
  // EVERY record with coordinates, worldwide, regardless of how small a
  // slice of the map was actually visible. Zoomed into one city out of a
  // dataset covering a whole country, that's still full-dataset work for
  // a screen that can only ever show a city's worth of it. Padding
  // (WAE_VIEWPORT_PAD_FACTOR, 75% of the viewport's own span in each
  // direction) means panning a little doesn't immediately show a blank
  // gap at the edge while markers there catch up on the next idle --
  // there's already a one-recompute-per-settle delay from the debounce,
  // so a modest buffer around the visible area smooths that over.
  // Longitude wraparound at the antimeridian isn't handled (a plain
  // west<=lng<=east range check, which breaks if the view happens to
  // straddle it) -- a real gap, but one shared with the existing nearby-
  // duplicate grid-bucketing's own simplifications, and not worth the
  // extra complexity for how rarely an abuse report near the date line
  // would come up in practice.
  const WAE_VIEWPORT_PAD_FACTOR = 0.75;
  function waeGetPaddedBounds(map) {
    const bounds = map.getBounds?.();
    if (!bounds) return null; // no bounds yet (e.g. map not fully idle) -- caller should render everything rather than wrongly show nothing
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const latPad = (ne.lat() - sw.lat()) * WAE_VIEWPORT_PAD_FACTOR;
    const lngPad = (ne.lng() - sw.lng()) * WAE_VIEWPORT_PAD_FACTOR;
    return { north: ne.lat() + latPad, south: sw.lat() - latPad, east: ne.lng() + lngPad, west: sw.lng() - lngPad };
  }
  function waeWithinPaddedBounds(record, padded) {
    if (!padded) return true;
    return record.latitude >= padded.south && record.latitude <= padded.north
      && record.longitude >= padded.west && record.longitude <= padded.east;
  }

  function waeRefreshPulses() {
    const map = WAE_PULSES.map;
    // No local staleness check needed anymore -- WFMM.map.onCleared()
    // (see waeStartMapTracking()) already nulls WAE_PULSES.map out the
    // moment the suite's own map service considers it gone, so a non-null
    // value here can be trusted without re-checking it ourselves.
    if (!map) return;
    if (typeof google === 'undefined' || !google.maps?.Marker) return;

    if (!waeShouldShowPulses(map, WAE_PULSES.surface)) {
      waeClearPulses();
      return;
    }

    const paddedBounds = waeGetPaddedBounds(map);
    const wanted = waeAllRecords.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && waeWithinPaddedBounds(r, paddedBounds));
    const clusters = waeComputeClusters(map, wanted);
    const wantedKeys = new Set(clusters.map(waeClusterKey));
    const appearance = waeLoadAppearance();

    for (const [key, marker] of WAE_PULSES.markersById.entries()) {
      if (!wantedKeys.has(key)) {
        try { marker.setMap(null); } catch (e) { /* ignore */ }
        WAE_PULSES.markersById.delete(key);
      }
    }

    for (const cluster of clusters) {
      const key = waeClusterKey(cluster);
      const isCluster = cluster.records.length > 1;
      const position = { lat: cluster.lat, lng: cluster.lng };
      let marker = WAE_PULSES.markersById.get(key);
      if (!marker) {
        marker = new google.maps.Marker({});
        // Read from the marker itself, not a closed-over `cluster`, so a
        // later re-render that rebuilds this same cluster's data is
        // reflected even though the click listener below was only
        // attached once at creation time.
        marker.addListener('click', () => {
          const c = marker.waeCluster;
          if (c.records.length > 1) {
            WAE_PULSES.map.setCenter(marker.getPosition());
            WAE_PULSES.map.setZoom(Math.min((WAE_PULSES.map.getZoom() || 8) + 3, 21));
          } else {
            waeShowPulseInfoWindow(c.records[0], marker.getPosition());
          }
        });
        WAE_PULSES.markersById.set(key, marker);
      }
      marker.waeCluster = cluster;
      marker.setPosition(position);
      marker.setIcon(isCluster ? waeGetClusterIcon() : waeGetMarkerIcon());
      marker.setLabel(isCluster ? { text: String(cluster.records.length), color: '#ffffff', fontSize: '10px', fontWeight: '700' } : null);
      marker.setTitle(isCluster ? `${cluster.records.length} reports` : (cluster.records[0].wayspotName || '(unnamed report)'));
      // setClickable(false) doesn't just suppress the click listener above
      // -- it also drops the pointer cursor and lets the click reach
      // whatever's underneath (the map itself, or a Wayspot marker at the
      // same spot), which is the point of turning this off.
      marker.setClickable(appearance.clickable);
      marker.setMap(map);
    }
  }

  // Shared by waeAttachToMapIfNeeded() (on-demand) and the WFMM.map.onReady()
  // subscription below (passive/event-driven) -- both need to react the
  // same way to "the map WFMM.map handed us is a different object than
  // what we had", so it's one place rather than two copies that could
  // drift out of sync with each other.
  // BUGFIX (not upstream): zoom_changed was recomputing clusters (a full
  // re-projection + grid-bucket pass over every record, see
  // waeComputeClusters()) SYNCHRONOUSLY on every single firing, with no
  // debounce at all -- and Google Maps fires zoom_changed once per
  // discrete zoom level, not once per gesture, so a fast scroll-wheel
  // zoom through several levels (or a double-click zoom, which animates
  // through intermediate levels on its own) could trigger several of
  // these expensive synchronous recomputes back to back, each one
  // blocking the main thread while the map itself is trying to animate
  // -- reported as "zooming becomes very slow while markers are
  // rendered". Debounced now (waeZoomDebounceMs, trailing-edge -- only
  // the LAST zoom level in a fast sequence actually triggers a
  // recompute, not every intermediate one) and moved off zoom_changed
  // onto idle, which fires once after the map has actually settled
  // (covers pans too, not just zooms, but idle only fires once per
  // gesture regardless, so that's a single redundant recompute on a pure
  // pan at worst, not a pileup of them) -- see waeComputeClusters()'s own
  // comment for the other half of this fix (caching each record's
  // projected position, which zoom itself never actually changes).
  const WAE_ZOOM_DEBOUNCE_MS = 200;
  function waeSetCurrentMap(map, surface) {
    if (WAE_PULSES.map === map) return;
    waeClearPulses();
    WAE_PULSES.map = map;
    WAE_PULSES.surface = map ? (surface || null) : null;
    if (map) {
      let debounceTimer = null;
      map.addListener?.('idle', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(waeRefreshPulses, WAE_ZOOM_DEBOUNCE_MS);
      });
    }
  }

  async function waeAttachToMapIfNeeded() {
    const map = await wfmmWindow.WFMM.map.refresh({ reason: 'wae-attach' });
    if (!map) return false;
    // refresh() only ever returns the bare google.maps.Map object, not
    // the surrounding context WFMM.map itself tracks (route/surface/
    // adapter/etc) -- getContext() is a separate call for that, and it's
    // safe to call right after refresh() resolves since refresh() is
    // what sets it in the first place.
    const context = wfmmWindow.WFMM.map.getContext?.();
    waeSetCurrentMap(map, context?.surface);
    return true;
  }

  // WFMM.map.onReady()/onCleared() (subscribed once in startPlugin(), see
  // that function) keep WAE_PULSES.map in sync automatically -- including
  // across a mapview<->submit-new switch, since that's a different
  // underlying google.maps.Map object each time and a Marker only ever
  // renders on the one it was created against. But WFMM.map only actually
  // SEARCHES when something calls .refresh() -- nothing in the suite's
  // own core does that automatically on every navigation, it's genuinely
  // each plugin's job to ask when it cares -- so onEnterMapRoute()/
  // onChangeMapRoute() below are what actually trigger a fresh refresh()
  // call at the moment it'd matter (landing on, or switching between,
  // mapview/submit-new), which onReady above then reacts to.
  let waeMapReadyUnsub = null;
  let waeMapClearedUnsub = null;
  let waeRouteEnterUnsub = null;
  let waeRouteChangeUnsub = null;
  // BUGFIX (not upstream): "Show on Map" left toggled on from a previous
  // session didn't reliably re-show its markers on a fresh page load --
  // needed a manual toggle off/on to actually appear. Root cause: this
  // plugin now runs at document-start (see the header's own v1.26.1
  // changelog note), so waeResyncMapIfVisible()'s very first
  // WFMM.map.refresh() call can genuinely race ahead of Angular/Google
  // Maps finishing initialization -- confirmed against the real source
  // (src/core/map/service.js): refresh() already retries internally (80
  // attempts, 250ms apart, ~20s total) before giving up and emitting
  // "map:not-found", but nothing retries again after that -- another
  // .refresh() call only ever happens from a route change or another
  // explicit call, neither of which happens on a page you're already on
  // when it finishes loading. A slow-loading page could exhaust that
  // whole 20s window before its map component ever renders, and from
  // then on the single failed search was just the end of it. Toggling
  // the button off and on again worked purely because that's a SECOND,
  // later .refresh() call, made after the map had had more time to
  // actually appear -- not because anything about the toggle itself
  // mattered. Retrying automatically here removes the need for that.
  let waeMapNotFoundUnsub = null;
  let waeMapRetryTimer = null;
  let waeMapRetriesLeft = 0;
  // Only armed for the two silent/background triggers below (the initial
  // resync at startup, and a route change) -- deliberately NOT armed for
  // the "Show on Map" button's own click handler, which already has its
  // own clear, immediate error message on failure; layering a delayed
  // silent retry underneath that too would risk the button already
  // having shown "couldn't find the map" while pulses then quietly
  // appear anyway a few seconds later, which reads as more confusing
  // than just letting a manual click be its own cheap retry.
  const WAE_MAP_RETRY_LIMIT = 3;
  // BUGFIX (not upstream): abuse crosses still weren't showing up
  // reliably on the submit-Wayspot page specifically, even after the
  // route-level fixes above -- reported as "inconsistent" rather than
  // "never", which pointed at something route-level tracking wouldn't
  // catch. Likely explanation (not confirmed against Base's own source,
  // since this needs live testing on the actual submit flow to fully
  // verify): unlike the general mapview, /new/submit/new is ONE route
  // start to finish -- picking a location, confirming it, moving between
  // whatever internal steps that flow has -- and if the underlying
  // google.maps.Map object gets torn down and recreated as part of that
  // (rather than staying the same instance for the route's whole
  // lifetime), nothing here would ever notice: onEnterMapRoute/
  // onChangeMapRoute only fire on an actual ROUTE change, and this
  // plugin's own map:not-found retry above only fires from a failed
  // SEARCH, not from an already-attached map silently going stale under
  // it. A periodic safety-net refresh() call, gated on pulses actually
  // being on, covers this regardless of the exact internal cause --
  // refresh()'s own fast path (the currently-attached map is still
  // valid) is just a staleness check against a cached value, so this
  // costs essentially nothing on every tick where nothing's actually
  // changed, and only does real work (a fresh search, then onReady above
  // picking up the result) on the tick where it turns out something did.
  const WAE_MAP_PERIODIC_RECHECK_MS = 5000;
  let waeMapPeriodicRecheckTimer = null;

  function waeStartMapTracking() {
    if (waeMapReadyUnsub) return; // already subscribed
    const WFMM = wfmmWindow.WFMM;
    waeMapReadyUnsub = WFMM.map.onReady(({ map, context }) => {
      waeMapRetriesLeft = 0; // a real map showed up -- nothing left to retry
      waeSetCurrentMap(map, context?.surface);
      if (isMapPulsesEnabled()) waeRefreshPulses();
    });
    waeMapClearedUnsub = WFMM.map.onCleared(() => {
      WAE_PULSES.map = null;
      WAE_PULSES.surface = null;
    });
    const onMapRouteEvent = () => {
      if (!isMapPulsesEnabled()) return;
      waeMapRetriesLeft = WAE_MAP_RETRY_LIMIT; // fresh route -> a fresh search that can itself race Angular/Maps, same as the startup case
      WFMM.map.refresh({ reason: 'wae-route-change' });
    };
    waeRouteEnterUnsub = WFMM.routes.onEnterMapRoute(onMapRouteEvent);
    waeRouteChangeUnsub = WFMM.routes.onChangeMapRoute(onMapRouteEvent);
    waeMapNotFoundUnsub = WFMM.events.on('map:not-found', () => {
      if (!isMapPulsesEnabled() || waeMapRetryTimer || waeMapRetriesLeft <= 0) return;
      waeMapRetriesLeft -= 1;
      waeMapRetryTimer = setTimeout(() => {
        waeMapRetryTimer = null;
        if (isMapPulsesEnabled()) WFMM.map.refresh({ reason: 'wae-retry-after-not-found' });
      }, 3000);
    });
    waeMapPeriodicRecheckTimer = setInterval(() => {
      if (isMapPulsesEnabled()) WFMM.map.refresh({ reason: 'wae-periodic-recheck' });
    }, WAE_MAP_PERIODIC_RECHECK_MS);
  }

  function waeStopMapTracking() {
    waeMapReadyUnsub?.();
    waeMapClearedUnsub?.();
    waeRouteEnterUnsub?.();
    waeRouteChangeUnsub?.();
    waeMapNotFoundUnsub?.();
    if (waeMapRetryTimer) { clearTimeout(waeMapRetryTimer); waeMapRetryTimer = null; }
    if (waeMapPeriodicRecheckTimer) { clearInterval(waeMapPeriodicRecheckTimer); waeMapPeriodicRecheckTimer = null; }
    waeMapReadyUnsub = null;
    waeMapClearedUnsub = null;
    waeRouteEnterUnsub = null;
    waeRouteChangeUnsub = null;
    waeMapNotFoundUnsub = null;
    waeMapRetriesLeft = 0;
  }

  // Panel-row click -> jump the map to that location. The panel is a
  // full-screen backdrop, so the map isn't visible until it closes -- this
  // closes it as part of navigating BY DEFAULT, the same way clicking a
  // location is expected to actually show it rather than just move
  // something behind the modal -- but only when
  // waeAutoCloseOnNavigateEnabled() says so; see that setting's own
  // comment for why it's optional. Shows the InfoWindow on arrival
  // either way, as immediate visual confirmation regardless of whether
  // "Show on Map" pins are toggled on -- that part was never conditional
  // on autoclose, only whether the panel itself gets out of the way.
  async function waeGoToLocation(record) {
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude)) return;
    const attached = await waeAttachToMapIfNeeded();
    if (!attached) {
      if (waeUI) log(waeUI.logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview or the submit-Wayspot map.', 'err');
      return;
    }
    const map = WAE_PULSES.map;
    const latLng = new google.maps.LatLng(record.latitude, record.longitude);
    map.setCenter(latLng);
    const z = map.getZoom();
    if (typeof z === 'number' && z < 17) map.setZoom(17);
    if (waeAutoCloseOnNavigateEnabled()) closePanel();
    google.maps.event.addListenerOnce(map, 'idle', () => waeShowPulseInfoWindow(record, latLng));
  }

  function isMapPulsesEnabled() {
    return localStorage.getItem(WAE_MAP_VISIBLE_KEY) === 'true';
  }

  // Re-syncs the map layer with whatever's currently in storage, but only
  // if the toggle is actually on -- called after scan/clear so the map
  // doesn't silently drift out of date while "Show on Map" is active, and
  // at bootstrap so a persisted-on toggle re-attaches on page load. The
  // bootstrap case is exactly where WAE_MAP_RETRY_LIMIT (see
  // waeStartMapTracking()'s own comment) matters most -- @run-at
  // document-start means this specific call can run before Angular/
  // Google Maps have actually finished initializing, so it's armed here
  // before attaching, not just left at whatever it happened to be.
  // Keeping in sync with view switches after this point is
  // waeStartMapTracking()'s job (see its own comment), not this
  // function's -- that's a one-time subscription set up in startPlugin(),
  // not something re-armed on every resync.
  async function waeResyncMapIfVisible() {
    if (!isMapPulsesEnabled()) return;
    waeMapRetriesLeft = WAE_MAP_RETRY_LIMIT;
    const attached = await waeAttachToMapIfNeeded();
    if (attached) waeRefreshPulses();
  }

  // ---------------------------------------------------------------------
  // Scan: raw imported emails -> extracted rows
  // ---------------------------------------------------------------------

  async function scanImportedEmails(onProgress) {
    const allEmails = await WSTStorage.getAllEmails();

    // Pass 1: classify + parse every stored email into its own thread,
    // and group by conversationId. A long-running ticket can span
    // several separate email notifications -- Helpshift/the mailer only
    // includes a recent window of quoted history in each one, not
    // necessarily the complete conversation -- so a ticket's true
    // complete picture can require several stored emails, not just
    // whichever one happens to be newest. Emails with no conversationId
    // (couldn't be parsed as a ticket at all) each get their own
    // single-email group, keyed by record.id, same as before.
    const groups = new Map(); // key -> { threads: [], records: [] }
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

      let thread;
      try {
        thread = OPREmail.helpshift.parseThread(email.getBody('text/plain') || '', email.getFirstHeaderValue('Date', null));
      } catch (e) { continue; }

      const key = thread.conversationId ? `conv:${thread.conversationId}` : `email:${record.id}`;
      if (!groups.has(key)) groups.set(key, { threads: [], records: [] });
      const group = groups.get(key);
      group.threads.push(thread);
      group.records.push(record);
    }

    // Pass 2: merge each group's messages into one complete thread (a
    // no-op for single-email groups -- mergeThreads on one thread just
    // returns it), then extract locations/fields/status from that
    // complete picture instead of any single email's own partial view.
    const extracted = [];
    const ticketDetails = [];
    for (const [idBase, group] of groups.entries()) {
      const merged = OPREmail.helpshift.mergeThreads(group.threads);

      let parsed;
      try {
        parsed = OPREmail.helpshift.parseAbuseReportThread(merged);
      } catch (e) { continue; }

      const ticketStatus = OPREmail.helpshift.classifyAbuseReportStatus(merged.messages) || 'ABUSE_REPORT_UPDATED';

      // Per-ticket, not per-location -- same value on every row for this
      // ticket, same reasoning as ticketStatus just above. merged.messages
      // is already newest-first (mergeThreads' own re-sort, by actual
      // parsed timestamp -- see its comment), so [0] is reliably the
      // actual most recent message across every source email that fed
      // into this ticket, not just whichever export happened to be
      // scanned. An unparseable/missing timestamp (no messages at all,
      // or a date/time pair Date.parse() can't make sense of) leaves this
      // null rather than showing a wrong date -- the table/CSV both
      // already have an established "blank rather than guess" convention
      // for exactly this (see e.g. wayspotName).
      const newestMessage = merged.messages[0];
      const lastResponseAtMs = newestMessage ? Date.parse(`${newestMessage.date} ${newestMessage.time}`) : NaN;
      const lastResponseAt = Number.isNaN(lastResponseAtMs) ? null : lastResponseAtMs;

      // Multiple source emails can contribute to one merged ticket now --
      // list all of them (oldest first, matching the merged message
      // order's intent) rather than picking just one, so every email that
      // fed into this row's data is still traceable.
      const sourceEmailId = group.records.map((r) => r.id).join('; ');
      const sourceFilename = group.records.map((r) => r.filename).filter(Boolean).join('; ') || null;

      // issueType/locationDetails/reportDetails are per-TICKET, not
      // per-location -- written once here rather than duplicated onto
      // every location row below (see the v1.21.0 changelog note on
      // EXTRACT_DB_VERSION for why: a 12-location ticket used to store
      // the same ~2.4KB of raw text 12 times).
      ticketDetails.push({
        id: idBase,
        issueType: parsed.issueType || null,
        locationDetails: parsed.locationDetails || null,
        reportDetails: parsed.reportDetails || null,
      });

      // parsed.locations is every Wayspot found anywhere in the merged
      // thread -- the original report can list several at once, and
      // later replies ("I see I missed some: ...") can add more. One row
      // per location, all sharing conversationId/ticketStatus/ticketKey
      // so they're still recognizable as one ticket in the CSV. A ticket
      // with no parseable location at all still gets exactly one row (so
      // it's not silently dropped from the scan), with everything
      // location-related left null.
      const locations = parsed.locations && parsed.locations.length ? parsed.locations : [null];

      locations.forEach((loc, i) => {
        extracted.push({
          id: locations.length > 1 ? `${idBase}:${i}` : idBase,
          ticketKey: idBase,
          conversationId: parsed.conversationId || null,
          ticketStatus,
          lastResponseAt,
          wayspotName: loc ? loc.name : null,
          latitude: loc ? Number(loc.latitude) : null,
          longitude: loc ? Number(loc.longitude) : null,
          comment: loc ? (loc.comment || null) : null,
          sourceEmailId,
          sourceFilename,
          scannedAt: Date.now(),
        });
      });
    }

    return { extracted, ticketDetails };
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------

  const CSV_COLUMNS = [
    ['conversationId', 'Conversation ID'],
    ['ticketStatus', 'Ticket Status'],
    ['lastResponseAt', 'Last Response (UTC)'],
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

  // Only the bits WFMM.ui's own base styles (injected by
  // ui.injectBaseStyles()/ui.openModal() itself) don't already cover --
  // the modal shell, buttons, inputs, section headers, empty/loading
  // states, and the table's core look all come from the suite's own
  // wfmm-* classes now, applied via WFMM.ui.createElement/button/
  // textInput/table/etc rather than reimplemented here. This is layered
  // ON TOP of ui.table()'s own .wfmm-table styling for the report-
  // specific semantics it doesn't know about (missing-value styling,
  // status badges, nearby-duplicate highlighting, the floating nearby-
  // ticket popover, which has no equivalent in the suite's UI service).
  const STYLE = `
    #wae-panel .wfmapmods-modal-dialog{ width:600px; max-width:calc(100vw - 24px); }
    .wae-sub{ font-size:11px; color:var(--wfmm-muted-text, #667085); margin-bottom:8px; }
    .wae-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    .wae-log{ margin-top:8px; max-height:110px; overflow-y:auto; font-size:11px; line-height:1.5; }
    .wae-log div.ok{ color:#16a34a; }
    .wae-log div.warn{ color:#b45309; }
    .wae-log div.err{ color:#dc2626; }
    .wae-search-input{ margin:6px 0; }
    /* BUGFIX v1.25.0: WFMM.ui.table()'s own base CSS (.wfmm-table) has no
       table-layout:fixed and no per-cell max-width/overflow -- columns
       size purely to content, so one long unbroken string (e.g. a URL)
       could blow a column out wide enough to push Status/the nearby-flag
       column out of the visible/scrollable area entirely. The old hand-
       rolled #wae-table had this constraint (max-width:160px + ellipsis
       on every td) and it silently didn't carry over when the table
       switched to WFMM.ui.table() -- fixed widths per column below (by
       position, since table() has no per-column width option) restore
       it.
       BUGFIX v1.29.2: percentages below were tuned for 7 columns and
       never revisited when the "Last Response" column was added
       (v1.28.0), landing it and Status (both real content -- a status
       pill, and a date + sort-arrow header -- not filler) too narrow for
       what they actually render. Only columns 1-2 had overflow:hidden at
       the time (the two free-text columns, the original overflow risk),
       so instead of wrapping or clipping, Status'/Last Response's own
       content just visually spilled out past their cell boundary into
       whatever sits next to them -- reported as the two columns
       "overlapping". Widths rebalanced below to actually fit a "Pending
       Review" badge and a wrapped two-line "Last Response ▼" header
       without that, and overflow:hidden now applies to every column, not
       just the two free-text ones -- so the next new column added here
       clips instead of bleeding into its neighbor if it's ever undersized
       the same way, rather than silently reproducing this exact bug
       again. */
    .wae-table{ table-layout: fixed; }
    .wae-table th:nth-child(1), .wae-table td:nth-child(1){ width: 10%; }
    .wae-table th:nth-child(2), .wae-table td:nth-child(2){ width: 22%; }
    .wae-table th:nth-child(3), .wae-table td:nth-child(3){ width: 9%; }
    .wae-table th:nth-child(4), .wae-table td:nth-child(4){ width: 9%; }
    .wae-table th:nth-child(5), .wae-table td:nth-child(5){ width: 5%; }
    .wae-table th:nth-child(6), .wae-table td:nth-child(6){ width: 5%; }
    .wae-table th:nth-child(7), .wae-table td:nth-child(7){ width: 18%; }
    .wae-table th:nth-child(8), .wae-table td:nth-child(8){ width: 22%; }
    .wae-table td{
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wae-pagination{ display:flex; align-items:center; justify-content:center; gap:10px; margin-top:8px; }
    .wae-pagination .wae-sub{ margin:0; white-space:nowrap; }
    td.wae-missing{ color:#9ca3af; font-style:italic; }
    td.wae-comment, td.wae-nearby-flag{ text-align:center; cursor:help; max-width:24px; }
    .wae-status-badge{
      display:inline-block; border:1px solid; border-radius:9999px;
      padding:1px 8px; font-size:10.5px; font-weight:600; white-space:nowrap;
    }
    tr.wae-row-nearby td{ background:#fffbeb; }
    tr.wae-row-clickable{ cursor:pointer; }
    tr.wae-row-clickable:hover td{ background:#fff7ed; }

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
    const line = waeUiApi.createElement('div', { className: cls || '', text: msg });
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

  // Status pipeline order (not alphabetical) -- Received -> Pending Review
  // -> a settled state (Actioned/Denied/Updated) -- so sorting by status
  // groups tickets by where they are in that pipeline instead of by
  // label text. Anything not in WAE_STATUS_BADGES (a status value this
  // plugin doesn't recognize) sorts last, after every known stage.
  const WAE_STATUS_SORT_RANK = Object.keys(WAE_STATUS_BADGES).reduce((m, key, i) => { m[key] = i; return m; }, {});
  function waeStatusSortRank(ticketStatus) {
    return ticketStatus in WAE_STATUS_SORT_RANK ? WAE_STATUS_SORT_RANK[ticketStatus] : 999;
  }


  function waeStatusBadgeEl(ticketStatus) {
    const info = WAE_STATUS_BADGES[ticketStatus] || { label: waeStatusLabel(ticketStatus), color: '#6b7280' };
    return waeUiApi.createElement('span', {
      className: 'wae-status-badge',
      text: info.label,
      style: { color: info.color, borderColor: info.color },
    });
  }

  // "Last Response" column -- the ticket's lastResponseAt (see
  // scanImportedEmails()'s own comment on where that comes from), shown
  // as a locale-formatted date/time. toLocaleDateString() alone for the
  // cell text (day-level precision is enough to scan a column of these
  // at a glance) with the full toLocaleString() -- date AND time -- in
  // the title attribute for whoever wants the exact time on hover, same
  // "short in the cell, full detail on hover" pattern the Wayspot Name
  // column already uses.
  function waeFormatLastResponse(ms) {
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return { short: d.toLocaleDateString(), full: d.toLocaleString() };
  }

  // Builds the table (or an empty-state) for the current page, using
  // WFMM.ui.table()/pager()/emptyState() instead of an innerHTML string --
  // see the v1.22.0 changelog note. table()'s own onRowClick fires for
  // ANY click on a row, so the nearby-flag trigger has to be special-cased
  // inside it (checked via event.target.closest()) rather than getting
  // its own listener the way the old delegated click handler on
  // #wae-table-container used to split these apart.
  function buildTableSection(sorted, hasQuery, nearbyMap) {
    if (!sorted.length) {
      return waeUiApi.emptyState(
        hasQuery
          ? 'No rows match that search.'
          : 'No abuse reports extracted yet -- click "Scan Imported Emails".'
      );
    }

    const totalPages = Math.max(1, Math.ceil(sorted.length / WAE_PAGE_SIZE));
    if (waeCurrentPage > totalPages) waeCurrentPage = totalPages;
    if (waeCurrentPage < 1) waeCurrentPage = 1;
    const startIdx = (waeCurrentPage - 1) * WAE_PAGE_SIZE;
    const pageRecords = sorted.slice(startIdx, startIdx + WAE_PAGE_SIZE);

    const columns = [
      {
        key: 'conversation', label: 'Conversation', sortable: true,
        render: (r) => {
          const v = r.conversationId || r.sourceEmailId;
          return waeUiApi.createElement('span', { text: v, attrs: { title: v } });
        },
      },
      {
        key: 'name', label: 'Wayspot Name',
        render: (r) => r.wayspotName
          ? waeUiApi.createElement('span', { text: r.wayspotName, attrs: { title: r.wayspotName } })
          : waeUiApi.createElement('span', { className: 'wae-missing', text: '(none found)' }),
      },
      {
        key: 'lat', label: 'Lat',
        render: (r) => r.latitude !== null
          ? r.latitude.toFixed(6)
          : waeUiApi.createElement('span', { className: 'wae-missing', text: '-' }),
      },
      {
        key: 'lng', label: 'Lng',
        render: (r) => r.longitude !== null
          ? r.longitude.toFixed(6)
          : waeUiApi.createElement('span', { className: 'wae-missing', text: '-' }),
      },
      {
        key: 'comment', label: '', cellClassName: 'wae-comment',
        render: (r) => r.comment ? waeUiApi.createElement('span', { text: '\uD83D\uDCAC', attrs: { title: r.comment } }) : '',
      },
      {
        key: 'nearby', label: '', cellClassName: 'wae-nearby-flag',
        render: (r) => {
          const nearby = nearbyMap && nearbyMap.get(r.id);
          if (!nearby || !nearby.length) return '';
          return waeUiApi.createElement('span', {
            className: 'wae-nearby-trigger',
            text: '\u26A0\uFE0F',
            attrs: { title: 'Click to see nearby ticket(s)' },
            dataset: { nearbyId: r.id },
          });
        },
      },
      { key: 'status', label: 'Status', sortable: true, render: (r) => waeStatusBadgeEl(r.ticketStatus) },
      {
        key: 'lastResponse', label: 'Last Response', sortable: true,
        render: (r) => {
          const f = waeFormatLastResponse(r.lastResponseAt);
          return f
            ? waeUiApi.createElement('span', { text: f.short, attrs: { title: f.full } })
            : waeUiApi.createElement('span', { className: 'wae-missing', text: '-' });
        },
      },
    ];

    const { wrap, tbody } = waeUiApi.table({
      columns,
      rows: pageRecords,
      className: 'wae-table',
      stickyHeader: true,
      maxHeight: 260,
      sortState: { key: waeSortKey, direction: waeSortDirection },
      onSort: (key) => {
        // Clicking the already-active column's header flips direction;
        // clicking a different sortable column switches to it, starting
        // ascending. Back to page 1 too -- sorting reshuffles which
        // records land on which page, so staying on e.g. page 3 after a
        // re-sort would show an arbitrary slice rather than what's
        // actually 3 pages in under the new order.
        waeSortDirection = (waeSortKey === key && waeSortDirection === 'asc') ? 'desc' : 'asc';
        waeSortKey = key;
        waeSaveSortState();
        waeCurrentPage = 1;
        waeRenderFilteredTable();
      },
      onRowClick: (record, rowIndex, event) => {
        const flagTrigger = event.target.closest('.wae-nearby-trigger');
        if (flagTrigger) {
          event.stopPropagation();
          const nearby = nearbyMap.get(flagTrigger.dataset.nearbyId);
          if (nearby && nearby.length) waeOpenNearbyPopover(flagTrigger, nearby);
          return;
        }
        if (record.latitude !== null && record.longitude !== null) {
          waeGoToLocation(record);
        }
      },
    });

    // table() has no per-row className/title option -- applied directly
    // to the rendered <tr> elements afterward instead, matched back up to
    // pageRecords by index (same order table() rendered them in).
    pageRecords.forEach((record, i) => {
      const tr = tbody.children[i];
      if (!tr) return;
      const hasCoords = record.latitude !== null && record.longitude !== null;
      const nearby = nearbyMap && nearbyMap.get(record.id);
      if (hasCoords) {
        tr.classList.add('wae-row-clickable');
        tr.title = 'Click to locate on the map';
      }
      if (nearby && nearby.length) tr.classList.add('wae-row-nearby');
    });

    const children = [wrap];
    if (totalPages > 1) {
      children.push(waeUiApi.pager({
        page: waeCurrentPage,
        pageCount: totalPages,
        label: `Page ${waeCurrentPage} of ${totalPages} (rows ${startIdx + 1}\u2013${Math.min(startIdx + WAE_PAGE_SIZE, sorted.length)} of ${sorted.length})`,
        onPage: (nextPage) => {
          waeCurrentPage = nextPage;
          waeRenderFilteredTable();
        },
        className: 'wae-pagination',
      }));
    }

    return waeUiApi.createElement('div', { children });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let waeFilteredSortedCache = null;
  let waeFilteredSortedCacheFor = null;

  // Only re-filters/re-sorts when the underlying data or the search query
  // actually changed since last time -- refreshPanel() always assigns a
  // fresh array to waeAllRecords on a real data reload, so comparing by
  // reference (not content) is enough to detect that cheaply. A pure page
  // turn (Prev/Next) calls waeRenderFilteredTable() with neither of those
  // changed, so it hits this cache instead of redoing the same filter and
  // sort pass across the whole dataset for the sake of showing 200
  // already-known rows.
  // Only re-filters/re-sorts when the underlying data, search query, or
  // sort column/direction actually changed since last time -- refreshPanel()
  // always assigns a fresh array to waeAllRecords on a real data reload,
  // so comparing by reference (not content) is enough to detect that
  // cheaply. A pure page turn (Prev/Next) calls waeRenderFilteredTable()
  // with none of those changed, so it hits this cache instead of redoing
  // the same filter and sort pass across the whole dataset for the sake
  // of showing 200 already-known rows.
  function waeGetFilteredSorted() {
    const q = waeSearchQuery.trim().toLowerCase();
    if (
      waeFilteredSortedCacheFor
      && waeFilteredSortedCacheFor.recordsRef === waeAllRecords
      && waeFilteredSortedCacheFor.query === q
      && waeFilteredSortedCacheFor.sortKey === waeSortKey
      && waeFilteredSortedCacheFor.sortDirection === waeSortDirection
    ) {
      return waeFilteredSortedCache;
    }
    const filtered = q ? waeAllRecords.filter((r) => waeMatchesQuery(r, q)) : waeAllRecords;
    const dir = waeSortDirection === 'asc' ? 1 : -1;
    let compare;
    if (waeSortKey === 'conversation') {
      compare = (a, b) => dir * String(a.conversationId || a.sourceEmailId).localeCompare(String(b.conversationId || b.sourceEmailId), undefined, { numeric: true, sensitivity: 'base' });
    } else if (waeSortKey === 'status') {
      compare = (a, b) => dir * (waeStatusSortRank(a.ticketStatus) - waeStatusSortRank(b.ticketStatus));
    } else if (waeSortKey === 'lastResponse') {
      // Missing/unparseable timestamps sort last regardless of direction
      // -- "no known last-response date" isn't meaningfully "oldest" or
      // "newest", it's just unknown, so it shouldn't jump to the top on
      // a descending sort the way treating it as 0/-Infinity would.
      // Number.isFinite() rather than checking specifically for null --
      // a record extracted before this column existed has no
      // lastResponseAt property at all (undefined), not null, and both
      // need the same "unknown" treatment here.
      compare = (a, b) => {
        const af = Number.isFinite(a.lastResponseAt);
        const bf = Number.isFinite(b.lastResponseAt);
        if (!af && !bf) return 0;
        if (!af) return 1;
        if (!bf) return -1;
        return dir * (a.lastResponseAt - b.lastResponseAt);
      };
    } else {
      // Default/original behavior -- newest-scanned first, direction not
      // user-adjustable since there's no header for it to click.
      compare = (a, b) => (b.scannedAt || 0) - (a.scannedAt || 0);
    }
    const sorted = filtered.slice().sort(compare);
    waeFilteredSortedCache = sorted;
    waeFilteredSortedCacheFor = { recordsRef: waeAllRecords, query: q, sortKey: waeSortKey, sortDirection: waeSortDirection };
    return sorted;
  }

  let waeStatsCache = null;
  let waeStatsCacheFor = null;

  // Same idea as waeGetFilteredSorted -- these three counts only depend
  // on waeAllRecords itself, never the current page or search query, so
  // recomputing three O(n) passes over the full dataset on every single
  // render (including a plain page turn) was pure waste.
  function waeGetStats() {
    if (waeStatsCacheFor === waeAllRecords) return waeStatsCache;
    waeStatsCache = {
      withCoords: waeAllRecords.filter((r) => r.latitude !== null && r.longitude !== null).length,
      withName: waeAllRecords.filter((r) => r.wayspotName).length,
      ticketCount: new Set(waeAllRecords.map((r) => r.conversationId || r.sourceEmailId)).size,
    };
    waeStatsCacheFor = waeAllRecords;
    return waeStatsCache;
  }

  function waeRenderFilteredTable() {
    if (!waeUI) return; // panel isn't open -- nothing to render into
    const q = waeSearchQuery.trim().toLowerCase();
    const sorted = waeGetFilteredSorted();

    waeUiApi.empty(waeUI.tableContainer);
    waeUI.tableContainer.appendChild(buildTableSection(sorted, !!q, waeNearbyMap));

    const { withCoords, withName, ticketCount } = waeGetStats();
    const nearbyCount = waeNearbyMap.size;
    let base = `${waeAllRecords.length} location(s) extracted from ${ticketCount} ticket(s) -- ${withCoords} with coordinates, ${withName} with a name guess.`;
    if (nearbyCount) base += ` \u26A0\uFE0F ${nearbyCount} within ${WAE_NEARBY_THRESHOLD_METERS}m of a report from another ticket.`;
    waeUI.countEl.textContent = q ? `${sorted.length} match${sorted.length === 1 ? '' : 'es'} -- ${base}` : base;

    waeUI.exportBtn.disabled = waeAllRecords.length === 0;
    waeUI.clearBtn.disabled = waeAllRecords.length === 0;
    waeUI.mapToggleBtn.disabled = withCoords === 0;
    waeUI.mapToggleBtn.textContent = isMapPulsesEnabled() ? 'Hide from Map' : 'Show on Map';
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
    if (!waeUI) return; // panel isn't open
    try {
      waeAllRecords = await getAllExtractedRecords();
      waeRecordsById = new Map(waeAllRecords.map((r) => [r.id, r]));
    } catch (e) {
      waeUI.countEl.textContent = 'Could not read extracted-report storage.';
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

  // Builds the panel's BODY content into an already-open WFMM.ui modal --
  // called as openModal()'s buildContent(modalController). The modal
  // itself (backdrop, dialog, header/title, close button, Escape/
  // backdrop-click handling) is entirely WFMM.ui's own doing now; this
  // only ever touches modal.body. Every button/input/section is built via
  // the `ui` service handed in here, same one openModal() itself uses
  // internally, so this panel matches the rest of the suite's look
  // instead of a hand-copied approximation of it.
  function buildPanelContent(modal) {
    const ui = modal.ui;
    waeUiApi = ui; // so helpers called outside buildContent's own scope (log(), the popover, table row clicks) can still reach it

    const countEl = ui.createElement('div', { className: 'wae-sub', text: 'Loading...' });

    const scanBtn = ui.button({ text: 'Scan Imported Emails', variant: 'primary' });
    const mapToggleBtn = ui.button({ text: 'Show on Map', disabled: true });
    const exportBtn = ui.button({ text: 'Export CSV', disabled: true });
    const clearBtn = ui.button({ text: 'Clear Extracted Data', variant: 'danger', disabled: true });
    const buttonRowEl = ui.buttonRow([scanBtn, mapToggleBtn, exportBtn, clearBtn]);

    const progressEl = ui.createElement('div', { className: 'wae-progress' });

    const searchInput = ui.textInput({
      className: 'wfmm-input wfmm-input-large wae-search-input',
      placeholder: 'Search name, ticket, location/report text\u2026',
    });

    const autoCloseToggle = ui.checkboxRow({
      label: 'Close this panel when a row jumps the map to its location',
      checked: waeAutoCloseOnNavigateEnabled(),
      onChange: (checked) => localStorage.setItem(WAE_AUTOCLOSE_ON_NAVIGATE_KEY, String(checked)),
    });

    const tableContainer = ui.createElement('div', { className: 'wae-table-container' });
    const logEl = ui.createElement('div', { className: 'wae-log' });

    // ---- Marker Style ----
    // See the WAE_APPEARANCE_* block up top for why this is its own
    // section here rather than a literal new entry in Wayspot Overlay's
    // built-in Wayspots/Pok\u00e9stops/Gyms/Power Spots grid (not
    // possible -- that grid is hardcoded to those four kinds). This uses
    // the same generic-style shape and the same colorInput/rangeInput
    // controls the suite's own settings screens use, and is backed by a
    // real WFMM.markerAppearance.registerStyle() registration (see
    // startPlugin()) so it's genuinely part of that engine, just
    // surfaced through this panel instead of that one fixed grid.
    function updateAppearance(partial) {
      const next = waeNormalizeAppearance({ ...waeLoadAppearance(), ...partial });
      waeSaveAppearance(next);
      return next;
    }
    const initialAppearance = waeLoadAppearance();
    const styleColorInput = ui.colorInput({
      value: initialAppearance.fillColor,
      onInput: (v) => updateAppearance({ fillColor: v }),
    });
    const styleSizeRange = ui.rangeInput({
      min: 4, max: 24, step: 1, value: initialAppearance.markerSize,
      formatValue: (v) => `${v}px`,
      onInput: (v) => updateAppearance({ markerSize: Number(v) }),
    });
    const styleFillOpacityRange = ui.rangeInput({
      min: 0, max: 1, step: 0.05, value: initialAppearance.fillOpacity,
      formatValue: (v) => `${Math.round(Number(v) * 100)}%`,
      onInput: (v) => updateAppearance({ fillOpacity: Number(v) }),
    });
    const styleBorderColorInput = ui.colorInput({
      value: initialAppearance.borderColor,
      onInput: (v) => updateAppearance({ borderColor: v }),
    });
    const styleBorderWidthRange = ui.rangeInput({
      min: 0, max: 8, step: 1, value: initialAppearance.borderWidth,
      formatValue: (v) => `${v}px`,
      onInput: (v) => updateAppearance({ borderWidth: Number(v) }),
    });
    const styleBorderOpacityRange = ui.rangeInput({
      min: 0, max: 1, step: 0.05, value: initialAppearance.borderOpacity,
      formatValue: (v) => `${Math.round(Number(v) * 100)}%`,
      onInput: (v) => updateAppearance({ borderOpacity: Number(v) }),
    });
    const resetStyleBtn = ui.button({
      text: 'Reset to default',
      onClick: () => {
        const d = waeNormalizeAppearance(WAE_APPEARANCE_DEFAULTS);
        waeSaveAppearance(d);
        styleColorInput.value = d.fillColor;
        styleBorderColorInput.value = d.borderColor;
        styleSizeRange.input.value = String(d.markerSize);
        styleSizeRange.valueEl.textContent = `${d.markerSize}px`;
        styleFillOpacityRange.input.value = String(d.fillOpacity);
        styleFillOpacityRange.valueEl.textContent = `${Math.round(d.fillOpacity * 100)}%`;
        styleBorderWidthRange.input.value = String(d.borderWidth);
        styleBorderWidthRange.valueEl.textContent = `${d.borderWidth}px`;
        styleBorderOpacityRange.input.value = String(d.borderOpacity);
        styleBorderOpacityRange.valueEl.textContent = `${Math.round(d.borderOpacity * 100)}%`;
        styleClickableToggle.input.checked = d.clickable;
      },
    });
    const styleClickableToggle = ui.checkboxRow({
      label: 'Clickable markers',
      checked: initialAppearance.clickable,
      onChange: (checked) => updateAppearance({ clickable: checked }),
    });
    const styleSection = ui.section({
      title: 'Marker Style',
      hint: 'Color/size for the map markers this plugin draws (single reports and clusters).',
      children: [
        ui.fieldRow({ label: 'Color', input: styleColorInput }),
        ui.fieldRow({ label: 'Size', input: styleSizeRange.row }),
        ui.fieldRow({ label: 'Fill opacity', input: styleFillOpacityRange.row, help: 'Only visible on cluster markers -- a single X marker is always fully opaque.' }),
        ui.fieldRow({ label: 'Ring color', input: styleBorderColorInput, help: 'Cluster markers only.' }),
        ui.fieldRow({ label: 'Ring width', input: styleBorderWidthRange.row }),
        ui.fieldRow({ label: 'Ring opacity', input: styleBorderOpacityRange.row }),
        styleClickableToggle.row,
        ui.buttonRow([resetStyleBtn]),
      ],
    });

    modal.body.append(countEl, buttonRowEl, progressEl, searchInput, autoCloseToggle.row, tableContainer, logEl, styleSection);

    waeUI = { countEl, tableContainer, logEl, scanBtn, mapToggleBtn, exportBtn, clearBtn, searchInput };

    let waeSearchDebounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(waeSearchDebounceTimer);
      waeSearchDebounceTimer = setTimeout(() => {
        waeSearchQuery = searchInput.value;
        waeCurrentPage = 1;
        waeRenderFilteredTable();
      }, 200);
    });

    mapToggleBtn.addEventListener('click', async () => {
      const turningOn = !isMapPulsesEnabled();
      if (turningOn) {
        mapToggleBtn.disabled = true;
        mapToggleBtn.textContent = 'Attaching to map...';
        const attached = await waeAttachToMapIfNeeded();
        mapToggleBtn.disabled = false;
        if (!attached) {
          log(logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview or the submit-Wayspot map.', 'err');
          mapToggleBtn.textContent = 'Show on Map';
          return;
        }
        localStorage.setItem(WAE_MAP_VISIBLE_KEY, 'true');
        await waeRefreshPulses();
        // No waeStartStaleWatch()-equivalent call needed here anymore --
        // waeStartMapTracking() (see startPlugin()) subscribes once for
        // the plugin's whole lifetime, not per-toggle; its own callbacks
        // already check isMapPulsesEnabled() before doing any real work,
        // so there's nothing extra to arm just because the toggle turned
        // on.
        mapToggleBtn.textContent = 'Hide from Map';
      } else {
        localStorage.setItem(WAE_MAP_VISIBLE_KEY, 'false');
        waeClearPulses();
        mapToggleBtn.textContent = 'Show on Map';
      }
    });

    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      progressEl.textContent = 'Scanning imported emails...';
      try {
        const { extracted, ticketDetails } = await scanImportedEmails((done, total) => {
          progressEl.textContent = `Scanning imported emails... ${done}/${total}`;
        });
        // Rebuild from scratch rather than upsert: a ticket's row count can
        // change between scans (a multi-location ticket now yields several
        // "conv:X:0" / "conv:X:1" / ... rows instead of one "conv:X" row),
        // and upserting alone would leave the old id's row behind as a
        // stale duplicate. Source data is the already-imported emails, so
        // a full rebuild is cheap and side-steps that entirely. Both
        // stores rebuild together -- ticketDetails is the per-ticket raw
        // text extractedReports' rows now reference via ticketKey rather
        // than each carrying their own copy (see EXTRACT_DB_VERSION note).
        await clearExtractedRecords();
        await clearTicketDetails();
        await putExtractedRecords(extracted);
        await putTicketDetails(ticketDetails);
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
        waeCurrentPage = 1;
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
          // ISO 8601 rather than a locale-formatted string (what the
          // table itself shows) -- unambiguous regardless of which
          // spreadsheet app/locale opens the file, and sorts correctly
          // as plain text too, which a "Sep 10, 2026" string wouldn't.
          lastResponseAt: Number.isFinite(r.lastResponseAt) ? new Date(r.lastResponseAt).toISOString() : '',
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
        await clearTicketDetails();
        log(logEl, '✓ Cleared extracted-report storage.', 'ok');
      } catch (e) {
        log(logEl, `✗ Clear failed: ${e.message || e}`, 'err');
      } finally {
        waeCurrentPage = 1;
        refreshPanel();
        waeResyncMapIfVisible();
      }
    });

    refreshPanel();

    // Returned as this modal's contentHooks -- WFMM.ui.openModal() calls
    // onClose() itself once the dialog is actually torn down, regardless
    // of whether that happened via the × button, Escape, a backdrop
    // click, or our own waeGoToLocation() calling modal.close()
    // programmatically -- one place to null out the now-stale DOM refs
    // instead of every close path having to remember to do it.
    return {
      onClose() {
        waeUI = null;
        waePanelController = null;
        waeCloseNearbyPopover();
      },
    };
  }

  function openPanel() {
    if (waePanelController) return; // already open
    waePanelController = wfmmWindow.WFMM.ui.openModal({
      id: 'wae-panel',
      title: 'Wayfarer Map Mods - Abuse Report Extractor',
      className: 'wae-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      // Dragging/resizing itself isn't something a plugin can turn on for
      // its own modal -- confirmed against the real source
      // (resolveDesktopModalInteractionOptions() in
      // desktop-modal-interactions.js): whatever draggable/resizable a
      // modal passes in gets OVERWRITTEN with the suite-wide "Make modals
      // draggable"/"Make modals resizeable" preference (Base's own Side
      // Panel settings), same as every other WFMM.ui modal, including the
      // suite's own (e.g. Reporting History). Since this panel already
      // goes through openModal(), it's automatically draggable/resizable
      // too, for free, once the user turns that preference on -- nothing
      // to opt into here. minWidth/minHeight below only matter once
      // resizing is on, same as Reporting History's own desktopInteractions.
      desktopInteractions: { minWidth: 420, minHeight: 320 },
      buildContent: buildPanelContent,
    });
  }

  function closePanel() {
    waePanelController?.close();
  }

  function togglePanel() {
    if (waePanelController) closePanel();
    else openPanel();
  }

  // ---------------------------------------------------------------------
  // Map Mods - Base side panel integration -- confirmed against Report
  // Wayspots v3.3.0's own insertReportingHistoryLinkIfReady() /
  // insertReportingSettingsLinkIfReady(): both just appendChild a plain
  // <a> into ".wfmapmods-settings-links" the first time it exists, found
  // via a MutationObserver on document.documentElement (childList+subtree,
  // debounced 50ms) that fires until "#wfmapmods-side-panel" is present.
  //
  // BUGFIX (not upstream): that other script's own observer disconnects
  // itself once its links are in, and this one used to copy that exactly
  // on the assumption that the settings section persists for the rest of
  // the SPA session once Base has rendered it once -- reported as the
  // plugin becoming completely unreachable ("unavailable") after
  // swapping between different pages on the same domain, since Wayfarer
  // being an Angular app means most navigation between its own routed
  // views (mapview, submit-new, etc.) is client-side, not a real page
  // load this script would ever re-run for. If Base's own side panel (or
  // just the .wfmapmods-settings-links section within it) gets torn down
  // and rebuilt by Angular's router on one of those navigations -- not
  // confirmed against Base's own source, but consistent with ordinary
  // Angular router behavior and with what was actually reported -- an
  // observer that already disconnected itself the first time would have
  // no way to notice the link is gone and never re-add it, permanently
  // losing the only way to reach this plugin's panel even though its own
  // background logic (map tracking, etc.) keeps running the whole time.
  // Left running indefinitely now instead (only actually disconnected in
  // stopPlugin()) so a rebuilt side panel gets the link re-inserted the
  // same way the very first appearance did. The observer's own handler
  // is already a cheap early-return once the link exists, so leaving it
  // attached for the rest of the page's lifetime rather than a one-shot
  // "until inserted" watch isn't a meaningfully heavier cost, just a more
  // correct one for an SPA.
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
    insertSettingsLinkIfReady();
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

  function startPlugin() {
    // Registering as an external plugin (the only path startPlugin() is
    // reached from -- see registerOrSelfStart() below) already implies
    // WFMM.plugins exists, which per the real v4.0.0+ source means
    // WFMM.ui and WFMM.markerAppearance do too -- all populated by the
    // same suite bootstrap (confirmed: WFMM.markerAppearance is assigned
    // right alongside WFMM.ui in that bootstrap sequence).
    // injectStyle() is idempotent (replaces by id, see WFMM.ui's own
    // dom.js), so this is safe to call every startPlugin() -- no separate
    // "already injected" guard needed.
    wfmmWindow.WFMM.ui.injectStyle('wae-extra-styles', STYLE);
    // registerStyle() itself is NOT idempotent -- it throws if the same
    // key is already registered, which matters here since startPlugin()
    // can run again if the plugin's toggled off/on in Plugin Manager. The
    // unregister function it returns is called in stopPlugin() below for
    // exactly that reason.
    waeUnregisterAppearance = wfmmWindow.WFMM.markerAppearance.registerStyle({
      key: WAE_APPEARANCE_STYLE_KEY,
      pluginId: PLUGIN_ID,
      // normalizeResolvedStyle() (marker-appearance.js) reads style.generic.*,
      // not a flat object -- waeLoadAppearance() stays flat for our own
      // icon-building code's convenience, wrapped here to match what the
      // registry actually expects from a resolve() callback.
      // Only the six fields normalizeResolvedStyle() (marker-appearance.js)
      // actually reads from style.generic -- clickable isn't a WFMM
      // marker-appearance concept, so it's left out here even though
      // waeLoadAppearance() itself carries it (see the v1.23.1 changelog
      // note up top).
      resolve: () => {
        const { markerSize, fillColor, fillOpacity, borderColor, borderWidth, borderOpacity } = waeLoadAppearance();
        return { markerType: 'generic', generic: { markerSize, fillColor, fillOpacity, borderColor, borderWidth, borderOpacity } };
      },
    });
    startSidePanelWatcher();
    // Subscribes to WFMM.map/WFMM.routes for this plugin's whole
    // lifetime (see waeStartMapTracking()'s own comment for why this
    // replaced the old setInterval-based stale watch) -- started here
    // rather than tied to the "Show on Map" toggle, since the
    // subscriptions themselves are cheap and their callbacks already
    // check isMapPulsesEnabled() before doing any real work.
    waeStartMapTracking();
    waeResyncMapIfVisible();
  }

  function stopPlugin() {
    stopSidePanelWatcher();
    document.getElementById('wae-settings-link')?.remove();
    waeCloseNearbyPopover();
    closePanel(); // no-op if the panel isn't open; openModal's own close() tears its DOM down
    waeStopMapTracking();
    waeClearPulses();
    waeUnregisterAppearance?.();
    waeUnregisterAppearance = null;
  }

  // ---------------------------------------------------------------------
  // Map Mods plugin manager registration -- see the importer script's own
  // copy of this comment for the full explanation. Same pattern here:
  // register as a real entry in the suite's Plugin Manager settings
  // screen (window.WFMM.plugins.registerExternal(), confirmed against its
  // v4.0.0 source), falling back to the old self-starting behavior if the
  // plugin manager never becomes available within 5s.
  // ---------------------------------------------------------------------

  const PLUGIN_ID = 'wayfarer-abuse-report-extractor';
  const PLUGIN_DEFINITION = {
    id: PLUGIN_ID,
    name: (typeof GM_info !== 'undefined' && GM_info.script?.name) || 'Wayfarer Map Mods - Abuse Report Extractor',
    description: 'Scans imported abuse-report emails for reported Wayspot names/coordinates, flags nearby duplicates, and plots them on the map.',
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
  // comment for why) -- reused here unchanged from earlier versions.
  function registerOrSelfStart(attemptsLeft) {
    const plugins = wfmmWindow.WFMM && wfmmWindow.WFMM.plugins;
    if (plugins && typeof plugins.registerExternal === 'function') {
      try {
        plugins.registerExternal(PLUGIN_DEFINITION);
        return; // registered -- WFMM owns calling start()/stop() from here
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Report Extractor] Plugin Manager registration failed, self-starting instead:', e);
        startPlugin();
        return;
      }
    }
    if (attemptsLeft > 0) {
      setTimeout(() => registerOrSelfStart(attemptsLeft - 1), 250);
      return;
    }
    console.warn('[Wayfarer Map Mods - Abuse Report Extractor] Map Mods plugin manager not detected after 5s -- self-starting instead.');
    startPlugin();
  }

  registerOrSelfStart(20); // 20 * 250ms = 5s
})();
