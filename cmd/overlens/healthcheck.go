package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/andrejad/overlens/internal/config"
)

// healthTimeout bounds the whole check; a variable so tests can shorten it.
var healthTimeout = 3 * time.Second

// healthcheck is `overlens -healthcheck` (REQ_DEPLOY_009): the distroless image has no shell, curl or
// wget, so the container's HEALTHCHECK runs the binary itself. It asks GET /health on 127.0.0.1 at the
// configured port and returns 0 on a 200, else 1. It prints nothing except one line to stderr on a
// failure, and writes no log file (it runs every few seconds).
func healthcheck(ctx context.Context, confPath string, getenv func(string) string, stderr io.Writer) int {
	cfg, err := config.Load(confPath, getenv)
	if err != nil {
		fmt.Fprintln(stderr, "healthcheck: "+err.Error())
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	url := fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		fmt.Fprintln(stderr, "healthcheck:", err)
		return 1
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(stderr, "healthcheck: %s answered %s\n", url, resp.Status)
		return 1
	}
	slog.Debug("healthcheck: ok", "url", url)
	return 0
}
