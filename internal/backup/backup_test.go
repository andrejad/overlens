package backup_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/backup"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type rec struct {
	mu      sync.Mutex
	actions []string
	details map[string]map[string]any
}

func (r *rec) record(_ context.Context, action string, d map[string]any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.actions = append(r.actions, action)
	if r.details == nil {
		r.details = map[string]map[string]any{}
	}
	r.details[action] = d
	return nil
}

func (r *rec) count(action string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, a := range r.actions {
		if a == action {
			n++
		}
	}
	return n
}

type fixture struct {
	env *testutil.Env
	dir string
	r   *rec
	now time.Time
	o   backup.Options
}

func (f *fixture) svc() *backup.Service {
	o := f.o
	o.Dir = f.dir
	o.Now = func() time.Time { return f.now }
	o.Record = f.r.record
	return backup.New(f.env.DB, o)
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{env: testutil.NewEnv(t), dir: filepath.Join(t.TempDir(), "backups"), r: &rec{},
		now: time.Date(2030, 3, 15, 5, 0, 0, 0, time.Local)}
	f.o = backup.Options{Enabled: true, Time: "04:00", KeepDays: 3, RetentionDays: 30}
	return f
}

func (f *fixture) file(name string) string { return filepath.Join(f.dir, name) }

func (f *fixture) touch(t *testing.T, name string) {
	t.Helper()
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.file(name), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) exists(name string) bool {
	_, err := os.Stat(f.file(name))
	return err == nil
}

