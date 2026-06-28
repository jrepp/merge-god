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

## Repository And Runtime Tools

| Tool ref | Required Inputs | Output Contract | Semantics |
|---|---|---|---|
| `tool://merge-god/repo.validate@v1` | `repo_path` | `{valid, errors[]}` | Verify path exists, is a git repo, git works, and GitHub auth is available. |
| `tool://merge-god/state.initialize@v1` | `repo_path`, optional `db_path` | `{database_enabled, db_path, repo_name}` | Open or create local state DB; failure may be non-fatal. |
| `tool://merge-god/git.detect-default-branch@v1` | `repo_path` | `{default_branch}` | Prefer `origin/HEAD`, fallback to `main`, `master`, `develop`, then `main`. |
| `tool://merge-god/repo.load-guidance@v1` | `repo_path`, `default_branch` | `{guidelines, commit_examples}` | Read contribution/PR guideline files; if none, fetch recent commit subjects. |
| `tool://merge-god/git.sync-repository@v1` | `repo_path`, `default_branch` | `{synced}` | Fetch all remotes, checkout default branch, pull latest. |

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
| Secret redaction | GitHub and LLM credentials must be redacted from logs, prompts, and tool outputs. |
| Prompt trace | Each LLM turn should record prompt ref, model, tool definitions, streamed text, tool calls, and tool results as runtime evidence. |
| Mutation audit | File edits, test runs, and git commits should be recorded with success/failure and target path/message. |
| Loop bound | Agent tool loops must enforce a maximum iteration count, default 25. |
| Timer durability | Five-minute monitor waits and one-minute sync retry waits should be durable sleeps in production orchestration, not process-blocking sleeps. |
