package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"
)

// A dependency from → to means `from` is the prerequisite and `to` the dependent: the dependent may
// not start before the day after the prerequisite ends (REQ_DEP_004, REQ_DEP_024). An item is a
// deliverable or a milestone (a milestone's start and end are both its date). Every edge, whatever
// the kinds of its ends, is one row of the dependencies table (REQ_DAT_007, schema.sql).

const (
	KindDeliverable = "deliverable"
	KindMilestone   = "milestone"
)

// ItemRef names one item: a deliverable or a milestone.
type ItemRef struct {
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
}

// ValidKind reports whether k is "deliverable" or "milestone".
func ValidKind(k string) bool { return k == KindDeliverable || k == KindMilestone }

// cmpItem orders items by kind, then id (deliverables first).
func cmpItem(a, b ItemRef) int {
	if c := strings.Compare(a.Kind, b.Kind); c != 0 {
		return c
	}
	switch {
	case a.ID < b.ID:
		return -1
	case a.ID > b.ID:
		return 1
	}
	return 0
}

// DepEnd describes one end of a dependency (enough for the timeline's arrows and chevron badges, and
// for audit names, REQ_AUD_003). For a milestone StartDate and EndDate both equal its date.
type DepEnd struct {
	Kind      string `json:"kind"`
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	TeamName  string `json:"team_name"`
	RoadmapID int64  `json:"roadmap_id"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

// DependencyEdge is an edge seen from one item; Other is the end that is not that item.
type DependencyEdge struct {
	FromKind string  `json:"from_kind"`
	FromID   int64   `json:"from_id"`
	ToKind   string  `json:"to_kind"`
	ToID     int64   `json:"to_id"`
	Other    *DepEnd `json:"other"`
}

// RoadmapDependency is an edge with both ends described, as RoadmapFull.dependencies carries it.
type RoadmapDependency struct {
	FromKind string `json:"from_kind"`
	FromID   int64  `json:"from_id"`
	ToKind   string `json:"to_kind"`
	ToID     int64  `json:"to_id"`
	From     DepEnd `json:"from"`
	To       DepEnd `json:"to"`
}

// DependencyCandidate is an item the picker may offer; Blocked says why it can't be chosen.
type DependencyCandidate struct {
	Kind      string  `json:"kind"`
	ID        int64   `json:"id"`
	Name      string  `json:"name"`
	TeamID    int64   `json:"team_id"`
	TeamName  string  `json:"team_name"`
	TeamTag   string  `json:"team_tag"`
	RoadmapID int64   `json:"roadmap_id"`
	StartDate string  `json:"start_date"`
	EndDate   string  `json:"end_date"`
	Blocked   *string `json:"blocked"` // null | ends_too_late | already_prerequisite | would_cycle
}

// DependencyResult carries both ends (with team names) for the caller's audit entry.
type DependencyResult struct {
	Edge     DependencyEdge
	From, To DepEnd
	Created  bool
}

// RemovedDependency is one dependency taken away with a deleted milestone, deliverable or roadmap;
// both ends are named so the audit entry stays readable (REQ_AUD_003, REQ_DEP_029).
type RemovedDependency struct {
	From, To DepEnd
}

func endLabel(e DepEnd) string {
	if e.Kind == KindMilestone {
		return fmt.Sprintf("milestone %s (%s)", e.Name, e.TeamName)
	}
	return fmt.Sprintf("%s (%s)", e.Name, e.TeamName)
}

// String names both ends: "<prerequisite> → <dependent>".
func (r RemovedDependency) String() string { return endLabel(r.From) + " → " + endLabel(r.To) }

// itemsCTE lists every item of both kinds with where it lives; edgesCTE every edge.
const itemsCTE = `items(kind, id, name, team_id, team_name, team_tag, roadmap_id, start_date, end_date) AS (
  SELECT 'deliverable', d.id, d.name, t.id, t.name, t.tag, d.roadmap_id, d.start_date, d.end_date
    FROM deliverables d JOIN roadmaps r ON r.id=d.roadmap_id JOIN teams t ON t.id=r.team_id
  UNION ALL
  SELECT 'milestone', m.id, m.name, t.id, t.name, t.tag, m.roadmap_id, m.date, m.date
    FROM milestones m JOIN roadmaps r ON r.id=m.roadmap_id JOIN teams t ON t.id=r.team_id)`
const edgesCTE = `edges(fk, fi, tk, ti) AS (SELECT from_kind, from_id, to_kind, to_id FROM dependencies)`
const withItemsEdges = `WITH ` + itemsCTE + `, ` + edgesCTE + ` `

// edgePairs loads every edge matching where (over e = the edge, f = its prerequisite item, g = its
// dependent item), both ends described, ordered by (from kind, from id, to kind, to id).
func edgePairs(ctx context.Context, q querier, where string, args ...any) ([]CompanyEdge, error) {
	out := []CompanyEdge{}
	err := collect(ctx, q, withItemsEdges+`SELECT e.fk, e.fi, e.tk, e.ti,
	  f.name, f.team_name, f.roadmap_id, f.start_date, f.end_date, f.team_id, f.team_tag,
	  g.name, g.team_name, g.roadmap_id, g.start_date, g.end_date, g.team_id, g.team_tag
	  FROM edges e JOIN items f ON f.kind=e.fk AND f.id=e.fi JOIN items g ON g.kind=e.tk AND g.id=e.ti
	  WHERE `+where+` ORDER BY e.fk, e.fi, e.tk, e.ti`, args, func(s scanner) error {
		var e CompanyEdge
		if err := s.Scan(&e.FromKind, &e.FromID, &e.ToKind, &e.ToID,
			&e.From.Name, &e.From.TeamName, &e.From.RoadmapID, &e.From.StartDate, &e.From.EndDate, &e.From.TeamID, &e.From.TeamTag,
			&e.To.Name, &e.To.TeamName, &e.To.RoadmapID, &e.To.StartDate, &e.To.EndDate, &e.To.TeamID, &e.To.TeamTag); err != nil {
			return err
		}
		e.From.Kind, e.From.ID, e.To.Kind, e.To.ID = e.FromKind, e.FromID, e.ToKind, e.ToID
		out = append(out, e)
		return nil
	})
	return out, err
}

func itemEnd(ctx context.Context, q querier, it ItemRef) (DepEnd, error) {
	e := DepEnd{Kind: it.Kind}
	var query string
	switch it.Kind {
	case KindDeliverable:
		query = `SELECT d.id, d.name, t.name, d.roadmap_id, d.start_date, d.end_date FROM deliverables d
		  JOIN roadmaps r ON r.id=d.roadmap_id JOIN teams t ON t.id=r.team_id WHERE d.id=?`
	case KindMilestone:
		query = `SELECT d.id, d.name, t.name, d.roadmap_id, d.date, d.date FROM milestones d
		  JOIN roadmaps r ON r.id=d.roadmap_id JOIN teams t ON t.id=r.team_id WHERE d.id=?`
	default:
		return e, invalid1("from_kind", "must be deliverable or milestone")
	}
	err := q.QueryRowContext(ctx, query, it.ID).Scan(&e.ID, &e.Name, &e.TeamName, &e.RoadmapID, &e.StartDate, &e.EndDate)
	if errors.Is(err, sql.ErrNoRows) {
		return e, notFound(it.Kind, it.ID)
	}
	return e, err
}

func addDays(date string, n int) string {
	t, _ := time.Parse(dateLayout, date)
	return t.AddDate(0, 0, n).Format(dateLayout)
}

// maxStepItems bounds the items in one IN list, well under SQLite's variable limit.
const maxStepItems = 400

// stepLevel lists, for each of items, the items one step from it along the edges: its dependents
// (down=true) or prerequisites. It reads a whole level with one query per chunk of maxStepItems items,
// not one per item (REQ_DEP_003).
func stepLevel(ctx context.Context, q querier, items []ItemRef, down bool) (map[ItemRef][]ItemRef, error) {
	self, other := "from", "to"
	if !down {
		self, other = other, self
	}
	out := map[ItemRef][]ItemRef{}
	for chunk := range slices.Chunk(items, maxStepItems) {
		args := make([]any, 0, 2*len(chunk))
		marks := make([]string, len(chunk))
		for i, it := range chunk {
			args = append(args, it.Kind, it.ID)
			marks[i] = "(?,?)"
		}
		err := collect(ctx, q, `SELECT `+self+`_kind, `+self+`_id, `+other+`_kind, `+other+`_id FROM dependencies
		  WHERE (`+self+`_kind, `+self+`_id) IN (VALUES `+strings.Join(marks, ",")+`) ORDER BY `+other+`_kind, `+other+`_id`, args, func(s scanner) error {
			var a, b ItemRef
			if err := s.Scan(&a.Kind, &a.ID, &b.Kind, &b.ID); err != nil {
				return err
			}
			out[a] = append(out[a], b)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// downstream returns every item that (transitively) depends on it, with the path to reach it (the
// items after it, in order) — breadth-first, so the path is a shortest one. It runs one query per
// level of the walk, not one per item.
func downstream(ctx context.Context, q querier, it ItemRef) (map[ItemRef][]ItemRef, error) {
	paths := map[ItemRef][]ItemRef{}
	level := []ItemRef{it}
	for len(level) > 0 {
		steps, err := stepLevel(ctx, q, level, true)
		if err != nil {
			return nil, err
		}
		var next []ItemRef
		for _, cur := range level {
			for _, n := range steps[cur] {
				if _, seen := paths[n]; seen || n == it {
					continue
				}
				paths[n] = append(append([]ItemRef{}, paths[cur]...), n)
				next = append(next, n)
			}
		}
		level = next
	}
	return paths, nil
}

func depDateConflict(msg, earliest, latest string) error {
	return &Error{Kind: Conflict, Code: "date_order", Msg: msg, EarliestStart: earliest, LatestEnd: latest}
}

// neighbourDates reads only it's own edges and the name and date of the other end of each, never the
// whole item set (REQ_DEP_004: the cost does not grow with the database). With prereq it visits the
// prerequisites whose end is on or after bound (the new start); otherwise the dependents whose start is on
// or before bound (the new end). A milestone's date is both its start and its end.
func neighbourDates(ctx context.Context, q querier, it ItemRef, prereq bool, bound string, each func(name, date string)) error {
	self, other, dcol, cmp := "to", "from", "d.end_date", ">="
	if !prereq {
		self, other, dcol, cmp = "from", "to", "d.start_date", "<="
	}
	run := func(query string, args ...any) error {
		return collect(ctx, q, query, args, func(s scanner) error {
			var n, d string
			if err := s.Scan(&n, &d); err != nil {
				return err
			}
			each(n, d)
			return nil
		})
	}
	if err := run(`SELECT d.name, `+dcol+` FROM dependencies x JOIN deliverables d ON d.id=x.`+other+`_id
	  WHERE x.`+other+`_kind='deliverable' AND x.`+self+`_kind=? AND x.`+self+`_id=? AND `+dcol+cmp+`? ORDER BY d.id`, it.Kind, it.ID, bound); err != nil {
		return err
	}
	return run(`SELECT m.name, m.date FROM dependencies x JOIN milestones m ON m.id=x.`+other+`_id
	  WHERE x.`+other+`_kind='milestone' AND x.`+self+`_kind=? AND x.`+self+`_id=? AND m.date`+cmp+`? ORDER BY m.id`, it.Kind, it.ID, bound)
}

// checkDependencyDates refuses new dates for item it that would leave it starting on or before a
// prerequisite's end, or ending on or after a dependent's start (REQ_DEP_004, REQ_DEP_024, hard
// rule), over edges to deliverables and milestones alike. For a milestone start and end are its date
// and the error carries earliest_date / latest_date instead. It is called inside the write's
// transaction, so nothing is written when it refuses.
func checkDependencyDates(ctx context.Context, q querier, it ItemRef, name, start, end string) error {
	var earliest, latest string
	var msgs []string
	verb := "start after"
	if it.Kind == KindMilestone {
		verb = "fall after"
	}
	err := neighbourDates(ctx, q, it, true, start, func(n, e string) {
		msgs = append(msgs, fmt.Sprintf("%q must %s %q ends on %s", name, verb, n, e))
		if d := addDays(e, 1); d > earliest {
			earliest = d
		}
	})
	if err != nil {
		return err
	}
	err = neighbourDates(ctx, q, it, false, end, func(n, st string) {
		msgs = append(msgs, fmt.Sprintf("%q must end before %q starts on %s", name, n, st))
		if d := addDays(st, -1); latest == "" || d < latest {
			latest = d
		}
	})
	if err != nil {
		return err
	}
	if len(msgs) == 0 {
		return nil
	}
	slog.WarnContext(ctx, "store: dates refused, they break a dependency", "kind", it.Kind, "id", it.ID, "earliest", earliest, "latest", latest)
	e := depDateConflict("These dates break a dependency: "+strings.Join(msgs, "; "), earliest, latest)
	if it.Kind == KindMilestone { // REQ_DEP_024: a milestone has a date, not a start and an end
		se := e.(*Error)
		se.EarliestDate, se.LatestDate, se.EarliestStart, se.LatestEnd = earliest, latest, "", ""
	}
	return e
}

// DependencyAdd makes deliverable toID depend on deliverable fromID (REQ_DEP_001-004).
func DependencyAdd(ctx context.Context, db *sql.DB, toID, fromID int64) (DependencyResult, error) {
	return DependencyAddItems(ctx, db, ItemRef{KindDeliverable, toID}, ItemRef{KindDeliverable, fromID}, "from_id")
}

// DependencyAddItems makes `to` depend on `from`, either of them a deliverable or a milestone
// (REQ_DEP_023-025). Adding an edge that already exists is not an error and writes nothing
// (Created=false). fromField names the request field a validation error points at.
func DependencyAddItems(ctx context.Context, db *sql.DB, to, from ItemRef, fromField string) (res DependencyResult, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error { return dependencyAddTx(ctx, tx, to, from, fromField, &res) })
	if err == nil && res.Created {
		slog.InfoContext(ctx, "store: dependency created", "from", res.From.Name, "from_kind", from.Kind, "to", res.To.Name, "to_kind", to.Kind)
	}
	return
}

func edgeExists(ctx context.Context, q querier, from, to ItemRef) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM dependencies WHERE from_kind=? AND from_id=? AND to_kind=? AND to_id=?`,
		from.Kind, from.ID, to.Kind, to.ID).Scan(&n)
	return n > 0, err
}

