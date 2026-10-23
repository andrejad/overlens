package api

import (
	"log/slog"
	"net/http"
	"slices"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/store"
)

// Company view endpoints (Phase 7, REQ_API_022, 031, 036-039).

func (a *API) companyRoadmaps(w http.ResponseWriter, r *http.Request) {
	items, err := store.CompanyRoadmaps(r.Context(), a.DB)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items})
}

func (a *API) getTeamOrder(w http.ResponseWriter, r *http.Request) {
	items, err := store.TeamOrderGet(r.Context(), a.DB)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items})
}

// auditOrder writes one entry when a PUT changed the effective order or the saved list, and nothing
// when it changed neither (REQ_AUD_022, REQ_AUD_023). {from, to} are the effective orders by name;
// {saved_from, saved_to} (the stored list, in position order) are added only when the saved list changed.
func (a *API) auditOrder(r *http.Request, action string, ch store.OrderChange) {
	if !ch.Changed() {
		slog.InfoContext(r.Context(), "api: order unchanged, no audit entry", "action", action)
		return
	}
	d := map[string]any{"from": ch.From, "to": ch.To}
	if ch.SavedChanged() {
		d["saved_from"], d["saved_to"] = ch.SavedFrom, ch.SavedTo
	}
	slog.InfoContext(r.Context(), "api: order changed", "action", action, "effective_changed", !slices.Equal(ch.From, ch.To), "saved_changed", ch.SavedChanged())
	a.audit(r, AuditEntry{Action: action, EntityType: "company", Details: d})
}

func (a *API) putTeamOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TeamIDs *[]int64 `json:"team_ids"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.TeamIDs == nil {
		fail(w, r, store.ErrRequired("team_ids"))
		return
	}
	ch, after, err := store.TeamOrderSet(r.Context(), a.DB, *in.TeamIDs)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.auditOrder(r, "company.team_order", ch) // REQ_AUD_023
	writeJSON(w, r, http.StatusOK, map[string]any{"items": after})
}

func (a *API) getWorkstreamOrder(w http.ResponseWriter, r *http.Request) {
	items, err := store.WorkstreamOrderGet(r.Context(), a.DB)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items})
}

func (a *API) putWorkstreamOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Names *[]string `json:"names"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Names == nil {
		fail(w, r, store.ErrRequired("names"))
		return
	}
	ch, err := store.WorkstreamOrderSet(r.Context(), a.DB, *in.Names)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.auditOrder(r, "company.workstream_order", ch) // REQ_AUD_022
	writeJSON(w, r, http.StatusOK, map[string]any{"items": ch.To})
}

func (a *API) companyDependencies(w http.ResponseWriter, r *http.Request) {
	items, err := store.CompanyDependencies(r.Context(), a.DB)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items})
}

// companyTraceItem is GET /api/company/trace/{kind}/{id} (REQ_DEP_028): the typed trace.
func (a *API) companyTraceItem(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	kind := chi.URLParam(r, "kind")
	if !store.ValidKind(kind) {
		badRequest(w, r, "The kind in the address must be deliverable or milestone")
		return
	}
	tr, err := store.CompanyTraceItem(r.Context(), a.DB, store.ItemRef{Kind: kind, ID: id})
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, tr)
}

// companyAttention is GET /api/company/attention (REQ_API_054, REQ_API_055): open to anyone, "today" is the
// server's local date.
func (a *API) companyAttention(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	days := 14
	if q.Has("days") {
		n, err := strconv.Atoi(q.Get("days"))
		if err != nil || n < 1 || n > 90 {
			badRequest(w, r, "days must be a whole number from 1 to 90")
			return
		}
		days = n
	}
	var teamID int64
	if q.Has("team_id") {
		n, err := strconv.ParseInt(q.Get("team_id"), 10, 64)
		if err != nil || n <= 0 {
			badRequest(w, r, "team_id must be a positive whole number")
			return
		}
		teamID = n
	}
	today := a.now().Format("2006-01-02")
	items, err := store.CompanyAttention(r.Context(), a.DB, today, days, teamID)
	if err != nil {
		fail(w, r, err)
		return
	}
	slog.InfoContext(r.Context(), "api: attention list", "today", today, "days", days, "team_id", teamID, "items", len(items))
	writeJSON(w, r, http.StatusOK, map[string]any{"today": today, "days": days, "items": items})
}
