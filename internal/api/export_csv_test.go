package api_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/testutil"
)

type m = map[string]any

// richRoadmap builds a roadmap through the API that uses every kind of metadata.
func (g *rig) richRoadmap() (testutil.Team, testutil.Roadmap) {
	t := g.Team(testutil.TeamOpts{Name: "Platform", Tag: "PLT", Color: "#112233"})
	rm := g.Roadmap(t, testutil.RoadmapOpts{Title: "2026 plan, v2"})
	build := g.newWorkstream(rm.ID, "Build")
	general := g.firstWorkstreamOf(rm.ID)
	a := g.newDeliverable(rm.ID, []int64{general, build.ID}, 0, 20, map[string]any{
		"name": "=Alpha, first", "description_html": "<p>Hello <strong>world</strong></p><p>second</p>", "responsible_person": "Ana",
		"color": "#ff0000", "icons": []string{"flag", "rocket"}, "status": "at_risk", "risk_note": "vendor late",
		"links": []m{{"label": "Spec", "url": "https://example.com/spec"}}})
	b := g.newDeliverable(rm.ID, []int64{general}, 30, 60, map[string]any{"name": "Beta"})
	g.rawMilestone(rm.ID, build.ID, "Launch", g.Clock.Date(70))
	g.expect(201, "POST", "/api/deliverables/"+id(b.ID)+"/dependencies", m{"from_kind": "deliverable", "from_id": a.ID})
	return t, rm
}

// REQ_IMP_001, 002, 003: the export file carries everything, no database ids, file-local keys,

func Test_REQ_API_023_export_csv_format(t *testing.T) {
	t.Run("csv milestone row", func(t *testing.T) {
		g := newRig(t)
		_, rm := g.richRoadmap()
		mid := g.roadmap(rm.ID).Milestones[0].ID
		g.expect(200, "PATCH", "/api/milestones/"+id(mid), map[string]any{"name": "=Launch", "responsible_person": "Dana", "status": "at_risk",
			"risk_note": "vendor", "links": []map[string]string{{"label": "Plan", "url": "https://example.com/p"}}})
		_, body := g.rawGet("/api/roadmaps/" + id(rm.ID) + "/export.csv")
		if !strings.Contains(body, `'=Launch,`) || !strings.Contains(body, ",at_risk,vendor,Dana,,,Plan (https://example.com/p),,milestone\r\n") {
			t.Errorf("milestone row:\n%s", body)
		}
	})

	g := newRig(t)
	_, rm := g.richRoadmap()
	resp, body := g.rawGet("/api/roadmaps/" + id(rm.ID) + "/export.csv")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/csv; charset=utf-8" {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	wantName := fmt.Sprintf("attachment; filename=\"overlens-plt-2026-plan-v2-%s.csv\"", time.Now().Format("2006-01-02"))
	if cd := resp.Header.Get("Content-Disposition"); cd != wantName {
		t.Errorf("Content-Disposition %q, want %q", cd, wantName)
	}
	if !strings.HasPrefix(body, "\xEF\xBB\xBF") {
		t.Error("no UTF-8 BOM")
	}
	body = strings.TrimPrefix(body, "\xEF\xBB\xBF")
	if strings.Contains(strings.ReplaceAll(body, "\r\n", ""), "\r") || !strings.HasSuffix(body, "\r\n") {
		t.Error("line ends must be CRLF")
	}
	if !strings.HasPrefix(body, "team,roadmap,workstreams,name,start_date,end_date,status,risk_note,responsible,color,description,links,prerequisites,kind\r\n") {
		t.Errorf("header: %q", body)
	}
	for _, want := range []string{
		`"2026 plan, v2"`,                 // comma: quoted
		`General; Build`,                  // workstreams joined with "; "
		`"'=Alpha, first"`,                // formula guard, then quoted
		"\"Hello world\nsecond\"",         // plain-text description, the line break quoted
		`Spec (https://example.com/spec)`, // links
		`at_risk,vendor late,Ana,#ff0000`, // plain fields
		`Beta,` + g.Clock.Date(30),        // second row
	} {
		if !strings.Contains(body, want) {
			t.Errorf("CSV lacks %q:\n%s", want, body)
		}
	}
	// Beta's prerequisites cell is Alpha's name, guarded and quoted like any other cell
	if !strings.Contains(body, `,"'=Alpha, first",deliverable`+"\r\n") {
		t.Errorf("Beta's prerequisites cell:\n%s", body)
	}
	// REQ_API_023: the milestone has a row too, kind last, date as start and end, empty color
	if !strings.Contains(body, ",Launch,"+g.Clock.Date(70)+","+g.Clock.Date(70)+",planned,,,,,,,milestone\r\n") {
		t.Errorf("milestone row:\n%s", body)
	}

}

func Test_REQ_API_023_csv_cell_rules(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testutil.TeamOpts{})
	rm := g.Roadmap(tm, testutil.RoadmapOpts{})
	ws := g.firstWorkstreamOf(rm.ID)
	for i, name := range []string{"+plus", "-minus", "@at", `say "hi"`, "plain"} {
		g.newDeliverable(rm.ID, []int64{ws}, i*20, i*20+10, map[string]any{"name": name})
	}
	_, body := g.rawGet("/api/roadmaps/" + id(rm.ID) + "/export.csv")
	for _, want := range []string{"'+plus", "'-minus", "'@at", `"say ""hi"""`, ",plain,"} {
		if !strings.Contains(body, want) {
			t.Errorf("CSV lacks %q:\n%s", want, body)
		}
	}

	t.Run("csv prefixes tab and carriage return", func(t *testing.T) {
		g := newRig(t)
		tm := g.Team(testutil.TeamOpts{})
		rm := g.Roadmap(tm, testutil.RoadmapOpts{})
		ws := g.firstWorkstreamOf(rm.ID)
		for i, v := range []string{"\tTabbed", "\rReturned", "plain"} {
			g.newDeliverable(rm.ID, []int64{ws}, i*20, i*20+10, map[string]any{"responsible_person": v})
		}
		_, body := g.rawGet("/api/roadmaps/" + id(rm.ID) + "/export.csv")
		for _, want := range []string{"'\tTabbed", "\"'\rReturned\"", ",plain,"} {
			if !strings.Contains(body, want) {
				t.Errorf("CSV lacks %q:\n%q", want, body)
			}
		}
	})
}

// REQ_API_023: a dangerous first character after leading spaces is defused too (one shared helper).
func Test_REQ_API_023_csv_guard_sees_past_leading_spaces(t *testing.T) {
	g := newRig(t)
	tm := g.Team(testutil.TeamOpts{})
	rm := g.Roadmap(tm, testutil.RoadmapOpts{})
	ws := g.firstWorkstreamOf(rm.ID)
	for i, v := range []string{"  =cmd", " @at", "  plain"} {
		g.newDeliverable(rm.ID, []int64{ws}, i*20, i*20+10, map[string]any{"responsible_person": v})
	}
	_, body := g.rawGet("/api/roadmaps/" + id(rm.ID) + "/export.csv")
	for _, want := range []string{"'  =cmd", "' @at", ",  plain,"} {
		if !strings.Contains(body, want) {
			t.Errorf("CSV lacks %q:\n%s", want, body)
		}
	}
}
