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

## Understand the Baseline

Merge God should understand the current baseline so it can distinguish PR-introduced regressions from inherited repository failures. Decisions should be grounded in the target project's contribution guide, architecture decisions, release policy, and documented validation commands. If those guardrails are missing, Merge God should surface that gap and ask for project-level guidance before treating merge decisions as routine automation.

## Survey Pass

For every open PR under consideration, collect enough context to plan work without rescanning the full codebase later:

- PR title, author, age, labels, head branch, and base branch.
- Mission or intent extracted from the PR title, body, linked issues, and recent comments.
- Current branch freshness relative to the base branch.
- CI status and failing check names.
- Merge conflict status and conflicting files.
- Review state and unresolved review comments.
- Retained scope: the behavior, files, or commits that still need to land after comparing the PR to the current base branch.
- Whether the retained scope is already present on the base branch, superseded by newer work, or in need of redesign.

## Classification

Classify PRs into planning buckets:

- Quick wins: small, fresh PRs with passing checks or low-risk failures.
- Stale PRs: old PRs based on out-of-date code that need modernization before landing.
- Failing PRs: PRs blocked by CI or validation failures.
- Conflicted PRs: PRs requiring conflict analysis before merge.
- Duplicated failures: multiple PRs failing for what appears to be the same underlying reason.
- No-op or superseded PRs: PRs whose intended behavior is already on the base branch or no longer applies.
- Redesign candidates: PRs whose retained scope conflicts with newer base behavior and should not be mechanically respun.

## Queue State

Merge God should persist explicit queue state for every PR selected by the plan. Branch names, chat history, and transient agent context are not sufficient sources of truth.

Per-PR queue state should include:

- PR number, title, URL, head ref, base ref, starting SHA, and current SHA.
- Run id, isolated worktree path, local branch, and any sibling worktrees needed for workspace validation.
- Retained scope summary, retained files, retained commits, changed files, skipped commits, and conflicts.
- Requested `disposition_setting`, which caps how much remediation Merge God may perform.
- Status such as `queued`, `syncing`, `conflicted`, `validated`, `pushed`, `merged`, `closed`, `skipped`, or `blocked`.
- Disposition such as `candidate`, `safe-to-push`, `safe-to-merge`, `stale`, `superseded`, `no-op`, `needs-redesign`, or `blocked`.
- Workspace audit result, validation results, CI state, action taken, next action, and any partial-validation waiver.

Queue state should be stored as durable runtime evidence, such as `pr-queue/state.json`, not encoded as canonical WorkflowIR node status.

## Remediation Disposition Scale

Merge God should treat remediation as a sliding scale controlled by a requested `disposition_setting`. The setting defines the maximum allowed autonomy for the PR. The computed disposition can always become more conservative when evidence shows the PR is stale, superseded, no-op, needs redesign, or blocked.

| `disposition_setting` | Allowed remediation | Required stop condition |
|---|---|---|
| `observe` | Gather context and classify only. No isolated worktree mutation. | Stop after planning or reporting. |
| `validate` | Create isolated worktree and run documented validation. No file edits, commits, pushes, or merges. | Stop after validation report and PR comment. |
| `mechanical` | Apply non-behavioral fixes such as formatting, generated artifacts, lockfile refreshes, or metadata corrections when the repo documents the command. | Stop if passing requires source behavior changes or conflict interpretation. |
| `bounded` | Resolve conflicts, address review comments, and fix failing checks when the fix preserves the PR's stated goal and retained scope. | Stop if the fix changes product behavior, expands scope, or requires architectural judgment. |
| `maintainer-approved` | Perform broader modernization or redesign work only after an explicit human gate names the accepted scope. | Stop if the requested redesign scope is ambiguous or validation cannot prove equivalence. |

Processing labels can provide defaults: `for-review` should default to `validate` or `mechanical` unless the operator requests deeper remediation, while `for-landing` can default to `bounded` for PRs with clean retained scope. Repositories may override these defaults in configuration.

Terminal computed dispositions override the requested setting:

- `no-op` and `superseded` stop without pushing replacement commits.
- `needs-redesign` stops unless the operator raises the setting to `maintainer-approved` with a scoped redesign request.
- `blocked` stops until the external blocker is removed.
- `safe-to-push` and `safe-to-merge` require evidence that all remediation stayed within the requested setting.

## Isolated Worktrees

Merge God should validate and remediate PRs in isolated worktrees under a run-scoped parent directory beside the repository under review. This keeps PR verification independent from the operator's checkout and lets coordinated runs share sibling dependency worktrees when a monorepo or local workspace requires them.

The default worktree layout should be:

