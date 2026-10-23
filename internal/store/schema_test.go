package store_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_DAT_001_first_start_applies_schema_to_an_empty_db: a brand-new, completely empty SQLite
// file — no tables at all — gets the whole of schema.sql applied by a single store.Converge call,
// the same call the app makes on every start (REQ_DAT_001).
func Test_REQ_DAT_001_REQ_DAT_003_first_start_applies_schema_to_an_empty_db(t *testing.T) {
	t.Run("all tables exist", func(t *testing.T) {
		e := testutil.NewEnv(t)
		for _, tab := range []string{"teams", "roadmaps", "workstreams", "deliverables", "deliverable_workstreams",
			"deliverable_icons", "roadmap_item_links", "icon_labels", "dependencies", "milestones", "users",
			"sessions", "audit_log", "company_workstream_order", "meta"} {
			var n int
			if err := e.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, tab).Scan(&n); err != nil || n != 1 {
				t.Errorf("table %s missing (%v)", tab, err)
			}
		}
	})

	e := testutil.NewEnv(t)
	db := e.OpenDB(filepath.Join(e.Root, "empty.db"))
	var before int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before != 0 {
		t.Fatalf("fixture not empty: %d tables already present", before)
	}
	if err := store.Converge(db, testutil.ReadSchema(t, "schema.sql")); err != nil {
		t.Fatal(err)
	}
	for _, tab := range []string{"teams", "roadmaps", "workstreams", "deliverables", "deliverable_workstreams",
		"deliverable_icons", "roadmap_item_links", "icon_labels", "dependencies", "milestones", "users",
		"sessions", "audit_log", "company_workstream_order", "meta"} {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, tab).Scan(&n); err != nil || n != 1 {
			t.Errorf("table %s missing after applying schema.sql to an empty db (%v)", tab, err)
		}
	}

}

func Test_REQ_DAT_004_team_name_tag_color_rules(t *testing.T) {
	e := testutil.NewEnv(t)
	team := e.Team(testutil.TeamOpts{})
	ins := func(name, tag, color string) error {
		_, err := e.DB.Exec(`INSERT INTO teams(name,tag,default_color) VALUES (?,?,?)`, name, tag, color)
		return err
	}
	name, tag := team.Name, team.Tag
	if ins(strings.ToUpper(name), "ZZ", "#ffffff") == nil {
		t.Error("name must be unique ignoring case")
	}
	if ins("Other", strings.ToLower(tag), "#ffffff") == nil {
		t.Error("tag must be unique ignoring case")
	}
	for _, bad := range []string{"A", "ABCDE", "ab", "A1"} {
		if ins("n-"+bad, bad, "#ffffff") == nil {
			t.Errorf("tag %q accepted", bad)
		}
	}
	for _, bad := range []string{"red", "#fff", "#gggggg"} {
		if ins("c-"+bad, "QQ", bad) == nil {
			t.Errorf("color %q accepted", bad)
		}
	}
	if err := ins("Fine", "QQ", "#A1b2C3"); err != nil {
		t.Errorf("valid team rejected: %v", err)
	}
}

