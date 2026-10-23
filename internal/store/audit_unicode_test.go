package store_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_AUD_016_deliverable_filter_ignores_case_for_non_ascii_and_keeps_paging_right.
func Test_REQ_AUD_016_deliverable_filter_ignores_case_for_non_ascii_and_keeps_paging_right(t *testing.T) {
	e := testutil.NewEnv(t)
	ctx := context.Background()
	add := func(typ, details string) {
		if _, err := e.DB.Exec(`INSERT INTO audit_log(ts, username, action, entity_type, details_json) VALUES ('2030-01-01 00:00:00','a','x',?,?)`, typ, details); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 7 {
		add("deliverable", fmt.Sprintf(`{"deliverable":"Großer Ärger %d"}`, i))
	}
	add("deliverable", `{"deliverable":"Unrelated"}`)
	add("dependency", `{"from":"Prep","to":"ÄRGER-Fix"}`)
	add("team", `{"deliverable":"ärger but wrong type filter"}`)

	f := store.AuditFilter{Deliverable: "ärger"}
	n, err := store.AuditCount(ctx, e.DB, f)
	if err != nil || n != 9 { // 7 + the dependency end + the team row (no type filter)
		t.Fatalf("count = %d, %v; want 9", n, err)
	}
	f.Type = "deliverable"
	if n, _ := store.AuditCount(ctx, e.DB, f); n != 7 {
		t.Errorf("with type filter count = %d, want 7", n)
	}
	f.Type, f.Limit = "", 4
	p1, _ := store.AuditList(ctx, e.DB, f)
	f.Offset = 4
	p2, _ := store.AuditList(ctx, e.DB, f)
	f.Offset = 8
	p3, _ := store.AuditList(ctx, e.DB, f)
	f.Offset = 20
	p4, _ := store.AuditList(ctx, e.DB, f)
	if len(p1) != 4 || len(p2) != 4 || len(p3) != 1 || len(p4) != 0 {
		t.Fatalf("pages %d %d %d %d, want 4 4 1 0", len(p1), len(p2), len(p3), len(p4))
	}
	seen := map[int64]bool{}
	for _, p := range [][]store.AuditEntry{p1, p2, p3} {
		for _, en := range p {
			if seen[en.ID] {
				t.Errorf("row %d on two pages", en.ID)
			}
			seen[en.ID] = true
		}
	}
	if p1[0].ID < p1[1].ID {
		t.Error("not newest first")
	}
	// keyset paging (the CSV export) works with the filter too
	f = store.AuditFilter{Deliverable: "ÄRGER", Limit: 5, BeforeID: p1[0].ID}
	if got, _ := store.AuditList(ctx, e.DB, f); len(got) != 5 || got[0].ID >= p1[0].ID {
		t.Errorf("keyset page: %d rows", len(got))
	}
	if n, _ := store.AuditCount(ctx, e.DB, store.AuditFilter{Deliverable: "nomatch"}); n != 0 {
		t.Errorf("no-match count = %d", n)
	}

	// a milestone's name matches; "from"/"to" only on a dependency entry (finding #29 kept these semantics
	// when the filter moved into SQL)
	add("milestone", `{"milestone":"Ärgerlich gate"}`)
	add("team", `{"from":"ärger team","to":"ärger"}`)
	if n, _ := store.AuditCount(ctx, e.DB, store.AuditFilter{Deliverable: "ärger"}); n != 10 {
		t.Errorf("count with a milestone and a non-dependency from/to = %d, want 10", n)
	}
	// the filter is one SQL condition, so keyset pages walk every match exactly once (the CSV export)
	f = store.AuditFilter{Deliverable: "äRGER", Limit: 3}
	var walked int
	for page, _ := store.AuditList(ctx, e.DB, f); len(page) > 0; page, _ = store.AuditList(ctx, e.DB, f) {
		walked += len(page)
		f.BeforeID = page[len(page)-1].ID
	}
	if walked != 10 {
		t.Errorf("keyset walk saw %d rows, want 10", walked)
	}
}
