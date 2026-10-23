package api_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

func (g *rig) newMilestoneWith(rm, ws int64, extra map[string]any) store.Milestone {
	g.T.Helper()
	body := map[string]any{"name": "M", "date": g.Clock.Date(5), "workstream_id": ws}
	for k, v := range extra {
		body[k] = v
	}
	return must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones", body)
}

// REQ_DAT_029: the description defaults to "" and is returned everywhere a milestone is.
func Test_REQ_DAT_029_milestone_description_defaults_empty_and_is_returned(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	m := g.newMilestoneWith(rm, ws[0], nil)
	if m.DescriptionHTML != "" {
		t.Fatalf("default %q", m.DescriptionHTML)
	}
	raw, _ := json.Marshal(m)
	if !strings.Contains(string(raw), `"description_html":""`) {
		t.Errorf("key missing from JSON: %s", raw)
	}
	m2 := g.newMilestoneWith(rm, ws[0], map[string]any{"description_html": "<p>Hi</p>"})
	if m2.DescriptionHTML != "<p>Hi</p>" {
		t.Fatalf("created %q", m2.DescriptionHTML)
	}
	got, ok := g.milestoneByID(rm, m2.ID)
	if !ok || got.DescriptionHTML != "<p>Hi</p>" {
		t.Errorf("roadmap read %+v", got)
	}
}

// REQ_DAT_029, REQ_DAT_030: a move to another team keeps the milestone's description, owner, status,
// risk note and links.
func Test_REQ_DAT_029_REQ_DAT_030_REQ_API_013_move_keeps_milestone_fields(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	m := g.newMilestoneWith(rm, ws[0], map[string]any{"description_html": "<p>keep me</p>", "responsible_person": "Dana",
		"status": "at_risk", "risk_note": "vendor", "links": []map[string]string{{"label": "Plan", "url": "https://example.com/p"}}})
	dst := g.Team(testTeamOpts("", ""))
	dr := g.Roadmap(dst, roadmapOpts())
	x := must[store.Milestone](g, 200, "POST", "/api/milestones/"+id(m.ID)+"/move",
		map[string]any{"team_id": dst.ID, "workstream_map": []map[string]any{{"from": ws[0], "to": g.firstWorkstreamOf(dr.ID)}}})
	if x.DescriptionHTML != "<p>keep me</p>" || x.ResponsiblePerson != "Dana" || x.Status != "at_risk" || x.RiskNote != "vendor" ||
		len(x.Links) != 1 || x.Links[0].ID != m.Links[0].ID || x.RoadmapID != dr.ID {
		t.Errorf("move changed the milestone: %+v", x)
	}
}
