package main

// Phase 8 command line: -version (REQ_DEPLOY_010) and -dev-data [--reset] (REQ_DEMO_016-018).

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// REQ_DEPLOY_010: -version prints what the Makefile's -ldflags stamped in, and exits 0 without a config.
func Test_REQ_DEPLOY_010_version_flag_is_stamped_by_ldflags(t *testing.T) {
	t.Run("startup logs version", func(t *testing.T) {
		restoreLogger(t)
		dir := t.TempDir()
		conf := filepath.Join(dir, "overlens.conf")
		os.WriteFile(conf, []byte("bootstrap_admin_user: a\nbootstrap_admin_password: b\nport: "+fmt.Sprint(pickFreePort(t))+"\nbackup_enabled: false\n"+
			fmt.Sprintf("db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", filepath.Join(dir, "d", "r.db"), filepath.Join(dir, "logs"), filepath.Join(dir, "b"))), 0o600)
		ctx, cancel := context.WithCancel(context.Background())
		cancel() // start, log, and shut down at once
		run(ctx, conf, testEnv(nil), os.Stderr)
		b, _ := os.ReadFile(filepath.Join(dir, "logs", "test-app.log"))
		if !strings.Contains(string(b), "starting") || !strings.Contains(string(b), "version=dev") ||
			!strings.Contains(string(b), "build_time=") || !strings.Contains(string(b), "commit=") {
			t.Errorf("log lacks the version line:\n%s", b)
		}
	})

	root := testutil.RepoRoot(t)
	bin := filepath.Join(t.TempDir(), "overlens-v")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-ldflags", "-X main.version=1.2.3 -X main.buildTime=2026-10-04T10:00:00Z -X main.commit=abc1234",
		"-o", bin, "./cmd/overlens")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	out, err := exec.CommandContext(ctx, bin, "-version").CombinedOutput()
	if err != nil {
		t.Fatalf("-version: %v\n%s", err, out)
	}
	for _, want := range []string{"1.2.3", "2026-10-04T10:00:00Z", "abc1234"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("-version output lacks %q: %s", want, out)
		}
	}
	// without ldflags the defaults say so
	if got := versionLine(); !strings.Contains(got, "dev") || !strings.Contains(got, "unknown") {
		t.Errorf("unstamped version line %q", got)
	}

}

// ---- -dev-data ---------------------------------------------------------------------------------------

const devFixture = `{
  "format": "e-roadmaps/company", "dates": "relative", "anchor": "2026-01-05",
  "team_order": ["Beta", "Alpha"], "workstream_order": ["Core"],
  "teams": [
    {"team": {"name": "Alpha", "tag": "ALP", "default_color": "#3366cc"},
     "roadmap": {"title": "Alpha plan", "workstreams": [{"name": "Core"}],
       "deliverables": [{"key": "a", "name": "A", "start_date": 0, "end_date": 10, "workstreams": [{"name": "Core", "row": 0}]}],
       "milestones": [], "dependencies": []}},
    {"team": {"name": "Beta", "tag": "BET", "default_color": "#22aa66"},
     "roadmap": {"title": "Beta plan", "workstreams": [{"name": "Core"}],
       "deliverables": [{"key": "b", "name": "B", "start_date": 20, "end_date": 30, "workstreams": [{"name": "Core", "row": 0}]}],
       "milestones": [{"key": "m", "name": "M", "date": 40, "workstream": "Core", "row": 0}],
       "dependencies": [{"from": {"external": {"team": "Alpha", "name": "A"}}, "to": "b"}]}}
  ]}`

type devRig struct {
	t                 *testing.T
	dir, conf, dbPath string
	file              string
	stdout, stderr    bytes.Buffer
}

