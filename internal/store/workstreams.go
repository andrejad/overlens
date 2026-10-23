package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"slices"
)

type Workstream struct {
	ID        int64  `json:"id"`
	RoadmapID int64  `json:"roadmap_id"`
	Name      string `json:"name"`
	Position  int    `json:"position"`
}

func workstreamsOf(ctx context.Context, q querier, roadmapID int64) ([]Workstream, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, roadmap_id, name, position FROM workstreams WHERE roadmap_id=? ORDER BY position, id`, roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Workstream
	for rows.Next() {
		var w Workstream
		if err := rows.Scan(&w.ID, &w.RoadmapID, &w.Name, &w.Position); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return listPage(out), rows.Err()
}

func WorkstreamGet(ctx context.Context, q querier, id int64) (Workstream, error) {
	var w Workstream
	err := q.QueryRowContext(ctx, `SELECT id, roadmap_id, name, position FROM workstreams WHERE id=?`, id).
		Scan(&w.ID, &w.RoadmapID, &w.Name, &w.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return w, notFound("workstream", id)
	}
	return w, err
}

// workstreamNamesByID looks up each id's current name, once per distinct id, inside q (the caller's
// own transaction — REQ_AUD_003: a deliverable update's audit diff must name workstreams by their
// name at the moment of the change, not by a later, separate lookup no error from which could ever
// be silently dropped).
func workstreamNamesByID(ctx context.Context, q querier, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	for _, id := range ids {
		if _, ok := out[id]; ok {
			continue
		}
		w, err := WorkstreamGet(ctx, q, id)
		if err != nil {
			return nil, err
		}
		out[id] = w.Name
	}
	return out, nil
}

// checkWorkstreamNameUnique refuses a name already used by another workstream of the same roadmap,
// ignoring case (409 duplicate_name) — checked on create and rename. A move/copy "create" of an
// already-existing name never reaches here: it reuses that workstream instead (see move.go).
func checkWorkstreamNameUnique(ctx context.Context, q querier, roadmapID, excludeID int64, name string) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM workstreams WHERE roadmap_id=? AND id<>? AND name=? COLLATE NOCASE`,
		roadmapID, excludeID, name).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		slog.InfoContext(ctx, "store: duplicate workstream name refused", "roadmap_id", roadmapID, "name", name)
		return conflict("duplicate_name", "A workstream named \""+name+"\" already exists in this roadmap")
	}
	return nil
}

