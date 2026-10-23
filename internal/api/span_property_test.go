package api_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_TEST_018_three_year_cap_holds_on_random_roadmaps is the seeded random-roadmap test for the
// 3-year cap (REQ_DAT_015, REQ_API_014): random creates and date changes of deliverables and milestones
// through the real API, aimed at the cap's edge. A small model of the roadmap's dates decides what the
// server must do: a write that leaves the earliest-to-latest span within 3 calendar years is accepted and
// stored; any other is refused with 409 span_exceeded and changes nothing. The failure message names
// the seed; TEST_SEED=<n> replays the run exactly (NewEnv also logs it).
func Test_REQ_TEST_018_three_year_cap_holds_on_random_roadmaps(t *testing.T) {
	g := newRig(t)
	rng := g.RNG
	t.Logf("seed %d (replay with TEST_SEED=%d)", g.Seed, testutil.MasterSeed())
	rm := g.Roadmap(g.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
	ws := g.firstWorkstreamOf(rm.ID)

	type span struct{ s, e int } // day offsets from the test clock
	dels := map[int64]span{}
	mss := map[int64]int{}

	// the model's verdict for the current state plus extra dates: earliest to latest may not pass 3 years
	withinCap := func(extra ...span) bool {
		lo, hi, seen := 0, 0, false
		add := func(s, e int) {
			if !seen || s < lo {
				lo = s
			}
			if !seen || e > hi {
				hi = e
			}
			seen = true
		}
		for _, d := range dels {
			add(d.s, d.e)
		}
		for _, m := range mss {
			add(m, m)
		}
		for _, x := range extra {
			add(x.s, x.e)
		}
		return !g.Clock.Day(hi).After(g.Clock.Day(lo).AddDate(3, 0, 0))
	}
	// a date offset near the cap's edge: the roadmap's earliest + 3 years +/- a few days
	edge := func() int {
		lo := 0
		for _, d := range dels {
			lo = min(lo, d.s)
		}
		for _, m := range mss {
			lo = min(lo, m)
		}
		return int(g.Clock.Day(lo).AddDate(3, 0, 0).Sub(g.Clock.Day(0)).Hours()/24) + rng.Intn(7) - 3
	}
	day := func() int {
		if rng.Intn(2) == 0 {
			return edge()
		}
		return rng.Intn(1500) - 200
	}

	// every item gets a workstream of its own, so a random date never meets a neighbour in its row: this test is
	// about the 3-year cap only, and row overlaps (REQ_API_051) have their own randomized test
	own := func(step int) int64 { return g.newWorkstream(rm.ID, fmt.Sprintf("W%d", step)).ID }

	accepted, refused := 0, 0
	check := func(step int, what string, status int, code string, ok bool) {
		t.Helper()
		switch {
		case ok && (status == 200 || status == 201):
			accepted++
		case !ok && status == 409 && code == "span_exceeded":
			refused++
		default:
			t.Fatalf("step %d %s: status %d (%s), the model says the write is %s (replay with TEST_SEED=%d)", step, what, status, code, map[bool]string{true: "allowed", false: "over the cap"}[ok], testutil.MasterSeed())
		}
		// whatever happened, the server holds exactly the model's dates and never a span over 3 years
		full := g.roadmap(rm.ID)
		if len(full.Deliverables) != len(dels) || len(full.Milestones) != len(mss) {
			t.Fatalf("step %d %s: server holds %d deliverables and %d milestones, model %d and %d (replay with TEST_SEED=%d)", step, what, len(full.Deliverables), len(full.Milestones), len(dels), len(mss), testutil.MasterSeed())
		}
		for _, d := range full.Deliverables {
			if want := dels[d.ID]; d.StartDate != g.Clock.Date(want.s) || d.EndDate != g.Clock.Date(want.e) {
				t.Fatalf("step %d %s: deliverable %d stored %s..%s, model %s..%s (replay with TEST_SEED=%d)", step, what, d.ID, d.StartDate, d.EndDate, g.Clock.Date(want.s), g.Clock.Date(want.e), testutil.MasterSeed())
			}
		}
		for _, m := range full.Milestones {
			if m.Date != g.Clock.Date(mss[m.ID]) {
				t.Fatalf("step %d %s: milestone %d stored %s, model %s (replay with TEST_SEED=%d)", step, what, m.ID, m.Date, g.Clock.Date(mss[m.ID]), testutil.MasterSeed())
			}
		}
		if full.RangeStart != nil && full.RangeEnd != nil {
			s, _ := time.Parse("2006-01-02", *full.RangeStart)
			e, _ := time.Parse("2006-01-02", *full.RangeEnd)
			if e.After(s.AddDate(3, 0, 0)) {
				t.Fatalf("step %d %s: stored range %s..%s is over 3 years (replay with TEST_SEED=%d)", step, what, *full.RangeStart, *full.RangeEnd, testutil.MasterSeed())
			}
		}
	}

	// a first deliverable so there is a range to push against
	first := g.newDeliverable(rm.ID, []int64{ws}, 0, 10, nil)
	dels[first.ID] = span{0, 10}
	delIDs := []int64{first.ID}
	var msIDs []int64

	for step := 0; step < 300; step++ {
		var what string
		var status int
		var e errResp
		var ok bool
		switch op := rng.Intn(10); {
		case op < 3: // new deliverable
			s := day()
			end := s + rng.Intn(120)
			ok, what = withinCap(span{s, end}), fmt.Sprintf("create deliverable %d..%d", s, end)
			body := map[string]any{"name": "D", "start_date": g.Clock.Date(s), "end_date": g.Clock.Date(end), "workstream_ids": []int64{own(step)}}
			var d store.Deliverable
			status, d = call[store.Deliverable](g, "POST", "/api/roadmaps/"+id(rm.ID)+"/deliverables", body)
			if status == 201 {
				dels[d.ID] = span{s, end}
				delIDs = append(delIDs, d.ID)
			} else {
				_, e = call[errResp](g, "POST", "/api/roadmaps/"+id(rm.ID)+"/deliverables", body)
			}
		case op < 4: // new milestone
			m := day()
			ok, what = withinCap(span{m, m}), fmt.Sprintf("create milestone %d", m)
			body := map[string]any{"name": "M", "date": g.Clock.Date(m), "workstream_id": own(step)}
			var ms store.Milestone
			status, ms = call[store.Milestone](g, "POST", "/api/roadmaps/"+id(rm.ID)+"/milestones", body)
			if status == 201 {
				mss[ms.ID] = m
				msIDs = append(msIDs, ms.ID)
			} else {
				_, e = call[errResp](g, "POST", "/api/roadmaps/"+id(rm.ID)+"/milestones", body)
			}
		case op < 5 && len(msIDs) > 0: // move a milestone
			mid := msIDs[rng.Intn(len(msIDs))]
			m := day()
			old := mss[mid]
			delete(mss, mid)
			ok = withinCap(span{m, m})
			mss[mid] = old
			what = fmt.Sprintf("move milestone %d to %d", mid, m)
			status, e = call[errResp](g, "PATCH", "/api/milestones/"+id(mid), map[string]any{"date": g.Clock.Date(m)})
			if ok {
				mss[mid] = m
			}
		default: // change a deliverable's start, end or both
			did := delIDs[rng.Intn(len(delIDs))]
			cur := dels[did]
			next := cur
			body := map[string]any{}
			switch rng.Intn(3) {
			case 0:
				next.s = min(day(), cur.e)
				body["start_date"] = g.Clock.Date(next.s)
			case 1:
				next.e = max(day(), cur.s)
				body["end_date"] = g.Clock.Date(next.e)
			default:
				next.s = day()
				next.e = next.s + rng.Intn(120)
				body["start_date"], body["end_date"] = g.Clock.Date(next.s), g.Clock.Date(next.e)
			}
			delete(dels, did)
			ok = withinCap(next)
			dels[did] = cur
			what = fmt.Sprintf("patch deliverable %d %v", did, body)
			status, e = call[errResp](g, "PATCH", "/api/deliverables/"+id(did), body)
			if ok {
				dels[did] = next
			}
		}
		check(step, what, status, e.Error.Code, ok)
	}
	if accepted == 0 || refused == 0 {
		t.Errorf("degenerate run: %d accepted, %d refused (replay with TEST_SEED=%d) - the random writes should hit both", accepted, refused, testutil.MasterSeed())
	}
	t.Logf("%d accepted, %d refused", accepted, refused)
}
