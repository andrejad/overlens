-- The single definition of the database (spec section 5). Every statement is idempotent, so the same
-- file is applied on every start; store.Converge then adds any columns an older database lacks.
-- Columns added later must be nullable or have a constant default (SQLite ALTER TABLE ADD COLUMN).
-- Known limits when Converge adds a column to an existing table: DEFAULT CURRENT_TIMESTAMP (any
-- non-constant default) is not allowed, so the column is added nullable with no default; NOT NULL is
-- only kept with a constant default; CHECK, REFERENCES and COLLATE are not carried over. Fresh
-- databases get the full definition. Missing columns are added before this file's indexes are created.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  tag TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(tag) BETWEEN 2 AND 4 AND tag NOT GLOB '*[^A-Z]*'),
  default_color TEXT NOT NULL DEFAULT '#3b82f6' CHECK (default_color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS roadmaps (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL UNIQUE REFERENCES teams(id), -- one roadmap per team (REQ_DAT_032)
  title TEXT NOT NULL,
  range_start TEXT,
  range_end TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workstreams (
  id INTEGER PRIMARY KEY,
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deliverables (
  id INTEGER PRIMARY KEY,
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  color TEXT NOT NULL,
  responsible_person TEXT NOT NULL DEFAULT '',
  description_html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','at_risk')),
  risk_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Every dependency between roadmap items (REQ_DAT_007): from is the prerequisite, to the dependent, each a
-- deliverable or a milestone. There is no foreign key (the target table depends on the kind): the store
-- deletes the rows in the same transaction as the item or roadmap they touch.
CREATE TABLE IF NOT EXISTS dependencies (
  from_kind TEXT NOT NULL CHECK (from_kind IN ('deliverable','milestone')),
  from_id INTEGER NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('deliverable','milestone')),
  to_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (from_kind, from_id, to_kind, to_id)
);
-- The unique index serves the lookup by the "from" side; this one serves the lookup by the "to" side (the
-- date check reads an item's prerequisites by its own id, REQ_DEP_004), so it never scans the table.
CREATE INDEX IF NOT EXISTS dependencies_to ON dependencies(to_kind, to_id, from_kind, from_id);
CREATE TABLE IF NOT EXISTS deliverable_workstreams (
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams(id),
  row INTEGER NOT NULL DEFAULT 0, -- the stacked row (0, 1, 2, ...) the deliverable occupies in this workstream (REQ_DAT_026)
  PRIMARY KEY (deliverable_id, workstream_id)
);
CREATE TABLE IF NOT EXISTS deliverable_icons (
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  icon_key TEXT NOT NULL,
  PRIMARY KEY (deliverable_id, icon_key)
);
-- The links of every roadmap item, deliverable or milestone (REQ_DAT_031). There is no foreign key (the target
-- table depends on the kind): the store deletes the rows in the same transaction as the item or roadmap.
CREATE TABLE IF NOT EXISTS roadmap_item_links (
  id INTEGER PRIMARY KEY,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('deliverable','milestone')),
  item_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS roadmap_item_links_item ON roadmap_item_links(item_kind, item_id);
CREATE TABLE IF NOT EXISTS icon_labels (
  icon_key TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
  workstream_id INTEGER NOT NULL REFERENCES workstreams(id),
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  row INTEGER NOT NULL DEFAULT 0, -- the stacked row this milestone occupies in its workstream (REQ_DAT_026)
  description_html TEXT NOT NULL DEFAULT '', -- rich text, cleaned on save like a deliverable's (REQ_DAT_029)
  responsible_person TEXT NOT NULL DEFAULT '', -- owner, status and risk note as on a deliverable (REQ_DAT_030)
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','at_risk')),
  risk_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, -- SHA-256 hash of the cookie token, never the token itself
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  roadmap_id INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);
CREATE TABLE IF NOT EXISTS company_workstream_order (
  workstream_name TEXT PRIMARY KEY COLLATE NOCASE,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS company_team_order (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
