package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"
)

// MoveEntry maps one source workstream to a destination. To is a workstream id, {"create":"name"}
// or null (drop from this workstream; a deliverable only).
type MoveEntry struct {
	From int64           `json:"from"`
	To   json.RawMessage `json:"to"`
}

// MoveInput is the one request body of both move endpoints (REQ_API_052).
type MoveInput struct {
	TeamID        int64       `json:"team_id"`
	WorkstreamMap []MoveEntry `json:"workstream_map"`
}

// MoveResult carries the moved item and what its audit entry needs (REQ_API_011, REQ_API_013).
type MoveResult struct {
	Item                       any // the moved Deliverable or Milestone, as GET returns it
	Name                       string
	FromTeam, ToTeam           string
	FromRoadmapID, ToRoadmapID int64
}

type target struct {
	id     int64
	create string
}

func (e MoveEntry) parse() (t *target, err error) {
	if len(e.To) == 0 { // the "to" key was not sent at all: only an explicit null means "drop"
		return nil, invalid1("workstream_map", `"to" is required for each entry; send null to drop that workstream`)
	}
	raw := strings.TrimSpace(string(e.To))
	switch {
	case raw == "null":
		return nil, nil
	case strings.HasPrefix(raw, "{"):
		var c struct {
			Create string `json:"create"`
		}
		if json.Unmarshal(e.To, &c) != nil || TrimName(c.Create) == "" {
			return nil, invalid1("workstream_map", `"to" object must be {"create": "<name>"}`)
		}
		// same name validation as POST .../workstreams: required, at most 200 characters
		name, err := cleanName("workstream_map", c.Create)
		if err != nil {
			return nil, err
		}
		return &target{create: name}, nil
	}
	var id int64
	if json.Unmarshal(e.To, &id) != nil {
		return nil, invalid1("workstream_map", `"to" must be a workstream id, {"create": "<name>"} or null`)
	}
	return &target{id: id}, nil
}

