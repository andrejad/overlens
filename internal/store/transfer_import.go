package store

// The company-file loader (REQ_IMP_006). A file is first checked in memory against the same rules as
// the other endpoints (Deliverable.validate, cleanName, validTeam, the 3-year span), then written in the
// caller's transaction; dependencies are added through dependencyAddTx, so the date-order and loop rules
// are the ones POST .../dependencies uses. Any problem fails the whole load (all or nothing).

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"time"
)

type ImportCounts struct {
	Workstreams  int `json:"workstreams"`
	Deliverables int `json:"deliverables"`
	Milestones   int `json:"milestones"`
	Dependencies int `json:"dependencies"`
}

// ---- the in-memory plan ----------------------------------------------------------------------

type planDel struct {
	d    Deliverable // validated and normalised; WorkstreamIDs are placeholders
	ws   []string    // canonical workstream names, in file order
	rows []int
}

type planMs struct {
	name, date, ws, desc string
	row                  int
	details              Milestone // owner, status, risk note and links, already validated
}

type planDep struct {
	i        int
	from, to FileEnd
}

type bodyPlan struct {
	prefix      string
	workstreams []string
	dels        []planDel
	mss         []planMs
	deps        []planDep
	keys        map[string]int // deliverable key -> index in dels
	msKeys      map[string]int // milestone key -> index in mss
}

var deliverableFieldPath = map[string]string{
	"responsible_person": "responsible", "description_html": "description", "workstream_ids": "workstreams",
}

type span struct{ start, end, label, path string }

