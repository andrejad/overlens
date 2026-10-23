// Package api holds the chi handlers for the JSON API described in docs/API.md.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/store"
)

// AuditEntry is what a handler reports for one mutating request. Names are included at write time
// so the entry stays readable after the thing it describes is renamed or deleted.
type AuditEntry struct {
	Action     string // e.g. deliverable.move
	EntityType string
	EntityID   int64
	RoadmapID  int64
	Details    map[string]any
}

// Auditor is the audit seam; internal/audit holds the real writer, which reads the acting admin
// from the request context (REQ_AUD_020). Record returns an error so a failed write is never
// silent; the store change it describes has already been committed, so the handler does not roll
// anything back — it only makes the failure visible (REQ_AUD_001, REQ_AUD_018).
type Auditor interface {
	Record(ctx context.Context, e AuditEntry) error
}

type NopAudit struct{}

func (NopAudit) Record(context.Context, AuditEntry) error { return nil }

type API struct {
	DB    *sql.DB
	Audit Auditor
	Auth  *auth.Service

	// AuditRetentionDays is audit_retention_days from the config; GET /api/admin/audit reports it (REQ_AUD_008).
	AuditRetentionDays int

	// CookieSecure forces the Secure flag on the session cookie (config cookie_secure: true).
	CookieSecure bool

	// dbPath and logDir are what GET /api/admin/storage measures (REQ_API_053).
	dbPath, logDir string

	// now is the clock for "today" in the attention list (REQ_API_054); time.Now unless a test sets it.
	now func() time.Time

	// mcpOn and version switch /mcp on and name the server in its handshake (REQ_API_056/057, REQ_CFG_013).
	mcpOn   bool
	version string
	// buildTime and commit, with version, are the running build that GET /api/admin/storage reports (WithBuild).
	buildTime, commit string
}

// WithStoragePaths supplies the database file and the log folder for GET /api/admin/storage (REQ_API_053).
func WithStoragePaths(dbPath, logDir string) Option {
	return func(a *API) { a.dbPath, a.logDir = dbPath, logDir }
}

// WithClock replaces the clock that decides what "today" is for the attention list (a test seam).
func WithClock(now func() time.Time) Option { return func(a *API) { a.now = now } }

// WithMCP switches the MCP endpoint at /mcp on or off (config mcp_enabled); version is the app version
// the server reports in its handshake.
func WithMCP(on bool, version string) Option {
	return func(a *API) { a.mcpOn, a.version = on, version }
}

// WithBuild supplies the running build for GET /api/admin/storage (REQ_API_053, REQ_DEPLOY_010).
func WithBuild(version, buildTime, commit string) Option {
	return func(a *API) { a.version, a.buildTime, a.commit = version, buildTime, commit }
}

// WithAuditRetention supplies audit_retention_days for the audit list's retention_days (REQ_AUD_008).
func WithAuditRetention(days int) Option { return func(a *API) { a.AuditRetentionDays = days } }

// WithCookieSecure sets the Secure flag on every session cookie, whatever the connection (REQ_DEPLOY_013).
func WithCookieSecure(on bool) Option { return func(a *API) { a.CookieSecure = on } }

// Option customises New.
type Option func(*API)

// WithAuth supplies the auth service (the session TTL from the config, or a test clock). Without
// it New builds one with the default TTL on the real clock.
func WithAuth(s *auth.Service) Option { return func(a *API) { a.Auth = s } }

func New(db *sql.DB, a Auditor, opts ...Option) *API {
	if a == nil {
		a = NopAudit{}
	}
	api := &API{DB: db, Audit: a, now: time.Now}
	for _, o := range opts {
		o(api)
	}
	if api.Auth == nil {
		api.Auth = auth.New(db, auth.Options{})
	}
	return api
}

