package api_test

import (
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type moveRig struct {
	*rig
	srcTeam, dstTeam testutil.Team
	src, dst         testutil.Roadmap
	srcWS            []store.Workstream // "Platform", "Only here"
	dstWS            []store.Workstream // "platform" (different case), "Other"
	d                store.Deliverable
}

func newMoveRig(t *testing.T) *moveRig {
	g := newRig(t)
	m := &moveRig{rig: g}
	m.srcTeam, m.dstTeam = g.Team(testTeamOpts("", "")), g.Team(testTeamOpts("", ""))
	m.src, m.dst = g.Roadmap(m.srcTeam, roadmapOpts()), g.Roadmap(m.dstTeam, roadmapOpts())
	// REQ_DAT_023: each roadmap already carries an automatic "General" workstream — reused here as
	// the first named one instead of adding an extra, so each roadmap holds exactly two, as before.
	m.srcWS = []store.Workstream{g.renameWorkstream(g.roadmap(m.src.ID).Workstreams[0].ID, "Platform"), g.newWorkstream(m.src.ID, "Only here")}
	m.dstWS = []store.Workstream{g.renameWorkstream(g.roadmap(m.dst.ID).Workstreams[0].ID, "platform"), g.newWorkstream(m.dst.ID, "Other")}
	m.d = g.newDeliverable(m.src.ID, []int64{m.srcWS[0].ID, m.srcWS[1].ID}, 5, 25, map[string]any{
		"color": "#112233", "status": "at_risk", "risk_note": "late", "responsible_person": "Bo", "description_html": "<b>d</b>",
		"icons": []string{"flag", "rocket"}, "links": []map[string]string{{"label": "L", "url": "https://x.example"}}})
	return m
}

func (m *moveRig) move(want int, body map[string]any) string {
	m.T.Helper()
	return m.expect(want, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", body)
}

func Test_REQ_API_011_move_is_one_step_with_one_audit_entry(t *testing.T) {
	m := newMoveRig(t)
	before := m.auditCount()
	got := must[store.Deliverable](m.rig, 200, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", map[string]any{
		"team_id": m.dstTeam.ID,
		"workstream_map": []map[string]any{
			{"from": m.srcWS[1].ID, "to": map[string]string{"create": "Brand new"}}, // "Platform" is unmapped: same-named match
		}})
	if got.RoadmapID != m.dst.ID || got.TeamID != m.dstTeam.ID || got.ID != m.d.ID {
		t.Fatalf("re-pointing: %+v", got)
	}
	full := m.roadmap(m.dst.ID)
	names := map[int64]string{}
	for _, w := range full.Workstreams {
		names[w.ID] = w.Name
	}
	if len(full.Workstreams) != 3 || len(got.WorkstreamIDs) != 2 || names[got.WorkstreamIDs[0]] != "platform" || names[got.WorkstreamIDs[1]] != "Brand new" {
		t.Errorf("workstreams %v -> %v", names, got.WorkstreamIDs)
	}
	if len(m.roadmap(m.src.ID).Deliverables) != 0 || len(full.Deliverables) != 1 {
		t.Error("deliverable not moved out of the source / into the destination")
	}
	if m.auditCount() != before+1 {
		t.Fatalf("%d audit entries for the move", m.auditCount()-before)
	}
	e := m.lastAudit()
	if e.Action != "deliverable.move" || e.Details["deliverable"] != m.d.Name || e.Details["from_team"] != m.srcTeam.Name ||
		e.Details["to_team"] != m.dstTeam.Name || e.Details["from_roadmap_id"] != m.src.ID || e.Details["to_roadmap_id"] != m.dst.ID {
		t.Errorf("audit %+v", e)
	}
	// the source range is recomputed (empty now); the destination's covers the deliverable
	if r := m.roadmap(m.src.ID); r.RangeStart != nil {
		t.Errorf("source range %v", r.RangeStart)
	}
	if r := full; r.RangeStart == nil || *r.RangeStart != m.d.StartDate {
		t.Errorf("destination range %v", r.RangeStart)
	}
}

func Test_REQ_API_011_move_mapping_rules_and_atomicity(t *testing.T) {
	t.Run("move create workstream name is validated", func(t *testing.T) {
		m := newMoveRig(t)
		count := func() int {
			m.T.Helper()
			var w int
			if err := m.DB.QueryRow(`SELECT COUNT(*) FROM workstreams`).Scan(&w); err != nil {
				m.T.Fatal(err)
			}
			return w
		}
		before := count()
		tooLong := strings.Repeat("x", 201)
		if c := m.move(422, map[string]any{"team_id": m.dstTeam.ID, "workstream_map": []map[string]any{
			{"from": m.srcWS[0].ID, "to": map[string]string{"create": tooLong}}, {"from": m.srcWS[1].ID, "to": nil}}}); c != "validation_failed" {
			t.Errorf("too-long create name: code = %q, want validation_failed", c)
		}
		if c := m.move(422, map[string]any{"team_id": m.dstTeam.ID, "workstream_map": []map[string]any{
			{"from": m.srcWS[0].ID, "to": map[string]string{"create": "   "}}, {"from": m.srcWS[1].ID, "to": nil}}}); c != "validation_failed" {
			t.Errorf("blank create name: code = %q, want validation_failed", c)
		}
		if after := count(); after != before {
			t.Errorf("a workstream was created despite the invalid name: %d workstreams before, %d after", before, after)
		}
	})

	t.Run("workstream map missing to key is rejected", func(t *testing.T) {
		m := newMoveRig(t)
		if c := m.expect(422, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", map[string]any{"team_id": m.dstTeam.ID,
			"workstream_map": []map[string]any{{"from": m.srcWS[0].ID}, {"from": m.srcWS[1].ID, "to": nil}}}); c != "validation_failed" {
			t.Errorf("code %q", c)
		}
		if got := must[store.Deliverable](m.rig, 200, "GET", "/api/deliverables/"+id(m.d.ID), nil); got.RoadmapID != m.src.ID {
			t.Error("refused move was applied")
		}
	})

	m := newMoveRig(t)
	count := func() (int, int) {
		m.T.Helper()
		var w, dw int
		if err := m.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM workstreams), (SELECT COUNT(*) FROM deliverable_workstreams)`).Scan(&w, &dw); err != nil {
			m.T.Fatal(err)
		}
		return w, dw
	}
	w0, dw0 := count()
	unchanged := func(what string) {
		t.Helper()
		if w, dw := count(); w != w0 || dw != dw0 {
			t.Errorf("%s: partial change left behind (%d/%d workstreams, %d/%d memberships)", what, w, w0, dw, dw0)
		}
		if got := must[store.Deliverable](m.rig, 200, "GET", "/api/deliverables/"+id(m.d.ID), nil); got.RoadmapID != m.src.ID {
			t.Errorf("%s: deliverable moved", what)
		}
	}
	// "Only here" has no same-named destination workstream and is unmapped
	m.move(422, map[string]any{"team_id": m.dstTeam.ID})
	unchanged("unmapped without a match")
	// creating a workstream and then failing later must roll the creation back. The deliverable's
	// workstream ids are processed in position order (srcWS[0] "Platform" first), so the create
	// must be mapped to the one processed first and the failing map to the one processed second,
	// or the failure would be hit before the create ever ran.
	m.move(422, map[string]any{"team_id": m.dstTeam.ID, "workstream_map": []map[string]any{
		{"from": m.srcWS[0].ID, "to": map[string]string{"create": "Temp"}}, {"from": m.srcWS[1].ID, "to": m.noSuchID()}}})
	unchanged("bad destination workstream (workstream created just before the failure must not persist)")
	// dropping everything is refused
	m.move(422, map[string]any{"team_id": m.dstTeam.ID, "workstream_map": []map[string]any{
		{"from": m.srcWS[0].ID, "to": nil}, {"from": m.srcWS[1].ID, "to": nil}}})
	unchanged("drop all")
	m.move(422, map[string]any{"team_id": m.dstTeam.ID, "workstream_map": []map[string]any{{"from": m.noSuchID(), "to": nil}}})
	m.move(422, map[string]any{"team_id": m.dstTeam.ID, "workstream_map": []map[string]any{{"from": m.srcWS[1].ID, "to": "nonsense"}}})
	unchanged("bad map")

	// map to an existing workstream, drop the other: keeps one membership
	got := must[store.Deliverable](m.rig, 200, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", map[string]any{"team_id": m.dstTeam.ID,
		"workstream_map": []map[string]any{{"from": m.srcWS[0].ID, "to": m.dstWS[1].ID}, {"from": m.srcWS[1].ID, "to": nil}}})
	if len(got.WorkstreamIDs) != 1 || got.WorkstreamIDs[0] != m.dstWS[1].ID {
		t.Errorf("membership %v", got.WorkstreamIDs)
	}
	// moving where it already is
	m.move(422, map[string]any{"team_id": m.dstTeam.ID})
	m.move(422, map[string]any{"team_id": m.noSuchID()})

}

func Test_REQ_DAT_021_REQ_DEP_030_move_keeps_everything_about_the_deliverable(t *testing.T) {
	m := newMoveRig(t)
	other := m.newDeliverable(m.src.ID, m.dstWSIDs(m.srcWS), 40, 50, nil)
	m.Dependency(testutil.Deliverable{ID: m.d.ID}, testutil.Deliverable{ID: other.ID}) // other depends on d
	before := m.d
	after := must[store.Deliverable](m.rig, 200, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", map[string]any{"team_id": m.dstTeam.ID,
		"workstream_map": []map[string]any{{"from": m.srcWS[1].ID, "to": m.dstWS[1].ID}}})
	if after.ID != before.ID || after.StartDate != before.StartDate || after.EndDate != before.EndDate || after.Status != before.Status ||
		after.RiskNote != before.RiskNote || after.DescriptionHTML != before.DescriptionHTML || after.ResponsiblePerson != before.ResponsiblePerson ||
		after.Color != before.Color || after.Name != before.Name || after.CreatedAt != before.CreatedAt {
		t.Errorf("fields changed:\nbefore %+v\nafter  %+v", before, after)
	}
	if len(after.Icons) != 2 || after.Icons[0] != before.Icons[0] || len(after.Links) != 1 || after.Links[0].ID != before.Links[0].ID {
		t.Errorf("icons/links changed: %+v %+v", after.Icons, after.Links)
	}
	var n int
	if err := m.DB.QueryRow(`SELECT COUNT(*) FROM dependencies WHERE from_kind='deliverable' AND to_kind='deliverable' AND from_id=? AND to_id=?`, m.d.ID, other.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Error("dependency lost by the move")
	}
	// team color changed for the destination, but the deliverable keeps its own
	if after.Color != "#112233" {
		t.Errorf("color %q", after.Color)
	}
}

func (m *moveRig) dstWSIDs(ws []store.Workstream) []int64 {
	var ids []int64
	for _, w := range ws {
		ids = append(ids, w.ID)
	}
	return ids
}

// REQ_API_012: a team has one roadmap, so a move always goes to another team; naming the item's own
// team, or a team that does not exist, is refused 422 and changes nothing.
func Test_REQ_API_012_move_goes_to_another_team_only(t *testing.T) {
	m := newMoveRig(t)
	for _, team := range []int64{m.srcTeam.ID, m.noSuchID()} {
		if c := m.move(422, map[string]any{"team_id": team}); c != "validation_failed" {
			t.Errorf("team %d: code %q", team, c)
		}
	}
	ms := m.rawMilestone(m.src.ID, m.srcWS[0].ID, "M", m.Clock.Date(3))
	if c := m.expect(422, "POST", "/api/milestones/"+id(ms)+"/move", map[string]any{"team_id": m.srcTeam.ID}); c != "validation_failed" {
		t.Errorf("milestone: code %q", c)
	}
	if got := must[store.Deliverable](m.rig, 200, "GET", "/api/deliverables/"+id(m.d.ID), nil); got.RoadmapID != m.src.ID {
		t.Error("refused move was applied")
	}
}

// Test_REQ_API_013_milestone_move_refused_past_three_years: a milestone move follows REQ_API_012's span
// rule; the refused move leaves the milestone where it was.
func Test_REQ_API_013_REQ_API_012_milestone_move_refused_past_three_years(t *testing.T) {
	m := newMoveRig(t)
	// the destination already spans nearly 3 years; the milestone lies outside that span
	m.newDeliverable(m.dst.ID, m.dstWSIDs(m.dstWS[:1]), -800, 200, nil)
	far := m.rawMilestone(m.src.ID, m.srcWS[0].ID, "Far", m.Clock.Date(900))
	code := m.expect(409, "POST", "/api/milestones/"+id(far)+"/move",
		map[string]any{"team_id": m.dstTeam.ID})
	if code != "span_exceeded" {
		t.Errorf("code %q", code)
	}
	src := m.roadmap(m.src.ID)
	if len(src.Milestones) != 1 || src.Milestones[0].ID != far {
		t.Errorf("refused move was applied: %+v", src.Milestones)
	}
	// a milestone inside the destination's span moves fine
	inside := m.rawMilestone(m.src.ID, m.srcWS[0].ID, "Inside", m.Clock.Date(10))
	m.expect(200, "POST", "/api/milestones/"+id(inside)+"/move", map[string]any{"team_id": m.dstTeam.ID})

	t.Run("move refused past three years", func(t *testing.T) {
		m := newMoveRig(t)
		// the destination already spans nearly 3 years; the moved deliverable lies outside that span
		m.newDeliverable(m.dst.ID, m.dstWSIDs(m.dstWS[:1]), -800, 200, nil)
		far := m.newDeliverable(m.src.ID, m.dstWSIDs(m.srcWS[:1]), 900, 910, nil)
		code := m.expect(409, "POST", "/api/deliverables/"+id(far.ID)+"/move", map[string]any{"team_id": m.dstTeam.ID})
		if code != "span_exceeded" {
			t.Errorf("code %q", code)
		}
		if got := must[store.Deliverable](m.rig, 200, "GET", "/api/deliverables/"+id(far.ID), nil); got.RoadmapID != m.src.ID {
			t.Error("refused move was applied")
		}
		// a deliverable inside the destination's span moves fine
		inside := m.newDeliverable(m.src.ID, m.dstWSIDs(m.srcWS[:1]), 0, 10, nil)
		m.expect(200, "POST", "/api/deliverables/"+id(inside.ID)+"/move", map[string]any{"team_id": m.dstTeam.ID})
	})
}
