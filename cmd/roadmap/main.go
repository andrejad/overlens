// Command roadmap is the Overlens server (REQ_OVR_014: the program keeps its name). Phase 1: config, database, /health.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	erm "github.com/andrejad/overlens"
	"github.com/andrejad/overlens/internal/api"
	"github.com/andrejad/overlens/internal/audit"
	"github.com/andrejad/overlens/internal/auth"
	"github.com/andrejad/overlens/internal/backup"
	"github.com/andrejad/overlens/internal/config"
	"github.com/andrejad/overlens/internal/demo"
	"github.com/andrejad/overlens/internal/logging"
	"github.com/andrejad/overlens/internal/store"
	"github.com/andrejad/overlens/internal/webui"
	webdist "github.com/andrejad/overlens/web"
)

// Stamped at build time by every Makefile build (`make run`, `make build`, `make build-linux`, `make build-windows`) and
// the Docker image (-ldflags "-X main.version=..."), REQ_DEPLOY_010. A plain `go build` leaves the defaults.
var (
	version   = "dev"
	buildTime = "unknown"
	commit    = "unknown"
)

// ensureSample is demo.EnsureSample; a seam so a test can make the sample fail (REQ_DEMO_005).
var ensureSample = demo.EnsureSample

func versionLine() string {
	return fmt.Sprintf("roadmap %s (built %s, commit %s)", version, buildTime, commit)
}