// Recover turns a panic anywhere below it into the standard JSON 500 (REQ_API_004) instead of a bare
// dropped connection, and logs it as an ERROR with the request id. It must sit inside
// logging.Middleware in the chain (mounted after it with r.Use) so the request id is already in the
// context by the time a handler panics.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				slog.ErrorContext(r.Context(), "api: panic recovered", "method", r.Method, "path", r.URL.Path, "panic", p)
				writeError(w, r, http.StatusInternalServerError, "internal", "Something went wrong on the server", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// jsonOnly answers 415 unless every write (POST/PATCH/PUT/DELETE) sends Content-Type: application/json
// — even one with no body (e.g. a DELETE). A plain HTML form can't set this
// header, so with SameSite=Lax this is the app's CSRF defence (REQ_API_003, spec §8).
func jsonOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
			slog.InfoContext(r.Context(), "api: non-JSON write refused", "content_type", r.Header.Get("Content-Type"))
			writeError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "Send Content-Type: application/json, even for a request with no body", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Register mounts every /api route on r.
func (a *API) Register(root chi.Router) {
	a.mountMCP(root)
	root.Route("/api", func(r chi.Router) {
		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			slog.InfoContext(r.Context(), "api: unknown path", "path", r.URL.Path)
			writeError(w, r, http.StatusNotFound, "not_found", "No such endpoint", nil)
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
			slog.InfoContext(r.Context(), "api: method not allowed", "method", r.Method, "path", r.URL.Path)
			writeError(w, r, http.StatusMethodNotAllowed, "bad_request", "Method not allowed for this endpoint", nil)
		})
		r.Get("/teams", a.listTeams)
		r.Get("/teams/{id}", a.getTeam)
		r.Get("/roadmaps/{id}", a.getRoadmap)
		r.Get("/deliverables/{id}", a.getDeliverable)
		r.Get("/icons", a.getIcons)
		r.Get("/deliverables/{id}/dependencies", a.listDependencies(store.KindDeliverable))
		r.Get("/deliverables/{id}/dependency-candidates", a.dependencyCandidates(store.KindDeliverable))
		r.Get("/milestones/{id}/dependencies", a.listDependencies(store.KindMilestone))
		r.Get("/milestones/{id}/dependency-candidates", a.dependencyCandidates(store.KindMilestone))
		r.Get("/me", a.me)
		r.Get("/company/roadmaps", a.companyRoadmaps)
		r.Get("/company/team-order", a.getTeamOrder)
		r.Get("/company/workstream-order", a.getWorkstreamOrder)
		r.Get("/company/dependencies", a.companyDependencies)
		r.Get("/company/trace/{kind}/{id}", a.companyTraceItem)
		r.Get("/company/attention", a.companyAttention)
		r.Get("/roadmaps/{id}/export.csv", a.exportCSV)

		// Anonymous writes: they carry no roadmap data, so no session is needed — but they still need
		// Content-Type: application/json (REQ_API_003).
		r.Group(func(r chi.Router) {
			r.Use(jsonOnly)
			r.Post("/login", a.login)
			r.Post("/logout", a.logout)
		})

		// Admin-only reads (the user list and /admin/*): a session, no body, so no jsonOnly.
		r.Group(func(r chi.Router) {
			r.Use(a.requireAdmin)
			r.Get("/users", a.listUsers)
			r.Get("/admin/audit", a.listAudit)
			r.Get("/admin/audit/export.csv", a.exportAuditCSV)
			r.Get("/admin/storage", a.storage)
		})

		r.Group(func(r chi.Router) {
			r.Use(a.requireAdmin, jsonOnly)
			r.Post("/users", a.createUser)
			r.Patch("/users/{id}", a.updateUser)

			r.Post("/teams", a.createTeam)
			r.Patch("/teams/{id}", a.updateTeam)
			r.Delete("/teams/{id}", a.deleteTeam)

			r.Patch("/roadmaps/{id}", a.renameRoadmap)

			r.Post("/roadmaps/{id}/workstreams", a.createWorkstream)
			r.Put("/roadmaps/{id}/workstreams/order", a.reorderWorkstreams)
			r.Patch("/workstreams/{id}", a.renameWorkstream)
			r.Delete("/workstreams/{id}", a.deleteWorkstream)

			r.Post("/roadmaps/{id}/deliverables", a.createDeliverable)
			r.Patch("/deliverables/{id}", a.updateDeliverable)
			r.Delete("/deliverables/{id}", a.deleteDeliverable)
			r.Post("/deliverables/{id}/move", a.moveItem(store.KindDeliverable))

			r.Post("/roadmaps/{id}/milestones", a.createMilestone)
			r.Patch("/milestones/{id}", a.updateMilestone)
			r.Post("/milestones/{id}/move", a.moveItem(store.KindMilestone))
			r.Delete("/milestones/{id}", a.deleteMilestone)

			r.Put("/icons/{key}", a.putIconLabel)

			r.Put("/company/team-order", a.putTeamOrder)
			r.Put("/company/workstream-order", a.putWorkstreamOrder)

			r.Post("/deliverables/{id}/dependencies", a.addDependency(store.KindDeliverable))
			r.Delete("/deliverables/{id}/dependencies/{fromKind}/{fromId}", a.removeDependency(store.KindDeliverable))
			r.Post("/milestones/{id}/dependencies", a.addDependency(store.KindMilestone))
			r.Delete("/milestones/{id}/dependencies/{fromKind}/{fromId}", a.removeDependency(store.KindMilestone))
		})
	})
}

type errBody struct {
	Error struct {
		Code    string            `json:"code"`
		Message string            `json:"message"`
		Fields  map[string]string `json:"fields,omitempty"`
		// dependency conflicts only (REQ_DEP_003/004)
		// Path is []string for a loop of deliverables only, []store.PathItem when a milestone is on it
		Path          any    `json:"path,omitempty"`
		EarliestStart string `json:"earliest_start,omitempty"`
		LatestEnd     string `json:"latest_end,omitempty"`
		// a milestone's date_order (REQ_DEP_024)
		EarliestDate string `json:"earliest_date,omitempty"`
		LatestDate   string `json:"latest_date,omitempty"`
	} `json:"error"`
}

