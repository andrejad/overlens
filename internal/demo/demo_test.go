package demo

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// fixtureCompany is a tiny company file of the test's own: two teams, three shared workstreams, relative
// dates, a dependency inside a team and one across the two (an external end), and the saved orders.
const fixtureCompany = `{
  "format": "e-roadmaps/company", "dates": "relative", "anchor": "2026-01-05",
  "team_order": ["Beta", "Alpha"], "workstream_order": ["Two", "One", "Three"],
  "teams": [
    {"team": {"name": "Alpha", "tag": "ALP", "default_color": "#3366cc"},
     "roadmap": {"title": "Alpha plan",
       "workstreams": [{"name": "One"}, {"name": "Two"}, {"name": "Three"}],
       "deliverables": [
         {"key": "a1", "name": "A one", "description": "<p>Hello <strong>bold</strong> <em>it</em></p>", "responsible": "Ana",
          "start_date": 0, "end_date": 20, "status": "at_risk", "risk_note": "late vendor", "color": "#cc0000",
          "workstreams": [{"name": "One", "row": 0}, {"name": "Two", "row": 0}], "icons": ["flag"],
          "links": [{"label": "Spec", "url": "https://example.com"}]},
         {"key": "a2", "name": "A two", "start_date": 30, "end_date": 50, "status": "planned", "color": null,
          "workstreams": [{"name": "One", "row": 0}]}],
       "milestones": [{"key": "m1", "name": "Gate", "date": 25, "workstream": "Three", "row": 0}],
       "dependencies": [{"from": "a1", "to": "a2"}]}},
    {"team": {"name": "Beta", "tag": "BET", "default_color": "#22aa66"},
     "roadmap": {"title": "Beta plan",
       "workstreams": [{"name": "One"}, {"name": "Two"}, {"name": "Three"}],
       "deliverables": [
         {"key": "b1", "name": "B one", "start_date": 60, "end_date": 80, "status": "planned",
          "workstreams": [{"name": "Two", "row": 0}]}],
       "milestones": [],
       "dependencies": [{"from": {"external": {"team": "Alpha", "name": "A two"}}, "to": "b1"}]}}
  ]}`

func ensureFixture(t *testing.T, env *testutil.Env, enabled bool, rec Recorder) (bool, error) {
	t.Helper()
	return ensure(context.Background(), env.DB, enabled, env.Clock.Day(0), []byte(fixtureCompany), true, rec)
}

// importCompany loads a company file the way the sample start-up does: in one transaction.
func importCompany(db *sql.DB, f *store.CompanyFile, today time.Time) (res store.CompanyResult, err error) {
	err = store.InTx(context.Background(), db, func(tx *sql.Tx) (err error) {
		res, err = store.ImportCompanyTx(context.Background(), tx, f, today)
		return err
	})
	return
}

