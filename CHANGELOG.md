# Changelog

All notable changes to Overlens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
