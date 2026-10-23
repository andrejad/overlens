package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// CookieName is the session cookie (REQ_AUTH_008).
const CookieName = "session"

// DefaultTTL is used when Options.TTL is zero (the config default, session_ttl_days).
const DefaultTTL = 365 * 24 * time.Hour

var (
	// ErrNoSession means the request carries no usable session: no cookie, an unknown token, an
	// expired session or a disabled user.
	ErrNoSession = errors.New("auth: no valid session")
	// ErrInvalidCredentials is the one answer for an unknown user, a wrong password or a disabled
	// account (REQ_AUTH_017).
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	// ErrLocked means the connection address or the username is locked out (REQ_AUTH_011).
	ErrLocked = errors.New("auth: locked out")
)

// User is the logged-in person as the API shows them.
type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	slid     bool
}

// Slid reports whether Authenticate just extended this user's session, so the caller must re-set
// the cookie (REQ_AUTH_009).
func (u *User) Slid() bool { return u.slid }

// Options configures a Service. The zero value is a production-like service on the real clock.
type Options struct {
	TTL    time.Duration    // session lifetime; 0 = DefaultTTL
	Now    func() time.Time // injectable clock for tests
	Params *Params          // argon2id cost for new hashes; nil = DefaultParams
}

// maxVerifies bounds how many argon2 checks run at once: each allocates ~19 MiB, so an unbounded
// burst of logins could exhaust memory. Extra logins wait for a slot; they do not fail.
const maxVerifies = 4

// Service owns sessions, the login brake and the users table.
type Service struct {
	db  *sql.DB
	ttl time.Duration
	now func() time.Time
	lim *limiter

	params Params
	dummy  string // the hash an unknown user's password is checked against, built at construction
	sem    chan struct{}
	verify func(pw, encoded string) (bool, error) // VerifyPassword; a seam for the concurrency test
}

func New(db *sql.DB, o Options) *Service {
	if o.TTL <= 0 {
		o.TTL = DefaultTTL
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	s := &Service{db: db, ttl: o.TTL, now: o.Now, lim: newLimiter(), params: DefaultParams,
		sem: make(chan struct{}, maxVerifies), verify: VerifyPassword}
	if o.Params != nil {
		s.params = *o.Params
	}
	// Built now, not on the first unknown-user login, so that first request is not measurably slower.
	d, err := HashPasswordWith("not-a-real-password", s.params)
	if err != nil {
		slog.Error("auth: cannot build the dummy password hash", "err", err)
	}
	s.dummy = d
	return s
}

// TTL is the session lifetime, for the cookie's Max-Age.
func (s *Service) TTL() time.Duration { return s.ttl }

const tsLayout = "2006-01-02T15:04:05Z"

func (s *Service) stamp(t time.Time) string { return t.UTC().Format(tsLayout) }

// NewToken returns a fresh 256-bit random session token (base64url) and the SHA-256 fingerprint
// that is the only thing the database stores (REQ_AUTH_008).
func NewToken() (token, id string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

// HashToken is the SHA-256 fingerprint stored as sessions.id.
func HashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// hostOf is the connection's address without the port. X-Forwarded-For is deliberately never read
// (REQ_AUTH_017).
func hostOf(remoteAddr string) string {
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return h
	}
	return remoteAddr
}

// normalizeUsername is the one way a typed username is read: surrounding space dropped, case
// folded. The limiter keys on it; the database lookup uses the trimmed name with the column's
// NOCASE collation, so " Admin" and "admin " are the same user to both.
func normalizeUsername(name string) string { return strings.ToLower(strings.TrimSpace(name)) }

// validLoginName rejects what no stored username can be (empty, over 64 characters, control
// characters) before any limiter entry or password work exists for it.
func validLoginName(name string) bool {
	name = strings.TrimSpace(name)
	return name != "" && utf8.RuneCountInString(name) <= maxUsername && strings.IndexFunc(name, unicode.IsControl) < 0
}

func limiterUserKey(name string) string {
	h := sha256.Sum256([]byte(normalizeUsername(name)))
	return "user:" + hex.EncodeToString(h[:])
}

// Login checks the credentials and starts a session. remoteAddr is r.RemoteAddr. The attempt is
// counted against the address and the username before the password is hashed (so a parallel burst
// cannot exceed the limit), at most maxVerifies checks run at once, and an unknown user costs the
// same hashing work as a known one, so timing does not reveal which usernames exist.
func (s *Service) Login(ctx context.Context, remoteAddr, username, password string) (*User, string, error) {
	if !validLoginName(username) {
		slog.InfoContext(ctx, "auth: login failed", "ip", hostOf(remoteAddr), "reason", "invalid_username")
		return nil, "", ErrInvalidCredentials
	}
	name := strings.TrimSpace(username)
	ik, uk := "ip:"+hostOf(remoteAddr), limiterUserKey(name)
	now := s.now()
	if !s.lim.reserve(now, ik, uk) {
		slog.WarnContext(ctx, "auth: login refused, locked out", "ip", hostOf(remoteAddr))
		return nil, "", ErrLocked
	}
	u := &User{}
	var hash string
	var disabled bool
	err := s.db.QueryRowContext(ctx, `SELECT id, username, role, password_hash, disabled FROM users WHERE username = ?`, name).
		Scan(&u.ID, &u.Username, &u.Role, &hash, &disabled)
	found := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.lim.refund(ik, uk)
		return nil, "", err
	}
	if !found {
		hash = s.dummy
	}
	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		s.lim.refund(ik, uk)
		return nil, "", ctx.Err()
	}
	defer func() { <-s.sem }()
	ok, verr := s.verify(password, hash)
	if verr != nil {
		slog.ErrorContext(ctx, "auth: stored password hash is malformed", "err", verr)
	}
	if !found || disabled || !ok {
		reason := "wrong_password"
		if !found {
			reason = "unknown_user"
		} else if disabled {
			reason = "disabled"
		}
		slog.InfoContext(ctx, "auth: login failed", "ip", hostOf(remoteAddr), "reason", reason)
		return nil, "", ErrInvalidCredentials
	}
	if NeedsRehash(hash, s.params) {
		s.rehash(ctx, u.ID, hash, password)
	}
	token, id, err := NewToken()
	if err != nil {
		s.lim.refund(ik, uk)
		return nil, "", err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO sessions(id, user_id, expires_at, created_at) VALUES (?,?,?,?)`,
		id, u.ID, s.stamp(now.Add(s.ttl)), s.stamp(now)); err != nil {
		s.lim.refund(ik, uk)
		return nil, "", err
	}
	s.lim.refund(ik) // a success is not a failed attempt for the address ...
	s.lim.clear(uk)  // ... and forgives the username entirely
	slog.InfoContext(ctx, "auth: login ok", "user_id", u.ID, "username", u.Username)
	return u, token, nil
}

// rehash replaces a stored hash made with older cost settings, now that the password is known. It
// only writes if the hash is still the one that was verified, and a failure never fails the login.
func (s *Service) rehash(ctx context.Context, userID int64, old, password string) {
	h, err := HashPasswordWith(password, s.params)
	if err == nil {
		_, err = s.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`, h, userID, old)
	}
	if err != nil {
		slog.WarnContext(ctx, "auth: password re-hash failed, login continues", "user_id", userID, "err", err)
		return
	}
	slog.InfoContext(ctx, "auth: password re-hashed with the current cost settings", "user_id", userID)
}

