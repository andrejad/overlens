package api_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// deliverableRig: one team, its roadmap and two workstreams. REQ_DAT_023: the roadmap
// already carries an automatic "General" workstream from creation — reused here (renamed "A")
// instead of adding an extra one, so the roadmap holds exactly two, as the rig's name promises.
func deliverableRig(t *testing.T) (*rig, int64, []int64, string) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, roadmapOpts())
	a := g.renameWorkstream(g.roadmap(rm.ID).Workstreams[0].ID, "A")
	b := g.newWorkstream(rm.ID, "B")
	return g, rm.ID, []int64{a.ID, b.ID}, tm.Color
}

func Test_REQ_DAT_010_status_is_one_of_four_and_never_derived(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	past := g.newDeliverable(rm, ws[:1], -400, -300, nil) // dates long past: status is still what a person set
	if past.Status != "planned" {
		t.Errorf("status derived from dates: %q", past.Status)
	}
	for _, s := range []string{"planned", "in_progress", "done", "at_risk"} {
		if d := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(past.ID), map[string]any{"status": s}); d.Status != s {
			t.Errorf("status %q -> %q", s, d.Status)
		}
	}
	status, e := call[errResp](g, "PATCH", "/api/deliverables/"+id(past.ID), map[string]any{"status": "late"})
	if status != 422 || e.Error.Fields["status"] == "" {
		t.Errorf("bad status: %d %+v", status, e)
	}
	got := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(past.ID), map[string]any{"end_date": g.Clock.Date(-100)})
	if got.Status != "at_risk" || got.EndDate != g.Clock.Date(-100) {
		t.Errorf("date change touched status: %+v", got)
	}
}

func Test_REQ_DAT_011_risk_note_cleared_when_no_longer_at_risk(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	d := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"status": "at_risk", "risk_note": "vendor late"})
	if d.RiskNote != "vendor late" {
		t.Fatalf("note %q", d.RiskNote)
	}
	// editing only the note keeps it
	if u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"risk_note": "still late"}); u.RiskNote != "still late" {
		t.Errorf("note %q", u.RiskNote)
	}
	for _, s := range []string{"in_progress", "done", "planned"} {
		must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"status": "at_risk", "risk_note": "n"})
		u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"status": s})
		if u.RiskNote != "" {
			t.Errorf("status %s left note %q", s, u.RiskNote)
		}
	}
	// a note sent with a non-at-risk status is dropped
	n := g.newDeliverable(rm, ws[:1], 1, 2, map[string]any{"status": "done", "risk_note": "x"})
	if n.RiskNote != "" {
		t.Errorf("created with note %q", n.RiskNote)
	}
	if u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(n.ID), map[string]any{"risk_note": "y"}); u.RiskNote != "" {
		t.Errorf("note accepted on a done deliverable: %q", u.RiskNote)
	}
}

func Test_REQ_DAT_012_deliverable_always_has_a_workstream(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	body := map[string]any{"name": "x", "start_date": g.Clock.Date(0), "end_date": g.Clock.Date(1)}
	g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", body)
	body["workstream_ids"] = []int64{}
	g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", body)
	// a workstream from another roadmap is not accepted
	other := g.Roadmap(g.Team(testTeamOpts("", "")), roadmapOpts())
	foreign := g.newWorkstream(other.ID, "F")
	body["workstream_ids"] = []int64{foreign.ID}
	g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", body)

	d := g.newDeliverable(rm, ws, 0, 5, nil)
	g.expect(422, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"workstream_ids": []int64{}})
	g.expect(422, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"workstream_ids": []int64{foreign.ID}})
	if u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"workstream_ids": ws[1:]}); len(u.WorkstreamIDs) != 1 || u.WorkstreamIDs[0] != ws[1] {
		t.Errorf("membership %+v", u.WorkstreamIDs)
	}
	// unrelated PATCH keeps membership
	if u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"name": "n"}); len(u.WorkstreamIDs) != 1 {
		t.Errorf("membership lost: %+v", u.WorkstreamIDs)
	}
}