func counts(t *testing.T, db *sql.DB) (teams, roadmaps, marks int) {
	t.Helper()
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM teams), (SELECT COUNT(*) FROM roadmaps), (SELECT COUNT(*) FROM meta WHERE key=?)`, MetaKey).
		Scan(&teams, &roadmaps, &marks); err != nil {
		t.Fatal(err)
	}
	return
}

// REQ_DEMO_005: an empty database gets the sample once, with the meta row and one audit record.
func Test_REQ_DEMO_005_REQ_DEMO_015_sample_created_once_on_empty_database(t *testing.T) {
	t.Run("switched off", func(t *testing.T) {
		env := testutil.NewEnv(t)
		if created, err := ensureFixture(t, env, false, nil); created || err != nil {
			t.Fatalf("created=%v err=%v", created, err)
		}
		if teams, _, marks := counts(t, env.DB); teams != 0 || marks != 0 {
			t.Errorf("teams %d marks %d", teams, marks)
		}
	})

	env := testutil.NewEnv(t)
	var audits []map[string]any
	var actions []string
	rec := func(_ context.Context, action string, d map[string]any) error {
		actions = append(actions, action)
		audits = append(audits, d)
		return nil
	}
	created, err := ensureFixture(t, env, true, rec)
	if err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	if teams, roadmaps, marks := counts(t, env.DB); teams != 2 || roadmaps != 2 || marks != 1 {
		t.Fatalf("teams %d roadmaps %d marks %d", teams, roadmaps, marks)
	}
	if len(actions) != 1 || actions[0] != "sample.create" || audits[0]["teams"] != 2 || audits[0]["deliverables"] != 3 ||
		audits[0]["milestones"] != 1 || audits[0]["dependencies"] != 2 {
		t.Errorf("audit: %v %v", actions, audits)
	}
	// a restart changes nothing
	created, err = ensureFixture(t, env, true, rec)
	if err != nil || created || len(actions) != 1 {
		t.Errorf("second start: created=%v err=%v audits=%d", created, err, len(actions))
	}

}

// REQ_DEMO_007 (hard rule): deleting everything by hand never brings the sample back; existing data
// is never touched or counted as "empty".
func Test_REQ_DEMO_007_never_again_and_never_over_existing_data(t *testing.T) {
	env := testutil.NewEnv(t)
	if _, err := ensureFixture(t, env, true, nil); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DELETE FROM dependencies`, `DELETE FROM deliverable_workstreams`, `DELETE FROM deliverables`,
		`DELETE FROM milestones`, `DELETE FROM workstreams`, `DELETE FROM roadmaps`, `DELETE FROM company_team_order`, `DELETE FROM teams`} {
		if _, err := env.DB.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if created, _ := ensureFixture(t, env, true, nil); created {
		t.Error("the sample was created again after a hand-made delete-all")
	}
	if teams, _, _ := counts(t, env.DB); teams != 0 {
		t.Errorf("%d teams", teams)
	}

	// a database with a team (and no meta row) is not empty: nothing is created, nothing is marked
	env2 := testutil.NewEnv(t)
	team := env2.Team(testutil.TeamOpts{Name: "Mine", Tag: "MIN"})
	if created, err := ensureFixture(t, env2, true, nil); created || err != nil {
		t.Fatalf("created=%v err=%v", created, err)
	}
	if teams, roadmaps, marks := counts(t, env2.DB); teams != 1 || roadmaps != 1 || marks != 0 || team.ID == 0 {
		t.Errorf("teams %d roadmaps %d marks %d", teams, roadmaps, marks)
	}
}

// REQ_DEMO_005: a missing or broken sample file writes nothing at all, not even the meta row.
func Test_REQ_DEMO_005_missing_or_broken_sample_writes_nothing(t *testing.T) {
	env := testutil.NewEnv(t)
	if created, err := ensure(context.Background(), env.DB, true, env.Clock.Day(0), nil, false, nil); created || err != nil {
		t.Fatalf("missing: created=%v err=%v", created, err)
	}
	broken := strings.Replace(fixtureCompany, `"end_date": 20`, `"end_date": -5`, 1) // ends before it starts
	created, err := ensure(context.Background(), env.DB, true, env.Clock.Day(0), []byte(broken), true, nil)
	if created || err == nil {
		t.Fatalf("broken: created=%v err=%v", created, err)
	}
	if teams, roadmaps, marks := counts(t, env.DB); teams != 0 || roadmaps != 0 || marks != 0 {
		t.Errorf("a failed sample left %d teams, %d roadmaps, %d marks", teams, roadmaps, marks)
	}
	// and it works afterwards: the failure was not remembered
	if created, err := ensureFixture(t, env, true, nil); !created || err != nil {
		t.Errorf("after the failure: created=%v err=%v", created, err)
	}
}

