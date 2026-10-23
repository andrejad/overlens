package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"unicode"
)

// maxOrderItems caps team_ids and names of the order PUTs: each entry is one INSERT in a transaction
// on the single connection, so an unbounded list would block every other request. A PUT replaces the
// whole saved list, so this is also the most saved workstream rows the table can ever hold (stale
// names the client keeps sending stay bounded by it).
const maxOrderItems = 1000

// foldName is the one canonical key for comparing workstream names across roadmaps: trim, then
// lower-case each rune on its own (unicode.ToLower, simple case mapping, no context rules). It is
// not strings.ToLower on the whole string and not SQLite NOCASE (ASCII only): see docs/API.md,
// "Company view".
func foldName(s string) string { return strings.Map(unicode.ToLower, TrimName(s)) }

// FoldName is foldName for other packages: the MCP tools match workstream names and search text the same way.
func FoldName(s string) string { return foldName(s) }

// The company view (Phase 7): every team's roadmap in one read, the saved team and workstream
// orders, and the company-wide dependency graph with its trace (REQ_API_022, 031, 036-039).

// TeamRef is a team in the saved team order.
type TeamRef struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Tag  string `json:"tag"`
}

// CompanyTeam is one band of the company view: the team and its one roadmap (REQ_DAT_032).
type CompanyTeam struct {
	Team    Team        `json:"team"`
	Roadmap RoadmapFull `json:"roadmap"`
}

// CompanyEnd is a dependency end plus where it lives, so the company graph needs no further lookups.
type CompanyEnd struct {
	DepEnd
	TeamID  int64  `json:"team_id"`
	TeamTag string `json:"team_tag"`
}

// CompanyEdge is one dependency of any roadmap.
type CompanyEdge struct {
	FromKind string     `json:"from_kind"`
	FromID   int64      `json:"from_id"`
	ToKind   string     `json:"to_kind"`
	ToID     int64      `json:"to_id"`
	From     CompanyEnd `json:"from"`
	To       CompanyEnd `json:"to"`
}

// TypedTrace is the answer of GET /api/company/trace/{kind}/{id}.
type TypedTrace struct {
	Root          ItemRef       `json:"root"`
	Prerequisites []ItemRef     `json:"prerequisites"`
	Dependents    []ItemRef     `json:"dependents"`
	Edges         []CompanyEdge `json:"edges"`
}

// teamOrderTx lists every team in the effective order: saved positions first, then the teams with no
// saved row by name, ignoring case (teams.name is NOCASE).
func teamOrderTx(ctx context.Context, q querier) ([]TeamRef, error) {
	out := []TeamRef{}
	err := collect(ctx, q, `SELECT t.id, t.name, t.tag FROM teams t LEFT JOIN company_team_order o ON o.team_id=t.id
	  ORDER BY o.team_id IS NULL, o.position, t.name COLLATE NOCASE, t.id`, nil, func(s scanner) error {
		var t TeamRef
		if err := s.Scan(&t.ID, &t.Name, &t.Tag); err != nil {
			return err
		}
		out = append(out, t)
		return nil
	})
	return out, err
}

// TeamOrderGet returns the effective team order (REQ_API_037).
func TeamOrderGet(ctx context.Context, db *sql.DB) (out []TeamRef, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) (err error) { out, err = teamOrderTx(ctx, tx); return })
	return
}

// savedTeamNames lists the teams that have a saved position, in position order.
func savedTeamNames(ctx context.Context, q querier) ([]string, error) {
	out := []string{}
	err := collect(ctx, q, `SELECT t.name FROM company_team_order o JOIN teams t ON t.id=o.team_id ORDER BY o.position, t.id`, nil, func(s scanner) error {
		var n string
		if err := s.Scan(&n); err != nil {
			return err
		}
		out = append(out, n)
		return nil
	})
	return out, err
}

// OrderChange is what a PUT of an order did: the effective order and the saved list (the rows of the
// order table, in position order) before and after, so the caller can audit a real change (REQ_AUD_022,
// REQ_AUD_023).
type OrderChange struct {
	From, To           []string
	SavedFrom, SavedTo []string
}

// Changed reports whether the PUT changed what is shown or what is stored.
func (c OrderChange) Changed() bool { return !slices.Equal(c.From, c.To) || c.SavedChanged() }

