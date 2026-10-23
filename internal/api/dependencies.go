package api

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/store"
)

// The dependency endpoints exist under both kinds of item: /deliverables/{id}/... and
// /milestones/{id}/... (REQ_API_040); kind is the kind of the {id} in the address, the dependent.

func (a *API) listDependencies(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		edges, err := store.DependenciesOf(r.Context(), a.DB, store.ItemRef{Kind: kind, ID: id})
		if err != nil {
			fail(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, edges)
	}
}

func (a *API) dependencyCandidates(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		cs, err := store.DependencyCandidates(r.Context(), a.DB, store.ItemRef{Kind: kind, ID: id})
		if err != nil {
			fail(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, cs)
	}
}

// depAudit is the entry dependency.create / dependency.delete share: names, not ids (REQ_AUD_003).
func depAudit(action string, from, to store.DepEnd) AuditEntry {
	return AuditEntry{Action: action, EntityType: "dependency", EntityID: to.ID, RoadmapID: to.RoadmapID,
		Details: map[string]any{"from": from.Name, "from_kind": from.Kind, "from_team": from.TeamName,
			"to": to.Name, "to_kind": to.Kind, "to_team": to.TeamName}}
}

func (a *API) addDependency(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		var in struct {
			FromKind *string `json:"from_kind"`
			FromID   *int64  `json:"from_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		if in.FromKind == nil {
			fail(w, r, store.ErrRequired("from_kind"))
			return
		}
		fromKind := *in.FromKind
		if !store.ValidKind(fromKind) {
			fail(w, r, &store.Error{Kind: store.Invalid, Code: "validation_failed", Msg: "from_kind: must be deliverable or milestone",
				Fields: map[string]string{"from_kind": "must be deliverable or milestone"}})
			return
		}
		if in.FromID == nil {
			fail(w, r, store.ErrRequired("from_id"))
			return
		}
		res, err := store.DependencyAddItems(r.Context(), a.DB, store.ItemRef{Kind: kind, ID: id}, store.ItemRef{Kind: fromKind, ID: *in.FromID}, "from_id")
		if err != nil {
			fail(w, r, err)
			return
		}
		if res.Created {
			a.audit(r, depAudit("dependency.create", res.From, res.To))
		} else {
			slog.InfoContext(r.Context(), "api: dependency already existed, no audit entry", "from", res.From.Name, "to", res.To.Name)
		}
		writeJSON(w, r, http.StatusCreated, res.Edge)
	}
}

// removeDependency serves DELETE /{deliverables|milestones}/{id}/dependencies/{fromKind}/{fromId}.
func (a *API) removeDependency(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		fromKind := chi.URLParam(r, "fromKind")
		if !store.ValidKind(fromKind) {
			badRequest(w, r, "The fromKind in the address must be deliverable or milestone")
			return
		}
		fromID, err := strconv.ParseInt(chi.URLParam(r, "fromId"), 10, 64)
		if err != nil || fromID <= 0 {
			badRequest(w, r, "The fromId in the address must be a positive integer")
			return
		}
		from, to, err := store.DependencyRemoveItems(r.Context(), a.DB, store.ItemRef{Kind: kind, ID: id}, store.ItemRef{Kind: fromKind, ID: fromID})
		if err != nil {
			fail(w, r, err)
			return
		}
		a.audit(r, depAudit("dependency.delete", from, to))
		w.WriteHeader(http.StatusNoContent)
	}
}
