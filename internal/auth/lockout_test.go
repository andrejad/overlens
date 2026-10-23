package auth_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/testutil"
)

// lockout is the 15 minutes of REQ_AUTH_011, written out here on purpose: the tests pin the number.
const lockout = 15 * time.Minute

// clockSvc builds a service whose clock is the returned pointer, with a cheap hash cost.
func clockSvc(e *testutil.Env, start time.Time) (*auth.Service, *time.Time) {
	now := start
	p := cheap
	return auth.New(e.DB, auth.Options{Now: func() time.Time { return now }, Params: &p}), &now
}

// Test_REQ_AUTH_011_lock_ends_exactly_15_minutes_after_it_was_set: one nanosecond before the
// expiry the key is still locked, at the expiry it is free. Checked for an address and a username.
func Test_REQ_AUTH_011_lock_ends_exactly_15_minutes_after_it_was_set(t *testing.T) {
	t.Run("failure count starts over after 15 minutes", func(t *testing.T) {
		e := testutil.NewEnv(t)
		start := time.Date(2031, 5, 5, 8, 0, 0, 0, time.UTC)
		svc, now := clockSvc(e, start)
		a := e.Admin(testutil.AdminOpts{})
		ctx := context.Background()
		for i, tc := range []struct {
			gap    time.Duration
			locked bool
		}{{lockout, false}, {lockout - time.Nanosecond, true}} {
			start = start.Add(48 * time.Hour)
			*now = start
			ip := fmt.Sprintf("5.5.%d.5:1", i)
			for range 4 {
				svc.Login(ctx, ip, "ghost", "nope")
			}
			*now = start.Add(tc.gap)
			for range 4 {
				svc.Login(ctx, ip, "ghost", "nope")
			}
			_, _, err := svc.Login(ctx, ip, a.Username, a.Password)
			if tc.locked != errors.Is(err, auth.ErrLocked) || (!tc.locked && err != nil) {
				t.Errorf("gap %v: err = %v, want locked=%v", tc.gap, err, tc.locked)
			}
		}
	})

	t.Run("successful login clears the username count", func(t *testing.T) {
		e := testutil.NewEnv(t)
		svc, _ := clockSvc(e, time.Date(2031, 5, 5, 8, 0, 0, 0, time.UTC))
		a := e.Admin(testutil.AdminOpts{})
		ctx := context.Background()
		fail := func(i int) {
			if _, _, err := svc.Login(ctx, fmt.Sprintf("10.1.%d.1:1", i), a.Username, "wrong-password"); !errors.Is(err, auth.ErrInvalidCredentials) {
				t.Fatalf("failure %d: %v", i, err)
			}
		}
		for i := range 4 {
			fail(i)
		}
		if _, _, err := svc.Login(ctx, "10.2.0.1:1", a.Username, a.Password); err != nil {
			t.Fatalf("login after 4 failures: %v", err)
		}
		for i := 10; i < 14; i++ {
			fail(i)
		}
		if _, _, err := svc.Login(ctx, "10.2.0.2:1", a.Username, a.Password); err != nil {
			t.Errorf("4 + success + 4 failures locked the username: %v", err)
		}
	})

	t.Run("default clock is the wall clock", func(t *testing.T) {
		e := testutil.NewEnv(t)
		p := cheap
		ttl := 36 * time.Hour
		svc := auth.New(e.DB, auth.Options{TTL: ttl, Params: &p})
		a := e.Admin(testutil.AdminOpts{})
		before := time.Now()
		if _, _, err := svc.Login(context.Background(), "1.2.3.4:5", a.Username, a.Password); err != nil {
			t.Fatal(err)
		}
		var exp string
		if err := e.DB.QueryRow(`SELECT expires_at FROM sessions WHERE user_id = ?`, a.ID).Scan(&exp); err != nil {
			t.Fatal(err)
		}
		got, err := time.Parse("2006-01-02T15:04:05Z", exp)
		if err != nil {
			t.Fatalf("expires_at %q: %v", exp, err)
		}
		if d := got.Sub(before.Add(ttl)); d < -3*time.Second || d > 5*time.Second {
			t.Errorf("expires_at %v is %v away from now+ttl", got, d)
		}
	})

	t.Run("limiter counts per key and the clock is injectable", func(t *testing.T) {
		e := testutil.NewEnv(t)
		now := time.Date(2031, 5, 5, 8, 0, 0, 0, time.UTC)
		svc := auth.New(e.DB, auth.Options{Now: func() time.Time { return now }})
		a := e.Admin(testutil.AdminOpts{})
		ctx := context.Background()
		for i := range 4 {
			if _, _, err := svc.Login(ctx, "7.7.7.7:1", "ghost", "nope"); !errors.Is(err, auth.ErrInvalidCredentials) {
				t.Fatalf("failure %d: %v", i, err)
			}
		}
		// failures are spread over time: 4 now, then the window passes, then 4 more must not lock
		now = now.Add(16 * time.Minute)
		for range 4 {
			svc.Login(ctx, "7.7.7.7:1", "ghost", "nope")
		}
		if _, _, err := svc.Login(ctx, "7.7.7.7:1", a.Username, a.Password); err != nil {
			t.Errorf("4 + 4 failures far apart locked the address: %v", err)
		}
		// the fifth in a row locks
		for range 5 {
			svc.Login(ctx, "8.8.8.8:1", "ghost2", "nope")
		}
		if _, _, err := svc.Login(ctx, "8.8.8.8:99", a.Username, a.Password); !errors.Is(err, auth.ErrLocked) {
			t.Errorf("fifth failure did not lock the address: %v", err)
		}
		// the address key is the host: the port does not matter, and a different host is free
		if _, _, err := svc.Login(ctx, "9.9.9.9:1", a.Username, a.Password); err != nil {
			t.Errorf("other host: %v", err)
		}
	})

	e := testutil.NewEnv(t)
	start := time.Date(2031, 5, 5, 8, 0, 0, 0, time.UTC)
	svc, now := clockSvc(e, start)
	a := e.Admin(testutil.AdminOpts{})
	ctx := context.Background()
	for _, byAddress := range []bool{true, false} {
		*now = start
		start = start.Add(48 * time.Hour) // the next round begins long after this round's keys are stale
		// bad(i) fails the password check; good() is a correct login. By address every attempt
		// comes from one IP and a made-up user; by username each comes from its own IP.
		bad := func(i int) error {
			ip, user := "6.6.6.6:1", "ghost"
			if !byAddress {
				ip, user = fmt.Sprintf("10.0.%d.1:1", i), a.Username
			}
			_, _, err := svc.Login(ctx, ip, user, "wrong-password")
			return err
		}
		good := func() error {
			ip := "6.6.6.6:1"
			if !byAddress {
				ip = "10.9.9.9:1"
			}
			_, _, err := svc.Login(ctx, ip, a.Username, a.Password)
			return err
		}
		for i := range 5 {
			if err := bad(i); !errors.Is(err, auth.ErrInvalidCredentials) {
				t.Fatalf("byAddress=%v failure %d: %v", byAddress, i, err)
			}
		}
		// the sixth attempt comes 5 minutes after the first, so the lock (set now) ends 15 minutes after
		// this moment, not 15 minutes after the first failure: lock expiry and window expiry differ.
		*now = (*now).Add(5 * time.Minute)
		if err := bad(5); !errors.Is(err, auth.ErrLocked) { // the sixth attempt sets the lock
			t.Fatalf("byAddress=%v: sixth attempt: %v", byAddress, err)
		}
		lockedAt := *now
		*now = lockedAt.Add(lockout - time.Nanosecond)
		if err := good(); !errors.Is(err, auth.ErrLocked) {
			t.Errorf("byAddress=%v: 1ns before expiry: %v, want locked", byAddress, err)
		}
		*now = lockedAt.Add(lockout)
		if err := good(); err != nil {
			t.Errorf("byAddress=%v: at expiry: %v, want success", byAddress, err)
		}
	}

}