// REQ_IMP_006 + REQ_IMP_004 + REQ_DEMO_003: the company loader. Dates are relative to the day of loading,
// external ends resolve once every roadmap exists (a missing neighbour fails the load with the edge's path), orders are saved.
func Test_REQ_IMP_006_REQ_IMP_002_REQ_DAT_019_REQ_DEMO_003_company_file_loads_with_relative_dates_and_orders(t *testing.T) {
	t.Run("company file errors have paths", func(t *testing.T) {
		env := testutil.NewEnv(t)
		bad := strings.Replace(fixtureCompany, `"status": "at_risk"`, `"status": "wild"`, 1)
		f, _ := store.ParseCompanyFile([]byte(bad))
		_, err := importCompany(env.DB, f, time.Now())
		if err == nil || !strings.Contains(err.Error(), "teams[0].roadmap.deliverables[0].status") {
			t.Fatalf("%v", err)
		}
		if teams, _, _ := counts(t, env.DB); teams != 0 {
			t.Error("nothing may be written")
		}
		if _, err := store.ParseCompanyFile([]byte(strings.Replace(fixtureCompany, `e-roadmaps/company`, `e-roadmaps/roadmap`, 1))); err == nil {
			t.Error("an unknown format must be refused")
		}
	})

	t.Run("REQ_IMP_003 an external end that matches nothing fails the load with the edge's path", func(t *testing.T) {
		env := testutil.NewEnv(t)
		ghost := strings.Replace(fixtureCompany, `"name": "A two"}}, "to": "b1"}`,
			`"name": "A two"}}, "to": "b1"}, {"from": {"external": {"team": "Ghost", "name": "Missing"}}, "to": "b1"}`, 1)
		if ghost == fixtureCompany {
			t.Fatal("the fixture did not change")
		}
		f, err := store.ParseCompanyFile([]byte(ghost))
		if err != nil {
			t.Fatal(err)
		}
		_, err = importCompany(env.DB, f, time.Now())
		if err == nil || !strings.Contains(err.Error(), "teams[1].roadmap.dependencies[1]") {
			t.Fatalf("%v", err)
		}
		if teams, _, _ := counts(t, env.DB); teams != 0 {
			t.Error("nothing may be written")
		}
	})

	env := testutil.NewEnv(t)
	f, err := store.ParseCompanyFile([]byte(fixtureCompany))
	if err != nil {
		t.Fatal(err)
	}
	today := time.Date(2030, 3, 10, 0, 0, 0, 0, time.UTC)
	res, err := importCompany(env.DB, f, today)
	if err != nil {
		t.Fatal(err)
	}
	if res.Teams != 2 || res.Roadmaps != 2 || res.Counts != (store.ImportCounts{Workstreams: 6, Deliverables: 3, Milestones: 1, Dependencies: 2}) {
		t.Errorf("result %+v", res)
	}
	teams, _, _ := store.TeamsList(context.Background(), env.DB, 50, 0)
	var alpha store.RoadmapFull
	for _, tm := range teams {
		full, err := store.RoadmapFullGet(context.Background(), env.DB, tm.RoadmapID)
		if err != nil {
			t.Fatal(err)
		}
		if tm.Name == "Alpha" {
			alpha = full
		}
		if full.Title != tm.Name+" plan" {
			t.Errorf("%s: roadmap title %q, want the file's", tm.Name, full.Title)
		}
	}
	if d := alpha.Deliverables[0]; d.StartDate != "2030-03-10" || d.EndDate != "2030-03-30" || d.Color != "#cc0000" || d.Status != "at_risk" ||
		len(d.Workstreams) != 2 || d.ResponsiblePerson != "Ana" || len(d.Links) != 1 || !strings.Contains(d.DescriptionHTML, "<strong>bold</strong>") {
		t.Errorf("deliverable: %+v", d)
	}
	if alpha.Deliverables[1].Color != "#3366cc" { // null colour: the team's
		t.Errorf("default colour: %s", alpha.Deliverables[1].Color)
	}
	if alpha.Milestones[0].Date != "2030-04-04" {
		t.Errorf("milestone date %s", alpha.Milestones[0].Date)
	}
	to, err := store.TeamOrderGet(context.Background(), env.DB)
	if err != nil || len(to) != 2 || to[0].Name != "Beta" {
		t.Errorf("team order %+v %v", to, err)
	}
	wo, err := store.WorkstreamOrderGet(context.Background(), env.DB)
	if err != nil || !reflect.DeepEqual(wo, []string{"Two", "One", "Three"}) {
		t.Errorf("workstream order %v %v", wo, err)
	}
	// the cross-team edge is real: Beta's deliverable depends on Alpha's
	edges, err := store.CompanyDependencies(context.Background(), env.DB)
	if err != nil || len(edges) != 2 {
		t.Fatalf("edges %v %v", edges, err)
	}

	// loading again on the same database refuses (duplicate team) and changes nothing
	f2, _ := store.ParseCompanyFile([]byte(fixtureCompany))
	if _, err := importCompany(env.DB, f2, today); err == nil {
		t.Error("loading the same company twice must be refused")
	}
	if n, _, _ := counts(t, env.DB); n != 2 {
		t.Errorf("%d teams after the refused second load", n)
	}

}

