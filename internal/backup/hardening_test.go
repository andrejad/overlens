package backup_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// blockTempFile makes VACUUM INTO fail: a non-empty folder sits where the temp file must go.
func blockTempFile(t *testing.T, f *fixture, day string) {
	t.Helper()
	tmp := f.file(".roadmap-" + day + ".db.tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "blocker"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

// Test_REQ_AUD_014_failures_never_expose_server_paths: the audit details and the status message
// are short path-free sentences; the full error only goes to the log.
func Test_REQ_AUD_014_failures_never_expose_server_paths(t *testing.T) {
	t.Run("last message is cut on a character boundary", func(t *testing.T) {
		f := newFixture(t)
		s := f.svc()
		// 499 ASCII bytes, then a 3-byte character straddling the 500-byte limit
		s.SetLast(context.Background(), f.now, "failed", strings.Repeat("a", 499)+"€€€")
		st, _ := s.Status(context.Background())
		m := st.Last.Message
		if !utf8.ValidString(m) || len(m) > 500 || m != strings.Repeat("a", 499) {
			t.Errorf("message %d bytes, valid=%v", len(m), utf8.ValidString(m))
		}
		s.SetLast(context.Background(), f.now, "failed", strings.Repeat("é", 400))
		st, _ = s.Status(context.Background())
		if m := st.Last.Message; !utf8.ValidString(m) || len(m) != 500 {
			t.Errorf("two-byte characters: %d bytes valid=%v", len(m), utf8.ValidString(m))
		}
	})

	f := newFixture(t)
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	blockTempFile(t, f, "2030-03-15")
	s := f.svc()
	if s.Backup(context.Background()) {
		t.Fatal("backup should have failed")
	}
	root := filepath.Dir(f.dir)
	d := f.r.details["backup.fail"]
	raw, _ := json.Marshal(d)
	if d["error"] != "could not create the backup file" || d["file"] != "roadmap-2030-03-15.db" || strings.Contains(string(raw), root) {
		t.Errorf("audit details %s", raw)
	}
	st, err := s.Status(context.Background())
	if err != nil || st.Last == nil || st.Last.Message != "could not create the backup file" {
		t.Fatalf("status: %+v %v", st.Last, err)
	}
	if b, _ := json.Marshal(st); strings.Contains(string(b), root) || strings.Contains(string(b), f.dir) {
		t.Errorf("status exposes a path: %s", b)
	}

	// the folder itself cannot be created
	g := newFixture(t)
	blocker := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(blocker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	g.dir = filepath.Join(blocker, "sub")
	s2 := g.svc()
	s2.Backup(context.Background())
	d = g.r.details["backup.fail"]
	raw, _ = json.Marshal(d)
	if d["error"] != "could not create the backup folder" || strings.Contains(string(raw), filepath.Dir(blocker)) {
		t.Errorf("folder failure details %s", raw)
	}

}

// Test_REQ_AUD_012_names_with_an_invalid_date_are_never_listed_counted_or_deleted.
func Test_REQ_AUD_012_names_with_an_invalid_date_are_never_listed_counted_or_deleted(t *testing.T) {
	f := newFixture(t) // KeepDays 3, today 2030-03-15
	odd := []string{"roadmap-2099-99-99.db", "roadmap-2030-02-30.db", "roadmap-0000-00-00.db", "roadmap-2030-13-01.db"}
	for _, n := range append([]string{"roadmap-2030-03-10.db", "roadmap-2030-03-11.db", "roadmap-2030-03-12.db", "roadmap-2030-03-13.db"}, odd...) {
		f.touch(t, n)
	}
	s := f.svc()
	st, _ := s.Status(context.Background())
	if len(st.Items) != 4 {
		t.Fatalf("items %+v: names with an impossible date must not be listed", st.Items)
	}
	if !s.Backup(context.Background()) {
		t.Fatal("backup failed")
	}
	for _, n := range odd {
		if !f.exists(n) {
			t.Errorf("%s was touched", n)
		}
	}
	// 4 real + today = 5, keep 3: the two oldest real ones go. If the odd names counted, more would go.
	for gone, want := range map[string]bool{"roadmap-2030-03-10.db": false, "roadmap-2030-03-11.db": false, "roadmap-2030-03-12.db": true,
		"roadmap-2030-03-13.db": true, "roadmap-2030-03-15.db": true} {
		if f.exists(gone) != want {
			t.Errorf("%s exists=%v, want %v", gone, f.exists(gone), want)
		}
	}
}
