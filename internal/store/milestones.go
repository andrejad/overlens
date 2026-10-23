package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"slices"
)

// MilestoneInput: on create name, date and workstream_id are required; on PATCH any subset may be
// sent. row follows the same rule as a deliverable's (REQ_DAT_026/REQ_API_029): the server only
// picks one itself (lowest free row, via freeRow) when the milestone enters a workstream it wasn't
// already in; an explicit row, for its current workstream or the one it's moving to in the same
// request (the drag-to-move case), is checked for overlap like any other change (REQ_API_051).
type MilestoneInput struct {
	Name            *string `json:"name"`
	Date            *string `json:"date"`
	WorkstreamID    *int64  `json:"workstream_id"`
	Row             *int    `json:"row"`
	DescriptionHTML *string `json:"description_html"`
	// Owner, status, risk note and links follow a deliverable's rules exactly (REQ_DAT_030, REQ_DAT_014):
	// links, when sent, replace the whole set.
	ResponsiblePerson *string      `json:"responsible_person"`
	Status            *string      `json:"status"`
	RiskNote          *string      `json:"risk_note"`
	Links             *[]LinkInput `json:"links"`
}

// milestonesWhere loads milestones matching cond (a predicate on alias m, roadmaps as r) with their links,
// ordered by date then id, using one query per table.
func milestonesWhere(ctx context.Context, q querier, cond string, args ...any) ([]Milestone, error) {
	out := []Milestone{}
	byID := map[int64]int{}
	if err := collect(ctx, q, `SELECT m.id, m.roadmap_id, m.workstream_id, m.name, m.date, m.row, m.description_html,
	  m.responsible_person, m.status, m.risk_note FROM milestones m JOIN roadmaps r ON r.id=m.roadmap_id WHERE `+cond+` ORDER BY m.date, m.id`, args, func(s scanner) error {
		m := Milestone{Links: []Link{}}
		if err := s.Scan(&m.ID, &m.RoadmapID, &m.WorkstreamID, &m.Name, &m.Date, &m.Row, &m.DescriptionHTML,
			&m.ResponsiblePerson, &m.Status, &m.RiskNote); err != nil {
			return err
		}
		byID[m.ID] = len(out)
		out = append(out, m)
		return nil
	}); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	err := collect(ctx, q, `SELECT l.item_id, l.id, l.label, l.url, l.position FROM roadmap_item_links l
	  JOIN milestones m ON m.id=l.item_id JOIN roadmaps r ON r.id=m.roadmap_id WHERE l.item_kind='milestone' AND (`+cond+`) ORDER BY l.position, l.id`, args, func(s scanner) error {
		var mid int64
		var l Link
		if err := s.Scan(&mid, &l.ID, &l.Label, &l.URL, &l.Position); err != nil {
			return err
		}
		if i, ok := byID[mid]; ok {
			out[i].Links = append(out[i].Links, l)
		}
		return nil
	})
	return out, err
}

// cleanMilestoneDescription cleans a milestone's description_html exactly like a deliverable's
// (REQ_API_030) and then applies the 100 KB limit to the cleaned text (422, field description_html).
func cleanMilestoneDescription(raw string) (string, error) {
	d := sanitizeDescription(raw)
	if len(d) > maxDescriptionBytes {
		slog.Warn("store: milestone description_html refused, too long after cleaning", "bytes", len(d), "limit", maxDescriptionBytes)
		return "", invalid1("description_html", fmt.Sprintf("must be at most %d bytes after cleaning", maxDescriptionBytes))
	}
	return d, nil
}

func MilestoneGet(ctx context.Context, q querier, id int64) (Milestone, error) {
	ms, err := milestonesWhere(ctx, q, "m.id=?", id)
	if err != nil {
		return Milestone{}, err
	}
	if len(ms) == 0 {
		return Milestone{}, notFound("milestone", id)
	}
	return ms[0], nil
}

