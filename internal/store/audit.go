package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"modernc.org/sqlite"
)

// AuditEntry is one audit_log row as the viewer and the CSV show it. Details is the parsed
// details_json object; ts is UTC.
type AuditEntry struct {
	ID         int64          `json:"id"`
	TS         string         `json:"ts"`
	Username   string         `json:"username"`
	Action     string         `json:"action"`
	EntityType string         `json:"entity_type"`
	EntityID   *int64         `json:"entity_id"`
	RoadmapID  *int64         `json:"roadmap_id"`
	Details    map[string]any `json:"details"`
}

// AuditFilter selects audit rows (REQ_AUD_016). Empty fields do not filter.
//
//   - User, Action, Type: exact match; User ignores case.
//   - Team: the team name written into details_json at the time of the change (REQ_AUD_003), under
//     "team", or "from_team" / "to_team" for dependencies and deliverable moves; ignores case.
//   - Deliverable: case-insensitive (Unicode, so "Ärger" matches "ärger") substring of the roadmap item
//     name in details_json: "deliverable" or "milestone" (REQ_AUD_016), or "from" / "to" on dependency
//     entries. SQLite's lower() only folds ASCII, so the match is the SQL function contains_fold (Go's
//     Unicode lower-casing, registered below): the count, a page and each CSV page are one query each.
//   - From, To: YYYY-MM-DD, inclusive, in UTC (the clock audit_log.ts is stored in).
//
// No new index: rows are read by primary key order and the table is bounded by retention.
type AuditFilter struct {
	User, Action, Type, Team, Deliverable string
	From, To                              string
	Limit, Offset                         int
	BeforeID                              int64 // keyset paging for the CSV export: only rows with id < BeforeID
}

const auditTSLayout = "2006-01-02 15:04:05"

// contains_fold(s, sub) is 1 when s contains sub ignoring Unicode case (Go's strings.ToLower on both), 0
// otherwise or when s is NULL — the roadmap item name filter of the audit log (REQ_API_033, REQ_API_016).
func init() {
	sqlite.MustRegisterDeterministicScalarFunction("contains_fold", 2, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		s, ok1 := args[0].(string)
		sub, ok2 := args[1].(string)
		if ok1 && ok2 && strings.Contains(strings.ToLower(s), strings.ToLower(sub)) {
			return int64(1), nil
		}
		return int64(0), nil
	})
}

func (f AuditFilter) where() (string, []any, error) {
	var conds []string
	var args []any
	add := func(c string, a ...any) { conds = append(conds, c); args = append(args, a...) }
	if f.User != "" {
		add("username = ? COLLATE NOCASE", f.User)
	}
	if f.Action != "" {
		add("action = ?", f.Action)
	}
	if f.Type != "" {
		add("entity_type = ?", f.Type)
	}
	if f.Team != "" {
		add(`(json_extract(details_json,'$.team') = ? COLLATE NOCASE OR json_extract(details_json,'$.from_team') = ? COLLATE NOCASE
			OR json_extract(details_json,'$.to_team') = ? COLLATE NOCASE)`, f.Team, f.Team, f.Team)
	}
	if f.Deliverable != "" {
		add(`(contains_fold(CAST(json_extract(details_json,'$.deliverable') AS TEXT), ?)
			OR contains_fold(CAST(json_extract(details_json,'$.milestone') AS TEXT), ?)
			OR (entity_type = 'dependency' AND (contains_fold(CAST(json_extract(details_json,'$.from') AS TEXT), ?)
				OR contains_fold(CAST(json_extract(details_json,'$.to') AS TEXT), ?))))`,
			f.Deliverable, f.Deliverable, f.Deliverable, f.Deliverable)
	}
	if f.From != "" {
		d, err := time.Parse("2006-01-02", f.From)
		if err != nil {
			return "", nil, invalid1("from", "must be a date YYYY-MM-DD")
		}
		add("ts >= ?", d.Format(auditTSLayout))
	}
	if f.To != "" {
		d, err := time.Parse("2006-01-02", f.To)
		if err != nil {
			return "", nil, invalid1("to", "must be a date YYYY-MM-DD")
		}
		add("ts < ?", d.AddDate(0, 0, 1).Format(auditTSLayout))
	}
	if f.BeforeID > 0 {
		add("id < ?", f.BeforeID)
	}
	if len(conds) == 0 {
		return "", nil, nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args, nil
}

// AuditCount is how many rows match the filter (paging fields are ignored).
func AuditCount(ctx context.Context, db *sql.DB, f AuditFilter) (int, error) {
	f.BeforeID = 0
	w, args, err := f.where()
	if err != nil {
		return 0, err
	}
	var n int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM audit_log"+w, args...).Scan(&n); err != nil {
		slog.ErrorContext(ctx, "store: audit count failed", "err", err)
		return 0, err
	}
	return n, nil
}

// AuditList returns matching rows, newest first (by id, which grows with time), at most f.Limit
// (0 = 50) starting at f.Offset.
func AuditList(ctx context.Context, db *sql.DB, f AuditFilter) ([]AuditEntry, error) {
	w, args, err := f.where()
	if err != nil {
		return nil, err
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	args = append(args, f.Limit, f.Offset)
	rows, err := db.QueryContext(ctx, `SELECT id, ts, username, action, entity_type, entity_id, roadmap_id, details_json
		FROM audit_log`+w+` ORDER BY id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		slog.ErrorContext(ctx, "store: audit list failed", "err", err)
		return nil, err
	}
	defer rows.Close()
	items := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var eid, rid sql.NullInt64
		var dj string
		if err := rows.Scan(&e.ID, &e.TS, &e.Username, &e.Action, &e.EntityType, &eid, &rid, &dj); err != nil {
			return nil, err
		}
		if eid.Valid {
			e.EntityID = &eid.Int64
		}
		if rid.Valid {
			e.RoadmapID = &rid.Int64
		}
		if t, perr := time.Parse(auditTSLayout, e.TS); perr == nil {
			e.TS = t.UTC().Format("2006-01-02T15:04:05Z")
		}
		if err := json.Unmarshal([]byte(dj), &e.Details); err != nil || e.Details == nil {
			e.Details = map[string]any{}
		}
		items = append(items, e)
	}
	return items, rows.Err()
}

// AuditPurge deletes audit rows with ts before cutoff (UTC), batch rows per statement so the
// database's single connection is released between statements and requests are never starved
// (REQ_AUD_004). It returns how many rows went.
func AuditPurge(ctx context.Context, db *sql.DB, cutoff time.Time, batch int) (int64, error) {
	if batch <= 0 {
		batch = 500
	}
	c := cutoff.UTC().Format(auditTSLayout)
	var total int64
	for {
		res, err := db.ExecContext(ctx, `DELETE FROM audit_log WHERE id IN
			(SELECT id FROM audit_log WHERE ts < ? ORDER BY id LIMIT ?)`, c, batch)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
		if n < int64(batch) {
			return total, nil
		}
		if err := ctx.Err(); err != nil {
			return total, err
		}
	}
}
