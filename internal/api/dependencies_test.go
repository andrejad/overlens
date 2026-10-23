package api_test

import (
	"encoding/json"
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

// depErr is the error body of a dependency conflict, with the extra keys (REQ_DEP_003/004).
type depErr struct {
	Error struct {
		Code          string
		Message       string
		Path          []string
		EarliestStart string `json:"earliest_start"`
		LatestEnd     string `json:"latest_end"`
		Fields        map[string]string
	}
}

func depsURL(d int64) string { return "/api/deliverables/" + id(d) + "/dependencies" }

// addDep makes `to` depend on `from` through the API.
func (g *rig) addDep(to, from int64) (int, depErr) {
	g.T.Helper()
	return call[depErr](g, "POST", depsURL(to), map[string]any{"from_kind": "deliverable", "from_id": from})
}

// depPair: two teams' roadmaps with one deliverable chain each side, for cross-team checks.
func depRig(t *testing.T) (g *rig, rmA int64, wsA []int64, rmB int64, wsB []int64) {
	g, rmA, wsA, _ = deliverableRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rb := g.Roadmap(tm, roadmapOpts())
	return g, rmA, wsA, rb.ID, []int64{g.roadmap(rb.ID).Workstreams[0].ID}
}

func Test_REQ_DEP_001_add_list_remove_across_teams(t *testing.T) {
	g, rmA, wsA, rmB, wsB := depRig(t)
	pre := g.newDeliverable(rmA, wsA[:1], 0, 10, map[string]any{"name": "Pre"})
	dep1 := g.newDeliverable(rmB, wsB, 20, 30, map[string]any{"name": "DepB"})
	dep2 := g.newDeliverable(rmA, wsA[:1], 40, 50, map[string]any{"name": "DepA"})

	edge := must[store.DependencyEdge](g, 201, "POST", depsURL(dep1.ID), map[string]any{"from_kind": "deliverable", "from_id": pre.ID})
	if edge.FromID != pre.ID || edge.ToID != dep1.ID || edge.Other == nil || edge.Other.ID != pre.ID || edge.Other.Name != "Pre" {
		t.Errorf("edge %+v other %+v", edge, edge.Other)
	}
	must[store.DependencyEdge](g, 201, "POST", depsURL(dep2.ID), map[string]any{"from_kind": "deliverable", "from_id": pre.ID})

	// from the prerequisite's side: both edges, `other` is the dependent
	got := must[[]store.DependencyEdge](g, 200, "GET", depsURL(pre.ID), nil)
	if len(got) != 2 || got[0].Other.ID != dep1.ID || got[1].Other.ID != dep2.ID || got[0].Other.TeamName == "" {
		t.Errorf("prereq edges %+v", got)
	}
	// from the dependent's side: one edge, `other` is the prerequisite
	got = must[[]store.DependencyEdge](g, 200, "GET", depsURL(dep1.ID), nil)
	if len(got) != 1 || got[0].Other.ID != pre.ID {
		t.Errorf("dependent edges %+v", got)
	}
	// a deliverable with none lists [], not null
	lone := g.newDeliverable(rmA, wsA[:1], 100, 110, nil)
	if _, raw := g.send("GET", depsURL(lone.ID), "", nil); string(raw) != "[]\n" {
		t.Errorf("empty list body %q", raw)
	}

	g.expect(204, "DELETE", depsURL(dep1.ID)+"/deliverable/"+id(pre.ID), nil)
	if got = must[[]store.DependencyEdge](g, 200, "GET", depsURL(pre.ID), nil); len(got) != 1 {
		t.Errorf("after delete %+v", got)
	}
	g.expect(404, "DELETE", depsURL(dep1.ID)+"/deliverable/"+id(pre.ID), nil) // edge already gone
	g.expect(404, "GET", depsURL(99999), nil)                                 // unknown deliverable
	g.expect(404, "POST", depsURL(99999), map[string]any{"from_kind": "deliverable", "from_id": pre.ID})
	g.expect(422, "POST", depsURL(dep1.ID), map[string]any{"from_kind": "deliverable", "from_id": 99999})
	g.expect(422, "POST", depsURL(dep1.ID), map[string]any{})

	t.Run("a duplicate edge is idempotent", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		a := g.newDeliverable(rm, ws[:1], 0, 5, nil)
		b := g.newDeliverable(rm, ws[:1], 10, 15, nil)
		must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID})
		n := g.auditCount()
		must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID})
		if g.auditCount() != n {
			t.Error("duplicate POST wrote an audit entry")
		}
		if got := must[[]store.DependencyEdge](g, 200, "GET", depsURL(a.ID), nil); len(got) != 1 {
			t.Errorf("edges %+v", got)
		}
	})
}

