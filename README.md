# Wayfarer Abuse Report Tools

Two companion Tampermonkey userscripts that pull Niantic Support's
"Reporting Abuse in Wayfarer" Helpshift ticket emails out of Gmail (or
`.eml` files), and extract a best-guess Wayspot name + coordinates from
each one into an exportable CSV. Both hook into [Tntnnbltn's Wayfarer Map
Mods - Base][base] side panel rather than having their own floating UI.

[base]: https://gitlab.com/Tntnnbltn/wayfarer-addons

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
- **[Wayfarer Map Mods - Base][base] installed separately, on its own.**
  Both scripts add a link into its side panel settings section
  (`Import Abuse Report Emails` / `Abuse Report Extractor`) — without Base
  running, there's nowhere for those links or panels to appear. Don't
  `@require` Base into anything else; see the "Why no `@require` for
  Base" note below.
- A Google Cloud OAuth Client ID, **only** if you want Gmail sync. The
  `.eml` drop path works with no setup at all.

## Install

1. Install Map Mods - Base first, if you haven't already.
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
   `https://wayfarer.nianticlabs.com`. No redirect URI is needed — this
   uses Google Identity Services' popup token flow, not a redirect flow.
6. Copy the resulting Client ID (ends in `.apps.googleusercontent.com`)
   into the **Connect Gmail** field in the importer's panel. It's saved
   in `localStorage` so you only paste it once; it's not a secret.

The access token itself is never persisted — it's requested fresh each
time the page loads and kept in memory only, for the session.

## Using it

1. On `https://wayfarer.nianticlabs.com/new/mapview`, open Base's side
   panel and click **Import Abuse Report Emails**.
2. Either **Sync new emails** (after connecting Gmail) or drop `.eml`
   files into the dropzone. Turn on auto-sync if you want it to check
   periodically without you opening the panel.
3. Click **Abuse Report Extractor** in the side panel, then **Scan
   Imported Emails**.
4. Review the table — rows missing a name or coordinates are flagged so
   you can check the raw `Location Details` / `Report Details` columns by
   hand — then **Export CSV**.

## What counts as an "abuse report" email

Gmail sync only searches `support@nianticlabs.com` — Niantic Support's
Helpshift "Reporting Abuse in Wayfarer" ticket threads. It used to also
pull in general Wayfarer/Spatial/Ingress nomination-status notifications
from several other senders; that was narrowed in v4.4.0 to keep this
tool scoped to abuse reports specifically.

Dropped `.eml` files are accepted from any sender — screening happens at
extraction time instead, via `opr-email-lib.js`'s `classify()`, which
only keeps emails it recognizes as `ABUSE_REPORT_*`.

## CSV columns

`Conversation ID`, `Ticket Status`, `Wayspot Name (best guess)`,
`Latitude`, `Longitude`, `Issue Type`, `Location Details (raw)`,
`Report Details (raw)`, `Source Email ID`, `Source Filename`.

The two "(raw)" columns are there so you can sanity-check or hand-correct
a bad name/coordinate guess in a spreadsheet — there's no in-page editing
UI by design.

## Data storage & privacy

Everything lives in IndexedDB, in your own browser, and never leaves it
except for the Gmail API calls you make yourself:

- `wst_email_store` — raw imported emails (importer).
- `wf-abuse-report-extract-db` — extracted name/coordinate rows
  (extractor's own database, kept separate from both the importer's
  store and Base's own `wayfarer-tools-db`).

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
- No map-plotting yet. The importer exposes
  `window.WayfarerAbuseEmailImporter.publishPoiToMap()` and
  `getAbuseReportRecords()` specifically so a future script (or a later
  version of the extractor) can push pins onto Base's map through its
  real POI bridge — nothing currently calls it.
- No inline editing of extracted rows — corrections happen in the
  exported CSV.

## Why no `@require` for Base

Earlier versions of both scripts `@require`d Base directly. That turned
out to be wrong: `@require` re-fetches and re-executes the *entire*
required file separately inside **each** userscript that lists it, not a
single shared instance. With two scripts both requiring it, that meant
two independent copies of Base running on the same page, each building
its own `#wfmapmods-side-panel` — and since Base has no guard against a
second, separately-required copy, whichever one you could see wasn't
necessarily the one a script had actually inserted its link into.

Base's real companion script, Report Wayspots, never `@require`s it
either — it's installed once, standalone, and every other script just
assumes exactly one copy is already running and talks to it purely
through the DOM (`.wfmapmods-settings-links`, `#wfmapmods-side-panel`,
the bridge elements). Both scripts here now do the same.

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

- `wayfarer-abuse-email-importer.user.js` — v4.4.0
- `wayfarer-abuse-report-extractor.user.js` — v1.3.0

Full version-by-version detail lives in the changelog comment block at
the top of each `.user.js` file.
