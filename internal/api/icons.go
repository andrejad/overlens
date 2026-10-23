package api

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/store"
)

// getIcons is anonymous (no auth) — every GET is (REQ_API_002).
func (a *API) getIcons(w http.ResponseWriter, r *http.Request) {
	items, err := store.IconsList(r.Context(), a.DB)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, list[store.Icon]{items, len(items)})
}

func (a *API) putIconLabel(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	var in struct {
		Label string `json:"label"`
	}
	if !decode(w, r, &in) {
		return
	}
	icon, before, changed, err := store.IconLabelSet(r.Context(), a.DB, key, in.Label)
	if err != nil {
		fail(w, r, err)
		return
	}
	if changed { // no-op relabel writes no audit entry
		a.audit(r, AuditEntry{Action: "icon.relabel", EntityType: "icon", EntityID: 0,
			Details: map[string]any{"icon": key, "from": before, "to": icon.Label}})
	}
	slog.InfoContext(r.Context(), "icon label updated", "icon_key", key, "changed", changed)
	writeJSON(w, r, http.StatusOK, icon)
}
