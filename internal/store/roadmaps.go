package store

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
)

type Roadmap struct {
	ID         int64   `json:"id"`
	TeamID     int64   `json:"team_id"`
	Title      string  `json:"title"`
	RangeStart *string `json:"range_start"`
	RangeEnd   *string `json:"range_end"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

type Milestone struct {
	ID              int64  `json:"id"`
	RoadmapID       int64  `json:"roadmap_id"`
	WorkstreamID    int64  `json:"workstream_id"`
	Name            string `json:"name"`
	Date            string `json:"date"`
	Row             int    `json:"row"`              // stored, stacked row inside its workstream (REQ_DAT_026)
	DescriptionHTML string `json:"description_html"` // cleaned rich text, "" by default (REQ_DAT_029)
	// Owner, status, risk note and links, exactly as on a deliverable (REQ_DAT_030, REQ_DAT_014).
	ResponsiblePerson string `json:"responsible_person"`
	Status            string `json:"status"`
	RiskNote          string `json:"risk_note"`
	Links             []Link `json:"links"`
}

// RoadmapFull's Team block is the Phase 3 timeline's one-call answer to "whose roadmap is this and
// what's its color" (a client would otherwise need a second GET /api/teams/{id}).
type RoadmapFull struct {
	Roadmap
	Team         Team          `json:"team"`
	Workstreams  []Workstream  `json:"workstreams"`
	Deliverables []Deliverable `json:"deliverables"`
	Milestones   []Milestone   `json:"milestones"`
	// Dependencies: every edge with either end in this roadmap (REQ_DEP_001, REQ_DEP_012).
	Dependencies []RoadmapDependency `json:"dependencies"`
}

const roadmapCols = `id, team_id, title, range_start, range_end, created_at, updated_at`

func scanRoadmap(s interface{ Scan(...any) error }) (Roadmap, error) {
	var r Roadmap
	var rs, re sql.NullString
	err := s.Scan(&r.ID, &r.TeamID, &r.Title, &rs, &re, &r.CreatedAt, &r.UpdatedAt)
	if rs.Valid {
		r.RangeStart = &rs.String
	}
	if re.Valid {
		r.RangeEnd = &re.String
	}
	r.CreatedAt, r.UpdatedAt = ts(r.CreatedAt), ts(r.UpdatedAt)
	return r, err
}

func RoadmapGet(ctx context.Context, q querier, id int64) (Roadmap, error) {
	r, err := scanRoadmap(q.QueryRowContext(ctx, `SELECT `+roadmapCols+` FROM roadmaps WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return r, notFound("roadmap", id)
	}
	return r, err
}

// RoadmapNames returns the roadmap's title and its team's name (for audit details).
func RoadmapNames(ctx context.Context, q querier, id int64) (title, team string, err error) {
	err = q.QueryRowContext(ctx, `SELECT r.title, t.name FROM roadmaps r JOIN teams t ON t.id=r.team_id WHERE r.id=?`, id).Scan(&title, &team)
	if errors.Is(err, sql.ErrNoRows) {
		err = notFound("roadmap", id)
	}
	return
}

// roadmapCreate adds the team's one roadmap (REQ_DAT_032) with its "General" workstream (REQ_DAT_023)
// inside the caller's transaction; TeamCreate calls it (the company-file loader inserts its roadmaps itself).
// The UNIQUE team_id refuses a second roadmap for the same team.
func roadmapCreate(ctx context.Context, tx *sql.Tx, teamID int64, title string) (int64, error) {
	res, err := tx.ExecContext(ctx, `INSERT INTO roadmaps(team_id, title) VALUES (?,?)`, teamID, title)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	slog.InfoContext(ctx, "store: roadmap created with its team, adding General", "team_id", teamID, "roadmap_id", id)
	if _, err := appendWorkstream(ctx, tx, id, "General"); err != nil {
		return 0, err
	}
	return id, nil
}

// RoadmapRename changes the roadmap's own title (REQ_FE_001). It also returns the team's name, read
// inside the same transaction as the rename (REQ_AUD_003).
func RoadmapRename(ctx context.Context, db *sql.DB, id int64, title string) (before, after Roadmap, team string, err error) {
	title, err = cleanName("title", title)
	if err != nil {
		return
	}
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if before, err = RoadmapGet(ctx, tx, id); err != nil {
			return err
		}
		if before.Title == title { // no-op: no UPDATE, no updated_at bump, no audit entry upstream
			slog.InfoContext(ctx, "store: roadmap rename is a no-op, title unchanged", "roadmap_id", id)
			after = before
		} else {
			if _, err = tx.ExecContext(ctx, `UPDATE roadmaps SET title=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, title, id); err != nil {
				return err
			}
			if after, err = RoadmapGet(ctx, tx, id); err != nil {
				return err
			}
		}
		_, team, err = RoadmapNames(ctx, tx, id)
		return err
	})
	return
}

func RoadmapFullGet(ctx context.Context, db *sql.DB, id int64) (f RoadmapFull, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) (err error) { // one transaction: a consistent snapshot
		f, err = roadmapFullGetTx(ctx, tx, id)
		return err
	})
	return f, err
}

// roadmapFullGetTx is RoadmapFullGet inside the caller's transaction (the company view reads many
// roadmaps in one).
func roadmapFullGetTx(ctx context.Context, tx *sql.Tx, id int64) (RoadmapFull, error) {
	var f RoadmapFull
	err := func() error {
		var err error
		if f.Roadmap, err = RoadmapGet(ctx, tx, id); err != nil {
			return err
		}
		if f.Team, err = TeamGet(ctx, tx, f.Roadmap.TeamID); err != nil {
			return err
		}
		if f.Workstreams, err = workstreamsOf(ctx, tx, id); err != nil {
			return err
		}
		if f.Deliverables, err = deliverablesWhere(ctx, tx, "d.roadmap_id=?", id); err != nil {
			return err
		}
		if f.Milestones, err = milestonesWhere(ctx, tx, "m.roadmap_id=?", id); err != nil {
			return err
		}
		f.Dependencies, err = roadmapDependencies(ctx, tx, id)
		return err
	}()
	return f, err
}
