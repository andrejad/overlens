package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/andrejad/overlens/internal/logging"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

// mcpData is a small company: Platform and Mobile, a deliverable in two workstreams, a milestone, a done item
// and a chain public API -> Mobile SDK -> Gateway go-live. "Today" is day 0.
type mcpData struct {
	a, b                 testutil.Team
	ra, rb               testutil.Roadmap
	api, sdk, old        testutil.Deliverable
	gate                 testutil.Milestone
	infra, security, bws testutil.Workstream
}

func (m *mcpRig) data() *mcpData {
	d := &mcpData{}
	e := m.Env
	d.a = e.Team(testutil.TeamOpts{Name: "Platform", Tag: "PLAT"})
	d.b = e.Team(testutil.TeamOpts{Name: "Mobile", Tag: "MOB"})
	d.ra = e.Roadmap(d.a, testutil.RoadmapOpts{Title: "Platform roadmap"})
	d.rb = e.Roadmap(d.b, testutil.RoadmapOpts{Title: "Mobile roadmap"})
	d.infra, d.security = e.Workstream(d.ra, "Infrastructure"), e.Workstream(d.ra, "Security")
	d.bws = e.Workstream(d.rb, "INFRASTRUCTURE ") // trimmed on save; merges with Platform's in the company view
	d.api = e.Deliverable(d.ra, testutil.DeliverableOpts{Name: "Public API v2", StartDay: 0, EndDay: 40, WorkstreamIDs: []int64{d.infra.ID, d.security.ID}})
	d.sdk = e.Deliverable(d.rb, testutil.DeliverableOpts{Name: "Mobile SDK", StartDay: 50, EndDay: 90, WorkstreamIDs: []int64{d.bws.ID}})
	d.old = e.Deliverable(d.ra, testutil.DeliverableOpts{Name: "Old thing", StartDay: -30, EndDay: -10, WorkstreamIDs: []int64{d.infra.ID}})
	d.gate = e.Milestone(d.ra, testutil.MilestoneOpts{Name: "Gateway go-live", Day: 95, WorkstreamID: d.security.ID})
	e.Dependency(d.api, d.sdk)
	e.ItemDependency(store.KindDeliverable, d.sdk.ID, store.KindMilestone, d.gate.ID)
	desc := "<p>Core   API <b>rewrite</b></p>"
	links := []store.LinkInput{{Label: "Spec", URL: "https://example.com/spec"}, {Label: "", URL: "https://example.com/b?x=1&y=2"}}
	if _, _, _, _, _, err := store.DeliverableUpdate(context.Background(), e.DB, d.api.ID,
		store.DeliverableInput{DescriptionHTML: &desc, Links: &links}); err != nil {
		e.T.Fatal(err)
	}
	m.setOwnerStatus(store.KindDeliverable, d.api.ID, "Dana", "at_risk")
	if _, err := e.DB.Exec(`UPDATE deliverables SET risk_note='Vendor late' WHERE id=?`, d.api.ID); err != nil {
		e.T.Fatal(err)
	}
	m.setOwnerStatus(store.KindDeliverable, d.sdk.ID, "Lee", "planned")
	m.setOwnerStatus(store.KindDeliverable, d.old.ID, "Dana", "done")
	m.setOwnerStatus(store.KindMilestone, d.gate.ID, "Dana", "in_progress")
	return d
}

// item is the AiItem shape as a client sees it.
type item struct {
	Kind              string
	ID                int64
	Name              string
	TeamTag           string `json:"team_tag"`
	TeamName          string `json:"team_name"`
	RoadmapID         int64  `json:"roadmap_id"`
	RoadmapTitle      string `json:"roadmap_title"`
	Workstreams       []string
	ResponsiblePerson string `json:"responsible_person"`
	StartDate         string `json:"start_date"`
	EndDate           string `json:"end_date"`
	Status            string
	RiskNote          string `json:"risk_note"`
	Description       string
	Links             []struct{ Label, URL string }
	Link              string
}

func names(items []item) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func sameStrings(t *testing.T, what string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("%s: %v, want %v", what, got, want)
	}
}

