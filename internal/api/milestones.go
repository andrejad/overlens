package api

import (
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/andrejad/overlens/internal/store"
)

// milestoneDetails builds the audit Details every milestone write shares: title/team are the
// roadmap's title and its team's name, already read inside the store call's own transaction
// (REQ_AUD_003) — this never re-queries them.
func milestoneDetails(title, team string, m store.Milestone) map[string]any {
	return map[string]any{"milestone": m.Name, "roadmap": title, "team": team}
}

func (a *API) createMilestone(w http.ResponseWriter, r *http.Request) {
	rid, ok := pathID(w, r)
	if !ok {
		return
	}
	var in store.MilestoneInput
	if !decode(w, r, &in) {
		return
	}
	m, title, team, err := store.MilestoneCreate(r.Context(), a.DB, rid, in)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.audit(r, AuditEntry{Action: "milestone.create", EntityType: "milestone", EntityID: m.ID, RoadmapID: rid, Details: milestoneDetails(title, team, m)})
	writeJSON(w, r, http.StatusCreated, m)
}

func (a *API) updateMilestone(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in store.MilestoneInput
	if !decode(w, r, &in) {
		return
	}
	before, after, title, team, wsNames, err := store.MilestoneUpdate(r.Context(), a.DB, id, in)
	if err != nil {
		fail(w, r, err)
		return
	}

	// REQ_API_027-style: at most one milestone.update audit entry for the whole request, listing
	// every field that actually changed as {field, from, to}. Nothing changed writes nothing.
	// workstream is reported by name, not id (REQ_AUD_003).
	type change struct {
		Field string `json:"field"`
		From  string `json:"from"`
		To    string `json:"to"`
	}
	var changes []change
	if before.Name != after.Name {
		changes = append(changes, change{"name", before.Name, after.Name})
	}
	if before.Date != after.Date {
		changes = append(changes, change{"date", before.Date, after.Date})
	}
	if before.WorkstreamID != after.WorkstreamID {
		changes = append(changes, change{"workstream", wsNames[before.WorkstreamID], wsNames[after.WorkstreamID]})
	}
	if before.Row != after.Row {
		changes = append(changes, change{"row", strconv.Itoa(before.Row), strconv.Itoa(after.Row)})
	}
	if before.DescriptionHTML != after.DescriptionHTML {
		changes = append(changes, change{"description_html", before.DescriptionHTML, after.DescriptionHTML})
	}
	if before.ResponsiblePerson != after.ResponsiblePerson {
		changes = append(changes, change{"responsible_person", before.ResponsiblePerson, after.ResponsiblePerson})
	}
	if before.Status != after.Status {
		changes = append(changes, change{"status", before.Status, after.Status})
	}
	if before.RiskNote != after.RiskNote {
		changes = append(changes, change{"risk_note", before.RiskNote, after.RiskNote})
	}
	if in.Links != nil && !slices.Equal(store.LinkPairs(before.Links), store.LinkPairs(after.Links)) {
		changes = append(changes, change{"links", strings.Join(store.LinkPairs(before.Links), ", "), strings.Join(store.LinkPairs(after.Links), ", ")})
	}
	if len(changes) > 0 {
		d := milestoneDetails(title, team, after)
		d["changes"] = changes
		a.audit(r, AuditEntry{Action: "milestone.update", EntityType: "milestone", EntityID: id, RoadmapID: after.RoadmapID, Details: d})
	}
	slog.InfoContext(r.Context(), "milestone updated", "milestone_id", id, "changed_fields", len(changes))
	writeJSON(w, r, http.StatusOK, after)
}

func (a *API) deleteMilestone(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	m, removed, title, team, err := store.MilestoneDelete(r.Context(), a.DB, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	details := milestoneDetails(title, team, m)
	if len(removed) > 0 { // REQ_DEP_029
		details["dependencies_removed"] = removedNames(removed)
	}
	a.audit(r, AuditEntry{Action: "milestone.delete", EntityType: "milestone", EntityID: id, RoadmapID: m.RoadmapID, Details: details})
	w.WriteHeader(http.StatusNoContent)
}

// removedNames names each dependency taken away by a delete by both ends (REQ_AUD_003, REQ_DEP_029).
func removedNames(removed []store.RemovedDependency) []string {
	out := make([]string, len(removed))
	for i, d := range removed {
		out[i] = d.String()
	}
	return out
}
