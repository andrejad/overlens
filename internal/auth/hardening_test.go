package auth_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

var fixedNow = time.Date(2031, 5, 5, 8, 0, 0, 0, time.UTC)

func cheapService(e *testutil.Env) *auth.Service {
	return auth.New(e.DB, auth.Options{Params: &cheap, Now: func() time.Time { return fixedNow }})
}

// outcomes runs n logins at once and tallies how each ended.
func outcomes(n int, login func(i int) error) (invalid, locked, other int) {
	var wg sync.WaitGroup
	var iv, lk, ot atomic.Int64
	start := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			switch err := login(i); {
			case errors.Is(err, auth.ErrInvalidCredentials):
				iv.Add(1)
			case errors.Is(err, auth.ErrLocked):
				lk.Add(1)
			default:
				ot.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	return int(iv.Load()), int(lk.Load()), int(ot.Load())
}

// Test_REQ_AUTH_011_a_parallel_burst_gets_five_attempts_not_n: the attempt is counted before the
// password is hashed, so 40 simultaneous logins are 5 checked ones and 35 locked ones.
func Test_REQ_AUTH_011_a_parallel_burst_gets_five_attempts_not_n(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := cheapService(e)
	a := e.Admin(testutil.AdminOpts{})
	var verified atomic.Int64
	svc.SetVerify(func(pw, h string) (bool, error) { verified.Add(1); return auth.VerifyPassword(pw, h) })
	ctx := context.Background()

	// same address, same username
	iv, lk, ot := outcomes(40, func(int) error { _, _, err := svc.Login(ctx, "5.5.5.5:1", a.Username, "wrong"); return err })
	if iv != 5 || lk != 35 || ot != 0 || verified.Load() != 5 {
		t.Errorf("same address+user: %d checked-wrong, %d locked, %d other, %d verified; want 5/35/0/5", iv, lk, ot, verified.Load())
	}
	// same address, a different username each time (a guessing run): the address key stops it
	verified.Store(0)
	iv, lk, _ = outcomes(40, func(i int) error {
		_, _, err := svc.Login(ctx, "6.6.6.6:1", fmt.Sprintf("guess%d", i), "wrong")
		return err
	})
	if iv != 5 || lk != 35 || verified.Load() != 5 {
		t.Errorf("same address, many users: %d wrong, %d locked, %d verified; want 5/35/5", iv, lk, verified.Load())
	}
	// same username from many addresses: the username key stops it
	verified.Store(0)
	iv, lk, _ = outcomes(40, func(i int) error {
		_, _, err := svc.Login(ctx, fmt.Sprintf("7.7.7.%d:1", i), "victim", "wrong")
		return err
	})
	if iv != 5 || lk != 35 || verified.Load() != 5 {
		t.Errorf("many addresses, one user: %d wrong, %d locked, %d verified; want 5/35/5", iv, lk, verified.Load())
	}
	// a clean address and user still gets in
	b := e.Admin(testutil.AdminOpts{})
	if _, _, err := svc.Login(ctx, "8.8.8.8:1", b.Username, b.Password); err != nil {
		t.Errorf("a clean address and user was refused: %v", err)
	}
	if _, _, err := svc.Login(ctx, "8.8.8.8:1", a.Username, a.Password); !errors.Is(err, auth.ErrLocked) {
		t.Errorf("the burst's user is locked for everyone: %v", err)
	}

	t.Run("unusable usernames are refused before the limiter", func(t *testing.T) {
		e := testutil.NewEnv(t)
		svc := cheapService(e)
		var verified atomic.Int64
		svc.SetVerify(func(pw, h string) (bool, error) { verified.Add(1); return false, nil })
		for _, name := range []string{"", "   ", strings.Repeat("a", 65), strings.Repeat("é", 65), "a\x00b", "a\nb", "a\x7fb", "tab\there"} {
			for range 10 { // far more than the 5 that would lock a real key
				if _, _, err := svc.Login(context.Background(), "9.9.9.9:1", name, "x"); !errors.Is(err, auth.ErrInvalidCredentials) {
					t.Fatalf("username %q: %v, want the generic invalid_credentials", name, err)
				}
			}
		}
		if svc.LimiterSize() != 0 || verified.Load() != 0 {
			t.Errorf("limiter entries = %d, password checks = %d; an unusable name must create neither", svc.LimiterSize(), verified.Load())
		}
		// a 64-character name is still a name
		if _, _, err := svc.Login(context.Background(), "9.9.9.9:1", strings.Repeat("a", 64), "x"); !errors.Is(err, auth.ErrInvalidCredentials) || svc.LimiterSize() == 0 {
			t.Errorf("64 characters should reach the limiter: %v / %d", err, svc.LimiterSize())
		}
	})

	t.Run("limiter table is capped and keeps locks", func(t *testing.T) {
		e := testutil.NewEnv(t)
		svc := cheapService(e)
		svc.SetLimiterCap(50)
		ctx := context.Background()
		for range 5 {
			svc.Login(ctx, "1.1.1.1:1", "victim", "wrong")
		}
		for i := range 500 { // a spray of invented names from invented addresses
			svc.Login(ctx, fmt.Sprintf("10.1.%d.%d:1", i/200, i%200), fmt.Sprintf("invented%d", i), "x")
		}
		if n := svc.LimiterSize(); n > 50 {
			t.Errorf("limiter holds %d entries, cap is 50", n)
		}
		if _, _, err := svc.Login(ctx, "3.3.3.3:1", "victim", "wrong"); !errors.Is(err, auth.ErrLocked) {
			t.Errorf("the spray evicted an active lock: %v", err)
		}
	})
}

// Test_REQ_AUTH_011_at_most_a_few_password_checks_run_at_once: extra logins wait, they do not fail.
func Test_REQ_AUTH_011_at_most_a_few_password_checks_run_at_once(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := cheapService(e)
	var cur, peak atomic.Int64
	svc.SetVerify(func(pw, h string) (bool, error) {
		n := cur.Add(1)
		for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
		}
		time.Sleep(15 * time.Millisecond)
		cur.Add(-1)
		return false, nil
	})
	iv, lk, ot := outcomes(24, func(i int) error { // 24 distinct addresses and users: no lock is involved
		_, _, err := svc.Login(context.Background(), fmt.Sprintf("10.0.0.%d:1", i), fmt.Sprintf("u%d", i), "x")
		return err
	})
	if iv != 24 || lk != 0 || ot != 0 {
		t.Errorf("%d wrong, %d locked, %d other; every waiting login must still be answered", iv, lk, ot)
	}
	if p := peak.Load(); p > auth.MaxVerifies || p < 2 {
		t.Errorf("peak concurrent checks = %d, want 2..%d", p, auth.MaxVerifies)
	}
	// a waiting login whose request is cancelled gives up
	svc.SetVerify(func(pw, h string) (bool, error) { time.Sleep(150 * time.Millisecond); return false, nil })
	for i := range auth.MaxVerifies {
		go svc.Login(context.Background(), fmt.Sprintf("11.0.0.%d:1", i), "busy", "x")
	}
	time.Sleep(40 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := svc.Login(ctx, "12.0.0.1:1", "patient", "x"); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("cancelled waiter: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // let the busy ones finish before the database goes away
}

// Test_REQ_AUTH_017_the_dummy_hash_exists_before_the_first_login.
func Test_REQ_AUTH_017_the_dummy_hash_exists_before_the_first_login(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := auth.New(e.DB, auth.Options{Params: &cheap})
	if h := svc.DummyHash(); !strings.HasPrefix(h, "$argon2id$v=19$m=64,t=1,p=1$") {
		t.Errorf("dummy hash %q, want one built at construction with the service's cost", h)
	}

	t.Run("username is trimmed and case folded for limiter and lookup", func(t *testing.T) {
		ctx := context.Background()
		e := testutil.NewEnv(t)
		svc := cheapService(e)
		a := e.Admin(testutil.AdminOpts{Username: "kim"})
		for i, name := range []string{" KIM", "kim ", "\tKiM\n", "Kim", "kIM"} { // five spellings, five addresses
			svc.Login(ctx, fmt.Sprintf("1.1.1.%d:1", i), name, "wrong")
		}
		if _, _, err := svc.Login(ctx, "2.2.2.2:1", "kim", a.Password); !errors.Is(err, auth.ErrLocked) {
			t.Errorf("five spellings did not lock the one user: %v", err)
		}

		e2 := testutil.NewEnv(t)
		svc2 := cheapService(e2)
		a2 := e2.Admin(testutil.AdminOpts{Username: "Kim"})
		for _, name := range []string{" kim", "KIM ", "kIm"} {
			if u, _, err := svc2.Login(ctx, "3.3.3.3:1", name, a2.Password); err != nil || u.Username != "Kim" {
				t.Errorf("login as %q: %v %v", name, u, err)
			}
		}

		// Kelvin sign U+212A lower-cases to "k" in Go but is NOT "k" to SQLite's NOCASE: not that user
		e3 := testutil.NewEnv(t)
		svc3 := cheapService(e3)
		a3 := e3.Admin(testutil.AdminOpts{Username: "kim"})
		if _, _, err := svc3.Login(ctx, "4.4.4.4:1", "Kim", a3.Password); !errors.Is(err, auth.ErrInvalidCredentials) {
			t.Errorf("Kelvin-sign look-alike logged in as kim: %v", err)
		}
		if _, _, err := svc3.Login(ctx, "4.4.4.4:1", "kim", a3.Password); err != nil {
			t.Errorf("the real name stopped working: %v", err)
		}
	})
}

// Test_REQ_AUTH_014_concurrent_creates_of_one_name_give_one_user_and_clean_conflicts.
func Test_REQ_AUTH_014_concurrent_creates_of_one_name_give_one_user_and_clean_conflicts(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := auth.New(e.DB, auth.Options{Params: &cheap})
	names := []string{"Bob", "bob", "BOB", "bOb", " bob ", "Bob", "bob", "BoB"}
	var wg sync.WaitGroup
	errs := make([]error, len(names))
	for i, n := range names {
		wg.Add(1)
		go func() { defer wg.Done(); _, errs[i] = svc.CreateUser(context.Background(), n, "long-enough-pw") }()
	}
	wg.Wait()
	created := 0
	for i, err := range errs {
		var se *store.Error
		switch {
		case err == nil:
			created++
		case errors.As(err, &se) && se.Kind == store.Conflict && se.Code == "duplicate_name":
		default:
			t.Errorf("create %q: %v, want nil or 409 duplicate_name", names[i], err)
		}
	}
	var n int
	e.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	if created != 1 || n != 1 {
		t.Errorf("created %d, rows %d, want exactly one", created, n)
	}
}

// Test_REQ_AUTH_004_concurrent_bootstrap_is_a_clean_no_op_for_the_loser.
func Test_REQ_AUTH_004_concurrent_bootstrap_is_a_clean_no_op_for_the_loser(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := auth.New(e.DB, auth.Options{Params: &cheap})
	var wg sync.WaitGroup
	var created, failed atomic.Int64
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := svc.Bootstrap(context.Background(), "root", "bootstrap-pass-1")
			if err != nil {
				failed.Add(1)
			} else if ok {
				created.Add(1)
			}
		}()
	}
	wg.Wait()
	var n int
	e.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	if failed.Load() != 0 || created.Load() != 1 || n != 1 {
		t.Errorf("failed %d, created %d, rows %d; want 0, 1, 1", failed.Load(), created.Load(), n)
	}
}

// REQ_AUTH_019: "system" is reserved, so the bootstrap admin may not take it; but only when it would really be created.
func Test_REQ_AUTH_019_bootstrap_admin_may_not_be_system(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := cheapService(e)
	for _, name := range []string{"system", " System "} {
		ok, err := svc.Bootstrap(context.Background(), name, "bootstrap-pass-1")
		if ok || err == nil || !strings.Contains(err.Error(), "bootstrap_admin_user") {
			t.Fatalf("%q: want a refusal naming bootstrap_admin_user, got %v %v", name, ok, err)
		}
	}
	if _, err := svc.Bootstrap(context.Background(), "root", "bootstrap-pass-1"); err != nil {
		t.Fatal(err)
	}
	// an install that already has users keeps starting, whatever the config says
	if ok, err := svc.Bootstrap(context.Background(), "system", "bootstrap-pass-1"); ok || err != nil {
		t.Fatalf("existing install: want a quiet no-op, got %v %v", ok, err)
	}
}
