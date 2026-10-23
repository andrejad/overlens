package store_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

func moveIt(e *testutil.Env, kind string, id int64, in store.MoveInput) (store.MoveResult, error) {
	return store.ItemMove(context.Background(), e.DB, kind, id, in)
}

func to(v string) json.RawMessage { return json.RawMessage(v) }

func Test_REQ_API_013_milestone_move_destination_rules(t *testing.T) {
	t.Run("milestone move keeps dependencies", func(t *testing.T) {
		e := testutil.NewEnv(t)
		ctx := context.Background()
		src, dst := e.Team(testutil.TeamOpts{}), e.Team(testutil.TeamOpts{})
		rs, rd := e.Roadmap(src, testutil.RoadmapOpts{}), e.Roadmap(dst, testutil.RoadmapOpts{})
		d1 := e.Deliverable(rs, testutil.DeliverableOpts{Name: "D1", StartDay: 0, EndDay: 5})
		d2 := e.Deliverable(rs, testutil.DeliverableOpts{Name: "D2", StartDay: 20, EndDay: 25})
		m := e.Milestone(rs, testutil.MilestoneOpts{Name: "M", Day: 10})
		e.ItemDependency(dk, d1.ID, mk, m.ID)
		e.ItemDependency(mk, m.ID, dk, d2.ID)

		// the default workstream ("General") exists on both roadmaps, so the name match works
		res, err := moveIt(e, mk, m.ID, store.MoveInput{TeamID: dst.ID})
		if err != nil {
			t.Fatal(err)
		}
		got := res.Item.(store.Milestone)
		if got.RoadmapID != rd.ID || res.ToTeam != dst.Name || res.FromTeam != src.Name || got.Date != m.Date {
			t.Fatalf("move: %+v", res)
		}
		edges, err := store.DependenciesOf(ctx, e.DB, ref(mk, m.ID))
		if err != nil || len(edges) != 2 {
			t.Fatalf("edges after move: %+v %v", edges, err)
		}
		if n := e.DanglingMilestoneDependencies(); n != 0 {
			t.Errorf("%d dangling rows", n)
		}
	})

	e := testutil.NewEnv(t)
	src, dst := e.Team(testutil.TeamOpts{}), e.Team(testutil.TeamOpts{})
	rs, rd := e.Roadmap(src, testutil.RoadmapOpts{}), e.Roadmap(dst, testutil.RoadmapOpts{})
	wsSrc := e.Workstream(rs, "Only here")
	m := e.Milestone(rs, testutil.MilestoneOpts{Name: "M", Day: 3, WorkstreamID: wsSrc.ID})
	refused := func(in store.MoveInput) {
		t.Helper()
		_, err := moveIt(e, mk, m.ID, in)
		storeErr(t, err, "validation_failed")
	}
	// no same-named workstream in the destination; an unknown team
	refused(store.MoveInput{TeamID: dst.ID})
	refused(store.MoveInput{TeamID: 999999})
	// a workstream of another roadmap is refused; a milestone can't drop its workstream
	other := e.Workstream(rs, "Elsewhere")
	refused(store.MoveInput{TeamID: dst.ID, WorkstreamMap: []store.MoveEntry{{From: wsSrc.ID, To: to(strconv.FormatInt(other.ID, 10))}}})
	refused(store.MoveInput{TeamID: dst.ID, WorkstreamMap: []store.MoveEntry{{From: wsSrc.ID, To: to("null")}}})
	// its map has at most one entry, and that entry's from is its workstream
	refused(store.MoveInput{TeamID: dst.ID, WorkstreamMap: []store.MoveEntry{{From: other.ID, To: to(`{"create":"X"}`)}}})
	refused(store.MoveInput{TeamID: dst.ID, WorkstreamMap: []store.MoveEntry{
		{From: wsSrc.ID, To: to(`{"create":"X"}`)}, {From: wsSrc.ID, To: to(`{"create":"Y"}`)}}})

	// create a workstream on the fly
	res, err := moveIt(e, mk, m.ID, store.MoveInput{TeamID: dst.ID, WorkstreamMap: []store.MoveEntry{{From: wsSrc.ID, To: to(`{"create":"Brand new"}`)}}})
	if err != nil || res.Item.(store.Milestone).RoadmapID != rd.ID {
		t.Fatalf("create: %+v %v", res, err)
	}
}

