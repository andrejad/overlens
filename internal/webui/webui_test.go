package webui_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"

	"github.com/andrejad/overlens/internal/webui"
)

func router(dist fstest.MapFS) http.Handler {
	r := chi.NewRouter()
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"status":"ok"}`)) })
	r.Route("/api", func(r chi.Router) {
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
		r.Get("/teams", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"items":[],"total":0}`)) })
	})
	webui.Register(r, dist)
	return r
}

// REQ_OVR_008: an unknown address serves the app's main page (index.html), and /api and /health are
// never shadowed by that fallback.
func Test_REQ_OVR_008_spa_fallback_serves_index_for_unknown_path(t *testing.T) {
	t.Run("spa fallback serves real asset as is", func(t *testing.T) {
		dist := fstest.MapFS{
			"index.html":    {Data: []byte("<html>the app</html>")},
			"assets/app.js": {Data: []byte("console.log(1)")},
		}
		srv := httptest.NewServer(router(dist))
		defer srv.Close()

		res, err := http.Get(srv.URL + "/assets/app.js")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if ct := res.Header.Get("Content-Type"); res.StatusCode != http.StatusOK {
			t.Fatalf("real asset: got status %d (content-type %q), want 200", res.StatusCode, ct)
		}
	})

	t.Run("spa fallback without a build does not panic", func(t *testing.T) {
		dist := fstest.MapFS{} // empty: as if only .gitkeep were there
		srv := httptest.NewServer(router(dist))
		defer srv.Close()

		res, err := http.Get(srv.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("unbuilt frontend: got status %d, want 404 (not a panic/500)", res.StatusCode)
		}
	})

	dist := fstest.MapFS{
		"index.html":    {Data: []byte("<html>the app</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	srv := httptest.NewServer(router(dist))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/some/deep/link")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("unknown path: got status %d, want 200", res.StatusCode)
	}

}

// The SPA fallback is mounted last and only as chi's router-wide NotFound: it must never answer for
// paths the API or /health already own.
func Test_REQ_OVR_008_spa_fallback_never_shadows_api_or_health(t *testing.T) {
	dist := fstest.MapFS{"index.html": {Data: []byte("<html>the app</html>")}}
	srv := httptest.NewServer(router(dist))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/health: got status %d, want 200", res.StatusCode)
	}

	res, err = http.Get(srv.URL + "/api/teams")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/api/teams: got status %d, want 200", res.StatusCode)
	}

	// an unknown /api/* path still answers through the API's own NotFound, not the SPA's
	res, err = http.Get(srv.URL + "/api/does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 1)
	n, _ := res.Body.Read(body)
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("/api/does-not-exist: got status %d, want 404", res.StatusCode)
	}
	if n > 0 && body[0] == '<' {
		t.Fatalf("/api/does-not-exist: got HTML from the SPA fallback instead of the API's own 404")
	}
}