// Test_REQ_API_056_exactly_five_read_only_tools: the handshake names the server and offers tools only; tools/list
// has exactly the five tools, all marked read only; the SDK's own client can list and call them over HTTP.
func Test_REQ_API_056_exactly_five_read_only_tools(t *testing.T) {
	m := newMCPRig(t, true)
	r := m.rpc(nil, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "1"}})
	var init struct {
		Capabilities map[string]any
		ServerInfo   struct{ Name, Version string }
	}
	if err := json.Unmarshal(r.Result, &init); err != nil || init.ServerInfo.Name != "overlens" || init.ServerInfo.Version != "9.9.9" {
		t.Errorf("serverInfo %+v %v", init.ServerInfo, err)
	}
	if len(init.Capabilities) != 1 || init.Capabilities["tools"] == nil {
		t.Errorf("capabilities %v, want tools only", init.Capabilities)
	}
	var list struct {
		Tools []struct {
			Name, Description string
			Annotations       struct{ ReadOnlyHint bool }
		}
	}
	if err := json.Unmarshal(m.rpc(nil, "tools/list", nil).Result, &list); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, tl := range list.Tools {
		got = append(got, tl.Name)
		if !tl.Annotations.ReadOnlyHint {
			t.Errorf("%s is not marked read only", tl.Name)
		}
	}
	slices.Sort(got)
	sameStrings(t, "tools", got, []string{"find_items", "get_roadmap", "list_teams", "needs_attention", "trace_dependencies"})

	d := m.data()
	ctx := context.Background()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "sdk-client", Version: "1"}, nil).Connect(ctx, &mcp.StreamableClientTransport{Endpoint: m.srv.URL + "/mcp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	tools, err := cs.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 5 {
		t.Fatalf("SDK client lists %d tools: %v", len(tools.Tools), err)
	}
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "get_roadmap", Arguments: map[string]any{"team": "plat"}})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, d.api.Name) {
		t.Errorf("SDK client get_roadmap: %v %+v", err, res)
	}
}

// Test_REQ_API_056_endpoint_checks_answer_in_the_standard_shape: GET and DELETE are 405, a body that is not
// JSON-typed 415, one over 4 MiB 413 (all in the standard error shape), and no cookie is needed or set.
func Test_REQ_API_056_endpoint_checks_answer_in_the_standard_shape(t *testing.T) {
	m := newMCPRig(t, true)
	check := func(what string, status int, wantStatus int, body []byte, code string) {
		t.Helper()
		var e errResp
		if status != wantStatus || json.Unmarshal(body, &e) != nil || e.Error.Code != code {
			t.Errorf("%s: %d %s, want %d %s", what, status, body, wantStatus, code)
		}
	}
	for _, method := range []string{"GET", "DELETE"} {
		st, h, b := m.do(method, "/mcp", nil, "")
		check(method, st, 405, b, "bad_request")
		if h.Get("Allow") != "POST" {
			t.Errorf("%s: Allow %q", method, h.Get("Allow"))
		}
	}
	st, _, b := m.post(map[string]string{"Content-Type": "text/plain"}, `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	check("text/plain", st, 415, b, "unsupported_media_type")
	st, _, b = m.post(nil, `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"`+strings.Repeat("x", 4<<20)+`"}`)
	check("5 MiB", st, 413, b, "bad_request")
	st, h, _ := m.post(nil, `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if st != 200 || h.Get("Set-Cookie") != "" {
		t.Errorf("ping without login: %d, cookie %q", st, h.Get("Set-Cookie"))
	}
}

// Test_REQ_API_056_calling_every_tool_changes_nothing: no audit row and no change to any roadmap data.
func Test_REQ_API_056_calling_every_tool_changes_nothing(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	snap := func() (string, int) {
		teams, err := store.CompanyRoadmaps(context.Background(), m.DB)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(teams)
		var n int
		if err := m.DB.QueryRow(`SELECT COUNT(*) FROM audit_log`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return string(b), n
	}
	before, auditBefore := snap()
	m.call(nil, "list_teams", map[string]any{})
	m.call(nil, "get_roadmap", map[string]any{"team": "MOB"})
	m.call(nil, "find_items", map[string]any{"text": "api"})
	m.call(nil, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.api.ID})
	m.call(nil, "needs_attention", map[string]any{})
	m.call(nil, "get_roadmap", map[string]any{"team": "nope"})
	after, auditAfter := snap()
	if before != after {
		t.Error("the roadmap data changed")
	}
	if auditBefore != auditAfter {
		t.Errorf("audit rows %d -> %d, want none written", auditBefore, auditAfter)
	}
}

