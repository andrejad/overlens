package api_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/audit"
	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// fakeClock is the injectable clock the auth service reads in the sliding-expiry and lockout tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// rigWithClock is a rig whose auth service runs on a fake clock and a 10-day session lifetime.
func rigWithClock(t *testing.T) (*rig, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)}
	g := newRigWith(t, nil, func(db *sql.DB) *auth.Service {
		return auth.New(db, auth.Options{TTL: 10 * 24 * time.Hour, Now: clk.Now})
	})
	return g, clk
}

// reply is an in-process response, so a test can choose the connection address and read headers.
type reply struct {
	code   int
	body   string
	header http.Header
}

func (r reply) cookie(name string) *http.Cookie {
	for _, c := range (&http.Response{Header: r.header}).Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// serve sends one request straight into the router. remote is the connection address (RemoteAddr).
func (g *rig) serve(method, path, body, token, remote string, hdr map[string]string) reply {
	g.T.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if remote != "" {
		req.RemoteAddr = remote
	}
	if method != "GET" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	rec := httptest.NewRecorder()
	g.root.ServeHTTP(rec, req)
	return reply{rec.Code, rec.Body.String(), rec.Header()}
}

func (g *rig) login(user, pw, remote string) reply {
	g.T.Helper()
	b, _ := json.Marshal(map[string]string{"username": user, "password": pw})
	return g.serve("POST", "/api/login", string(b), "", remote, nil)
}

type meBody struct {
	User *struct {
		ID       int64
		Username string
		Role     string
	}
}

func (g *rig) me(token string) *meBody {
	g.T.Helper()
	r := g.serve("GET", "/api/me", "", token, "", nil)
	if r.code != 200 {
		g.T.Fatalf("GET /api/me: %d %s", r.code, r.body)
	}
	var m meBody
	if err := json.Unmarshal([]byte(r.body), &m); err != nil {
		g.T.Fatal(err)
	}
	return &m
}

func errCode(r reply) string {
	var e errResp
	json.Unmarshal([]byte(r.body), &e)
	return e.Error.Code
}

func sessionExpiry(g *rig, token string) string {
	var exp string
	if err := g.DB.QueryRow(`SELECT expires_at FROM sessions WHERE id = ?`, auth.HashToken(token)).Scan(&exp); err != nil {
		g.T.Fatal(err)
	}
	return exp
}

func countRows(g *rig, q string, args ...any) int {
	var n int
	if err := g.DB.QueryRow(q, args...).Scan(&n); err != nil {
		g.T.Fatal(err)
	}
	return n
}

// Test_REQ_AUTH_016_me_is_200_with_user_or_null: /api/me always answers 200.
func Test_REQ_AUTH_016_me_is_200_with_user_or_null(t *testing.T) {
	g := newRig(t)
	if m := g.me(""); m.User != nil {
		t.Errorf("anonymous me = %+v, want null", m.User)
	}
	r := g.serve("GET", "/api/me", "", "", "", nil)
	if strings.TrimSpace(r.body) != `{"user":null}` {
		t.Errorf("anonymous body %q", r.body)
	}
	m := g.me(g.cookie)
	if m.User == nil || m.User.ID != g.admin.ID || m.User.Username != g.admin.Username || m.User.Role != "admin" {
		t.Errorf("me = %+v", m.User)
	}
	if m := g.me("not-a-real-token"); m.User != nil {
		t.Errorf("bogus cookie me = %+v, want null", m.User)
	}
}

// Test_REQ_AUTH_002_login_logout_flow also covers REQ_AUTH_010's first sentence: logging out deletes
// the session.
func Test_REQ_AUTH_002_REQ_API_015_login_logout_flow(t *testing.T) {
	t.Run("login logout and me endpoints exist and behave", func(t *testing.T) {
		g := newRig(t)
		u := g.Admin(testutil.AdminOpts{Username: "Kim", Password: "kim-password-1"})

		// the routes exist, with the right methods
		if r := g.serve("GET", "/api/login", "", "", "", nil); r.code != 405 {
			t.Errorf("GET /api/login = %d, want 405", r.code)
		}
		if r := g.serve("GET", "/api/logout", "", "", "", nil); r.code != 405 {
			t.Errorf("GET /api/logout = %d, want 405", r.code)
		}
		if r := g.serve("POST", "/api/me", "{}", "", "", nil); r.code != 405 {
			t.Errorf("POST /api/me = %d, want 405", r.code)
		}
		// edge-case usernames
		for _, name := range []string{"Kim", "kim", "KIM", " kim", "kim ", "\tKim "} {
			r := g.login(name, u.Password, "")
			if r.code != 200 || r.cookie(auth.CookieName) == nil {
				t.Errorf("login as %q: %d %s", name, r.code, r.body)
			}
		}
		for _, name := range []string{"Kim", "ki\nm", "k\x00im", strings.Repeat("k", 65), ""} {
			r := g.login(name, u.Password, "")
			if r.code != 401 || errCode(r) != "invalid_credentials" {
				t.Errorf("login as %q: %d %s, want the generic 401", name, r.code, r.body)
			}
		}
		// unusable names never lock anything: many of them, then the real login still works
		for range 12 {
			g.login(strings.Repeat("x", 70), "pw", "3.3.3.3:5")
		}
		if r := g.login("kim", u.Password, "3.3.3.3:5"); r.code != 200 {
			t.Errorf("unusable names locked the address: %d", r.code)
		}
		// me and logout follow the session
		c := g.login("KIM", u.Password, "").cookie(auth.CookieName)
		if m := g.me(c.Value); m.User == nil || m.User.Username != "Kim" {
			t.Errorf("me = %+v", m.User)
		}
		if r := g.serve("POST", "/api/logout", "", c.Value, "", nil); r.code != 204 {
			t.Errorf("logout %d", r.code)
		}
		if m := g.me(c.Value); m.User != nil {
			t.Error("session survived logout")
		}
	})

	g := newRig(t)
	r := g.login(g.admin.Username, g.admin.Password, "")
	if r.code != 200 {
		t.Fatalf("login: %d %s", r.code, r.body)
	}
	var lb meBody
	json.Unmarshal([]byte(r.body), &lb)
	if lb.User == nil || lb.User.Username != g.admin.Username || lb.User.Role != "admin" {
		t.Fatalf("login body %s", r.body)
	}
	c := r.cookie(auth.CookieName)
	if c == nil || c.Value == "" {
		t.Fatal("no session cookie")
	}
	if m := g.me(c.Value); m.User == nil || m.User.ID != g.admin.ID {
		t.Errorf("me after login = %+v", m.User)
	}
	// the new session works for an admin write
	if w := g.serve("POST", "/api/teams", `{"name":"Via Login","tag":"VLG"}`, c.Value, "", nil); w.code != 201 {
		t.Errorf("write with fresh session: %d %s", w.code, w.body)
	}
	lo := g.serve("POST", "/api/logout", "", c.Value, "", nil)
	if lo.code != 204 {
		t.Fatalf("logout: %d", lo.code)
	}
	if cc := lo.cookie(auth.CookieName); cc == nil || cc.MaxAge >= 0 {
		t.Errorf("logout must clear the cookie: %+v", cc)
	}
	if n := countRows(g, `SELECT COUNT(*) FROM sessions WHERE id = ?`, auth.HashToken(c.Value)); n != 0 {
		t.Error("session row survived logout")
	}
	if m := g.me(c.Value); m.User != nil {
		t.Error("old cookie still identifies someone after logout")
	}
	if w := g.serve("POST", "/api/teams", `{"name":"After","tag":"AFT"}`, c.Value, "", nil); w.code != 401 {
		t.Errorf("write with a logged-out cookie: %d", w.code)
	}
	if again := g.serve("POST", "/api/logout", "", "", "", nil); again.code != 204 {
		t.Errorf("logout with no session = %d, want idempotent 204", again.code)
	}

}

// Test_REQ_AUTH_008_cookie_flags_and_only_the_hash_is_stored.
func Test_REQ_AUTH_008_REQ_DEPLOY_013_cookie_flags_and_only_the_hash_is_stored(t *testing.T) {
	t.Run("cookie secure", func(t *testing.T) {
		for _, tc := range []struct {
			name   string
			secure bool
			tls    bool
			want   bool
		}{{"auto on plain http", false, false, false}, {"auto on tls", false, true, true}, {"true on plain http", true, false, true}} {
			t.Run(tc.name, func(t *testing.T) {
				env := testutil.NewEnv(t)
				admin := env.Admin(testutil.AdminOpts{})
				root := chi.NewRouter()
				api.New(env.DB, api.NopAudit{}, api.WithCookieSecure(tc.secure)).Register(root)
				body, _ := json.Marshal(map[string]string{"username": admin.Username, "password": admin.Password})
				req := httptest.NewRequest("POST", "/api/login", strings.NewReader(string(body)))
				req.Header.Set("Content-Type", "application/json")
				if tc.tls {
					req.TLS = &tls.ConnectionState{}
				}
				rec := httptest.NewRecorder()
				root.ServeHTTP(rec, req)
				if rec.Code != 200 {
					t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
				}
				var found bool
				for _, c := range rec.Result().Cookies() {
					if c.Name == auth.CookieName {
						found = true
						if c.Secure != tc.want || !c.HttpOnly {
							t.Errorf("Secure=%v HttpOnly=%v, want Secure=%v", c.Secure, c.HttpOnly, tc.want)
						}
					}
				}
				if !found {
					t.Error("no session cookie")
				}
				// logout clears it with the same flag
				req = httptest.NewRequest("POST", "/api/logout", nil)
				req.Header.Set("Content-Type", "application/json")
				rec = httptest.NewRecorder()
				root.ServeHTTP(rec, req)
				for _, c := range rec.Result().Cookies() {
					if c.Name == auth.CookieName && c.Secure != (tc.secure) {
						t.Errorf("logout cookie Secure=%v, want %v", c.Secure, tc.secure)
					}
				}
			})
		}
	})

	t.Run("tokens are 256 bit and unique", func(t *testing.T) {
		seen := map[string]bool{}
		for range 50 {
			tok, id, err := auth.NewToken()
			if err != nil || len(tok) != 43 || len(id) != 64 || id != auth.HashToken(tok) || id == tok || seen[tok] {
				t.Fatalf("token %q id %q err %v", tok, id, err)
			}
			seen[tok] = true
		}
	})

	g, _ := rigWithClock(t)
	r := g.login(g.admin.Username, g.admin.Password, "")
	c := r.cookie(auth.CookieName)
	if c == nil {
		t.Fatalf("no cookie: %d %s", r.code, r.body)
	}
	if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" {
		t.Errorf("cookie flags %+v", c)
	}
	if c.MaxAge != 10*24*3600 {
		t.Errorf("Max-Age = %d, want the session TTL (10 days)", c.MaxAge)
	}
	if c.Secure {
		t.Error("Secure set on a plain-HTTP request")
	}
	raw, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(raw) != 32 {
		t.Errorf("token is not 256-bit base64url: %v len %d", err, len(raw))
	}
	var id string
	if err := g.DB.QueryRow(`SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, g.admin.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if n := countRows(g, `SELECT COUNT(*) FROM sessions WHERE id = ?`, c.Value); n != 0 {
		t.Error("the raw token is stored as a session id")
	}
	if n := countRows(g, `SELECT COUNT(*) FROM sessions WHERE id = ?`, auth.HashToken(c.Value)); n != 1 || len(auth.HashToken(c.Value)) != 64 {
		t.Error("the SHA-256 of the token is not the stored id")
	}

	// Over TLS the cookie is Secure; a forwarded header alone is not trusted.
	b, _ := json.Marshal(map[string]string{"username": g.admin.Username, "password": g.admin.Password})
	req := httptest.NewRequest("POST", "/api/login", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.TLS = &tls.ConnectionState{}
	rec := httptest.NewRecorder()
	g.root.ServeHTTP(rec, req)
	if sc := (&http.Response{Header: rec.Header()}).Cookies(); len(sc) == 0 || !sc[0].Secure {
		t.Errorf("no Secure cookie over TLS: %+v", sc)
	}
	r = g.serve("POST", "/api/login", string(b), "", "", map[string]string{"X-Forwarded-Proto": "https"})
	if cc := r.cookie(auth.CookieName); cc == nil || cc.Secure {
		t.Errorf("X-Forwarded-Proto must not make the cookie Secure: %+v", cc)
	}

}

// Test_REQ_AUTH_017_every_failed_login_looks_the_same: unknown user, wrong password and a disabled
// account give byte-identical 401 invalid_credentials bodies.
func Test_REQ_AUTH_017_every_failed_login_looks_the_same(t *testing.T) {
	g := newRig(t)
	off := g.Admin(testutil.AdminOpts{Username: "Off", Password: "right-password", Disabled: true})
	cases := map[string]reply{
		"unknown":  g.login("nobody", "whatever-123", ""),
		"wrong":    g.login(g.admin.Username, "wrong-password", ""),
		"disabled": g.login(off.Username, off.Password, ""),
		"empty":    g.login("", "", ""),
	}
	for name, r := range cases {
		if r.code != 401 || errCode(r) != "invalid_credentials" {
			t.Errorf("%s: %d %s", name, r.code, r.body)
		}
		if r.cookie(auth.CookieName) != nil {
			t.Errorf("%s: a cookie was set", name)
		}
		if r.body != cases["unknown"].body {
			t.Errorf("%s: body %q differs from the unknown-user body %q", name, r.body, cases["unknown"].body)
		}
	}
	// the disabled user, with the right password, is still refused; and the right password for an
	// enabled user works (so the failures above were not just a broken login)
	if r := g.login(g.admin.Username, g.admin.Password, ""); r.code != 200 {
		t.Errorf("good login: %d", r.code)
	}
}

// Test_REQ_AUTH_011_lockout_per_connection_address_ignores_forwarded_for: 5 failures from one
// address lock it for 15 minutes — whatever X-Forwarded-For says.
func Test_REQ_AUTH_011_lockout_per_connection_address_ignores_forwarded_for(t *testing.T) {
	t.Run("lockout per username ignoring case", func(t *testing.T) {
		g, clk := rigWithClock(t)
		other := g.Admin(testutil.AdminOpts{Username: "other", Password: "other-password"})
		names := []string{g.admin.Username, strings.ToUpper(g.admin.Username), g.admin.Username, strings.ToUpper(g.admin.Username), g.admin.Username}
		for i, n := range names {
			if r := g.login(n, "wrong-password", fmt.Sprintf("10.3.3.%d:1", i)); r.code != 401 {
				t.Fatalf("attempt %d: %d", i, r.code)
			}
		}
		if r := g.login(g.admin.Username, g.admin.Password, "10.3.3.99:1"); r.code != 429 {
			t.Errorf("locked username, correct password: %d %s", r.code, r.body)
		}
		if r := g.login(other.Username, other.Password, "10.3.3.99:1"); r.code != 200 {
			t.Errorf("an unrelated username must still log in: %d", r.code)
		}
		clk.Advance(16 * time.Minute)
		if r := g.login(g.admin.Username, g.admin.Password, "10.3.3.99:1"); r.code != 200 {
			t.Errorf("username lock should have ended: %d", r.code)
		}
	})

	g, clk := rigWithClock(t)
	for i := range 5 {
		r := g.serve("POST", "/api/login", fmt.Sprintf(`{"username":"nobody%d","password":"x"}`, i), "", "10.1.1.1:5000",
			map[string]string{"X-Forwarded-For": fmt.Sprintf("9.9.9.%d", i)})
		if r.code != 401 {
			t.Fatalf("attempt %d: %d", i, r.code)
		}
	}
	good, _ := json.Marshal(map[string]string{"username": g.admin.Username, "password": g.admin.Password})
	r := g.serve("POST", "/api/login", string(good), "", "10.1.1.1:6000", map[string]string{"X-Forwarded-For": "8.8.8.8"})
	if r.code != 429 || errCode(r) != "locked" {
		t.Fatalf("locked address: %d %s", r.code, r.body)
	}
	// another connection address is not locked, even when it claims the locked one in X-Forwarded-For
	r = g.serve("POST", "/api/login", string(good), "", "10.2.2.2:5000", map[string]string{"X-Forwarded-For": "10.1.1.1"})
	if r.code != 200 {
		t.Errorf("other address with a spoofed X-Forwarded-For: %d %s", r.code, r.body)
	}
	clk.Advance(14 * time.Minute)
	if r := g.serve("POST", "/api/login", string(good), "", "10.1.1.1:5000", nil); r.code != 429 {
		t.Errorf("still locked after 14 minutes: %d", r.code)
	}
	clk.Advance(2 * time.Minute)
	if r := g.serve("POST", "/api/login", string(good), "", "10.1.1.1:5000", nil); r.code != 200 {
		t.Errorf("lock should end after 15 minutes: %d %s", r.code, r.body)
	}

}

// Test_REQ_AUTH_009_sessions_slide_in_the_last_half_of_their_life.
func Test_REQ_AUTH_009_sessions_slide_in_the_last_half_of_their_life(t *testing.T) {
	g, clk := rigWithClock(t)
	r := g.login(g.admin.Username, g.admin.Password, "")
	tok := r.cookie(auth.CookieName).Value
	first := sessionExpiry(g, tok)

	clk.Advance(4 * 24 * time.Hour) // 6 of 10 days left: first half of its life, nothing changes
	r = g.serve("GET", "/api/me", "", tok, "", nil)
	if r.cookie(auth.CookieName) != nil || sessionExpiry(g, tok) != first {
		t.Error("a request in the first half of the life must not extend the session")
	}
	clk.Advance(2 * 24 * time.Hour) // 4 of 10 days left: last half
	r = g.serve("GET", "/api/me", "", tok, "", nil)
	c := r.cookie(auth.CookieName)
	if c == nil || c.Value != tok || c.MaxAge != 10*24*3600 {
		t.Fatalf("a request in the last half must re-set the cookie: %+v", c)
	}
	if want := clk.Now().Add(10 * 24 * time.Hour).Format("2006-01-02T15:04:05Z"); sessionExpiry(g, tok) != want {
		t.Errorf("expires_at = %s, want %s", sessionExpiry(g, tok), want)
	}
	// a write that slides it also re-sets the cookie
	clk.Advance(6 * 24 * time.Hour)
	w := g.serve("POST", "/api/teams", `{"name":"Slide","tag":"SLD"}`, tok, "", nil)
	if w.code != 201 || w.cookie(auth.CookieName) == nil {
		t.Errorf("sliding write: %d, cookie %v", w.code, w.cookie(auth.CookieName))
	}
	// an unused session dies at its expiry
	clk.Advance(11 * 24 * time.Hour)
	if w := g.serve("POST", "/api/teams", `{"name":"Late","tag":"LTE"}`, tok, "", nil); w.code != 401 {
		t.Errorf("expired session: %d", w.code)
	}
	if m := g.me(tok); m.User != nil {
		t.Error("expired session still identifies a user")
	}
}

// Test_REQ_AUTH_010_password_reset_and_disable_delete_that_users_sessions.
func Test_REQ_AUTH_010_password_reset_and_disable_delete_that_users_sessions(t *testing.T) {
	g := newRig(t)
	bob := g.Admin(testutil.AdminOpts{Username: "bob", Password: "bobs-password"})
	carol := g.Admin(testutil.AdminOpts{Username: "carol", Password: "carols-password"})
	bobTok, bobTok2 := g.Session(bob), g.Session(bob)
	carolTok := g.Session(carol)

	r := g.serve("PATCH", "/api/users/"+id(bob.ID), `{"password":"a-brand-new-password"}`, g.cookie, "", nil)
	if r.code != 200 {
		t.Fatalf("reset: %d %s", r.code, r.body)
	}
	if n := countRows(g, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, bob.ID); n != 0 {
		t.Errorf("%d of bob's sessions survived the reset", n)
	}
	for _, tok := range []string{bobTok, bobTok2} {
		if g.me(tok).User != nil {
			t.Error("a reset user's old cookie still works")
		}
	}
	if g.me(carolTok).User == nil || g.me(g.cookie).User == nil {
		t.Error("someone else's session died")
	}
	if r := g.login("bob", "bobs-password", ""); r.code != 401 {
		t.Errorf("old password still works: %d", r.code)
	}
	if r := g.login("bob", "a-brand-new-password", ""); r.code != 200 {
		t.Errorf("new password: %d %s", r.code, r.body)
	}

	// disabling: sessions go, login is refused, re-enabling brings the account back (with a fresh login)
	r = g.serve("PATCH", "/api/users/"+id(carol.ID), `{"disabled":true}`, g.cookie, "", nil)
	if r.code != 200 || countRows(g, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, carol.ID) != 0 || g.me(carolTok).User != nil {
		t.Errorf("disable: %d %s", r.code, r.body)
	}
	if r := g.login("carol", "carols-password", ""); r.code != 401 || errCode(r) != "invalid_credentials" {
		t.Errorf("disabled login: %d %s", r.code, r.body)
	}
	r = g.serve("PATCH", "/api/users/"+id(carol.ID), `{"disabled":false}`, g.cookie, "", nil)
	if r.code != 200 {
		t.Fatalf("re-enable: %d %s", r.code, r.body)
	}
	if r := g.login("carol", "carols-password", ""); r.code != 200 {
		t.Errorf("re-enabled login: %d", r.code)
	}
}

type userJSON struct {
	ID        int64
	Username  string
	Role      string
	Disabled  bool
	CreatedAt string `json:"created_at"`
}

// Test_REQ_API_032_users_list_create_patch_no_delete.
func Test_REQ_API_032_users_list_create_patch_no_delete(t *testing.T) {
	g := newRig(t)
	u := must[userJSON](g, 201, "POST", "/api/users", map[string]any{"username": "Dana", "password": "dana-password"})
	if u.Username != "Dana" || u.Role != "admin" || u.Disabled || u.CreatedAt == "" || u.ID == 0 {
		t.Errorf("created %+v", u)
	}
	if r := g.login("dana", "dana-password", ""); r.code != 200 {
		t.Errorf("the new admin can't log in (username is case-insensitive): %d", r.code)
	}
	l := must[struct {
		Items []userJSON
		Total int
	}](g, 200, "GET", "/api/users", nil)
	if l.Total != 2 || len(l.Items) != 2 || l.Items[0].ID != g.admin.ID || l.Items[1].ID != u.ID {
		t.Errorf("list %+v", l)
	}
	raw := g.serve("GET", "/api/users", "", g.cookie, "", nil).body
	if strings.Contains(strings.ToLower(raw), "hash") || strings.Contains(raw, "argon2") || strings.Contains(strings.ToLower(raw), "password") {
		t.Errorf("user list carries a secret: %s", raw)
	}
	if got := must[userJSON](g, 200, "PATCH", "/api/users/"+id(u.ID), map[string]any{"disabled": true}); !got.Disabled {
		t.Errorf("patched %+v", got)
	}
	if code := g.expect(404, "PATCH", "/api/users/99999", map[string]any{"disabled": true}); code != "not_found" {
		t.Errorf("unknown id code %q", code)
	}
	g.expect(405, "DELETE", "/api/users/"+id(u.ID), nil)
	g.expect(405, "DELETE", "/api/users", nil)
}

// Test_REQ_AUTH_019_system_username_is_reserved: "system" names the server's own audit entries, so no
// admin may be created under it, in any capitals, after trimming.
func Test_REQ_AUTH_019_system_username_is_reserved(t *testing.T) {
	g := newRig(t)
	for _, name := range []string{"system", "SYSTEM", " System\t"} {
		status, e := call[errResp](g, "POST", "/api/users", map[string]any{"username": name, "password": "long-enough-pw"})
		if status != 422 || e.Error.Code != "validation_failed" || e.Error.Fields["username"] == "" {
			t.Errorf("%q: %d %+v", name, status, e)
		}
	}
	var n int
	g.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE username = 'system' COLLATE NOCASE`).Scan(&n)
	if n != 0 {
		t.Errorf("%d users named system", n)
	}
	must[userJSON](g, 201, "POST", "/api/users", map[string]any{"username": "systems", "password": "long-enough-pw"}) // only the exact name
}

