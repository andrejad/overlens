// Package audit writes audit_log rows (REQ_AUD_001, 019, 020).
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/auth"
)

// SystemUser is the actor recorded for entries the server makes itself (REQ_AUD_020).
const SystemUser = "system"

// Writer is the real api.Auditor. The actor is the admin in the request context, as they are at
// the time of writing (their id and username are copied into the row); with no user in the
// context the entry belongs to the system: user_id NULL, username "system".
type Writer struct{ db *sql.DB }

func New(db *sql.DB) *Writer { return &Writer{db: db} }

// Record inserts one row. It is deliberately a standalone statement, not part of the change's own
// transaction: a failure is returned for the caller to log, and never undoes the change
// (REQ_AUD_018).
func (w *Writer) Record(ctx context.Context, e api.AuditEntry) error {
	var uid any
	name := SystemUser
	if u := auth.UserFromContext(ctx); u != nil {
		uid, name = u.ID, u.Username
	}
	details := e.Details
	if details == nil {
		details = map[string]any{}
	}
	dj, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = w.db.ExecContext(ctx, `INSERT INTO audit_log(user_id, username, action, entity_type, entity_id, roadmap_id, details_json)
		VALUES (?,?,?,?,?,?,?)`, uid, name, e.Action, e.EntityType, nullID(e.EntityID), nullID(e.RoadmapID), string(dj))
	if err != nil {
		return err
	}
	slog.DebugContext(ctx, "audit: row written", "action", e.Action, "actor", name)
	return nil
}

func nullID(n int64) any {
	if n == 0 {
		return nil
	}
	return n
}
