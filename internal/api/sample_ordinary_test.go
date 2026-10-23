package api_test

import (
	"context"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/demo"
)

// Test_REQ_DEMO_014_sample_data_is_ordinary_data loads the shipped sample company into a fresh database (the
// one place a test may use it, REQ_TEST_020) and treats it like anything else: the API refuses and allows the
// same things as for a team a user made. Every team can be renamed and every item edited and deleted, a team
// is deleted the usual way (only once its roadmap holds no items), and no column in the schema marks any
// of it as sample data.
func Test_REQ_DEMO_014_sample_data_is_ordinary_data(t *testing.T) {
	g := newRig(t)
	created, err := demo.EnsureSample(context.Background(), g.DB, true, g.Clock.Day(0), nil)
	if err != nil || !created {
		t.Fatalf("sample not loaded: created=%v err=%v", created, err)
	}

	// nothing marks it as special: no column of any table is named after sample/demo data, besides the one-off meta row
	rows, err := g.DB.Query(`SELECT m.name, p.name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type='table'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var table, col string
		if err := rows.Scan(&table, &col); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.ToLower(col), "sample") || strings.Contains(strings.ToLower(col), "demo") {
			t.Errorf("%s.%s marks rows as sample data", table, col)
		}
	}
	rows.Close()

	list := must[teamList](g, 200, "GET", "/api/teams", nil)
	if len(list.Items) == 0 {
		t.Fatal("the sample company has no team")
	}
	for _, tm := range list.Items {
		// edit by hand: rename the team, rename its first workstream, change a deliverable
		g.expect(200, "PATCH", "/api/teams/"+id(tm.ID), map[string]any{"name": "Renamed " + tm.Name})
		full := g.roadmap(tm.RoadmapID)
		if len(full.Workstreams) == 0 {
			t.Fatalf("sample team %q has no workstream", tm.Name)
		}
		g.expect(200, "PATCH", "/api/workstreams/"+id(full.Workstreams[0].ID), map[string]any{"name": "Renamed workstream"})
		if len(full.Deliverables) > 0 {
			g.expect(200, "PATCH", "/api/deliverables/"+id(full.Deliverables[0].ID), map[string]any{"name": "Edited by hand"})
		}

		// the usual protections apply: the team is not deleted while its roadmap holds items
		if len(full.Deliverables)+len(full.Milestones) > 0 {
			if c := g.expect(409, "DELETE", "/api/teams/"+id(tm.ID), nil); c != "has_roadmap_items" {
				t.Errorf("sample team %q: delete with items gave code %q", tm.Name, c)
			}
		}
		// delete the items one by one, then the team: all as for any other data
		for _, d := range full.Deliverables {
			g.expect(204, "DELETE", "/api/deliverables/"+id(d.ID), nil)
		}
		for _, m := range full.Milestones {
			g.expect(204, "DELETE", "/api/milestones/"+id(m.ID), nil)
		}
		g.expect(204, "DELETE", "/api/teams/"+id(tm.ID), nil)
		g.expect(404, "GET", "/api/teams/"+id(tm.ID), nil)
	}
	if left := must[teamList](g, 200, "GET", "/api/teams", nil); len(left.Items) != 0 {
		t.Errorf("%d sample teams could not be deleted", len(left.Items))
	}
}
