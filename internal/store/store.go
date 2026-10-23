// Package store holds the database access functions. Phase 0b: only what the test builders need.
// Phase 1 replaces the schema and grows this package; builders keep calling these entry points.
package store

import (
	"database/sql"
	"fmt"
	"log/slog"
	"strings"

	_ "modernc.org/sqlite"
)

// sqliteDSN builds a modernc.org/sqlite DSN for path. The DSN is passed through as a "file:" URI
// with SQLITE_OPEN_URI set, so SQLite's own URI parser reads it: an unescaped '?' would start the
// query early, an unescaped '#' would start a fragment, and an unescaped '%' would be misread as the
// start of a percent-escape — so a db_path containing any of those (a valid filename character on
// Windows and Linux alike) would silently corrupt the path or drop part of it. '%' is escaped first,
// so escaping '?' and '#' doesn't itself introduce more '%' characters to re-escape.
func sqliteDSN(path string) string {
	esc := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(path)
	return "file:" + esc + "?_pragma=foreign_keys(1)"
}

// Open opens the SQLite file at path with foreign keys on.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		slog.Error("store: open failed", "err", err)
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// Converge brings db up to schema.sql. It only ever adds (CREATE ... IF NOT EXISTS, ALTER TABLE ADD
// COLUMN); it never drops or recreates a table. Missing columns are added first, so an index in
// schema.sql that names a new column can be created afterwards.
//
// ADD COLUMN limits (see schema.sql): a NOT NULL column is only added NOT NULL when it has a
// constant default; a non-constant default such as CURRENT_TIMESTAMP is dropped and the column is
// nullable; CHECK, REFERENCES and COLLATE are not carried over to an added column.
func Converge(db *sql.DB, schema string) error {
	slog.Info("store: converging schema")
	// A scratch in-memory copy of schema.sql is the reference for what every table should have.
	ref, err := sql.Open("sqlite", "file::memory:")
	if err != nil {
		return fmt.Errorf("converge: %w", err)
	}
	defer ref.Close()
	ref.SetMaxOpenConns(1)
	if _, err := ref.Exec(schema); err != nil {
		slog.Error("store: converge reference schema failed", "err", err)
		return fmt.Errorf("converge: %w", err)
	}
	tables, err := tableNames(ref)
	if err != nil {
		return err
	}
	for _, tab := range tables {
		want, err := columns(ref, tab)
		if err != nil {
			return err
		}
		have, err := columns(db, tab)
		if err != nil {
			return err
		}
		has := map[string]bool{}
		for _, c := range have {
			has[c.name] = true
		}
		for _, c := range want {
			if len(have) == 0 || has[c.name] { // table absent: the schema below creates it whole
				continue
			}
			def := c.name + " " + c.typ
			constDefault := c.dflt.Valid && !strings.HasPrefix(strings.ToUpper(c.dflt.String), "CURRENT_") &&
				!strings.HasPrefix(c.dflt.String, "(")
			if constDefault {
				def += " DEFAULT " + c.dflt.String
				if c.notnull { // NOT NULL is only legal on ADD COLUMN with a constant default
					def += " NOT NULL"
				}
			} else if c.dflt.Valid || c.notnull {
				slog.Warn("store: added column is nullable without default (SQLite ADD COLUMN limit)", "table", tab, "column", c.name)
			}
			slog.Info("store: adding missing column", "table", tab, "column", c.name)
			if _, err := db.Exec("ALTER TABLE " + tab + " ADD COLUMN " + def); err != nil {
				slog.Error("store: add column failed", "table", tab, "column", c.name, "err", err)
				return fmt.Errorf("converge: add %s.%s: %w", tab, c.name, err)
			}
		}
	}
	if _, err := db.Exec(schema); err != nil {
		slog.Error("store: converge failed", "err", err)
		return fmt.Errorf("converge: %w", err)
	}
	return nil
}

type column struct {
	name, typ string
	notnull   bool
	dflt      sql.NullString
}

func tableNames(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

func columns(db *sql.DB, tab string) ([]column, error) {
	rows, err := db.Query(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)`, tab)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []column
	for rows.Next() {
		var c column
		if err := rows.Scan(&c.name, &c.typ, &c.notnull, &c.dflt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
