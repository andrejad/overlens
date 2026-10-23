// Package logging sets up slog: a daily-rolling file plus the console, and an X-Request-Id on
// every request line (REQ_CFG_008/009).
package logging

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ctxKey struct{}

// RequestID returns the request id carried by ctx, or "".
func RequestID(ctx context.Context) string { s, _ := ctx.Value(ctxKey{}).(string); return s }

// idHandler adds the request id from the context to every record.
type idHandler struct{ slog.Handler }

func (h idHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}
func (h idHandler) WithAttrs(a []slog.Attr) slog.Handler { return idHandler{h.Handler.WithAttrs(a)} }
func (h idHandler) WithGroup(n string) slog.Handler      { return idHandler{h.Handler.WithGroup(n)} }

// dailyFile writes to <dir>/<prefix>app.log and, when the local date changes, renames the finished
// file to <dir>/YYYY-MM-DD-<prefix>app.log and starts a new one.
type dailyFile struct {
	mu          sync.Mutex
	dir, prefix string
	now         func() time.Time
	f           *os.File
	day         string
}

func (d *dailyFile) path() string { return filepath.Join(d.dir, d.prefix+"app.log") }

func (d *dailyFile) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	today := d.now().Format("2006-01-02")
	if d.f != nil && d.day != today {
		d.f.Close()
		d.f = nil
		d.roll()
	}
	if d.f == nil {
		f, err := os.OpenFile(d.path(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return 0, err
		}
		d.f, d.day = f, today
	}
	return d.f.Write(p)
}

// maxRollAttempts bounds the search for a free numbered name; a non-ENOENT Stat error (e.g.
// permission denied) must never spin forever.
const maxRollAttempts = 1000

// roll renames the finished file to its dated name, never overwriting an earlier rolled file (a
// numbered name is used instead). Failures go to stderr, never through slog: roll runs inside
// dailyFile.Write with d.mu held, and slog's own handler writes back through this same Write —
// calling slog here would re-enter Write and deadlock on d.mu. On failure the old file simply keeps
// receiving lines.
func (d *dailyFile) roll() {
	to := filepath.Join(d.dir, d.day+"-"+d.prefix+"app.log")
	found := false
	for n := 2; n <= maxRollAttempts; n++ {
		_, err := os.Stat(to)
		if os.IsNotExist(err) {
			found = true
			break
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR logging: roll gave up, could not stat candidate name %s: %v\n", to, err)
			return
		}
		to = filepath.Join(d.dir, fmt.Sprintf("%s-%sapp.%d.log", d.day, d.prefix, n))
	}
	if !found {
		// Every numbered name up to maxRollAttempts is taken (or the last one was never actually
		// confirmed free): never guess and overwrite it — skip the roll, the old file keeps growing.
		fmt.Fprintf(os.Stderr, "ERROR logging: roll gave up, no free numbered name found under %d attempts for %s\n", maxRollAttempts, to)
		return
	}
	if err := os.Rename(d.path(), to); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR log roll failed: %v\n", err)
	}
}

// Setup installs the default slog logger writing to the daily file and out (the console). prefix is
// LOG_PREFIX (tests set "test" so they never write to the real app.log). The returned func closes the file.
func Setup(dir, prefix, level string, out io.Writer) (func(), error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if prefix != "" {
		prefix += "-"
	}
	// An existing app.log from an earlier day is rolled on the first write via its modification date.
	d := &dailyFile{dir: dir, prefix: prefix, now: time.Now}
	if st, err := os.Stat(d.path()); err == nil {
		d.day = st.ModTime().Format("2006-01-02")
		if f, err := os.OpenFile(d.path(), os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			d.f = f
		}
	}
	var lv slog.Level
	lv.UnmarshalText([]byte(level))
	h := slog.NewTextHandler(io.MultiWriter(d, out), &slog.HandlerOptions{Level: lv})
	slog.SetDefault(slog.New(idHandler{h}))
	return func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.f != nil {
			d.f.Close()
		}
	}, nil
}

// maxBodyLogChars is the cutoff for the DEBUG-level request/response body summaries (REQ_CFG_009).
const maxBodyLogChars = 1000

