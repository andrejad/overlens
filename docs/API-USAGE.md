# API Usage Guide

This guide provides copy-and-paste examples for common tasks and explains key concepts of the Overlens API.

## Authentication and Access

### Anonymous access (read-only)
All `GET` requests are anonymous — no authentication required. For example, you can fetch teams, roadmaps, deliverables and dependencies without logging in:

```bash
curl http://localhost:8080/api/teams
curl http://localhost:8080/api/teams/1
curl http://localhost:8080/api/roadmaps/1
```

### Logging in (admin-only access: create, update, delete)
All `POST`, `PATCH`, `PUT` and `DELETE` requests (except `login` and `logout`) require an admin
session cookie. The first admin is created from `bootstrap_admin_user` / `bootstrap_admin_password` in
`overlens.conf` the first time the server starts with no users. Log in with it and keep the cookie in a file
(`-c` saves it, `-b` sends it):

```bash
curl -c cookies.txt -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "change-me-please"}'
```
```json
{"user":{"id":1,"username":"admin","role":"admin"}}
```

The response sets a `session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when the request itself came over TLS, valid
for `session_ttl_days` and renewed whenever you use it in the last half of its life). Every write below passes it
with `-b cookies.txt`:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/teams/1 -H "Content-Type: application/json" -d '{...}'
```

Without a valid cookie a write is `401 unauthorized`:

```bash
curl -X POST http://localhost:8080/api/teams -H "Content-Type: application/json" -d '{"name": "X", "tag": "XX"}'
```
```json
{"error":{"code":"unauthorized","message":"Log in as an admin to do this"}}
```

Ask who you are (always `200`; `user` is `null` when nobody is logged in):

```bash
curl -b cookies.txt http://localhost:8080/api/me
```
```json
{"user":{"id":1,"username":"admin","role":"admin"}}
```

A wrong password, an unknown user and a disabled account all answer the same `401 invalid_credentials`, so the
answer never reveals which usernames exist:

```bash
curl -X POST http://localhost:8080/api/login -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "wrong"}'
```
```json
{"error":{"code":"invalid_credentials","message":"Wrong username or password"}}
```

After 5 failed attempts the connection's IP address, and separately that username, is locked out for 15 minutes:
`429` with code `locked`. The attempts are counted before the password is checked, so a burst of parallel logins
cannot get more than 5 tries. The username is read with spaces trimmed and case ignored (`" Admin"` is `admin`).
The address is the connection's own; an `X-Forwarded-For` header is ignored.

Behind a reverse proxy, remember two things. Every user then arrives from the proxy's address, so all of them share one
per-address lock: five failed logins by anyone lock that address for everyone for 15 minutes. And the cookie is marked
`Secure` only when the request reached the app over TLS itself (the app never trusts `X-Forwarded-Proto`), so either
terminate TLS in the app or accept that behind a TLS-terminating proxy the cookie goes without `Secure`.

Log out (`204`; deletes the session and clears the cookie; harmless without one):

```bash
curl -b cookies.txt -c cookies.txt -X POST http://localhost:8080/api/logout -H "Content-Type: application/json"
```

### Managing admins

Admins can add other admins, reset any admin's password and disable or re-enable an admin. There is no way to
delete a user, so the audit trail always has a real account behind it. A password is 8 to 128 characters and a
username is unique ignoring case. None of these responses ever contains a password or a hash.

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/users -H "Content-Type: application/json" \
  -d '{"username": "maria", "password": "a long passphrase"}'
```
```json
{"id":2,"username":"maria","role":"admin","disabled":false,"created_at":"2026-10-01T16:05:56Z"}
```

```bash
curl -b cookies.txt http://localhost:8080/api/users
```
```json
{"items":[{"id":1,"username":"admin","role":"admin","disabled":false,"created_at":"2026-10-01T16:05:47Z"},{"id":2,"username":"maria","role":"admin","disabled":false,"created_at":"2026-10-01T16:05:56Z"}],"total":2}
```

Reset a password or disable an account (either one logs that user out everywhere by deleting their sessions);
`{"disabled": false}` re-enables:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/users/2 -H "Content-Type: application/json" \
  -d '{"password": "another long passphrase"}'
curl -b cookies.txt -X PATCH http://localhost:8080/api/users/2 -H "Content-Type: application/json" \
  -d '{"disabled": true}'
```

The rules: `409 duplicate_name` for a taken username, `422` with `fields.username` for the reserved name `system`
(any capitals; it names the server's own audit entries), `422` with `fields.password` for a bad password,
`409 self_disable` when you disable yourself, `409 last_admin` for the last active admin, `404` for an unknown id.

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/users/1 -H "Content-Type: application/json" \
  -d '{"disabled": true}'
```
```json
{"error":{"code":"self_disable","message":"You can't disable your own account"}}
```

### Reading disk usage (admin only)

```bash
curl -b cookies.txt http://localhost:8080/api/admin/storage
```
```json
{"version":"1.0.0","build_time":"2026-10-21T14:02:00Z","commit":"abc1234","db_bytes":1048576,"log_bytes":52428,"log_files":4,"disk_free_bytes":21474836480,"disk_total_bytes":107374182400}
```

`version`, `build_time` and `commit` are the running build (`dev` and `unknown` when it was not stamped); the admin
screen shows them above the storage figures. `log_bytes` adds up every log file in `log_dir`; the disk figures are for
the disk holding the database.

### Reading the audit log (admin only)

It is read-only; there is no way to purge the audit log, delete a backup, run one on demand or change retention
(those are `overlens.conf` settings and the daily job's work). Filters combine with AND; `user`/`team` ignore case,
`action`/`type` match exactly, `deliverable` is a substring of the name, `from`/`to` are inclusive UTC dates:

```bash
curl -b cookies.txt "http://localhost:8080/api/admin/audit?type=team&limit=5"
```
```json
{"items":[{"id":3,"ts":"2026-10-01T16:15:10Z","username":"admin","action":"team.create","entity_type":"team","entity_id":1,"roadmap_id":null,"details":{"default_color":"#3b82f6","tag":"PL","team":"Platform"}}],"total":1,"retention_days":365}
```

The server's own entries (backup, prune, retention purge) are recorded as the user `system`:

```bash
curl -b cookies.txt "http://localhost:8080/api/admin/audit?user=system"
```
```json
{"items":[{"id":2,"ts":"2026-10-01T16:15:08Z","username":"system","action":"audit.purge","entity_type":"system","entity_id":null,"roadmap_id":null,"details":{"cutoff":"2025-10-01","deleted":0,"retention_days":365}},{"id":1,"ts":"2026-10-01T16:15:08Z","username":"system","action":"backup.create","entity_type":"system","entity_id":null,"roadmap_id":null,"details":{"file":"overlens-2026-10-01.db","size_bytes":131072}}],"total":2,"retention_days":365}
```

The CSV takes the same filters (no `limit`/`offset`) and downloads as a file; cells that would start with `=`, `+`,
`-` or `@` get a leading `'` so a spreadsheet never runs them:

```bash
curl -b cookies.txt -OJ "http://localhost:8080/api/admin/audit/export.csv?user=admin"
```
```
id,ts,username,action,entity_type,entity_id,roadmap_id,details
3,2026-10-01T16:15:10Z,admin,team.create,team,1,1,"{""default_color"":""#3b82f6"",""roadmap"":""Platform"",""tag"":""PL"",""team"":""Platform""}"
```

Without a session both answer `401 unauthorized`.

**Every write needs `Content-Type: application/json`, even one with no body at all** — this is the
app's CSRF defence (a plain HTML form can't set that header). That includes every `DELETE`. Omitting it, or sending anything else, answers `415
unsupported_media_type` before the request is even parsed. Every example below sends it on every
write; `GET` never needs it.

All the examples below were run (with the cookie from the login above) against a real build of the server (a scratch, throw-away
database — never the repo's own `data/` folder) and its actual JSON responses pasted in, with only
timestamps tidied to a readable, incrementing sequence.

## Complete Walkthrough

This example creates a team (which brings its roadmap), workstreams, deliverables and a dependency, then reads it back.

### 1. Create a team

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform",
    "tag": "PLAT",
    "default_color": "#3b82f6"
  }'
