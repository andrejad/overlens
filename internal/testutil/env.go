package testutil

import (
	"database/sql"
	"hash/fnv"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/store"
)

// Clock is the test-controlled clock. Tests express dates as days relative to it.
type Clock struct{ now time.Time }

// clockFromSeed derives "today" deterministically from an env's seed, instead of real wall-clock
// time (REQ_TEST_017/018): two runs with the same TEST_SEED must produce byte-for-byte identical
// dates, not just identical day *offsets*, on whatever day they happen to run.
func clockFromSeed(seed int64) *Clock {
	days := seed % (365 * 8)
	if days < 0 {
		days = -days
	}
	epoch := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	return &Clock{now: epoch.AddDate(0, 0, int(days))}
}

func (c *Clock) Now() time.Time           { return c.now }
func (c *Clock) Advance(days int)         { c.now = c.now.AddDate(0, 0, days) }
func (c *Clock) Day(offset int) time.Time { return c.now.AddDate(0, 0, offset) }

// Date returns the ISO date offset days from the clock.
func (c *Clock) Date(offset int) string { return c.Day(offset).Format("2006-01-02") }

// Env is what one test gets: a fresh database, clock, seeded RNG and builders.
type Env struct {
	T     *testing.T
	DB    *sql.DB
	Path  string
	Root  string
	Clock *Clock
	RNG   *rand.Rand
	Seed  int64
	n     int
	// roadmapTaken: teams whose one roadmap a test already asked for (Env.Roadmap)
	roadmapTaken map[int64]bool
}

// NewEnv builds a fresh temp DB from schema.sql. Cleanup is registered before anything can fail,
// so it runs on failure and panic; the guard runs before any file is created or deleted.
func NewEnv(t *testing.T) *Env {
	t.Helper()
	t.Setenv("LOG_PREFIX", "test")
	root, err := os.MkdirTemp("", tempPrefix)
	if err != nil {
		t.Fatal(err)
	}
	e := &Env{T: t, Root: root}
	t.Cleanup(func() {
		if e.DB != nil {
			e.DB.Close()
		}
		if err := SafeRemoveAll(root, root); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})
	e.Path = filepath.Join(root, "test.db")
	if err := GuardDBPath(e.Path, root); err != nil {
		t.Fatal(err)
	}
	e.DB = e.OpenDB(e.Path)
	if err := store.Converge(e.DB, ReadSchema(t, "schema.sql")); err != nil {
		t.Fatal(err)
	}
	// REQ_TEST_018: the seed (and everything derived from it — the clock and the RNG) comes from
	// TEST_SEED when set, else a fresh one; each Env within one test gets its own, derived from the
	// test's name and how many Envs it has already built, so a replay under TEST_SEED=<n> reproduces
	// the exact same sequence regardless of which other tests ran alongside it or in what order.
	e.Seed = deriveSeed(t)
	e.Clock = clockFromSeed(e.Seed)
	e.RNG = rand.New(rand.NewSource(e.Seed))
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("replay with TEST_SEED=%d (this env derived seed %d)", masterSeed(), e.Seed)
		}
	})
	slog.Debug("testutil: env ready", "path", e.Path, "seed", e.Seed)
	return e
}

// OpenDB opens another database inside the env's temp dir (used by the upgrade tests).
func (e *Env) OpenDB(path string) *sql.DB {
	e.T.Helper()
	if err := GuardDBPath(path, e.Root); err != nil {
		e.T.Fatal(err)
	}
	db, err := store.Open(path)
	if err != nil {
		e.T.Fatal(err)
	}
	e.T.Cleanup(func() { db.Close() })
	return db
}

// masterSeed is read from TEST_SEED once per process; unset, it falls back to real time so an
// un-replayed run still varies.
var masterSeed = sync.OnceValue(func() int64 {
	if s := os.Getenv("TEST_SEED"); s != "" {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	}
	return time.Now().UnixNano()
})

// MasterSeed is the value to export as TEST_SEED to replay the whole run: every Env's own seed (Env.Seed) is derived
// from it, the test's name and the Env's ordinal, so Env.Seed itself is not a replay value.
func MasterSeed() int64 { return masterSeed() }

// envOrdinals counts, per test name, how many Envs that test has built — the Nth Env of a given
// test always derives the same seed under a given TEST_SEED, independent of any other test.
var envOrdinals sync.Map // map[string]*int64

// deriveSeed combines the master seed with the calling test's name and its own Env ordinal, so two
// Envs — in the same test, in different tests, or in different processes entirely — never collide
// but a whole run replays exactly under the same TEST_SEED.
func deriveSeed(t *testing.T) int64 {
	v, _ := envOrdinals.LoadOrStore(t.Name(), new(int64))
	n := atomic.AddInt64(v.(*int64), 1)
	h := fnv.New64a()
	h.Write([]byte(t.Name()))
	return int64(h.Sum64())*31 + masterSeed()*1_000_003 + n
}

// ReadSchema reads a file relative to the repo root (schema.sql).
func ReadSchema(t *testing.T, rel string) string {
	t.Helper()
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (e *Env) next() int {
	e.n++
	return e.n
}

func tagFor(n int) string { // unique 2-4 uppercase letters
	s := ""
	for n = n + 26*26; n > 0 && len(s) < 4; n /= 26 {
		s = string(rune('A'+n%26)) + s
	}
	return s
}

// RepoRoot returns the directory holding go.mod.
func RepoRoot(t *testing.T) string {
	t.Helper()
	r, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	return r
}
