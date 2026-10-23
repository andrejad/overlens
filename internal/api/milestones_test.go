package api_test

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

// milestoneByID finds a roadmap's milestone by id through the real GET /api/roadmaps/{id} — there
// is no GET /api/milestones/{id} endpoint (only create/update/delete, see docs/API.md's Milestones
// section).
func (g *rig) milestoneByID(rm, mid int64) (store.Milestone, bool) {
	g.T.Helper()
	for _, m := range g.roadmap(rm).Milestones {
		if m.ID == mid {
			return m, true
		}
	}
	return store.Milestone{}, false
}

// Test_REQ_API_005_milestone_create_update_delete covers the full CRUD vertical slice: create,
// update every field, delete.
func Test_REQ_API_005_milestone_create_update_delete(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	date := g.Clock.Date(5)
	m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "Launch", "date": date, "workstream_id": ws[0]})
	if m.Name != "Launch" || m.Date != date || m.WorkstreamID != ws[0] || m.RoadmapID != rm {
		t.Fatalf("created %+v", m)
	}
	if _, ok := g.milestoneByID(rm, m.ID); !ok {
		t.Fatal("created milestone not found in the roadmap")
	}
	newDate := g.Clock.Date(10)
	u := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID),
		map[string]any{"name": "GA", "date": newDate, "workstream_id": ws[1]})
	if u.Name != "GA" || u.Date != newDate || u.WorkstreamID != ws[1] {
		t.Fatalf("updated %+v", u)
	}
	g.expect(204, "DELETE", "/api/milestones/"+id(m.ID), nil)
	if _, ok := g.milestoneByID(rm, m.ID); ok {
		t.Error("milestone still present after delete")
	}

	// validation: name required, date required and must be a real date, workstream_id must belong
	// to this roadmap (422) or be a real workstream at all (404).
	if c := g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "", "date": date, "workstream_id": ws[0]}); c != "validation_failed" {
		t.Errorf("blank name code %q", c)
	}
	if c := g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "X", "date": "not-a-date", "workstream_id": ws[0]}); c != "validation_failed" {
		t.Errorf("bad date code %q", c)
	}
	other := g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts())
	otherWS := g.firstWorkstreamOf(other.ID)
	if c := g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "X", "date": date, "workstream_id": otherWS}); c != "validation_failed" {
		t.Errorf("foreign workstream_id code %q", c)
	}
	if c := g.expect(404, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "X", "date": date, "workstream_id": g.noSuchID()}); c != "not_found" {
		t.Errorf("unknown workstream_id code %q", c)
	}
}

// firstWorkstreamOf returns a roadmap's first workstream id through the real API.
func (g *rig) firstWorkstreamOf(rm int64) int64 {
	g.T.Helper()
	full := g.roadmap(rm)
	if len(full.Workstreams) == 0 {
		g.T.Fatalf("roadmap %d has no workstream", rm)
	}
	return full.Workstreams[0].ID
}

// Test_REQ_API_013_milestone_team_move: a milestone moves to another team's roadmap with one audit
// entry and keeps its date. Kept dependencies are Test_REQ_API_013_milestone_move_keeps_dependencies (store);
// the anonymous 401 is Test_REQ_API_002_every_write_route_needs_a_session.
func Test_REQ_API_013_milestone_team_move(t *testing.T) {
	t.Run("deliverable move leaves milestones behind", func(t *testing.T) {
		m := newMoveRig(t)
		m.rawMilestone(m.src.ID, m.srcWS[0].ID, "Launch", m.Clock.Date(3))
		// moving a deliverable leaves the milestones (and the workstream they sit in) behind
		m.expect(200, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", map[string]any{"team_id": m.dstTeam.ID,
			"workstream_map": []map[string]any{{"from": m.srcWS[1].ID, "to": m.dstWS[1].ID}}})
		src := m.roadmap(m.src.ID)
		if len(src.Milestones) != 1 || src.Milestones[0].RoadmapID != m.src.ID {
			t.Errorf("milestones %+v", src.Milestones)
		}
		if len(m.roadmap(m.dst.ID).Milestones) != 0 {
			t.Error("milestone appeared in the destination")
		}
		// source range still covers the milestone
		if src.RangeStart == nil || *src.RangeStart != m.Clock.Date(3) {
			t.Errorf("source range %v", src.RangeStart)
		}
		// REQ_API_025: a workstream still holding a milestone can't be deleted without a target either —
		// the same "move" gate as for deliverables, no separate has_milestones refusal any more
		if c := m.expect(409, "DELETE", "/api/workstreams/"+id(m.srcWS[0].ID), nil); c != "has_roadmap_items" {
			t.Errorf("code %q", c)
		}
		// deleting it with a target moves the milestone along too
		other := m.newWorkstream(m.src.ID, "Elsewhere")
		m.expect(204, "DELETE", "/api/workstreams/"+id(m.srcWS[0].ID)+"?target="+id(other.ID), nil)
		src2 := m.roadmap(m.src.ID)
		if len(src2.Milestones) != 1 || src2.Milestones[0].WorkstreamID != other.ID {
			t.Errorf("milestone not moved to the target workstream: %+v", src2.Milestones)
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "M", "date": g.Clock.Date(1), "workstream_id": ws[0]})
	dst := g.Team(testTeamOpts("", ""))
	dr := g.Roadmap(dst, roadmapOpts())
	dws := g.firstWorkstreamOf(dr.ID)
	before := g.auditCount()
	got := must[store.Milestone](g, 200, "POST", "/api/milestones/"+id(m.ID)+"/move",
		map[string]any{"team_id": dst.ID, "workstream_map": []map[string]any{{"from": ws[0], "to": dws}}})
	if got.RoadmapID != dr.ID || got.WorkstreamID != dws || got.Date != m.Date {
		t.Fatalf("moved: %+v", got)
	}
	if g.auditCount() != before+1 {
		t.Fatalf("%d audit entries", g.auditCount()-before)
	}
	if e := g.lastAudit(); e.Action != "milestone.move" || e.Details["milestone"] != "M" || e.Details["to_team"] != dst.Name || e.Details["to_roadmap_id"] != dr.ID {
		t.Errorf("audit %+v", e)
	}
	if c := g.expect(422, "POST", "/api/milestones/"+id(m.ID)+"/move", map[string]any{"team_id": dst.ID}); c != "validation_failed" {
		t.Errorf("moving into its own roadmap: code %q", c)
	}

}

