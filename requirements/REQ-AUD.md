# Change history, retention and backups

## The audit log

- **REQ_AUD_001** — Every change is recorded: when, who, what action, which kind of thing and which one, which roadmap, and a small JSON with details — normally one entry per request (a team edit changing several fields writes one per field, REQ_AUD_002). This includes dependency, icon-label and team changes. A request that changes nothing writes no entry. The actions are listed in REQ_AUD_024.
- **REQ_AUD_002** — Each field that autosaves is its own entry, because the app saves each field as its own request (REQ_FE_026). When one request changes several fields, a team edit writes one entry per changed field and a deliverable edit writes one entry listing every changed field (REQ_API_027). Creating a deliverable is one entry.
- **REQ_AUD_003** — Entries store the names involved (roadmap item, team, and both ends of a dependency) at the moment of the change, so they stay readable after things are renamed or deleted.
- **REQ_AUD_016** — The audit table can be filtered by user, action, type, team, roadmap item name and date range, and downloaded as CSV with the same filters.
- **REQ_AUD_008** — The admin Audit log card always shows this notice, word for word, next to a "Retention N days" badge showing the configured number: *"Set by `audit_retention_days` in `overlens.conf` (default 365), not editable here. Older rows are removed automatically; nobody can delete entries by hand."*

## Audit writes

- **REQ_AUD_017** *(withdrawn — decommissioned 2026-10-11: activate and deactivate are gone with archived roadmaps, REQ_DAT_032)*
- **REQ_AUD_018** — A failed audit write is logged as an error but does not roll back the change that triggered it. This is an accepted risk, not a bug, and it stays so after Phase 6: the audit write is deliberately not part of the change's own transaction.

## Retention

- **REQ_AUD_004** — Entries older than `audit_retention_days` (default 365; 0 means keep forever) are removed by the daily job, and only after that day's backup succeeded. If the backup failed, the removal waits until the next day.
- **REQ_AUD_005** — If backups are switched off, the daily job still removes old entries.
- **REQ_AUD_006** — A removal run records how many entries went and the cutoff date, and writes one audit entry. If it fails, that's logged and nothing else is affected.
- **REQ_AUD_007** — There is no manual purge, no in-app backup deletion and no "run now" button — for anyone.

## Backups

- **REQ_AUD_009** — A backup runs every day inside the program at `backup_time` (default 04:00, server time). No cron job or Windows Task Scheduler entry is needed.
- **REQ_AUD_010** — A backup is a consistent snapshot made with SQLite (`VACUUM INTO` or its backup API), written to a temporary file, flushed to disk, then renamed into place. It is never a plain copy of the live file.
- **REQ_AUD_011** — Files are named `overlens-YYYY-MM-DD.db` and go in `backup_dir` (default `./backups`, and never the database's own folder). A second run on the same day overwrites that day's file.
- **REQ_AUD_012** — After a successful backup, everything older than the newest `backup_keep_days` (default 10) is deleted. A failed backup deletes nothing. Only files with exactly that name pattern are ever touched.
- **REQ_AUD_013** — If the app was off at `backup_time`, it makes today's backup once when it next starts.
- **REQ_AUD_014** — Each backup run writes an audit entry (`backup.create`, `backup.prune` or `backup.fail`) as the system user. Failures are logged without secrets.
- **REQ_AUD_015** *(withdrawn — decommissioned 2026-10-11: the read-only Backups card is gone)*
- **REQ_AUD_019** — Audit actions added in Phase 6 are `user.create`, `user.password_reset`, `user.disable` and `user.enable` (details name the user, never a password or hash), plus the backup and purge actions of REQ_AUD_006/014. Logging in and out is written to the log file but is not an audit entry.
- **REQ_AUD_020** — An audit entry made by the server itself (backup, prune, retention purge) records the user as `system` with no user id; an entry made by an admin records that admin's id and username as they were at the time (REQ_AUD_003).
- **REQ_AUD_021** — The audit viewer and CSV are admin-only; an anonymous visitor gets `401` on both.
- **REQ_AUD_022** — Saving a new company workstream order writes one `company.workstream_order` entry listing the order before and after by name; saving an order that changes nothing writes nothing.
- **REQ_AUD_023** — Saving a new team order writes one `company.team_order` entry listing the order before and after by team name; saving an order that changes nothing writes nothing.
- **REQ_AUD_024** — The audit actions are exactly: `team.create` (its details name the roadmap created with it), `team.rename`, `team.retag`, `team.recolor`, `team.delete`; `roadmap.rename`; `workstream.create`, `workstream.rename`, `workstream.reorder`, `workstream.delete`; `deliverable.create`, `deliverable.update`, `deliverable.delete`, `deliverable.move`; `milestone.create`, `milestone.update`, `milestone.delete`, `milestone.move`; `dependency.create`, `dependency.delete`; `icon.relabel`; `company.workstream_order`, `company.team_order`; `user.create`, `user.password_reset`, `user.disable`, `user.enable`; `backup.create`, `backup.prune`, `backup.fail`; `audit.purge`; `sample.create`. A new action is added here first.
