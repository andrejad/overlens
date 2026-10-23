package logging

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// REQ_DEPLOY_009: the container's health check calls /health constantly, so its request line is DEBUG,
// not INFO; every other path still logs at INFO.
func Test_REQ_DEPLOY_009_health_request_line_is_debug_only(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	run := func(level slog.Level, path string) string {
		var buf bytes.Buffer
		slog.SetDefault(slog.New(idHandler{slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: level})}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
		return buf.String()
	}
	if out := run(slog.LevelInfo, "/health"); strings.Contains(out, "path=/health") {
		t.Errorf("/health logged at INFO: %s", out)
	}
	if out := run(slog.LevelDebug, "/health"); !strings.Contains(out, "path=/health") {
		t.Errorf("/health missing at DEBUG: %s", out)
	}
	if out := run(slog.LevelInfo, "/api/teams"); !strings.Contains(out, "path=/api/teams") {
		t.Errorf("/api/teams not logged at INFO: %s", out)
	}
}
