package store_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_DEP_008_candidates_carry_team_tag_and_order: the picker's list is ordered by team tag
// (not by team name), then milestones before deliverables, then name, and every
// candidate carries its team's tag.
func Test_REQ_DEP_008_candidates_carry_team_tag_and_order(t *testing.T) {
	e := testutil.NewEnv(t)
	// name order is Alpha < Zulu, tag order is ABC (Zulu) < ZED (Alpha)
	alpha := e.Team(testutil.TeamOpts{Name: "Alpha", Tag: "ZED"})
	zulu := e.Team(testutil.TeamOpts{Name: "Zulu", Tag: "ABC"})
	ra := e.Roadmap(alpha, testutil.RoadmapOpts{})
	rz := e.Roadmap(zulu, testutil.RoadmapOpts{})
	self := e.Deliverable(ra, testutil.DeliverableOpts{Name: "Self", StartDay: 100, EndDay: 110})
	e.Deliverable(ra, testutil.DeliverableOpts{Name: "a-deliv", StartDay: 0, EndDay: 10})
	e.Milestone(ra, testutil.MilestoneOpts{Name: "b-ms", Day: 5})
	e.Milestone(ra, testutil.MilestoneOpts{Name: "A-ms", Day: 6})
	e.Deliverable(rz, testutil.DeliverableOpts{Name: "z-deliv", StartDay: 0, EndDay: 10})
	e.Deliverable(rz, testutil.DeliverableOpts{Name: "B-deliv", StartDay: 0, EndDay: 10})
	e.Milestone(rz, testutil.MilestoneOpts{Name: "z-ms", Day: 7})

	cs, err := store.DependencyCandidates(context.Background(), e.DB, store.ItemRef{Kind: store.KindDeliverable, ID: self.ID})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range cs {
		want := map[int64]string{alpha.ID: "ZED", zulu.ID: "ABC"}[c.TeamID]
		if c.TeamTag != want {
			t.Errorf("%s: team_tag %q, want %q", c.Name, c.TeamTag, want)
		}
		got = append(got, c.TeamTag+"/"+c.Kind+"/"+c.Name)
	}
	want := []string{
		"ABC/milestone/z-ms", "ABC/deliverable/B-deliv", "ABC/deliverable/z-deliv",
		"ZED/milestone/A-ms", "ZED/milestone/b-ms", "ZED/deliverable/a-deliv",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("order\n got %v\nwant %v", got, want)
	}
}
