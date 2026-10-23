package testutil

import (
	"context"
	"fmt"
	"time"

	"github.com/andrejad/overlens/internal/auth"
)

// Admin is a user the builder created. Password is the plain text, kept only so a test can log in.
type Admin struct {
	ID       int64
	Username string
	Password string
}

// AdminOpts, all optional.
type AdminOpts struct {
	Username, Password string
	Disabled           bool
}

// cheapParams keeps the hundreds of builder-made admins fast; the cost is stored inside each hash,
// so the real login path verifies them exactly as it would a production hash.
var cheapParams = auth.Params{MemoryKiB: 64, Time: 1, Threads: 1}

// Admin inserts an admin user directly in the env's temp database and returns it.
func (e *Env) Admin(o AdminOpts) Admin {
	e.T.Helper()
	n := e.next()
	if o.Username == "" {
		o.Username = fmt.Sprintf("admin%d", n)
	}
	if o.Password == "" {
		o.Password = "test-password-" + fmt.Sprint(n)
	}
	hash, err := auth.HashPasswordWith(o.Password, cheapParams)
	e.check(err)
	res, err := e.DB.ExecContext(context.Background(), `INSERT INTO users(username, password_hash, disabled) VALUES (?,?,?)`,
		o.Username, hash, o.Disabled)
	e.check(err)
	id, _ := res.LastInsertId()
	return Admin{ID: id, Username: o.Username, Password: o.Password}
}

// Session inserts a live session for a (a year from the real clock, because the server under test
// reads the real clock unless a test injects one) and returns the cookie value to send as
// "session=<value>". Only the temp database is ever touched.
func (e *Env) Session(a Admin) string {
	e.T.Helper()
	token, id, err := auth.NewToken()
	e.check(err)
	exp := time.Now().UTC().Add(365 * 24 * time.Hour).Format("2006-01-02T15:04:05Z")
	_, err = e.DB.ExecContext(context.Background(), `INSERT INTO sessions(id, user_id, expires_at) VALUES (?,?,?)`, id, a.ID, exp)
	e.check(err)
	return token
}
