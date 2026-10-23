package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
)

func Test_REQ_API_003_writes_must_be_json(t *testing.T) {
	g := newRig(t)
	if c := func() string {
		status, raw := g.send("POST", "/api/teams", "text/plain", []byte(`{"name":"X","tag":"XX"}`))
		if status != 415 {
			t.Fatalf("text/plain: %d %s", status, raw)
		}
		return string(raw)
	}(); !contains(c, "unsupported_media_type") {
		t.Errorf("body %s", c)
	}
	if status, _ := g.send("POST", "/api/teams", "", []byte(`{"name":"X","tag":"XX"}`)); status != 415 {
		t.Errorf("missing content type: %d", status)
	}
	if status, _ := g.send("PATCH", "/api/teams/"+id(g.noSuchID()), "application/x-www-form-urlencoded", []byte("name=x")); status != 415 {
		t.Errorf("form: %d", status)
	}
	if status, _ := g.send("POST", "/api/teams", "application/json; charset=utf-8", []byte(`{"name":"X","tag":"XX"}`)); status != 201 {
		t.Errorf("json with charset: %d", status)
	}
	if status, _ := g.send("POST", "/api/teams", "application/json", []byte(`{not json`)); status != 400 {
		t.Errorf("broken json: %d", status)
	}
	// a bodiless write still needs the header — this is the CSRF defence (spec §8): a plain HTML form
	// cannot set Content-Type: application/json, so SameSite=Lax alone is not enough without this.
	tm := g.Team(testTeamOpts("", ""))
	if status, _ := g.send("DELETE", "/api/teams/"+id(tm.ID), "", nil); status != 415 {
		t.Errorf("bodiless DELETE without content type: %d, want 415", status)
	}
	if status, _ := g.send("DELETE", "/api/teams/"+id(tm.ID), "application/json", nil); status != 204 {
		t.Errorf("bodiless DELETE with the header and no body: %d, want 204", status)
	}
}

func Test_REQ_API_004_errors_have_one_shape(t *testing.T) {
	g := newRig(t)
	for _, c := range []struct {
		status int
		code   string
		do     func() (int, errResp)
	}{
		{404, "not_found", func() (int, errResp) { return call[errResp](g, "GET", "/api/roadmaps/"+id(g.noSuchID()), nil) }},
		{404, "not_found", func() (int, errResp) { return call[errResp](g, "GET", "/api/nope", nil) }},
		{400, "bad_request", func() (int, errResp) { return call[errResp](g, "GET", "/api/roadmaps/abc", nil) }},
		{422, "validation_failed", func() (int, errResp) {
			return call[errResp](g, "POST", "/api/teams", map[string]any{"name": "", "tag": "x"})
		}},
		{404, "not_found", func() (int, errResp) { return call[errResp](g, "GET", "/api/teams/"+id(g.noSuchID())+"/roadmaps", nil) }},
	} {
		status, e := c.do()
		if status != c.status || e.Error.Code != c.code || e.Error.Message == "" {
			t.Errorf("want %d %s, got %d %+v", c.status, c.code, status, e)
		}
	}
	_, e := call[errResp](g, "POST", "/api/teams", map[string]any{"name": "", "tag": "x"})
	if e.Error.Fields["name"] == "" || e.Error.Fields["tag"] == "" {
		t.Errorf("fields missing: %+v", e)
	}
	tm := g.Team(testTeamOpts("", ""))
	_, dup := call[errResp](g, "POST", "/api/teams", map[string]any{"name": tm.Name, "tag": "ZQZ"})
	if dup.Error.Code != "duplicate_name" || dup.Error.Fields != nil {
		t.Errorf("conflict shape %+v", dup)
	}

	t.Run("oversized body is 413", func(t *testing.T) {
		g := newRig(t)
		huge := strings.Repeat("x", 5<<20)
		body := []byte(`{"name":"` + huge + `","tag":"XX"}`)
		status, raw := g.send("POST", "/api/teams", "application/json", body)
		if status != http.StatusRequestEntityTooLarge {
			t.Fatalf("status %d, want 413: %s", status, raw)
		}
	})

	t.Run("trailing data after json is rejected", func(t *testing.T) {
		g := newRig(t)
		body := []byte(`{"name":"Trailer","tag":"TRL"}{"oops":true}`)
		status, raw := g.send("POST", "/api/teams", "application/json", body)
		if status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400: %s", status, raw)
		}
		// trailing whitespace after the value is fine, not "trailing data"
		status, raw = g.send("POST", "/api/teams", "application/json", []byte(`{"name":"Fine","tag":"FIN"}`+"\n"))
		if status != http.StatusCreated {
			t.Fatalf("trailing whitespace refused: status %d: %s", status, raw)
		}
	})
}

