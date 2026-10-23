package api_test

import (
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type teamList struct {
	Items []store.Team
	Total int
}

// Test_REQ_API_008_teams_list_paging_and_write_crud proves the list/paging endpoint and the write
// CRUD shape (REQ_API_005-style create/update/delete). "Only admins can write" (REQ_API_008's other
// half) is Test_REQ_API_008_team_writes_are_admin_only in authz_test.go.
func Test_REQ_API_008_teams_list_paging_and_write_crud(t *testing.T) {
	t.Run("get team by id", func(t *testing.T) {
		g := newRig(t)
		tm := g.Team(testTeamOpts("Alpha", "ALP"))
		got := must[store.Team](g, 200, "GET", "/api/teams/"+id(tm.ID), nil)
		if got.ID != tm.ID || got.Name != "Alpha" {
			t.Errorf("got %+v", got)
		}
		g.expect(404, "GET", "/api/teams/"+id(g.noSuchID()), nil)
	})

	g := newRig(t)
	a := g.Team(testTeamOpts("Alpha", "AAA"))
	g.Team(testTeamOpts("Beta", "BBB"))
	g.Team(testTeamOpts("Gamma", "CCC"))

	l := must[teamList](g, 200, "GET", "/api/teams", nil)
	if l.Total != 3 || len(l.Items) != 3 {
		t.Fatalf("list %+v", l)
	}
	p := must[teamList](g, 200, "GET", "/api/teams?limit=2&offset=1", nil)
	if p.Total != 3 || len(p.Items) != 2 || p.Items[0].Name != "Beta" {
		t.Errorf("paged %+v", p)
	}
	if n := len(must[teamList](g, 200, "GET", "/api/teams?limit=9999", nil).Items); n != 3 {
		t.Errorf("clamped limit returned %d", n)
	}
	g.expect(400, "GET", "/api/teams?limit=abc", nil)

	c := must[store.Team](g, 201, "POST", "/api/teams", map[string]any{"name": "New Team", "tag": "NEW"})
	if c.ID == 0 || c.DefaultColor == "" || c.CreatedAt == "" {
		t.Errorf("created %+v", c)
	}
	u := must[store.Team](g, 200, "PATCH", "/api/teams/"+id(a.ID), map[string]any{"name": "Alpha 2"})
	if u.Name != "Alpha 2" || u.Tag != "AAA" {
		t.Errorf("patched %+v", u)
	}
	if e := g.lastAudit(); e.Action != "team.rename" || e.Details["team"] != "Alpha 2" {
		t.Errorf("audit %+v", e)
	}
	g.expect(404, "PATCH", "/api/teams/"+id(g.noSuchID()), map[string]any{"name": "x"})
	g.expect(204, "DELETE", "/api/teams/"+id(c.ID), nil)
	g.expect(404, "DELETE", "/api/teams/"+id(c.ID), nil)

}

func Test_REQ_API_009_REQ_DAT_004_duplicate_team_name_or_tag_refused(t *testing.T) {
	g := newRig(t)
	a := g.Team(testTeamOpts("Alpha", "AAA"))
	b := g.Team(testTeamOpts("Beta", "BBB"))
	if c := g.expect(409, "POST", "/api/teams", map[string]any{"name": "aLPHA", "tag": "ZZZ"}); c != "duplicate_name" {
		t.Errorf("code %q", c)
	}
	if c := g.expect(409, "POST", "/api/teams", map[string]any{"name": "Other", "tag": "AAA"}); c != "duplicate_tag" {
		t.Errorf("code %q", c)
	}
	if c := g.expect(409, "PATCH", "/api/teams/"+id(b.ID), map[string]any{"name": "alpha"}); c != "duplicate_name" {
		t.Errorf("code %q", c)
	}
	if c := g.expect(409, "PATCH", "/api/teams/"+id(b.ID), map[string]any{"tag": "AAA"}); c != "duplicate_tag" {
		t.Errorf("code %q", c)
	}
	// keeping its own name/tag is not a duplicate
	must[store.Team](g, 200, "PATCH", "/api/teams/"+id(a.ID), map[string]any{"name": "Alpha", "tag": "AAA"})
	if n := must[teamList](g, 200, "GET", "/api/teams", nil).Total; n != 2 {
		t.Errorf("refused requests changed the list: %d teams", n)
	}

	t.Run("team name tag color rules via api", func(t *testing.T) {
		g := newRig(t)
		for _, tag := range []string{"A", "ABCDE", "ab", "A1", "A B"} {
			status, e := call[errResp](g, "POST", "/api/teams", map[string]any{"name": "T" + tag, "tag": tag})
			if status != 422 || e.Error.Fields["tag"] == "" {
				t.Errorf("tag %q: status %d %+v", tag, status, e)
			}
		}
		for _, col := range []string{"red", "#12345", "#gggggg", "123456"} {
			status, e := call[errResp](g, "POST", "/api/teams", map[string]any{"name": "C" + col, "tag": "COL", "default_color": col})
			if status != 422 || e.Error.Fields["default_color"] == "" {
				t.Errorf("color %q: status %d %+v", col, status, e)
			}
		}
		if status, _ := call[errResp](g, "POST", "/api/teams", map[string]any{"name": "  ", "tag": "OKK"}); status != 422 {
			t.Errorf("blank name status %d", status)
		}
		ok := must[store.Team](g, 201, "POST", "/api/teams", map[string]any{"name": "Fine", "tag": "FINE", "default_color": "#aabbcc"})
		if ok.DefaultColor != "#aabbcc" {
			t.Errorf("color %q", ok.DefaultColor)
		}
		g.expect(409, "POST", "/api/teams", map[string]any{"name": "fine", "tag": "OTHR"})
		g.expect(409, "POST", "/api/teams", map[string]any{"name": "Other", "tag": "FINE"})
	})
}

// REQ_DAT_020, REQ_API_010: a team is refused 409 has_roadmap_items while its roadmap holds a deliverable
// or a milestone; once empty, the team goes with its roadmap and that roadmap's workstreams, in one
// team.delete entry naming the roadmap, and nothing else is touched.
func Test_REQ_DAT_020_REQ_API_010_team_delete_only_while_its_roadmap_is_empty(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, testutil.RoadmapOpts{Title: "Plan"})
	ws := g.newWorkstream(rm.ID, "W")
	d := g.newDeliverable(rm.ID, []int64{ws.ID}, 0, 10, nil)
	ms := g.rawMilestone(rm.ID, ws.ID, "M", g.Clock.Date(3))
	other := g.Team(testTeamOpts("", ""))
	orm := g.Roadmap(other, roadmapOpts())
	g.Deliverable(orm, testutil.DeliverableOpts{})

	before := g.auditCount()
	if c := g.expect(409, "DELETE", "/api/teams/"+id(tm.ID), nil); c != "has_roadmap_items" {
		t.Errorf("with a deliverable and a milestone: code %q", c)
	}
	if g.auditCount() != before {
		t.Errorf("a refused team delete wrote %d audit entries", g.auditCount()-before)
	}
	g.expect(204, "DELETE", "/api/deliverables/"+id(d.ID), nil)
	if c := g.expect(409, "DELETE", "/api/teams/"+id(tm.ID), nil); c != "has_roadmap_items" {
		t.Errorf("with a milestone only: code %q", c)
	}
	g.expect(204, "DELETE", "/api/milestones/"+id(ms), nil)
	before = g.auditCount()
	g.expect(204, "DELETE", "/api/teams/"+id(tm.ID), nil)
	if g.auditCount() != before+1 {
		t.Fatalf("%d audit entries for the team delete", g.auditCount()-before)
	}
	if e := g.lastAudit(); e.Action != "team.delete" || e.Details["team"] != tm.Name || e.Details["roadmap"] != "Plan" {
		t.Errorf("audit %+v", e)
	}
	g.expect(404, "GET", "/api/roadmaps/"+id(rm.ID), nil)
	if n := countRows(g, `SELECT COUNT(*) FROM workstreams WHERE roadmap_id=`+id(rm.ID)); n != 0 {
		t.Errorf("%d workstreams left behind", n)
	}
	if got := g.roadmap(orm.ID); len(got.Deliverables) != 1 {
		t.Error("another team's roadmap was affected")
	}
}