// newDevRig writes a development config (environment: development, sample_data: false) and the fixture
// file in a scratch folder, and lets the dev-data command ignore that folder being a scratch folder (every
// test lives in one); the refusal test for scratch paths puts the real check back.
func newDevRig(t *testing.T, conf string) *devRig {
	t.Helper()
	restoreLogger(t)
	prev := devDataScratch
	devDataScratch = func(string, func(string) string) bool { return false }
	t.Cleanup(func() { devDataScratch = prev })
	dir := t.TempDir()
	r := &devRig{t: t, dir: dir, dbPath: filepath.Join(dir, "data", "dev.db"), conf: filepath.Join(dir, "overlens.conf"), file: filepath.Join(dir, "company.json")}
	body := "bootstrap_admin_user: a\nbootstrap_admin_password: b\nenvironment: development\nsample_data: false\nbackup_enabled: false\n" +
		fmt.Sprintf("db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", r.dbPath, filepath.Join(dir, "logs"), filepath.Join(dir, "backups")) + conf
	os.WriteFile(r.conf, []byte(body), 0o600)
	os.WriteFile(r.file, []byte(devFixture), 0o600)
	return r
}

func (r *devRig) run(reset bool, stdin string, env map[string]string) int {
	r.t.Helper()
	r.stdout.Reset()
	r.stderr.Reset()
	return runDevData(context.Background(), r.conf, r.file, reset, testEnv(env), strings.NewReader(stdin), &r.stdout, &r.stderr)
}

func (r *devRig) db() *sql.DB {
	r.t.Helper()
	db, err := store.Open(r.dbPath)
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { db.Close() })
	return db
}

func (r *devRig) n(table string) int {
	r.t.Helper()
	var n int
	if err := r.db().QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		r.t.Fatal(err)
	}
	return n
}

func Test_REQ_DEMO_018_loads_the_company_into_an_empty_development_database(t *testing.T) {
	r := newDevRig(t, "")
	if code := r.run(false, "", nil); code != 0 {
		t.Fatalf("exit %d: %s", code, r.stderr.String())
	}
	if r.n("teams") != 2 || r.n("deliverables") != 2 || r.n("milestones") != 1 || r.n("dependencies") != 1 || r.n("company_team_order") != 2 {
		t.Errorf("loaded: teams %d deliverables %d", r.n("teams"), r.n("deliverables"))
	}
	if !strings.Contains(r.stdout.String(), "Loaded 2 teams") {
		t.Errorf("stdout: %s", r.stdout.String())
	}
}

