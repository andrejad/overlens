package api_test

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_DAT_016_dates_are_exact_days: a date is stored and returned as the very day that was sent, whatever
// weekday or month position it has (never moved to a Monday or the first of a month), and anything that is not an
// exact day (a month, a week, a time of day) is refused instead of being rounded.
func Test_REQ_DAT_016_dates_are_exact_days(t *testing.T) {
	g := newRig(t)
	rm := g.Roadmap(g.Team(testTeamOpts("", "")), testutil.RoadmapOpts{})
	ws := g.firstWorkstreamOf(rm.ID)

	// one start on each weekday: stored as sent
	for i := 0; i < 7; i++ {
		start, end := g.Clock.Date(100+i), g.Clock.Date(100+i+3)
		d := must[store.Deliverable](g, 201, "POST", "/api/roadmaps/"+id(rm.ID)+"/deliverables",
			map[string]any{"name": "Exact", "start_date": start, "end_date": end, "workstream_ids": []int64{ws}})
		got := must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(d.ID), nil)
		if got.StartDate != start || got.EndDate != end {
			t.Errorf("sent %s..%s, stored %s..%s", start, end, got.StartDate, got.EndDate)
		}
	}
	m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm.ID)+"/milestones",
		map[string]any{"name": "Marker", "date": g.Clock.Date(200), "workstream_id": ws}) // clear of the bars above (REQ_API_051)
	if got := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"date": g.Clock.Date(201)}); got.Date != g.Clock.Date(201) {
		t.Errorf("milestone moved by one day: stored %s, want %s", got.Date, g.Clock.Date(201))
	}

	// not an exact day: refused, never rounded
	for _, bad := range []string{g.Clock.Date(100)[:7], g.Clock.Date(100)[:4], g.Clock.Date(100) + "T10:00:00Z", "2026-W03", "2026-02-30"} {
		status, _ := call[errResp](g, "POST", "/api/roadmaps/"+id(rm.ID)+"/milestones",
			map[string]any{"name": "Bad", "date": bad, "workstream_id": ws})
		if status != 422 && status != 400 {
			t.Errorf("date %q: status %d, want a refusal", bad, status)
		}
	}
}
