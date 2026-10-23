package api

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/andrejad/overlens/internal/auth"
)

// setSessionCookie sets (or, with maxAge < 0, clears) the session cookie. Secure follows the
// connection itself (r.TLS), never a forwarded header the client could forge (REQ_AUTH_008) — unless
// the config says cookie_secure: true, for a proxy that ends HTTPS in front of this plain-HTTP server
// (REQ_DEPLOY_013).
func (a *API) setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: token, Path: "/", MaxAge: maxAge,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: a.CookieSecure || r.TLS != nil,
	})
}

// session authenticates the request through the one seam (REQ_AUTH_003) and, when the session just
// slid, refreshes the cookie (REQ_AUTH_009). It returns nil for an anonymous visitor and an error
// only for a server fault.
func (a *API) session(w http.ResponseWriter, r *http.Request) (*auth.User, error) {
	u, err := a.Auth.Authenticate(r)
	if errors.Is(err, auth.ErrNoSession) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if u.Slid() {
		if c, cerr := r.Cookie(auth.CookieName); cerr == nil {
			a.setSessionCookie(w, r, c.Value, int(a.Auth.TTL().Seconds()))
		}
	}
	return u, nil
}

// requireAdmin answers 401 unless the request has a valid session of an admin, and puts that user
// in the request context for the handler and the audit writer (REQ_AUTH_002/012, REQ_AUD_020).
func (a *API) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := a.session(w, r)
		if err != nil {
			fail(w, r, err)
			return
		}
		if u == nil {
			slog.InfoContext(r.Context(), "api: unauthorized", "method", r.Method, "path", r.URL.Path)
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "Log in as an admin to do this", nil)
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.ContextWithUser(r.Context(), u)))
	})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password string }
	if !decode(w, r, &in) {
		return
	}
	u, token, err := a.Auth.Login(r.Context(), r.RemoteAddr, in.Username, in.Password)
	switch {
	case errors.Is(err, auth.ErrLocked):
		writeError(w, r, http.StatusTooManyRequests, "locked", "Too many failed attempts. Try again in 15 minutes", nil)
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeError(w, r, http.StatusUnauthorized, "invalid_credentials", "Wrong username or password", nil)
	case err != nil:
		fail(w, r, err)
	default:
		a.setSessionCookie(w, r, token, int(a.Auth.TTL().Seconds()))
		writeJSON(w, r, http.StatusOK, map[string]any{"user": u})
	}
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		if err := a.Auth.Logout(r.Context(), c.Value); err != nil {
			fail(w, r, err)
			return
		}
	}
	a.setSessionCookie(w, r, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	u, err := a.session(w, r)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"user": u}) // a nil *User encodes as null
}

// ---- users (admin) ----

func (a *API) listUsers(w http.ResponseWriter, r *http.Request) {
	items, err := a.Auth.ListUsers(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, list[auth.UserRow]{items, len(items)})
}

func (a *API) createUser(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password string }
	if !decode(w, r, &in) {
		return
	}
	u, err := a.Auth.CreateUser(r.Context(), in.Username, in.Password)
	if err != nil {
		fail(w, r, err)
		return
	}
	a.audit(r, AuditEntry{Action: "user.create", EntityType: "user", EntityID: u.ID, Details: map[string]any{"user": u.Username}})
	writeJSON(w, r, http.StatusCreated, u)
}

func (a *API) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Password *string `json:"password"`
		Disabled *bool   `json:"disabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	actor := auth.UserFromContext(r.Context())
	res, err := a.Auth.UpdateUser(r.Context(), actor.ID, id, auth.UserChange{Password: in.Password, Disabled: in.Disabled})
	if err != nil {
		fail(w, r, err)
		return
	}
	for _, action := range res.Actions { // names only, never the password or its hash (REQ_AUD_019)
		a.audit(r, AuditEntry{Action: action, EntityType: "user", EntityID: id, Details: map[string]any{"user": res.User.Username}})
	}
	writeJSON(w, r, http.StatusOK, res.User)
}