func Test_REQ_DEMO_018_refuses_unless_environment_is_development(t *testing.T) {
	t.Run("refuses a database under the test scratch folder", func(t *testing.T) {
		r := newDevRig(t, "")
		prevScratch := devDataScratch
		devDataScratch = isScratchPath // the real check
		t.Cleanup(func() { devDataScratch = prevScratch })
		// 1. under $ERM_RUN_DIR (what `make test` sets)
		if code := r.run(false, "", map[string]string{"ERM_RUN_DIR": r.dir}); code != 1 || !strings.Contains(r.stderr.String(), "scratch") {
			t.Fatalf("ERM_RUN_DIR: exit %d, stderr %q", code, r.stderr.String())
		}
		// 2. inside any erm-test-* folder
		scratch := filepath.Join(r.dir, "erm-test-123")
		os.MkdirAll(scratch, 0o755)
		os.WriteFile(r.conf, []byte(strings.Replace(mustRead(t, r.conf), r.dbPath, filepath.Join(scratch, "dev.db"), 1)), 0o600)
		if code := r.run(false, "", nil); code != 1 || !strings.Contains(r.stderr.String(), "scratch") {
			t.Fatalf("erm-test-*: exit %d, stderr %q", code, r.stderr.String())
		}
		if _, err := os.Stat(filepath.Join(scratch, "dev.db")); err == nil {
			t.Error("a refused load created the database")
		}
		// a plain path is fine for the real check (not under r.dir: `make test` puts that inside an erm-run-* folder)
		if isScratchPath(filepath.Join("/srv", "roadmap", "data", "dev.db"), testEnv(nil)) {
			t.Error("an ordinary path was taken for a scratch path")
		}
	})

	t.Run("refuses a database that already has a team", func(t *testing.T) {
		r := newDevRig(t, "")
		if code := r.run(false, "", nil); code != 0 {
			t.Fatal(r.stderr.String())
		}
		before := r.n("deliverables")
		if code := r.run(false, "", nil); code != 1 || !strings.Contains(r.stderr.String(), "already has 2 team") || !strings.Contains(r.stderr.String(), "--reset") {
			t.Fatalf("second load: exit %d, stderr %q", code, r.stderr.String())
		}
		if r.n("deliverables") != before || r.n("teams") != 2 {
			t.Error("a refused load changed the data")
		}
		// a hand-made team counts, too
		r2 := newDevRig(t, "")
		os.MkdirAll(filepath.Dir(r2.dbPath), 0o755)
		db := r2.db()
		store.Converge(db, mustRead(t, filepath.Join(testutil.RepoRoot(t), "schema.sql")))
		name, tag := "Mine", "MIN"
		if _, err := store.TeamCreate(context.Background(), db, store.TeamInput{Name: &name, Tag: &tag}); err != nil {
			t.Fatal(err)
		}
		if code := r2.run(false, "", nil); code != 1 {
			t.Fatalf("exit %d", code)
		}
	})

	r := newDevRig(t, "")
	os.WriteFile(r.conf, []byte(strings.Replace(mustRead(t, r.conf), "environment: development", "environment: production", 1)), 0o600)
	if code := r.run(false, "", nil); code != 1 || !strings.Contains(r.stderr.String(), "refused") || !strings.Contains(r.stderr.String(), "development") {
		t.Fatalf("production: exit %d, stderr %q", code, r.stderr.String())
	}
	// the default (key absent) is production, too
	os.WriteFile(r.conf, []byte(strings.Replace(mustRead(t, r.conf), "environment: production\n", "", 1)), 0o600)
	if code := r.run(false, "", nil); code != 1 {
		t.Fatalf("default environment: exit %d", code)
	}
	// the environment variable overrides the file
	os.WriteFile(r.conf, []byte(strings.Replace(mustRead(t, r.conf), "sample_data: false", "environment: production\nsample_data: false", 1)), 0o600)
	if code := r.run(false, "", map[string]string{"OVERLENS_ENVIRONMENT": "development"}); code != 0 {
		t.Fatalf("env override: exit %d %s", code, r.stderr.String())
	}

}

