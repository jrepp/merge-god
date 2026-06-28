---
title: Workflow Helper Tool Surface
status: Draft
author: Engineering Team
created: 2026-06-28T06:48:37Z
tags: [design, merge-god, rfc, workflow-ir]
id: rfc-002
project_id: merge-god
doc_uuid: 346eded0-ce65-4ad3-b4db-ebd7a1f6bb11
---

# Summary

Parent spec: [RFC-001: Merge God WorkflowIR Extraction](./rfc-001-workflow-ir-extraction.md)

This document declares the helper tools and external systems required to execute the extracted Merge God workflow in a `WorkflowIR` orchestrator. The workflow depends on these capabilities, but the orchestrator may implement them with any language, CLI, service, SDK, or sandboxed agent runtime.

# Detailed Design

## Tool Contract Principles

- Tool implementations must be replaceable across harnesses.
- Tool outputs should be structured and serializable.
- Secret values must not appear in WorkflowIR, logs, prompt text, or telemetry.
- Mutating tools must enforce repository path boundaries.
- Tool failures should return structured errors instead of crashing the workflow host.

## External Systems

| System ID | Purpose | Required Credentials |
|---|---|---|
| `github-cli` | Discover issues/PRs and fetch PR context | GitHub-authenticated identity with repo read/write permissions as needed |
| `git-cli` | Sync local repo, branch management, commit operations | Local git credentials for remote fetch/push |
| `sqlite-state` | Optional state, PR context snapshots, agent sessions, actions, metrics | Local filesystem write access |
| `llm-provider` | Agent task execution and optional issue implementation | Anthropic or Bedrock-compatible model credentials |
| `notifier` | Optional operator notifications | Notification service credentials if required |
| `validation-runner` | Repository-documented build, test, lint, and static-analysis commands | Local command execution in isolated worktrees |

## Repository And Runtime Tools

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/repo.validate@v1` | `repo_path` | `{valid, errors[]}` | Verify path exists, is a git repo, git works, and GitHub auth is available. |
| `tool://merge-god/state.initialize@v1` | `repo_path`, optional `db_path` | `{database_enabled, db_path, repo_name}` | Open or create local state DB; failure may be non-fatal. |
| `tool://merge-god/git.detect-default-branch@v1` | `repo_path` | `{default_branch}` | Prefer `origin/HEAD`, fallback to `main`, `master`, `develop`, then `main`. |
| `tool://merge-god/repo.load-guidance@v1` | `repo_path`, `default_branch` | `{guidelines, commit_examples}` | Read contribution/PR guideline files; if none, fetch recent commit subjects. |
| `tool://merge-god/git.sync-repository@v1` | `repo_path`, `default_branch` | `{synced}` | Fetch all remotes, checkout default branch, pull latest. |
| `tool://merge-god/git.create-isolated-worktree@v1` | `repo_path`, `repo_name`, `pr_number`, `head_ref`, `run_id` | `{worktree_root, worktree_path, local_branch, starting_head}` | Create one clean PR worktree under a run-scoped directory beside the repo under review. |
| `tool://merge-god/git.sync-pr-worktree@v1` | `worktree_path`, `head_ref`, `base_ref` | `{synced, current_head, behind_by, ahead_by, conflicts[]}` | Fetch latest head/base and reconcile drift in the isolated worktree. |
| `tool://merge-god/git.cleanup-worktree@v1` | `worktree_path`, `retain_reason?` | `{removed, retained, reason?}` | Remove the isolated worktree unless an operator or policy explicitly retains it for diagnosis. |

## GitHub Discovery Tools

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/github.list-issues@v1` | `repo_path`, label default `for-impl` | `{issues[]}` | Return open issues with implementation label and required metadata. |
| `tool://merge-god/github.list-prs-by-mode@v1` | `repo_path`, labels | `{for_review[], for_landing[], untagged[], filtered}` | List open PRs, skip drafts and WIP labels, classify `for-review` before `for-landing`. |
| `tool://merge-god/github.gather-pr-context@v1` | `repo_path`, `pr_number`, `head_branch`, `base_branch`, `url` | `{pr_details, pr_context_raw}` | Gather PR details, CI status, comments, review comments, commits, files, merge conflict info, and diff. |

## PR Context Gatherer Subtools

The gathered PR context can be implemented as one composite tool or as these subtools.

