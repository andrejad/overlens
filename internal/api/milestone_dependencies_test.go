package api_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Phase 9A: milestone dependencies through the HTTP API (REQ_DEP_023-031, REQ_API_040).

const (
	kD = "deliverable"
	kM = "milestone"
)

// depErrBody is the error object of a dependency refusal, every field a Phase 9 answer can carry.
type depErrBody struct {
	Error struct {
		Code, Message string
		Fields        map[string]string
		Path          json.RawMessage
		EarliestStart string `json:"earliest_start"`
		LatestEnd     string `json:"latest_end"`
		EarliestDate  string `json:"earliest_date"`
		LatestDate    string `json:"latest_date"`
	}
}

type pathItem = store.PathItem

// mdRig: one team, one roadmap, D1 (days 0-5), D2 (days 20-25), M1 (day 10), M2 (day 15).
type mdRig struct {
	*rig
	team   testutil.Team
	rm     testutil.Roadmap
	ws     int64
	d1, d2 store.Deliverable
	m1, m2 store.Milestone
}

func (g *rig) newMilestone(rm, ws int64, name string, day int) store.Milestone {
	g.T.Helper()
	return must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
		m{"name": name, "date": g.Clock.Date(day), "workstream_id": ws})
}

func newMD(t *testing.T) *mdRig {
	g := newRig(t)
	tm := g.Team(testutil.TeamOpts{Name: "Alpha Team", Tag: "ALP"})
	rm := g.Roadmap(tm, testutil.RoadmapOpts{})
	ws := g.firstWorkstreamOf(rm.ID)
	d1 := g.newDeliverable(rm.ID, []int64{ws}, 0, 5, m{"name": "D1"})
	d2 := g.newDeliverable(rm.ID, []int64{ws}, 20, 25, m{"name": "D2"})
	return &mdRig{rig: g, team: tm, rm: rm, ws: ws, d1: d1, d2: d2,
		m1: g.newMilestone(rm.ID, ws, "M1", 10), m2: g.newMilestone(rm.ID, ws, "M2", 15)}
}

func depsOf(kind string, itemID int64) string {
	return "/api/" + kind + "s/" + id(itemID) + "/dependencies"
}

// postDep adds `from` as a prerequisite of `to` and requires the status; it returns the raw body.
func (g *rig) postDep(want int, toKind string, to int64, fromKind string, from int64) []byte {
	g.T.Helper()
	status, raw := g.send("POST", depsOf(toKind, to), "application/json",
		[]byte(`{"from_kind":"`+fromKind+`","from_id":`+id(from)+`}`))
	if status != want {
		g.T.Fatalf("POST %s from %s %d: status %d, want %d: %s", depsOf(toKind, to), fromKind, from, status, want, raw)
	}
	return raw
}

func errOf(t *testing.T, raw []byte) depErrBody {
	t.Helper()
	var e depErrBody
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return e
}

