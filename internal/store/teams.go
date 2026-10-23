package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
)

var tagRe = regexp.MustCompile(`^[A-Z]{2,4}$`)

type Team struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Tag          string `json:"tag"`
	DefaultColor string `json:"default_color"`
	RoadmapID    int64  `json:"roadmap_id"` // the team's one roadmap (REQ_DAT_032)
	CreatedAt    string `json:"created_at"`
}

// TeamInput: any field may be absent on PATCH; create needs name and tag.
type TeamInput struct {
	Name         *string `json:"name"`
	Tag          *string `json:"tag"`
	DefaultColor *string `json:"default_color"`
}

const teamCols = `id, name, tag, default_color, created_at, (SELECT r.id FROM roadmaps r WHERE r.team_id=teams.id)`

func scanTeam(s interface{ Scan(...any) error }) (Team, error) {
	var t Team
	var rid sql.NullInt64
	err := s.Scan(&t.ID, &t.Name, &t.Tag, &t.DefaultColor, &t.CreatedAt, &rid)
	t.CreatedAt, t.RoadmapID = ts(t.CreatedAt), rid.Int64
	return t, err
}

func TeamGet(ctx context.Context, q querier, id int64) (Team, error) {
	t, err := scanTeam(q.QueryRowContext(ctx, `SELECT `+teamCols+` FROM teams WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, notFound("team", id)
	}
	return t, err
}

func TeamsList(ctx context.Context, db *sql.DB, limit, offset int) ([]Team, int, error) {
	var total int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM teams`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.QueryContext(ctx, `SELECT `+teamCols+` FROM teams ORDER BY name LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Team
	for rows.Next() {
		t, err := scanTeam(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, t)
	}
	return listPage(out), total, rows.Err()
}

// checkTeamUnique refuses a name or tag another team already has (ignoring case).
func checkTeamUnique(ctx context.Context, q querier, id int64, name, tag string) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM teams WHERE name=? AND id<>?`, name, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		slog.InfoContext(ctx, "store: duplicate team name refused", "name", name)
		return conflict("duplicate_name", "A team named \""+name+"\" already exists")
	}
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM teams WHERE tag=? AND id<>?`, tag, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		slog.InfoContext(ctx, "store: duplicate team tag refused", "tag", tag)
		return conflict("duplicate_tag", "The tag "+tag+" is already used by another team")
	}
	return nil
}

func validTeam(t *Team) error {
	fields := map[string]string{}
	name, err := cleanName("name", t.Name)
	if err != nil {
		fields["name"] = err.(*Error).Fields["name"]
	}
	t.Name = name
	t.Tag = TrimName(t.Tag) // REQ_DAT_028: the tag is trimmed like every name
	if !tagRe.MatchString(t.Tag) {
		fields["tag"] = "must be 2 to 4 capital letters"
	}
	if !colorRe.MatchString(t.DefaultColor) {
		fields["default_color"] = "must be a color like #3b82f6"
	}
	if len(fields) > 0 {
		return invalid("Team is not valid", fields)
	}
	return nil
}

func TeamCreate(ctx context.Context, db *sql.DB, in TeamInput) (Team, error) {
	t := Team{DefaultColor: "#3b82f6"}
	if in.Name != nil {
		t.Name = *in.Name
	}
	if in.Tag != nil {
		t.Tag = *in.Tag
	}
	if in.DefaultColor != nil {
		t.DefaultColor = *in.DefaultColor
	}
	if err := validTeam(&t); err != nil {
		return t, err
	}
	err := inTx(ctx, db, func(tx *sql.Tx) error {
		if err := checkTeamUnique(ctx, tx, 0, t.Name, t.Tag); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO teams(name, tag, default_color) VALUES (?,?,?)`, t.Name, t.Tag, t.DefaultColor)
		if err != nil {
			return err
		}
		t.ID, _ = res.LastInsertId()
		// REQ_DAT_032: the team's one roadmap is created with it, titled with the team's name.
		_, err = roadmapCreate(ctx, tx, t.ID, t.Name)
		return err
	})
	if err != nil {
		return t, err
	}
	slog.InfoContext(ctx, "store: team created with its roadmap", "team_id", t.ID, "name", t.Name, "tag", t.Tag)
	return TeamGet(ctx, db, t.ID)
}

// TeamUpdate returns the team before and after, and a changed default colour never recolors existing deliverables (REQ_DAT_018).
func TeamUpdate(ctx context.Context, db *sql.DB, id int64, in TeamInput) (before, after Team, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if before, err = TeamGet(ctx, tx, id); err != nil {
			return err
		}
		after = before
		if in.Name != nil {
			after.Name = *in.Name
		}
		if in.Tag != nil {
			after.Tag = *in.Tag
		}
		if in.DefaultColor != nil {
			after.DefaultColor = *in.DefaultColor
		}
		if err := validTeam(&after); err != nil {
			return err
		}
		if err := checkTeamUnique(ctx, tx, id, after.Name, after.Tag); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE teams SET name=?, tag=?, default_color=? WHERE id=?`,
			after.Name, after.Tag, after.DefaultColor, id); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return
	}
	slog.InfoContext(ctx, "store: team updated", "team_id", id)
	return
}

// TeamDelete removes the team with its roadmap and that roadmap's workstreams in one transaction,
// refused with 409 has_roadmap_items while the roadmap holds any deliverable or milestone (REQ_DAT_020,
// REQ_API_010). An empty roadmap has no links or dependencies, so nothing else goes with it.
// It also returns the roadmap's title for the audit entry (REQ_AUD_003).
func TeamDelete(ctx context.Context, db *sql.DB, id int64) (t Team, roadmap string, err error) {
	err = inTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		if t, err = TeamGet(ctx, tx, id); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT title FROM roadmaps WHERE id=?`, t.RoadmapID).Scan(&roadmap); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM deliverables WHERE roadmap_id=?) + (SELECT COUNT(*) FROM milestones WHERE roadmap_id=?)`,
			t.RoadmapID, t.RoadmapID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			slog.InfoContext(ctx, "store: team delete refused, its roadmap holds roadmap items", "team_id", id, "items", n)
			return conflict("has_roadmap_items", fmt.Sprintf(
				"This team's roadmap still holds %d roadmap item(s); move or delete them first", n))
		}
		for _, q := range []string{
			`DELETE FROM workstreams WHERE roadmap_id=?`,
			`DELETE FROM roadmaps WHERE id=?`} {
			if _, err := tx.ExecContext(ctx, q, t.RoadmapID); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM teams WHERE id=?`, id)
		return err
	})
	if err == nil {
		slog.InfoContext(ctx, "store: team deleted with its roadmap", "team_id", id, "name", t.Name, "roadmap_id", t.RoadmapID)
	}
	return
}