func Test_REQ_DEP_002_self_dependency_refused(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	a := g.newDeliverable(rm, ws[:1], 0, 5, nil)
	status, e := g.addDep(a.ID, a.ID)
	if status != 422 || e.Error.Fields["from_id"] == "" {
		t.Errorf("self dependency: %d %+v", status, e)
	}
}

func Test_REQ_DEP_003_cycle_refused_with_path(t *testing.T) {
	t.Run("a cycle across two roadmaps is refused", func(t *testing.T) {
		g, rmA, wsA, rmB, wsB := depRig(t)
		a := g.newDeliverable(rmA, wsA[:1], 0, 5, map[string]any{"name": "A"})
		b := g.newDeliverable(rmB, wsB, 10, 15, map[string]any{"name": "B"})
		must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID}) // A (team 1) -> B (team 2)
		status, e := g.addDep(a.ID, b.ID)                                                                                      // B -> A closes the loop
		if status != 409 || e.Error.Code != "cycle" || len(e.Error.Path) != 3 {
			t.Errorf("cross-roadmap cycle: %d %+v", status, e)
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	a := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"name": "A"})
	b := g.newDeliverable(rm, ws[:1], 10, 15, map[string]any{"name": "B"})
	c := g.newDeliverable(rm, ws[:1], 20, 25, map[string]any{"name": "C"})
	must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID}) // A -> B
	must[store.DependencyEdge](g, 201, "POST", depsURL(c.ID), map[string]any{"from_kind": "deliverable", "from_id": b.ID}) // B -> C
	n := g.auditCount()
	// A depending on C would close A -> B -> C -> A
	status, e := g.addDep(a.ID, c.ID)
	if status != 409 || e.Error.Code != "cycle" {
		t.Fatalf("cycle: %d %+v", status, e)
	}
	want := []string{"C", "A", "B", "C"}
	if len(e.Error.Path) != len(want) {
		t.Fatalf("path %v, want %v", e.Error.Path, want)
	}
	for i := range want {
		if e.Error.Path[i] != want[i] {
			t.Fatalf("path %v, want %v", e.Error.Path, want)
		}
	}
	if g.auditCount() != n || len(must[[]store.DependencyEdge](g, 200, "GET", depsURL(a.ID), nil)) != 1 {
		t.Error("refused cycle wrote something")
	}
}

func Test_REQ_DEP_004_add_refused_when_dates_overlap(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	pre := g.newDeliverable(rm, ws[:1], 0, 10, nil)
	same := g.newDeliverable(rm, ws[:1], 10, 20, nil) // starts the day the prerequisite ends: too early
	next := g.newDeliverable(rm, ws[:1], 11, 20, nil) // the day after: allowed
	status, e := g.addDep(same.ID, pre.ID)
	if status != 409 || e.Error.Code != "date_order" || e.Error.EarliestStart != g.Clock.Date(11) {
		t.Errorf("same-day: %d %+v", status, e)
	}
	if status, e = g.addDep(next.ID, pre.ID); status != 201 {
		t.Errorf("next-day: %d %+v", status, e)
	}
}