// Test_REQ_DAT_032_one_roadmap_per_team (hard rule): the database refuses a second roadmap for a team;
// TeamCreate makes the team's one roadmap (titled with its name, one "General" workstream) in the same
// step, and TeamDelete removes it with the team.
func Test_REQ_DAT_032_one_roadmap_per_team(t *testing.T) {
	e := testutil.NewEnv(t)
	ctx := context.Background()
	name, tag := "Payments", "PAY"
	team, err := store.TeamCreate(ctx, e.DB, store.TeamInput{Name: &name, Tag: &tag})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	var title, ws string
	if err := e.DB.QueryRow(`SELECT COUNT(*), MAX(r.title), MAX(w.name) FROM roadmaps r JOIN workstreams w ON w.roadmap_id=r.id WHERE r.team_id=?`, team.ID).
		Scan(&n, &title, &ws); err != nil {
		t.Fatal(err)
	}
	if n != 1 || title != name || ws != "General" || team.RoadmapID == 0 {
		t.Fatalf("team create: %d roadmap/workstream rows, title %q, workstream %q, roadmap_id %d", n, title, ws, team.RoadmapID)
	}
	if _, err := e.DB.Exec(`INSERT INTO roadmaps(team_id, title) VALUES (?, 'Second')`, team.ID); err == nil {
		t.Error("a second roadmap for one team was accepted by the database")
	}
	if _, _, err := store.TeamDelete(ctx, e.DB, team.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM roadmaps) + (SELECT COUNT(*) FROM workstreams)`).Scan(&n); err != nil || n != 0 {
		t.Errorf("after the team delete %d roadmap/workstream rows remain (%v)", n, err)
	}
}

// Test_REQ_DAT_007_one_dependency_table_unique_and_deleting_either_end_deletes_the_edge: every edge is one
// row of dependencies, whatever the kinds of its ends; the pair is unique; deleting either end through the
// store takes the edge with it, for all four kind combinations.
func Test_REQ_DAT_007_one_dependency_table_unique_and_deleting_either_end_deletes_the_edge(t *testing.T) {
	ctx := context.Background()
	count := func(e *testutil.Env) (n int) {
		if err := e.DB.QueryRow(`SELECT count(*) FROM dependencies`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return
	}
	for _, fk := range []string{"deliverable", "milestone"} {
		for _, tk := range []string{"deliverable", "milestone"} {
			for _, deleteFrom := range []bool{true, false} {
				t.Run(fmt.Sprintf("%s_to_%s_delete_from_end_%v", fk, tk, deleteFrom), func(t *testing.T) {
					e := testutil.NewEnv(t)
					rm := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
					mk := func(kind string, day int) (int64, func() error) {
						if kind == "milestone" {
							m := e.Milestone(rm, testutil.MilestoneOpts{Day: day})
							return m.ID, func() error { _, _, _, _, err := store.MilestoneDelete(ctx, e.DB, m.ID); return err }
						}
						d := e.Deliverable(rm, testutil.DeliverableOpts{StartDay: day, EndDay: day + 2})
						return d.ID, func() error { _, _, _, _, err := store.DeliverableDelete(ctx, e.DB, d.ID); return err }
					}
					fromID, delFrom := mk(fk, 0)
					toID, delTo := mk(tk, 10)
					e.ItemDependency(fk, fromID, tk, toID)
					if n := count(e); n != 1 {
						t.Fatalf("%d rows after adding, want 1", n)
					}
					if _, err := e.DB.Exec(`INSERT INTO dependencies(from_kind,from_id,to_kind,to_id) VALUES (?,?,?,?)`, fk, fromID, tk, toID); err == nil {
						t.Error("duplicate pair accepted")
					}
					del := delTo
					if deleteFrom {
						del = delFrom
					}
					if err := del(); err != nil {
						t.Fatal(err)
					}
					if n := count(e); n != 0 {
						t.Errorf("%d dependency rows survived deleting an end", n)
					}
				})
			}
		}
	}
}

// Test_REQ_CFG_003_sqlite_dsn_handles_special_characters_in_db_path: db_path (REQ_CFG_003) can be
// any valid filename, including one containing '?', '#' or '%' — none of that may corrupt the
// SQLite "file:" URI DSN. Open must open exactly that file, and a normal read/write round trip must
// work.
func Test_REQ_CFG_003_sqlite_dsn_handles_special_characters_in_db_path(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "weird?name#100%.db")
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.Converge(db, testutil.ReadSchema(t, "schema.sql")); err != nil {
		t.Fatal(err)
	}
	name, tag := "Weird Path Team", "WPT"
	if _, err := store.TeamCreate(context.Background(), db, store.TeamInput{Name: &name, Tag: &tag}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM teams WHERE tag='WPT'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("row not found through the DSN-escaped path: n=%d err=%v", n, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the database file was not created at the exact requested path: %v", err)
	}
}