// dependencyAddTx is DependencyAddItems inside the caller's transaction: the importer adds its edges
// through it, so an imported dependency obeys exactly the rules of POST .../dependencies.
func dependencyAddTx(ctx context.Context, tx *sql.Tx, to, from ItemRef, fromField string, res *DependencyResult) error {
	var err error
	if res.To, err = itemEnd(ctx, tx, to); err != nil {
		return err
	}
	if res.From, err = itemEnd(ctx, tx, from); err != nil {
		if isNotFound(err) {
			return invalid1(fromField, "no such "+from.Kind)
		}
		return err
	}
	res.Edge = DependencyEdge{FromKind: from.Kind, FromID: from.ID, ToKind: to.Kind, ToID: to.ID, Other: &res.From}
	if from == to { // REQ_DEP_002, REQ_DEP_023
		return invalid1(fromField, "an item can't depend on itself")
	}
	if exists, err := edgeExists(ctx, tx, from, to); err != nil {
		return err
	} else if exists {
		slog.InfoContext(ctx, "store: dependency already exists, nothing written", "from", from, "to", to)
		return nil
	}
	// REQ_DEP_003/025: a loop forms exactly when `from` already depends (transitively) on `to`, over
	// the one dependencies table.
	down, err := downstream(ctx, tx, to)
	if err != nil {
		return err
	}
	if p, loops := down[from]; loops {
		return cycleError(ctx, tx, from, to, p, res)
	}
	if res.To.StartDate <= res.From.EndDate { // REQ_DEP_004, REQ_DEP_024
		earliest := addDays(res.From.EndDate, 1)
		slog.WarnContext(ctx, "store: dependency refused, dates out of order", "from", from, "to", to, "earliest_start", earliest)
		return depDateConflict(fmt.Sprintf("%q can't start before the day after %q ends (%s)", res.To.Name, res.From.Name, res.From.EndDate), earliest, "")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO dependencies(from_kind, from_id, to_kind, to_id) VALUES (?,?,?,?)`,
		from.Kind, from.ID, to.Kind, to.ID)
	if err != nil {
		return err
	}
	res.Created = true
	return nil
}

// cycleError builds the 409 cycle for the refused edge from → to; p is the path from `to` to `from`.
// The names are plain strings when only deliverables are on the loop (Phase 5), typed {kind,name}
// items when a milestone is (REQ_DEP_025).
func cycleError(ctx context.Context, q querier, from, to ItemRef, p []ItemRef, res *DependencyResult) error {
	items := append([]ItemRef{from, to}, p...)
	var names []string
	var typed []PathItem
	labels := make([]string, 0, len(items))
	mixed := false
	for _, it := range items {
		e, err := itemEnd(ctx, q, it)
		if err != nil {
			return err
		}
		names = append(names, e.Name)
		typed = append(typed, PathItem{Kind: it.Kind, Name: e.Name})
		if it.Kind == KindMilestone {
			mixed = true
			labels = append(labels, e.Name+" (milestone)")
		} else {
			labels = append(labels, e.Name)
		}
	}
	slog.WarnContext(ctx, "store: dependency refused, it would form a loop", "from", from, "to", to, "path", labels)
	se := &Error{Kind: Conflict, Code: "cycle", Msg: "That dependency would form a loop: " + strings.Join(labels, " → ")}
	if mixed {
		se.TypedPath = typed
	} else {
		se.Path = names
	}
	return se
}

// DependencyRemoveItems deletes the edge from → to; an unknown item or edge is NotFound.
func DependencyRemoveItems(ctx context.Context, db *sql.DB, toRef, fromRef ItemRef) (from, to DepEnd, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if to, err = itemEnd(ctx, tx, toRef); err != nil {
			return err
		}
		if from, err = itemEnd(ctx, tx, fromRef); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM dependencies WHERE from_kind=? AND from_id=? AND to_kind=? AND to_id=?`,
			fromRef.Kind, fromRef.ID, toRef.Kind, toRef.ID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return &Error{Kind: NotFound, Code: "not_found", Msg: fmt.Sprintf("%s %d is not a prerequisite of %s %d", fromRef.Kind, fromRef.ID, toRef.Kind, toRef.ID)}
		}
		return nil
	})
	if err == nil {
		slog.InfoContext(ctx, "store: dependency removed", "from", from.Name, "from_kind", from.Kind, "to", to.Name, "to_kind", to.Kind)
	}
	return
}

