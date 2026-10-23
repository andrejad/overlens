package store

import (
	"cmp"
	"context"
	"database/sql"
	"log/slog"
	"slices"
	"strings"
	"time"
)

// The attention list (REQ_API_054, REQ_API_055): the roadmap items of every team that are overdue, at
// risk, due soon or without an owner, each with the roadmap items that wait on it.

// Attention signals, in the order AttentionItem.Signals lists them.
const (
	SignalOverdue = "overdue"
	SignalAtRisk  = "at_risk"
	SignalDueSoon = "due_soon"
	SignalNoOwner = "no_owner"
	statusDone    = "done"
	statusPlanned = "planned"
	statusAtRisk  = "at_risk"
)

// FlatItem is a deliverable or a milestone with where it lives, so a caller can treat both alike. For a
// milestone StartDate and EndDate are both its date; Workstreams are names, a deliverable's primary first.
type FlatItem struct {
	Kind, Name                        string
	ID                                int64
	TeamID                            int64
	TeamTag, TeamName                 string
	RoadmapID                         int64
	RoadmapTitle                      string
	Workstreams                       []string
	ResponsiblePerson                 string
	StartDate, EndDate                string
	Status, RiskNote, DescriptionHTML string
	Links                             []Link
}

// Ref is the item's kind and id.
func (f FlatItem) Ref() ItemRef { return ItemRef{f.Kind, f.ID} }

// FlattenCompany lists every deliverable and milestone of the company bands: all deliverables, then all
// milestones, each band after band in the given order.
func FlattenCompany(teams []CompanyTeam) []FlatItem {
	out := []FlatItem{}
	for _, ct := range teams {
		rm := ct.Roadmap
		wsName := map[int64]string{}
		for _, w := range rm.Workstreams {
			wsName[w.ID] = w.Name
		}
		base := FlatItem{TeamID: ct.Team.ID, TeamTag: ct.Team.Tag, TeamName: ct.Team.Name, RoadmapID: rm.ID, RoadmapTitle: rm.Title}
		for _, d := range rm.Deliverables {
			f := base
			f.Kind, f.ID, f.Name = KindDeliverable, d.ID, d.Name
			f.Workstreams = []string{}
			for _, id := range d.WorkstreamIDs { // already primary first
				f.Workstreams = append(f.Workstreams, wsName[id])
			}
			f.ResponsiblePerson, f.StartDate, f.EndDate = d.ResponsiblePerson, d.StartDate, d.EndDate
			f.Status, f.RiskNote, f.DescriptionHTML, f.Links = d.Status, d.RiskNote, d.DescriptionHTML, d.Links
			out = append(out, f)
		}
		for _, m := range rm.Milestones {
			f := base
			f.Kind, f.ID, f.Name = KindMilestone, m.ID, m.Name
			f.Workstreams = []string{wsName[m.WorkstreamID]}
			f.ResponsiblePerson, f.StartDate, f.EndDate = m.ResponsiblePerson, m.Date, m.Date
			f.Status, f.RiskNote, f.DescriptionHTML, f.Links = m.Status, m.RiskNote, m.DescriptionHTML, m.Links
			out = append(out, f)
		}
	}
	return out
}

// BlockedItem is a roadmap item that depends, directly or through a chain, on an attention item.
type BlockedItem struct {
	Kind              string `json:"kind"`
	ID                int64  `json:"id"`
	Name              string `json:"name"`
	TeamID            int64  `json:"team_id"`
	TeamTag           string `json:"team_tag"`
	RoadmapID         int64  `json:"roadmap_id"`
	ResponsiblePerson string `json:"responsible_person"`
	StartDate         string `json:"start_date"`
	EndDate           string `json:"end_date"`
}

// AttentionItem is one roadmap item that needs someone's attention, with its reasons and what it blocks.
type AttentionItem struct {
	Kind              string        `json:"kind"`
	ID                int64         `json:"id"`
	Name              string        `json:"name"`
	TeamID            int64         `json:"team_id"`
	TeamTag           string        `json:"team_tag"`
	TeamName          string        `json:"team_name"`
	RoadmapID         int64         `json:"roadmap_id"`
	RoadmapTitle      string        `json:"roadmap_title"`
	Workstreams       []string      `json:"workstreams"`
	ResponsiblePerson string        `json:"responsible_person"`
	StartDate         string        `json:"start_date"`
	EndDate           string        `json:"end_date"`
	Status            string        `json:"status"`
	RiskNote          string        `json:"risk_note"`
	Signals           []string      `json:"signals"`
	Blocks            []BlockedItem `json:"blocks"`
}

// signalsOf returns the attention signals of an item (empty when it needs none). dueLimit is today
// plus the days window; all three are YYYY-MM-DD, so they compare as strings.
func signalsOf(f FlatItem, today, dueLimit string) []string {
	out := []string{}
	if f.EndDate < today && f.Status != statusDone {
		out = append(out, SignalOverdue)
	}
	if f.Status == statusAtRisk {
		out = append(out, SignalAtRisk)
	}
	if f.Status == statusPlanned && f.EndDate >= today && f.EndDate <= dueLimit {
		out = append(out, SignalDueSoon)
	}
	if TrimName(f.ResponsiblePerson) == "" && f.Status != statusDone {
		out = append(out, SignalNoOwner)
	}
	return out
}