// planBody checks one roadmap's content against every rule that needs no database and returns what
// to write. Problems go to p, with paths under prefix; the plan is only usable when p is still empty.
func planBody(b *RoadmapBody, defaultColor, prefix string, p *problems) *bodyPlan {
	pl := &bodyPlan{prefix: prefix, keys: map[string]int{}, msKeys: map[string]int{}}
	reg := map[string]string{} // wsKey -> canonical spelling
	register := func(name string) string {
		k := wsKey(name)
		if c, ok := reg[k]; ok {
			return c
		}
		reg[k] = name
		pl.workstreams = append(pl.workstreams, name)
		return name
	}
	for i, w := range b.Workstreams {
		path := fmt.Sprintf("%sworkstreams[%d].name", prefix, i)
		name, err := cleanName("name", w.Name)
		if err != nil {
			p.add(path, "%s", err.(*Error).Fields["name"])
		} else if _, dup := reg[wsKey(name)]; dup {
			p.add(path, "%q appears more than once (names are compared ignoring case)", name)
		} else {
			register(name)
		}
	}

	allKeys := map[string]string{} // kind + key -> path; keys are unique per kind
	claim := func(kind, key, path string) {
		if key == "" {
			return
		}
		if prev, dup := allKeys[kind+"\x00"+key]; dup {
			p.add(path, "the key %q is already used at %s", key, prev)
		} else {
			allKeys[kind+"\x00"+key] = path
		}
	}

	var spans = map[string][]span{} // "workstream#row" -> occupied date ranges
	var lo, hi string
	widen := func(a, z string) {
		if lo == "" || a < lo {
			lo = a
		}
		if hi == "" || z > hi {
			hi = z
		}
	}
	// The same no-overlap test as every other write (rowItem.overlaps, REQ_API_051), on the file's rows.
	place := func(ws string, row int, s span, rowPath string) {
		k := fmt.Sprintf("%s#%d", wsKey(ws), row)
		me := rowItem{row: row, start: s.start, end: s.end}
		for _, o := range spans[k] {
			if me.overlaps(rowItem{row: row, start: o.start, end: o.end}) {
				slog.Info("store: company file refused, row overlap", "path", rowPath, "workstream", ws, "row", row)
				p.add(rowPath, "overlaps %s in workstream %q, row %d", o.label, ws, row)
				return
			}
		}
		spans[k] = append(spans[k], s)
	}

	for i, fd := range b.Deliverables {
		path := fmt.Sprintf("%sdeliverables[%d]", prefix, i)
		claim(KindDeliverable, fd.Key, path+".key")
		d := Deliverable{
			Name: fd.Name, StartDate: fd.StartDate.Text, EndDate: fd.EndDate.Text,
			ResponsiblePerson: fd.Responsible, DescriptionHTML: sanitizeDescription(fd.Description),
			Status: fd.Status, RiskNote: fd.RiskNote, Icons: slices.Compact(sortedCopy(fd.Icons)),
		}
		if d.Status == "" {
			d.Status = "planned"
		}
		if fd.Color != nil && *fd.Color != "" {
			d.Color = *fd.Color
		} else {
			d.Color = defaultColor
		}
		for j, l := range fd.Links {
			d.Links = append(d.Links, Link{Label: TrimName(l.Label), URL: strings.TrimSpace(l.URL), Position: j})
		}
		var names []string
		var rows []int
		inDel := map[string]bool{} // wsKey -> already listed for this deliverable
		for j, m := range fd.Workstreams {
			mpath := fmt.Sprintf("%s.workstreams[%d]", path, j)
			name, err := cleanName("name", m.Name)
			switch {
			case err != nil:
				p.add(mpath+".name", "%s", err.(*Error).Fields["name"])
			case inDel[wsKey(name)]:
				p.add(mpath+".name", "%q is listed twice for this deliverable", name)
			case m.Row < 0:
				p.add(mpath+".row", "must not be negative")
			default:
				inDel[wsKey(name)] = true
				names = append(names, register(name))
				rows = append(rows, m.Row)
				d.WorkstreamIDs = append(d.WorkstreamIDs, int64(len(names)))
			}
		}
		verr := d.validate()
		if se, ok := verr.(*Error); ok {
			keys := make([]string, 0, len(se.Fields))
			for k := range se.Fields {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				field := k
				if m, ok := deliverableFieldPath[k]; ok {
					field = m
				}
				p.add(path+"."+field, "%s", se.Fields[k])
			}
		}
		if verr == nil {
			widen(d.StartDate, d.EndDate)
			for j, name := range names {
				place(name, rows[j], span{d.StartDate, d.EndDate, fmt.Sprintf("%q", d.Name), path},
					fmt.Sprintf("%s.workstreams[%d].row", path, j))
			}
		}
		if fd.Key != "" {
			pl.keys[fd.Key] = len(pl.dels)
		}
		pl.dels = append(pl.dels, planDel{d: d, ws: names, rows: rows})
	}

	for i, fm := range b.Milestones {
		path := fmt.Sprintf("%smilestones[%d]", prefix, i)
		claim(KindMilestone, fm.Key, path+".key")
		name, err := cleanName("name", fm.Name)
		if err != nil {
			p.add(path+".name", "%s", err.(*Error).Fields["name"])
		}
		ws, werr := cleanName("workstream", fm.Workstream)
		if werr != nil {
			p.add(path+".workstream", "%s", werr.(*Error).Fields["workstream"])
		}
		if fm.Row < 0 {
			p.add(path+".row", "must not be negative")
		}
		switch {
		case fm.Date.Text == "":
			p.add(path+".date", "required")
		case !validDate(fm.Date.Text):
			p.add(path+".date", "must be a date like 2026-09-21")
		}
		desc, derr := cleanMilestoneDescription(fm.Description)
		if derr != nil {
			p.add(path+".description", "%s", derr.(*Error).Fields["description_html"])
		}
		// owner, status, risk note and links are optional; the rules are a deliverable's
		details := Milestone{ResponsiblePerson: fm.Responsible, Status: fm.Status, RiskNote: fm.RiskNote}
		if details.Status == "" {
			details.Status = "planned"
		}
		for j, l := range fm.Links {
			details.Links = append(details.Links, Link{Label: TrimName(l.Label), URL: strings.TrimSpace(l.URL), Position: j})
		}
		verr := details.validate()
		if se, ok := verr.(*Error); ok {
			keys := make([]string, 0, len(se.Fields))
			for k := range se.Fields {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				field := k
				if m, ok := deliverableFieldPath[k]; ok {
					field = m
				}
				p.add(path+"."+field, "%s", se.Fields[k])
			}
		}
		if err == nil && werr == nil && derr == nil && verr == nil && fm.Row >= 0 && validDate(fm.Date.Text) {
			ws = register(ws)
			widen(fm.Date.Text, fm.Date.Text)
			place(ws, fm.Row, span{fm.Date.Text, fm.Date.Text, fmt.Sprintf("the milestone %q", name), path}, path+".row")
			if fm.Key != "" {
				pl.msKeys[fm.Key] = len(pl.mss)
			}
			pl.mss = append(pl.mss, planMs{name: name, date: fm.Date.Text, ws: ws, row: fm.Row, desc: desc, details: details})
		}
	}

	if lo != "" && exceedsSpan(lo, hi) { // REQ_DAT_015
		p.add(prefix+"roadmap", "its dates run from %s to %s, more than the 3-year maximum", lo, hi)
	}

	for i, dep := range b.Dependencies {
		path := fmt.Sprintf("%sdependencies[%d]", prefix, i)
		okEnds := true
		check := func(e FileEnd, side string) {
			switch {
			case e.External != nil:
				x := e.External
				for field, v := range map[string]string{"team": x.Team, "name": x.Name} {
					if TrimName(v) == "" {
						p.add(path+"."+side+".external."+field, "required")
						okEnds = false
					}
				}
				switch {
				case x.Kind != "" && !ValidKind(x.Kind):
					p.add(path+"."+side+".external.kind", "must be deliverable or milestone")
					okEnds = false
				}
			case e.Key == "":
				p.add(path+"."+side, "needs a deliverable key, a milestone key or an external end")
				okEnds = false
			case e.Milestone:
				if _, ok := pl.msKeys[e.Key]; !ok {
					p.add(path+"."+side, "no milestone has the key %q", e.Key)
					okEnds = false
				}
			default:
				if _, ok := pl.keys[e.Key]; !ok {
					p.add(path+"."+side, "no deliverable has the key %q", e.Key)
					okEnds = false
				}
			}
		}
		check(dep.From, "from")
		check(dep.To, "to")
		if okEnds && dep.From.External != nil && dep.To.External != nil {
			p.add(path, "at least one end must be a deliverable of this roadmap")
			okEnds = false
		}
		if okEnds {
			pl.deps = append(pl.deps, planDep{i: i, from: dep.From, to: dep.To})
		}
	}
	return pl
}

