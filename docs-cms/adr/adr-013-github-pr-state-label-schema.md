---
title: GitHub PR State Label Schema
status: Proposed
created: 2026-06-28T06:48:37Z
deciders: Engineering Team
tags: [architecture, github, labels, merge-god]
id: adr-013
project_id: merge-god
doc_uuid: 0c19fc76-97dd-41ce-b21b-60a43d423540
---

# GitHub PR State Label Schema

# Context

Merge God already uses GitHub labels such as `for-landing` and `for-review` as input signals for whether and how a PR should be processed. Those labels express owner intent, but they do not tell the PR owner where Merge God is in its own workflow.

PR owners need a fast, low-friction way to see state transitions without reading every bot comment. Automation also needs a cheap query surface for dashboards, queues, and recovery after restarts.

At the same time, PR comments are still the right place for detailed communication: specific actions taken, evidence collected, validation output, gate failures, and owner requests.

# Decision

Use GitHub PR labels in the `merge:*` namespace as Merge God's state schema. These labels act as compact topics/tags for current machine state. Use PR comments as the detailed event log.

Existing processing labels remain input labels:

- `for-landing`: PR owner requests landing-focused processing.
- `for-review`: PR owner requests review plus landing-focused processing.

New `merge:*` labels are output labels controlled by Merge God:

- `merge:ready`: Merge God may process or embark this PR.
- `merge:processing`: Merge God is actively processing this PR.
- `merge:embarked`: Merge God included this PR in an embark cohort.
- `merge:blocked`: Merge God cannot continue until an external blocker is removed.
- `merge:failed`: Merge God attempted work and hit a failure that needs investigation.
- `merge:complete`: Merge God completed processing for this PR.

Only one primary `merge:*` lifecycle label should be present on a PR at a time.

# State Transitions

The expected lifecycle is:

1. `merge:ready`
2. `merge:processing` or `merge:embarked`
3. One terminal or waiting state:
   - `merge:blocked`
   - `merge:failed`
   - `merge:complete`

Merge God may move a PR backward when new commits, new review comments, or changed checks invalidate previous state. For example, an operator may remove `merge:complete` and apply `merge:ready` after the author pushes new commits.

# Label Semantics

`merge:ready` means the PR is eligible for Merge God processing. Operators or selection logic may apply it to mark a PR as ready for isolated PR processing or an embark cohort.

`merge:processing` means Merge God is actively operating on the PR through the one-PR processing path. This may include gathering context, resolving conflicts, addressing review comments, fixing checks, pushing commits, or preparing to merge.

`merge:embarked` means Merge God included the PR in a multi-PR embark cohort. The source PR is being represented in a grouped integration attempt that can merge multiple ready PRs together, run validation once, and produce a single output PR.

`merge:blocked` means an external condition prevents progress. Examples include missing permissions, unavailable required checks, branch protection that Merge God cannot satisfy, missing credentials, or unresolved product decisions. A comment must name the blocker and the evidence.

`merge:failed` means Merge God attempted an operation and failed unexpectedly or repeatedly. A comment must include the failed operation, the visible error, and any known recovery path.

`merge:complete` means processing is complete from Merge God's perspective. The PR may be merged, or the source PR may have been represented by a completed embark output.

# Comments Versus Labels

Use labels for current state that should be visible and queryable at a glance.

Use comments for:

- Actions Merge God took.
- Evidence for decisions.
- Gate failure details.
- Validation summaries.
- Owner action requests.
- Links to logs, commits, checks, or generated artifacts.

Merge God may maintain one bot-owned review gate cache comment with rows for
rule, status, and explanation. That comment is a projection for human scanning,
not an input to merge decisions. Durable trajectory/database state and validation
evidence remain the source of truth.

Do not encode detailed evidence in label names. Prefer `merge:blocked` plus a comment over labels such as `merge:blocked-ci-timeout-on-macos`.

# Update Rules

Merge God owns labels with the `merge:` prefix and may add or remove them. It must not mutate non-`merge:` labels except where a separate decision explicitly allows that.

When changing lifecycle state, Merge God should remove any existing primary lifecycle `merge:*` label before adding the new one. If GitHub API operations are not atomic, Merge God should converge to a single primary lifecycle label on the next sync pass.

Merge God should not post a comment for every polling cycle. It should comment only when:

- A terminal or waiting state is reached.
- A validation or gate failure requires owner attention.
- Merge God pushed commits or changed PR contents.
- The requested owner action changes.
- A retryable failure becomes persistent.

# Query Examples

Useful GitHub queries:

- `label:merge:ready`: PRs ready for Merge God processing or embark selection.
- `label:merge:processing`: PRs currently being worked by Merge God.
- `label:merge:embarked`: PRs included in a multi-PR embark cohort.
- `label:merge:blocked label:for-landing`: landing requests that cannot proceed.
- `label:merge:failed`: PRs needing Merge God operator investigation.
- `label:merge:complete`: PRs completed by Merge God.

# Consequences

## Positive

- PR owners can see Merge God's current state without reading the full comment history.
- Dashboards and sync loops can query PR state cheaply using labels.
- Comments stay focused on durable evidence and actionable details.
- The `merge:` namespace separates Merge God output from user-owned processing intent.

## Negative

- Repositories must create or allow creation of additional labels.
- Label churn can be noisy if state transitions are too granular.
- Non-atomic label updates can temporarily show more than one lifecycle label.

## Neutral

- This schema complements, but does not replace, persisted local state.
- State labels describe the latest known Merge God state, not a complete history.

# Alternatives Considered

## Comments Only

Using comments for all communication would preserve a full timeline but make current state hard to scan and expensive to query.

## GitHub Commit Statuses Or Checks

Checks are useful for validation gates, but they are less visible in PR lists and are a poor fit for states such as `merge:blocked` or `merge:embarked`.

## Reusing `for-*` Labels

The existing `for-landing` and `for-review` labels are owner intent. Reusing them for Merge God state would blur who controls each label and make state transitions ambiguous.

# References

- [ADR-004: Label-Based Processing Control](./adr-004-label-based-processing-control.md)