// Logout deletes the session behind token; an unknown or empty token is not an error.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, HashToken(token))
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	slog.InfoContext(ctx, "auth: logout", "session_deleted", n > 0)
	return nil
}

// Authenticate is the single seam every protected request goes through (REQ_AUTH_003): replacing
// the password check with single sign-on means replacing this function. It returns ErrNoSession
// when the request has no usable session. A session in the last half of its life is extended
// (REQ_AUTH_009); User.Slid then tells the caller to re-set the cookie.
func (s *Service) Authenticate(r *http.Request) (*User, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, ErrNoSession
	}
	id := HashToken(c.Value)
	u := &User{}
	var expires string
	var disabled bool
	err = s.db.QueryRowContext(r.Context(), `SELECT u.id, u.username, u.role, u.disabled, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, id).Scan(&u.ID, &u.Username, &u.Role, &disabled, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, err
	}
	exp, perr := time.Parse(tsLayout, expires)
	now := s.now()
	if perr != nil || disabled || !now.Before(exp) {
		return nil, ErrNoSession
	}
	if exp.Sub(now) < s.ttl/2 {
		if _, err := s.db.ExecContext(r.Context(), `UPDATE sessions SET expires_at = ? WHERE id = ?`, s.stamp(now.Add(s.ttl)), id); err != nil {
			return nil, err
		}
		u.slid = true
		slog.DebugContext(r.Context(), "auth: session extended", "user_id", u.ID)
	}
	return u, nil
}

// Cleanup deletes expired sessions and forgets stale login-failure counters.
func (s *Service) Cleanup(ctx context.Context) {
	now := s.now()
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, s.stamp(now))
	if err != nil {
		slog.ErrorContext(ctx, "auth: expired-session cleanup failed", "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		slog.InfoContext(ctx, "auth: expired sessions removed", "count", n)
	}
	s.lim.prune(now)
}

// CleanupLoop runs Cleanup every interval until ctx ends.
func (s *Service) CleanupLoop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Cleanup(ctx)
		}
	}
}

type ctxKey struct{}

// ContextWithUser carries the authenticated user down the request (REQ_AUD_020 reads it).
func ContextWithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, ctxKey{}, u)
}

// UserFromContext returns the authenticated user, or nil.
func UserFromContext(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKey{}).(*User)
	return u
}
