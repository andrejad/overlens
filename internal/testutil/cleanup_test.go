package testutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Test_REQ_TEST_007_cleanup_happens_even_when_a_test_fails_or_panics: the scratch directory an Env creates
// (with its database) is removed when the test calls t.Fatal and when it panics. Each case runs the test
// binary again as a child process that builds an Env and then fails on purpose; the parent checks that the
// directory the child reported is gone although the child exited with an error.
// (The browser run's own cleanup is checked by web/src/e2e-teardown.test.ts.)
func Test_REQ_TEST_007_cleanup_happens_even_when_a_test_fails_or_panics(t *testing.T) {
	if mode := os.Getenv("ERM_CLEANUP_CHILD"); mode != "" {
		e := NewEnv(t)
		if err := os.WriteFile(os.Getenv("ERM_CLEANUP_PATHFILE"), []byte(e.Root), 0o600); err != nil {
			t.Fatal(err)
		}
		if mode == "panic" {
			panic("boom: a crashing test")
		}
		t.Fatal("boom: a failing test")
	}

	for _, mode := range []string{"fatal", "panic"} {
		t.Run(mode, func(t *testing.T) {
			pathFile := filepath.Join(t.TempDir(), "root")
			cmd := exec.Command(os.Args[0], "-test.run=^Test_REQ_TEST_007_cleanup_happens_even_when_a_test_fails_or_panics$")
			cmd.Env = append(os.Environ(), "ERM_CLEANUP_CHILD="+mode, "ERM_CLEANUP_PATHFILE="+pathFile, "LOG_PREFIX=test")
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatalf("the child was meant to fail:\n%s", out)
			}
			if !strings.Contains(string(out), "boom") {
				t.Fatalf("the child failed for another reason:\n%s", out)
			}
			b, rerr := os.ReadFile(pathFile)
			if rerr != nil {
				t.Fatalf("the child never reported its scratch dir: %v\n%s", rerr, out)
			}
			root := string(b)
			if err := GuardRoot(root); err != nil {
				t.Fatalf("the child's scratch dir is not an erm-test dir: %v", err)
			}
			if _, serr := os.Stat(root); !os.IsNotExist(serr) {
				os.RemoveAll(root) // don't leave it behind either way
				t.Errorf("scratch dir %s survived a %s test (stat err: %v)", root, mode, serr)
			}
		})
	}
}
