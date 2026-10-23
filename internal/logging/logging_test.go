package logging

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A roll() that hits a persistent (non-ENOENT) stat error used to log that failure through slog —
// but roll runs inside dailyFile.Write with d.mu held, and slog's handler writes back through the
// same Write, so that call deadlocked the process. This drives the failure through Setup's real
// handler (not d.roll() directly) so a regression here reproduces the actual deadlock, with a
// timeout so it fails fast instead of hanging the whole test run.
func Test_REQ_CFG_008_roll_stat_error_through_the_real_handler_does_not_deadlock(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions, so this can't force a stat error")
	}
	dir := t.TempDir()
	// A stale app.log, dated yesterday, so the first write after Setup sees a day change and rolls.
	stale := filepath.Join(dir, "test-app.log")
	if err := os.WriteFile(stale, []byte("yesterday\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	yesterday := time.Now().Add(-24 * time.Hour)
	if err := os.Chtimes(stale, yesterday, yesterday); err != nil {
		t.Fatal(err)
	}

	// Captured BEFORE Setup, so cleanup restores the real pre-test default — not the file-writing
	// logger Setup is about to install (which, if a later assertion below ever hung, could otherwise
	// leak into every test that runs after this one).
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	t.Cleanup(func() { os.Chmod(dir, 0o755) }) // let TempDir clean up, even if the test fails

	closeFn, err := Setup(dir, "test", "INFO", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	// closeFn takes dailyFile's own mutex — the same one a reintroduced slog.Error inside roll()
	// would deadlock on while still holding it (see the comment on roll()). Cleanup must not wait on
	// that mutex forever: bound the wait so a regression here fails this test fast instead of hanging
	// the whole `go test` run at teardown.
	t.Cleanup(func() {
		done := make(chan struct{})
		go func() { closeFn(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Log("cleanup: closeFn did not return in time (a leaked goroutine is likely still holding the log mutex) — not waiting further")
		}
	})

	// Remove traverse permission on dir: os.Stat of any candidate rolled name inside it now fails
	// with a permission error, not ENOENT — the same non-ENOENT path the deadlock lived on.
	if err := os.Chmod(dir, 0o000); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		slog.Info("trigger the roll") // day changed since Setup: Write -> roll -> Stat fails -> must not deadlock
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("logging through the real handler deadlocked on a roll stat error")
	}

}

func Test_REQ_CFG_008_daily_file_rolls_at_midnight(t *testing.T) {
	t.Run("roll never overwrites a rolled file", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "2026-03-01-test-app.log"), []byte("earlier\n"), 0o644)
		now := time.Date(2026, 3, 1, 23, 59, 0, 0, time.Local)
		d := &dailyFile{dir: dir, prefix: "test-", now: func() time.Time { return now }}
		d.Write([]byte("later\n"))
		now = now.Add(2 * time.Minute)
		d.Write([]byte("next day\n"))
		d.f.Close()
		if b, _ := os.ReadFile(filepath.Join(dir, "2026-03-01-test-app.log")); string(b) != "earlier\n" {
			t.Errorf("existing rolled file overwritten: %q", b)
		}
		if b, _ := os.ReadFile(filepath.Join(dir, "2026-03-01-test-app.2.log")); string(b) != "later\n" {
			t.Errorf("rolled file lost: %q", b)
		}
	})
	t.Run("roll gives up on a persistent stat error", func(t *testing.T) {
		dir := t.TempDir()
		blocker := filepath.Join(dir, "blocker") // a plain file used as a directory: every Stat under it errors ENOTDIR
		if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		d := &dailyFile{dir: blocker, prefix: "test-", day: "2026-03-01"}
		done := make(chan struct{})
		go func() { d.roll(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("roll spun forever on a persistent stat error")
		}
	})

	dir := t.TempDir()
	now := time.Date(2026, 3, 1, 23, 59, 0, 0, time.Local)
	d := &dailyFile{dir: dir, prefix: "test-", now: func() time.Time { return now }}
	d.Write([]byte("day one\n"))
	now = now.Add(2 * time.Minute)
	d.Write([]byte("day two\n"))
	d.f.Close()
	old, err := os.ReadFile(filepath.Join(dir, "2026-03-01-test-app.log"))
	if err != nil || string(old) != "day one\n" {
		t.Fatalf("rolled file: %v %q", err, old)
	}
	cur, _ := os.ReadFile(filepath.Join(dir, "test-app.log"))
	if string(cur) != "day two\n" {
		t.Fatalf("current file %q", cur)
	}

}

// Test_REQ_CFG_009_body_summaries_only_at_debug: at INFO level, no body summary lines are written at
// all; the per-request line itself never carries a body either.
func Test_REQ_CFG_009_body_summaries_only_at_debug(t *testing.T) {
	t.Run("body summaries at debug are cut to 1000 chars", func(t *testing.T) {
		var buf bytes.Buffer
		prev := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
		t.Cleanup(func() { slog.SetDefault(prev) })

		longBody := `{"name":"` + strings.Repeat("x", 2000) + `"}`
		h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			if len(body) < 2000 {
				t.Errorf("handler must still see the FULL body, not the truncated log summary: got %d bytes", len(body))
			}
			w.Write([]byte(strings.Repeat("y", 2000)))
		}))
		req := httptest.NewRequest("POST", "/api/teams", strings.NewReader(longBody))
		h.ServeHTTP(httptest.NewRecorder(), req)

		out := buf.String()
		if !strings.Contains(out, "request body") || !strings.Contains(out, "response body") {
			t.Fatalf("no DEBUG body summary lines: %s", out)
		}
		if strings.Count(out, "x") > 1100 || strings.Count(out, "y") > 1100 {
			t.Errorf("body summary not cut to about 1000 characters: %d x's, %d y's", strings.Count(out, "x"), strings.Count(out, "y"))
		}
		if !strings.Contains(out, "truncated") {
			t.Errorf("no truncation marker in summary: %s", out)
		}
	})

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Write([]byte(`{"ok":true}`))
	}))
	req := httptest.NewRequest("POST", "/api/teams", strings.NewReader(`{"name":"secret-ish body content"}`))
	h.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if strings.Contains(out, "request body") || strings.Contains(out, "response body") {
		t.Errorf("body summaries logged below DEBUG level: %s", out)
	}
	if !strings.Contains(out, "\"request\"") && !strings.Contains(out, "request") {
		t.Fatalf("no request line at all: %s", out)
	}

}

// Test_REQ_CFG_008_x_request_id_client_value_validated: a client-supplied X-Request-Id is reused
// only if it's at most 64 characters of [A-Za-z0-9._-]; anything else is replaced with a generated
// id, so an attacker cannot inject arbitrary content (newlines, huge strings) into the log line via
// the header (REQ_CFG_008: "an X-Request-Id on every request line").
func Test_REQ_CFG_008_x_request_id_client_value_validated(t *testing.T) {
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	good := "abc-123.DEF_456"
	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-Request-Id", good)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got != good {
		t.Errorf("a valid client id should be reused: got %q, want %q", got, good)
	}

	for _, bad := range []string{strings.Repeat("a", 65), "has space", "semi;colon", "new\nline"} {
		req := httptest.NewRequest("GET", "/health", nil)
		req.Header.Set("X-Request-Id", bad)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("X-Request-Id"); got == bad {
			t.Errorf("invalid client id %q was reused instead of replaced", bad)
		}
	}
}