```

Response (201 Created):
```json
{
  "id": 1,
  "name": "Platform",
  "tag": "PLAT",
  "default_color": "#3b82f6",
  "roadmap_id": 1,
  "created_at": "2026-09-27T14:32:00Z"
}
```

**Creating a team creates its roadmap (REQ_DAT_032).** Every team has exactly one roadmap: it is created with the
team, in the same transaction, titled with the team's name and holding one workstream called `"General"`
(REQ_DAT_023). `roadmap_id` is its id (here: `1`); one `team.create` audit entry names both. There is no endpoint to
create a second roadmap; the roadmap goes only with its team (`DELETE /api/teams/{id}`, refused `409
has_roadmap_items` while the roadmap holds any deliverable or milestone).

### 2. Rename the team's roadmap

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/roadmaps/1 \
  -H "Content-Type: application/json" \
  -d '{
    "title": "2026 Platform Roadmap"
  }'
```

Response (200 OK):
```json
{
  "id": 1,
  "team_id": 1,
  "title": "2026 Platform Roadmap",
  "range_start": null,
  "range_end": null,
  "created_at": "2026-09-27T14:32:00Z",
  "updated_at": "2026-09-27T14:32:10Z"
}
```

The automatic `"General"` workstream doesn't appear here; there's no standalone `GET .../workstreams`, it shows up in
`RoadmapFull` (`GET /api/roadmaps/{id}`, see step 6) alongside everything else. The next step reuses it — by renaming
it — instead of creating a redundant one.

### 3. Set up two workstreams

The roadmap already has one workstream, `"General"` (`id: 1`, `position: 0`), created with the team in
step 1. Rename it in place to the first real one:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/workstreams/1 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Infrastructure"
  }'
```

Response (200 OK):
```json
{
  "id": 1,
  "roadmap_id": 1,
  "name": "Infrastructure",
  "position": 0
}
```

Then create a second one, which is appended after it:
```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/workstreams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Developer Tools"
  }'
```

Response (201 Created):
```json
{
  "id": 2,
  "roadmap_id": 1,
  "name": "Developer Tools",
  "position": 1
}
```

Save both workstream IDs: `1` and `2`.

### 4. Create two deliverables

First deliverable (in Infrastructure workstream):
```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/deliverables \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Kubernetes Upgrade",
    "start_date": "2026-01-15",
    "end_date": "2026-03-31",
    "color": "#ef4444",
    "status": "planned",
    "workstream_ids": [1],
    "responsible_person": "Alice Chen",
    "description_html": "<p>Upgrade cluster to 1.28</p>",
    "icons": [],
    "links": [
      {
        "label": "JIRA Ticket",
        "url": "https://jira.example.com/browse/INF-123"
      }
    ]
  }'
```

Response (201 Created):
```json
{
  "id": 1,
  "roadmap_id": 1,
  "team_id": 1,
  "name": "Kubernetes Upgrade",
  "start_date": "2026-01-15",
  "end_date": "2026-03-31",
  "color": "#ef4444",
  "responsible_person": "Alice Chen",
  "description_html": "<p>Upgrade cluster to 1.28</p>",
  "status": "planned",
  "risk_note": "",
  "icons": [],
  "workstream_ids": [1],
  "workstreams": [
    {
      "id": 1,
      "row": 0
    }
  ],
  "links": [
    {
      "id": 1,
      "label": "JIRA Ticket",
      "url": "https://jira.example.com/browse/INF-123",
      "position": 0
    }
  ],
  "created_at": "2026-09-27T14:32:20Z",
  "updated_at": "2026-09-27T14:32:20Z"
}
```

`workstreams` lists the same memberships as `workstream_ids`, in the same order, but each with its
stored `row` — the stacked row the deliverable occupies inside that workstream (here, row `0`: nothing
else was there yet). The server only ever picks a row itself when a deliverable enters a workstream it
wasn't already in; see the `rows` example under Common Patterns for setting one explicitly.

Second deliverable (in Developer Tools workstream):
```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/deliverables \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CLI Refactor",
    "start_date": "2026-04-01",
    "end_date": "2026-06-30",
    "color": "#10b981",
    "status": "in_progress",
    "workstream_ids": [2],
    "responsible_person": "Bob Martinez",
    "description_html": "<p>Modularize CLI commands</p>",
    "icons": [],
    "links": []
  }'
```

Response (201 Created):
```json
{
  "id": 2,
  "roadmap_id": 1,
  "team_id": 1,
  "name": "CLI Refactor",
  "start_date": "2026-04-01",
  "end_date": "2026-06-30",
  "color": "#10b981",
  "responsible_person": "Bob Martinez",
  "description_html": "<p>Modularize CLI commands</p>",
  "status": "in_progress",
  "risk_note": "",
  "icons": [],
  "workstream_ids": [2],
  "workstreams": [
    {
      "id": 2,
      "row": 0
    }
  ],
  "links": [],
  "created_at": "2026-09-27T14:32:25Z",
  "updated_at": "2026-09-27T14:32:25Z"
}
```

Save both deliverable IDs: `1` and `2`.

### 5. Create a dependency

Make deliverable 2 (CLI Refactor) depend on deliverable 1 (Kubernetes Upgrade):

The body names the prerequisite by `from_kind` and `from_id` (both required); the roadmap item in the URL is the
dependent. The dependent must start after the prerequisite ends (here 2026-04-01 is after 2026-03-31, so it is allowed):

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/deliverables/2/dependencies \
  -H "Content-Type: application/json" \
  -d '{
    "from_kind": "deliverable",
    "from_id": 1
  }'
```

Response `201`:

```json
{
  "from_kind": "deliverable",
  "to_kind": "deliverable",
  "from_id": 1,
  "to_id": 2,
  "other": { "kind": "deliverable", "id": 1, "name": "Kubernetes Upgrade", "team_name": "Platform", "roadmap_id": 1, "start_date": "2026-01-15", "end_date": "2026-03-31" }
}
```

`other` is the end that is not the deliverable in the URL. Every edge is `{from_kind, from_id, to_kind, to_id, …}`
because an end can be a deliverable or a milestone (see "Milestone Dependencies Walkthrough"); there are no
`from_deliverable_id` / `to_deliverable_id` fields. Sending the same edge again returns `201` with the same edge
and writes nothing. Refusals: `422` (field `from_kind` or `from_id`) for a missing kind or id, a self-dependency or an
unknown prerequisite, `404` for an unknown dependent, `409 cycle` with `error.path` naming the loop
(`["CLI Refactor", "Kubernetes Upgrade", "CLI Refactor"]`), and `409 date_order` with `error.earliest_start`.

List, remove, and ask which deliverables could be chosen as a prerequisite. The two `GET`s return bare JSON arrays
(not the `{items, total}` envelope), and a bad `{fromKind}` or a non-integer `{fromId}` in the `DELETE` is `400 bad_request`. The `DELETE`
line below is **illustrative only**: the rest of this walkthrough keeps the edge, so don't run it here:

```bash
curl http://localhost:8080/api/deliverables/2/dependencies
curl -b cookies.txt -X DELETE http://localhost:8080/api/deliverables/2/dependencies/deliverable/1 -H "Content-Type: application/json"
curl http://localhost:8080/api/deliverables/2/dependency-candidates
```

Each candidate is `{kind, id, name, team_id, team_name, team_tag, roadmap_id, start_date, end_date, blocked}`; `blocked` is `null`
when it can be chosen, else `ends_too_late`, `already_prerequisite` or `would_cycle`.

Changing dates is checked against dependencies in both directions. Moving CLI Refactor to start on or before the
prerequisite's end:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/deliverables/2 -H "Content-Type: application/json" \
  -d '{"start_date": "2026-03-31"}'