func Test_REQ_API_025_guarded_workstream_delete(t *testing.T) {
	t.Run("workstream delete moves milestones", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		g.rawMilestone(rm, ws[0], "Launch", g.Clock.Date(5))
		if c := g.expect(409, "DELETE", "/api/workstreams/"+id(ws[0]), nil); c != "has_roadmap_items" {
			t.Errorf("code %q", c)
		}
		n0 := g.auditCount()
		g.expect(204, "DELETE", "/api/workstreams/"+id(ws[0])+"?target="+id(ws[1]), nil)
		full := g.roadmap(rm)
		if len(full.Milestones) != 1 || full.Milestones[0].WorkstreamID != ws[1] {
			t.Fatalf("milestone not moved to the target: %+v", full.Milestones)
		}
		e := g.lastAudit()
		if g.auditCount() != n0+1 || e.Details["milestones_held"] != 1 {
			t.Errorf("audit %+v", e)
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	both := g.newDeliverable(rm, ws, 0, 5, nil)
	onlyA := g.newDeliverable(rm, ws[:1], 6, 9, nil)
	onlyB := g.newDeliverable(rm, ws[1:], 10, 12, nil)

	// with deliverables and no choice: refused, nothing changes
	if c := g.expect(409, "DELETE", "/api/workstreams/"+id(ws[0]), nil); c != "has_roadmap_items" {
		t.Errorf("code %q", c)
	}
	if n := len(g.roadmap(rm).Workstreams); n != 2 {
		t.Fatalf("workstream deleted anyway: %d", n)
	}
	g.expect(422, "DELETE", "/api/workstreams/"+id(ws[0])+"?target="+id(ws[0]), nil) // itself
	// move: everything lands in B, "both" just loses the A membership
	g.expect(204, "DELETE", "/api/workstreams/"+id(ws[0])+"?target="+id(ws[1]), nil)
	full := g.roadmap(rm)
	if len(full.Workstreams) != 1 || len(full.Deliverables) != 3 {
		t.Fatalf("after move: %d ws, %d deliverables", len(full.Workstreams), len(full.Deliverables))
	}
	for _, d := range full.Deliverables {
		if len(d.WorkstreamIDs) != 1 || d.WorkstreamIDs[0] != ws[1] {
			t.Errorf("deliverable %d in %v", d.ID, d.WorkstreamIDs)
		}
	}
	_ = both
	_ = onlyA

	// an empty workstream needs no choice
	e := g.newWorkstream(rm, "E")
	g.expect(204, "DELETE", "/api/workstreams/"+id(e.ID), nil)
	// range is recomputed after deletes (the latest date left is onlyB's)
	if r := g.roadmap(rm); r.RangeEnd == nil || *r.RangeEnd != g.Clock.Date(12) {
		t.Errorf("range_end %v", r.RangeEnd)
	}
	_ = onlyB

}

// REQ_API_025: there is no mode that deletes a workstream's deliverables — only "move" is accepted;
// a refused request destroys nothing.
func Test_REQ_API_025_workstream_delete_has_no_delete_mode(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	c := g.newWorkstream(rm, "C")
	solo := g.newDeliverable(rm, []int64{c.ID}, 0, 1, nil)
	if code := g.expect(409, "DELETE", "/api/workstreams/"+id(c.ID)+"?deliverables=delete", nil); code != "has_roadmap_items" {
		t.Errorf("code %q", code)
	}
	if got := must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(solo.ID), nil); got.ID != solo.ID {
		t.Error("deliverable destroyed by a refused request")
	}
	if n := len(g.roadmap(rm).Workstreams); n != 3 {
		t.Fatalf("workstream deleted anyway: %d", n)
	}
	// the only real choice is to move its deliverables
	g.expect(204, "DELETE", "/api/workstreams/"+id(c.ID)+"?target="+id(ws[0]), nil)
	if got := must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(solo.ID), nil); len(got.WorkstreamIDs) != 1 || got.WorkstreamIDs[0] != ws[0] {
		t.Errorf("deliverable not moved: %+v", got.WorkstreamIDs)
	}
}