func Test_REQ_API_005_roadmap_workstream_deliverable_crud(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	team := must[store.Team](g, 200, "GET", "/api/teams/"+id(tm.ID), nil)
	rm := must[store.RoadmapFull](g, 200, "GET", "/api/roadmaps/"+id(team.RoadmapID), nil).Roadmap
	if rm.TeamID != tm.ID || rm.Title != tm.Name || rm.RangeStart != nil || rm.RangeEnd != nil {
		t.Errorf("the team's roadmap: %+v", rm)
	}
	if r := must[store.Roadmap](g, 200, "PATCH", "/api/roadmaps/"+id(rm.ID), map[string]any{"title": "Plan 2"}); r.Title != "Plan 2" {
		t.Errorf("rename: %+v", r)
	}
	g.expect(422, "PATCH", "/api/roadmaps/"+id(rm.ID), map[string]any{"title": " "})

	// REQ_DAT_023: a blank roadmap already has one automatic "General" workstream.
	general := g.roadmap(rm.ID).Workstreams[0]
	w1 := g.newWorkstream(rm.ID, "One")
	w2 := g.newWorkstream(rm.ID, "Two")
	if w2.Position <= w1.Position {
		t.Errorf("new workstream not appended: %d %d", w1.Position, w2.Position)
	}
	if w := must[store.Workstream](g, 200, "PATCH", "/api/workstreams/"+id(w1.ID), map[string]any{"name": "Uno"}); w.Name != "Uno" {
		t.Errorf("ws rename %+v", w)
	}
	ord := must[struct{ Items []store.Workstream }](g, 200, "PUT", "/api/roadmaps/"+id(rm.ID)+"/workstreams/order",
		map[string]any{"ids": []int64{w2.ID, w1.ID, general.ID}})
	if ord.Items[0].ID != w2.ID || ord.Items[1].ID != w1.ID {
		t.Errorf("order %+v", ord)
	}
	g.expect(422, "PUT", "/api/roadmaps/"+id(rm.ID)+"/workstreams/order", map[string]any{"ids": []int64{w2.ID}})
	g.expect(422, "PUT", "/api/roadmaps/"+id(rm.ID)+"/workstreams/order", map[string]any{"ids": []int64{w2.ID, w2.ID}})

	d := g.newDeliverable(rm.ID, []int64{w1.ID, w2.ID}, 0, 20, map[string]any{
		"responsible_person": "Ann", "description_html": "<p>hi</p>", "icons": []string{"rocket", "flag"},
		"links": []map[string]string{{"label": "Spec", "url": "https://example.com/a"}, {"label": "", "url": "http://example.com/b"}}})
	if d.TeamID != tm.ID || d.RoadmapID != rm.ID || d.Status != "planned" || len(d.Links) != 2 || len(d.Icons) != 2 {
		t.Errorf("created %+v", d)
	}
	// primary first: w2 now has the lower position
	if d.WorkstreamIDs[0] != w2.ID {
		t.Errorf("workstream_ids not ordered by workstream position: %v", d.WorkstreamIDs)
	}
	up := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{
		"name": "Renamed", "links": []map[string]string{{"label": "Only", "url": "https://example.com/c"}}, "icons": []string{}})
	if up.Name != "Renamed" || len(up.Links) != 1 || up.Links[0].Label != "Only" || len(up.Icons) != 0 || up.ResponsiblePerson != "Ann" {
		t.Errorf("patched %+v", up)
	}
	full := g.roadmap(rm.ID)
	if len(full.Workstreams) != 3 || len(full.Deliverables) != 1 || full.Milestones == nil || full.Deliverables[0].Name != "Renamed" {
		t.Errorf("RoadmapFull %+v", full)
	}
	if full.Team.ID != tm.ID || full.Team.Name != tm.Name {
		t.Errorf("RoadmapFull.Team %+v", full.Team)
	}
	g.expect(204, "DELETE", "/api/deliverables/"+id(d.ID), nil)
	g.expect(404, "GET", "/api/deliverables/"+id(d.ID), nil)
	g.expect(204, "DELETE", "/api/workstreams/"+id(w1.ID), nil)
	if got := g.roadmap(rm.ID); len(got.Workstreams) != 2 {
		t.Errorf("workstreams after delete: %d", len(got.Workstreams))
	}
	if e := g.lastAudit(); e.Action != "workstream.delete" || e.Details["workstream"] != "Uno" {
		t.Errorf("audit %+v", e)
	}

	t.Run("workstream names unique within roadmap case insensitive", func(t *testing.T) {
		g, rm, _, _ := deliverableRig(t)
		if c := g.expect(409, "POST", "/api/roadmaps/"+id(rm)+"/workstreams", map[string]any{"name": "a"}); c != "duplicate_name" {
			t.Errorf("code %q", c)
		}
		other := g.newWorkstream(rm, "Unique")
		if c := g.expect(409, "PATCH", "/api/workstreams/"+id(other.ID), map[string]any{"name": "B"}); c != "duplicate_name" {
			t.Errorf("rename code %q", c)
		}
		// keeping its own (differently-cased) name is not a duplicate
		must[store.Workstream](g, 200, "PATCH", "/api/workstreams/"+id(other.ID), map[string]any{"name": "unique"})
		// a different roadmap may reuse the same name freely
		other2 := g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts())
		must[store.Workstream](g, 201, "POST", "/api/roadmaps/"+id(other2.ID)+"/workstreams", map[string]any{"name": "A"})
	})
}