// requestIDRe is what a client-supplied X-Request-Id must look like to be reused instead of
// replaced: at most 64 characters of [A-Za-z0-9._-] — anything else (too long, spaces, control
// characters, an attempt to inject something into the log line) gets a fresh generated id instead.
var requestIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// Middleware assigns (or reuses) an X-Request-Id, puts it in the context and logs method, path,
// status and duration for every request. At DEBUG level it also logs a request/response body
// summary, cut to about 1000 characters; /api/login's bodies are logged redacted, never the
// credentials themselves (REQ_CFG_009, REQ_CFG_010).
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !requestIDRe.MatchString(id) {
			b := make([]byte, 8)
			rand.Read(b)
			id = hex.EncodeToString(b)
		}
		w.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(r.Context(), ctxKey{}, id)

		debug := slog.Default().Enabled(ctx, slog.LevelDebug)
		// Body summaries are only ever built for paths that are not redacted, and from a copy of just
		// the first bytes the handler itself reads; the handler gets the body unchanged and the
		// middleware never buffers it whole (a 4 MiB body costs about 1 KiB of logging memory).
		wantBody := debug && !isLoginPath(r.URL.Path)
		var reqBody *captureBody
		if wantBody && r.Body != nil {
			reqBody = &captureBody{ReadCloser: r.Body}
			r.Body = reqBody
		}

		sw := &statusWriter{ResponseWriter: w, status: 200, capture: wantBody}
		start := time.Now()
		next.ServeHTTP(sw, r.WithContext(ctx))
		// The container's health check calls /health every few seconds: its line is DEBUG, not INFO
		// (REQ_DEPLOY_009), so it does not drown the log.
		lvl := slog.LevelInfo
		if r.URL.Path == "/health" {
			lvl = slog.LevelDebug
		}
		slog.Log(ctx, lvl, "request", "method", r.Method, "path", r.URL.Path, "status", sw.status,
			"duration_ms", time.Since(start).Milliseconds())
		if debug {
			var reqSummary []byte
			if reqBody != nil {
				reqSummary = reqBody.buf.Bytes()
			}
			slog.DebugContext(ctx, "request body", "method", r.Method, "path", r.URL.Path, "body", bodySummary(r.URL.Path, reqSummary))
			slog.DebugContext(ctx, "response body", "method", r.Method, "path", r.URL.Path, "body", bodySummary(r.URL.Path, sw.body.Bytes()))
		}
	})
}

// isLoginPath reports whether path carries credentials, so its request and response bodies are never
// logged even at DEBUG level (REQ_CFG_010, REQ_AUTH_018): /api/login, and every password-bearing
// user path (/api/users, /api/users/{id}). Cookie and Set-Cookie headers are never logged at all —
// the middleware only ever logs method, path, status and these body summaries.
func isLoginPath(path string) bool {
	return path == "/api/login" || path == "/api/users" || strings.HasPrefix(path, "/api/users/")
}

func bodySummary(path string, body []byte) string {
	if isLoginPath(path) {
		return "[redacted: " + path + "]"
	}
	s := string(body)
	if len(s) > maxBodyLogChars {
		s = s[:maxBodyLogChars] + "...(truncated)"
	}
	return s
}

// captureBody passes reads through and keeps a copy of the first maxBodyLogChars+1 bytes (one more
// than shown, so bodySummary can tell the body was longer).
type captureBody struct {
	io.ReadCloser
	buf bytes.Buffer
}

func (c *captureBody) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	if room := maxBodyLogChars + 1 - c.buf.Len(); room > 0 && n > 0 {
		c.buf.Write(p[:min(n, room)])
	}
	return n, err
}

type statusWriter struct {
	http.ResponseWriter
	status  int
	capture bool
	body    bytes.Buffer
}

// Unwrap lets http.ResponseController reach the real writer (write deadlines, flushing).
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusWriter) WriteHeader(c int) { s.status = c; s.ResponseWriter.WriteHeader(c) }

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.capture && s.body.Len() < maxBodyLogChars {
		remain := maxBodyLogChars - s.body.Len()
		if remain > len(b) {
			remain = len(b)
		}
		s.body.Write(b[:remain])
	}
	return s.ResponseWriter.Write(b)
}
