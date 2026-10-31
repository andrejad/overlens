package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/andrejad/overlens/internal/config"
	"github.com/andrejad/overlens/internal/testutil"
)

// REQ_DEPLOY_017: once the port is open and the backup scheduler has logged its next run, the program ends its start-up
// with an empty line and a framed message saying where to open it; after the first start also whom to log in as, never
// the password. It goes to the window (stdout), not the log file.
func Test_REQ_DEPLOY_017_start_ends_with_where_to_open_the_app(t *testing.T) {
	restoreLogger(t)
	dir := t.TempDir()
	port := pickFreePort(t)
	conf := filepath.Join(dir, "overlens.conf")
	os.WriteFile(conf, []byte(fmt.Sprintf("bootstrap_admin_user: admin\nbootstrap_admin_password: s3cret-pass\nport: %d\nsample_data: false\n"+
		"db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", port, filepath.Join(dir, "d", "r.db"), filepath.Join(dir, "logs"), filepath.Join(dir, "b"))), 0o600)

	start := func() string {
		t.Helper()
		r, w, _ := os.Pipe()
		old := os.Stdout
		os.Stdout = w
		var buf syncBuf
		copied := make(chan struct{})
		go func() { io.Copy(&buf, r); close(copied) }()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan int, 1)
		go func() { done <- run(ctx, conf, testEnv(nil), os.Stderr) }()
		// the message is only written after the scheduler's lines; wait for the port and then for the message
		for i := 0; i < 200; i++ {
			if res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port)); err == nil {
				res.Body.Close()
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		for i := 0; i < 200 && !strings.Contains(buf.String(), "Press Ctrl+C"); i++ {
			time.Sleep(25 * time.Millisecond)
		}
		cancel()
		if code := <-done; code != 0 {
			t.Errorf("run exited %d", code)
		}
		os.Stdout = old
		w.Close()
		<-copied
		return buf.String()
	}

	out := start()
	msg := strings.Index(out, "Overlens is running.")
	if msg < 0 {
		t.Fatalf("no start-up message:\n%s", out)
	}
	for _, before := range []string{"server listening", "backup: next run"} {
		if i := strings.Index(out, before); i < 0 || i > msg {
			t.Errorf("%q is not logged before the message", before)
		}
	}
	blockStart := strings.LastIndex(out[:msg], "\n\n") + 2
	block := out[blockStart:]
	if !strings.HasPrefix(block, "  +--") {
		t.Errorf("the message does not follow an empty line:\n%s", out[:msg+40])
	}
	end := strings.Index(block, "+\n\n") // the closing rule and its empty line
	if end < 0 {
		t.Fatalf("no closing frame:\n%s", block)
	}
	frame := block[:end]
	for _, want := range []string{fmt.Sprintf("http://localhost:%d", port), `log in as "admin"`, "overlens.conf", "Press Ctrl+C to stop Overlens."} {
		if !strings.Contains(frame, want) {
			t.Errorf("message lacks %q:\n%s", want, frame)
		}
	}
	if strings.Contains(out, "s3cret-pass") {
		t.Error("the password is shown")
	}
	logs, _ := os.ReadFile(filepath.Join(dir, "logs", "test-app.log"))
	if strings.Contains(string(logs), "Overlens is running") {
		t.Error("the message reached the log file")
	}
	// only start-up lines come before it: everything after the message is the shutdown and the /health requests
	for _, l := range strings.Split(strings.TrimSpace(out[blockStart+end+1:]), "\n") {
		if l != "" && !strings.Contains(l, "request") && !strings.Contains(l, "shutting down") && !strings.Contains(l, "stopped") &&
			!strings.Contains(l, "+--") && !strings.Contains(l, "|") {
			t.Errorf("a start-up line comes after the message: %q", l)
		}
	}

	// the next start: the admin exists, so the message says nothing about logging in
	if out := start(); !strings.Contains(out, "Overlens is running.") || strings.Contains(out, "log in as") {
		t.Errorf("second start message:\n%s", out)
	}
	// widths count characters: a first admin with a non-ASCII name keeps the right border in line
	lines := strings.Split(strings.Trim(startMessage(8080, "José"), "\n"), "\n")
	for _, l := range lines {
		if utf8.RuneCountInString(l) != utf8.RuneCountInString(lines[0]) {
			t.Errorf("line %q is not as wide as the frame %q", l, lines[0])
		}
	}
}

// syncBuf is a bytes.Buffer the copying goroutine writes while the test reads it.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// REQ_DEPLOY_016: the ready overlens.conf of the downloads loads and holds the chosen values.
func Test_REQ_DEPLOY_016_shipped_config_holds_the_chosen_values(t *testing.T) {
	path := filepath.Join(testutil.RepoRoot(t), "deploy", "overlens.conf")
	cfg, err := config.Load(path, func(string) string { return "" })
	if err != nil {
		t.Fatalf("deploy/overlens.conf does not load: %v", err)
	}
	dir := filepath.Dir(path)
	got := fmt.Sprintf("%s/%s %d %v %v %v %s %d %d %d %s %s %s", cfg.BootstrapAdminUser, cfg.BootstrapAdminPassword, cfg.Port, cfg.SampleData, cfg.MCPEnabled,
		cfg.BackupEnabled, cfg.BackupTime, cfg.BackupKeepDays, cfg.AuditRetentionDays, cfg.SessionTTLDays, cfg.LogLevel, cfg.Environment, cfg.CookieSecure)
	if want := "admin/admin 8080 true true true 04:00 10 365 365 INFO production auto"; got != want {
		t.Errorf("values\n got %s\nwant %s", got, want)
	}
	for p, want := range map[string]string{cfg.DBPath: "overlens-data/db/overlens-database.db", cfg.LogDir: "overlens-data/logs", cfg.BackupDir: "overlens-data/backups"} {
		if rel, _ := filepath.Rel(dir, p); filepath.ToSlash(rel) != want {
			t.Errorf("path %s, want %s beside the program", p, want)
		}
	}
}