func main() {
	confPath := flag.String("config", "", "path to roadmap.conf (default: beside the binary)")
	showVersion := flag.Bool("version", false, "print the version, build time and commit, then exit")
	devData := flag.String("dev-data", "", "load this development company file (dev/company.json) into the development database, then exit")
	reset := flag.Bool("reset", false, "with -dev-data: wipe the database first (asks you to type yes)")
	health := flag.Bool("healthcheck", false, "ask this server's own /health on the configured port; exit 0 on 200, 1 otherwise (for the container)")
	flag.Parse()
	if *showVersion {
		fmt.Println(versionLine())
		return
	}
	if *confPath == "" {
		*confPath = filepath.Join(exeDir(), "roadmap.conf")
	} else if err := explicitConfigExists(*confPath); err != nil {
		// REQ_DEPLOY_011: only the default file may be missing; a path given with -config that does not exist is a typo
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *health {
		stop() // os.Exit skips defers; the signal handler is not needed for a short check
		os.Exit(healthcheck(context.Background(), *confPath, os.Getenv, os.Stderr))
	}
	if *devData != "" {
		os.Exit(runDevData(ctx, *confPath, *devData, *reset, os.Getenv, os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(run(ctx, *confPath, os.Getenv, os.Stderr))
}

// exeDir is the directory of the running binary; roadmap.conf and the fallback log live there.
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		slog.Error("cannot locate the binary", "err", err)
		return "."
	}
	return filepath.Dir(exe)
}

// fallbackLogDir is where config failures are logged when the config's log_dir is unknown.
// A variable so tests can point it at a temp directory.
var fallbackLogDir = func() string { return filepath.Join(exeDir(), "logs") }

// run returns the process exit code. It validates the config before touching the database. getenv
// is the only source of environment settings (os.Getenv in production).
func run(ctx context.Context, confPath string, getenv func(string) string, stderr io.Writer) int {
	cfg, err := config.Load(confPath, getenv)
	if err != nil {
		failConfig(confPath, getenv, err, stderr)
		return 1
	}
	closeLog, err := logging.Setup(cfg.LogDir, getenv("LOG_PREFIX"), cfg.LogLevel, os.Stdout)
	if err != nil {
		fmt.Fprintln(stderr, "ERROR cannot set up logging:", err)
		return 1
	}
	defer closeLog()
	slog.Info("starting", "version", version, "build_time", buildTime, "commit", commit)
	cfg.LogSummary(confPath)

	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
		slog.Error("cannot create database directory", "err", err)
		return 1
	}
	db, err := store.Open(cfg.DBPath)
	if err == nil {
		err = store.Converge(db, erm.Schema)
	}
	if err != nil {
		slog.Error("cannot open database", "path", cfg.DBPath, "err", err)
		return 1
	}
	defer db.Close()

	authSvc := auth.New(db, auth.Options{TTL: time.Duration(cfg.SessionTTLDays) * 24 * time.Hour})
	// REQ_AUTH_004: only an empty users table gets the config's admin; any existing user means nothing happens.
	firstAdmin, err := authSvc.Bootstrap(ctx, cfg.BootstrapAdminUser, cfg.BootstrapAdminPassword)
	if err != nil {
		slog.Error("cannot create the bootstrap admin", "err", err)
		return 1
	}
	authSvc.Cleanup(ctx)
	auditW := audit.New(db)
	// REQ_DEMO_005: a fresh, empty installation gets the small sample company, once. A failure is
	// logged and does not stop the server: the sample is a convenience, not a requirement to run.
	if _, err := ensureSample(ctx, db, cfg.SampleData, time.Now(), func(ctx context.Context, action string, details map[string]any) error {
		return auditW.Record(ctx, api.AuditEntry{Action: action, EntityType: "system", Details: details})
	}); err != nil {
		slog.Error("sample company was not created", "err", err)
	}
	// Background goroutines (session cleanup here, the backup scheduler further down) share one
	// WaitGroup. The defers run in reverse: stopBg cancels them, bg.Wait waits for them, and only
	// then does db.Close() (deferred above) run, so nothing ever touches a closed database.
	bgCtx, stopBg := context.WithCancel(ctx)
	var bg sync.WaitGroup
	defer bg.Wait()
	defer stopBg()
	bg.Add(1)
	go func() { defer bg.Done(); authSvc.CleanupLoop(bgCtx, time.Hour) }()

	r := chi.NewRouter()
	// Recover sits inside logging.Middleware so the request id it logs a panic with is already in
	// the request's context (REQ_API_004: even a panic answers the one standard JSON error shape).
	r.Use(logging.Middleware, api.Recover)
	r.Get("/health", api.Health(db, version)) // REQ_DEPLOY_009: no login, no session lookup
	// closed once the scheduler has logged its start-up lines (REQ_DEPLOY_017)
	schedReady := make(chan struct{})
	bk := backup.New(db, backup.Options{
		Enabled: cfg.BackupEnabled, Dir: cfg.BackupDir, Time: cfg.BackupTime, KeepDays: cfg.BackupKeepDays,
		RetentionDays: cfg.AuditRetentionDays,
		Ready:         func() { close(schedReady) },
		// Entries the scheduler makes carry no user in their context, so they are recorded as `system` (REQ_AUD_020).
		Record: func(ctx context.Context, action string, details map[string]any) error {
			return auditW.Record(ctx, api.AuditEntry{Action: action, EntityType: "system", Details: details})
		},
	})
	api.New(db, auditW, api.WithAuth(authSvc), api.WithAuditRetention(cfg.AuditRetentionDays), api.WithCookieSecure(cfg.CookieSecure == "true"), api.WithStoragePaths(cfg.DBPath, cfg.LogDir), api.WithMCP(cfg.MCPEnabled, version), api.WithBuild(version, buildTime, commit)).Register(r)
	// Mounted after /api and /health so it never shadows either (REQ_OVR_008): it only fires as the
	// router's fallback for a path nothing else claimed.
	distRoot, err := fs.Sub(webdist.Dist, "dist")
	if err != nil {
		slog.Error("cannot open embedded frontend", "err", err)
		return 1
	}
	webui.Register(r, distRoot)
	srv := newServer(r)
	// Bind before logging "listening", so that line is only ever true (a failed bind — port in use,
	// no permission — is reported as the startup error it is, not a false "listening").
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.Port))
	if err != nil {
		slog.Error("cannot bind to port", "port", cfg.Port, "err", err)
		return 1
	}
	// The scheduler goroutine (backup, prune, audit purge) joins the same WaitGroup as the session
	// cleanup, so it too is waited for after the server has drained and before db.Close().
	bg.Add(1)
	go func() { defer bg.Done(); bk.Run(bgCtx) }()
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	slog.Info("server listening", "port", cfg.Port)

