package api_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/testutil"
)

// docRowRe matches the endpoint a docs/API.md table row starts with: | `METHOD /path` | ...
var docRowRe = regexp.MustCompile("^\\| `(GET|POST|PATCH|PUT|DELETE) (/[^` ?]*)")

var (
	paramRe = regexp.MustCompile(`\{[^}/]*\}`)                  // {id}, {fromKind}, ...
	altRe   = regexp.MustCompile(`\{([a-z-]+)\\?\|([a-z-]+)\}`) // {deliverables\|milestones}
)

// normalise names every path parameter {} so the docs' and chi's spellings compare.
func normalise(ep string) string { return paramRe.ReplaceAllString(ep, "{}") }

// docEndpoints lists every endpoint a docs/API.md table documents. A row for {deliverables\|milestones}
// stands for both.
func docEndpoints(t *testing.T) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testutil.RepoRoot(t), "docs", "API.md"))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		m := docRowRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		path := m[2]
		if a := altRe.FindStringSubmatch(path); a != nil {
			out[normalise(m[1]+" "+strings.Replace(path, a[0], a[1], 1))] = true
			path = strings.Replace(path, a[0], a[2], 1)
		}
		out[normalise(m[1]+" "+path)] = true
	}
	return out
}

// Test_REQ_API_001_routes_match_docs checks both directions: every endpoint a docs/API.md table documents is
// really registered in internal/api/api.go, and every route registered there has a table row — so the
// reference can't silently drift from what the server does. (GET /health is registered by cmd/roadmap and
// documented outside a table; its own test covers it.)
func Test_REQ_API_001_routes_match_docs(t *testing.T) {
	documented, registered := docEndpoints(t), map[string]bool{}
	for ep := range registeredEndpoints(t) { // admin_test.go walks the router with chi.Walk
		registered[normalise(ep)] = true
	}
	if len(documented) < 20 || len(registered) < 20 {
		t.Fatalf("parsed %d documented and %d registered endpoints: the parser or the doc format is broken", len(documented), len(registered))
	}
	var missing, undocumented []string
	for ep := range documented {
		if !registered[ep] {
			missing = append(missing, ep)
		}
	}
	for ep := range registered {
		if !documented[ep] {
			undocumented = append(undocumented, ep)
		}
	}
	t.Logf("%d documented, %d registered", len(documented), len(registered))
	sort.Strings(missing)
	sort.Strings(undocumented)
	if len(missing) > 0 {
		t.Errorf("documented in docs/API.md but not registered: %v", missing)
	}
	if len(undocumented) > 0 {
		t.Errorf("registered but not in a docs/API.md table: %v", undocumented)
	}
}
