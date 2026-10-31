# Configuration and logging

**The config file**

- **REQ_CFG_001** — Settings live in `overlens.conf` next to the program, one `key: value` per line, with `#` for comments. It can be edited in Notepad.
- **REQ_CFG_002** — Environment variables can override individual settings.
- **REQ_CFG_003** — The settings and their defaults: port 8080, db_path ./data/overlens-database.db *(Changed 2026-10-31: was ./data/roadmap-database.db; REQ_CFG_015)*, log_dir ./logs, log_level INFO, audit_retention_days 365, backup_enabled true, backup_dir ./backups, backup_time 04:00, backup_keep_days 10, session_ttl_days 365, environment production, sample_data true, cookie_secure auto, mcp_enabled false *(added 2026-10-19, REQ_CFG_013)*. `bootstrap_admin_user` and `bootstrap_admin_password` are required and have no default.
- **REQ_CFG_004** — A commented `overlens.conf.example` is in the repository for the server routes (`docs/DEPLOY.md`). The downloads carry the ready `overlens.conf` of REQ_DEPLOY_016 instead. *(Changed 2026-10-22: the example used to ship with the app.)*
- **REQ_CFG_011** *(withdrawn — decommissioned 2026-10-11: not built; moved back to a proposal, which is not a commitment)*
- **REQ_CFG_013** — *(2026-10-19)* `mcp_enabled` (`true` or `false`, default `false`; env `OVERLENS_MCP_ENABLED`) switches the AI connection at `/mcp` on or off (REQ_API_056/057). Any other value stops the start-up like every other bad setting (REQ_CFG_005). The start-up log line says whether it is on. It replaces the withdrawn REQ_CFG_011.
- **REQ_CFG_007** — Retention and backup settings can only be changed in this file, never from the screens or the API.

**Checking it on startup**

- **REQ_CFG_014** *(withdrawn 2026-10-22, decision — the downloads ship a ready `overlens.conf` instead of writing one on the first start, REQ_DEPLOY_016)*
- **REQ_CFG_005** — Before touching the database, the app checks its config. If the file is missing or unreadable, or a required setting is missing or empty, it writes one ERROR line to the log listing every problem, prints the same to the screen, and exits with a non-zero code.
- **REQ_CFG_006** — Required settings never get a silent default.

**Logging**

- **REQ_CFG_008** — Logging uses `log/slog` into a log file per day (`app.log` for today, renamed to `YYYY-MM-DD-app.log` at midnight), also copied to the console, with an `X-Request-Id` on every line.
- **REQ_CFG_009** — Every request logs its method, path, result and time. Request and response summaries appear only at DEBUG level, cut to about 1000 characters.
- **REQ_CFG_010** — Passwords, session tokens, password hashes and the bootstrap password are never logged.
- **REQ_CFG_012** *(withdrawn 2026-10-31, decision — the files were renamed from "roadmap" to "overlens" with no fallback to the old names, REQ_CFG_015)*
- **REQ_CFG_015** — *(2026-10-31, decision)* The files carry the product name: the program is `overlens` / `overlens.exe`, the config file `overlens.conf`, the database `overlens-database.db`, the backups `overlens-YYYY-MM-DD.db` (REQ_AUD_011), the CSV download `overlens-<team tag>-…`. The program reads only these names: a `roadmap.conf`, `roadmap-database.db`, `roadmap.db` or `roadmap-YYYY-MM-DD.db` is neither opened nor renamed nor deleted, and an installation that keeps them starts on an empty database until its files are renamed by hand (`docs/DEPLOY.md`, "Upgrading").
- **REQ_CFG_016** — *(2026-10-31, decision)* The environment variable of a setting is `OVERLENS_` plus the key in capitals (`OVERLENS_PORT`, also `OVERLENS_<KEY>_FILE` for the bootstrap secrets). The old `ROADMAP_` name still works: when only that is set its value is used and one warning per variable names it (never its value); when both are set the `OVERLENS_` one wins and nothing is logged.