// SavedChanged reports whether the saved list changed (names compared with foldName, so a spelling-only
// edit of a saved name is not a change).
func (c OrderChange) SavedChanged() bool {
	return !slices.EqualFunc(c.SavedFrom, c.SavedTo, func(a, b string) bool { return foldName(a) == foldName(b) })
}

// TeamOrderSet saves ids as the team order: each existing team exactly once (at most maxOrderItems).
// It returns the change, for the caller's audit entry (REQ_AUD_023); the orders are team names.
func TeamOrderSet(ctx context.Context, db *sql.DB, ids []int64) (ch OrderChange, after []TeamRef, err error) {
	if len(ids) > maxOrderItems {
		return ch, nil, invalid1("team_ids", fmt.Sprintf("at most %d teams may be listed", maxOrderItems))
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		before, err := teamOrderTx(ctx, tx)
		if err != nil {
			return err
		}
		if ch.SavedFrom, err = savedTeamNames(ctx, tx); err != nil {
			return err
		}
		ch.From = refNames(before)
		known := map[int64]bool{}
		for _, t := range before {
			known[t.ID] = true
		}
		seen := map[int64]bool{}
		for _, id := range ids {
			if !known[id] {
				return invalid1("team_ids", "unknown team id")
			}
			if seen[id] {
				return invalid1("team_ids", "each team may appear only once")
			}
			seen[id] = true
		}
		if len(ids) != len(known) {
			return invalid1("team_ids", "every team must be listed exactly once")
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM company_team_order`); err != nil {
			return err
		}
		for i, id := range ids {
			if _, err := tx.ExecContext(ctx, `INSERT INTO company_team_order(team_id, position) VALUES (?,?)`, id, i); err != nil {
				return err
			}
		}
		if after, err = teamOrderTx(ctx, tx); err != nil {
			return err
		}
		ch.To = refNames(after)
		ch.SavedTo, err = savedTeamNames(ctx, tx)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: company team order saved", "teams", len(after), "changed", ch.Changed())
	}
	return
}

func refNames(ts []TeamRef) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.Name
	}
	return out
}

// CompanyRoadmaps returns every team in the effective order with its roadmap, all in one
// transaction so the bands are a consistent snapshot (REQ_API_037). Each table is read once for all
// roadmaps and the bands are assembled in memory, so the statement count does not depend on
// the number of teams, roadmaps or deliverables. Every list keeps the order roadmapFullGetTx gives it.
func CompanyRoadmaps(ctx context.Context, db *sql.DB) (out []CompanyTeam, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) (err error) { out, _, err = companyRoadmapsTx(ctx, tx); return })
	if err == nil {
		slog.DebugContext(ctx, "store: company roadmaps read", "teams", len(out))
	}
	return out, err
}

// companyRoadmapsTx is CompanyRoadmaps inside a transaction the caller owns; it also returns the company's
// dependency edges, which it has read anyway.
func companyRoadmapsTx(ctx context.Context, tx *sql.Tx) ([]CompanyTeam, []CompanyEdge, error) {
	out := []CompanyTeam{}
	order, err := teamOrderTx(ctx, tx)
	if err != nil {
		return nil, nil, err
	}
	teams := map[int64]Team{}
	if err := collect(ctx, tx, `SELECT `+teamCols+` FROM teams`, nil, func(s scanner) error {
		t, err := scanTeam(s)
		teams[t.ID] = t
		return err
	}); err != nil {
		return nil, nil, err
	}
	bands := map[int64]*RoadmapFull{} // roadmap id -> its band; byTeam below maps team id -> same
	byTeam := map[int64]*RoadmapFull{}
	if err := collect(ctx, tx, `SELECT `+roadmapCols+` FROM roadmaps`, nil, func(s scanner) error {
		r, err := scanRoadmap(s)
		if err != nil {
			return err
		}
		f := &RoadmapFull{Roadmap: r, Team: teams[r.TeamID], Workstreams: []Workstream{}, Milestones: []Milestone{}, Dependencies: []RoadmapDependency{}}
		bands[r.ID], byTeam[r.TeamID] = f, f
		return nil
	}); err != nil {
		return nil, nil, err
	}
	if err := collect(ctx, tx, `SELECT w.id, w.roadmap_id, w.name, w.position FROM workstreams w ORDER BY w.position, w.id`, nil, func(s scanner) error {
		var w Workstream
		if err := s.Scan(&w.ID, &w.RoadmapID, &w.Name, &w.Position); err != nil {
			return err
		}
		bands[w.RoadmapID].Workstreams = append(bands[w.RoadmapID].Workstreams, w)
		return nil
	}); err != nil {
		return nil, nil, err
	}
	ds, err := deliverablesWhere(ctx, tx, "1=1")
	if err != nil {
		return nil, nil, err
	}
	for _, f := range bands {
		f.Deliverables = []Deliverable{}
	}
	for _, d := range ds {
		bands[d.RoadmapID].Deliverables = append(bands[d.RoadmapID].Deliverables, d)
	}
	ms, err := milestonesWhere(ctx, tx, "1=1")
	if err != nil {
		return nil, nil, err
	}
	for _, m := range ms {
		bands[m.RoadmapID].Milestones = append(bands[m.RoadmapID].Milestones, m)
	}
	pairs, err := companyEdges(ctx, tx) // an edge belongs to the roadmap of either end
	if err != nil {
		return nil, nil, err
	}
	for _, p := range pairs {
		d := RoadmapDependency{FromKind: p.FromKind, ToKind: p.ToKind, FromID: p.FromID, ToID: p.ToID, From: p.From.DepEnd, To: p.To.DepEnd}
		if f := bands[p.From.RoadmapID]; f != nil {
			f.Dependencies = append(f.Dependencies, d)
		}
		if f := bands[p.To.RoadmapID]; f != nil && p.To.RoadmapID != p.From.RoadmapID {
			f.Dependencies = append(f.Dependencies, d)
		}
	}
	for _, ref := range order {
		out = append(out, CompanyTeam{Team: teams[ref.ID], Roadmap: *byTeam[ref.ID]})
	}
	return out, pairs, nil
}

// workstreamNames lists the distinct workstream names of all roadmaps, compared with
// foldName; the first spelling met (by roadmap id, then position, then id) wins. Two workstreams of one
// roadmap that differ only by case ('Ärzte' / 'ärzte') stay two workstreams there but merge here.
func workstreamNames(ctx context.Context, q querier) ([]string, error) {
	names := []string{}
	seen := map[string]bool{}
	err := collect(ctx, q, `SELECT w.name FROM workstreams w ORDER BY w.roadmap_id, w.position, w.id`, nil, func(s scanner) error {
		var n string
		if err := s.Scan(&n); err != nil {
			return err
		}
		if k := foldName(n); !seen[k] {
			seen[k] = true
			names = append(names, n)
		}
		return nil
	})
	return names, err
}

// workstreamOrderTx is the effective order: names with a saved position first (by position), the
// rest alphabetically ignoring case.
func workstreamOrderTx(ctx context.Context, q querier) ([]string, error) {
	names, err := workstreamNames(ctx, q)
	if err != nil {
		return nil, err
	}
	pos := map[string]int{}
	err = collect(ctx, q, `SELECT workstream_name, position FROM company_workstream_order ORDER BY position, workstream_name`, nil, func(s scanner) error {
		var n string
		var p int
		if err := s.Scan(&n, &p); err != nil {
			return err
		}
		if k := foldName(n); !hasKey(pos, k) { // rows that fold alike: the lowest position wins
			pos[k] = p
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(names, func(i, j int) bool {
		li, lj := foldName(names[i]), foldName(names[j])
		pi, iSaved := pos[li]
		pj, jSaved := pos[lj]
		switch {
		case iSaved && jSaved:
			return pi < pj
		case iSaved != jSaved:
			return iSaved
		}
		return li < lj
	})
	return names, nil
}

func hasKey(m map[string]int, k string) bool { _, ok := m[k]; return ok }

// savedWorkstreamNames lists the saved names in position order.
func savedWorkstreamNames(ctx context.Context, q querier) ([]string, error) {
	out := []string{}
	err := collect(ctx, q, `SELECT workstream_name FROM company_workstream_order ORDER BY position, workstream_name`, nil, func(s scanner) error {
		var n string
		if err := s.Scan(&n); err != nil {
			return err
		}
		out = append(out, n)
		return nil
	})
	return out, err
}

// WorkstreamOrderGet returns the effective company workstream order (REQ_API_036).
func WorkstreamOrderGet(ctx context.Context, db *sql.DB) (out []string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) (err error) { out, err = workstreamOrderTx(ctx, tx); return })
	return
}

// WorkstreamOrderSet replaces the saved order with names (at most maxOrderItems; kept even when no
// roadmap has the name right now). It returns the change, for the audit entry (REQ_AUD_022).
func WorkstreamOrderSet(ctx context.Context, db *sql.DB, names []string) (ch OrderChange, err error) {
	if len(names) > maxOrderItems {
		return ch, invalid1("names", fmt.Sprintf("at most %d names may be listed", maxOrderItems))
	}
	clean := make([]string, 0, len(names))
	seen := map[string]bool{}
	for _, n := range names {
		c, err := cleanName("names", n)
		if err != nil {
			return ch, err
		}
		k := foldName(c)
		if seen[k] {
			return ch, invalid1("names", "\""+c+"\" appears more than once (names are compared ignoring case)")
		}
		seen[k] = true
		clean = append(clean, c)
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if ch.From, err = workstreamOrderTx(ctx, tx); err != nil {
			return err
		}
		if ch.SavedFrom, err = savedWorkstreamNames(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM company_workstream_order`); err != nil {
			return err
		}
		for i, n := range clean {
			if _, err := tx.ExecContext(ctx, `INSERT INTO company_workstream_order(workstream_name, position) VALUES (?,?)`, n, i); err != nil {
				return err
			}
		}
		if ch.To, err = workstreamOrderTx(ctx, tx); err != nil {
			return err
		}
		ch.SavedTo, err = savedWorkstreamNames(ctx, tx)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: company workstream order saved", "saved", len(clean), "changed", ch.Changed())
	}
	return
}

