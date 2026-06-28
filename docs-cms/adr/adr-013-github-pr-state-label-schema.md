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

Use GitHub PR labels in the `mg:*` namespace as Merge God's state schema. These labels act as compact topics/tags for current machine state. Use PR comments as the detailed event log.

Existing processing labels remain input labels:

- `for-landing`: PR owner requests landing-focused processing.
- `for-review`: PR owner requests review plus landing-focused processing.

New `mg:*` labels are output labels controlled by Merge God:

- `mg:proposed`: PR has been discovered as eligible or potentially eligible for Merge God processing.
- `mg:valid-queued`: PR is queued for validation but validation has not started.
- `mg:validating`: Merge God is gathering context and running validation gates.
- `mg:ready`: Validation passed and the PR is ready for Merge God to start work.
- `mg:embarked`: Merge God has started making or attempting changes for this PR.
- `mg:needs-review`: Merge God completed its work and needs human review or approval before landing.
- `mg:owner-action`: Merge God is waiting for the PR owner or reviewer to act.
- `mg:blocked`: Merge God cannot continue until an external blocker is removed.
- `mg:failed`: Merge God attempted work and hit a failure that needs investigation.
- `mg:landed`: Merge God successfully landed or confirmed the PR was merged.

Only one primary `mg:*` lifecycle label should be present on a PR at a time.

# State Transitions

The expected lifecycle is:

1. `mg:proposed`
2. `mg:valid-queued`
3. `mg:validating`
4. `mg:ready`
5. `mg:embarked`
6. One terminal or waiting state:
   - `mg:needs-review`
   - `mg:owner-action`
   - `mg:blocked`
   - `mg:failed`
   - `mg:landed`

Merge God may move a PR backward when new commits, new review comments, or changed checks invalidate previous state. For example, a PR in `mg:needs-review` may return to `mg:valid-queued` after the author pushes new commits.

# Label Semantics

`mg:proposed` means Merge God has identified the PR as a possible candidate. It does not mean work has started.

`mg:valid-queued` means the PR is in a validation queue. This state is useful for dashboards and for owners who need to know that Merge God has accepted the request but has not inspected the PR yet.

`mg:validating` means Merge God is reading PR metadata, diff, comments, reviews, mergeability, and CI state. Comments should only be posted from this state when validation fails or when the validation result changes what the owner should do.

`mg:ready` means required validation gates passed. The PR is safe for Merge God to start its configured processing mode.

`mg:embarked` means Merge God is actively operating on the PR. This may include resolving conflicts, addressing review comments, fixing failing checks, pushing commits, or preparing to merge.

`mg:needs-review` means Merge God made changes or reached a decision that should be reviewed by a human. A comment should summarize what changed and what the reviewer should inspect.

`mg:owner-action` means Merge God needs input or action from the PR owner. A comment must explain the requested action.

`mg:blocked` means an external condition prevents progress. Examples include missing permissions, unavailable required checks, branch protection that Merge God cannot satisfy, or unresolved product decisions. A comment must name the blocker and the evidence.

`mg:failed` means Merge God attempted an operation and failed unexpectedly or repeatedly. A comment must include the failed operation, the visible error, and any known recovery path.

`mg:landed` means the PR is merged or otherwise complete from Merge God's perspective.

# Comments Versus Labels

Use labels for current state that should be visible and queryable at a glance.

Use comments for:

- Actions Merge God took.
- Evidence for decisions.
- Gate failure details.
- Validation summaries.
- Owner action requests.
- Links to logs, commits, checks, or generated artifacts.

Do not encode detailed evidence in label names. Prefer `mg:blocked` plus a comment over labels such as `mg:blocked-ci-timeout-on-macos`.

# Update Rules

Merge God owns labels with the `mg:` prefix and may add or remove them. It must not mutate non-`mg:` labels except where a separate decision explicitly allows that.

When changing lifecycle state, Merge God should remove any existing primary lifecycle `mg:*` label before adding the new one. If GitHub API operations are not atomic, Merge God should converge to a single primary lifecycle label on the next sync pass.

Merge God should not post a comment for every polling cycle. It should comment only when:

- A terminal or waiting state is reached.
- A validation or gate failure requires owner attention.
- Merge God pushed commits or changed PR contents.
- The requested owner action changes.
- A retryable failure becomes persistent.

# Query Examples

Useful GitHub queries:

- `label:mg:valid-queued`: PRs waiting for validation.
- `label:mg:embarked`: PRs currently being worked by Merge God.
- `label:mg:needs-review`: PRs ready for human review after Merge God work.
- `label:mg:blocked label:for-landing`: landing requests that cannot proceed.
- `label:mg:failed`: PRs needing Merge God operator investigation.

# Consequences

## Positive

- PR owners can see Merge God's current state without reading the full comment history.
- Dashboards and sync loops can query PR state cheaply using labels.
- Comments stay focused on durable evidence and actionable details.
- The `mg:` namespace separates Merge God output from user-owned processing intent.

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

Checks are useful for validation gates, but they are less visible in PR lists and are a poor fit for states such as `mg:owner-action` or `mg:needs-review`.

## Reusing `for-*` Labels

The existing `for-landing` and `for-review` labels are owner intent. Reusing them for Merge God state would blur who controls each label and make state transitions ambiguous.

# References

- [ADR-004: Label-Based Processing Control](./adr-004-label-based-processing-control.md)