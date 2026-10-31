# Test entry points (REQ_TEST_001/002). Go tests use a fresh temp SQLite DB; nothing touches dev/prod data.
export PATH := $(HOME)/.local/go/bin:$(HOME)/go/bin:$(PATH)
export LOG_PREFIX := test

.PHONY: run build version release-files web-dist build-linux build-windows dev-data test test-all test-go test-web-deps test-lint test-unit test-e2e test-focus focus-run t test-clean clean-tmp

# Local dev: `go run` builds into a temp dir, so the config is passed explicitly (paths in it resolve
# against its folder, i.e. the repo root). LOG_PREFIX is cleared: the test prefix must not reach dev logs.
# Deliberately does not build the frontend (REQ_OVR_008's SPA fallback degrades to a "not built"
# message when web/dist has no index.html yet — see internal/webui) — use `make build` for that.
run:
	LOG_PREFIX= go run -ldflags "$(LDFLAGS)" ./cmd/overlens -config $(CURDIR)/overlens.conf

# Builds the frontend, then the single Go binary that embeds it (REQ_OVR_007/008).
build:
	cd web && npm run build
	go build -ldflags "$(LDFLAGS)" -o overlens ./cmd/overlens

# Version stamping (REQ_DEPLOY_010): -ldflags set main.version / main.buildTime / main.commit, which
# `overlens -version` prints and the start-up log line carries. The version is the release tag vX.Y.Z without the v
# (git describe: "1.0.0-3-gabc1234" after it, "-dirty" with uncommitted changes); with no such tag, or no git, it is
# the VERSION file (REQ_DEPLOY_015 says when it changes). `make version` prints it. `:=`, not `?=`: a VERSION variable
# in the environment must not win over the tag and the file (only `make VERSION=x` on the command line does).
VERSION := $(shell v=$$(git describe --tags --match 'v[0-9]*' --dirty 2>/dev/null) && echo "$${v#v}" || cat VERSION 2>/dev/null || echo dev)
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS = -s -w -X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME) -X main.commit=$(COMMIT)

version:
	@echo $(VERSION)

# The downloads of a release (REQ_DEPLOY_016): one archive per platform in dist/release/, each with the program, START-HERE.txt,
# the ready deploy/overlens.conf as overlens.conf, LICENSE and CHANGELOG.md, plus SHA256SUMS (no README.md: the repository shows it). Windows gets a .zip (made with Python's
# zipfile, so no zip tool is needed), the others a .tar.gz. Entries are GOOS/GOARCH/label.
RELEASE_TARGETS = windows/amd64/x64 linux/amd64/x64 linux/arm64/arm64 darwin/arm64/arm64 darwin/amd64/x64
release-files: web-dist
	rm -rf dist/release && mkdir -p dist/release
	@set -e; for t in $(RELEASE_TARGETS); do \
	  os=$${t%%/*}; rest=$${t#*/}; arch=$${rest%%/*}; label=$${rest#*/}; \
	  plat=$$os; exe=overlens; [ $$os = darwin ] && plat=macos; [ $$os = windows ] && exe=overlens.exe; \
	  name=overlens-$(VERSION)-$$plat-$$label; d=dist/release/$$name; mkdir -p $$d; \
	  echo "building $$name"; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o $$d/$$exe ./cmd/overlens; \
	  cp deploy/START-HERE.txt LICENSE CHANGELOG.md $$d/; cp deploy/overlens.conf $$d/overlens.conf; \
	  if [ $$os = windows ]; then (cd dist/release && python3 -m zipfile -c $$name.zip $$name/); \
	  else tar -C dist/release -czf dist/release/$$name.tar.gz $$name; fi; \
	  rm -rf $$d; \
	done
	cd dist/release && sha256sum overlens-* > SHA256SUMS
	@ls -l dist/release

web-dist:
	cd web && npm run build

# The Linux program (REQ_DEPLOY_003) and, cross-built from Linux with no C toolchain, the Windows one
# (REQ_DEPLOY_004). Both embed the frontend and are stamped with the version.
build-linux: web-dist
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/overlens ./cmd/overlens

build-windows: web-dist
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/overlens.exe ./cmd/overlens

# Loads dev/company.json into the development database (REQ_DEMO_018). Refuses unless overlens.conf says
# `environment: development`, and unless the database has no team yet. `make dev-data RESET=1` wipes the
# database first, after listing what it will delete and waiting for you to type yes. Like `make run`, the
# test prefix is cleared so nothing reaches a test log.
dev-data:
	LOG_PREFIX= go run ./cmd/overlens -config $(CURDIR)/overlens.conf -dev-data dev/company.json $(if $(RESET),--reset)

