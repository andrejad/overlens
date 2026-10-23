package api

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"time"
)

// Health is GET /health (REQ_DEPLOY_009): 200 {"status":"ok","version":...} when the database can be read, 503
// with the plain-text body "database unreachable" (REQ_API_019) when it cannot. It needs no login and never touches the session table; it
// only reads the database's schema. Registered by cmd/roadmap on the root router, outside /api.
func Health(db *sql.DB, version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		var n int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master`).Scan(&n); err != nil {
			slog.ErrorContext(r.Context(), "health: database unreachable", "err", err)
			http.Error(w, "database unreachable", http.StatusServiceUnavailable) // text/plain, the one non-JSON answer
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]string{"status": "ok", "version": version})
	}
}
