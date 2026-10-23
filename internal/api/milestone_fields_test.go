package api_test

import (
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

func (g *rig) linkRows(kind string, itemID int64) int {
	g.T.Helper()
	var n int
	if err := g.DB.QueryRow(`SELECT COUNT(*) FROM roadmap_item_links WHERE item_kind=? AND item_id=?`, kind, itemID).Scan(&n); err != nil {
		g.T.Fatal(err)
	}
	return n
}

// REQ_DAT_030, REQ_DAT_010, REQ_DAT_011: owner, status and risk note default, are stored and returned.
func Test_REQ_DAT_030_milestone_owner_status_risk_note(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	m := g.newMilestoneWith(rm, ws[0], nil)
	if m.ResponsiblePerson != "" || m.Status != "planned" || m.RiskNote != "" || m.Links == nil || len(m.Links) != 0 {
		t.Fatalf("defaults %+v", m)
	}
	m2 := g.newMilestoneWith(rm, ws[0], map[string]any{"responsible_person": "Dana", "status": "at_risk", "risk_note": "late vendor"})
	if m2.ResponsiblePerson != "Dana" || m2.Status != "at_risk" || m2.RiskNote != "late vendor" {
		t.Fatalf("created %+v", m2)
	}
	if got, ok := g.milestoneByID(rm, m2.ID); !ok || got.RiskNote != "late vendor" || got.Status != "at_risk" {
		t.Errorf("roadmap read %+v", got)
	}
	// REQ_DAT_011: leaving at_risk clears the note
	u := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m2.ID), map[string]any{"status": "in_progress"})
	if u.Status != "in_progress" || u.RiskNote != "" {
		t.Errorf("risk note kept after leaving at_risk: %+v", u)
	}
	// a risk note on another status is dropped on create too
	m3 := g.newMilestoneWith(rm, ws[0], map[string]any{"status": "done", "risk_note": "x"})
	if m3.RiskNote != "" {
		t.Errorf("risk note on done: %+v", m3)
	}
	// 422 with the deliverable's field names
	for field, body := range map[string]map[string]any{
		"status":             {"status": "late"},
		"responsible_person": {"responsible_person": strings.Repeat("a", 201)},
		"risk_note":          {"status": "at_risk", "risk_note": strings.Repeat("a", 2001)},
	} {
		status, e := call[errResp](g, "PATCH", "/api/milestones/"+id(m.ID), body)
		if status != 422 || e.Error.Code != "validation_failed" || e.Error.Fields[field] == "" {
			t.Errorf("%s: %d %+v", field, status, e)
		}
	}
}

// REQ_DAT_031: deliverable links live in roadmap_item_links and go with the deliverable.
func Test_REQ_DAT_031_deliverable_links_stored_in_shared_table(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	d := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"links": []map[string]string{{"label": "Spec", "url": "https://example.com/s"}}})
	if len(d.Links) != 1 || g.linkRows("deliverable", d.ID) != 1 {
		t.Fatalf("links %+v rows %d", d.Links, g.linkRows("deliverable", d.ID))
	}
	// a milestone with the same numeric id does not mix with it
	m := g.newMilestoneWith(rm, ws[0], map[string]any{"links": []map[string]string{{"url": "https://example.com/m"}}})
	if got := g.roadmap(rm); len(got.Deliverables[0].Links) != 1 || got.Deliverables[0].Links[0].Label != "Spec" || len(got.Milestones[0].Links) != 1 {
		t.Errorf("mixed links: %+v %+v", got.Deliverables[0].Links, got.Milestones[0].Links)
	}
	g.expect(204, "DELETE", "/api/deliverables/"+id(d.ID), nil)
	if g.linkRows("deliverable", d.ID) != 0 || g.linkRows("milestone", m.ID) != 1 {
		t.Errorf("orphan or lost links after deliverable delete")
	}
}
