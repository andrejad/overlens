package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// REQ_API_051: the company-file loader refuses rows that overlap with the same test as every other write.
func Test_REQ_API_051_company_file_loader_refuses_overlapping_rows(t *testing.T) {
	file := func(secondStart, msDay, msRow int) string {
		return fmt.Sprintf(`{"format": "e-roadmaps/company", "dates": "relative", "anchor": "2026-01-05",
		  "teams": [{"team": {"name": "Alpha", "tag": "ALP"}, "roadmap": {"title": "Plan",
		    "workstreams": [{"name": "One"}],
		    "deliverables": [
		      {"name": "First", "start_date": 0, "end_date": 10, "workstreams": [{"name": "One", "row": 0}]},
		      {"name": "Second", "start_date": %d, "end_date": 20, "workstreams": [{"name": "one", "row": 0}]}],
		    "milestones": [{"name": "Gate", "date": %d, "workstream": "One", "row": %d}]}}]}`, secondStart, msDay, msRow)
	}
	load := func(src string) error {
		e := testutil.NewEnv(t)
		f, err := store.ParseCompanyFile([]byte(src))
		if err != nil {
			t.Fatal(err)
		}
		return store.InTx(context.Background(), e.DB, func(tx *sql.Tx) error {
			_, err := store.ImportCompanyTx(context.Background(), tx, f, e.Clock.Now())
			return err
		})
	}
	for _, c := range []struct {
		start, msDay, msRow int
		bad                 string
	}{
		// both end days count, and differently spelt names are one workstream
		{10, 21, 1, `teams[0].roadmap.deliverables[1].workstreams[0].row: overlaps "First" in workstream "One", row 0`},
		{11, 20, 0, `teams[0].roadmap.milestones[0].row: overlaps "Second" in workstream "One", row 0`}, // a milestone holds its day
		{11, 21, 0, ""}, // the days after are free
	} {
		err := load(file(c.start, c.msDay, c.msRow))
		switch {
		case c.bad == "" && err != nil:
			t.Errorf("start %d: refused: %v", c.start, err)
		case c.bad != "" && (err == nil || !strings.Contains(err.Error(), c.bad)):
			t.Errorf("start %d: got %v, want %q", c.start, err, c.bad)
		}
	}
}

