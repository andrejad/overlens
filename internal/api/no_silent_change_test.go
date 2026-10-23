package api_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_OVR_011_no_write_deletes_or_overwrites_another_item_without_an_explicit_request: the data a user
// did not name is never touched. A workstream holding roadmap items cannot be deleted without saying where
// they go (and with a target they are moved, not deleted); a team whose roadmap holds items cannot be deleted;
// a refused delete changes nothing; a PATCH changes only the fields it sends; and a write to one item leaves
// the other items of the roadmap exactly as they were.
func Test_REQ_OVR_011_no_write_deletes_or_overwrites_another_item_without_an_explicit_request(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, testutil.RoadmapOpts{})
	ws := g.newWorkstream(rm.ID, "Source")
	other := g.newWorkstream(rm.ID, "Elsewhere")
	d := g.newDeliverable(rm.ID, []int64{ws.ID}, 0, 10, map[string]any{
		"name": "Keep me", "status": "in_progress", "responsible_person": "Pat", "color": "#1f9d6b",
		"description_html": "<p>notes</p>", "links": []map[string]string{{"label": "Spec", "url": "https://example.com/spec"}},
	})
	bystander := g.newDeliverable(rm.ID, []int64{other.ID}, 20, 30, map[string]any{"name": "Bystander"})
	g.rawMilestone(rm.ID, ws.ID, "Marker", g.Clock.Date(5))

	getMap := func(path string) map[string]any {
		t.Helper()
		var m map[string]any
		if err := json.Unmarshal(g.rawBytes(path), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	dPath := "/api/deliverables/" + id(d.ID)
	bPath := "/api/deliverables/" + id(bystander.ID)
	before := getMap(dPath)
	bystanderBefore := getMap(bPath)
	audits := g.auditCount()

	// 1. a workstream that still holds roadmap items is not deleted without a target; nothing changes
	if c := g.expect(409, "DELETE", "/api/workstreams/"+id(ws.ID), nil); c != "has_roadmap_items" {
		t.Errorf("workstream delete without a target: code %q", c)
	}
	// 2. a team whose roadmap holds items is not deleted
	if c := g.expect(409, "DELETE", "/api/teams/"+id(tm.ID), nil); c != "has_roadmap_items" {
		t.Errorf("team delete with items: code %q", c)
	}
	if g.auditCount() != audits {
		t.Errorf("refused deletes wrote %d audit entries", g.auditCount()-audits)
	}
	if !reflect.DeepEqual(getMap(dPath), before) || !reflect.DeepEqual(getMap(bPath), bystanderBefore) {
		t.Error("a refused delete changed a deliverable")
	}
	if full := g.roadmap(rm.ID); len(full.Milestones) != 1 || len(full.Workstreams) < 2 {
		t.Errorf("a refused delete removed a milestone or workstream: %d milestones, %d workstreams", len(full.Milestones), len(full.Workstreams))
	}

	// 3. a PATCH changes only the fields it sends
	g.expect(200, "PATCH", dPath, map[string]any{"name": "Renamed"})
	after := getMap(dPath)
	for _, k := range []string{"name", "updated_at"} {
		delete(before, k)
		delete(after, k)
	}
	if !reflect.DeepEqual(before, after) {
		t.Errorf("a PATCH of the name alone changed other fields:\nbefore %v\nafter  %v", before, after)
	}
	delete(bystanderBefore, "updated_at")
	bystanderAfter := getMap(bPath)
	delete(bystanderAfter, "updated_at")
	if !reflect.DeepEqual(bystanderBefore, bystanderAfter) {
		t.Errorf("a write to one deliverable changed another:\nbefore %v\nafter  %v", bystanderBefore, bystanderAfter)
	}

	// 4. with an explicit target the items are moved along, never deleted
	g.expect(204, "DELETE", "/api/workstreams/"+id(ws.ID)+"?target="+id(other.ID), nil)
	full := g.roadmap(rm.ID)
	if len(full.Deliverables) != 2 || len(full.Milestones) != 1 {
		t.Fatalf("the workstream delete lost items: %d deliverables, %d milestones", len(full.Deliverables), len(full.Milestones))
	}
	if full.Milestones[0].WorkstreamID != other.ID {
		t.Errorf("milestone not moved to the target: %+v", full.Milestones[0])
	}
	for _, x := range full.Deliverables {
		if len(x.WorkstreamIDs) != 1 || x.WorkstreamIDs[0] != other.ID {
			t.Errorf("deliverable %d not moved to the target: %v", x.ID, x.WorkstreamIDs)
		}
	}
}