func Test_REQ_DEMO_018_reset_prints_what_it_deletes_and_waits_for_yes(t *testing.T) {
	t.Run("a broken file does not wipe", func(t *testing.T) {
		r := newDevRig(t, "")
		if code := r.run(false, "", nil); code != 0 {
			t.Fatal(r.stderr.String())
		}
		os.WriteFile(r.file, []byte(`{"format": "nope"}`), 0o600)
		if code := r.run(true, "yes\n", nil); code != 1 || r.n("teams") != 2 {
			t.Fatalf("not a company file: exit %d teams %d", code, r.n("teams"))
		}
		// parses, but breaks a rule (found only by the importer): rolled back, the old data is still there
		os.WriteFile(r.file, []byte(strings.Replace(devFixture, `"end_date": 10`, `"end_date": -10`, 1)), 0o600)
		if code := r.run(true, "yes\n", nil); code != 1 || r.n("teams") != 2 || r.n("deliverables") != 2 {
			t.Fatalf("invalid file: exit %d teams %d deliverables %d, stderr %q", code, r.n("teams"), r.n("deliverables"), r.stderr.String())
		}
		if code := r.run(true, "yes\n", map[string]string{}); code != 1 {
			t.Fatal("still invalid")
		}
		os.WriteFile(r.file, []byte("not json"), 0o600)
		if code := r.run(false, "", nil); code != 1 {
			t.Fatalf("not json: exit %d", code)
		}
		if code := (func() int { r.file = filepath.Join(r.dir, "missing.json"); return r.run(false, "", nil) })(); code != 1 {
			t.Fatalf("missing file: exit %d", code)
		}
	})

	r := newDevRig(t, "")
	if code := r.run(false, "", nil); code != 0 {
		t.Fatal(r.stderr.String())
	}
	// users survive; seed one
	if _, err := r.db().Exec(`INSERT INTO users(username, password_hash) VALUES ('dev','x')`); err != nil {
		t.Fatal(err)
	}
	r.db().Exec(`INSERT INTO audit_log(action) VALUES ('x')`)

	for _, answer := range []string{"", "no\n", "y\n", "YES\n", "yes please\n"} {
		if code := r.run(true, answer, nil); code != 1 || !strings.Contains(r.stderr.String(), "nothing was deleted") {
			t.Fatalf("answer %q: exit %d, stderr %q", answer, code, r.stderr.String())
		}
		if r.n("teams") != 2 || r.n("deliverables") != 2 {
			t.Fatalf("answer %q deleted data", answer)
		}
	}
	out := r.stdout.String()
	for _, want := range []string{"2 teams", "2 roadmaps", "2 deliverables", "1 milestones", "1 dependencies", "Type yes"} {
		if !strings.Contains(strings.Join(strings.Fields(out), " "), want) {
			t.Errorf("the prompt lacks %q:\n%s", want, out)
		}
	}
	if code := r.run(true, "yes\n", nil); code != 0 {
		t.Fatalf("yes: exit %d, stderr %q", code, r.stderr.String())
	}
	if r.n("teams") != 2 || r.n("deliverables") != 2 || r.n("audit_log") != 0 || r.n("users") != 1 {
		t.Errorf("after reset: teams %d deliverables %d audit %d users %d", r.n("teams"), r.n("deliverables"), r.n("audit_log"), r.n("users"))
	}

}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// REQ_DEPLOY_010 / REQ_DEPLOY_015: `make version` is the release tag without its v (git describe after it, -dirty with
// uncommitted changes), and the VERSION file where there is no tag or no git; the VERSION file is a SemVer version.
func Test_REQ_DEPLOY_010_make_version_is_the_tag_or_the_VERSION_file(t *testing.T) {
	root := testutil.RepoRoot(t)
	v, err := os.ReadFile(filepath.Join(root, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	file := strings.TrimSpace(string(v))
	if !regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`).MatchString(file) {
		t.Fatalf("VERSION %q is not a SemVer version", file)
	}
	makefile, err := os.ReadFile(filepath.Join(root, "Makefile"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "Makefile"), makefile, 0o644)
	os.WriteFile(filepath.Join(dir, "VERSION"), []byte("2.0.0-dev\n"), 0o644)
	run := func(name string, args ...string) string {
		t.Helper()
		cmd := exec.Command(name, args...)
		cmd.Dir = dir
		for _, e := range os.Environ() {
			if !strings.HasPrefix(e, "VERSION=") { // an inherited VERSION would win over the Makefile's ?=
				cmd.Env = append(cmd.Env, e)
			}
		}
		cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if got := run("make", "-s", "version"); got != "2.0.0-dev" {
		t.Errorf("no git: %q, want the VERSION file", got)
	}
	run("git", "init", "-q")
	run("git", "add", ".")
	run("git", "commit", "-q", "-m", "one")
	if got := run("make", "-s", "version"); got != "2.0.0-dev" {
		t.Errorf("no tag: %q, want the VERSION file", got)
	}
	run("git", "tag", "v2.0.0")
	if got := run("make", "-s", "version"); got != "2.0.0" {
		t.Errorf("on the tag: %q, want 2.0.0", got)
	}
	os.WriteFile(filepath.Join(dir, "x"), []byte("x"), 0o644)
	run("git", "add", "x")
	run("git", "commit", "-q", "-m", "two")
	if got := run("make", "-s", "version"); !regexp.MustCompile(`^2\.0\.0-1-g[0-9a-f]+$`).MatchString(got) {
		t.Errorf("after the tag: %q, want 2.0.0-1-g<hash>", got)
	}
	os.WriteFile(filepath.Join(dir, "x"), []byte("y"), 0o644)
	if got := run("make", "-s", "version"); !strings.HasSuffix(got, "-dirty") {
		t.Errorf("uncommitted changes: %q, want -dirty", got)
	}
}
