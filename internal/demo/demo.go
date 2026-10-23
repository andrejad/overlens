// Package demo holds the shipped sample company (REQ_DEMO_001-005) and the rule that creates it once,
// on the first start of an empty database. The sample is a company file (REQ_IMP_006), embedded in the
// binary and loaded through the real importer in internal/store.
package demo

import (
	"context"
	"database/sql"
	"embed"
	"log/slog"
	"time"

	"github.com/andrejad/overlens/internal/store"
)

// sampleFS holds sample.json. The glob (instead of the plain file name) plus the placeholder file
// beside it keep the package compiling while sample.json is not written yet; Sample reports it missing.
//
//go:embed sample.json
var sampleFS embed.FS

// SampleFile is the embedded file's name.
const SampleFile = "sample.json"

// MetaKey is the meta row that marks the sample as created, once and for all (REQ_DEMO_005/007).
const MetaKey = "sample_created"

// Sample returns the embedded sample file; ok is false when it is not there.
func Sample() (data []byte, ok bool) {
	b, err := sampleFS.ReadFile(SampleFile)
	return b, err == nil
}

// Recorder writes one audit entry as the system user (cmd/roadmap passes the audit writer).
type Recorder func(ctx context.Context, action string, details map[string]any) error

// EnsureSample creates the sample company when enabled and the database has no team, no roadmap and no
// `sample_created` meta row (REQ_DEMO_005). The import and the meta row are one transaction, so a failure
// leaves nothing behind and a success is never repeated, even after everything is deleted by hand
// (REQ_DEMO_007). Existing data is never touched. It reports whether it created the sample.
func EnsureSample(ctx context.Context, db *sql.DB, enabled bool, today time.Time, record Recorder) (bool, error) {
	data, ok := Sample()
	return ensure(ctx, db, enabled, today, data, ok, record)
}

// EnsureFrom is EnsureSample with the sample file's bytes passed in; cmd/roadmap's tests use it to
// start a server on a broken sample without touching the embedded file.
func EnsureFrom(ctx context.Context, db *sql.DB, enabled bool, today time.Time, data []byte, record Recorder) (bool, error) {
	return ensure(ctx, db, enabled, today, data, true, record)
}

// ensure is EnsureSample with the sample file passed in (the tests use their own small fixture).
func ensure(ctx context.Context, db *sql.DB, enabled bool, today time.Time, data []byte, haveData bool, record Recorder) (bool, error) {
	if !enabled {
		slog.InfoContext(ctx, "demo: sample data is switched off (sample_data: false)")
		return false, nil
	}
	var res store.CompanyResult
	created := false
	err := store.InTx(ctx, db, func(tx *sql.Tx) error {
		var marks, teams, roadmaps int
		if err := tx.QueryRowContext(ctx, `SELECT
		  (SELECT COUNT(*) FROM meta WHERE key=?), (SELECT COUNT(*) FROM teams), (SELECT COUNT(*) FROM roadmaps)`, MetaKey).
			Scan(&marks, &teams, &roadmaps); err != nil {
			return err
		}
		switch {
		case marks > 0:
			slog.InfoContext(ctx, "demo: sample not created, it was created before")
			return nil
		case teams > 0 || roadmaps > 0:
			slog.InfoContext(ctx, "demo: sample not created, the database already has data", "teams", teams, "roadmaps", roadmaps)
			return nil
		}
		if !haveData {
			slog.ErrorContext(ctx, "demo: sample_data is on but this build has no embedded "+SampleFile+"; nothing created")
			return nil
		}
		f, err := store.ParseCompanyFile(data)
		if err != nil {
			return err
		}
		if res, err = store.ImportCompanyTx(ctx, tx, f, today); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES (?,?)`, MetaKey, time.Now().UTC().Format(time.RFC3339)); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		slog.ErrorContext(ctx, "demo: creating the sample failed, nothing was written", "err", err)
		return false, err
	}
	if !created {
		return false, nil
	}
	slog.InfoContext(ctx, "demo: sample company created", "teams", res.Teams, "roadmaps", res.Roadmaps, "counts", res.Counts)
	if record != nil {
		if err := record(ctx, "sample.create", map[string]any{"teams": res.Teams, "roadmaps": res.Roadmaps,
			"workstreams": res.Counts.Workstreams, "deliverables": res.Counts.Deliverables,
			"milestones": res.Counts.Milestones, "dependencies": res.Counts.Dependencies}); err != nil {
			slog.ErrorContext(ctx, "demo: audit entry for the sample failed", "err", err)
		}
	}
	return true, nil
}
