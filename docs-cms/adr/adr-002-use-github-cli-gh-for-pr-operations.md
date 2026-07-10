---
title: GitHub CLI Auth With TypeScript GitHub Clients
status: Implemented
created: 2025-11-20T00:00:00Z
updated: 2026-07-09T00:00:00Z
deciders: System Designer
tags: [architecture, github, merge-god, typescript]
id: adr-002
project_id: merge-god
doc_uuid: 1211ec4e-e7ff-403b-8d22-7a513fccda93
---

# GitHub CLI Auth With TypeScript GitHub Clients

# Context

Need to interact with GitHub API to fetch PR data, comments, reviews, etc.

# Decision

Use the GitHub CLI (`gh`) as the local authentication broker, and use
TypeScript GitHub clients for structured API access. The root GitHub integration
uses `@octokit/rest`; the dedicated `@merge-god/github-sync` workspace package
owns normalized forge models and sync behavior.

# Rationale

- **Authentication handled**: Uses existing gh auth
- **Well-tested**: Official GitHub tool
- **Structured API access**: TypeScript clients provide typed models and clearer error handling.
- **Forge boundary**: `@merge-god/github-sync` keeps sync concerns out of the loop.

# Consequences

## Positive

- No Python dependencies for GitHub interaction
- Works with 2FA and SSO
- Automatic token refresh
- Better structured state through TypeScript models and SQLite-backed sync storage

## Negative

- Requires gh CLI to be installed
- Requires maintaining client adapters in addition to local auth checks
- Some legacy paths still shell out through `gh`

# References

- Migrated from legacy `ADR.md` (ADR-002)
