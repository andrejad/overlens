package api

import (
	"encoding/csv"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/andrejad/overlens/internal/store"
)

// auditFilter reads the query filters shared by the audit list and the CSV (REQ_API_016/033).
func auditFilter(r *http.Request) store.AuditFilter {
	q := r.URL.Query()
	return store.AuditFilter{User: q.Get("user"), Action: q.Get("action"), Type: q.Get("type"),
		Team: q.Get("team"), Deliverable: q.Get("deliverable"), From: q.Get("from"), To: q.Get("to")}
}

func (a *API) listAudit(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := paging(w, r)
	if !ok {
		return
	}
	f := auditFilter(r)
	total, err := store.AuditCount(r.Context(), a.DB, f)
	if err != nil {
		fail(w, r, err)
		return
	}
	f.Limit, f.Offset = limit, offset
	items, err := store.AuditList(r.Context(), a.DB, f)
	if err != nil {
		fail(w, r, err)
		return
	}
	slog.InfoContext(r.Context(), "api: audit list", "total", total, "returned", len(items))
	writeJSON(w, r, http.StatusOK, struct {
		Items         []store.AuditEntry `json:"items"`
		Total         int                `json:"total"`
		RetentionDays int                `json:"retention_days"`
	}{items, total, a.AuditRetentionDays})
}

// csvPage is how many rows the export reads per query: the database has one connection, so it is
// released between pages instead of being held while a slow client downloads.
const csvPage = 500

func (a *API) exportAuditCSV(w http.ResponseWriter, r *http.Request) {
	f := auditFilter(r)
	f.Limit = csvPage
	// Fetch the first page before sending any header, so a bad date is a normal 422.
	page, err := store.AuditList(r.Context(), a.DB, f)
	if err != nil {
		fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="audit-`+time.Now().UTC().Format("2006-01-02")+`.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"id", "ts", "username", "action", "entity_type", "entity_id", "roadmap_id", "details"})
	id := func(p *int64) string {
		if p == nil {
			return ""
		}
		return strconv.FormatInt(*p, 10)
	}
	rows := 0
	for len(page) > 0 {
		extendWriteDeadline(w, r)
		for _, e := range page {
			details, _ := json.Marshal(e.Details)
			_ = cw.Write([]string{strconv.FormatInt(e.ID, 10), e.TS, csvSafe(e.Username), csvSafe(e.Action),
				csvSafe(e.EntityType), id(e.EntityID), id(e.RoadmapID), csvSafe(string(details))})
		}
		rows += len(page)
		if len(page) < csvPage {
			break
		}
		f.BeforeID = page[len(page)-1].ID
		if page, err = store.AuditList(r.Context(), a.DB, f); err != nil {
			slog.ErrorContext(r.Context(), "api: audit csv stopped part-way", "rows", rows, "err", err)
			break
		}
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		slog.ErrorContext(r.Context(), "api: audit csv write failed", "err", err)
	}
	slog.InfoContext(r.Context(), "api: audit csv", "rows", rows)
}