func Test_REQ_DEP_004_deliverable_writes_enforce_date_order_both_directions(t *testing.T) {
	// Create and move can't break the date rule today (a new deliverable has no edges; a move keeps
	// dates) — this pins that, so a later change to either can't silently break REQ_DEP_004.
	t.Run("create has no edges and move keeps dates and dependencies", func(t *testing.T) {
		m := newMoveRig(t)
		pre := m.newDeliverable(m.dst.ID, []int64{m.dstWS[0].ID}, 0, 4, nil)
		if pre.ID == 0 {
			t.Fatal("prerequisite not created")
		}
		must[store.DependencyEdge](m.rig, 201, "POST", depsURL(m.d.ID), map[string]any{"from_kind": "deliverable", "from_id": pre.ID})
		if got := must[[]store.DependencyEdge](m.rig, 200, "GET", depsURL(m.d.ID), nil); len(got) != 1 {
			t.Fatalf("new deliverable should have no edges before we add one: %+v", got)
		}

		moved := must[store.Deliverable](m.rig, 200, "POST", "/api/deliverables/"+id(m.d.ID)+"/move", map[string]any{
			"team_id":        m.dstTeam.ID,
			"workstream_map": []map[string]any{{"from": m.srcWS[1].ID, "to": map[string]string{"create": "Carried"}}},
		})
		if moved.StartDate != m.d.StartDate || moved.EndDate != m.d.EndDate {
			t.Errorf("move changed dates: %v-%v, was %v-%v", moved.StartDate, moved.EndDate, m.d.StartDate, m.d.EndDate)
		}
		got := must[[]store.DependencyEdge](m.rig, 200, "GET", depsURL(m.d.ID), nil)
		if len(got) != 1 || got[0].FromID != pre.ID || got[0].ToID != m.d.ID {
			t.Errorf("move lost or changed the dependency: %+v", got)
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	pre := g.newDeliverable(rm, ws[:1], 0, 10, map[string]any{"name": "Pre"})
	dep := g.newDeliverable(rm, ws[:1], 20, 30, map[string]any{"name": "Dep"})
	must[store.DependencyEdge](g, 201, "POST", depsURL(dep.ID), map[string]any{"from_kind": "deliverable", "from_id": pre.ID})
	url := func(d store.Deliverable) string { return "/api/deliverables/" + id(d.ID) }

	// the dependent starts too early
	status, e := call[depErr](g, "PATCH", url(dep), map[string]any{"start_date": g.Clock.Date(10)})
	if status != 409 || e.Error.Code != "date_order" || e.Error.EarliestStart != g.Clock.Date(11) {
		t.Errorf("dependent early: %d %+v", status, e)
	}
	// the prerequisite ends too late
	status, e = call[depErr](g, "PATCH", url(pre), map[string]any{"end_date": g.Clock.Date(20)})
	if status != 409 || e.Error.Code != "date_order" || e.Error.LatestEnd != g.Clock.Date(19) {
		t.Errorf("prereq late: %d %+v", status, e)
	}
	// whole bar shifted: both sides checked
	g.expect(409, "PATCH", url(dep), map[string]any{"start_date": g.Clock.Date(5), "end_date": g.Clock.Date(15)})
	// nothing was written by the refusals
	if d := must[store.Deliverable](g, 200, "GET", url(dep), nil); d.StartDate != g.Clock.Date(20) {
		t.Errorf("refused PATCH changed dates: %+v", d)
	}
	// the exact boundary is fine, and a move that keeps the rule too
	must[store.Deliverable](g, 200, "PATCH", url(dep), map[string]any{"start_date": g.Clock.Date(11)})
	must[store.Deliverable](g, 200, "PATCH", url(pre), map[string]any{"end_date": g.Clock.Date(10), "name": "Pre2"})
}

func Test_REQ_API_006_candidates_blocked_reasons(t *testing.T) {
	t.Run("roadmap full carries edges with either end", func(t *testing.T) {
		g, rmA, wsA, rmB, wsB := depRig(t)
		a := g.newDeliverable(rmA, wsA[:1], 0, 10, map[string]any{"name": "A"})
		b := g.newDeliverable(rmB, wsB, 20, 30, map[string]any{"name": "B"})
		must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID})
		for _, rm := range []int64{rmA, rmB} { // the edge is in both roadmaps' payloads
			deps := g.roadmap(rm).Dependencies
			if len(deps) != 1 || deps[0].From.Name != "A" || deps[0].To.Name != "B" || deps[0].From.RoadmapID != rmA || deps[0].To.RoadmapID != rmB ||
				deps[0].From.TeamName == "" || deps[0].To.EndDate != g.Clock.Date(30) {
				t.Errorf("roadmap %d dependencies %+v", rm, deps)
			}
		}
		// a roadmap with no edges: [] not null
		rm3 := g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts())
		raw := must[map[string]json.RawMessage](g, 200, "GET", "/api/roadmaps/"+id(rm3.ID), nil)
		if string(raw["dependencies"]) != "[]" {
			t.Errorf("dependencies %s", raw["dependencies"])
		}
	})

	g, rmA, wsA, rmB, wsB := depRig(t)
	a := g.newDeliverable(rmA, wsA[:1], 0, 10, map[string]any{"name": "A"})
	b := g.newDeliverable(rmA, wsA[:1], 20, 30, map[string]any{"name": "B"})
	c := g.newDeliverable(rmB, wsB, 40, 50, map[string]any{"name": "C"})
	late := g.newDeliverable(rmB, wsB, 15, 35, map[string]any{"name": "Late"}) // ends after B starts
	free := g.newDeliverable(rmB, wsB, 0, 5, map[string]any{"name": "Free"})
	must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID}) // A -> B
	must[store.DependencyEdge](g, 201, "POST", depsURL(c.ID), map[string]any{"from_kind": "deliverable", "from_id": b.ID}) // B -> C

	blocked := func(of, cand int64) any {
		for _, c := range must[[]store.DependencyCandidate](g, 200, "GET", "/api/deliverables/"+id(of)+"/dependency-candidates", nil) {
			if c.ID == cand {
				if c.Blocked == nil {
					return nil
				}
				return *c.Blocked
			}
		}
		t.Fatalf("candidate %d missing", cand)
		return nil
	}
	if got := blocked(b.ID, a.ID); got != "already_prerequisite" {
		t.Errorf("A for B: %v", got)
	}
	if got := blocked(b.ID, c.ID); got != "would_cycle" { // C already depends on B
		t.Errorf("C for B: %v", got)
	}
	if got := blocked(b.ID, late.ID); got != "ends_too_late" {
		t.Errorf("Late for B: %v", got)
	}
	if got := blocked(b.ID, free.ID); got != nil {
		t.Errorf("Free for B: %v", got)
	}
	// every deliverable but the one itself, across both teams; the response shape is the contract's
	cs := must[[]map[string]any](g, 200, "GET", "/api/deliverables/"+id(b.ID)+"/dependency-candidates", nil)
	if len(cs) != 4 {
		t.Errorf("%d candidates", len(cs))
	}
	for _, k := range []string{"id", "name", "team_id", "team_name", "team_tag", "roadmap_id", "start_date", "end_date", "blocked"} {
		if _, ok := cs[0][k]; !ok {
			t.Errorf("candidate lacks %q: %v", k, cs[0])
		}
	}
	g.expect(404, "GET", "/api/deliverables/99999/dependency-candidates", nil)

}

