---
title: TUI Dashboard with Rich Library
status: Accepted
created: 2025-11-21T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-010
project_id: merge-god
doc_uuid: ac27500c-9a09-4827-b618-ed2cf5ac3b4e
---

# TUI Dashboard with Rich Library

# Context

Need real-time monitoring of PR processing across multiple repositories without constantly tailing logs.

# Decision

Build TUI (Text User Interface) dashboard using Python Rich library to display live processing status.

# Rationale

- **Rich library**: Excellent TUI capabilities with tables, live updates, colors
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
- Rich formatting (colors, tables, progress)

## Negative

- Requires terminal window/pane
- Limited to text interface
- No remote access without tmux/screen
- Adds dependency on Rich library

# Implementation

- Dashboard runs as separate process
- Spawns pr-loop.py subprocesses for each repo
- Reads JSON logs from subprocess stdout
- Updates display in real-time using Rich Live

# References

- Migrated from legacy `ADR.md` (ADR-010)