# 409 {"error": {"code": "date_order", "message": "...", "earliest_start": "2026-04-01"}}
```

Ending a prerequisite too late answers `409 date_order` with `latest_end` (the day before its earliest dependent starts).
`GET /api/roadmaps/{id}` carries every edge with an end in that roadmap as `dependencies`.

### 6. Read the complete roadmap back

```bash
curl http://localhost:8080/api/roadmaps/1
```

Response (200 OK):
```json
{
  "id": 1,
  "team_id": 1,
  "title": "2026 Platform Roadmap",
  "range_start": "2026-01-15",
  "range_end": "2026-06-30",
  "created_at": "2026-09-27T14:32:00Z",
  "updated_at": "2026-09-27T14:32:25Z",
  "team": {
    "id": 1,
    "name": "Platform",
    "tag": "PLAT",
    "default_color": "#3b82f6",
    "roadmap_id": 1,
    "created_at": "2026-09-27T14:32:00Z"
  },
  "workstreams": [
    {
      "id": 1,
      "roadmap_id": 1,
      "name": "Infrastructure",
      "position": 0
    },
    {
      "id": 2,
      "roadmap_id": 1,
      "name": "Developer Tools",
      "position": 1
    }
  ],
  "deliverables": [
    {
      "id": 1,
      "roadmap_id": 1,
      "team_id": 1,
      "name": "Kubernetes Upgrade",
      "start_date": "2026-01-15",
      "end_date": "2026-03-31",
      "color": "#ef4444",
      "responsible_person": "Alice Chen",
      "description_html": "<p>Upgrade cluster to 1.28</p>",
      "status": "planned",
      "risk_note": "",
      "icons": [],
      "workstream_ids": [1],
      "workstreams": [
        {
          "id": 1,
          "row": 0
        }
      ],
      "links": [
        {
          "id": 1,
          "label": "JIRA Ticket",
          "url": "https://jira.example.com/browse/INF-123",
          "position": 0
        }
      ],
      "created_at": "2026-09-27T14:32:20Z",
      "updated_at": "2026-09-27T14:32:20Z"
    },
    {
      "id": 2,
      "roadmap_id": 1,
      "team_id": 1,
      "name": "CLI Refactor",
      "start_date": "2026-04-01",
      "end_date": "2026-06-30",
      "color": "#10b981",
      "responsible_person": "Bob Martinez",
      "description_html": "<p>Modularize CLI commands</p>",
      "status": "in_progress",
      "risk_note": "",
      "icons": [],
      "workstream_ids": [2],
      "workstreams": [
        {
          "id": 2,
          "row": 0
        }
      ],
      "links": [],
      "created_at": "2026-09-27T14:32:25Z",
      "updated_at": "2026-09-27T14:32:25Z"
    }
  ],
  "milestones": [],
  "dependencies": [
    {
      "from_kind": "deliverable",
      "to_kind": "deliverable",
      "from_id": 1,
      "to_id": 2,
      "from": { "kind": "deliverable", "id": 1, "name": "Kubernetes Upgrade", "team_name": "Platform", "roadmap_id": 1, "start_date": "2026-01-15", "end_date": "2026-03-31" },
      "to": { "kind": "deliverable", "id": 2, "name": "CLI Refactor", "team_name": "Platform", "roadmap_id": 1, "start_date": "2026-04-01", "end_date": "2026-06-30" }
    }
  ]
}
```

The roadmap's `range_start` and `range_end` are calculated automatically from the earliest and latest
deliverable (and milestone) dates. `team` is the owning team's own basics (`id`, `name`, `tag`,
`default_color`, `roadmap_id`, `created_at`) — a client never needs a second `GET /api/teams/{id}` just to know whose
roadmap it's looking at, or what color to draw it in.

## Milestone Dependencies Walkthrough

A milestone can be a prerequisite or a dependent, just like a deliverable. A milestone's start and end are both its
date, so the same date rule applies: the dependent must start **after** the prerequisite's end. This walkthrough is
self-contained and the IDs shown are those of an empty database (log in as in "Logging in" first); on a database that
already has data, use the IDs from your own responses.

### Set up a team (with its roadmap), two deliverables and a milestone

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/teams -H "Content-Type: application/json" \
  -d '{"name": "Platform", "tag": "PLAT", "default_color": "#3b82f6"}'
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/deliverables -H "Content-Type: application/json" \
  -d '{"name": "Kubernetes Upgrade", "start_date": "2027-01-15", "end_date": "2027-03-31", "status": "planned", "workstream_ids": [1]}'
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/deliverables -H "Content-Type: application/json" \
  -d '{"name": "CLI Refactor", "start_date": "2027-05-01", "end_date": "2027-06-30", "status": "planned", "workstream_ids": [1]}'
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/milestones -H "Content-Type: application/json" \
  -d '{"name": "Beta launch", "date": "2027-04-15", "workstream_id": 1}'
```

A milestone can carry a rich-text description (REQ_DAT_029), cleaned like a deliverable's (allowed: paragraphs, headings, bold, italic, underline, strikethrough, lists, http(s) links, and `span` with only a fixed `font-family` / `font-size` style; see `docs/API.md`); send it on create or later:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/milestones/1 -H "Content-Type: application/json" \
  -d '{"description_html": "<p>Public beta for <b>all</b> customers</p>"}'
```

The team's roadmap (id `1`) starts with one workstream, `General` (id `1`). The deliverables get IDs `1` (Kubernetes Upgrade) and
`2` (CLI Refactor), the milestone ID `1` (Beta launch). Deliverables and milestones are numbered separately: milestone
`1` and deliverable `1` are different roadmap items, which is why every dependency names a **kind** (`deliverable` or
`milestone`).

### Create dependencies

`{id}` in the URL is the dependent, the body names the prerequisite. Beta launch depends on Kubernetes Upgrade, and
CLI Refactor depends on Beta launch:

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/milestones/1/dependencies \
  -H "Content-Type: application/json" -d '{"from_kind": "deliverable", "from_id": 1}'
curl -b cookies.txt -X POST http://localhost:8080/api/deliverables/2/dependencies \
  -H "Content-Type: application/json" -d '{"from_kind": "milestone", "from_id": 1}'
```

Both answer `201`. The first:

```json
{"from_kind":"deliverable","to_kind":"milestone","from_id":1,"to_id":1,"other":{"kind":"deliverable","id":1,"name":"Kubernetes Upgrade","team_name":"Platform","roadmap_id":1,"start_date":"2027-01-15","end_date":"2027-03-31"}}
```

Read an edge with `from_kind` / `from_id` / `to_kind` / `to_id`. Both `from_kind` and `from_id` are required, on both routes. Sending an edge
that already exists returns `201` with the same edge and writes nothing.

### List, and ask for candidates

```bash
curl http://localhost:8080/api/milestones/1/dependencies
curl http://localhost:8080/api/deliverables/2/dependency-candidates
curl http://localhost:8080/api/milestones/1/dependency-candidates
```

The first lists both edges touching the milestone (`[]` when none), ordered by `(from_kind, from_id, to_kind, to_id)`.
The candidate lists hold deliverables and milestones of every team, ordered by team tag (ignoring case), then kind
(milestones first), then name. Each has a `kind` and a `blocked` of `null`, `ends_too_late`, `already_prerequisite` or
`would_cycle`. For deliverable 2:

```json
[{"kind":"milestone","id":1,"name":"Beta launch","team_id":1,"team_name":"Platform","team_tag":"PLAT","roadmap_id":1,"start_date":"2027-04-15","end_date":"2027-04-15","blocked":"already_prerequisite"},{"kind":"deliverable","id":1,"name":"Kubernetes Upgrade","team_id":1,"team_name":"Platform","team_tag":"PLAT","roadmap_id":1,"start_date":"2027-01-15","end_date":"2027-03-31","blocked":null}]
```

### The date rule

Moving the milestone to before its prerequisite ends, or to after its dependent starts, is refused and nothing changes.
A milestone has a date, so the answer carries `earliest_date` and/or `latest_date` instead of `earliest_start` /
`latest_end`:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/milestones/1 -H "Content-Type: application/json" \
  -d '{"date": "2027-03-20"}'
# 409 {"error":{"code":"date_order","message":"These dates break a dependency: \"Beta launch\" must fall after \"Kubernetes Upgrade\" ends on 2027-03-31","earliest_date":"2027-04-01"}}
curl -b cookies.txt -X PATCH http://localhost:8080/api/milestones/1 -H "Content-Type: application/json" \
  -d '{"date": "2027-05-10"}'