// Test_REQ_AUTH_014_username_unique_ignoring_case_and_password_policy.
func Test_REQ_AUTH_014_username_unique_ignoring_case_and_password_policy(t *testing.T) {
	g := newRig(t)
	ok := map[string]any{"username": "Erin", "password": "erin-password"}
	must[userJSON](g, 201, "POST", "/api/users", ok)
	if code := g.expect(409, "POST", "/api/users", map[string]any{"username": "ERIN", "password": "another-password"}); code != "duplicate_name" {
		t.Errorf("duplicate code %q", code)
	}
	for _, pw := range []string{"", "short", strings.Repeat("x", 7)} {
		status, e := call[errResp](g, "POST", "/api/users", map[string]any{"username": "Frank", "password": pw})
		if status != 422 || e.Error.Fields["password"] == "" {
			t.Errorf("password %q: %d %+v", pw, status, e)
		}
	}
	if status, e := call[errResp](g, "POST", "/api/users", map[string]any{"username": "Frank", "password": strings.Repeat("x", 129)}); status != 422 || e.Error.Fields["password"] == "" {
		t.Errorf("129-char password: %d %+v", status, e)
	}
	must[userJSON](g, 201, "POST", "/api/users", map[string]any{"username": "Frank", "password": strings.Repeat("x", 128)})
	must[userJSON](g, 201, "POST", "/api/users", map[string]any{"username": "Gus", "password": "12345678"})
	if status, e := call[errResp](g, "POST", "/api/users", map[string]any{"username": "  ", "password": "long-enough-pw"}); status != 422 || e.Error.Fields["username"] == "" {
		t.Errorf("blank username: %d %+v", status, e)
	}
	// a password reset is checked the same way
	u := must[userJSON](g, 201, "POST", "/api/users", map[string]any{"username": "Hana", "password": "hana-password"})
	if status, e := call[errResp](g, "PATCH", "/api/users/"+id(u.ID), map[string]any{"password": "tiny"}); status != 422 || e.Error.Fields["password"] == "" {
		t.Errorf("short reset: %d %+v", status, e)
	}

	t.Run("password policy is 8 to 128 characters", func(t *testing.T) {
		for pw, want := range map[string]bool{
			"": false, "1234567": false, "12345678": true, strings.Repeat("a", 128): true, strings.Repeat("a", 129): false,
			strings.Repeat("é", 8): true, strings.Repeat("é", 128): true, // characters, not bytes
		} {
			if got := auth.ValidatePassword(pw); got != want {
				t.Errorf("%d chars: %v, want %v", len([]rune(pw)), got, want)
			}
		}
	})
}

