package store_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_DAT_002_converge_adds_columns_only: a database made from an older copy of schema.sql (one
// column removed) gains the column on Converge, and its existing rows are untouched.
func Test_REQ_DAT_002_converge_adds_columns_only(t *testing.T) {
	schema := testutil.ReadSchema(t, "schema.sql")
	const col = "description_html"
	start := strings.Index(schema, "CREATE TABLE IF NOT EXISTS milestones")
	if start < 0 {
		t.Fatal("milestones table not found in schema.sql")
	}
	end := start + strings.Index(schema[start:], "\n);")
	var kept []string
	removed := 0
	for _, line := range strings.Split(schema[start:end], "\n") {
		if strings.Contains(line, col) {
			removed++
			continue
		}
		kept = append(kept, line)
	}
	if removed != 1 {
		t.Fatalf("expected one %s line in the milestones table, found %d", col, removed)
	}
	old := schema[:start] + strings.Join(kept, "\n") + schema[end:]

	e := testutil.NewEnv(t)
	db := e.OpenDB(filepath.Join(e.Root, "old.db"))
	if _, err := db.Exec(old); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO teams(id,name,tag) VALUES (1,'Old Team','OT')`,
		`INSERT INTO roadmaps(id,team_id,title) VALUES (1,1,'Old Roadmap')`,
		`INSERT INTO workstreams(id,roadmap_id,name,position) VALUES (1,1,'Old WS',1)`,
		`INSERT INTO milestones(id,roadmap_id,workstream_id,name,date) VALUES (1,1,1,'Old M','2020-01-15')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	for i := 0; i < 2; i++ { // the second run must be a no-op
		if err := store.Converge(db, schema); err != nil {
			t.Fatal(err)
		}
	}
	var name, date, desc string
	if err := db.QueryRow(`SELECT name, date, `+col+` FROM milestones WHERE id=1`).Scan(&name, &date, &desc); err != nil {
		t.Fatal(err)
	}
	if name != "Old M" || date != "2020-01-15" || desc != "" {
		t.Errorf("row after converge: %q %q %q", name, date, desc)
	}
	var n int
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM teams)+(SELECT COUNT(*) FROM roadmaps)+(SELECT COUNT(*) FROM workstreams)+(SELECT COUNT(*) FROM milestones)`).Scan(&n); err != nil || n != 4 {
		t.Errorf("rows after converge: %d, %v", n, err)
	}
}