// REQ_DAT_023: a roadmap's last remaining workstream can never be deleted, checked before even the
// deliverables/milestones checks.
func Test_REQ_DAT_023_last_workstream_cannot_be_deleted(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testTeamOpts("", ""))
	rm := g.Roadmap(tm, roadmapOpts())
	// the roadmap's automatic "General" workstream (REQ_DAT_023) is already its only one; reused
	// here instead of adding a second, which would defeat the point of this test.
	only := g.renameWorkstream(g.roadmap(rm.ID).Workstreams[0].ID, "Only")
	if c := g.expect(409, "DELETE", "/api/workstreams/"+id(only.ID), nil); c != "only_workstream" {
		t.Errorf("code %q", c)
	}
	g.newDeliverable(rm.ID, []int64{only.ID}, 0, 1, nil)
	if c := g.expect(409, "DELETE", "/api/workstreams/"+id(only.ID), nil); c != "only_workstream" {
		t.Errorf("code %q (want only_workstream even though it also holds a deliverable)", c)
	}
	other := g.newWorkstream(rm.ID, "Other")
	g.expect(204, "DELETE", "/api/workstreams/"+id(only.ID)+"?target="+id(other.ID), nil)
	if n := len(g.roadmap(rm.ID).Workstreams); n != 1 {
		t.Errorf("workstreams left: %d", n)
	}
	if c := g.expect(409, "DELETE", "/api/workstreams/"+id(other.ID), nil); c != "only_workstream" {
		t.Errorf("code %q", c)
	}
}

func Test_REQ_DAT_013_color_defaults_to_team_and_stays_per_deliverable(t *testing.T) {
	g, rm, ws, teamColor := deliverableRig(t)
	def := g.newDeliverable(rm, ws[:1], 0, 5, nil)
	own := g.newDeliverable(rm, ws[:1], 6, 9, map[string]any{"color": "#010203"})
	if def.Color != teamColor || own.Color != "#010203" {
		t.Errorf("colors %q %q (team %q)", def.Color, own.Color, teamColor)
	}
	tm := must[teamList](g, 200, "GET", "/api/teams", nil).Items[0]
	must[store.Team](g, 200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"default_color": "#abcdef"})
	if got := must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(def.ID), nil); got.Color != teamColor {
		t.Errorf("existing deliverable recolored to %q", got.Color)
	}
	if fresh := g.newDeliverable(rm, ws[:1], 10, 11, nil); fresh.Color != "#abcdef" {
		t.Errorf("new deliverable color %q", fresh.Color)
	}
	if u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(own.ID), map[string]any{"name": "x"}); u.Color != "#010203" {
		t.Errorf("own color lost: %q", u.Color)
	}
	g.expect(422, "PATCH", "/api/deliverables/"+id(own.ID), map[string]any{"color": "blue"})
}