# 409 {"error":{"code":"date_order","message":"These dates break a dependency: \"Beta launch\" must end before \"CLI Refactor\" starts on 2027-05-01","latest_date":"2027-04-30"}}
```

Adding an edge whose dates are out of order is `409 date_order` with `earliest_start` (the day after the prerequisite
ends). Create a second milestone, Kickoff, on 2027-02-01 and try to make it depend on Kubernetes Upgrade:

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/milestones -H "Content-Type: application/json" \
  -d '{"name": "Kickoff", "date": "2027-02-01", "workstream_id": 1}'
curl -b cookies.txt -X POST http://localhost:8080/api/milestones/2/dependencies \
  -H "Content-Type: application/json" -d '{"from_kind": "deliverable", "from_id": 1}'
# 409 {"error":{"code":"date_order","message":"\"Kickoff\" can't start before the day after \"Kubernetes Upgrade\" ends (2027-03-31)","earliest_start":"2027-04-01"}}
```

Deliverable date changes are checked against edges to milestones too (`earliest_start` / `latest_end` as before).

### Loops

Making Kubernetes Upgrade depend on CLI Refactor would close the loop Kubernetes Upgrade → Beta launch → CLI Refactor.
It is refused with `409 cycle` (checked before the dates). Because a milestone is on the loop, `path` is a list of
`{kind, name}` roadmap items, starting with the new edge's prerequisite and closing on it; the message marks milestones with
`(milestone)`:

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/deliverables/1/dependencies \
  -H "Content-Type: application/json" -d '{"from_kind": "deliverable", "from_id": 2}'
```
```json
{"error":{"code":"cycle","message":"That dependency would form a loop: CLI Refactor → Kubernetes Upgrade → Beta launch (milestone) → CLI Refactor","path":[{"kind":"deliverable","name":"CLI Refactor"},{"kind":"deliverable","name":"Kubernetes Upgrade"},{"kind":"milestone","name":"Beta launch"},{"kind":"deliverable","name":"CLI Refactor"}]}}
```

A loop made only of deliverables keeps the plain list of names (`"path": ["CLI Refactor", "Kubernetes Upgrade", "CLI Refactor"]`).

### Validation errors

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/milestones/1/dependencies \
  -H "Content-Type: application/json" -d '{"from_kind": "milestone", "from_id": 1}'
# 422 {"error":{"code":"validation_failed","message":"from_id: an item can't depend on itself","fields":{"from_id":"an item can't depend on itself"}}}
curl -b cookies.txt -X POST http://localhost:8080/api/milestones/1/dependencies \
  -H "Content-Type: application/json" -d '{}'
# 422 {"error":{"code":"validation_failed","message":"from_kind: required","fields":{"from_kind":"required"}}}
curl -b cookies.txt -X POST http://localhost:8080/api/milestones/1/dependencies \
  -H "Content-Type: application/json" -d '{"from_kind": "deliverable"}'
# 422 {"error":{"code":"validation_failed","message":"from_id: required","fields":{"from_id":"required"}}}
```

The field is `from_kind` for a missing or bad kind and `from_id` for a missing, unknown or self prerequisite. A body
in the old shape (`{"from_deliverable_id": 1}`) is answered as a missing `from_kind`. An unknown `{id}` in the URL is
`404`.

### The typed trace

`GET /api/company/trace/{kind}/{id}` answers for a deliverable or a milestone, following chains through both kinds,
across teams and roadmaps. The lists hold `{kind, id}` roadmap items sorted by kind, then id; `edges` are the edges among the
root and those roadmap items, including edges that touch a milestone:

```bash
curl http://localhost:8080/api/company/trace/milestone/1
```
```json
{"root":{"kind":"milestone","id":1},"prerequisites":[{"kind":"deliverable","id":1}],"dependents":[{"kind":"deliverable","id":2}],"edges":[{"from_kind":"deliverable","to_kind":"milestone","from_id":1,"to_id":1,"from":{"kind":"deliverable","id":1,"name":"Kubernetes Upgrade","team_name":"Platform","roadmap_id":1,"start_date":"2027-01-15","end_date":"2027-03-31","team_id":1,"team_tag":"PLAT"},"to":{"kind":"milestone","id":1,"name":"Beta launch","team_name":"Platform","roadmap_id":1,"start_date":"2027-04-15","end_date":"2027-04-15","team_id":1,"team_tag":"PLAT"}},{"from_kind":"milestone","to_kind":"deliverable","from_id":1,"to_id":2,"from":{"kind":"milestone","id":1,"name":"Beta launch","team_name":"Platform","roadmap_id":1,"start_date":"2027-04-15","end_date":"2027-04-15","team_id":1,"team_tag":"PLAT"},"to":{"kind":"deliverable","id":2,"name":"CLI Refactor","team_name":"Platform","roadmap_id":1,"start_date":"2027-05-01","end_date":"2027-06-30","team_id":1,"team_tag":"PLAT"}}]}
```

An unknown roadmap item is `404`; a kind other than `deliverable` / `milestone`, or an id that is not a positive integer, is `400`.

### Delete a dependency

One form for every combination, `DELETE /api/{deliverables|milestones}/{id}/dependencies/{fromKind}/{fromId}`; it
answers `204`, and an edge that isn't there is `404`
(`{"error":{"code":"not_found","message":"deliverable 1 is not a prerequisite of milestone 1"}}`). A `fromKind` other
than `deliverable` / `milestone`, or an id that is not a positive integer, is `400 bad_request`:

```bash
curl -b cookies.txt -X DELETE http://localhost:8080/api/deliverables/2/dependencies/milestone/1 -H "Content-Type: application/json"
curl -b cookies.txt -X DELETE http://localhost:8080/api/milestones/1/dependencies/deliverable/1 -H "Content-Type: application/json"
```

Each delete writes a `dependency.delete` audit entry with `{from, from_kind, from_team, to, to_kind, to_team}`.

Deleting a milestone, a deliverable or a roadmap removes every dependency touching it, and its audit entry lists them
in `dependencies_removed` (only when there are any). Each string is `"<prerequisite> (Team) → <dependent> (Team)"`, with
`milestone ` before the name of a milestone end, for example `"Kubernetes Upgrade (Platform) → milestone Beta launch (Platform)"`.

### CSV download

The CSV download has one row per roadmap item: a milestone prerequisite is named in the dependent's `prerequisites` cell, and a milestone row lists its own prerequisites the same way.

## Company View Walkthrough

The company view shows every team's roadmap together. These requests were replayed (with the admin cookie from the
login above) against a scratch server built from `cmd/overlens` on a temporary database. Setup: three teams (`Platform` 1,
`Mobile` 2, `Design` 3), each with its roadmap (ids 1, 2 and 3); in `Platform` and `Mobile` the first workstream was
renamed to `Infrastructure` and `infrastructure` (the same workstream, spelled differently), `Mobile` also has `Apps`;
deliverable 1 (`Public API v2`, Platform) is a prerequisite of deliverable 2 (`Mobile SDK`, Mobile).
`Design`'s roadmap is untouched: empty, with its `General` workstream.

### Workstream order (merged by name, ignoring case)

Every roadmap counts, the first spelling met wins, and unsaved names are alphabetical:

```bash
curl http://localhost:8080/api/company/workstream-order
```
```json
{"items":["Apps","General","Infrastructure"]}
```

Save a new order (admin; the list replaces the saved one, names compared ignoring case, each 1-200 characters). The
response is the effective order; the change is audited as `company.workstream_order` with the names before and after:

```bash
curl -b cookies.txt -X PUT http://localhost:8080/api/company/workstream-order \
  -H "Content-Type: application/json" -d '{"names": ["Infrastructure", "Apps"]}'
```
```json
{"items":["Infrastructure","Apps","General"]}
```

Sending the same order again is `200` and writes no audit entry. A `PUT` that changes only the saved list (adds or drops a
name no roadmap has) is audited too, with `saved_from`/`saved_to` next to `from`/`to`. At most 1000 names. A case-insensitive duplicate is refused:

```bash
curl -b cookies.txt -X PUT http://localhost:8080/api/company/workstream-order \
  -H "Content-Type: application/json" -d '{"names": ["Apps", "APPS"]}'
```
```json
{"error":{"code":"validation_failed","message":"names: \"APPS\" appears more than once (names are compared ignoring case)","fields":{"names":"\"APPS\" appears more than once (names are compared ignoring case)"}}}
```

Names no roadmap has right now are kept as saved positions (the workstream may come back) but are not listed.

### Team order

Teams nobody has ordered yet are listed by name, ignoring case:

```bash
curl http://localhost:8080/api/company/team-order
```
```json
{"items":[{"id":3,"name":"Design","tag":"DSN"},{"id":2,"name":"Mobile","tag":"MOB"},{"id":1,"name":"Platform","tag":"PLAT"}]}
```

```bash
curl -b cookies.txt -X PUT http://localhost:8080/api/company/team-order \
  -H "Content-Type: application/json" -d '{"team_ids": [2, 1, 3]}'
```
```json
{"items":[{"id":2,"name":"Mobile","tag":"MOB"},{"id":1,"name":"Platform","tag":"PLAT"},{"id":3,"name":"Design","tag":"DSN"}]}
```

`team_ids` must list every team exactly once; otherwise `422`, field `team_ids`:

```bash
curl -b cookies.txt -X PUT http://localhost:8080/api/company/team-order \
  -H "Content-Type: application/json" -d '{"team_ids": [2, 1]}'
```
```json
{"error":{"code":"validation_failed","message":"team_ids: every team must be listed exactly once","fields":{"team_ids":"every team must be listed exactly once"}}}
```

The audit entry is `company.team_order` with
`{"from":["Design","Mobile","Platform"],"to":["Mobile","Platform","Design"],"saved_from":[],"saved_to":["Mobile","Platform","Design"]}`
(names, not ids; `saved_from`/`saved_to` appear only when the stored list changed). At most 1000 ids. Both `PUT`s without a session are `401 unauthorized`; every `GET` here is anonymous.

### All teams' roadmaps in one request

```bash
curl http://localhost:8080/api/company/roadmaps
```

`items` follows the team order. Each item is `{team, roadmap}`; `roadmap` is the team's one roadmap exactly as
`GET /api/roadmaps/{id}` returns it, never `null`. Abridged to the keys that matter here:

```json
{"items":[
  {"team":{"id":2,"name":"Mobile","tag":"MOB"},"roadmap":{"id":2,"title":"Mobile 2026",
    "workstreams":[{"id":2,"name":"infrastructure"},{"id":3,"name":"Apps"}],
    "deliverables":[{"id":2,"name":"Mobile SDK"}],"milestones":[],
    "dependencies":[{"from_kind":"deliverable","from_id":1,"to_kind":"deliverable","to_id":2}]}},
  {"team":{"id":1,"name":"Platform","tag":"PLAT"},"roadmap":{"id":1,"title":"Platform 2026",
    "workstreams":[{"id":1,"name":"Infrastructure"}],"deliverables":[{"id":1,"name":"Public API v2"}],"milestones":[],
    "dependencies":[{"from_kind":"deliverable","from_id":1,"to_kind":"deliverable","to_id":2}]}},
  {"team":{"id":3,"name":"Design","tag":"DSN"},"roadmap":{"id":3,"title":"Design",
    "workstreams":[{"id":4,"name":"General"}],"deliverables":[],"milestones":[],"dependencies":[]}}]}
```

### The company dependency graph and a trace

`GET /api/company/dependencies` lists every dependency of every roadmap. Each end carries where it
lives (`team_id`, `team_tag`):

```bash
curl http://localhost:8080/api/company/dependencies
```
```json
{"items":[{"from_kind":"deliverable","to_kind":"deliverable","from_id":1,"to_id":2,"from":{"kind":"deliverable","id":1,"name":"Public API v2","team_name":"Platform","roadmap_id":1,"start_date":"2026-10-01","end_date":"2026-12-15","team_id":1,"team_tag":"PLAT"},"to":{"kind":"deliverable","id":2,"name":"Mobile SDK","team_name":"Mobile","roadmap_id":2,"start_date":"2026-12-20","end_date":"2027-02-28","team_id":2,"team_tag":"MOB"}}]}
```

`GET /api/company/trace/deliverable/{id}` returns everything the deliverable depends on and everything that depends on it, through
every team's roadmap, as sorted `{kind, id}` items, plus the edges among them. For deliverable 1:

```bash
curl http://localhost:8080/api/company/trace/deliverable/1
```
```json
{"root":{"kind":"deliverable","id":1},"prerequisites":[],"dependents":[{"kind":"deliverable","id":2}],"edges":[{"from_kind":"deliverable","to_kind":"deliverable","from_id":1,"to_id":2,"from":{"kind":"deliverable","id":1,"name":"Public API v2","team_name":"Platform","roadmap_id":1,"start_date":"2026-10-01","end_date":"2026-12-15","team_id":1,"team_tag":"PLAT"},"to":{"kind":"deliverable","id":2,"name":"Mobile SDK","team_name":"Mobile","roadmap_id":2,"start_date":"2026-12-20","end_date":"2027-02-28","team_id":2,"team_tag":"MOB"}}]}
```

An unknown deliverable is `404` (`{"error":{"code":"not_found","message":"deliverable 999 not found"}}`); a deliverable
with no dependencies gets `"prerequisites":[],"dependents":[],"edges":[]`. The same route answers for a milestone
(`/api/company/trace/milestone/{id}`, see "Milestone Dependencies Walkthrough").

The company view's "Milestones only" switch (`#/company/workstreams?milestones`) uses this same answer when a milestone is
clicked (`#/company/trace/milestone/{id}?milestones`): the page draws the root and its `prerequisites` only, and works
out the health line, gap flags, tight links and Accountable list (REQ_DEP_036-039) in the browser from the roadmap items
`GET /api/company/roadmaps` already returned. No request is added.

## AI and App Integration

Read only. Contract: "AI and app integration" in `docs/API.md` (REQ_API_054–063, REQ_CFG_013).

### What needs attention

Anyone can ask which roadmap items (deliverables and milestones) are overdue, at risk, due soon (default: within 14 days
and not started) or have no owner (empty, or only white space), across every team, and who is waiting on them, in any team. Using the company
walkthrough's data, with Platform's "Public API v2" marked at risk, and (for this example only) a Platform milestone
"Gateway go-live" in the Infrastructure workstream, dated 2027-01-15, that depends on it:

```bash
curl "http://localhost:8080/api/company/attention?days=14"
```
```json
{"today":"2026-10-19","days":14,"items":[
  {"kind":"deliverable","id":1,"name":"Public API v2","team_id":1,"team_tag":"PLAT","team_name":"Platform","roadmap_id":1,
   "roadmap_title":"Platform","workstreams":["Infrastructure"],
   "responsible_person":"Dana","start_date":"2026-10-01","end_date":"2026-12-15","status":"at_risk",
   "risk_note":"Vendor contract late","signals":["at_risk"],
   "blocks":[{"kind":"deliverable","id":2,"name":"Mobile SDK","team_id":2,"team_tag":"MOB","roadmap_id":2,
     "responsible_person":"Lee","start_date":"2026-12-20","end_date":"2027-02-28"},
    {"kind":"milestone","id":1,"name":"Gateway go-live","team_id":1,"team_tag":"PLAT","roadmap_id":1,
     "responsible_person":"Dana","start_date":"2027-01-15","end_date":"2027-01-15"}]}]}
```

