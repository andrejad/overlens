package api

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
)

type storageInfo struct {
	Version        string `json:"version"`
	BuildTime      string `json:"build_time"`
	Commit         string `json:"commit"`
	DBBytes        int64  `json:"db_bytes"`
	LogBytes       int64  `json:"log_bytes"`
	LogFiles       int    `json:"log_files"`
	DiskFreeBytes  int64  `json:"disk_free_bytes"`
	DiskTotalBytes int64  `json:"disk_total_bytes"`
}

// storage reports the running build (REQ_DEPLOY_010), the database size, the size of every log file and the disk space; it only reads (REQ_API_053).
func (a *API) storage(w http.ResponseWriter, r *http.Request) {
	out := storageInfo{Version: a.version, BuildTime: a.buildTime, Commit: a.commit}
	if fi, err := os.Stat(a.dbPath); err == nil {
		out.DBBytes = fi.Size()
	} else {
		slog.WarnContext(r.Context(), "api: storage: cannot stat database", "err", err)
	}
	// The logger writes app.log and YYYY-MM-DD-app.log (internal/logging); a test prefix sits before "app".
	files, err := filepath.Glob(filepath.Join(a.logDir, "*app*.log"))
	if err != nil {
		slog.WarnContext(r.Context(), "api: storage: cannot list logs", "err", err)
	}
	for _, f := range files {
		if fi, err := os.Stat(f); err == nil && fi.Mode().IsRegular() {
			out.LogBytes += fi.Size()
			out.LogFiles++
		}
	}
	free, total, err := diskSpace(filepath.Dir(a.dbPath))
	if err != nil {
		slog.WarnContext(r.Context(), "api: storage: cannot read disk space", "err", err)
	}
	out.DiskFreeBytes, out.DiskTotalBytes = free, total
	slog.InfoContext(r.Context(), "api: storage", "db_bytes", out.DBBytes, "log_bytes", out.LogBytes, "log_files", out.LogFiles)
	writeJSON(w, r, http.StatusOK, out)
}