| Logical subtool | Output |
|---|---|
| `get_pr_details` | PR number, title, body, state, branch names, draft/mergeability, author, labels, additions/deletions, reviews, review decision, status check rollup |
| `analyze_ci_status` | total/passed/failed/pending/skipped counts and failed check details |
| `get_pr_comments` | General PR/issue comments |
| `get_pr_review_comments` | Inline review comments with file paths and line/original-line metadata |
| `get_pr_commits` | PR commit list and messages |
| `get_pr_files` | Changed files with status/additions/deletions |
| `check_merge_conflicts` | `has_conflicts`, `conflicting_files`, `conflict_count`, optional error |
| `get_pr_diff` | Full PR diff, optionally size-capped by the consuming prompt |

## State And Context Tools

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/state.save-pr-context@v1` | `repo_name`, `pr_number`, `pr_details`, `pr_context_raw` | `{saved}` | Persist context snapshot; failure should be warning-level in the live flow. |
| `tool://merge-god/context.build-pr-context@v1` | `pr_details`, `pr_context_raw`, `guidelines`, `commit_examples` | `PRContext` | Normalize gathered dictionaries into agent context: PR metadata, conflict flags, failing CI, comments, files, diff, commits, labels. |
| `tool://merge-god/agent.decompose-pr-tasks@v1` | `PRContext`, `mode` | `AgentTask[]` | Build ordered tasks: `analyze`, optional `resolve_conflicts`, optional `address_reviews`, optional `fix_ci`, optional `code_review`, final `validate`. |

## PR Merge Gate Tools

These tools support the landing gate and should run outside the LLM tool loop unless a specific remediation subworkflow delegates a bounded task to an agent. The gate owns the evidence record and enforces the requested `disposition_setting`.

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/pr-merge.initialize-queue-state@v1` | `pr`, `repo_name`, `disposition_setting`, `run_id?` | `{queue_state, artifact_paths}` | Create or resume durable PR queue state, including worktree paths, retained scope placeholders, validation slots, and evidence artifact paths. |
| `tool://merge-god/pr.retained-scope-preflight@v1` | `pr`, `default_branch`, `pr_context` | `{disposition, retained_scope, changed_files, skipped_commits, reason}` | Determine whether the PR remains a candidate, is already on base, is superseded, needs redesign, or is blocked before expensive validation. |
| `tool://merge-god/validation.run-lane@v1` | `worktree_path`, `lane`, `commands?`, `scope?` | `{lane, command_results[], status, summary, artifact_refs[]}` | Run repository-documented build, test, lint, or static-analysis commands in the isolated worktree. |
| `tool://merge-god/validation.compare-with-base@v1` | `repo_path`, `worktree_path`, `default_branch`, `validation_results` | `{introduced_failures[], inherited_failures[], base_results?, pr_results, classification}` | Compare full-gate failures against the current base branch before classifying them as PR regressions. |
| `tool://merge-god/pr.review-diff@v1` | `worktree_path`, `base_ref`, `retained_scope`, `guidelines` | `{findings[], remediation_needed, severity, summary}` | Review retained diff for correctness, security, compatibility, tests, cleanup, and scope drift. |
| `tool://merge-god/pr.remediate-within-disposition@v1` | `worktree_path`, `pr_context`, `retained_scope`, `findings`, `disposition_setting` | `{changed_files[], commits[], skipped_items[], policy_violations[], summary}` | Apply only remediation permitted by the requested disposition setting; reject changes that exceed the policy cap. |
| `tool://merge-god/validation.rerun-affected@v1` | `worktree_path`, `changed_files`, `previous_results` | `{command_results[], status, summary}` | Re-run only the checks affected by remediation unless repository policy requires full gates. |
| `tool://merge-god/pr.evaluate-quality@v1` | `pr`, `pr_context`, `validation_results`, `findings` | `{quality_result, blockers[], warnings[]}` | Evaluate title, body, labels, branch metadata, review state, and repository merge policy. |
| `tool://merge-god/pr.final-gate@v1` | `queue_state`, `validation_results`, `findings`, `quality_result`, `disposition_setting` | `{disposition, gate, merge_allowed, push_allowed, evidence_summary}` | Produce one final gate decision after remediation and reruns, enforcing the requested disposition setting. |
| `tool://merge-god/pr.merge-or-approve@v1` | `pr`, `gate_result`, `worktree_path`, `repo_policy` | `{action, merged, approved, pushed, url?}` | Merge, approve, or push according to repository policy only when the final gate permits it. |
| `tool://merge-god/pr.publish-workflow-comment@v1` | `pr`, `gate_result`, `queue_state`, `artifact_refs` | `{posted, comment_url?}` | Publish a PR comment with phase outcomes, commands run, remediation performed or skipped, blockers, and evidence links. |