func Test_REQ_AUD_003_dependency_audit_names(t *testing.T) {
	g, rmA, wsA, rmB, wsB := depRig(t)
	a := g.newDeliverable(rmA, wsA[:1], 0, 10, map[string]any{"name": "Alpha"})
	b := g.newDeliverable(rmB, wsB, 20, 30, map[string]any{"name": "Beta"})
	teams := must[teamList](g, 200, "GET", "/api/teams", nil).Items
	teamOf := map[int64]string{}
	for _, tm := range teams {
		teamOf[tm.ID] = tm.Name
	}
	must[store.DependencyEdge](g, 201, "POST", depsURL(b.ID), map[string]any{"from_kind": "deliverable", "from_id": a.ID})
	e := g.lastAudit()
	if e.Action != "dependency.create" || e.Details["from"] != "Alpha" || e.Details["to"] != "Beta" ||
		e.Details["from_team"] != teamOf[a.TeamID] || e.Details["to_team"] != teamOf[b.TeamID] {
		t.Errorf("create entry %+v", e)
	}
	g.expect(204, "DELETE", depsURL(b.ID)+"/deliverable/"+id(a.ID), nil)
	e = g.lastAudit()
	if e.Action != "dependency.delete" || e.Details["from"] != "Alpha" || e.Details["to"] != "Beta" {
		t.Errorf("delete entry %+v", e)
	}
	// refusals write nothing
	n := g.auditCount()
	g.addDep(a.ID, a.ID)
	if g.auditCount() != n {
		t.Error("refused request wrote an audit entry")
	}
}
