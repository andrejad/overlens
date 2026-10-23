package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const dateLayout = "2006-01-02"

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// querier is what *sql.DB and *sql.Tx share. The pool has one connection, so code inside a
// transaction must only ever use the tx, and rows must be closed before the next statement.
type querier interface {
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
}

func inTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	// The pool has one connection (see querier above): a panic mid-transaction that skipped the
	// rollback would leave every later request hanging forever. Roll back, log, then re-panic so
	// the caller still sees it — this never swallows the panic, it only frees the connection.
	defer func() {
		if p := recover(); p != nil {
			tx.Rollback()
			slog.ErrorContext(ctx, "store: panic inside transaction, rolled back", "panic", p)
			panic(p)
		}
	}()
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ts turns SQLite's CURRENT_TIMESTAMP ("2006-01-02 15:04:05", UTC) into RFC 3339.
func ts(s string) string {
	if t, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	return s
}

// maxNameLen is the length limit (in characters, not bytes) for names: teams, roadmap titles,
// workstreams, deliverables.
const maxNameLen = 200

// TrimName is the one server-side name trim (REQ_DAT_028): it removes Unicode White_Space characters,
// U+FEFF (byte-order mark) and U+200B (zero-width space) from both ends and leaves everything in the
// middle alone. The browser's trimName() must give the same answers (testdata/trim_cases.json).
func TrimName(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return unicode.Is(unicode.White_Space, r) || r == 0xFEFF || r == 0x200B
	})
}

// wsKey is how two workstream names of one roadmap are compared: trimmed, then ASCII case folded
// only. That is exactly what the API's duplicate check does (checkWorkstreamNameUnique: SQLite
// `name = ? COLLATE NOCASE`), so import accepts every set of names the API can create ("Équipe" and
// "équipe" are two workstreams to both). A test pins the two together.
func wsKey(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, TrimName(s))
}

func cleanName(field string, s string) (string, error) {
	s = TrimName(s)
	if s == "" {
		return "", invalid1(field, "required")
	}
	if utf8.RuneCountInString(s) > maxNameLen {
		return "", invalid1(field, fmt.Sprintf("must be at most %d characters", maxNameLen))
	}
	return s, nil
}

func validDate(s string) bool {
	t, err := time.Parse(dateLayout, s)
	return err == nil && t.Format(dateLayout) == s
}

// exceedsSpan reports whether end is more than 3 calendar years after start (REQ_DAT_015).
func exceedsSpan(start, end string) bool {
	s, e := mustDate(start), mustDate(end)
	return e.After(s.AddDate(3, 0, 0))
}

func mustDate(s string) time.Time { t, _ := time.Parse(dateLayout, s); return t }

// refreshRange recomputes the roadmap's derived range_start/range_end from its deliverables and
// milestones (REQ_DAT_009). With enforce, a range that passes 3 years is refused with 409
// span_exceeded unless it still lies inside the range the roadmap already had (REQ_API_014).
func refreshRange(ctx context.Context, q querier, roadmapID int64, enforce bool) error {
	var oldS, oldE, newS, newE sql.NullString
	if err := q.QueryRowContext(ctx, `SELECT range_start, range_end FROM roadmaps WHERE id=?`, roadmapID).Scan(&oldS, &oldE); err != nil {
		return err
	}
	if err := q.QueryRowContext(ctx, `SELECT MIN(a), MAX(b) FROM (
	  SELECT start_date a, end_date b FROM deliverables WHERE roadmap_id=?
	  UNION ALL SELECT date, date FROM milestones WHERE roadmap_id=?)`, roadmapID, roadmapID).Scan(&newS, &newE); err != nil {
		return err
	}
	if enforce && newS.Valid && exceedsSpan(newS.String, newE.String) {
		inside := oldS.Valid && newS.String >= oldS.String && newE.String <= oldE.String
		if !inside {
			slog.WarnContext(ctx, "store: 3-year span refused", "roadmap_id", roadmapID, "start", newS.String, "end", newE.String)
			return conflict("span_exceeded", fmt.Sprintf(
				"This change would make the roadmap run from %s to %s, which is more than the 3-year maximum", newS.String, newE.String))
		}
	}
	_, err := q.ExecContext(ctx, `UPDATE roadmaps SET range_start=?, range_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		newS, newE, roadmapID)
	if err == nil {
		slog.DebugContext(ctx, "store: roadmap range refreshed", "roadmap_id", roadmapID, "start", newS.String, "end", newE.String)
	}
	return err
}

func listPage[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}