// REQ_DEP_023, REQ_API_040: all four combinations through the endpoints, the edge shape, the lists, and
// the one DELETE form.
func Test_REQ_DEP_023_api_four_kinds_add_list(t *testing.T) {
	t.Run("the one DELETE form removes the right edge", func(t *testing.T) {
		g := newMD(t)
		g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
		g.expect(204, "DELETE", depsOf(kM, g.m1.ID)+"/deliverable/"+id(g.d1.ID), nil)
		g.postDep(201, kD, g.d2.ID, kM, g.m1.ID)
		g.expect(204, "DELETE", depsOf(kD, g.d2.ID)+"/milestone/"+id(g.m1.ID), nil)
		g.postDep(201, kM, g.m2.ID, kM, g.m1.ID)
		g.expect(204, "DELETE", depsOf(kM, g.m2.ID)+"/milestone/"+id(g.m1.ID), nil)
		g.postDep(201, kD, g.d2.ID, kD, g.d1.ID)
		g.expect(204, "DELETE", depsOf(kD, g.d2.ID)+"/deliverable/"+id(g.d1.ID), nil)
		var n int
		g.DB.QueryRow(`SELECT COUNT(*) FROM dependencies`).Scan(&n)
		if n != 0 {
			t.Errorf("%d edges left", n)
		}
	})

	g := newMD(t)
	g.postDep(201, kD, g.d2.ID, kD, g.d1.ID)        // deliverable -> deliverable, in the new body form
	raw := g.postDep(201, kM, g.m1.ID, kD, g.d1.ID) // deliverable -> milestone
	var edge map[string]any
	json.Unmarshal(raw, &edge)
	if edge["from_kind"] != kD || edge["to_kind"] != kM || edge["from_id"] != float64(g.d1.ID) || edge["to_id"] != float64(g.m1.ID) ||
		edge["from_deliverable_id"] != nil || edge["to_deliverable_id"] != nil {
		t.Errorf("edge shape %s", raw)
	}
	if o, _ := edge["other"].(map[string]any); o["kind"] != kD || o["name"] != "D1" || o["team_name"] != "Alpha Team" {
		t.Errorf("other %v", edge["other"])
	}
	g.postDep(201, kM, g.m2.ID, kM, g.m1.ID) // milestone -> milestone
	// milestone -> deliverable, through the deliverable endpoint with from_kind
	raw = g.postDep(201, kD, g.d2.ID, kM, g.m2.ID)
	json.Unmarshal(raw, &edge)
	if edge["from_kind"] != kM || edge["to_kind"] != kD || edge["to_id"] != float64(g.d2.ID) || edge["from_id"] != float64(g.m2.ID) {
		t.Errorf("edge shape %s", raw)
	}
	// a duplicate: 201 again, no audit entry
	n := g.auditCount()
	g.postDep(201, kM, g.m2.ID, kM, g.m1.ID)
	if g.auditCount() != n {
		t.Errorf("a duplicate wrote an audit entry")
	}
	got := must[[]store.DependencyEdge](g.rig, 200, "GET", depsOf(kM, g.m1.ID), nil)
	if len(got) != 2 || got[0].FromKind != kD || got[0].ToKind != kM || got[1].FromKind != kM || got[1].Other.Name != "M2" {
		t.Errorf("edges of M1: %+v", got)
	}
	got = must[[]store.DependencyEdge](g.rig, 200, "GET", depsOf(kD, g.d2.ID), nil)
	if len(got) != 2 {
		t.Errorf("edges of D2: %+v", got) // D1 -> D2 and M2 -> D2
	}
	g.expect(404, "GET", depsOf(kM, 99999), nil)
}

// REQ_API_040: errors of the POST and DELETE endpoints.
func Test_REQ_API_040_post_delete_errors(t *testing.T) {
	g := newMD(t)
	g.postDep(422, kM, g.m1.ID, kM, g.m1.ID) // self
	e := errOf(t, g.postDep(422, kM, g.m1.ID, kM, 99999))
	if e.Error.Code != "validation_failed" || e.Error.Fields["from_id"] == "" {
		t.Errorf("unknown prerequisite: %+v", e.Error)
	}
	e = errOf(t, g.postDep(422, kM, g.m1.ID, "task", 1))
	if e.Error.Fields["from_kind"] == "" {
		t.Errorf("bad kind: %+v", e.Error)
	}
	status, raw := g.send("POST", depsOf(kM, g.m1.ID), "application/json", []byte(`{}`))
	if e = errOf(t, raw); status != 422 || e.Error.Fields["from_kind"] == "" {
		t.Errorf("missing from_kind: %d %s", status, raw)
	}
	status, raw = g.send("POST", depsOf(kM, g.m1.ID), "application/json", []byte(`{"from_kind":"deliverable"}`))
	if e = errOf(t, raw); status != 422 || e.Error.Fields["from_id"] == "" {
		t.Errorf("missing from_id: %d %s", status, raw)
	}
	g.expect(404, "POST", depsOf(kM, 99999), m{"from_kind": kD, "from_id": g.d1.ID})
	// the old body (from_deliverable_id alone) is gone: it names the missing from_kind
	status, raw = g.send("POST", depsOf(kD, g.d2.ID), "application/json", []byte(`{"from_deliverable_id":1}`))
	if e = errOf(t, raw); status == 422 && e.Error.Fields["from_kind"] == "" {
		t.Errorf("old body: %d %s", status, raw)
	}
	// DELETE: bad kind and bad id are 400, unknown edge is 404
	g.expect(400, "DELETE", depsOf(kM, g.m1.ID)+"/task/1", nil)
	g.expect(400, "DELETE", depsOf(kM, g.m1.ID)+"/deliverable/abc", nil)
	g.expect(404, "DELETE", depsOf(kM, g.m1.ID)+"/deliverable/"+id(g.d1.ID), nil)
	g.expect(404, "DELETE", depsOf(kD, g.d2.ID)+"/milestone/"+id(g.m1.ID), nil)
	// anonymous writes are refused like every write
	g.anon().expect(401, "POST", depsOf(kM, g.m1.ID), m{"from_kind": kD, "from_id": g.d1.ID})
	g.anon().expect(401, "DELETE", depsOf(kM, g.m1.ID)+"/deliverable/"+id(g.d1.ID), nil)
	if len(must[[]store.DependencyEdge](g.anon(), 200, "GET", depsOf(kM, g.m1.ID), nil)) != 0 {
		t.Errorf("an edge appeared")
	}
}