// validate checks the owner, status, risk note and links with a deliverable's rules (REQ_DAT_010, 011,
// 014) and normalizes: a status other than at_risk clears the risk note. Errors are 422 with the field names
// a deliverable uses.
func (m *Milestone) validate() error {
	f := map[string]string{}
	if !slices.Contains(statuses, m.Status) {
		f["status"] = "must be one of planned, in_progress, done, at_risk"
	}
	if m.Status != "at_risk" {
		m.RiskNote = "" // REQ_DAT_011
	}
	if runeLen(m.ResponsiblePerson) > maxResponsiblePerson {
		f["responsible_person"] = fmt.Sprintf("must be at most %d characters", maxResponsiblePerson)
	}
	if runeLen(m.RiskNote) > maxRiskNote {
		f["risk_note"] = fmt.Sprintf("must be at most %d characters", maxRiskNote)
	}
	if msg := validateLinks(m.Links); msg != "" {
		f["links"] = msg
	}
	if len(f) > 0 {
		slog.Warn("store: milestone refused, owner/status/risk note/links not valid", "fields", f)
		return invalid("Milestone is not valid", f)
	}
	return nil
}

// apply merges the sent owner, status, risk note and links over m.
func (in MilestoneInput) applyDetails(m *Milestone) {
	if in.ResponsiblePerson != nil {
		m.ResponsiblePerson = *in.ResponsiblePerson
	}
	if in.Status != nil {
		m.Status = *in.Status
	}
	if in.RiskNote != nil {
		m.RiskNote = *in.RiskNote
	}
	if in.Links != nil {
		m.Links = applyLinks(*in.Links)
	}
}

// checkMilestoneWorkstream requires id to be a workstream of roadmapID (422, field workstream_id);
// an id that isn't any workstream at all is 404 (from WorkstreamGet).
func checkMilestoneWorkstream(ctx context.Context, q querier, roadmapID, id int64) error {
	ws, err := WorkstreamGet(ctx, q, id)
	if err != nil {
		return err
	}
	if ws.RoadmapID != roadmapID {
		slog.WarnContext(ctx, "store: milestone workstream_id refused, not a workstream of this roadmap", "roadmap_id", roadmapID, "workstream_id", id)
		return invalid1("workstream_id", "must be a workstream of this roadmap")
	}
	return nil
}