// ---- writing a plan --------------------------------------------------------------------------

type pendingExt struct {
	path      string
	rmID      int64
	local     ItemRef
	ext       FileExternal
	localIsTo bool // the local item is the dependent (the external one is the prerequisite)
}

// write inserts the plan into roadmap rmID. Dependencies between its own deliverables are added at
// once; external ends are returned to be resolved by the caller (REQ_IMP_003).
func (pl *bodyPlan) write(ctx context.Context, tx *sql.Tx, rmID int64, p *problems) (ImportCounts, []pendingExt, error) {
	var c ImportCounts
	wsID := map[string]int64{}
	for _, name := range pl.workstreams {
		id, err := appendWorkstream(ctx, tx, rmID, name)
		if err != nil {
			return c, nil, err
		}
		wsID[wsKey(name)] = id
		c.Workstreams++
	}
	if c.Workstreams == 0 { // REQ_DAT_023: a roadmap always has a workstream
		if _, err := appendWorkstream(ctx, tx, rmID, "General"); err != nil {
			return c, nil, err
		}
		c.Workstreams++
	}
	delID := make([]int64, len(pl.dels))
	for i, pd := range pl.dels {
		d := pd.d
		res, err := tx.ExecContext(ctx, `INSERT INTO deliverables(roadmap_id, name, start_date, end_date, color, responsible_person, description_html, status, risk_note)
		  VALUES (?,?,?,?,?,?,?,?,?)`, rmID, d.Name, d.StartDate, d.EndDate, d.Color, d.ResponsiblePerson, d.DescriptionHTML, d.Status, d.RiskNote)
		if err != nil {
			return c, nil, err
		}
		delID[i], _ = res.LastInsertId()
		for j, name := range pd.ws {
			w := wsID[wsKey(name)]
			if _, err := tx.ExecContext(ctx, `INSERT INTO deliverable_workstreams(deliverable_id, workstream_id, row) VALUES (?,?,?)`,
				delID[i], w, pd.rows[j]); err != nil {
				return c, nil, err
			}
		}
		if err := writeIcons(ctx, tx, delID[i], d.Icons); err != nil {
			return c, nil, err
		}
		if err := writeLinks(ctx, tx, KindDeliverable, delID[i], d.Links); err != nil {
			return c, nil, err
		}
		c.Deliverables++
	}
	msID := make([]int64, len(pl.mss))
	for i, m := range pl.mss {
		res, err := tx.ExecContext(ctx, `INSERT INTO milestones(roadmap_id, workstream_id, name, date, row, description_html, responsible_person, status, risk_note) VALUES (?,?,?,?,?,?,?,?,?)`,
			rmID, wsID[wsKey(m.ws)], m.name, m.date, m.row, m.desc, m.details.ResponsiblePerson, m.details.Status, m.details.RiskNote)
		if err != nil {
			return c, nil, err
		}
		msID[i], _ = res.LastInsertId()
		if err := writeLinks(ctx, tx, KindMilestone, msID[i], m.details.Links); err != nil {
			return c, nil, err
		}
		c.Milestones++
	}
	if err := refreshRange(ctx, tx, rmID, false); err != nil {
		return c, nil, err
	}

	local := func(e FileEnd) ItemRef { // the item a local end names
		if e.Milestone {
			return ItemRef{KindMilestone, msID[pl.msKeys[e.Key]]}
		}
		return ItemRef{KindDeliverable, delID[pl.keys[e.Key]]}
	}
	var pend []pendingExt
	for _, dep := range pl.deps {
		path := fmt.Sprintf("%sdependencies[%d]", pl.prefix, dep.i)
		switch {
		case dep.from.External != nil:
			pend = append(pend, pendingExt{path: path, rmID: rmID, local: local(dep.to), ext: *dep.from.External, localIsTo: true})
		case dep.to.External != nil:
			pend = append(pend, pendingExt{path: path, rmID: rmID, local: local(dep.from), ext: *dep.to.External})
		default:
			created, err := addEdge(ctx, tx, local(dep.to), local(dep.from), path, p)
			if err != nil {
				return c, nil, err
			}
			if created {
				c.Dependencies++
			}
		}
	}
	return c, pend, nil
}

