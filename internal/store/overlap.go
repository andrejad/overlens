package store

import (
	"context"
	"fmt"
	"log/slog"
)

// rowItem is one roadmap item's place in one row of a workstream: a deliverable has one per membership,
// a milestone exactly one, its start and end being its single day.
type rowItem struct {
	kind       string
	id         int64
	name       string
	row        int
	start, end string
}

// overlaps is the one no-overlap test the server uses (REQ_FE_010, REQ_API_051): the same row and at least
// one shared day, both end days counting. freeRow, checkRowOverlap and the company-file loader all use it.
func (a rowItem) overlaps(b rowItem) bool {
	return a.row == b.row && a.start <= b.end && b.start <= a.end
}

// rowItemsIn lists every roadmap item placed in the workstream, deliverables and milestones, by start day.
func rowItemsIn(ctx context.Context, q querier, workstreamID int64) ([]rowItem, error) {
	var out []rowItem
	err := collect(ctx, q, `SELECT 'deliverable', d.id, d.name, dw.row, d.start_date, d.end_date
	  FROM deliverable_workstreams dw JOIN deliverables d ON d.id=dw.deliverable_id WHERE dw.workstream_id=?
	  UNION ALL SELECT 'milestone', id, name, row, date, date FROM milestones WHERE workstream_id=?
	  ORDER BY 5, 1, 2`, []any{workstreamID, workstreamID}, func(s scanner) error {
		var it rowItem
		if err := s.Scan(&it.kind, &it.id, &it.name, &it.row, &it.start, &it.end); err != nil {
			return err
		}
		out = append(out, it)
		return nil
	})
	return out, err
}

// checkRowOverlap is the server's guard for REQ_API_051. Called inside a write's own transaction, after
// the write, with the workstreams where the item's place (row or days) changed, it refuses with
// 409 row_overlap, naming the first item in the way, when the item now shares a row and a day with another.
func checkRowOverlap(ctx context.Context, q querier, me ItemRef, workstreamIDs []int64) error {
	for _, ws := range workstreamIDs {
		items, err := rowItemsIn(ctx, q, ws)
		if err != nil {
			return err
		}
		var mine *rowItem
		for i := range items {
			if items[i].kind == me.Kind && items[i].id == me.ID {
				mine = &items[i]
			}
		}
		if mine == nil {
			continue
		}
		for _, o := range items {
			if (o.kind != me.Kind || o.id != me.ID) && mine.overlaps(o) {
				w, err := WorkstreamGet(ctx, q, ws)
				if err != nil {
					return err
				}
				slog.InfoContext(ctx, "store: write refused, row overlap", "kind", me.Kind, "id", me.ID,
					"workstream_id", ws, "row", o.row, "in_the_way_kind", o.kind, "in_the_way_id", o.id)
				return conflict("row_overlap", fmt.Sprintf("Overlaps %q in %s, row %d", o.name, w.Name, o.row+1)) // rows count from 1 on screen
			}
		}
	}
	return nil
}
