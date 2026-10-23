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

// Test_REQ_CFG_009_debug_capture_is_bounded_and_the_handler_gets_the_whole_body.
func Test_REQ_CFG_009_debug_capture_is_bounded_and_the_handler_gets_the_whole_body(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	big := strings.Repeat("z", 3<<20)
	var got int
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = len(b)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/teams", strings.NewReader(big)))
	if got != len(big) {
		t.Errorf("handler saw %d bytes, want %d", got, len(big))
	}
	if n := strings.Count(buf.String(), "z"); n > maxBodyLogChars+50 || n < 900 {
		t.Errorf("log holds %d body characters, want about %d", n, maxBodyLogChars)
	}
}
