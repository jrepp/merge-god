---
title: Label-Based Processing Control
status: Accepted
created: 2025-11-21T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-004
project_id: merge-god
doc_uuid: c7aad66b-8830-49a9-8080-bdbf5875af95
supersedes: adr-007
---

# Label-Based Processing Control

# Context

Need flexible way to control PR processing mode without restarting the service or changing configuration.

# Decision

Use GitHub labels (`for-review`, `for-landing`) to control how PRs are processed, rather than command-line flags.

# Rationale

- **Per-PR control**: Different PRs can have different processing modes
- **No restart needed**: Change processing by adding/removing labels
- **Visible in GitHub**: Labels show processing intent to team
- **Self-documenting**: PR history shows processing decisions
- **Flexible**: Easy to add new processing modes via labels

# Consequences

## Positive

- Dynamic control without service restart
- Team can see and manage processing modes
- Natural fit with GitHub workflow
- Easy to change processing mode mid-stream

## Negative

- Requires labeling PRs manually
- Labels must be created in repo
- Unlabeled PRs are skipped (could be surprising)
- Less obvious than command-line flag

# Implementation

- `for-landing`: Basic processing (conflicts, reviews, CI)
- `for-review`: Comprehensive review with code improvements
- No label: Skip PR entirely

# References

- Migrated from legacy `ADR.md` (ADR-004)
