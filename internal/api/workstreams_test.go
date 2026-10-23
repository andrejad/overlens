package api_test

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

// REQ_DAT_023: a team's roadmap is created with one workstream called "General", in the same
// transaction — it's usable immediately (a deliverable can be created into it) and can be renamed like
// any other workstream.
func Test_REQ_DAT_023_new_roadmap_gets_general_workstream(t *testing.T) {
	g := newRig(t)
	tm := must[store.Team](g, 201, "POST", "/api/teams", map[string]any{"name": "Blank", "tag": "BLK"})
	rm := g.roadmap(tm.RoadmapID).Roadmap
	full := g.roadmap(rm.ID)
	if len(full.Workstreams) != 1 || full.Workstreams[0].Name != "General" {
		t.Fatalf("new roadmap workstreams: %+v", full.Workstreams)
	}
	// usable immediately: a deliverable can be created into it
	d := g.newDeliverable(rm.ID, []int64{full.Workstreams[0].ID}, 0, 5, nil)
	if len(d.WorkstreamIDs) != 1 || d.WorkstreamIDs[0] != full.Workstreams[0].ID {
		t.Errorf("General workstream not usable: %+v", d)
	}
	// renamed in place like any other workstream
	renamed := must[store.Workstream](g, 200, "PATCH", "/api/workstreams/"+id(full.Workstreams[0].ID), map[string]any{"name": "Core"})
	if renamed.Name != "Core" {
		t.Errorf("General not renamable: %+v", renamed)
	}

}
