# Overlens — API reference

Source of truth for the HTTP contract (REQ_API_001). Backend and frontend both build against this file;
change it in the same task as any endpoint change. Endpoints are marked with the phase that delivers them.

## Conventions

- A **roadmap item** is a deliverable or a milestone (`kind` is `deliverable` or `milestone` wherever both can appear).
- Base path `/api`. JSON only: every `POST`/`PATCH`/`PUT`/`DELETE` must send `Content-Type: application/json`
  — **even one with no body** (e.g. a bodiless `DELETE`) — otherwise `415`. This is the
  app's CSRF defence: a plain HTML form cannot set this header (REQ_API_003, spec §8). `GET` never needs it.
  Responses are `application/json`.
- **Time limits (REQ_OVR_013).** The server waits 10 s for request headers, 30 s for the whole request body, 60 s to write an answer and 120 s on an idle connection; a CSV download extends its own write deadline for each page it sends.
- A request body over 4 MiB is refused `413 bad_request` before it is parsed. A body that parses as valid JSON but is
  followed by more data (a second value, or garbage) is `400 bad_request` — exactly one JSON value is accepted.
- **Auth (REQ_API_002):** every `GET` is anonymous. Every `POST`/`PATCH`/`PUT`/`DELETE` needs an admin session
  cookie (`401 unauthorized` when there is none, or it is expired or the user is disabled); the session cookie is
  described under "Auth, audit, logs (Phase 6)".
- **Ids** are integers. **Dates** are `YYYY-MM-DD` (exact days, no times). **Timestamps** are RFC 3339 UTC.
  **Colors** are `#rrggbb`. **Status** is one of `planned`, `in_progress`, `done`, `at_risk`.
- **Errors (REQ_API_004)** — one shape, always:
  ```json
  { "error": { "code": "validation_failed", "message": "Human-readable reason", "fields": { "name": "required" } } }
  ```
  `fields` is present only for validation errors. Codes: `bad_request` 400, `validation_failed` 422, `unauthorized` 401,
  `invalid_credentials` 401 (login only), `locked` 429 (login only), `not_found` 404, `unsupported_media_type` 415, `internal` 500 (a panic
  anywhere in a handler is recovered into this same shape, never a dropped connection).
  A business-rule refusal is `409` and always carries one of these specific codes: duplicate team name/tag
  (`duplicate_name`, `duplicate_tag`), 3-year span exceeded
  (`span_exceeded`), dependency cycle or date-order violation (`cycle`, `date_order`), a delete blocked by content
  still inside what's being deleted (`has_roadmap_items`, `only_workstream`), two roadmap items in one row on a shared day
  (`row_overlap`). Only a genuine "no such thing" (a bad id) is ever folded into a `422`
  naming the offending field (e.g. move/workstream-delete target ids); any other, unexpected error answers `500`.
- **One roadmap per team (REQ_DAT_032).** A team's roadmap is created with the team and deleted only with it; there
  is no active/archived state and no second roadmap (the database refuses one).
- **Lists:** only `GET /api/teams` and `GET /api/admin/audit` page: they return
  `{ "items": [...], "total": N }` and accept `limit` (default 50, max 200; larger values are clamped) and
  `offset`. A non-numeric or non-positive `limit`, or a negative `offset`, is `400 bad_request`. Every other list
  endpoint is not paged: it ignores `limit` and `offset` and always returns its whole list — `{items}`,
  `{items, total}` or a bare array, as documented per endpoint.
- A non-integer id in the address is `400 bad_request`; an unknown id is `404 not_found`; an unknown `/api/...` path is
  `404 not_found` in the same error shape. Unknown JSON fields in a body are ignored (so a client may send a whole object
  back); derived fields such as `range_start` can't be set this way.