func Test_REQ_DAT_009_range_is_derived_on_create_delete_and_date_change(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, roadmapOpts())
	ws := g.newWorkstream(rm.ID, "W")
	rng := func() (string, string) {
		r := g.roadmap(rm.ID)
		if r.RangeStart == nil || r.RangeEnd == nil {
			return "", ""
		}
		return *r.RangeStart, *r.RangeEnd
	}
	if s, e := rng(); s != "" || e != "" {
		t.Errorf("empty roadmap range %q %q", s, e)
	}
	a := g.newDeliverable(rm.ID, []int64{ws.ID}, 10, 20, nil)
	if s, e := rng(); s != g.Clock.Date(10) || e != g.Clock.Date(20) {
		t.Errorf("after create: %s %s", s, e)
	}
	b := g.newDeliverable(rm.ID, []int64{ws.ID}, 30, 50, nil)
	if s, e := rng(); s != g.Clock.Date(10) || e != g.Clock.Date(50) {
		t.Errorf("after 2nd create: %s %s", s, e)
	}
	must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(a.ID), map[string]any{"start_date": g.Clock.Date(-5)})
	if s, _ := rng(); s != g.Clock.Date(-5) {
		t.Errorf("after date change: %s", s)
	}
	g.expect(204, "DELETE", "/api/deliverables/"+id(b.ID), nil)
	if s, e := rng(); s != g.Clock.Date(-5) || e != g.Clock.Date(20) {
		t.Errorf("after delete: %s %s", s, e)
	}
	g.expect(204, "DELETE", "/api/deliverables/"+id(a.ID), nil)
	if s, e := rng(); s != "" || e != "" {
		t.Errorf("after last delete %q %q", s, e)
	}
	// a client cannot type a range
	must[store.Roadmap](g, 200, "PATCH", "/api/roadmaps/"+id(rm.ID), map[string]any{"title": "T", "range_start": "1999-01-01"})
	if s, _ := rng(); s != "" {
		t.Errorf("range_start accepted from client: %s", s)
	}

	// the derived range covers milestones as well as deliverables: a milestone outside the deliverables'
	// own span on either side widens the range. The milestones are inserted directly and the recompute is
	// triggered by a real write (creating another deliverable), as any real write would.
	t.Run("range includes milestones", func(t *testing.T) {
		g := newRig(t)
		rm := g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts())
		ws := g.newWorkstream(rm.ID, "W")
		g.newDeliverable(rm.ID, []int64{ws.ID}, 0, 10, nil)
		early, late := g.Clock.Date(-30), g.Clock.Date(50)
		for _, m := range []struct{ name, date string }{{"Kickoff", early}, {"Launch", late}} {
			if _, err := g.DB.Exec(`INSERT INTO milestones(roadmap_id, workstream_id, name, date) VALUES (?,?,?,?)`, rm.ID, ws.ID, m.name, m.date); err != nil {
				t.Fatal(err)
			}
		}
		g.newDeliverable(rm.ID, []int64{ws.ID}, 5, 6, nil) // any real write recomputes the range
		r := g.roadmap(rm.ID)
		if r.RangeStart == nil || r.RangeEnd == nil {
			t.Fatal("the range is empty although the roadmap has deliverables and milestones")
		}
		if *r.RangeStart != early || *r.RangeEnd != late {
			t.Errorf("range %s..%s, want %s..%s (the milestones outside the deliverables' own span)", *r.RangeStart, *r.RangeEnd, early, late)
		}
	})
}

