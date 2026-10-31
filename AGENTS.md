# Overlens — notes for AI agents

For an AI agent (Claude Code, Codex, Cursor, Copilot and others) asked to explain, deploy, test or change this
repository. People are welcome to read it too.

## What the app is

A self-hosted roadmap for engineering organisations: every team's deliverables and milestones on one company
timeline, with the dependencies between teams and one accountable owner per item. A single Go program with the React
frontend and SQLite built in; meant to run inside a company VPN. `README.md` has the pitch, and `requirements/` says
precisely what the app does.

## Where things are

| Path | What |
|---|---|
| `README.md` | What the app is, screenshots, quick starts, run from source, tests |
| `requirements/REQ-*.md` | What the app must do, one requirement per line with a permanent ID (`REQ_FE_010`); start at `requirements/README.md` |
| `docs/DEPLOY.md` | Every way to run it: download, Linux (systemd), Windows, Docker / Compose / Portainer, CapRover, Kubernetes; configuration, backups, upgrades, the AI connection (MCP) |
| `docs/API.md`, `docs/API-USAGE.md` | The HTTP endpoints, and examples to copy |
| `overlens.conf.example` | Every setting, explained; any key can also be set as `OVERLENS_<KEY>` |
| `docker-compose.yml`, `Dockerfile`, `captain-definition`, `deploy/` | Packaging; `deploy/START-HERE.txt` and `deploy/overlens.conf` ship in the downloads |
| `CHANGELOG.md` | What changed in each release |
| `cmd/overlens/` | The program's entry point |
| `internal/` | Go packages: `api` (handlers, MCP), `auth`, `audit`, `backup`, `config`, `logging`, `store` (SQLite), `demo` (sample data), `testutil` (test harness), `webui` |
| `schema.sql` | The only database layout; `store.Converge` adds missing tables and columns on start |
| `web/` | React + TypeScript + Vite + Tailwind frontend; `web/src/timeline/` is the timeline |
| `dev/company.json` | A larger company for development (`make dev-data`) |

## Build and test

- Needs Go 1.27 and Node 22 with npm. `(cd web && npm install)` once.
- `./start.sh` runs backend (8080) and frontend (5173) for development; `make build` makes the single `overlens` program.
- `make test` runs everything (Go, ESLint, Vitest, Playwright) and prints a PASS/FAIL line per layer. `make t AREA=fe`
  runs the tests of one requirement area. Run `make test` before calling a change done.
- Tests build their own temporary database. Never point a test at a real database.

## Rules for changes

1. **Requirements first.** A change to what the app does starts in `requirements/REQ-*.md`: edit or add the
   requirement (new IDs continue the numbering; IDs are never reused, a dropped one is marked *(withdrawn)*), then the
   code and tests follow.
2. **Every behaviour requirement has a test named after its ID**: `Test_REQ_FE_010_...` in Go, `REQ_FE_010` in the
   Vitest or Playwright title, at the cheapest layer that proves it. Never change a test to make broken code pass.
3. **Hard rules** (marked *Hard rule* in the requirements) are never traded away, for example: items in one row never
   overlap; rows are sticky; a dependent never starts before its prerequisite ends; a roadmap spans at most 3 years.
4. **Never silently destroy roadmap data.** Deletes are explicit and confirmed. The only automatic deletions are the
   audit-log retention purge, the pruning of old backups and expired login sessions.
5. **Words.** The horizontal rows are **workstreams**, never "lane", "swimlane" or "track". The bars are
   **deliverables**, never "epics". A **roadmap item** is a deliverable or a milestone. A test enforces this across code
   and docs.
6. **Endpoints.** When an endpoint changes, update `docs/API.md` and `docs/API-USAGE.md` in the same change.
7. **Logging.** Go code logs with `log/slog` (no `fmt.Println`), and never logs secrets.
8. **Small changes.** Touch only what the task needs and match the surrounding style.
9. **Changelog.** A change users will notice gets one plain line under `## [Unreleased]` in `CHANGELOG.md`.
