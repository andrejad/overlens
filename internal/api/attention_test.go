package api_test

import (
	"encoding/json"
	"strconv"
	"testing"
)

type restBlock struct {
	Kind              string
	ID                int64
	Name              string
	TeamID            int64  `json:"team_id"`
	TeamTag           string `json:"team_tag"`
	RoadmapID         int64  `json:"roadmap_id"`
	ResponsiblePerson string `json:"responsible_person"`
	StartDate         string `json:"start_date"`
	EndDate           string `json:"end_date"`
}

type restAttention struct {
	Today string
	Days  int
	Items []struct {
		Kind         string
		ID           int64
		Name         string
		TeamID       int64  `json:"team_id"`
		TeamTag      string `json:"team_tag"`
		TeamName     string `json:"team_name"`
		RoadmapTitle string `json:"roadmap_title"`
		Workstreams  []string
		Status       string
		RiskNote     string `json:"risk_note"`
		Signals      []string
		Blocks       []restBlock
	}
}

func (m *mcpRig) attention(query string, want int) (restAttention, []byte) {
	m.T.Helper()
	st, _, body := m.do("GET", "/api/company/attention"+query, nil, "")
	if st != want {
		m.T.Fatalf("GET attention%s: %d %s, want %d", query, st, body, want)
	}
	var a restAttention
	if want == 200 {
		if err := json.Unmarshal(body, &a); err != nil {
			m.T.Fatal(err)
		}
	}
	return a, body
}

// Test_REQ_API_054_attention_list_is_open_and_shaped: no login, "today" is the server's date (injected here),
// default window 14 days, the fields of the contract, and no `links` (that is MCP only).
func Test_REQ_API_054_attention_list_is_open_and_shaped(t *testing.T) {
	m := newMCPRig(t, false)
	d := m.data()
	got, body := m.attention("", 200)
	if got.Today != m.Clock.Date(0) || got.Days != 14 || len(got.Items) != 1 {
		t.Fatalf("attention %s", body)
	}
	it := got.Items[0]
	if it.Kind != "deliverable" || it.ID != d.api.ID || it.Name != "Public API v2" || it.TeamTag != "PLAT" || it.TeamName != "Platform" ||
		it.RoadmapTitle != "Platform roadmap" || it.Status != "at_risk" || it.RiskNote != "Vendor late" || len(it.Workstreams) != 2 || it.Workstreams[0] != "Infrastructure" {
		t.Errorf("item %+v", it)
	}
	var raw struct{ Items []map[string]json.RawMessage }
	_ = json.Unmarshal(body, &raw)
	if _, has := raw.Items[0]["links"]; has {
		t.Error("the REST list has no links")
	}
	if got.Items[0].Signals[0] != "at_risk" || len(got.Items[0].Signals) != 1 {
		t.Errorf("signals %v", got.Items[0].Signals)
	}
	empty, body := m.attention("?team_id="+strconv.FormatInt(d.b.ID, 10), 200)
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Errorf("a team with nothing to report must get items [], got %s", body)
	}
}

// Test_REQ_API_055_attention_blocks_cross_team_and_own_team: everything that waits on the item through a chain,
// of any team and the item's own team too, with team, owner, kind and dates.
func Test_REQ_API_055_attention_blocks_cross_team_and_own_team(t *testing.T) {
	m := newMCPRig(t, false)
	d := m.data()
	got, _ := m.attention("", 200)
	b := got.Items[0].Blocks
	if len(b) != 2 {
		t.Fatalf("blocks %+v", b)
	}
	if b[0].Kind != "deliverable" || b[0].ID != d.sdk.ID || b[0].TeamTag != "MOB" || b[0].TeamID != d.b.ID || b[0].ResponsiblePerson != "Lee" ||
		b[0].StartDate != d.sdk.Start || b[0].EndDate != d.sdk.End || b[0].RoadmapID != d.rb.ID {
		t.Errorf("cross-team block %+v", b[0])
	}
	if b[1].Kind != "milestone" || b[1].ID != d.gate.ID || b[1].TeamTag != "PLAT" || b[1].StartDate != d.gate.Date || b[1].EndDate != d.gate.Date || b[1].ResponsiblePerson != "Dana" {
		t.Errorf("own-team block, reached through the other team's deliverable: %+v", b[1])
	}
}

// Test_REQ_API_054_attention_query_validation: days 1-90, team_id a positive integer (400), an unknown team 404.
func Test_REQ_API_054_attention_query_validation(t *testing.T) {
	m := newMCPRig(t, false)
	d := m.data()
	for _, q := range []string{"?days=0", "?days=91", "?days=abc", "?days=", "?days=-3", "?days=1.5", "?team_id=0", "?team_id=-1", "?team_id=x", "?team_id="} {
		st, _, body := m.do("GET", "/api/company/attention"+q, nil, "")
		var e errResp
		if st != 400 {
			t.Errorf("%s: status %d", q, st)
		}
		if json.Unmarshal(body, &e) != nil || e.Error.Code != "bad_request" {
			t.Errorf("%s: %s, want 400 bad_request", q, body)
		}
	}
	for _, q := range []string{"?days=1", "?days=90", "?team_id=" + strconv.FormatInt(d.a.ID, 10)} {
		m.attention(q, 200)
	}
	if a, _ := m.attention("?days=7", 200); a.Days != 7 {
		t.Errorf("days echoed: %d", a.Days)
	}
	_, body := m.attention("?team_id=99999", 404)
	var e errResp
	if json.Unmarshal(body, &e) != nil || e.Error.Code != "not_found" {
		t.Errorf("unknown team: %s", body)
	}
}