// Test_REQ_AUTH_015_self_disable_and_enable_rules: an admin can't disable themself; re-enabling is
// always allowed. (last_admin has its own test at the service level — through the API it can only
// be reached by a race, since the acting admin is always an active admin themself.)
func Test_REQ_AUTH_015_self_disable_and_enable_rules(t *testing.T) {
	g := newRig(t)
	if code := g.expect(409, "PATCH", "/api/users/"+id(g.admin.ID), map[string]any{"disabled": true}); code != "self_disable" {
		t.Errorf("code %q", code)
	}
	if g.me(g.cookie).User == nil {
		t.Error("the refused self-disable ended the session")
	}
	if got := must[userJSON](g, 200, "PATCH", "/api/users/"+id(g.admin.ID), map[string]any{"disabled": false}); got.Disabled {
		t.Errorf("enable-self no-op %+v", got)
	}
}

// Test_REQ_AUTH_018_no_password_hash_or_token_in_any_log_or_audit_entry drives the whole auth surface
// at DEBUG level and then searches every log line and audit row for secrets.
func Test_REQ_AUTH_018_no_password_hash_or_token_in_any_log_or_audit_entry(t *testing.T) {
	g2 := newRigWith(t, func(db *sql.DB) api.Auditor { return audit.New(db) }, nil)
	var buf bytes.Buffer
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	const pw1, pw2, pw3 = "s3cret-pass-one", "s3cret-pass-two", "bad-guess-pass"
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	u := must[userJSON](g2, 201, "POST", "/api/users", map[string]any{"username": "Ivy", "password": pw1})
	r := g2.login("Ivy", pw1, "")
	tok := r.cookie(auth.CookieName).Value
	g2.login("Ivy", pw3, "")
	g2.serve("PATCH", "/api/users/"+id(u.ID), fmt.Sprintf(`{"password":%q}`, pw2), g2.cookie, "", nil)
	g2.serve("GET", "/api/users", "", g2.cookie, "", nil)
	g2.serve("GET", "/api/me", "", tok, "", nil)
	g2.serve("POST", "/api/logout", "", tok, "", nil)

	var hash string
	if err := g2.DB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, u.ID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") || strings.Contains(hash, pw2) {
		t.Fatalf("stored hash %q", hash)
	}
	var audits strings.Builder
	rows, err := g2.DB.Query(`SELECT username || action || details_json FROM audit_log`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var s string
		rows.Scan(&s)
		audits.WriteString(s + "\n")
	}
	rows.Close()
	if audits.Len() == 0 {
		t.Fatal("expected audit rows")
	}
	for _, secret := range []string{pw1, pw2, pw3, hash, tok, g2.cookie, "argon2id"} {
		if strings.Contains(buf.String(), secret) {
			t.Errorf("log contains a secret %q:\n%s", secret, buf.String())
		}
		if strings.Contains(audits.String(), secret) {
			t.Errorf("audit contains a secret %q:\n%s", secret, audits.String())
		}
	}
	for _, name := range []string{"Cookie", "Set-Cookie"} {
		if strings.Contains(strings.ToLower(buf.String()), strings.ToLower(name)+"=") {
			t.Errorf("%s header logged", name)
		}
	}
	// and no response body carries the hash
	for _, body := range []string{g2.serve("GET", "/api/users", "", g2.cookie, "", nil).body, r.body} {
		if strings.Contains(body, hash) || strings.Contains(body, "argon2") {
			t.Errorf("response carries a hash: %s", body)
		}
	}
}