// appendWorkstream inserts a workstream at the end of the roadmap's order (MAX(position)+1) — the
// one place this "append at the end" logic lives; WorkstreamCreate, the move feature's "create a
// workstream" branch and RoadmapCreate's automatic "General" workstream (REQ_DAT_023) all call it.
func appendWorkstream(ctx context.Context, q querier, roadmapID int64, name string) (int64, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO workstreams(roadmap_id, name, position)
	  VALUES (?,?, (SELECT COALESCE(MAX(position)+1, 0) FROM workstreams WHERE roadmap_id=?))`, roadmapID, name, roadmapID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// WorkstreamCreate also returns the roadmap's title and its team's name, read inside the same
// transaction as the insert (REQ_AUD_003): the caller's audit entry must never re-query them after
// commit, when a rename racing in right after could show the wrong name.
func WorkstreamCreate(ctx context.Context, db *sql.DB, roadmapID int64, name string) (w Workstream, title, team string, err error) {
	name, err = cleanName("name", name)
	if err != nil {
		return
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := RoadmapGet(ctx, tx, roadmapID); err != nil {
			return err
		}
		if err := checkWorkstreamNameUnique(ctx, tx, roadmapID, 0, name); err != nil {
			return err
		}
		id, err := appendWorkstream(ctx, tx, roadmapID, name)
		if err != nil {
			return err
		}
		if w, err = WorkstreamGet(ctx, tx, id); err != nil {
			return err
		}
		title, team, err = RoadmapNames(ctx, tx, roadmapID)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: workstream created", "workstream_id", w.ID, "roadmap_id", roadmapID, "name", w.Name)
	}
	return
}

// WorkstreamRename also returns the roadmap's title and its team's name, read inside the same
// transaction as the update (REQ_AUD_003).
func WorkstreamRename(ctx context.Context, db *sql.DB, id int64, name string) (before, after Workstream, title, team string, err error) {
	name, err = cleanName("name", name)
	if err != nil {
		return
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if before, err = WorkstreamGet(ctx, tx, id); err != nil {
			return err
		}
		if before.Name == name {
			slog.InfoContext(ctx, "store: workstream rename is a no-op, name unchanged", "workstream_id", id)
			after = before
		} else {
			if err := checkWorkstreamNameUnique(ctx, tx, before.RoadmapID, id, name); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `UPDATE workstreams SET name=? WHERE id=?`, name, id); err != nil {
				return err
			}
			if after, err = WorkstreamGet(ctx, tx, id); err != nil {
				return err
			}
		}
		title, team, err = RoadmapNames(ctx, tx, before.RoadmapID)
		return err
	})
	if err == nil && before.Name != after.Name {
		slog.InfoContext(ctx, "store: workstream renamed", "workstream_id", id, "from", before.Name, "to", after.Name)
	}
	return
}

// WorkstreamReorder sets positions 0..n-1 in the given order; ids must be exactly the roadmap's workstreams.
// Reordering changes which workstream is a deliverable's derived primary (REQ_DAT_005), nothing else.
// Sending the order the roadmap already has is a no-op: no UPDATE is issued. title/team are the
// roadmap's title and its team's name, read inside the same transaction (REQ_AUD_003).
func WorkstreamReorder(ctx context.Context, db *sql.DB, roadmapID int64, ids []int64) (out []Workstream, changed bool, title, team string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := RoadmapGet(ctx, tx, roadmapID); err != nil {
			return err
		}
		cur, err := workstreamsOf(ctx, tx, roadmapID)
		if err != nil {
			return err
		}
		have := make([]int64, len(cur))
		for i, w := range cur {
			have[i] = w.ID
		}
		want := slices.Clone(ids)
		haveSorted, wantSorted := slices.Clone(have), slices.Clone(want)
		slices.Sort(haveSorted)
		slices.Sort(wantSorted)
		if !slices.Equal(haveSorted, wantSorted) {
			return invalid1("ids", "must list every workstream of this roadmap exactly once")
		}
		if slices.Equal(have, want) { // already in this order: nothing to do
			slog.InfoContext(ctx, "store: workstream reorder is a no-op, order unchanged", "roadmap_id", roadmapID)
			out = cur
		} else {
			changed = true
			for i, id := range ids {
				if _, err := tx.ExecContext(ctx, `UPDATE workstreams SET position=? WHERE id=?`, i, id); err != nil {
					return err
				}
			}
			if out, err = workstreamsOf(ctx, tx, roadmapID); err != nil {
				return err
			}
		}
		title, team, err = RoadmapNames(ctx, tx, roadmapID)
		return err
	})
	if err == nil && changed {
		slog.InfoContext(ctx, "store: workstreams reordered", "roadmap_id", roadmapID)
	}
	return
}

// freeRow finds the lowest row (0, 1, 2, ...) inside workstreamID where [start,end] overlaps nothing
// already there — deliverables and milestones both count, and a milestone occupies its single day
// (REQ_DAT_026, REQ_API_029). It is only ever consulted when an item is placed into a workstream it
// wasn't already in; an existing membership's row is never touched by it.
func freeRow(ctx context.Context, q querier, workstreamID int64, start, end string) (int, error) {
	items, err := rowItemsIn(ctx, q, workstreamID)
	if err != nil {
		return 0, err
	}
	for me := (rowItem{start: start, end: end}); ; me.row++ {
		if !slices.ContainsFunc(items, me.overlaps) {
			return me.row, nil
		}
	}
}

// WorkstreamDelete removes a workstream. There is no mode that deletes its deliverables or
// milestones (REQ_API_025): if it still holds any of either, the caller must pass a target (> 0)
// workstream of the same roadmap, else 409 has_roadmap_items; a target is validated even when the
// workstream is empty. Refused (409
// only_workstream) when it is the roadmap's last workstream (REQ_DAT_023), checked before anything
// else. Returns the removed workstream, how many deliverables and milestones it held, when a
// target was given its name, and the roadmap's title and its team's name — all read inside
// the same transaction as the delete (REQ_AUD_003).
func WorkstreamDelete(ctx context.Context, db *sql.DB, id int64, target int64) (w Workstream, held, heldMilestones int, targetName, title, team string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if w, err = WorkstreamGet(ctx, tx, id); err != nil {
			return err
		}
		var wsCount int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM workstreams WHERE roadmap_id=?`, w.RoadmapID).Scan(&wsCount); err != nil {
			return err
		}
		if wsCount <= 1 {
			slog.InfoContext(ctx, "store: workstream delete refused, roadmap's only workstream", "workstream_id", id, "roadmap_id", w.RoadmapID)
			return conflict("only_workstream", "A roadmap always needs at least one workstream; create another before deleting this one")
		}
		rows, err := tx.QueryContext(ctx, `SELECT dw.deliverable_id FROM deliverable_workstreams dw WHERE dw.workstream_id=?`, id)
		if err != nil {
			return err
		}
		var dels []int64
		for rows.Next() {
			var d int64
			if err := rows.Scan(&d); err != nil {
				rows.Close()
				return err
			}
			dels = append(dels, d)
		}
		rows.Close()
		held = len(dels)
		type ms struct {
			id   int64
			date string
		}
		var mss []ms
		if err := collect(ctx, tx, `SELECT id, date FROM milestones WHERE workstream_id=?`, []any{id}, func(s scanner) error {
			var m ms
			if err := s.Scan(&m.id, &m.date); err != nil {
				return err
			}
			mss = append(mss, m)
			return nil
		}); err != nil {
			return err
		}
		heldMilestones = len(mss)
		if (held > 0 || len(mss) > 0) && target == 0 {
			slog.InfoContext(ctx, "store: workstream delete refused, holds deliverables or milestones",
				"workstream_id", id, "deliverables", held, "milestones", len(mss))
			return conflict("has_roadmap_items", fmt.Sprintf(
				"This workstream still holds %d deliverable(s) and %d milestone(s); pass target=<workstream id>", held, len(mss)))
		}
		if target != 0 {
			if target == id || target < 0 {
				return invalid1("target", "must be another workstream of this roadmap")
			}
			t, err := WorkstreamGet(ctx, tx, target)
			if err != nil && !isNotFound(err) {
				return err
			}
			if err != nil || t.RoadmapID != w.RoadmapID {
				return invalid1("target", "must be another workstream of this roadmap")
			}
			targetName = t.Name
			for _, d := range dels {
				if err := addMembership(ctx, tx, d, target); err != nil { // no-op if already a member
					return err
				}
			}
			// REQ_API_025: a workstream's milestones move to the target along with its deliverables,
			// placed by the same free-row rule (REQ_DAT_026).
			for _, m := range mss {
				row, err := freeRow(ctx, tx, target, m.date, m.date)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `UPDATE milestones SET workstream_id=?, row=? WHERE id=?`, target, row, m.id); err != nil {
					return err
				}
			}
			if len(mss) > 0 {
				slog.InfoContext(ctx, "store: workstream delete moved milestones to the target", "workstream_id", id, "target_workstream_id", target, "milestones", len(mss))
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM deliverable_workstreams WHERE workstream_id=?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workstreams WHERE id=?`, id); err != nil {
			return err
		}
		if err := refreshRange(ctx, tx, w.RoadmapID, false); err != nil {
			return err
		}
		title, team, err = RoadmapNames(ctx, tx, w.RoadmapID)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: workstream deleted", "workstream_id", id, "target", target, "deliverables_held", held)
	}
	return
}

// addMembership adds the deliverable to the workstream if it isn't already a member, placing it at
// the lowest row that overlaps nothing already there (REQ_DAT_026); already being a member is a
// no-op that leaves its stored row untouched — the server never moves a row on its own.
func addMembership(ctx context.Context, q querier, deliverableID, workstreamID int64) error {
	var already int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM deliverable_workstreams WHERE deliverable_id=? AND workstream_id=?`,
		deliverableID, workstreamID).Scan(&already); err != nil {
		return err
	}
	if already > 0 {
		return nil
	}
	var start, end string
	if err := q.QueryRowContext(ctx, `SELECT start_date, end_date FROM deliverables WHERE id=?`, deliverableID).Scan(&start, &end); err != nil {
		return err
	}
	row, err := freeRow(ctx, q, workstreamID, start, end)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `INSERT INTO deliverable_workstreams(deliverable_id, workstream_id, row) VALUES (?,?,?)`,
		deliverableID, workstreamID, row)
	return err
}

// setRows updates the stored row of memberships the deliverable already has (REQ_API_029 — a PATCH
// can set rows). Every workstream id in rows must be one of ids; anything else is 422.
func setRows(ctx context.Context, q querier, deliverableID int64, ids []int64, rows map[int64]int) error {
	for wsID, row := range rows {
		if !slices.Contains(ids, wsID) {
			return invalid1("rows", fmt.Sprintf("workstream %d is not one of this deliverable's workstreams", wsID))
		}
		if row < 0 {
			return invalid1("rows", "must not be negative")
		}
		if _, err := q.ExecContext(ctx, `UPDATE deliverable_workstreams SET row=? WHERE deliverable_id=? AND workstream_id=?`, row, deliverableID, wsID); err != nil {
			return err
		}
	}
	return nil
}
