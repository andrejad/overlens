#!/usr/bin/env bash
# Started by Playwright's `webServer` (playwright.config.ts): builds and runs the real Go binary
# against its own fresh scratch database, never the dev/production one (REQ_TEST_005/006) — see the
# directory dance below for why this script mints that directory itself rather than reading
# ERM_E2E_DIR. Writes need a session since Phase 6: the bootstrap admin below is created on this
# fresh database at startup, and specs/builders log in as it (POST /api/login) before any write.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="$ROOT/web"

# Playwright starts webServer *before* running globalSetup (plugin setup tasks precede the user's
# globalSetup task in its task list), so this script can't wait for global-setup.ts to publish
# ERM_E2E_DIR — it has to create the scratch directory itself, in the same erm-test-* pattern
# global-setup.ts/global-teardown.ts use, and hand the path back via a sentinel file under
# web/.e2e-tmp (gitignored, worktree-scoped). global-setup.ts then reads it and points
# process.env.ERM_E2E_DIR at this same directory, so builders/tests and the running server agree.
mkdir -p "$WEB_DIR/.e2e-tmp"
ERM_E2E_DIR="$(mktemp -d "${TMPDIR:-/tmp}/erm-test-XXXXXX")"
mkdir -p "$ERM_E2E_DIR/data"
printf '%s' "$ERM_E2E_DIR" > "$WEB_DIR/.e2e-tmp/dir"

CONF="$ERM_E2E_DIR/overlens.conf"
: > "$CONF" # empty file: every setting comes from OVERLENS_* env below (config.Load requires the file to exist)

# The test server must not inherit anything from the caller's environment (REQ_TEST_005/020): drop every
# OVERLENS_* variable first, then set exactly the ones the tests rely on.
for v in $(compgen -e | grep '^OVERLENS_' || true); do unset "$v"; done

export OVERLENS_BOOTSTRAP_ADMIN_USER="e2e-admin"
export OVERLENS_BOOTSTRAP_ADMIN_PASSWORD="e2e-admin-password"
export OVERLENS_SAMPLE_DATA=false # REQ_TEST_020: the shipped sample company never appears in a browser test
export OVERLENS_DB_PATH="$ERM_E2E_DIR/data/overlens-database.db"
export OVERLENS_LOG_DIR="$ERM_E2E_DIR/logs"
export OVERLENS_BACKUP_ENABLED=false
export OVERLENS_PORT="${ERM_E2E_PORT:-8130}"
export LOG_PREFIX=test

BIN="$ERM_E2E_DIR/overlens-e2e"
go build -o "$BIN" "$ROOT/cmd/overlens"
exec "$BIN" -config "$CONF"