// Test_REQ_AUD_019_user_actions_are_audited_by_name_only.
func Test_REQ_AUD_019_user_actions_are_audited_by_name_only(t *testing.T) {
	g := newRig(t)
	u := must[userJSON](g, 201, "POST", "/api/users", map[string]any{"username": "Jo", "password": "jo-password-1"})
	e := g.lastAudit()
	if e.Action != "user.create" || e.EntityType != "user" || e.EntityID != u.ID || e.Details["user"] != "Jo" {
		t.Errorf("create entry %+v", e)
	}
	step := func(body map[string]any, want ...string) {
		t.Helper()
		n0 := g.auditCount()
		must[userJSON](g, 200, "PATCH", "/api/users/"+id(u.ID), body)
		if got := g.auditCount() - n0; got != len(want) {
			t.Fatalf("%v wrote %d entries, want %d", body, got, len(want))
		}
		g.audit.mu.Lock()
		defer g.audit.mu.Unlock()
		for i, a := range want {
			e := g.audit.entries[n0+i]
			if e.Action != a || e.Details["user"] != "Jo" {
				t.Errorf("entry %d = %+v, want %s", i, e, a)
			}
			for k, v := range e.Details {
				if k != "user" {
					t.Errorf("unexpected detail %s=%v", k, v)
				}
			}
		}
	}
	step(map[string]any{"password": "jo-new-password"}, "user.password_reset")
	step(map[string]any{"disabled": true}, "user.disable")
	step(map[string]any{"disabled": true}) // already disabled: a true no-op writes nothing
	step(map[string]any{"disabled": false}, "user.enable")
	step(map[string]any{}) // nothing to change
	step(map[string]any{"password": "jo-third-pass", "disabled": true}, "user.disable", "user.password_reset")
	// login and logout are logged, not audited
	n0 := g.auditCount()
	g.login("Jo", "jo-third-pass", "")
	g.serve("POST", "/api/logout", "", "", "", nil)
	if g.auditCount() != n0 {
		t.Error("login/logout wrote an audit entry")
	}
}

