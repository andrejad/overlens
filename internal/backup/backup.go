// Package backup runs the daily database backup, the pruning of old backups and the audit-log
// retention purge (REQ_AUD_004-006, 009-015), all from one scheduler goroutine inside the program.
//
// store.Open gives the database a single connection, so a VACUUM INTO holds it for as long as the
// copy takes; requests that arrive meanwhile wait in the pool (they do not fail or deadlock) and
// run as soon as it finishes. Nothing here can be triggered from the API (REQ_API_017).
package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/andrejad/overlens/internal/store"
)

// namePattern is the only kind of file this package ever lists or deletes (REQ_AUD_012).
var namePattern = regexp.MustCompile(`^overlens-(\d{4}-\d{2}-\d{2})\.db$`)

// Recorder writes one audit entry as the system user (REQ_AUD_014, 020). main.go adapts
// internal/audit's writer to it; a failure is only logged here.
type Recorder func(ctx context.Context, action string, details map[string]any) error

// Options are the config values plus the test seams.
type Options struct {
	Enabled       bool
	Dir           string
	Time          string // "HH:MM", server local time
	KeepDays      int
	RetentionDays int // audit_retention_days, 0 = keep forever
	Now           func() time.Time
	Record        Recorder
	PurgeBatch    int // rows per DELETE statement (default 500)
	// Ready, when set, is called once, after the start-up catch-up and the first "next run" line, so the caller can
	// show its start-up message after the scheduler's own lines (REQ_DEPLOY_017).
	Ready func()
}

// Service owns the daily job.
type Service struct {
	db *sql.DB
	o  Options
}

func New(db *sql.DB, o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Record == nil {
		o.Record = func(context.Context, string, map[string]any) error { return nil }
	}
	return &Service{db: db, o: o}
}

// Last is the most recent backup run.
type Last struct {
	At      string `json:"at"`
	Result  string `json:"result"` // ok | failed
	Message string `json:"message"`
}

// Item is one backup file on disk.
type Item struct {
	Name      string `json:"name"`
	Date      string `json:"date"`
	SizeBytes int64  `json:"size_bytes"`
}

// Status is the backup service's state, read by the tests; no endpoint reports it any more.
type Status struct {
	Enabled       bool    `json:"enabled"`
	BackupTime    string  `json:"backup_time"`
	NextRun       *string `json:"next_run"`
	Last          *Last   `json:"last"`
	RetentionDays int     `json:"retention_days"`
	KeepDays      int     `json:"keep_days"`
	Items         []Item  `json:"items"`
}

// NextRun is the next scheduled run strictly after now, in now's location.
func (s *Service) NextRun(now time.Time) time.Time {
	h, m := 4, 0
	if _, err := fmt.Sscanf(s.o.Time, "%d:%d", &h, &m); err != nil {
		h, m = 4, 0
	}
	t := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	if !t.After(now) {
		t = time.Date(now.Year(), now.Month(), now.Day()+1, h, m, 0, 0, now.Location())
	}
	return t
}

// Run is the scheduler: a catch-up at start, then one daily job at backup_time until ctx ends.
func (s *Service) Run(ctx context.Context) {
	slog.Info("backup: scheduler started", "enabled", s.o.Enabled, "time", s.o.Time, "dir", s.o.Dir,
		"keep_days", s.o.KeepDays, "audit_retention_days", s.o.RetentionDays)
	defer slog.Info("backup: scheduler stopped")
	s.CatchUp(ctx)
	ready := s.o.Ready
	for {
		now := s.o.Now()
		next := s.NextRun(now)
		slog.Info("backup: next run", "at", next.Format(time.RFC3339))
		if ready != nil {
			ready()
			ready = nil
		}
		timer := time.NewTimer(next.Sub(now))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			s.RunDaily(ctx)
		}
	}
}

// CatchUp runs today's job once when the app was off at backup_time: today's scheduled time has
// passed and today's backup file is missing (REQ_AUD_013). With backups off, the same applies to
// the retention purge (it has not run today).
func (s *Service) CatchUp(ctx context.Context) {
	now := s.o.Now()
	if !s.scheduledPassed(now) {
		slog.Info("backup: no catch-up needed, today's scheduled time has not passed")
		return
	}
	day := now.Format("2006-01-02")
	if s.o.Enabled {
		if _, err := os.Stat(filepath.Join(s.o.Dir, "overlens-"+day+".db")); err == nil {
			slog.Info("backup: no catch-up needed, today's backup exists", "day", day)
			return
		}
	} else if s.meta(ctx, "purge_last_date") == day {
		slog.Info("backup: no catch-up needed, today's purge already ran", "day", day)
		return
	}
	slog.Info("backup: catching up the missed daily job", "day", day)
	s.RunDaily(ctx)
}