- **No overlap in a row (REQ_API_051, REQ_FE_010).** The server refuses `409 row_overlap` any create or change that
  would put two roadmap items in the same row of a workstream on overlapping days: both end days count, a milestone
  occupies its one day, and a deliverable is checked in every workstream it belongs to. The message names the item in
  the way and where, with the row as people count it (`1` is the top row, the stored row + 1): `Overlaps "Kickoff" in Platform, row 1`. (The company-file loader's developer message keeps the stored row number.) It is
  checked inside the write's own transaction, so a refused write changes nothing and writes no audit entry. Only the
  workstreams where the item's place actually changes are checked (its days moved, it joined a workstream, or its row
  changed), so an overlap already in the data never blocks an unrelated edit. A row the server picks itself (a create
  or a move into a workstream without a row, a workstream delete's `target`, a move to another team) is always the
  lowest free one, so those never clash; an explicit row is checked like any other change. Deleting is never refused.
- **The 3-year cap (REQ_DAT_015)** means `range_end` is at most 3 calendar years after `range_start`, computed with
  ordinary calendar-date arithmetic (Go's `time.AddDate(3, 0, 0)`): 2026-01-01 to 2029-01-01 is fine, 2029-01-02 is
  not. The one case worth spelling out: from a leap day, `AddDate(3, 0, 0)` normalizes to the next day, since the
  target year has no Feb 29 — `2024-02-29` plus 3 years is `2027-03-01`, so `2024-02-29` to `2027-03-01` is exactly
  at the cap and `2027-03-02` is one day over. A change that goes past the cap is refused `409 span_exceeded` unless
  the resulting range still lies inside the range the roadmap already has; deletes are never refused.
- **Free-text length limits (422 `validation_failed` over the limit; names count characters, not bytes):** team/
  roadmap/workstream/deliverable names 200 characters; `responsible_person` 200; `risk_note` 2000;
  `description_html` (deliverable and milestone) 100 KB *after* cleaning (see below); a link's `label` 200, its `url` 2000, at most 50 links
  per deliverable or milestone; at most 20 `icons`.
- Every successful write returns the created/updated object (`201` on create, `200` otherwise); `DELETE`
  returns `204`. Every write appends at least one audit entry (Phase 6 wires this; handlers already call the
  audit seam): most write one entry per request. A team `PATCH` that changes several independent fields writes
  one entry *per changed field* (REQ_AUD_002); a deliverable `PATCH` writes at most **one** entry for the whole
  request listing every field that changed (REQ_API_027) — the two intentionally differ, see the Teams and
  Deliverables sections below. A `PATCH`/`POST` that changes nothing writes no entry.
- **A failed audit write is logged as an `ERROR`, never rolled back** (REQ_AUD_018): the store change it
  describes has already committed, so the handler does not undo it — it only makes the failure visible. This is
  an accepted risk, not a bug, and it stays one after Phase 6: the audit write is deliberately not part of the
  change's own transaction.
- A method that exists on a path but wasn't the one sent (e.g. `PUT /api/teams`) answers `405`, same error
  shape, code `bad_request`.

## Health

- `GET /health` → `200 {"status":"ok","version":"1.0.0"}` (REQ_API_019; `version` is the running build, REQ_DEPLOY_009/010). No auth. *(Phase 1, done.)* Failure: `503` with a plain-text body `database unreachable` (`Content-Type: text/plain`). This is the one non-JSON response in the API surface; it lives outside `/api`, so the JSON error shape does not apply to it.

## Teams (Phase 2) — REQ_API_008–010

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/teams` | none | — | `{items:[Team], total}` ordered by name |
| `GET /api/teams/{id}` | none | — | `Team` |
| `POST /api/teams` | admin | `{name, tag, default_color?}` | `201 Team`; the team's roadmap is created with it in the same transaction (title = the team's name, one workstream `"General"`, REQ_DAT_032) |
| `PATCH /api/teams/{id}` | admin | any of `{name, tag, default_color}` | `Team` |
| `DELETE /api/teams/{id}` | admin | — | `204`; deletes the team, its roadmap and that roadmap's workstreams in one transaction. `409 has_roadmap_items` while its roadmap holds any deliverable or milestone (REQ_API_010, REQ_DAT_020) |

Audit: a `PATCH` writes one entry per changed field, none if nothing changed: `team.rename`, `team.retag`, `team.recolor`, each with details `{team, field, from, to, summary}` (e.g. `Tag PE → PRD`). `team.create` writes one entry `{team, tag, default_color, roadmap}` (`roadmap` = the title of the roadmap created with it); `team.delete` writes one entry `{team, tag, roadmap}`. Both carry the roadmap's id as the entry's `roadmap_id`.

`Team = {id, name, tag, default_color, roadmap_id, created_at}`; `roadmap_id` is the team's one roadmap. `tag` is 2–4 capital letters; name and tag are unique
ignoring case (`409 duplicate_name` / `duplicate_tag`); name is at most 200 characters. A change of `default_color` never recolors existing deliverables (REQ_DAT_018).

## Roadmaps (Phase 2) — REQ_API_005, 014

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/roadmaps/{id}` | none | — | `RoadmapFull` |
| `PATCH /api/roadmaps/{id}` | admin | `{title}` | `Roadmap`; sending the title it already has is a no-op (no write, no audit entry) |

A roadmap is created and deleted only with its team (`POST`/`DELETE /api/teams`, REQ_DAT_032); there is no endpoint
that creates, activates, archives or deletes one on its own.

`Roadmap = {id, team_id, title, range_start, range_end, created_at, updated_at}`.
`range_start`/`range_end` are derived from the earliest/latest deliverable or milestone date and recalculated on
every create/delete/date change (REQ_DAT_009); they are `null` for an empty roadmap.

**A roadmap always has at least one workstream (REQ_DAT_023).** A team's roadmap is created with one workstream
called `"General"`, in the same transaction — usable immediately and renamed in place like any other workstream. Its
last remaining workstream can never be deleted (`409 only_workstream`).

`RoadmapFull = Roadmap + {team:Team, workstreams:[Workstream], deliverables:[Deliverable], milestones:[Milestone], dependencies:[RoadmapDependency]}`
— one call gives a client everything to draw a roadmap, including the owning team (id, name, tag, default_color),
so it never needs a second `GET /api/teams/{id}` just to know whose roadmap it's looking at. `dependencies` is described under Dependencies.
Any change that would make `range_end - range_start` exceed 3 years is refused `409 span_exceeded`; deletes and
changes inside the current span still work (REQ_API_014, REQ_DAT_015).

Audit: a title change writes one `roadmap.rename` entry, `{team, from, to}`.

## Workstreams (Phase 2) — REQ_API_025

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `POST /api/roadmaps/{id}/workstreams` | admin | `{name}` | `201 Workstream` (appended last) |
| `PATCH /api/workstreams/{id}` | admin | `{name}` | `Workstream` |
| `PUT /api/roadmaps/{id}/workstreams/order` | admin | `{ids:[workstreamId,…]}` (must be exactly the roadmap's workstreams) | `{items:[Workstream], total}` |
| `DELETE /api/workstreams/{id}?target={wsId}` | admin | — | `204` |

`Workstream = {id, roadmap_id, name, position}`. Names are unique within one roadmap, ignoring case (`409
duplicate_name`), checked on create and rename — except a move's `{"create": "<name>"}` for a name that
already exists in the destination, which reuses that workstream instead of ever reaching this check (REQ_API_011).
Deleting a workstream only ever *moves* its deliverables and its milestones — there is
no mode that deletes them (REQ_API_025): if it still holds either, `target={id}` is **required**
(never silent) and moves them (both) to another workstream of the same roadmap (a deliverable already in the target
just loses this membership; every other moved item gets the lowest free row there, so the move never makes an overlap
and is never refused for one, REQ_API_051); without it → `409 has_roadmap_items`. Refused `409 only_workstream` when it is the
roadmap's last workstream (REQ_DAT_023) — checked first, before even the deliverables/milestones check, so it fires
even for an empty last workstream. `PUT …/order` answers `422` unless `ids` lists every workstream of the roadmap
exactly once, and returns `{items, total}`; sending the order the roadmap already has is a no-op (no write, no audit
entry). Workstream positions only order rows; a deliverable's place inside a workstream is its *row* (see Deliverables below). A deliverable always keeps at least one workstream (REQ_DAT_012).

Audit: `workstream.delete`'s details name the workstream itself, how many deliverables and milestones it held, and
(REQ_AUD_003) only what actually happened: `target_workstream` is the destination workstream's *name*, present only
when a `target` was given. A rename to the name it already has, like the reorder above, is a no-op and
writes no entry.

## Deliverables (Phase 2) — REQ_API_005, 012, 027, DAT_010–014

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `POST /api/roadmaps/{id}/deliverables` | admin | `DeliverableInput` | `201 Deliverable` |
| `GET /api/deliverables/{id}` | none | — | `Deliverable` |
| `PATCH /api/deliverables/{id}` | admin | any subset of `DeliverableInput` | `Deliverable` |
| `DELETE /api/deliverables/{id}` | admin | — | `204` (removes its dependencies too) |
| `POST /api/deliverables/{id}/move` | admin | `MoveInput` | `Deliverable` — REQ_API_011, 012, 052 (see **Move** below) |

`DeliverableInput = {name, start_date, end_date, color?, responsible_person?, description_html?, status?, risk_note?,
icons?:[iconKey], workstream_ids:[id,…] (≥1, all in this roadmap), rows?:{workstreamId: row}, links?:[{label, url}]}`.
`color` defaults to the team's `default_color`. `end_date` ≥ `start_date` (`422` otherwise). `status` defaults to `planned`;
`at_risk` is not required to carry a note, server or client side (the UI offers one, not required, REQ_FE_041). `icons` are keys of
`[a-z0-9_-]{1,40}`, at most 20, each one of the 20 fixed keys listed under Icons below (any other key is `422`,
field `icons`). On `PATCH`, sending `icons` or `links` **replaces the whole
set** (the links are written as new rows; sending exactly the stored links changes nothing, so it writes nothing and keeps the ids,
the same rule as a milestone's, REQ_DAT_014); omitting them leaves them alone; `workstream_ids` keeps existing memberships that stay.
`description_html` is cleaned on save (REQ_API_030, see below) before any length check or diff.
`workstream_ids` in a response are ordered by workstream position, so the first is the primary. A change that would pass the
3-year cap is `409 span_exceeded`. Setting a status other than `at_risk`
clears `risk_note` (REQ_DAT_011). Link URLs must be http(s). The first id in `workstream_ids` order by workstream
position is the *primary* workstream — derived, never stored (REQ_DAT_005).
`Deliverable = DeliverableInput + {id, roadmap_id, team_id, workstreams:[{id, row}], links:[{id,label,url,position}], created_at, updated_at}`.
`workstream_ids` and the richer `workstreams` (same order, each with its stored `row`, REQ_DAT_026/REQ_API_029) are
both present — `workstream_ids` for callers that only need membership, `workstreams` for anything that draws the
timeline and needs to know which row each membership occupies. **Rows are stored** and only ever picked by the
server (the lowest row that overlaps nothing already there, deliverables and milestones both counting, a milestone
occupying its single day) when the deliverable enters a workstream it wasn't already a member of — a `PATCH` can set
a row for a workstream the deliverable is already (or is becoming) a member of via `rows` (object keyed by
workstream id); naming a workstream the deliverable doesn't belong to is `422` (field `rows`). A `POST` may send `rows`
too, for the workstreams in its `workstream_ids`. An explicit row, and every change of `start_date`/`end_date`, `rows` or
`workstream_ids`, is checked: a deliverable that would share a row and a day with another roadmap item, in any of its
workstreams, is `409 row_overlap` (see Conventions, REQ_API_051). A move to another team gives each
membership a freshly picked free row in its destination workstream. A `PATCH` that changes nothing (all sent values equal to the current
ones, an empty `PATCH` included) issues no `UPDATE` — `updated_at` does not move either.

**Description cleaning (REQ_API_030).** `description_html` is sanitized with an allow-list before it's stored:
`<p>`, `<h1>`–`<h6>`, `<b>`/`<strong>`, `<i>`/`<em>`, `<u>`, `<s>`, `<ul>`/`<ol>`/`<li>`, `<br>`, `<a href>` where `href` is
`http`/`https` only, and `<span>` whose only allowed attribute is `style`, holding only `font-family` and/or
`font-size` with an exact value from a fixed list (REQ_FE_124): font-family `Georgia, serif`, `ui-monospace, monospace`,
`Arial, sans-serif`, `Verdana, sans-serif`, `"Times New Roman", serif`; font-size `12px`, `14px`, `16px`, `18px`,
`20px`, `24px`. Any other style property or value (and `style` on any other element) is dropped; a `<span>` left
without a style stays a bare `<span>`. Everything else — `<script>`, event-handler attributes (`onclick`, …), `class`,
`javascript:` links, any other tag or attribute — is stripped, regardless of which client sent it. The 100 KB length limit is
checked *after* cleaning.

Audit: `POST` writes one `deliverable.create` entry, `{deliverable, roadmap, team}`. A `PATCH` writes **at most one**
`deliverable.update` entry for the whole request (REQ_API_027 — unlike team `PATCH`, which is one entry per changed
field): `{deliverable, roadmap, team, changes:[{field, from, to}, …]}` listing every field that actually changed —
`name`, `start_date`, `end_date`, `color`, `responsible_person`, `description_html`, `status`, `risk_note`, and, when
sent and actually different, `workstreams` (comma-joined workstream *names*, not ids), `icons`, `links` (comma-joined
label+url pairs), `rows` (comma-joined `name:row` pairs). Nothing changed (an empty `PATCH` included) writes no entry.
`DELETE` writes one `deliverable.delete` entry, `{deliverable, roadmap, team, dependencies_removed?:[string,…]}` —
when it took any dependency with it, each removed one is named by both ends (the other deliverable's name and team,
REQ_AUD_003), not just counted.

**Move (REQ_API_011, 012, 013, 052).** Both `POST /api/deliverables/{id}/move` and `POST /api/milestones/{id}/move`
take the same body and run the same server code:
`MoveInput = {team_id, workstream_map?: [{from, to}]}`. `team_id` is **another** team (a team has one roadmap,
REQ_DAT_032); the item lands on that team's roadmap. Each `workstream_map` entry maps one of the item's workstreams
(`from`, its id) to a workstream of the destination roadmap: `to` is its id, `{"create": "<name>"}` (same name rules as
`POST .../workstreams`; a destination workstream that already has that name is reused) or `null` (drop — a
deliverable only, and at least one workstream must remain). The `"to"` key is required in every entry; only an explicit
`null` means drop. A workstream with no entry goes to the destination's same-named workstream — names compared trimmed
and ignoring case (ASCII), the first by position winning. A milestone's map has at most one entry, whose `from` is its
workstream. One transaction: re-point the item's roadmap, rewrite its workstream memberships (a fresh free row in
each, REQ_DAT_026), create needed workstreams, keep id, dates, status, risk note, description, owner, colour, icons,
links and dependencies (REQ_DAT_021, 029, 030); both roadmaps' ranges are recomputed. A deliverable move never takes
milestones with it. One audit entry, `deliverable.move` / `milestone.move`, with
`{deliverable|milestone: <name>, from_team, to_team, from_roadmap_id, to_roadmap_id}`.
`409 span_exceeded` if the destination would pass 3 years. All of these are `422 validation_failed` with the reason in
`fields`: unknown `team_id`, or the item's own team; a `from` that isn't one of the item's workstreams (or is listed
twice); an entry with no `"to"` key; a destination workstream outside the destination roadmap; an unmapped
workstream with no same-named destination workstream; `null` for a milestone; nothing left after dropping.

## Milestones (Phase 4) — REQ_API_005, 013, 029, DAT_026


| Method & path | Auth | Body | Result |
|---|---|---|---|
| `POST /api/roadmaps/{id}/milestones` | admin | `MilestoneInput` | `201 Milestone` |
| `PATCH /api/milestones/{id}` | admin | any subset of `MilestoneInput` | `Milestone` |
| `POST /api/milestones/{id}/move` | admin | `MoveInput` | `Milestone` — REQ_API_013, 052: the same body and rules as a deliverable move (see **Move** under Deliverables); the date is unchanged and the row is picked fresh |
| `DELETE /api/milestones/{id}` | admin | — | `204` |

`MilestoneInput = {name, date, workstream_id, row?, description_html?, responsible_person?, status?, risk_note?, links?:[{label, url}]}`.
`Milestone = MilestoneInput + {id, roadmap_id}`, where `links` is returned as `[{id,label,url,position}]`
(`description_html`, `responsible_person` and `risk_note` are always returned, `""` when empty; `status` is always returned,
`"planned"` by default; `links` is `[]` when none). `description_html` (REQ_DAT_029) is cleaned exactly like a
deliverable's (REQ_API_030) before the 100 KB check and before the diff, and defaults to `""` on create. `name` is
required, at most 200 characters (`422 validation_failed`, field `name` — same limit as team/roadmap/workstream/
deliverable names). `date` is `YYYY-MM-DD`, required on create. `workstream_id` is required on create (`422`, field
`workstream_id`, `required`) and must belong to the milestone's own roadmap (`422`, field `workstream_id`); an
unknown id is `404`. `row` follows the same rule as a deliverable's (REQ_DAT_026/REQ_API_029): stored, occupies its
single day, and the server only picks one itself (lowest free row) when the milestone enters a workstream it wasn't
already in and no `row` was sent — moving it via `DELETE /api/workstreams/{id}`'s own `target`
(REQ_API_025) picks a fresh row the same way. An explicit `row` on `POST` or `PATCH` (also together with a new
`workstream_id`: the drag-to-move case sends `{date, workstream_id, row}` together), and every change of `date`, `row`
or `workstream_id`, is checked: a milestone that would share its day and row with another roadmap item is
`409 row_overlap` (see Conventions, REQ_API_051). A negative `row` is
`422 validation_failed`, field `row`, message "must not be negative", on create and update.
Storage (informative, REQ_DAT_031): links of both kinds live in one table, `roadmap_item_links`.
`responsible_person`, `status`, `risk_note` and `links` follow a deliverable's rules exactly (REQ_DAT_030, REQ_DAT_014): `status` is
one of `planned`, `in_progress`, `done`, `at_risk` (else `422`, field `status`); setting a status other than `at_risk` clears
`risk_note` (REQ_DAT_011); on `PATCH`, sending `links` **replaces the whole set** (the links are written as new rows; sending exactly the stored set changes
nothing, so it writes nothing and keeps the ids) and omitting it leaves them alone; link URLs must be http(s); the length limits are under Conventions. A `date` change or a move to
a new `workstream_id` recomputes the roadmap's range the same way a deliverable's does (REQ_DAT_009: the range is
derived from the earliest/latest deliverable **or milestone** date) and is refused `409 span_exceeded` on the same
terms (REQ_DAT_015) — deletes are never refused. A milestone moves to another team with `POST /api/milestones/{id}/move`
(REQ_API_013); it writes one `milestone.move` entry, `{milestone, from_team, to_team, from_roadmap_id, to_roadmap_id}`. A `PATCH` that changes nothing issues no write and no audit entry.

Audit: `POST` writes one `milestone.create` entry, `{milestone, roadmap, team}`. A `PATCH` writes **at most one**
`milestone.update` entry for the whole request (same shape as a deliverable's, REQ_API_027), listing every field
that changed: `name`, `date`, `workstream` (the destination workstream's *name*, REQ_AUD_003, when sent and
actually different), `row`, `description_html`, `responsible_person`, `status`, `risk_note`, `links` (the last recorded as for a deliverable's). `DELETE` writes one `milestone.delete` entry, `{milestone, roadmap, team}` plus `dependencies_removed` when it took edges with it (see "Dependencies").

## Icons (Phase 4) — REQ_FE_080, DAT_003

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/icons` | none | — | `{items:[Icon], total:20}` |
| `PUT /api/icons/{key}` | admin | `{label}` | `Icon` |

`Icon = {key, label}`. `key` is one of the 20 fixed keys below (an unknown key is `404 not_found`); the set is
hardcoded and can never grow or shrink via the API. `label` is the *effective* label: the `icon_labels` row's value
for that key if one has ever been set, otherwise the hardcoded default below — computed at read time, not seeded,
so `icon_labels` only ever holds the keys an admin has actually overridden. `label` is required, at most 200
characters after trimming surrounding whitespace; the trimmed value is what is stored, and a whitespace-only label is
`422 validation_failed`, field `label`, `required` (an over-long one is `422`, field `label`). Labels are global, not per-roadmap or per-team (REQ_FE_080).

The 20 keys and their default labels (REQ_FE_080; the key is the API/DB value, an app-owned string independent of
whichever icon glyph the frontend renders for it):

| key | default label | key | default label |
|---|---|---|---|
| `star` | High priority | `coins` | Budget impact |
| `clock` | Time sensitive | `rocket` | Launch / GA |
| `flag` | Key deliverable | `flask` | Experiment |
| `warning` | Warning | `wrench` | Tech debt |
| `flame` | Escalated | `bug` | Quality focus |
| `lock` | Blocked | `cloud` | Infrastructure |
| `link` | Has dependency | `database` | Data migration |
| `users` | Cross-team | `globe` | Customer facing |
| `shield` | Security | `bulb` | Innovation |
| `scale` | Regulatory | `pause` | On hold |

A deliverable's `icons` field (see Deliverables above) must be a subset of these 20 keys — sending any other key is
`422 validation_failed`, field `icons`, same as the existing per-key shape check.

Audit: `PUT` writes one `icon.relabel` entry, `{icon: key, from, to}`, only when the label actually changed.

## Company view (Phase 7) — REQ_API_022, 031, 036–039, REQ_DAT_027, REQ_AUD_022–023

All reads are anonymous (REQ_AUTH_001); the two `PUT`s are admin-only and need `Content-Type: application/json`.
Implemented in Phase 7a (backend); the frontend (7b) builds on these shapes.

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/company/roadmaps` | none | — | `{items: CompanyTeam[]}`, one per team, in the effective team order. `CompanyTeam = {team: Team, roadmap: RoadmapFull}`; `roadmap` is the team's one roadmap exactly as `GET /api/roadmaps/{id}` returns it (workstreams, deliverables, milestones, `dependencies`), never `null` (REQ_DAT_032). One request replaces N+1 calls |
| `GET /api/company/team-order` | none | — | `{items: {id, name, tag}[]}`: the effective order — teams with a saved position first, in that order, then the rest by name ignoring case |
| `PUT /api/company/team-order` | admin | `{team_ids: number[]}` | `200`, same shape as the `GET` (the effective order after saving). `team_ids` must contain each existing team exactly once: `422 validation_failed`, field `team_ids`, for an unknown id, a duplicate, a missing team, more than 1000 ids or a missing `team_ids` key |
| `GET /api/company/workstream-order` | none | — | `{items: string[]}`: the distinct workstream names of all roadmaps (compared by the name normalisation below; the first spelling met wins — lowest roadmap id, then position), saved order first, then the rest alphabetically ignoring case |
| `PUT /api/company/workstream-order` | admin | `{names: string[]}` | `200`, same shape as the `GET`. Replaces the saved order with the given list (each name 1–200 characters after trimming; `422`, field `names`, for a blank or too long name, a duplicate under the name normalisation below, more than 1000 names or a missing `names` key). Names no roadmap currently has are kept as saved positions (a workstream may come back) but are not listed |
| `GET /api/company/dependencies` | none | — | `{items: CompanyEdge[]}`: every dependency of every roadmap, ordered by `(from_kind, from_id, to_kind, to_id)`. `CompanyEdge = {from_kind, from_id, to_kind, to_id, from: CompanyEnd, to: CompanyEnd}`, `CompanyEnd = DepEnd + {team_id, team_tag}` |

The trace loads the edge list once and walks it in memory with a visited set, so it terminates even if a cycle were ever
in the data (cycles are refused on write, REQ_DEP_003); the root is never listed in its own lists.

Audit (REQ_AUD_022/023, names not ids): `company.workstream_order` `{from, to, saved_from?, saved_to?}` and
`company.team_order` `{from, to, saved_from?, saved_to?}` (all `string[]`; team names), entity type `company`, no entity id.
`from` and `to` are the **effective** orders before and after. `saved_from`/`saved_to` are the stored list (the rows of the
order table, in position order) and are present **only when the saved list changed** — so a `PUT` that only adds or removes
saved names no roadmap has (workstreams), or that only stores the order the teams were already shown in, still
writes one entry (with `from` equal to `to`). A `PUT` that changes neither the effective order nor the saved list writes no
entry (still `200`). Saved lists are compared with the name normalisation below, so changing only the spelling or case of a
saved workstream name is not a change.

**Name normalisation (workstream names).** One key is used everywhere names are compared — merging the workstreams of the
roadmaps, "first spelling wins", matching saved positions, the duplicate check of the `PUT`, and the alphabetical order
of unsaved names: *trim* surrounding white space (Unicode `White_Space`), then lower-case **each code point on its own**
with the simple Unicode mapping (Go `strings.Map(unicode.ToLower, …)`); no context rules, no multi-character results. So
` infra`, `Infra` and `infra ` are one name, `Ärzte` and `ärzte` are one name, the Kelvin sign U+212A and `k` are one name,
and `ΑΣ` (key `ασ`) and `ας` (final sigma, left as is) are **different** names. Unsaved names sort by that key, comparing
code points (not UTF-16 units, not locale collation). A client matching the server should do the same: trim, then
`Array.from(s, c => c.toLowerCase())` per code point — not `s.toLowerCase()` of the whole string, whose final-sigma rule
differs — and treat `İ` (U+0130, which JS maps to two code points) as `i`. SQLite's `NOCASE` (used by the unique constraints
on `workstreams` and the saved-order table) folds ASCII only, so one roadmap may hold both `Ärzte` and `ärzte`; they remain
two workstreams of that roadmap and merge into one row of the company order (the first met by roadmap id, position, id).

**Limits.** `PUT /api/company/workstream-order` takes at most 1000 `names` and `PUT /api/company/team-order` at most 1000
`team_ids` (`422`, field named, "at most 1000 …"). Because a `PUT` replaces the whole saved list, 1000 is also the most saved
workstream rows that can exist: stale names no roadmap has are kept until the client stops sending them, and never
accumulate beyond the last list saved.

Storage: `company_workstream_order(workstream_name COLLATE NOCASE PRIMARY KEY, position)` exists; new additive
`company_team_order(team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE, position INTEGER NOT NULL
DEFAULT 0)` (REQ_DAT_027). Adding it needs no frozen schema unless an existing table changes shape.

**Frontend routes (REQ_FE_091/098/105/116):** `#/company/workstreams` (`#/company` leads there), `#/company/order`,
`#/company/trace/<kind>/<id>` (`#/company/trace/<id>` still means a deliverable), `?milestones` on the company view
and the trace (the Milestones only switch, REQ_FE_136; on a milestone's trace the page keeps only its prerequisites,
REQ_FE_137, from the same `GET /api/company/trace/{kind}/{id}` answer, so no endpoint changed), `#/` (the team list, in the order of
`GET /api/company/team-order`), `#/teams/<id>` (the team's roadmap, via `Team.roadmap_id`), `#/teams/<id>/workstreams`
(its Manage workstreams page). **Seams:** the company view and the trace render one merged-row timeline (read-only for layout,
REQ_FE_096); the team tag (REQ_FE_054) and the trace filter are applied by the page from the
endpoints above — pixel and date maths stay in `axis.ts` (REQ_FE_065).

## Dependencies — REQ_DEP_001–004, 007, 008, 023–031, REQ_DAT_007, REQ_API_006, 031, 040, REQ_AUD_003

A **roadmap item** is a deliverable or a milestone; `Kind = "deliverable" | "milestone"`. A dependency `from → to`
means `from` is the **prerequisite** and `to` the **dependent**, and either end may be of either kind (four
combinations). A milestone's start and end are both its `date`. Every endpoint sits under the dependent `{id}`,
either `/api/deliverables/{id}/…` or `/api/milestones/{id}/…`. The company-wide graph
(`GET /api/company/dependencies`, REQ_API_031) is under "Company view (Phase 7)".

**Storage (informative).** One table, `dependencies(from_kind, from_id, to_kind, to_id, created_at)`, unique on
all four of the first columns, whatever the kinds (REQ_DAT_007); a second index on the "to" side lets the date check
find a roadmap item's prerequisites without scanning. There is no foreign key (the target table depends on the
kind), so the server removes the rows in the same transaction as the delete of the milestone or deliverable they
touch.

**Edge shape.** `DependencyEdge`, `RoadmapDependency` and `CompanyEdge` all carry `from_kind`, `from_id`,
`to_kind`, `to_id` (always present; the id is that of the roadmap item of the given kind, and a deliverable and a
milestone can have the same number). `DependencyEdge = {from_kind, from_id, to_kind, to_id, other: DepEnd | null}`
— `other` describes the end that is **not** `{id}`, used for the chevron badge when the other end is off-screen
(REQ_DEP_012); the server always sets it. `RoadmapDependency = {from_kind, from_id, to_kind, to_id, from: DepEnd,
to: DepEnd}`; `CompanyEdge` adds where each end lives (see Company view). `DepEnd = {kind, id, name, team_name,
roadmap_id, start_date, end_date}`; for a milestone `start_date` and `end_date` both equal its date.
`RoadmapFull.dependencies` lists every edge with **either** end in that roadmap (`[]` when none). The timeline draws
an arrow when both ends are on screen and a chevron badge when one is in another roadmap.

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/{deliverables\|milestones}/{id}/dependencies` | none | — | `DependencyEdge[]` for every edge touching `{id}`, either way, ordered by `(from_kind, from_id, to_kind, to_id)`; `[]` when none; `404` unknown deliverable or milestone |
| `POST /api/{deliverables\|milestones}/{id}/dependencies` | admin | `{from_kind, from_id}`, both required | `201 DependencyEdge`. `{id}` is the dependent; either end may be in any team's roadmap (REQ_DEP_001). Errors below |
| `DELETE /api/{deliverables\|milestones}/{id}/dependencies/{fromKind}/{fromId}` | admin | — | `204`; the only delete shape. Unknown `{id}`, prerequisite or edge `404`; a `fromKind` that is not `deliverable` / `milestone`, or a `fromId` that is not a positive integer, `400 bad_request` |
| `GET /api/{deliverables\|milestones}/{id}/dependency-candidates` | none | — | `Candidate[]` of both kinds, ordered by team tag (ignoring case), then kind (milestones first), then name; `404` unknown deliverable or milestone |
| `GET /api/company/trace/{kind}/{id}` | none | — | `{root: {kind, id}, prerequisites: ItemRef[], dependents: ItemRef[], edges: CompanyEdge[]}`, `ItemRef = {kind, id}`, sorted by kind then id; `404` unknown roadmap item, `400` bad kind or id. `edges` are the edges among the root and its prerequisites and dependents |

The routes are spelled out in `internal/api/api.go` for each kind (`/deliverables/…` and `/milestones/…`).

The `GET` endpoints return a **bare JSON array**, not the `{items, total}` envelope — they are exempt from the list
convention above, since they are never paged.

`Candidate = {kind, id, name, team_id, team_name, team_tag, roadmap_id, start_date, end_date, blocked: null |
"ends_too_late" | "already_prerequisite" | "would_cycle"}` (REQ_DEP_007/008/026). The server computes `blocked`, so
the picker never re-implements the rules. When more than one reason applies, the first of `already_prerequisite`,
`would_cycle`, `ends_too_late` wins. `ends_too_late` means the candidate's end is on or after `{id}`'s start.

**POST errors.** `422 validation_failed` with the field `from_kind` for a missing kind or one that is not
`deliverable` / `milestone`, and the field `from_id` for a missing, unknown or self prerequisite (REQ_DEP_002). The
old body `{from_deliverable_id}` is gone: it is answered as a missing `from_kind`. `404` is for an unknown `{id}` (the
dependent). A duplicate edge is idempotent (`201` with the edge, no audit entry).

- `409 cycle` (REQ_DEP_003, checked first): the loop is found over all four combinations of edge. `path` is
  `[{kind, name}, …]` when a milestone is on the loop; a loop through deliverables only has a plain `string[]` of
  names. Either way it starts with the new edge's `from`, then `to`, and closes on its first roadmap item. The
  `message` lists the same names joined with ` → `, a milestone marked `(milestone)`. The search loads the edges one
  graph level per query, so its cost grows with the depth of the graph below the dependent, not with the number of
  items in it.
- `409 date_order` (REQ_DEP_004, after cycle): `earliest_start` (the day after the prerequisite ends) when the
  dependent starts on or before the prerequisite's end. A milestone's start is its date.

**Date rule on every write (REQ_DEP_004 and REQ_DEP_024, hard).** `PATCH /api/deliverables/{id}` refuses any change of
`start_date` / `end_date` (the rule is only checked when a date actually differs from the stored one — a `PATCH` that
resends the current dates, or changes other fields only, is never refused by it) that leaves a dependent starting on
or before a prerequisite's end, for edges in both directions and to deliverables and milestones alike: `409
date_order`, and the error object carries `earliest_start` (the caller's deliverable starts too early for one of its
prerequisites; the latest such day wins) and/or `latest_end` (it ends too late for one of its dependents; the
earliest such day wins). `PATCH /api/milestones/{id}` refuses a change of `date` that leaves it on or before a
prerequisite's end or on or after a dependent's start: `409 date_order` with `earliest_date` (the day after the
latest prerequisite end) and/or `latest_date` (the day before the earliest dependent start); for a milestone these
replace `earliest_start` / `latest_end`. A refused write changes nothing. `POST .../deliverables` (a new deliverable
has no edges yet) and the moves (dates do not change) cannot break the rule.

Error body example:

```json
{"error": {"code": "date_order", "message": "These dates break a dependency: ...", "earliest_start": "2026-10-11"}}
```

**Cascades.** `DELETE` of a milestone or a deliverable removes every edge touching it (a team, and with it its roadmap,
can only be deleted once the roadmap holds no roadmap items, so it never takes an edge). The
audit entry (`milestone.delete`, `deliverable.delete`) gets `dependencies_removed: string[]`, only
when that list is not empty. Each string is `"<from> (<Team>) → <to> (<Team>)"`, with `milestone ` before the name of
a milestone end, e.g. `"D1 (Alpha Team) → milestone M1 (Alpha Team)"`.

**Audit (REQ_AUD_003, names not ids).** `dependency.create` / `dependency.delete`, entity type `dependency`, entity id
the dependent's id (a deliverable's or a milestone's, see `to_kind`), roadmap the dependent's; details `{from,
from_kind, from_team, to, to_kind, to_team}`.

**Where it lives in the frontend:** the `Timeline` component's `dateLimits(id): Bounds` prop is where the drag limits
(REQ_DEP_005) plug in; arrows, connector dots, connect mode and arrow deletion are in the timeline; the picker
(REQ_DEP_007/008) is in the side panel and the edit window, and the dependencies switch (REQ_DEP_013–015) in the top
bar.

**CSV (REQ_API_023).**

- **CSV** has one row per roadmap item (REQ_API_023). A milestone prerequisite appears in the dependent's `prerequisites` column by name, and a milestone row lists its own prerequisites the same way.

## Auth, audit, logs (Phase 6) — REQ_AUTH_001–018, REQ_API_015–017, 032, 033, REQ_AUD_019–021

Session cookie `session`: random 256-bit token (base64url), `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the
request itself arrived over TLS (`X-Forwarded-Proto` is not trusted), `Max-Age` = `session_ttl_days`; the database
stores only its SHA-256 (REQ_AUTH_008). A request in the second half of the TTL slides `expires_at` and re-sets the
cookie (REQ_AUTH_009). All writes keep needing `Content-Type: application/json`, including `login` and `logout`.

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `POST /api/login` | none | `{username, password}` | `200 {user: {id, username, role}}` + `Set-Cookie`; `401 invalid_credentials`; `429 locked` |
| `POST /api/logout` | none | — | `204`, deletes the session, clears the cookie |
| `GET /api/me` | none | — | `200 {user: {id, username, role} \| null}` |
| `GET /api/users` | admin | — | `{items: User[], total}` |
| `POST /api/users` | admin | `{username, password}` | `201 User` |
| `PATCH /api/users/{id}` | admin | any of `{password, disabled}` | `200 User` |

`User = {id, username, role, disabled, created_at}` — never a password or hash.

- `POST /api/login`: `401 invalid_credentials` for an unknown user, a wrong password or a disabled account alike
  (REQ_AUTH_017; an unknown user costs the same hashing work, so timing does not reveal usernames); `429 locked` after
  5 attempts for that connection address or that username, for 15 minutes (REQ_AUTH_011). An attempt is counted
  *before* the password is checked, so a burst of parallel requests gets 5 checks at most and the rest `429`; a
  successful login hands its attempt back to the address and clears that username's count. The username is read with
  surrounding spaces trimmed and case ignored (`" Admin"` and `"admin "` are the user `admin` and share one lock); a
  username that is empty, over 64 characters or contains control characters is the same `401 invalid_credentials` and
  is never counted. The address is the connection's (`RemoteAddr`), never `X-Forwarded-For`. The lockout is in memory
  only (a restart forgives everyone) and bounded in size. At most 4 password checks run at once; further logins wait
  their turn, they are not refused. A stored hash made with older cost settings is replaced by one with the current
  settings at the next successful login. Request and response bodies are never logged (REQ_CFG_010).
  **Behind a reverse proxy** every user arrives from the proxy's address, so they all share one per-address lock: five
  failures by anyone lock the address for everyone for 15 minutes. And the cookie is `Secure` only when the request
  itself arrived over TLS (`r.TLS`), never from `X-Forwarded-Proto`: terminate TLS in the app, or accept that behind a
  TLS-terminating proxy the cookie is sent without `Secure`.
- `POST /api/logout` works, idempotently, with no session at all.
- `GET /api/me` is always `200`; `user` is `null` for an anonymous visitor, an expired session or a disabled user.
- `POST /api/users`: `409 duplicate_name` (case-insensitive); `422` field `username` for the reserved name `system`
  in any capitals, after trimming (it names the server's own audit entries, REQ_AUTH_019); `422` for a bad username (1–64 characters after
  trimming, no control characters; field `username`) or password (8–128 characters, field `password`). The first admin
  comes from the config (`bootstrap_admin_user` / `bootstrap_admin_password`) only when the users table is empty
  (REQ_AUTH_004; a `bootstrap_admin_user` of `system` stops the start with an ERROR line only when that admin would be created, an install that already has users keeps starting); that password is not held to the 8–128 policy for now (the server logs a warning at startup when it
  is outside it), but it should satisfy it. Two concurrent creates of the same name (any case) give one `201` and one
  `409 duplicate_name`, never a `500`.
- `PATCH /api/users/{id}`: a new password or `disabled: true` deletes that user's sessions (REQ_AUTH_010) — including
  your own, when you reset your own password. `409 last_admin` (disabling the last active admin), `409 self_disable`
  (checked first); `disabled` equal to its current value, or an empty body, changes nothing and writes no audit entry;
  unknown id `404`. Re-enabling is always allowed. No `DELETE`.
- Admin-only: every `POST/PATCH/PUT/DELETE` in this document except `login` and `logout`, including team
  writes and `PUT /api/icons/{key}` (REQ_AUTH_012); the user list and `/api/admin/*` GETs. Every other `GET` is
  anonymous (REQ_AUTH_001). The auth check runs before the content-type check, so an anonymous write answers `401`.

| Method & path | Auth | Query | Result |
|---|---|---|---|
| `GET /api/admin/audit` | admin | `user, action, type, team, deliverable (matches a deliverable's or a milestone's name, REQ_AUD_016), from, to, limit, offset` | `{items: AuditEntry[], total, retention_days}`, newest first; `retention_days` is `audit_retention_days` (0 = forever, REQ_AUD_008) |
| `GET /api/admin/audit/export.csv` | admin | the same filters, no paging | `text/csv` attachment of every matching row |
| `GET /api/admin/storage` | admin | none | `{version, build_time, commit, db_bytes, log_bytes, log_files, disk_free_bytes, disk_total_bytes}`: the running build (REQ_DEPLOY_010; `dev` / `unknown` when not stamped), the database file, every `*app*.log` file in `log_dir`, and the disk holding the database; read-only (REQ_API_053) |

`AuditEntry = {id, ts, username, action, entity_type, entity_id, roadmap_id, details}`: `ts` is UTC RFC 3339,
`entity_id` / `roadmap_id` are `null` when the row has none, `details` is the parsed JSON object (names as they were
when the change happened, REQ_AUD_003).

- Filters (REQ_AUD_016, REQ_API_033): an empty or missing filter does not filter; filters combine with AND.
  `user` is the acting username, `action` (e.g. `deliverable.update`) and `type` (`entity_type`, e.g. `team`) match
  exactly; `user` and `team` ignore case. `team` matches the team name stored in the entry's details (`team`, or
  `from_team` / `to_team` on dependencies and deliverable moves). `deliverable` is a case-insensitive (Unicode: `Ärger` matches `ärger`) substring of the
  roadmap item name in the details (`deliverable` or `milestone`, or `from` / `to` on dependency entries); it is one
  database condition like the others, so the count, a page and each CSV page are one query each. `from` and `to` are dates
  `YYYY-MM-DD`, inclusive, in UTC; a malformed one is `422 validation_failed` (field `from` / `to`). Because the
  team and deliverable filters read the names written at the time, they keep working after renames and deletes.
- Paging: `limit` (default 50, max 200, larger is cut to 200) and `offset`; `total` counts every match, not just the
  page. A bad `limit` / `offset` is `400`. Order is newest first (by id).
- CSV (REQ_API_016): header row `id,ts,username,action,entity_type,entity_id,roadmap_id,details` (`details` is the JSON
  text), standard CSV quoting, `Content-Disposition: attachment; filename="audit-YYYY-MM-DD.csv"`. A text cell that would
  start with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with a single quote so spreadsheets never run it
  as a formula. A bad filter is a normal JSON `422` before any CSV is sent.
- Backups: the daily job writes `roadmap-YYYY-MM-DD.db` files and audits them (`backup.create`, `backup.prune`,
  `backup.fail`); no endpoint reports them. Pruning keeps the newest `backup_keep_days` of the files named exactly
  that way with a real calendar date and ignores files dated in the future for that ranking (they are never deleted).

Audit actor: an admin's entry carries their user id and username as they were then; backup/prune/purge entries use the
user `system` with no id (REQ_AUD_020). New actions: `user.create`, `user.password_reset`, `user.disable`,
`user.enable` (REQ_AUD_019); the server's own `backup.create`, `backup.prune`, `backup.fail` and `audit.purge`
(REQ_AUD_006/014, entity type `system`), and `sample.create` (entity type `system`, no user; `{teams, roadmaps, workstreams, deliverables, milestones, dependencies}`), written once when the server creates the sample company on a first start or on an upgraded empty install (REQ_DEMO_005). There is deliberately **no** endpoint to purge the audit log, delete backups, run a backup
or change retention (REQ_API_017).

## CSV download (Phase 8) — REQ_API_023, REQ_IMP_026

The JSON export and import (and the Export / import page) were decommissioned on 2026-10-11; the error codes `import_invalid`, `unknown_team`, `unsupported_version`, `external_dependencies` and `payload_too_large` went with them. A company file (`"format": "e-roadmaps/company"`, `teams[].roadmaps[]`) is still read by the server itself for the shipped sample and the development data (REQ_IMP_006); there is no endpoint for it.

| Endpoint | Auth | Response |
|---|---|---|
| `GET /api/roadmaps/{id}/export.csv` | none | `200` `text/csv; charset=utf-8` attachment, UTF-8 BOM, CRLF line ends. One row per roadmap item, deliverables and milestones (REQ_API_023). Columns: `team, roadmap, workstreams, name, start_date, end_date, status, risk_note, responsible, color, description, links, prerequisites, kind` (`kind` is `deliverable` or `milestone` and is the last column; a milestone row has its date as start and end and an empty `color`). Lists are joined with `; `. A field holding `,` `"` or a line break is quoted (`""` for a quote). A cell whose first non-space character is `=` `+` `-` `@`, a tab or a carriage return gets a leading `'`. Description is plain text |

A download writes no audit entry.

## Health (Phase 8) — REQ_DEPLOY_009

`GET /health` (no login, no session lookup): as in "Health" above: `200 {"status":"ok","version":"<version>"}`; `503` with the plain-text body `database unreachable`. The binary's `-healthcheck` flag calls it on the configured port and exits 0 on `200`, 1 otherwise (for the container, which has no shell). Not under `/api`.

## AI and app integration — REQ_API_054–063, REQ_CFG_013

Read only. Two parts: one anonymous REST endpoint, and a Model Context Protocol (MCP) endpoint for AI apps that is off
unless the installation switches it on. (The earlier
REQ_API_041–050 and REQ_CFG_011 stay withdrawn; these are their successors without archived roadmaps, REQ_DAT_032.)

**"Today"** is the server's local date (the same clock as `backup_time`).

### Attention list — REQ_API_054, 055

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/company/attention` | none | — | `{today, days, items: AttentionItem[]}`. Query `days` (integer 1–90, default 14) and `team_id` (optional). `400 bad_request` for a `days` outside 1–90 or not an integer, or a `team_id` that is not a positive integer; `404` unknown `team_id`. Not paged; `items` is `[]` when nothing needs attention |

This endpoint does not depend on `mcp_enabled`.

The roadmap items listed are the **deliverables and milestones** of every team (with `team_id`, only that team's) that
have at least one signal. A milestone's start and end are both its date, so its date is the "end" in the rules below.
A new milestone starts `planned` with no owner, so milestones nobody has edited are listed as `no_owner` and past ones
also as `overdue`: intended, the list shows what is unowned or late.

| Signal | Rule |
|---|---|
| `overdue` | `end_date` < today and `status` ≠ `done` |
| `at_risk` | `status` = `at_risk` |
| `due_soon` | `status` = `planned` and today ≤ `end_date` ≤ today + `days` |
| `no_owner` | `responsible_person` is empty or only white space, and `status` ≠ `done` |

`AttentionItem = {kind, id, name, team_id, team_tag, team_name, roadmap_id, roadmap_title, workstreams: string[],
responsible_person, start_date, end_date, status, risk_note, signals: string[], blocks: BlockedItem[]}`.
`workstreams` are names, primary first. `signals` are in the table's order.

`BlockedItem = {kind, id, name, team_id, team_tag, roadmap_id, responsible_person, start_date, end_date}`: every roadmap
item that depends on this one directly or through a chain (the same walk as `GET /api/company/trace/{kind}/{id}`),
**of every team, the item's own team included** (REQ_API_055). For a milestone both dates equal its date. Ordered by
`start_date`, team tag (ignoring case), kind, id.

Roadmap items are ordered by `end_date`, team tag (ignoring case), name, id. The server reads the whole company once (one
transaction, one statement per table, the dependency edges included) and walks the edges in memory, so the number of statements does not depend on the amount of data. The logic
lives in `internal/store/attention.go`; the REST handler and the MCP tool both call it.

### MCP endpoint — REQ_API_056–063, REQ_CFG_013

- **Off by default.** With `mcp_enabled: false`, every request to `/mcp` answers `404 not_found` in the standard error
  shape: never the app's main page, which the server otherwise shows for any address it does not know (REQ_OVR_008).
- **On:** `POST /mcp` speaks MCP over the Streamable HTTP transport, **stateless**: no `Mcp-Session-Id`, every answer is
  one `application/json` JSON-RPC 2.0 message (never an event stream). `GET` and `DELETE /mcp` are `405`.
  `Content-Type: application/json` is required (`415 unsupported_media_type` otherwise) and the body limit is 4 MiB
  (`413 bad_request`), as under `/api`; `GET` and `DELETE` are `405 bad_request` with `Allow: POST`. All three answer in
  the standard error shape.
  No login, no cookie is read. Implemented with the official Go SDK (`github.com/modelcontextprotocol/go-sdk`); the
  server offers the handshake-era protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`
  (`ServerOptions.SupportedProtocolVersions`, SDK v1.8.0) and negotiates the newest one the client names.
- **Origin check (REQ_API_063).** A request carrying an `Origin` header whose host (with port) is not the request's own
  `Host` is refused `403` with code `forbidden` and logged (INFO `mcp.refused`), so a web page of another site in
  someone's browser cannot use the endpoint. A request with no `Origin` (command-line and desktop AI apps) is accepted.
  This does **not** stop DNS rebinding: the page and the rebound address then count as the same site. That is accepted,
  as for the anonymous REST reads; there is no Host allow-list setting.
- **Methods:** `initialize`, `notifications/initialized` (`202`), `ping`, `tools/list`, `tools/call`. Capabilities:
  `{"tools":{}}` only. `serverInfo = {name: "overlens", version: <app version>}` (REQ_OVR_014). The client must send
  `Accept: application/json, text/event-stream` (the SDK answers `400` otherwise, as plain text). What follows is the
  SDK's own behaviour (v1.8.0) for the versions above, which is what `initialize` negotiates and what a request without
  an `MCP-Protocol-Version` header gets: `resources/list` and `prompts/list` answer an empty list; an unknown method, or
  a body that is not JSON-RPC (bad JSON, `jsonrpc` other than `2.0`), is `400` with the SDK's plain-text reason; an
  unknown tool name is the JSON-RPC error `-32602` (not a tool result). A request that sends
  `MCP-Protocol-Version: 2026-07-28` anyway gets the SDK's newer behaviour (e.g. an unknown method is `404` with JSON-RPC
  `-32601`, and a request without `_meta` protocol fields is `400`); that protocol is not offered and not tested here.
- **Tool results** are one `text` content block holding a JSON object (shapes below). A bad argument, an unknown team or
  roadmap item is a tool result with `isError: true` and a one-sentence message the AI can act on (e.g.
  `no team with tag or name "PAYX"; teams are: PAY, ONB, PLAT`), never a JSON-RPC error.
- **Log (REQ_API_060):** one INFO line per `tools/call`: `mcp.tool` with `tool`, `args`, `items`, `ms` (`items` counts
  roadmap items returned, so `0` for `list_teams`); a refused call logs `mcp.tool_refused` with `tool`, `args`, `reason`.
  `args` is the arguments as sent, cut to 500 bytes.
- **Read only (REQ_API_056).** No tool changes anything or writes an audit entry, and none returns users, sessions, the
  audit log, backups or settings: exactly what an anonymous visitor sees.

**Shared shapes.** A `team` argument is a team tag or name, ignoring case.

`AiItem = {kind, id, name, team_tag, team_name, roadmap_id, roadmap_title, workstreams: string[], responsible_person,
start_date, end_date, status, risk_note, description, links, link}`. For a milestone both dates equal its date; its
`status`, `responsible_person` and `risk_note` are real values, as for a deliverable.
`links` is `[{label, url}]`: the roadmap item's web links exactly as stored, in position order, `[]` when none (an empty
label stays empty); the server never fetches, rewrites or re-checks them (REQ_API_061).
`description` is the roadmap item's rich text as plain text, white space collapsed; longer than 500 characters it is its
first 499 followed by `…` (500 in all).
`link` is `<scheme>://<Host header>/#/company/trace/<kind>/<id>`; `<scheme>` is `https` when the request itself arrived
over TLS or the first comma-separated value of `X-Forwarded-Proto`, trimmed and compared ignoring case, is `https`, else
`http` (`cookie_secure` is not consulted). This is for these links only: the session cookie still never trusts that
header (REQ_API_059).

