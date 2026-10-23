package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

const (
	dk = store.KindDeliverable
	mk = store.KindMilestone
)

func ref(kind string, id int64) store.ItemRef { return store.ItemRef{Kind: kind, ID: id} }

func addEdge(e *testutil.Env, fromKind string, from int64, toKind string, to int64) error {
	_, err := store.DependencyAddItems(context.Background(), e.DB, ref(toKind, to), ref(fromKind, from), "from_id")
	return err
}

func storeErr(t *testing.T, err error, code string) *store.Error {
	t.Helper()
	var se *store.Error
	if !errors.As(err, &se) || se.Code != code {
		t.Fatalf("got %v, want a %q store error", err, code)
	}
	return se
}

// fixture: team A with D1 (day 0-5), D2 (day 20-25) and milestones M1 (day 10), M2 (day 15).
type fx struct {
	e      *testutil.Env
	rm     testutil.Roadmap
	d1, d2 testutil.Deliverable
	m1, m2 testutil.Milestone
}

func newFx(t *testing.T) fx {
	e := testutil.NewEnv(t)
	tm := e.Team(testutil.TeamOpts{})
	rm := e.Roadmap(tm, testutil.RoadmapOpts{})
	return fx{e: e, rm: rm,
		d1: e.Deliverable(rm, testutil.DeliverableOpts{Name: "D1", StartDay: 0, EndDay: 5}),
		d2: e.Deliverable(rm, testutil.DeliverableOpts{Name: "D2", StartDay: 20, EndDay: 25}),
		m1: e.Milestone(rm, testutil.MilestoneOpts{Name: "M1", Day: 10}),
		m2: e.Milestone(rm, testutil.MilestoneOpts{Name: "M2", Day: 15}),
	}
}

// Test_REQ_DEP_023_all_four_combinations: deliverable->deliverable, deliverable->milestone,
// milestone->deliverable and milestone->milestone all add, are idempotent, list from both ends and remove.
func Test_REQ_DEP_023_all_four_combinations(t *testing.T) {
	t.Run("the table refuses an unknown kind", func(t *testing.T) {
		e := testutil.NewEnv(t)
		for _, q := range []string{
			`INSERT INTO dependencies(from_kind, from_id, to_kind, to_id) VALUES ('thing',1,'milestone',2)`,
			`INSERT INTO dependencies(from_kind, from_id, to_kind, to_id) VALUES ('milestone',1,'',2)`,
		} {
			if _, err := e.DB.Exec(q); err == nil {
				t.Errorf("accepted: %s", q)
			}
		}
	})

	f := newFx(t)
	ctx := context.Background()
	f.e.ItemDependency(dk, f.d1.ID, dk, f.d2.ID)
	f.e.ItemDependency(dk, f.d1.ID, mk, f.m1.ID)
	f.e.ItemDependency(mk, f.m1.ID, mk, f.m2.ID)
	f.e.ItemDependency(mk, f.m2.ID, dk, f.d2.ID)
	// duplicate: nothing written
	res, err := store.DependencyAddItems(ctx, f.e.DB, ref(mk, f.m2.ID), ref(mk, f.m1.ID), "from_id")
	if err != nil || res.Created {
		t.Fatalf("duplicate: created=%v err=%v", res.Created, err)
	}
	var n int
	f.e.DB.QueryRow(`SELECT COUNT(*) FROM dependencies`).Scan(&n)
	if n != 4 {
		t.Errorf("%d rows in dependencies, want 4", n)
	}
	edges, err := store.DependenciesOf(ctx, f.e.DB, ref(mk, f.m1.ID))
	if err != nil || len(edges) != 2 {
		t.Fatalf("edges of M1: %+v %v", edges, err)
	}
	if e := edges[0]; e.FromKind != dk || e.FromID != f.d1.ID || e.ToKind != mk || e.ToID != f.m1.ID || e.Other == nil || e.Other.Kind != dk || e.Other.Name != "D1" {
		t.Errorf("first edge of M1: %+v other %+v", e, e.Other)
	}
	if e := edges[1]; e.FromKind != mk || e.ToKind != mk || e.Other == nil || e.Other.Name != "M2" || e.Other.StartDate != f.m2.Date || e.Other.EndDate != f.m2.Date {
		t.Errorf("second edge of M1: %+v other %+v", e, e.Other)
	}
	// self-dependency of a milestone is refused, a deliverable and a milestone with one id are not "self"
	storeErr(t, addEdge(f.e, mk, f.m1.ID, mk, f.m1.ID), "validation_failed")
	// removal, in the right table
	for _, c := range []struct {
		fk string
		f  int64
		tk string
		t  int64
	}{{dk, f.d1.ID, dk, f.d2.ID}, {dk, f.d1.ID, mk, f.m1.ID}, {mk, f.m1.ID, mk, f.m2.ID}, {mk, f.m2.ID, dk, f.d2.ID}} {
		if _, _, err := store.DependencyRemoveItems(ctx, f.e.DB, ref(c.tk, c.t), ref(c.fk, c.f)); err != nil {
			t.Errorf("remove %v: %v", c, err)
		}
		if _, _, err := store.DependencyRemoveItems(ctx, f.e.DB, ref(c.tk, c.t), ref(c.fk, c.f)); err == nil {
			t.Errorf("second remove of %v succeeded", c)
		}
	}
}