// Test_REQ_API_052_one_move_for_both_kinds: one store function and one body for both kinds; the item's
// own team is refused; an unmapped workstream goes to the destination's workstream whose name matches
// by wsKey (trimmed, ASCII case ignored — the store's one workstream-name comparison), the first by
// position winning; {"create": name} reuses a workstream that already has that name.
func Test_REQ_API_052_one_move_for_both_kinds(t *testing.T) {
	e := testutil.NewEnv(t)
	src, dst := e.Team(testutil.TeamOpts{}), e.Team(testutil.TeamOpts{})
	rs, rd := e.Roadmap(src, testutil.RoadmapOpts{}), e.Roadmap(dst, testutil.RoadmapOpts{})
	plat := e.Workstream(rs, "Platform")
	accent := e.Workstream(rs, "Équipe")
	// two destination workstreams with the same wsKey can only be made behind the API's back; the
	// one with the lower position must win
	if _, err := e.DB.Exec(`INSERT INTO workstreams(roadmap_id, name, position) VALUES (?,?,9),(?,?,5)`, rd.ID, "platform", rd.ID, "PLATFORM"); err != nil {
		t.Fatal(err)
	}
	var first int64
	if err := e.DB.QueryRow(`SELECT id FROM workstreams WHERE roadmap_id=? AND name='PLATFORM'`, rd.ID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	e.Workstream(rd, "équipe") // differs from "Équipe" beyond ASCII case: no wsKey match

	d := e.Deliverable(rs, testutil.DeliverableOpts{WorkstreamIDs: []int64{plat.ID}})
	m := e.Milestone(rs, testutil.MilestoneOpts{Day: 2, WorkstreamID: plat.ID})
	for _, it := range []struct {
		kind string
		id   int64
	}{{dk, d.ID}, {mk, m.ID}} {
		_, err := moveIt(e, it.kind, it.id, store.MoveInput{TeamID: src.ID})
		storeErr(t, err, "validation_failed") // its own team
		res, err := moveIt(e, it.kind, it.id, store.MoveInput{TeamID: dst.ID})
		if err != nil {
			t.Fatalf("%s: %v", it.kind, err)
		}
		var ws int64
		switch v := res.Item.(type) {
		case store.Deliverable:
			ws = v.WorkstreamIDs[0]
		case store.Milestone:
			ws = v.WorkstreamID
		}
		if ws != first || res.FromRoadmapID != rs.ID || res.ToRoadmapID != rd.ID {
			t.Errorf("%s landed in workstream %d (want %d, the first by position): %+v", it.kind, ws, first, res)
		}
	}

	m2 := e.Milestone(rs, testutil.MilestoneOpts{Day: 4, WorkstreamID: accent.ID})
	_, err := moveIt(e, mk, m2.ID, store.MoveInput{TeamID: dst.ID})
	storeErr(t, err, "validation_failed") // "Équipe" vs "équipe": not the same name to wsKey
	// a create whose name matches an existing one (trimmed, case ignored) reuses it
	var before int
	e.DB.QueryRow(`SELECT COUNT(*) FROM workstreams WHERE roadmap_id=?`, rd.ID).Scan(&before)
	res, err := moveIt(e, mk, m2.ID, store.MoveInput{TeamID: dst.ID, WorkstreamMap: []store.MoveEntry{{From: accent.ID, To: to(`{"create":"  PLATFORM  "}`)}}})
	if err != nil || res.Item.(store.Milestone).WorkstreamID != first {
		t.Fatalf("create reusing a same-named workstream: %+v %v", res, err)
	}
	var after int
	e.DB.QueryRow(`SELECT COUNT(*) FROM workstreams WHERE roadmap_id=?`, rd.ID).Scan(&after)
	if after != before {
		t.Errorf("a duplicate workstream was created: %d -> %d", before, after)
	}
}
