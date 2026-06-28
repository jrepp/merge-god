---
title: Prompt Fragment Contracts
status: Draft
author: Engineering Team
created: 2026-06-28T06:48:37Z
tags: [design, merge-god, prompts, rfc, workflow-ir]
id: rfc-003
project_id: merge-god
doc_uuid: e967fa46-0fac-4a47-b83a-ad32ac775dd5
---

# Summary

Parent spec: [RFC-001: Merge God WorkflowIR Extraction](./rfc-001-workflow-ir-extraction.md)

This document extracts the prompt design from `merge-god-main` into reusable prompt contracts. A `WorkflowIR` orchestrator should reference these prompt contracts instead of embedding large raw prompts in workflow nodes.

# Detailed Design

## Prompt Catalog

| Prompt ref | Used By | Purpose |
|---|---|---|
| `prompt://merge-god.pr.monolithic@1.0.0` | Legacy PR agent path | Build one comprehensive prompt containing PR metadata, conflicts, CI, comments, files, commits, guidelines, mission, and critical rules. |
| `prompt://merge-god.pr-review.second-pass@1.0.0` | Legacy `for-review` second pass | Review full diff for quality, correctness, security, performance, tests, documentation, and targeted improvements. |
| `prompt://merge-god.pr-task.analyze@1.0.0` | Agent task loop | Analyze PR state and identify required work. |
| `prompt://merge-god.pr-task.resolve-conflicts@1.0.0` | Agent task loop | Resolve merge conflicts in known conflicting files. |
| `prompt://merge-god.pr-task.address-reviews@1.0.0` | Agent task loop | Address inline review comments systematically. |
| `prompt://merge-god.pr-task.fix-ci@1.0.0` | Agent task loop | Fix failing CI checks from PR context. |
| `prompt://merge-god.pr-task.code-review@1.0.0` | Agent task loop, `for-review` only | Perform comprehensive code review and make targeted improvements. |
| `prompt://merge-god.pr-task.validate@1.0.0` | Agent task loop | Run final validation and report status. |
| `prompt://merge-god.issue.implement@1.0.0` | Issue implementation path | Implement a labeled GitHub issue, create branch, commit changes, and create a PR. |

## Shared PR Task Base Context

Every task-specific PR prompt includes a base context equivalent to:

```text
# Task: {{task.description}}

## PR Context
- PR number and title
- Head branch -> base branch
- Author
- URL

## Testing & Evaluation Context
- Actions may be logged for evaluation
- Session metrics may include tasks, tokens, duration, cost
- File operations may be recorded
- Results may be evaluated for success rate, quality, performance, and error handling
```

Required context object: `schema://merge-god/agent.pr-context/v1`.

## Task Prompt Contracts

| Prompt ref | Required Context | Instructions | Allowed Tools |
|---|---|---|---|
| `prompt://merge-god.pr-task.analyze@1.0.0` | PR details, changed file count, commit count, review comment count, conflict flag, failing CI flag, review decision | Analyze merge conflicts, failing CI, outstanding reviews, and potential improvements. Provide structured analysis. | `read_file`, `list_files` |
| `prompt://merge-god.pr-task.resolve-conflicts@1.0.0` | conflicting file list, base branch, PR diff | Resolve conflicts, preserve both sides where possible, remove markers, test, commit. Begin by reading files. | `read_file`, `list_files`, `edit_file`, `run_tests`, `git_commit` |
| `prompt://merge-god.pr-task.address-reviews@1.0.0` | review comments, changed files | Address each review comment thoughtfully, test changes, commit with review references. | `read_file`, `list_files`, `edit_file`, `run_tests`, `git_commit` |
| `prompt://merge-god.pr-task.fix-ci@1.0.0` | failing checks, changed files | Understand each check, fix root causes, verify tests, commit descriptively. | `read_file`, `list_files`, `edit_file`, `run_tests`, `git_commit` |
| `prompt://merge-god.pr-task.code-review@1.0.0` | changed files, guidelines, diff or readable files | Review correctness, security, performance, best practices, testing, and docs; make targeted improvements. | `read_file`, `list_files`, `edit_file`, `run_tests`, `git_commit` |
| `prompt://merge-god.pr-task.validate@1.0.0` | changed files, current PR context | Run final validation, verify conflicts/reviews/CI readiness, report status. | `read_file`, `list_files`, `run_tests` |

