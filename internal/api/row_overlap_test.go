package api_test

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

// overlapRig: one roadmap with workstreams "Platform" and "Other". In Platform, row 0 holds the
// deliverable "Wall" (days 10..20) and the milestone "Gate" (day 30).
type overlapRig struct {
	*rig
	rm     int64
	a, b   int64 // Platform, Other
	wall   store.Deliverable
	gateID int64
}

func newOverlapRig(t *testing.T) *overlapRig {
	g := newRig(t)
	o := &overlapRig{rig: g}
	o.rm = g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts()).ID
	o.a = g.renameWorkstream(g.roadmap(o.rm).Workstreams[0].ID, "Platform").ID
	o.b = g.newWorkstream(o.rm, "Other").ID
	o.wall = g.newDeliverable(o.rm, []int64{o.a}, 10, 20, map[string]any{"name": "Wall"})
	o.gateID = must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(o.rm)+"/milestones",
		map[string]any{"name": "Gate", "date": g.Clock.Date(30), "workstream_id": o.a}).ID
	if o.wall.Workstreams[0].Row != 0 {
		t.Fatalf("setup: Wall in row %d", o.wall.Workstreams[0].Row)
	}
	return o
}

// refused requires 409 row_overlap with exactly msg, that nothing changed, and that no audit entry was written.
func (o *overlapRig) refused(method, path string, body any, msg string) {
	o.T.Helper()
	before, audits := o.roadmap(o.rm), o.auditCount()
	status, e := call[errResp](o.rig, method, path, body)
	if status != 409 || e.Error.Code != "row_overlap" || e.Error.Message != msg {
		o.T.Fatalf("%s %s: %d %s %q, want 409 row_overlap %q", method, path, status, e.Error.Code, e.Error.Message, msg)
	}
	after := o.roadmap(o.rm)
	if len(after.Deliverables) != len(before.Deliverables) || len(after.Milestones) != len(before.Milestones) || o.auditCount() != audits {
		o.T.Fatalf("%s %s: a refused write changed something", method, path)
	}
	if bad := o.RowOverlaps(); len(bad) > 0 {
		o.T.Fatalf("overlaps in the database: %v", bad)
	}
}

func (o *overlapRig) noOverlaps() {
	o.T.Helper()
	if bad := o.RowOverlaps(); len(bad) > 0 {
		o.T.Fatalf("overlaps in the database: %v", bad)
	}
}

func Test_REQ_API_051_deliverable_create_with_rows(t *testing.T) {
	o := newOverlapRig(t)
	body := func(s, e int) map[string]any {
		return map[string]any{"name": "New", "start_date": o.Clock.Date(s), "end_date": o.Clock.Date(e),
			"workstream_ids": []int64{o.a}, "rows": map[string]int{id(o.a): 0}}
	}
	path := "/api/roadmaps/" + id(o.rm) + "/deliverables"
	o.refused("POST", path, body(20, 25), `Overlaps "Wall" in Platform, row 1`) // ends the same day: both end days count
	o.refused("POST", path, body(25, 30), `Overlaps "Gate" in Platform, row 1`) // a milestone holds its one day
	d := must[store.Deliverable](o.rig, 201, "POST", path, body(21, 29))        // the days in between are free
	if d.Workstreams[0].Row != 0 {
		t.Errorf("row %d", d.Workstreams[0].Row)
	}
	// without rows the server picks a free row (REQ_DAT_026), never a clash
	d = o.newDeliverable(o.rm, []int64{o.a, o.b}, 12, 18, nil)
	if d.Workstreams[0].Row == 0 {
		t.Errorf("picked row 0 under Wall")
	}
	o.noOverlaps()
}

