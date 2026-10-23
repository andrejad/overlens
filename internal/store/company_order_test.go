package store_test

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"

	"modernc.org/sqlite"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_API_036_REQ_DAT_006_names_merge_by_one_canonical_fold: names are trimmed and lower-cased rune by rune
// (not strings.ToLower's whole-string rules, not SQLite's ASCII NOCASE) in the merge, 'first spelling
// wins', the saved-order match and the PUT duplicate check.
func Test_REQ_API_036_REQ_DAT_006_names_merge_by_one_canonical_fold(t *testing.T) {
	e := testutil.NewEnv(t)
	ctx := context.Background()
	var rms []testutil.Roadmap
	for i := 0; i < 3; i++ {
		rms = append(rms, e.Roadmap(e.Team(testutil.TeamOpts{}), testutil.RoadmapOpts{}))
	}
	// across roadmaps: ' infra' / 'Infra' / 'infra ' are one workstream, the first spelling (trimmed) wins
	e.Workstream(rms[0], " infra")
	e.Workstream(rms[1], "Infra")
	e.Workstream(rms[2], "infra ")
	// 'Ärzte' and 'ärzte' differ for SQLite NOCASE, so one roadmap may hold both; they stay two
	// workstreams there and merge into one row of the company order
	e.Workstream(rms[0], "Ärzte")
	e.Workstream(rms[0], "ärzte")
	// Greek: per-rune folding leaves final sigma alone, so 'ΑΣ' (-> 'ασ') and 'ας' are different names
	e.Workstream(rms[1], "ΑΣ")
	e.Workstream(rms[1], "ας")
	// Kelvin sign U+212A lower-cases to ASCII 'k'
	e.Workstream(rms[1], "Kelvin")
	e.Workstream(rms[2], "kelvin")

	got, err := store.WorkstreamOrderGet(ctx, e.DB)
	if err != nil {
		t.Fatal(err)
	}
	// alphabetical by folded key, code point order
	want := []string{"General", "infra", "Kelvin", "Ärzte", "ας", "ΑΣ"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged order %q, want %q", got, want)
	}

	// saved order matches by the same fold, and the roadmaps' spelling is what is listed
	ch, err := store.WorkstreamOrderSet(ctx, e.DB, []string{" KELVIN ", "ÄRZTE", "INFRA"})
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"Kelvin", "Ärzte", "infra", "General", "ας", "ΑΣ"}
	if !reflect.DeepEqual(ch.To, want) {
		t.Errorf("after PUT %q, want %q", ch.To, want)
	}

	// duplicates by the fold are refused; names the per-rune fold keeps apart are accepted
	for _, dup := range [][]string{{"infra", " Infra "}, {"Ärzte", "ärzte"}, {"ΑΣ", "ασ"}, {"kelvin", "Kelvin"}} {
		if _, err := store.WorkstreamOrderSet(ctx, e.DB, dup); err == nil {
			t.Errorf("%q accepted, want a duplicate error", dup)
		}
	}
	if _, err := store.WorkstreamOrderSet(ctx, e.DB, []string{"ΑΣ", "ας"}); err != nil {
		t.Errorf("'ΑΣ' and 'ας' are distinct names: %v", err)
	}
}