func (s *Service) scheduledPassed(now time.Time) bool {
	// NextRun(now) is tomorrow's slot exactly when today's has passed.
	return s.NextRun(now).Day() != now.Day()
}

// RunDaily is the daily job: backup (when enabled), then the retention purge, which only runs
// when the backup succeeded or backups are off (REQ_AUD_004/005).
func (s *Service) RunDaily(ctx context.Context) {
	if s.o.Enabled {
		if !s.Backup(ctx) {
			slog.Warn("backup: failed, so the audit purge waits until the next day")
			return
		}
	} else {
		slog.Info("backup: backups are switched off, skipping the backup")
	}
	s.Purge(ctx)
}

// Backup makes today's backup and, only on success, prunes old ones. It reports success.
func (s *Service) Backup(ctx context.Context) bool {
	now := s.o.Now()
	day := now.Format("2006-01-02")
	name := "overlens-" + day + ".db"
	slog.Info("backup: starting", "file", name, "dir", s.o.Dir)
	size, err := s.snapshot(ctx, day, name)
	rctx := context.WithoutCancel(ctx) // the outcome is recorded even while shutting down
	if err != nil {
		if ctx.Err() != nil {
			slog.Warn("backup: interrupted by shutdown", "err", err)
			return false
		}
		slog.Error("backup: failed", "file", name, "err", err)
		s.setLast(rctx, now, "failed", err.Error())
		s.record(rctx, "backup.fail", map[string]any{"file": name, "error": err.Error()})
		return false
	}
	slog.Info("backup: done", "file", name, "size_bytes", size)
	s.setLast(rctx, now, "ok", fmt.Sprintf("%s, %d bytes", name, size))
	s.record(rctx, "backup.create", map[string]any{"file": name, "size_bytes": size})
	s.prune(rctx)
	return true
}

// stepFailed logs the full error (it may contain server paths, which belong in the log file only)
// and returns the short, path-free message that goes into the audit entry.
func stepFailed(what string, err error) error {
	slog.Error("backup: step failed", "step", what, "err", err)
	return errors.New("could not " + what)
}

// snapshot writes the consistent copy to a temp file, flushes it and renames it into place; a
// second run on the same day replaces that day's file (REQ_AUD_010/011). Its errors never contain
// a path: stepFailed logs the detail and hands back a plain sentence.
func (s *Service) snapshot(ctx context.Context, day, name string) (int64, error) {
	if err := os.MkdirAll(s.o.Dir, 0o755); err != nil {
		return 0, stepFailed("create the backup folder", err)
	}
	final := filepath.Join(s.o.Dir, name)
	tmp := filepath.Join(s.o.Dir, ".overlens-"+day+".db.tmp")
	_ = os.Remove(tmp) // VACUUM INTO refuses an existing file
	if _, err := s.db.ExecContext(ctx, "VACUUM INTO ?", tmp); err != nil {
		_ = os.Remove(tmp)
		return 0, stepFailed("create the backup file", err)
	}
	f, err := os.OpenFile(tmp, os.O_RDWR, 0)
	if err == nil {
		err = f.Sync()
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		_ = os.Remove(tmp)
		return 0, stepFailed("flush the backup file to disk", err)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return 0, stepFailed("move the backup file into place", err)
	}
	if d, err := os.Open(s.o.Dir); err == nil { // make the rename durable; not possible on every OS
		_ = d.Sync()
		d.Close()
	}
	st, err := os.Stat(final)
	if err != nil {
		return 0, stepFailed("read the finished backup file", err)
	}
	return st.Size(), nil
}

// prune keeps the newest KeepDays files named exactly overlens-YYYY-MM-DD.db and deletes the rest.
// Only called after a successful backup (REQ_AUD_012).
func (s *Service) prune(ctx context.Context) {
	all, err := s.list()
	if err != nil {
		slog.Error("backup: prune cannot list the folder", "err", err)
		return
	}
	// A file dated after today (clock moved back, hand-copied) is not "newest": it is left out of
	// the ranking and, like every non-matching file, never deleted.
	today := s.o.Now().Format("2006-01-02")
	items := make([]Item, 0, len(all))
	for _, it := range all {
		if it.Date > today {
			slog.Warn("backup: file dated in the future is ignored by pruning", "file", it.Name)
			continue
		}
		items = append(items, it)
	}
	if len(items) <= s.o.KeepDays {
		slog.Info("backup: nothing to prune", "have", len(items), "keep_days", s.o.KeepDays)
		return
	}
	var gone []string
	for _, it := range items[s.o.KeepDays:] {
		if err := os.Remove(filepath.Join(s.o.Dir, it.Name)); err != nil {
			slog.Error("backup: cannot delete an old backup", "file", it.Name, "err", err)
			continue
		}
		gone = append(gone, it.Name)
	}
	slog.Info("backup: pruned", "deleted", gone, "keep_days", s.o.KeepDays)
	if len(gone) > 0 {
		s.record(ctx, "backup.prune", map[string]any{"deleted": gone, "keep_days": s.o.KeepDays})
	}
}

