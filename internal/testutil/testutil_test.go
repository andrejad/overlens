package testutil

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/logging"
)

func Test_REQ_TEST_006_guard_refuses_unsafe_paths(t *testing.T) {
	e := NewEnv(t)
	repo, _ := repoRoot()
	t.Setenv("ROADMAP_DB", filepath.Join(e.Root, "prod.db"))
	cases := map[string]string{
		"repo dev db":       filepath.Join(repo, "data", "roadmap-database.db"),
		"repo dev db (old)": filepath.Join(repo, "data", "roadmap.db"),
		"outside temp dir":  filepath.Join(os.TempDir(), "elsewhere.db"),
		"home":              filepath.Join(os.Getenv("HOME"), "roadmap.db"),
		"env-named prod db": filepath.Join(e.Root, "prod.db"),
		"traversal":         filepath.Join(e.Root, "..", "x.db"),
	}
	for name, p := range cases {
		if err := GuardDBPath(p, e.Root); err == nil {
			t.Errorf("%s: guard accepted %s", name, p)
		}
	}
	if err := GuardDBPath(filepath.Join(e.Root, "ok.db"), e.Root); err != nil {
		t.Errorf("guard refused a safe path: %v", err)
	}
	if err := GuardRoot(repo); err == nil {
		t.Error("guard accepted the repo as a scratch root")
	}
	if err := GuardRoot(os.TempDir()); err == nil {
		t.Error("guard accepted the bare temp dir as a scratch root")
	}
}

func Test_REQ_TEST_006_delete_outside_temp_dir_refused(t *testing.T) {
	e := NewEnv(t)
	outside, err := os.MkdirTemp("", "erm-outside-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	if err := SafeRemoveAll(e.Root, outside); err == nil {
		t.Error("SafeRemoveAll deleted outside its root")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Error("outside dir is gone")
	}
	if err := SafeRemoveAll(outside, outside); err == nil {
		t.Error("SafeRemoveAll accepted a root without the erm-test- prefix")
	}
}

func Test_REQ_TEST_005_fresh_db_per_test_built_from_schema(t *testing.T) {
	a, b := NewEnv(t), NewEnv(t)
	if a.Path == b.Path {
		t.Fatal("two envs share a database")
	}
	a.Team(TeamOpts{})
	var n int
	if err := b.DB.QueryRow(`SELECT COUNT(*) FROM teams`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("second db not empty: n=%d err=%v", n, err)
	}
	if err := GuardDBPath(a.Path, a.Root); err != nil {
		t.Fatal(err)
	}
}

// Test_REQ_TEST_008_log_prefix_is_test: LOG_PREFIX=test must actually reach the log FILE NAME (a
// bare app.log is the real file production logging writes), not just be set as an env var.
func Test_REQ_TEST_008_log_prefix_is_test(t *testing.T) {
	e := NewEnv(t)
	if got := os.Getenv("LOG_PREFIX"); got != "test" {
		t.Fatalf("LOG_PREFIX = %q", got)
	}
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	closeFn, err := logging.Setup(e.Root, os.Getenv("LOG_PREFIX"), "INFO", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeFn)
	slog.Info("probe")
	if _, err := os.Stat(filepath.Join(e.Root, "test-app.log")); err != nil {
		t.Errorf("expected test-app.log in %s: %v", e.Root, err)
	}
	if _, err := os.Stat(filepath.Join(e.Root, "app.log")); err == nil {
		t.Error("a bare app.log was created — LOG_PREFIX=test did not reach the log file name")
	}
}

func Test_REQ_TEST_016_builders_return_handles_with_defaults(t *testing.T) {
	e := NewEnv(t)
	tm := e.Team(TeamOpts{})
	r := e.Roadmap(tm, RoadmapOpts{})
	ws := e.Workstream(r, "")
	d := e.Deliverable(r, DeliverableOpts{})
	e2 := e.Team(TeamOpts{})
	if tm.ID == e2.ID || tm.Name == e2.Name || tm.Tag == e2.Tag {
		t.Error("defaults are not unique")
	}
	var name string
	if err := e.DB.QueryRow(`SELECT name FROM deliverables WHERE id=?`, d.ID).Scan(&name); err != nil || name != d.Name {
		t.Errorf("handle does not match row: %v %q", err, name)
	}
	if ws.ID == 0 {
		t.Error("workstream handle empty")
	}
}

