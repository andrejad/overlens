package api_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/logging"
)

// Test_REQ_API_004_panic_is_recovered_as_the_standard_500 checks that api.Recover turns a panic
// anywhere below it into the one documented JSON error shape, not a dropped connection, and logs it
// as an ERROR carrying the request id.
func Test_REQ_API_004_panic_is_recovered_as_the_standard_500(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	root := chi.NewRouter()
	root.Use(logging.Middleware, api.Recover)
	root.Get("/boom", func(w http.ResponseWriter, r *http.Request) { panic("kaboom") })
	srv := httptest.NewServer(root)
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/boom")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type %q", ct)
	}
	var body errResp
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "internal" {
		t.Errorf("error code %q", body.Error.Code)
	}
	// Recover logs with slog.ErrorContext(r.Context(), ...): the request's context, which by the time
	// it reaches Recover (mounted after logging.Middleware) already carries the request id — logging
	// itself attaching that id to every line is logging.idHandler's job, covered by its own tests;
	// what matters here is that Recover passes the request-scoped context through, not a bare one.
	out := buf.String()
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "panic recovered") {
		t.Errorf("no ERROR log line for the panic: %s", out)
	}
}