func (f *fixture) auditRow(t *testing.T, ts, action string) {
	t.Helper()
	if _, err := f.env.DB.Exec(`INSERT INTO audit_log(ts, username, action) VALUES (?, 'x', ?)`, ts, action); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) auditCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.env.DB.QueryRow(`SELECT COUNT(*) FROM audit_log`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// openCopy opens a backup file as its own database and counts its teams.
func openCopy(t *testing.T, path string) int {
	t.Helper()
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM teams`).Scan(&n); err != nil {
		t.Fatalf("backup is not a readable database: %v", err)
	}
	return n
}

func Test_REQ_AUD_010_REQ_AUD_011_backup_is_a_consistent_snapshot_renamed_into_place(t *testing.T) {
	t.Run("same day run overwrites that days file", func(t *testing.T) {
		f := newFixture(t)
		f.env.Team(testutil.TeamOpts{Name: "Alpha"})
		s := f.svc()
		s.Backup(context.Background())
		f.env.Team(testutil.TeamOpts{Name: "Beta"})
		s.Backup(context.Background())
		if got := openCopy(t, f.file("roadmap-2030-03-15.db")); got != 2 {
			t.Fatalf("second run did not replace the file: %d teams", got)
		}
		ents, _ := os.ReadDir(f.dir)
		if len(ents) != 1 {
			t.Fatalf("want exactly one file, got %v", ents)
		}
	})

	f := newFixture(t)
	f.dir = filepath.Join(filepath.Dir(f.dir), "we#ird?%dir") // odd characters must not confuse VACUUM INTO
	f.env.Team(testutil.TeamOpts{Name: "Alpha"})
	f.env.Team(testutil.TeamOpts{Name: "Beta"})
	if !f.svc().Backup(context.Background()) {
		t.Fatal("backup failed")
	}
	if got := openCopy(t, f.file("roadmap-2030-03-15.db")); got != 2 {
		t.Fatalf("backup has %d teams, want 2", got)
	}
	ents, _ := os.ReadDir(f.dir)
	if len(ents) != 1 {
		t.Fatalf("temp file left behind: %v", ents)
	}

}

func Test_REQ_AUD_012_prune_keeps_newest_n_and_only_matching_names(t *testing.T) {
	t.Run("future dated files do not rank as newest and are never deleted", func(t *testing.T) {
		f := newFixture(t) // KeepDays 3, today 2030-03-15
		for _, n := range []string{"roadmap-2030-03-11.db", "roadmap-2030-03-12.db", "roadmap-2030-03-13.db", "roadmap-2031-01-01.db", "roadmap-2031-01-02.db"} {
			f.touch(t, n)
		}
		if !f.svc().Backup(context.Background()) {
			t.Fatal("backup failed")
		}
		// ranked among the real ones: 15, 13, 12 stay; 11 goes. The future files are left alone.
		for n, want := range map[string]bool{"roadmap-2030-03-15.db": true, "roadmap-2030-03-13.db": true, "roadmap-2030-03-12.db": true,
			"roadmap-2030-03-11.db": false, "roadmap-2031-01-01.db": true, "roadmap-2031-01-02.db": true} {
			if f.exists(n) != want {
				t.Errorf("%s exists=%v, want %v", n, f.exists(n), want)
			}
		}
	})

	f := newFixture(t) // KeepDays 3
	for _, n := range []string{"roadmap-2030-03-10.db", "roadmap-2030-03-11.db", "roadmap-2030-03-12.db", "roadmap-2030-03-13.db",
		"roadmap-2030-03-01.db.bak", "roadmap-2030-3-1.db", "notes.txt", "my-roadmap-2030-03-01.db", "roadmap-2030-03-01.db-wal"} {
		f.touch(t, n)
	}
	if err := os.Mkdir(f.file("roadmap-2020-01-01.db"), 0o755); err != nil { // a folder is never touched
		t.Fatal(err)
	}
	if !f.svc().Backup(context.Background()) {
		t.Fatal("backup failed")
	}
	for _, gone := range []string{"roadmap-2030-03-10.db", "roadmap-2030-03-11.db"} {
		if f.exists(gone) {
			t.Errorf("%s should have been pruned", gone)
		}
	}
	for _, kept := range []string{"roadmap-2030-03-12.db", "roadmap-2030-03-13.db", "roadmap-2030-03-15.db",
		"roadmap-2030-03-01.db.bak", "roadmap-2030-3-1.db", "notes.txt", "my-roadmap-2030-03-01.db", "roadmap-2030-03-01.db-wal", "roadmap-2020-01-01.db"} {
		if !f.exists(kept) {
			t.Errorf("%s must not be touched", kept)
		}
	}
	if f.r.count("backup.create") != 1 || f.r.count("backup.prune") != 1 || f.r.count("backup.fail") != 0 {
		t.Fatalf("audit actions: %v", f.r.actions)
	}

}

func Test_REQ_AUD_012_REQ_AUD_014_failed_backup_prunes_nothing_and_audits_backup_fail(t *testing.T) {
	t.Run("unusable backup folder fails cleanly", func(t *testing.T) {
		f := newFixture(t)
		blocker := filepath.Join(t.TempDir(), "afile")
		if err := os.WriteFile(blocker, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		f.dir = filepath.Join(blocker, "sub")
		if f.svc().Backup(context.Background()) {
			t.Fatal("backup into an impossible folder must fail")
		}
		if f.r.count("backup.fail") != 1 {
			t.Fatalf("audit actions: %v", f.r.actions)
		}
	})

	f := newFixture(t) // KeepDays 3
	old := []string{"roadmap-2030-03-08.db", "roadmap-2030-03-09.db", "roadmap-2030-03-10.db", "roadmap-2030-03-11.db", "roadmap-2030-03-12.db"}
	for _, n := range old {
		f.touch(t, n)
	}
	// A non-empty folder where the temp file must go makes VACUUM INTO fail, even for root.
	tmp := f.file(".roadmap-2030-03-15.db.tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "blocker"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	f.auditRow(t, "2000-01-01 00:00:00", "old")
	s := f.svc()
	s.RunDaily(context.Background())
	for _, n := range old {
		if !f.exists(n) {
			t.Errorf("%s was deleted by a failed run", n)
		}
	}
	if f.r.count("backup.fail") != 1 || f.r.count("backup.create") != 0 || f.r.count("backup.prune") != 0 {
		t.Fatalf("audit actions: %v", f.r.actions)
	}
	if f.auditCount(t) != 1 || f.r.count("audit.purge") != 0 {
		t.Fatal("a failed backup must postpone the audit purge (REQ_AUD_004)")
	}
	st, err := s.Status(context.Background())
	if err != nil || st.Last == nil || st.Last.Result != "failed" || st.Last.Message == "" {
		t.Fatalf("status after failure: %+v %v", st.Last, err)
	}

}

func Test_REQ_AUD_013_REQ_AUD_009_catch_up_runs_once_when_todays_slot_was_missed(t *testing.T) {
	t.Run("scheduler stops when its context ends", func(t *testing.T) {
		f := newFixture(t)
		f.now = time.Date(2030, 3, 15, 3, 0, 0, 0, time.Local)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		s := f.svc()
		go func() { s.Run(ctx); close(done) }()
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("scheduler did not stop")
		}
	})

	f := newFixture(t) // now 05:00, scheduled 04:00
	s := f.svc()
	s.CatchUp(context.Background())
	if !f.exists("roadmap-2030-03-15.db") || f.r.count("backup.create") != 1 {
		t.Fatal("missed backup was not caught up")
	}
	s.CatchUp(context.Background()) // today's file exists now
	if f.r.count("backup.create") != 1 {
		t.Fatal("catch-up must run only once")
	}

	g := newFixture(t)
	g.now = time.Date(2030, 3, 15, 3, 0, 0, 0, time.Local) // before the slot
	g.svc().CatchUp(context.Background())
	if g.exists("roadmap-2030-03-15.db") {
		t.Fatal("no catch-up before today's scheduled time")
	}

}

func Test_REQ_AUD_009_next_run_is_the_next_local_backup_time(t *testing.T) {
	s := newFixture(t).svc()
	if got := s.NextRun(time.Date(2030, 3, 15, 3, 0, 0, 0, time.Local)); got.Day() != 15 || got.Hour() != 4 {
		t.Fatalf("before the slot: %v", got)
	}
	if got := s.NextRun(time.Date(2030, 3, 15, 4, 0, 0, 0, time.Local)); got.Day() != 16 || got.Hour() != 4 {
		t.Fatalf("at the slot: %v", got)
	}
	if got := s.NextRun(time.Date(2030, 3, 31, 23, 0, 0, 0, time.Local)); got.Month() != 4 || got.Day() != 1 {
		t.Fatalf("month end: %v", got)
	}
}

func Test_REQ_AUD_004_REQ_AUD_005_purge_runs_only_after_a_successful_backup(t *testing.T) {
	t.Run("retention zero keeps everything forever", func(t *testing.T) {
		f := newFixture(t)
		f.o.RetentionDays = 0
		f.auditRow(t, "2000-01-01 00:00:00", "old")
		f.svc().RunDaily(context.Background())
		if f.auditCount(t) != 1 || f.r.count("audit.purge") != 0 {
			t.Fatal("retention 0 must keep the audit log forever")
		}
	})

	t.Run("purge still runs when backups are off", func(t *testing.T) {
		f := newFixture(t)
		f.o.Enabled = false
		f.auditRow(t, "2000-01-01 00:00:00", "old")
		f.svc().RunDaily(context.Background())
		if f.auditCount(t) != 0 || f.exists("roadmap-2030-03-15.db") || f.r.count("backup.create") != 0 {
			t.Fatal("with backups off the purge runs and no backup is made")
		}
		// Caught up at start only when today's purge has not happened yet.
		f.auditRow(t, "2000-01-01 00:00:00", "old2")
		f.svc().CatchUp(context.Background())
		if f.auditCount(t) != 1 {
			t.Fatal("today's purge already ran, catch-up must not repeat it")
		}
	})

	f := newFixture(t) // retention 30 days, now 2030-03-15 05:00 local
	f.auditRow(t, "2000-01-01 00:00:00", "old")
	f.auditRow(t, "2030-03-14 12:00:00", "recent")
	f.svc().RunDaily(context.Background())
	var left []string
	rows, _ := f.env.DB.Query(`SELECT action FROM audit_log ORDER BY id`)
	for rows.Next() {
		var a string
		rows.Scan(&a)
		left = append(left, a)
	}
	rows.Close()
	if fmt.Sprint(left) != "[recent]" {
		t.Fatalf("rows left: %v", left)
	}
	if f.r.count("backup.create") != 1 || f.r.count("audit.purge") != 1 {
		t.Fatalf("audit actions: %v", f.r.actions)
	}

}

func Test_REQ_AUD_006_purge_logs_count_and_cutoff_in_one_audit_entry(t *testing.T) {
	f := newFixture(t)
	f.o.Enabled = false
	f.auditRow(t, "2000-01-01 00:00:00", "old")
	f.auditRow(t, "2000-01-02 00:00:00", "old")
	f.svc().Purge(context.Background())
	d := f.r.details["audit.purge"]
	if f.r.count("audit.purge") != 1 || d["deleted"] != int64(2) || d["cutoff"] == "" || d["retention_days"] != 30 {
		t.Fatalf("purge audit: %v %v", f.r.actions, d)
	}
}

func Test_REQ_AUD_004_purge_deletes_in_small_batches(t *testing.T) {
	f := newFixture(t)
	f.o.PurgeBatch = 2
	for i := 0; i < 7; i++ {
		f.auditRow(t, "2000-01-01 00:00:00", "old")
	}
	f.auditRow(t, "2030-03-14 00:00:00", "recent")
	f.svc().Purge(context.Background())
	if f.auditCount(t) != 1 || f.r.details["audit.purge"]["deleted"] != int64(7) {
		t.Fatalf("batched purge left %d rows, details %v", f.auditCount(t), f.r.details["audit.purge"])
	}
	for i := 0; i < 4; i++ { // an exact multiple of the batch size
		f.auditRow(t, "2000-01-01 00:00:00", "old")
	}
	f.svc().Purge(context.Background())
	if f.auditCount(t) != 1 {
		t.Fatal("batch-aligned purge left rows behind")
	}
}

func Test_REQ_AUD_015_status_reports_next_run_last_run_and_files_newest_first(t *testing.T) {
	f := newFixture(t)
	f.touch(t, "roadmap-2030-03-01.db")
	f.touch(t, "junk.db")
	s := f.svc()
	st, _ := s.Status(context.Background())
	if st.Last != nil || len(st.Items) != 1 || st.NextRun == nil || !st.Enabled || st.KeepDays != 3 || st.RetentionDays != 30 || st.BackupTime != "04:00" {
		t.Fatalf("fresh status: %+v", st)
	}
	s.Backup(context.Background())
	st, _ = s.Status(context.Background())
	if st.Last == nil || st.Last.Result != "ok" || len(st.Items) != 2 || st.Items[0].Date != "2030-03-15" || st.Items[0].SizeBytes == 0 {
		t.Fatalf("status after a backup: %+v", st)
	}
	f.o.Enabled = false
	if off, _ := f.svc().Status(context.Background()); off.NextRun != nil || off.Enabled {
		t.Fatal("next_run must be null when backups are off")
	}
}

// With one database connection a VACUUM INTO holds it, and requests wait for it instead of failing.
func Test_REQ_AUD_010_requests_wait_for_a_backup_instead_of_deadlocking(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 50; i++ {
		f.env.Team(testutil.TeamOpts{})
	}
	s := f.svc()
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	wg.Add(1)
	go func() { defer wg.Done(); s.Backup(context.Background()) }()
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var n int
			errs <- f.env.DB.QueryRow(`SELECT COUNT(*) FROM teams`).Scan(&n)
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("deadlock between backup and requests")
	}
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if !f.exists("roadmap-2030-03-15.db") {
		t.Fatal("backup missing")
	}
}
