package api_test

import (
	"encoding/json"
	"reflect"
	"testing"
)

// auditDetails decodes the last audit entry's details, checking its action.
func auditDetails(g *rig, action string) map[string][]string {
	g.T.Helper()
	e := g.lastAudit()
	if e.Action != action {
		g.T.Fatalf("last audit action %q, want %q", e.Action, action)
	}
	raw, _ := json.Marshal(e.Details)
	d := map[string][]string{}
	if err := json.Unmarshal(raw, &d); err != nil {
		g.T.Fatal(err)
	}
	return d
}

// Test_REQ_AUD_022_workstream_order_entry_on_real_change: a real change writes exactly one entry with
// names; a change only to the saved list (names no roadmap has) writes one too, with
// saved_from/saved_to; a PUT that changes neither writes nothing.
func Test_REQ_AUD_022_workstream_order_entry_on_real_change(t *testing.T) {
	g := newRig(t)
	r := g.Roadmap(g.Team(testTeamOpts("One", "ONE")), roadmapOpts())
	g.Workstream(r, "Platform")
	put := func(names ...string) {
		g.expect(200, "PUT", "/api/company/workstream-order", map[string]any{"names": names})
	}
	base := g.auditCount()

	put("Platform", "General") // effective order changes: General, Platform -> Platform, General
	if g.auditCount() != base+1 {
		t.Fatalf("real change wrote %d entries, want 1", g.auditCount()-base)
	}
	d := auditDetails(g, "company.workstream_order")
	if !reflect.DeepEqual(d["from"], []string{"General", "Platform"}) || !reflect.DeepEqual(d["to"], []string{"Platform", "General"}) {
		t.Errorf("entry lists names before and after: %v", d)
	}

	put("Platform", "General", "Ghost") // effective order is the same; the saved list gained a name
	if g.auditCount() != base+2 {
		t.Fatalf("saved-only change wrote %d entries, want 1", g.auditCount()-base-1)
	}
	d = auditDetails(g, "company.workstream_order")
	if !reflect.DeepEqual(d["from"], d["to"]) || !reflect.DeepEqual(d["saved_from"], []string{"Platform", "General"}) ||
		!reflect.DeepEqual(d["saved_to"], []string{"Platform", "General", "Ghost"}) {
		t.Errorf("saved-only entry: %v", d)
	}

	put("Platform", "General", "Ghost")   // identical
	put("platform", " GENERAL ", "ghost") // spelling only: not a change either
	if g.auditCount() != base+2 {
		t.Errorf("identical PUTs wrote %d entries", g.auditCount()-base-2)
	}
	put("Platform", "General") // dropping the stale saved name is a saved-only change
	if g.auditCount() != base+3 {
		t.Errorf("removing a saved name wrote %d entries, want 1", g.auditCount()-base-2)
	}
	if d = auditDetails(g, "company.workstream_order"); len(d["saved_from"]) != 3 || len(d["saved_to"]) != 2 {
		t.Errorf("removal entry: %v", d)
	}
}

// Test_REQ_AUD_023_team_order_entry_names_and_saved_only_change: a real change writes one entry with
// team names, not ids; a PUT that only stores the order the teams already show in writes one entry with
// saved_from/saved_to; an identical PUT writes nothing.
func Test_REQ_AUD_023_team_order_entry_names_and_saved_only_change(t *testing.T) {
	t.Run("team order audit only when changed", func(t *testing.T) {
		g := newRig(t)
		a := g.Team(testTeamOpts("A", "AAA"))
		b := g.Team(testTeamOpts("B", "BBB"))
		c := g.Team(testTeamOpts("C", "CCC"))
		base := g.auditCount()

		// The effective order is already A, B, C but nothing is saved yet: the first PUT stores it (future
		// teams then go after these, not alphabetically), which is a real change -> one entry. Saving the
		// same thing again changes nothing -> 200, no entry.
		g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(a, b, c)})
		if g.auditCount() != base+1 {
			t.Errorf("first PUT (saved list changes, effective order does not) wrote %d entries, want 1", g.auditCount()-base)
		}
		g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(a, b, c)})
		if g.auditCount() != base+1 {
			t.Errorf("no-op PUT wrote %d audit entries", g.auditCount()-base-1)
		}
		g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(c, b, a)})
		if g.auditCount() != base+2 {
			t.Errorf("changing PUT wrote %d entries, want 1", g.auditCount()-base-1)
		}

		for name, body := range map[string]any{
			"missing team": map[string]any{"team_ids": teamIDs(a, b)},
			"duplicate":    map[string]any{"team_ids": teamIDs(a, a, b, c)},
			"unknown id":   map[string]any{"team_ids": []int64{a.ID, b.ID, c.ID, 99999}},
			"missing key":  map[string]any{},
			"empty":        map[string]any{"team_ids": []int64{}},
		} {
			status, e := call[errResp](g, "PUT", "/api/company/team-order", body)
			if status != 422 && !(name == "missing key" && status == 422) {
				t.Errorf("%s: status %d, want 422", name, status)
			}
			if _, ok := e.Error.Fields["team_ids"]; !ok {
				t.Errorf("%s: want field team_ids, got %+v", name, e.Error)
			}
		}
		if got := g.teamOrderNames(); !reflect.DeepEqual(got, []string{"C", "B", "A"}) {
			t.Errorf("a refused PUT changed the order: %v", got)
		}
		if g.auditCount() != base+2 {
			t.Errorf("a refused PUT wrote audit entries")
		}
	})

	g := newRig(t)
	a := g.Team(testTeamOpts("Alpha", "AAA"))
	b := g.Team(testTeamOpts("Beta", "BBB"))
	base := g.auditCount()

	g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(b, a)})
	if g.auditCount() != base+1 {
		t.Fatalf("real change wrote %d entries, want 1", g.auditCount()-base)
	}
	d := auditDetails(g, "company.team_order")
	if !reflect.DeepEqual(d["from"], []string{"Alpha", "Beta"}) || !reflect.DeepEqual(d["to"], []string{"Beta", "Alpha"}) ||
		len(d["saved_from"]) != 0 || !reflect.DeepEqual(d["saved_to"], []string{"Beta", "Alpha"}) {
		t.Errorf("entry: %v", d)
	}
	g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(b, a)})
	if g.auditCount() != base+1 {
		t.Errorf("identical PUT wrote an entry")
	}

	// a new team lands after the saved ones; saving that exact order is a saved-only change
	c := g.Team(testTeamOpts("Cora", "CCC"))
	g.expect(200, "PUT", "/api/company/team-order", map[string]any{"team_ids": teamIDs(b, a, c)})
	if g.auditCount() != base+2 {
		t.Fatalf("saved-only change wrote %d entries, want 1", g.auditCount()-base-1)
	}
	d = auditDetails(g, "company.team_order")
	if !reflect.DeepEqual(d["from"], d["to"]) || !reflect.DeepEqual(d["saved_to"], []string{"Beta", "Alpha", "Cora"}) {
		t.Errorf("saved-only entry: %v", d)
	}

}