// companyStatements builds `teams` teams (each with its roadmap holding `delivs` deliverables and a
// milestone) and returns how many statements CompanyRoadmaps ran.
func companyStatements(t *testing.T, teams, delivs int) int64 {
	t.Helper()
	e := testutil.NewEnv(t)
	for i := 0; i < teams; i++ {
		tm := e.Team(testutil.TeamOpts{})
		active := e.Roadmap(tm, testutil.RoadmapOpts{})
		for k := 0; k < delivs; k++ {
			e.Deliverable(active, testutil.DeliverableOpts{StartDay: k * 10, EndDay: k*10 + 5})
		}
		e.Milestone(active, testutil.MilestoneOpts{Day: 1})
	}
	var n atomic.Int64
	db := sql.OpenDB(countingConnector{dsn: e.Path, n: &n})
	db.SetMaxOpenConns(1)
	defer db.Close()
	items, err := store.CompanyRoadmaps(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != teams {
		t.Fatalf("bands %d, want %d", len(items), teams)
	}
	for _, it := range items {
		if len(it.Roadmap.Deliverables) != delivs || len(it.Roadmap.Milestones) != 1 {
			t.Fatalf("band without its roadmap in full: %+v", it.Team)
		}
	}
	return n.Load()
}

// Test_REQ_API_037_company_roadmaps_single_request_statement_count: the company view is one request and
// one transaction and its statement count is a fixed number: it does not depend on the number of teams,
// roadmaps or deliverables. Statements are counted by a wrapping driver.
func Test_REQ_API_037_company_roadmaps_single_request_statement_count(t *testing.T) {
	const budget = 12 // BEGIN, COMMIT and one read per table: 10 today
	small := companyStatements(t, 2, 1)
	large := companyStatements(t, 25, 5)
	t.Logf("company roadmaps: %d statements for 2 teams, %d for 25 teams", small, large)
	if small != large {
		t.Errorf("statements grow with the data: %d for 2 teams x 1 deliverable, %d for 25 teams x 5", small, large)
	}
	if large > budget {
		t.Errorf("%d statements, want at most %d", large, budget)
	}
}

// Test_REQ_API_037_property_batched_matches_per_team: for random data (teams with empty and full
// roadmaps, workstreams, deliverables in several workstreams, milestones, dependencies of every kind
// across teams) the batched CompanyRoadmaps answer is byte-for-byte what loading each team's roadmap
// with RoadmapFullGet gives. TEST_SEED replays.
func Test_REQ_API_037_property_batched_matches_per_team(t *testing.T) {
	for i := 0; i < 8; i++ { // each scenario has its own Env and seed; TEST_SEED replays one
		t.Run(fmt.Sprintf("scenario%d", i), batchedMatchesPerTeam)
	}
}

func batchedMatchesPerTeam(t *testing.T) {
	e := testutil.NewEnv(t)
	ctx := context.Background()
	rng := e.RNG
	type item struct {
		kind string
		id   int64
	}
	var items []item
	for i, nt := 0, 2+rng.Intn(6); i < nt; i++ {
		tm := e.Team(testutil.TeamOpts{})
		// a team's roadmap stays empty or gets content
		r := e.Roadmap(tm, testutil.RoadmapOpts{})
		if rng.Intn(4) > 0 {
			ws := []int64{}
			for k, n := 0, rng.Intn(3); k < n; k++ {
				ws = append(ws, e.Workstream(r, "").ID)
			}
			for k, n := 0, rng.Intn(7); k < n; k++ {
				st := rng.Intn(3*365 - 60)
				o := testutil.DeliverableOpts{StartDay: st, EndDay: st + 1 + rng.Intn(59)}
				if len(ws) > 0 && rng.Intn(2) == 0 {
					o.WorkstreamIDs = ws[:1+rng.Intn(len(ws))]
				}
				items = append(items, item{store.KindDeliverable, e.Deliverable(r, o).ID})
			}
			for k, n := 0, rng.Intn(4); k < n; k++ {
				items = append(items, item{store.KindMilestone, e.Milestone(r, testutil.MilestoneOpts{Day: rng.Intn(3*365 - 60)}).ID})
			}
		}
	}
	for tries := 0; tries < 80 && len(items) > 1; tries++ { // an edge that breaks a rule is refused and skipped
		f, g := items[rng.Intn(len(items))], items[rng.Intn(len(items))]
		_, err := store.DependencyAddItems(ctx, e.DB, store.ItemRef{Kind: g.kind, ID: g.id}, store.ItemRef{Kind: f.kind, ID: f.id}, "from_id")
		var se *store.Error
		if err != nil && !(errors.As(err, &se) && (se.Kind == store.Conflict || se.Kind == store.Invalid)) {
			t.Fatalf("adding an edge failed for a reason other than a broken rule: %v", err)
		}
	}

	got, err := store.CompanyRoadmaps(ctx, e.DB)
	if err != nil {
		t.Fatal(err)
	}
	order, err := store.TeamOrderGet(ctx, e.DB)
	if err != nil {
		t.Fatal(err)
	}
	want := []store.CompanyTeam{}
	for _, ref := range order {
		tm, err := store.TeamGet(ctx, e.DB, ref.ID)
		if err != nil {
			t.Fatal(err)
		}
		f, err := store.RoadmapFullGet(ctx, e.DB, tm.RoadmapID)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, store.CompanyTeam{Team: tm, Roadmap: f})
	}
	gj, _ := json.Marshal(got)
	wj, _ := json.Marshal(want)
	if string(gj) != string(wj) {
		t.Errorf("batched answer differs from per-team loading\n got %s\nwant %s", gj, wj)
	}
	edges := 0
	for _, ct := range got {
		edges += len(ct.Roadmap.Dependencies)
	}
	t.Logf("%d bands, %d items, %d edge entries", len(got), len(items), edges)
}

// countingConnector counts every statement run on the connections it opens, and the rows read
// from queries when rows is set.
type countingConnector struct {
	dsn  string
	n    *atomic.Int64
	rows *atomic.Int64
	sqls *sqlLog // when set, the text and arguments of every query are recorded
}

// sqlLog records the queries run through a countingConnector.
type sqlLog struct {
	mu      sync.Mutex
	queries []loggedQuery
}
type loggedQuery struct {
	sql  string
	args []any
}

func (l *sqlLog) add(q string, a []driver.NamedValue) {
	args := make([]any, len(a))
	for i, v := range a {
		args[i] = v.Value
	}
	l.mu.Lock()
	l.queries = append(l.queries, loggedQuery{q, args})
	l.mu.Unlock()
}

func (c countingConnector) Connect(context.Context) (driver.Conn, error) {
	inner, err := (&sqlite.Driver{}).Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return &countingConn{inner.(connIface), c.n, c.rows, c.sqls}, nil
}
func (c countingConnector) Driver() driver.Driver { return &sqlite.Driver{} }

type connIface interface {
	driver.Conn
	driver.ConnBeginTx
	driver.QueryerContext
	driver.ExecerContext
}

type countingConn struct {
	connIface
	n    *atomic.Int64
	rows *atomic.Int64
	sqls *sqlLog
}

// countingRows counts the rows handed out.
type countingRows struct {
	driver.Rows
	n *atomic.Int64
}

func (r countingRows) Next(dest []driver.Value) error {
	err := r.Rows.Next(dest)
	if err == nil {
		r.n.Add(1)
	}
	return err
}

func (c *countingConn) Prepare(q string) (driver.Stmt, error) {
	return nil, fmt.Errorf("countingConn: Prepare not expected")
}
func (c *countingConn) QueryContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Rows, error) {
	c.n.Add(1)
	if c.sqls != nil {
		c.sqls.add(q, a)
	}
	rs, err := c.connIface.QueryContext(ctx, q, a)
	if err == nil && c.rows != nil {
		rs = countingRows{rs, c.rows}
	}
	return rs, err
}
func (c *countingConn) ExecContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Result, error) {
	c.n.Add(1)
	return c.connIface.ExecContext(ctx, q, a)
}
