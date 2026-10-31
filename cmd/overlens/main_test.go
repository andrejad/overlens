package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/testutil"
)

// restoreLogger captures the current slog default BEFORE the caller does anything that might
// replace it (e.g. calling run(), which calls logging.Setup) and restores it on cleanup — run() is
// called in-process by several tests below, and without this each leaves its own file-writing
// logger installed as the global default for whatever test happens to run next.
func restoreLogger(t *testing.T) {
	t.Helper()
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
}

// testEnv is the only environment the code under test sees: LOG_PREFIX plus what a test sets.
func testEnv(extra map[string]string) func(string) string {
	m := map[string]string{"LOG_PREFIX": "test"}
	for k, v := range extra {
		m[k] = v
	}
	return func(k string) string { return m[k] }
}

func buildBinary(t *testing.T, dir string) string {
	t.Helper()
	bin := filepath.Join(dir, "overlens-test")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", bin, filepath.Join(testutil.RepoRoot(t), "cmd", "overlens")).CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

// runChild runs the binary with a minimal explicit environment and a timeout.
func runChild(t *testing.T, bin, dir string, args ...string) (stderr string, err error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = []string{"LOG_PREFIX=test"}
	var buf bytes.Buffer
	cmd.Stderr = &buf
	err = cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("child timed out; stderr %q", buf.String())
	}
	return buf.String(), err
}

func Test_REQ_TEST_014_missing_bootstrap_admin_user_exits_nonzero(t *testing.T) {
	dir := t.TempDir()
	bin := buildBinary(t, dir)
	conf := filepath.Join(dir, "overlens.conf")
	os.WriteFile(conf, []byte("bootstrap_admin_password: pw-not-logged\n"), 0o600)

	stderr, err := runChild(t, bin, dir, "-config", conf)
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() == 0 {
		t.Fatalf("want non-zero exit, got %v", err)
	}
	if !strings.Contains(stderr, "ERROR") || !strings.Contains(stderr, "bootstrap_admin_user") {
		t.Errorf("stderr lacks ERROR line naming the key: %q", stderr)
	}
	// the config has no log_dir, so the default resolves beside the config file
	logb, err := os.ReadFile(filepath.Join(dir, "logs", "test-app.log"))
	if err != nil || !strings.Contains(string(logb), "level=ERROR") || !strings.Contains(string(logb), "bootstrap_admin_user") {
		t.Errorf("log lacks ERROR line: %v %q", err, logb)
	}
	if strings.Contains(string(logb)+stderr, "pw-not-logged") {
		t.Error("password leaked")
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); err == nil {
		t.Error("database directory created despite invalid config")
	}
}

// The parent's OVERLENS_* variables must not reach the app under test, in-process or as a child.
func Test_REQ_TEST_005_parent_environment_cannot_reach_tests(t *testing.T) {
	restoreLogger(t)
	trap := t.TempDir()
	for k, v := range map[string]string{
		"OVERLENS_DB_PATH": filepath.Join(trap, "trap", "real.db"), "OVERLENS_LOG_DIR": filepath.Join(trap, "traplogs"),
		"OVERLENS_BOOTSTRAP_ADMIN_USER": "trapuser", "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD": "trappw",
	} {
		t.Setenv(k, v)
	}
	dir := t.TempDir()
	conf := filepath.Join(dir, "overlens.conf")
	os.WriteFile(conf, []byte("port: 1\n"), 0o600) // both bootstrap keys missing: must fail

	var errb bytes.Buffer
	if code := run(context.Background(), conf, testEnv(nil), &errb); code != 1 || !strings.Contains(errb.String(), "bootstrap_admin_user") {
		t.Fatalf("in-process: code %d, stderr %q (parent bootstrap env leaked in?)", code, errb.String())
	}
	bin := buildBinary(t, dir)
	stderr, err := runChild(t, bin, dir, "-config", conf)
	if err == nil || !strings.Contains(stderr, "bootstrap_admin_user") {
		t.Fatalf("child: %v %q (parent bootstrap env leaked in?)", err, stderr)
	}
	for _, p := range []string{"trap", "traplogs"} {
		if _, err := os.Stat(filepath.Join(trap, p)); err == nil {
			t.Errorf("%s was created from the parent environment", p)
		}
	}
}

