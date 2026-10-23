package audit_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/andrejad/overlens/internal/testutil"
)

// actionRe is the shape of an audit action, "<thing>.<verb>". Other Go string literals of that shape are
// file names and SQL column names (a one-letter table alias), which notAction skips.
var actionRe = regexp.MustCompile(`^[a-z]+\.[a-z_]+$`)

func notAction(s string) bool {
	prefix, suffix, _ := strings.Cut(s, ".")
	return len(prefix) == 1 || prefix == "mcp" /* log events: mcp.tool, mcp.tool_refused */ || slices.Contains([]string{"conf", "db", "html", "json", "log", "mod", "sql"}, suffix)
}

// Test_REQ_AUD_024_actions_written_match_the_list: every audit action the code writes (every string literal
// of the form "<thing>.<verb>" in the non-test Go files under internal/ and cmd/) is in REQ_AUD_024's list,
// and every action in the list is written somewhere.
func Test_REQ_AUD_024_actions_written_match_the_list(t *testing.T) {
	root := testutil.RepoRoot(t)
	code := map[string]string{} // action -> where
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
			if err != nil {
				return err
			}
			ast.Inspect(f, func(n ast.Node) bool {
				if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
					if s, err := strconv.Unquote(lit.Value); err == nil && actionRe.MatchString(s) && !notAction(s) {
						code[s], _ = filepath.Rel(root, path)
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	req, err := os.ReadFile(filepath.Join(root, "requirements", "REQ-AUD.md"))
	if err != nil {
		t.Fatal(err)
	}
	var line string
	for _, l := range strings.Split(string(req), "\n") {
		if strings.HasPrefix(l, "- **REQ_AUD_024**") {
			line = l
		}
	}
	listed := map[string]bool{}
	for _, m := range regexp.MustCompile("`([a-z]+\\.[a-z_]+)`").FindAllStringSubmatch(line, -1) {
		listed[m[1]] = true
	}
	if len(listed) < 10 {
		t.Fatalf("REQ_AUD_024's list not found or too short: %v", listed)
	}
	for a, where := range code {
		if !listed[a] {
			t.Errorf("%s writes the audit action %q, which REQ_AUD_024 does not list", where, a)
		}
	}
	for a := range listed {
		if _, ok := code[a]; !ok {
			t.Errorf("REQ_AUD_024 lists %q, but no code writes it", a)
		}
	}
	t.Logf("%d actions written, %d listed", len(code), len(listed))
}
