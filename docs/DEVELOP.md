# Developing Overlens

How to run Overlens from source and how to run its tests. To run it on a server, see [DEPLOY.md](DEPLOY.md).

## Run from source (about five minutes)

You need Go 1.27 and Node 22 with npm.

```
git clone https://github.com/andrejad/overlens.git && cd overlens
export PATH="$HOME/.local/go/bin:$PATH"     # only if Go lives there
cp overlens.conf.example overlens.conf        # then set bootstrap_admin_user and bootstrap_admin_password (no defaults)
(cd web && npm install)                     # one time, about a minute
./start.sh                                  # Vite on 8080, backend on 8081; Ctrl+C stops both
```

Open `http://localhost:8080` and log in with the admin you put in `overlens.conf`. On the first start of an empty database
the app creates a small sample company (five teams, three workstreams, twenty deliverables, five milestones), so you see
something right away; `sample_data: false` in `overlens.conf` switches that off. Check the server with
`curl localhost:8080/health`.

`./start.sh` runs the Vite frontend (`port` in `overlens.conf`, default 8080, proxying `/api`, `/health` and `/mcp`) and the
Go backend (`backend_port`, default 8081) together in one terminal; Ctrl+C stops both gracefully. `./stop.sh` does the same from another terminal (it uses the `.dev-servers.pid`
file that `start.sh` writes, and falls back to whatever holds the two ports).

Other ways to run it:

- `make run` runs only the backend (`go run ./cmd/overlens -config <repo>/overlens.conf`); it does not build the frontend.
- `make build` builds the frontend and then the single `overlens` program with it embedded; `./overlens` serves both on port
  8080.
- `make dev-data` loads the development company (5 teams, 30 deliverables, `dev/company.json`) into an empty development database.
  It refuses unless `overlens.conf` has `environment: development` and the database has no team
  yet (set `sample_data: false` in a development config, or the first start creates the sample company and the loader refuses); the loader's `--reset` option first wipes the database after you type `yes` (`make dev-data RESET=1`).
- Running it on a server, in Docker or as a service: see `docs/DEPLOY.md`.

The built binary looks for `overlens.conf` in its own directory (`-config /path/to/overlens.conf` overrides
this). Relative `db_path`, `log_dir` and `backup_dir` resolve against the config file's directory, so the
database, logs and backups sit beside the binary (or beside the file given with `-config`), never in the
current working directory. `make run` passes `-config` explicitly because `go run` builds into a temp folder.

The app validates `overlens.conf` first (a missing or invalid setting prints one ERROR line naming every
problem and exits non-zero; the line is also written to the config's `log_dir`, or to `logs/` beside the
binary if the file cannot be read), then creates/upgrades the SQLite database and serves. Any key can be
overridden with `OVERLENS_<KEY>` (e.g. `OVERLENS_PORT=9000`). It serves `GET /health` and the endpoints in `docs/API.md`; examples to copy are in `docs/API-USAGE.md`. `overlens -version` prints the version, build time and commit; `make version` prints the version a build gets (`docs/DEPLOY.md`, "Versions").

An optional, read-only connection for AI assistants (MCP at `/mcp`) is off by default; `mcp_enabled: true` switches it
on. See `docs/DEPLOY.md`, "Connecting AI apps".

## Running the tests

- `make test` — the one command: runs every layer (`go vet` + Go tests on a temp SQLite DB per test,
  ESLint (`npm run lint` in `web/`), Vitest, Playwright) regardless of an earlier layer failing, prints a per-layer PASS/FAIL summary,
  always cleans up afterwards — even on failure — and exits non-zero if anything failed.
- Each `make test` and `make t` run also writes every layer's full output and the summary to
  `test-logs/<YYYYMMDD-HHMMSS>-<layer>.log` (`go`, `lint`, `vitest`, `playwright`, `summary`) in the repository
  root, separate from the app's own logs. The folder is git-ignored; only the newest 20 runs are kept (older
  files in it that match this naming are deleted automatically, nothing else).
- `make t AREA=<area>` (same as `make test-focus`) — selects tests by the REQ ID area they prove, not
  by Go package or file location: Go via `go test -run 'REQ_<AREA>_'` (uppercased) across the whole
  module, Vitest via `-t 'REQ_<AREA>_'`, Playwright via `--grep 'REQ_<AREA>_' --no-deps` (so a focus
  run never drags in the full core no-overlap/copies-off suite just to satisfy a project dependency).
  An area with no matching test in a layer is a pass in that layer, not a failure. Areas are the
  lowercase requirement areas: `ovr`, `dat`, `api`, `fe`, `dep`, `auth`, `aud`, `cfg`, `test`, `demo`, `deploy`.
- `make test-clean` — rarely needed; also drops the Go test cache.
- `TEST_SEED=<n> make test-go` (or `TEST_SEED=<n> make t AREA=<area>`) replays a randomised test
  exactly, including its dates — the test clock derives from the seed, never from real "today"; a
  failing test prints its seed.
- Every `make test`/`make t` run gets its own scratch parent directory (`$TMPDIR`, cleaned up by
  `clean-tmp` at the end) so it never touches another worktree's or another concurrent run's live
  test database — only its own `erm-test-*` dirs are ever removed.

Tests never touch the dev or production database: `internal/testutil` builds a fresh DB from
`schema.sql` inside a temp dir and refuses any other path. There is no fixed dataset; tests use the
builders in `internal/testutil/builders.go` with dates relative to the test clock. `schema.sql` is the only
database layout; on start, `store.Converge` adds missing tables and columns to an existing database.

The Playwright projects run in order: `core-no-overlap`, then `core-copies-off`, then the rest; a
failure in a core project stops the suite. Both run against the real app.