// addEdge adds from -> to through the store's own rule check. A rule violation becomes a problem at
// path; only a real database error is returned.
func addEdge(ctx context.Context, tx *sql.Tx, to, from ItemRef, path string, p *problems) (bool, error) {
	var res DependencyResult
	if err := dependencyAddTx(ctx, tx, to, from, "from_id", &res); err != nil {
		if se, ok := err.(*Error); ok {
			p.add(path, "%s", se.Msg)
			return false, nil
		}
		return false, err
	}
	return res.Created, nil
}

// resolveExternal turns each external end into a dependency when exactly one item (a deliverable, or a
// milestone when the end says so) on another team's roadmap matches its team and name (ignoring case);
// otherwise the load fails with the edge's path (REQ_IMP_003).
func resolveExternal(ctx context.Context, tx *sql.Tx, pend []pendingExt, p *problems) (created int, err error) {
	for _, pe := range pend {
		var ids []int64
		extKind, table := KindDeliverable, "deliverables"
		if pe.ext.Kind == KindMilestone {
			extKind, table = KindMilestone, "milestones"
		}
		err = collect(ctx, tx, `SELECT d.id FROM `+table+` d JOIN roadmaps r ON r.id=d.roadmap_id JOIN teams t ON t.id=r.team_id
		  WHERE t.name=? COLLATE NOCASE AND d.name=? COLLATE NOCASE AND r.id<>? LIMIT 2`,
			[]any{TrimName(pe.ext.Team), TrimName(pe.ext.Name), pe.rmID}, func(s scanner) error {
				var id int64
				if err := s.Scan(&id); err != nil {
					return err
				}
				ids = append(ids, id)
				return nil
			})
		if err != nil {
			return
		}
		if len(ids) != 1 {
			why := "no " + extKind + " matches"
			if len(ids) > 1 {
				why = "more than one " + extKind + " matches"
			}
			p.add(pe.path, "%s %q on the roadmap of team %q", why, pe.ext.Name, pe.ext.Team)
			slog.WarnContext(ctx, "store: company file dependency end not resolved", "path", pe.path, "matches", len(ids))
			continue
		}
		from, to := ItemRef{extKind, ids[0]}, pe.local
		if !pe.localIsTo {
			from, to = pe.local, ItemRef{extKind, ids[0]}
		}
		ok, aerr := addEdge(ctx, tx, to, from, pe.path, p)
		if aerr != nil {
			return created, aerr
		}
		if ok {
			created++
		}
	}
	return
}

// teamProblems maps a validTeam failure onto paths in the file.
func teamProblems(err error, prefix string, p *problems) {
	se, ok := err.(*Error)
	if !ok {
		return
	}
	keys := make([]string, 0, len(se.Fields))
	for k := range se.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		p.add(prefix+"."+k, "%s", se.Fields[k])
	}
}

// ---- the company file ------------------------------------------------------------------------

type CompanyResult struct {
	Teams, Roadmaps int
	Counts          ImportCounts
}