func Test_REQ_API_014_and_DAT_015_three_year_span_is_enforced(t *testing.T) {
	t.Run("milestone span exceeded", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		start := g.Clock.Day(0)
		edge := start.AddDate(3, 0, 0).Format("2006-01-02")
		over := start.AddDate(3, 0, 1).Format("2006-01-02")
		// a deliverable spanning exactly 3 years sets the far edge of the roadmap's range
		must[store.Deliverable](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/deliverables",
			map[string]any{"name": "a", "start_date": start.Format("2006-01-02"), "end_date": edge, "workstream_ids": []int64{ws[0]}})

		if c := g.expect(409, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "M", "date": over, "workstream_id": ws[0]}); c != "span_exceeded" {
			t.Errorf("create code %q", c)
		}
		if len(g.roadmap(rm).Milestones) != 0 {
			t.Fatal("refused milestone was created anyway")
		}

		m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "M2", "date": start.Format("2006-01-02"), "workstream_id": ws[0]})
		if c := g.expect(409, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"date": over}); c != "span_exceeded" {
			t.Errorf("patch code %q", c)
		}
		unchanged, ok := g.milestoneByID(rm, m.ID)
		if !ok || unchanged.Date != m.Date {
			t.Errorf("refused patch was applied anyway: %+v", unchanged)
		}
		// deletes are never refused by the cap
		g.expect(204, "DELETE", "/api/milestones/"+id(m.ID), nil)
	})

	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, roadmapOpts())
	ws := g.newWorkstream(rm.ID, "W")
	start := g.Clock.Day(0)
	edge := start.AddDate(3, 0, 0).Format("2006-01-02")
	over := start.AddDate(3, 0, 1).Format("2006-01-02")
	post := func(s, e string) string {
		return g.expect(409, "POST", "/api/roadmaps/"+id(rm.ID)+"/deliverables",
			map[string]any{"name": "x", "start_date": s, "end_date": e, "workstream_ids": []int64{ws.ID}})
	}
	if c := post(start.Format("2006-01-02"), over); c != "span_exceeded" {
		t.Errorf("code %q", c)
	}
	// exactly three years is allowed
	a := must[store.Deliverable](g, 201, "POST", "/api/roadmaps/"+id(rm.ID)+"/deliverables",
		map[string]any{"name": "a", "start_date": start.Format("2006-01-02"), "end_date": edge, "workstream_ids": []int64{ws.ID}})
	inside := g.newDeliverable(rm.ID, []int64{ws.ID}, 10, 20, nil) // inside the span: still works
	// growing past the span in either direction is refused; nothing changes
	if c := g.expect(409, "PATCH", "/api/deliverables/"+id(inside.ID), map[string]any{"end_date": over}); c != "span_exceeded" {
		t.Errorf("patch code %q", c)
	}
	g.expect(409, "PATCH", "/api/deliverables/"+id(inside.ID), map[string]any{"start_date": g.Clock.Date(-2)})
	if got := must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(inside.ID), nil); got.EndDate != inside.EndDate || got.StartDate != inside.StartDate {
		t.Errorf("refused change was applied: %+v", got)
	}
	// changes inside the current span work
	must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(inside.ID), map[string]any{"start_date": g.Clock.Date(11), "end_date": g.Clock.Date(300)})
	// deletes always work
	g.expect(204, "DELETE", "/api/deliverables/"+id(a.ID), nil)
	g.expect(204, "DELETE", "/api/deliverables/"+id(inside.ID), nil)
	// the database itself never holds a span over 3 years (checked over the whole table)
	var n int
	if err := g.DB.QueryRow(`SELECT COUNT(*) FROM roadmaps WHERE date(range_end) > date(range_start, '+3 years')`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%d roadmaps over the cap", n)
	}

}

