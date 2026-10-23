package main

// `roadmap -dev-data <file> [--reset]` (REQ_DEMO_016-018): loads the development company into the
// development database, then exits. It never starts the server.

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	erm "github.com/andrejad/overlens"
	"github.com/andrejad/overlens/internal/config"
	"github.com/andrejad/overlens/internal/logging"
	"github.com/andrejad/overlens/internal/store"
)

// devDataScratch reports whether a database path lies in the test scratch folder (REQ_DEMO_018):
// under $ERM_RUN_DIR (made by `make test` / `make t`) or inside any erm-test-* / erm-run-* folder.
// A variable so the tests of the loading itself, which necessarily run under a scratch folder, can
// switch it off; the refusal test uses the real one.
var devDataScratch = isScratchPath

func isScratchPath(path string, getenv func(string) string) bool {
	p := filepath.Clean(path)
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	if d := getenv("ERM_RUN_DIR"); d != "" {
		if rel, err := filepath.Rel(filepath.Clean(d), p); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	for _, part := range strings.Split(filepath.ToSlash(p), "/") {
		if strings.HasPrefix(part, "erm-test-") || strings.HasPrefix(part, "erm-run-") {
			return true
		}
	}
	return false
}

// wipeTables are emptied by --reset, children before parents. Users, sessions and the icon labels
// are kept: the dev admin can still log in, and the labels are settings, not roadmap data.
var wipeTables = []string{
	"dependencies", "deliverable_icons", "roadmap_item_links", "deliverable_workstreams", "deliverables",
	"milestones", "workstreams", "company_team_order", "company_workstream_order", "roadmaps", "teams", "audit_log", "meta",
}

func count(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, table string) (n int, err error) {
	err = q.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&n)
	return
}

func runDevData(ctx context.Context, confPath, file string, reset bool, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	cfg, err := config.Load(confPath, getenv)
	if err != nil {
		failConfig(confPath, getenv, err, stderr)
		return 1
	}
	closeLog, err := logging.Setup(cfg.LogDir, getenv("LOG_PREFIX"), cfg.LogLevel, io.Discard)
	if err != nil {
		fmt.Fprintln(stderr, "ERROR cannot set up logging:", err)
		return 1
	}
	defer closeLog()
	refuse := func(why string, args ...any) int {
		msg := fmt.Sprintf(why, args...)
		slog.Error("dev-data refused", "reason", msg, "db_path", cfg.DBPath)
		fmt.Fprintln(stderr, "ERROR dev-data refused: "+msg)
		return 1
	}
	slog.Info("dev-data: started", "file", file, "reset", reset, "environment", cfg.Environment, "db_path", cfg.DBPath)

	if cfg.Environment != "development" {
		return refuse("the environment is %q; set `environment: development` in the development config", cfg.Environment)
	}
	if devDataScratch(cfg.DBPath, getenv) {
		return refuse("the database %s is under the test scratch folder; dev data never goes there", cfg.DBPath)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return refuse("cannot read %s: %v", file, err)
	}
	cf, err := store.ParseCompanyFile(data)
	if err != nil {
		return refuse("%s is not a valid company file: %v", file, err)
	}

	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
		return refuse("cannot create the database folder: %v", err)
	}
	db, err := store.Open(cfg.DBPath)
	if err == nil {
		err = store.Converge(db, erm.Schema)
	}
	if err != nil {
		slog.Error("dev-data: cannot open database", "path", cfg.DBPath, "err", err)
		fmt.Fprintln(stderr, "ERROR cannot open the database:", err)
		return 1
	}
	defer db.Close()

	teams, err := count(ctx, db, "teams")
	if err != nil {
		fmt.Fprintln(stderr, "ERROR", err)
		return 1
	}
	if teams > 0 && !reset {
		return refuse("the database already has %d team(s); `--reset` wipes it first (it asks before deleting)", teams)
	}
	if reset && !confirmReset(ctx, db, cfg.DBPath, stdin, stdout) {
		slog.Warn("dev-data: reset not confirmed, nothing was deleted")
		fmt.Fprintln(stderr, "ERROR not confirmed (the word is `yes`); nothing was deleted")
		return 1
	}

	var res store.CompanyResult
	err = store.InTx(ctx, db, func(tx *sql.Tx) error {
		if reset {
			for _, t := range wipeTables {
				if _, err := tx.ExecContext(ctx, `DELETE FROM `+t); err != nil {
					return err
				}
			}
			slog.Warn("dev-data: database wiped", "tables", wipeTables)
		}
		var err error
		res, err = store.ImportCompanyTx(ctx, tx, cf, time.Now())
		return err
	})
	if err != nil {
		slog.Error("dev-data: load failed, nothing was changed", "err", err)
		fmt.Fprintln(stderr, "ERROR the file was not loaded and nothing was changed:", err)
		return 1
	}
	slog.Info("dev-data: loaded", "teams", res.Teams, "roadmaps", res.Roadmaps, "counts", res.Counts)
	fmt.Fprintf(stdout, "Loaded %d teams, %d roadmaps, %d workstreams, %d deliverables, %d milestones, %d dependencies.\n",
		res.Teams, res.Roadmaps, res.Counts.Workstreams, res.Counts.Deliverables, res.Counts.Milestones, res.Counts.Dependencies)
	return 0
}

// confirmReset prints what --reset will delete and waits for the word yes.
func confirmReset(ctx context.Context, db *sql.DB, path string, stdin io.Reader, stdout io.Writer) bool {
	fmt.Fprintf(stdout, "--reset will delete all of this from %s:\n", path)
	for _, t := range []struct{ label, table string }{
		{"teams", "teams"}, {"roadmaps", "roadmaps"}, {"workstreams", "workstreams"}, {"deliverables", "deliverables"},
		{"milestones", "milestones"}, {"dependencies", "dependencies"}, {"audit log entries", "audit_log"},
	} {
		n, err := count(ctx, db, t.table)
		if err != nil {
			n = -1
		}
		fmt.Fprintf(stdout, "  %6d %s\n", n, t.label)
	}
	fmt.Fprintln(stdout, "Users, sessions and icon labels are kept.")
	fmt.Fprint(stdout, "Type yes to continue: ")
	line, _ := bufio.NewReader(stdin).ReadString('\n')
	return strings.TrimSpace(line) == "yes"
}
