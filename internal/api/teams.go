package api

import (
	"log/slog"
	"net/http"

	"github.com/andrejad/overlens/internal/store"
)

func (a *API) listTeams(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := paging(w, r)
	if !ok {
		return
	}
	items, total, err := store.TeamsList(r.Context(), a.DB, limit, offset)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, list[store.Team]{items, total})
}

func (a *API) getTeam(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	t, err := store.TeamGet(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, t)
}

func (a *API) createTeam(w http.ResponseWriter, r *http.Request) {
	var in store.TeamInput
	if !decode(w, r, &in) {
		return
	}
	t, err := store.TeamCreate(r.Context(), a.DB, in)
	if err != nil {
		fail(w, r, err)
		return
	}
	// REQ_AUD_024: one team.create entry, which also names the roadmap created with the team (REQ_DAT_032).
	a.audit(r, AuditEntry{Action: "team.create", EntityType: "team", EntityID: t.ID, RoadmapID: t.RoadmapID,
		Details: map[string]any{"team": t.Name, "tag": t.Tag, "default_color": t.DefaultColor, "roadmap": t.Name}})
	writeJSON(w, r, http.StatusCreated, t)
}

func (a *API) updateTeam(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in store.TeamInput
	if !decode(w, r, &in) {
		return
	}
	before, after, err := store.TeamUpdate(r.Context(), a.DB, id, in)
	if err != nil {
		fail(w, r, err)
		return
	}
	// One audit entry per changed field (REQ_AUD_002); names are written as names (REQ_AUD_003).
	fields := []struct{ action, field, label, from, to string }{
		{"team.rename", "name", "Name", before.Name, after.Name},
		{"team.retag", "tag", "Tag", before.Tag, after.Tag},
		{"team.recolor", "default_color", "Color", before.DefaultColor, after.DefaultColor},
	}
	written := 0
	for _, f := range fields {
		if f.from == f.to {
			continue
		}
		summary := f.label + " " + f.from + " → " + f.to
		d := map[string]any{"team": after.Name, "field": f.field, "from": f.from, "to": f.to}
		d["summary"] = summary
		a.audit(r, AuditEntry{Action: f.action, EntityType: "team", EntityID: id, Details: d})
		written++
	}
	slog.InfoContext(r.Context(), "team updated", "team_id", id, "audit_entries", written)
	writeJSON(w, r, http.StatusOK, after)
}

func (a *API) deleteTeam(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	t, roadmap, err := store.TeamDelete(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.audit(r, AuditEntry{Action: "team.delete", EntityType: "team", EntityID: id, RoadmapID: t.RoadmapID,
		Details: map[string]any{"team": t.Name, "tag": t.Tag, "roadmap": roadmap}})
	w.WriteHeader(http.StatusNoContent)
}
