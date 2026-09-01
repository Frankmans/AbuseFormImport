# Wayfarer Abuse Report Tools

Two companion Tampermonkey userscripts that pull Niantic Support's
"Reporting Abuse in Wayfarer" Helpshift ticket emails out of Gmail (or
`.eml` files), and extract a best-guess Wayspot name + coordinates from
each one into an exportable CSV. Both hook into [Tntnnbltn's
wayfarer-map-mods suite][base] side panel rather than having their own
floating UI. Wayfarer itself moved to `wayfarer.scopely.com`; both
scripts and this README are updated for that.

[base]: https://gitlab.com/Tntnnbltn/wayfarer-map-mods

## What's in here

| File | Role |
|---|---|
| `wayfarer-abuse-email-importer.user.js` | Gmail OAuth sync + `.eml` drop -> raw email store |
| `wayfarer-abuse-report-extractor.user.js` | Classifies stored emails, extracts name/coordinates, CSV export |
| `opr-email-lib.js` | Shared MIME parsing + classification library (pulled in via `@require`, not installed separately) |
| `wst-storage.js` | Shared IndexedDB wrapper for the raw email store (also `@require`d, not installed separately) |

The importer's only job is getting raw emails into a shared IndexedDB
store, unclassified. The extractor is the one that actually decides
what's an abuse-report ticket and pulls a location out of it. Splitting
them this way means you can re-run extraction as the parsing logic
improves without re-importing anything.

## Requirements

- A userscript manager (Tampermonkey or compatible).
- **[Tntnnbltn's wayfarer-map-mods suite][base] (v4.0.0+) installed
  separately, on its own.** Both scripts add a link into its side panel
  settings section (`Import Abuse Report Emails` / `Abuse Report
  Extractor`) — without it running, there's nowhere for those links or
  panels to appear. Don't `@require` it into anything else; see the "Why
  no `@require` for the suite" note below. Earlier versions of both
  scripts targeted the old separate `wayfarer-map-mods-base.user.js` —
  if you're still on that, update it to the consolidated v4.0.0+ suite
  first.
- A Google Cloud OAuth Client ID, **only** if you want Gmail sync. The
  `.eml` drop path works with no setup at all.

## Install

1. Install the wayfarer-map-mods suite first, if you haven't already.
2. Install the importer:
   `https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js`
3. Install the extractor:
   `https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js`

`opr-email-lib.js` and `wst-storage.js` come along automatically via
`@require` — there's nothing to separately install for those two.

## Setting up Gmail sync (optional)

Only needed if you want automatic sync instead of (or alongside) dropping
`.eml` files by hand:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/),
   create or pick a project.
2. **APIs & Services -> Library**: enable the **Gmail API**.
3. **APIs & Services -> OAuth consent screen**: set it up as External. If
   it's left in "Testing" mode (the default, and fine for personal use),
   add your own Google account under **Test users** or sign-in will be
   refused. Scope needed: `gmail.readonly`.
4. **APIs & Services -> Credentials -> Create Credentials -> OAuth client
   ID**. Application type: **Web application**.
5. Under **Authorized JavaScript origins**, add
   `https://wayfarer.scopely.com`. No redirect URI is needed — this
   uses Google Identity Services' popup token flow, not a redirect flow.
   If you set this up before Wayfarer moved off `wayfarer.nianticlabs.com`,
   add the new origin to the existing OAuth client rather than making a
   new one — Google validates against the page's actual origin at request
   time, so the old entry alone will now fail silently.
6. Copy the resulting Client ID (ends in `.apps.googleusercontent.com`)
   into the **Connect Gmail** field in the importer's panel. It's saved
   in `localStorage` so you only paste it once; it's not a secret.

The access token itself is never persisted — it's requested fresh each
time the page loads and kept in memory only, for the session.

## Using it

1. On `https://wayfarer.scopely.com/new/mapview`, open the suite's side
   panel and click **Import Abuse Report Emails**.
