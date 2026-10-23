package store_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_API_038_trace_walker_is_cycle_safe: cycles are refused on write, but the walker must not
// hang or repeat ids if one is ever in the data (hand-inserted here, bypassing the store's check).
func Test_REQ_API_038_trace_walker_is_cycle_safe(t *testing.T) {
	e := testutil.NewEnv(t)
	tm := e.Team(testutil.TeamOpts{})
	rm := e.Roadmap(tm, testutil.RoadmapOpts{})
	a := e.Deliverable(rm, testutil.DeliverableOpts{StartDay: 0, EndDay: 1})
	b := e.Deliverable(rm, testutil.DeliverableOpts{StartDay: 5, EndDay: 6})
	c := e.Deliverable(rm, testutil.DeliverableOpts{StartDay: 10, EndDay: 11})
	for _, p := range [][2]int64{{a.ID, b.ID}, {b.ID, c.ID}, {c.ID, a.ID}} {
		if _, err := e.DB.Exec(`INSERT INTO dependencies(from_kind, from_id, to_kind, to_id) VALUES ('deliverable',?,'deliverable',?)`, p[0], p[1]); err != nil {
			t.Fatal(err)
		}
	}
	tr, err := store.CompanyTraceItem(context.Background(), e.DB, store.ItemRef{Kind: store.KindDeliverable, ID: b.ID})
	if err != nil {
		t.Fatal(err)
	}
	want := []store.ItemRef{{Kind: store.KindDeliverable, ID: a.ID}, {Kind: store.KindDeliverable, ID: c.ID}}
	if !reflect.DeepEqual(tr.Prerequisites, want) || !reflect.DeepEqual(tr.Dependents, want) || len(tr.Edges) != 3 {
		t.Errorf("trace through a loop: %+v", tr)
	}
	for _, r := range append(tr.Prerequisites, tr.Dependents...) {
		if r.ID == b.ID {
			t.Errorf("the root must not list itself")
		}
	}
}