// REQ_DEP_024: the strict day boundary on POST for each kind combination, PATCH of a milestone, and
// deliverable writes against milestone edges.
func Test_REQ_DEP_024_api_date_rule(t *testing.T) {
	g := newMD(t)
	same := g.newMilestone(g.rm.ID, g.ws, "SameDay", 5) // D1 ends day 5
	e := errOf(t, g.postDep(409, kM, same.ID, kD, g.d1.ID))
	if e.Error.Code != "date_order" || e.Error.EarliestStart != g.Clock.Date(6) {
		t.Errorf("same-day milestone: %+v", e.Error)
	}
	next := g.newMilestone(g.rm.ID, g.ws, "NextDay", 6)
	g.postDep(201, kM, next.ID, kD, g.d1.ID)
	e = errOf(t, g.postDep(409, kM, g.newMilestone(g.rm.ID, g.ws, "Twin", 10).ID, kM, g.m1.ID))
	if e.Error.Code != "date_order" {
		t.Errorf("milestone on milestone, same day: %+v", e.Error)
	}
	d3 := g.newDeliverable(g.rm.ID, []int64{g.ws}, 10, 12, m{"name": "D3"}) // starts on M1's day
	e = errOf(t, g.postDep(409, kD, d3.ID, kM, g.m1.ID))
	if e.Error.Code != "date_order" || e.Error.EarliestStart != g.Clock.Date(11) {
		t.Errorf("deliverable on the milestone's day: %+v", e.Error)
	}
	// PATCH /api/milestones/{id}
	g.postDep(201, kM, g.m1.ID, kD, g.d1.ID) // D1 (end 5) -> M1 (10)
	g.postDep(201, kD, g.d2.ID, kM, g.m1.ID) // M1 -> D2 (start 20)
	n := g.auditCount()
	status, raw := g.send("PATCH", "/api/milestones/"+id(g.m1.ID), "application/json", []byte(`{"date":"`+g.Clock.Date(5)+`"}`))
	e = errOf(t, raw)
	if status != 409 || e.Error.Code != "date_order" || e.Error.EarliestDate != g.Clock.Date(6) || e.Error.LatestDate != "" || e.Error.EarliestStart != "" {
		t.Errorf("patch to the prerequisite's end: %d %s", status, raw)
	}
	status, raw = g.send("PATCH", "/api/milestones/"+id(g.m1.ID), "application/json", []byte(`{"date":"`+g.Clock.Date(20)+`"}`))
	e = errOf(t, raw)
	if status != 409 || e.Error.LatestDate != g.Clock.Date(19) || e.Error.EarliestDate != "" {
		t.Errorf("patch to the dependent's start: %d %s", status, raw)
	}
	if g.auditCount() != n || must[store.Milestone](g.rig, 200, "PATCH", "/api/milestones/"+id(g.m1.ID), m{"name": "M1"}).Date != g.Clock.Date(10) {
		t.Errorf("a refused patch changed something")
	}
	if got := must[store.Milestone](g.rig, 200, "PATCH", "/api/milestones/"+id(g.m1.ID), m{"date": g.Clock.Date(19)}); got.Date != g.Clock.Date(19) {
		t.Errorf("legal move: %+v", got)
	}
	// deliverables are checked against milestone edges too
	status, raw = g.send("PATCH", "/api/deliverables/"+id(g.d2.ID), "application/json", []byte(`{"start_date":"`+g.Clock.Date(19)+`"}`))
	if e = errOf(t, raw); status != 409 || e.Error.EarliestStart != g.Clock.Date(20) {
		t.Errorf("deliverable before its prerequisite milestone: %d %s", status, raw)
	}
	status, raw = g.send("PATCH", "/api/deliverables/"+id(g.d1.ID), "application/json", []byte(`{"end_date":"`+g.Clock.Date(19)+`"}`))
	if e = errOf(t, raw); status != 409 || e.Error.LatestEnd != g.Clock.Date(5) { // the earliest dependent (NextDay, day 6) wins
		t.Errorf("deliverable past its dependent milestone: %d %s", status, raw)
	}
	g.expect(200, "PATCH", "/api/deliverables/"+id(g.d1.ID), m{"start_date": g.Clock.Date(-3)})
}

