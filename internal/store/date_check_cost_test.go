package store_test

import (
	"context"
	"database/sql"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_DEP_004_date_check_reads_by_index: every dependency statement a date change of a deliverable
// and of milestones issues is run through EXPLAIN QUERY PLAN, and none may scan a whole table (a SEARCH
// using an index or the primary key is what keeps the cost independent of the database size,
// REQ_DEP_004 / REQ_DEP_024). The items have prerequisites and dependents of every kind of edge, so
// both directions of the check run.
func Test_REQ_DEP_004_date_check_reads_by_index(t *testing.T) {
	e := testutil.NewEnv(t)
	ctx := context.Background()
	r := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
	a := e.Deliverable(r, testutil.DeliverableOpts{StartDay: 0, EndDay: 10})
	b := e.Deliverable(r, testutil.DeliverableOpts{StartDay: 20, EndDay: 30})
	c := e.Deliverable(r, testutil.DeliverableOpts{StartDay: 50, EndDay: 60})
	m := e.Milestone(r, testutil.MilestoneOpts{Day: 80})
	m2 := e.Milestone(r, testutil.MilestoneOpts{Day: 15})
	e.Dependency(a, b)
	e.Dependency(b, c)
	e.ItemDependency(store.KindDeliverable, c.ID, store.KindMilestone, m.ID)
	e.ItemDependency(store.KindDeliverable, a.ID, store.KindMilestone, m2.ID)
	e.ItemDependency(store.KindMilestone, m2.ID, store.KindDeliverable, b.ID)
	e.ItemDependency(store.KindMilestone, m2.ID, store.KindMilestone, m.ID)

	var n atomic.Int64
	log := &sqlLog{}
	db := sql.OpenDB(countingConnector{dsn: e.Path, n: &n, sqls: log})
	db.SetMaxOpenConns(1)
	defer db.Close()
	start, end := e.Clock.Date(21), e.Clock.Date(31)
	if _, _, _, _, _, err := store.DeliverableUpdate(ctx, db, b.ID, store.DeliverableInput{StartDate: &start, EndDate: &end}); err != nil {
		t.Fatal(err)
	}
	for _, mm := range []struct {
		id  int64
		day int
	}{{m.ID, 81}, {m2.ID, 16}} {
		date := e.Clock.Date(mm.day)
		if _, _, _, _, _, err := store.MilestoneUpdate(ctx, db, mm.id, store.MilestoneInput{Date: &date}); err != nil {
			t.Fatal(err)
		}
	}

	checked := 0
	for _, q := range log.queries {
		if !strings.Contains(q.sql, "FROM dependencies") || !strings.HasPrefix(strings.TrimSpace(q.sql), "SELECT") {
			continue
		}
		rows, err := e.DB.QueryContext(ctx, "EXPLAIN QUERY PLAN "+q.sql, q.args...)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s", detail)
			// a dependencies search must pin the item's id as well as its kind (the kind alone
			// reads every edge of that kind)
			kindOnly := strings.Contains(detail, "(from_kind=?)") || strings.Contains(detail, "(to_kind=?)")
			if strings.HasPrefix(detail, "SCAN") || kindOnly {
				t.Errorf("full scan %q in a date-check statement:\n%s", detail, q.sql)
			}
		}
		rows.Close()
		checked++
	}
	if checked < 6 {
		t.Errorf("only %d dependency queries captured, want at least 6", checked)
	}
}

// Test_REQ_DEP_003_cycle_walk_costs_one_query_per_level: the walk behind the cycle check loads the
// edges of a whole level of the graph in one query, so the number of statements grows with the depth
// of the graph below the dependent, not with the number of items in it.
func Test_REQ_DEP_003_cycle_walk_costs_one_query_per_level(t *testing.T) {
	ctx := context.Background()
	// queries counts the statements of adding one edge into the root of a graph `depth` levels deep and
	// `width` items wide per level (every item of a level depends on every item of the level before).
	queries := func(depth, width int) int64 {
		e := testutil.NewEnv(t)
		r := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
		x := e.Milestone(r, testutil.MilestoneOpts{Day: 0})
		root := e.Milestone(r, testutil.MilestoneOpts{Day: 10})
		prev := []int64{root.ID}
		for l := 1; l <= depth; l++ {
			var cur []int64
			for w := 0; w < width; w++ {
				m := e.Milestone(r, testutil.MilestoneOpts{Day: 10 + 10*l})
				cur = append(cur, m.ID)
				for _, p := range prev {
					e.ItemDependency(store.KindMilestone, p, store.KindMilestone, m.ID)
				}
			}
			prev = cur
		}
		var n atomic.Int64
		db := sql.OpenDB(countingConnector{dsn: e.Path, n: &n})
		db.SetMaxOpenConns(1)
		defer db.Close()
		if _, err := store.DependencyAddItems(ctx, db, ref(mk, root.ID), ref(mk, x.ID), "from_id"); err != nil {
			t.Fatal(err)
		}
		return n.Load()
	}
	narrow, wide := queries(3, 2), queries(3, 25)
	if narrow != wide {
		t.Errorf("same depth, 2 vs 25 items per level: %d vs %d statements, want equal", narrow, wide)
	}
	if deeper := queries(5, 2); deeper <= narrow {
		t.Errorf("depth 5 cost %d statements, depth 3 cost %d: the cost should grow with depth", deeper, narrow)
	}
}