// writeJSON encodes v as the response body. An encode failure is logged with the request's context
// (so it carries the request id), not a bare package-level slog.Error.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.ErrorContext(r.Context(), "api: writing response failed", "method", r.Method, "path", r.URL.Path, "err", err)
	}
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, msg string, fields map[string]string) {
	var b errBody
	b.Error.Code, b.Error.Message, b.Error.Fields = code, msg, fields
	writeJSON(w, r, status, b)
}

// fail maps a store error to the uniform error shape. Every refusal is logged at INFO with its
// reason (a person can read why a 4xx happened without reproducing it); anything unexpected is a
// logged ERROR and a 500.
func fail(w http.ResponseWriter, r *http.Request, err error) {
	var se *store.Error
	if errors.As(err, &se) {
		switch se.Kind {
		case store.NotFound:
			slog.InfoContext(r.Context(), "api: not found", "path", r.URL.Path, "reason", se.Msg)
			writeError(w, r, http.StatusNotFound, "not_found", se.Msg, nil)
		case store.Invalid:
			slog.InfoContext(r.Context(), "api: validation failed", "path", r.URL.Path, "code", se.Code, "reason", se.Msg, "fields", se.Fields)
			var b errBody
			b.Error.Code, b.Error.Message, b.Error.Fields = se.Code, se.Msg, se.Fields
			writeJSON(w, r, http.StatusUnprocessableEntity, b)
		default:
			slog.InfoContext(r.Context(), "api: conflict", "path", r.URL.Path, "code", se.Code, "reason", se.Msg)
			var b errBody
			b.Error.Code, b.Error.Message = se.Code, se.Msg
			switch {
			case len(se.TypedPath) > 0:
				b.Error.Path = se.TypedPath
			case len(se.Path) > 0:
				b.Error.Path = se.Path
			}
			b.Error.EarliestStart, b.Error.LatestEnd = se.EarliestStart, se.LatestEnd
			b.Error.EarliestDate, b.Error.LatestDate = se.EarliestDate, se.LatestDate
			writeJSON(w, r, http.StatusConflict, b)
		}
		return
	}
	slog.ErrorContext(r.Context(), "api: internal error", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, r, http.StatusInternalServerError, "internal", "Something went wrong on the server", nil)
}

func badRequest(w http.ResponseWriter, r *http.Request, msg string) {
	slog.InfoContext(r.Context(), "api: bad request", "path", r.URL.Path, "reason", msg)
	writeError(w, r, http.StatusBadRequest, "bad_request", msg, nil)
}

// maxBodyBytes bounds every request body; a larger one is refused 413 before it is ever parsed.
const maxBodyBytes = 4 << 20

// decode reads and parses the JSON body of a request. An oversized body is 413; anything that isn't
// exactly one JSON value — broken JSON, or valid JSON followed by trailing data — is 400.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeLimited(w, r, v, maxBodyBytes)
}

// decodeLimited is decode with a caller-chosen size limit in bytes.
func decodeLimited(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			slog.InfoContext(r.Context(), "api: request body too large", "path", r.URL.Path, "limit", limit)
			writeError(w, r, http.StatusRequestEntityTooLarge, "bad_request", "Request body is too large", nil)
			return false
		}
		badRequest(w, r, "Request body must be valid JSON: "+err.Error())
		return false
	}
	if dec.More() { // a second JSON value (or plain garbage) after the one we just decoded
		badRequest(w, r, "Request body must be a single JSON value, with nothing after it")
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		badRequest(w, r, "The id in the address must be a positive integer")
		return 0, false
	}
	return id, true
}

// paging reads limit (default 50, max 200) and offset.
func paging(w http.ResponseWriter, r *http.Request) (limit, offset int, ok bool) {
	limit = 50
	for name, dst := range map[string]*int{"limit": &limit, "offset": &offset} {
		if s := r.URL.Query().Get(name); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 0 || (name == "limit" && n == 0) {
				badRequest(w, r, name+" must be a positive integer")
				return 0, 0, false
			}
			*dst = n
		}
	}
	return min(limit, 200), offset, true
}

type list[T any] struct {
	Items []T `json:"items"`
	Total int `json:"total"`
}

func (a *API) audit(r *http.Request, e AuditEntry) {
	slog.InfoContext(r.Context(), "api: audit", "action", e.Action, "entity_id", e.EntityID)
	// The store change this entry describes has already committed; the audit write must not be
	// skipped just because the client went away (a request context is cancelled the moment the
	// response is written/the connection drops) — context.WithoutCancel keeps the same values
	// (request id) but detaches the cancellation.
	if err := a.Audit.Record(context.WithoutCancel(r.Context()), e); err != nil {
		// There is nothing to roll back here either way. This only makes the failure visible until
		// the audit write is deliberately not part of the change's transaction (REQ_AUD_018).
		slog.ErrorContext(r.Context(), "api: audit write failed", "action", e.Action, "entity_id", e.EntityID, "err", err)
	}
}