// Purge removes audit rows older than audit_retention_days in small batches, logs the count and
// cutoff, and writes one audit entry. A failure is only logged (REQ_AUD_006).
func (s *Service) Purge(ctx context.Context) {
	if s.o.RetentionDays <= 0 {
		slog.Info("audit purge: retention is 0, keeping the audit log forever")
		return
	}
	now := s.o.Now()
	cutoff := now.UTC().AddDate(0, 0, -s.o.RetentionDays)
	n, err := store.AuditPurge(ctx, s.db, cutoff, s.o.PurgeBatch)
	if err != nil {
		slog.Error("audit purge: failed", "deleted_before_failure", n, "cutoff", cutoff.Format(time.RFC3339), "err", err)
		return
	}
	slog.Info("audit purge: done", "deleted", n, "cutoff", cutoff.Format(time.RFC3339))
	rctx := context.WithoutCancel(ctx)
	s.setMeta(rctx, "purge_last_date", now.Format("2006-01-02"))
	s.record(rctx, "audit.purge", map[string]any{"deleted": n, "cutoff": cutoff.Format("2006-01-02"), "retention_days": s.o.RetentionDays})
}

// Status builds a read-only report of the service; it only ever exposes file names.
func (s *Service) Status(ctx context.Context) (Status, error) {
	st := Status{Enabled: s.o.Enabled, BackupTime: s.o.Time, RetentionDays: s.o.RetentionDays, KeepDays: s.o.KeepDays, Items: []Item{}}
	if s.o.Enabled {
		n := s.NextRun(s.o.Now()).Format(time.RFC3339)
		st.NextRun = &n
	}
	if at := s.meta(ctx, "backup_last_at"); at != "" {
		st.Last = &Last{At: at, Result: s.meta(ctx, "backup_last_result"), Message: s.meta(ctx, "backup_last_message")}
	}
	items, err := s.list()
	if err != nil {
		return st, err
	}
	st.Items = items
	return st, nil
}

// list returns the matching files, newest first, ranked by the date parsed from the name. Only
// names with a real calendar date match; anything else is never listed, counted or deleted. A
// missing folder is simply empty.
func (s *Service) list() ([]Item, error) {
	ents, err := os.ReadDir(s.o.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Item{}, nil
	}
	if err != nil {
		return nil, err
	}
	items := []Item{}
	for _, e := range ents {
		m := namePattern.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if _, err := time.Parse("2006-01-02", m[1]); err != nil { // e.g. 2099-99-99: not a backup of ours
			continue
		}
		items = append(items, Item{Name: e.Name(), Date: m[1], SizeBytes: info.Size()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Date > items[j].Date })
	return items, nil
}

func (s *Service) record(ctx context.Context, action string, details map[string]any) {
	if err := s.o.Record(ctx, action, details); err != nil {
		slog.Error("backup: audit write failed", "action", action, "err", err)
	}
}

func (s *Service) meta(ctx context.Context, key string) string {
	var v string
	if err := s.db.QueryRowContext(ctx, "SELECT value FROM meta WHERE key = ?", key).Scan(&v); err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Error("backup: cannot read meta", "key", key, "err", err)
	}
	return v
}

func (s *Service) setMeta(ctx context.Context, key, val string) {
	if _, err := s.db.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, val); err != nil {
		slog.Error("backup: cannot write meta", "key", key, "err", err)
	}
}

func (s *Service) setLast(ctx context.Context, at time.Time, result, msg string) {
	if len(msg) > 500 {
		n := 500
		for n > 0 && !utf8.RuneStart(msg[n]) { // cut on a character boundary, never inside one
			n--
		}
		msg = msg[:n]
	}
	s.setMeta(ctx, "backup_last_at", at.Format(time.RFC3339))
	s.setMeta(ctx, "backup_last_result", result)
	s.setMeta(ctx, "backup_last_message", strings.TrimSpace(msg))
}