// Test_REQ_API_062_list_teams_counts_each_roadmap_item_once: deliverables and milestones together, in the
// company team order, a deliverable in two workstreams counted once.
func Test_REQ_API_062_list_teams_counts_each_roadmap_item_once(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	type counts struct {
		Planned    int
		InProgress int `json:"in_progress"`
		AtRisk     int `json:"at_risk"`
		Done       int
	}
	type teamList struct {
		Teams []struct {
			ID        int64
			Name, Tag string
			Roadmap   struct {
				ID          int64
				Title, Link string
			}
			RoadmapItems counts `json:"roadmap_items"`
		}
	}
	out := mcpOK[teamList](m, "list_teams", map[string]any{})
	if len(out.Teams) != 2 || out.Teams[0].Tag != "MOB" || out.Teams[1].Tag != "PLAT" { // company order: by name until saved
		t.Fatalf("teams %+v", out.Teams)
	}
	out.Teams[0], out.Teams[1] = out.Teams[1], out.Teams[0]
	// Platform: Public API v2 (in two workstreams, at risk), Old thing (done), Gateway go-live (in progress)
	if c := out.Teams[0].RoadmapItems; c != (counts{Planned: 0, InProgress: 1, AtRisk: 1, Done: 1}) {
		t.Errorf("Platform counts %+v: the two-workstream deliverable must count once", c)
	}
	if c := out.Teams[1].RoadmapItems; c != (counts{Planned: 1}) {
		t.Errorf("Mobile counts %+v", c)
	}
	if rm := out.Teams[0].Roadmap; rm.ID != d.ra.ID || rm.Title != "Platform roadmap" || rm.Link != m.srv.URL+"/#/teams/"+strconv.FormatInt(d.a.ID, 10) {
		t.Errorf("roadmap %+v", rm)
	}
}

// Test_REQ_API_058_get_roadmap_by_tag_or_name: either, ignoring case; items are deliverables then milestones;
// the dependencies touching the roadmap; an unknown team is an isError result naming the teams there are.
func Test_REQ_API_058_get_roadmap_by_tag_or_name(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	type ref struct {
		Kind, Name string
		TeamTag    string `json:"team_tag"`
		ID         int64
	}
	type rm struct {
		Roadmap struct {
			ID         int64
			Title      string
			TeamTag    string  `json:"team_tag"`
			TeamName   string  `json:"team_name"`
			RangeStart *string `json:"range_start"`
			RangeEnd   *string `json:"range_end"`
			Link       string
		}
		Workstreams  []string
		Items        []item
		Dependencies []struct{ From, To ref }
	}
	for _, team := range []string{"PLAT", "plat", "platform", " PLATFORM "} {
		got := mcpOK[rm](m, "get_roadmap", map[string]any{"team": team})
		if got.Roadmap.ID != d.ra.ID || got.Roadmap.TeamTag != "PLAT" || got.Roadmap.TeamName != "Platform" || got.Roadmap.RangeStart == nil || got.Roadmap.RangeEnd == nil {
			t.Fatalf("%q: roadmap %+v", team, got.Roadmap)
		}
	}
	got := mcpOK[rm](m, "get_roadmap", map[string]any{"team": "PLAT"})
	sameStrings(t, "workstreams in position order", got.Workstreams, []string{"General", "Infrastructure", "Security"})
	sameStrings(t, "items: deliverables then milestones by start", names(got.Items), []string{"Old thing", "Public API v2", "Gateway go-live"})
	if len(got.Dependencies) != 2 || got.Dependencies[0].From.Name != "Public API v2" || got.Dependencies[0].To.Name != "Mobile SDK" || got.Dependencies[0].To.TeamTag != "MOB" ||
		got.Dependencies[1].From.Name != "Mobile SDK" || got.Dependencies[1].To.Kind != "milestone" || got.Dependencies[1].To.ID != d.gate.ID {
		t.Errorf("dependencies %+v", got.Dependencies)
	}
	if ws := got.Items[1].Workstreams; !slices.Equal(ws, []string{"Infrastructure", "Security"}) {
		t.Errorf("deliverable workstreams, primary first: %v", ws)
	}
	isErr, text := m.call(nil, "get_roadmap", map[string]any{"team": "PLATX"})
	if !isErr || text != `no team with tag or name "PLATX"; teams are: MOB, PLAT` {
		t.Errorf("unknown team: %v %q", isErr, text)
	}
	if isErr, _ := m.call(nil, "get_roadmap", map[string]any{}); !isErr {
		t.Error("a missing team must be an isError result")
	}
}

