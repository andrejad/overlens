package store_test

import (
	"context"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// A deliverable's main workstream is the first one listed (lowest workstream position). It is worked
// out when read and never stored: no column or table names a primary, and reordering the workstreams
// changes which one comes first without touching the deliverable.
func Test_REQ_DAT_005_main_workstream_is_first_listed_and_not_stored(t *testing.T) {
	e := testutil.NewEnv(t)
	ctx := context.Background()
	rm := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
	first := e.Workstream(rm, "First")
	second := e.Workstream(rm, "Second")
	third := e.Workstream(rm, "Third")
	// memberships are given in an order unrelated to the workstream order
	d := e.Deliverable(rm, testutil.DeliverableOpts{WorkstreamIDs: []int64{third.ID, first.ID, second.ID}})

	main := func() int64 {
		t.Helper()
		got, err := store.DeliverableGet(ctx, e.DB, d.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.WorkstreamIDs) != 3 {
			t.Fatalf("workstream ids: %v", got.WorkstreamIDs)
		}
		return got.WorkstreamIDs[0]
	}
	if got := main(); got != first.ID {
		t.Fatalf("main workstream = %d, want the first listed %d", got, first.ID)
	}

	// reordering the workstreams moves the main one; nothing is stored on the deliverable
	var all []int64
	rows, err := e.DB.Query(`SELECT id FROM workstreams WHERE roadmap_id=? ORDER BY position, id`, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		all = append(all, id)
	}
	rows.Close()
	rev := make([]int64, len(all))
	for i, id := range all {
		rev[len(all)-1-i] = id
	}
	if _, _, _, _, err := store.WorkstreamReorder(ctx, e.DB, rm.ID, rev); err != nil {
		t.Fatal(err)
	}
	if got := main(); got != third.ID {
		t.Fatalf("after reversing the order the main workstream = %d, want %d", got, third.ID)
	}

	// no stored primary: no table or column in the schema carries the word
	for _, q := range []string{
		`SELECT m.name || '.' || p.name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type='table' AND lower(p.name) LIKE '%primary%'`,
		`SELECT name FROM sqlite_master WHERE type IN ('table','index') AND lower(name) LIKE '%primary%'`,
	} {
		rs, err := e.DB.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		var found []string
		for rs.Next() {
			var s string
			if err := rs.Scan(&s); err != nil {
				t.Fatal(err)
			}
			found = append(found, s)
		}
		rs.Close()
		if len(found) > 0 {
			t.Errorf("schema stores a primary: %s", strings.Join(found, ", "))
		}
	}
}