func Test_REQ_CFG_005_failure_log_goes_to_configured_log_dir_else_fallback(t *testing.T) {
	restoreLogger(t)
	dir := t.TempDir()
	logs := filepath.Join(dir, "custom-logs")
	conf := filepath.Join(dir, "overlens.conf")
	os.WriteFile(conf, []byte("log_dir: custom-logs\nport: abc\n"), 0o600)
	cwd, _ := os.Getwd()
	var errb bytes.Buffer
	if code := run(context.Background(), conf, testEnv(nil), &errb); code != 1 {
		t.Fatalf("code %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(logs, "test-app.log")); err != nil || !strings.Contains(string(b), "level=ERROR") {
		t.Errorf("configured log_dir lacks ERROR: %v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(cwd, "logs")); err == nil {
		t.Error("a cwd-relative ./logs was created")
	}

	// unreadable config: fallback beside the binary (a temp dir here)
	fb := filepath.Join(dir, "fallback")
	old := fallbackLogDir
	fallbackLogDir = func() string { return fb }
	defer func() { fallbackLogDir = old }()
	if code := run(context.Background(), filepath.Join(dir, "absent.conf"), testEnv(nil), &errb); code != 1 {
		t.Fatalf("code %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(fb, "test-app.log")); err != nil || !strings.Contains(string(b), "missing or unreadable") {
		t.Errorf("fallback lacks ERROR: %v %q", err, b)
	}
}

// Test_REQ_CFG_008_console_copy_and_request_id: logging is "also copied to the console" (REQ_CFG_008)
// — run() always logs to the real os.Stdout as that console copy, so this swaps it for a pipe for
// the duration of the test (restored via t.Cleanup and again explicitly, before reading it) and
// checks the request line — with its X-Request-Id — actually reaches it, not just the log file.
func Test_REQ_CFG_008_console_copy_and_request_id(t *testing.T) {
	restoreLogger(t)
	dir := t.TempDir()
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	conf := filepath.Join(dir, "overlens.conf")
	os.WriteFile(conf, []byte(fmt.Sprintf("bootstrap_admin_user: a\nbootstrap_admin_password: b\nport: %d\n"+
		"db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", port, filepath.Join(dir, "data", "r.db"),
		filepath.Join(dir, "logs"), filepath.Join(dir, "backups"))), 0o600)

	origStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = origStdout })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, conf, testEnv(nil), io.Discard) }()

	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	var got error
	for i := 0; i < 100; i++ {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			got = nil
			break
		}
		got = err
		time.Sleep(50 * time.Millisecond)
	}
	if got != nil {
		cancel()
		t.Fatal(got)
	}
	// /health is logged at DEBUG only (REQ_DEPLOY_009), so the request line comes from another path.
	if r2, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/teams", port)); err == nil {
		r2.Body.Close()
	}
	http.DefaultClient.CloseIdleConnections() // see startServer: a never-used spare connection delays Shutdown
	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("no graceful shutdown")
	}
	os.Stdout = origStdout
	w.Close()
	out, _ := io.ReadAll(r)
	if !strings.Contains(string(out), "path=/api/teams") || !strings.Contains(string(out), "request_id=") {
		t.Errorf("console (stdout) did not carry the request line with its request id:\n%s", out)
	}
}

// pickFreePort finds a free TCP port and closes the listener immediately before returning, since
// run() rebinds by port number, not by reusing an open listener; there is an inherent (tiny) race
// between that close and run()'s own bind. Callers retry with a fresh port on an early run() exit.
func pickFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func Test_REQ_API_019_health_and_graceful_shutdown(t *testing.T) {
	restoreLogger(t)
	dir := t.TempDir()

	var ctx context.Context
	var cancel context.CancelFunc
	var done chan int
	var resp *http.Response
	var err error
	var logDir string
	const attempts = 3
	for attempt := 1; attempt <= attempts; attempt++ {
		port := pickFreePort(t)
		conf := filepath.Join(dir, fmt.Sprintf("overlens-%d.conf", attempt))
		logDir = filepath.Join(dir, fmt.Sprintf("logs-%d", attempt))
		os.WriteFile(conf, []byte(fmt.Sprintf("bootstrap_admin_user: a\nbootstrap_admin_password: b\nport: %d\n"+
			"db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", port, filepath.Join(dir, fmt.Sprintf("data-%d", attempt), "r.db"),
			logDir, filepath.Join(dir, fmt.Sprintf("backups-%d", attempt)))), 0o600)

		ctx, cancel = context.WithCancel(context.Background())
		done = make(chan int, 1)
		go func() { done <- run(ctx, conf, testEnv(nil), os.Stderr) }()

		url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
		resp, err = nil, nil
		lostRace := false
		for i := 0; i < 100 && !lostRace; i++ {
			select {
			case <-done: // run() already exited — almost certainly lost the port race picking it; retry
				lostRace = true
				continue
			default:
			}
			if resp, err = http.Get(url); err == nil {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if resp != nil {
			break
		}
		cancel()
		if attempt < attempts {
			t.Logf("attempt %d: could not reach the server on port %d (lostRace=%v, err=%v) — retrying with a fresh port", attempt, port, lostRace, err)
		}
	}
	defer cancel()
	if resp == nil {
		t.Fatalf("could not reach /health after %d attempts: %v", attempts, err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `"status":"ok"`) {
		t.Errorf("health body %q", body)
	}
	if resp.StatusCode != 200 || resp.Header.Get("X-Request-Id") == "" {
		t.Errorf("status %d, request id %q", resp.StatusCode, resp.Header.Get("X-Request-Id"))
	}
	if r2, err := http.Get(strings.Replace(resp.Request.URL.String(), "/health", "/api/teams", 1)); err == nil {
		r2.Body.Close() // /health is logged at DEBUG only (REQ_DEPLOY_009): the request line comes from another path
	}
	http.DefaultClient.CloseIdleConnections() // see startServer: a never-used spare connection delays Shutdown
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("exit code %d", code)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no graceful shutdown")
	}
	logb, _ := os.ReadFile(filepath.Join(logDir, "test-app.log"))
	if !strings.Contains(string(logb), "path=/api/teams") || !strings.Contains(string(logb), "request_id=") {
		t.Errorf("request line with request_id missing:\n%s", logb)
	}
}