func Test_REQ_TEST_019_REQ_TEST_017_builders_produce_valid_random_roadmaps(t *testing.T) {
	e := NewEnv(t)
	for i := 0; i < 20; i++ {
		r, ds := e.RandomRoadmap(e.Team(TeamOpts{}))
		checkValid(t, e, r, ds)
	}

	t.Run("dates are relative to controlled clock", func(t *testing.T) {
		e := NewEnv(t)
		r := e.Roadmap(e.Team(TeamOpts{}), RoadmapOpts{})
		d := e.Deliverable(r, DeliverableOpts{StartDay: 5, EndDay: 20})
		e.Clock.Advance(100)
		d2 := e.Deliverable(r, DeliverableOpts{StartDay: 5, EndDay: 20})
		s1, _ := time.Parse("2006-01-02", d.Start)
		s2, _ := time.Parse("2006-01-02", d2.Start)
		if got := s2.Sub(s1); got != 100*24*time.Hour {
			t.Errorf("advancing the clock shifted dates by %v, want 100 days", got)
		}
		// expected roadmap range derived from what was created, not a literal
		var rs, re string
		if err := e.DB.QueryRow(`SELECT range_start, range_end FROM roadmaps WHERE id=?`, r.ID).Scan(&rs, &re); err != nil {
			t.Fatal(err)
		}
		if rs != d.Start || re != d2.End {
			t.Errorf("range cache = %s..%s, want %s..%s", rs, re, d.Start, d2.End)
		}
	})
}