`blocks` lists every roadmap item that depends on the item, deliverable or milestone, of any team, its own included
(here Platform's own milestone "Gateway go-live" waits on it as well). `?team_id=1` limits the list to one team. A
`days` outside 1–90 is `400`.

### Switching on the AI connection

The MCP endpoint is off until the installation switches it on in `overlens.conf` and restarts:

```
mcp_enabled: true
```

(or `OVERLENS_MCP_ENABLED=true`). Off, `/mcp` answers `404`.

### Connecting an AI app

Claude Code:

```bash
claude mcp add --transport http roadmaps http://localhost:8080/mcp
```

Claude Desktop (*Settings → Developer → Edit Config*, needs Node.js). The local `mcp-remote` bridge is used because the
server is only reachable on the company network, where a connector added on claude.ai cannot reach it:

```json
{"mcpServers": {"roadmaps": {"command": "npx", "args": ["mcp-remote", "http://localhost:8080/mcp"]}}}
```

Any other app that supports MCP over HTTP: add a server with the address ending in `/mcp`. No login or token.

### Talking to `/mcp` by hand

The examples use the company walkthrough's data without the example milestone above.

Each request is one JSON-RPC message; each answer is one JSON message (no session id to keep).

```bash
# Which tools are there?
curl -X POST http://localhost:8080/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call one
curl -X POST http://localhost:8080/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_items","arguments":{"workstream":"infrastructure"}}}'
```
```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"items\":[{\"kind\":\"deliverable\",\"id\":1,\"name\":\"Public API v2\",\"team_tag\":\"PLAT\",\"team_name\":\"Platform\",\"roadmap_id\":1,\"roadmap_title\":\"Platform\",\"workstreams\":[\"Infrastructure\"],\"responsible_person\":\"Dana\",\"start_date\":\"2026-10-01\",\"end_date\":\"2026-12-15\",\"status\":\"at_risk\",\"risk_note\":\"Vendor contract late\",\"description\":\"\",\"links\":[],\"link\":\"http://localhost:8080/#/company/trace/deliverable/1\"}],\"total\":1,\"truncated\":false}"}]}}
```

`"infrastructure"` matched Platform's "Infrastructure": workstream names are compared the way the company view merges
them. A wrong argument is not an HTTP error; the tool answers `"isError":true` with a sentence saying what to fix:

```json
{"jsonrpc":"2.0","id":3,"result":{"isError":true,"content":[{"type":"text","text":"no team with tag or name \"PAYX\"; teams are: DSN, MOB, PLAT"}]}}
```

The five tools are `list_teams`, `get_roadmap` (by `team`), `find_items`, `trace_dependencies` and `needs_attention`.
None of them changes anything. A request sent from a web page on another site (its `Origin` is not the server's own
address) is refused `403`.

## Filtering and Paging

### Only the team list and the audit list page

`GET /api/teams` and `GET /api/admin/audit` accept `limit` and `offset` and return a page:

```json
{
  "items": [...],
  "total": <number>
}
```

Every other list is not paged: it ignores `limit` and `offset` and returns the whole list, in the shape its endpoint
documents (`{items}`, `{items, total}` or a bare array).

**Example: fetch teams with paging**

```bash
# Fetch the first 10 teams
curl "http://localhost:8080/api/teams?limit=10&offset=0"

# Fetch teams 20-29
curl "http://localhost:8080/api/teams?limit=10&offset=20"
```

Response (200 OK) for the first call, with only the one team created so far:
```json
{
  "items": [
    {
      "id": 1,
      "name": "Platform",
      "tag": "PLAT",
      "default_color": "#3b82f6",
      "roadmap_id": 1,
      "created_at": "2026-09-27T14:32:00Z"
    }
  ],
  "total": 1
}
```

**Paging conventions:**
- `limit`: number of items per page; default 50, maximum 200. Values larger than 200 are clamped.
- `offset`: number of items to skip from the beginning; default 0.
- Non-numeric, non-positive `limit`, or negative `offset` → `400 bad_request`.
- The `total` field always reflects the total count regardless of paging.

## Error Codes and Responses

All errors return a JSON object with a consistent shape:

```json
{
  "error": {
    "code": "error_code",
    "message": "Human-readable explanation",
    "fields": { "fieldname": "field-specific reason" }
  }
}
```

The `fields` object is present only for validation errors (`validation_failed`).

### Error code reference

| Code | HTTP | Meaning |
|------|------|---------|
| `bad_request` | 400 | Invalid input: malformed JSON, JSON followed by trailing data, non-numeric ID (including a bad `{fromKind}` or a non-integer `{fromId}` in `DELETE .../dependencies/{fromKind}/{fromId}`), negative paging offset, etc. |
| `validation_failed` | 422 | Semantic validation failed (e.g., `end_date` before `start_date`, a free-text field over its length limit). See `fields` for details. |
| `unauthorized` | 401 | A write (or the user list) without a valid admin session cookie: none sent, expired, or the user was disabled. |
| `invalid_credentials` | 401 | `POST /api/login` with an unknown user, a wrong password or a disabled account (always the same answer). |
| `locked` | 429 | `POST /api/login`: 5 attempts for that IP address or username; locked for 15 minutes. |
| `not_found` | 404 | Team, roadmap, workstream, deliverable, milestone, icon key, or dependency edge (`DELETE .../dependencies/{fromKind}/{fromId}` naming an edge that isn't there) does not exist. |
| `unsupported_media_type` | 415 | A write (`POST`/`PATCH`/`PUT`/`DELETE`) — including one with no body — was not sent with `Content-Type: application/json`. |
| — (`bad_request`) | 413 | Request body over 4 MiB. |
| — | 409 | Business rule violation, always with a specific code in `code`: |
| — `duplicate_name` | 409 | Team or workstream name already taken (workstream: within the same roadmap). |
| — `duplicate_tag` | 409 | Team tag already taken. |
| — `span_exceeded` | 409 | Adding/changing a date would exceed the 3-year limit. |
| — `row_overlap` | 409 | The create or change would put two roadmap items in one workstream row on a shared day (REQ_API_051); the message names the item in the way, e.g. `Overlaps "CLI Refactor" in Developer Tools, row 1`. Deletes are never refused. |
| — `has_roadmap_items` | 409 | Cannot delete a workstream that still holds a deliverable or a milestone without specifying a target, or a team whose roadmap still holds any deliverable or milestone — move or delete them first. |
| — `only_workstream` | 409 | Cannot delete a roadmap's last remaining workstream (REQ_DAT_023). |
| — `cycle` | 409 | Creating this dependency would form a cycle; `error.path` lists the names in the loop: plain strings, or `{kind, name}` roadmap items when a milestone is on the loop. |
| — `date_order` | 409 | Deliverable dates violate dependency order; `error.earliest_start` and/or `error.latest_end` give the nearest allowed day (`earliest_date` / `latest_date` for a milestone's date). |
| `internal` | 500 | Unexpected server error, including a recovered panic (logged with the request id). |

### Example errors

**Non-JSON request body:**
```bash
curl -b cookies.txt -X POST http://localhost:8080/api/teams \
  -H "Content-Type: text/plain" \
  -d 'name=Platform'
```

Response (415 Unsupported Media Type):
```json
{
  "error": {
    "code": "unsupported_media_type",
    "message": "Send Content-Type: application/json, even for a request with no body"
  }
}
```

This applies to **every** write, even one that sends no body at all. Both of these get the exact same
`415`:
```bash
curl -b cookies.txt -X DELETE http://localhost:8080/api/teams/1
curl -b cookies.txt -X DELETE http://localhost:8080/api/workstreams/1
```

Response (415 Unsupported Media Type) for either:
```json
{
  "error": {
    "code": "unsupported_media_type",
    "message": "Send Content-Type: application/json, even for a request with no body"
  }
}
```

This is the CSRF defence (spec §8): a plain HTML form cannot set that header.

**Validation failure (end_date before start_date):**
```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/deliverables \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test",
    "start_date": "2026-06-30",
    "end_date": "2026-01-15",
    "workstream_ids": [1]
  }'
```

Response (422 Validation Failed):
```json
{
  "error": {
    "code": "validation_failed",
    "message": "Deliverable is not valid",
    "fields": {
      "end_date": "must not be before start_date"
    }
  }
}
```

**Team name already taken:**
```bash
curl -b cookies.txt -X POST http://localhost:8080/api/teams \
  -H "Content-Type: application/json" \
  -d '{"name": "Platform", "tag": "NEW", "default_color": "#000000"}'
```

Response (409 Conflict):
```json
{
  "error": {
    "code": "duplicate_name",
    "message": "A team named \"Platform\" already exists"
  }
}
```

**Unknown resource:**
```bash
curl http://localhost:8080/api/teams/999
```

Response (404 Not Found):
```json
{
  "error": {
    "code": "not_found",
    "message": "team 999 not found"
  }
}
```

## CSV download (Phase 8)

A roadmap can be downloaded as a CSV file for spreadsheets; the top bar's Download CSV button does the same. There is no JSON export and no import any more (the contract is in `docs/API.md`, "CSV download").

It is a read, so it needs no login. `-OJ` saves the file under the name the server suggests (`overlens-<team tag>-<title slug>-<YYYY-MM-DD>.csv`):

```bash
curl -OJ http://localhost:8080/api/roadmaps/1/export.csv
```

The file is UTF-8 with a BOM and CRLF line ends, one row per roadmap item (deliverable or milestone). The columns are `team, roadmap, workstreams, name, start_date, end_date, status, risk_note, responsible, color, description,
links, prerequisites, kind`; `kind` is `deliverable` or `milestone` (the last column; a milestone row has its date as start and end and an empty `color`). Lists are joined with `; `. A cell whose first non-space character is `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'` so a spreadsheet never runs it as a formula. An unknown id is `404 not_found`, a bad id `400 bad_request`. A download writes no audit entry.

### Health

```bash
curl http://localhost:8080/health
```
```json
{"status":"ok","version":"1.0.0"}
```

No login. `503` when the database cannot be read.

## Common Patterns

### Update a team's name
```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/teams/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "Platform (Updated)"}'
```

Response (200 OK):
```json
{
  "id": 1,
  "name": "Platform (Updated)",
  "tag": "PLAT",
  "default_color": "#3b82f6",
  "created_at": "2026-09-27T14:32:00Z"
}
```

Unchanged fields are not sent; only the field(s) you want to change.

### Update a deliverable's status
```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/deliverables/1 \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

Response (200 OK):
```json
{
  "id": 1,
  "roadmap_id": 1,
  "team_id": 1,
  "name": "Kubernetes Upgrade",
  "start_date": "2026-01-15",
  "end_date": "2026-03-31",
  "color": "#ef4444",
  "responsible_person": "Alice Chen",
  "description_html": "<p>Upgrade cluster to 1.28</p>",
  "status": "done",
  "risk_note": "",
  "icons": [],
  "workstream_ids": [1],
  "workstreams": [
    {
      "id": 1,
      "row": 0
    }
  ],
  "links": [
    {
      "id": 1,
      "label": "JIRA Ticket",
      "url": "https://jira.example.com/browse/INF-123",
      "position": 0
    }
  ],
  "created_at": "2026-09-27T14:32:20Z",
  "updated_at": "2026-09-27T14:34:00Z"
}
```

### Set a deliverable's row inside a workstream explicitly
Rows are normally picked by the server (the lowest one that doesn't overlap anything already there)
only when a deliverable enters a workstream it wasn't already a member of; a stored row otherwise never
moves on its own. To place it on a specific row instead — inside a workstream it already belongs to, or
one being added in the same request — send `rows`, keyed by workstream id:

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/deliverables/1 \
  -H "Content-Type: application/json" \
  -d '{"rows": {"1": 2}}'
```

Response (200 OK) — only `workstreams[].row` changes; everything else, including `updated_at`, stays
exactly as it was, because `rows` alone isn't one of the "simple" fields that bump it:
```json
{
  "id": 1,
  "roadmap_id": 1,
  "team_id": 1,
  "name": "Kubernetes Upgrade",
  "start_date": "2026-01-15",
  "end_date": "2026-03-31",
  "color": "#ef4444",
  "responsible_person": "Alice Chen",
  "description_html": "<p>Upgrade cluster to 1.28</p>",
  "status": "done",
  "risk_note": "",
  "icons": [],
  "workstream_ids": [1],
  "workstreams": [
    {
      "id": 1,
      "row": 2
    }
  ],
  "links": [
    {
      "id": 1,
      "label": "JIRA Ticket",
      "url": "https://jira.example.com/browse/INF-123",
      "position": 0
    }
  ],
  "created_at": "2026-09-27T14:32:20Z",
  "updated_at": "2026-09-27T14:34:00Z"
}
```

Naming a workstream id in `rows` that the deliverable doesn't belong to (and isn't being added to in
the same request, via `workstream_ids`) is `422 validation_failed`, field `rows`.

A row that is already taken on any of the deliverable's days is refused (REQ_API_051): two roadmap items never
share a row on the same day (both end days count; a milestone holds its one day). The same check runs on every
change of `start_date`/`end_date` and `workstream_ids`, in each workstream the deliverable belongs to. Nothing is
written and the message names the item in the way (the row is named as people count it: `1` is the top row, the stored row + 1). A `POST`
may send `rows` too; here row 0 of Developer Tools is CLI Refactor's in May:

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/deliverables \
  -H "Content-Type: application/json" \
  -d '{"name": "Plugin API", "start_date": "2026-05-01", "end_date": "2026-05-31", "workstream_ids": [2], "rows": {"2": 0}}'
```

Response (409 Conflict):
```json
{"error": {"code": "row_overlap", "message": "Overlaps \"CLI Refactor\" in Developer Tools, row 1"}}
```

### Reorder workstreams
To change the order of workstreams in a roadmap, send their IDs in the desired order:

```bash
curl -b cookies.txt -X PUT http://localhost:8080/api/roadmaps/1/workstreams/order \
  -H "Content-Type: application/json" \
  -d '{
    "ids": [2, 1]
  }'
```

Response (200 OK):
```json
{
  "items": [
    {"id": 2, "roadmap_id": 1, "name": "Developer Tools", "position": 0},
    {"id": 1, "roadmap_id": 1, "name": "Infrastructure", "position": 1}
  ],
  "total": 2
}
```

### Delete a workstream

Deleting a workstream never deletes its deliverables or its milestones — there is no such mode. If the
workstream still holds either, `target` (another workstream of the same roadmap) is required, or the
request is refused `409 has_roadmap_items`. This is a `DELETE` with no body, so it still needs
`Content-Type: application/json` (see "Every write needs Content-Type" above) even though nothing is
sent:

```bash
curl -b cookies.txt -X DELETE "http://localhost:8080/api/workstreams/1?target=2" \
  -H "Content-Type: application/json"
```

Response: `204 No Content`. The moved deliverables keep every other workstream they already belonged
to; a deliverable already in the target workstream just loses the membership it had in the deleted
one. Its milestones move to the target too, each placed at the lowest row there that doesn't overlap
anything already there (so the delete never makes an overlap and is never refused for one). Deleting a roadmap's last remaining workstream is refused `409 only_workstream`
(REQ_DAT_023), checked before the has_roadmap_items check.

### Create, move and delete a milestone

Same shape as a deliverable, but a single date instead of a range; moving one to another team has its own
endpoint ("Move a milestone to another team" below):

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/milestones \
  -H "Content-Type: application/json" \
  -d '{"name": "Beta launch", "date": "2026-04-01", "workstream_id": 2}'
```

Response (201 Created):
```json
{"id": 1, "roadmap_id": 1, "workstream_id": 2, "name": "Beta launch", "date": "2026-04-01", "row": 1, "description_html": "",
 "responsible_person": "", "status": "planned", "risk_note": "", "links": []}
```

Workstream `2` is used because workstream `1` no longer exists after "Delete a workstream" above (`workstream_id`
is required on create). `row` was picked by the server (the lowest one that doesn't overlap anything already
there: CLI Refactor holds row `0` on 2026-04-01) because this is the milestone's first time in workstream `2`. Moving it — by date, by workstream, or both at
once (e.g. dragging it in the UI to another row of another workstream) — is one `PATCH`; an explicit `row`
(also together with `workstream_id`) and every new `date` are checked like a deliverable's `rows`: a day and row
another roadmap item already holds is `409 row_overlap` naming it. A negative `row` is `422` (field `row`):

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/milestones/1 \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-15", "workstream_id": 2, "row": 1}'
```

**Owner, status, risk note and links (REQ_DAT_030, REQ_DAT_014).** A milestone has them just like a
deliverable, with the same field names and rules. They can be sent on create or changed later; `status` is `planned`,
`in_progress`, `done` or `at_risk`, and a risk note is kept only while the status is `at_risk` (any other status clears it):

```bash
curl -b cookies.txt -X PATCH http://localhost:8080/api/milestones/1 \
  -H "Content-Type: application/json" \
  -d '{"responsible_person": "Dana", "status": "at_risk", "risk_note": "Vendor contract late",
       "links": [{"label": "Release plan", "url": "https://example.com/release-plan"}]}'