// Test_REQ_API_058_find_items_filters: any mix of text, team, owner, status, workstream and date window;
// workstream names merge the way the company view does; at most 100, with total and truncated.
func Test_REQ_API_058_find_items_filters(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	type found struct {
		Items     []item
		Total     int
		Truncated bool
	}
	find := func(args map[string]any) found { t.Helper(); return mcpOK[found](m, "find_items", args) }
	sameStrings(t, "no argument: everything, by start date", names(find(map[string]any{}).Items),
		[]string{"Old thing", "Public API v2", "Mobile SDK", "Gateway go-live"})
	sameStrings(t, "text in the name", names(find(map[string]any{"text": "api V2"}).Items), []string{"Public API v2"})
	sameStrings(t, "text in the description as plain text, ignoring case", names(find(map[string]any{"text": "API REWRITE"}).Items), []string{"Public API v2"})
	sameStrings(t, "text matches nothing", names(find(map[string]any{"text": "<b>"}).Items), []string{})
	sameStrings(t, "team by name", names(find(map[string]any{"team": "mobile"}).Items), []string{"Mobile SDK"})
	sameStrings(t, "owner", names(find(map[string]any{"owner": "DAN"}).Items), []string{"Old thing", "Public API v2", "Gateway go-live"})
	sameStrings(t, "status", names(find(map[string]any{"status": "done"}).Items), []string{"Old thing"})
	sameStrings(t, "status of a milestone", names(find(map[string]any{"status": "in_progress"}).Items), []string{"Gateway go-live"})
	sameStrings(t, "workstream across teams, merged", names(find(map[string]any{"workstream": "infrastructure"}).Items), []string{"Old thing", "Public API v2", "Mobile SDK"})
	sameStrings(t, "workstream and team", names(find(map[string]any{"workstream": "INFRASTRUCTURE", "team": "MOB"}).Items), []string{"Mobile SDK"})
	sameStrings(t, "second workstream of a deliverable", names(find(map[string]any{"workstream": "security"}).Items), []string{"Public API v2", "Gateway go-live"})
	d0, d35, d45, d60 := m.Clock.Date(0), m.Clock.Date(35), m.Clock.Date(45), m.Clock.Date(60)
	sameStrings(t, "window overlap", names(find(map[string]any{"from": d35, "to": d60}).Items), []string{"Public API v2", "Mobile SDK"})
	sameStrings(t, "window between the two", names(find(map[string]any{"from": d45, "to": d45}).Items), []string{})
	sameStrings(t, "window from", names(find(map[string]any{"from": m.Clock.Date(91)}).Items), []string{"Gateway go-live"})
	sameStrings(t, "window to", names(find(map[string]any{"to": m.Clock.Date(-20)}).Items), []string{"Old thing"})
	sameStrings(t, "mix", names(find(map[string]any{"owner": "dana", "from": d0, "to": d0, "status": "at_risk"}).Items), []string{"Public API v2"})
	for what, args := range map[string]map[string]any{"status": {"status": "late"}, "from": {"from": "next week"}, "team": {"team": "XX"}} {
		if isErr, text := m.call(nil, "find_items", args); !isErr || text == "" {
			t.Errorf("bad %s: want an isError sentence, got %v %q", what, isErr, text)
		}
	}

	// text matches the whole description, not the 500 characters an item carries; the cut's ellipsis is not text
	long := "<p>" + strings.Repeat("word ", 150) + "needle</p>"
	if _, _, _, _, _, err := store.DeliverableUpdate(context.Background(), m.DB, d.sdk.ID, store.DeliverableInput{DescriptionHTML: &long}); err != nil {
		t.Fatal(err)
	}
	hit := find(map[string]any{"text": "NEEDLE"}).Items
	sameStrings(t, "text beyond character 500", names(hit), []string{"Mobile SDK"})
	if len(hit) == 1 && (strings.Contains(hit[0].Description, "needle") || !strings.HasSuffix(hit[0].Description, "…")) {
		t.Errorf("the returned description is still cut: %q", hit[0].Description[len(hit[0].Description)-20:])
	}
	sameStrings(t, "the ellipsis is not text", names(find(map[string]any{"text": "…"}).Items), []string{})

	// 120 milestones: only 100 come back, the total says how many matched
	e := m.Env
	tm := e.Team(testutil.TeamOpts{Tag: "BIG"})
	r := e.Roadmap(tm, testutil.RoadmapOpts{})
	for i := 0; i < 120; i++ {
		e.Milestone(r, testutil.MilestoneOpts{Name: "Gate " + strconv.Itoa(i), Day: i})
	}
	big := find(map[string]any{"team": "big"})
	if len(big.Items) != 100 || big.Total != 120 || !big.Truncated {
		t.Errorf("120 matches: %d items, total %d, truncated %v", len(big.Items), big.Total, big.Truncated)
	}
	if small := find(map[string]any{"team": "plat"}); small.Truncated || small.Total != len(small.Items) {
		t.Errorf("small result: %+v", small.Total)
	}
}

