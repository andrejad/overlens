// Package webui serves the built frontend (web/dist, embedded by web/embed.go) with an SPA
// fallback to index.html for any path the API router doesn't otherwise know (REQ_OVR_008).
// web/dist/.gitkeep is tracked so the directory always exists for `//go:embed`, even in a fresh
// checkout before the frontend has ever been built ("make run" does not build it — see Makefile);
// in that case index.html is simply missing and Register serves a plain "not built yet" message
// instead of panicking.
package webui

import (
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Register mounts dist on root as the fallback for any path not already claimed by another route
// (e.g. /api/*, /health, both registered on root before this runs — chi tries those first). dist is
// the frontend build root (already `fs.Sub`bed past the embed's "dist" prefix by the caller), so
// tests can pass an in-memory fs.FS instead of the real embedded build.
func Register(root chi.Router, dist fs.FS) {
	fileServer := http.FileServer(http.FS(dist))
	root.NotFound(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(dist, "index.html"); err != nil {
			slog.WarnContext(r.Context(), "webui: frontend not built, serving placeholder", "path", r.URL.Path)
			http.Error(w, "Frontend not built. Run `npm run build` in web/, or use `make build`.", http.StatusNotFound)
			return
		}
		// A real file (JS/CSS/asset) is served as-is; anything else falls back to index.html so
		// client-side routing works on a hard refresh or a deep link (REQ_OVR_008).
		if _, err := fs.Stat(dist, trimLeadingSlash(r.URL.Path)); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		slog.DebugContext(r.Context(), "webui: SPA fallback to index.html", "path", r.URL.Path)
		r2 := new(http.Request)
		*r2 = *r
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	})
}

func trimLeadingSlash(p string) string {
	if len(p) > 0 && p[0] == '/' {
		return p[1:]
	}
	return p
}