// REQ_AUD_001: renaming a roadmap to the title it already has writes no audit entry and does not
// bump updated_at.
func Test_REQ_AUD_001_REQ_API_030_REQ_DAT_014_roadmap_rename_no_op_is_silent(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, roadmapOpts())
	before := g.roadmap(rm.ID)
	n0 := g.auditCount()
	after := must[store.Roadmap](g, 200, "PATCH", "/api/roadmaps/"+id(rm.ID), map[string]any{"title": before.Title})
	if after.UpdatedAt != before.UpdatedAt {
		t.Errorf("no-op rename bumped updated_at: %q -> %q", before.UpdatedAt, after.UpdatedAt)
	}
	if g.auditCount() != n0 {
		t.Errorf("no-op rename wrote %d entries", g.auditCount()-n0)
	}

	t.Run("milestone description audit and noop", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		m := g.newMilestoneWith(rm, ws[0], map[string]any{"description_html": "<p>one</p>"})
		before := g.auditCount()
		// the same text after cleaning is a no-op: nothing audited
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"description_html": `<p onclick="x()">one</p>`})
		if g.auditCount() != before {
			t.Fatal("no-op PATCH was audited")
		}
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"description_html": "<p>two</p>"})
		if g.auditCount() != before+1 {
			t.Fatalf("%d audit entries", g.auditCount()-before)
		}
		e := g.lastAudit()
		raw, _ := json.Marshal(e.Details["changes"])
		if e.Action != "milestone.update" || string(raw) != `[{"field":"description_html","from":"\u003cp\u003eone\u003c/p\u003e","to":"\u003cp\u003etwo\u003c/p\u003e"}]` {
			t.Errorf("audit %s %s", e.Action, raw)
		}
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"name": "Renamed"})
		if got, _ := g.milestoneByID(rm, m.ID); got.DescriptionHTML != "<p>two</p>" {
			t.Errorf("description changed by rename: %q", got.DescriptionHTML)
		}
	})

	t.Run("milestone no op patch writes nothing", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		date := g.Clock.Date(2)
		m := must[store.Milestone](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "Launch", "date": date, "workstream_id": ws[0]})
		n0 := g.auditCount()
		must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{})
		if g.auditCount() != n0 {
			t.Errorf("empty patch wrote %d entries", g.auditCount()-n0)
		}
		must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID),
			map[string]any{"name": "Launch", "date": date, "workstream_id": ws[0], "row": m.Row})
		if g.auditCount() != n0 {
			t.Errorf("same-values patch wrote %d entries", g.auditCount()-n0)
		}
	})

	t.Run("deliverable patch no op does not bump updated at", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		d := g.newDeliverable(rm, ws[:1], 0, 5, nil)
		before := d.UpdatedAt
		u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"name": d.Name, "status": d.Status})
		if u.UpdatedAt != before {
			t.Errorf("no-op PATCH bumped updated_at: %q -> %q", before, u.UpdatedAt)
		}
	})

	t.Run("workstream no op writes are silent", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		n0 := g.auditCount()
		renamed := must[store.Workstream](g, 200, "PATCH", "/api/workstreams/"+id(ws[0]), map[string]any{"name": "A"})
		if renamed.Name != "A" {
			t.Fatalf("rename %+v", renamed)
		}
		if g.auditCount() != n0 {
			t.Errorf("no-op rename wrote %d entries", g.auditCount()-n0)
		}
		ord := must[struct{ Items []store.Workstream }](g, 200, "PUT", "/api/roadmaps/"+id(rm)+"/workstreams/order", map[string]any{"ids": ws})
		if len(ord.Items) != 2 {
			t.Fatalf("order %+v", ord)
		}
		if g.auditCount() != n0 {
			t.Errorf("no-op reorder wrote %d entries", g.auditCount()-n0)
		}
	})

	t.Run("identical links patch writes nothing", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		links := []map[string]string{{"label": "A", "url": "https://a.example"}, {"label": "B", "url": "https://b.example"}}
		d := g.newDeliverable(rm, ws[:1], 0, 1, map[string]any{"links": links})
		if _, err := g.DB.Exec(`UPDATE roadmap_item_links SET created_at='2001-02-03 04:05:06'`); err != nil {
			t.Fatal(err)
		}
		created := func() string {
			var s string
			if err := g.DB.QueryRow(`SELECT group_concat(created_at) FROM roadmap_item_links WHERE item_kind='deliverable' AND item_id=?`, d.ID).Scan(&s); err != nil {
				t.Fatal(err)
			}
			return s
		}
		n := g.auditCount()
		u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"links": links})
		if len(u.Links) != 2 || u.Links[0].ID != d.Links[0].ID || u.Links[1].ID != d.Links[1].ID {
			t.Errorf("link ids changed by an identical PATCH: %+v -> %+v", d.Links, u.Links)
		}
		if got := created(); got != "2001-02-03 04:05:06,2001-02-03 04:05:06" {
			t.Errorf("created_at rewritten: %q", got)
		}
		if g.auditCount() != n {
			t.Errorf("identical links PATCH wrote %d audit entries", g.auditCount()-n)
		}
		u = must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"links": links[:1]})
		if len(u.Links) != 1 || created() == "2001-02-03 04:05:06" { // ids may be reused after a delete; created_at shows the rewrite
			t.Errorf("a changed set must be rewritten: %+v, created %q", u.Links, created())
		}
	})
}