// Test_REQ_DEP_024_day_boundary: a dependent must start strictly after the day its prerequisite ends,
// for every combination of kinds.
func Test_REQ_DEP_024_day_boundary(t *testing.T) {
	f := newFx(t)
	e := f.e
	same := e.Milestone(f.rm, testutil.MilestoneOpts{Name: "Same day as D1 end", Day: 5})
	next := e.Milestone(f.rm, testutil.MilestoneOpts{Name: "Day after D1 end", Day: 6})
	// deliverable -> milestone
	se := storeErr(t, addEdge(e, dk, f.d1.ID, mk, same.ID), "date_order")
	if se.EarliestStart != e.Clock.Date(6) {
		t.Errorf("earliest_start %q, want %q", se.EarliestStart, e.Clock.Date(6))
	}
	if err := addEdge(e, dk, f.d1.ID, mk, next.ID); err != nil {
		t.Errorf("milestone the day after the end: %v", err)
	}
	// milestone -> deliverable: D3 starts on the day of M1 (day 10), D4 the day after
	d3 := e.Deliverable(f.rm, testutil.DeliverableOpts{StartDay: 10, EndDay: 12})
	d4 := e.Deliverable(f.rm, testutil.DeliverableOpts{StartDay: 11, EndDay: 12})
	storeErr(t, addEdge(e, mk, f.m1.ID, dk, d3.ID), "date_order")
	if err := addEdge(e, mk, f.m1.ID, dk, d4.ID); err != nil {
		t.Errorf("deliverable starting the day after the milestone: %v", err)
	}
	// milestone -> milestone: same date refused, the next day accepted
	twin := e.Milestone(f.rm, testutil.MilestoneOpts{Name: "Twin of M1", Day: 10})
	storeErr(t, addEdge(e, mk, f.m1.ID, mk, twin.ID), "date_order")
	if err := addEdge(e, mk, f.m1.ID, mk, f.m2.ID); err != nil {
		t.Errorf("milestone after milestone: %v", err)
	}
	// ... and a rejected add wrote nothing
	var n int
	e.DB.QueryRow(`SELECT COUNT(*) FROM dependencies WHERE to_id=? AND to_kind='milestone'`, twin.ID).Scan(&n)
	if n != 0 {
		t.Errorf("refused edge was stored")
	}
}

