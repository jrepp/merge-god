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