// REQ_DAT_015: the 3-year cap's exact boundary, including the Feb-29 leap-year case. A start date of
// 2024-02-29 plus "3 calendar years" normalizes (Go's time.AddDate) to 2027-03-01, since 2027 is not
// a leap year and has no Feb 29 — so 2027-03-01 is the latest allowed end date for that start, and
// 2027-02-28 (a full year short of a leap day) is comfortably inside it.
func Test_REQ_DAT_015_three_year_span_feb29_boundary(t *testing.T) {
	g := newRig(t)
	// Each case gets its own fresh roadmap: the span is the whole roadmap's derived range, not any
	// one deliverable's own dates, so cases must not share a roadmap.
	post := func(start, end string) (int, errResp) {
		rm := g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts())
		ws := g.newWorkstream(rm.ID, "W")
		return call[errResp](g, "POST", "/api/roadmaps/"+id(rm.ID)+"/deliverables",
			map[string]any{"name": "x", "start_date": start, "end_date": end, "workstream_ids": []int64{ws.ID}})
	}
	if status, e := post("2024-02-29", "2027-03-01"); status != 201 {
		t.Errorf("exactly 3 years from a leap day: status %d %+v", status, e)
	}
	if status, _ := post("2024-02-29", "2027-03-02"); status != 409 {
		t.Errorf("one day past 3 years from a leap day: status %d, want 409", status)
	}
	// an ordinary (non-leap-day) start has no such quirk: exactly 3 years later lands on the same
	// month/day, and one more day is refused.
	if status, e := post("2026-01-01", "2029-01-01"); status != 201 {
		t.Errorf("exactly 3 years, ordinary date: status %d %+v", status, e)
	}
	if status, _ := post("2026-01-02", "2029-01-03"); status != 409 {
		t.Errorf("2026-01-02 to 2029-01-03 should be one day over 3 years: status %d, want 409", status)
	}
}