// Test_REQ_DEP_024_milestone_update_checks_edges: PATCH-level date rule for a milestone, both ways, and
// deliverable writes check the edges to milestones too.
func Test_REQ_DEP_024_writes_check_milestone_edges(t *testing.T) {
	f := newFx(t)
	e := f.e
	ctx := context.Background()
	e.ItemDependency(dk, f.d1.ID, mk, f.m1.ID) // D1 (ends day 5) -> M1 (day 10)
	e.ItemDependency(mk, f.m1.ID, dk, f.d2.ID) // M1 (day 10) -> D2 (starts day 20)
	date := func(d int) *string { s := e.Clock.Date(d); return &s }

	upd := func(d int) error {
		_, _, _, _, _, err := store.MilestoneUpdate(ctx, e.DB, f.m1.ID, store.MilestoneInput{Date: date(d)})
		return err
	}
	se := storeErr(t, upd(5), "date_order") // on the prerequisite's end day
	if se.EarliestDate != e.Clock.Date(6) || se.LatestDate != "" || se.EarliestStart != "" || se.LatestEnd != "" {
		t.Errorf("range %+v", se)
	}
	se = storeErr(t, upd(20), "date_order") // on the dependent's start day
	if se.LatestDate != e.Clock.Date(19) || se.EarliestDate != "" {
		t.Errorf("range %+v", se)
	}
	storeErr(t, upd(25), "date_order")
	for _, d := range []int{6, 19} {
		if err := upd(d); err != nil {
			t.Errorf("day %d: %v", d, err)
		}
	}
	// M1 is on day 19 now. A deliverable write: D2 may not start on or before it, D1 may not end on or after it
	updD := func(id int64, s, en int) error {
		_, _, _, _, _, err := store.DeliverableUpdate(ctx, e.DB, id, store.DeliverableInput{StartDate: date(s), EndDate: date(en)})
		return err
	}
	se = storeErr(t, updD(f.d2.ID, 19, 25), "date_order")
	if se.EarliestStart != e.Clock.Date(20) {
		t.Errorf("earliest_start %q", se.EarliestStart)
	}
	if err := updD(f.d2.ID, 20, 25); err != nil {
		t.Errorf("D2 on the day after: %v", err)
	}
	se = storeErr(t, updD(f.d1.ID, 0, 19), "date_order")
	if se.LatestEnd != e.Clock.Date(18) {
		t.Errorf("latest_end %q", se.LatestEnd)
	}
	one := 1 // M2 (day 15) steps out of D1's row first, so the no-overlap rule (REQ_API_051) stays out of this
	if _, _, _, _, _, err := store.MilestoneUpdate(ctx, e.DB, f.m2.ID, store.MilestoneInput{Row: &one}); err != nil {
		t.Fatal(err)
	}
	if err := updD(f.d1.ID, 0, 18); err != nil {
		t.Errorf("D1 ending the day before: %v", err)
	}
	// a PATCH that resends the stored date is never refused, even if the data were out of order
	if _, err := e.DB.Exec(`UPDATE milestones SET date=? WHERE id=?`, e.Clock.Date(3), f.m1.ID); err != nil {
		t.Fatal(err)
	}
	if err := upd(3); err != nil {
		t.Errorf("unchanged date refused: %v", err)
	}
}

// Test_REQ_DEP_025_cycles_through_milestones: a loop is found across both tables, and the path says which
// item is a milestone. A loop of deliverables only keeps the plain string path.
func Test_REQ_DEP_025_cycles_through_milestones(t *testing.T) {
	f := newFx(t)
	e := f.e
	e.ItemDependency(dk, f.d1.ID, mk, f.m1.ID) // D1 -> M1
	e.ItemDependency(mk, f.m1.ID, dk, f.d2.ID) // M1 -> D2
	se := storeErr(t, addEdge(e, dk, f.d2.ID, dk, f.d1.ID), "cycle")
	want := []store.PathItem{{Kind: dk, Name: "D2"}, {Kind: dk, Name: "D1"}, {Kind: mk, Name: "M1"}, {Kind: dk, Name: "D2"}}
	if !reflect.DeepEqual(se.TypedPath, want) || len(se.Path) != 0 {
		t.Errorf("typed path %+v / %v, want %+v", se.TypedPath, se.Path, want)
	}
	// milestone -> milestone loop
	e.ItemDependency(mk, f.m1.ID, mk, f.m2.ID)
	se = storeErr(t, addEdge(e, mk, f.m2.ID, mk, f.m1.ID), "cycle")
	if len(se.TypedPath) != 3 || se.TypedPath[0] != se.TypedPath[2] {
		t.Errorf("milestone loop path %+v", se.TypedPath)
	}
	// a deliverable-only loop: plain names, as in Phase 5
	e.ItemDependency(dk, f.d1.ID, dk, f.d2.ID)
	se = storeErr(t, addEdge(e, dk, f.d2.ID, dk, f.d1.ID), "cycle")
	if !reflect.DeepEqual(se.Path, []string{"D2", "D1", "D2"}) || len(se.TypedPath) != 0 {
		t.Errorf("deliverable loop path %v / %+v", se.Path, se.TypedPath)
	}
	// self edge through the cycle check is a validation error, not a cycle
	storeErr(t, addEdge(e, dk, f.d1.ID, dk, f.d1.ID), "validation_failed")
}

