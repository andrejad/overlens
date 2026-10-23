package api

import (
	"net/http"
	"strconv"

	"github.com/andrejad/overlens/internal/store"
)

type nameBody struct {
	Name string `json:"name"`
}

func (a *API) createWorkstream(w http.ResponseWriter, r *http.Request) {
	rid, ok := pathID(w, r)
	if !ok {
		return
	}
	var in nameBody
	if !decode(w, r, &in) {
		return
	}
	ws, title, team, err := store.WorkstreamCreate(r.Context(), a.DB, rid, in.Name)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.audit(r, AuditEntry{Action: "workstream.create", EntityType: "workstream", EntityID: ws.ID, RoadmapID: rid,
		Details: map[string]any{"workstream": ws.Name, "roadmap": title, "team": team}})
	writeJSON(w, r, http.StatusCreated, ws)
}

func (a *API) renameWorkstream(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in nameBody
	if !decode(w, r, &in) {
		return
	}
	before, after, title, team, err := store.WorkstreamRename(r.Context(), a.DB, id, in.Name)
	if err != nil {
		fail(w, r, err)
		return
	}
	if before.Name != after.Name { // a no-op rename writes no audit entry
		a.audit(r, AuditEntry{Action: "workstream.rename", EntityType: "workstream", EntityID: id, RoadmapID: after.RoadmapID,
			Details: map[string]any{"from": before.Name, "to": after.Name, "roadmap": title, "team": team}})
	}
	writeJSON(w, r, http.StatusOK, after)
}

func (a *API) reorderWorkstreams(w http.ResponseWriter, r *http.Request) {
	rid, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !decode(w, r, &in) {
		return
	}
	items, changed, title, team, err := store.WorkstreamReorder(r.Context(), a.DB, rid, in.IDs)
	if err != nil {
		fail(w, r, err)
		return
	}
	if changed { // sending the order the roadmap already has writes no audit entry
		names := make([]string, len(items))
		for i, ws := range items {
			names[i] = ws.Name
		}
		a.audit(r, AuditEntry{Action: "workstream.reorder", EntityType: "roadmap", EntityID: rid, RoadmapID: rid,
			Details: map[string]any{"order": names, "roadmap": title, "team": team}})
	}
	writeJSON(w, r, http.StatusOK, list[store.Workstream]{items, len(items)})
}

func (a *API) deleteWorkstream(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	var target int64
	if s := q.Get("target"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			badRequest(w, r, "target must be a workstream id")
			return
		}
		target = n
	}
	ws, held, heldMilestones, targetName, title, team, err := store.WorkstreamDelete(r.Context(), a.DB, id, target)
	if err != nil {
		fail(w, r, err)
		return
	}
	// REQ_AUD_003: the destination is named, not its bare id (REQ_API_025: there is no delete mode).
	details := map[string]any{"workstream": ws.Name, "deliverables_held": held, "milestones_held": heldMilestones, "roadmap": title, "team": team}
	if target != 0 {
		details["target_workstream"] = targetName
	}
	a.audit(r, AuditEntry{Action: "workstream.delete", EntityType: "workstream", EntityID: id, RoadmapID: ws.RoadmapID, Details: details})
	w.WriteHeader(http.StatusNoContent)
}
