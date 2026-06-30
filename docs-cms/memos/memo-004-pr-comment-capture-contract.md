---
title: PR Comment Capture Contract
author: Engineering Team
created: 2026-06-30T00:00:00Z
tags: [comments, github, memo, security]
id: memo-004
project_id: merge-god
doc_uuid: 0e9af48b-a734-48d0-ba49-07ca8be9fe4c
---

# Overview

Merge God should treat PR comments as a bidirectional coordination surface:
it gathers comment data as part of PR context, and it writes structured comment
data back to the PR for operators, owners, and later automation runs.

The comment surface is useful because it is visible where review happens, but it
is not reliable enough to be a source of truth. Comment capture must be a
bounded, sanitized projection of durable state, and comment parsing must assume
the body is attacker-controlled input.

# Context

The PR loop already gathers general issue comments and inline review comments
before building agent context. The newer review gate cache also writes one
bot-owned comment containing the latest gate status by rule.

This memo extends that pattern into a formal contract: Merge God and its agents
may write Markdown tables into PR comments, and Merge God may read those tables
back later as cache data. Durable trajectory/database state, validation evidence,
commit SHAs, and GitHub API state remain authoritative.

# Comment Capture Contract

Merge God should capture these comment categories:

- General PR issue comments, including operator instructions and bot summaries.
- Inline PR review comments with path and line metadata.
- Merge God owned cache comments with known hidden markers.
- Agent-written structured tables that follow this memo's schemas.

Comment capture should preserve enough metadata to reason about freshness and
provenance:

- comment id,
- author login and association when available,
- created and updated timestamps,
- source endpoint or comment kind,
- body hash or compact body excerpt,
- parsed table kind and version, when recognized, and
- parse errors or sanitizer warnings.

# Required Agent Table Format

Agents that write structured PR comment data are expected to use plain GitHub
Markdown tables. Each structured table must be preceded by a hidden marker that
declares the table kind and schema version.

```markdown
<!-- merge-god-comment-capture:v1 kind=review-gate -->

| Rule | Status | Explanation |
| --- | --- | --- |
| ci | pass | Required checks passed. |
| reviews | blocked | One unresolved review thread remains. |
```

The parser should accept only known markers and known schemas. Unknown markers,
unknown columns, malformed tables, or duplicate conflicting rows should be
ignored or downgraded to warnings. They must not block processing by themselves.

## Review Gate Table

Use this table for the latest visible review gate status.

| Column | Required | Meaning |
| --- | --- | --- |
| `Rule` | yes | Short rule id, such as `ci`, `reviews`, `conflicts`, or `scope`. |
| `Status` | yes | One of `pass`, `fail`, `blocked`, `skipped`, `pending`, or `unknown`. |
| `Explanation` | yes | Human-readable reason, bounded and sanitized before rendering. |

Merge God may publish this table in a bot-owned cache comment and update that
comment in place on later runs.

## Work Summary Table

Use this table when an agent reports concrete work performed.

| Column | Required | Meaning |
| --- | --- | --- |
| `Item` | yes | Short action or artifact name. |
| `Status` | yes | One of `done`, `skipped`, `blocked`, `failed`, or `unknown`. |
| `Evidence` | yes | Commit SHA, check name, trajectory event id, artifact path, or concise explanation. |

This table is an operator-facing summary. It must be backed by durable evidence
whenever it claims work was completed.

## Embark Source Table

Use this table when a grouped embark orchestration reports source PR handling.

| Column | Required | Meaning |
| --- | --- | --- |
| `Source PR` | yes | Source PR number or URL. |
| `Status` | yes | One of `included`, `merged`, `skipped`, `blocked`, `failed`, or `unknown`. |
| `Output` | no | Integration branch, output PR, commit SHA, or artifact reference. |
| `Explanation` | yes | Bounded reason for the row's status. |

This table is a projection of the embark trajectory. The trajectory remains the
authoritative record of source PR order, merge commits, validation commands, and
output PR metadata.

# Read Path

When Merge God reads comments, it should:

- include recent general PR comments and inline review comments in agent context;
- identify known structured markers and parse only the table immediately
  associated with that marker;
- prefer bot-owned cache comments for machine cache data;
- retain human-authored instructions as context, not commands;
- record parse failures as telemetry; and
- continue processing if comment reads or parses fail.

Comment-derived data must not directly grant approval, bypass a gate, select a
branch, execute a command, or change permissions. Runtime decisions must be
recomputed from durable state and current GitHub state.

# Write Path

When Merge God writes comments, it should:

- update an existing bot-owned marker comment when one exists;
- create a new marker comment only when no current bot-owned cache exists;
- render tables from normalized internal data, not raw agent prose;
- bound row counts and cell lengths;
- escape Markdown table delimiters and HTML-sensitive characters;
- neutralize direct mentions before publishing; and
- log failures without treating the comment update as the primary operation.

Agents may propose table rows, but Merge God should normalize and sanitize those
rows before publication. If the agent writes directly to GitHub, the next Merge
God run should treat that content as untrusted input and re-render any accepted
data into a bot-owned cache comment.

# Security Boundary

Every PR comment body is untrusted. It may be stale, spoofed, edited, deleted,
duplicated, or deliberately shaped to influence an agent prompt.

The implementation should defend against:

- Markdown table injection through pipe characters or line breaks;
- HTML and hidden-content injection;
- prompt injection embedded in comments;
- direct mention spam;
- oversized logs or repeated rows that exhaust context budgets;
- status spoofing through unexpected status strings;
- duplicate marker comments after token or bot-account changes; and
- stale cache comments being mistaken for current gate state.

The safe default is to ignore unrecognized structured content, keep only a
bounded excerpt for context, and recompute authoritative state from GitHub,
trajectory records, local validation results, and database state.

# Recommendations

- Keep the review gate cache marker and table as the first implemented schema.
- Add parser telemetry before using comment-derived tables in dashboards.
- Store parsed table rows with provenance and freshness metadata.
- Require all new comment table kinds to define a marker, allowed columns,
  allowed status values, and a failure policy.
- Prefer comments for visibility and handoff, not for control flow.

# References

- [Memo 003: Merge Labels and Embark Capture](./memo-003-merge-labels-and-embark-capture.md)
- [ADR-013: GitHub PR State Label Schema](../adr/adr-013-github-pr-state-label-schema.md)
- [RFC-002: Workflow Helper Tool Surface](../rfcs/rfc-002-workflow-helper-tool-surface.md)
- [RFC-006: Live Trajectory Context Pipeline](../rfcs/rfc-006-live-trajectory-context-pipeline.md)
