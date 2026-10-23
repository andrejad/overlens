# Export and the company file

*Decommissioned 2026-10-11:* exporting a roadmap to JSON and importing it back (the API, the overwrite mode and the
Export / import page) are gone — daily backups and an admin restoring one cover recovery. What remains is the CSV
download (REQ_API_023, REQ_IMP_026) and the **company file**, the JSON form in which the shipped sample and the
development data are written and loaded (REQ-DEMO.md). The withdrawn IDs stay below so they are never reused.

## The company file


- **REQ_IMP_001** *(withdrawn — decommissioned 2026-10-11: there is no JSON export; see the introduction above)*
- **REQ_IMP_002** — In a company file each team has one roadmap: its title, workstreams, deliverables, milestones and dependencies. A deliverable carries name, description, responsible, dates, status, risk note, color, its workstream names (with the row in each, REQ_DAT_026), icon keys and links (label and URL). A milestone carries its name, description, date, workstream and row, responsible, status, risk note and links; it has no colour or icons. Every deliverable and milestone has a file-local `key` (string) that dependencies refer to; database ids are not in the file.
- **REQ_IMP_003** — Dependencies are listed as `{from, to}` pairs of `key`s, either end a deliverable or a milestone. An end in another team's roadmap is `{external: {team, name}}`, resolved after every team in the file has been created; an end that matches no roadmap item, or more than one, fails the whole load with the path of the edge.
- **REQ_IMP_004** — Dates are ISO `YYYY-MM-DD`. A file may instead say `"dates": "relative"` with an `anchor` date; every date is then a whole number of days counted from the day of the load (0 is that day, negative numbers are earlier). The `anchor` only has to be a valid date; it documents the day the offsets were written against and shifts nothing. Offsets beyond 40,000 days either way are refused. This is the form of the sample and development files (REQ_DEMO_003/017).
- **REQ_IMP_005** *(withdrawn — decommissioned 2026-10-11: the company file has no versions; it is only ever read by the build it ships with)*
- **REQ_IMP_006** — A **company file** (`"format": "e-roadmaps/company"`) holds `teams: [{team, roadmap}]` plus `team_order` and `workstream_order`. It exists only for the shipped sample (REQ_DEMO_002) and the development data (REQ_DEMO_017) and is read by the server's own loader — there is no endpoint for it. A load is all or nothing and runs the same rules as the API: names, the three-year span, no overlap on a row, status and risk note, dependency date order, no loops, known icon keys, link URL schemes; descriptions are cleaned by the same sanitiser (REQ_API_030).

## The CSV download

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/roadmaps/{id}/export.csv` | none | one row per roadmap item (deliverable or milestone): team, roadmap, workstreams (joined by `; `), name, start, end, status, risk note, responsible, color, description (plain text), links, prerequisites (names joined by `; `), kind (`deliverable` or `milestone`, the last column). A milestone row has its date as start and end and an empty color; its links are listed like a deliverable's. UTF-8 with BOM, CRLF, every field quoted when it holds `,`, `"` or a line break. A cell whose first non-space character is `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` (spreadsheet formula injection, REQ_API_023) |

A download writes no audit entry (a read); the access log line records it.

## Import (withdrawn)

- **REQ_IMP_010** *(withdrawn — decommissioned 2026-10-11: there is no import)*
- **REQ_IMP_011** *(withdrawn — decommissioned 2026-10-11: there is no import)*
- **REQ_IMP_012** *(withdrawn — decommissioned 2026-10-11: there is no import; the company-file load keeps the rules, REQ_IMP_006)*
- **REQ_IMP_013** *(withdrawn — decommissioned 2026-10-11: there is no import; REQ_DAT_019 keeps the colour rule)*
- **REQ_IMP_014** *(withdrawn — decommissioned 2026-10-11: there is no import)*
- **REQ_IMP_015** *(withdrawn — decommissioned 2026-10-11: there is no JSON export)*

## The screen

- **REQ_IMP_020** *(withdrawn — decommissioned 2026-10-11: the Export / import page is gone; replaced by the Download CSV button, REQ_IMP_026)*
- **REQ_IMP_021** *(withdrawn — decommissioned 2026-10-11: see REQ_IMP_020)*
- **REQ_IMP_022** *(withdrawn — decommissioned 2026-10-11: see REQ_API_018)*
- **REQ_IMP_023** *(withdrawn — decommissioned 2026-10-11: no file versions; milestone dependencies are part of REQ_IMP_003)*
- **REQ_IMP_024** *(withdrawn — decommissioned 2026-10-11: part of REQ_IMP_002)*
- **REQ_IMP_025** *(withdrawn — decommissioned 2026-10-11: part of REQ_IMP_002)*
- **REQ_IMP_026** — The team roadmap's top bar has a Download CSV icon button (tooltip "Download this roadmap as a CSV file") where the Export / import button was; it downloads `GET /api/roadmaps/{id}/export.csv` (REQ_API_023). Anyone can use it. There is no export/import page.
