// Package webdist embeds the built frontend (dist/, produced by `npm run build`) so
// internal/webui can serve it from the Go binary (REQ_OVR_008). It has to live here, in web/, not
// in internal/webui: `//go:embed` can only reach files at or below the directory of the .go file
// that declares the directive, and dist is a sibling of this file, not of internal/webui's.
// dist/.gitkeep is tracked so the directory always exists (see web/dist/.gitkeep and .gitignore),
// even in a fresh checkout before the frontend has ever been built.
package webdist

import "embed"

//go:embed all:dist
var Dist embed.FS