// MilestoneCreate also returns the roadmap's title and its team's name, read inside the same
// transaction as the insert (REQ_AUD_003).
func MilestoneCreate(ctx context.Context, db *sql.DB, roadmapID int64, in MilestoneInput) (out Milestone, title, team string, err error) {
	var name string
	if in.Name != nil {
		name = *in.Name
	}
	name, err = cleanName("name", name)
	if err != nil {
		return
	}
	if in.Date == nil || *in.Date == "" {
		err = invalid1("date", "required")
		return
	}
	date := *in.Date
	if !validDate(date) {
		err = invalid1("date", "must be a date like 2026-09-21")
		return
	}
	if in.WorkstreamID == nil {
		err = invalid1("workstream_id", "required")
		return
	}
	wsID := *in.WorkstreamID
	if in.Row != nil && *in.Row < 0 {
		err = invalid1("row", "must not be negative")
		return
	}
	var desc string
	if in.DescriptionHTML != nil {
		if desc, err = cleanMilestoneDescription(*in.DescriptionHTML); err != nil {
			return
		}
	}
	nm := Milestone{Status: "planned"}
	in.applyDetails(&nm)
	if err = nm.validate(); err != nil {
		return
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := RoadmapGet(ctx, tx, roadmapID); err != nil {
			return err
		}
		if err := checkMilestoneWorkstream(ctx, tx, roadmapID, wsID); err != nil {
			return err
		}
		// REQ_DAT_026/REQ_API_029: a brand new milestone always enters a workstream it wasn't already
		// in, so the server always picks a free row first; an explicit row overrides it and is checked below.
		row, err := freeRow(ctx, tx, wsID, date, date)
		if err != nil {
			return err
		}
		if in.Row != nil {
			row = *in.Row
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO milestones(roadmap_id, workstream_id, name, date, row, description_html, responsible_person, status, risk_note) VALUES (?,?,?,?,?,?,?,?,?)`,
			roadmapID, wsID, name, date, row, desc, nm.ResponsiblePerson, nm.Status, nm.RiskNote)
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		if err := writeLinks(ctx, tx, KindMilestone, id, nm.Links); err != nil {
			return err
		}
		if err := refreshRange(ctx, tx, roadmapID, true); err != nil {
			return err
		}
		if in.Row != nil { // a row the server picked is free; an explicit one is checked (REQ_API_051)
			if err := checkRowOverlap(ctx, tx, ItemRef{KindMilestone, id}, []int64{wsID}); err != nil {
				return err
			}
		}
		if out, err = MilestoneGet(ctx, tx, id); err != nil {
			return err
		}
		title, team, err = RoadmapNames(ctx, tx, roadmapID)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: milestone created", "milestone_id", out.ID, "roadmap_id", roadmapID, "name", out.Name)
	}
	return
}

// MilestoneUpdate applies a partial update and returns the milestone before and after, the
// roadmap's title, its team's name, and the before/after workstream names (for the caller's audit
// diff, REQ_AUD_003, workstream reported by name not id) — all read inside the same transaction as
// the update. A request that changes nothing issues no UPDATE (REQ_AUD_001's no-op writes nothing).
func MilestoneUpdate(ctx context.Context, db *sql.DB, id int64, in MilestoneInput) (before, after Milestone, title, team string, wsNames map[int64]string, err error) {
	if in.Row != nil && *in.Row < 0 {
		err = invalid1("row", "must not be negative")
		return
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if before, err = MilestoneGet(ctx, tx, id); err != nil {
			return err
		}
		m := before
		if in.Name != nil {
			name, err := cleanName("name", *in.Name)
			if err != nil {
				return err
			}
			m.Name = name
		}
		if in.Date != nil {
			if *in.Date == "" {
				return invalid1("date", "required")
			}
			if !validDate(*in.Date) {
				return invalid1("date", "must be a date like 2026-09-21")
			}
			m.Date = *in.Date
		}
		if in.DescriptionHTML != nil {
			if m.DescriptionHTML, err = cleanMilestoneDescription(*in.DescriptionHTML); err != nil {
				return err
			}
		}
		in.applyDetails(&m)
		if err := m.validate(); err != nil {
			return err
		}
		movingWorkstream := in.WorkstreamID != nil && *in.WorkstreamID != before.WorkstreamID
		if in.WorkstreamID != nil {
			if err := checkMilestoneWorkstream(ctx, tx, before.RoadmapID, *in.WorkstreamID); err != nil {
				return err
			}
			m.WorkstreamID = *in.WorkstreamID
		}
		switch {
		case in.Row != nil:
			// An explicit row, same as a deliverable's `rows` — whether for the workstream the milestone is
			// already in or the one it's moving to in this same request (the drag-to-move case sends
			// {date, workstream_id, row} together) — is checked for overlap below (REQ_API_051).
			m.Row = *in.Row
		case movingWorkstream:
			// REQ_DAT_026/REQ_API_029: the server only picks a row itself when the milestone enters a
			// workstream it wasn't already in.
			row, err := freeRow(ctx, tx, m.WorkstreamID, m.Date, m.Date)
			if err != nil {
				return err
			}
			m.Row = row
		}
		if m.Date != before.Date { // REQ_DEP_024: the date may not break a dependency, in either direction
			if err := checkDependencyDates(ctx, tx, ItemRef{KindMilestone, id}, m.Name, m.Date, m.Date); err != nil {
				return err
			}
		}
		if sameMilestoneRow(m, before) {
			slog.DebugContext(ctx, "store: milestone columns unchanged, no UPDATE", "milestone_id", id)
		} else if _, err := tx.ExecContext(ctx, `UPDATE milestones SET name=?, workstream_id=?, date=?, row=?, description_html=?,
		  responsible_person=?, status=?, risk_note=? WHERE id=?`,
			m.Name, m.WorkstreamID, m.Date, m.Row, m.DescriptionHTML, m.ResponsiblePerson, m.Status, m.RiskNote, id); err != nil {
			return err
		}
		if m.Date != before.Date || m.WorkstreamID != before.WorkstreamID || m.Row != before.Row { // REQ_API_051
			if err := checkRowOverlap(ctx, tx, ItemRef{KindMilestone, id}, []int64{m.WorkstreamID}); err != nil {
				return err
			}
		}
		if in.Links != nil && !slices.Equal(LinkPairs(m.Links), LinkPairs(before.Links)) {
			if err := writeLinks(ctx, tx, KindMilestone, id, m.Links); err != nil {
				return err
			}
		}
		if m.Date != before.Date || m.WorkstreamID != before.WorkstreamID {
			if err := refreshRange(ctx, tx, before.RoadmapID, true); err != nil {
				return err
			}
		}
		if after, err = MilestoneGet(ctx, tx, id); err != nil {
			return err
		}
		if title, team, err = RoadmapNames(ctx, tx, after.RoadmapID); err != nil {
			return err
		}
		wsNames, err = workstreamNamesByID(ctx, tx, []int64{before.WorkstreamID, after.WorkstreamID})
		return err
	})
	if err == nil {
		if !sameMilestoneRow(before, after) || !slices.Equal(LinkPairs(before.Links), LinkPairs(after.Links)) {
			slog.InfoContext(ctx, "store: milestone updated", "milestone_id", id)
		} else {
			slog.InfoContext(ctx, "store: milestone update is a no-op, nothing changed", "milestone_id", id)
		}
	}
	return
}

func sameMilestoneRow(a, b Milestone) bool {
	a.Links, b.Links = nil, nil
	return a.ID == b.ID && a.RoadmapID == b.RoadmapID && a.WorkstreamID == b.WorkstreamID && a.Name == b.Name && a.Date == b.Date &&
		a.Row == b.Row && a.DescriptionHTML == b.DescriptionHTML && a.ResponsiblePerson == b.ResponsiblePerson &&
		a.Status == b.Status && a.RiskNote == b.RiskNote
}

// LinkPairs lists label and url of each link, for comparing sets of links without their ids.
func LinkPairs(ls []Link) []string {
	out := make([]string, len(ls))
	for i, l := range ls {
		out[i] = l.Label + " " + l.URL
	}
	return out
}

// MilestoneDelete removes the milestone; it also returns the roadmap's title and its team's name,
// read inside the same transaction as the delete (REQ_AUD_003). A delete is never refused by the
// 3-year cap — refreshRange only recomputes the (now possibly smaller) range afterward.
func MilestoneDelete(ctx context.Context, db *sql.DB, id int64) (m Milestone, removed []RemovedDependency, title, team string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if m, err = MilestoneGet(ctx, tx, id); err != nil {
			return err
		}
		if title, team, err = RoadmapNames(ctx, tx, m.RoadmapID); err != nil {
			return err
		}
		if removed, err = removeItemEdges(ctx, tx, ItemRef{KindMilestone, id}); err != nil { // REQ_DEP_029
			return err
		}
		if err := deleteLinks(ctx, tx, KindMilestone, id); err != nil { // no foreign key (REQ_DAT_031)
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM milestones WHERE id=?`, id); err != nil {
			return err
		}
		return refreshRange(ctx, tx, m.RoadmapID, false)
	})
	if err == nil {
		slog.InfoContext(ctx, "store: milestone deleted", "milestone_id", id, "name", m.Name, "dependencies_removed", len(removed))
	}
	return
}
