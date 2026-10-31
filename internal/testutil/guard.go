// Package testutil is the test harness: temp databases with a dev/prod guard, a controllable
// clock, a seeded RNG and data builders. It is imported only from _test.go files.
package testutil

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

const tempPrefix = "erm-test-"

// repoRoot walks up from the working directory to the directory holding go.mod.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found above working directory")
		}
		dir = parent
	}
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// resolve makes p absolute and resolves symlinks in the existing part of its path.
func resolve(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	dir, base := filepath.Split(abs)
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		return filepath.Join(r, base)
	}
	return abs
}

// GuardRoot refuses a scratch directory that is not a fresh erm-test-* folder under the system temp dir.
func GuardRoot(root string) error {
	r, tmp := resolve(root), resolve(os.TempDir())
	if !within(tmp, r) || !strings.HasPrefix(filepath.Base(r), tempPrefix) {
		return fmt.Errorf("guard: %q is not a %s* directory inside %s", root, tempPrefix, tmp)
	}
	return nil
}

// GuardDBPath refuses to use path as a test database unless it is inside root (a valid scratch
// dir), outside the repository (where the dev DB lives) and not named by any dev/prod env var.
func GuardDBPath(path, root string) error {
	if err := GuardRoot(root); err != nil {
		return err
	}
	p := resolve(path)
	if !within(resolve(root), p) {
		return fmt.Errorf("guard: database path %q is outside the test temp dir %q", path, root)
	}
	if repo, err := repoRoot(); err == nil && within(resolve(repo), p) {
		return fmt.Errorf("guard: database path %q is inside the repository", path)
	}
	for _, k := range []string{"OVERLENS_DB", "OVERLENS_DB_PATH", "ROADMAP_DB", "ROADMAP_DB_PATH", "DB_PATH", "DATABASE_PATH"} {
		if v := os.Getenv(k); v != "" && resolve(v) == p {
			return fmt.Errorf("guard: database path %q equals the dev/prod path in %s", path, k)
		}
	}
	return nil
}

// SafeRemoveAll deletes target only if it is inside root and root passes GuardRoot.
func SafeRemoveAll(root, target string) error {
	if err := GuardRoot(root); err != nil {
		return err
	}
	if !within(resolve(root), resolve(target)) && resolve(root) != resolve(target) {
		return fmt.Errorf("guard: refusing to delete %q outside %q", target, root)
	}
	slog.Debug("testutil: removing", "target", target)
	return os.RemoveAll(target)
}
