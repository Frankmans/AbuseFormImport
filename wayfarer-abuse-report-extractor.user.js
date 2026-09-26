// ==UserScript==
// @name         Wayfarer Map Mods - Abuse Reports
// @namespace    https://github.com/Frankmans/AbuseFormImport
// @version      1.53.6
// @description  Scans emails already imported by Wayfarer Abuse Email Importer for Niantic Support "Reporting Abuse" tickets, extracts every reported Wayspot's name + coordinates (a ticket can report several, across the original submission and later replies), stores them locally, plots them on the Wayfarer map and the review page's duplicate-check map, and exports as CSV.
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
 * v1.53.6 CHANGE FROM v1.53.5 (feature request): the side-panel "+" button's
 * label is spelled back out to "+ add to abuse report draft" -- v1.52.0's
 * "+ Add" shortening (see that entry below) turned out too terse once
 * people had to tell it apart from the "\u2713 Added"/"\u2713 Updated" it
 * flashes after a click. WAE_MARK_BTN_LABEL is the one place this string
 * lives now, referenced both where the button's created and in the
 * post-click reset that used to hardcode "+ Add" a second time.
 *
 * v1.53.5 CHANGE FROM v1.53.4 (feature request): waeAddMarkedWayspot()
 * used to unconditionally push a new list entry every time "+ Add" was
 * clicked, even for a Wayspot already on the Marked Wayspots list --
 * clicking it again on the same Wayspot (e.g. to jot a note after the
 * fact, or just by accident) left two rows for one physical place. It now
 * looks for an existing entry at the same coordinates first (exact match
 * at toFixed(6) precision -- see the function's own comment for why that,
 * rather than a Haversine "nearby" check, is enough here) and, if found,
 * overwrites that entry's note with whatever's in the note field this
 * time -- including clearing it out to blank, same "last write wins"
 * behavior as every other field on this list -- rather than adding a
 * second row. The name is refreshed too, but only when the new read isn't
 * blank, so a real title never gets clobbered back to "Untitled location"
 * by a stale re-read. The "+ Add" button now shows "\u2713 Updated" instead of
 * "\u2713 Added" for this case, so it's obvious which happened.
 *
 * v1.53.4 CHANGE FROM v1.53.3 (bugfix, reported): Marked Wayspots' dots
 * stayed on the map even after unchecking "Abuse Report Crosses" in the
 * Layers menu -- v1.53.0 wired them up as their own always-on OverlayView
 * set (see that entry below), never actually gated on isMapPulsesEnabled()
 * the way the abuse-report crosses/clusters already are everywhere else.
 * waeRenderMarkedWayspotMarkers() now checks isMapPulsesEnabled() itself,
 * right alongside its existing `!map`/`!waeEnsureMarkMarkerOverlayCtor()`
 * early-clear check, so every one of its call sites (add/edit/delete/
 * clear-list, marker-style-size and marker-color changes, a fresh
 * waeSetCurrentMap() attach) now hides the dots for free whenever the
 * layer's off, with no need to touch any of those call sites individually.
 * waeApplyLayerEnabled() -- the layer's own onChange handler -- calls it
 * explicitly in both directions: on the disable path, right after
 * waeClearPulses(), so the dots disappear the instant the checkbox is
 * unticked rather than waiting for the next list mutation to trigger the
 * now-gated render; on the enable path, right after waeSafeRefreshPulses(),
 * since re-checking the box doesn't reassign WAE_PULSES.map (same map
 * instance as before) and so wouldn't otherwise re-trigger a draw the way
 * waeSetCurrentMap()'s own call does for a genuinely new map.
 *
 * v1.53.3 CHANGE FROM v1.53.2 (performance): waeGetMarkedWayspotSvgMarkup()
 * -- the Marked Wayspots cross icon -- used to rebuild its SVG string
 * from scratch on every single call, i.e. once per marker on every single
 * waeRenderMarkedWayspotMarkers() pass, even though every marker in a
 * given pass shares the same global color/markerSize. It now caches the
 * built SVG (WAE_MARK_ICON, new) and only rebuilds when the color or
 * markerSize it's called with actually differs from last time -- the
 * same kind of cache WAE_MARKER_ICON/WAE_CLUSTER_ICON already keep for
 * the abuse-report markers, just self-invalidating by comparing its own
 * inputs rather than needing an external reset call, since color is
 * already passed in as a parameter here rather than read internally.
 *
 * v1.53.2 CHANGE FROM v1.53.1 (performance): waeFindMatchingTicketNumbers()
 * -- the ticket-number annotation on the Wayspot details side panel, run
 * on every single Wayspot click -- used to do a plain linear scan (with a
 * Haversine distance check) over every record in waeAllRecords, every
 * time. Fine at a few hundred extracted tickets; increasingly not once
 * that climbs into the thousands, since accumulating exactly that over
 * time is this plugin's whole purpose. It now reuses the same grid-hash
 * index waeFindNearbyDuplicates() already builds for its own, similarly-
 * shaped nearby-match problem (waeGetTicketIndexBuckets(), new -- see its
 * own comment for why it's a different index from that function's
 * result, not a shared one), only checking the 3x3 neighborhood of grid
 * cells around the clicked Wayspot instead of the entire list. The index
 * is rebuilt only when waeAllRecords itself is reassigned, the same
 * reference-comparison cache-invalidation idiom already used for
 * waeFilteredSortedCacheFor/waeStatsCacheFor elsewhere in this file.
 *
 * v1.53.1 CHANGE FROM v1.53.0 (feature request): Marked Wayspots dots
 * changed from a filled circle to the same "X" cross glyph as the
 * abuse-report markers (waeGetMarkedWayspotSvgMarkup(), now sharing its
 * size math with waeGetMarkerSvgMarkup() -- markerSize * 2 viewbox, same
 * arm/stroke scaling), just drawn in this list's own configurable color
 * instead of fillColor. The Marker Style size slider now redraws these
 * too on every change, since their shape's size depends on it now.
 *
 * v1.53.0 CHANGE FROM v1.52.1 (feature request): every entry on the
 * Marked Wayspots list now also gets a visual marker on the mapview/
 * submit map itself -- a small filled dot, default blue (#2563eb),
 * clicking it shows the name/coordinates/note in an info window
 * (waeRenderMarkedWayspotMarkers()/WaeMarkMarkerOverlayCtor, new). The
 * color is changeable from Marker Style (the new "Marked Wayspot color"
 * field, separate from the abuse-report cross/cluster color above it)
 * and applies immediately, same as every other control in that section.
 * Deliberately its own, much simpler OverlayView rather than reusing
 * WaePulseOverlayCtor: no clustering (a manually-curated list realistic-
 * ally never gets dense enough to need it), and a single div straight in
 * overlayMouseTarget rather than a visible+hit-div pair, since there's
 * no "must not visually cover a real Wayspot marker" requirement for
 * these the way there is for abuse-report crosses (see that class's own
 * comment, and v1.50.2's changelog entry, for why splitting it in two
 * was necessary there specifically).
 *
 * v1.52.1 CHANGE FROM v1.52.0 (feature request): the Marked Wayspots list
 * modal (waeRenderMarkedWayspotListSection()) now opens with a link to
 * Niantic's own "Reporting Abuse in Wayfarer" Help Center article, right
 * above Copy All/Clear All -- a shortcut to where the copied list is
 * actually meant to be pasted.
 *
 * v1.52.0 CHANGE FROM v1.51.3 (feature request): the "+" on the Wayspot
 * details side panel now sits alongside a short note field
 * (waeStartSidePanelDetailsWatcher(), the new .wae-detail-mark-row/
 * .wae-detail-mark-note) -- typing a note there before clicking "+"
 * captures it in the same entry right away, instead of only being able
 * to add one afterward from the list modal (still possible too -- this
 * doesn't replace that). waeAddMarkedWayspot() now takes an optional
 * `note`. The button's own label is shortened to "+ Add" (was "+ Add to
 * Abuse Report List") now that it shares its row with that field.
 *
 * v1.51.3 CHANGE FROM v1.51.2: Marked Wayspots Copy All/per-row format
 * tweaked to "Name, lat, lng (note)" -- comma between name and
 * coordinates instead of an em dash, note in parentheses at the end
 * instead of another em-dash-separated segment. waeFormatMarkedWayspotLine()
 * is the only thing that changed.
 *
 * v1.51.2 CHANGE FROM v1.51.1 (reported not matching the wanted
 * interaction): replaces the global "+" toggle on the main panel
 * (arm marking mode, then click a Wayspot anywhere on the map) with a
 * "+" that lives directly on the Wayspot details side panel instead --
 * right alongside the existing ticket-number annotation this plugin
 * already adds there (see waeStartSidePanelDetailsWatcher(), extended
 * rather than duplicated: same WFMM.sidePanel.EVENTS.DETAILS_CHANGED
 * subscription, same DOM-read approach for the Wayspot's title/lat/lng).
 * Individual Wayspots now each get their own "+" to click, rather than a
 * separate mode that had to be armed first and applied to whatever got
 * clicked next. waeSetMarkModeActive()/WFMM.selection-based selection
 * listening from v1.51.1 is removed entirely -- nothing left needs it,
 * since the side panel's own DETAILS_CHANGED event already reliably
 * fires with the right Wayspot's data every time one is selected. The
 * List button (Copy All/Clear All) on the main panel is unchanged.
 *
 * v1.51.1 CHANGE FROM v1.51.0: v1.51.0's own name/location capture (a
 * capturing DOM click listener + map projection math, with the name only
 * ever a best-effort guess at a title/aria-label/alt attribute on
 * whatever DOM element was clicked) is replaced with a proper one,
 * checked against WFMM's own source rather than guessed at: Wayfarer's
 * real Wayspot markers render through deck.gl, so there was never a
 * per-marker DOM element for that attribute guess to actually read
 * anything off in the first place. WFMM itself already tracks every
 * Wayspot click centrally, for its own purposes, via WFMM.selection
 * (type "poi") backed by WFMM.pois (built from Wayfarer's own map-data
 * API responses) -- waeHandleWfmmSelectionChanged() now reads the
 * clicked Wayspot's real title/lat/lng straight from there instead, both
 * exact rather than either being a guess. See that function's own
 * comment, and this feature's top-of-section comment (search "Marked
 * Wayspots" above waeRenderMarkerStyleSection()), for the full
 * before/after.
 *
 * v1.51.0 CHANGE FROM v1.50.4 (feature request): adds a "Marked
 * Wayspots" scratch list, separate from the ticket-tracking table the
 * rest of this plugin is built around -- meant for copying into an
 * actual abuse report filed elsewhere, not for tracking tickets already
 * extracted from email. A new "+" icon button on the main panel arms
 * marking mode; while armed, clicking a Wayspot on the mapview/submit
 * map records its name, latitude, longitude and an (initially blank)
 * note into a small persisted list (waeSetMarkModeActive()). A second
 * new icon button opens that list in its own modal
 * (waeOpenMarkedWayspotListModal()), with Copy All (plain-text, one line
 * per entry) and Clear All buttons. Clicking a row's note opens a
 * textarea to edit it; clicking anywhere outside that textarea closes it
 * and saves whatever's in it (waeBuildMarkedWayspotRow()). (Its original
 * name/location capture approach didn't survive first contact with the
 * real page -- see v1.51.1, directly above.)
 *
 * v1.50.4 CHANGE FROM v1.50.3: fixes clicking a cluster whose records
 * all share the same (or near-identical) coordinates -- previously,
 * clicking it just recentered/zoomed to try to split it apart, but
 * records at identical coordinates measure 0px apart at every zoom
 * level, so that zoom could never actually separate them into
 * individually-clickable crosses; once already at the deepest zoom this
 * plugin ever zooms a cluster to, clicking it again just repeated the
 * same no-op zoom forever, leaving every ticket underneath it
 * unreachable. _handleClick() (WaePulseOverlayCtor) now checks whether
 * the map is already at WAE_CLUSTER_MAX_ZOOM (a newly-named constant --
 * previously a bare "20") before zooming again; if it is, it opens an
 * info window (waeShowPulseClusterInfoWindow(), new) listing every
 * record in the cluster by ticket number and Wayspot name instead, so
 * the reports are at least visible/readable even though the map itself
 * still can't give them separate clickable crosses.
 *
 * v1.50.3 CHANGE FROM v1.50.2: fixes the initial render on a fresh page
 * load showing every record as its own individual cross first, then
 * reclustering into groups a moment later. waeComputeClusters() falls
 * back to "every record is its own cluster" whenever the map's
 * projection isn't ready yet -- a deliberate fallback, but one meant for
 * a rare transient hiccup, not the normal state of the very first draw.
 * The three places that draw immediately after first attaching to a map
 * can all run before Google Maps has actually finished setting up that
 * map's projection, which made the fallback the norm on a fresh load
 * rather than the exception. waeSafeRefreshPulses()/
 * waeSafeRefreshReviewPulses() now wait for the map's one-time
 * 'projection_changed' event before drawing at all if the projection
 * isn't ready yet, so the very first thing drawn is already properly
 * clustered. See waeSafeRefreshPulses()'s own comment for why
 * 'projection_changed' specifically, not 'idle'.
 *
 * v1.50.2 CHANGE FROM v1.50.1: fixes mapview/submit crosses/clusters not
 * being clickable at all, even with "Clickable markers" on (its
 * default). Root cause was v1.38.0's own "BUGFIX" (see WaePulseOverlayCtor's
 * comment): it moved the marker div from the overlayMouseTarget pane to
 * overlayLayer to stop crosses from visually covering real Wayspot
 * markers, on the assumption that CSS pointer-events on the div itself
 * would still make it clickable in whatever area wasn't covered by a
 * real marker. Google's own Custom Overlays documentation says
 * otherwise: overlayLayer "may not receive DOM events" at all -- a hard
 * platform restriction, not a CSS one, so nothing about pointer-events
 * could have ever fixed it. WaePulseOverlayCtor now uses two elements
 * per marker: the original div stays in overlayLayer, purely visual
 * from here on (never interactive, whatever the setting says); a second,
 * invisible "hit" div -- same content, same position, created only
 * while a marker is actually meant to be clickable -- lives in
 * overlayMouseTarget (the pane Google's docs confirm does receive DOM
 * events) and is what the click listener is actually attached to now.
 * Review-page markers are unaffected -- they're hardcoded click-through
 * regardless of this setting already (see v1.49.0's own entry), so
 * WaeReviewPulseOverlayCtor never needed a hit div in the first place.
 *
 * v1.50.1 CHANGE FROM v1.50.0: v1.50.0's fix still landed the review
 * toggle bar beside the map instead of under it -- reported back with a
 * screenshot showing it inside what looks like the review card's own
 * side panel. Root cause: v1.50.0 tried to force the map's EXISTING
 * row/grid parent to wrap the bar onto a new line (flex-wrap:wrap +
 * flex-basis:100%, or grid-column:1/-1), which only works if nothing
 * else keeps re-asserting the row/grid's own layout after our styles
 * are applied -- Wayfarer's own layout code (or Angular re-running a
 * template binding) can simply do that, and there's no reliable way
 * from outside to tell whether it will. waePlaceReviewToggle() no
 * longer touches the map's original parent's layout at all: it now
 * moves host into a small wrapper div this plugin fully owns (copying
 * host's own resolved row/grid-placement properties onto the wrapper
 * first, so the wrapper keeps host's original footprint), then stacks
 * host and the bar inside that wrapper with a plain flex column this
 * plugin controls end to end -- so nothing about the site's own layout
 * has any say over whether the two end up on the same line. See
 * waeInjectReviewToggle()'s and waePlaceReviewToggle()'s own comments.
 *
 * v1.50.0 CHANGE FROM v1.49.1: the review-page toggle bar is back to
 * living in the page's own layout instead of floating over it --
 * v1.47.0 had moved it to position:fixed on document.body (recomputing
 * top/left/width from the map's own getBoundingClientRect() every
 * resize/scroll/idle tick) because a plain insertBefore() landed it
 * beside the map on review cards with a flex/grid row (map + photo
 * carousel). That fixed it, but the visible cost was a bar that visibly
 * lagged a frame behind the page during scroll/resize/card transitions
 * -- looking like it was "floating around" rather than part of the UI.
 * waeInjectReviewToggle() now inserts the bar as host's own next DOM
 * sibling again (normal flow, no getBoundingClientRect tracking, no
 * resize/scroll listeners), but waePlaceReviewToggle() checks how that
 * shared parent actually lays out its children first: if it's a flex
 * row, the parent gets flex-wrap:wrap and the bar gets flex-basis:100%,
 * which forces it onto its own full-width line below whatever else is
 * in that row (map + carousel keep sitting side by side above it, per
 * the original ask that it never share a line with anything); if it's
 * a grid, the bar gets grid-column:1/-1 to span every column the same
 * way; otherwise it's already alone on its own line for free, same as
 * v1.43.0's original approach. Position tracking
 * (waePositionReviewToggle(), waeStart/StopReviewTogglePositionTracking())
 * is removed entirely -- nothing to recompute once the bar is back in
 * normal flow. See waeInjectReviewToggle()/waePlaceReviewToggle()'s own
 * comments and the CSS block's for the rest.
 *
 * v1.49.1 CHANGE FROM v1.49.0: search now strips a leading "#" from the
 * query before matching, so "#12345" finds the same reports plain
 * "12345" already did -- conversationId is never stored with a leading
 * "#", so the two used to be genuinely different substrings and
 * "#12345" matched nothing. Worth fixing specifically because Live
 * Wayspot annotation (see the README) shows ticket references on the
 * map itself as "#12345, #67890" -- exactly the format someone reading
 * that off the map would naturally paste into this search box. See
 * waeMatchesQuery()'s own comment.
 *
 * v1.49.0 CHANGE FROM v1.48.0: review-page markers are now always
 * click-through, regardless of the "Clickable markers" setting --
 * WaeReviewPulseOverlayCtor's own setCluster() used to follow that same
 * shared appearance.clickable setting as the mapview/submit crosses
 * (WaePulseOverlayCtor's setCluster()), but a click on the review page
 * is far more likely meant for the actual review UI underneath
 * (selecting a duplicate candidate, etc.) than for this plugin's own
 * popup/cluster-zoom, so this surface now hardcodes _clickable = false
 * rather than reading the setting at all. The mapview/submit crosses are
 * unchanged -- still follow "Clickable markers" normally. Relabeled that
 * checkbox to "Clickable markers (mapview/submit only)" in the Marker
 * Style section so it doesn't read as covering both surfaces anymore.
 *
 * v1.48.0 CHANGE FROM v1.47.0: clicking a cluster badge now jumps
 * straight to zoom 20, on both the mapview/submit crosses and the
 * review-page markers -- replaces the old relative "+3 from wherever the
 * map already was, capped at 21" behavior, which could land back inside
 * another cluster's own pixel radius at low starting zooms (clicking a
 * cluster while zoomed way out, say, only reached zoom 11), making the
 * click look like it hadn't done anything. Only ever zooms IN to reach
 * 20 -- Math.max(), not Math.min() -- so it never zooms back OUT if
 * already deeper than that. See WaePulseOverlayCtor's click handler
 * comment (and the identical one on WaeReviewPulseOverlayCtor) for the
 * full reasoning.
 *
 * v1.47.0 CHANGE FROM v1.46.0: fixes the review-page toggle bar not
 * always landing above the map -- reported in the field (screenshot) as
 * sitting to the LEFT of the map instead, in a card with a photo
 * carousel next to the map. Root cause: v1.43.0's original approach
 * inserted the bar as a normal sibling right before the map element
 * (host.parentElement.insertBefore(bar, host)), which only stacks
 * visually above the map if that parent happens to lay its children out
 * in a column -- on a review card where the map's own immediate parent
 * turned out to be a flex/grid ROW (map + photo side by side), the
 * inserted bar just became another item in that row instead. There's no
 * single assumption about the map's parent's layout that holds across
 * every review card type, so no tweak to insertBefore()'s target would
 * have reliably fixed this for all of them.
 *
 * Fixed by taking the bar out of the review page's own layout entirely:
 * appended straight to document.body and positioned with
 * `position: fixed`, with top/left/width computed in JS from the map's
 * own getBoundingClientRect() (waePositionReviewToggle()) -- recomputed
 * on every map 'idle', on window resize/scroll (capture phase, since a
 * nested scrollable review card's own scroll doesn't bubble to window by
 * default), and as a cheap fallback on every periodic recheck tick. This
 * also brought back a real opaque background/shadow on the bar (briefly
 * dropped in v1.43.1 in favor of plain color-flipped text) -- a floating
 * overlay that can now end up positioned over genuinely arbitrary
 * content needs its own background to stay legible, the same reason any
 * tooltip/HUD element has one; and switched dark-mode detection from a
 * ".dark .wae-review-toggle-bar" descendant selector (v1.43.2's fix for
 * Wayfarer's own in-app dark mode) to a class this script sets directly
 * on the bar from host.closest('.dark') -- the descendant selector
 * depended on the bar still being nested inside whatever ancestor
 * carries that class, which moving it to document.body broke. See
 * waeInjectReviewToggle()'s own comment for the full explanation.
 *
 * v1.46.0 CHANGE FROM v1.45.0: fixes crosses not appearing on first page
 * load -- reported in the field as: nothing shows until the panel is
 * opened AND THEN the map is panned/zoomed, and toggling the "Abuse
 * Report Crosses" layer off/on didn't help either. Root cause:
 * waeAllRecords (the in-memory cache everything actually draws from)
 * used to only ever get populated inside refreshPanel(), itself a no-op
 * unless the tool panel is open -- so on a fresh page load, with the
 * layer already on from a previous session, the map attached with
 * genuinely nothing loaded to draw, and nothing re-populated
 * waeAllRecords afterward except opening the panel, which didn't itself
 * trigger a redraw either (only the next pan/zoom's 'idle' event did,
 * by which point data happened to already be loaded). Toggling the
 * layer hit that same empty cache every time, for the same reason.
 * Fixed with one shared, cached loader, waeEnsureRecordsLoaded() --
 * fired eagerly at startPlugin(), and awaited by every real draw
 * trigger (waeResyncMapIfVisible()'s bootstrap path, waeApplyLayerEnabled()'s
 * toggle-on path, and the review-page map-attach path in
 * waeSetReviewMap()) before that trigger's first draw, so real data is
 * there by the time anything first tries to show it -- whether or not
 * the panel has ever been opened. refreshPanel() also now nudges
 * whichever surface (mapview/submit, review) is currently attached to
 * redraw once it loads fresher data of its own, closing a related gap
 * where opening the panel alone didn't refresh an already-visible map.
 * See waeEnsureRecordsLoaded()'s own comment (right after WAE_REVIEW_PULSES)
 * for the full implementation.
 *
 * v1.45.0 CHANGE FROM v1.44.0: display name shortened from "Abuse Report
 * Extractor" to "Abuse Reports" -- the @name header, the Settings side-
 * panel link text, the main panel's and Marker Style sub-panel's modal
 * titles, the Plugin Manager listing name (PLUGIN_DEFINITION.name's own
 * GM_info fallback), and every console.warn() prefix in this file all
 * changed to match. Cosmetic only -- PLUGIN_ID ('wayfarer-abuse-report-
 * extractor', unchanged) is what WFMM.settings/WFMM.plugins actually key
 * on, so this doesn't reset or orphan any saved settings, Plugin Manager
 * enable/disable state, or Marker Style appearance. Historical changelog
 * entries above that quote the old name (describing what a given past
 * version actually said/did at the time) are left as written, not
 * retroactively renamed.
 *
 * v1.44.0 CHANGE FROM v1.43.2: the companion Abuse Email Importer script
 * is now reached from a small envelope icon right here in this panel's
 * own header row, next to the existing Marker Style cog, instead of
 * having its own separate entry in Base's native Settings side-panel
 * list. Clicking it calls window.WayfarerAbuseEmailImporter.togglePanel()
 * (that script's own v4.10.0 exposes openPanel()/closePanel()/
 * togglePanel()/isPanelOpen() for exactly this) to open ITS panel --
 * still a fully separate script under the hood (it needs
 * GM_xmlhttpRequest for Gmail OAuth, a sandbox-only API this script's
 * own @inject-into page can't use, so the two can't actually be merged
 * into one file), just with one shared entry point now instead of two
 * separate ones a reviewer would have to know to look for individually.
 * If the importer script isn't installed/enabled, the icon logs a plain
 * message saying so instead of silently doing nothing. See
 * buildPanelContent()'s own comment on emailImporterBtn for the full
 * reasoning, and the importer script's own v4.10.0 changelog entry for
 * its side of this change.
 *
 * v1.43.2 CHANGE FROM v1.43.1: fixes the review-page toggle bar being
 * unreadable (dark text on a dark background) with Wayfarer's own dark
 * mode on -- v1.43.1's color-flip keyed off prefers-color-scheme, the
 * OS/browser's own light/dark setting, but Wayfarer's in-app dark mode is
 * a separate, independent toggle (confirmed against Map Mods' own source:
 * every one of Base's own dark-mode-aware styles keys off a ".dark"
 * ancestor class instead, e.g. ".dark .wfmm-contribution-tags-section").
 * The two can disagree -- reported as exactly that: OS in light mode,
 * Wayfarer's own dark mode on, text rendering in the light-mode black
 * against the page's actual dark background. Added plain ".dark
 * .wae-review-toggle-bar" etc. rules (this bar is a DOM descendant of the
 * review page itself, so the same cascade Base's own styles rely on
 * applies here too) -- these now do the real work, with the
 * prefers-color-scheme block kept only as a fallback for no ".dark"
 * ancestor being present at all.
 *
 * v1.43.1 CHANGE FROM v1.43.0: the review-page toggle bar (v1.43.0) no
 * longer sits on its own opaque white/dark plate -- dropped the
 * background/border/shadow entirely and just color-flips plain text via
 * prefers-color-scheme instead (black on light, white on dark), since the
 * filled box read as an odd white slab sitting on the page. The on/off
 * button keeps a plain currentColor outline (black/white to match) and
 * still turns solid green only once it's toggled on.
 *
 * v1.43.0 CHANGE FROM v1.42.0: re-adds review-page (/new/review) support --
 * crosses/clusters now also render on the review page's own map (whichever
 * <nia-map> Angular is currently showing there: the check-duplicates map,
 * the edit-location/edit-info map, etc.), which v1.40.0 fully reverted
 * after its own Settings-side-panel-entry-disappearing bug was never
 * root-caused. This is a from-scratch reimplementation, not a re-apply of
 * the reverted v1.39.x code, and is built to structurally avoid repeating
 * that bug rather than just hoping it doesn't recur: it uses its own
 * completely separate state (WAE_REVIEW_PULSES), its own map-discovery
 * (WFMM.map/WFMM.routes.onEnterMapRoute() never fire for review at all --
 * Map Mods' own ROUTES table marks it hasMap:false -- so this walks
 * <nia-map>'s own Angular __ngContext__ directly instead, the same
 * general technique Map Mods' own bundled review-map-enhancements plugin
 * uses internally), its own lifecycle (WFMM.routes.onEnter('review')/
 * onLeave('review'), not WAE_LAYER_ID/WFMM.layers), and its own on/off
 * toggle -- a small bar injected directly above the review page's map,
 * NOT a checkbox in the Settings side panel. That last point is also a
 * hard requirement, not just an implementation detail: this plugin's
 * tool panel and its Settings-side-panel entry (attachSettingsActions())
 * stay exclusive to the mapview/submit pages and are never touched by
 * any review-page code in either direction, so whatever else does or
 * doesn't go wrong with review support, it structurally cannot be what
 * makes that entry disappear again. See the "Review page support"
 * section (right after waeStopMapTracking()) for the full implementation
 * and its own more detailed reasoning.
 *
 * v1.42.0 CHANGE FROM v1.41.0: crosses/clusters now render at every
 * zoom level, 1 through 21, on every surface -- reported as "no markers
 * show from zoom 1 through 8, they should render up to and including
 * the highest zoom level." waeShouldShowPulses() used to hide them
 * below zoom 8 on the general mapview specifically (matching how the
 * submit-Wayspot page already always showed them regardless of zoom,
 * since v1.33.0); it's now an always-true stub for all surfaces, kept
 * (rather than removing the function and its call site entirely) so
 * the reasoning stays documented in one place if zoom-gating is ever
 * wanted back. Clustering itself is unchanged -- a fully zoomed-out
 * view still collapses nearby reports into one circle with a count
 * rather than showing hundreds of individual markers, this only
 * stopped hiding that circle outright below a fixed zoom.
 * WAE_MIN_SHOW_ZOOM stays as the reference floor for the unrelated
 * "expand cluster size at the lowest zoom" feature (WAE_CLUSTER_EXPAND_FACTOR),
 * which never controlled visibility, only size.
 *
 * v1.41.0 CHANGE FROM v1.40.1: standard Marker Style defaults changed --
 * markerSize/clusterMarkerSize both now 12px (previously 9/10), ring
 * width 1px (previously 2), cluster fill opacity 50% (previously fully
 * opaque). Only affects anyone who's never touched Marker Style
 * settings before -- see WAE_APPEARANCE_DEFAULTS' own comment for why
 * an existing customized value is never overwritten by this.
 *
 * v1.40.1 CHANGE FROM v1.40.0: Marker Style settings no longer have
 * their own entry in the native Settings side-panel list -- a whole
 * separate entry for what's really one small piece of this plugin's
 * own tool panel was more than that one setting needed. Reachable now
 * from a small cog button next to the panel's own summary line
 * (countEl) instead, tucked out of the way until clicked rather than
 * sitting in the panel as a labeled button by default -- same modal,
 * same fields, same live-apply behavior, just one way in instead of
 * two, and that one way lives where the rest of this plugin's own UI
 * does.
 *
 * v1.40.0 CHANGE FROM v1.38.1: reverts ALL review-page (/new/review)
 * support added across v1.39.0-v1.39.4 -- the whole feature, its
 * WFMM.routes.onEnter()/onLeave()-based map discovery, the injected
 * show/hide checkbox, and every touch point it added elsewhere in this
 * file (waeShouldShowPulses(), the overlay's clickable check,
 * waeApplyLayerEnabled(), the WFMM.map.onCleared() handler). Despite
 * several attempted fixes across v1.39.1-v1.39.4 -- reordering
 * startPlugin(), wrapping the review code in try/catch, moving
 * attachSettingsActions() to run first -- the "Abuse Report Extractor"
 * entry disappearing from the Settings side-panel list on every page
 * load was never actually resolved, and continuing to guess at fixes
 * for a diagnosis that was never confirmed wasn't a responsible way to
 * keep going. This restores the file to exactly its v1.38.1 behavior:
 * crosses/clusters render on the general mapview and the submit-Wayspot
 * map only, the same as before the review page was ever attempted.
 * Nothing about map rendering itself (the OverlayView-based Marker
 * replacement from v1.38.0, its stacking-order fix in v1.38.1) is
 * touched -- this is specifically an undo of the review-page work, not
 * a broader rollback.
 *
 * v1.38.1 CHANGE FROM v1.38.0: crosses/clusters now sit BELOW real
 * markers in stacking order (Wayspot/Pok\u00e9stop/Gym/Power Spot markers,
 * WFMM's own submission-pin/draft markers), instead of on top of them.
 * v1.38.0's rewrite placed WaePulseOverlay's divs in the overlayMouseTarget
 * pane, reasoning that "clickable" meant it belonged in the pane meant
 * for mouse events -- but MapPanes' documented stacking order is
 * mapPane < overlayLayer < markerLayer < overlayMouseTarget < floatPane,
 * and overlayMouseTarget sits ABOVE markerLayer, where every real marker
 * actually lives. That meant a cross or cluster could visually cover a
 * real marker underneath it. Moved to overlayLayer (matching WFMM's own
 * pulse-layer.js, which was already there) -- below markerLayer, so real
 * markers stay visually on top and clickable through this layer
 * wherever the two overlap. Explicit pointer-events CSS (unchanged) is
 * what keeps a cross/cluster clickable in the areas no real marker
 * covers it; that doesn't depend on which pane it's in. See
 * waeEnsurePulseOverlayCtor()'s own comment for the full reasoning.
 *
 * v1.38.0 CHANGE FROM v1.37.0: fixes crosses/clusters loading noticeably
 * slower on Firefox than Chrome once a dataset grew into the hundreds.
 * Every marker used to be a real google.maps.Marker with its icon set
 * as a data: URI SVG -- fine on Chrome, but a Marker's .icon is
 * fundamentally an <img>, decoded through the browser's image pipeline,
 * and that pipeline is measurably heavier in Firefox than Chrome for
 * many small repeated data: URIs specifically. Compared against WFMM's
 * own actual source: its directly analogous "Report History" pulse
 * layer (src/plugins/report-history/pulse-layer.js, PulseOverlay) never
 * used Marker for this at all, for exactly this reason -- it positions
 * a plain CSS-styled <div> per point via a custom google.maps.OverlayView
 * subclass, with the shape as real DOM/SVG content rather than an icon
 * image (DOM/SVG rendering doesn't go through image decoding, in either
 * browser). WaePulseOverlay (see waeEnsurePulseOverlayCtor()) is that
 * same pattern, adapted for this plugin's own needs -- clickable, with
 * a cluster-count label, backing a real InfoWindow / recenter-and-zoom,
 * none of which pulse-layer.js's own deliberately non-interactive
 * pulses need. waeGetMarkerIcon()/waeGetClusterIcon() are renamed
 * waeGetMarkerSvgMarkup()/waeGetClusterSvgMarkup() and now return the
 * raw <svg> markup itself (still cached/invalidated the same way as
 * before) instead of a Marker icon descriptor. Also corrects v1.12.0's
 * own reasoning for why Marker was chosen over OverlayView in the first
 * place -- see the "Map plotting" section comment above
 * waeEnsurePulseOverlayCtor() for the full explanation; the short
 * version is that the per-frame-repositioning concern it raised was
 * never actually the bottleneck; the icon-decode cost was.
 *
 * Everything else -- clustering, the diffing loop in waeRefreshPulses(),
 * waeClearPulses(), click behavior, Marker Style settings (still applies
 * live, still the same fields) -- is unchanged; OverlayView instances
 * support the same .setMap(map)/.setMap(null) calls a Marker does, so
 * none of the surrounding code needed to change to accommodate this.
 *
 * v1.37.0 CHANGE FROM v1.36.0: better-integration pass, part 2 --
 * Marker Style's appearance settings and the "close panel on navigate"
 * toggle now live in WFMM.settings (registered under this plugin's own
 * id in startPlugin(), see WAE_SETTINGS_DEFAULTS) instead of two raw
 * localStorage keys (wae_marker_appearance/wae_autoclose_on_navigate).
 * Same reasoning as the settings-link fix in v1.35.0: this is the same
 * registry bundled plugins use, and it's what feeds WFMM's own Settings
 * > Backups export/import -- neither setting was included in a backup
 * before this. Existing values migrate automatically the first time
 * this version runs (old keys are read once and removed); nothing to
 * do manually. WAE_MAP_VISIBLE_KEY is untouched -- it was already a
 * one-time seed straight into WFMM.layers.register(), not an ongoing
 * raw-storage dependency, so there was nothing left to migrate there.
 *
 * v1.36.0 CHANGE FROM v1.35.1: cluster ("heatmap") marker size is now
 * decoupled from the single-report cross marker size, with its own
 * "Cluster size" control in Marker Style settings -- previously
 * waeGetClusterIcon() just multiplied the cross's markerSize by a fixed
 * 1.15, so the two could never be sized independently. New
 * WAE_APPEARANCE_DEFAULTS.clusterMarkerSize field, defaulted to 10 (==
 * 9 * 1.15, rounded) so anyone with an already-customized cross size
 * sees no visual change until they touch the new control themselves.
 *
 * Also: cluster markers now render visibly bigger (WAE_CLUSTER_EXPAND_
 * FACTOR, 1.5x) specifically at the lowest zoom level they're shown at
 * (WAE_MIN_SHOW_ZOOM, now a named constant instead of a bare "8" in
 * waeShouldShowPulses()) -- at that floor zoom a cluster represents far
 * more ground (and often far more reports) per pixel than it does once
 * you're zoomed in, so the same fixed size under-emphasized exactly the
 * view where it matters most. waeGetClusterIcon() now caches two
 * variants (normal/expanded) rather than one, and waeRefreshPulses()
 * picks whichever the current (floor()'d, to avoid flicker across
 * fractional zoom) zoom level calls for.
 *
 * v1.35.1 CHANGE FROM v1.35.0: fixes crosses sometimes not appearing
 * when the map first opens, only showing up once you click an abuse
 * report (which recenters/zooms the map). Root cause: v1.34.1 added
 * try/catch + a retry to waeRefreshPulses()'s debounced 'idle' caller,
 * but every OTHER caller -- the initial WFMM.map.onReady() render,
 * waeResyncMapIfVisible() at bootstrap, waeApplyLayerEnabled()'s
 * toggle-on path, and a live appearance-color redraw -- still called it
 * raw. Those load-time callers run at precisely the moment the map's
 * projection/bounds are least likely to be fully settled, so a
 * transient throw there had no retry and nothing else would re-render
 * until an actual map interaction (pan/zoom) fired 'idle' and landed on
 * the one already-protected path -- e.g. clicking a report. The retry
 * logic is now one shared waeSafeRefreshPulses() helper, and every
 * caller (the idle handler included) goes through it, so all of them
 * get the same resilience.
 *
 * v1.35.0 CHANGE FROM v1.34.4: Marker Style settings (color, size,
 * opacity, ring, clickable) moved out of the bottom of the main
 * "Extract Wayspots" tool panel into their own modal, reachable from a
 * new "Abuse Report Extractor - Marker Style" entry in the native
 * Settings side-panel list, alongside the existing "Abuse Report
 * Extractor" entry that still opens the main tool panel. See
 * waeRenderMarkerStyleSection()'s own comment for why a literal new tab
 * inside WFMM's own native Settings window (Markers/Map/Planner/...)
 * isn't something a plugin outside the suite's own bundle can add
 * (confirmed against Base's own settings-hub source: a frozen list of
 * sections, each one hardcoded by bundled-plugin id) and why
 * WFMM.sidePanel.appendSettingsAction() -- what Planner's own settings
 * link relies on too, once you look past its extra settings-hub
 * shortcut -- is the actual public mechanism this uses instead.
 *
 * Also replaces the settings-link insertion itself: it used to hand-
 * roll a whole-document MutationObserver watching for
 * ".wfmapmods-settings-links" to exist (copied from Report Wayspots
 * v3.3.0's own approach, bug included -- see the removed comment this
 * replaced). Now uses WFMM.sidePanel.appendSettingsAction() directly,
 * with WFMM.sidePanel.onReady()/onCleared() (already relied on
 * elsewhere in this file, for the ticket-annotation feature) re-adding
 * both links whenever the side panel is actually rebuilt, rather than
 * polling the entire document tree for it.
 *
 * v1.34.4 CHANGE FROM v1.34.3: Export CSV no longer repeats the raw
 * per-ticket text (Issue Type / Location Details / Report Details) on
 * every Wayspot row a ticket reported -- it's now written once, on the
 * first row for that ticket, and left blank on the rest of that
 * ticket's rows. That text was already stored just once per ticket at
 * rest (the ticketDetails store, since v1.21.0); getAllExtractedRecords()
 * hydrates it back onto every location row for in-memory use (table,
 * search, nearby-duplicate detection all still rely on that), and CSV
 * export used to just take those fully-hydrated rows as-is -- so a
 * 12-location ticket's export repeated the same raw text 12 times. See
 * waeDedupeTicketLevelColumnsForExport()'s own comment for the full
 * reasoning, including why conversationId/ticketStatus/lastResponseAt
 * deliberately stay on every row (short, and needed to tell which
 * ticket a blanked-out row belongs to) and why Comment isn't touched
 * (it's genuinely per-location, not per-ticket).
 *
 * v1.34.3 CHANGE FROM v1.34.2: the "Import CSV" format hint above the
 * button now shows its example as an actual two-line CSV (header row,
 * then a data row below it) instead of one run-on sentence joining them
 * with "then". .wae-csv-hint gets white-space:pre-line so the \n in the
 * hint text actually breaks the line rather than collapsing like normal
 * HTML whitespace. Purely cosmetic -- waeParseCsvImport() itself is
 * unchanged, still just needs a Latitude/Longitude header somewhere in
 * the first row.
 *
 * v1.34.2 CHANGE FROM v1.34.1: fixes crosses reappearing on their own
 * after turning the "Abuse Report Crosses" layer off and then just
 * scrolling through zoom levels -- no re-enabling involved.
 * waeRefreshPulses() never actually checked isMapPulsesEnabled(); it
 * only checked that a map existed and that waeShouldShowPulses()
 * (zoom/surface) allowed showing something. waeApplyLayerEnabled(false)
 * clears the markers once, at the moment of the toggle, but the
 * debounced 'idle' listener stays attached to the map for its whole
 * lifetime (see waeSetCurrentMap()) and keeps firing on every zoom/pan
 * regardless -- so the very next one silently rebuilt every marker with
 * no awareness the layer had been switched off, undoing the toggle.
 * waeRefreshPulses() now bails out (clearing anything that snuck back
 * before this existed) whenever the layer is off, so every automatic
 * refresh actually respects the current on/off state rather than only
 * the single clear that runs at toggle time.
 *
 * v1.34.1 CHANGE FROM v1.34.0: fixes crosses vanishing on a zoom change
 * and not coming back until the "Abuse Report Crosses" Layers checkbox
 * is toggled off and back on. Root cause: the debounced 'idle' listener
 * in waeSetCurrentMap() is the only thing that keeps the crosses synced
 * with the map after the initial attach (confirmed against WFMM.map's
 * own source: its refresh() fast path doesn't re-emit "map:ready" for a
 * map that's still valid, so nothing else re-fires on an ordinary zoom),
 * and neither it nor waeRefreshPulses()/waeComputeClusters() had any
 * error handling. A transient non-finite projected point right as a
 * zoom gesture settled (see waeComputeClusters()'s own comment) could
 * throw partway through a render -- after old markers were already
 * cleared but before new ones went up -- with no other automatic path
 * left to retry it. Three changes: waeComputeClusters() now drops a
 * record whose projected point isn't finite instead of letting it
 * corrupt a cluster; waeRefreshPulses()'s per-cluster marker
 * create/update is now individually try/caught so one bad cluster can't
 * take the rest of the redraw down with it; and the 'idle' handler
 * itself now catches a failure and retries once, shortly after, rather
 * than leaving the layer empty until another map interaction happens to
 * come along.
 *
 * v1.34.0 CHANGE FROM v1.33.0: adds "Import CSV" -- for locations that
 * didn't come from a scanned email at all (a known problem spot from
 * another source, something to track manually), not another export from
 * this same tool. Deliberately forgiving: only Latitude/Longitude are
 * required (matched case-insensitively against a few common spellings --
 * "Lat"/"Latitude", "Lng"/"Long"/"Longitude" -- not one fixed header),
 * every other column (Name/Comment/Conversation ID) is optional. A format
 * hint with a one-line example is always shown above the button, not
 * just after a failed attempt. Imported rows show up in the table/map
 * like any other (Status "Imported", a distinct purple badge -- see
 * WAE_STATUS_BADGES' own CSV_IMPORT entry) and are explicitly carried
 * forward across a re-scan (which otherwise fully rebuilds the extracted-
 * records store from scratch -- see the scan handler's own long-standing
 * comment) and called out by name in the "Clear Extracted Data" confirm
 * dialog, since -- unlike scanned data -- there's no email to re-derive a
 * CSV-imported row from if either of those wipes it. Verified the parser
 * itself (quoted fields with embedded commas, a bare lat/lng-only file,
 * mixed valid/invalid rows, a missing-columns file, no trailing newline)
 * against the exact example text shown in the hint before shipping this.
 *
 * v1.33.0 CHANGE FROM v1.32.2: removes this plugin's own "Show on Map"/
 * "Hide from Map" button entirely -- purely redundant once v1.32.0
 * registered the same on/off state as a real WFMM.layers entry with its
 * own native checkbox in the suite's own Layers menu. Verified the whole
 * mechanism end to end against the real source while doing this (not
 * just the parts this plugin owns): register() itself does NOT invoke
 * onChange on registration, only setEnabled() does when the state
 * actually changes -- confirming waeResyncMapIfVisible() (called right
 * after register() in startPlugin()) is what actually applies a
 * restored/default "on" state on page load, not something left over and
 * now redundant. The native Layers menu's own checkbox is wired to
 * WFMM.layers.setEnabled() on change and rebuilds its whole list fresh
 * every time it's opened (confirmed against src/plugins/map-ui/
 * layers-menu.js), so it correctly reflects this plugin's layer being
 * unregistered in stopPlugin() too, even though that specific event
 * isn't one the menu subscribes to directly for a live in-place refresh
 * -- reopening it shows the correct list regardless. No functional gap
 * found; this version is a pure removal plus comment cleanup for
 * everything that referenced the now-gone button/click handler.
 *
 * v1.32.2 CHANGE FROM v1.32.1: centers the ticket-number line in the
 * Wayspot details side panel (see v1.30.0) -- was left-aligned, matching
 * the metadata lines around it; now centered instead.
 *
 * v1.32.1 CHANGE FROM v1.32.0: fixes sorting by star not being possible
 * -- the star column's header label was '' (correctly copied from the
 * Comment/Nearby icon columns, which are NOT sortable), but combined
 * with sortable: true, table()'s own header-building code rendered a
 * real, clickable sort button with genuinely no visible text -- it
 * technically worked, there was just nothing to see or reliably click.
 * The header label is now a literal \u2605, giving it something visible
 * (and self-explanatory) to click, same as every other sortable column.
 *
 * v1.32.0 CHANGE FROM v1.31.0: registers the abuse-cross markers as a
 * real WFMM.layers entry ("Abuse Report Crosses") instead of only being
 * toggleable from this plugin's own "Show on Map" button -- confirmed
 * against the real source that the suite's native Layers menu (the
 * stacked-squares icon next to the map's search bar) just iterates
 * WFMM.layers.list() and builds a plain checkbox per entry, so
 * registering is the whole integration; nothing else needed for it to
 * show up there with a working toggle. WFMM.layers (backed by WFMM's own
 * settings persistence) is now the single source of truth for on/off --
 * the old standalone localStorage flag (WAE_MAP_VISIBLE_KEY) is only
 * read once, as the starting default for whoever upgrades into this
 * version with it already set, never written to again. The "Show on Map"
 * button still works exactly as before, it just flips the same shared
 * flag now, so toggling from the button or from the native Layers menu
 * can never drift out of sync with each other.
 *
 * v1.31.0 CHANGE FROM v1.30.0: adds a star/favorite toggle to the table,
 * matching Report History's own \u2605/\u2606 button (confirmed against
 * the real source -- it's called "Star" there, not "Favorite", flagged
 * per-record with a boolean field, no separate favorites list). Click the
 * star cell to toggle; sortable like the other columns (ascending shows
 * starred first, matching Report History's own "Starred first" wording
 * for the same sort), included in the CSV export, and -- since a scan
 * fully rebuilds the extracted-records store from the source emails every
 * time rather than upserting (see the scan handler's own long-standing
 * "Rebuild from scratch" comment) -- explicitly carried forward across a
 * re-scan by matching ticket+coordinates (not the row's own `id`, which
 * isn't reliably stable across scans either -- see waeStarredKey()'s own
 * comment), so re-scanning doesn't silently un-star everything the way a
 * naive rebuild would have.
 *
 * v1.30.0 CHANGE FROM v1.29.4: adds a live-Wayspot ticket annotation --
 * clicking a Wayspot on the map now shows "#<ticket>" just above the
 * LIVE/status badge row in its side-panel details card, for any Wayspot
 * within WAE_NEARBY_THRESHOLD_METERS of one of this plugin's own
 * extracted locations. See waeStartSidePanelDetailsWatcher()'s own
 * comment (right above it) for the full mechanism -- found after
 * confirming there's no hook into Wayfarer's truly-native popup
 * rendering, but WFMM.sidePanel (real, public, confirmed against
 * src/core/side-panel.js -- the same service Base's own code uses to
 * build that exact card) turned out to expose enough to append into the
 * ALREADY-rendered card without needing one. Multiple matching tickets
 * show comma-separated; no match means nothing gets added, same
 * appearance as before this version everywhere else.
 *
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

  // Same grid (WAE_GRID_DEG/waeGridKey, just above) waeFindNearbyDuplicates()
  // already indexes waeAllRecords with -- reused here rather than a second
  // grid built from scratch, since the cell math (threshold, cell size) is
  // identical either way. A DIFFERENT index from that function's own,
  // though, not its result: waeFindNearbyDuplicates() deliberately excludes
  // a record's own ticket (it's answering "does this ticket duplicate a
  // DIFFERENT one?"), while waeFindMatchingTicketNumbers() below answers
  // "what ticket(s), if any, already cover this exact Wayspot?" -- self-
  // matches are exactly what it wants, so the two can't share one result.
  //
  // BUGFIX (not upstream): this index used to not exist at all --
  // waeFindMatchingTicketNumbers() did a plain, unindexed linear scan
  // (with a Haversine check) over every single record in waeAllRecords,
  // run again from scratch on every single Wayspot click (see
  // waeStartSidePanelDetailsWatcher(), the only caller). Fine at a few
  // hundred extracted tickets; increasingly not once that count climbs
  // into the thousands, since this plugin's whole purpose is accumulating
  // exactly that over time. Rebuilt only when waeAllRecords itself is
  // reassigned (waeTicketIndexFor !== waeAllRecords) -- comparing the
  // array by reference rather than diffing its contents, same
  // cache-invalidation idiom already used for waeFilteredSortedCacheFor/
  // waeStatsCacheFor elsewhere in this file, safe because every place
  // that actually changes what's extracted (see those two variables' own
  // comments) always assigns waeAllRecords a fresh array rather than
  // mutating the existing one in place.
  let waeTicketIndexFor = null;
  let waeTicketIndexBuckets = null;
  function waeGetTicketIndexBuckets() {
    if (waeTicketIndexFor === waeAllRecords) return waeTicketIndexBuckets;
    const buckets = new Map();
    for (const r of waeAllRecords) {
      if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
      const key = waeGridKey(r.latitude, r.longitude);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = []; buckets.set(key, bucket); }
      bucket.push(r);
    }
    waeTicketIndexBuckets = buckets;
    waeTicketIndexFor = waeAllRecords;
    return buckets;
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
  // Map plotting -- extracted locations as a custom google.maps.OverlayView
  // subclass (WaePulseOverlay, see waeEnsurePulseOverlayCtor() further
  // down), NOT native google.maps.Marker objects, as of v1.38.0.
  //
  // v1.12.0's own note here (kept for the record, since the reasoning in
  // it turned out to be the wrong half of the story) argued the opposite:
  // that a custom OverlayView forces a JS-driven DOM reposition on every
  // drag frame while native Markers are repositioned by the Maps SDK
  // itself with "no per-frame JS callback involved." That's not actually
  // true -- Marker's own positioning is internally driven by the exact
  // same projection/frame-update mechanism an OverlayView's draw()
  // subscribes to; there's no callback-free "native" path, just one
  // hidden from userland instead of one written in this file. What
  // v1.12.0 was actually seeing (or anticipating) was never confirmed
  // against a real reposition-cost measurement either way.
  //
  // What v1.38.0 DID confirm, reported as "loads fine on Chrome, slow on
  // Firefox" once a dataset grew into the hundreds: a Marker's .icon is
  // fundamentally an <img>, decoded through the browser's image
  // pipeline -- and that pipeline is measurably heavier in Firefox than
  // Chrome for many small, repeated data: URIs specifically, independent
  // of anything about per-frame positioning. WFMM's own directly
  // analogous "Report History" pulse layer (pulse-layer.js) never used
  // Marker at all, for exactly this reason: it's always been a plain
  // CSS-styled <div> positioned by a custom OverlayView, with the shape
  // as real DOM content rather than an icon image. WaePulseOverlay is
  // that same pattern, adapted for this plugin's own needs (clickable,
  // with a cluster-count label) -- see its own comment for the rest.
  //
  // Own icon/color so this doesn't read as the same layer as Report
  // Wayspots' own reported-wayspot history markers -- this shows
  // *extracted* reports, not Report Wayspots' own submission history, and
  // doesn't require that script to be installed at all. Clickable --
  // with dozens of nearby entries otherwise looking identical, a click
  // naming which ticket a marker belongs to earns its keep here.
  // ---------------------------------------------------------------------

  // BUGFIX (not upstream): only kept now for its OLD saved value, read
  // once at registration time (see startPlugin()) as the starting
  // default for WAE_LAYER_ID the first time this version ever runs for a
  // given user -- WFMM.layers itself is the actual source of truth for
  // on/off going forward (see isMapPulsesEnabled()'s own comment for the
  // full explanation), not this key. Never written to again after this
  // version; left in place rather than deleted since there's no harm in
  // an unused old key sitting in localStorage.
  const WAE_MAP_VISIBLE_KEY = 'wae_map_pulses_visible';
  const WAE_LAYER_ID = 'wae-abuse-crosses';
  // Whether clicking a table row (waeGoToLocation()) closes this panel as
  // part of jumping the map to that location. Defaults to on (matches
  // every version before this setting existed) -- since the panel is a
  // full-screen backdrop, leaving it open would mean the map you just
  // navigated to stays hidden behind it, which is why that was the only
  // behavior originally. Some people would rather keep the panel open
  // (e.g. clicking through several rows in a row to compare locations)
  // and re-open it themselves when they're done looking, hence this
  // being a real setting rather than the one hardcoded behavior.
  //
  // BUGFIX (not upstream, better-integration pass): used to be its own
  // raw localStorage flag (wae_autoclose_on_navigate) -- moved into
  // WFMM.settings (see startPlugin(), which registers WAE_SETTINGS_DEFAULTS
  // under this plugin's own id and migrates whatever was in the old keys
  // the first time this runs) alongside Marker Style's appearance
  // settings just below, for the same reason: WFMM's own Settings >
  // Backups export/import only sees what's registered there.
  function waeAutoCloseOnNavigateEnabled() {
    return wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'autoCloseOnNavigate', true) !== false;
  }
  const WAE_PULSES = { map: null, surface: null, markersById: new Map(), infoWindow: null };

  // Review page (/new/review) crosses -- deliberately a WHOLE SEPARATE
  // state object/overlay class/toggle from WAE_PULSES above, not a third
  // surface folded into it. Two reasons: (1) WFMM.map/WFMM.routes'
  // onEnterMapRoute/onChangeMapRoute -- everything WAE_PULSES' lifecycle
  // runs on -- never fire for the review route at all (see ROUTES in the
  // Map Mods source: the "review" entry is hasMap:false, "WFMM does not
  // currently interact with the review duplicates map"), so this can't
  // piggyback on that tracking and needs its own map-discovery entirely;
  // (2) the requirement this exists to satisfy is that the Settings
  // side-panel entry and this plugin's own tool panel stay exclusive to
  // the mapview/submit pages and never appear on review -- easiest to
  // guarantee by never letting review-page code touch WAE_LAYER_ID,
  // WFMM.layers, or attachSettingsActions() at all, in either direction.
  // See the "Review page support" section (right after waeStopMapTracking())
  // for the map-discovery/toggle/refresh logic itself.
  const WAE_REVIEW_PULSES = { map: null, host: null, markersById: new Map(), infoWindow: null };
  let waeAllRecords = [];
  let waeRecordsById = new Map();
  // BUGFIX (not upstream, feature request): waeAllRecords used to only
  // ever get populated inside refreshPanel(), which is itself a no-op
  // unless the tool panel is open -- meaning on a fresh page load, with
  // "Abuse Report Crosses" already on from a previous session, the map
  // attached with zero records to draw and nothing ever re-populated
  // waeAllRecords afterward except opening the panel (which didn't
  // itself trigger a redraw either -- only the *next* pan/zoom's 'idle'
  // event did, once data happened to already be loaded by then). Net
  // effect, reported in the field: markers missing on first load, only
  // appearing after opening the panel AND THEN zooming -- and toggling
  // the layer off/on didn't help either, since that path hit the exact
  // same empty waeAllRecords. waeEnsureRecordsLoaded() below is the fix:
  // a single shared, cached load callers can await before any redraw,
  // so the data is actually there by the time anything first tries to
  // draw from it, whether or not the panel has ever been opened. See
  // its own comment just below.
  let waeRecordsLoadPromise = null;

  // Loads waeAllRecords/waeRecordsById from storage if nothing has
  // loaded them yet THIS session, and caches the in-flight promise so
  // concurrent callers (bootstrap, a layer toggle-on, the review map
  // attaching, the panel opening) all await the same one IndexedDB read
  // rather than racing separate ones. Deliberately a one-time-per-session
  // cache, not a "read fresh every time" -- callers that need genuinely
  // up-to-date data after a real change (refreshPanel(), and the scan/
  // import/clear handlers it's called from) still call
  // getAllExtractedRecords() directly and assign waeAllRecords themselves,
  // exactly as before; this function only exists to guarantee SOMETHING
  // has loaded at least once before the very first draw attempt.
  function waeEnsureRecordsLoaded() {
    if (!waeRecordsLoadPromise) {
      waeRecordsLoadPromise = getAllExtractedRecords()
        .then((records) => {
          waeAllRecords = records;
          waeRecordsById = new Map(records.map((r) => [r.id, r]));
          return records;
        })
        .catch((e) => {
          waeRecordsLoadPromise = null; // don't cache a failure -- let the next caller retry the read
          throw e;
        });
    }
    return waeRecordsLoadPromise;
  }
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
  const WAE_SORTABLE_KEYS = ['starred', 'conversation', 'status', 'lastResponse'];
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
  const WAE_APPEARANCE_DEFAULTS = Object.freeze({
    // BUGFIX (not upstream, feature request): standard defaults as of
    // v1.41.0 -- markerSize/clusterMarkerSize both 12px (previously 9/10
    // respectively -- see clusterMarkerSize's own comment for why they
    // used to differ at all), borderWidth 1px (previously 2), fillOpacity
    // 0.5 (previously 1, fully opaque). fillOpacity/borderWidth only
    // ever render on the cluster circle -- a single-report X marker has
    // no fill region or ring to apply them to (see waeGetMarkerSvgMarkup()'s
    // own comment) -- so in practice this reads as "cluster circles are
    // now half-opacity with a thinner ring," with both marker types
    // sized the same. Only takes effect for anyone who hasn't customized
    // these already -- WFMM.settings.registerPlugin() (see startPlugin())
    // only ever fills in values that aren't already saved, so an
    // existing customized value here is left exactly as that person set
    // it.
    markerSize: 12,
    clusterMarkerSize: 12,
    fillColor: '#dc2626',
    fillOpacity: 0.5,
    borderColor: '#ffffff',
    borderWidth: 1,
    borderOpacity: 1,
    clickable: true,
    // Feature request: color for the separate Marked Wayspots dots (see
    // waeRenderMarkedWayspotMarkers()) -- blue by default, deliberately
    // distinct from fillColor's own red-ish default above so the two
    // marker types (abuse-report crosses/clusters vs. this plugin's own
    // scratch-list dots) stay visually distinguishable even before
    // anyone customizes either one.
    markColor: '#2563eb',
  });
  // Combined with autoCloseOnNavigate (see waeAutoCloseOnNavigateEnabled()
  // above) under one WFMM.settings.registerPlugin() call in startPlugin()
  // -- everything this plugin persists as a genuine user preference (as
  // opposed to sync/bookkeeping state) lives under these two keys now.
  const WAE_SETTINGS_DEFAULTS = Object.freeze({
    appearance: WAE_APPEARANCE_DEFAULTS,
    autoCloseOnNavigate: true,
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
      clusterMarkerSize: waeClampNumber(a.clusterMarkerSize, 4, 24, WAE_APPEARANCE_DEFAULTS.clusterMarkerSize),
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
      // than as a separate WFMM.settings key.
      clickable: typeof a.clickable === 'boolean' ? a.clickable : WAE_APPEARANCE_DEFAULTS.clickable,
      markColor: waeNormalizeHexColor(a.markColor, WAE_APPEARANCE_DEFAULTS.markColor),
    };
  }
  // BUGFIX (not upstream, better-integration pass): used to be its own
  // raw localStorage key (wae_marker_appearance) -- moved into
  // WFMM.settings, same registry (and same reasoning: WFMM's own
  // Settings > Backups export/import) as waeAutoCloseOnNavigateEnabled()
  // just above. See WAE_SETTINGS_DEFAULTS and startPlugin(), which
  // registers it and migrates whatever was in the old keys the first
  // time this runs.
  function waeLoadAppearance() {
    return waeNormalizeAppearance(wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'appearance', WAE_APPEARANCE_DEFAULTS));
  }
  function waeSaveAppearance(appearance) {
    wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'appearance', appearance);
    // Cached SVG icons (WAE_MARKER_ICON/WAE_CLUSTER_ICON, see below) are
    // built from these values -- stale otherwise until the next full page
    // load.
    WAE_MARKER_ICON = null;
    WAE_CLUSTER_ICON.normal = null;
    WAE_CLUSTER_ICON.expanded = null;
    // Only live-redraw if pulses are actually already visible -- editing
    // colors shouldn't be what makes the map attach/show pulses if the
    // user never turned "Show on Map" on.
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
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
  //
  // BUGFIX (not upstream, feature request): a query starting with "#"
  // used to fail to match anything, even for a ticket number that
  // otherwise matches fine on its own -- conversationId itself is never
  // stored with a leading "#", so "#12345".includes(...) against a
  // haystack containing plain "12345" is a real substring mismatch, not
  // a false positive being avoided. This matters in practice because the
  // Live Wayspot annotation feature (see the README) shows ticket
  // references on the map itself as "#12345, #67890" -- the exact format
  // someone reading that off the map and pasting into this search box
  // would naturally type. Stripped here (leading "#"s only -- there's no
  // legitimate reason a real query would start with one otherwise) so
  // "#12345" and "12345" search identically.
  function waeMatchesQuery(r, q) {
    if (!q) return true;
    if (!r._waeHaystack) {
      r._waeHaystack = [
        r.wayspotName, r.conversationId, r.comment, r.issueType,
        r.locationDetails, r.reportDetails, r.sourceFilename, r.sourceEmailId,
        waeStatusLabel(r.ticketStatus),
      ].filter(Boolean).join('\n').toLowerCase();
    }
    return r._waeHaystack.includes(q.replace(/^#+/, ''));
  }
  // Built lazily and cached -- same icon object reused for every marker
  // instead of rebuilt per-call. Invalidated (set back to null) by
  // waeSaveAppearance() whenever the user changes a marker-style setting.
  // BUGFIX (not upstream): these two used to build a Marker "icon"
  // descriptor ({url: 'data:image/svg+xml,...', scaledSize, anchor}) --
  // see STYLE's own .wae-pulse-marker comment for why that's the actual
  // source of the Chrome-vs-Firefox gap this was rewritten to fix. Now
  // return the raw <svg>...</svg> markup itself (still cached exactly
  // the same way, still invalidated by waeSaveAppearance() the same way)
  // for WaePulseOverlay to drop straight into a div's innerHTML instead.
  let WAE_MARKER_ICON = null;
  function waeGetMarkerSvgMarkup() {
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
    WAE_MARKER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<line x1="${half - arm}" y1="${half - arm}" x2="${half + arm}" y2="${half + arm}" stroke="${a.fillColor}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + `<line x1="${half + arm}" y1="${half - arm}" x2="${half - arm}" y2="${half + arm}" stroke="${a.fillColor}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + '</svg>';
    return WAE_MARKER_ICON;
  }

  // Same color as the single-report marker, just as a filled circle
  // (matching WFMM's own "generic" POI marker shape) with room for a
  // count label -- reads as "many of the same thing" rather than a
  // different kind of marker. Every field here (fillColor/fillOpacity/
  // borderColor/borderWidth/borderOpacity/clusterMarkerSize) is user-
  // configurable through the Marker Style section.
  //
  // Two cached variants, not one -- see WAE_CLUSTER_EXPAND_ZOOM/
  // WAE_CLUSTER_EXPAND_FACTOR just below for why: at the lowest zoom
  // level these still show at, a cluster typically represents FAR more
  // ground (and often far more reports) per pixel than it does once
  // you're zoomed in, so the same fixed size reads as under-emphasized
  // right when it matters most. Rendering it visibly bigger specifically
  // at that floor zoom -- rather than one size for every zoom -- makes a
  // wide-area glance actually draw the eye to where reports are
  // concentrated, without changing anything about how it looks once
  // you've zoomed in past that floor.
  const WAE_CLUSTER_EXPAND_FACTOR = 1.5;
  let WAE_CLUSTER_ICON = { normal: null, expanded: null };
  function waeGetClusterSvgMarkup(expanded) {
    const cacheKey = expanded ? 'expanded' : 'normal';
    if (WAE_CLUSTER_ICON[cacheKey]) return WAE_CLUSTER_ICON[cacheKey];
    const a = waeLoadAppearance();
    const r = a.clusterMarkerSize * (expanded ? WAE_CLUSTER_EXPAND_FACTOR : 1);
    const size = (r + a.borderWidth) * 2;
    const c = size / 2;
    WAE_CLUSTER_ICON[cacheKey] = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<circle cx="${c}" cy="${c}" r="${r}" fill="${a.fillColor}" fill-opacity="${a.fillOpacity}" stroke="${a.borderColor}" stroke-width="${a.borderWidth}" stroke-opacity="${a.borderOpacity}"/>`
      + '</svg>';
    return WAE_CLUSTER_ICON[cacheKey];
  }

  // ---------------------------------------------------------------------
  // BUGFIX (not upstream): every single-report and cluster marker used
  // to be a real google.maps.Marker, with the SVG above wrapped as a
  // data: URI and handed in as its .icon -- reported as noticeably
  // slower to load on Firefox than Chrome once a dataset grew into the
  // hundreds, and confirmed (against WFMM's own actual source) to be
  // the same class of problem the suite's own directly-analogous
  // "Report History" pulse layer (pulse-layer.js, PulseOverlay) already
  // avoids on purpose: a Marker's icon renders through the browser's
  // IMAGE decode pipeline (it's fundamentally an <img>), and that
  // pipeline is measurably heavier in Firefox than Chrome for many
  // small, repeated data: URIs specifically -- worse the more markers
  // there are, which is exactly when it'd matter most. WFMM's own pulse
  // layer sidesteps this entirely by never using Marker's icon at all:
  // each point is a plain <div>, styled with real CSS/DOM content,
  // positioned by a custom google.maps.OverlayView subclass instead.
  //
  // WaePulseOverlay below is that same pattern, adapted for this
  // plugin's needs -- clickable, with a cluster-count label, backing a
  // real InfoWindow / recenter-and-zoom on click, none of which
  // pulse-layer.js's own deliberately non-interactive pulses need. The
  // SVG markup from waeGetMarkerSvgMarkup()/waeGetClusterSvgMarkup()
  // above is inserted as real innerHTML now, not a data: URI -- that's
  // the actual fix: DOM/SVG rendering doesn't go through image decoding
  // at all, in either browser.
  //
  // BUGFIX (not upstream): the VISIBLE div lives in the overlayLayer
  // pane (matching pulse-layer.js's own choice), not overlayMouseTarget
  // -- v1.38.0 originally used overlayMouseTarget, which put every
  // cross/cluster visually ABOVE real markers (MapPanes' documented
  // stacking order is mapPane < overlayLayer < markerLayer <
  // overlayMouseTarget < floatPane -- native Wayspot/Pok\u00e9stop/Gym/
  // Power Spot markers, and WFMM's own submission-pin/draft markers,
  // live in markerLayer, below overlayMouseTarget), capable of covering
  // them -- the opposite of the layering a "where are there abuse
  // reports" overlay should have relative to the markers actually being
  // reported on. overlayLayer sits below markerLayer, so real markers
  // now stay visually on top.
  //
  // BUGFIX (not upstream), v1.50.2: that move to overlayLayer was
  // believed to keep the div clickable in its own uncovered area (CSS
  // pointer-events on a specific element overrides an ancestor pane's
  // own default, so the reasoning went) -- reported back as simply not
  // clickable ANYWHERE, not just narrowed to uncovered area, and
  // Google's own Custom Overlays documentation confirms why: overlayLayer
  // "may not receive DOM events" at all, a hard platform restriction
  // with nothing CSS can override, unlike overlayMouseTarget, which
  // explicitly "contains elements that receive DOM events." No single
  // pane is both "receives clicks" and "paints below markerLayer," so
  // this now uses two elements per marker instead of one: the ORIGINAL
  // visible div stays in overlayLayer, purely cosmetic now (never
  // interactive, whatever appearance.clickable says); a second,
  // invisible "hit" div -- same SVG content, same draw() position, only
  // ever created while appearance.clickable is on -- lives in
  // overlayMouseTarget and is what the click listener actually attaches
  // to. Invisible (opacity:0 in CSS, not visibility/display, so it
  // still receives events) rather than removed-but-present, so it never
  // changes what's on screen; visually indistinguishable from a single
  // div that was simply clickable, while still painting below real
  // markers the way the visible div does.
  //
  // Everything OUTSIDE this class -- the diffing loop in
  // waeRefreshPulses(), waeClearPulses(), the WAE_PULSES.markersById Map
  // itself -- is UNCHANGED: OverlayView instances support the exact same
  // .setMap(map)/.setMap(null) calls a Marker does, so none of that
  // surrounding code needed to know its "markers" aren't Markers anymore.
  // ---------------------------------------------------------------------
  let WaePulseOverlayCtor = null;
  function waeEnsurePulseOverlayCtor() {
    if (WaePulseOverlayCtor) return true;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return false;
    WaePulseOverlayCtor = class extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = null;
        this.hitDiv = null;
        this.latLng = null;
        this.cluster = null;
        this._html = '';
        this._title = '';
        this._clickable = true;
      }
      // Attached to hitDiv's own click listener (see applyToDiv()) --
      // hitDiv only ever exists while this._clickable is on, so there's
      // no need to re-check appearance.clickable in here.
      _handleClick(ev) {
        ev.stopPropagation();
        const c = this.cluster;
        if (!c) return;
        if (c.records.length > 1) {
          const map = WAE_PULSES.map;
          // BUGFIX (not upstream, feature request): a cluster whose
          // records all share the same (or near-identical) coordinates
          // can never actually split apart no matter how far in you
          // zoom -- waeComputeClusters()'s pixel-distance grouping still
          // measures 0px between them at any zoom, so the "zoom in to
          // split it" behavior below used to just re-run at an already-
          // maxed-out zoom, doing nothing visible and leaving every
          // record underneath it unreachable. Once already at
          // WAE_CLUSTER_MAX_ZOOM (so a further zoom genuinely can't
          // reveal anything a previous click hasn't already tried),
          // list the records directly instead of zooming again.
          if (Math.floor(map.getZoom() ?? 0) >= WAE_CLUSTER_MAX_ZOOM) {
            waeShowPulseClusterInfoWindow(c, this.latLng);
            return;
          }
          map.setCenter(this.latLng);
          // Jumps straight to WAE_CLUSTER_MAX_ZOOM (not just "a few
          // levels in") -- a relative +3 from wherever the map happened
          // to already be could still land inside another cluster's
          // pixel radius at low starting zooms, leaving the click
          // looking like it did nothing. WAE_CLUSTER_MAX_ZOOM is deep
          // enough that this plugin's own clustering
          // (WAE_CLUSTER_PIXEL_RADIUS, in screen pixels) reliably splits
          // every real-world cluster back into individual markers.
          // Only ever zooms IN to reach it -- if already deeper than
          // that, the branch above already caught it.
          map.setZoom(Math.max(map.getZoom() || 8, WAE_CLUSTER_MAX_ZOOM));
        } else {
          waeShowPulseInfoWindow(c.records[0], this.latLng);
        }
      }
      onAdd() {
        const div = document.createElement('div');
        div.className = 'wae-pulse-marker';
        this.div = div;
        this.getPanes().overlayLayer.appendChild(div);
        this.applyToDiv();
        this.draw();
      }
      draw() {
        if (!this.div || !this.latLng) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(this.latLng);
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
        if (this.hitDiv) {
          this.hitDiv.style.left = `${point.x}px`;
          this.hitDiv.style.top = `${point.y}px`;
        }
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
        this.hitDiv?.remove();
        this.hitDiv = null;
      }
      getPosition() {
        return this.latLng;
      }
      applyToDiv() {
        if (!this.div) return;
        this.div.innerHTML = this._html;
        this.div.title = this._title;
        // hitDiv is created lazily, only once actually needed, and torn
        // down again the moment it isn't -- no point keeping an extra
        // per-marker DOM node (and its own listener) around for markers
        // that will never be clickable, e.g. with the "Clickable
        // markers" setting off.
        if (this._clickable && !this.hitDiv) {
          const hitDiv = document.createElement('div');
          hitDiv.className = 'wae-pulse-marker wae-pulse-hit wae-pulse-clickable';
          hitDiv.addEventListener('click', (ev) => this._handleClick(ev));
          this.hitDiv = hitDiv;
          this.getPanes()?.overlayMouseTarget.appendChild(hitDiv);
          this.draw(); // hitDiv just got created -- give it a position immediately, don't wait for the next draw() pass
        } else if (!this._clickable && this.hitDiv) {
          this.hitDiv.remove();
          this.hitDiv = null;
        }
        if (this.hitDiv) {
          this.hitDiv.innerHTML = this._html;
          this.hitDiv.title = this._title;
        }
      }
      // Called every refresh pass, for both a brand-new overlay and one
      // being reused for the same cluster key -- same "always reapply
      // rather than diff what changed" approach waeRefreshPulses()'s own
      // per-cluster loop already took with a Marker's
      // setPosition()/setIcon()/setLabel()/etc, kept as-is here since
      // none of this goes through image decoding anymore -- there's
      // nothing left in it that was ever the expensive part.
      setCluster(cluster, isExpanded, appearance) {
        this.cluster = cluster;
        this.latLng = new google.maps.LatLng(cluster.lat, cluster.lng);
        const isClusterMarker = cluster.records.length > 1;
        const shapeSvg = isClusterMarker ? waeGetClusterSvgMarkup(isExpanded) : waeGetMarkerSvgMarkup();
        this._html = isClusterMarker ? `${shapeSvg}<span class="wae-pulse-count">${cluster.records.length}</span>` : shapeSvg;
        this._title = isClusterMarker ? `${cluster.records.length} reports` : (cluster.records[0].wayspotName || '(unnamed report)');
        this._clickable = !!appearance.clickable;
        this.applyToDiv();
        this.draw();
      }
    };
    return true;
  }


  // Same shape/draw/click logic as WaePulseOverlayCtor above, just wired
  // to WAE_REVIEW_PULSES instead of WAE_PULSES -- kept as a genuinely
  // separate class (not a parameterized shared one) because the two
  // surfaces' lifecycles never overlap in practice (you're either on the
  // review page or you're not) and duplicating this one small class is
  // simpler than threading a "which state object" parameter through
  // every method for a class this size.
  let WaeReviewPulseOverlayCtor = null;
  function waeEnsureReviewPulseOverlayCtor() {
    if (WaeReviewPulseOverlayCtor) return true;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return false;
    WaeReviewPulseOverlayCtor = class extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = null;
        this.latLng = null;
        this.cluster = null;
        this._html = '';
        this._title = '';
        this._clickable = true;
      }
      onAdd() {
        const div = document.createElement('div');
        div.className = 'wae-pulse-marker';
        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const c = this.cluster;
          if (!c) return;
          if (c.records.length > 1) {
            WAE_REVIEW_PULSES.map.setCenter(this.latLng);
            // Same fix, same reasoning as WaePulseOverlayCtor's own click
            // handler above -- see its comment.
            WAE_REVIEW_PULSES.map.setZoom(Math.max(WAE_REVIEW_PULSES.map.getZoom() || 8, 20));
          } else {
            waeShowReviewPulseInfoWindow(c.records[0], this.latLng);
          }
        });
        this.div = div;
        this.applyToDiv();
        this.getPanes().overlayLayer.appendChild(div);
        this.draw();
      }
      draw() {
        if (!this.div || !this.latLng) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(this.latLng);
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
      }
      getPosition() {
        return this.latLng;
      }
      applyToDiv() {
        if (!this.div) return;
        this.div.innerHTML = this._html;
        this.div.title = this._title;
        this.div.classList.toggle('wae-pulse-clickable', this._clickable);
      }
      setCluster(cluster, isExpanded, appearance) {
        this.cluster = cluster;
        this.latLng = new google.maps.LatLng(cluster.lat, cluster.lng);
        const isClusterMarker = cluster.records.length > 1;
        const shapeSvg = isClusterMarker ? waeGetClusterSvgMarkup(isExpanded) : waeGetMarkerSvgMarkup();
        this._html = isClusterMarker ? `${shapeSvg}<span class="wae-pulse-count">${cluster.records.length}</span>` : shapeSvg;
        this._title = isClusterMarker ? `${cluster.records.length} reports` : (cluster.records[0].wayspotName || '(unnamed report)');
        // BUGFIX (not upstream, feature request): always false here,
        // deliberately NOT appearance.clickable -- review-page markers
        // are meant to stay click-through no matter what the shared
        // "Clickable markers" setting says, since a click on the review
        // page is much more likely meant for the actual review UI
        // underneath (selecting a duplicate candidate, etc.) than for
        // this plugin's own popup/cluster-zoom. The mapview/submit
        // crosses (WaePulseOverlayCtor's own setCluster(), earlier in
        // this file) still follow that setting normally -- this is the
        // one place the two surfaces are meant to diverge on it.
        this._clickable = false;
        this.applyToDiv();
        this.draw();
      }
    };
    return true;
  }

  // Ceiling of Google's own zoom scale for this map type -- also the
  // target _handleClick() above zooms a cluster in to. Named here (used
  // by both _handleClick() and waeShowPulseClusterInfoWindow()) instead
  // of the bare "20" it used to be, now that there's a second thing that
  // needs to agree on exactly which zoom counts as "as far in as this
  // can go."
  const WAE_CLUSTER_MAX_ZOOM = 20;

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
    // BUGFIX (not upstream): projection.fromLatLngToPoint() -- or the
    // `* scale` step right after it -- can transiently hand back a
    // non-finite x/y for a split second right as a zoom gesture settles
    // (observed as "crosses vanish on a zoom change and don't come back
    // until the Layers checkbox is toggled off/on"). A single bad point
    // here used to propagate into a cluster's averaged lat/lng below,
    // which google.maps.Marker#setPosition() throws on (it requires
    // finite coordinates) -- and since this whole computation runs
    // inside the debounced 'idle' handler with no try/catch anywhere in
    // the chain (see waeRefreshPulses()), that throw aborted the refresh
    // AFTER old markers had already been cleared but BEFORE new ones
    // were added, and nothing else re-triggers a refresh until the next
    // zoom/pan -- so a transient bad value on the LAST settle of a zoom
    // gesture left the layer empty indefinitely. Dropping just the
    // offending record here (instead of letting a bad point corrupt
    // whatever cluster it lands in) keeps one flaky projection from
    // taking out the whole redraw; it's very likely to project cleanly
    // again on the very next recompute.
    const points = records.map((r) => {
      let world = waeWorldPointCache.get(r.id);
      if (!world) {
        world = projection.fromLatLngToPoint(new google.maps.LatLng(r.latitude, r.longitude));
        waeWorldPointCache.set(r.id, world);
      }
      return { record: r, x: world.x * scale, y: world.y * scale };
    }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

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

  // Feature request (not upstream): shown instead of waeShowPulseInfoWindow()
  // when _handleClick() (WaePulseOverlayCtor, above) finds a cluster it
  // can't zoom-and-split any further -- see that call site's own comment.
  // A plain list of tickets, one per record, is deliberately as far as
  // this goes: these records still can't be individually clicked on the
  // map itself (there's no way to give two same-pixel crosses separate
  // hit targets), so this exists purely to make the tickets themselves
  // visible/copyable, not to reproduce the single-record popup's full
  // detail (comment text, etc.) for every record at once.
  // 'ticket' falls back to sourceEmailId, same as every other "what do
  // we call this record" spot in the file (waeFindNearbyDuplicates()'s
  // own list, the main table's export column, etc.) -- some records
  // never got a real conversationId (see this file's own conversationId/
  // sourceEmailId history) and still need *something* shown here.
  function waeShowPulseClusterInfoWindow(cluster, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_PULSES.map) return;
    if (!WAE_PULSES.infoWindow) WAE_PULSES.infoWindow = new google.maps.InfoWindow();
    const parts = [`<div style="font-size:12px;max-width:280px;"><strong>${cluster.records.length} reports at this location</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    parts.push('<ul style="margin:6px 0 0;padding-left:16px;">');
    for (const record of cluster.records) {
      const ticket = record.conversationId || record.sourceEmailId || '(no ticket)';
      const name = escapeHtml(record.wayspotName || '(unnamed report)');
      parts.push(`<li style="margin-bottom:2px;">${escapeHtml(String(ticket))} \u2014 ${name}</li>`);
    }
    parts.push('</ul></div>');
    WAE_PULSES.infoWindow.setContent(parts.join(''));
    WAE_PULSES.infoWindow.setPosition(latLng);
    WAE_PULSES.infoWindow.open(WAE_PULSES.map);
  }

  function waeClearPulses() {
    for (const overlay of WAE_PULSES.markersById.values()) {
      try { overlay.setMap(null); } catch (e) { /* ignore */ }
    }
    WAE_PULSES.markersById.clear();
    if (WAE_PULSES.infoWindow) WAE_PULSES.infoWindow.close();
  }

  // Review-page counterparts of the two functions just above -- same
  // body, WAE_REVIEW_PULSES instead of WAE_PULSES. See WAE_REVIEW_PULSES'
  // own comment for why this stays a parallel copy rather than a shared,
  // parameterized function.
  function waeShowReviewPulseInfoWindow(record, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_REVIEW_PULSES.map) return;
    if (!WAE_REVIEW_PULSES.infoWindow) WAE_REVIEW_PULSES.infoWindow = new google.maps.InfoWindow();
    const name = escapeHtml(record.wayspotName || '(unnamed report)');
    const parts = [`<div style="font-size:12px;max-width:260px;"><strong>${name}</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    if (record.comment) parts.push(`<div style="margin-top:4px;color:#6b7280;word-break:break-all;">${escapeHtml(record.comment)}</div>`);
    if (record.conversationId) parts.push(`<div style="margin-top:4px;color:#9ca3af;">Ticket ${escapeHtml(record.conversationId)}</div>`);
    parts.push('</div>');
    WAE_REVIEW_PULSES.infoWindow.setContent(parts.join(''));
    WAE_REVIEW_PULSES.infoWindow.setPosition(latLng);
    WAE_REVIEW_PULSES.infoWindow.open(WAE_REVIEW_PULSES.map);
  }

  function waeClearReviewPulses() {
    for (const overlay of WAE_REVIEW_PULSES.markersById.values()) {
      try { overlay.setMap(null); } catch (e) { /* ignore */ }
    }
    WAE_REVIEW_PULSES.markersById.clear();
    if (WAE_REVIEW_PULSES.infoWindow) WAE_REVIEW_PULSES.infoWindow.close();
  }

  // BUGFIX (not upstream, feature request): this used to hide crosses
  // below zoom level 8 on the general mapview (still zoom-gated, per a
  // now-removed comment, to avoid a fully zoomed-out view trying to show
  // every marker/cluster at once) -- reported as "no markers show from
  // zoom 1 through 8, they should render at every zoom level up to and
  // including the highest one." Crosses/clusters now always show
  // regardless of zoom, on every surface -- matching how the
  // submit-Wayspot page already behaved (see v1.26.0/v1.33.0's own
  // history with that page for why zoom-gating there specifically was
  // already recognized as wrong). Clustering (see waeComputeClusters())
  // still keeps a fully zoomed-out view from turning into hundreds of
  // individual markers -- nearby reports still collapse into one circle
  // with a count, this just stopped hiding that circle outright below a
  // fixed zoom.
  //
  // WAE_MIN_SHOW_ZOOM itself stays -- waeGetClusterSvgMarkup()'s "expand
  // at the lowest zoom level" behavior (see WAE_CLUSTER_EXPAND_FACTOR)
  // still needs a reference floor to compare the current zoom against,
  // it just no longer doubles as a visibility cutoff.
  const WAE_MIN_SHOW_ZOOM = 8;
  function waeShouldShowPulses() {
    return true;
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
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return;
    if (!waeEnsurePulseOverlayCtor()) return;

    // BUGFIX (not upstream): this function never checked whether the
    // "Abuse Report Crosses" layer was actually enabled -- only whether
    // a map existed and waeShouldShowPulses() allowed it.
    // waeApplyLayerEnabled(false) calls waeClearPulses() exactly once
    // when the checkbox is switched off, but the debounced 'idle'
    // listener set up in waeSetCurrentMap() stays attached to the map
    // for its whole lifetime regardless -- so the very next zoom (or
    // pan) fired this function again, which happily rebuilt every
    // marker with no idea the layer had been turned off, undoing the
    // toggle. Bailing out (and clearing anything that snuck back before
    // this check existed) whenever the layer is off makes every
    // automatic refresh respect the current on/off state, not just the
    // one that fires at the moment of the toggle itself.
    if (!isMapPulsesEnabled()) {
      waeClearPulses();
      return;
    }

    if (!waeShouldShowPulses(map, WAE_PULSES.surface)) {
      waeClearPulses();
      return;
    }

    const paddedBounds = waeGetPaddedBounds(map);
    const wanted = waeAllRecords.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && waeWithinPaddedBounds(r, paddedBounds));
    const clusters = waeComputeClusters(map, wanted);
    const wantedKeys = new Set(clusters.map(waeClusterKey));
    const appearance = waeLoadAppearance();
    // Floor()'d since Google Maps allows fractional zoom (smooth
    // scroll-zoom) -- without this, a cluster mid-transition at e.g.
    // 8.6 would flip in and out of "expanded" on every fractional tick
    // rather than settling once it's genuinely left the lowest whole
    // zoom level.
    const isLowestZoom = Math.floor(map.getZoom() ?? WAE_MIN_SHOW_ZOOM) <= WAE_MIN_SHOW_ZOOM;

    for (const [key, overlay] of WAE_PULSES.markersById.entries()) {
      if (!wantedKeys.has(key)) {
        try { overlay.setMap(null); } catch (e) { /* ignore */ }
        WAE_PULSES.markersById.delete(key);
      }
    }

    // BUGFIX (not upstream): this loop used to run with no error handling
    // at all -- if any single cluster's position/icon/etc call threw
    // (e.g. a still-non-finite lat/lng that slipped past the filter in
    // waeComputeClusters(), or any other one-off marker API hiccup), the
    // exception aborted the WHOLE refresh right here, after the removal
    // loop above had already cleared out markers no longer wanted --
    // leaving the layer visibly empty (or half-updated) with nothing
    // left to re-trigger a retry until the next zoom/pan (or the Layers
    // checkbox, toggled off then back on, which calls this function
    // directly outside the debounce). Isolating each cluster in its own
    // try/catch means one bad cluster gets skipped -- and picked back up
    // on the very next recompute, once whatever made it transiently bad
    // has passed -- instead of taking every other cluster's marker down
    // with it.
    for (const cluster of clusters) {
      if (!Number.isFinite(cluster.lat) || !Number.isFinite(cluster.lng)) continue;
      try {
        const key = waeClusterKey(cluster);
        let overlay = WAE_PULSES.markersById.get(key);
        if (!overlay) {
          overlay = new WaePulseOverlayCtor();
          WAE_PULSES.markersById.set(key, overlay);
        }
        overlay.setCluster(cluster, isLowestZoom, appearance);
        overlay.setMap(map);
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Reports] Skipped rendering one cluster:', e);
      }
    }
  }

  // Review-page counterpart of waeRefreshPulses() above -- same
  // filter/cluster/diff logic (waeGetPaddedBounds()/waeWithinPaddedBounds()/
  // waeComputeClusters()/waeClusterKey() are all already generic, just
  // take a map + records and hand back plain data, so they're reused
  // as-is here), just reading/writing WAE_REVIEW_PULSES and gated on the
  // review toggle (waeReviewPulsesEnabled(), see the "Review page
  // support" section) instead of isMapPulsesEnabled()/WFMM.layers --
  // this surface's on/off state is deliberately its own thing, never
  // wired through WFMM.layers, so it can never touch the Settings
  // side-panel list the way WAE_LAYER_ID does.
  function waeRefreshReviewPulses() {
    const map = WAE_REVIEW_PULSES.map;
    if (!map) return;
    if (!waeReviewPulsesEnabled()) {
      waeClearReviewPulses();
      return;
    }
    if (!waeEnsureReviewPulseOverlayCtor()) return;

    const paddedBounds = waeGetPaddedBounds(map);
    const wanted = waeAllRecords.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && waeWithinPaddedBounds(r, paddedBounds));
    const clusters = waeComputeClusters(map, wanted);
    const wantedKeys = new Set(clusters.map(waeClusterKey));
    const appearance = waeLoadAppearance();
    const isLowestZoom = Math.floor(map.getZoom() ?? WAE_MIN_SHOW_ZOOM) <= WAE_MIN_SHOW_ZOOM;

    for (const [key, overlay] of WAE_REVIEW_PULSES.markersById.entries()) {
      if (!wantedKeys.has(key)) {
        try { overlay.setMap(null); } catch (e) { /* ignore */ }
        WAE_REVIEW_PULSES.markersById.delete(key);
      }
    }

    for (const cluster of clusters) {
      if (!Number.isFinite(cluster.lat) || !Number.isFinite(cluster.lng)) continue;
      try {
        const key = waeClusterKey(cluster);
        let overlay = WAE_REVIEW_PULSES.markersById.get(key);
        if (!overlay) {
          overlay = new WaeReviewPulseOverlayCtor();
          WAE_REVIEW_PULSES.markersById.set(key, overlay);
        }
        overlay.setCluster(cluster, isLowestZoom, appearance);
        overlay.setMap(map);
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Reports] Skipped rendering one review cluster:', e);
      }
    }
  }

  // Same 'projection_changed' wait as waeSafeRefreshPulses() above, for
  // the exact same reason -- see that function's own comment. The
  // review-page map is attached later, and typically already idle by
  // the time waeSetReviewMap() runs (it's found via DOM search, not an
  // onReady-style event), so this race is if anything more likely here,
  // not less.
  function waeSafeRefreshReviewPulses() {
    const map = WAE_REVIEW_PULSES.map;
    if (map && typeof google !== 'undefined' && google.maps?.event && !map.getProjection()) {
      google.maps.event.addListenerOnce(map, 'projection_changed', () => {
        if (WAE_REVIEW_PULSES.map === map) waeSafeRefreshReviewPulses();
      });
      return;
    }
    try {
      waeRefreshReviewPulses();
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Review pulse refresh failed, retrying shortly:', e);
      setTimeout(() => {
        try { waeRefreshReviewPulses(); } catch (e2) { /* give up quietly -- next idle/search will try again */ }
      }, WAE_ZOOM_DEBOUNCE_MS);
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
  // BUGFIX (not upstream): only the debounced 'idle' handler below used
  // to have any error handling around waeRefreshPulses() -- every OTHER
  // caller (the initial WFMM.map.onReady() render, waeResyncMapIfVisible()
  // at bootstrap, waeApplyLayerEnabled()'s toggle-on path, and a live
  // appearance-color redraw) called it raw. Reported as "the crosses
  // sometimes don't load when you open the map, but do appear once you
  // click an abuse report": the map's projection/bounds are least likely
  // to be fully settled at the exact moment it first reports itself
  // ready, which is precisely when these load-time callers run -- if
  // that transient state made waeRefreshPulses() throw (see
  // waeComputeClusters()'s own comment on non-finite projected points),
  // the exception had nowhere to go on these paths, and nothing else
  // re-triggers a refresh until the map's own 'idle' event fires from an
  // actual interaction -- e.g. clicking a report, which recenters/zooms
  // the map and lands on the one path that WAS already protected.
  // Pulling that retry logic out into this one shared helper, and
  // routing every caller through it instead of the raw function, gives
  // all of them the same resilience the idle path already had.
  // BUGFIX (not upstream): reported as "the initial render shows every
  // record as its own individual cross, then a moment later reclusters
  // into groups" -- waeComputeClusters() deliberately falls back to
  // "every record is its own cluster" whenever map.getProjection() isn't
  // available yet (see that function's own comment: that fallback exists
  // for a DIFFERENT, more serious failure mode -- without SOME result
  // there, a still-unready projection used to throw and leave the whole
  // layer empty). The three callers that draw immediately after first
  // attaching to a map (WFMM.map.onReady() in waeStartMapTracking(),
  // waeApplyLayerEnabled()'s toggle-on path, and waeResyncMapIfVisible()
  // at bootstrap) can all run before Google Maps has actually finished
  // setting up that map's projection -- which is exactly the visible
  // "unclustered flash before it settles" being reported, now that the
  // actual THROW this fallback was originally written for is already
  // handled elsewhere (see this function's own try/catch below). Waiting
  // here for 'projection_changed' -- a one-time event that fires the
  // moment a map's projection becomes available -- means the very first
  // draw after attaching always has a real projection to cluster
  // against, so waeComputeClusters()'s fallback is only ever reached for
  // a genuinely transient hiccup mid-session, not as the normal outcome
  // of every fresh page load. Deliberately NOT 'idle' (used elsewhere in
  // this file for the same "wait for the map to be ready" purpose): idle
  // only fires once a full pan/zoom gesture settles, and if the map had
  // ALREADY idled once before this particular call happened to run, nothing
  // guarantees it'll ever fire again on its own -- 'projection_changed'
  // fires exactly once, unconditionally, the moment the projection first
  // becomes available, regardless of the map's idle history.
  function waeSafeRefreshPulses() {
    const map = WAE_PULSES.map;
    if (map && typeof google !== 'undefined' && google.maps?.event && !map.getProjection()) {
      google.maps.event.addListenerOnce(map, 'projection_changed', () => {
        if (WAE_PULSES.map === map) waeSafeRefreshPulses();
      });
      return;
    }
    try {
      waeRefreshPulses();
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Pulse refresh failed, retrying shortly:', e);
      setTimeout(() => {
        try { waeRefreshPulses(); } catch (e2) { /* give up quietly -- next real map interaction will try again */ }
      }, WAE_ZOOM_DEBOUNCE_MS);
    }
  }
  // BUGFIX (not upstream): this 'idle' listener is the ONLY thing that
  // keeps the crosses in sync with the map after the initial attach --
  // WFMM.map.refresh()'s own fast path (confirmed against the real
  // source) returns without re-emitting "map:ready" whenever the map is
  // still valid, so nothing else here re-fires on an ordinary zoom/pan.
  // That made this the single point of failure behind "crosses vanish on
  // a zoom change and only come back after toggling the layer off/on":
  // waeRefreshPulses() used to have no error handling at all, so if it
  // threw for any reason on a given settle (a transient bad projection
  // value right as the zoom gesture stopped -- see waeComputeClusters()'s
  // own comment), the exception was swallowed by the browser as an
  // uncaught error inside this setTimeout callback, and nothing else
  // would call waeRefreshPulses() again until the NEXT zoom/pan (or the
  // Layers checkbox, which calls it directly). If that failed settle
  // happened to be the last one in the gesture -- i.e. the user stopped
  // zooming right there -- the layer just stayed empty. Now: (1)
  // waeRefreshPulses() itself no longer lets one bad cluster take the
  // whole redraw down (see its own comment), and (2) waeSafeRefreshPulses()
  // above catches anything that still gets through and retries once,
  // shortly after, instead of leaving the layer to rot until another map
  // interaction happens to come along.
  function waeSetCurrentMap(map, surface) {
    if (WAE_PULSES.map === map) return;
    waeClearPulses();
    // Marked Wayspots' own dots (waeMarkMarkerOverlays) are OverlayView
    // instances tied to the OLD map instance -- torn down and redrawn on
    // the new one below, same reasoning as waeClearPulses() just above
    // for the abuse-report crosses/clusters.
    waeClearMarkedWayspotMarkers();
    WAE_PULSES.map = map;
    WAE_PULSES.surface = map ? (surface || null) : null;
    if (map) {
      let debounceTimer = null;
      map.addListener?.('idle', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(waeSafeRefreshPulses, WAE_ZOOM_DEBOUNCE_MS);
      });
      waeRenderMarkedWayspotMarkers();
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
  // an explicit toggle (the native Layers menu checkbox, the only way to
  // turn this on now -- see WAE_LAYER_ID's own comment), which already
  // gets its own clear, immediate error message on failure via
  // waeApplyLayerEnabled(); layering a delayed silent retry underneath
  // that too would risk that error already having shown while pulses
  // then quietly appear anyway a few seconds later, which reads as more
  // confusing than just letting the user flip the checkbox again
  // themselves as their own cheap retry.
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
      if (isMapPulsesEnabled()) waeSafeRefreshPulses();
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

  // ---------------------------------------------------------------------
  // Review page (/new/review) support.
  //
  // Deliberately independent of everything above: WFMM.map/WAE_LAYER_ID/
  // WFMM.layers/attachSettingsActions() are never touched by anything in
  // this section, and nothing above ever touches WAE_REVIEW_PULSES or
  // WAE_REVIEW_TOGGLE_KEY either. That separation is the point, not an
  // accident -- an earlier attempt at review-page support (reverted in
  // v1.40.0, see that changelog entry) tangled review handling into the
  // same map/route tracking this plugin already used for mapview/submit,
  // and the "Abuse Report Extractor" entry disappearing from the Settings
  // side-panel list on every page load was never actually root-caused
  // before the whole feature was pulled. Keeping this surface's own
  // on/off state, map lookup, and UI entirely apart from that machinery
  // means review-page code literally cannot be what breaks the Settings
  // link this time, whatever else does or doesn't go wrong here -- and
  // it directly satisfies the actual requirement besides: this plugin's
  // tool panel and its Settings side-panel entry stay exclusive to the
  // mapview/submit pages, never on review, so review support gets its
  // OWN small toggle instead, rendered directly above the review page's
  // own map.
  //
  // Map discovery: WFMM.map / WFMM.routes.onEnterMapRoute() never fire
  // for review at all (Map Mods' own ROUTES table marks "review" as
  // hasMap:false -- "WFMM does not currently interact with the review
  // duplicates map"), so there's no suite-provided map to ask for here.
  // Map Mods' OWN bundled review-map-enhancements plugin has to solve the
  // exact same problem internally (see createReviewMapController() in its
  // source) by querying the <nia-map> custom element Angular renders for
  // whichever review card is showing a map, then walking its
  // __ngContext__ (Angular's internal component-instance tree) looking
  // for something that looks like a real google.maps.Map -- but it only
  // exposes getSettings()/renderSettingsSection() on WFMM.reviewMapEnhancements,
  // not the map instance itself, so external plugins can't reuse it
  // directly. waeFindReviewMapOnce() below is this plugin's own from-
  // scratch version of that same technique (the file used to have a
  // comparable hand-rolled __ngContext__ reflection for mapview/submit
  // too, before WFMM.map replaced it in v1.26.0 -- see that changelog
  // entry) -- deliberately NOT narrowed to one specific review mode
  // (duplicates-check vs edit-location vs edit-info vs photo): it just
  // checks every <nia-map> currently in the DOM and uses whichever one
  // actually yields a map object, which is simpler and more robust to
  // Wayfarer's own markup changing than mirroring Map Mods' own mode
  // branching would be, at the cost of harmlessly checking one or two
  // extra elements when only one is really present.
  const WAE_REVIEW_TOGGLE_KEY = 'wae_review_pulses_visible';
  const WAE_REVIEW_TOGGLE_ID = 'wae-review-toggle-bar';
  const WAE_REVIEW_TOGGLE_WRAP_ID = 'wae-review-toggle-wrap';
  // Defaults ON (unlike WAE_LAYER_ID's mapview/submit crosses, which
  // default off via the native Layers menu) -- this is the one thing the
  // whole feature exists to show, and it's opt-OUT via the toggle bar
  // right above the map rather than opt-in via a menu the reviewer would
  // have to already know to look for.
  function waeReviewPulsesEnabled() {
    return localStorage.getItem(WAE_REVIEW_TOGGLE_KEY) !== 'false';
  }
  function waeSetReviewPulsesEnabled(enabled) {
    localStorage.setItem(WAE_REVIEW_TOGGLE_KEY, enabled ? 'true' : 'false');
  }

  function waeReviewLooksLikeGoogleMap(value) {
    return !!value && typeof value === 'object'
      && typeof value.getDiv === 'function'
      && typeof value.getZoom === 'function'
      && typeof value.setCenter === 'function'
      && typeof value.getProjection === 'function'
      && typeof value.addListener === 'function';
  }

  // Bounded breadth-first walk of an Angular __ngContext__ array/object
  // tree looking for a value waeReviewLooksLikeGoogleMap() accepts.
  // maxDepth/maxItems keep this from ever doing unbounded work against
  // whatever unrelated component state happens to be reachable from the
  // same context -- matches the caution Map Mods' own equivalent
  // (findObjectDeep(), maxDepth 9 / maxItems 5000) takes for the same
  // reason. Explicitly refuses to descend into DOM nodes/Window (both
  // reachable from a component context, both huge and cyclic) since
  // neither can ever itself be the map object we're looking for.
  function waeReviewFindObjectDeep(root, predicate, { maxDepth = 9, maxItems = 5000 } = {}) {
    if (!root || typeof root !== 'object') return null;
    const seen = new Set();
    const queue = [[root, 0]];
    let visited = 0;
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      if (visited > maxItems) return null;
      try {
        if (predicate(node)) return node;
      } catch (e) { /* a weird getter threw -- skip this node, keep walking */ }
      if (depth >= maxDepth) continue;
      if ((typeof Node !== 'undefined' && node instanceof Node) || (typeof Window !== 'undefined' && node instanceof Window)) continue;
      let keys;
      try { keys = Object.keys(node); } catch (e) { continue; }
      for (const key of keys) {
        let val;
        try { val = node[key]; } catch (e) { continue; } // some Angular/Maps getters throw outside their normal call context
        if (val && typeof val === 'object') queue.push([val, depth + 1]);
      }
    }
    return null;
  }

  function waeFindReviewMapHosts() {
    return Array.from(document.querySelectorAll('nia-map'));
  }

  function waeFindReviewMapOnce() {
    for (const host of waeFindReviewMapHosts()) {
      const ctx = host.__ngContext__;
      if (!ctx) continue;
      const map = waeReviewFindObjectDeep(ctx, waeReviewLooksLikeGoogleMap, { maxDepth: 9, maxItems: 5000 });
      if (map) return { map, host };
    }
    return null;
  }

  // Polling search, same shape as Map Mods' own review-map-enhancements
  // scheduleFind()/tryFind() (80 attempts * 250ms = 20s ceiling) --
  // Angular doesn't emit anything this plugin can listen for the moment
  // its map component finishes constructing, so a short poll after
  // entering/changing within the review route is the same approach the
  // suite's own equivalent feature already relies on.
  const WAE_REVIEW_MAP_SEARCH_INTERVAL_MS = 250;
  const WAE_REVIEW_MAP_SEARCH_MAX_ATTEMPTS = 80;
  let waeReviewMapSearchTimer = null;
  let waeReviewMapSearchAttempts = 0;
  // /new/review is a single route across every ticket a reviewer works
  // through, the same "one route, map swapped out underneath it"
  // situation v1.29.3 already had to add a periodic safety-net refresh
  // for on the submit-Wayspot page (see WAE_MAP_PERIODIC_RECHECK_MS
  // above) -- nothing here would otherwise notice the review map going
  // stale between one ticket and the next, since that's not a route
  // change and there's no WFMM.map staleness check backing this surface.
  // A cheap "is the attached map's own div still in the document"
  // check, polled the same way, covers it the same way.
  const WAE_REVIEW_PERIODIC_RECHECK_MS = 3000;
  let waeReviewPeriodicRecheckTimer = null;

  function waeReviewIsOnRoute() {
    return wfmmWindow.WFMM.routes.is('review');
  }

  function waeStopReviewMapSearch() {
    if (waeReviewMapSearchTimer) { clearTimeout(waeReviewMapSearchTimer); waeReviewMapSearchTimer = null; }
  }

  function waeScheduleReviewMapSearch() {
    if (waeReviewMapSearchTimer || WAE_REVIEW_PULSES.map) return;
    const tick = () => {
      waeReviewMapSearchTimer = null;
      if (!waeReviewIsOnRoute()) return; // left the review page before this fired
      const found = waeFindReviewMapOnce();
      if (found) {
        waeReviewMapSearchAttempts = 0;
        waeSetReviewMap(found.map, found.host);
        return;
      }
      waeReviewMapSearchAttempts += 1;
      if (waeReviewMapSearchAttempts < WAE_REVIEW_MAP_SEARCH_MAX_ATTEMPTS) {
        waeReviewMapSearchTimer = setTimeout(tick, WAE_REVIEW_MAP_SEARCH_INTERVAL_MS);
      }
    };
    waeReviewMapSearchTimer = setTimeout(tick, WAE_REVIEW_MAP_SEARCH_INTERVAL_MS);
  }

  function waeReviewMapStillValid() {
    const map = WAE_REVIEW_PULSES.map;
    if (!map) return false;
    try {
      const div = map.getDiv?.();
      return !!(div && div.isConnected);
    } catch (e) {
      return false;
    }
  }

  // Called from the panel's own scan/import/clear handlers (see
  // waeResyncMapIfVisible()'s call sites) alongside that function -- the
  // panel itself only ever shows on mapview/submit, but waeAllRecords is
  // a shared module-level cache, so a scan done there should be
  // reflected on the review map too if it's the one currently attached,
  // not just on the next incidental idle/pan. A no-op whenever no review
  // map is attached.
  function waeResyncReviewIfVisible() {
    if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();
  }

  // Doesn't reset waeReviewMapSearchAttempts here -- only
  // waeReviewOnRouteEnter does that, for a genuine fresh 20s burst on
  // actually entering the route. Leaving the counter alone means once a
  // burst exhausts itself (a review card with no map at all, e.g. a
  // report with no location), each subsequent periodic tick here does
  // exactly one more retry (waeScheduleReviewMapSearch() no-ops while a
  // search is already in flight, and a single retry from an exhausted
  // counter doesn't re-arm a whole new 80-attempt burst) rather than
  // resetting the counter and re-triggering a fresh 20-second busy-poll
  // burst every single 3-second tick forever.
  function waeReviewPeriodicRecheck() {
    if (!waeReviewIsOnRoute()) return;
    if (!waeReviewMapStillValid()) {
      waeSetReviewMap(null, null);
      waeScheduleReviewMapSearch();
    }
  }

  let waeReviewMapIdleListener = null;
  let waeReviewIdleDebounceTimer = null;

  function waeSetReviewMap(map, host) {
    if (WAE_REVIEW_PULSES.map === map) {
      if (map && host) waeInjectReviewToggle(host); // same map, host element got re-rendered -- keep the toggle bar anchored to it
      return;
    }
    waeClearReviewPulses();
    if (waeReviewMapIdleListener) {
      try { google.maps.event.removeListener(waeReviewMapIdleListener); } catch (e) { /* ignore */ }
      waeReviewMapIdleListener = null;
    }
    clearTimeout(waeReviewIdleDebounceTimer);
    WAE_REVIEW_PULSES.map = map;
    WAE_REVIEW_PULSES.host = host || null;
    if (map) {
      waeReviewMapIdleListener = map.addListener?.('idle', () => {
        clearTimeout(waeReviewIdleDebounceTimer);
        waeReviewIdleDebounceTimer = setTimeout(waeSafeRefreshReviewPulses, WAE_ZOOM_DEBOUNCE_MS);
      });
      waeInjectReviewToggle(host);
      // BUGFIX: see waeEnsureRecordsLoaded()'s own comment -- same fix as
      // waeApplyLayerEnabled()/waeResyncMapIfVisible(), applied here to
      // the review-page map-attach path. waeSetReviewMap() itself isn't
      // async (called from several synchronous call sites), so this is
      // fire-and-forget rather than awaited -- finally() (not then())
      // so a draw is still attempted even if the load failed, same
      // reasoning as those two functions' own .catch(() => {}).
      waeEnsureRecordsLoaded().finally(waeSafeRefreshReviewPulses);
    } else {
      waeRemoveReviewToggle();
    }
  }

  // Toggle bar embedded in the review page's own layout, directly below
  // whichever <nia-map> element the currently-attached review map came
  // from -- a real DOM descendant of host's own parent again (normal
  // flow, no fixed positioning, no getBoundingClientRect tracking),
  // which is what "embedded in the UI" means here: it scrolls, resizes
  // and reflows with the page instead of a script re-synchronizing a
  // floating copy against it a frame later.
  //
  // v1.43.0's original version of this (host.parentElement.insertBefore
  // (bar, host)) broke on review cards where the map's immediate parent
  // turned out to be a flex/grid ROW (map + photo carousel side by
  // side, confirmed in the field via screenshot) rather than a simple
  // stacked column -- inserting a second child there just became
  // another item in that row. v1.47.0 sidestepped that with
  // position:fixed on document.body, which fixed the placement but
  // introduced the floating/lagging look. v1.50.0 tried forcing the
  // existing row to wrap (flex-wrap:wrap/grid-column:1/-1 on the bar
  // itself) instead -- reported back still landing beside the map,
  // confirming that guessing at and overriding the SITE'S OWN row/grid
  // settings from outside isn't reliable (Wayfarer's own layout code
  // can simply re-apply whatever it was already doing).
  //
  // waePlaceReviewToggle() below takes a different approach that
  // doesn't depend on any of that: it moves host itself inside a new
  // wrapper div this plugin fully owns, with the wrapper -- not host --
  // now occupying host's old slot in whatever row/grid the review card
  // uses. Host's own placement/sizing rules (an external "nia-map{...}"
  // stylesheet rule, an inline style, or an Angular binding -- whichever
  // it was) still apply to host wherever it's nested, but the ones that
  // controlled HOW MUCH SPACE THE ROW GAVE IT (flex-grow/shrink/basis,
  // grid-column/row/area, width) only matter for whatever element is
  // the row's DIRECT child -- so those are read off host's *computed*
  // style (the resolved value, however it got there) and copied onto
  // the wrapper before host moves, giving the wrapper the same
  // footprint host used to have. Inside that wrapper, host and the bar
  // are stacked in a plain flex column this plugin controls end to end,
  // so nothing about the site's own row/grid settings has any say over
  // whether they end up on the same line -- they can't, structurally.
  function waeInjectReviewToggle(host) {
    if (!host) return;
    let bar = document.getElementById(WAE_REVIEW_TOGGLE_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = WAE_REVIEW_TOGGLE_ID;
      bar.className = 'wae-review-toggle-bar';
      const label = document.createElement('span');
      label.className = 'wae-review-toggle-label';
      label.textContent = 'Abuse report markers';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wae-review-toggle-btn';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        waeSetReviewPulsesEnabled(!waeReviewPulsesEnabled());
        waeUpdateReviewToggleUi();
        waeSafeRefreshReviewPulses();
      });
      bar.appendChild(label);
      bar.appendChild(btn);
    }
    waeReviewToggleHost = host;
    waePlaceReviewToggle(host, bar);
    // Back to living inside Wayfarer's own app tree (a genuine DOM
    // descendant of host's parent), so the bar and whatever ancestor
    // carries Wayfarer's in-app ".dark" class are in the same subtree
    // again -- but this still checks host.closest('.dark') directly and
    // applies the result as our own class, rather than reintroducing a
    // ".dark .wae-review-toggle-bar" descendant selector, since that's
    // one less thing that can silently stop matching if the bar's exact
    // DOM position ever moves again in a future version.
    bar.classList.toggle('wae-review-dark', !!host.closest('.dark'));
    waeUpdateReviewToggleUi();
  }

  // Moves host inside a wrapper div this plugin owns (if it isn't
  // already), copying host's computed row/grid-placement properties
  // onto the wrapper first so the wrapper keeps host's original
  // footprint in the surrounding page, then stacks host and bar
  // vertically inside that wrapper via a plain flex column -- see
  // waeInjectReviewToggle()'s own comment for why this replaced trying
  // to make the SITE'S row/grid wrap the bar onto its own line instead.
  // 'height' is deliberately left off the copied-property list: copying
  // host's own resolved height onto the wrapper would cap the wrapper
  // at exactly the map's height, leaving no room for the bar and
  // squeezing the map to fit both inside that fixed height instead.
  // Leaving it off means the wrapper has no explicit height of its own
  // and simply grows to fit its two stacked children (host at whatever
  // height it already had, plus the bar) -- taller than a single
  // grid/flex row might otherwise expect, which is an acceptable
  // trade-off next to squeezing the actual map.
  // Idempotent and re-run on every waeInjectReviewToggle() call (not
  // just the first): the map's host element can get replaced wholesale
  // by Angular re-rendering a review card (see waeSetReviewMap()'s own
  // comment), and a fresh host may or may not land back inside the same
  // wrapper depending on how much of the surrounding DOM Angular
  // recreated -- checking parentElement's id on every call re-wraps a
  // host that came back outside our old wrapper, and is a cheap no-op
  // for one that's still inside it.
  const WAE_REVIEW_WRAP_COPIED_PROPS = [
    'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf',
    'gridColumn', 'gridRow', 'gridArea', 'width', 'minWidth', 'maxWidth',
  ];
  function waePlaceReviewToggle(host, bar) {
    let wrap = host.parentElement;
    if (!wrap || wrap.id !== WAE_REVIEW_TOGGLE_WRAP_ID) {
      const originalParent = host.parentElement;
      if (!originalParent) return;
      wrap = document.createElement('div');
      wrap.id = WAE_REVIEW_TOGGLE_WRAP_ID;
      const hostComputed = getComputedStyle(host);
      for (const prop of WAE_REVIEW_WRAP_COPIED_PROPS) wrap.style[prop] = hostComputed[prop];
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.minWidth = wrap.style.minWidth || '0'; // avoid flex-content overflow
      originalParent.insertBefore(wrap, host);
      wrap.appendChild(host);
    }
    if (bar.parentElement !== wrap || bar.previousElementSibling !== host) {
      wrap.appendChild(bar); // (re-)place as wrap's last child, right after host
    }
  }

  let waeReviewToggleHost = null;

  function waeRemoveReviewToggle() {
    document.getElementById(WAE_REVIEW_TOGGLE_ID)?.remove();
    waeReviewToggleHost = null;
  }

  function waeUpdateReviewToggleUi() {
    const bar = document.getElementById(WAE_REVIEW_TOGGLE_ID);
    if (!bar) return;
    const btn = bar.querySelector('.wae-review-toggle-btn');
    if (!btn) return;
    const on = waeReviewPulsesEnabled();
    btn.textContent = on ? 'On' : 'Off';
    btn.classList.toggle('wae-review-toggle-on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  let waeReviewRouteEnterUnsub = null;
  let waeReviewRouteLeaveUnsub = null;

  function waeReviewOnRouteEnter() {
    waeReviewMapSearchAttempts = 0;
    waeScheduleReviewMapSearch();
    if (!waeReviewPeriodicRecheckTimer) {
      waeReviewPeriodicRecheckTimer = setInterval(waeReviewPeriodicRecheck, WAE_REVIEW_PERIODIC_RECHECK_MS);
    }
  }

  function waeReviewOnRouteLeave() {
    waeStopReviewMapSearch();
    if (waeReviewPeriodicRecheckTimer) { clearInterval(waeReviewPeriodicRecheckTimer); waeReviewPeriodicRecheckTimer = null; }
    waeSetReviewMap(null, null);
  }

  function waeStartReviewTracking() {
    if (waeReviewRouteEnterUnsub) return; // already subscribed
    const WFMM = wfmmWindow.WFMM;
    waeReviewRouteEnterUnsub = WFMM.routes.onEnter('review', waeReviewOnRouteEnter);
    waeReviewRouteLeaveUnsub = WFMM.routes.onLeave('review', waeReviewOnRouteLeave);
    if (waeReviewIsOnRoute()) waeReviewOnRouteEnter(); // this version can load while already sitting on /new/review
  }

  function waeStopReviewTracking() {
    waeReviewRouteEnterUnsub?.();
    waeReviewRouteLeaveUnsub?.();
    waeReviewRouteEnterUnsub = null;
    waeReviewRouteLeaveUnsub = null;
    waeReviewOnRouteLeave();
  }

  // ---------------------------------------------------------------------
  // Live Wayspot ticket annotation -- appends "#<ticket>" just above the
  // LIVE/status badge row in the side panel's own Wayspot details card
  // (the one that opens when you click a Wayspot on the map), for any
  // Wayspot within WAE_NEARBY_THRESHOLD_METERS of one of this plugin's
  // own extracted locations.
  //
  // Uses WFMM.sidePanel -- a real, public service (confirmed against the
  // real source, src/core/side-panel.js), NOT the same as this plugin's
  // OWN "Show on Map" markers/popups, and NOT a hook into Wayfarer's
  // truly-native rendering (there isn't a confirmed one -- see the
  // earlier back-and-forth on this feature for why an approach that
  // needed one was abandoned). This IS how Base itself builds that same
  // card (createPoiDetailsElement(), confirmed against the same source),
  // so this plugin is using the identical public surface Base's own code
  // does, not reverse-engineering something undocumented.
  //
  // The mechanism: WFMM.sidePanel.setDetails() -- what Base calls every
  // time a different Wayspot gets selected -- fully replaces the details
  // slot's content, THEN emits "side-panel:details-changed" with a
  // reference to that slot. This plugin only ever listens for that event
  // and inserts one extra element into the ALREADY-rendered slot after
  // the fact -- it never calls setDetails() itself, which would wipe out
  // Base's own card (title, photo, everything) rather than adding to it.
  // Each event gives a freshly-Base-rendered slot (whatever this plugin
  // inserted last time is already gone by the time the event fires, wiped
  // by Base's own replaceSlotContent()), so there's nothing to clean up
  // beforehand -- just insert fresh every time, or don't if there's no
  // match.
  //
  // Which Wayspot is showing isn't in the event payload itself (just
  // {pluginId, panel, slot}) -- read from the already-rendered DOM
  // instead: the coords element Base's own createCoordsElement() builds
  // carries the exact lat/lng as data-lat/data-lng attributes (confirmed
  // against the same source), which is more robust than trying to parse
  // the "(50.312940,6.731698)" display text back apart.
  let waeSidePanelDetailsUnsub = null;

  function waeFindMatchingTicketNumbers(lat, lng) {
    // BUGFIX (not upstream): was a plain linear scan over every record in
    // waeAllRecords -- see waeGetTicketIndexBuckets()'s own comment (just
    // above waeFindNearbyDuplicates()) for why that stopped scaling and
    // what replaced it. Only the 3x3 neighborhood around (lat, lng)'s own
    // grid cell needs checking -- same reasoning as
    // waeFindNearbyDuplicates()'s own neighborhood scan, and the same
    // WAE_GRID_DEG cell size guarantees it here too: anything within
    // WAE_NEARBY_THRESHOLD_METERS always falls in one of these 9 cells.
    const buckets = waeGetTicketIndexBuckets();
    const cellLat = Math.floor(lat / WAE_GRID_DEG);
    const cellLon = Math.floor(lng / WAE_GRID_DEG);
    const seen = new Set();
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = buckets.get(`${cellLat + dLat}:${cellLon + dLon}`);
        if (!bucket) continue;
        for (const r of bucket) {
          if (waeHaversineMeters(lat, lng, r.latitude, r.longitude) <= WAE_NEARBY_THRESHOLD_METERS) {
            seen.add(r.conversationId || r.sourceEmailId);
          }
        }
      }
    }
    return Array.from(seen);
  }

  // v1.53.6: spelled back out from the terser "+ Add" (v1.52.0's own
  // shortening, once the note field moved into this same row) -- kept as
  // one constant since the label's set in two places below (the button's
  // initial text, and the post-"\u2713 Added"/"\u2713 Updated" reset).
  const WAE_MARK_BTN_LABEL = '+ add to abuse report draft';

  function waeStartSidePanelDetailsWatcher() {
    if (waeSidePanelDetailsUnsub) return; // already subscribed
    const WFMM = wfmmWindow.WFMM;
    waeSidePanelDetailsUnsub = WFMM.events.on(WFMM.sidePanel.EVENTS.DETAILS_CHANGED, ({ slot }) => {
      if (!slot) return;
      const coordsEl = slot.querySelector('.wfmapmods-detail-coords');
      const lat = Number(coordsEl?.dataset.lat);
      const lng = Number(coordsEl?.dataset.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const statusRow = slot.querySelector('.wfmapmods-detail-status');
      if (!statusRow || !statusRow.parentNode) return;

      const tickets = waeFindMatchingTicketNumbers(lat, lng);
      if (tickets.length) {
        const line = document.createElement('div');
        line.className = 'wae-detail-ticket-line';
        line.textContent = tickets.map((t) => `#${t}`).join(', ');
        statusRow.parentNode.insertBefore(line, statusRow);
      }

      // Feature request: a "+" right in this same spot (where the
      // ticket-number line above shows, whether or not there's actually
      // one to show right now) to add THIS Wayspot to the separate
      // Marked Wayspots scratch list -- see that feature's own
      // top-of-section comment (search "Marked Wayspots" further down
      // this file) for what that list is for. An earlier version of this
      // feature tried a global "arm marking mode, then click a Wayspot
      // on the map" toggle instead, reported back as not matching the
      // wanted interaction -- individual Wayspots need their own "+" to
      // click, not a separate mode. Same DOM-read approach as the ticket
      // line above (title read off .wfmapmods-detail-title, confirmed
      // against Base's own createTitleElement(), same source as
      // everything else in this watcher) rather than WFMM.selection/
      // WFMM.pois -- one mechanism for this whole watcher, not two, and
      // this one's already proven reliable here.
      const titleText = slot.querySelector('.wfmapmods-detail-title')?.textContent?.trim() || '';
      const name = (titleText && titleText !== 'Untitled location') ? titleText : '';

      const markRow = document.createElement('div');
      markRow.className = 'wae-detail-mark-row';

      // Feature request: a short note can be typed here BEFORE clicking
      // "+", so it's captured in the same entry right away instead of
      // needing a separate trip to the list modal afterward to open and
      // fill in the note there (still possible too -- this is an
      // addition, not a replacement for that).
      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.className = 'wae-detail-mark-note';
      noteInput.placeholder = 'Note (optional)';
      noteInput.maxLength = 300;
      // Typing/clicking into this field is squarely inside Wayfarer's own
      // side panel, which has its own click handling around it (the same
      // reason markBtn's own click handler below stops propagation) --
      // without this, a keystroke could end up also triggering whatever
      // that surrounding panel does with clicks/keys it doesn't
      // recognize as text input.
      noteInput.addEventListener('click', (ev) => ev.stopPropagation());
      noteInput.addEventListener('keydown', (ev) => ev.stopPropagation());

      const markBtn = document.createElement('button');
      markBtn.type = 'button';
      markBtn.className = 'wae-detail-mark-btn';
      // Feature request: label spelled out again (was shortened to the
      // terser "+ Add" in v1.52.0 once the note field landed alongside it
      // in this same row -- see that changelog entry) -- WAE_MARK_BTN_LABEL
      // is the one place this string lives now, since it's set both here
      // and in the post-click reset below.
      markBtn.textContent = WAE_MARK_BTN_LABEL;
      markBtn.title = 'Add this Wayspot to your Marked Wayspots list';
      markBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const result = waeAddMarkedWayspot({ name, lat, lng, note: noteInput.value.trim() });
        noteInput.value = '';
        // Distinguishes an overwrite of an already-marked Wayspot's note
        // from a genuinely new entry -- waeAddMarkedWayspot() itself is
        // what actually decides which happened (coordinate match against
        // the existing list, see its own comment).
        markBtn.textContent = result === 'updated' ? '\u2713 Updated' : '\u2713 Added';
        markBtn.disabled = true;
        setTimeout(() => {
          // Guards against the slot (and this button along with it)
          // having already been torn down/replaced by the time this
          // fires -- Base wipes and rebuilds the whole details slot on
          // every new selection (see this watcher's own top comment),
          // so a stale button re-enabling itself into nothing visible
          // is harmless, but touching it at all past that point isn't
          // needed either.
          if (markBtn.isConnected) {
            markBtn.textContent = WAE_MARK_BTN_LABEL;
            markBtn.disabled = false;
          }
        }, 1200);
      });
      markRow.append(noteInput, markBtn);
      statusRow.parentNode.insertBefore(markRow, statusRow);
      statusRow.parentNode.insertBefore(markBtn, statusRow);
    });
  }

  function waeStopSidePanelDetailsWatcher() {
    waeSidePanelDetailsUnsub?.();
    waeSidePanelDetailsUnsub = null;
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

  // BUGFIX (not upstream): this used to be its own independent
  // localStorage flag, toggled only from this plugin's own "Show on Map"
  // button -- meaning it had no presence in the suite's own native
  // Layers menu (the stacked-squares icon next to the map's search bar),
  // unlike Wayspots/OSM/etc. Registered as a real WFMM.layers entry now
  // (see startPlugin()) instead, confirmed against the real source
  // (src/core/layers.js) -- that menu (src/plugins/map-ui/layers-menu.js)
  // just iterates WFMM.layers.list() and builds a plain checkbox per
  // entry, so registering ours is the entire integration; nothing else
  // to build for it to show up there with a working toggle. This is now
  // the single source of truth for on/off, backed by WFMM's own settings
  // persistence rather than this plugin's own. This plugin's own "Show
  // on Map" button was removed entirely in v1.33.0 once it became purely
  // redundant with that native checkbox -- the checkbox is the only way
  // to toggle this now, and this function is just reading whatever it's
  // currently set to.
  function isMapPulsesEnabled() {
    return wfmmWindow.WFMM.layers.isEnabled(WAE_LAYER_ID);
  }

  // The one place that actually reacts to the layer's on/off state
  // changing -- registered as the layer's own onChange in startPlugin().
  // The only way to toggle this is the native Layers menu now (v1.33.0
  // removed this plugin's own "Show on Map"/"Hide from Map" button,
  // since it was entirely redundant with that menu once the layer was
  // registered there -- see WAE_LAYER_ID's own comment) -- no button of
  // this plugin's own left to show a transient "Attaching to map..."
  // state on, or to disable/re-enable around the attach.
  async function waeApplyLayerEnabled(enabled) {
    if (enabled) {
      const attached = await waeAttachToMapIfNeeded();
      if (attached) {
        // BUGFIX: used to call waeSafeRefreshPulses() immediately here,
        // which drew nothing at all if waeAllRecords hadn't loaded yet
        // this session (see waeEnsureRecordsLoaded()'s own comment) --
        // toggling the layer off/on looked like it simply didn't work.
        // Awaited so the very first draw after turning this on always
        // has real data to draw from.
        await waeEnsureRecordsLoaded().catch(() => {}); // best-effort -- still try to draw with whatever's cached (likely []) rather than leave the layer on with a silent failure
        waeSafeRefreshPulses();
        // v1.53.4: Marked Wayspots' dots are gated on isMapPulsesEnabled()
        // now (see waeRenderMarkedWayspotMarkers()'s own comment), but
        // re-ticking this checkbox reuses the SAME map instance as before
        // (WAE_PULSES.map already pointed at it) -- waeSetCurrentMap()'s
        // guard clause means it won't re-fire its own render call the way
        // it does for a genuinely new map, so this has to ask explicitly.
        waeRenderMarkedWayspotMarkers();
      } else {
        if (waeUI) log(waeUI.logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview or the submit-Wayspot map.', 'err');
        // Couldn't actually attach -- don't leave the layer claiming to
        // be on. Triggers this same function again (via onChange, since
        // the state genuinely changes false->true->false), which just
        // takes the `else` branch below and no-ops on an already-empty
        // set of markers.
        wfmmWindow.WFMM.layers.setEnabled(WAE_LAYER_ID, false);
      }
    } else {
      waeClearPulses();
      // v1.53.4: hide Marked Wayspots' dots the instant the box is
      // unticked, rather than leaving them up until the next list
      // mutation happens to call waeRenderMarkedWayspotMarkers() again --
      // isMapPulsesEnabled() already reflects the new (disabled) state by
      // this point, so the gate inside that function clears them here.
      waeRenderMarkedWayspotMarkers();
    }
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
    if (attached) {
      // BUGFIX: see waeEnsureRecordsLoaded()'s own comment -- this is
      // the actual first-page-load case that comment describes. Awaited
      // (not fire-and-forget) so the map's very first draw, right after
      // attaching on a fresh page load, has real data instead of [].
      await waeEnsureRecordsLoaded().catch(() => {});
      waeSafeRefreshPulses();
    }
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
    ['starred', 'Starred'],
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

  // BUGFIX (not upstream): issueType/locationDetails/reportDetails are
  // genuinely per-TICKET data (see the v1.21.0 changelog note on
  // EXTRACT_DB_VERSION) -- they're stored just once per ticket, in the
  // separate ticketDetails object store, precisely so a 12-location
  // ticket doesn't pay for 12 copies of the same raw text at rest.
  // getAllExtractedRecords() then transparently HYDRATES that one stored
  // copy back onto every location row sharing the ticket, so every
  // existing caller (table rendering, search, nearby-duplicate
  // detection) keeps seeing the same familiar per-row shape without
  // needing its own join logic -- that hydration is correct and
  // intentional for those callers. CSV export used to hand the fully
  // hydrated rows straight to recordsToCsv() too, though, which meant a
  // reader opening the file saw the same (often long) raw report text
  // repeated once per Wayspot the ticket reported -- reported as "many
  // duplicated texts" in the export (and, from the outside, easy to
  // mistake for the storage itself being duplicated, even though that
  // part was already fixed in v1.21.0). This keeps the raw ticket-level
  // text on only the FIRST row for a given ticketKey and blanks it on
  // every later row of that same ticket, purely for the exported file --
  // waeAllRecords / the on-screen table / getAllExtractedRecords() are
  // untouched, so nothing else loses the per-row hydration it relies on.
  // conversationId/ticketStatus/lastResponseAt stay on every row
  // deliberately -- they're short, and needed on every row to identify
  // which ticket it belongs to once the raw text below is blanked out.
  const WAE_TICKET_LEVEL_EXPORT_COLUMNS = ['issueType', 'locationDetails', 'reportDetails'];
  function waeDedupeTicketLevelColumnsForExport(records) {
    const seenTicketKeys = new Set();
    return records.map((r) => {
      const alreadySeen = seenTicketKeys.has(r.ticketKey);
      seenTicketKeys.add(r.ticketKey);
      if (!alreadySeen) return r;
      const deduped = { ...r };
      for (const key of WAE_TICKET_LEVEL_EXPORT_COLUMNS) deduped[key] = null;
      return deduped;
    });
  }

  function recordsToCsv(records) {
    const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
    const rows = waeDedupeTicketLevelColumnsForExport(records)
      .map((r) => CSV_COLUMNS.map(([key]) => csvEscape(r[key])).join(','));
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
  // CSV import -- for locations that didn't come from a scanned email at
  // all (a known problem spot from another source, something a reviewer
  // wants to track manually, etc.) rather than anything this plugin
  // extracted itself. Deliberately forgiving: only Latitude/Longitude are
  // required, every other column is optional, and column names are
  // matched case-insensitively against a short list of common spellings
  // rather than requiring one exact header row -- someone hand-building a
  // CSV in a spreadsheet app is the expected case, not another export
  // from this same tool.
  //
  // A minimal RFC4180-ish parser (quoted fields, "" as an escaped quote
  // inside one, commas/newlines inside quotes) -- not the full spec (no
  // BOM stripping here specifically, since File.text() already decodes
  // as UTF-8 and a leading BOM character just ends up harmless leading
  // whitespace on the first header name once trimmed), but enough for
  // what a spreadsheet app or a hand-written file will actually produce.
  function csvParse(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; } // swallow bare \r -- \r\n handled by the \n case below, a lone \r (old Mac line endings) still just ends the row
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    // Final field/row if the file doesn't end in a newline.
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === '')); // drop fully-blank trailing lines
  }

  // header -> column index, matched against a few common spellings per
  // field rather than one fixed name -- e.g. "Lat" and "Latitude" both
  // work, so does "Lng"/"Long"/"Longitude". Latitude/longitude are the
  // only ones that block the whole file if missing; everything else
  // just means that field comes back empty for every row.
  const WAE_CSV_COLUMN_ALIASES = {
    latitude: ['latitude', 'lat'],
    longitude: ['longitude', 'lng', 'long', 'lon'],
    wayspotName: ['name', 'wayspot name', 'wayspotname'],
    comment: ['comment', 'comments', 'note', 'notes'],
    conversationId: ['conversation id', 'conversationid', 'ticket', 'ticket id', 'ticketid'],
  };
  function waeMapCsvHeader(headerRow) {
    const normalized = headerRow.map((h) => h.trim().toLowerCase());
    const indexOf = {};
    for (const [field, aliases] of Object.entries(WAE_CSV_COLUMN_ALIASES)) {
      const idx = normalized.findIndex((h) => aliases.includes(h));
      if (idx !== -1) indexOf[field] = idx;
    }
    return indexOf;
  }

  // Returns { records, skipped, error }. `error` (a string) means the
  // whole file was rejected outright (no usable header); otherwise each
  // unparseable/out-of-range row is just skipped and counted rather than
  // failing the whole import over one bad line.
  function waeParseCsvImport(text) {
    const rows = csvParse(text);
    if (!rows.length) return { records: [], skipped: 0, error: 'That file is empty.' };
    const indexOf = waeMapCsvHeader(rows[0]);
    if (indexOf.latitude === undefined || indexOf.longitude === undefined) {
      return { records: [], skipped: 0, error: 'Could not find Latitude/Longitude columns in the header row -- see the format hint above the button.' };
    }
    const records = [];
    let skipped = 0;
    for (const cells of rows.slice(1)) {
      const lat = Number((cells[indexOf.latitude] || '').trim());
      const lng = Number((cells[indexOf.longitude] || '').trim());
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        skipped++;
        continue;
      }
      const conversationId = indexOf.conversationId !== undefined ? (cells[indexOf.conversationId] || '').trim() || null : null;
      // A stable id (ticket + rounded coordinates) when the row supplies
      // its own Conversation ID, so re-importing the same file updates
      // those rows instead of duplicating them -- there's no other
      // reliable dedup key for data that didn't come from this plugin's
      // own extraction in the first place. Falls back to a random id
      // when no Conversation ID is given, same as it would for any
      // other never-seen-before location.
      const id = conversationId
        ? `csv:${conversationId}:${lat.toFixed(6)},${lng.toFixed(6)}`
        : `csv:${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      records.push({
        id,
        ticketKey: null,
        conversationId,
        ticketStatus: 'CSV_IMPORT',
        lastResponseAt: null,
        wayspotName: indexOf.wayspotName !== undefined ? (cells[indexOf.wayspotName] || '').trim() || null : null,
        latitude: lat,
        longitude: lng,
        comment: indexOf.comment !== undefined ? (cells[indexOf.comment] || '').trim() || null : null,
        sourceEmailId: null,
        sourceFilename: null,
        scannedAt: Date.now(),
        source: 'csv',
      });
    }
    return { records, skipped, error: null };
  }

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
    /* Holds the panel's summary line (countEl, "N reports across M tickets"
       or similar) on the left, and -- grouped together on the right, via
       .wae-panel-header-actions -- the small envelope + cog icon buttons
       that open the Email Importer panel and Marker Style settings. See
       buildPanelContent()'s own comments on emailImporterBtn/
       markerStyleBtn for why both live here (tucked next to this line)
       rather than as labeled buttons of their own. */
    .wae-panel-header-row{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .wae-panel-header-row .wae-sub{ margin-bottom:0; }
    .wae-panel-header-actions{ display:flex; align-items:center; gap:4px; flex-shrink:0; }
    /* Marked Wayspots -- the list modal's rows (waeBuildMarkedWayspotRow()).
       The "+" itself is styled separately (.wae-detail-mark-btn, in the
       side-panel-details section below) since it lives in the Wayspot
       details side panel, not this panel. */
    .wae-mark-list{ max-height:320px; overflow-y:auto; margin-top:8px; }
    /* The on-map dot for a Marked Wayspots entry (waeRenderMarkedWayspotMarkers()) --
       same absolute-positioned/centered pattern as .wae-pulse-marker,
       just its own class since it lives in a different pane
       (overlayMouseTarget, not overlayLayer -- see that function's own
       comment) and isn't subject to the clickable-or-not toggle the
       abuse-report crosses are. */
    .wae-mark-marker{ position:absolute; transform:translate(-50%, -50%); cursor:pointer; line-height:0; }
    .wae-mark-marker svg{ display:block; }
    .wae-mark-form-link{ display:block; font-size:12px; margin-bottom:6px; }
    .wae-mark-row{ border:1px solid var(--wfmm-border, #e5e7eb); border-radius:6px; padding:6px 8px; margin-bottom:6px; }
    .wae-mark-row-main{ display:flex; align-items:center; gap:8px; }
    .wae-mark-row-name{ font-weight:600; font-size:12px; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .wae-mark-row-coord{ font-size:11px; color:var(--wfmm-muted-text, #667085); flex-shrink:0; }
    .wae-mark-row-delete{ flex-shrink:0; border:none; background:none; color:var(--wfmm-muted-text, #667085); font-size:16px; line-height:1; cursor:pointer; padding:0 2px; }
    .wae-mark-row-delete:hover{ color:#dc2626; }
    .wae-mark-row-note{ margin-top:4px; font-size:11px; color:var(--wfmm-muted-text, #667085); cursor:pointer; word-break:break-word; white-space:pre-wrap; }
    .wae-mark-row-note-empty{ font-style:italic; opacity:0.7; }
    .wae-mark-row-note-input{ margin-top:4px; width:100%; box-sizing:border-box; font:inherit; font-size:11px; resize:vertical; }
    .wae-csv-hint{ white-space:pre-line; font-family:ui-monospace, monospace; }
    /* BUGFIX (not upstream): the crosses/clusters this plugin draws on the
       map used to be google.maps.Marker instances with a data: URI SVG
       as their icon -- fine on Chrome, but reported (and confirmed
       against WFMM's own source: its directly analogous "Report History"
       pulse layer, pulse-layer.js, deliberately avoids Marker + icon
       images entirely) as considerably slower on Firefox once a dataset
       grew into the hundreds. Marker's icon is an <img>, which goes
       through the browser's IMAGE decode pipeline -- Firefox's is
       measurably heavier than Chrome's for many small repeated data:
       URIs specifically. WFMM's own pulse layer instead positions a
       plain CSS-styled <div> per point via a custom
       google.maps.OverlayView (see WaePulseOverlay in the script itself)
       -- these two rules are that div's real content now: the SVG shape
       is set as actual inline markup (real DOM/SVG rendering, the same
       pipeline as any other on-page SVG, not the image pipeline), and
       .wae-pulse-count is a plain positioned label over it for a
       cluster's count, replacing what used to be a Marker's built-in
       .setLabel().
    */
    .wae-pulse-marker{ position:absolute; transform:translate(-50%, -50%); pointer-events:none; line-height:0; }
    .wae-pulse-marker.wae-pulse-clickable{ pointer-events:auto; cursor:pointer; }
    .wae-pulse-marker svg{ display:block; }
    /* The invisible click-target twin WaePulseOverlayCtor's applyToDiv()
       creates in overlayMouseTarget -- see that class's own comment for
       why a second element is needed at all. opacity:0 (not visibility
       or display) so it still receives the DOM events overlayMouseTarget
       exists for, while never changing what's actually on screen -- the
       ORIGINAL div, still in overlayLayer, is what renders the visible
       cross/cluster graphic. */
    .wae-pulse-hit{ opacity:0; }
    .wae-pulse-count{ position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:#ffffff; font-size:10px; font-weight:700; pointer-events:none; user-select:none; }
    .wae-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    .wae-log{ margin-top:8px; max-height:110px; overflow-y:auto; font-size:11px; line-height:1.5; }
    .wae-log div.ok{ color:#16a34a; }
    .wae-log div.warn{ color:#b45309; }
    .wae-log div.err{ color:#dc2626; }
    .wae-search-input{ margin:6px 0; }
    /* Live Wayspot ticket annotation -- see waeStartSidePanelDetailsWatcher()'s
       own comment. Styled as a small badge-ish line (not plain text, and
       not one of the wae-status-badge pills either) so it reads as "this
       plugin added something here" without looking like it's part of
       Base's own card. */
    .wae-detail-ticket-line{
      font-size:11px; font-weight:600; color:#dc2626;
      margin:2px 0 6px; text-align:center;
    }
    /* "+" row (note field + button) added right alongside the
       ticket-number line above -- see waeStartSidePanelDetailsWatcher()'s
       own comment. A small plain button rather than a pill/badge like
       the ticket line itself, so it reads as clickable (an action)
       rather than as more status text. */
    .wae-detail-mark-row{ display:flex; align-items:stretch; gap:4px; margin:2px 0 6px; }
    .wae-detail-mark-note{
      flex:1 1 auto; min-width:0; padding:4px 6px;
      font-size:11px; font-family:Roboto, Arial, sans-serif;
      border:1px solid #c7d2fe; border-radius:5px; box-sizing:border-box;
    }
    .wae-detail-mark-btn{
      flex:0 0 auto; padding:4px 8px; white-space:nowrap;
      font-size:11px; font-weight:600; font-family:Roboto, Arial, sans-serif;
      color:#154aab; background:#eef2ff; border:1px solid #c7d2fe; border-radius:5px;
      cursor:pointer; text-align:center;
    }
    .wae-detail-mark-btn:hover{ background:#e0e7ff; }
    .wae-detail-mark-btn:disabled{ color:#16a34a; background:#f0fdf4; border-color:#bbf7d0; cursor:default; }
    /* Star toggle -- matches Report History's own \u2605/\u2606 button
       convention (plain glyph, no pill/border) rather than inventing a
       new visual language for what's already a familiar affordance. */
    .wae-star-cell{ text-align:center; cursor:pointer; }
    .wae-star-toggle{
      background:none; border:none; padding:0; margin:0; cursor:pointer;
      font-size:15px; line-height:1; color:#d97706;
    }
    .wae-star-toggle:hover{ color:#b45309; }
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
    .wae-table th:nth-child(1), .wae-table td:nth-child(1){ width: 5%; }
    .wae-table th:nth-child(2), .wae-table td:nth-child(2){ width: 8%; }
    .wae-table th:nth-child(3), .wae-table td:nth-child(3){ width: 19%; }
    .wae-table th:nth-child(4), .wae-table td:nth-child(4){ width: 9%; }
    .wae-table th:nth-child(5), .wae-table td:nth-child(5){ width: 9%; }
    .wae-table th:nth-child(6), .wae-table td:nth-child(6){ width: 5%; }
    .wae-table th:nth-child(7), .wae-table td:nth-child(7){ width: 5%; }
    .wae-table th:nth-child(8), .wae-table td:nth-child(8){ width: 18%; }
    .wae-table th:nth-child(9), .wae-table td:nth-child(9){ width: 22%; }
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

    /* Review page (/new/review) toggle bar -- see waeInjectReviewToggle()'s
       and waePlaceReviewToggle()'s own comments for the full history.
       Lives in the page's own normal flow, directly under host inside
       waePlaceReviewToggle()'s own wrapper div (no position:fixed, no
       JS-computed top/left) -- v1.47.0's fixed-on-document.body version
       fixed a real placement bug but left the bar visibly floating a
       frame behind the page during scroll/resize; the wrapper's flex
       column keeps it pinned directly under the map without that.
       Kept its own opaque background/border/shadow even though it's
       embedded now rather than floating over arbitrary content --
       review cards can still place it next to a photo carousel or
       other non-uniform background, and it doubles as a visual
       separator between the map and whatever the reviewer's own
       controls render right below this bar.
       Dark/light color pair is chosen by the .wae-review-dark class,
       which waeInjectReviewToggle() sets directly on the bar itself from
       host.closest('.dark') rather than a ".dark .wae-review-toggle-bar"
       descendant selector, so it keeps working regardless of exactly
       where in the DOM the bar ends up relative to whatever ancestor
       carries that class. The prefers-color-scheme block stays too,
       purely as a fallback for the (currently unobserved) case of no
       ".dark" ancestor at all. */
    .wae-review-toggle-bar{
      position:static; box-sizing:border-box;
      display:flex; align-items:center; justify-content:space-between; gap:10px;
      margin:6px 0; padding:6px 10px; border-radius:6px;
      background:#ffffff; color:#111827; border:1px solid #d1d5db;
      box-shadow:0 1px 3px rgba(0,0,0,0.15);
      font-family:Roboto, Arial, sans-serif; font-size:12px; font-weight:600;
    }
    .wae-review-toggle-label{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .wae-review-toggle-btn{
      min-width:44px; padding:3px 10px; border-radius:9999px; cursor:pointer;
      font-size:11px; font-weight:700; line-height:1.4; flex-shrink:0;
      background:transparent; color:#111827; border:1px solid currentColor;
    }
    .wae-review-toggle-btn.wae-review-toggle-on{
      background:#16a34a; color:#ffffff; border-color:#15803d;
    }
    @media (prefers-color-scheme: dark){
      .wae-review-toggle-bar{ background:#1f2937; color:#f9fafb; border-color:#4b5563; box-shadow:0 2px 6px rgba(0,0,0,0.5); }
      .wae-review-toggle-btn{ color:#f9fafb; }
      .wae-review-toggle-btn.wae-review-toggle-on{ background:#22c55e; color:#052e16; border-color:#16a34a; }
    }
    .wae-review-toggle-bar.wae-review-dark{ background:#1f2937; color:#f9fafb; border-color:#4b5563; box-shadow:0 2px 6px rgba(0,0,0,0.5); }
    .wae-review-toggle-bar.wae-review-dark .wae-review-toggle-btn{ color:#f9fafb; }
    .wae-review-toggle-bar.wae-review-dark .wae-review-toggle-btn.wae-review-toggle-on{ background:#22c55e; color:#052e16; border-color:#16a34a; }
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
    // Not a real ticket status at all -- see waeParseCsvImport()'s own
    // comment. Placed last so sorting by Status still puts every genuine
    // abuse-report pipeline stage before it, rather than interleaving
    // with them at whatever rank an unrecognized value would otherwise
    // fall back to.
    CSV_IMPORT: { label: 'Imported', color: '#7c3aed' },
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

  // Identity key for carrying a starred flag across a re-scan -- NOT the
  // record's own `id`, which isn't reliably stable between scans (a
  // ticket's row count can change if extraction finds more/fewer
  // locations than last time, shifting the "conv:X:0"/"conv:X:1"-style
  // index suffixes -- see the scan handler's own "Rebuild from scratch"
  // comment for why that already rules out id-based upserting for the
  // rows themselves, and the same instability applies here). Coordinates
  // are what actually identify "the same real-world location" across two
  // scans of the same source emails, so ticket + coordinates is used
  // instead wherever a record has them; falling back to ticket + name for
  // the (rarer) case of a starred record with no coordinates, since
  // there's nothing else stable enough to key on there.
  function waeStarredKey(r) {
    const ticket = r.conversationId || r.sourceEmailId || '';
    if (Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
      return `${ticket}|${r.latitude.toFixed(6)},${r.longitude.toFixed(6)}`;
    }
    return `${ticket}|name:${r.wayspotName || ''}`;
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
        // BUGFIX (not upstream): label was '' (matching the Comment/
        // Nearby icon columns, which are correctly blank since they're
        // NOT sortable) -- but combined with sortable: true, table()'s
        // own header-building code (children: [column.label ?? column.key,
        // marker]) renders a real, clickable sort button with genuinely
        // no visible text before it's ever been sorted by, since ''
        // isn't nullish and so doesn't fall through to column.key
        // either. The button technically existed and worked, there was
        // just nothing to see or reliably click -- reported as sorting
        // by star not being possible at all. A literal star as the
        // header label fixes both at once: something visible to click,
        // and it reads as "this column is about stars" on its own.
        key: 'starred', label: '\u2605', sortable: true, cellClassName: 'wae-star-cell',
        render: (r) => waeUiApi.createElement('button', {
          className: 'wae-star-toggle',
          text: r.starred ? '\u2605' : '\u2606',
          attrs: { type: 'button', title: r.starred ? 'Unstar' : 'Star' },
        }),
      },
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
        const starToggle = event.target.closest('.wae-star-toggle');
        if (starToggle) {
          event.stopPropagation();
          const next = !record.starred;
          record.starred = next;
          starToggle.textContent = next ? '\u2605' : '\u2606';
          starToggle.title = next ? 'Unstar' : 'Star';
          // Fire-and-forget, same as Report History's own equivalent --
          // the visible toggle above already happened, so a slow/failed
          // write shouldn't block or roll back what the user just saw
          // happen. putExtractedRecords() upserts by id, and `record` is
          // the exact same object already held in waeAllRecords (not a
          // copy), so this persists the one changed field without
          // needing to touch or re-fetch anything else on the row.
          putExtractedRecords([record]).catch((e) => {
            if (waeUI) log(waeUI.logEl, `\u2717 Could not save star: ${e.message || e}`, 'err');
          });
          return;
        }
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
    if (waeSortKey === 'starred') {
      // Ascending (the default the first time this header's clicked)
      // means starred-first here, not literally "false before true" --
      // that reads as the useful default (show me what I starred),
      // matching Report History's own "Starred first" wording for what
      // amounts to the same sort.
      compare = (a, b) => dir * ((a.starred ? 0 : 1) - (b.starred ? 0 : 1));
    } else if (waeSortKey === 'conversation') {
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
      // Keeps waeEnsureRecordsLoaded()'s cache in sync with this fresher
      // read, rather than leaving it pointed at whatever (possibly
      // stale, possibly still-empty) data it resolved with earlier --
      // a review map or a layer toggle-on right after this shouldn't
      // redraw from data older than what the panel itself just showed.
      waeRecordsLoadPromise = Promise.resolve(waeAllRecords);
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
    // BUGFIX: see waeEnsureRecordsLoaded()'s own comment -- opening the
    // panel used to only ever refresh the table, never the map, so
    // whichever surface (mapview/submit crosses, the review-page
    // markers) happened to already be attached wouldn't pick up
    // whatever just loaded here until its own next pan/zoom. Only
    // redraws a surface that's actually attached right now -- this
    // isn't what makes either surface attach or turn on in the first
    // place, same restraint waeSaveAppearance() already applies.
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
    if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();
  }

  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Marked Wayspots -- feature request: a "+" button on the Wayspot
  // details side panel (see waeStartSidePanelDetailsWatcher(), where it's
  // actually added -- right alongside the existing ticket-number
  // annotation, per the request) records the currently-shown Wayspot's
  // name/coordinates into a small persistent list, editable with a
  // per-entry note, viewable/copyable/clearable from its own modal
  // (waeOpenMarkedWayspotListModal(), opened via markListBtn on the main
  // panel). Meant as a scratch list to copy from while filing an actual
  // abuse report elsewhere (Niantic's own form/email), not a duplicate of
  // the ticket-tracking table above -- nothing here reads from or writes
  // to waeAllRecords/the extracted-report storage.
  //
  // Persisted via WFMM.settings, same mechanism as appearance/
  // autoCloseOnNavigate elsewhere in this file -- a handful to a few
  // dozen manually-marked entries is a trivially small amount of data
  // next to what that's already used for.
  //
  // (Two earlier approaches to WHERE/HOW this "+" gets clicked didn't
  // survive first contact with real use: a capturing map-click listener
  // that could only guess at the Wayspot's name since Wayfarer's markers
  // render through deck.gl with no DOM element to read one off, then a
  // global "arm marking mode, then click a Wayspot" toggle once the name
  // problem was fixed via WFMM.selection/WFMM.pois -- reported back as
  // not the wanted interaction. Individual Wayspots need their own "+",
  // not a separate mode, hence this landing in the side panel instead.)
  // ---------------------------------------------------------------------

  const WAE_MARK_LIST_SETTINGS_KEY = 'markedWayspots';

  function waeLoadMarkedWayspots() {
    try {
      const list = wfmmWindow.WFMM.settings.get(PLUGIN_ID, WAE_MARK_LIST_SETTINGS_KEY, []);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function waeSaveMarkedWayspots(list) {
    try {
      wfmmWindow.WFMM.settings.set(PLUGIN_ID, WAE_MARK_LIST_SETTINGS_KEY, list);
    } catch (e) { /* ignore -- next mutation attempt will just try again */ }
  }

  function waeAddMarkedWayspot({ name, lat, lng, note }) {
    const list = waeLoadMarkedWayspots();
    // Feature request: adding a Wayspot that's already on this list --
    // matched on coordinates, not name, since the side-panel title can
    // read blank/"Untitled location" for the very same physical Wayspot
    // depending on what happened to be rendered at click time (see this
    // watcher's own name-reading comment above) -- now updates that
    // existing entry's note in place instead of pushing a second entry
    // for the same Wayspot. Coordinates come from the same WFMM/side-panel
    // source every time, so an exact match at toFixed(6) precision -- the
    // same precision this file already keys duplicate/identity checks on
    // elsewhere (the CSV-row key, the review-page pulse key) -- is enough
    // here; no Haversine "nearby" fuzz-match needed the way it is for
    // independently-typed abuse-report coordinates (waeFindNearbyDuplicates()).
    const existing = list.find((item) =>
      Number(item.lat).toFixed(6) === Number(lat).toFixed(6) &&
      Number(item.lng).toFixed(6) === Number(lng).toFixed(6)
    );
    let result;
    if (existing) {
      existing.note = note || '';
      // Keep the name in sync too, but only ever upgrade a blank one --
      // never clobber a real title with a blank one from a stale re-read.
      if (name) existing.name = name;
      existing.markedAt = Date.now();
      result = 'updated';
    } else {
      list.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name || '',
        lat,
        lng,
        note: note || '',
        markedAt: Date.now(),
      });
      result = 'added';
    }
    waeSaveMarkedWayspots(list);
    waeMarkListRenderHook?.();
    waeRenderMarkedWayspotMarkers();
    return result;
  }

  // Set by waeRenderMarkedWayspotListSection() (below) to its own render()
  // while that modal is open, cleared on close -- lets waeAddMarkedWayspot()
  // above keep the list modal's own view in sync with entries added by
  // clicking the map WHILE the list modal happens to already be open,
  // without the two having any other reference to each other.
  let waeMarkListRenderHook = null;

  // ---------------------------------------------------------------------
  // Feature request: a visual marker on the map (mapview/submit) for
  // every entry on the Marked Wayspots list, not just an entry in the
  // list modal -- a small filled dot, default blue, in a color this
  // plugin's own Marker Style settings can change (see
  // waeRenderMarkerStyleSection()'s new markColorInput) just like the
  // abuse-report cross/cluster color already is. Deliberately its own,
  // much simpler OverlayView -- no clustering (this list is manually
  // curated, realistically never dense enough to need it the way
  // hundreds of scanned tickets are) and a single div per marker rather
  // than WaePulseOverlayCtor's visible+hit-div pair, added straight to
  // overlayMouseTarget: there's no "stay visually under real Wayspot
  // markers" requirement for these the way there is for abuse-report
  // crosses (see THAT class's own comment for why it's split there), so
  // nothing here needs to trade away reliable clicks (see v1.50.2's own
  // changelog entry) to get it.
  // ---------------------------------------------------------------------

  // Feature request: an "X" cross, same glyph as waeGetMarkerSvgMarkup()'s
  // own abuse-report markers (see that function's own comment for why a
  // cross rather than a filled circle/pin in the first place -- it reads
  // as "a problem here", not just another POI dot), just in this list's
  // own configurable color instead of fillColor. Reuses the same size
  // math (markerSize * 2 viewbox, 0.35 arm length, stroke scaled off
  // markerSize) so the two marker types stay visually consistent in
  // scale too, not just in shape -- there's no separate "Marked Wayspot
  // size" control, this rides on the same markerSize the abuse-report
  // crosses use.
  //
  // BUGFIX (not upstream, performance): used to rebuild this SVG string
  // from scratch on every single call -- i.e. once per marker, on every
  // single waeRenderMarkedWayspotMarkers() pass, even though every marker
  // in a given pass shares the exact same color and markerSize (there's
  // one global setting for each, not a per-entry one). WAE_MARKER_ICON/
  // WAE_CLUSTER_ICON above cache the same way for the same reason, just
  // invalidated externally (from waeSaveAppearance(), since those two
  // read appearance internally rather than taking it as a parameter) --
  // this one instead compares its own last-seen color/markerSize against
  // the current call's before deciding whether to rebuild, since color is
  // already threaded in as a parameter here. Self-contained rather than
  // one more place waeSaveAppearance() has to remember to reach into.
  let WAE_MARK_ICON = { color: null, markerSize: null, svg: null };
  function waeGetMarkedWayspotSvgMarkup(color) {
    const markerSize = waeLoadAppearance().markerSize;
    if (WAE_MARK_ICON.color === color && WAE_MARK_ICON.markerSize === markerSize) {
      return WAE_MARK_ICON.svg;
    }
    const size = markerSize * 2;
    const half = size / 2;
    const arm = size * 0.35;
    const stroke = Math.max(2, Math.round(markerSize * 0.45));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<line x1="${half - arm}" y1="${half - arm}" x2="${half + arm}" y2="${half + arm}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + `<line x1="${half + arm}" y1="${half - arm}" x2="${half - arm}" y2="${half + arm}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + '</svg>';
    WAE_MARK_ICON = { color, markerSize, svg };
    return svg;
  }

  function waeShowMarkedWayspotInfoWindow(item, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_PULSES.map) return;
    if (!WAE_PULSES.infoWindow) WAE_PULSES.infoWindow = new google.maps.InfoWindow();
    const name = escapeHtml(item.name || '(unnamed)');
    const parts = [`<div style="font-size:12px;max-width:260px;"><strong>${name}</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    if (item.note) parts.push(`<div style="margin-top:4px;color:#6b7280;word-break:break-word;white-space:pre-wrap;">${escapeHtml(item.note)}</div>`);
    parts.push('</div>');
    WAE_PULSES.infoWindow.setContent(parts.join(''));
    WAE_PULSES.infoWindow.setPosition(latLng);
    WAE_PULSES.infoWindow.open(WAE_PULSES.map);
  }

  let WaeMarkMarkerOverlayCtor = null;
  function waeEnsureMarkMarkerOverlayCtor() {
    if (WaeMarkMarkerOverlayCtor) return true;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return false;
    WaeMarkMarkerOverlayCtor = class extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = null;
        this.latLng = null;
        this.item = null;
      }
      onAdd() {
        const div = document.createElement('div');
        div.className = 'wae-mark-marker';
        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.item && this.latLng) waeShowMarkedWayspotInfoWindow(this.item, this.latLng);
        });
        this.div = div;
        // overlayMouseTarget, not overlayLayer -- see this section's own
        // top comment: unlike WaePulseOverlayCtor's crosses, there's no
        // "must not visually cover a real marker" requirement to trade
        // against reliable clicks here (see v1.50.2's own changelog
        // entry for why overlayLayer alone can't ever deliver those).
        this.getPanes().overlayMouseTarget.appendChild(div);
        this.applyToDiv();
        this.draw();
      }
      draw() {
        if (!this.div || !this.latLng) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(this.latLng);
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
      }
      getPosition() {
        return this.latLng;
      }
      applyToDiv() {
        if (!this.div || !this.item) return;
        this.div.innerHTML = waeGetMarkedWayspotSvgMarkup(this._color);
        this.div.title = this.item.name || '(unnamed)';
      }
      setItem(item, color) {
        this.item = item;
        this._color = color;
        this.latLng = new google.maps.LatLng(item.lat, item.lng);
        this.applyToDiv();
        this.draw();
      }
    };
    return true;
  }

  // id -> overlay instance, reused across refreshes the same way
  // WAE_PULSES.markersById is -- redrawing everything from scratch on
  // every add/delete/map-change would work too, but this way an entry
  // that didn't change (position, color) doesn't churn its own DOM node
  // for no reason.
  const waeMarkMarkerOverlays = new Map();

  function waeClearMarkedWayspotMarkers() {
    for (const overlay of waeMarkMarkerOverlays.values()) overlay.setMap(null);
    waeMarkMarkerOverlays.clear();
  }

  // Called on every list mutation (add/delete/clear -- see this
  // feature's own call sites) and on every map change (waeSetCurrentMap())
  // -- no viewport/idle-based redraw the way waeSafeRefreshPulses() needs
  // (see that function's own comment): a manually-curated list is
  // realistically never large enough that redrawing the whole thing on
  // every one of those triggers is worth debouncing against a map pan.
  function waeRenderMarkedWayspotMarkers() {
    const map = WAE_PULSES.map;
    // Gated on isMapPulsesEnabled() (the "Abuse Report Crosses" Layers-menu
    // checkbox) same as the abuse-report crosses/clusters themselves --
    // added in v1.53.4, see that changelog entry for why this was missing
    // up to v1.53.3. Centralizing the check here, rather than at each of
    // this function's call sites, is what makes every one of them --
    // add/edit/delete/clear-list, marker-style changes, a fresh map
    // attach -- respect the toggle without having to touch them individually.
    if (!map || !isMapPulsesEnabled() || !waeEnsureMarkMarkerOverlayCtor()) {
      waeClearMarkedWayspotMarkers();
      return;
    }
    const color = waeLoadAppearance().markColor;
    const list = waeLoadMarkedWayspots();
    const seen = new Set();
    for (const item of list) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) continue;
      seen.add(item.id);
      let overlay = waeMarkMarkerOverlays.get(item.id);
      if (!overlay) {
        overlay = new WaeMarkMarkerOverlayCtor();
        waeMarkMarkerOverlays.set(item.id, overlay);
      }
      overlay.setItem(item, color);
      if (overlay.getMap() !== map) overlay.setMap(map);
    }
    for (const [id, overlay] of waeMarkMarkerOverlays) {
      if (!seen.has(id)) {
        overlay.setMap(null);
        waeMarkMarkerOverlays.delete(id);
      }
    }
  }

  async function waeCopyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the execCommand fallback below */ }
    // Fallback for a context where the async Clipboard API isn't
    // available/permitted (an insecure context, or a permission
    // prompt that was denied) -- the old hidden-textarea +
    // execCommand('copy') trick, synchronous and far less capable but
    // reliable enough for a plain-text copy.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) {
      return false;
    }
  }

  function waeFormatMarkedWayspotLine(item) {
    const name = item.name || '(unnamed)';
    const coords = `${Number(item.lat).toFixed(6)}, ${Number(item.lng).toFixed(6)}`;
    return item.note ? `${name}, ${coords} (${item.note})` : `${name}, ${coords}`;
  }

  // One list row: name/coords/delete on the first line, a click-to-edit
  // note below it. Feature request, exact interaction as specified:
  // clicking the note line opens a textarea; a second click OUTSIDE that
  // textarea closes it again and stores whatever's in it. Implemented
  // with a capturing 'mousedown' listener on the document (checking
  // whether the click landed inside the textarea, not any particular
  // element outside it) rather than the textarea's own 'blur' -- blur
  // alone is unreliable here since not every element that can be clicked
  // is itself focusable, and this needs to catch literally any outside
  // click, not just a focus change.
  function waeBuildMarkedWayspotRow(item, ui, onDelete) {
    const row = ui.createElement('div', { className: 'wae-mark-row' });
    const mainLine = ui.createElement('div', { className: 'wae-mark-row-main' });
    const nameEl = ui.createElement('span', { className: 'wae-mark-row-name', text: item.name || '(unnamed)' });
    const coordEl = ui.createElement('span', { className: 'wae-mark-row-coord', text: `${Number(item.lat).toFixed(6)}, ${Number(item.lng).toFixed(6)}` });
    const deleteBtn = ui.createElement('button', { className: 'wae-mark-row-delete', text: '\u00d7', attrs: { type: 'button', title: 'Remove from list' } });
    mainLine.append(nameEl, coordEl, deleteBtn);

    const noteEl = ui.createElement('div', {
      className: `wae-mark-row-note${item.note ? '' : ' wae-mark-row-note-empty'}`,
      text: item.note || 'Click to add a note\u2026',
    });
    row.append(mainLine, noteEl);

    deleteBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      waeSaveMarkedWayspots(waeLoadMarkedWayspots().filter((x) => x.id !== item.id));
      waeRenderMarkedWayspotMarkers();
      onDelete(row);
    });

    noteEl.addEventListener('click', () => {
      if (row.querySelector('textarea')) return; // already open
      const textarea = ui.createElement('textarea', {
        className: 'wae-mark-row-note-input',
        attrs: { rows: '2' },
      });
      textarea.value = item.note || '';
      row.replaceChild(textarea, noteEl);
      textarea.focus();
      textarea.select();

      const commit = () => {
        document.removeEventListener('mousedown', onOutsideMouseDown, true);
        const value = textarea.value.trim();
        item.note = value;
        waeSaveMarkedWayspots(waeLoadMarkedWayspots().map((x) => (x.id === item.id ? { ...x, note: value } : x)));
        noteEl.textContent = value || 'Click to add a note\u2026';
        noteEl.classList.toggle('wae-mark-row-note-empty', !value);
        if (row.contains(textarea)) row.replaceChild(noteEl, textarea);
      };
      const onOutsideMouseDown = (ev) => {
        if (!textarea.contains(ev.target)) commit();
      };
      // Deferred to the next tick so the SAME click that just opened
      // this editor (still being dispatched) isn't immediately treated
      // as the "outside" click that closes it right back again.
      setTimeout(() => document.addEventListener('mousedown', onOutsideMouseDown, true), 0);
    });

    return row;
  }

  function waeRenderMarkedWayspotListSection(ui, body) {
    const listContainer = ui.createElement('div', { className: 'wae-mark-list' });
    const emptyEl = ui.createElement('div', {
      className: 'wae-sub',
      text: 'No wayspots marked yet -- use the + button on the main panel, then click a Wayspot on the map.',
    });
    // Feature request: a quick link to Niantic's own "Reporting Abuse in
    // Wayfarer" Help Center article right on this list -- where the
    // entries actually get copied FROM before going to file the report,
    // not the extracted-ticket table elsewhere in this plugin, which is
    // about reports already filed rather than about to be.
    const formLinkEl = ui.createElement('a', {
      className: 'wae-mark-form-link',
      text: 'Report abuse via Wayfarer Help Center \u2197',
      attrs: {
        href: 'https://scopelyexplore.helpshift.com/hc/en/10-wayfarer/faq/1999-reporting-abuse-in-wayfarer/',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    });
    const copyAllBtn = ui.button({ text: 'Copy All', disabled: true });
    const clearAllBtn = ui.button({ text: 'Clear All', variant: 'danger', disabled: true });
    const buttonRow = ui.buttonRow([copyAllBtn, clearAllBtn]);

    function render() {
      listContainer.innerHTML = '';
      const list = waeLoadMarkedWayspots();
      copyAllBtn.disabled = !list.length;
      clearAllBtn.disabled = !list.length;
      if (!list.length) {
        listContainer.append(emptyEl);
        return;
      }
      for (const item of list) {
        listContainer.append(waeBuildMarkedWayspotRow(item, ui, (rowEl) => {
          rowEl.remove();
          if (!waeLoadMarkedWayspots().length) render();
          else { copyAllBtn.disabled = false; clearAllBtn.disabled = false; }
        }));
      }
    }

    copyAllBtn.addEventListener('click', async () => {
      const list = waeLoadMarkedWayspots();
      if (!list.length) return;
      const ok = await waeCopyToClipboard(list.map(waeFormatMarkedWayspotLine).join('\n'));
      copyAllBtn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => { copyAllBtn.textContent = 'Copy All'; }, 1500);
    });

    clearAllBtn.addEventListener('click', () => {
      if (!waeLoadMarkedWayspots().length) return;
      if (!confirm('Clear the entire marked-wayspots list? This cannot be undone.')) return;
      waeSaveMarkedWayspots([]);
      waeRenderMarkedWayspotMarkers();
      render();
    });

    body.append(formLinkEl, buttonRow, listContainer);
    render();
    waeMarkListRenderHook = render;

    return {
      onOk() { return true; }, // no-op -- every action above already saves on its own
    };
  }

  let waeMarkListController = null;
  function waeOpenMarkedWayspotListModal() {
    if (waeMarkListController) return; // already open
    waeMarkListController = wfmmWindow.WFMM.ui.openModal({
      id: 'wae-mark-list',
      title: 'Abuse Reports - Marked Wayspots',
      className: 'wae-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      desktopInteractions: { minWidth: 360, minHeight: 320 },
      buildContent(modal) {
        return waeRenderMarkedWayspotListSection(modal.ui, modal.body);
      },
      onClose() {
        waeMarkListController = null;
        waeMarkListRenderHook = null;
      },
    });
  }
  // ---------------------------------------------------------------------

  // Marker Style settings -- its own modal, opened from a small cog
  // button next to the tool panel's title (see buildPanelContent()),
  // rather than living inline at the bottom of the panel where it used
  // to. Kept as a separate modal (not folded back into the main panel)
  // because the {onOk}-returning renderXSection(body) shape -- same
  // pattern the suite's own bundled Planner plugin uses for its own
  // settings, see renderPlannerMarkerSettingsSection()/
  // createPlannerSettingsModal()'s own openSettings() in Base's source
  // -- is what waeOpenMarkerSettingsModal() below wraps with
  // WFMM.ui.openModal(). Every control here still applies (and persists)
  // immediately on change, matching how this section already behaved
  // when it lived inline -- so onOk here is just a no-op to satisfy
  // openModal()'s contentHooks contract, not a real save step.
  //
  // This used to also get its own entry in the native Settings side-
  // panel list (WFMM.sidePanel.appendSettingsAction(), see
  // attachSettingsActions()) -- removed as more than this one small
  // setting needed: it's a once-in-a-while adjustment, not something
  // that belongs competing for attention in the Settings list the way a
  // whole plugin's own entry point does. A literal new tab inside
  // WFMM's own native Settings window (the Side Panels & UI / Markers /
  // Map / Planner / ... tabbed modal opened from the gear icon) was
  // never an option regardless -- confirmed against Base's own
  // settings-hub source, that modal's own SECTIONS list is an
  // Object.freeze()'d array, and the function that renders a given
  // section's body hardcodes each non-generic one to a specific bundled
  // plugin by id, with no registerSection()-style hook an externally-
  // registered plugin like this one can call into.
  function waeRenderMarkerStyleSection(ui, body) {
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
      onInput: (v) => {
        updateAppearance({ markerSize: Number(v) });
        // Marked Wayspots' own crosses ride on this same markerSize now
        // (see waeGetMarkedWayspotSvgMarkup()) -- redraw them too,
        // same as the abuse-report crosses eventually pick this up via
        // waeSafeRefreshPulses(), just immediately rather than waiting
        // for the next map idle since these aren't on that refresh cycle.
        waeRenderMarkedWayspotMarkers();
      },
    });
    // BUGFIX (not upstream, feature request): this used to be the same
    // markerSize as the cross above (waeGetClusterIcon() just multiplied
    // it by a fixed 1.15) -- decoupled into its own field/control, see
    // WAE_APPEARANCE_DEFAULTS.clusterMarkerSize's own comment. Cluster
    // markers ALSO get bigger automatically at the lowest zoom level
    // (see WAE_CLUSTER_EXPAND_FACTOR) -- that expansion isn't a separate
    // control here, it's a fixed multiplier applied on top of whatever
    // size is set below, only while zoomed all the way out.
    const styleClusterSizeRange = ui.rangeInput({
      min: 4, max: 24, step: 1, value: initialAppearance.clusterMarkerSize,
      formatValue: (v) => `${v}px`,
      onInput: (v) => updateAppearance({ clusterMarkerSize: Number(v) }),
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
        styleClusterSizeRange.input.value = String(d.clusterMarkerSize);
        styleClusterSizeRange.valueEl.textContent = `${d.clusterMarkerSize}px`;
        styleFillOpacityRange.input.value = String(d.fillOpacity);
        styleFillOpacityRange.valueEl.textContent = `${Math.round(d.fillOpacity * 100)}%`;
        styleBorderWidthRange.input.value = String(d.borderWidth);
        styleBorderWidthRange.valueEl.textContent = `${d.borderWidth}px`;
        styleBorderOpacityRange.input.value = String(d.borderOpacity);
        styleBorderOpacityRange.valueEl.textContent = `${Math.round(d.borderOpacity * 100)}%`;
        styleClickableToggle.input.checked = d.clickable;
        styleMarkColorInput.value = d.markColor;
        waeRenderMarkedWayspotMarkers();
      },
    });
    const styleClickableToggle = ui.checkboxRow({
      label: 'Clickable markers (mapview/submit only)',
      checked: initialAppearance.clickable,
      onChange: (checked) => updateAppearance({ clickable: checked }),
    });
    // Feature request: color for the separate Marked Wayspots dots (see
    // waeRenderMarkedWayspotMarkers()) -- a distinct field/control from
    // fillColor above since it's a genuinely different marker type (this
    // plugin's own scratch list, not an extracted abuse-report ticket),
    // re-rendering those dots immediately on change the same way
    // updateAppearance()'s other onInput handlers apply immediately to
    // the crosses/clusters -- WFMM.settings alone doesn't redraw
    // anything already on screen, this plugin has to do that itself.
    const styleMarkColorInput = ui.colorInput({
      value: initialAppearance.markColor,
      onInput: (v) => {
        updateAppearance({ markColor: v });
        waeRenderMarkedWayspotMarkers();
      },
    });
    const styleSection = ui.section({
      title: 'Marker Style',
      hint: 'Color/size for the map markers this plugin draws (single reports and clusters). Changes apply immediately.',
      children: [
        ui.fieldRow({ label: 'Color', input: styleColorInput }),
        ui.fieldRow({ label: 'Cross size', input: styleSizeRange.row, help: 'Single-report \u201cX\u201d markers.' }),
        ui.fieldRow({ label: 'Cluster size', input: styleClusterSizeRange.row, help: `Multi-report \u201cheatmap\u201d markers. Automatically shown ${WAE_CLUSTER_EXPAND_FACTOR}\u00d7 bigger at the lowest zoom level.` }),
        ui.fieldRow({ label: 'Fill opacity', input: styleFillOpacityRange.row, help: 'Only visible on cluster markers -- a single X marker is always fully opaque.' }),
        ui.fieldRow({ label: 'Ring color', input: styleBorderColorInput, help: 'Cluster markers only.' }),
        ui.fieldRow({ label: 'Ring width', input: styleBorderWidthRange.row }),
        ui.fieldRow({ label: 'Ring opacity', input: styleBorderOpacityRange.row }),
        styleClickableToggle.row,
        ui.fieldRow({ label: 'Marked Wayspot color', input: styleMarkColorInput, help: 'The dot shown for entries on your Marked Wayspots list.' }),
        ui.buttonRow([resetStyleBtn]),
      ],
    });
    body.append(styleSection);
    return {
      onOk() { return true; }, // no-op -- every control above already saved on its own onInput/onChange
    };
  }

  let waeMarkerSettingsController = null;
  function waeOpenMarkerSettingsModal() {
    if (waeMarkerSettingsController) return; // already open
    waeMarkerSettingsController = wfmmWindow.WFMM.ui.openModal({
      id: 'wae-marker-settings',
      title: 'Abuse Reports - Marker Style',
      className: 'wae-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      desktopInteractions: { minWidth: 360, minHeight: 280 },
      buildContent(modal) {
        return waeRenderMarkerStyleSection(modal.ui, modal.body);
      },
      onClose() {
        waeMarkerSettingsController = null;
      },
    });
  }
  // ---------------------------------------------------------------------

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
    const importCsvBtn = ui.button({ text: 'Import CSV' });
    const exportBtn = ui.button({ text: 'Export CSV', disabled: true });
    const clearBtn = ui.button({ text: 'Clear Extracted Data', variant: 'danger', disabled: true });
    const buttonRowEl = ui.buttonRow([scanBtn, importCsvBtn, exportBtn, clearBtn]);
    const csvFileInput = ui.createElement('input', {
      attrs: { type: 'file', accept: '.csv,text/csv' },
      style: { display: 'none' },
    });
    // Always visible, not just shown after a failed import -- the whole
    // point is knowing the format going in, not finding out by trial and
    // error. Latitude/Longitude are the only columns waeParseCsvImport()
    // actually requires; everything else in this example is there to
    // show what else it recognizes, not because a real file needs them.
    // The header and its data row are on separate lines (.wae-csv-hint
    // has white-space:pre-line for this) rather than run together with
    // "then", so the example actually reads like a real CSV instead of
    // a sentence describing one.
    const csvHint = ui.createElement('div', {
      className: 'wae-sub wae-csv-hint',
      text: 'Import CSV expects a header row -- only Latitude/Longitude are required. Example:\nLatitude,Longitude,Name,Comment,Conversation ID\n52.006199,4.535424,Example Wayspot,Optional note,12345',
    });

    const progressEl = ui.createElement('div', { className: 'wae-progress' });

    const searchInput = ui.textInput({
      className: 'wfmm-input wfmm-input-large wae-search-input',
      placeholder: 'Search name, ticket, location/report text\u2026',
    });

    const autoCloseToggle = ui.checkboxRow({
      label: 'Close this panel when a row jumps the map to its location',
      checked: waeAutoCloseOnNavigateEnabled(),
      onChange: (checked) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'autoCloseOnNavigate', checked),
    });

    const tableContainer = ui.createElement('div', { className: 'wae-table-container' });
    const logEl = ui.createElement('div', { className: 'wae-log' });

    // ---- Marked Wayspots ----
    // List icon -- opens the modal listing everything marked so far via
    // the "+" on the Wayspot details side panel (see
    // waeStartSidePanelDetailsWatcher()), with its own Copy All/Clear
    // All (waeOpenMarkedWayspotListModal()). Same tucked-next-to-the-
    // summary-line treatment as markerStyleBtn/emailImporterBtn below,
    // for the same reason: a once-in-a-while tool, not something that
    // should compete with the table/export/scan controls every time the
    // panel opens.
    const markListBtn = ui.iconButton({
      iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
      title: 'Marked Wayspots List',
      onClick: () => waeOpenMarkedWayspotListModal(),
    });

    // ---- Marker Style ----
    // BUGFIX (not upstream, feature request): used to also have its own
    // entry in the native Settings side-panel list -- see
    // attachSettingsActions()'s own comment for why that was more than
    // this one setting needed. This cog button is now the only way in:
    // tucked out of the way next to the panel's own summary line rather
    // than sitting in the panel as a labeled button by default, so it
    // doesn't compete for attention with the table/export/scan controls
    // every time the panel opens -- the same reasoning as it having its
    // own modal at all (see waeRenderMarkerStyleSection()'s own comment).
    const markerStyleBtn = ui.iconButton({
      iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
      title: 'Marker Style Settings',
      onClick: () => waeOpenMarkerSettingsModal(),
    });

    // ---- Email Importer ----
    // Same treatment as markerStyleBtn just above, for the same reason:
    // the companion Abuse Email Importer script (a separate userscript --
    // it needs GM_xmlhttpRequest for Gmail OAuth, a sandbox-only API, so
    // it can't run @inject-into page the way this script does, and so
    // can't just be merged into this file outright) used to add its own
    // separate "Import Abuse Report Emails" entry to Base's Settings
    // side-panel list -- removed as of its own v4.10.0, in favor of this
    // one small envelope icon here instead, so there's exactly one entry
    // in that list ("Abuse Reports") rather than two separate
    // ones a reviewer would have to know to look for individually.
    // Both scripts run in the same page-context window (this script via
    // @inject-into page; the importer's own wfmmWindow resolves to
    // unsafeWindow, which IS that same window -- see its own comment on
    // that declaration), so window.WayfarerAbuseEmailImporter is a plain,
    // synchronously-available object here, not something that needs
    // fetching or waiting on -- checked fresh on every click (not just
    // once at panel-build time) since the two scripts' own startup timing
    // relative to each other isn't guaranteed, and the importer script
    // being missing/not-yet-loaded is a perfectly normal state (it's an
    // optional companion script, not a dependency) rather than an error.
    const emailImporterBtn = ui.iconButton({
      iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22 6 12 13 2 6"></polyline></svg>',
      title: 'Import Abuse Report Emails',
      onClick: () => {
        const wei = window.WayfarerAbuseEmailImporter;
        if (wei && typeof wei.togglePanel === 'function') {
          wei.togglePanel();
        } else {
          log(logEl, '\u2717 Abuse Email Importer script not detected -- install/enable it to import from Gmail or .eml files.', 'err');
        }
      },
    });

    const panelHeaderRow = ui.createElement('div', { className: 'wae-panel-header-row' });
    const panelHeaderActions = ui.createElement('div', { className: 'wae-panel-header-actions' });
    panelHeaderActions.append(markListBtn, emailImporterBtn, markerStyleBtn);
    panelHeaderRow.append(countEl, panelHeaderActions);

    modal.body.append(panelHeaderRow, buttonRowEl, csvHint, csvFileInput, progressEl, searchInput, autoCloseToggle.row, tableContainer, logEl);

    waeUI = { countEl, tableContainer, logEl, scanBtn, exportBtn, clearBtn, searchInput };

    let waeSearchDebounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(waeSearchDebounceTimer);
      waeSearchDebounceTimer = setTimeout(() => {
        waeSearchQuery = searchInput.value;
        waeCurrentPage = 1;
        waeRenderFilteredTable();
      }, 200);
    });

    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      progressEl.textContent = 'Scanning imported emails...';
      try {
        // Fetched BEFORE the rebuild below wipes them -- carries starred
        // flags forward across a re-scan, which the full-rebuild-from-
        // scratch approach (see the comment a few lines down) would
        // otherwise silently lose every single time, same as it would
        // any other flag not sourced fresh from the emails themselves.
        const previousRecords = await getAllExtractedRecords();
        const starredKeys = new Set(previousRecords.filter((r) => r.starred).map(waeStarredKey));
        // CSV-imported rows (see waeParseCsvImport()) don't come from a
        // scanned email at all, so there's nothing for a re-scan to
        // re-derive them from -- unlike every other row, wiping them in
        // the rebuild below would be permanent, not just "re-scan to get
        // them back". Set aside here and re-added after the rebuild
        // completes, same idea as the starred carry-over just above but
        // for whole rows rather than one field on rows that do get
        // re-derived.
        const csvRecords = previousRecords.filter((r) => r.source === 'csv');

        const { extracted, ticketDetails } = await scanImportedEmails((done, total) => {
          progressEl.textContent = `Scanning imported emails... ${done}/${total}`;
        });
        if (starredKeys.size) {
          for (const r of extracted) {
            if (starredKeys.has(waeStarredKey(r))) r.starred = true;
          }
        }
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
        await putExtractedRecords([...extracted, ...csvRecords]);
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
        waeResyncReviewIfVisible();
      }
    });

    importCsvBtn.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', async () => {
      const file = csvFileInput.files[0];
      csvFileInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const { records, skipped, error } = waeParseCsvImport(text);
        if (error) {
          log(logEl, `✗ ${error}`, 'err');
          return;
        }
        if (!records.length) {
          log(logEl, `${skipped ? `All ${skipped} row(s)` : 'No rows'} had missing or invalid coordinates -- nothing imported.`, 'warn');
          return;
        }
        await putExtractedRecords(records);
        log(logEl, `✓ Imported ${records.length} location(s) from "${file.name}"${skipped ? ` (${skipped} row(s) skipped: missing/invalid coordinates)` : ''}.`, 'ok');
      } catch (e) {
        log(logEl, `✗ CSV import failed: ${e.message || e}`, 'err');
      } finally {
        waeCurrentPage = 1;
        refreshPanel();
        waeResyncMapIfVisible();
        waeResyncReviewIfVisible();
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
      // BUGFIX (not upstream): this warning used to only mention scanned
      // data ("you can re-scan any time"), which was accurate for every
      // row until CSV-imported ones existed -- those don't come from an
      // email at all, so there's nothing to re-derive them from if this
      // clears them too. Checked for and mentioned explicitly now rather
      // than letting the reassuring "re-scan any time" line quietly
      // apply to rows it doesn't actually cover.
      const hasCsvRows = (await getAllExtractedRecords()).some((r) => r.source === 'csv');
      const csvWarning = hasCsvRows
        ? ' This will ALSO permanently delete any CSV-imported location(s) -- unlike scanned data, those cannot be recovered by re-scanning.'
        : '';
      if (!confirm(`Clear all extracted abuse-report data? The original imported emails are untouched -- you can re-scan any time.${csvWarning}`)) return;
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
        waeResyncReviewIfVisible();
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
      title: 'Wayfarer Map Mods - Abuse Reports',
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
  // BUGFIX (not upstream) + refactor: this used to hand-roll its own
  // side-panel integration -- confirmed against Report Wayspots v3.3.0's
  // own insertReportingHistoryLinkIfReady()/
  // insertReportingSettingsLinkIfReady(): appendChild a plain <a> into
  // ".wfmapmods-settings-links" the first time it exists, found via a
  // whole-document MutationObserver (childList+subtree, debounced 50ms).
  // That copied a real bug from that other script (an observer that
  // disconnects itself after first success has no way to notice the
  // link is gone and never re-add it if Base's side panel gets torn
  // down and rebuilt by Angular's router -- reported as the plugin going
  // completely unreachable after navigating between routed views) and,
  // separately, never used the mechanism WFMM.sidePanel actually offers
  // for exactly this: appendSettingsAction(element, options) drops an
  // element into the real settings-actions slot and hands back an
  // unsubscribe function, while WFMM.sidePanel.onReady()/onCleared()
  // (already relied on elsewhere in this file -- see
  // waeStartSidePanelDetailsWatcher()) fire every time that slot is
  // actually rebuilt, which is the real, public replacement for the
  // MutationObserver above: re-adding through onReady() covers the
  // Angular-router case the old code was trying to patch over, without
  // watching the entire document tree to do it.
  //
  // Just the one link now -- Marker Style settings used to also get a
  // second entry here of its own ("Abuse Report Extractor \u2013 Marker
  // Style"), but a whole separate Settings-list entry for what's really
  // one small piece of this plugin's own panel was more than it needed
  // to be. It's reachable from inside the tool panel itself instead now
  // (see the cog button next to its title, in buildPanelContent()) --
  // tucked behind a click rather than sitting in the panel by default,
  // same reasoning as it having its own modal at all: it's a
  // once-in-a-while adjustment, not something that should compete for
  // attention with the table/export/scan controls every time the panel
  // opens.
  // ---------------------------------------------------------------------

  let waeSettingsActionCleanup = null;
  let waeSidePanelReadyUnsub = null;
  let waeSidePanelClearedUnsub = null;

  function attachSettingsActions() {
    waeSettingsActionCleanup?.();
    const toolLink = document.createElement('a');
    toolLink.textContent = 'Abuse Reports';
    toolLink.style.cursor = 'pointer';
    toolLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      togglePanel();
    });
    waeSettingsActionCleanup = wfmmWindow.WFMM.sidePanel.appendSettingsAction(toolLink);
  }

  function detachSettingsActions() {
    waeSettingsActionCleanup?.();
    waeSettingsActionCleanup = null;
  }


  function startPlugin() {
    // Fired off first, before anything else in this function, so the
    // IndexedDB read is already in flight by the time waeResyncMapIfVisible()
    // (below) goes looking for it -- see waeEnsureRecordsLoaded()'s own
    // comment for the bug this is the other half of the fix for. Not
    // awaited here -- startPlugin() itself isn't async, and doesn't need
    // to be: every real consumer (waeResyncMapIfVisible(),
    // waeApplyLayerEnabled(), the review-map attach path) awaits this
    // same cached promise itself before its own first draw.
    waeEnsureRecordsLoaded();
    // One-time migration from the old raw-localStorage keys (removed
    // from this file as of v1.37.0, see WAE_SETTINGS_DEFAULTS' own
    // comment) into WFMM.settings -- only runs if this plugin id has
    // genuinely never been registered with WFMM.settings before (get()
    // with no fallback comes back undefined only in that case;
    // registerPlugin() itself always leaves AT LEAST {} behind after the
    // first call, so this can't accidentally re-run and clobber a real
    // choice made after upgrading). Must run BEFORE registerPlugin()
    // just below -- that's what makes get(PLUGIN_ID) stop looking "never
    // registered" to this check. Old keys are removed once migrated so
    // this doesn't leave two sources of truth lying around, silently
    // disagreeing, forever. WAE_MAP_VISIBLE_KEY is deliberately NOT part
    // of this -- see its own comment for why that one's already handled,
    // as a one-time seed straight into WFMM.layers.register() instead.
    if (wfmmWindow.WFMM.settings.get(PLUGIN_ID) === undefined) {
      const legacyAppearanceRaw = localStorage.getItem('wae_marker_appearance');
      const legacyAutoClose = localStorage.getItem('wae_autoclose_on_navigate');
      if (legacyAppearanceRaw !== null || legacyAutoClose !== null) {
        let legacyAppearance;
        try { legacyAppearance = JSON.parse(legacyAppearanceRaw || '{}'); } catch (e) { legacyAppearance = {}; }
        wfmmWindow.WFMM.settings.setPlugin(PLUGIN_ID, {
          appearance: waeNormalizeAppearance(legacyAppearance),
          autoCloseOnNavigate: legacyAutoClose !== 'false',
        });
        localStorage.removeItem('wae_marker_appearance');
        localStorage.removeItem('wae_autoclose_on_navigate');
      }
    }
    wfmmWindow.WFMM.settings.registerPlugin(PLUGIN_ID, WAE_SETTINGS_DEFAULTS);
    // Registering as an external plugin (the only path startPlugin() is
    // reached from -- see registerOrSelfStart() below) already implies
    // WFMM.plugins exists, which per the real v4.0.0+ source means
    // WFMM.ui, WFMM.markerAppearance, and WFMM.layers do too -- all
    // populated by the same suite bootstrap (confirmed: all three are
    // assigned right alongside each other in that bootstrap sequence).
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
    // register() itself throws if the same id is already registered --
    // same reasoning as registerStyle() above, and the same reason
    // unregister() is paired with it in stopPlugin(). defaultEnabled
    // reads the OLD standalone localStorage flag (see WAE_MAP_VISIBLE_KEY's
    // own comment) purely as a one-time starting value for whoever
    // upgrades into this version with it already set -- WFMM.layers'
    // OWN persisted value (from a previous run of THIS version) always
    // wins over this if one already exists, matching register()'s own
    // documented savedEnabled ?? defaultEnabled priority.
    wfmmWindow.WFMM.layers.register({
      id: WAE_LAYER_ID,
      pluginId: PLUGIN_ID,
      label: 'Abuse Report Crosses',
      defaultEnabled: localStorage.getItem(WAE_MAP_VISIBLE_KEY) === 'true',
      onChange: (enabled) => { waeApplyLayerEnabled(enabled); },
    });
    // Subscribes to the real WFMM.sidePanel.onReady()/onCleared() events
    // (see attachSettingsActions()'s own comment for why this replaced
    // the old whole-document MutationObserver) rather than a one-shot
    // call, so a side panel rebuilt later in the SPA session -- Angular
    // router navigation, same case the old code was patching around --
    // gets both settings-actions links re-added the same way they
    // appeared the first time. onReady() itself only fires for FUTURE
    // rebuilds (confirmed against every other plugin's own use of it,
    // e.g. Web Reports' attachSettingsAction() call site: each calls its
    // attach function once immediately, THEN subscribes for later) --
    // so the immediate call below covers the side panel already being
    // up right now, same as this plugin's own
    // waeStartSidePanelDetailsWatcher() does for its own subscription.
    attachSettingsActions();
    waeSidePanelReadyUnsub = wfmmWindow.WFMM.sidePanel.onReady(attachSettingsActions);
    waeSidePanelClearedUnsub = wfmmWindow.WFMM.sidePanel.onCleared(detachSettingsActions);
    // Subscribes to WFMM.map/WFMM.routes for this plugin's whole
    // lifetime (see waeStartMapTracking()'s own comment for why this
    // replaced the old setInterval-based stale watch) -- started here
    // rather than tied to the "Show on Map" toggle, since the
    // subscriptions themselves are cheap and their callbacks already
    // check isMapPulsesEnabled() before doing any real work.
    waeStartMapTracking();
    waeStartSidePanelDetailsWatcher();
    waeResyncMapIfVisible();
    // Review-page (/new/review) crosses -- see that section's own top
    // comment (right after waeStopMapTracking()) for why this is a
    // wholly separate subscription from waeStartMapTracking() above,
    // deliberately never touching WFMM.layers/attachSettingsActions().
    waeStartReviewTracking();
  }

  function stopPlugin() {
    waeSidePanelReadyUnsub?.();
    waeSidePanelReadyUnsub = null;
    waeSidePanelClearedUnsub?.();
    waeSidePanelClearedUnsub = null;
    detachSettingsActions();
    waeMarkerSettingsController?.close();
    waeCloseNearbyPopover();
    closePanel(); // no-op if the panel isn't open; openModal's own close() tears its DOM down
    waeStopMapTracking();
    waeStopSidePanelDetailsWatcher();
    waeClearPulses();
    waeStopReviewTracking();
    waeUnregisterAppearance?.();
    waeUnregisterAppearance = null;
    wfmmWindow.WFMM.layers.unregister(WAE_LAYER_ID);
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
    name: (typeof GM_info !== 'undefined' && GM_info.script?.name) || 'Wayfarer Map Mods - Abuse Reports',
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
        console.warn('[Wayfarer Map Mods - Abuse Reports] Plugin Manager registration failed, self-starting instead:', e);
        startPlugin();
        return;
      }
    }
    if (attemptsLeft > 0) {
      setTimeout(() => registerOrSelfStart(attemptsLeft - 1), 250);
      return;
    }
    console.warn('[Wayfarer Map Mods - Abuse Reports] Map Mods plugin manager not detected after 5s -- self-starting instead.');
    startPlugin();
  }

  registerOrSelfStart(20); // 20 * 250ms = 5s
})();
