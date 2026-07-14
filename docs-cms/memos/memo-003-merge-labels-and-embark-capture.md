---
title: Merge Labels and Embark Capture
author: Engineering Team
created: 2026-06-30T00:00:00Z
tags: [embark, github, labels, memo, trajectory]
id: memo-003
project_id: merge-god
doc_uuid: 8d7ab5c1-99a3-4de3-9780-85e9f4e1f8c8
---

# Overview

Merge God now uses compact GitHub PR state labels in the `merge:*` namespace.
These labels are intentionally short so repository PR lists stay readable while
still exposing current automation state.

# Label Contract

The user-controlled input labels remain unchanged:

- `for-landing`: request landing-focused processing.
- `for-review`: request review plus landing-focused processing.

Merge God controls these output labels:

- `merge:ready`: the PR may be processed or selected for an embark cohort.
- `merge:processing`: the one-PR processing path is active.
- `merge:embarked`: the PR is included in a multi-PR embark cohort.
- `merge:blocked`: external input, credentials, permissions, or another blocker
  prevents progress.
- `merge:failed`: processing failed and needs investigation.
- `merge:complete`: processing completed from Merge God's perspective.

Only one `merge:*` state label should be present on a PR at a time. Merge God
adds the target label and then removes stale `merge:*` labels as a convergence
step because GitHub label updates are not atomic.

# Embark Capture

An embark run groups multiple ready source PRs into one durable trajectory. The
trajectory stores:

- the source PR numbers and branch refs,
- the intended merge-commit order,
- the cohort id,
- the integration branch or output PR metadata, when known,
- validation commands for the grouped build/test pass, and
- a cohort-level merge-gate activity.

This is capture-first. The durable record can represent an orchestration where
Merge God creates multiple merge commits from existing ready PRs and validates
them together as one output PR. Actual automatic merge-commit creation and output
PR creation are separate execution work.

# Evidence-Guided Cohort Recovery

A failed cohort merge gate is recoverable when durable evidence identifies the
failed member. Recovery preserves validated members, records conflict files and
evidence references on the failed member, and derives deferred members from the
original merge order. It then creates a high-tier, non-mutating
`embark_planning` activity and reopens the run in `embark_replanning`.

This transition avoids two unsafe outcomes: discarding a validated prefix, or
forcing a conflict resolution that exceeds the failed member's disposition.
The recovery activity may recommend a smaller cohort, redesign, salvage path,
or operator handoff. It may not edit, push, or merge while its tool policy is
non-mutating.

# Operator Notes

- Use `merge:ready` to mark PRs eligible for normal processing or embark
  selection.
- Use `merge:embarked` to make source PRs visibly tied to a grouped run.
- Use comments, trajectory events, and evidence artifacts for details; do not
  encode failure details in label names.
- Clear terminal labels before asking Merge God to retry a PR.

# Review Gate Comment Cache

Merge God may maintain one PR comment marked internally as the review gate cache.
The reviewer-facing comment uses this order:

- required action,
- checks and results,
- a collapsed technical-details section when evidence is available.

The required action must identify the specific next step and completion
condition. Internal terms such as trajectory, workset, activity, disposition,
or evidence ref must not lead the comment. Avoid generic explainer headings such
as “Why it matters”; use operational headings such as “Problem,” “Required
action,” “Checks,” and “Technical details.”

Machine-local evidence may remain in the durable run record, but it must not be
cited in a PR comment. Publish it as a PR attachment or reviewer-accessible
forge/CI artifact first. The publication boundary removes opaque evidence refs,
home-directory paths, local URLs, URL credentials and query parameters, and
email addresses from reviewer-facing output.

This comment is intentionally not authoritative. It can be missing, stale,
duplicated after token changes, or unavailable due to GitHub API failures.
Runtime decisions must read durable trajectory/database state and validation
evidence, not the comment body.

The renderer treats all rule and explanation text as untrusted. It strips control
characters, limits field length, escapes Markdown table delimiters and HTML, and
neutralizes direct mentions. Status values are normalized to a small allowlist:
`pass`, `fail`, `blocked`, `skipped`, `pending`, or `unknown`.

# References

- [ADR-013: GitHub PR State Label Schema](../adr/adr-013-github-pr-state-label-schema.md)
- [RFC-005: Advanced PR Salvage and Embark Planning](../rfcs/rfc-005-advanced-pr-salvage-and-embark-planning.md)