func Test_REQ_DAT_014_links_are_labelled_http_urls(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	for _, bad := range []string{"javascript:alert(1)", "ftp://x.org/a", "example.com", "//x.org", "https://", ""} {
		status, e := call[errResp](g, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", map[string]any{
			"name": "x", "start_date": g.Clock.Date(0), "end_date": g.Clock.Date(1), "workstream_ids": ws[:1],
			"links": []map[string]string{{"label": "l", "url": bad}}})
		if status != 422 || e.Error.Fields["links"] == "" {
			t.Errorf("url %q: %d %+v", bad, status, e)
		}
	}
	d := g.newDeliverable(rm, ws[:1], 0, 1, map[string]any{"links": []map[string]string{
		{"label": "First", "url": "https://a.example/x?y=1"}, {"label": "Second", "url": "http://b.example"}, {"label": "Third", "url": "https://c.example"}}})
	if len(d.Links) != 3 || d.Links[0].Label != "First" || d.Links[2].Position != 2 || d.Links[1].ID == 0 {
		t.Errorf("links %+v", d.Links)
	}
	before := g.auditCount()
	u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"links": []map[string]string{{"label": "Renamed", "url": "https://a.example/x"}}})
	if len(u.Links) != 1 || u.Links[0].Label != "Renamed" {
		t.Errorf("links %+v", u.Links)
	}
	if g.auditCount() != before+1 { // one link change request = one audit entry
		t.Errorf("audit entries %d", g.auditCount()-before)
	}
	// not sending links leaves them alone
	if u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"name": "n"}); len(u.Links) != 1 {
		t.Errorf("links lost: %+v", u.Links)
	}
	g.expect(422, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"links": []map[string]string{{"label": "x", "url": "gopher://x"}}})

	t.Run("milestone links", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		m := g.newMilestoneWith(rm, ws[0], map[string]any{"links": []map[string]string{{"label": " Plan ", "url": "https://example.com/p"}}})
		if len(m.Links) != 1 || m.Links[0].Label != "Plan" || m.Links[0].Position != 0 || m.Links[0].ID == 0 {
			t.Fatalf("created %+v", m.Links)
		}
		// a PATCH without links leaves them; with links it replaces the set
		u := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"name": "Renamed"})
		if len(u.Links) != 1 || u.Links[0].ID != m.Links[0].ID {
			t.Errorf("links changed by a PATCH without links: %+v", u.Links)
		}
		u = must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"links": []map[string]string{
			{"label": "B", "url": "http://example.com/b"}, {"label": "C", "url": "https://example.com/c"}}})
		if len(u.Links) != 2 || u.Links[0].Label != "B" || u.Links[1].Position != 1 {
			t.Errorf("replaced %+v", u.Links)
		}
		if n := g.linkRows("milestone", m.ID); n != 2 {
			t.Errorf("%d rows in roadmap_item_links", n)
		}
		// 422, field links
		long := make([]map[string]string, 51)
		for i := range long {
			long[i] = map[string]string{"url": "https://example.com/x"}
		}
		for name, links := range map[string]any{
			"javascript": []map[string]string{{"url": "javascript:alert(1)"}},
			"ftp":        []map[string]string{{"url": "ftp://example.com"}},
			"label":      []map[string]string{{"label": strings.Repeat("a", 201), "url": "https://example.com"}},
			"url":        []map[string]string{{"url": "https://example.com/" + strings.Repeat("a", 2000)}},
			"51 links":   long,
		} {
			status, e := call[errResp](g, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"links": links})
			if status != 422 || e.Error.Fields["links"] == "" {
				t.Errorf("%s: %d %+v", name, status, e)
			}
		}
		// the refused requests changed nothing
		if got, _ := g.milestoneByID(rm, m.ID); len(got.Links) != 2 {
			t.Errorf("links after refused requests: %+v", got.Links)
		}
		// delete takes the links (no foreign key, REQ_DAT_031)
		g.expect(204, "DELETE", "/api/milestones/"+id(m.ID), nil)
		if n := g.linkRows("milestone", m.ID); n != 0 {
			t.Errorf("%d orphan links after milestone delete", n)
		}
	})
}

