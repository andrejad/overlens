package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/andrejad/overlens/internal/store"
)

func (a *API) getDeliverable(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	d, err := store.DeliverableGet(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, d)
}

// delivDetails builds the audit Details every deliverable write shares: title/team are the roadmap's
// title and its team's name, already read inside the store call's own transaction (REQ_AUD_003) —
// this never re-queries them.
func delivDetails(title, team string, d store.Deliverable) map[string]any {
	return map[string]any{"deliverable": d.Name, "roadmap": title, "team": team}
}

func (a *API) createDeliverable(w http.ResponseWriter, r *http.Request) {
	rid, ok := pathID(w, r)
	if !ok {
		return
	}
	var in store.DeliverableInput
	if !decode(w, r, &in) {
		return
	}
	d, title, team, err := store.DeliverableCreate(r.Context(), a.DB, rid, in)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.audit(r, AuditEntry{Action: "deliverable.create", EntityType: "deliverable", EntityID: d.ID, RoadmapID: rid, Details: delivDetails(title, team, d)})
	writeJSON(w, r, http.StatusCreated, d)
}

// delivFields lists the simple (non-collection) fields a PATCH may change. Unlike team PATCH
// (updateTeam, one entry per changed field), a deliverable PATCH writes at most one audit entry for
// the whole request, listing every field that actually changed (REQ_API_027).
var delivFields = []string{"name", "start_date", "end_date", "color", "responsible_person", "description_html", "status", "risk_note"}

func delivFieldValue(d store.Deliverable, field string) string {
	switch field {
	case "name":
		return d.Name
	case "start_date":
		return d.StartDate
	case "end_date":
		return d.EndDate
	case "color":
		return d.Color
	case "responsible_person":
		return d.ResponsiblePerson
	case "description_html":
		return d.DescriptionHTML
	case "status":
		return d.Status
	case "risk_note":
		return d.RiskNote
	}
	return ""
}

// workstreamNamesJoined names ids using names (looked up inside the store write's own transaction,
// REQ_AUD_003), joined for the audit diff. A ok=false id (should never happen: wsNames covers every
// id in before's and after's WorkstreamIDs) is reported literally, never silently dropped.
func workstreamNamesJoined(names map[int64]string, ids []int64) string {
	out := make([]string, len(ids))
	for i, id := range ids {
		if n, ok := names[id]; ok {
			out[i] = n
		} else {
			out[i] = fmt.Sprintf("workstream %d", id)
		}
	}
	return strings.Join(out, ", ")
}

// rowPairs formats a deliverable's memberships as "<workstream name>:<row>, ..." for the audit diff
// (REQ_AUD_003: names, not bare ids, looked up inside the store write's own transaction), in the same
// primary-first order the response already carries.
func rowPairs(names map[int64]string, ms []store.WorkstreamMembership) string {
	pairs := make([]string, len(ms))
	for i, m := range ms {
		name := names[m.ID]
		pairs[i] = fmt.Sprintf("%s:%d", name, m.Row)
	}
	return strings.Join(pairs, ", ")
}

func (a *API) updateDeliverable(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in store.DeliverableInput
	if !decode(w, r, &in) {
		return
	}
	before, after, title, team, wsNames, err := store.DeliverableUpdate(r.Context(), a.DB, id, in)
	if err != nil {
		fail(w, r, err)
		return
	}

	// REQ_API_027: at most one deliverable.update audit entry for the whole request, listing every
	// field that actually changed as {field, from, to} — never a whole before/after object, never
	// split into one entry per field. Nothing changed writes nothing. Workstream, icon and link
	// changes are reported by name, not id (REQ_AUD_003).
	type change struct {
		Field string `json:"field"`
		From  string `json:"from"`
		To    string `json:"to"`
	}
	var changes []change
	for _, f := range delivFields {
		from, to := delivFieldValue(before, f), delivFieldValue(after, f)
		if from != to {
			changes = append(changes, change{f, from, to})
		}
	}
	if in.WorkstreamIDs != nil {
		from := workstreamNamesJoined(wsNames, before.WorkstreamIDs)
		to := workstreamNamesJoined(wsNames, after.WorkstreamIDs)
		if from != to {
			changes = append(changes, change{"workstreams", from, to})
		}
	}
	if in.Icons != nil && !slices.Equal(before.Icons, after.Icons) {
		changes = append(changes, change{"icons", strings.Join(before.Icons, ", "), strings.Join(after.Icons, ", ")})
	}
	if in.Links != nil && !slices.Equal(store.LinkPairs(before.Links), store.LinkPairs(after.Links)) {
		changes = append(changes, change{"links", strings.Join(store.LinkPairs(before.Links), ", "), strings.Join(store.LinkPairs(after.Links), ", ")})
	}
	if in.Rows != nil {
		from, to := rowPairs(wsNames, before.Workstreams), rowPairs(wsNames, after.Workstreams)
		if from != to {
			changes = append(changes, change{"rows", from, to})
		}
	}
	if len(changes) > 0 {
		d := delivDetails(title, team, after)
		d["changes"] = changes
		a.audit(r, AuditEntry{Action: "deliverable.update", EntityType: "deliverable", EntityID: id, RoadmapID: after.RoadmapID, Details: d})
	}
	slog.InfoContext(r.Context(), "deliverable updated", "deliverable_id", id, "changed_fields", len(changes))
	writeJSON(w, r, http.StatusOK, after)
}

func (a *API) deleteDeliverable(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	d, removed, title, team, err := store.DeliverableDelete(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	details := delivDetails(title, team, d)
	if len(removed) > 0 {
		// REQ_AUD_003: name every removed dependency by both ends' names and teams, not a bare count.
		details["dependencies_removed"] = removedNames(removed)
	}
	a.audit(r, AuditEntry{Action: "deliverable.delete", EntityType: "deliverable", EntityID: id, RoadmapID: d.RoadmapID, Details: details})
	w.WriteHeader(http.StatusNoContent)
}

// moveItem is both move endpoints (REQ_API_011, 013, 052): one body, one store function, one audit
// entry deliverable.move / milestone.move naming both teams and both roadmap ids (REQ_AUD_003).
func (a *API) moveItem(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		var in store.MoveInput
		if !decode(w, r, &in) {
			return
		}
		res, err := store.ItemMove(r.Context(), a.DB, kind, id, in)
		if err != nil {
			fail(w, r, err)
			return
		}
		action := "deliverable.move" // spelt out, so the audit action list test can find it (REQ_AUD_024)
		if kind == store.KindMilestone {
			action = "milestone.move"
		}
		a.audit(r, AuditEntry{Action: action, EntityType: kind, EntityID: id, RoadmapID: res.ToRoadmapID,
			Details: map[string]any{kind: res.Name, "from_team": res.FromTeam, "to_team": res.ToTeam,
				"from_roadmap_id": res.FromRoadmapID, "to_roadmap_id": res.ToRoadmapID}})
		writeJSON(w, r, http.StatusOK, res.Item)
	}
}