# Every erm-test-* dir any test creates lands under $(TMPDIR) (Go's os.TempDir() resolves against it).
# `make test` and `make t` each create their own scratch dir (erm-run-*), run under it via ERM_RUN_DIR,
# and remove exactly that one dir afterwards — never a sweep of every erm-test-* dir under the shared
# system temp dir, which would also destroy another worktree's or concurrent run's live test database.
# Other targets (e.g. `make run`) create nothing.
ifdef ERM_RUN_DIR
export TMPDIR := $(ERM_RUN_DIR)
endif
NEW_RUN_DIR = mktemp -d "$${TMPDIR:-/tmp}/erm-run-XXXXXX"

# `make test` is the one command: runs every layer regardless of an earlier one failing, prints a
# per-layer summary, always cleans up afterwards (even when tests fail), and keeps the real exit code.
test:
	@d=$$($(NEW_RUN_DIR)) || exit 1; rc=0; ERM_RUN_DIR="$$d" $(MAKE) --no-print-directory test-all || rc=$$?; \
	rm -rf "$$d"; $(MAKE) --no-print-directory clean-tmp; exit $$rc

test-all:
	@go_rc=0; lint_rc=0; unit_rc=0; e2e_rc=0; \
	$(MAKE) --no-print-directory test-go || go_rc=$$?; \
	$(MAKE) --no-print-directory test-lint || lint_rc=$$?; \
	$(MAKE) --no-print-directory test-unit || unit_rc=$$?; \
	$(MAKE) --no-print-directory test-e2e || e2e_rc=$$?; \
	echo ""; \
	echo "== make test summary =="; \
	printf "  Go:         %s\n" "$$( [ $$go_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	printf "  ESLint:     %s\n" "$$( [ $$lint_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	printf "  Vitest:     %s\n" "$$( [ $$unit_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	printf "  Playwright: %s\n" "$$( [ $$e2e_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	test $$go_rc -eq 0 -a $$lint_rc -eq 0 -a $$unit_rc -eq 0 -a $$e2e_rc -eq 0

clean-tmp:
	@rm -rf web/test-results web/playwright-report

# -count=1: Go's test cache would otherwise skip re-running date-dependent tests.
test-go:
	go vet ./...
	go test -count=1 ./...

test-web-deps:
	cd web && npm install --no-audit --no-fund

# ESLint over web/ (react-hooks rules, typescript-eslint, react-refresh; web/eslint.config.mjs).
test-lint: test-web-deps
	cd web && npm run lint

test-unit: test-web-deps
	cd web && npx vitest run

test-e2e: test-web-deps web-dist
	cd web && npx playwright test

# AREA is a lowercase requirement area (ovr, dat, api, fe, dep, auth, aud, cfg, test, demo, deploy —
# see requirements/README.md). Selects tests by the REQ ID area they prove, not by Go package or file
# location: Go via `-run 'REQ_<AREA>_'` across the whole module, Vitest via `-t`, Playwright via
# `--grep` (with `--no-deps`, so a focus run never drags in the full core no-overlap/copies-off suite
# just to satisfy a project dependency — the ~15s budget is for this focused run; `make test` still
# runs core first, always). An area with no matching test in a layer is a pass in that layer, not a
# failure — `go test -run` with no match is already a pass; Vitest/Playwright get `--passWithNoTests`.
test-focus:
	@test -n "$(AREA)" || (echo "usage: make t AREA=<area>"; exit 2)
	@d=$$($(NEW_RUN_DIR)) || exit 1; rc=0; ERM_RUN_DIR="$$d" $(MAKE) --no-print-directory focus-run || rc=$$?; \
	rm -rf "$$d"; $(MAKE) --no-print-directory clean-tmp; exit $$rc

# Runs every layer even if an earlier one fails, and fails if any layer failed.
focus-run:
	@area_upper=$$(echo "$(AREA)" | tr '[:lower:]' '[:upper:]'); go_rc=0; unit_rc=0; e2e_rc=0; \
	echo "== Go: -run 'REQ_$${area_upper}_' =="; \
	go test -count=1 ./... -run "REQ_$${area_upper}_" -v || go_rc=$$?; \
	echo "== Vitest: -t 'REQ_$${area_upper}_' =="; \
	(cd web && npx vitest run --passWithNoTests -t "REQ_$${area_upper}_") || unit_rc=$$?; \
	echo "== Playwright: --grep 'REQ_$${area_upper}_' =="; \
	(cd web && npx playwright test --grep "REQ_$${area_upper}_" --pass-with-no-tests --no-deps) || e2e_rc=$$?; \
	echo ""; echo "== make t AREA=$(AREA) summary =="; \
	printf "  Go:         %s\n" "$$( [ $$go_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	printf "  Vitest:     %s\n" "$$( [ $$unit_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	printf "  Playwright: %s\n" "$$( [ $$e2e_rc -eq 0 ] && echo PASS || echo FAIL )"; \
	test $$go_rc -eq 0 -a $$unit_rc -eq 0 -a $$e2e_rc -eq 0

# `make t AREA=aud` is shorthand for test-focus.
t: test-focus

# Rarely needed (test already cleans); also drops the Go test cache.
test-clean: clean-tmp
	go clean -testcache