// REQ_API_027: a deliverable PATCH writes at most one deliverable.update entry for the whole
// request, listing every field that actually changed as {field, from, to} — never split into one
// entry per field (that pattern stays for team PATCH only), never a whole before/after object.
func Test_REQ_API_027_deliverable_patch_writes_one_entry_listing_every_changed_field(t *testing.T) {
	t.Run("milestone update audits new fields", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		m := g.newMilestoneWith(rm, ws[0], nil)
		n0 := g.auditCount()
		body := map[string]any{"responsible_person": "Dana", "status": "at_risk", "risk_note": "vendor",
			"links": []map[string]string{{"label": "Plan", "url": "https://example.com/p"}}}
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), body)
		if g.auditCount() != n0+1 {
			t.Fatalf("%d entries, want 1", g.auditCount()-n0)
		}
		e := g.lastAudit()
		raw := fmt.Sprint(e.Details["changes"])
		if e.Action != "milestone.update" {
			t.Fatalf("action %s", e.Action)
		}
		for _, f := range []string{"responsible_person", "status", "risk_note", "links", "Plan https://example.com/p"} {
			if !strings.Contains(raw, f) {
				t.Errorf("changes lack %q: %s", f, raw)
			}
		}
		// the same request again changes nothing: no audit entry, same link ids
		before := g.roadmap(rm).Milestones
		n1 := g.auditCount()
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), body)
		after := g.roadmap(rm).Milestones
		if g.auditCount() != n1 {
			t.Errorf("no-op PATCH wrote an audit entry")
		}
		for i := range before {
			if before[i].ID == m.ID && before[i].Links[0].ID != after[i].Links[0].ID {
				t.Errorf("no-op PATCH rewrote the links")
			}
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	d := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"responsible_person": "Ann", "description_html": "<p>a</p>",
		"icons": []string{"flag"}, "links": []map[string]string{{"label": "L1", "url": "https://a.example"}}})
	n0 := g.auditCount()
	u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{
		"name": "Renamed", "start_date": g.Clock.Date(1), "end_date": g.Clock.Date(6), "color": "#abcdef",
		"responsible_person": "Bo", "description_html": "<p>b</p>", "status": "in_progress",
		"workstream_ids": ws, "icons": []string{"rocket"}, "links": []map[string]string{{"label": "L2", "url": "https://b.example"}}})
	// one entry for the whole request, no matter how many fields changed
	if got := g.auditCount() - n0; got != 1 {
		t.Fatalf("want 1 entry, got %d", got)
	}
	e := g.lastAudit()
	if e.Action != "deliverable.update" || e.Details["deliverable"] != u.Name {
		t.Fatalf("entry %+v", e)
	}
	type change struct{ Field, From, To string }
	var changes []change
	raw, _ := json.Marshal(e.Details["changes"])
	if err := json.Unmarshal(raw, &changes); err != nil {
		t.Fatal(err)
	}
	// 7 simple fields changed (risk_note stays empty, so is not listed) + workstreams + icons + links = 10
	if len(changes) != 10 {
		t.Fatalf("want 10 changes, got %d: %+v", len(changes), changes)
	}
	byField := map[string]change{}
	for _, c := range changes {
		if _, dup := byField[c.Field]; dup {
			t.Errorf("field %q listed twice: %+v", c.Field, changes)
		}
		byField[c.Field] = c
	}
	if c := byField["name"]; c.From != "D0-5" || c.To != "Renamed" {
		t.Errorf("name change %+v", c)
	}
	if _, ok := byField["risk_note"]; ok {
		t.Error("unchanged risk_note listed as a change")
	}
	// workstream, icon and link changes are reported by name, not id (REQ_AUD_003)
	if c := byField["workstreams"]; c.From != "A" || c.To != "A, B" {
		t.Errorf("workstreams change %+v", c)
	}
	if c := byField["icons"]; c.From != "flag" || c.To != "rocket" {
		t.Errorf("icons change %+v", c)
	}
	if c := byField["links"]; c.From != "L1 https://a.example" || c.To != "L2 https://b.example" {
		t.Errorf("links change %+v", c)
	}
	// unchanged values and an empty patch write nothing
	n1 := g.auditCount()
	must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(u.ID), map[string]any{"name": u.Name, "status": u.Status})
	must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(u.ID), map[string]any{})
	if g.auditCount() != n1 {
		t.Errorf("no-op PATCH wrote %d entries", g.auditCount()-n1)
	}

}

