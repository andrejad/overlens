package auth

import (
	"sync"
	"time"
)

const (
	maxFailures = 5
	lockFor     = 15 * time.Minute
	// maxLimiterKeys caps the in-memory table: an attacker who invents usernames cannot grow it
	// without bound (the oldest unlocked entries are evicted first).
	maxLimiterKeys = 10000
)

// limiter counts login attempts per key (a connection address or the hash of a normalised
// username). An attempt is counted when it is reserved, BEFORE the slow password check, so a burst
// of parallel requests cannot all slip through: the sixth attempt inside the window finds the key
// full and locks it for lockFor (REQ_AUTH_011). It lives in memory only: a restart forgives
// everyone, which is acceptable for a brake on guessing.
type limiter struct {
	mu  sync.Mutex
	m   map[string]*attempts
	cap int
}

type attempts struct {
	n           int // attempts reserved in the current window
	first       time.Time
	lockedUntil time.Time
}

func newLimiter() *limiter { return &limiter{m: map[string]*attempts{}, cap: maxLimiterKeys} }

func (a *attempts) stale(now time.Time) bool {
	return !now.Before(a.lockedUntil) && now.Sub(a.first) >= lockFor
}

// reserve counts one attempt against every key and reports whether it may go ahead. If any key is
// locked (or already holds maxFailures attempts, which locks it now) nothing is counted.
func (l *limiter) reserve(now time.Time, keys ...string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		a := l.m[k]
		if a == nil {
			continue
		}
		if a.stale(now) {
			delete(l.m, k)
			continue
		}
		if now.Before(a.lockedUntil) {
			return false
		}
		if a.n >= maxFailures {
			a.lockedUntil = now.Add(lockFor)
			return false
		}
	}
	for _, k := range keys {
		a := l.m[k]
		if a == nil {
			l.makeRoom(now)
			a = &attempts{first: now}
			l.m[k] = a
		}
		a.n++
	}
	return true
}

// refund gives back one reserved attempt (the login succeeded or never got to check a password).
func (l *limiter) refund(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		if a := l.m[k]; a != nil && a.n > 0 {
			a.n--
		}
	}
}

// clear forgets a key after a successful login.
func (l *limiter) clear(k string) {
	l.mu.Lock()
	delete(l.m, k)
	l.mu.Unlock()
}

// prune drops entries that can no longer matter.
func (l *limiter) prune(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, a := range l.m {
		if a.stale(now) {
			delete(l.m, k)
		}
	}
}

func (l *limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.m)
}

// makeRoom keeps the table under its cap: stale entries first, then the oldest unlocked one, and
// only if every entry is locked the one whose lock ends soonest. Called with mu held.
func (l *limiter) makeRoom(now time.Time) {
	if len(l.m) < l.cap {
		return
	}
	var victim string
	var vFirst time.Time
	var vLocked bool
	have := false
	for k, a := range l.m {
		if a.stale(now) {
			delete(l.m, k)
			continue
		}
		locked := now.Before(a.lockedUntil) || a.n >= maxFailures // a full entry is a lock in waiting
		t := a.first
		if now.Before(a.lockedUntil) {
			t = a.lockedUntil
		}
		better := !have || (vLocked && !locked) || (vLocked == locked && t.Before(vFirst))
		if better {
			victim, vFirst, vLocked, have = k, t, locked, true
		}
	}
	if len(l.m) >= l.cap && have {
		delete(l.m, victim)
	}
}