// DependenciesOf lists the edges touching it in either direction, with the other end described.
func DependenciesOf(ctx context.Context, db *sql.DB, it ItemRef) ([]DependencyEdge, error) {
	out := []DependencyEdge{}
	err := inTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := itemEnd(ctx, tx, it); err != nil {
			return err
		}
		pairs, err := edgePairs(ctx, tx, `(e.fk=? AND e.fi=?) OR (e.tk=? AND e.ti=?)`, it.Kind, it.ID, it.Kind, it.ID)
		if err != nil {
			return err
		}
		for _, p := range pairs {
			other := p.To.DepEnd
			if p.FromKind != it.Kind || p.FromID != it.ID {
				other = p.From.DepEnd
			}
			out = append(out, DependencyEdge{FromKind: p.FromKind, FromID: p.FromID, ToKind: p.ToKind, ToID: p.ToID, Other: &other})
		}
		return nil
	})
	return out, err
}

// DependencyCandidates lists every other item (deliverable or milestone) in every team, with why it
// can't be chosen as a prerequisite of it (REQ_DEP_007/008/026). The server computes this so the
// picker never re-implements the rules.
func DependencyCandidates(ctx context.Context, db *sql.DB, it ItemRef) ([]DependencyCandidate, error) {
	out := []DependencyCandidate{}
	err := inTx(ctx, db, func(tx *sql.Tx) error {
		self, err := itemEnd(ctx, tx, it)
		if err != nil {
			return err
		}
		already := map[ItemRef]bool{}
		steps, err := stepLevel(ctx, tx, []ItemRef{it}, false)
		if err != nil {
			return err
		}
		for _, p := range steps[it] {
			already[p] = true
		}
		cyc, err := downstream(ctx, tx, it) // choosing any of these as a prerequisite would close a loop
		if err != nil {
			return err
		}
		return collect(ctx, tx, `WITH `+itemsCTE+` SELECT kind, id, name, team_id, team_name, team_tag, roadmap_id, start_date, end_date FROM items
		  WHERE NOT (kind=? AND id=?) ORDER BY team_tag COLLATE NOCASE, kind DESC, name COLLATE NOCASE, id`, []any{it.Kind, it.ID}, func(s scanner) error {
			var c DependencyCandidate
			if err := s.Scan(&c.Kind, &c.ID, &c.Name, &c.TeamID, &c.TeamName, &c.TeamTag, &c.RoadmapID, &c.StartDate, &c.EndDate); err != nil {
				return err
			}
			ref := ItemRef{c.Kind, c.ID}
			var b string
			_, loops := cyc[ref]
			switch {
			case already[ref]:
				b = "already_prerequisite"
			case loops:
				b = "would_cycle"
			case c.EndDate >= self.StartDate:
				b = "ends_too_late"
			}
			if b != "" {
				c.Blocked = &b
			}
			out = append(out, c)
			return nil
		})
	})
	return out, err
}

