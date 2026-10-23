package api_test

import (
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// anonymousWrites are the only write routes that need no session: login and logout.
var anonymousWrites = map[string]bool{
	"POST /api/login": true, "POST /api/logout": true,
}

// concrete turns a chi route pattern into an address with placeholder values.
func concrete(route string) string {
	r := strings.NewReplacer("{id}", "1", "{key}", "star", "{fromId}", "2")
	return r.Replace(route)
}

// Test_REQ_API_002_REQ_AUTH_001_every_write_route_needs_a_session walks every registered route: each write (except
// login and logout) is 401 for an anonymous caller — even with a valid JSON body,
// and before any body is read — and is *not* 401 for the logged-in admin; every anonymous GET is
// reachable, except the users and admin ones, which are 401.
func Test_REQ_API_002_REQ_AUTH_001_every_write_route_needs_a_session(t *testing.T) {
	g := newRig(t)
	type route struct{ method, path string }
	var routes []route
	err := chi.Walk(g.root, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes = append(routes, route{method, strings.TrimSuffix(pattern, "/")})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].method+routes[i].path < routes[j].method+routes[j].path })
	var writes, reads int
	for _, rt := range routes {
		if rt.path == "/mcp" || rt.path == "/mcp/*" { // /mcp has its own rules (REQ_API_056/057): open, or 404 when off
			continue
		}
		key := rt.method + " " + rt.path
		url := concrete(rt.path)
		body := "{}"
		if rt.method == "GET" {
			body = ""
		}
		anon := g.serve(rt.method, url, body, "", "", nil)
		adminOnlyRead := rt.method == "GET" && (rt.path == "/api/users" || strings.HasPrefix(rt.path, "/api/admin/"))
		switch {
		case rt.method == "GET" && !adminOnlyRead:
			reads++
			if anon.code == 401 {
				t.Errorf("%s: an anonymous read got 401 (REQ_AUTH_001)", key)
			}
		case anonymousWrites[key]:
			writes++
			if anon.code == 401 && key != "POST /api/login" {
				t.Errorf("%s must work anonymously, got 401", key)
			}
		default:
			writes++
			if anon.code != 401 || errCode(anon) != "unauthorized" {
				t.Errorf("%s: anonymous = %d %s, want 401 unauthorized", key, anon.code, anon.body)
			}
			// a request with a content type the write would refuse is still 401 first
			if r := g.serve(rt.method, url, body, "", "", map[string]string{"Content-Type": "text/plain"}); r.code != 401 {
				t.Errorf("%s: anonymous bad content type = %d, want 401", key, r.code)
			}
			if ad := g.serve(rt.method, url, body, g.cookie, "", nil); ad.code == 401 {
				t.Errorf("%s: the logged-in admin got 401", key)
			}
		}
	}
	if writes < 25 || reads < 8 {
		t.Fatalf("walked only %d writes and %d reads: the route walk is broken", writes, reads)
	}
	for _, p := range []string{"/api/teams", "/api/icons", "/api/me"} {
		if r := g.serve("GET", p, "", "", "", nil); r.code != 200 {
			t.Errorf("anonymous GET %s = %d, want 200", p, r.code)
		}
	}
	if r := g.serve("GET", "/api/users", "", "", "", nil); r.code != 401 {
		t.Errorf("anonymous GET /api/users = %d, want 401", r.code)
	}
	if r := g.serve("GET", "/api/users", "", g.cookie, "", nil); r.code != 200 {
		t.Errorf("admin GET /api/users = %d, want 200", r.code)
	}
}

// Test_REQ_AUTH_012_a_reader_cannot_change_teams_icons_milestones_or_dependencies: the anonymous
// request is refused 401 and nothing changed in the database.
func Test_REQ_AUTH_012_REQ_API_008_a_reader_cannot_change_teams_icons_milestones_or_dependencies(t *testing.T) {
	g := newRig(t)
	team := g.Team(testTeamOpts("Alpha", "AAA"))
	rm := g.Roadmap(team, roadmapOpts())
	ws := g.Workstream(rm, "WS")
	d1 := g.Deliverable(rm, testutil.DeliverableOpts{StartDay: 0, EndDay: 5})
	d2 := g.Deliverable(rm, testutil.DeliverableOpts{StartDay: 10, EndDay: 15})
	a := g.anon()

	snapshot := func() [5]int {
		return [5]int{
			countRows(g, `SELECT COUNT(*) FROM teams`), countRows(g, `SELECT COUNT(*) FROM icon_labels`),
			countRows(g, `SELECT COUNT(*) FROM milestones`), countRows(g, `SELECT COUNT(*) FROM dependencies`),
			countRows(g, `SELECT COUNT(*) FROM audit_log`) + g.auditCount(),
		}
	}
	before := snapshot()
	var teamName string
	g.DB.QueryRow(`SELECT name FROM teams WHERE id = ?`, team.ID).Scan(&teamName)

	a.expect(401, "POST", "/api/teams", map[string]any{"name": "Rogue", "tag": "RGE"})
	a.expect(401, "PATCH", "/api/teams/"+id(team.ID), map[string]any{"name": "Hijacked"})
	a.expect(401, "DELETE", "/api/teams/"+id(team.ID), nil)
	a.expect(401, "PUT", "/api/icons/star", map[string]any{"label": "Mine now"})
	a.expect(401, "POST", "/api/roadmaps/"+id(rm.ID)+"/milestones", map[string]any{"name": "M", "date": g.Clock.Date(3), "workstream_id": ws.ID})
	a.expect(401, "POST", "/api/deliverables/"+id(d2.ID)+"/dependencies", map[string]any{"from_kind": "deliverable", "from_id": d1.ID})
	a.expect(401, "DELETE", "/api/deliverables/"+id(d1.ID)+"/dependencies/deliverable/"+id(d2.ID), nil)

	if after := snapshot(); after != before {
		t.Errorf("a refused anonymous write changed state: %v -> %v", before, after)
	}
	var nowName string
	g.DB.QueryRow(`SELECT name FROM teams WHERE id = ?`, team.ID).Scan(&nowName)
	if nowName != teamName {
		t.Errorf("team renamed to %q by an anonymous request", nowName)
	}
	// the admin can do the same things
	g.expect(200, "PUT", "/api/icons/star", map[string]any{"label": "Mine now"})
	must[store.Team](g, 201, "POST", "/api/teams", map[string]any{"name": "Rogue", "tag": "RGE"})

	t.Run("team writes are admin only", func(t *testing.T) {
		g := newRig(t)
		a := g.anon()
		tm := g.Team(testTeamOpts("Open", "OPN"))
		if l := must[teamList](a, 200, "GET", "/api/teams", nil); l.Total != 1 {
			t.Errorf("anonymous read: %+v", l)
		}
		if code := a.expect(401, "POST", "/api/teams", map[string]any{"name": "No", "tag": "NO"}); code != "unauthorized" {
			t.Errorf("code %q", code)
		}
		a.expect(401, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"name": "No"})
		a.expect(401, "DELETE", "/api/teams/"+id(tm.ID), nil)
		if l := must[teamList](g, 200, "GET", "/api/teams", nil); l.Total != 1 || l.Items[0].Name != "Open" {
			t.Errorf("state changed: %+v", l)
		}
		g.expect(200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"name": "Renamed"})
		g.expect(204, "DELETE", "/api/teams/"+id(tm.ID), nil)
	})
}
