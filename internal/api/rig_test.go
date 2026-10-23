package api_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/logging"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type recAudit struct {
	mu      sync.Mutex
	entries []api.AuditEntry
}

func (a *recAudit) Record(_ context.Context, e api.AuditEntry) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries = append(a.entries, e)
	return nil
}

// rig is a test server on a fresh temp database. Tests create their data through the builders
// (store code) or through the API under test; nothing is fixed.
//
// The rig acts as a logged-in admin: newRig seeds one admin with a session, and send/call attach its
// cookie. g.anon() is the same server with no cookie, for tests about anonymous access.
type rig struct {
	*testutil.Env
	srv    *httptest.Server
	root   *chi.Mux
	audit  *recAudit
	admin  testutil.Admin
	cookie string // the session token sent as "session=<cookie>"; "" = anonymous
}

// anon returns the same rig without a session.
func (g *rig) anon() *rig { c := *g; c.cookie = ""; return &c }

func newRig(t *testing.T) *rig {
	t.Helper()
	return newRigWith(t, nil, nil)
}

// newRigWith builds the rig with a chosen auditor (nil = the recording one) and an auth service built
// on the rig's database (nil = the default, real clock).
func newRigWith(t *testing.T, mkAudit func(*sql.DB) api.Auditor, mkAuth func(*sql.DB) *auth.Service) *rig {
	t.Helper()
	env := testutil.NewEnv(t)
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil))) // keep test output readable
	t.Cleanup(func() { slog.SetDefault(prev) })
	g := &rig{Env: env, audit: &recAudit{}}
	root := chi.NewRouter()
	root.Use(logging.Middleware)
	var aud api.Auditor = g.audit
	if mkAudit != nil {
		aud = mkAudit(env.DB)
	}
	var opts []api.Option
	if mkAuth != nil {
		opts = append(opts, api.WithAuth(mkAuth(env.DB)))
	}
	api.New(env.DB, aud, opts...).Register(root)
	g.root = root
	g.srv = httptest.NewServer(root)
	t.Cleanup(g.srv.Close)
	g.admin = env.Admin(testutil.AdminOpts{})
	g.cookie = env.Session(g.admin)
	return g
}

type errResp struct {
	Error struct {
		Code, Message string
		Fields        map[string]string
	}
}

func (g *rig) send(method, path, ctype string, body []byte) (int, []byte) {
	g.T.Helper()
	req, _ := http.NewRequest(method, g.srv.URL+path, bytes.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if g.cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: g.cookie})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		g.T.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

// call sends a JSON request and decodes the response into T.
func call[T any](g *rig, method, path string, body any) (int, T) {
	g.T.Helper()
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	// REQ_API_003: every write must send Content-Type: application/json, even with no body — GET
	// never needs it.
	ct := ""
	if method != "GET" {
		ct = "application/json"
	}
	status, raw := g.send(method, path, ct, b)
	var v T
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &v); err != nil {
			g.T.Fatalf("%s %s: bad JSON %q: %v", method, path, raw, err)
		}
	}
	return status, v
}

// expect sends a request and requires the status; for errors it returns the error code.
func (g *rig) expect(want int, method, path string, body any) string {
	g.T.Helper()
	status, e := call[errResp](g, method, path, body)
	if status != want {
		g.T.Fatalf("%s %s: status %d, want %d (%s)", method, path, status, want, e.Error.Message)
	}
	return e.Error.Code
}

func id(n int64) string { return strconv.FormatInt(n, 10) }

func must[T any](g *rig, want int, method, path string, body any) T {
	g.T.Helper()
	status, v := call[T](g, method, path, body)
	if status != want {
		_, e := call[errResp](g, method, path, body)
		g.T.Fatalf("%s %s: status %d, want %d (%s)", method, path, status, want, e.Error.Message)
	}
	return v
}

// newDeliverable creates a deliverable through the API; start/end are day offsets from the clock.
func (g *rig) newDeliverable(rm int64, ws []int64, start, end int, extra map[string]any) store.Deliverable {
	g.T.Helper()
	body := map[string]any{"name": "D" + strconv.Itoa(start) + "-" + strconv.Itoa(end),
		"start_date": g.Clock.Date(start), "end_date": g.Clock.Date(end), "workstream_ids": ws}
	for k, v := range extra {
		body[k] = v
	}
	return must[store.Deliverable](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", body)
}

func (g *rig) newWorkstream(rm int64, name string) store.Workstream {
	g.T.Helper()
	return must[store.Workstream](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/workstreams", map[string]any{"name": name})
}

func (g *rig) roadmap(rm int64) store.RoadmapFull {
	g.T.Helper()
	return must[store.RoadmapFull](g, 200, "GET", "/api/roadmaps/"+id(rm), nil)
}

func (g *rig) lastAudit() api.AuditEntry {
	g.T.Helper()
	g.audit.mu.Lock()
	defer g.audit.mu.Unlock()
	if len(g.audit.entries) == 0 {
		g.T.Fatal("no audit entry recorded")
	}
	return g.audit.entries[len(g.audit.entries)-1]
}

func (g *rig) auditCount() int {
	g.audit.mu.Lock()
	defer g.audit.mu.Unlock()
	return len(g.audit.entries)
}

func contains(s string, subs ...string) bool {
	for _, x := range subs {
		if !strings.Contains(s, x) {
			return false
		}
	}
	return true
}
