package testutil

import (
	"context"
	"fmt"

	"github.com/andrejad/overlens/internal/store"
)

// Milestone is a handle to a milestone built by Env.Milestone.
type Milestone struct {
	ID        int64
	RoadmapID int64
	Name      string
	Date      string // ISO
	Day       int    // offset from the env clock
}

// MilestoneOpts: Day is an offset from the clock. If WorkstreamID is 0 the roadmap's first workstream is used.
type MilestoneOpts struct {
	Name         string
	Day          int
	WorkstreamID int64
}

// Milestone goes through store.MilestoneCreate, the entry point POST .../milestones uses.
func (e *Env) Milestone(r Roadmap, o MilestoneOpts) Milestone {
	e.T.Helper()
	if o.Name == "" {
		o.Name = fmt.Sprintf("Milestone %d", e.next())
	}
	ws := o.WorkstreamID
	if ws == 0 {
		ws = e.firstWorkstream(r)
	}
	date := e.Clock.Date(o.Day)
	m, _, _, err := store.MilestoneCreate(context.Background(), e.DB, r.ID, store.MilestoneInput{Name: &o.Name, Date: &date, WorkstreamID: &ws})
	e.check(err)
	return Milestone{ID: m.ID, RoadmapID: r.ID, Name: m.Name, Date: m.Date, Day: o.Day}
}

// ItemDependency makes the item `to` depend on `from`, either a deliverable or a milestone, through the
// real store function (date rule, cycle check and self check apply as in the API).
func (e *Env) ItemDependency(fromKind string, fromID int64, toKind string, toID int64) {
	e.T.Helper()
	_, err := store.DependencyAddItems(context.Background(), e.DB,
		store.ItemRef{Kind: toKind, ID: toID}, store.ItemRef{Kind: fromKind, ID: fromID}, "from_id")
	e.check(err)
}

// DanglingMilestoneDependencies counts dependencies rows with an end that no longer exists
// (the table has no foreign key, so deletes must clean it up in code; REQ_DEP_029).
func (e *Env) DanglingMilestoneDependencies() int {
	e.T.Helper()
	var n int
	err := e.DB.QueryRow(`SELECT COUNT(*) FROM dependencies x WHERE
	  (x.from_kind='deliverable' AND NOT EXISTS (SELECT 1 FROM deliverables WHERE id=x.from_id)) OR
	  (x.from_kind='milestone'   AND NOT EXISTS (SELECT 1 FROM milestones   WHERE id=x.from_id)) OR
	  (x.to_kind='deliverable'   AND NOT EXISTS (SELECT 1 FROM deliverables WHERE id=x.to_id)) OR
	  (x.to_kind='milestone'     AND NOT EXISTS (SELECT 1 FROM milestones   WHERE id=x.to_id))`).Scan(&n)
	e.check(err)
	return n
}

// RowOverlaps lists every pair of roadmap items sharing a workstream row on at least one day (both end
// days count, a milestone holds its one day) — an oracle of its own, independent of the store's check
// (REQ_FE_010, REQ_API_051). Empty means the database holds no overlap.
func (e *Env) RowOverlaps() []string {
	e.T.Helper()
	rows, err := e.DB.Query(`WITH p AS (
	    SELECT 'deliverable' k, d.id i, dw.workstream_id w, dw.row r, d.start_date s, d.end_date e
	      FROM deliverable_workstreams dw JOIN deliverables d ON d.id=dw.deliverable_id
	    UNION ALL SELECT 'milestone', id, workstream_id, row, date, date FROM milestones)
	  SELECT a.k || ' ' || a.i || ' and ' || b.k || ' ' || b.i || ' in workstream ' || a.w || ' row ' || a.r
	  FROM p a JOIN p b ON a.w=b.w AND a.r=b.r AND (a.k < b.k OR (a.k=b.k AND a.i < b.i)) AND a.s<=b.e AND b.s<=a.e`)
	e.check(err)
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		e.check(rows.Scan(&s))
		out = append(out, s)
	}
	e.check(rows.Err())
	return out
}