2. Either **Sync new emails** (after connecting Gmail) or drop `.eml`
   files into the dropzone. Turn on auto-sync if you want it to check
   periodically without you opening the panel.
3. Click **Abuse Report Extractor** in the side panel, then **Scan
   Imported Emails**.
4. Review the table — one row per reported Wayspot, so a ticket that
   reports several (or has more added in a later reply) shows several
   rows sharing the same `Conversation ID`. Rows missing a name or
   coordinates are flagged so you can check the raw `Location Details` /
   `Report Details` columns by hand — then **Export CSV**, or click
   **Show on Map** to see them plotted directly on the map instead (see
   below).

Both scripts also show up as their own entries — with a name,
description, and enable/disable toggle — in the wayfarer-map-mods
suite's own **Plugin Manager** settings screen, alongside its bundled
features. Disabling one there tears it down cleanly (removes its panel
and side-panel link, stops its background watchers) rather than just
hiding it; re-enabling rebuilds everything fresh.

## What counts as an "abuse report" email

Gmail sync only searches `support@nianticlabs.com` — Niantic Support's
Helpshift "Reporting Abuse in Wayfarer" ticket threads. It used to also
pull in general Wayfarer/Spatial/Ingress nomination-status notifications
from several other senders; that was narrowed in v4.4.0 to keep this
tool scoped to abuse reports specifically. Left unchanged when Wayfarer
itself moved to `wayfarer.scopely.com` — that's a separate concern (who
sends support email vs. which domain the web app runs on), and nothing
so far indicates the sender address changed too. Worth checking if
tickets stop arriving.

Dropped `.eml` files are accepted from any sender — screening happens at
extraction time instead, via `opr-email-lib.js`'s `classify()`, which
only keeps emails it recognizes as `ABUSE_REPORT_*`.

## Multiple Wayspots per ticket

