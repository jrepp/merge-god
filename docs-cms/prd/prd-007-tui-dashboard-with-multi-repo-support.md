---
title: TUI Dashboard with Multi-Repo Support
status: Completed
author: Jacob Repp
created: 2025-11-21T00:00:00Z
target_release: Released
tags: [feature, merge-god]
id: prd-007
project_id: merge-god
doc_uuid: cb9a06e7-1f4b-4e44-a09b-3d9d42955d36
---

# TUI Dashboard with Multi-Repo Support

## Executive Summary

TUI Dashboard with Multi-Repo Support for the merge-god PR automation system.

**Priority:** P1 (High)

# Requirements

- [x] TUI (Text User Interface) dashboard for monitoring
- [x] Support for multiple repositories via config file
- [x] Real-time display of PR processing status
- [x] Show recent activity/logs per repository
- [x] Display processing statistics
- [x] Run in tmux/screen sessions
- [x] Config file format (YAML)
- [x] Per-repo settings (branch, polling interval)
- [x] Live updates without refreshing

# Success Criteria

- Dashboard displays all configured repos
- Shows live processing status for each repo
- Updates in real-time as PRs are processed
- Easy to read in terminal
- Config file is human-readable and editable
- Works well in tmux sessions

# Configuration Format

```yaml
repos:
  - path: /path/to/repo1
    name: "Project A"
    enabled: true
  - path: /path/to/repo2
    name: "Project B"
    enabled: true
```

# References

- Migrated from legacy `PRD.md`
