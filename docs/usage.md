---
title: Usage
description: Operating merge-god — the dashboard, the processing loop, labels, and issue watching.
group: Guides
order: 11
---

## The dashboard

`dashboard.ts` is the control center. It reads `config.yaml`, spawns one
`pr-loop.ts` monitor per enabled repo, and renders a live view.

```bash
npx tsx dashboard.ts                 # run with config.yaml
npx tsx dashboard.ts my-config.yaml  # alternate config
npx tsx dashboard.ts --dry-run       # validate, don't start
```

The published CLI uses the same default:

```bash
npx merge-god@latest dashboard
npx merge-god@latest --config my-config.yaml dashboard
```

Run it inside `tmux` or `screen` so it survives a disconnected session. When
there's no TTY (CI, background), it automatically drops into non-interactive
logging mode.

At startup the dashboard shows the **tag selection criteria** — the labels that
trigger processing — alongside per-repo status, live processing updates,
statistics, recent activity, and recent logs.

## Interactive bootstrap

If `config.yaml` is missing, the dashboard offers to create one:

- Prompts for repository paths with live validation
- Suggests names from the directory
- Verifies each is a real git repo
- Shows a summary before saving
- Optionally runs `--dry-run` afterward

You can also start from the packaged template:

```bash
cp config.example.yaml config.yaml
```

## How PRs get selected

For each repo, the loop iterates open PRs **in order** and processes any that:

- carry a `for-landing` or `for-review` label, and
- are not drafts and not labeled WIP / work-in-process.

PRs with no recognized label are left alone. Confirmed processing order:
**issues first** (if watching), then PRs.

### `for-landing` vs `for-review`

- **`for-landing`** — the essentials to get the PR merged: resolve conflicts,
  respond to reviews, fix failing CI, then merge.
- **`for-review`** — everything above, followed by a **second pass** that
  reviews code for quality, security, performance, and best practices (SOLID,
  DRY, etc.), committing targeted improvements.

Aggregate merge-queue PRs still use these labels today. merge-god detects
queue-like PRs during context gathering and records constituent PRs, merge
commits, validation evidence, and blockers. See
[Agent-managed merge queues](./merge-queues/).

### Merge state labels

merge-god also writes one current-state label in the `merge:*` namespace:

| Label | Meaning |
| --- | --- |
| `merge:ready` | The PR may be processed or selected for a merge group. |
| `merge:processing` | merge-god is actively processing this PR. |
| `merge:embarked` | The PR is part of a multi-PR merge group. |
| `merge:blocked` | External input, credentials, permissions, or another blocker is needed. |
| `merge:failed` | Processing failed and needs investigation. |
| `merge:complete` | Processing completed from merge-god's perspective. |

The `for-*` labels are operator intent; `merge:*` labels are merge-god's output.
Only one `merge:*` state label should be present at a time. Clear a terminal
state label before asking merge-god to retry a PR.

### Review gate cache comments

merge-god may also maintain one PR comment headed `Merge God status`. When work
is blocked, the comment starts with **Required action** and then lists the checks.
Supporting run evidence is placed in a collapsed **Technical details** section.
This comment is for reviewer scanning only.

The comment is **not** a source of truth. Merge decisions must use the durable
trajectory/database state and validation evidence. If the comment update fails,
processing continues and the failure is logged.

## Bounded loop runs

Use bounded controls when testing merge-god against a whole repository without
starting a long-running daemon:

```bash
npx tsx pr-loop.ts /path/to/repo --once --dry-run
npx tsx merge-god.ts pr-loop /path/to/repo --max-iterations 3 --idle-sleep-seconds 30
```

- `--once` runs one loop iteration and exits.
- `--max-iterations N` runs at most `N` loop iterations.
- `--dry-run` still syncs the repo, discovers PRs, and plans stack order, but
  does not invoke agents or change PR state labels.
- `--idle-sleep-seconds N`, `--sync-failure-sleep-seconds N`, and
  `--between-items-sleep-seconds N` tune loop pacing for CI, local testing, or
  daemon operation.

The normal loop still runs continuously when no bound is supplied.

## Issue watching

Enable per-repo with `watch_issues: true`. merge-god then watches for issues
labeled `for-impl` and treats them as **primary tasks** (processed before PRs):

1. Creates a new branch from the issue
2. Implements the feature or fix described
3. Opens a PR
4. Links the PR back to the issue

This lets you turn a backlog issue into a landed change end-to-end.

## Observability

- **Structured logging** — every run emits JSON events with timestamps and repo
  context to `merge-god-dashboard.log` (configurable).
- **Notifications** — send real-time updates (start, complete, errors) to an
  [ntfy.sh](https://ntfy.sh) topic.
- **Inspectable prompts** — the full prompt generated for each PR can be viewed;
  see [prompt-example.md](./prompt-example.md) for a complete example.