## Monolithic PR Prompt Fallback

`prompt://merge-god.pr.monolithic@1.0.0` preserves the original rich prompt design as a single-prompt fallback.

| Section | Included When | Content |
|---|---|---|
| PR header | Always | PR number, title, author, branch, URL |
| PR description | Body present | Full PR body |
| PR statistics | Always | files changed, additions, deletions |
| Merge conflicts | conflicts present | base branch and conflicting file list |
| CI/CD status | checks present | total, passed, failed, pending, skipped; failed checks with URLs |
| Review status | decision present | approved, changes requested, pending |
| Code review comments | comments present | up to 20 inline review comments with author, path, line, body |
| Discussion comments | comments present | last 10 general comments |
| Changed files | files present | up to 50 file entries with status and additions/deletions |
| Commit history | commits present | last 10 commits with short SHA and subject |
| Mission | Always | ordered task list based on conflicts, review comments, CI failures, tests, push, CI verification |
| Guidelines | guidelines present | contribution/PR guidelines in fenced block |
| Commit examples | no guidelines and examples present | recent commit subjects in fenced block |
| Critical rules | Always | no assistant branding, professional commits, focused changes, test thoroughly, respond to reviews, document blockers |

Mission task construction rules:

- If conflicts exist, resolving conflicts is first and critical.
- Always checkout PR branch and sync with base branch.
- If review comments exist, address all review comments.
- If CI failures exist, fix all failing checks.
- Always run local tests/checks.
- Always push changes back to head branch.
- Always verify CI passes after pushing.

## Second-Pass Review Prompt

`prompt://merge-god.pr-review.second-pass@1.0.0` preserves the older second-pass review prompt used for comprehensive `for-review` mode.

Review checklist:

- Bugs or logical errors
- Security vulnerabilities
- Performance issues
- Code duplication
- Poor error handling
- Missing edge cases
- Style consistency
- Missing tests
- Missing or unclear documentation

Rules:

- Fix issues directly.
- Write clear commits.
- Run tests.
- Make surgical changes.
- Avoid assistant branding.
- Skip uncertain changes and document why.

## Issue Implementation Prompt

`prompt://merge-god.issue.implement@1.0.0` implements an issue labeled for implementation.

Required context:

- issue number
- title
- URL
- issue body
- generated branch name
- default branch
- project guidelines
- commit examples

Semantic instructions:

```text
Implement the feature or fix described in the issue.
Write tests for the implementation.
Commit focused changes with clear messages and issue references.
Create a pull request from the issue branch to the default branch.
Link the PR back to the issue using a closing keyword.
Test thoroughly before creating the PR.
```

## Prompt Assembly Rules For A Harness

1. Resolve prompt ref by `task.id`.
2. Render shared PR task base context first.
3. Render task-specific instructions.
4. Bind structured context values by schema, not by ad-hoc string concatenation where possible.
5. Expose only the tools permitted for that task.
6. Preserve critical safety rules outside prose where the orchestrator supports policies.
7. Record prompt ref, semantic version, rendered prompt hash, model, and tool set in runtime trace.

## Critical Rules To Preserve As Policy

| Rule | Policy Mapping |
|---|---|
| No assistant branding in commits, comments, or code | Commit/message linter or post-generation validation |
| Make focused, minimal changes | Diff review heuristic or reviewer gate |
| Test before push or completion | Required validation task/tool call |
| Document blockers clearly | Failure artifact requirement |
| Avoid mutating unrelated files | Worktree diff guard |
| Keep tool paths inside repo | Tool sandbox/path guard |
| Do not exceed requested remediation disposition | Tool policy must reject edits, commits, pushes, approvals, or merges outside `disposition_setting` |