// Test_REQ_API_056_trace_dependencies: the same sets as the REST trace, as AiItems, with the edges; an
// unknown item or kind is an isError sentence.
func Test_REQ_API_056_trace_dependencies(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	type trace struct {
		Root          item
		Prerequisites []item
		Dependents    []item
		Edges         []struct{ From, To struct{ Kind, Name string } }
	}
	got := mcpOK[trace](m, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.sdk.ID})
	if got.Root.Name != "Mobile SDK" || got.Root.Kind != "deliverable" {
		t.Errorf("root %+v", got.Root)
	}
	sameStrings(t, "prerequisites", names(got.Prerequisites), []string{"Public API v2"})
	sameStrings(t, "dependents", names(got.Dependents), []string{"Gateway go-live"})
	if len(got.Edges) != 2 || got.Edges[0].From.Name != "Public API v2" || got.Edges[0].To.Name != "Mobile SDK" {
		t.Errorf("edges %+v", got.Edges)
	}
	// through a chain: everything that waits on the first item, across teams
	chain := mcpOK[trace](m, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.api.ID})
	sameStrings(t, "chain dependents by start date", names(chain.Dependents), []string{"Mobile SDK", "Gateway go-live"})
	ms := mcpOK[trace](m, "trace_dependencies", map[string]any{"kind": "milestone", "id": d.gate.ID})
	if ms.Root.StartDate != ms.Root.EndDate || ms.Root.Kind != "milestone" || ms.Root.Status != "in_progress" {
		t.Errorf("milestone root: %+v", ms.Root)
	}
	if isErr, text := m.call(nil, "trace_dependencies", map[string]any{"kind": "deliverable", "id": 99999}); !isErr || !strings.Contains(text, "no deliverable with id 99999") {
		t.Errorf("unknown item: %v %q", isErr, text)
	}
	if isErr, _ := m.call(nil, "trace_dependencies", map[string]any{"kind": "feature", "id": 1}); !isErr {
		t.Error("unknown kind must be an isError result")
	}
}