## Remediation Disposition Policy

The merge gate must enforce remediation limits before any mutating tool or agent task runs.

| `disposition_setting` | Tool behavior |
|---|---|
| `observe` | Do not create mutating worktree state or run remediation. Context gathering and planning only. |
| `validate` | Allow isolated worktree checkout and validation commands. Reject file edits, commits, pushes, approvals, and merges. |
| `mechanical` | Allow documented non-behavioral commands such as formatting, generation, lockfile refreshes, and metadata repairs. Reject source behavior changes. |
| `bounded` | Allow conflict resolution, review-comment fixes, and CI fixes only when retained scope and PR intent remain unchanged. |
| `maintainer-approved` | Allow broader modernization or redesign only when a human gate provides the accepted scope and validation requirements. |

Terminal computed dispositions such as `no-op`, `superseded`, `needs-redesign`, and `blocked` must stop remediation even when the requested setting is permissive.

## Agent Runtime Tools

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/agent.initialize@v1` | model/provider env | `{client_ref, model, session_id?}` | Resolve Anthropic/Bedrock client and model. |
| `tool://merge-god/prompt.build-task-prompt@v1` | `task`, `PRContext` | `{prompt, prompt_ref}` | Build focused task prompt from prompt catalog fragments. |
| `tool://merge-god/agent.select-task-tools@v1` | `task.id` | `{tools[]}` | Always include `read_file`, `list_files`; add mutating tools for conflict/review/CI/code-review tasks. |
| `tool://merge-god/agent.llm-turn@v1` | `conversation_history`, `tools`, `model` | `{text, tool_uses[], final_message}` | Stream one LLM turn and collect any requested tool calls. |
| `tool://merge-god/agent.execute-tool-calls@v1` | `tool_uses[]`, `repo_path` | `{tool_results[], actions[]}` | Execute requested tools, record telemetry, and return tool results for the next LLM turn. |

## Agent-Exposed Repository Tools

These are the tools exposed to the LLM during the agent task loop.

| Tool name | Mutates Repo | Input Schema | Key Safety Requirements |
|---|---:|---|---|
| `read_file` | No | `{path}` | Path must remain inside repo; file must exist; reject directories, binary files, and files over configured size limit. |
| `list_files` | No | `{path?, pattern?}` | Path must remain inside repo; directory must exist; sorted deterministic output. |
| `edit_file` | Yes | `{path, changes: [{old, new}]}` | Path must remain inside repo; reject `.git`; file must exist; `old` must occur exactly once; reject no-op edits. |
| `run_tests` | Maybe | `{test_path?}` | Optional path must remain inside repo; use configured test runner; enforce timeout; return stdout/stderr and exit code. |
| `git_commit` | Yes | `{message, files?}` | Commit only selected or current changes; message required; should avoid committing secrets or unrelated files. |

## Issue Implementation Tool

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/agent.run-issue-implementation@v1` | issue details, branch name, default branch, guidelines, commit examples | `{success, created_pr?, logs}` | Execute an issue implementation prompt with repository mutation and PR creation autonomy. |

## Notifications And Telemetry

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/notify@v1` | title, message, priority?, tags? | `{delivered}` | Notification failure is non-fatal unless a harness policy says otherwise. |
| `merge-god.telemetry.*` | event type, data | `{logged}` | Emit structured JSON or equivalent trace events. |

## Required Harness Policies

An orchestrator executing this workflow should provide these policies:

| Policy | Requirement |
|---|---|
| Worktree lock | Only one mutating workflow should operate on a repo path at a time unless isolated worktrees are used. |
| Isolated PR worktrees | PR validation and remediation should happen in a run-scoped worktree, not the operator's checkout. |
| Secret redaction | GitHub and LLM credentials must be redacted from logs, prompts, and tool outputs. |
| Prompt trace | Each LLM turn should record prompt ref, model, tool definitions, streamed text, tool calls, and tool results as runtime evidence. |
| Mutation audit | File edits, test runs, and git commits should be recorded with success/failure and target path/message. |
| Disposition enforcement | Mutating tools must reject actions outside the requested `disposition_setting`. |
| Baseline comparison | Full-gate failures should be compared against the current base branch before classifying PR regressions. |
| Evidence artifacts | Queue state, validation summaries, final gate results, and PR comment bodies should be durable artifacts. |
| Loop bound | Agent tool loops must enforce a maximum iteration count, default 25. |
| Timer durability | Five-minute monitor waits and one-minute sync retry waits should be durable sleeps in production orchestration, not process-blocking sleeps. |
