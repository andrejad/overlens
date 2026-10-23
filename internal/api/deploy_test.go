package api_test

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/testutil"
)

// REQ_DEPLOY_009: 200 {"status":"ok","version":...} with no login and no session lookup (it still answers with the
// sessions table gone), 503 with the plain text "database unreachable" when the database can't be read.
func Test_REQ_DEPLOY_009_health_ok_without_sessions_and_503_when_unreadable(t *testing.T) {
	env := testutil.NewEnv(t)
	if _, err := env.DB.Exec(`DROP TABLE sessions`); err != nil {
		t.Fatal(err)
	}
	h := api.Health(env.DB, "1.2.3")
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest("GET", "/health", nil))
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"status":"ok","version":"1.2.3"}` {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
	env.DB.Close()
	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest("GET", "/health", nil))
	if rec.Code != 503 || strings.TrimSpace(rec.Body.String()) != "database unreachable" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("closed database: %d %q", rec.Code, rec.Body.String())
	}
}