// Test_REQ_API_051_random_writes_never_overlap (REQ_TEST_018 style): random creates, changes, workstream
// deletes, moves and deletes of roadmap items, from a seeded generator, with and without explicit rows.
// Whatever is accepted or refused, the database never holds two items in one row on a shared day.
// The seed is printed; TEST_SEED=<n> replays it.
func Test_REQ_API_051_random_writes_never_overlap(t *testing.T) {
	ctx := context.Background()
	e := testutil.NewEnv(t)
	t.Logf("seed %d (replay with TEST_SEED)", e.Seed)
	rng := e.RNG
	var teams []testutil.Team
	for i := 0; i < 2; i++ {
		tm := e.Team(testutil.TeamOpts{})
		rm := e.Roadmap(tm, testutil.RoadmapOpts{})
		e.Workstream(rm, "Two")
		e.Workstream(rm, "Three")
		teams = append(teams, tm)
	}
	ids := func(q string, args ...any) []int64 {
		rows, err := e.DB.Query(q, args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []int64
		for rows.Next() {
			var n int64
			rows.Scan(&n)
			out = append(out, n)
		}
		return out
	}
	pick := func(xs []int64) int64 { return xs[rng.Intn(len(xs))] }
	day := func() *string { s := e.Clock.Date(rng.Intn(120)); return &s }
	row := func() *int { r := rng.Intn(3); return &r }
	roadmapOf := func(table string, id int64) int64 {
		var r int64
		e.DB.QueryRow(`SELECT roadmap_id FROM `+table+` WHERE id=?`, id).Scan(&r)
		return r
	}
	workstreamsOf := func(rm int64) []int64 {
		return ids(`SELECT id FROM workstreams WHERE roadmap_id=? ORDER BY position, id`, rm)
	}
	subset := func(ws []int64) []int64 {
		out := []int64{pick(ws)}
		if w := pick(ws); w != out[0] && rng.Intn(2) == 0 {
			out = append(out, w)
		}
		return out
	}
	rowsFor := func(ws []int64) *map[int64]int {
		m := map[int64]int{}
		for _, w := range ws {
			if rng.Intn(2) == 0 {
				m[w] = *row()
			}
		}
		return &m
	}
	dates := func() (*string, *string) {
		s := rng.Intn(120)
		a, b := e.Clock.Date(s), e.Clock.Date(s+rng.Intn(15))
		return &a, &b
	}
	outcomes := map[string]int{}
	defer func() { t.Logf("outcomes: %v", outcomes) }()
	for step := 0; step < 400; step++ {
		rms := ids(`SELECT id FROM roadmaps ORDER BY id`)
		dels, mss := ids(`SELECT id FROM deliverables ORDER BY id`), ids(`SELECT id FROM milestones ORDER BY id`)
		var err error
		var op string
		switch k := rng.Intn(12); {
		case k < 2 || len(dels) == 0:
			op = "deliverable create"
			rm := pick(rms)
			ws := subset(workstreamsOf(rm))
			name := "D" + strconv.Itoa(step)
			s, en := dates()
			in := store.DeliverableInput{Name: &name, StartDate: s, EndDate: en, WorkstreamIDs: &ws}
			if rng.Intn(2) == 0 {
				in.Rows = rowsFor(ws)
			}
			_, _, _, err = store.DeliverableCreate(ctx, e.DB, rm, in)
		case k < 4 || len(mss) == 0:
			op = "milestone create"
			rm := pick(rms)
			name, ws := "M"+strconv.Itoa(step), pick(workstreamsOf(rm))
			in := store.MilestoneInput{Name: &name, Date: day(), WorkstreamID: &ws}
			if rng.Intn(2) == 0 {
				in.Row = row()
			}
			_, _, _, err = store.MilestoneCreate(ctx, e.DB, rm, in)
		case k < 6:
			op = "deliverable patch"
			id := pick(dels)
			var in store.DeliverableInput
			switch rng.Intn(3) {
			case 0:
				in.StartDate, in.EndDate = dates()
			case 1:
				d, _ := store.DeliverableGet(ctx, e.DB, id)
				in.Rows = rowsFor(d.WorkstreamIDs)
			default:
				ws := subset(workstreamsOf(roadmapOf("deliverables", id)))
				in.WorkstreamIDs = &ws
				if rng.Intn(2) == 0 {
					in.Rows = rowsFor(ws)
				}
			}
			_, _, _, _, _, err = store.DeliverableUpdate(ctx, e.DB, id, in)
		case k < 8:
			op = "milestone patch"
			id := pick(mss)
			var in store.MilestoneInput
			switch rng.Intn(3) {
			case 0:
				in.Date = day()
			case 1:
				in.Row = row()
			default:
				ws := pick(workstreamsOf(roadmapOf("milestones", id)))
				in.WorkstreamID = &ws
				if rng.Intn(2) == 0 {
					in.Row = row()
				}
			}
			_, _, _, _, _, err = store.MilestoneUpdate(ctx, e.DB, id, in)
		case k < 9:
			op = "workstream delete"
			rm := pick(rms)
			ws := workstreamsOf(rm)
			if len(ws) < 3 {
				_, _, _, err = store.WorkstreamCreate(ctx, e.DB, rm, "Extra "+strconv.Itoa(step))
				break
			}
			from, target := ws[0], ws[1+rng.Intn(len(ws)-1)]
			_, _, _, _, _, _, err = store.WorkstreamDelete(ctx, e.DB, from, target)
		case k < 10:
			op = "move"
			kind, id, table := store.KindDeliverable, pick(dels), "deliverables"
			if rng.Intn(2) == 0 {
				kind, id, table = store.KindMilestone, pick(mss), "milestones"
			}
			var other, otherRm int64
			for _, tm := range teams {
				var rm int64
				e.DB.QueryRow(`SELECT id FROM roadmaps WHERE team_id=?`, tm.ID).Scan(&rm)
				if rm != roadmapOf(table, id) {
					other, otherRm = tm.ID, rm
				}
			}
			in := store.MoveInput{TeamID: other}
			from := ids(`SELECT workstream_id FROM deliverable_workstreams WHERE deliverable_id=?`, id)
			if kind == store.KindMilestone {
				from = ids(`SELECT workstream_id FROM milestones WHERE id=?`, id)
			}
			for _, w := range from { // each to a random destination workstream, so a move rarely fails on names
				in.WorkstreamMap = append(in.WorkstreamMap, store.MoveEntry{From: w, To: json.RawMessage(strconv.FormatInt(pick(workstreamsOf(otherRm)), 10))})
			}
			_, err = store.ItemMove(ctx, e.DB, kind, id, in)
		default:
			op = "delete"
			if rng.Intn(2) == 0 {
				_, _, _, _, err = store.DeliverableDelete(ctx, e.DB, pick(dels))
			} else {
				_, _, _, _, err = store.MilestoneDelete(ctx, e.DB, pick(mss))
			}
		}
		var se *store.Error
		switch {
		case err == nil:
			outcomes[op]++
		case errors.As(err, &se):
			outcomes[op+" refused "+se.Code]++
			if strings.HasPrefix(op, "delete") || (op == "workstream delete" && se.Code == "row_overlap") {
				t.Fatalf("step %d: %s refused: %v (seed %d)", step, op, err, e.Seed)
			}
		default:
			t.Fatalf("step %d: %s: %v (seed %d)", step, op, err, e.Seed)
		}
		if bad := e.RowOverlaps(); len(bad) > 0 {
			b, _ := json.Marshal(bad)
			t.Fatalf("step %d: after %s the database overlaps: %s (seed %d)", step, op, b, e.Seed)
		}
	}
	refused := 0
	for k, n := range outcomes {
		if strings.HasSuffix(k, "row_overlap") {
			refused += n
		}
	}
	if refused == 0 {
		t.Errorf("no write was refused for an overlap: the run tested nothing (seed %d)", e.Seed)
	}
}