// cmpTagFold orders by team tag ignoring case, the order every attention list uses.
func cmpTagFold(a, b string) int { return strings.Compare(foldName(a), foldName(b)) }

// CompanySnapshot is everything the company view reads, from one transaction: the bands, their roadmap
// items flattened, and every dependency edge. The attention list and the trace are computed from it in memory.
type CompanySnapshot struct {
	Teams []CompanyTeam
	Items []FlatItem
	Edges []CompanyEdge
}

// CompanySnapshotGet reads the company once (one transaction, one read per table).
func CompanySnapshotGet(ctx context.Context, db *sql.DB) (snap CompanySnapshot, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		snap.Teams, snap.Edges, err = companyRoadmapsTx(ctx, tx)
		return err
	})
	snap.Items = FlattenCompany(snap.Teams)
	return snap, err
}

// CompanyAttention returns the attention list as of today (YYYY-MM-DD, the server's local date) for
// every team, or for one team when teamID is not 0 (an unknown team is a not-found error). days is the
// due-soon window. Ordered by end date, team tag (ignoring case), name, id. The company is read once in
// one transaction and the dependency edges are walked in memory, so the statement count does not grow
// with the data (REQ_API_054, REQ_API_055).
func CompanyAttention(ctx context.Context, db *sql.DB, today string, days int, teamID int64) ([]AttentionItem, error) {
	snap, err := CompanySnapshotGet(ctx, db)
	if err != nil {
		return nil, err
	}
	return snap.Attention(ctx, today, days, teamID)
}

// Attention is CompanyAttention on a snapshot already read.
func (snap CompanySnapshot) Attention(ctx context.Context, today string, days int, teamID int64) ([]AttentionItem, error) {
	t, err := time.Parse(dateLayout, today)
	if err != nil {
		return nil, invalid1("today", "must be a date YYYY-MM-DD")
	}
	if teamID != 0 && !slices.ContainsFunc(snap.Teams, func(ct CompanyTeam) bool { return ct.Team.ID == teamID }) {
		return nil, notFound("team", teamID)
	}
	dueLimit := t.AddDate(0, 0, days).Format(dateLayout)
	out := []AttentionItem{}
	byRef := make(map[ItemRef]FlatItem, len(snap.Items))
	for _, f := range snap.Items {
		byRef[f.Ref()] = f
	}
	down := map[ItemRef][]ItemRef{} // prerequisite -> its direct dependents
	for _, e := range snap.Edges {
		from := ItemRef{e.FromKind, e.FromID}
		down[from] = append(down[from], ItemRef{e.ToKind, e.ToID})
	}
	for _, f := range snap.Items {
		if teamID != 0 && f.TeamID != teamID {
			continue
		}
		sig := signalsOf(f, today, dueLimit)
		if len(sig) == 0 {
			continue
		}
		blocks := []BlockedItem{}
		for _, ref := range reach(down, f.Ref()) {
			b := byRef[ref]
			blocks = append(blocks, BlockedItem{Kind: b.Kind, ID: b.ID, Name: b.Name, TeamID: b.TeamID, TeamTag: b.TeamTag,
				RoadmapID: b.RoadmapID, ResponsiblePerson: b.ResponsiblePerson, StartDate: b.StartDate, EndDate: b.EndDate})
		}
		slices.SortFunc(blocks, func(a, b BlockedItem) int {
			return cmp.Or(strings.Compare(a.StartDate, b.StartDate), cmpTagFold(a.TeamTag, b.TeamTag),
				strings.Compare(a.Kind, b.Kind), cmp.Compare(a.ID, b.ID))
		})
		out = append(out, AttentionItem{Kind: f.Kind, ID: f.ID, Name: f.Name, TeamID: f.TeamID, TeamTag: f.TeamTag, TeamName: f.TeamName,
			RoadmapID: f.RoadmapID, RoadmapTitle: f.RoadmapTitle, Workstreams: f.Workstreams, ResponsiblePerson: f.ResponsiblePerson,
			StartDate: f.StartDate, EndDate: f.EndDate, Status: f.Status, RiskNote: f.RiskNote, Signals: sig, Blocks: blocks})
	}
	slices.SortFunc(out, func(a, b AttentionItem) int {
		return cmp.Or(strings.Compare(a.EndDate, b.EndDate), cmpTagFold(a.TeamTag, b.TeamTag),
			strings.Compare(a.Name, b.Name), cmp.Compare(a.ID, b.ID), strings.Compare(a.Kind, b.Kind))
	})
	slog.DebugContext(ctx, "store: attention list", "today", today, "days", days, "team_id", teamID, "items", len(out))
	return out, nil
}

// Trace is CompanyTraceItem on a snapshot already read; an item that is not in it is a not-found error.
func (snap CompanySnapshot) Trace(root ItemRef) (TypedTrace, error) {
	if !slices.ContainsFunc(snap.Items, func(f FlatItem) bool { return f.Ref() == root }) {
		return TypedTrace{}, notFound(root.Kind, root.ID)
	}
	return traceFromEdges(root, snap.Edges), nil
}