// companyEdges loads every dependency with both ends described, in one statement.
func companyEdges(ctx context.Context, q querier) ([]CompanyEdge, error) {
	return edgePairs(ctx, q, `1=1`)
}

// CompanyDependencies returns every dependency of every roadmap (REQ_API_038).
func CompanyDependencies(ctx context.Context, db *sql.DB) (out []CompanyEdge, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) (err error) { out, err = companyEdges(ctx, tx); return })
	return
}

// reach walks adj from root and returns everything reachable, sorted. The visited set (seeded with
// root) bounds the walk even if a loop sits in the data; root itself is never returned.
func reach(adj map[ItemRef][]ItemRef, root ItemRef) []ItemRef {
	visited := map[ItemRef]bool{root: true}
	queue := []ItemRef{root}
	out := []ItemRef{}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, n := range adj[cur] {
			if !visited[n] {
				visited[n] = true
				out = append(out, n)
				queue = append(queue, n)
			}
		}
	}
	return itemSorted(out)
}

// CompanyTraceItem returns the transitive prerequisites and dependents of an item (deliverable or
// milestone) across all teams and roadmaps, following chains through both kinds, plus the edges among
// them and the root (REQ_API_038, REQ_DEP_022, REQ_DEP_028). The edge list is loaded once and walked
// in memory.
func CompanyTraceItem(ctx context.Context, db *sql.DB, root ItemRef) (TypedTrace, error) {
	var tr TypedTrace
	err := inTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := itemEnd(ctx, tx, root); err != nil {
			return err
		}
		edges, err := companyEdges(ctx, tx)
		if err != nil {
			return err
		}
		tr = traceFromEdges(root, edges)
		return nil
	})
	if err == nil {
		slog.DebugContext(ctx, "store: company trace", "kind", root.Kind, "root", root.ID, "prerequisites", len(tr.Prerequisites), "dependents", len(tr.Dependents))
	}
	return tr, err
}

// traceFromEdges walks edges in memory: everything root waits on and everything that waits on it, through
// chains of both kinds, plus the edges among them and root.
func traceFromEdges(root ItemRef, edges []CompanyEdge) TypedTrace {
	tr := TypedTrace{Root: root}
	down, up := map[ItemRef][]ItemRef{}, map[ItemRef][]ItemRef{}
	for _, e := range edges {
		f, t := ItemRef{e.FromKind, e.FromID}, ItemRef{e.ToKind, e.ToID}
		down[f] = append(down[f], t)
		up[t] = append(up[t], f)
	}
	tr.Prerequisites, tr.Dependents = reach(up, root), reach(down, root)
	in := map[ItemRef]bool{root: true}
	for _, n := range tr.Prerequisites {
		in[n] = true
	}
	for _, n := range tr.Dependents {
		in[n] = true
	}
	tr.Edges = []CompanyEdge{}
	for _, e := range edges {
		if in[ItemRef{e.FromKind, e.FromID}] && in[ItemRef{e.ToKind, e.ToID}] {
			tr.Edges = append(tr.Edges, e)
		}
	}
	return tr
}