// REQ_DEP_025: a loop through a milestone is a 409 with a typed path; a loop of deliverables keeps the string path.
func Test_REQ_DEP_025_api_cycle_paths(t *testing.T) {
	g := newMD(t)
	g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
	g.postDep(201, kD, g.d2.ID, kM, g.m1.ID)
	n := g.auditCount()
	e := errOf(t, g.postDep(409, kD, g.d1.ID, kD, g.d2.ID))
	var typed []pathItem
	if e.Error.Code != "cycle" || json.Unmarshal(e.Error.Path, &typed) != nil || len(typed) != 4 ||
		typed[0] != (pathItem{Kind: kD, Name: "D2"}) || typed[1] != (pathItem{Kind: kD, Name: "D1"}) || typed[2] != (pathItem{Kind: kM, Name: "M1"}) || typed[3] != typed[0] {
		t.Errorf("typed path %s (%+v)", e.Error.Path, e.Error)
	}
	if g.auditCount() != n {
		t.Errorf("a refused edge was audited")
	}
	g.postDep(201, kD, g.d2.ID, kD, g.d1.ID)
	e = errOf(t, g.postDep(409, kD, g.d1.ID, kD, g.d2.ID))
	var plain []string
	if e.Error.Code != "cycle" || json.Unmarshal(e.Error.Path, &plain) != nil || strings.Join(plain, ",") != "D2,D1,D2" {
		t.Errorf("plain path %s", e.Error.Path)
	}
}

// REQ_DEP_026, REQ_API_040: candidates of both kinds, for a deliverable and for a milestone.
func Test_REQ_DEP_026_api_candidates(t *testing.T) {
	g := newMD(t)
	g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
	g.postDep(201, kM, g.m2.ID, kM, g.m1.ID)
	cs := must[[]store.DependencyCandidate](g.rig, 200, "GET", "/api/milestones/"+id(g.m2.ID)+"/dependency-candidates", nil)
	var names []string
	blocked := map[string]string{}
	for _, c := range cs {
		names = append(names, c.Kind+":"+c.Name)
		if c.Blocked != nil {
			blocked[c.Name] = *c.Blocked
		}
	}
	if strings.Join(names, ",") != "milestone:M1,deliverable:D1,deliverable:D2" { // milestones first, then deliverables (REQ_DEP_008); M2 itself is not offered
		t.Errorf("candidates %v", names)
	}
	if blocked["M1"] != "already_prerequisite" || blocked["D2"] != "ends_too_late" || blocked["D1"] != "" {
		t.Errorf("blocked %v", blocked)
	}
	// from M1: M2 would close a loop, D1 is already a prerequisite
	cs = must[[]store.DependencyCandidate](g.rig, 200, "GET", "/api/milestones/"+id(g.m1.ID)+"/dependency-candidates", nil)
	blocked = map[string]string{}
	for _, c := range cs {
		if c.Blocked != nil {
			blocked[c.Kind+":"+c.Name] = *c.Blocked
		}
	}
	if blocked["milestone:M2"] != "would_cycle" || blocked["deliverable:D1"] != "already_prerequisite" || blocked["deliverable:D2"] != "ends_too_late" {
		t.Errorf("blocked from M1: %v", blocked)
	}
	// a deliverable's list carries milestones as well
	cs = must[[]store.DependencyCandidate](g.rig, 200, "GET", "/api/deliverables/"+id(g.d2.ID)+"/dependency-candidates", nil)
	var kinds int
	for _, c := range cs {
		if c.Kind == kM {
			kinds++
		}
	}
	if len(cs) != 3 || kinds != 2 {
		t.Errorf("candidates of D2: %+v", cs)
	}
	g.expect(404, "GET", "/api/milestones/99999/dependency-candidates", nil)
}