// Test_REQ_API_054_needs_attention_tool: the REST list's items as AiItems with signals and blocks; team and days.
func Test_REQ_API_054_needs_attention_tool(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	type attention struct {
		Today string
		Days  int
		Items []struct {
			item
			Signals []string
			Blocks  []item
		}
	}
	got := mcpOK[attention](m, "needs_attention", map[string]any{})
	if got.Today != m.Clock.Date(0) || got.Days != 14 || len(got.Items) != 1 {
		t.Fatalf("attention %+v", got)
	}
	it := got.Items[0]
	sameStrings(t, "signals", it.Signals, []string{"at_risk"})
	sameStrings(t, "blocks", names(it.Blocks), []string{"Mobile SDK", "Gateway go-live"})
	if it.Name != "Public API v2" || it.Link != m.srv.URL+"/#/company/trace/deliverable/"+strconv.FormatInt(d.api.ID, 10) || it.Blocks[0].Link == "" {
		t.Errorf("item %+v", it.item)
	}
	if w := mcpOK[attention](m, "needs_attention", map[string]any{"team": "mob", "days": 90}); w.Days != 90 || len(w.Items) != 1 || w.Items[0].Name != "Mobile SDK" {
		sigs := ""
		for _, i := range w.Items {
			sigs += i.Name + " "
		}
		t.Errorf("Mobile with a 90-day window: %d %s", w.Days, sigs)
	}
	for _, days := range []int{0, 91} {
		if isErr, text := m.call(nil, "needs_attention", map[string]any{"days": days}); !isErr || !strings.Contains(text, "1 to 90") {
			t.Errorf("days %d: %v %q", days, isErr, text)
		}
	}
	if isErr, _ := m.call(nil, "needs_attention", map[string]any{"team": "nope"}); !isErr {
		t.Error("unknown team must be an isError result")
	}
}

// Test_REQ_API_059_link_scheme: https when the request itself is TLS or the first X-Forwarded-Proto value is
// https (trimmed, any case), else http; built from the Host header.
func Test_REQ_API_059_link_scheme(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	host := strings.TrimPrefix(m.srv.URL, "http://")
	path := "/#/company/trace/deliverable/" + strconv.FormatInt(d.api.ID, 10)
	linkWith := func(headers map[string]string) string {
		t.Helper()
		isErr, text := m.call(headers, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.api.ID})
		var tr struct{ Root item }
		if isErr || json.Unmarshal([]byte(text), &tr) != nil {
			t.Fatalf("%s", text)
		}
		return tr.Root.Link
	}
	for hdr, want := range map[string]string{
		"": "http", "https": "https", "HTTPS": "https", " https ": "https", "https, http": "https", "https,http": "https",
		"http": "http", "http, https": "http", "ftp": "http", "xhttps": "http",
	} {
		h := map[string]string{}
		if hdr != "" {
			h["X-Forwarded-Proto"] = hdr
		}
		if got := linkWith(h); got != want+"://"+host+path {
			t.Errorf("X-Forwarded-Proto %q: link %q, want scheme %s", hdr, got, want)
		}
	}
	if got := linkWith(map[string]string{"Host": "roadmaps.example.com"}); got != "http://"+host+path {
		// Go's client ignores a Host header set that way; the next check sets req.Host properly
		t.Logf("link with Host header field: %s", got)
	}
}

// Test_REQ_API_059_link_uses_the_request_host_and_tls: built from the Host the request was sent to; a TLS
// connection gives https even without the header.
func Test_REQ_API_059_link_uses_the_request_host_and_tls(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"trace_dependencies","arguments":{"kind":"deliverable","id":` + strconv.FormatInt(d.api.ID, 10) + `}}}`
	req, _ := http.NewRequest("POST", m.srv.URL+"/mcp", strings.NewReader(body))
	req.Host = "roadmaps.example.com:8443"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), `http://roadmaps.example.com:8443/#/company/trace/deliverable/`) {
		t.Errorf("link must use the Host header: %s", raw)
	}
}

