---
title: YAML Configuration for Multi-Repo
status: Accepted
created: 2025-11-21T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-011
project_id: merge-god
doc_uuid: dd8e89a4-5328-44d0-b0c0-e89b0c01eb49
---

# YAML Configuration for Multi-Repo

# Context

Need to manage multiple repository configurations without command-line complexity.

# Decision

Use YAML configuration file for multi-repository setup.

# Rationale

- **Human-readable**: Easy to edit and understand
- **Comments**: Support for inline documentation
- **Structured**: Clear hierarchy for repo settings
- **Standard**: Well-known format
- **Per-repo settings**: Can customize each repo independently
- **Enable/disable**: Easy to turn repos on/off

# Consequences

## Positive

- Single file for all configuration
- Easy to add/remove repositories
- Can commit to version control
- Supports comments for documentation
- Per-repo customization possible

## Negative

- Adds PyYAML dependency
- Another file to manage
- Needs validation on load
- Breaking changes require migration

# Configuration Format

```yaml
repos:
  - path: /path/to/repo
    name: "Repo Name"
    enabled: true
    # Future: custom settings per repo
```

# Future Extensions

- Per-repo polling intervals
- Per-repo notification settings
- Custom prompt templates
- Label filters per repo

# References

- Migrated from legacy `ADR.md` (ADR-011)
