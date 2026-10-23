package api

import (
	"net/http"

	"github.com/andrejad/overlens/internal/store"
)

type titleBody struct {
	Title string `json:"title"`
}

func (a *API) getRoadmap(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	f, err := store.RoadmapFullGet(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, f)
}

func (a *API) renameRoadmap(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in titleBody
	if !decode(w, r, &in) {
		return
	}
	before, after, team, err := store.RoadmapRename(r.Context(), a.DB, id, in.Title)
	if err != nil {
		fail(w, r, err)
		return
	}
	if before.Title != after.Title { // a no-op rename writes no audit entry
		a.audit(r, AuditEntry{Action: "roadmap.rename", EntityType: "roadmap", EntityID: id, RoadmapID: id,
			Details: map[string]any{"team": team, "from": before.Title, "to": after.Title}})
	}
	writeJSON(w, r, http.StatusOK, after)
}
