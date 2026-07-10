---
title: TypeScript ANSI TUI Dashboard
status: Implemented
created: 2025-11-21T00:00:00Z
updated: 2026-07-09T00:00:00Z
deciders: System Designer
tags: [architecture, dashboard, merge-god, typescript]
id: adr-010
project_id: merge-god
doc_uuid: ac27500c-9a09-4827-b618-ed2cf5ac3b4e
---

# TypeScript ANSI TUI Dashboard

# Context

Need real-time monitoring of PR processing across multiple repositories without constantly tailing logs.

# Decision

Build the TUI dashboard in TypeScript (`dashboard.ts`) with ANSI live rendering.
It reads `config.yaml`, spawns one `pr-loop.ts` monitor per enabled repo, and
falls back to non-interactive logging when no TTY is available.

# Rationale

- **Single runtime**: Dashboard, CLI, and processing loop all use TypeScript / Node.js.
- **Terminal-based**: Works in tmux/screen sessions
- **Real-time updates**: Live display without manual refresh
- **Readable**: Better than raw JSON logs
- **No web server needed**: Simpler than web dashboard
- **Cross-platform**: Works on Linux, macOS, Windows

# Consequences

## Positive

- Visual monitoring without log parsing
- Real-time status updates
- Works in existing terminal workflow
- No additional infrastructure needed
- Colorized, live terminal rendering without a Python dependency

## Negative

- Requires terminal window/pane
- Limited to text interface
- No remote access without tmux/screen
- ANSI rendering code is maintained locally

# Implementation

- Dashboard is `dashboard.ts`
- Spawns `pr-loop.ts` subprocesses for each repo
- Reads JSON logs from subprocess stdout
- Updates display in real time with the local renderer

# References

- Migrated from legacy `ADR.md` (ADR-010)
