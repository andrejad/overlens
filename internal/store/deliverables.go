package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var iconKeyRe = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)

var statuses = []string{"planned", "in_progress", "done", "at_risk"}

// Free-text length limits (REQ_API length limits review item); names count runes, not bytes.
const (
	maxResponsiblePerson = 200
	maxRiskNote          = 2000
	maxDescriptionBytes  = 100 * 1024 // after sanitizing
	maxLinkLabel         = 200
	maxLinkURL           = 2000
	maxLinks             = 50
	maxIcons             = 20
)

type Link struct {
	ID       int64  `json:"id"`
	Label    string `json:"label"`
	URL      string `json:"url"`
	Position int    `json:"position"`
}

type LinkInput struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// WorkstreamMembership is a deliverable's membership in one workstream, with the row it's stored in
// (REQ_DAT_026, REQ_API_029). Workstreams (and WorkstreamIDs, kept for simpler existing callers) are
// ordered by the workstream's position: the first is the primary (REQ_DAT_005).
type WorkstreamMembership struct {
	ID  int64 `json:"id"`
	Row int   `json:"row"`
}

// DeliverableInput: on create name, start_date, end_date and workstream_ids are required; on PATCH
// any subset may be sent. Icons and links, when sent, replace the whole set. Rows, when sent, set the
// stored row of memberships the deliverable already has (or will have after workstream_ids is
// applied in the same request) — every other key of rows must name one of those workstreams.
type DeliverableInput struct {
	Name              *string        `json:"name"`
	StartDate         *string        `json:"start_date"`
	EndDate           *string        `json:"end_date"`
	Color             *string        `json:"color"`
	ResponsiblePerson *string        `json:"responsible_person"`
	DescriptionHTML   *string        `json:"description_html"`
	Status            *string        `json:"status"`
	RiskNote          *string        `json:"risk_note"`
	Icons             *[]string      `json:"icons"`
	WorkstreamIDs     *[]int64       `json:"workstream_ids"`
	Rows              *map[int64]int `json:"rows"`
	Links             *[]LinkInput   `json:"links"`
}

type Deliverable struct {
	ID                int64                  `json:"id"`
	RoadmapID         int64                  `json:"roadmap_id"`
	TeamID            int64                  `json:"team_id"`
	Name              string                 `json:"name"`
	StartDate         string                 `json:"start_date"`
	EndDate           string                 `json:"end_date"`
	Color             string                 `json:"color"`
	ResponsiblePerson string                 `json:"responsible_person"`
	DescriptionHTML   string                 `json:"description_html"`
	Status            string                 `json:"status"`
	RiskNote          string                 `json:"risk_note"`
	Icons             []string               `json:"icons"`
	WorkstreamIDs     []int64                `json:"workstream_ids"` // ordered by workstream position: the first is the primary
	Workstreams       []WorkstreamMembership `json:"workstreams"`    // same order, each with its stored row
	Links             []Link                 `json:"links"`
	CreatedAt         string                 `json:"created_at"`
	UpdatedAt         string                 `json:"updated_at"`
}

