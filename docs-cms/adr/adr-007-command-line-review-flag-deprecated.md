---
title: Command-Line --review Flag (DEPRECATED)
status: Superseded
created: 2025-11-21T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-007
project_id: merge-god
doc_uuid: 442d5ed6-532c-453d-b947-75002ce2d814
superseded_by: adr-004
---

# Command-Line --review Flag (DEPRECATED)

# Context

Initially needed way to enable code review pass as optional feature.

# Decision

Use `--review` command-line flag to enable comprehensive code review.

# Rationale

- Simple on/off switch
- Clear opt-in behavior
- Easy to understand

# Why Superseded

Replaced by label-based control (ADR-004) for better flexibility:

- Can't change mode without restart
- Global setting affects all PRs equally
- Less visible to team
- Labels provide per-PR control

# References

- Migrated from legacy `ADR.md` (ADR-007)
