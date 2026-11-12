# Changelog

All notable changes to Overlens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.1] — 2026-11-12

### Changed
- The README now shows Overlens in three steps (milestones, one milestone traced, the whole company view). Instructions for running from source and for the tests moved to `docs/DEVELOP.md`.

### Fixed
- On a row of very short deliverables, a name that stays inside its bar no longer takes room away from its neighbour's name under the bar, so more of those names are readable.

## [1.2.0] — 2026-11-01

### Changed
- A deliverable's name that doesn't fit on one row now shows in smaller letters on two rows inside its bar, so more of it can be read at the wider zoom levels.
- On very short deliverables, a name that can't fit in the bar now shows in small letters under it, where there is room. The team tag and status badge stay in the bar; its icons move to the side panel only.
- When running from source, `./start.sh` now serves the live app on `port` from `overlens.conf` (default 8080), the address the start-up message shows, instead of 5173. The backend moves behind it to the new `backend_port` setting (default 8081). Installed programs and containers are not affected.

### Fixed
- Short deliverables with a team tag no longer cram their name into the bar: it shows centred under the bar instead, with clear space below it. Rows are a little taller to make room.
- Label icons on a bar are no longer cut off: an icon without room is left out, and all of them stay in the side panel.

## [1.1.0] — 2026-10-31

### Changed
- The program, its settings file, the database and the backups are now named `overlens` (`overlens.exe`, `overlens.conf`,
  `overlens-database.db`, `overlens-YYYY-MM-DD.db`). Rename the old files by hand when you upgrade; see "Upgrading" in
  `docs/DEPLOY.md`. The `ROADMAP_*` environment variables still work but are replaced by `OVERLENS_*`.

## [1.0.0] — 2026-10-22

The first public release.

### Added
- One company timeline: every team's deliverables and milestones on one page, grouped by workstream, with status, risk
  and owner.
- Team roadmaps: drag to move and resize, workstreams, deliverables in several workstreams, and rows that never overlap.
- Dependencies between deliverables and milestones, across teams, drawn as arrows, with date rules the server enforces
  and a trace that shows a whole chain.
- Milestones only: the milestones of every team; click one to see everything that leads to it, who owns each part, what
  is at risk or overdue, and where the slack is thin.
- Reading needs no account; editors log in. An admin screen for users, teams, icon labels, the audit log, storage and the
  running version.
- An audit log of every change, daily database backups, and a CSV download of a team's roadmap.
- A read-only connection for AI assistants (MCP): switched on in the downloads' ready settings, off by default
  everywhere else (`mcp_enabled`).
- One program with nothing else to install: downloads for Windows, Linux and macOS that start with a double-click (ready
  settings included; log in as admin / admin and change the password), a Dockerfile, and guides for Linux and Windows
  services, Docker, CapRover and Kubernetes.
- Sample data, so a new installation is not empty.