func Test_REQ_API_005_deliverable_validation(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	post := func(m map[string]any) errResp {
		body := map[string]any{"name": "x", "start_date": g.Clock.Date(0), "end_date": g.Clock.Date(1), "workstream_ids": ws[:1]}
		for k, v := range m {
			body[k] = v
		}
		status, e := call[errResp](g, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", body)
		if status != 422 {
			t.Errorf("%v: status %d", m, status)
		}
		return e
	}
	if e := post(map[string]any{"end_date": g.Clock.Date(-1)}); e.Error.Fields["end_date"] == "" {
		t.Errorf("end before start: %+v", e)
	}
	for _, bad := range []string{"", "2026-13-01", "2026-9-1", "tomorrow", "2026-02-30"} {
		if e := post(map[string]any{"start_date": bad}); e.Error.Fields["start_date"] == "" {
			t.Errorf("start %q accepted: %+v", bad, e)
		}
	}
	post(map[string]any{"name": ""})
	post(map[string]any{"icons": []string{"Not A Key!"}})
	// same-day deliverable is fine
	g.newDeliverable(rm, ws[:1], 3, 3, nil)
	d := g.newDeliverable(rm, ws[:1], 4, 6, nil)
	g.expect(422, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{"end_date": g.Clock.Date(3)})
	g.expect(404, "POST", "/api/roadmaps/"+id(g.noSuchID())+"/deliverables", map[string]any{"name": "x"})

	t.Run("deliverable free text length limits", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		post := func(extra map[string]any) errResp {
			body := map[string]any{"name": "x", "start_date": g.Clock.Date(0), "end_date": g.Clock.Date(1), "workstream_ids": ws[:1]}
			for k, v := range extra {
				body[k] = v
			}
			status, e := call[errResp](g, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", body)
			if status != 422 {
				t.Errorf("%v: status %d", extra, status)
			}
			return e
		}
		if e := post(map[string]any{"responsible_person": strings.Repeat("é", 201)}); e.Error.Fields["responsible_person"] == "" {
			t.Errorf("responsible_person over the limit accepted: %+v", e)
		}
		if e := post(map[string]any{"status": "at_risk", "risk_note": strings.Repeat("x", 2001)}); e.Error.Fields["risk_note"] == "" {
			t.Errorf("risk_note over the limit accepted: %+v", e)
		}
		if e := post(map[string]any{"links": []map[string]string{{"label": strings.Repeat("l", 201), "url": "https://a.example"}}}); e.Error.Fields["links"] == "" {
			t.Errorf("link label over the limit accepted: %+v", e)
		}
		longURL := "https://a.example/" + strings.Repeat("x", 2000)
		if e := post(map[string]any{"links": []map[string]string{{"label": "l", "url": longURL}}}); e.Error.Fields["links"] == "" {
			t.Errorf("link url over the limit accepted: %+v", e)
		}
		var manyLinks []map[string]string
		for i := 0; i < 51; i++ {
			manyLinks = append(manyLinks, map[string]string{"label": "l", "url": "https://a.example"})
		}
		if e := post(map[string]any{"links": manyLinks}); e.Error.Fields["links"] == "" {
			t.Errorf("51 links accepted: %+v", e)
		}
		var manyIcons []string
		for i := 0; i < 21; i++ {
			manyIcons = append(manyIcons, fmt.Sprintf("icon%d", i)) // distinct keys: duplicates would just be compacted away
		}
		if e := post(map[string]any{"icons": manyIcons}); e.Error.Fields["icons"] == "" {
			t.Errorf("21 icons accepted: %+v", e)
		}
		big := strings.Repeat("<p>a</p>", 15000) // sanitized survivor is still over 100KB
		if e := post(map[string]any{"description_html": big}); e.Error.Fields["description_html"] == "" {
			t.Errorf("oversized description_html accepted: %+v", e)
		}
		// exactly at the limit is fine
		must[store.Deliverable](g, 201, "POST", "/api/roadmaps/"+id(rm)+"/deliverables", map[string]any{
			"name": "ok", "start_date": g.Clock.Date(0), "end_date": g.Clock.Date(1), "workstream_ids": ws[:1],
			"responsible_person": strings.Repeat("é", 200)})
	})
}

// REQ_API_030: description_html is cleaned on save with an allow-list — scripts, event handlers,
// style and javascript: links never survive, whichever client sent them; paragraphs, headings,
// bold/italic, lists and http(s) links do.
func Test_REQ_API_030_description_html_is_sanitized(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	dirty := `<p onclick="evil()">Hi <script>alert(1)</script><b>bold</b> <em>it</em> ` +
		`<a href="javascript:alert(1)">bad link</a> <a href="https://ok.example">good link</a></p>` +
		`<style>.x{color:red}</style><h2>Heading</h2><ul><li>one</li></ul>`
	d := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"description_html": dirty})
	for _, bad := range []string{"<script", "onclick", "<style", "javascript:"} {
		if contains(d.DescriptionHTML, bad) {
			t.Errorf("description still contains %q: %s", bad, d.DescriptionHTML)
		}
	}
	for _, good := range []string{"<p>", "<b>bold</b>", "<em>it</em>", "<h2>Heading</h2>", "<ul>", "<li>one</li>", `href="https://ok.example"`} {
		if !contains(d.DescriptionHTML, good) {
			t.Errorf("description lost %q: %s", good, d.DescriptionHTML)
		}
	}
	// PATCH is sanitized too, not just create
	u := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(d.ID), map[string]any{
		"description_html": `<img src=x onerror="alert(1)"><p>clean</p>`})
	if contains(u.DescriptionHTML, "onerror") || contains(u.DescriptionHTML, "<img") {
		t.Errorf("PATCH description not sanitized: %s", u.DescriptionHTML)
	}
	if !contains(u.DescriptionHTML, "<p>clean</p>") {
		t.Errorf("PATCH description lost allowed content: %s", u.DescriptionHTML)
	}

	t.Run("milestone description is sanitised and limited", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		dirty := `<p onclick="x()">Hi<script>alert(1)</script> <a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a></p>`
		m := g.newMilestoneWith(rm, ws[0], map[string]any{"description_html": dirty})
		for _, bad := range []string{"<script", "onclick", "javascript:"} {
			if strings.Contains(m.DescriptionHTML, bad) {
				t.Errorf("create kept %q: %s", bad, m.DescriptionHTML)
			}
		}
		if !strings.Contains(m.DescriptionHTML, `href="https://ok.example"`) {
			t.Errorf("lost good link: %s", m.DescriptionHTML)
		}
		u := must[store.Milestone](g, 200, "PATCH", "/api/milestones/"+id(m.ID),
			map[string]any{"description_html": `<img src=x onerror="a()"><p>clean</p>`})
		if u.DescriptionHTML != "<p>clean</p>" {
			t.Errorf("patch %q", u.DescriptionHTML)
		}
		// 100 KB counts after cleaning
		before := g.auditCount()
		big := strings.Repeat("a", 100*1024+1)
		if c := g.expect(422, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"description_html": "<p>" + big + "</p>"}); c != "validation_failed" {
			t.Errorf("code %q", c)
		}
		if c := g.expect(422, "POST", "/api/roadmaps/"+id(rm)+"/milestones",
			map[string]any{"name": "B", "date": g.Clock.Date(5), "workstream_id": ws[0], "description_html": big}); c != "validation_failed" {
			t.Errorf("create code %q", c)
		}
		if g.auditCount() != before {
			t.Error("refused writes were audited")
		}
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"description_html": strings.Repeat("a", 100*1024)})
		pad := strings.Repeat("<script>x</script>", 10000) + "<p>small</p>"
		g.expect(200, "PATCH", "/api/milestones/"+id(m.ID), map[string]any{"description_html": pad})
		if got, _ := g.milestoneByID(rm, m.ID); got.DescriptionHTML != "<p>small</p>" {
			t.Errorf("stored %q", got.DescriptionHTML)
		}
	})
}