```text
<repo-parent>/wt-pr-merge/<repo-name>/<run-id>/
  state.json
  pr-<number>-<safe-head-ref>/
  scratch/
```

Conflicted or partially remediated worktrees must not be reused for a different PR. Cleanup should run at the end of every terminal outcome unless the operator explicitly preserves the worktree for diagnosis.

## Merge Gate Workflow

Every PR selected for landing should pass a merge gate before Merge God approves, pushes, or merges it. The gate should be evidence-first and repo-agnostic:

1. Preflight retained scope, no-op status, and workspace health.
2. Check out the PR in an isolated worktree.
3. Fetch the latest head and base branch and reconcile drift.
4. Run the repository's documented build, test, and lint lanes.
5. Compare failures against the current base branch when full gates fail.
6. Review the diff for correctness, security, compatibility, tests, and cleanup.
7. Attempt only remediation allowed by the requested `disposition_setting`.
8. Re-run affected checks after remediation.
9. Evaluate PR title, body, labels, branch metadata, and merge policy.
10. Publish a final gate decision and PR comment with action log and evidence.

The final gate should be written once, after follow-up remediation and reruns complete. A failed intermediate validation step should not become a terminal gate decision until root cause and remediation options have been recorded.

The gate must enforce the requested `disposition_setting`. For example, a PR in `validate` mode may discover the exact source fix but must report it rather than apply it; a PR in `mechanical` mode may regenerate artifacts but must not rewrite business logic; a PR in `bounded` mode may fix conflicts or CI failures only when the retained scope remains unchanged.

## Planning Output

Before mutating any repository state, Merge God should present a plan for human approval. The plan should include:

- PRs to land first to update `main` quickly.
- PRs that need modernization work before they are worth testing again.
- Shared failures that should be fixed once in a dedicated underlying PR.
- Conflicted PRs that require higher-capability model review.
- Expected model or agent tier for each class of work.
- Required approval points and merge gates.
- Per-PR retained scope and terminal disposition when the PR is no-op, superseded, stale, or needs redesign.
- Requested remediation disposition setting and the reason it is appropriate for each PR.
- Validation lanes required before merge, including whether full gates or targeted checks are acceptable.
- Runtime artifacts that will be produced for operator handoff and audit.

## Cost-Aware Execution

Simple tasks should be delegated to cheaper or less capable models where appropriate. Planning, difficult merges, conflict resolution, and regression-risk analysis should use more capable models.

When several PRs share a failure, Merge God should prefer fixing the underlying failure once and then rebasing the affected PRs onto the updated base branch. The plan should track back-pointers from the shared fix to the PRs it unblocks.

If the process is not converging, Merge God should stop before repeated respins pollute context or duplicate work. It should record the blocker, preserve enough queue state for continuation, and escalate by requesting a higher-capability model, a fresh session with a scoped continuation prompt, or human operator input.

## Runtime Artifacts

The planning and merge gate workflows should produce durable artifacts for handoff and audit:

- `pr-queue/state.json` with the current queue state.
- `pr-merge/report.md` with phase outcomes, commands run, and final gate decision.
- Validation command logs or summarized output for failures and notable warnings.
- Baseline comparison results when PR and base branch validation differ or both fail.
- Final PR comment body generated from the same evidence used for the gate.

# Safety Rules

- Use PR merge gates before auto-merging work.
- Use conventional commits.
- Follow the project's committer guide.
- Require human approval for the generated plan before starting mutating work.
- Avoid duplicate debugging sessions for the same underlying failure.
- Keep verification and remediation work in isolated worktrees.
- Compare full-gate failures against the current base branch before classifying them as PR regressions.
- Attempt remediation only when it preserves the PR's goal, intent, and behavior.
- Post an evidence-bearing PR workflow result comment for pass and fail outcomes.
- Clean up isolated worktrees or explicitly record why they were retained.

# Drawbacks

Planning adds latency before the first PR is worked. It also requires enough context gathering to make prioritization trustworthy. Isolated worktrees and baseline comparisons consume additional disk, network, and validation time.

# Alternatives

## Process PRs Independently

Processing each PR independently is simpler but can duplicate expensive debugging and miss shared causes.

## Always Use The Strongest Model

Using the strongest model everywhere is operationally simple but wastes budget on small or mechanical tasks.

# Unresolved Questions

- What exact signal marks two failing PRs as sharing the same underlying cause?
- Which merge gates belong in code, and which remain repository policy?
- How should approved plans be persisted and resumed after interruption?
- Which repositories require full build/test/lint gates before merge, and which allow scoped validation?
- How long should retained diagnostic worktrees live before automatic cleanup?