func Test_REQ_API_051_deliverable_patch_dates_rows_and_workstreams(t *testing.T) {
	o := newOverlapRig(t)
	path := func(d store.Deliverable) string { return "/api/deliverables/" + id(d.ID) }

	t.Run("dates", func(t *testing.T) {
		x := o.newDeliverable(o.rm, []int64{o.a}, 40, 45, map[string]any{"name": "X"}) // row 0, after Gate
		o.refused("PATCH", path(x), map[string]any{"start_date": o.Clock.Date(30)}, `Overlaps "Gate" in Platform, row 1`)
		must[store.Deliverable](o.rig, 200, "PATCH", path(x), map[string]any{"start_date": o.Clock.Date(31)})
	})
	t.Run("rows", func(t *testing.T) {
		y := o.newDeliverable(o.rm, []int64{o.a}, 10, 20, map[string]any{"name": "Y"}) // row 1, under Wall
		o.refused("PATCH", path(y), map[string]any{"rows": map[string]int{id(o.a): 0}}, `Overlaps "Wall" in Platform, row 1`)
		got := must[store.Deliverable](o.rig, 200, "PATCH", path(y), map[string]any{
			"start_date": o.Clock.Date(0), "end_date": o.Clock.Date(9), "rows": map[string]int{id(o.a): 0}}) // the day before Wall
		if got.Workstreams[0].Row != 0 {
			t.Errorf("row %d", got.Workstreams[0].Row)
		}
	})
	t.Run("workstream_ids", func(t *testing.T) {
		z := o.newDeliverable(o.rm, []int64{o.b}, 11, 19, map[string]any{"name": "Z"})
		o.refused("PATCH", path(z), map[string]any{"workstream_ids": []int64{o.a, o.b}, "rows": map[string]int{id(o.a): 0}},
			`Overlaps "Wall" in Platform, row 1`)
		got := must[store.Deliverable](o.rig, 200, "PATCH", path(z), map[string]any{"workstream_ids": []int64{o.a, o.b}}) // a free row is picked
		if got.Workstreams[0].ID != o.a || got.Workstreams[0].Row == 0 {
			t.Errorf("memberships %+v", got.Workstreams)
		}
	})
	t.Run("checked in every workstream", func(t *testing.T) {
		blocker := o.newDeliverable(o.rm, []int64{o.b}, 60, 70, map[string]any{"name": "Blocker"}) // Other, row 0
		if blocker.Workstreams[0].Row != 0 {
			t.Fatalf("Blocker row %d", blocker.Workstreams[0].Row)
		}
		w := o.newDeliverable(o.rm, []int64{o.a, o.b}, 50, 55, map[string]any{"name": "W"}) // row 0 in both
		o.refused("PATCH", path(w), map[string]any{"end_date": o.Clock.Date(60)}, `Overlaps "Blocker" in Other, row 1`)
		must[store.Deliverable](o.rig, 200, "PATCH", path(w), map[string]any{"end_date": o.Clock.Date(59)})
	})
	t.Run("a change elsewhere is not refused over an old overlap", func(t *testing.T) {
		// data written before this rule (here: straight into the database) may already overlap; a rename doesn't touch it
		v := o.newDeliverable(o.rm, []int64{o.a}, 12, 14, map[string]any{"name": "V"})
		if _, err := o.DB.Exec(`UPDATE deliverable_workstreams SET row=0 WHERE deliverable_id=?`, v.ID); err != nil {
			t.Fatal(err)
		}
		must[store.Deliverable](o.rig, 200, "PATCH", path(v), map[string]any{"name": "V2", "status": "done"})
		if _, err := o.DB.Exec(`DELETE FROM deliverables WHERE id=?`, v.ID); err != nil {
			t.Fatal(err)
		}
	})
	o.noOverlaps()
}