// --- the real files: a missing one fails the test -------------------------

func realFile(t *testing.T, rel string) []byte {
	t.Helper()
	root := testutil.RepoRoot(t)
	b, err := os.ReadFile(filepath.Join(root, rel))
	if os.IsNotExist(err) {
		t.Fatalf("%s is missing: the shipped data files must exist, and a skipped check would hide that", rel)
	}
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// loadedCompany loads a company file through the real importer into a fresh database and reads it back.
func loadedCompany(t *testing.T, data []byte) (rms []store.RoadmapFull, res store.CompanyResult) {
	t.Helper()
	env := testutil.NewEnv(t)
	f, err := store.ParseCompanyFile(data)
	if err != nil {
		t.Fatalf("not a valid company file: %v", err)
	}
	if res, err = importCompany(env.DB, f, time.Now()); err != nil {
		t.Fatalf("the importer refuses the file: %v", err)
	}
	teams, _, _ := store.TeamsList(context.Background(), env.DB, 200, 0)
	for _, tm := range teams {
		full, err := store.RoadmapFullGet(context.Background(), env.DB, tm.RoadmapID)
		if err != nil {
			t.Fatal(err)
		}
		rms = append(rms, full)
	}
	return
}

// REQ_DEMO_004 (and 002/003/017): the sample loads through the real importer, so every roadmap rule holds
// (no overlap, dependency order, no loops, 3-year span), and it is in relative dates.
func Test_REQ_DEMO_004_REQ_DEMO_002_REQ_TEST_020_sample_file_satisfies_the_rules(t *testing.T) {
	data := realFile(t, "internal/demo/sample.json")
	if !strings.Contains(string(data), `"relative"`) {
		t.Error("REQ_DEMO_003: the sample must use relative dates")
	}
	if embedded, ok := Sample(); !ok || string(embedded) != string(data) {
		t.Error("REQ_DEMO_002: sample.json is not what the binary embeds")
	}
	rms, _ := loadedCompany(t, data)
	if len(rms) == 0 {
		t.Fatal("no roadmaps")
	}
}

// REQ_DEMO_001: five teams, three shared workstreams, four deliverables per team, five milestones in all.
func Test_REQ_DEMO_001_REQ_DEMO_012_REQ_DEMO_013_sample_shape(t *testing.T) {
	rms, _ := loadedCompany(t, realFile(t, "internal/demo/sample.json"))
	perTeam := map[string]int{}
	milestones := 0
	var names []string
	for _, r := range rms {
		perTeam[r.Team.Name] += len(r.Deliverables)
		milestones += len(r.Milestones)
		var ws []string
		for _, w := range r.Workstreams {
			ws = append(ws, w.Name)
		}
		if names == nil {
			names = ws
		} else if !reflect.DeepEqual(names, ws) {
			t.Errorf("workstreams differ between teams: %v vs %v", names, ws)
		}
	}
	if len(perTeam) != 5 || len(names) != 3 || milestones != 5 {
		t.Errorf("teams %v, workstreams %v, milestones %d", perTeam, names, milestones)
	}
	for team, n := range perTeam {
		if n != 4 {
			t.Errorf("%s has %d deliverables, want 4", team, n)
		}
	}

	t.Run("sample shows every kind of metadata", func(t *testing.T) {
		rms, _ := loadedCompany(t, realFile(t, "internal/demo/sample.json"))
		var formatted, responsible, colour, icons, links, multi, atRisk bool
		for _, r := range rms {
			for _, d := range r.Deliverables {
				formatted = formatted || strings.Contains(d.DescriptionHTML, "<strong>") || strings.Contains(d.DescriptionHTML, "<em>") ||
					strings.Contains(d.DescriptionHTML, "<li>") || strings.Contains(d.DescriptionHTML, "<b>") || strings.Contains(d.DescriptionHTML, "<i>")
				responsible = responsible || d.ResponsiblePerson != ""
				colour = colour || !strings.EqualFold(d.Color, r.Team.DefaultColor)
				icons = icons || len(d.Icons) > 0
				links = links || len(d.Links) > 0
				multi = multi || len(d.Workstreams) > 1
				atRisk = atRisk || (d.Status == "at_risk" && d.RiskNote != "")
			}
		}
		// the milestones each have an owner; between them planned, in progress and at risk with its note
		statuses := map[string]bool{}
		for _, r := range rms {
			for _, m := range r.Milestones {
				if m.ResponsiblePerson == "" {
					t.Errorf("milestone %q has no owner", m.Name)
				}
				statuses[m.Status] = true
				if m.Status == "at_risk" && m.RiskNote == "" {
					t.Errorf("at-risk milestone %q has no risk note", m.Name)
				}
			}
		}
		if !statuses["planned"] || !statuses["in_progress"] || !statuses["at_risk"] {
			t.Errorf("milestone statuses %v, want planned, in_progress and at_risk", statuses)
		}
		for what, ok := range map[string]bool{"a formatted description": formatted, "a responsible person": responsible,
			"a custom colour": colour, "icons": icons, "links": links, "several workstreams": multi, "an at-risk status with its note": atRisk} {
			if !ok {
				t.Errorf("no sample deliverable shows %s", what)
			}
		}
	})

	t.Run("sample dependencies and milestones", func(t *testing.T) {
		rms, _ := loadedCompany(t, realFile(t, "internal/demo/sample.json"))
		type edge struct{ from, to int64 }
		cross := map[edge]bool{}
		same := map[edge]bool{}
		next := map[int64][]int64{}
		for _, r := range rms {
			for _, d := range r.Dependencies {
				e := edge{d.FromID, d.ToID}
				if d.From.TeamName == d.To.TeamName {
					same[e] = true
				} else {
					cross[e] = true
				}
				next[d.FromID] = append(next[d.FromID], d.ToID)
			}
		}
		if len(same) == 0 || len(cross) == 0 {
			t.Fatalf("dependencies inside a team: %d, across teams: %d", len(same), len(cross))
		}
		chain := false
		for e := range cross { // a path of three deliverables through a cross-team edge
			for _, n := range next[e.to] {
				chain = chain || n != e.from
			}
			for p := range same {
				chain = chain || p.to == e.from
			}
			for p := range cross {
				chain = chain || p.to == e.from
			}
		}
		if !chain {
			t.Error("the dependencies do not form a chain of at least three deliverables")
		}
		wsOfMilestone := map[int64]bool{}
		for _, r := range rms {
			for _, m := range r.Milestones {
				wsOfMilestone[m.WorkstreamID] = true
			}
		}
		if len(wsOfMilestone) < 2 {
			t.Errorf("the milestones sit in %d workstream(s), want different ones", len(wsOfMilestone))
		}
	})
}

// REQ_DEMO_019: the sample spans 3 months before today to 9 months ahead, every deliverable is one to four
// two-week sprints long, and milestones sit in the same workstreams as deliverables (no workstream of their own).
func Test_REQ_DEMO_019_sample_span_sprint_lengths_and_milestone_workstreams(t *testing.T) {
	for _, file := range []string{"internal/demo/sample.json", "dev/company.json"} {
		t.Run(file, func(t *testing.T) { checkLayout(t, file) })
	}
}

func checkLayout(t *testing.T, file string) {
	rms, _ := loadedCompany(t, realFile(t, file))
	today := time.Now().UTC().Truncate(24 * time.Hour)
	earliest, latest := today.AddDate(0, -3, -3), today.AddDate(0, 9, 3) // a few days of slack for month lengths
	day := func(s string) time.Time {
		d, err := time.Parse("2006-01-02", s)
		if err != nil {
			t.Fatalf("date %q: %v", s, err)
		}
		return d
	}
	for _, r := range rms {
		wsHasDeliverable := map[int64]bool{}
		for _, d := range r.Deliverables {
			for _, w := range d.Workstreams {
				wsHasDeliverable[w.ID] = true
			}
			start, end := day(d.StartDate), day(d.EndDate)
			if start.Before(earliest) || end.After(latest) {
				t.Errorf("%s / %s runs %s..%s, outside 3 months back to 9 months ahead", r.Team.Name, d.Name, d.StartDate, d.EndDate)
			}
			if days := int(end.Sub(start).Hours()/24) + 1; days%14 != 0 || days < 14 || days > 56 {
				t.Errorf("%s / %s is %d days long, want 14, 28, 42 or 56 (one to four two-week sprints)", r.Team.Name, d.Name, days)
			}
		}
		for _, m := range r.Milestones {
			if got := day(m.Date); got.Before(earliest) || got.After(latest) {
				t.Errorf("%s / %s on %s is outside the span", r.Team.Name, m.Name, m.Date)
			}
			if !wsHasDeliverable[m.WorkstreamID] {
				t.Errorf("%s / milestone %q sits in a workstream with no deliverable of that team", r.Team.Name, m.Name)
			}
		}
	}
}

// REQ_DEMO_016/017/018: the development company is the small "Acme Support" company and loads through the
// real importer, so a broken dev/company.json fails `make test`.
func Test_REQ_DEMO_016_REQ_DEMO_017_development_company_file_loads(t *testing.T) {
	data := realFile(t, "dev/company.json")
	if !strings.Contains(string(data), `"relative"`) {
		t.Error("REQ_DEMO_017: dev/company.json must use relative dates")
	}
	rms, res := loadedCompany(t, data)
	ws := map[string]bool{}
	for _, r := range rms {
		for _, w := range r.Workstreams {
			ws[strings.ToLower(w.Name)] = true
		}
	}
	if res.Teams != 5 || len(ws) != 3 || res.Counts.Deliverables != 30 || res.Counts.Milestones != 6 || res.Counts.Dependencies != 17 {
		t.Errorf("teams %d, workstream names %d, deliverables %d, milestones %d, dependencies %d (want 5, 3, 30, 6, 17)",
			res.Teams, len(ws), res.Counts.Deliverables, res.Counts.Milestones, res.Counts.Dependencies)
	}
}

// REQ_DEP_031: the shipped sample and the development data both carry at least one dependency with a milestone end.
func Test_REQ_DEP_031_sample_and_dev_data_carry_milestone_dependencies(t *testing.T) {
	for _, file := range []string{"internal/demo/sample.json", "dev/company.json"} {
		rms, _ := loadedCompany(t, realFile(t, file))
		found := false
		for _, r := range rms {
			for _, e := range r.Dependencies {
				if e.FromKind == "milestone" || e.ToKind == "milestone" {
					found = true
				}
			}
		}
		if !found {
			t.Errorf("%s: no dependency with a milestone end", file)
		}
	}
}

// REQ_IMP_006: two teams whose names differ only by non-ASCII case are two teams (the schema compares team
// names ASCII-only), and each keeps its own place in team_order.
func Test_REQ_IMP_006_company_teams_differing_by_non_ascii_case_stay_distinct(t *testing.T) {
	env := testutil.NewEnv(t)
	src := strings.NewReplacer("Alpha", "Équipe", "Beta", "équipe").Replace(fixtureCompany)
	f, err := store.ParseCompanyFile([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := importCompany(env.DB, f, time.Now()); err != nil {
		t.Fatal(err)
	}
	rows, err := env.DB.Query(`SELECT t.name, o.position FROM company_team_order o JOIN teams t ON t.id=o.team_id ORDER BY o.position`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var n string
		var p int
		rows.Scan(&n, &p)
		got = append(got, n)
	}
	if want := []string{"équipe", "Équipe"}; !reflect.DeepEqual(got, want) {
		t.Errorf("team order %v, want %v", got, want)
	}
}

// REQ_DEMO_020: made-up people with first and last name own the roadmap items, two or three per team for the
// deliverables, every milestone has one, and at least one deliverable that is not done and leads to a milestone has
// none, so the trace's "without owner" count and the Accountable list's "No owner" group show in the demo.
func Test_REQ_DEMO_020_owners_are_named_people_shared_per_team_with_an_unowned_chain_item(t *testing.T) {
	fullName := func(s string) bool {
		return len(strings.Fields(s)) == 2 && !strings.Contains(strings.ToLower(s), "chief")
	}
	for _, file := range []string{"internal/demo/sample.json", "dev/company.json"} {
		t.Run(file, func(t *testing.T) {
			rms, _ := loadedCompany(t, realFile(t, file))
			next := map[string][]string{} // item key -> its dependents, over every roadmap's edges
			key := func(kind string, id int64) string { return fmt.Sprintf("%s:%d", kind, id) }
			for _, r := range rms {
				for _, e := range r.Dependencies {
					next[key(e.FromKind, e.FromID)] = append(next[key(e.FromKind, e.FromID)], key(e.ToKind, e.ToID))
				}
			}
			leadsToMilestone := func(start string) bool {
				seen, todo := map[string]bool{}, []string{start}
				for len(todo) > 0 {
					k := todo[0]
					todo = todo[1:]
					for _, n := range next[k] {
						if strings.HasPrefix(n, "milestone:") {
							return true
						}
						if !seen[n] {
							seen[n] = true
							todo = append(todo, n)
						}
					}
				}
				return false
			}
			unownedInChain := 0
			for _, r := range rms {
				people := map[string]bool{}
				for _, d := range r.Deliverables {
					if d.ResponsiblePerson == "" {
						if d.Status != "done" && leadsToMilestone(key("deliverable", d.ID)) {
							unownedInChain++
						}
						continue
					}
					people[d.ResponsiblePerson] = true
					if !fullName(d.ResponsiblePerson) {
						t.Errorf("%s / %s: owner %q is not a first and last name", r.Team.Name, d.Name, d.ResponsiblePerson)
					}
				}
				if len(people) < 2 || len(people) > 3 {
					t.Errorf("%s: deliverables owned by %d people %v, want 2 or 3", r.Team.Name, len(people), people)
				}
				for _, m := range r.Milestones {
					if !fullName(m.ResponsiblePerson) {
						t.Errorf("%s / milestone %s: owner %q is not a first and last name", r.Team.Name, m.Name, m.ResponsiblePerson)
					}
				}
			}
			if unownedInChain == 0 {
				t.Error("no deliverable that is not done and leads to a milestone is without an owner")
			}
		})
	}
}