// REQ_DEP_028, REQ_API_040: the typed trace endpoint, the unchanged Phase 7 one, and the typed company edges.
func Test_REQ_DEP_028_api_typed_trace(t *testing.T) {
	g := newMD(t)
	g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
	g.postDep(201, kM, g.m2.ID, kM, g.m1.ID)
	g.postDep(201, kD, g.d2.ID, kM, g.m2.ID)
	type typedTrace struct {
		Root          store.ItemRef
		Prerequisites []store.ItemRef
		Dependents    []store.ItemRef
		Edges         []store.CompanyEdge
	}
	tr := must[typedTrace](g.rig, 200, "GET", "/api/company/trace/milestone/"+id(g.m1.ID), nil)
	if tr.Root != (store.ItemRef{Kind: kM, ID: g.m1.ID}) || !reflect.DeepEqual(tr.Prerequisites, []store.ItemRef{{Kind: kD, ID: g.d1.ID}}) ||
		!reflect.DeepEqual(tr.Dependents, []store.ItemRef{{Kind: kD, ID: g.d2.ID}, {Kind: kM, ID: g.m2.ID}}) || len(tr.Edges) != 3 {
		t.Errorf("trace %+v", tr)
	}
	// an item with no edges traces to nothing
	other := g.newDeliverable(g.rm.ID, []int64{g.ws}, 40, 41, m{"name": "Unrelated"})
	if un := must[typedTrace](g.rig, 200, "GET", "/api/company/trace/deliverable/"+id(other.ID), nil); len(un.Prerequisites) != 0 || len(un.Dependents) != 0 || len(un.Edges) != 0 {
		t.Errorf("unrelated item: %+v", un)
	}
	g.expect(404, "GET", "/api/company/trace/milestone/99999", nil)
	g.expect(400, "GET", "/api/company/trace/task/1", nil)
	g.expect(400, "GET", "/api/company/trace/milestone/abc", nil)
	// the company graph carries the kinds, and null deliverable ids on milestone sides
	_, raw := g.send("GET", "/api/company/dependencies", "", nil)
	var all struct{ Items []map[string]any }
	json.Unmarshal(raw, &all)
	if len(all.Items) != 3 {
		t.Fatalf("company edges: %s", raw)
	}
	for _, it := range all.Items {
		if it["from_kind"] == nil || it["to_kind"] == nil || it["from_id"] == nil {
			t.Errorf("edge without kinds: %v", it)
		}
		if _, old := it["from_deliverable_id"]; old {
			t.Errorf("removed field from_deliverable_id still written: %v", it)
		}
	}
	// RoadmapFull.dependencies is typed too
	if full := g.roadmap(g.rm.ID); len(full.Dependencies) != 3 || full.Dependencies[0].From.Kind == "" {
		t.Errorf("roadmap dependencies %+v", full.Dependencies)
	}
}

