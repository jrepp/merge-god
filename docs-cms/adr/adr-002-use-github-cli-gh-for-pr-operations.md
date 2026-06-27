---
title: Use GitHub CLI (gh) for PR Operations
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-002
project_id: merge-god
doc_uuid: 1211ec4e-e7ff-403b-8d22-7a513fccda93
---

# Use GitHub CLI (gh) for PR Operations

# Context

Need to interact with GitHub API to fetch PR data, comments, reviews, etc.

# Decision

Use GitHub CLI (`gh`) command-line tool instead of direct API calls or Python libraries.

# Rationale

- **Authentication handled**: Uses existing gh auth
- **Well-tested**: Official GitHub tool
- **JSON output**: Easy to parse with --json flag
- **No dependencies**: No need for PyGithub or requests library
- **Simplified code**: CLI commands simpler than REST API calls

# Consequences

## Positive

- No Python dependencies for GitHub interaction
- Works with 2FA and SSO
- Automatic token refresh
- Less code to maintain

## Negative

- Requires gh CLI to be installed
- Less control over API calls
- Subprocess overhead
- Error messages may be less structured

# References

- Migrated from legacy `ADR.md` (ADR-002)