func Test_REQ_API_051_milestone_create_and_patch(t *testing.T) {
	o := newOverlapRig(t)
	create := "/api/roadmaps/" + id(o.rm) + "/milestones"
	ms := func(name string, day int, ws int64, row *int) map[string]any {
		b := map[string]any{"name": name, "date": o.Clock.Date(day), "workstream_id": ws}
		if row != nil {
			b["row"] = *row
		}
		return b
	}
	zero := 0
	o.refused("POST", create, ms("M", 20, o.a, &zero), `Overlaps "Wall" in Platform, row 1`)
	o.refused("POST", create, ms("M", 30, o.a, &zero), `Overlaps "Gate" in Platform, row 1`)
	must[store.Milestone](o.rig, 201, "POST", create, ms("Next day", 21, o.a, &zero))

	m := must[store.Milestone](o.rig, 201, "POST", create, ms("M", 50, o.a, nil)) // row 0
	p := "/api/milestones/" + id(m.ID)
	o.refused("PATCH", p, map[string]any{"date": o.Clock.Date(15)}, `Overlaps "Wall" in Platform, row 1`)
	must[store.Milestone](o.rig, 200, "PATCH", p, map[string]any{"date": o.Clock.Date(9)}) // the day before Wall

	n := must[store.Milestone](o.rig, 201, "POST", create, ms("N", 15, o.a, nil)) // row 1, under Wall
	if n.Row == 0 {
		t.Fatalf("picked row 0 under Wall")
	}
	o.refused("PATCH", "/api/milestones/"+id(n.ID), map[string]any{"row": 0}, `Overlaps "Wall" in Platform, row 1`)

	k := must[store.Milestone](o.rig, 201, "POST", create, ms("K", 15, o.b, nil)) // Other, row 0
	pk := "/api/milestones/" + id(k.ID)
	o.refused("PATCH", pk, map[string]any{"workstream_id": o.a, "row": 0}, `Overlaps "Wall" in Platform, row 1`)
	got := must[store.Milestone](o.rig, 200, "PATCH", pk, map[string]any{"workstream_id": o.a}) // a free row is picked
	if got.WorkstreamID != o.a || got.Row == 0 {
		t.Errorf("moved to %d row %d", got.WorkstreamID, got.Row)
	}
	o.noOverlaps()
}

// Moving items with a workstream delete or a move to another team gives each a free row: never a clash,
// never a refusal (a delete is never refused, REQ_API_051).
func Test_REQ_API_051_workstream_delete_and_move_pick_free_rows(t *testing.T) {
	o := newOverlapRig(t)
	c := o.newWorkstream(o.rm, "Doomed").ID
	o.newDeliverable(o.rm, []int64{c}, 10, 20, nil)                                    // row 0 in Doomed, same days as Wall
	o.newDeliverable(o.rm, []int64{c, o.a}, 25, 35, nil)                               // in Platform already (row 1, under Gate)
	must[store.Milestone](o.rig, 201, "POST", "/api/roadmaps/"+id(o.rm)+"/milestones", // same day as Gate
		map[string]any{"name": "Twin", "date": o.Clock.Date(30), "workstream_id": c})
	o.expect(204, "DELETE", "/api/workstreams/"+id(c)+"?target="+id(o.a), nil)
	o.noOverlaps()

	// a move: the destination's "Platform" row 0 is taken on the same days
	dst := o.Roadmap(o.Team(testTeamOpts("", "")), roadmapOpts())
	dws := o.renameWorkstream(o.roadmap(dst.ID).Workstreams[0].ID, "Platform").ID
	o.newDeliverable(dst.ID, []int64{dws}, 10, 20, nil)
	must[store.Milestone](o.rig, 201, "POST", "/api/roadmaps/"+id(dst.ID)+"/milestones",
		map[string]any{"name": "There", "date": o.Clock.Date(30), "workstream_id": dws})
	must[store.Deliverable](o.rig, 200, "POST", "/api/deliverables/"+id(o.wall.ID)+"/move", map[string]any{"team_id": dst.TeamID})
	must[store.Milestone](o.rig, 200, "POST", "/api/milestones/"+id(o.gateID)+"/move", map[string]any{"team_id": dst.TeamID})
	o.noOverlaps()
}

// Deleting is never refused, even when the data already overlaps.
func Test_REQ_API_051_delete_is_never_refused(t *testing.T) {
	o := newOverlapRig(t)
	v := o.newDeliverable(o.rm, []int64{o.a}, 12, 14, nil)
	if _, err := o.DB.Exec(`UPDATE deliverable_workstreams SET row=0 WHERE deliverable_id=?`, v.ID); err != nil {
		t.Fatal(err)
	}
	o.expect(204, "DELETE", "/api/milestones/"+id(o.gateID), nil)
	o.expect(204, "DELETE", "/api/deliverables/"+id(v.ID), nil)
	o.expect(204, "DELETE", "/api/deliverables/"+id(o.wall.ID), nil)
}