// roadmapDependencies lists every edge with either end in the roadmap (for RoadmapFull).
func roadmapDependencies(ctx context.Context, q querier, roadmapID int64) ([]RoadmapDependency, error) {
	pairs, err := edgePairs(ctx, q, `f.roadmap_id=? OR g.roadmap_id=?`, roadmapID, roadmapID)
	if err != nil {
		return nil, err
	}
	out := make([]RoadmapDependency, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, RoadmapDependency{FromKind: p.FromKind, FromID: p.FromID, ToKind: p.ToKind, ToID: p.ToID, From: p.From.DepEnd, To: p.To.DepEnd})
	}
	return out, nil
}

// removeItemEdges deletes the dependencies rows touching it (there is no foreign key across kinds,
// REQ_DAT_007) and returns every edge that touched it, each with both ends named (REQ_DEP_029). Call it before the item itself is deleted.
func removeItemEdges(ctx context.Context, tx *sql.Tx, it ItemRef) ([]RemovedDependency, error) {
	pairs, err := edgePairs(ctx, tx, `(e.fk=? AND e.fi=?) OR (e.tk=? AND e.ti=?)`, it.Kind, it.ID, it.Kind, it.ID)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM dependencies WHERE (from_kind=? AND from_id=?) OR (to_kind=? AND to_id=?)`,
		it.Kind, it.ID, it.Kind, it.ID); err != nil {
		return nil, err
	}
	out := make([]RemovedDependency, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, RemovedDependency{From: p.From.DepEnd, To: p.To.DepEnd})
	}
	if len(out) > 0 {
		slog.InfoContext(ctx, "store: dependencies removed with their item", "kind", it.Kind, "id", it.ID, "count", len(out))
	}
	return out, nil
}

// itemSorted returns refs sorted by kind then id, without duplicates.
func itemSorted(refs []ItemRef) []ItemRef {
	slices.SortFunc(refs, cmpItem)
	return slices.Compact(refs)
}