// Test_REQ_DAT_026_milestone_row_survives_unrelated_patch: the stored row is exactly what REQ_DAT_026
// calls a hard rule — it stays put across a reload and across any patch that doesn't touch the
// workstream or the row itself.
func Test_REQ_DAT_026_REQ_API_029_milestone_row_survives_unrelated_patch(t *testing.T) {
	t.Run("milestone row picked on new workstream only", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		date := g.Clock.Date(5)
		a := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "A", "date": date, "workstream_id": ws[0]})
		if a.Row != 0 {
			t.Fatalf("first milestone into an empty workstream: row %d", a.Row)
		}
		// same date, same workstream: overlaps a's row, must be placed in a free one
		b := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "B", "date": date, "workstream_id": ws[0]})
		if b.Row == a.Row {
			t.Fatalf("overlapping milestones share a row: a=%d b=%d", a.Row, b.Row)
		}
		// moving b to ws[1] (empty) without an explicit row: server picks a fresh free row (0)
		moved := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(b.ID), map[string]any{"workstream_id": ws[1]})
		if moved.Row != 0 {
			t.Errorf("row not freshly picked on entering a new (empty) workstream: %d", moved.Row)
		}
		// an unrelated patch (name only) never touches the stored row
		renamed := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(b.ID), map[string]any{"name": "B2"})
		if renamed.Row != moved.Row {
			t.Errorf("row changed by an unrelated patch: was %d, now %d", moved.Row, renamed.Row)
		}
		// an explicit row is trusted as-is, even overlapping a's row in ws[0] — never auto-corrected
		explicit := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(a.ID), map[string]any{"row": 9})
		if explicit.Row != 9 {
			t.Errorf("explicit row not honored: %d", explicit.Row)
		}
		// the drag-to-move case: workstream_id and row sent together apply row to the destination
		dragged := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(renamed.ID),
			map[string]any{"workstream_id": ws[0], "row": 7})
		if dragged.WorkstreamID != ws[0] || dragged.Row != 7 {
			t.Errorf("drag-to-move with explicit row: %+v", dragged)
		}
	})

	t.Run("milestone row rejects negative", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		date := g.Clock.Date(5)
		if c := g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "A", "date": date, "workstream_id": ws[0], "row": -3}); c != "validation_failed" {
			t.Errorf("negative row on create code %q", c)
		}
		m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "A", "date": date, "workstream_id": ws[0]})
		if c := g.expect(422, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"row": -1}); c != "validation_failed" {
			t.Errorf("negative row on update code %q", c)
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	date := g.Clock.Date(3)
	must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "A", "date": date, "workstream_id": ws[0]})
	b := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		map[string]any{"name": "B", "date": date, "workstream_id": ws[0]})
	if b.Row == 0 {
		t.Fatalf("second overlapping milestone expected a non-zero row, got %d", b.Row)
	}
	u1 := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(b.ID), map[string]any{"name": "B renamed"})
	if u1.Row != b.Row {
		t.Errorf("row changed by a name-only patch: %d -> %d", b.Row, u1.Row)
	}
	u2 := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(b.ID), map[string]any{"date": g.Clock.Date(4)})
	if u2.Row != b.Row {
		t.Errorf("row changed by a date-only patch: %d -> %d", b.Row, u2.Row)
	}
	// a reload (fresh GET through the roadmap) shows the same row
	reloaded, ok := g.milestoneByID(rm, b.ID)
	if !ok || reloaded.Row != b.Row {
		t.Errorf("row not stable across reload: %+v", reloaded)
	}

}
