package api_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type companyTeams struct{ Items []store.CompanyTeam }
type teamOrder struct{ Items []store.TeamRef }
type nameOrder struct{ Items []string }
type companyEdges struct{ Items []store.CompanyEdge }

func (g *rig) teamOrderNames() []string {
	g.T.Helper()
	var out []string
	for _, t := range must[teamOrder](g, 200, "GET", "/api/company/team-order", nil).Items {
		out = append(out, t.Name)
	}
	return out
}

func teamIDs(ts ...testutil.Team) []int64 {
	out := make([]int64, len(ts))
	for i, t := range ts {
		out[i] = t.ID
	}
	return out
}

func lastCompanyAudit(g *rig, action string) (from, to []string) {
	g.T.Helper()
	e := g.lastAudit()
	if e.Action != action {
		g.T.Fatalf("last audit action %q, want %q", e.Action, action)
	}
	raw, _ := json.Marshal(e.Details)
	var d struct{ From, To []string }
	if err := json.Unmarshal(raw, &d); err != nil {
		g.T.Fatal(err)
	}
	return d.From, d.To
}

// Test_REQ_API_037_company_roadmaps_and_team_order: every team in the effective order (saved first,
// the rest by name ignoring case), each with its roadmap exactly as GET /api/roadmaps/{id}
// returns it, or null.
func Test_REQ_API_037_company_roadmaps_and_team_order(t *testing.T) {
	t.Run("team ids capped", func(t *testing.T) {
		g := newRig(t)
		tm := g.Team(testTeamOpts("A", "AAA"))
		ids := make([]int64, 1001)
		for i := range ids {
			ids[i] = tm.ID
		}
		status, e := call[errResp](g, "PUT", "/api/company/team-order", map[string]any{"team_ids": ids})
		if status != 422 || !strings.Contains(e.Error.Fields["team_ids"], "1000") {
			t.Errorf("status %d %+v, want 422 naming the limit on field team_ids", status, e.Error)
		}
	})

	g := newRig(t)
	zeta := g.Team(testTeamOpts("zeta", "ZET"))
	alpha := g.Team(testTeamOpts("Alpha", "ALP"))
	mid := g.Team(testTeamOpts("Mid", "MID")) // an empty roadmap
	rz := g.Roadmap(zeta, roadmapOpts())
	ra := g.Roadmap(alpha, roadmapOpts())
	g.Deliverable(ra, testutil.DeliverableOpts{Name: "A1", StartDay: 0, EndDay: 5})
	g.Deliverable(rz, testutil.DeliverableOpts{Name: "Z1", StartDay: 10, EndDay: 15})

	if got := g.teamOrderNames(); !reflect.DeepEqual(got, []string{"Alpha", "Mid", "zeta"}) {
		t.Fatalf("unsaved order %v, want alphabetical ignoring case", got)
	}
	cr := must[companyTeams](g, 200, "GET", "/api/company/roadmaps", nil).Items
	if len(cr) != 3 || cr[0].Team.Name != "Alpha" || cr[1].Team.Name != "Mid" || cr[2].Team.Name != "zeta" {
		t.Fatalf("company roadmaps order: %+v", cr)
	}
	// REQ_DAT_032: every team has its roadmap, so roadmap is never null
	if midTeam := must[store.Team](g, 200, "GET", "/api/teams/"+id(mid.ID), nil); cr[1].Roadmap.ID != midTeam.RoadmapID || len(cr[1].Roadmap.Deliverables) != 0 {
		t.Errorf("the empty team's roadmap: %+v", cr[1].Roadmap)
	}
	want, _ := json.Marshal(g.roadmap(ra.ID))
	got, _ := json.Marshal(cr[0].Roadmap)
	if string(want) != string(got) || cr[0].Roadmap.ID != ra.ID {
		t.Errorf("company roadmap differs from GET /api/roadmaps/{id}:\n%s\n%s", got, want)
	}

	// save an order: zeta first, Alpha second; a team created later goes after the saved ones
	before := g.auditCount()
	got2 := must[teamOrder](g, 200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(zeta, alpha, mid)}).Items
	if len(got2) != 3 || got2[0].Name != "zeta" || got2[1].Name != "Alpha" || got2[2].Tag != "MID" {
		t.Fatalf("PUT result %+v", got2)
	}
	if g.auditCount() != before+1 {
		t.Fatalf("a changing PUT must write exactly one audit entry")
	}
	from, to := lastCompanyAudit(g, "company.team_order")
	if !reflect.DeepEqual(from, []string{"Alpha", "Mid", "zeta"}) || !reflect.DeepEqual(to, []string{"zeta", "Alpha", "Mid"}) {
		t.Errorf("audit by team name: from %v to %v", from, to)
	}
	g.Team(testTeamOpts("Beta", "BET"))
	if got := g.teamOrderNames(); !reflect.DeepEqual(got, []string{"zeta", "Alpha", "Mid", "Beta"}) {
		t.Errorf("a team missing from the saved order goes last: %v", got)
	}
	if cr := must[companyTeams](g, 200, "GET", "/api/company/roadmaps", nil).Items; cr[0].Team.Name != "zeta" || cr[3].Team.Name != "Beta" {
		t.Errorf("company roadmaps must follow the team order: %+v", cr)
	}

}

