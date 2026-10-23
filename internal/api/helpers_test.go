package api_test

import (
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

func testTeamOpts(name, tag string) testutil.TeamOpts { return testutil.TeamOpts{Name: name, Tag: tag} }
func roadmapOpts() testutil.RoadmapOpts               { return testutil.RoadmapOpts{} }

// renameWorkstream goes through the real PATCH /api/workstreams/{id} endpoint — used to reuse a
// roadmap's automatic "General" workstream (REQ_DAT_023) under a test's own name, instead of
// creating an extra one alongside it.
func (g *rig) renameWorkstream(wsID int64, name string) store.Workstream {
	g.T.Helper()
	return must[store.Workstream](g, 200, "PATCH", "/api/workstreams/"+id(wsID), map[string]any{"name": name})
}

// noSuchID returns an id guaranteed not to name any row created so far in this test — derived from
// the current max id across every id-keyed table plus a buffer, instead of a hardcoded literal like
// 99999 that could (in principle) collide with something a test itself created.
func (g *rig) noSuchID() int64 {
	g.T.Helper()
	var max int64
	if err := g.DB.QueryRow(`SELECT COALESCE(MAX(id), 0) FROM (
	  SELECT id FROM teams UNION ALL SELECT id FROM roadmaps UNION ALL SELECT id FROM workstreams
	  UNION ALL SELECT id FROM deliverables)`).Scan(&max); err != nil {
		g.T.Fatal(err)
	}
	return max + 1000
}

// rawMilestone inserts a milestone directly. There is no store function or API endpoint for
// milestones yet (they are Phase 4, see docs/API.md's "Milestones (Phase 4)"), so this is the one
// place tests that need a milestone insert it, respecting the same schema a future store function
// would — kept in one clearly labelled spot rather than scattered inline SQL.
func (g *rig) rawMilestone(roadmapID, workstreamID int64, name, date string) int64 {
	g.T.Helper()
	res, err := g.DB.Exec(`INSERT INTO milestones(roadmap_id, workstream_id, name, date) VALUES (?,?,?,?)`, roadmapID, workstreamID, name, date)
	if err != nil {
		g.T.Fatal(err)
	}
	mid, err := res.LastInsertId()
	if err != nil {
		g.T.Fatal(err)
	}
	return mid
}
