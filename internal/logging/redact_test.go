package logging

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Test_REQ_AUTH_018_password_bearing_paths_are_redacted_and_cookies_never_logged: the bodies of
// /api/login and of every /api/users path are always replaced by a marker at DEBUG, and the Cookie
// and Set-Cookie headers (session tokens) never reach the log (REQ_AUTH_018, REQ_CFG_010).
func Test_REQ_AUTH_018_REQ_CFG_010_password_bearing_paths_are_redacted_and_cookies_never_logged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "set-cookie-token-value"})
		w.Write([]byte(`{"password":"echoed-secret-value"}`))
	}))
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/login"}, {"POST", "/api/users"}, {"GET", "/api/users"}, {"PATCH", "/api/users/7"},
	} {
		buf.Reset()
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(`{"password":"request-secret-value"}`))
		req.AddCookie(&http.Cookie{Name: "session", Value: "cookie-token-value"})
		h.ServeHTTP(httptest.NewRecorder(), req)
		out := buf.String()
		for _, secret := range []string{"request-secret-value", "echoed-secret-value", "cookie-token-value", "set-cookie-token-value"} {
			if strings.Contains(out, secret) {
				t.Errorf("%s %s logged %q: %s", c.method, c.path, secret, out)
			}
		}
		if strings.Count(out, "[redacted: "+c.path+"]") != 2 { // request body and response body
			t.Errorf("%s %s: missing redaction markers: %s", c.method, c.path, out)
		}
	}
	// other paths are still summarised, so redaction is not simply turned on everywhere
	buf.Reset()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/teams", strings.NewReader(`{"name":"visible"}`)))
	if !strings.Contains(buf.String(), "visible") || strings.Contains(buf.String(), "redacted") {
		t.Errorf("a non-credential path was redacted: %s", buf.String())
	}
	for _, p := range []string{"/api/userscript", "/api/user", "/api/me"} {
		if isLoginPath(p) {
			t.Errorf("%s must not be treated as password-bearing", p)
		}
	}

	t.Run("login bodies are redacted even at debug", func(t *testing.T) {
		var buf bytes.Buffer
		prev := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
		t.Cleanup(func() { slog.SetDefault(prev) })

		h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.Copy(io.Discard, r.Body)
			w.Write([]byte(`{"session":"top-secret-token-value"}`))
		}))
		req := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"username":"admin","password":"hunter2-the-real-password"}`))
		h.ServeHTTP(httptest.NewRecorder(), req)

		out := buf.String()
		if strings.Contains(out, "hunter2") || strings.Contains(out, "top-secret-token-value") {
			t.Fatalf("login body was logged unredacted: %s", out)
		}
		if !strings.Contains(out, "redacted") {
			t.Errorf("no redaction marker for /api/login: %s", out)
		}
	})

	t.Run("redacted paths are not read by the middleware", func(t *testing.T) {
		var buf bytes.Buffer
		prev := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
		t.Cleanup(func() { slog.SetDefault(prev) })

		for _, path := range []string{"/api/login", "/api/users", "/api/users/3"} {
			req := httptest.NewRequest("POST", path, strings.NewReader(`{"password":"hunter2-secret"}`))
			orig := req.Body
			var wrapped bool
			h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				wrapped = r.Body != orig
				b, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(b), "hunter2") {
					t.Errorf("%s: handler lost its body", path)
				}
			}))
			h.ServeHTTP(httptest.NewRecorder(), req)
			if wrapped {
				t.Errorf("%s: body was wrapped, so the middleware touched a redacted path", path)
			}
		}
		if strings.Contains(buf.String(), "hunter2") || !strings.Contains(buf.String(), "redacted") {
			t.Errorf("log: %s", buf.String())
		}
	})
}