// Test_REQ_DAT_027_deleting_a_team_removes_its_order_row.
func Test_REQ_DAT_027_deleting_a_team_removes_its_order_row(t *testing.T) {
	g := newRig(t)
	a := g.Team(testTeamOpts("A", "AAA"))
	b := g.Team(testTeamOpts("B", "BBB"))
	g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(b, a)})
	if n := countRows(g, `SELECT COUNT(*) FROM company_team_order`); n != 2 {
		t.Fatalf("order rows %d, want 2", n)
	}
	g.expect(204, "DELETE", "/api/teams/"+id(b.ID), nil)
	if n := countRows(g, `SELECT COUNT(*) FROM company_team_order WHERE team_id=?`, b.ID); n != 0 {
		t.Errorf("the deleted team's order row remains")
	}
	if got := g.teamOrderNames(); !reflect.DeepEqual(got, []string{"A"}) {
		t.Errorf("order after delete %v", got)
	}
}

// Test_REQ_API_036_REQ_API_022_company_workstream_order: distinct names of all roadmaps, ignoring case, first
// spelling wins; saved order first, the rest alphabetical; the saved order keeps absent names.
func Test_REQ_API_036_REQ_API_022_company_workstream_order(t *testing.T) {
	t.Run("names capped", func(t *testing.T) {
		g := newRig(t)
		mk := func(n int) []string {
			out := make([]string, n)
			for i := range out {
				out[i] = fmt.Sprintf("ws %d", i)
			}
			return out
		}
		base := g.auditCount()
		status, e := call[errResp](g, "PUT", "/api/company/workstream-order", map[string]any{"names": mk(1001)})
		if status != 422 || !strings.Contains(e.Error.Fields["names"], "1000") {
			t.Errorf("1001 names: status %d %+v, want 422 naming the limit on field names", status, e.Error)
		}
		if n := countRows(g, `SELECT COUNT(*) FROM company_workstream_order`); n != 0 || g.auditCount() != base {
			t.Errorf("a refused PUT changed state (%d rows)", n)
		}
		g.expect(200, "PUT", "/api/company/workstream-order", map[string]any{"names": mk(1000)})
		if n := countRows(g, `SELECT COUNT(*) FROM company_workstream_order`); n != 1000 {
			t.Errorf("rows %d, want 1000", n)
		}
		g.expect(422, "PUT", "/api/company/workstream-order", map[string]any{"names": []string{strings.Repeat("é", 201)}})
		g.expect(200, "PUT", "/api/company/workstream-order", map[string]any{"names": []string{strings.Repeat("é", 200)}})
		if n := countRows(g, `SELECT COUNT(*) FROM company_workstream_order`); n != 1 {
			t.Errorf("a PUT replaces the whole list: rows %d, want 1", n)
		}
	})

	g := newRig(t)
	t1 := g.Team(testTeamOpts("One", "ONE"))
	t2 := g.Team(testTeamOpts("Two", "TWO"))
	t3 := g.Team(testTeamOpts("Three", "THR"))
	r1 := g.Roadmap(t1, roadmapOpts())
	r2 := g.Roadmap(t2, roadmapOpts())
	g.Roadmap(t3, roadmapOpts()) // only "General"
	g.Workstream(r1, "Platform")
	g.Workstream(r1, "design")
	g.Workstream(r2, "platform") // same workstream, other spelling: merged
	g.Workstream(r2, "Zed")

	got := must[nameOrder](g, 200, "GET", "/api/company/workstream-order", nil).Items
	if want := []string{"design", "General", "Platform", "Zed"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("unsaved order %v, want %v", got, want)
	}

	base := g.auditCount()
	got = must[nameOrder](g, 200, "PUT", "/api/company/workstream-order", map[string]any{"names": []string{"  zed ", "PLATFORM", "Ghost"}}).Items
	if want := []string{"Zed", "Platform", "design", "General"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after PUT %v, want %v (saved first with the roadmaps' spelling, rest alphabetical, Ghost not listed)", got, want)
	}
	if g.auditCount() != base+1 {
		t.Fatalf("expected one audit entry")
	}
	from, to := lastCompanyAudit(g, "company.workstream_order")
	if !reflect.DeepEqual(from, []string{"design", "General", "Platform", "Zed"}) || !reflect.DeepEqual(to, got) {
		t.Errorf("audit from %v to %v", from, to)
	}
	if n := countRows(g, `SELECT COUNT(*) FROM company_workstream_order WHERE workstream_name='ghost'`); n != 1 {
		t.Errorf("a saved name no roadmap has right now must be kept")
	}
	if again := must[nameOrder](g, 200, "GET", "/api/company/workstream-order", nil).Items; !reflect.DeepEqual(again, got) {
		t.Errorf("GET %v differs from the PUT result %v", again, got)
	}

	// REQ_AUD_022: the same effective order again writes nothing, and still answers 200
	g.expect(200, "PUT", "/api/company/workstream-order", map[string]any{"names": []string{"Zed", "Platform", "Ghost"}})
	if g.auditCount() != base+1 {
		t.Errorf("a no-op PUT wrote an audit entry")
	}

	// a workstream that comes back lands at its saved position
	g.Workstream(r1, "Ghost")
	if got := must[nameOrder](g, 200, "GET", "/api/company/workstream-order", nil).Items; !reflect.DeepEqual(got, []string{"Zed", "Platform", "Ghost", "design", "General"}) {
		t.Errorf("returning workstream: %v", got)
	}

	long := strings.Repeat("x", 201)
	for name, names := range map[string][]string{
		"blank": {"A", "  "}, "too long": {long}, "case duplicate": {"Alpha", "ALPHA"},
	} {
		status, e := call[errResp](g, "PUT", "/api/company/workstream-order", map[string]any{"names": names})
		if status != 422 || e.Error.Fields["names"] == "" {
			t.Errorf("%s: status %d %+v, want 422 with field names", name, status, e.Error)
		}
	}
	g.expect(422, "PUT", "/api/company/workstream-order", map[string]any{})
	if g.auditCount() != base+1 {
		t.Errorf("refused PUTs wrote audit entries")
	}

}

// Test_REQ_API_039_company_reads_are_anonymous_writes_are_admin_json: also covers REQ_API_031.
func Test_REQ_API_039_company_reads_are_anonymous_writes_are_admin_json(t *testing.T) {
	g := newRig(t)
	a := g.anon()
	tm := g.Team(testTeamOpts("A", "AAA"))
	rm := g.Roadmap(tm, roadmapOpts())
	d := g.Deliverable(rm, testutil.DeliverableOpts{StartDay: 0, EndDay: 3})
	for _, p := range []string{"/api/company/roadmaps", "/api/company/team-order", "/api/company/workstream-order",
		"/api/company/dependencies", "/api/company/trace/deliverable/" + id(d.ID)} {
		if status, _ := a.send("GET", p, "", nil); status != 200 {
			t.Errorf("anonymous GET %s = %d, want 200", p, status)
		}
	}
	base := g.auditCount()
	a.expect(401, "PUT", "/api/company/team-order", map[string]any{"team_ids": []int64{tm.ID}})
	a.expect(401, "PUT", "/api/company/workstream-order", map[string]any{"names": []string{"X"}})
	if status, _ := g.send("PUT", "/api/company/team-order", "text/plain", []byte(`{"team_ids":[]}`)); status != 415 {
		t.Errorf("non-JSON PUT = %d, want 415", status)
	}
	if status, _ := g.send("PUT", "/api/company/workstream-order", "", nil); status != 415 {
		t.Errorf("PUT without content type = %d, want 415", status)
	}
	if countRows(g, `SELECT COUNT(*) FROM company_team_order`)+countRows(g, `SELECT COUNT(*) FROM company_workstream_order`) != 0 || g.auditCount() != base {
		t.Errorf("a refused write changed state")
	}
}

// companyGraph builds: A(team1) -> B(team2) -> C(team3), A -> D(team1), E alone.
type companyGraph struct {
	g          *rig
	a, b, c, d testutil.Deliverable
	e          testutil.Deliverable
}

func newCompanyGraph(t *testing.T) companyGraph {
	g := newRig(t)
	t1 := g.Team(testTeamOpts("One", "ONE"))
	t2 := g.Team(testTeamOpts("Two", "TWO"))
	t3 := g.Team(testTeamOpts("Three", "THR"))
	r1, r2 := g.Roadmap(t1, roadmapOpts()), g.Roadmap(t2, roadmapOpts())
	r3 := g.Roadmap(t3, roadmapOpts())
	c := companyGraph{g: g}
	c.a = g.Deliverable(r1, testutil.DeliverableOpts{Name: "A", StartDay: 0, EndDay: 10})
	c.b = g.Deliverable(r2, testutil.DeliverableOpts{Name: "B", StartDay: 20, EndDay: 30})
	c.c = g.Deliverable(r3, testutil.DeliverableOpts{Name: "C", StartDay: 40, EndDay: 50})
	c.d = g.Deliverable(r1, testutil.DeliverableOpts{Name: "D", StartDay: 20, EndDay: 30})
	c.e = g.Deliverable(r1, testutil.DeliverableOpts{Name: "E", StartDay: 60, EndDay: 70})
	g.Dependency(c.a, c.b)
	g.Dependency(c.b, c.c)
	g.Dependency(c.a, c.d)
	return c
}

func Test_REQ_API_038_REQ_API_031_company_dependencies_of_every_roadmap(t *testing.T) {
	c := newCompanyGraph(t)
	items := must[companyEdges](c.g, 200, "GET", "/api/company/dependencies", nil).Items
	if len(items) != 3 {
		t.Fatalf("edges %d, want 3: %+v", len(items), items)
	}
	var bc store.CompanyEdge
	for _, e := range items {
		if e.FromID == c.b.ID && e.ToID == c.c.ID {
			bc = e
		}
	}
	if bc.From.Name != "B" || bc.From.TeamName != "Two" || bc.From.TeamTag != "TWO" ||
		bc.To.Name != "C" || bc.To.TeamName != "Three" || bc.To.TeamTag != "THR" ||
		bc.To.RoadmapID != c.c.RoadmapID || bc.To.StartDate != c.c.Start || bc.To.EndDate != c.c.End || bc.To.TeamID == 0 {
		t.Errorf("edge B->C ends: %+v", bc)
	}
	_, raw := c.g.send("GET", "/api/company/dependencies", "", nil)
	for _, k := range []string{`"team_id"`, `"team_tag"`, `"team_name"`, `"start_date"`} {
		if !strings.Contains(string(raw), k) {
			t.Errorf("response lacks %s: %s", k, raw)
		}
	}
	if strings.Contains(string(raw), "active") || strings.Contains(string(raw), "archived") {
		t.Errorf("a dependency end has no active/archived field any more (REQ_DAT_032): %s", raw)
	}
}

func Test_REQ_DEP_022_trace_follows_every_teams_roadmap(t *testing.T) {
	c := newCompanyGraph(t)
	g := c.g
	tr := must[store.TypedTrace](g, 200, "GET", "/api/company/trace/deliverable/"+id(c.b.ID), nil)
	if tr.Root.ID != c.b.ID || !reflect.DeepEqual(delivIDs(tr.Prerequisites), []int64{c.a.ID}) || !reflect.DeepEqual(delivIDs(tr.Dependents), []int64{c.c.ID}) {
		t.Fatalf("trace of B: %+v", tr)
	}
	if len(tr.Edges) != 2 {
		t.Errorf("edges among {A,B,C}: %+v", tr.Edges)
	}
	tr = must[store.TypedTrace](g, 200, "GET", "/api/company/trace/deliverable/"+id(c.a.ID), nil)
	want := []int64{c.b.ID, c.c.ID, c.d.ID}
	slices.Sort(want)
	if len(tr.Prerequisites) != 0 || !reflect.DeepEqual(delivIDs(tr.Dependents), want) || len(tr.Edges) != 3 {
		t.Errorf("trace of A: %+v", tr)
	}
	tr = must[store.TypedTrace](g, 200, "GET", "/api/company/trace/deliverable/"+id(c.c.ID), nil)
	if want := []int64{c.a.ID, c.b.ID}; !reflect.DeepEqual(delivIDs(tr.Prerequisites), want) || len(tr.Dependents) != 0 {
		t.Errorf("trace of C: %+v", tr)
	}
	// D is not an ancestor of B: siblings are unrelated
	if tr := must[store.TypedTrace](g, 200, "GET", "/api/company/trace/deliverable/"+id(c.d.ID), nil); !reflect.DeepEqual(delivIDs(tr.Prerequisites), []int64{c.a.ID}) || len(tr.Dependents) != 0 || len(tr.Edges) != 1 {
		t.Errorf("trace of D: %+v", tr)
	}
	_, raw := g.send("GET", "/api/company/trace/deliverable/"+id(c.e.ID), "", nil)
	if !strings.Contains(string(raw), `"prerequisites":[]`) || !strings.Contains(string(raw), `"dependents":[]`) || !strings.Contains(string(raw), `"edges":[]`) {
		t.Errorf("a deliverable with no dependencies must get empty lists, not null: %s", raw)
	}
	g.expect(404, "GET", "/api/company/trace/deliverable/"+id(g.noSuchID()), nil)
	g.expect(400, "GET", "/api/company/trace/deliverable/abc", nil)
}

// Test_REQ_TEST_018_company_trace_equals_brute_force_reachability: on seeded random company graphs
// (several teams, random roadmaps, random cross-roadmap edges) the trace of
// every deliverable equals a reachability closure computed here from the stored edges.
func Test_REQ_TEST_018_company_trace_equals_brute_force_reachability(t *testing.T) {
	g := newRig(t)
	var all []testutil.Deliverable
	for i := 0; i < 4; i++ {
		tm := g.Team(testutil.TeamOpts{})
		_, ds := g.RandomRoadmap(tm)
		all = append(all, ds...)
	}
	for _, x := range all { // cross-team edges, only where the date rule allows
		for _, y := range all {
			if x.RoadmapID != y.RoadmapID && x.EndDay < y.StartDay && g.RNG.Intn(8) == 0 {
				g.Dependency(x, y)
			}
		}
	}
	type pair struct{ from, to int64 }
	var edges []pair
	rows, err := g.DB.Query(`SELECT from_id, to_id FROM dependencies`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.from, &p.to); err != nil {
			t.Fatal(err)
		}
		edges = append(edges, p)
	}
	rows.Close()
	reach := func(start int64, forward bool) []int64 { // plain fixpoint iteration, no queue
		in := map[int64]bool{}
		for changed := true; changed; {
			changed = false
			for _, e := range edges {
				src, dst := e.from, e.to
				if !forward {
					src, dst = dst, src
				}
				if (src == start || in[src]) && !in[dst] {
					in[dst] = true
					changed = true
				}
			}
		}
		out := []int64{}
		for n := range in {
			out = append(out, n)
		}
		slices.Sort(out)
		return out
	}
	for _, d := range all {
		tr := must[store.TypedTrace](g, 200, "GET", fmt.Sprintf("/api/company/trace/deliverable/%d", d.ID), nil)
		if want := reach(d.ID, false); !slices.Equal(delivIDs(tr.Prerequisites), want) {
			t.Fatalf("deliverable %d prerequisites %v, brute force %v (seed %d, replay with TEST_SEED=%d)", d.ID, tr.Prerequisites, want, g.Seed, testutil.MasterSeed())
		}
		if want := reach(d.ID, true); !slices.Equal(delivIDs(tr.Dependents), want) {
			t.Fatalf("deliverable %d dependents %v, brute force %v (seed %d, replay with TEST_SEED=%d)", d.ID, tr.Dependents, want, g.Seed, testutil.MasterSeed())
		}
	}
	if len(edges) == 0 {
		t.Logf("no edges were generated for seed %d (replay with TEST_SEED=%d)", g.Seed, testutil.MasterSeed())
	}
}

// delivIDs lists the deliverable ids of a typed trace list (the lists here hold deliverables only).
func delivIDs(refs []store.ItemRef) []int64 {
	out := []int64{}
	for _, r := range refs {
		out = append(out, r.ID)
	}
	return out
}
