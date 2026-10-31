package api_test

import (
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

type auditPage struct {
	Items []store.AuditEntry `json:"items"`
	Total int                `json:"total"`
}

// seedAudit inserts a row straight into audit_log (the rig's auditor only records in memory).
func seedAudit(g *rig, ts, user, action, typ string, details string) {
	g.T.Helper()
	var eid any
	if typ != "" {
		eid = 7
	}
	if _, err := g.DB.Exec(`INSERT INTO audit_log(ts, username, action, entity_type, entity_id, roadmap_id, details_json) VALUES (?,?,?,?,?,?,?)`,
		ts, user, action, typ, eid, nil, details); err != nil {
		g.T.Fatal(err)
	}
}

// seedAuditSet is a small log that every filter test reads. Oldest first, so ids grow with time.
func seedAuditSet(g *rig) {
	seedAudit(g, "2030-01-01 08:00:00", "ann", "team.create", "team", `{"team":"Platform","tag":"PL"}`)
	seedAudit(g, "2030-01-02 09:00:00", "bob", "deliverable.create", "deliverable", `{"deliverable":"Launch Beta","roadmap":"R1","team":"Platform"}`)
	seedAudit(g, "2030-01-03 10:00:00", "Ann", "deliverable.update", "deliverable", `{"deliverable":"Billing Rework","roadmap":"R2","team":"Payments"}`)
	seedAudit(g, "2030-01-03 23:59:59", "ann", "dependency.create", "dependency", `{"from":"Billing Rework","from_team":"Payments","to":"Launch Beta","to_team":"Platform"}`)
	seedAudit(g, "2030-01-04 00:00:00", "system", "backup.create", "system", `{"file":"overlens-2030-01-04.db"}`)
}

func getAudit(g *rig, query string) auditPage {
	g.T.Helper()
	return must[auditPage](g, 200, "GET", "/api/admin/audit"+query, nil)
}

func ids(p auditPage) []int64 {
	out := []int64{}
	for _, e := range p.Items {
		out = append(out, e.ID)
	}
	return out
}

func Test_REQ_API_033_audit_list_shape_order_and_total(t *testing.T) {
	t.Run("paging limit offset and cap", func(t *testing.T) {
		g := newRig(t)
		for i := 0; i < 205; i++ {
			seedAudit(g, "2030-02-01 00:00:00", "ann", "team.update", "team", `{}`)
		}
		if p := getAudit(g, ""); len(p.Items) != 50 || p.Total != 205 {
			t.Fatalf("default limit: %d/%d", len(p.Items), p.Total)
		}
		if p := getAudit(g, "?limit=1000"); len(p.Items) != 200 {
			t.Fatalf("max limit: %d", len(p.Items))
		}
		a, b := getAudit(g, "?limit=10&offset=0"), getAudit(g, "?limit=10&offset=10")
		if len(a.Items) != 10 || len(b.Items) != 10 || a.Items[9].ID <= b.Items[0].ID || b.Total != 205 {
			t.Fatalf("pages overlap or total wrong: %v %v", ids(a), ids(b))
		}
		if p := getAudit(g, "?offset=200"); len(p.Items) != 5 {
			t.Fatalf("last page: %d", len(p.Items))
		}
		g.expect(400, "GET", "/api/admin/audit?limit=0", nil)
		g.expect(400, "GET", "/api/admin/audit?offset=-1", nil)
	})

	t.Run("bad date filter is 422", func(t *testing.T) {
		g := newRig(t)
		for _, q := range []string{"?from=yesterday", "?to=2030-13-01", "?from=2030-1-1"} {
			if code := g.expect(422, "GET", "/api/admin/audit"+q, nil); code != "validation_failed" {
				t.Errorf("%s: code %q", q, code)
			}
			g.expect(422, "GET", "/api/admin/audit/export.csv"+q, nil)
		}
	})

	g := newRig(t)
	seedAuditSet(g)
	p := getAudit(g, "")
	if p.Total != 5 || len(p.Items) != 5 {
		t.Fatalf("total %d items %d", p.Total, len(p.Items))
	}
	if p.Items[0].Action != "backup.create" || p.Items[4].Action != "team.create" {
		t.Fatalf("not newest first: %v", ids(p))
	}
	e := p.Items[4]
	if e.TS != "2030-01-01T08:00:00Z" || e.Username != "ann" || e.EntityType != "team" || e.EntityID == nil || *e.EntityID != 7 ||
		e.RoadmapID != nil || e.Details["team"] != "Platform" {
		t.Fatalf("entry shape: %+v", e)
	}
	var raw map[string]json.RawMessage
	_, body := g.send("GET", "/api/admin/audit?limit=1", "", nil)
	if err := json.Unmarshal(body, &raw); err != nil || string(raw["total"]) != "5" {
		t.Fatalf("raw: %s", body)
	}
	empty := getAudit(g, "?user=nobody")
	if empty.Total != 0 || empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty result must be {items: [], total: 0}: %+v", empty)
	}

}

