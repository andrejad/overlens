package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/auth"
)

// deadlineWriter records every SetWriteDeadline call, so a test can see a CSV handler extending it.
type deadlineWriter struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (d *deadlineWriter) SetWriteDeadline(t time.Time) error {
	d.deadlines = append(d.deadlines, t)
	return nil
}

func Test_REQ_OVR_013_REQ_API_016_csv_extends_the_write_deadline_per_page(t *testing.T) {
	g := newRig(t)
	for i := 0; i < 1203; i++ { // three pages of 500
		seedAudit(g, "2030-02-01 00:00:00", "ann", "team.update", "team", `{}`)
	}
	req := httptest.NewRequest("GET", "/api/admin/audit/export.csv", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: g.cookie})
	w := &deadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	g.root.ServeHTTP(w, req)
	if w.Code != 200 || len(w.deadlines) != 3 {
		t.Fatalf("status %d, %d deadline extensions, want 3", w.Code, len(w.deadlines))
	}
	for _, d := range w.deadlines {
		if left := time.Until(d); left < 55*time.Second || left > 61*time.Second {
			t.Errorf("deadline %v ahead, want about 60s", left)
		}
	}
}

func Test_REQ_OVR_013_roadmap_csv_extends_the_write_deadline(t *testing.T) {
	g := newRig(t)
	_, rm := g.richRoadmap()
	req := httptest.NewRequest("GET", "/api/roadmaps/"+id(rm.ID)+"/export.csv", nil)
	w := &deadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	g.root.ServeHTTP(w, req)
	if w.Code != 200 || len(w.deadlines) < 1 {
		t.Fatalf("status %d, %d deadline extensions", w.Code, len(w.deadlines))
	}
}