// REQ_DEP_029, REQ_AUD_003: deleting a milestone, a deliverable or a team (with its roadmap) removes its edges and the audit
// entry names both ends; creating and deleting an edge each write one entry naming both ends and their kinds.
func Test_REQ_DEP_029_REQ_AUD_003_api_delete_cascades_audit(t *testing.T) {
	t.Run("create and delete of an edge are audited with both ends and kinds", func(t *testing.T) {
		g := newMD(t)
		g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
		e := g.lastAudit()
		if e.Action != "dependency.create" || e.Details["from"] != "D1" || e.Details["from_kind"] != kD || e.Details["to"] != "M1" ||
			e.Details["to_kind"] != kM || e.Details["from_team"] != "Alpha Team" || e.Details["to_team"] != "Alpha Team" {
			t.Errorf("create audit %+v", e)
		}
		g.expect(204, "DELETE", depsOf(kM, g.m1.ID)+"/deliverable/"+id(g.d1.ID), nil)
		if e = g.lastAudit(); e.Action != "dependency.delete" || e.Details["to_kind"] != kM || e.Details["from_kind"] != kD {
			t.Errorf("delete audit %+v", e)
		}
	})

	g := newMD(t)
	g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
	g.postDep(201, kD, g.d2.ID, kM, g.m1.ID)
	g.postDep(201, kM, g.m2.ID, kM, g.m1.ID)
	g.expect(204, "DELETE", "/api/milestones/"+id(g.m1.ID), nil)
	e := g.lastAudit()
	removed, _ := e.Details["dependencies_removed"].([]string)
	if e.Action != "milestone.delete" || len(removed) != 3 {
		t.Fatalf("audit %+v", e)
	}
	joined := strings.Join(removed, "|")
	for _, want := range []string{"D1 (Alpha Team) → milestone M1 (Alpha Team)", "milestone M1 (Alpha Team) → D2 (Alpha Team)", "milestone M1 (Alpha Team) → milestone M2 (Alpha Team)"} {
		if !strings.Contains(joined, want) {
			t.Errorf("audit lacks %q: %v", want, removed)
		}
	}
	if n := g.DanglingMilestoneDependencies(); n != 0 {
		t.Errorf("%d dangling rows", n)
	}
	// a deliverable with a milestone edge
	g.postDep(201, kM, g.m2.ID, kD, g.d1.ID)
	g.expect(204, "DELETE", "/api/deliverables/"+id(g.d1.ID), nil)
	removed, _ = g.lastAudit().Details["dependencies_removed"].([]string)
	if len(removed) != 1 || !strings.Contains(removed[0], "D1") || !strings.Contains(removed[0], "milestone M2") {
		t.Errorf("deliverable delete audit %v", removed)
	}
	// a team whose roadmap holds only a milestone with an edge to a deliverable on another roadmap
	doomed := g.Team(testutil.TeamOpts{Name: "Doomed", Tag: "DOO"})
	gone := g.Roadmap(doomed, testutil.RoadmapOpts{Title: "Doomed"})
	gm := g.newMilestone(gone.ID, g.firstWorkstreamOf(gone.ID), "Doomed milestone", 3)
	g.postDep(201, kD, g.d2.ID, kM, gm.ID)
	// the milestone blocks the team delete; deleting it names the edge it took, and the team then goes
	g.expect(409, "DELETE", "/api/teams/"+id(doomed.ID), nil)
	g.expect(204, "DELETE", "/api/milestones/"+id(gm.ID), nil)
	e = g.lastAudit()
	removed, _ = e.Details["dependencies_removed"].([]string)
	if e.Action != "milestone.delete" || len(removed) != 1 || !strings.Contains(removed[0], "milestone Doomed milestone") || !strings.Contains(removed[0], "D2") {
		t.Errorf("milestone delete audit %+v", e)
	}
	g.expect(204, "DELETE", "/api/teams/"+id(doomed.ID), nil)
	if e = g.lastAudit(); e.Action != "team.delete" || e.Details["dependencies_removed"] != nil {
		t.Errorf("team delete audit %+v", e)
	}
	if n := g.DanglingMilestoneDependencies(); n != 0 {
		t.Errorf("%d dangling rows after the team delete", n)
	}
	if len(must[[]store.DependencyEdge](g.rig, 200, "GET", depsOf(kD, g.d2.ID), nil)) != 0 {
		t.Errorf("D2 still has edges")
	}
}

// REQ_API_023: the CSV lists a milestone's prerequisites like a deliverable's, a milestone of another roadmap too.
func Test_REQ_API_023_csv_lists_milestone_prerequisites(t *testing.T) {
	g := newMD(t)
	other := g.Team(testutil.TeamOpts{Name: "Other", Tag: "OTH"})
	orm := g.Roadmap(other, testutil.RoadmapOpts{Title: "Their plan"})
	oms := g.newMilestone(orm.ID, g.firstWorkstreamOf(orm.ID), "Their milestone", -20)
	g.postDep(201, kM, g.m1.ID, kD, g.d1.ID)
	g.postDep(201, kD, g.d2.ID, kM, g.m1.ID)
	g.postDep(201, kD, g.d1.ID, kM, oms.ID) // D1 depends on a milestone of another roadmap
	csv := string(g.rawBytes("/api/roadmaps/" + id(g.rm.ID) + "/export.csv"))
	if !strings.Contains(csv, "M1") || !strings.Contains(csv, "Their milestone") {
		t.Errorf("csv lacks the milestone prerequisites:\n%s", csv)
	}
}

func (g *rig) rawBytes(path string) []byte {
	_, body := g.rawGet(path)
	return []byte(body)
}