func Test_REQ_AUD_016_each_audit_filter(t *testing.T) {
	g := newRig(t)
	seedAuditSet(g)
	cases := []struct {
		query string
		want  int
	}{
		{"?user=ann", 3}, // case-insensitive: ann and Ann
		{"?user=bob", 1},
		{"?action=deliverable.create", 1},
		{"?action=deliverable", 0}, // exact, not a prefix
		{"?type=deliverable", 2},
		{"?type=system", 1},
		{"?team=platform", 3},    // team.create, deliverable.create, dependency.create (to_team)
		{"?team=Payments", 2},    // deliverable.update, dependency.create (from_team)
		{"?deliverable=beta", 2}, // deliverable.create + dependency "to"
		{"?deliverable=billing", 2},
		{"?deliverable=zzz", 0},
		{"?deliverable=%25", 0}, // % is a character, not a wildcard
		{"?from=2030-01-03", 3},
		{"?to=2030-01-03", 4}, // inclusive of the whole day, including 23:59:59
		{"?from=2030-01-02&to=2030-01-03", 3},
	}
	for _, c := range cases {
		if p := getAudit(g, c.query); p.Total != c.want || len(p.Items) != c.want {
			t.Errorf("%s: total %d items %d, want %d", c.query, p.Total, len(p.Items), c.want)
		}
	}

	t.Run("filters combine with and", func(t *testing.T) {
		g := newRig(t)
		seedAuditSet(g)
		p := getAudit(g, "?user=ann&team=Platform&type=dependency&from=2030-01-03&to=2030-01-03&deliverable=billing")
		if p.Total != 1 || p.Items[0].Action != "dependency.create" {
			t.Fatalf("%+v", p)
		}
		if p := getAudit(g, "?user=bob&type=team"); p.Total != 0 {
			t.Fatal("AND of unrelated filters must be empty")
		}
	})

	t.Run("filter matches milestone names", func(t *testing.T) {
		g := newRig(t)
		seedAudit(g, "2030-01-02 09:00:00", "bob", "milestone.create", "milestone", `{"milestone":"Beta Gate","roadmap":"R1","team":"Platform"}`)
		seedAudit(g, "2030-01-03 09:00:00", "bob", "deliverable.create", "deliverable", `{"deliverable":"Other","roadmap":"R1","team":"Platform"}`)
		p := getAudit(g, "?deliverable=beta+gate")
		if p.Total != 1 || p.Items[0].Action != "milestone.create" {
			t.Errorf("filter result %+v", p)
		}
		_, csv := g.rawGet("/api/admin/audit/export.csv?deliverable=beta+gate")
		if !strings.Contains(csv, "milestone.create") || strings.Contains(csv, "deliverable.create") {
			t.Errorf("csv:\n%s", csv)
		}
	})
}

func (g *rig) rawGet(path string) (*http.Response, string) {
	g.T.Helper()
	req, _ := http.NewRequest("GET", g.srv.URL+path, nil)
	if g.cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: g.cookie})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		g.T.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp, sb.String()
}