// Test_REQ_DEP_029_deletes_leave_no_dangling_rows: deleting a milestone or a deliverable removes
// the milestone edges that touch it and names both ends of each.
func Test_REQ_DEP_029_deletes_leave_no_dangling_rows(t *testing.T) {
	ctx := context.Background()
	f := newFx(t)
	e := f.e
	e.ItemDependency(dk, f.d1.ID, mk, f.m1.ID)
	e.ItemDependency(mk, f.m1.ID, mk, f.m2.ID)
	e.ItemDependency(mk, f.m2.ID, dk, f.d2.ID)
	e.ItemDependency(dk, f.d1.ID, dk, f.d2.ID)

	_, removed, _, _, err := store.MilestoneDelete(ctx, e.DB, f.m1.ID)
	if err != nil || len(removed) != 2 {
		t.Fatalf("delete M1: %v %+v", err, removed)
	}
	team := removed[0].From.TeamName
	names := map[string]bool{}
	for _, r := range removed {
		names[r.String()] = true
	}
	if !names[fmt.Sprintf("D1 (%s) → milestone M1 (%s)", team, team)] || !names[fmt.Sprintf("milestone M1 (%s) → milestone M2 (%s)", team, team)] {
		t.Errorf("removed edges %v", names)
	}
	if n := e.DanglingMilestoneDependencies(); n != 0 {
		t.Errorf("%d dangling rows after milestone delete", n)
	}
	_, removed, _, _, err = store.DeliverableDelete(ctx, e.DB, f.d2.ID)
	if err != nil || len(removed) != 2 { // M2 -> D2 and D1 -> D2
		t.Fatalf("delete D2: %v %+v", err, removed)
	}
	if n := e.DanglingMilestoneDependencies(); n != 0 {
		t.Errorf("%d dangling rows after deliverable delete", n)
	}
}

