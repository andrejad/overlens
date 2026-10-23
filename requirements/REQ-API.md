# What the server offers

**General**

- **REQ_API_001** — `docs/API.md` describes every endpoint (method, address, who may call it, what goes in, what comes back, which errors) and always matches what the server really does.
- **REQ_API_002** — Anyone can read. Every change needs a logged-in admin.
- **REQ_API_003** — Every change request (POST, PATCH, PUT, DELETE) must send `Content-Type: application/json`, even one with no body; anything else is refused (`415`). This is the CSRF defence.
- **REQ_API_004** — Every error comes back in one documented shape, with a reason a person can read.
- **REQ_API_019** — There is a `/health` address that container health checks can call.

**Roadmaps and their contents**

- **REQ_API_005** — The server can read a roadmap and rename it (a roadmap is created and deleted only with its team, REQ_DAT_032), and can create, read, change and delete workstreams (including reordering), deliverables, milestones, and the links of deliverables and milestones.
- **REQ_API_024** *(withdrawn — decommissioned 2026-10-11: one roadmap per team, nothing to deactivate, REQ_DAT_032)*
- **REQ_API_007** *(withdrawn — decommissioned 2026-10-11: one roadmap per team, nothing to activate, REQ_DAT_032)*
- **REQ_API_022** — The order of workstreams in the company view is saved for everyone.
- **REQ_API_014** — Any change that would make a roadmap span more than 3 years is refused (`409`). Deleting things, and changes that stay inside the current span, still work.
- **REQ_API_025** — Deleting a workstream only ever moves its deliverables and its milestones to another workstream of the same roadmap — there is no mode that deletes them. It is refused (`409`) when the workstream is the roadmap's only one.
- **REQ_API_026** *(withdrawn — decommissioned 2026-10-11: a roadmap is deleted only with its team, REQ_DAT_020)*
- **REQ_API_028** *(withdrawn — decommissioned 2026-10-11: no second roadmap to copy into, REQ_DAT_032)*
- **REQ_API_029** — Every deliverable returns, for each workstream it belongs to, the row it sits in there, and a `PATCH` can set it; milestones return and accept their row the same way. Rows are never changed by the server except when the roadmap item is placed into a workstream it wasn't in (it goes into a free row).
- **REQ_API_030** — The server cleans a deliverable's or a milestone's description when saving it: only the tags and attributes the rich-text editor produces are kept (paragraphs, headings, bold, italic, underline, strikethrough, lists, http(s) links, and `span` with a `style` holding only a `font-family` and/or `font-size` from the editor's fixed lists, REQ_FE_124); scripts, event handlers, classes, any other style or value and everything else are stripped.
- **REQ_API_027** — A deliverable or milestone `PATCH` writes at most one audit entry for the request, listing exactly the fields that changed (name, old value, new value) — never whole before/after objects, and never split into one entry per field the way a team edit is.

**Dependencies**

- **REQ_API_006** — There are endpoints to list, add and remove a roadmap item's dependencies, and to list the roadmap items that could be chosen as its prerequisite (candidates). (Narrowed: the company-wide graph is REQ_API_031.)
- **REQ_API_031** — (Phase 7) `GET /api/company/dependencies` returns the company-wide dependency graph (details: REQ_API_038).

**Teams**

- **REQ_API_008** — Anyone can read the team list; only admins can add, change or delete teams.
- **REQ_API_009** — A team name or tag that is already taken is refused with a clear message.
- **REQ_API_010** — A team whose roadmap still holds roadmap items can't be deleted (`409 has_roadmap_items`).

**Moving a deliverable to another team**

- **REQ_API_011** — One call, `POST /api/deliverables/{id}/move`, does the whole move to another team as a single step: it re-points the deliverable to that team's roadmap, rewrites its workstream links, creates any workstreams that are needed, and writes one audit entry naming the source and destination team. The request body is the one of REQ_API_052.
- **REQ_API_012** — A move always goes to another team's roadmap (a team has only one, REQ_DAT_032); naming the item's own team is refused (`422`). It is refused (`409 span_exceeded`) if it would push the destination past 3 years.
- **REQ_API_013** — A milestone is moved to another team with `POST /api/milestones/{id}/move`, with the same request body and the same rules as a deliverable (REQ_API_011, 012, 052), handled by the same server code. It keeps its date, owner, status, risk note, links and dependencies, and lands in the chosen workstream, a newly created one, or the destination's same-named workstream (refused if there is none).

**Logging in**

- **REQ_API_015** — There are endpoints to log in, log out and ask who is logged in (`/api/login`, `/api/logout`, `/api/me`).

**Audit, logs, the CSV download**

- **REQ_API_016** — Admins can download the audit log as a CSV file, filtered the same way as the audit table (user, action, type, team, roadmap item name, date range).
- **REQ_API_017** — The server has no way to purge the audit log, delete backups, run a backup on demand or change retention — not even for an admin.
- **REQ_API_018** *(withdrawn — decommissioned 2026-10-11: the browser no longer reports user actions; the audit log and the request log cover changes and requests)*
- **REQ_API_020** *(withdrawn — decommissioned 2026-10-11: export/import to JSON is gone; daily backups and an admin restore cover recovery. The CSV download stays, REQ_API_023)*
- **REQ_API_023** — A roadmap can be downloaded as a CSV file of its roadmap items (`GET /api/roadmaps/{id}/export.csv`, no login; a row per deliverable and per milestone, with a `kind` column) for spreadsheets. It is the only export; there is no import. A cell whose first non-space character is `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` (spreadsheet formula injection).
- **REQ_API_021** — `docs/API-USAGE.md` has a copy-and-paste example walkthrough (log in, create a team (which brings its roadmap), two workstreams, two deliverables, a dependency, read it back) and explains anonymous vs. logged-in access, filtering and paging, error codes and the CSV download.
- **REQ_API_032** — Admins can list users (`GET /api/users`), create one (`POST /api/users`) and change one's password or disabled flag (`PATCH /api/users/{id}`); the list never contains a password hash. There is no `DELETE`.
- **REQ_API_033** — `GET /api/admin/audit` (admin only) lists audit entries newest first, as `{items, total}`, filtered by user, action, type, team, roadmap item name (the query parameter is still called `deliverable`) and date range, with `limit` and `offset` paging. The CSV download (REQ_API_016) accepts exactly the same filters.
- **REQ_API_034** *(withdrawn — decommissioned 2026-10-11: the read-only Backups card is gone; backup runs are in the log and the audit log, REQ_AUD_014)*
- **REQ_API_035** *(withdrawn — decommissioned 2026-10-11: see REQ_API_018)*
- **REQ_API_036** — `GET /api/company/workstream-order` returns the workstream names in the order the company workstream view shows them; `PUT` (admin only) replaces the saved order with the ordered list of names it is given and is audited (REQ_AUD_022). Names are matched ignoring case; a name that is not in the saved order is listed after the saved ones, alphabetically.
- **REQ_API_037** — `GET /api/company/roadmaps` returns, for every team in the saved team order, the team and its roadmap in full, in a single request. The server loads each table once for all roadmaps, so the number of database statements does not grow with the number of teams or roadmap items; the answer is the same as loading team by team. `GET /api/company/team-order` returns the team order and `PUT` (admin only) saves a new one, audited (REQ_AUD_023). A team missing from the saved order is listed after the saved ones, by name.
- **REQ_API_038** — `GET /api/company/dependencies` (REQ_API_031) returns every dependency between any two roadmap items, each with both ends' kind, id, name, team, roadmap and dates. `GET /api/company/trace/{kind}/{id}` returns everything the roadmap item depends on (directly or indirectly) and everything that depends on it, across all teams, plus the edges between them; an unknown roadmap item is `404`.
- **REQ_API_039** — The company endpoints are readable by anyone (REQ_AUTH_001); only the two `PUT` endpoints need an admin and `Content-Type: application/json`.
- **REQ_API_040** — Dependencies are managed under the dependent roadmap item, the same way for both kinds: `GET`/`POST /api/{deliverables|milestones}/{id}/dependencies` (`POST` body `{from_kind, from_id}`), `DELETE /api/{deliverables|milestones}/{id}/dependencies/{fromKind}/{fromId}`, and `GET …/dependency-candidates`. Candidates, `RoadmapFull.dependencies`, the company graph and the trace give each end as its kind and id. `PATCH /api/milestones/{id}` runs the date rule (REQ_DEP_024) and answers `409 date_order` with the allowed range. *(Simplified 2026-10-11: the deliverable-only request shapes and fields are gone.)*
- **REQ_API_051** — The server refuses (`409 row_overlap`, naming the roadmap item in the way) any create or change that would put two roadmap items in the same row of a workstream on overlapping days (both end days count; a milestone occupies its one day; a deliverable is checked in every workstream it belongs to). A create, or a move into a workstream without a row, gets the lowest free row; an explicit row is checked like any other change. Deleting is never refused.
- **REQ_API_052** — Both move endpoints (REQ_API_011, 013) take `{team_id, workstream_map?: [{from, to}]}`: `team_id` is another team; each entry maps one of the item's workstreams (`from`, its id) to a workstream of the destination roadmap (`to`: its id, `{"create": "<name>"}`, or `null` to drop it — a deliverable only, and at least one must remain). A workstream with no entry goes to the destination's same-named workstream; names are compared the way the company view merges them (trimmed, case ignored), the first by position winning. The move is one transaction and writes one audit entry.

**AI and app integration (withdrawn 2026-10-11; taken up again 2026-10-19 as REQ_API_054–063 below)**

> The withdrawn IDs were never built and stay withdrawn so they are not reused.

- **REQ_API_041** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_042** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_043** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_044** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_045** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_046** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_047** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_048** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_049** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_050** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_API_053** — *(2026-10-18)* `GET /api/admin/storage` (admin only; `401` otherwise) reports the running build — `version`, `build_time` and `commit` (REQ_DEPLOY_010; *added 2026-10-21*) — and how much disk the app uses: `db_bytes` (the database file), `log_bytes` and `log_files` (every log file in the log folder: `app.log` and the daily files `YYYY-MM-DD-app.log`), and `disk_free_bytes` and `disk_total_bytes` of the disk holding the database. It only reads; it deletes, rotates and compacts nothing.

**AI and app integration** *(decision 2026-10-19: read only; contract in `docs/API.md`, "AI and app integration")*

- **REQ_API_054** — `GET /api/company/attention` lists, for anyone, the roadmap items (deliverables and milestones) of every team that need someone's attention: overdue (ended before today, not done), at risk, due soon (ends within the next `days` days, default 14, still planned) and without an owner (empty or only white space, not done). A milestone's date counts as its end. Each comes with its reasons and says whether it is a deliverable or a milestone; done roadmap items never appear. A new milestone starts planned and without an owner, so milestones nobody has edited are listed as without an owner, and past ones as overdue; that is intended. The number of database statements does not grow with the number of teams or roadmap items.
- **REQ_API_055** — Each attention roadmap item lists every roadmap item, deliverable or milestone, of any team, its own team included, that depends on it, directly or through a chain, with their team, owner, kind and dates, so it is clear who has to be told.
- **REQ_API_056** — When `mcp_enabled` is on (REQ_CFG_013), the server answers the Model Context Protocol at `/mcp` and offers exactly five tools: `list_teams`, `get_roadmap`, `find_items`, `trace_dependencies` and `needs_attention`. No tool changes anything or writes an audit entry, none needs a login, and none shows more than an anonymous visitor sees: no users, sessions, audit log, backups or settings.
- **REQ_API_057** — When `mcp_enabled` is off (the default), every request to `/mcp` answers `404` in the standard error shape, not the app's main page.
- **REQ_API_058** — `find_items` searches deliverables and milestones of every team by any mix of text, team, owner, status, workstream and date window, and returns at most 100. Workstream names match the way the company view merges them (trimmed, case ignored). `get_roadmap` takes a team, by tag or name, case ignored.
- **REQ_API_059** — Every roadmap item an MCP tool returns carries a link that opens it in the app, built from the address the request was sent to. Its scheme is `https` when the request arrived over TLS or the first comma-separated value of `X-Forwarded-Proto`, trimmed and compared ignoring case, is `https`, else `http` (the `cookie_secure` setting is not consulted), for these links only; the session cookie rule (never trust that header) is unchanged.
- **REQ_API_060** — Every MCP tool call writes one log line with the tool name, its arguments, the number of roadmap items returned and the time taken; a refused call logs why.
- **REQ_API_061** — Every roadmap item an MCP tool returns carries `links`: its web links' label and URL exactly as stored, in position order, `[]` when it has none (an empty label stays empty). The server never fetches, rewrites or re-checks them. Every tool description says that `links` and text fields were typed by users, while `link` is the app's own address. (The REST attention list has no `links`.)
- **REQ_API_062** — `list_teams` counts the planned, in-progress, at-risk and done roadmap items of each team, deliverables and milestones together, with each roadmap item counted once, even a deliverable that sits in several workstreams, as the header counts on screen do (REQ_FE_043).
- **REQ_API_063** — `/mcp` refuses with `403` any request whose `Origin` header names a host other than the request's own `Host`, so a web page on another site cannot call it from someone's browser; a request without `Origin` is accepted. This does not stop DNS rebinding (a rebound page's `Origin` matches its `Host`); that is accepted, since the anonymous `GET /api/...` reads are open to it in the same way.