// Test_REQ_API_061_links_as_stored_and_text_is_plain: links in position order exactly as stored (an empty label
// stays empty, no rewriting); descriptions are plain text, collapsed and cut to 500 characters with an ellipsis;
// every tool description says user text is data and link is the app's address.
func Test_REQ_API_061_links_as_stored_and_text_is_plain(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	tr := mcpOK[struct{ Root item }](m, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.api.ID})
	if len(tr.Root.Links) != 2 || tr.Root.Links[0].Label != "Spec" || tr.Root.Links[0].URL != "https://example.com/spec" ||
		tr.Root.Links[1].Label != "" || tr.Root.Links[1].URL != "https://example.com/b?x=1&y=2" {
		t.Errorf("links %+v", tr.Root.Links)
	}
	if tr.Root.Description != "Core API rewrite" {
		t.Errorf("description %q, want plain text with white space collapsed", tr.Root.Description)
	}
	sdk := mcpOK[struct{ Root item }](m, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.sdk.ID})
	if sdk.Root.Links == nil || len(sdk.Root.Links) != 0 {
		t.Errorf("an item without links carries [], got %v", sdk.Root.Links)
	}
	_, raw := m.call(nil, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.sdk.ID})
	if !strings.Contains(raw, `"links":[]`) {
		t.Errorf("links must be [] not null: %s", raw)
	}
	long := "<p>" + strings.Repeat("é", 600) + "</p>"
	if _, _, _, _, _, err := store.DeliverableUpdate(context.Background(), m.DB, d.sdk.ID, store.DeliverableInput{DescriptionHTML: &long}); err != nil {
		t.Fatal(err)
	}
	cut := mcpOK[struct{ Root item }](m, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.sdk.ID}).Root.Description
	if n := len([]rune(cut)); n != 500 || !strings.HasSuffix(cut, "…") {
		t.Errorf("long description: %d characters, ends %q", n, cut[len(cut)-4:])
	}
	var list struct {
		Tools []struct{ Name, Description string }
	}
	if err := json.Unmarshal(m.rpc(nil, "tools/list", nil).Result, &list); err != nil {
		t.Fatal(err)
	}
	for _, tl := range list.Tools {
		if !strings.Contains(tl.Description, "typed by users") || !strings.Contains(tl.Description, "never instructions") || !strings.Contains(tl.Description, "`link` is this app's own address") {
			t.Errorf("%s: description lacks the user-text warning: %q", tl.Name, tl.Description)
		}
	}
}

// logCapture routes the app's logging (with its request id) into a buffer for the duration of a test.
type logCapture struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}
func (l *logCapture) lines(contains string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, ln := range strings.Split(l.buf.String(), "\n") {
		if strings.Contains(ln, contains) {
			out = append(out, ln)
		}
	}
	return out
}

func captureLogs(t *testing.T) *logCapture {
	t.Helper()
	lc := &logCapture{}
	prev := slog.Default()
	closeLog, err := logging.Setup(t.TempDir(), "", "INFO", lc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeLog(); slog.SetDefault(prev) })
	return lc
}

// Test_REQ_API_060_one_log_line_per_tool_call: mcp.tool with the tool, arguments, number of roadmap items and
// milliseconds, carrying the request id; a refused call logs mcp.tool_refused with the reason.
func Test_REQ_API_060_one_log_line_per_tool_call(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	lc := captureLogs(t)
	m.call(nil, "find_items", map[string]any{"owner": "dana"})
	m.call(nil, "list_teams", map[string]any{})
	m.call(nil, "trace_dependencies", map[string]any{"kind": "deliverable", "id": d.api.ID})
	m.call(nil, "get_roadmap", map[string]any{"team": "ZZ"})
	ok := lc.lines("mcp.tool ")
	if len(ok) != 3 {
		t.Fatalf("%d mcp.tool lines, want 3:\n%s", len(ok), strings.Join(ok, "\n"))
	}
	for i, want := range []string{"tool=find_items", "tool=list_teams", "tool=trace_dependencies"} {
		if !strings.Contains(ok[i], want) || !strings.Contains(ok[i], "args=") || !strings.Contains(ok[i], "items=") || !strings.Contains(ok[i], "ms=") || !strings.Contains(ok[i], "request_id=") {
			t.Errorf("line %d lacks %s, args, items, ms or request_id: %s", i, want, ok[i])
		}
	}
	if !strings.Contains(ok[0], "items=3") || !strings.Contains(ok[0], "dana") || !strings.Contains(ok[2], "items=3") {
		t.Errorf("find_items must log 3 items and its arguments, trace 3: %s | %s", ok[0], ok[2])
	}
	refused := lc.lines("mcp.tool_refused")
	if len(refused) != 1 || !strings.Contains(refused[0], "tool=get_roadmap") || !strings.Contains(refused[0], "no team with tag or name") || !strings.Contains(refused[0], "ZZ") {
		t.Errorf("refused call lines: %v", refused)
	}
	if got := lc.lines("mcp.tool"); len(got) != 4 {
		t.Errorf("%d tool lines for 4 calls, want one each", len(got))
	}
}