// Test_REQ_DEP_025_property_mixed_graph: random adds, date changes and deletes over deliverables and
// milestones, checked against a brute-force oracle. After every step: no self edge, no loop, every edge
// obeys the strict date rule, nothing dangles; every refused write left the data as it was.
func Test_REQ_DEP_025_property_mixed_graph(t *testing.T) {
	ctx := context.Background()
	e := testutil.NewEnv(t)
	rng := e.RNG
	tm := e.Team(testutil.TeamOpts{})
	rm := e.Roadmap(tm, testutil.RoadmapOpts{})
	rm2 := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
	type item struct {
		kind       string
		id         int64
		start, end int
	}
	var items []*item
	for i := 0; i < 8; i++ {
		r := []testutil.Roadmap{rm, rm2}[rng.Intn(2)]
		s := rng.Intn(100)
		d := e.Deliverable(r, testutil.DeliverableOpts{StartDay: s, EndDay: s + 1 + rng.Intn(8)})
		items = append(items, &item{dk, d.ID, d.StartDay, d.EndDay})
	}
	for i := 0; i < 8; i++ {
		r := []testutil.Roadmap{rm, rm2}[rng.Intn(2)]
		d := rng.Intn(110)
		m := e.Milestone(r, testutil.MilestoneOpts{Day: d})
		items = append(items, &item{mk, m.ID, d, d})
	}
	type key struct {
		k string
		i int64
	}
	edges := map[[2]key]bool{}
	reach := func(from, to key) bool { // is `to` reachable from `from` along edges?
		seen := map[key]bool{from: true}
		queue := []key{from}
		for len(queue) > 0 {
			c := queue[0]
			queue = queue[1:]
			if c == to {
				return true
			}
			for ed := range edges {
				if ed[0] == c && !seen[ed[1]] {
					seen[ed[1]] = true
					queue = append(queue, ed[1])
				}
			}
		}
		return false
	}
	find := func(k key) *item {
		for _, it := range items {
			if it.kind == k.k && it.id == k.i {
				return it
			}
		}
		return nil
	}
	snapshot := func() string {
		var s string
		for _, q := range []string{
			`SELECT 'd', id, start_date, end_date FROM deliverables ORDER BY id`,
			`SELECT 'm', id, date, date FROM milestones ORDER BY id`,
			`SELECT from_kind, from_id, to_kind || to_id, '' FROM dependencies ORDER BY 1,2,3`} {
			rows, err := e.DB.Query(q)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var a, d string
				var b sql.NullInt64
				var c string
				if err := rows.Scan(&a, &b, &c, &d); err != nil {
					t.Fatal(err)
				}
				s += fmt.Sprint(a, b.Int64, c, d, ";")
			}
			rows.Close()
		}
		return s
	}
	check := func(step string) {
		t.Helper()
		for ed := range edges {
			a, b := find(ed[0]), find(ed[1])
			if ed[0] == ed[1] || reach(ed[1], ed[0]) {
				t.Fatalf("%s: loop or self edge %v (seed %d)", step, ed, e.Seed)
			}
			if !(b.start > a.end) {
				t.Fatalf("%s: edge %v breaks the strict date rule: %d..%d then %d..%d (seed %d)", step, ed, a.start, a.end, b.start, b.end, e.Seed)
			}
		}
		if n := e.DanglingMilestoneDependencies(); n != 0 {
			t.Fatalf("%s: %d dangling rows (seed %d)", step, n, e.Seed)
		}
		var d int
		e.DB.QueryRow(`SELECT COUNT(*) FROM dependencies`).Scan(&d)
		if d != len(edges) {
			t.Fatalf("%s: database holds %d edges, oracle %d (seed %d)", step, d, len(edges), e.Seed)
		}
	}
	outcomes := map[string]int{} // how the run was spread, logged so a thin run is visible
	defer func() { t.Logf("outcomes: %v", outcomes) }()
	pick := func() *item { return items[rng.Intn(len(items))] }
	date := func(d int) *string { s := e.Clock.Date(d); return &s }
	for step := 0; step < 400; step++ {
		label := fmt.Sprintf("step %d", step)
		switch op := rng.Intn(10); {
		case op < 6: // add
			from, to := pick(), pick()
			fk, tk := key{from.kind, from.id}, key{to.kind, to.id}
			before := snapshot()
			_, err := store.DependencyAddItems(ctx, e.DB, ref(to.kind, to.id), ref(from.kind, from.id), "from_id")
			var se *store.Error
			switch {
			case fk == tk:
				outcomes["self"]++
				storeErr(t, err, "validation_failed")
			case edges[[2]key{fk, tk}]:
				if err != nil {
					t.Fatalf("%s: duplicate refused: %v", label, err)
				}
			case reach(tk, fk):
				outcomes["cycle"]++
				se = storeErr(t, err, "cycle")
				if len(se.Path) == 0 && len(se.TypedPath) == 0 {
					t.Fatalf("%s: cycle without a path", label)
				}
			case to.start <= from.end:
				outcomes["date_order"]++
				storeErr(t, err, "date_order")
			default:
				outcomes["added"]++
				if err != nil {
					t.Fatalf("%s: valid edge %v>%v refused: %v (seed %d)", label, fk, tk, err, e.Seed)
				}
				edges[[2]key{fk, tk}] = true
			}
			if err != nil && snapshot() != before {
				t.Fatalf("%s: a refused add changed the data", label)
			}
		case op < 9: // change a date
			it := pick()
			before := snapshot()
			ns, ne := rng.Intn(110), 0
			ne = ns
			if it.kind == dk {
				ne = ns + rng.Intn(8)
			}
			ok := true
			for ed := range edges {
				a, b := find(ed[0]), find(ed[1])
				s1, e1, s2, e2 := a.start, a.end, b.start, b.end
				if a == it {
					s1, e1 = ns, ne
				}
				if b == it {
					s2, e2 = ns, ne
				}
				_, _ = s1, e2
				if !(s2 > e1) {
					ok = false
				}
			}
			var err error
			if it.kind == dk {
				_, _, _, _, _, err = store.DeliverableUpdate(ctx, e.DB, it.id, store.DeliverableInput{StartDate: date(ns), EndDate: date(ne)})
			} else {
				_, _, _, _, _, err = store.MilestoneUpdate(ctx, e.DB, it.id, store.MilestoneInput{Date: date(ns)})
			}
			// a write that changes nothing is never refused by the date rule, whatever the state
			unchanged := ns == it.start && ne == it.end
			switch {
			case unchanged || ok:
				var se *store.Error
				if errors.As(err, &se) && se.Code == "date_order" {
					t.Fatalf("%s: legal date change refused: %v (seed %d)", label, err, e.Seed)
				}
				if err == nil {
					it.start, it.end = ns, ne
				} else if !errors.As(err, &se) || (se.Code != "span_exceeded" && se.Code != "row_overlap") { // REQ_API_051
					t.Fatalf("%s: %v", label, err)
				}
			default:
				outcomes["date change refused"]++
				storeErr(t, err, "date_order")
				if snapshot() != before {
					t.Fatalf("%s: a refused date change changed the data", label)
				}
			}
		default: // delete an item (and the edges it carries)
			if len(items) <= 8 {
				continue
			}
			i := rng.Intn(len(items))
			it := items[i]
			var err error
			if it.kind == dk {
				_, _, _, _, err = store.DeliverableDelete(ctx, e.DB, it.id)
			} else {
				_, _, _, _, err = store.MilestoneDelete(ctx, e.DB, it.id)
			}
			if err != nil {
				t.Fatalf("%s: delete: %v", label, err)
			}
			for ed := range edges {
				if ed[0] == (key{it.kind, it.id}) || ed[1] == (key{it.kind, it.id}) {
					delete(edges, ed)
				}
			}
			items = append(items[:i], items[i+1:]...)
		}
		check(label)
	}
}