// ImportCompanyTx loads a company file inside the caller's transaction (the sample start-up writes its
// meta row in the same one). Each team is created with its one roadmap (REQ_DAT_032), and external
// dependency ends are resolved once every roadmap exists.
func ImportCompanyTx(ctx context.Context, tx *sql.Tx, f *CompanyFile, today time.Time) (CompanyResult, error) {
	var res CompanyResult
	if today.IsZero() {
		today = time.Now()
	}
	var p problems
	dates := checkDatesMode(f.Dates, f.Anchor, &p)
	type planned struct {
		team  Team
		plan  *bodyPlan
		title string
	}
	var plans []planned
	for ti := range f.Teams {
		tf := &f.Teams[ti]
		tp := fmt.Sprintf("teams[%d]", ti)
		t := Team{Name: tf.Team.Name, Tag: tf.Team.Tag, DefaultColor: tf.Team.DefaultColor}
		if t.DefaultColor == "" {
			t.DefaultColor = "#3b82f6"
		}
		if verr := validTeam(&t); verr != nil {
			teamProblems(verr, tp+".team", &p)
		}
		b := &tf.Roadmap
		prefix := tp + ".roadmap."
		b.resolveDates(prefix, dates, today, &p)
		title, err := cleanName("title", b.Title)
		if err != nil {
			p.add(prefix+"title", "%s", err.(*Error).Fields["title"])
		}
		plans = append(plans, planned{team: t, plan: planBody(b, t.DefaultColor, prefix, &p), title: title})
	}
	if p.any() {
		slog.WarnContext(ctx, "store: company file refused, it breaks the rules", "problems", len(p.list)+p.more)
		return res, p.err()
	}

	var pend []pendingExt
	teamID := map[string]int64{}
	for ti, pt := range plans {
		if err := checkTeamUnique(ctx, tx, 0, pt.team.Name, pt.team.Tag); err != nil {
			return res, err
		}
		r, err := tx.ExecContext(ctx, `INSERT INTO teams(name, tag, default_color) VALUES (?,?,?)`, pt.team.Name, pt.team.Tag, pt.team.DefaultColor)
		if err != nil {
			return res, err
		}
		tid, _ := r.LastInsertId()
		teamID[wsKey(pt.team.Name)] = tid
		res.Teams++
		r, err = tx.ExecContext(ctx, `INSERT INTO roadmaps(team_id, title) VALUES (?,?)`, tid, pt.title)
		if err != nil {
			return res, err
		}
		rmID, _ := r.LastInsertId()
		c, pe, err := pt.plan.write(ctx, tx, rmID, &p)
		if err != nil {
			return res, err
		}
		pend = append(pend, pe...)
		res.Roadmaps++
		res.Counts.Workstreams += c.Workstreams
		res.Counts.Deliverables += c.Deliverables
		res.Counts.Milestones += c.Milestones
		res.Counts.Dependencies += c.Dependencies
		slog.InfoContext(ctx, "store: company roadmap loaded", "team", pt.team.Name, "roadmap", pt.title, "path", fmt.Sprintf("teams[%d].roadmap", ti))
	}
	created, err := resolveExternal(ctx, tx, pend, &p)
	if err != nil {
		return res, err
	}
	res.Counts.Dependencies += created

	// the saved company orders (REQ_IMP_006)
	var ids []int64
	for i, n := range f.TeamOrder {
		id, ok := teamID[wsKey(n)]
		if !ok {
			p.add(fmt.Sprintf("team_order[%d]", i), "no team named %q in this file", n)
			continue
		}
		ids = append(ids, id)
	}
	seen := map[string]bool{}
	var wsNames []string
	for i, n := range f.WorkstreamOrder {
		c, err := cleanName("name", n)
		switch {
		case err != nil:
			p.add(fmt.Sprintf("workstream_order[%d]", i), "%s", err.(*Error).Fields["name"])
		case seen[foldName(c)]:
			p.add(fmt.Sprintf("workstream_order[%d]", i), "%q appears more than once", c)
		default:
			seen[foldName(c)] = true
			wsNames = append(wsNames, c)
		}
	}
	if p.any() {
		slog.WarnContext(ctx, "store: company file refused", "problems", len(p.list)+p.more)
		return res, p.err()
	}
	for i, id := range ids {
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO company_team_order(team_id, position) VALUES (?,?)`, id, i); err != nil {
			return res, err
		}
	}
	for i, n := range wsNames {
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO company_workstream_order(workstream_name, position) VALUES (?,?)`, n, i); err != nil {
			return res, err
		}
	}
	slog.InfoContext(ctx, "store: company file loaded", "teams", res.Teams, "roadmaps", res.Roadmaps, "counts", res.Counts)
	return res, nil
}

// InTx runs fn in one transaction on db; used by internal/demo to keep its guard, import and meta row
// together.
func InTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) error { return inTx(ctx, db, fn) }
