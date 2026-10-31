package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/testutil"
)

// startServer runs the real server in-process on a free port against dir's temp database, retrying
// on a lost port race, and returns the base URL and a stop func that returns the exit code.
func startServer(t *testing.T, dir, user, pw string) (string, func() int) {
	t.Helper()
	for attempt := 1; attempt <= 3; attempt++ {
		port := pickFreePort(t)
		conf := filepath.Join(dir, fmt.Sprintf("overlens-%s-%d.conf", user, attempt))
		os.WriteFile(conf, []byte(fmt.Sprintf("bootstrap_admin_user: %s\nbootstrap_admin_password: %s\nport: %d\n"+
			"db_path: %s\nlog_dir: %s\nbackup_dir: %s\n", user, pw, port, filepath.Join(dir, "data", "r.db"),
			filepath.Join(dir, "logs"), filepath.Join(dir, "backups"))), 0o600)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan int, 1)
		go func() { done <- run(ctx, conf, testEnv(nil), os.Stderr) }()
		base := fmt.Sprintf("http://127.0.0.1:%d", port)
		for i := 0; i < 100; i++ {
			select {
			case <-done:
				i = 100
				continue
			default:
			}
			if resp, err := http.Get(base + "/health"); err == nil {
				resp.Body.Close()
				return base, func() int {
					// The client may hold a spare connection it never used; the server's Shutdown waits up to 5s for
					// such a brand-new connection, racing the 5s limit below. Drop the client's idle ones first.
					http.DefaultClient.CloseIdleConnections()
					cancel()
					select {
					case code := <-done:
						return code
					case <-time.After(15 * time.Second):
						t.Fatal("no graceful shutdown")
						return -1
					}
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		cancel()
	}
	t.Fatal("could not start the server")
	return "", nil
}

func postLogin(t *testing.T, base, user, pw string) int {
	t.Helper()
	resp, err := http.Post(base+"/api/login", "application/json", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":%q}`, user, pw)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// Test_REQ_AUTH_004_bootstrap_admin_is_created_once_from_the_config: an empty database gets the
// config's admin (argon2id, never logged); a later start with different bootstrap settings changes
// nothing, because users already exist.
func Test_REQ_AUTH_004_bootstrap_admin_is_created_once_from_the_config(t *testing.T) {
	t.Run("bootstrap admin only when the users table is empty", func(t *testing.T) {
		e := testutil.NewEnv(t)
		svc := auth.New(e.DB, auth.Options{})
		ctx := context.Background()
		created, err := svc.Bootstrap(ctx, "root", "bootstrap-pass-1")
		if err != nil || !created {
			t.Fatalf("first bootstrap: %v %v", created, err)
		}
		var hash, role string
		if err := e.DB.QueryRow(`SELECT password_hash, role FROM users WHERE username='root'`).Scan(&hash, &role); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(hash, "$argon2id$") || strings.Contains(hash, "bootstrap-pass-1") || role != "admin" {
			t.Errorf("stored %q / %q", hash, role)
		}
		if _, _, err := svc.Login(ctx, "1.2.3.4:5", "ROOT", "bootstrap-pass-1"); err != nil {
			t.Errorf("the bootstrap admin can't log in: %v", err)
		}
		// users exist now: another config (new name, new password) creates nothing and changes nothing
		created, err = svc.Bootstrap(ctx, "someone-else", "another-pass-2")
		if err != nil || created {
			t.Fatalf("second bootstrap: %v %v", created, err)
		}
		var n int
		e.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
		var h2 string
		e.DB.QueryRow(`SELECT password_hash FROM users WHERE username='root'`).Scan(&h2)
		if n != 1 || h2 != hash {
			t.Errorf("users=%d, hash changed=%v", n, h2 != hash)
		}
		// even a disabled-only table counts as "has users"
		e.DB.Exec(`UPDATE users SET disabled=1`)
		if created, _ := svc.Bootstrap(ctx, "third", "third-pass-33"); created {
			t.Error("bootstrap ran although a (disabled) user exists")
		}
	})

	restoreLogger(t)
	dir := t.TempDir()
	const pw = "bootstrap-secret-pw"

	base, stop := startServer(t, dir, "boss", pw)
	if code := postLogin(t, base, "boss", pw); code != 200 {
		t.Errorf("bootstrap admin login: %d", code)
	}
	if code := postLogin(t, base, "boss", "wrong-password"); code != 401 {
		t.Errorf("wrong password: %d", code)
	}
	// an anonymous write is refused (requireAdmin is really wired in main)
	resp, err := http.Post(base+"/api/teams", "application/json", strings.NewReader(`{"name":"T","tag":"TT"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("anonymous write: %d", resp.StatusCode)
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}

	base, stop = startServer(t, dir, "intruder", "intruder-secret-pw")
	if code := postLogin(t, base, "boss", pw); code != 200 {
		t.Errorf("original admin after restart: %d", code)
	}
	if code := postLogin(t, base, "intruder", "intruder-secret-pw"); code != 401 {
		t.Errorf("a second bootstrap admin was created: %d", code)
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}

	logb, _ := os.ReadFile(filepath.Join(dir, "logs", "test-app.log"))
	for _, secret := range []string{pw, "intruder-secret-pw", "argon2id"} {
		if strings.Contains(string(logb), secret) {
			t.Errorf("log contains %q", secret)
		}
	}
	if !strings.Contains(string(logb), "bootstrap admin created") || !strings.Contains(string(logb), "bootstrap admin not created") {
		t.Errorf("bootstrap decisions are not logged:\n%s", logb)
	}

}
