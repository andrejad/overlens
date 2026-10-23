# Configuration and logging

**The config file**

- **REQ_CFG_001** — Settings live in `roadmap.conf` next to the program, one `key: value` per line, with `#` for comments. It can be edited in Notepad.
- **REQ_CFG_002** — Environment variables can override individual settings.
- **REQ_CFG_003** — The settings and their defaults: port 8080, db_path ./data/roadmap-database.db *(Changed 2026-10-17: was ./data/roadmap.db; REQ_CFG_012)*, log_dir ./logs, log_level INFO, audit_retention_days 365, backup_enabled true, backup_dir ./backups, backup_time 04:00, backup_keep_days 10, session_ttl_days 365, environment production, sample_data true, cookie_secure auto, mcp_enabled false *(added 2026-10-19, REQ_CFG_013)*. `bootstrap_admin_user` and `bootstrap_admin_password` are required and have no default.
- **REQ_CFG_004** — A commented `roadmap.conf.example` is in the repository for the server routes (`docs/DEPLOY.md`). The downloads carry the ready `roadmap.conf` of REQ_DEPLOY_016 instead. *(Changed 2026-10-22: the example used to ship with the app.)*
- **REQ_CFG_011** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_CFG_013** — *(2026-10-19)* `mcp_enabled` (`true` or `false`, default `false`; env `ROADMAP_MCP_ENABLED`) switches the AI connection at `/mcp` on or off (REQ_API_056/057). Any other value stops the start-up like every other bad setting (REQ_CFG_005). The start-up log line says whether it is on. It replaces the withdrawn REQ_CFG_011.
- **REQ_CFG_007** — Retention and backup settings can only be changed in this file, never from the screens or the API.

**Checking it on startup**

- **REQ_CFG_014** *(withdrawn 2026-10-22, decision — the downloads ship a ready `roadmap.conf` instead of writing one on the first start, REQ_DEPLOY_016)*
- **REQ_CFG_005** — Before touching the database, the app checks its config. If the file is missing or unreadable, or a required setting is missing or empty, it writes one ERROR line to the log listing every problem, prints the same to the screen, and exits with a non-zero code.
- **REQ_CFG_006** — Required settings never get a silent default.

**Logging**

- **REQ_CFG_008** — Logging uses `log/slog` into a log file per day (`app.log` for today, renamed to `YYYY-MM-DD-app.log` at midnight), also copied to the console, with an `X-Request-Id` on every line.
- **REQ_CFG_009** — Every request logs its method, path, result and time. Request and response summaries appear only at DEBUG level, cut to about 1000 characters.
- **REQ_CFG_010** — Passwords, session tokens, password hashes and the bootstrap password are never logged.
- **REQ_CFG_012** — *(2026-10-17)* The database file is `roadmap-database.db` (it was `roadmap.db`). An existing installation keeps its data: when the configured file is named `roadmap-database.db`, does not exist, and a `roadmap.db` is in the same folder, the app opens that one instead and logs a warning saying so (and how to rename it). A file that exists is never replaced, and a `db_path` with any other name is used as written. Nothing is renamed or copied automatically.
