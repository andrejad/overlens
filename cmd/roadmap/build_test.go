package main

// REQ_OVR_005/006: the server builds with no cgo SQLite driver, and cross-builds for Windows from
// Linux — the two things that let a company's IT install "one program and one config file" (REQ_OVR_003)
// on either platform without a C toolchain.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/andrejad/overlens/internal/testutil"
)

// Test_REQ_OVR_006_cross_builds_for_windows: building the Windows binary from this (Linux) machine
// succeeds — the whole point of avoiding a cgo driver.
func Test_REQ_OVR_006_REQ_OVR_005_cross_builds_for_windows(t *testing.T) {
	t.Run("builds with cgo disabled", func(t *testing.T) {
		root := testutil.RepoRoot(t)
		dir := t.TempDir()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "go", "build", "-o", filepath.Join(dir, "roadmap"), "./cmd/roadmap")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("CGO_ENABLED=0 build failed: %v\n%s", err, out)
		}
	})

	root := testutil.RepoRoot(t)
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", filepath.Join(dir, "roadmap.exe"), "./cmd/roadmap")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Windows cross-build failed: %v\n%s", err, out)
	}

}
