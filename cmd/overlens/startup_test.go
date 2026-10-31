package main

// Phase 8 review fixes: -healthcheck (REQ_DEPLOY_009), a start with no config file (REQ_DEPLOY_011),
// and a server that starts although the sample is broken (REQ_DEMO_005).

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/demo"
)

// healthEnv is the settings a container would pass, for a given port.
func healthEnv(port int) map[string]string {
	return map[string]string{"OVERLENS_PORT": strconv.Itoa(port), "OVERLENS_BOOTSTRAP_ADMIN_USER": "a", "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD": "b"}
}

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// REQ_DEPLOY_009: exit 0 on 200 and nothing printed; 1 with one stderr line on anything else.
func Test_REQ_DEPLOY_009_healthcheck_exit_codes(t *testing.T) {
	t.Run("healthcheck flag in the binary", func(t *testing.T) {
		bin := buildBinary(t, t.TempDir())
		run := func(port int) (string, string, int) {
			var out, errb bytes.Buffer
			cmd := exec.Command(bin, "-healthcheck")
			cmd.Env = []string{"OVERLENS_PORT=" + strconv.Itoa(port), "OVERLENS_BOOTSTRAP_ADMIN_USER=a", "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD=b"}
			cmd.Stdout, cmd.Stderr = &out, &errb
			err := cmd.Run()
			code := 0
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else if err != nil {
				t.Fatal(err)
			}
			return out.String(), errb.String(), code
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"status":"ok"}`)) }))
		port := portOf(t, srv)
		if out, errs, code := run(port); code != 0 || out != "" || errs != "" {
			t.Errorf("healthy: exit %d, stdout %q, stderr %q", code, out, errs)
		}
		srv.Close()
		if out, errs, code := run(port); code != 1 || out != "" || errs == "" {
			t.Errorf("stopped: exit %d, stdout %q, stderr %q", code, out, errs)
		}
	})

	missing := filepath.Join(t.TempDir(), "no-such.conf") // also REQ_DEPLOY_011: no config file needed

	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" || r.Method != "GET" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer ok.Close()
	var stderr bytes.Buffer
	if code := healthcheck(context.Background(), missing, testEnv(healthEnv(portOf(t, ok))), &stderr); code != 0 || stderr.Len() != 0 {
		t.Fatalf("healthy: exit %d, stderr %q", code, stderr.String())
	}

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "database unreachable", http.StatusServiceUnavailable)
	}))
	defer down.Close()
	stderr.Reset()
	if code := healthcheck(context.Background(), missing, testEnv(healthEnv(portOf(t, down))), &stderr); code != 1 || !strings.Contains(stderr.String(), "503") {
		t.Fatalf("503: exit %d, stderr %q", code, stderr.String())
	}

	stderr.Reset() // nothing listens
	if code := healthcheck(context.Background(), missing, testEnv(healthEnv(pickFreePort(t))), &stderr); code != 1 || stderr.Len() == 0 {
		t.Fatalf("no server: exit %d, stderr %q", code, stderr.String())
	}

	prev := healthTimeout
	healthTimeout = 100 * time.Millisecond
	t.Cleanup(func() { healthTimeout = prev })
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(time.Second) }))
	defer slow.Close()
	stderr.Reset()
	start := time.Now()
	if code := healthcheck(context.Background(), missing, testEnv(healthEnv(portOf(t, slow))), &stderr); code != 1 || time.Since(start) > 900*time.Millisecond {
		t.Fatalf("slow: exit %d after %v, stderr %q", code, time.Since(start), stderr.String())
	}

	stderr.Reset() // an invalid configuration is a failure too, never a pass
	if code := healthcheck(context.Background(), missing, testEnv(nil), &stderr); code != 1 || stderr.Len() == 0 {
		t.Fatalf("no config at all: exit %d, stderr %q", code, stderr.String())
	}

}

// REQ_DEPLOY_011: the server starts with no config file when the OVERLENS_* variables carry the settings.
func Test_REQ_DEPLOY_011_server_starts_without_a_config_file(t *testing.T) {
	restoreLogger(t)
	dir := t.TempDir()
	port := pickFreePort(t)
	env := map[string]string{"OVERLENS_PORT": strconv.Itoa(port), "OVERLENS_BOOTSTRAP_ADMIN_USER": "a", "OVERLENS_BOOTSTRAP_ADMIN_PASSWORD": "b",
		"OVERLENS_DB_PATH": filepath.Join(dir, "data", "r.db"), "OVERLENS_LOG_DIR": filepath.Join(dir, "logs"),
		"OVERLENS_BACKUP_DIR": filepath.Join(dir, "backups"), "OVERLENS_BACKUP_ENABLED": "false", "OVERLENS_SAMPLE_DATA": "false"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, filepath.Join(dir, "absent.conf"), testEnv(env), io.Discard) }()
	waitHealthy(t, port, done)
	cancel()
	if code := <-done; code != 0 {
		t.Errorf("exit %d", code)
	}

	t.Run("explicit config path must exist", func(t *testing.T) {
		if err := explicitConfigExists(filepath.Join(t.TempDir(), "nope.conf")); err == nil {
			t.Error("a mistyped -config path was accepted")
		}
		present := filepath.Join(t.TempDir(), "overlens.conf")
		if err := os.WriteFile(present, []byte("port: 8080\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := explicitConfigExists(present); err != nil {
			t.Errorf("an existing path was refused: %v", err)
		}
	})
}

func waitHealthy(t *testing.T, port int, done chan int) {
	t.Helper()
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	for i := 0; i < 100; i++ {
		select {
		case code := <-done:
			t.Fatalf("the server exited early with %d", code)
		default:
		}
		if resp, err := http.Get(url); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the server never answered /health")
}

// REQ_DEMO_005: a broken embedded sample is logged and does not stop the server. The seam replaces
// the embedded file with garbage; the real file is untouched.
func Test_REQ_DEMO_005_server_starts_when_the_sample_is_broken(t *testing.T) {
	restoreLogger(t)
	prev := ensureSample
	called := false
	ensureSample = func(ctx context.Context, db *sql.DB, enabled bool, today time.Time, rec demo.Recorder) (bool, error) {
		called = true
		return demo.EnsureFrom(ctx, db, enabled, today, []byte(`{"format": "e-roadmaps/company", "teams": [oops`), rec)
	}
	t.Cleanup(func() { ensureSample = prev })

	dir := t.TempDir()
	port := pickFreePort(t)
	conf := filepath.Join(dir, "overlens.conf")
	os.WriteFile(conf, []byte(fmt.Sprintf("bootstrap_admin_user: a\nbootstrap_admin_password: b\nport: %d\nbackup_enabled: false\nsample_data: true\n"+
		"db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", port, filepath.Join(dir, "data", "r.db"), filepath.Join(dir, "logs"), filepath.Join(dir, "backups"))), 0o600)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, conf, testEnv(nil), io.Discard) }()
	waitHealthy(t, port, done)
	http.DefaultClient.CloseIdleConnections()
	cancel()
	if code := <-done; code != 0 {
		t.Errorf("exit %d", code)
	}
	if !called {
		t.Fatal("the seam was not used")
	}
	logb, _ := os.ReadFile(filepath.Join(dir, "logs", "test-app.log"))
	if !strings.Contains(string(logb), "sample company was not created") {
		t.Errorf("the failure was not logged:\n%s", logb)
	}
}
