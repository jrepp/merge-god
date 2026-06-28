---
title: PR Triage And Merge Planning Workflow
status: Draft
author: Engineering Team
created: 2026-06-28T06:48:37Z
tags: [merge-god, planning, pull-requests, rfc]
id: rfc-004
project_id: merge-god
doc_uuid: daca6721-ab06-498d-8b3c-a89d99724d2b
---

# Summary

This RFC defines a planning workflow for surveying open PRs, extracting enough context to prioritize them, and presenting a cost-aware merge plan for human approval before Merge God starts mutating work.

# Motivation

Merge God should not treat every open PR as an isolated task. Older PRs, failing PRs, and conflicted PRs often share causes. A planning pass lets the system identify quick wins, group related failures, and choose the right model or execution mode before spending agent time.

# Detailed Design

## Survey Pass

For every open PR under consideration, collect enough context to plan work without rescanning the full codebase later:

- PR title, author, age, labels, head branch, and base branch.
- Mission or intent extracted from the PR title, body, linked issues, and recent comments.
- Current branch freshness relative to the base branch.
- CI status and failing check names.
- Merge conflict status and conflicting files.
- Review state and unresolved review comments.

## Classification

Classify PRs into planning buckets:

- Quick wins: small, fresh PRs with passing checks or low-risk failures.
- Stale PRs: old PRs based on out-of-date code that need modernization before landing.
- Failing PRs: PRs blocked by CI or validation failures.
- Conflicted PRs: PRs requiring conflict analysis before merge.
- Duplicated failures: multiple PRs failing for what appears to be the same underlying reason.

## Planning Output

Before mutating any repository state, Merge God should present a plan for human approval. The plan should include:

- PRs to land first to update `main` quickly.
- PRs that need modernization work before they are worth testing again.
- Shared failures that should be fixed once in a dedicated underlying PR.
- Conflicted PRs that require higher-capability model review.
- Expected model or agent tier for each class of work.
- Required approval points and merge gates.

## Cost-Aware Execution

Simple tasks should be delegated to cheaper or less capable models where appropriate. Planning, difficult merges, conflict resolution, and regression-risk analysis should use more capable models.

When several PRs share a failure, Merge God should prefer fixing the underlying failure once and then rebasing the affected PRs onto the updated base branch. The plan should track back-pointers from the shared fix to the PRs it unblocks.

# Safety Rules

- Use PR merge gates before auto-merging work.
- Use conventional commits.
- Follow the project's committer guide.
- Require human approval for the generated plan before starting mutating work.
- Avoid duplicate debugging sessions for the same underlying failure.

# Drawbacks

Planning adds latency before the first PR is worked. It also requires enough context gathering to make prioritization trustworthy.

# Alternatives

## Process PRs Independently

Processing each PR independently is simpler but can duplicate expensive debugging and miss shared causes.

## Always Use The Strongest Model

Using the strongest model everywhere is operationally simple but wastes budget on small or mechanical tasks.

# Unresolved Questions

- What exact signal marks two failing PRs as sharing the same underlying cause?
- Which merge gates belong in code, and which remain repository policy?
- How should approved plans be persisted and resumed after interruption?