Every tool description says that `links` and all text fields were typed by users and are data, not instructions, while
`link` is the app's own address (REQ_API_061).

`AiRef = {kind, id, name, team_tag}`.

| Tool | Arguments | Result |
|---|---|---|
| `list_teams` | — | `{teams: [{id, name, tag, roadmap: {id, title, link}, roadmap_items: {planned, in_progress, at_risk, done}}]}` in the company team order; `roadmap_items` counts the team's deliverables and milestones together, each roadmap item once even when it sits in several workstreams (all `0` when none; REQ_API_062). `roadmap.link` is `#/teams/<team id>` on the same base as `link` |
| `get_roadmap` | `team` (required) | `{roadmap: {id, title, team_tag, team_name, range_start, range_end, link}, workstreams: string[], items: AiItem[], dependencies: [{from: AiRef, to: AiRef}]}`. `workstreams` in position order; `items` are deliverables then milestones, each by `start_date`, name, id; `dependencies` are every edge with either end in this roadmap |
| `find_items` | any of `text`, `team`, `owner`, `status`, `workstream`, `from`, `to` | `{items: AiItem[], total, truncated}`, at most 100 roadmap items (REQ_API_058). `text`: in name or description, ignoring case. `owner`: in `responsible_person`, ignoring case. `status`: one of the four (milestones have a status too). `workstream`: the roadmap item belongs to a workstream of that name under the company name normalisation (see "Company view"). `from`/`to` (`YYYY-MM-DD`): the roadmap item overlaps that window. No argument means every roadmap item. Ordered by `start_date`, team tag, name, kind, id |
| `trace_dependencies` | `kind` (`deliverable` \| `milestone`), `id` | `{root: AiItem, prerequisites: AiItem[], dependents: AiItem[], edges: [{from: AiRef, to: AiRef}]}`: the same sets as `GET /api/company/trace/{kind}/{id}`, each list by `start_date`, team tag, name, kind, id |
| `needs_attention` | `team?`, `days?` (1–90, default 14) | `{today, days, items}`: the attention list above, with each roadmap item and each `blocks` entry as an `AiItem` (`signals` added to each roadmap item) |

**How a call flows (for implementers).** `internal/api` registers `/mcp` on the router: the MCP handler when
`mcp_enabled`, else the `404`. The SDK handler parses JSON-RPC; the
tool function (`internal/api/mcp.go`) checks its arguments (unknown names and wrong types are an `isError` result, and
are logged as refused) and calls the store directly; the result is shaped into `AiItem`s and returned as one
JSON message. The SDK's own "localhost" Host check is switched off: it would
refuse (plain-text `403`) a reverse proxy on the same machine that passes the public Host on. The Origin check above
keeps other sites' web pages out; DNS rebinding is not stopped, as accepted above. The server makes no outbound calls and holds no AI keys: the user's AI app sends tool results to its model.
