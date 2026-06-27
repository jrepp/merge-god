---
title: Single Repository Target
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-008
project_id: merge-god
doc_uuid: 7895619e-6c05-45fa-950c-07633bcb762d
---

# Single Repository Target

# Context

Script needs to know which repository to process.

# Decision

Accept repository path as command-line argument. One instance processes one repository.

# Rationale

- **Simple**: One concern per process
- **Scalable**: Run multiple instances for multiple repos
- **Isolated**: Failures in one repo don't affect others
- **Clear ownership**: Each process has single responsibility

# Consequences

## Positive

- Simple process model
- Easy to reason about
- Natural scaling (N processes for N repos)
- Process failures are isolated

## Negative

- Need multiple processes for multiple repos
- No centralized coordination
- More resource usage

# Future Consideration

Could add multi-repo support in future PRD if needed.

# References

- Migrated from legacy `ADR.md` (ADR-008)