// REQ_DAT_026, REQ_API_029: every deliverable-workstream membership stores a row; it's returned
// alongside workstream_ids, a PATCH can set it, and the server only ever picks one itself (the
// lowest free row) when the deliverable enters a workstream it wasn't already in.
func Test_REQ_DAT_026_and_API_029_membership_rows(t *testing.T) {
	g, rm, ws, _ := deliverableRig(t)
	a := g.newDeliverable(rm, ws[:1], 0, 10, nil)
	if len(a.Workstreams) != 1 || a.Workstreams[0].ID != ws[0] || a.Workstreams[0].Row != 0 {
		t.Fatalf("first deliverable in a workstream should take row 0: %+v", a.Workstreams)
	}
	// b overlaps a's dates in the same workstream: it must not reuse row 0
	b := g.newDeliverable(rm, ws[:1], 5, 15, nil)
	if len(b.Workstreams) != 1 || b.Workstreams[0].Row == 0 {
		t.Fatalf("overlapping deliverable took the occupied row: %+v", b.Workstreams)
	}
	// c does not overlap a or b (starts after b ends): it can reuse row 0
	c := g.newDeliverable(rm, ws[:1], 20, 25, nil)
	if len(c.Workstreams) != 1 || c.Workstreams[0].Row != 0 {
		t.Fatalf("non-overlapping deliverable did not reuse the free row: %+v", c.Workstreams)
	}

	// PATCH can move a's row explicitly
	moved := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(a.ID), map[string]any{
		"rows": map[string]int{fmt.Sprint(ws[0]): 5}})
	if moved.Workstreams[0].Row != 5 {
		t.Errorf("PATCH did not set the row: %+v", moved.Workstreams)
	}
	// an unrelated PATCH does not disturb the row the user set
	again := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(a.ID), map[string]any{"name": "renamed"})
	if again.Workstreams[0].Row != 5 {
		t.Errorf("row changed by an unrelated PATCH: %+v", again.Workstreams)
	}
	// a write to one item leaves every OTHER item's stored row untouched
	rowOf := func(itemID int64) int {
		d := must[store.Deliverable](g, 200, "GET", "/api/deliverables/"+id(itemID), nil)
		return d.Workstreams[0].Row
	}
	bRow, cRow := b.Workstreams[0].Row, c.Workstreams[0].Row
	if got := rowOf(b.ID); got != bRow {
		t.Errorf("renaming a moved b's row: %d -> %d", bRow, got)
	}
	if got := rowOf(c.ID); got != cRow {
		t.Errorf("renaming a moved c's row: %d -> %d", cRow, got)
	}
	// deleting one item does not move the others either
	g.expect(204, "DELETE", "/api/deliverables/"+id(c.ID), nil)
	if got := rowOf(b.ID); got != bRow {
		t.Errorf("deleting c moved b's row: %d -> %d", bRow, got)
	}
	if got := rowOf(a.ID); got != 5 {
		t.Errorf("deleting c moved a's row: %d, want 5", got)
	}
	// rows naming a workstream the deliverable isn't in is refused
	g.expect(422, "PATCH", "/api/deliverables/"+id(a.ID), map[string]any{"rows": map[string]int{fmt.Sprint(ws[1]): 0}})

	// entering a NEW workstream (via workstream_ids) places it at the lowest free row there, and
	// never touches the row it already had in a workstream it stays in
	d := g.newDeliverable(rm, ws[1:], 0, 5, nil) // occupies row 0 of ws[1]
	moved2 := must[store.Deliverable](g, 200, "PATCH", "/api/deliverables/"+id(a.ID), map[string]any{"workstream_ids": ws})
	var rowInWS0, rowInWS1 int
	for _, m := range moved2.Workstreams {
		if m.ID == ws[0] {
			rowInWS0 = m.Row
		}
		if m.ID == ws[1] {
			rowInWS1 = m.Row
		}
	}
	if rowInWS0 != 5 {
		t.Errorf("row in the workstream it already had membership in changed: %d, want 5", rowInWS0)
	}
	if rowInWS1 == d.Workstreams[0].Row { // a's dates (0-10, now moved... still 0-10) overlap d's (0-5): must not collide
		t.Errorf("newly entered workstream did not get a free row: a=%d d=%d", rowInWS1, d.Workstreams[0].Row)
	}
}

