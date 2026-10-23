package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/audit"
	"github.com/andrejad/overlens/internal/logging"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
	"github.com/andrejad/overlens/internal/webui"
)

// mcpRig is the real router (request logging, the API, and the app's page as the fallback for unknown
// paths) on a temp database, with "today" = day 0 of the test clock.
type mcpRig struct {
	*testutil.Env
	srv *httptest.Server
}

func newMCPRig(t *testing.T, on bool) *mcpRig {
	t.Helper()
	e := testutil.NewEnv(t)
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	root := chi.NewRouter()
	root.Use(logging.Middleware, api.Recover)
	api.New(e.DB, audit.New(e.DB), api.WithMCP(on, "9.9.9"), api.WithClock(func() time.Time { return e.Clock.Day(0) })).Register(root)
	webui.Register(root, fstest.MapFS{"index.html": {Data: []byte("<html>the app</html>")}})
	srv := httptest.NewServer(root)
	t.Cleanup(srv.Close)
	return &mcpRig{Env: e, srv: srv}
}

// post sends body to /mcp as a JSON-RPC client would, plus the extra headers.
func (m *mcpRig) post(headers map[string]string, body string) (int, http.Header, []byte) {
	m.T.Helper()
	return m.do("POST", "/mcp", headers, body)
}

func (m *mcpRig) do(method, path string, headers map[string]string, body string) (int, http.Header, []byte) {
	m.T.Helper()
	req, _ := http.NewRequest(method, m.srv.URL+path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		m.T.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, b
}

type rpcReply struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int
		Message string
	} `json:"error"`
}

// rpc sends one JSON-RPC request and returns the decoded answer.
func (m *mcpRig) rpc(headers map[string]string, method string, params any) rpcReply {
	m.T.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	status, h, raw := m.post(headers, string(b))
	if status != 200 {
		m.T.Fatalf("%s: status %d: %s", method, status, raw)
	}
	if h.Get("Content-Type") != "application/json" || h.Get("Mcp-Session-Id") != "" {
		m.T.Fatalf("%s: want one application/json message and no session, got %q session %q", method, h.Get("Content-Type"), h.Get("Mcp-Session-Id"))
	}
	var r rpcReply
	if err := json.Unmarshal(raw, &r); err != nil {
		m.T.Fatalf("%s: not JSON %q: %v", method, raw, err)
	}
	return r
}

// toolResult is what tools/call returns.
type toolResult struct {
	IsError bool `json:"isError"`
	Content []struct{ Type, Text string }
}

// call runs a tool and returns its isError flag and its text; with isError false the text is JSON.
func (m *mcpRig) call(headers map[string]string, tool string, args any) (bool, string) {
	m.T.Helper()
	r := m.rpc(headers, "tools/call", map[string]any{"name": tool, "arguments": args})
	if r.Error != nil {
		m.T.Fatalf("%s: JSON-RPC error %+v, want a tool result", tool, r.Error)
	}
	var tr toolResult
	if err := json.Unmarshal(r.Result, &tr); err != nil || len(tr.Content) != 1 || tr.Content[0].Type != "text" {
		m.T.Fatalf("%s: want one text block, got %s", tool, r.Result)
	}
	return tr.IsError, tr.Content[0].Text
}

// ok runs a tool that must succeed and decodes its JSON answer into T.
func mcpOK[T any](m *mcpRig, tool string, args any) T {
	m.T.Helper()
	isErr, text := m.call(nil, tool, args)
	if isErr {
		m.T.Fatalf("%s: %s", tool, text)
	}
	var v T
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		m.T.Fatalf("%s: answer is not JSON: %q", tool, text)
	}
	return v
}

// setOwnerStatus writes an owner and a status straight to the test database.
func (m *mcpRig) setOwnerStatus(kind string, id int64, owner, status string) {
	m.T.Helper()
	table := map[string]string{store.KindDeliverable: "deliverables", store.KindMilestone: "milestones"}[kind]
	if _, err := m.DB.Exec(`UPDATE `+table+` SET responsible_person=?, status=? WHERE id=?`, owner, status, id); err != nil {
		m.T.Fatal(err)
	}
}
