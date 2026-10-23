package auth_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/testutil"
)

var cheap = auth.Params{MemoryKiB: 64, Time: 1, Threads: 1}

// Test_REQ_AUTH_004_passwords_are_hashed_with_argon2id_and_verified.
func Test_REQ_AUTH_004_passwords_are_hashed_with_argon2id_and_verified(t *testing.T) {
	t.Run("stale hashes are replaced at login", func(t *testing.T) {
		e := testutil.NewEnv(t)
		cur := auth.Params{MemoryKiB: 128, Time: 1, Threads: 1}
		svc := auth.New(e.DB, auth.Options{Params: &cur})
		a := e.Admin(testutil.AdminOpts{}) // the builder uses m=64
		read := func() string {
			var h string
			e.DB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, a.ID).Scan(&h)
			return h
		}
		old := read()
		if !auth.NeedsRehash(old, cur) || auth.NeedsRehash(old, cheap) || auth.NeedsRehash("garbage", cur) {
			t.Fatal("NeedsRehash gave the wrong answer")
		}
		svc.Login(context.Background(), "1.1.1.1:1", a.Username, "wrong password")
		if read() != old {
			t.Fatal("a failed login rewrote the hash")
		}
		if _, _, err := svc.Login(context.Background(), "1.1.1.1:1", a.Username, a.Password); err != nil {
			t.Fatal(err)
		}
		h := read()
		if h == old || !strings.Contains(h, "m=128,t=1,p=1") || auth.NeedsRehash(h, cur) {
			t.Errorf("hash after login: %q", h)
		}
		if _, _, err := svc.Login(context.Background(), "1.1.1.1:1", a.Username, a.Password); err != nil || read() != h {
			t.Errorf("second login: %v, hash changed=%v", err, read() != h)
		}
	})

	h, err := auth.HashPasswordWith("correct horse", cheap)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=64,t=1,p=1$") || strings.Contains(h, "correct horse") {
		t.Fatalf("hash %q", h)
	}
	if ok, err := auth.VerifyPassword("correct horse", h); !ok || err != nil {
		t.Errorf("right password: %v %v", ok, err)
	}
	if ok, _ := auth.VerifyPassword("correct horsf", h); ok {
		t.Error("wrong password verified")
	}
	h2, _ := auth.HashPasswordWith("correct horse", cheap)
	if h == h2 {
		t.Error("two hashes of one password are identical: the salt is not random")
	}
	for _, bad := range []string{"", "plain", "$argon2id$v=19$m=64,t=1,p=1$x", "$bcrypt$v=19$m=64,t=1,p=1$AAAA$AAAA", "$argon2id$v=19$m=64,t=0,p=1$AAAA$AAAA"} {
		if ok, err := auth.VerifyPassword("x", bad); ok || err == nil {
			t.Errorf("malformed hash %q verified or gave no error: %v %v", bad, ok, err)
		}
	}
	// the default cost is what production uses, and the hash says so
	d, err := auth.HashPassword("pw-for-default-cost")
	if err != nil || !strings.Contains(d, "m=19456,t=2,p=1") {
		t.Errorf("default hash %q %v", d, err)
	}

}

// Test_REQ_AUTH_015_last_active_admin_cannot_be_disabled: through the API the acting admin is always
// active themself, so this rule is only reachable here, with an actor id that isn't the target.
func Test_REQ_AUTH_015_last_active_admin_cannot_be_disabled(t *testing.T) {
	e := testutil.NewEnv(t)
	svc := auth.New(e.DB, auth.Options{})
	only := e.Admin(testutil.AdminOpts{})
	tr := true
	_, err := svc.UpdateUser(context.Background(), only.ID+100, only.ID, auth.UserChange{Disabled: &tr})
	var se *store.Error
	if !errors.As(err, &se) || se.Kind != store.Conflict || se.Code != "last_admin" {
		t.Fatalf("err = %v", err)
	}
	e.Admin(testutil.AdminOpts{}) // a second active admin: now the first may go
	res, err := svc.UpdateUser(context.Background(), only.ID+100, only.ID, auth.UserChange{Disabled: &tr})
	if err != nil || !res.User.Disabled || len(res.Actions) != 1 || res.Actions[0] != "user.disable" {
		t.Fatalf("disable with a second admin: %+v %v", res, err)
	}
	// a disabled admin does not count as active: the remaining one is now the last
	var rest int64
	e.DB.QueryRow(`SELECT id FROM users WHERE disabled=0`).Scan(&rest)
	if _, err := svc.UpdateUser(context.Background(), only.ID+100, rest, auth.UserChange{Disabled: &tr}); !errors.As(err, &se) || se.Code != "last_admin" {
		t.Errorf("err = %v", err)
	}
	// re-enabling is always allowed
	fl := false
	if res, err := svc.UpdateUser(context.Background(), rest, only.ID, auth.UserChange{Disabled: &fl}); err != nil || res.User.Disabled {
		t.Errorf("re-enable: %+v %v", res, err)
	}
}

// Test_REQ_AUTH_009_cleanup_removes_only_expired_sessions.
func Test_REQ_AUTH_009_cleanup_removes_only_expired_sessions(t *testing.T) {
	e := testutil.NewEnv(t)
	now := time.Date(2031, 5, 5, 8, 0, 0, 0, time.UTC)
	svc := auth.New(e.DB, auth.Options{Now: func() time.Time { return now }})
	a := e.Admin(testutil.AdminOpts{})
	_, live, err := svc.Login(context.Background(), "1.1.1.1:1", a.Username, a.Password)
	if err != nil {
		t.Fatal(err)
	}
	e.DB.Exec(`INSERT INTO sessions(id,user_id,expires_at) VALUES ('old',?,?)`, a.ID, now.Add(-time.Hour).Format("2006-01-02T15:04:05Z"))
	svc.Cleanup(context.Background())
	var n int
	e.DB.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&n)
	var old int
	e.DB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id='old'`).Scan(&old)
	if n != 1 || old != 0 || live == "" {
		t.Errorf("sessions left %d, expired one present %d", n, old)
	}
}