// ItemMove moves a deliverable or a milestone to another team's roadmap in one transaction
// (REQ_API_011, 012, 013, 052; REQ_DAT_021, 029, 030). Both kinds take the same body and run this
// code: each of the item's workstreams goes where workstream_map sends it, or else to the destination's
// workstream of the same name (wsKey: trimmed, case ignored; the first by position wins). The item's
// id, dates, links and dependencies stay as they are; only its roadmap and workstreams change.
func ItemMove(ctx context.Context, db *sql.DB, kind string, id int64, in MoveInput) (MoveResult, error) {
	var res MoveResult
	err := inTx(ctx, db, func(tx *sql.Tx) error {
		// The item's roadmap, its workstreams in position order, and its dates (for a milestone's row).
		var wsIDs []int64
		var date string
		switch kind {
		case KindDeliverable:
			d, err := DeliverableGet(ctx, tx, id)
			if err != nil {
				return err
			}
			res.Name, res.FromRoadmapID, wsIDs = d.Name, d.RoadmapID, d.WorkstreamIDs
		default:
			m, err := MilestoneGet(ctx, tx, id)
			if err != nil {
				return err
			}
			res.Name, res.FromRoadmapID, wsIDs, date = m.Name, m.RoadmapID, []int64{m.WorkstreamID}, m.Date
		}
		var fromTeamID int64
		if err := tx.QueryRowContext(ctx, `SELECT r.team_id, t.name FROM roadmaps r JOIN teams t ON t.id=r.team_id WHERE r.id=?`,
			res.FromRoadmapID).Scan(&fromTeamID, &res.FromTeam); err != nil {
			return err
		}
		toTeam, err := TeamGet(ctx, tx, in.TeamID)
		if isNotFound(err) {
			return invalid1("team_id", "no such team")
		} else if err != nil {
			return err
		}
		if toTeam.ID == fromTeamID { // REQ_API_012: a team has one roadmap, so a move always leaves the team
			slog.InfoContext(ctx, "store: move refused, destination is the item's own team", "kind", kind, "id", id, "team_id", toTeam.ID)
			return invalid1("team_id", "must be another team; the "+kind+" is already on this team's roadmap")
		}
		res.ToTeam, res.ToRoadmapID = toTeam.Name, toTeam.RoadmapID

		src := map[int64]Workstream{}
		for _, w := range wsIDs {
			ws, err := WorkstreamGet(ctx, tx, w)
			if err != nil {
				return err
			}
			src[w] = ws
		}
		given := map[int64]MoveEntry{}
		for _, e := range in.WorkstreamMap {
			if _, ok := src[e.From]; !ok {
				return invalid1("workstream_map", "from must be a workstream of the "+kind)
			}
			if _, dup := given[e.From]; dup {
				return invalid1("workstream_map", "each source workstream may appear only once")
			}
			given[e.From] = e
		}
		dest, err := workstreamsOf(ctx, tx, res.ToRoadmapID) // position order: the first match wins
		if err != nil {
			return err
		}
		byName := func(name string) int64 {
			for _, w := range dest {
				if wsKey(w.Name) == wsKey(name) {
					return w.ID
				}
			}
			return 0
		}
		var final []int64
		for _, from := range wsIDs { // already in position order, so a deliverable's primary stays derived
			var t *target
			if e, ok := given[from]; ok {
				if t, err = e.parse(); err != nil {
					return err
				}
			} else if w := byName(src[from].Name); w != 0 {
				t = &target{id: w}
			} else {
				return invalid1("workstream_map", "workstream \""+src[from].Name+"\" has no same-named workstream in the destination; map it or create it")
			}
			var w int64
			switch {
			case t == nil && kind == KindMilestone:
				return invalid1("workstream_map", "a milestone can't drop its workstream; map it to one or create one")
			case t == nil:
				slog.InfoContext(ctx, "store: move drops workstream", "kind", kind, "id", id, "workstream", src[from].Name)
				continue
			case t.create != "":
				if w = byName(t.create); w == 0 { // a same-named one is reused rather than duplicated
					if w, err = appendWorkstream(ctx, tx, res.ToRoadmapID, t.create); err != nil {
						return err
					}
					dest = append(dest, Workstream{ID: w, RoadmapID: res.ToRoadmapID, Name: t.create})
					slog.InfoContext(ctx, "store: move creates workstream", "name", t.create, "roadmap_id", res.ToRoadmapID)
				}
			default:
				for _, d := range dest {
					if d.ID == t.id {
						w = t.id
					}
				}
				if w == 0 {
					return invalid1("workstream_map", "destination workstream is not in the destination roadmap")
				}
			}
			if !slices.Contains(final, w) {
				final = append(final, w)
			}
		}
		if len(final) == 0 {
			return invalid1("workstream_map", "at least one workstream must remain")
		}
		if kind == KindDeliverable {
			if _, err := tx.ExecContext(ctx, `DELETE FROM deliverable_workstreams WHERE deliverable_id=?`, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE deliverables SET roadmap_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, res.ToRoadmapID, id); err != nil {
				return err
			}
			for _, w := range final {
				if err := addMembership(ctx, tx, id, w); err != nil {
					return err
				}
			}
		} else {
			row, err := freeRow(ctx, tx, final[0], date, date)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE milestones SET roadmap_id=?, workstream_id=?, row=? WHERE id=?`, res.ToRoadmapID, final[0], row, id); err != nil {
				return err
			}
		}
		if err := refreshRange(ctx, tx, res.ToRoadmapID, true); err != nil {
			return err
		}
		if err := refreshRange(ctx, tx, res.FromRoadmapID, false); err != nil {
			return err
		}
		if kind == KindDeliverable {
			res.Item, err = DeliverableGet(ctx, tx, id)
		} else {
			res.Item, err = MilestoneGet(ctx, tx, id)
		}
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: roadmap item moved", "kind", kind, "id", id, "from", res.FromTeam, "to", res.ToTeam)
	}
	return res, err
}