// Test_REQ_AUD_020_entries_record_the_acting_admin_or_system uses the real Auditor on the temp DB.
func Test_REQ_AUD_020_entries_record_the_acting_admin_or_system(t *testing.T) {
	g := newRigWith(t, func(db *sql.DB) api.Auditor { return audit.New(db) }, nil)
	team := must[store.Team](g, 201, "POST", "/api/teams", map[string]any{"name": "Acting", "tag": "ACT"})
	var uid sql.NullInt64
	var name, action, details string
	var entity sql.NullInt64
	row := `SELECT user_id, username, action, entity_id, details_json FROM audit_log ORDER BY id DESC LIMIT 1`
	if err := g.DB.QueryRow(row).Scan(&uid, &name, &action, &entity, &details); err != nil {
		t.Fatal(err)
	}
	if !uid.Valid || uid.Int64 != g.admin.ID || name != g.admin.Username || action != "team.create" || entity.Int64 != team.ID {
		t.Errorf("entry: user_id=%v username=%q action=%q entity=%v", uid, name, action, entity)
	}
	if !strings.Contains(details, "Acting") {
		t.Errorf("details %s", details)
	}
	// the username is as it was at the time: a later change of the user table does not rewrite history
	g.DB.Exec(`UPDATE users SET username = 'renamed' WHERE id = ?`, g.admin.ID)
	g.DB.QueryRow(`SELECT username FROM audit_log ORDER BY id DESC LIMIT 1`).Scan(&name)
	if name != g.admin.Username {
		t.Errorf("history rewritten: %q", name)
	}
	// a server-made entry (no user in the context) is the system user with no id
	if err := audit.New(g.DB).Record(context.Background(), api.AuditEntry{Action: "backup.create", EntityType: "backup"}); err != nil {
		t.Fatal(err)
	}
	if err := g.DB.QueryRow(row).Scan(&uid, &name, &action, &entity, &details); err != nil {
		t.Fatal(err)
	}
	if uid.Valid || name != "system" || action != "backup.create" || entity.Valid || details != "{}" {
		t.Errorf("system entry: user_id=%v username=%q entity=%v details=%s", uid, name, entity, details)
	}
}

// Test_REQ_AUTH_003_authenticate_is_the_single_seam: requireAdmin, /api/me and the audit actor all
// follow what Authenticate says, so replacing it replaces the password check everywhere.
func Test_REQ_AUTH_003_authenticate_is_the_single_seam(t *testing.T) {
	g := newRig(t)
	svc := auth.New(g.DB, auth.Options{})
	req := httptest.NewRequest("GET", "/", nil)
	if _, err := svc.Authenticate(req); err == nil {
		t.Error("no cookie must not authenticate")
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: g.cookie})
	u, err := svc.Authenticate(req)
	if err != nil || u.ID != g.admin.ID {
		t.Errorf("Authenticate = %+v, %v", u, err)
	}
}