// REQ_AUD_003: deliverable.delete names every dependency it takes with it — both ends' names and
// teams — not just a count, so the entry stays readable after the other deliverable is itself gone.
func Test_REQ_AUD_003_deliverable_delete_names_removed_dependencies(t *testing.T) {
	t.Run("workstream delete audits target by name", func(t *testing.T) {
		g, rm, ws, _ := deliverableRig(t)
		target := g.newWorkstream(rm, "D")
		g.newDeliverable(rm, []int64{ws[0]}, 5, 6, nil)
		n0 := g.auditCount()
		g.expect(204, "DELETE", "/api/workstreams/"+id(ws[0])+"?target="+id(target.ID), nil)
		if g.auditCount() != n0+1 {
			t.Fatalf("entries %d", g.auditCount()-n0)
		}
		e := g.lastAudit()
		if e.Details["workstream"] != "A" {
			t.Errorf("workstream field %v", e.Details["workstream"])
		}
		if e.Details["target_workstream"] != "D" {
			t.Errorf("target_workstream %v", e.Details["target_workstream"])
		}
	})

	g, rm, ws, _ := deliverableRig(t)
	tm := must[teamList](g, 200, "GET", "/api/teams", nil).Items[0]
	prereq := g.newDeliverable(rm, ws[:1], 0, 5, map[string]any{"name": "Prereq"})
	dependent := g.newDeliverable(rm, ws[:1], 10, 15, map[string]any{"name": "Dependent"})
	g.Dependency(testutil.Deliverable{ID: prereq.ID}, testutil.Deliverable{ID: dependent.ID}) // dependent depends on prereq

	n0 := g.auditCount()
	g.expect(204, "DELETE", "/api/deliverables/"+id(dependent.ID), nil)
	if g.auditCount() != n0+1 {
		t.Fatalf("entries %d", g.auditCount()-n0)
	}
	e := g.lastAudit()
	deps, _ := e.Details["dependencies_removed"].([]string)
	if len(deps) != 1 || !contains(deps[0], "Prereq", tm.Name) {
		t.Errorf("dependencies_removed %+v", e.Details["dependencies_removed"])
	}

}
