package api_test

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/testutil"
)

// depState is everything a dependency operation could change: every deliverable's dates and every edge.
type depState struct {
	dates map[int64]string // id -> "start..end"
	edges []string         // "from>to", sorted
}

func (g *rig) depSnapshot() depState {
	g.T.Helper()
	s := depState{dates: map[int64]string{}}
	rows, err := g.DB.Query(`SELECT id, start_date, end_date FROM deliverables`)
	if err != nil {
		g.T.Fatal(err)
	}
	for rows.Next() {
		var id int64
		var st, en string
		if err := rows.Scan(&id, &st, &en); err != nil {
			g.T.Fatal(err)
		}
		s.dates[id] = st + ".." + en
	}
	rows.Close()
	rows, err = g.DB.Query(`SELECT from_id, to_id FROM dependencies`)
	if err != nil {
		g.T.Fatal(err)
	}
	for rows.Next() {
		var a, b int64
		if err := rows.Scan(&a, &b); err != nil {
			g.T.Fatal(err)
		}
		s.edges = append(s.edges, fmt.Sprintf("%d>%d", a, b))
	}
	rows.Close()
	sort.Strings(s.edges)
	return s
}

func (s depState) equal(o depState) bool {
	if len(s.dates) != len(o.dates) || strings.Join(s.edges, ",") != strings.Join(o.edges, ",") {
		return false
	}
	for id, d := range s.dates {
		if o.dates[id] != d {
			return false
		}
	}
	return true
}

// checkDepInvariants asserts the hard rule REQ_DEP_004 (every dependent starts after its
// prerequisite ends), REQ_DEP_002 (no self edge) and REQ_DEP_003 (no cycle) on the stored data.
func (g *rig) checkDepInvariants(step string) {
	g.T.Helper()
	s := g.depSnapshot()
	next := map[int64][]int64{}
	for _, e := range s.edges {
		var from, to int64
		fmt.Sscanf(e, "%d>%d", &from, &to)
		if from == to {
			g.T.Fatalf("%s: self dependency %s (seed %d, replay with TEST_SEED=%d)", step, e, g.Seed, testutil.MasterSeed())
		}
		pre, dep := strings.Split(s.dates[from], ".."), strings.Split(s.dates[to], "..")
		if !(dep[0] > pre[1]) { // ISO dates compare lexically
			g.T.Fatalf("%s: REQ_DEP_004 broken on edge %s: prerequisite %s, dependent %s (seed %d, replay with TEST_SEED=%d)", step, e, s.dates[from], s.dates[to], g.Seed, testutil.MasterSeed())
		}
		next[from] = append(next[from], to)
	}
	const (
		white = iota
		grey
		black
	)
	colour := map[int64]int{}
	var visit func(n int64) bool
	visit = func(n int64) bool {
		colour[n] = grey
		for _, m := range next[n] {
			if colour[m] == grey || (colour[m] == white && visit(m)) {
				return true
			}
		}
		colour[n] = black
		return false
	}
	for n := range next {
		if colour[n] == white && visit(n) {
			g.T.Fatalf("%s: REQ_DEP_003 broken: the stored edges contain a cycle %v (seed %d, replay with TEST_SEED=%d)", step, s.edges, g.Seed, testutil.MasterSeed())
		}
	}
}

// Test_REQ_TEST_018_dependency_order_holds_on_random_roadmaps is the seeded random-roadmap test for
// the dependency hard rule (REQ_DEP_004, with REQ_DEP_002/003): random deliverables across two teams,
// then random add-dependency, remove-dependency and date-PATCH requests through the real API. After
// every request the stored data must satisfy the rule, and a refused request must have changed
// nothing. NewEnv logs `replay with TEST_SEED=<n>` on failure, and every failure message names the seed.
func Test_REQ_TEST_018_dependency_order_holds_on_random_roadmaps(t *testing.T) {
	g := newRig(t)
	rng := g.RNG
	t.Logf("seed %d (replay with TEST_SEED=%d)", g.Seed, testutil.MasterSeed())

	var ids []int64
	for i := 0; i < 2; i++ {
		rm := g.Roadmap(g.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
		for j, n := 0, 5+rng.Intn(5); j < n; j++ {
			s := rng.Intn(700)
			ids = append(ids, g.Deliverable(rm, testutil.DeliverableOpts{StartDay: s, EndDay: s + 1 + rng.Intn(60)}).ID)
		}
	}
	g.checkDepInvariants("initial")

	accepted, refused := 0, 0
	for step := 0; step < 400; step++ {
		before := g.depSnapshot()
		var status int
		var what string
		switch op := rng.Intn(10); {
		case op < 4: // add a dependency between two random deliverables (possibly the same one)
			to, from := ids[rng.Intn(len(ids))], ids[rng.Intn(len(ids))]
			what = fmt.Sprintf("add %d>%d", from, to)
			status, _ = g.addDep(to, from)
		case op < 5 && len(before.edges) > 0: // remove an existing edge
			var from, to int64
			fmt.Sscanf(before.edges[rng.Intn(len(before.edges))], "%d>%d", &from, &to)
			what = fmt.Sprintf("remove %d>%d", from, to)
			status, _ = call[errResp](g, "DELETE", depsURL(to)+"/deliverable/"+id(from), nil)
		default: // change dates: start, end, or the whole bar, sometimes aimed right at an edge's boundary
			d := ids[rng.Intn(len(ids))]
			body := map[string]any{}
			day := func() string { return g.Clock.Date(rng.Intn(800)) }
			switch rng.Intn(3) {
			case 0:
				body["start_date"] = day()
			case 1:
				body["end_date"] = day()
			default:
				s := rng.Intn(800)
				body["start_date"], body["end_date"] = g.Clock.Date(s), g.Clock.Date(s+rng.Intn(60))
			}
			if rng.Intn(3) == 0 && len(before.edges) > 0 { // probe the exact boundary of a random edge
				var from, to int64
				fmt.Sscanf(before.edges[rng.Intn(len(before.edges))], "%d>%d", &from, &to)
				pre := strings.Split(before.dates[from], "..")
				delete(body, "start_date")
				delete(body, "end_date")
				d = to
				body["start_date"] = shiftISO(pre[1], rng.Intn(3)) // day of, day after, two after the prerequisite's end
			}
			what = fmt.Sprintf("patch %d %v", d, body)
			status, _ = call[errResp](g, "PATCH", "/api/deliverables/"+id(d), body)
		}
		after := g.depSnapshot()
		switch {
		case status >= 200 && status < 300:
			accepted++
		case status == 400 || status == 404 || status == 409 || status == 422:
			refused++
			if !before.equal(after) {
				t.Fatalf("step %d %s: refused with %d but changed stored data (seed %d)\nbefore %v\nafter  %v", step, what, status, g.Seed, before, after)
			}
		default:
			t.Fatalf("step %d %s: unexpected status %d (seed %d, replay with TEST_SEED=%d)", step, what, status, g.Seed, testutil.MasterSeed())
		}
		g.checkDepInvariants(fmt.Sprintf("step %d %s -> %d", step, what, status))
	}
	if accepted == 0 || refused == 0 {
		t.Errorf("degenerate run: %d accepted, %d refused (seed %d, replay with TEST_SEED=%d) — the random operations should hit both", accepted, refused, g.Seed, testutil.MasterSeed())
	}
	t.Logf("%d accepted, %d refused", accepted, refused)
}

// shiftISO returns the ISO date n days after the given ISO date.
func shiftISO(iso string, n int) string {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		panic(err)
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}