```

Response (200 OK):
```json
{"id": 1, "roadmap_id": 1, "workstream_id": 2, "name": "Beta launch", "date": "2026-04-01", "row": 1, "description_html": "",
 "responsible_person": "Dana", "status": "at_risk", "risk_note": "Vendor contract late",
 "links": [{"id": 1, "label": "Release plan", "url": "https://example.com/release-plan", "position": 0}]}
```

Sending `links` replaces the whole set (omit it to leave the links alone; `"links": []` removes them all). An unknown
`status` is `422` (field `status`); a link URL that is not http(s) is `422` (field `links`). One `PATCH` writes one
`milestone.update` audit entry listing every field that changed.

```bash
curl -b cookies.txt -X DELETE http://localhost:8080/api/milestones/1 \
  -H "Content-Type: application/json"
```

Response: `204 No Content`.

### Read the 20 fixed icons, and relabel one

`GET /api/icons` needs no auth and always returns exactly 20 — every deliverable's `icons` field
(see step 4 above) must be a subset of these keys:

```bash
curl http://localhost:8080/api/icons
```

```json
{"items": [{"key": "star", "label": "High priority"}, {"key": "coins", "label": "Budget impact"}, "... 18 more"], "total": 20}
```

`label` is the *effective* label — an admin override if one was ever set for that key, otherwise the
built-in default. Relabeling is global: it changes what every viewer sees for that icon, on every
roadmap, immediately:

```bash
curl -b cookies.txt -X PUT http://localhost:8080/api/icons/star \
  -H "Content-Type: application/json" \
  -d '{"label": "Board priority"}'