// REQ_DAT_032, REQ_AUD_024: creating a team answers with its roadmap_id and writes one team.create entry
// that also names the roadmap created with it.
func Test_REQ_DAT_032_REQ_AUD_024_team_create_brings_its_roadmap_in_one_entry(t *testing.T) {
	g := newRig(t)
	before := g.auditCount()
	tm := must[store.Team](g, 201, "POST", "/api/teams", map[string]any{"name": "Payments", "tag": "PAY"})
	if g.auditCount() != before+1 {
		t.Fatalf("%d audit entries for a team create", g.auditCount()-before)
	}
	if e := g.lastAudit(); e.Action != "team.create" || e.Details["team"] != "Payments" || e.Details["roadmap"] != "Payments" || e.RoadmapID != tm.RoadmapID {
		t.Errorf("audit %+v", e)
	}
	full := g.roadmap(tm.RoadmapID)
	if full.TeamID != tm.ID || full.Title != "Payments" || len(full.Workstreams) != 1 || full.Workstreams[0].Name != "General" {
		t.Errorf("the team's roadmap: %+v", full)
	}
}

func Test_REQ_DAT_018_team_color_change_never_recolors(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, roadmapOpts())
	ws := g.newWorkstream(rm.ID, "W")
	d1 := g.newDeliverable(rm.ID, []int64{ws.ID}, 0, 5, nil)
	d2 := g.newDeliverable(rm.ID, []int64{ws.ID}, 6, 9, map[string]any{"color": "#123456"})
	other := g.Team(testTeamOpts("", ""))
	orm := g.Roadmap(other, roadmapOpts())
	ows := g.newWorkstream(orm.ID, "W")
	od := g.newDeliverable(orm.ID, []int64{ows.ID}, 0, 5, nil)
	colorOf := func(d store.Deliverable) string {
		return must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(d.ID), nil).Color
	}
	before1, before2, beforeO := colorOf(d1), colorOf(d2), colorOf(od)

	must[store.Team](g, 200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"default_color": "#ff0000"})
	if colorOf(d1) != before1 || colorOf(d2) != before2 || colorOf(od) != beforeO {
		t.Error("changing the default recolored deliverables")
	}
	// a leftover apply_color_to_existing is an unknown field and ignored: still no recolor
	must[store.Team](g, 200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"default_color": "#0000ff", "apply_color_to_existing": true})
	if colorOf(d1) != before1 || colorOf(d2) != before2 || colorOf(od) != beforeO {
		t.Error("changing the default with apply_color_to_existing recolored deliverables")
	}
	if e := g.lastAudit(); e.Action != "team.recolor" || e.Details["recolored_deliverables"] != nil {
		t.Errorf("audit entry %+v", e)
	}
}