A single ticket can report more than one Wayspot — either all at once in
the original submission, or with more added in a later reply ("I see I
missed some: ..."). The extractor picks up both:

- The original form's **Provide details of the location(s)** field is
  split per line, so a report listing several Wayspots at once (each as
  its own `Name (lat, lng)` or `Name, lat,lng` line) becomes one entry
  per line, not just the first.
- Every other message in the thread is scanned the same way, so Wayspots
  a reporter adds in a follow-up reply are picked up too.

Each entry becomes its own CSV row, sharing that ticket's
`Conversation ID` / `Issue Type` / raw-text columns. Deliberately **not**
turned into a *new* location entry: a corrected coordinate mentioned in
prose (e.g. "(is actually here: &lt;lat,lng&gt;)") — that's a correction to
a Wayspot already named elsewhere in the same message, not a new one, so
treating every number pair in prose as a distinct report would invent
duplicate rows. A Street View / Maps link found near a location isn't
dropped, though — it's kept as that entry's `Comment` (see below). If a
reply mixes a genuinely new Wayspot into the same sentence as a
correction, it may need a manual check.

## Long-running tickets spanning several emails

An actively back-and-forth ticket generates a new email notification on
every reply, and each individual export only contains a recent window of
quoted history — not necessarily the complete conversation. If you've
imported more than one email for the same ticket, the extractor merges
all of them (deduping identical messages, re-sorting into one true
newest-first order by actual timestamp) into a single complete thread
*before* extracting — so a Wayspot mentioned only in an older email that's
since scrolled out of a newer one's quoted history still gets picked up,
and the original form fields still resolve even if the newest export's
own quoted history no longer reaches back that far. Import every email
you have for an active ticket, not just the latest one, for the most
complete picture — auto-sync already does this automatically.

## CSV columns

`Conversation ID`, `Ticket Status`, `Wayspot Name (best guess)`,
`Latitude`, `Longitude`, `Comment`, `Nearby Tickets (<20m, other
tickets)`, `Issue Type`, `Location Details (raw)`, `Report Details
(raw)`, `Source Email ID`, `Source Filename`.

`Comment` holds a Street View / Maps link found near that specific
location in a reply (real example: *"'t Zudn, &lt;lat,lng&gt; (is here:
&lt;corrected lat,lng&gt;, shows on street view: &lt;url&gt;)"*) — kept as
context for that entry rather than dropped or turned into a bogus extra
row. Shown as a hover-for-full-text 💬 in the panel's table since the
link itself is usually too long to display inline.

`Source Email ID` / `Source Filename` list every email that contributed
to that row (semicolon-joined) — for a long-running ticket merged from
several emails, that can be more than one.

`Nearby Tickets` lists any other ticket(s) with a location within 20m of
this row's — see "Flagging nearby duplicate reports" below.

The two "(raw)" columns are there so you can sanity-check or hand-correct
a bad name/coordinate guess in a spreadsheet — there's no in-page editing
UI by design. Since a ticket can now span several rows, use
`Conversation ID` to group them back together if you need to.

## Ticket status

`Ticket Status` is Niantic Support's own reply, classified against three
confirmed canned closing messages:

| Status | Matches | Meaning |
|---|---|---|
| **Actioned** | *"We have reviewed the report and have taken action on the Wayspots in accordance with our policies."* | Reviewed and acted on — nothing further to do. |
| **Pending Review** | *"Thank you for your patience as your report is being looked into. We will follow up once we have reviewed the reported Wayspots."* | Still under review — revisit later. |
| **Denied** | *"We took another look at the Wayspot in question and decided that it does not meet our criteria for removal at this time."* | Reviewed, no action taken — also nothing further to do, distinct from Actioned. |

Two other values can show up: **Received** (just the initial auto-ack,
no human reply yet) and **Updated** (a reply that isn't one of the three
canned ones above — a custom human reply, or the reporter's own
follow-up being the newest message in the thread). Only the single
newest message in the thread is ever checked — not previous replies — so
if the reporter sends a follow-up (e.g. a "thanks!") *after* the real
decision, status reads Updated again even though it was actually decided
earlier; that's expected given how this is meant to work, not a bug.
Shown as a color-coded badge in the panel and included in search (e.g.
searching "pending" matches).

## Flagging nearby duplicate reports

Rows get a ⚠️ (and a subtle highlight) when their coordinates fall within
20m of a location extracted from a **different** ticket — the same spot
reported more than once, independently. Click the ⚠️ for a popover
listing which ticket(s) and how far away — each entry is clickable too,
jumping the map straight to that specific match so you can compare the
two directly. The same detail is in the CSV's `Nearby Tickets` column.

Locations within *one* ticket's own thread are never flagged against
each other — that's the expected multi-location shape this tool already
handles (see "Multiple Wayspots per ticket" above), not a duplicate worth
noticing. Flagging only fires across two distinct `Conversation ID`s.

## Data storage & privacy

Everything lives in IndexedDB, in your own browser, and never leaves it
except for the Gmail API calls you make yourself:

- `wst_email_store` — raw imported emails (importer).
- `wf-abuse-report-extract-db` — the extractor's own database, kept
  separate from both the importer's store and whatever the map-mods
  suite itself uses for its own data. Two object stores inside it:
  `extractedReports` (one row per reported Wayspot — name, coordinates,
  comment) and `ticketDetails` (one row per *ticket* — issue type and
  the raw report/location text, shared by every location row that ticket
  produced, rather than each row storing its own copy). You won't
  usually need to think about this split — every part of the panel
  (search, the table, CSV export) sees the two joined back together
  automatically — but it's why a 12-location ticket doesn't store its
  ~2.4KB of raw text twelve times over.

Both panels have **Export backup JSON** / **Import backup JSON** /
**Clear** buttons for their respective stores. Clearing extracted data
doesn't touch the imported emails — re-scan any time to rebuild it.

## Known limitations

- Coordinate/name extraction is **best-effort**. It's been confirmed
  against real tickets and one significant parsing bug has already been
  found and fixed (Helpshift renders the reporter's own messages with a
  blank author name, which an earlier version of the header-parsing
  regex silently dropped — including the message with the actual report
  fields), but treat low-confidence rows as needing a manual check
  before you rely on them.
- Multi-location extraction only recognizes the two per-line list
  formats seen so far (`Name (lat, lng)` and `Name, lat,lng`). A reply
  that mixes a genuinely new Wayspot into the same sentence as a
  correction, rather than giving it its own line, may need a manual
  check — see "Multiple Wayspots per ticket" above.
- No inline editing of extracted rows — corrections happen in the
  exported CSV.

## Searching

The extractor panel has a search box above the table. It filters against
name, conversation ID, comment, issue type, both raw text fields, and the
source filename/email ID — not just what's shown in the columns, since a
query is more likely to hit the raw `Location Details`/`Report Details`
text than the best-guess name. It only changes what's *displayed* —
**Export CSV**, **Show on Map**, and the summary counts above the table
all still reflect everything, not just the currently-filtered rows.
Typing is debounced (200ms) rather than filtering on every keystroke.

## Large histories (thousands of rows)

The table only ever renders 200 rows at a time (**Prev**/**Next**
controls appear once you have more than that), regardless of how many
total rows exist or how many match a search — confirmed via benchmark
that rendering the full table as real DOM elements, not the underlying
computations, is what actually gets slow once a real history reaches
into the thousands. Nearby-duplicate detection and map clustering both
stayed fast (well under 100ms) even at 15,000+ rows in testing, so if
things still feel sluggish at that scale, it's worth checking whether
something's re-rendering the full table rather than paging through it.

Storage itself is also lighter than it used to be — issue type and the
raw report/location text are now stored once per *ticket*, not once per
*location* (see "Data storage & privacy" above), which measured as
roughly an 80% reduction in stored bytes at a realistic 15,000-row scale
with real-sized report text. Search, CSV export, and everything else
still see the exact same data on every row — this only changed how it's
stored, not what any part of the panel shows.

## Plotting on the map

Click **Show on Map** in the extractor panel to plot every extracted
location directly on the Wayfarer map — the same idea as Report
Wayspots' own reported-wayspot history markers, but for what this script
extracted from imported emails, and without needing Report Wayspots
installed. Nearby locations cluster into a single numbered badge when
zoomed out, splitting apart into individual red-X markers as you zoom in
close enough to tell them apart — clustering is based on actual on-screen
distance at the current zoom, not a fixed real-world radius, so it
adapts correctly whether you're looking at the whole country or one
neighborhood. Click an individual marker for its name, coordinates,
comment, and ticket ID; click a cluster to zoom in on it. The toggle's
state is remembered (`localStorage`) and re-attaches automatically next
time the mapview loads if you left it on; markers stay in sync
automatically after every scan or clear while it's on.

Every table row with coordinates is clickable too, independent of whether
the map markers themselves are toggled on — click a row to jump the map
straight to that location (centering and zooming in) and show the same
info popup there. Since the panel is a full-screen backdrop, clicking a
row also closes it, so the map you just navigated to is actually visible.

The suite itself has no marker-plotting API — this ports its confirmed-
working map-lookup code, then plots results as native
`google.maps.Marker` objects (custom SVG icons) rather than anything
from the suite, so it doesn't read as the same layer as its own
reported-wayspot history markers. `window.WayfarerAbuseEmailImporter
.publishPoiToMap()` is unrelated to this — it used to hand a POI to a
`#wfmapmods-poi-bridge` element for the suite's own side-panel selection
(never a map marker, even before this), but that bridge was removed
entirely in the suite's v4.0.0; the function is now a documented no-op
kept only for API compatibility. Real map-plotting has only ever been
this script's own "Show on Map".

Markers reposition themselves via the Maps SDK on pan with no app code
involved, but a full re-render (recomputing clusters) does run on every
zoom step — that's necessary now since clustering itself is zoom-
dependent, and it's cheap (grid-bucketed, not pairwise) so it stays fast.
Data-driven rebuilds (a scan, a clear, first turning the toggle on) work
the same as before.

Rendering hundreds of individual markers used to be the real remaining
slowdown once a dataset grew large, even after the fixes above — each
one has genuine linear overhead regardless of how cheap any single
marker is. Nearby locations now cluster into a single numbered badge
based on actual on-screen pixel distance at the current zoom (not a
fixed real-world radius), splitting apart as you zoom in — same
grid-bucketing idea as the nearby-duplicate detection below, just in
screen-pixel space. A synthetic 450-location test (30 tickets × 15
locations, matching real multi-location extraction scale) rendered just
21 markers zoomed out vs. 447 zoomed in close enough to distinguish them.

Separately, the ⚠️ nearby-duplicate detection used to recompute on every
panel *open* too (not just when data changed), and did it as a full
pairwise scan — with a few thousand accumulated rows that was slow enough
to visibly hang the panel while opening. It's now grid-bucketed (only
compares records in the same ~111m neighborhood, not every pair) and
skipped entirely when nothing's changed since last time.

Zooming into a specific Wayspot switches Wayfarer into a separate
submit/edit view with its own map component — a genuinely different
`google.maps.Map` object than the general mapview's. Markers only ever
render on the one map they were created against, so this used to make
every marker silently vanish when you zoomed in, with nothing bringing
them back until you manually re-toggled. A lightweight watch (checks
every 2s, only while pins are toggled on) now notices that swap and
re-attaches automatically.

## Why no `@require` for the suite

Earlier versions of both scripts `@require`d Tntnnbltn's Base script
directly. That turned out to be wrong: `@require` re-fetches and
re-executes the *entire* required file separately inside **each**
userscript that lists it, not a single shared instance. With two scripts
both requiring it, that meant two independent copies running on the same
page, each building its own `#wfmapmods-side-panel` — and since it had no
guard against a second, separately-required copy, whichever one you
could see wasn't necessarily the one a script had actually inserted its
link into.

Base's real companion script, Report Wayspots (now merged into the same
consolidated `wayfarer-map-mods.user.js` suite as of v4.0.0), never
`@require`d it either — it's installed once, standalone, and every other
script just assumes exactly one copy is already running and talks to it
purely through the DOM (`.wfmapmods-settings-links`, `#wfmapmods-side-panel`).
Both scripts here do the same.

## Architecture at a glance

```
Gmail  ──┐
         ├─▶ wayfarer-abuse-email-importer.user.js ─▶ wst_email_store (IndexedDB)
.eml  ───┘         (raw, unclassified {headers, body})
                             │
                             ▼
              wayfarer-abuse-report-extractor.user.js
        (classify via opr-email-lib.js, extract name + coords)
                             │
                             ▼
              wf-abuse-report-extract-db (IndexedDB)
                             │
                             ▼
                          CSV export
```

`opr-email-lib.js` is a vanilla-JS port of
[bilde2910/OPR-Tools](https://github.com/bilde2910/OPR-Tools)'s
`src/email` module (parsing, classification, Helpshift thread
extraction) — shared by both scripts, with no build step or bundler
needed since it's plain `@require`-able JS.

## Versions covered by this README

- `wayfarer-abuse-email-importer.user.js` — v4.6.0
- `wayfarer-abuse-report-extractor.user.js` — v1.21.1
- Verified against `wayfarer-map-mods.user.js` v4.0.0 (the consolidated
  suite both scripts depend on — see Requirements above).

Full version-by-version detail lives in the changelog comment block at
the top of each `.user.js` file.