// checkValid asserts every invariant a builder-produced roadmap must satisfy (REQ_TEST_019): dates
// in range, every deliverable in at least one workstream of its own roadmap (REQ_DAT_012), the
// roadmap's derived range cache matching its actual earliest/latest deliverable (REQ_DAT_009), that
// range never spanning more than 3 years (REQ_DAT_015), and no dependency cycle.
func checkValid(t *testing.T, e *Env, r Roadmap, ds []Deliverable) {
	t.Helper()
	limit := e.Clock.Day(3*365 + 1)
	for _, d := range ds {
		s, _ := time.Parse("2006-01-02", d.Start)
		en, _ := time.Parse("2006-01-02", d.End)
		if en.Before(s) || s.Before(e.Clock.Day(0)) || en.After(limit) {
			t.Errorf("seed %d: %s dates out of range %s..%s", e.Seed, d.Name, d.Start, d.End)
		}
	}

	// REQ_DAT_012: every deliverable belongs to at least one workstream of its own roadmap.
	for _, d := range ds {
		var n int
		if err := e.DB.QueryRow(`SELECT COUNT(*) FROM deliverable_workstreams dw
		  JOIN workstreams w ON w.id=dw.workstream_id WHERE dw.deliverable_id=? AND w.roadmap_id=?`, d.ID, r.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Errorf("seed %d: deliverable %s has no workstream of its own roadmap", e.Seed, d.Name)
		}
	}

	// REQ_DAT_009: the roadmap's derived range cache is exactly its deliverables' earliest start and
	// latest end (no milestone is built by RandomRoadmap, so they don't enter this computation here —
	// Test_REQ_DAT_009_range_is_derived_on_create_delete_and_date_change in internal/api covers that half separately).
	if len(ds) > 0 {
		var wantS, wantE string
		if err := e.DB.QueryRow(`SELECT MIN(start_date), MAX(end_date) FROM deliverables WHERE roadmap_id=?`, r.ID).Scan(&wantS, &wantE); err != nil {
			t.Fatal(err)
		}
		var gotS, gotE string
		if err := e.DB.QueryRow(`SELECT range_start, range_end FROM roadmaps WHERE id=?`, r.ID).Scan(&gotS, &gotE); err != nil {
			t.Fatal(err)
		}
		if gotS != wantS || gotE != wantE {
			t.Errorf("seed %d: range cache %s..%s, want %s..%s", e.Seed, gotS, gotE, wantS, wantE)
		}
		// REQ_DAT_015 (hard rule): the stored span itself never exceeds 3 calendar years.
		var over int
		if err := e.DB.QueryRow(`SELECT COUNT(*) FROM roadmaps WHERE id=? AND date(range_end) > date(range_start, '+3 years')`, r.ID).Scan(&over); err != nil {
			t.Fatal(err)
		}
		if over != 0 {
			t.Errorf("seed %d: roadmap %d's stored range exceeds the 3-year cap (%s..%s)", e.Seed, r.ID, gotS, gotE)
		}
	}

	// deps: prerequisite must end before dependent starts; that also rules out cycles
	rows, err := e.DB.Query(`SELECT f.end_date, t.start_date FROM dependencies x
	  JOIN deliverables f ON f.id=x.from_id JOIN deliverables t ON t.id=x.to_id
	  WHERE x.from_kind='deliverable' AND x.to_kind='deliverable' AND f.roadmap_id=?`, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var fe, ts string
		if err := rows.Scan(&fe, &ts); err != nil {
			t.Fatal(err)
		}
		if fe >= ts {
			t.Errorf("seed %d: dependency violates order: prerequisite ends %s, dependent starts %s", e.Seed, fe, ts)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	// explicit cycle check on the stored graph
	adj := map[int64][]int64{}
	for _, d := range ds {
		g, err := e.DB.Query(`SELECT to_id FROM dependencies WHERE from_kind='deliverable' AND to_kind='deliverable' AND from_id=?`, d.ID)
		if err != nil {
			t.Fatal(err)
		}
		for g.Next() {
			var to int64
			if err := g.Scan(&to); err != nil {
				g.Close()
				t.Fatal(err)
			}
			adj[d.ID] = append(adj[d.ID], to)
		}
		if err := g.Err(); err != nil {
			g.Close()
			t.Fatal(err)
		}
		g.Close()
	}
	state := map[int64]int{}
	var visit func(int64) bool
	visit = func(n int64) bool {
		if state[n] == 1 {
			return false
		}
		if state[n] == 2 {
			return true
		}
		state[n] = 1
		for _, m := range adj[n] {
			if !visit(m) {
				return false
			}
		}
		state[n] = 2
		return true
	}
	for _, d := range ds {
		if !visit(d.ID) {
			t.Fatalf("seed %d: dependency cycle", e.Seed)
		}
	}
}

// Test_REQ_TEST_018_test_seed_replays_exactly proves TEST_SEED replay two ways: (1) two Envs built
// under the same TEST_SEED, from two differently-named subtests (so they don't even share an Env
// ordinal), derive different seeds and different roadmaps — envs never collide; (2) run as its own
// subprocess twice with the same TEST_SEED, the exact same roadmap (including absolute dates, which
// the clock now derives from the seed instead of real "today") comes out both times.
func Test_REQ_TEST_018_test_seed_replays_exactly(t *testing.T) {
	// Child mode: print this Env's derived seed, clock and roadmap, then stop — the parent (below)
	// runs this twice as a subprocess with the same TEST_SEED and diffs the two outputs.
	if os.Getenv("ERM_REPLAY_CHILD") == "1" {
		e := NewEnv(t)
		_, ds := e.RandomRoadmap(e.Team(TeamOpts{}))
		fmt.Println("ERM_REPLAY_SEED=" + strconv.FormatInt(e.Seed, 10))
		fmt.Println("ERM_REPLAY_TODAY=" + e.Clock.Date(0))
		for _, d := range ds {
			fmt.Printf("ERM_REPLAY_D=%s,%s\n", d.Start, d.End)
		}
		return
	}

	t.Setenv("TEST_SEED", "424242")
	shape := func(t *testing.T) []string {
		e := NewEnv(t)
		_, ds := e.RandomRoadmap(e.Team(TeamOpts{}))
		var out []string
		out = append(out, e.Clock.Date(0))
		for _, d := range ds {
			out = append(out, d.Start, d.End)
		}
		return out
	}
	var a, b []string
	t.Run("first", func(t *testing.T) { a = shape(t) })
	t.Run("second", func(t *testing.T) { b = shape(t) })
	if reflect.DeepEqual(a, b) {
		t.Errorf("two differently-named subtests under the same TEST_SEED produced identical Envs (seed derivation ignores the test name?): %v", a)
	}

	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	run := func() string {
		cmd := exec.Command("go", "test", "-run", "^Test_REQ_TEST_018_test_seed_replays_exactly$", "-v", "./internal/testutil")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "TEST_SEED=777777", "ERM_REPLAY_CHILD=1", "LOG_PREFIX=test")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("subprocess run failed: %v\n%s", err, out)
		}
		return string(out)
	}
	first, second := run(), run()
	extract := func(s string) string {
		re := regexp.MustCompile(`(?m)^ERM_REPLAY_.*$`)
		return strings.Join(re.FindAllString(s, -1), "\n")
	}
	if f, s := extract(first), extract(second); f == "" || f != s {
		t.Errorf("TEST_SEED=777777 did not replay exactly across two subprocess runs:\nrun 1:\n%s\nrun 2:\n%s", f, s)
	}
}