func Test_REQ_AUD_002_REQ_AUD_003_team_patch_writes_one_entry_per_changed_field(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("Growth", "PE"))
	oldColor := must[teamList](g, 200, "GET", "/api/teams", nil).Items[0].DefaultColor
	n0 := g.auditCount()
	u := must[store.Team](g, 200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{
		"name": "Growth & Ops", "tag": "PRD", "default_color": "#0F766E"})
	if got := g.auditCount() - n0; got != 3 {
		t.Fatalf("want 3 entries, got %d", got)
	}
	es := g.audit.entries[n0:]
	want := []struct{ action, field, from, to, summary string }{
		{"team.rename", "name", "Growth", "Growth & Ops", "Name Growth → Growth & Ops"},
		{"team.retag", "tag", "PE", "PRD", "Tag PE → PRD"},
		{"team.recolor", "default_color", oldColor, "#0F766E", "Color " + oldColor + " → #0F766E"},
	}
	for i, w := range want {
		d := es[i].Details
		if es[i].Action != w.action || d["field"] != w.field || d["from"] != w.from || d["to"] != w.to ||
			d["summary"] != w.summary || d["team"] != u.Name {
			t.Errorf("entry %d: %+v", i, es[i])
		}
	}
	// unchanged values and empty patches write nothing
	n1 := g.auditCount()
	must[store.Team](g, 200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"name": "Growth & Ops", "tag": "PRD"})
	must[store.Team](g, 200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{})
	if g.auditCount() != n1 {
		t.Errorf("no-op PATCH wrote %d entries", g.auditCount()-n1)
	}

}
