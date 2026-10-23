package store_test

import (
	"context"
	"database/sql"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// setItem sets owner and status of a roadmap item straight in the test database.
func setItem(t *testing.T, e *testutil.Env, kind string, id int64, owner, status string) {
	t.Helper()
	table := map[string]string{store.KindDeliverable: "deliverables", store.KindMilestone: "milestones"}[kind]
	if _, err := e.DB.Exec(`UPDATE `+table+` SET responsible_person=?, status=? WHERE id=?`, owner, status, id); err != nil {
		t.Fatal(err)
	}
}

type attentionFixture struct {
	e                                 *testutil.Env
	a, b                              testutil.Team
	overdue, atRisk, soon, far, done  testutil.Deliverable
	inProgress, b1, b2, a6            testutil.Deliverable
	mOverdue, mSoon, mFar, mDependent testutil.Milestone
}

// newAttentionFixture builds two teams; "today" is day 0 of the env clock and the due window is 14 days.
func newAttentionFixture(t *testing.T) *attentionFixture {
	e := testutil.NewEnv(t)
	f := &attentionFixture{e: e}
	f.a, f.b = e.Team(testutil.TeamOpts{}), e.Team(testutil.TeamOpts{})
	ra, rb := e.Roadmap(f.a, testutil.RoadmapOpts{}), e.Roadmap(f.b, testutil.RoadmapOpts{})
	d := func(r testutil.Roadmap, name string, s, en int, owner, status string) testutil.Deliverable {
		x := e.Deliverable(r, testutil.DeliverableOpts{Name: name, StartDay: s, EndDay: en})
		setItem(t, e, store.KindDeliverable, x.ID, owner, status)
		return x
	}
	f.overdue = d(ra, "Overdue one", -20, -5, "Ann", "planned")
	f.atRisk = d(ra, "Risky one", 0, 10, "", "at_risk")
	f.soon = d(ra, "Soon one", 0, 11, "Ann", "planned")
	f.far = d(ra, "Far one", 0, 40, "Ann", "planned")
	f.done = d(ra, "Done one", -30, -20, "", "done")
	f.inProgress = d(ra, "Running one", 0, 5, "Ann", "in_progress")
	f.a6 = d(ra, "Chain end", 60, 70, "Ann", "planned")
	f.b1 = d(rb, "Due today", -3, 1, "Bob", "planned")
	if _, err := e.DB.Exec(`UPDATE deliverables SET end_date=? WHERE id=?`, e.Clock.Date(0), f.b1.ID); err != nil { // the builder cannot end on day 0
		t.Fatal(err)
	}
	f.b2 = d(rb, "Middle", 20, 30, "Bob", "planned")
	ms := func(r testutil.Roadmap, name string, day int, owner, status string) testutil.Milestone {
		m := e.Milestone(r, testutil.MilestoneOpts{Name: name, Day: day})
		setItem(t, e, store.KindMilestone, m.ID, owner, status)
		return m
	}
	f.mOverdue = ms(ra, "Past gate", -3, "", "planned") // a new milestone: planned, no owner
	f.mSoon = ms(ra, "Edge gate", 14, "Ann", "planned")
	f.mFar = ms(ra, "Later gate", 15, "Ann", "planned")
	f.mDependent = ms(ra, "Wait gate", 80, "Ann", "planned")
	// atRisk -> b2 -> a6, and atRisk -> mDependent: a cross-team chain that comes back to the own team
	e.Dependency(f.atRisk, f.b2)
	e.Dependency(f.b2, f.a6)
	e.ItemDependency(store.KindDeliverable, f.atRisk.ID, store.KindMilestone, f.mDependent.ID)
	return f
}

func attentionNames(items []store.AttentionItem) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Test_REQ_API_054_attention_signals: each signal, for deliverables and milestones, done roadmap items never
// appear, the due window includes its last day, and the list is ordered by end date, tag, name, id.
func Test_REQ_API_054_attention_signals(t *testing.T) {
	f := newAttentionFixture(t)
	today := f.e.Clock.Date(0)
	items, err := store.CompanyAttention(context.Background(), f.e.DB, today, 14, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Overdue one", "Past gate", "Due today", "Risky one", "Soon one", "Edge gate"}
	if got := attentionNames(items); !equalStrings(got, want) {
		t.Fatalf("attention names %v, want %v", got, want)
	}
	signals := map[string][]string{
		"Overdue one": {"overdue"},
		"Past gate":   {"overdue", "no_owner"},
		"Due today":   {"due_soon"},
		"Risky one":   {"at_risk", "no_owner"},
		"Soon one":    {"due_soon"},
		"Edge gate":   {"due_soon"},
	}
	for _, it := range items {
		if !equalStrings(it.Signals, signals[it.Name]) {
			t.Errorf("%s: signals %v, want %v", it.Name, it.Signals, signals[it.Name])
		}
	}
	gate := items[1]
	if gate.Kind != store.KindMilestone || gate.StartDate != gate.EndDate || gate.EndDate != f.mOverdue.Date || gate.TeamTag != f.a.Tag || gate.RoadmapID == 0 {
		t.Errorf("a milestone's date is its start and end: %+v", gate)
	}
	if items[3].Status != "at_risk" || len(items[3].Workstreams) != 1 || items[3].Workstreams[0] == "" {
		t.Errorf("fields of the at-risk deliverable: %+v", items[3])
	}
	// a shorter window drops the milestone on day 14 and the deliverable ending on day 11 stays out of 5 days
	short, err := store.CompanyAttention(context.Background(), f.e.DB, today, 5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := attentionNames(short); !equalStrings(got, []string{"Overdue one", "Past gate", "Due today", "Risky one"}) {
		t.Errorf("5-day window: %v", got)
	}
}

// Test_REQ_API_055_attention_blocks_across_teams_and_own_team: blocks lists everything that depends on the
// item directly or through a chain, of any team, the item's own team included, ordered by start date.
func Test_REQ_API_055_attention_blocks_across_teams_and_own_team(t *testing.T) {
	f := newAttentionFixture(t)
	items, err := store.CompanyAttention(context.Background(), f.e.DB, f.e.Clock.Date(0), 14, 0)
	if err != nil {
		t.Fatal(err)
	}
	var risky store.AttentionItem
	for _, it := range items {
		if it.ID == f.atRisk.ID && it.Kind == store.KindDeliverable {
			risky = it
		}
		if it.Name != "Risky one" && len(it.Blocks) != 0 || it.Blocks == nil {
			t.Errorf("%s: blocks %v, want a (possibly empty) list with nothing for an item nothing waits on", it.Name, it.Blocks)
		}
	}
	type blk struct {
		kind string
		id   int64
		tag  string
	}
	var got []blk
	for _, b := range risky.Blocks {
		got = append(got, blk{b.Kind, b.ID, b.TeamTag})
	}
	want := []blk{{"deliverable", f.b2.ID, f.b.Tag}, {"deliverable", f.a6.ID, f.a.Tag}, {"milestone", f.mDependent.ID, f.a.Tag}}
	if len(got) != len(want) {
		t.Fatalf("blocks %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("block %d: %v, want %v", i, got[i], want[i])
		}
	}
	b := risky.Blocks[0]
	if b.Name != "Middle" || b.ResponsiblePerson != "Bob" || b.StartDate != f.b2.Start || b.EndDate != f.b2.End || b.RoadmapID == 0 || b.TeamID != f.b.ID {
		t.Errorf("a block carries team, owner, kind and dates: %+v", b)
	}
	m := risky.Blocks[2]
	if m.StartDate != m.EndDate || m.StartDate != f.mDependent.Date {
		t.Errorf("a milestone block has both dates equal to its date: %+v", m)
	}
}

// Test_REQ_API_054_attention_team_filter_and_unknown_team: team_id limits the list to that team's roadmap
// items (blocks still cross teams); an unknown team is the store's not-found error.
func Test_REQ_API_054_attention_team_filter_and_unknown_team(t *testing.T) {
	f := newAttentionFixture(t)
	ctx := context.Background()
	items, err := store.CompanyAttention(ctx, f.e.DB, f.e.Clock.Date(0), 14, f.b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := attentionNames(items); !equalStrings(got, []string{"Due today"}) {
		t.Errorf("team B: %v", got)
	}
	empty, err := store.CompanyAttention(ctx, f.e.DB, f.e.Clock.Date(0), 14, f.a.ID+f.b.ID+100)
	var se *store.Error
	if !errors.As(err, &se) || se.Kind != store.NotFound || empty != nil && len(empty) != 0 {
		t.Errorf("unknown team: %v, want not found", err)
	}
	// a team with nothing to report gets [] and not null
	e := testutil.NewEnv(t)
	tm := e.Team(testutil.TeamOpts{})
	r := e.Roadmap(tm, testutil.RoadmapOpts{})
	x := e.Deliverable(r, testutil.DeliverableOpts{StartDay: 0, EndDay: 100})
	setItem(t, e, store.KindDeliverable, x.ID, "Ann", "planned")
	none, err := store.CompanyAttention(ctx, e.DB, e.Clock.Date(0), 14, tm.ID)
	if err != nil || none == nil || len(none) != 0 {
		t.Errorf("nothing to report: %v %v", none, err)
	}
}

// attentionStatements counts the statements CompanyAttention runs for `teams` teams, each with three
// deliverables, a milestone and a dependency chain.
func attentionStatements(t *testing.T, teams int) int64 {
	t.Helper()
	e := testutil.NewEnv(t)
	for i := 0; i < teams; i++ {
		r := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
		a := e.Deliverable(r, testutil.DeliverableOpts{StartDay: -20, EndDay: -10})
		b := e.Deliverable(r, testutil.DeliverableOpts{StartDay: 0, EndDay: 5})
		e.Deliverable(r, testutil.DeliverableOpts{StartDay: 10, EndDay: 20})
		e.Milestone(r, testutil.MilestoneOpts{Day: 30})
		e.Dependency(a, b)
	}
	var n atomic.Int64
	db := sql.OpenDB(countingConnector{dsn: e.Path, n: &n})
	db.SetMaxOpenConns(1)
	defer db.Close()
	items, err := store.CompanyAttention(context.Background(), db, e.Clock.Date(0), 14, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) < teams {
		t.Fatalf("only %d attention items for %d teams", len(items), teams)
	}
	return n.Load()
}

// Test_REQ_API_054_attention_statement_count_does_not_grow: the number of statements is the same for 2 and
// 25 teams, and small (BEGIN, COMMIT and one read per table).
func Test_REQ_API_054_attention_statement_count_does_not_grow(t *testing.T) {
	const budget = 14
	small, large := attentionStatements(t, 2), attentionStatements(t, 25)
	t.Logf("attention: %d statements for 2 teams, %d for 25 teams", small, large)
	if small != large {
		t.Errorf("statements grow with the data: %d for 2 teams, %d for 25", small, large)
	}
	if large > budget {
		t.Errorf("%d statements, want at most %d", large, budget)
	}
}

// Test_REQ_API_054_attention_white_space_owner_is_no_owner: an owner that is only white space counts as none
// (a done item still never appears).
func Test_REQ_API_054_attention_white_space_owner_is_no_owner(t *testing.T) {
	e := testutil.NewEnv(t)
	r := e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{})
	blank := e.Deliverable(r, testutil.DeliverableOpts{Name: "Blank owner", StartDay: 0, EndDay: 100})
	named := e.Deliverable(r, testutil.DeliverableOpts{Name: "Named owner", StartDay: 0, EndDay: 100})
	done := e.Deliverable(r, testutil.DeliverableOpts{Name: "Done blank", StartDay: 0, EndDay: 100})
	setItem(t, e, store.KindDeliverable, blank.ID, " \t\u00a0 ", "planned")
	setItem(t, e, store.KindDeliverable, named.ID, " Ann ", "planned")
	setItem(t, e, store.KindDeliverable, done.ID, "  ", "done")
	items, err := store.CompanyAttention(context.Background(), e.DB, e.Clock.Date(0), 14, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := attentionNames(items); !equalStrings(got, []string{"Blank owner"}) || items[0].Signals[0] != "no_owner" {
		t.Errorf("attention %v, want only the blank-owner item with no_owner", got)
	}
}