```

Response (200 OK):
```json
{"key": "star", "label": "Board priority"}
```

A key outside the fixed 20 is `404 not_found`; the label is trimmed before it is stored, and a whitespace-only
one is `422` (field `label`, `required`); sending the label it already has is a no-op (no write,
no audit entry), same convention as everywhere else.

### Delete a team (and with it its roadmap)

A roadmap is deleted only together with its team (REQ_DAT_020, REQ_DAT_032). The delete is refused while the team's
roadmap still holds any deliverable or milestone — move or delete them first:

```bash
curl -b cookies.txt -X DELETE http://localhost:8080/api/teams/1 -H "Content-Type: application/json"
```

Response (409 Conflict) — nothing is touched:
```json
{
  "error": {
    "code": "has_roadmap_items",
    "message": "This team's roadmap still holds 2 roadmap item(s); move or delete them first"
  }
}
```

Once the roadmap holds none, the same request answers `204 No Content` and deletes the team, its roadmap and that
roadmap's workstreams in one transaction, with one `team.delete` audit entry `{team, tag, roadmap}`. An empty roadmap
has no dependencies or links, so nothing else goes with it.

### Move a deliverable to another team

Both move calls take the same body, `{team_id, workstream_map?: [{from, to}]}` (REQ_API_052), and the item always lands
on **another** team's roadmap (a team has only one). This needs a second team; creating it brings its roadmap:

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/teams \
  -H "Content-Type: application/json" \
  -d '{"name": "Mobile", "tag": "MOB", "default_color": "#f59e0b"}'
```

The response is team `2` ("Mobile") with `roadmap_id: 2`; that roadmap already has its `"General"` workstream
(`id: 3`).

Deliverable `1` (Kubernetes Upgrade) is, at this point in the walkthrough, in workstream `2` (Developer
Tools — see "Delete a workstream" above, which moved it there when workstream `1` was deleted). Move it
to team 2, mapping that one membership onto team 2's `"General"` workstream (`3`):

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/deliverables/1/move \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": 2,
    "workstream_map": [
      {"from": 2, "to": 3}
    ]
  }'
```

Response (200 OK):
```json
{
  "id": 1,
  "roadmap_id": 2,
  "team_id": 2,
  "name": "Kubernetes Upgrade",
  "start_date": "2026-01-15",
  "end_date": "2026-03-31",
  "color": "#ef4444",
  "responsible_person": "Alice Chen",
  "description_html": "<p>Upgrade cluster to 1.28</p>",
  "status": "done",
  "risk_note": "",
  "icons": [],
  "workstream_ids": [3],
  "workstreams": [
    {
      "id": 3,
      "row": 0
    }
  ],
  "links": [
    {
      "id": 1,
      "label": "JIRA Ticket",
      "url": "https://jira.example.com/browse/INF-123",
      "position": 0
    }
  ],
  "created_at": "2026-09-27T14:32:20Z",
  "updated_at": "2026-09-27T14:36:00Z"
}
```

The deliverable keeps its ID, dates, status, description, icons, links, responsible person, color and dependencies. It is
re-pointed to the destination roadmap and workstream(s), and one `deliverable.move` audit entry records
`{deliverable, from_team, to_team, from_roadmap_id, to_roadmap_id}`.

Each `to` is a destination workstream id, `{"create": "<name>"}` (a workstream of that name is reused if it exists) or
`null` to drop that membership (a deliverable only; at least one must remain). A workstream left out of the map goes
to the destination's workstream of the same name — trimmed, case ignored, the first by position — and is refused
`422` if there is none. Naming the deliverable's own team is `422` too.

The dependency stays in place: it is still `Kubernetes Upgrade → CLI Refactor` (prerequisite `1`, dependent `2`), now
across two teams. `GET /api/deliverables/2/dependencies` returns it with `other` describing deliverable `1` (team
`Mobile`, roadmap `2`). A move never changes dates, so the date rule can't refuse it.

### Move a milestone to another team

`POST /api/milestones/{id}/move` (admin) takes the same body and follows the same rules (REQ_API_013, 052); a milestone
has one workstream, so its map has at most one entry, and it can't be dropped. Milestone `1` was deleted above, so
create one on team 1's roadmap (it gets id `1` again: SQLite reuses the highest free id) and move it to team 2's
`"General"` workstream (`3`):

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/roadmaps/1/milestones \
  -H "Content-Type: application/json" \
  -d '{"name": "GA", "date": "2026-05-01", "workstream_id": 2}'
curl -b cookies.txt -X POST http://localhost:8080/api/milestones/1/move \
  -H "Content-Type: application/json" \
  -d '{"team_id": 2, "workstream_map": [{"from": 2, "to": 3}]}'
```

Response (200 OK):
```json
{"id": 1, "roadmap_id": 2, "workstream_id": 3, "name": "GA", "date": "2026-05-01", "row": 0, "description_html": "",
 "responsible_person": "", "status": "planned", "risk_note": "", "links": []}
```

The date, the owner, status, risk note, links and every dependency stay; the server picks a free `row` in the new
workstream. Instead of an id, `to` can be `{"create": "Launches"}`; with no map at all the destination's same-named
workstream is used. Refusals:

- `422 validation_failed`: the milestone's own team; an unknown team; no entry and no same-named workstream in the
  destination; a workstream of another roadmap; `"to": null`.
- `404 not_found`: an unknown milestone.
- `409 span_exceeded`: the destination would span more than 3 years.

## Notes

- **Dates** are exact days in `YYYY-MM-DD` format; no time component.
- **Timestamps** in responses (e.g., `created_at`, `updated_at`) are RFC 3339 UTC (e.g., `2026-09-27T14:32:00Z`).
- **Colors** are hex RGB codes (e.g., `#3b82f6`).
- **Status** values: `planned`, `in_progress`, `done`, `at_risk`.
- **Every write needs `Content-Type: application/json`**, including one with no body at all
  (every `DELETE`) — otherwise `415 unsupported_media_type`. `GET` never
  needs it.
- A deliverable's first workstream (in the `workstream_ids` list, ordered by workstream position) is its primary workstream.
- A deliverable's `workstreams` field lists the same memberships as `workstream_ids`, in the same order, each with
  its stored `row` — the stacked row it occupies inside that workstream. Rows are stored so they survive a reload
  and are the same for every viewer; the server only ever picks one itself when the deliverable enters a
  workstream it wasn't already in (the lowest row that doesn't overlap anything already there). A `PATCH` can set
  a row explicitly with `{"rows": {"<workstream id>": <row>}}`.
- `GET /api/roadmaps/{id}` (`RoadmapFull`) includes a `team` block (`{id, name, tag, default_color, roadmap_id, created_at}`)
  alongside `workstreams`, `deliverables`, `milestones` and `dependencies` (every edge with an end in that
  roadmap, each end described by `{id, name, team_name, roadmap_id, start_date, end_date}`) — the owning team's
  basics in the same call.
- Roadmap **span** is automatically calculated from the earliest to latest deliverable or milestone date, and is never more than 3 calendar years.
- Every team has exactly one roadmap, created with the team (title = the team's name) with one `"General"`
  workstream, in the same transaction (see steps 1-3 of the walkthrough); a roadmap always keeps at least one workstream.
- All IDs are integers.
