package auth

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/andrejad/overlens/internal/store"
)

// UserRow is a user as the admin API lists it. There is no password or hash field, so one can
// never be serialised by accident (REQ_AUTH_018).
type UserRow struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	Disabled  bool   `json:"disabled"`
	CreatedAt string `json:"created_at"`
}

const maxUsername = 64

func invalid(field, reason string) error {
	return &store.Error{Kind: store.Invalid, Code: "validation_failed", Msg: field + ": " + reason, Fields: map[string]string{field: reason}}
}

func conflict(code, msg string) error {
	return &store.Error{Kind: store.Conflict, Code: code, Msg: msg}
}

// reservedUsername names the server's own audit entries (REQ_AUD_020, audit.SystemUser); no admin may be
// created under it, in any capitals (REQ_AUTH_019).
const reservedUsername = "system"

func cleanUsername(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("username", "required")
	}
	if utf8.RuneCountInString(name) > maxUsername {
		return "", invalid("username", "must be at most 64 characters")
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", invalid("username", "must not contain control characters")
	}
	return name, nil
}

func checkPassword(pw string) error {
	if !ValidatePassword(pw) {
		return invalid("password", "must be 8 to 128 characters")
	}
	return nil
}

func createdAt(s string) string {
	if t, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	return s
}

type scanner interface{ Scan(...any) error }

func scanUser(s scanner) (UserRow, error) {
	var u UserRow
	var created string
	err := s.Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &created)
	u.CreatedAt = createdAt(created)
	return u, err
}

const userCols = `id, username, role, disabled, created_at`

// ListUsers returns every user, oldest first.
func (s *Service) ListUsers(ctx context.Context) ([]UserRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserRow{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// CreateUser adds an admin (REQ_AUTH_013). The username is unique ignoring case (REQ_AUTH_014).
func (s *Service) CreateUser(ctx context.Context, username, password string) (UserRow, error) {
	name, err := cleanUsername(username)
	if err != nil {
		return UserRow{}, err
	}
	if strings.ToLower(name) == reservedUsername { // REQ_AUTH_019
		slog.InfoContext(ctx, "auth: user not created, username is reserved", "username", name)
		return UserRow{}, invalid("username", "\"system\" is reserved for the server's own audit entries")
	}
	if err := checkPassword(password); err != nil {
		return UserRow{}, err
	}
	hash, err := HashPasswordWith(password, s.params)
	if err != nil {
		return UserRow{}, err
	}
	return s.insertUser(ctx, name, hash)
}

// insertUser only inserts: the UNIQUE (NOCASE) constraint decides, so two concurrent creates of
// "Bob" and "bob" cannot both pass a check-then-insert gap; the loser gets the same 409.
func (s *Service) insertUser(ctx context.Context, name, hash string) (UserRow, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO users(username, password_hash) VALUES (?, ?)`, name, hash)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			slog.InfoContext(ctx, "auth: user not created, name already taken", "username", name)
			return UserRow{}, conflict("duplicate_name", "A user with this name already exists")
		}
		return UserRow{}, err
	}
	id, _ := res.LastInsertId()
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

// Bootstrap creates the first admin from the config when the users table is empty and does nothing
// otherwise (REQ_AUTH_004). The password is hashed at once and never logged. The config's password
// is not held to the 8–128 policy, which is for what an admin types in the app.
func (s *Service) Bootstrap(ctx context.Context, username, password string) (bool, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		slog.InfoContext(ctx, "auth: users exist, bootstrap admin not created")
		return false, nil
	}
	name, err := cleanUsername(username)
	if err != nil {
		return false, err
	}
	// REQ_AUTH_019: only when the admin would really be created, so an existing install keeps starting.
	if strings.ToLower(name) == reservedUsername {
		slog.ErrorContext(ctx, "auth: bootstrap admin not created, username is reserved", "username", name)
		return false, errors.New("bootstrap_admin_user must not be \"system\" (reserved for the server's own audit entries)")
	}
	if !ValidatePassword(password) {
		slog.WarnContext(ctx, "auth: bootstrap admin password is outside the 8 to 128 character policy (accepted for now); it should satisfy that rule, change it after the first login")
	}
	hash, err := HashPasswordWith(password, s.params)
	if err != nil {
		return false, err
	}
	u, err := s.insertUser(ctx, name, hash)
	var se *store.Error
	if errors.As(err, &se) && se.Code == "duplicate_name" { // another process won the race: nothing to do
		slog.InfoContext(ctx, "auth: bootstrap admin already exists, nothing created")
		return false, nil
	}
	if err != nil {
		return false, err
	}
	slog.InfoContext(ctx, "auth: bootstrap admin created", "user_id", u.ID, "username", u.Username)
	return true, nil
}

// UserChange is what PATCH /api/users/{id} may change; nil means "leave alone".
type UserChange struct {
	Password *string
	Disabled *bool
}

// UserUpdate is the result of UpdateUser: the user afterwards, and the audit actions that apply
// (user.password_reset, user.disable, user.enable), none for a true no-op.
type UserUpdate struct {
	User    UserRow
	Actions []string
}

// UpdateUser resets a password and/or disables or re-enables a user. A new password or a disable
// deletes all of that user's sessions (REQ_AUTH_010). Disabling yourself is self_disable and
// disabling the last active admin is last_admin (REQ_AUTH_015); re-enabling is always allowed.
func (s *Service) UpdateUser(ctx context.Context, actorID, id int64, ch UserChange) (UserUpdate, error) {
	var hash string
	// Hash before the transaction: the pool has one connection, and argon2 is slow.
	if ch.Password != nil {
		if err := checkPassword(*ch.Password); err != nil {
			return UserUpdate{}, err
		}
		h, err := HashPasswordWith(*ch.Password, s.params)
		if err != nil {
			return UserUpdate{}, err
		}
		hash = h
	}
	var out UserUpdate
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	cur, err := scanUser(tx.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return out, &store.Error{Kind: store.NotFound, Code: "not_found", Msg: "user not found"}
	}
	if err != nil {
		return out, err
	}
	kill := false
	if ch.Disabled != nil && *ch.Disabled != cur.Disabled {
		if *ch.Disabled {
			if id == actorID {
				return out, conflict("self_disable", "You can't disable your own account")
			}
			var others int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE disabled = 0 AND role = 'admin' AND id <> ?`, id).Scan(&others); err != nil {
				return out, err
			}
			if others == 0 {
				return out, conflict("last_admin", "The last active admin can't be disabled")
			}
			kill = true
			out.Actions = append(out.Actions, "user.disable")
		} else {
			out.Actions = append(out.Actions, "user.enable")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET disabled = ? WHERE id = ?`, *ch.Disabled, id); err != nil {
			return out, err
		}
		cur.Disabled = *ch.Disabled
	}
	if ch.Password != nil {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, hash, id); err != nil {
			return out, err
		}
		kill = true
		out.Actions = append(out.Actions, "user.password_reset")
	}
	if kill {
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, id); err != nil {
			return out, err
		}
	}
	if err := tx.Commit(); err != nil {
		return out, err
	}
	out.User = cur
	slog.InfoContext(ctx, "auth: user updated", "user_id", id, "actions", out.Actions, "sessions_killed", kill)
	return out, nil
}