func Test_REQ_API_016_csv_headers_quoting_and_formula_guard(t *testing.T) {
	g := newRig(t)
	seedAudit(g, "2030-01-01 08:00:00", "=cmd|' /C calc'!A0", "+SUM(1)", "team", `{"team":"Say \"hi\", ok","note":"line1\nline2"}`)
	seedAudit(g, "2030-01-01 09:00:00", "@evil", "-1+1", "team", `{}`)
	seedAudit(g, "2030-01-01 10:00:00", "fine", "ok, with comma", "", `{}`)
	resp, body := g.rawGet("/api/admin/audit/export.csv")
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/csv") ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment; filename=") {
		t.Fatalf("status %d headers %v", resp.StatusCode, resp.Header)
	}
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatalf("not valid CSV: %v\n%s", err, body)
	}
	if strings.Join(rows[0], ",") != "id,ts,username,action,entity_type,entity_id,roadmap_id,details" || len(rows) != 4 {
		t.Fatalf("rows: %q", rows)
	}
	// newest first: "fine" row, then "@evil", then the quoting row
	if rows[1][3] != "ok, with comma" || rows[1][5] != "" {
		t.Fatalf("row 1: %q", rows[1])
	}
	if rows[2][2] != "'@evil" || rows[2][3] != "'-1+1" {
		t.Fatalf("formula guard missing: %q", rows[2])
	}
	if rows[3][2] != "'=cmd|' /C calc'!A0" || rows[3][3] != "'+SUM(1)" {
		t.Fatalf("formula guard missing: %q", rows[3])
	}
	var d map[string]any
	if err := json.Unmarshal([]byte(rows[3][7]), &d); err != nil || d["team"] != `Say "hi", ok` || d["note"] != "line1\nline2" {
		t.Fatalf("details cell: %q %v", rows[3][7], err)
	}
	if rows[3][1] != "2030-01-01T08:00:00Z" || rows[3][5] != "7" {
		t.Fatalf("row: %q", rows[3])
	}
}

func Test_REQ_API_016_csv_uses_the_same_filters_and_ignores_paging(t *testing.T) {
	t.Run("csv streams more than one page", func(t *testing.T) {
		g := newRig(t)
		for i := 0; i < 1203; i++ {
			seedAudit(g, "2030-02-01 00:00:00", "ann", "team.update", "team", `{}`)
		}
		_, body := g.rawGet("/api/admin/audit/export.csv")
		rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
		if err != nil || len(rows) != 1204 {
			t.Fatalf("rows %d err %v", len(rows), err)
		}
		seen := map[string]bool{}
		for _, r := range rows[1:] {
			seen[r[0]] = true
		}
		if len(seen) != 1203 {
			t.Fatal("paging repeated or skipped rows")
		}
	})

	g := newRig(t)
	seedAuditSet(g)
	for _, q := range []string{"", "?user=ann", "?team=Platform&from=2030-01-02", "?deliverable=billing", "?type=dependency", "?action=nope"} {
		jsonIDs := getAudit(g, q+sepFor(q)+"limit=200")
		_, body := g.rawGet("/api/admin/audit/export.csv" + q + sepFor(q) + "limit=1&offset=1")
		rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		if len(rows)-1 != jsonIDs.Total {
			t.Errorf("%q: csv has %d rows, JSON total %d", q, len(rows)-1, jsonIDs.Total)
		}
	}

}

func sepFor(q string) string {
	if q == "" {
		return "?"
	}
	return "&"
}

func Test_REQ_AUD_021_audit_is_admin_only(t *testing.T) {
	g := newRig(t).anon()
	for _, p := range []string{"/api/admin/audit", "/api/admin/audit/export.csv"} {
		if code := g.expect(401, "GET", p, nil); code != "unauthorized" {
			t.Errorf("%s: %q", p, code)
		}
	}
}

// Test_REQ_API_017 walks the router: nothing can purge the audit log, delete a backup, run one now
// or change retention. The only routes about audit/backups are admin GETs.
func Test_REQ_API_017_REQ_AUD_007_REQ_CFG_007_no_purge_delete_or_run_now_route_exists(t *testing.T) {
	for ep := range registeredEndpoints(t) {
		method, path, _ := strings.Cut(ep, " ")
		lower := strings.ToLower(path)
		if strings.Contains(lower, "audit") || strings.Contains(lower, "backup") || strings.Contains(lower, "retention") ||
			strings.Contains(lower, "purge") || strings.Contains(lower, "admin") {
			if method != "GET" {
				t.Errorf("%s: only GET may touch audit, backups, retention or admin", ep)
			}
		}
		for _, bad := range []string{"purge", "run", "retention", "prune", "vacuum"} {
			if strings.Contains(lower, bad) {
				t.Errorf("%s: forbidden route", ep)
			}
		}
	}
}