wait:
	for {
		select {
		case <-schedReady:
			// REQ_DEPLOY_017: the last start-up output is where to open the app; to the window only, not the log file
			admin := ""
			if firstAdmin {
				admin = cfg.BootstrapAdminUser
			}
			fmt.Fprint(os.Stdout, startMessage(cfg.Port, admin))
			slog.Debug("start-up message shown", "first_admin", firstAdmin)
			schedReady = nil // a nil channel never fires again
		case err := <-errc:
			slog.Error("server failed", "err", err)
			return 1
		case <-ctx.Done():
			break wait
		}
	}
	slog.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("graceful shutdown failed", "err", err)
		return 1
	}
	slog.Info("stopped")
	return 0
}

// newServer builds the HTTP server with every timeout set (REQ_OVR_013), so a slow or stalled client can't
// hold a connection open: headers within 10s, the whole request within 30s, the whole answer within 60s
// (generous for the largest CSV download), and an idle keep-alive connection is closed after 120s.
func newServer(h http.Handler) *http.Server {
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	slog.Debug("http server timeouts", "read_header", srv.ReadHeaderTimeout, "read", srv.ReadTimeout, "write", srv.WriteTimeout, "idle", srv.IdleTimeout)
	return srv
}

// failConfig writes one ERROR line to stderr and to the log file: in the config's own log_dir when
// it can be read from the file, else in a fallback beside the binary. Never a cwd-relative path.
func failConfig(confPath string, getenv func(string) string, err error, stderr io.Writer) {
	fmt.Fprintln(stderr, "ERROR "+err.Error())
	dir := config.PeekLogDir(confPath, getenv)
	if dir == "" {
		dir = fallbackLogDir()
	}
	closeLog, lerr := logging.Setup(dir, getenv("LOG_PREFIX"), "ERROR", io.Discard)
	if lerr != nil {
		fmt.Fprintln(stderr, "ERROR cannot write the log file:", lerr)
		return
	}
	slog.Error(err.Error(), "config", confPath, "log_dir", dir)
	closeLog()
}

// explicitConfigExists refuses a -config path that is not there. config.Load tolerates a missing file so a
// container can run on ROADMAP_* variables alone, but a path the operator typed must not be ignored silently.
func explicitConfigExists(path string) error {
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("config file %q given with -config does not exist", path)
	}
	return nil
}

// startMessage is the framed note the program ends its start-up with (REQ_DEPLOY_017): an empty line, then where to open
// Overlens and how to stop it; after the first start also whom to log in as (never the password). The frame is ASCII,
// so a Windows console in any code page draws it; widths count characters, not bytes.
func startMessage(port int, firstAdmin string) string {
	lines := []string{"Overlens is running.", "", "Open in your browser:", fmt.Sprintf("    http://localhost:%d", port), ""}
	if firstAdmin != "" {
		lines = append(lines, fmt.Sprintf("First start: log in as %q with the password", firstAdmin), "from roadmap.conf, then change it (account menu).", "")
	}
	lines = append(lines, "Keep this window open.", "Press Ctrl+C to stop Overlens.")
	w := 0
	for _, l := range lines {
		w = max(w, utf8.RuneCountInString(l)) // a username may hold any Unicode letter
	}
	rule := "  +" + strings.Repeat("-", w+4) + "+\n"
	var b strings.Builder
	b.WriteString("\n" + rule)
	for _, l := range lines {
		b.WriteString("  |  " + l + strings.Repeat(" ", w-utf8.RuneCountInString(l)) + "  |\n")
	}
	b.WriteString(rule + "\n")
	return b.String()
}
