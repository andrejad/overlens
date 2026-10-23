package testutil

import (
	"context"
	"fmt"

	"github.com/andrejad/overlens/internal/store"
)

// Handles: named references returned by builders. Tests use these, never literal ids.
type Team struct {
	ID        int64
	Name, Tag string
	Color     string
}
type Roadmap struct {
	ID     int64
	TeamID int64
	Title  string
}
type Workstream struct {
	ID   int64
	Name string
}
type Deliverable struct {
	ID         int64
	RoadmapID  int64
	Name       string
	Start, End string // ISO dates
	// StartDay/EndDay are offsets from the env clock.
	StartDay, EndDay int
}

// TeamOpts, all optional.
type TeamOpts struct{ Name, Tag, Color string }

// Team goes through store.TeamCreate, the same entry point POST /api/teams uses, so a builder can
// never produce a team the app itself couldn't (REQ_TEST_016).
func (e *Env) Team(o TeamOpts) Team {
	e.T.Helper()
	n := e.next()
	if o.Name == "" {
		o.Name = fmt.Sprintf("Team %d", n)
	}
	if o.Tag == "" {
		o.Tag = tagFor(n)
	}
	in := store.TeamInput{Name: &o.Name, Tag: &o.Tag}
	if o.Color != "" {
		in.DefaultColor = &o.Color
	}
	t := e.mustTeam(store.TeamCreate(context.Background(), e.DB, in))
	return Team{ID: t.ID, Name: t.Name, Tag: t.Tag, Color: t.DefaultColor}
}

type RoadmapOpts struct {
	Title string
}

// Roadmap returns the team's one roadmap, which store.TeamCreate made with the team (REQ_DAT_032,
// with its "General" workstream, REQ_DAT_023), renamed through store.RoadmapRename when Title is
// given. Asking twice for the same team fails the test: a second roadmap can't exist.
func (e *Env) Roadmap(t Team, o RoadmapOpts) Roadmap {
	e.T.Helper()
	if e.roadmapTaken[t.ID] {
		e.T.Fatalf("team %d already has its one roadmap (REQ_DAT_032)", t.ID)
	}
	if e.roadmapTaken == nil {
		e.roadmapTaken = map[int64]bool{}
	}
	e.roadmapTaken[t.ID] = true
	tm, err := store.TeamGet(context.Background(), e.DB, t.ID)
	e.check(err)
	if o.Title == "" {
		o.Title = fmt.Sprintf("Roadmap %d", e.next())
	}
	_, r, _, err := store.RoadmapRename(context.Background(), e.DB, tm.RoadmapID, o.Title)
	e.check(err)
	return Roadmap{ID: r.ID, TeamID: t.ID, Title: r.Title}
}

// Workstream goes through store.WorkstreamCreate.
func (e *Env) Workstream(r Roadmap, name string) Workstream {
	e.T.Helper()
	n := e.next()
	if name == "" {
		name = fmt.Sprintf("Workstream %d", n)
	}
	w, _, _, err := store.WorkstreamCreate(context.Background(), e.DB, r.ID, name)
	e.check(err)
	return Workstream{ID: w.ID, Name: w.Name}
}

// firstWorkstream returns the roadmap's first (lowest-position) workstream — every roadmap built by
// this package has at least one, because a team's roadmap is created with one (REQ_DAT_023).
func (e *Env) firstWorkstream(r Roadmap) int64 {
	e.T.Helper()
	var id int64
	if err := e.DB.QueryRow(`SELECT id FROM workstreams WHERE roadmap_id=? ORDER BY position, id LIMIT 1`, r.ID).Scan(&id); err != nil {
		e.T.Fatalf("roadmap %d has no workstream (should be impossible via store.TeamCreate): %v", r.ID, err)
	}
	return id
}

// DeliverableOpts: days are offsets from the clock. Defaults: starts today, lasts 30 days, and — if
// WorkstreamIDs is empty — is placed in the roadmap's first workstream, so a builder can never
// produce a deliverable with no workstream (REQ_DAT_012, the app itself refuses that).
type DeliverableOpts struct {
	Name             string
	StartDay, EndDay int // EndDay 0 means StartDay+30
	Color            string
	WorkstreamIDs    []int64
}

// Deliverable goes through store.DeliverableCreate, the same entry point POST .../deliverables
// uses: it always carries a workstream, its dates are validated and the roadmap's derived range
// (including any milestones) and the 3-year cap are enforced exactly as they are through the API.
func (e *Env) Deliverable(r Roadmap, o DeliverableOpts) Deliverable {
	e.T.Helper()
	if o.Name == "" {
		o.Name = fmt.Sprintf("Deliverable %d", e.next())
	}
	if o.EndDay == 0 {
		o.EndDay = o.StartDay + 30
	}
	ws := o.WorkstreamIDs
	if len(ws) == 0 {
		ws = []int64{e.firstWorkstream(r)}
	}
	start, end := e.Clock.Date(o.StartDay), e.Clock.Date(o.EndDay)
	in := store.DeliverableInput{Name: &o.Name, StartDate: &start, EndDate: &end, WorkstreamIDs: &ws}
	if o.Color != "" {
		in.Color = &o.Color
	}
	d, _, _, err := store.DeliverableCreate(context.Background(), e.DB, r.ID, in)
	e.check(err)
	return Deliverable{ID: d.ID, RoadmapID: r.ID, Name: d.Name, Start: d.StartDate, End: d.EndDate,
		StartDay: o.StartDay, EndDay: o.EndDay}
}

// Dependency makes `to` depend on `from` (from is the prerequisite) through the real store function,
// so the date rule (REQ_DEP_004), the cycle check and the self-dependency check apply as in the API.
func (e *Env) Dependency(from, to Deliverable) {
	e.T.Helper()
	_, err := store.DependencyAdd(context.Background(), e.DB, to.ID, from.ID)
	e.check(err)
}

// RandomRoadmap builds a valid random roadmap from the env's seeded RNG: 1-6 deliverables inside
// a 3-year window, with dependencies only where the prerequisite ends before the dependent starts.
func (e *Env) RandomRoadmap(t Team) (Roadmap, []Deliverable) {
	e.T.Helper()
	r := e.Roadmap(t, RoadmapOpts{})
	var ds []Deliverable
	for i, n := 0, 1+e.RNG.Intn(6); i < n; i++ {
		s := e.RNG.Intn(3*365 - 60)
		ds = append(ds, e.Deliverable(r, DeliverableOpts{StartDay: s, EndDay: s + 1 + e.RNG.Intn(59)}))
	}
	for i := range ds {
		for j := range ds {
			if i != j && ds[i].EndDay < ds[j].StartDay && e.RNG.Intn(2) == 0 {
				e.Dependency(ds[i], ds[j])
			}
		}
	}
	return r, ds
}

func (e *Env) check(err error) {
	e.T.Helper()
	if err != nil {
		e.T.Fatal(err)
	}
}

func (e *Env) mustTeam(t store.Team, err error) store.Team {
	e.T.Helper()
	e.check(err)
	return t
}