// registeredEndpoints walks the real chi router api.New(...).Register(...) builds, normalizing
// chi's route method constants and its own "/*" catch-alls (NotFound/MethodNotAllowed) away.
func registeredEndpoints(t *testing.T) map[string]bool {
	t.Helper()
	env := testutil.NewEnv(t)
	root := chi.NewRouter()
	api.New(env.DB, api.NopAudit{}).Register(root)
	out := map[string]bool{}
	err := chi.Walk(root, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		route = strings.TrimSuffix(route, "/")
		if route == "/mcp" || route == "/mcp/*" { // documented in prose, not in a table (REQ_API_057)
			return nil
		}
		out[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Test_REQ_AUD_008_audit_list_reports_the_configured_retention: the Retention badge reads retention_days
// from the audit list (the Backups endpoint that used to carry it is gone).
func Test_REQ_AUD_008_audit_list_reports_the_configured_retention(t *testing.T) {
	g := newRig(t)
	root := chi.NewRouter()
	api.New(g.DB, g.audit, api.WithAuditRetention(120)).Register(root)
	srv := httptest.NewServer(root)
	t.Cleanup(srv.Close)
	c := *g
	c.srv = srv
	var out struct {
		RetentionDays int `json:"retention_days"`
	}
	_, body := c.send("GET", "/api/admin/audit", "", nil)
	if err := json.Unmarshal(body, &out); err != nil || out.RetentionDays != 120 {
		t.Fatalf("retention_days: %s (%v)", body, err)
	}
}

// Test_REQ_API_053_storage_reports_db_and_log_sizes: admin only; sums every app log file, ignores other files; reports
// the running build (REQ_DEPLOY_010).
func Test_REQ_API_053_storage_reports_db_and_log_sizes(t *testing.T) {
	g := newRig(t)
	dir := t.TempDir()
	write := func(name string, n int) {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("overlens-database.db", 1000)
	write("app.log", 100)
	write("2026-10-17-app.log", 200)
	write("2026-10-17-app.2.log", 50)
	write("notes.txt", 999)
	root := chi.NewRouter()
	api.New(g.DB, g.audit, api.WithStoragePaths(filepath.Join(dir, "overlens-database.db"), dir), api.WithBuild("1.2.3", "2026-10-21T14:02:00Z", "abc1234")).Register(root)
	srv := httptest.NewServer(root)
	t.Cleanup(srv.Close)
	c := *g
	c.srv = srv
	var out struct {
		DBBytes, LogBytes, DiskFreeBytes, DiskTotalBytes int64
		LogFiles                                         int
	}
	_, body := c.send("GET", "/api/admin/storage", "", nil)
	var build struct{ Version, BuildTime, Commit string }
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	m := map[string]int64{}
	for _, k := range []string{"db_bytes", "log_bytes", "log_files", "disk_free_bytes", "disk_total_bytes"} {
		var n int64
		if err := json.Unmarshal(raw[k], &n); err != nil {
			t.Fatalf("%s in %s: %v", k, body, err)
		}
		m[k] = n
	}
	json.Unmarshal(raw["version"], &build.Version)
	json.Unmarshal(raw["build_time"], &build.BuildTime)
	json.Unmarshal(raw["commit"], &build.Commit)
	if build.Version != "1.2.3" || build.BuildTime != "2026-10-21T14:02:00Z" || build.Commit != "abc1234" {
		t.Fatalf("build: %s", body)
	}
	out.DBBytes, out.LogBytes, out.LogFiles = m["db_bytes"], m["log_bytes"], int(m["log_files"])
	out.DiskFreeBytes, out.DiskTotalBytes = m["disk_free_bytes"], m["disk_total_bytes"]
	if out.DBBytes != 1000 || out.LogBytes != 350 || out.LogFiles != 3 {
		t.Fatalf("sizes: %s", body)
	}
	if out.DiskTotalBytes <= 0 || out.DiskFreeBytes <= 0 || out.DiskFreeBytes > out.DiskTotalBytes {
		t.Fatalf("disk space: %s", body)
	}
	if code := g.anon().expect(401, "GET", "/api/admin/storage", nil); code != "unauthorized" {
		t.Fatalf("anonymous code %q", code)
	}
}