// deliverablesWhere loads deliverables matching cond (a predicate on alias d, roadmaps as r) with
// their workstream ids, icons and links, using one query per table.
func deliverablesWhere(ctx context.Context, q querier, cond string, args ...any) ([]Deliverable, error) {
	rows, err := q.QueryContext(ctx, `SELECT d.id, d.roadmap_id, r.team_id, d.name, d.start_date, d.end_date, d.color,
	  d.responsible_person, d.description_html, d.status, d.risk_note, d.created_at, d.updated_at
	  FROM deliverables d JOIN roadmaps r ON r.id=d.roadmap_id WHERE `+cond+` ORDER BY d.start_date, d.id`, args...)
	if err != nil {
		return nil, err
	}
	var out []Deliverable
	byID := map[int64]*Deliverable{}
	for rows.Next() {
		var d Deliverable
		if err := rows.Scan(&d.ID, &d.RoadmapID, &d.TeamID, &d.Name, &d.StartDate, &d.EndDate, &d.Color,
			&d.ResponsiblePerson, &d.DescriptionHTML, &d.Status, &d.RiskNote, &d.CreatedAt, &d.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		d.CreatedAt, d.UpdatedAt = ts(d.CreatedAt), ts(d.UpdatedAt)
		d.Icons, d.WorkstreamIDs, d.Workstreams, d.Links = []string{}, []int64{}, []WorkstreamMembership{}, []Link{}
		out = append(out, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		byID[out[i].ID] = &out[i]
	}
	// workstream memberships, primary first (lowest workstream position)
	if err := collect(ctx, q, `SELECT dw.deliverable_id, dw.workstream_id, dw.row FROM deliverable_workstreams dw
	  JOIN workstreams w ON w.id=dw.workstream_id JOIN deliverables d ON d.id=dw.deliverable_id
	  JOIN roadmaps r ON r.id=d.roadmap_id WHERE `+cond+` ORDER BY w.position, w.id`, args, func(s scanner) error {
		var did, wid int64
		var row int
		if err := s.Scan(&did, &wid, &row); err != nil {
			return err
		}
		if d := byID[did]; d != nil {
			d.WorkstreamIDs = append(d.WorkstreamIDs, wid)
			d.Workstreams = append(d.Workstreams, WorkstreamMembership{ID: wid, Row: row})
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := collect(ctx, q, `SELECT di.deliverable_id, di.icon_key FROM deliverable_icons di
	  JOIN deliverables d ON d.id=di.deliverable_id JOIN roadmaps r ON r.id=d.roadmap_id WHERE `+cond+` ORDER BY di.icon_key`, args, func(s scanner) error {
		var did int64
		var k string
		if err := s.Scan(&did, &k); err != nil {
			return err
		}
		if d := byID[did]; d != nil {
			d.Icons = append(d.Icons, k)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := collect(ctx, q, `SELECT l.item_id, l.id, l.label, l.url, l.position FROM roadmap_item_links l
	  JOIN deliverables d ON d.id=l.item_id JOIN roadmaps r ON r.id=d.roadmap_id WHERE l.item_kind='deliverable' AND (`+cond+`) ORDER BY l.position, l.id`, args, func(s scanner) error {
		var did int64
		var l Link
		if err := s.Scan(&did, &l.ID, &l.Label, &l.URL, &l.Position); err != nil {
			return err
		}
		if d := byID[did]; d != nil {
			d.Links = append(d.Links, l)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return listPage(out), nil
}

type scanner interface{ Scan(...any) error }

func collect(ctx context.Context, q querier, query string, args []any, each func(scanner) error) error {
	rs, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rs.Close()
	for rs.Next() {
		if err := each(rs); err != nil {
			return err
		}
	}
	return rs.Err()
}

func DeliverableGet(ctx context.Context, q querier, id int64) (Deliverable, error) {
	ds, err := deliverablesWhere(ctx, q, "d.id=?", id)
	if err != nil {
		return Deliverable{}, err
	}
	if len(ds) == 0 {
		return Deliverable{}, notFound("deliverable", id)
	}
	return ds[0], nil
}

// apply merges the sent fields over d. description_html is sanitized here (REQ_API_030), so d always
// holds the cleaned value from the moment a request applies it, before validate or any diff.
func (in DeliverableInput) apply(d *Deliverable) {
	if in.Name != nil {
		d.Name = *in.Name
	}
	if in.StartDate != nil {
		d.StartDate = *in.StartDate
	}
	if in.EndDate != nil {
		d.EndDate = *in.EndDate
	}
	if in.Color != nil {
		d.Color = *in.Color
	}
	if in.ResponsiblePerson != nil {
		d.ResponsiblePerson = *in.ResponsiblePerson
	}
	if in.DescriptionHTML != nil {
		d.DescriptionHTML = sanitizeDescription(*in.DescriptionHTML)
	}
	if in.Status != nil {
		d.Status = *in.Status
	}
	if in.RiskNote != nil {
		d.RiskNote = *in.RiskNote
	}
	if in.Icons != nil {
		d.Icons = slices.Compact(sortedCopy(*in.Icons))
	}
	if in.WorkstreamIDs != nil {
		d.WorkstreamIDs = slices.Clone(*in.WorkstreamIDs)
	}
	if in.Links != nil {
		d.Links = applyLinks(*in.Links)
	}
}

func sortedCopy(s []string) []string { c := slices.Clone(s); slices.Sort(c); return c }

func runeLen(s string) int { return utf8.RuneCountInString(s) }

// validate checks every rule that needs no database (REQ_DAT_010, 011, 013, 014) and normalizes.
func (d *Deliverable) validate() error {
	f := map[string]string{}
	name, err := cleanName("name", d.Name)
	if err != nil {
		f["name"] = err.(*Error).Fields["name"]
	}
	d.Name = name
	for field, v := range map[string]string{"start_date": d.StartDate, "end_date": d.EndDate} {
		switch {
		case v == "":
			f[field] = "required"
		case !validDate(v):
			f[field] = "must be a date like 2026-09-21"
		}
	}
	if f["start_date"] == "" && f["end_date"] == "" && d.EndDate < d.StartDate {
		f["end_date"] = "must not be before start_date"
	}
	if !colorRe.MatchString(d.Color) {
		f["color"] = "must be a color like #3b82f6"
	}
	if !slices.Contains(statuses, d.Status) {
		f["status"] = "must be one of planned, in_progress, done, at_risk"
	}
	if d.Status != "at_risk" {
		d.RiskNote = "" // REQ_DAT_011
	}
	if runeLen(d.ResponsiblePerson) > maxResponsiblePerson {
		f["responsible_person"] = fmt.Sprintf("must be at most %d characters", maxResponsiblePerson)
	}
	if runeLen(d.RiskNote) > maxRiskNote {
		f["risk_note"] = fmt.Sprintf("must be at most %d characters", maxRiskNote)
	}
	if len(d.DescriptionHTML) > maxDescriptionBytes {
		f["description_html"] = fmt.Sprintf("must be at most %d bytes after cleaning", maxDescriptionBytes)
	}
	if len(d.Icons) > maxIcons {
		f["icons"] = fmt.Sprintf("at most %d icons", maxIcons)
	}
	for _, k := range d.Icons {
		if !iconKeyRe.MatchString(k) {
			f["icons"] = "invalid icon key " + k
		} else if _, ok := iconDefaults[k]; !ok {
			// REQ_FE_080: only the fixed set of 20 keys is valid — the regex above is just the cheap
			// shape check, this is the real membership check.
			f["icons"] = "invalid icon key " + k
		}
	}
	if msg := validateLinks(d.Links); msg != "" {
		f["links"] = msg
	}
	if len(d.WorkstreamIDs) == 0 {
		f["workstream_ids"] = "a deliverable needs at least one workstream"
	}
	if len(f) > 0 {
		return invalid("Deliverable is not valid", f)
	}
	return nil
}

// checkWorkstreams requires every id to be a workstream of the roadmap, and drops duplicates.
func checkWorkstreams(ctx context.Context, q querier, roadmapID int64, ids []int64) ([]int64, error) {
	var out []int64
	for _, id := range ids {
		var n int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM workstreams WHERE id=? AND roadmap_id=?`, id, roadmapID).Scan(&n); err != nil {
			return nil, err
		}
		if n == 0 {
			slog.WarnContext(ctx, "store: workstream_ids refused, not a workstream of this roadmap", "roadmap_id", roadmapID, "workstream_id", id)
			return nil, invalid1("workstream_ids", fmt.Sprintf("workstream %d is not in this roadmap", id))
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

func writeIcons(ctx context.Context, q querier, id int64, icons []string) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM deliverable_icons WHERE deliverable_id=?`, id); err != nil {
		return err
	}
	for _, k := range icons {
		if _, err := q.ExecContext(ctx, `INSERT INTO deliverable_icons(deliverable_id, icon_key) VALUES (?,?)`, id, k); err != nil {
			return err
		}
	}
	return nil
}

// writeLinks replaces the links of one roadmap item, a deliverable or a milestone (REQ_DAT_014, REQ_DAT_031).
func writeLinks(ctx context.Context, q querier, kind string, id int64, links []Link) error {
	if err := deleteLinks(ctx, q, kind, id); err != nil {
		return err
	}
	for i, l := range links {
		if _, err := q.ExecContext(ctx, `INSERT INTO roadmap_item_links(item_kind, item_id, label, url, position) VALUES (?,?,?,?,?)`, kind, id, l.Label, l.URL, i); err != nil {
			return err
		}
	}
	return nil
}

// deleteLinks removes a roadmap item's links. roadmap_item_links has no foreign key (the target table
// depends on the kind), so every delete of an item does this in its own transaction (REQ_DAT_031).
func deleteLinks(ctx context.Context, q querier, kind string, id int64) error {
	_, err := q.ExecContext(ctx, `DELETE FROM roadmap_item_links WHERE item_kind=? AND item_id=?`, kind, id)
	return err
}

// applyLinks turns the links a request sent into the stored shape: trimmed, positioned in the order sent.
func applyLinks(in []LinkInput) []Link {
	var out []Link
	for i, l := range in {
		out = append(out, Link{Label: TrimName(l.Label), URL: strings.TrimSpace(l.URL), Position: i})
	}
	return out
}

// validateLinks checks the link rules shared by both kinds of roadmap item (REQ_DAT_014) and returns
// the field errors to add under "links" (empty when fine).
func validateLinks(links []Link) string {
	var msg string
	if len(links) > maxLinks {
		msg = fmt.Sprintf("at most %d links", maxLinks)
	}
	for i, l := range links {
		if runeLen(l.Label) > maxLinkLabel {
			msg = fmt.Sprintf("link %d: label must be at most %d characters", i+1, maxLinkLabel)
		}
		if runeLen(l.URL) > maxLinkURL {
			msg = fmt.Sprintf("link %d: url must be at most %d characters", i+1, maxLinkURL)
		}
		u, err := url.Parse(l.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			msg = fmt.Sprintf("link %d: url must be an http or https address", i+1)
		}
	}
	return msg
}

// DeliverableCreate also returns the roadmap's title and its team's name, read inside the same
// transaction as the insert (REQ_AUD_003).
func DeliverableCreate(ctx context.Context, db *sql.DB, roadmapID int64, in DeliverableInput) (out Deliverable, title, team string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var d Deliverable
		err := tx.QueryRowContext(ctx, `SELECT t.default_color FROM roadmaps r JOIN teams t ON t.id=r.team_id WHERE r.id=?`, roadmapID).Scan(&d.Color)
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("roadmap", roadmapID)
		} else if err != nil {
			return err
		}
		if in.Color == nil {
			slog.DebugContext(ctx, "store: deliverable color defaults to the team color", "color", d.Color)
		}
		d.RoadmapID, d.Status = roadmapID, "planned"
		in.apply(&d)
		if err := d.validate(); err != nil {
			return err
		}
		if d.WorkstreamIDs, err = checkWorkstreams(ctx, tx, roadmapID, d.WorkstreamIDs); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO deliverables(roadmap_id, name, start_date, end_date, color, responsible_person, description_html, status, risk_note)
		  VALUES (?,?,?,?,?,?,?,?,?)`, roadmapID, d.Name, d.StartDate, d.EndDate, d.Color, d.ResponsiblePerson, d.DescriptionHTML, d.Status, d.RiskNote)
		if err != nil {
			return err
		}
		d.ID, _ = res.LastInsertId()
		for _, w := range d.WorkstreamIDs {
			if err := addMembership(ctx, tx, d.ID, w); err != nil {
				return err
			}
		}
		if in.Rows != nil {
			if err := setRows(ctx, tx, d.ID, d.WorkstreamIDs, *in.Rows); err != nil {
				return err
			}
			// Rows the server picked are free; explicit ones are checked (REQ_API_051).
			if err := checkRowOverlap(ctx, tx, ItemRef{KindDeliverable, d.ID}, d.WorkstreamIDs); err != nil {
				return err
			}
		}
		if err := writeIcons(ctx, tx, d.ID, d.Icons); err != nil {
			return err
		}
		if err := writeLinks(ctx, tx, KindDeliverable, d.ID, d.Links); err != nil {
			return err
		}
		if err := refreshRange(ctx, tx, roadmapID, true); err != nil {
			return err
		}
		if out, err = DeliverableGet(ctx, tx, d.ID); err != nil {
			return err
		}
		title, team, err = RoadmapNames(ctx, tx, roadmapID)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: deliverable created", "deliverable_id", out.ID, "roadmap_id", roadmapID, "name", out.Name)
	}
	return
}

// DeliverableUpdate applies a partial update and returns the deliverable before and after. A request
// that changes nothing issues no UPDATE and leaves updated_at untouched (REQ_AUD_001's "a request
// that changes nothing writes no entry" implies the row itself must look unchanged too). It also
// returns the roadmap's title, its team's name, and every workstream name the audit diff might need
// (before's and after's workstream ids, keyed by id) — all read inside the same transaction as the
// update (REQ_AUD_003).
func DeliverableUpdate(ctx context.Context, db *sql.DB, id int64, in DeliverableInput) (before, after Deliverable, title, team string, wsNames map[int64]string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if before, err = DeliverableGet(ctx, tx, id); err != nil {
			return err
		}
		d := before
		in.apply(&d)
		if err := d.validate(); err != nil {
			return err
		}
		if in.WorkstreamIDs != nil {
			if d.WorkstreamIDs, err = checkWorkstreams(ctx, tx, d.RoadmapID, d.WorkstreamIDs); err != nil {
				return err
			}
		}
		if d.StartDate != before.StartDate || d.EndDate != before.EndDate {
			// REQ_DEP_004: refuse dates that break a dependency, for edges in both directions.
			if err := checkDependencyDates(ctx, tx, ItemRef{KindDeliverable, id}, d.Name, d.StartDate, d.EndDate); err != nil {
				return err
			}
		}
		simpleChanged := d.Name != before.Name || d.StartDate != before.StartDate || d.EndDate != before.EndDate ||
			d.Color != before.Color || d.ResponsiblePerson != before.ResponsiblePerson || d.DescriptionHTML != before.DescriptionHTML ||
			d.Status != before.Status || d.RiskNote != before.RiskNote
		if simpleChanged {
			if _, err := tx.ExecContext(ctx, `UPDATE deliverables SET name=?, start_date=?, end_date=?, color=?, responsible_person=?,
			  description_html=?, status=?, risk_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
				d.Name, d.StartDate, d.EndDate, d.Color, d.ResponsiblePerson, d.DescriptionHTML, d.Status, d.RiskNote, id); err != nil {
				return err
			}
		}
		if in.WorkstreamIDs != nil {
			// Keep the memberships that stay (and their position/row), drop the others, append the new
			// ones (placed by the free-row rule, REQ_DAT_026).
			for _, w := range before.WorkstreamIDs {
				if !slices.Contains(d.WorkstreamIDs, w) {
					if _, err := tx.ExecContext(ctx, `DELETE FROM deliverable_workstreams WHERE deliverable_id=? AND workstream_id=?`, id, w); err != nil {
						return err
					}
				}
			}
			for _, w := range d.WorkstreamIDs {
				if err := addMembership(ctx, tx, id, w); err != nil {
					return err
				}
			}
		}
		if in.Rows != nil {
			if err := setRows(ctx, tx, id, d.WorkstreamIDs, *in.Rows); err != nil {
				return err
			}
		}
		if in.Icons != nil {
			if err := writeIcons(ctx, tx, id, d.Icons); err != nil {
				return err
			}
		}
		if in.Links != nil && !slices.Equal(LinkPairs(d.Links), LinkPairs(before.Links)) { // same rule as a milestone (REQ_DAT_014)
			if err := writeLinks(ctx, tx, KindDeliverable, id, d.Links); err != nil {
				return err
			}
		}
		if d.StartDate != before.StartDate || d.EndDate != before.EndDate {
			if err := refreshRange(ctx, tx, d.RoadmapID, true); err != nil {
				return err
			}
		}
		if after, err = DeliverableGet(ctx, tx, id); err != nil {
			return err
		}
		if err := checkRowOverlap(ctx, tx, ItemRef{KindDeliverable, id}, placesChanged(before, after)); err != nil { // REQ_API_051
			return err
		}
		if title, team, err = RoadmapNames(ctx, tx, after.RoadmapID); err != nil {
			return err
		}
		ids := append(append([]int64{}, before.WorkstreamIDs...), after.WorkstreamIDs...)
		wsNames, err = workstreamNamesByID(ctx, tx, ids)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: deliverable updated", "deliverable_id", id)
	}
	return
}

// placesChanged lists the workstreams where the deliverable's place differs after a change: all of them
// when its days moved, else those it newly joined or whose row changed. Only these are checked for
// overlap (REQ_API_051), so a change elsewhere is never refused over an old overlap it didn't cause.
func placesChanged(before, after Deliverable) []int64 {
	if before.StartDate != after.StartDate || before.EndDate != after.EndDate {
		return after.WorkstreamIDs
	}
	var out []int64
	for _, m := range after.Workstreams {
		if !slices.Contains(before.Workstreams, m) {
			out = append(out, m.ID)
		}
	}
	return out
}

// DeliverableDelete removes the deliverable; its dependencies (to deliverables and milestones), links,
// icons and memberships go with it. removed names every dependency taken (both ends' names and teams,
// REQ_AUD_003, REQ_DEP_029), so the caller's audit entry can say what disappeared instead of a count.
// DeliverableDelete also returns the roadmap's title and its team's name, read inside the same
// transaction as the delete (REQ_AUD_003).
func DeliverableDelete(ctx context.Context, db *sql.DB, id int64) (d Deliverable, removed []RemovedDependency, title, team string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if d, err = DeliverableGet(ctx, tx, id); err != nil {
			return err
		}
		if title, team, err = RoadmapNames(ctx, tx, d.RoadmapID); err != nil {
			return err
		}
		if removed, err = removeItemEdges(ctx, tx, ItemRef{KindDeliverable, id}); err != nil {
			return err
		}
		if err := deleteLinks(ctx, tx, KindDeliverable, id); err != nil { // no foreign key (REQ_DAT_031)
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM deliverables WHERE id=?`, id); err != nil {
			return err
		}
		return refreshRange(ctx, tx, d.RoadmapID, false)
	})
	if err == nil {
		slog.InfoContext(ctx, "store: deliverable deleted", "deliverable_id", id, "name", d.Name, "dependencies_removed", len(removed))
	}
	return
}
