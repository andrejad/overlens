package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sort"
)

// ExportRoadmap reads one roadmap for the CSV download (REQ_API_023). It
// reads one consistent snapshot. Ids never appear in the file; deliverables and milestones get
// file-local keys d1, d2, ... and m1, m2, ... in the order the file lists them.
func ExportRoadmap(ctx context.Context, db *sql.DB, id int64) (*RoadmapFile, error) {
	var f *RoadmapFile
	err := inTx(ctx, db, func(tx *sql.Tx) error {
		full, err := roadmapFullGetTx(ctx, tx, id)
		if err != nil {
			return err
		}
		f = &RoadmapFile{
			Team: TeamBlock{Name: full.Team.Name, Tag: full.Team.Tag, DefaultColor: full.Team.DefaultColor},
		}
		f.Title = full.Title
		f.Workstreams, f.Deliverables, f.Milestones, f.Dependencies = []FileWorkstream{}, []FileDeliverable{}, []FileMilestone{}, []FileDependency{}
		wsName := map[int64]string{}
		for _, w := range full.Workstreams {
			wsName[w.ID] = w.Name
			f.Workstreams = append(f.Workstreams, FileWorkstream{Name: w.Name})
		}
		key := map[int64]string{} // deliverable id -> key
		msKey := map[int64]string{}
		index := map[int64]int{} // deliverable id -> position; milestones follow the deliverables
		for i, d := range full.Deliverables {
			k := fmt.Sprintf("d%d", i+1)
			key[d.ID], index[d.ID] = k, i
			fd := FileDeliverable{
				Key: k, Name: d.Name, Description: d.DescriptionHTML, Responsible: d.ResponsiblePerson,
				StartDate: FileDate{Text: d.StartDate}, EndDate: FileDate{Text: d.EndDate},
				Status: d.Status, RiskNote: d.RiskNote, Workstreams: []FileMembership{},
				Icons: append([]string{}, d.Icons...), Links: []FileLink{},
			}
			color := d.Color
			fd.Color = &color
			for _, m := range d.Workstreams {
				fd.Workstreams = append(fd.Workstreams, FileMembership{Name: wsName[m.ID], Row: m.Row})
			}
			for _, l := range d.Links {
				fd.Links = append(fd.Links, FileLink{Label: l.Label, URL: l.URL})
			}
			f.Deliverables = append(f.Deliverables, fd)
		}
		msIndex := map[int64]int{}
		for i, m := range full.Milestones {
			k := fmt.Sprintf("m%d", i+1)
			msKey[m.ID], msIndex[m.ID] = k, len(full.Deliverables)+i
			fm := FileMilestone{Key: k, Name: m.Name,
				Date: FileDate{Text: m.Date}, Workstream: wsName[m.WorkstreamID], Row: m.Row, Description: m.DescriptionHTML,
				Responsible: m.ResponsiblePerson, Status: m.Status, RiskNote: m.RiskNote, Links: []FileLink{}}
			for _, l := range m.Links {
				fm.Links = append(fm.Links, FileLink{Label: l.Label, URL: l.URL})
			}
			f.Milestones = append(f.Milestones, fm)
		}

		// Edges: both ends local -> keys; the other end elsewhere -> an external end. Sorted by the
		// file's own order so the same roadmap always exports the same bytes after a round trip.
		end := func(e DepEnd) (FileEnd, error) {
			if e.RoadmapID == id {
				if e.Kind == KindMilestone {
					return FileEnd{Key: msKey[e.ID], Milestone: true}, nil
				}
				return FileEnd{Key: key[e.ID]}, nil
			}
			x := &FileExternal{Team: e.TeamName, Name: e.Name}
			if e.Kind == KindMilestone {
				x.Kind = KindMilestone
			}
			return FileEnd{External: x}, nil
		}
		type edge struct {
			dep      FileDependency
			sortKey  [2]string
			from, to int
		}
		var edges []edge
		for _, d := range full.Dependencies {
			from, err := end(d.From)
			if err != nil {
				return err
			}
			to, err := end(d.To)
			if err != nil {
				return err
			}
			e := edge{dep: FileDependency{From: from, To: to}, from: 1 << 30, to: 1 << 30}
			pos := func(e DepEnd) int {
				if e.Kind == KindMilestone {
					return msIndex[e.ID]
				}
				return index[e.ID]
			}
			if d.From.RoadmapID == id {
				e.from = pos(d.From)
			} else {
				e.sortKey[0] = d.From.TeamName + "\x00" + d.From.Kind + "\x00" + d.From.Name
			}
			if d.To.RoadmapID == id {
				e.to = pos(d.To)
			} else {
				e.sortKey[1] = d.To.TeamName + "\x00" + d.To.Kind + "\x00" + d.To.Name
			}
			edges = append(edges, e)
		}
		sort.SliceStable(edges, func(i, j int) bool {
			a, b := edges[i], edges[j]
			switch {
			case a.from != b.from:
				return a.from < b.from
			case a.sortKey[0] != b.sortKey[0]:
				return a.sortKey[0] < b.sortKey[0]
			case a.to != b.to:
				return a.to < b.to
			}
			return a.sortKey[1] < b.sortKey[1]
		})
		for _, e := range edges {
			f.Dependencies = append(f.Dependencies, e.dep)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "store: roadmap read for csv", "roadmap_id", id, "deliverables", len(f.Deliverables),
		"milestones", len(f.Milestones), "dependencies", len(f.Dependencies))
	return f, nil
}