// Test_REQ_API_063_origin_must_be_the_requests_own_host: a foreign Origin is 403 forbidden (logged); the same
// host, with or without a scheme-matching port, and no Origin are accepted.
func Test_REQ_API_063_origin_must_be_the_requests_own_host(t *testing.T) {
	m := newMCPRig(t, true)
	lc := captureLogs(t)
	host := strings.TrimPrefix(m.srv.URL, "http://")
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	for origin, want := range map[string]int{
		"": 200, "http://" + host: 200, "https://" + host: 200, "HTTP://" + strings.ToUpper(host): 200,
		"http://evil.example": 403, "http://evil.example:" + strings.Split(host, ":")[1]: 403, "http://127.0.0.1": 403,
		"http://" + host + ".evil.example": 403, "null": 403, "garbage": 403,
	} {
		st, _, body := m.post(map[string]string{"Origin": origin}, ping)
		if st != want {
			t.Errorf("Origin %q: %d, want %d (%s)", origin, st, want, body)
		}
		if want == 403 {
			var e errResp
			if json.Unmarshal(body, &e) != nil || e.Error.Code != "forbidden" {
				t.Errorf("Origin %q: body %s, want the standard forbidden error", origin, body)
			}
		}
	}
	if len(lc.lines("Origin names another host")) < 6 {
		t.Errorf("refused origins must be logged, got %d lines", len(lc.lines("Origin names another host")))
	}
}

// Test_REQ_API_057_switched_off_answers_404_in_the_standard_shape: through the real router with the app's page
// as the fallback; the REST attention list does not depend on the switch.
func Test_REQ_API_057_switched_off_answers_404_in_the_standard_shape(t *testing.T) {
	m := newMCPRig(t, false)
	for _, tc := range []struct{ method, path string }{{"POST", "/mcp"}, {"GET", "/mcp"}, {"DELETE", "/mcp"}, {"POST", "/mcp/"}, {"POST", "/mcp/x"}} {
		st, h, body := m.do(tc.method, tc.path, nil, `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
		var e errResp
		if st != 404 || !strings.HasPrefix(h.Get("Content-Type"), "application/json") || json.Unmarshal(body, &e) != nil || e.Error.Code != "not_found" || strings.Contains(string(body), "the app") {
			t.Errorf("%s %s: %d %s %s, want 404 not_found JSON, not the app's page", tc.method, tc.path, st, h.Get("Content-Type"), body)
		}
	}
	if st, _, body := m.do("GET", "/some/other/page", nil, ""); st != 200 || !strings.Contains(string(body), "the app") {
		t.Errorf("the fallback page must still work: %d %s", st, body)
	}
	if st, _, _ := m.do("GET", "/api/company/attention", nil, ""); st != 200 {
		t.Errorf("attention list with mcp off: %d", st)
	}
	on := newMCPRig(t, true)
	if st, _, _ := on.post(nil, `{"jsonrpc":"2.0","id":1,"method":"ping"}`); st != 200 {
		t.Errorf("switched on: %d", st)
	}
}

// Test_REQ_API_059_https_link_on_a_tls_connection: a request that itself arrived over TLS gets an https link
// without any X-Forwarded-Proto header.
func Test_REQ_API_059_https_link_on_a_tls_connection(t *testing.T) {
	m := newMCPRig(t, true)
	d := m.data()
	ts := httptest.NewTLSServer(m.srv.Config.Handler)
	defer ts.Close()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"trace_dependencies","arguments":{"kind":"deliverable","id":` + strconv.FormatInt(d.api.ID, 10) + `}}}`
	req, _ := http.NewRequest("POST", ts.URL+"/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), `https://`+strings.TrimPrefix(ts.URL, "https://")+`/#/company/trace/deliverable/`) {
		t.Errorf("a TLS request must get an https link: %s", raw)
	}
}
