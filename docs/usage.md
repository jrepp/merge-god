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
- are not drafts, labeled WIP / work-in-process, or labeled `duplicate`.

PRs with no recognized label are left alone. Confirmed processing order:
**issues first** (if watching), then PRs.

### Duplicate PRs

The `duplicate` label is a hold, not proof that a PR can be closed. merge-god
removes these PRs from the agent queue and analyzes them directly from current
Git and GitHub state; it does not require the state database.

```bash
npx tsx merge-god.ts duplicates
```

The analyzer calculates stable patch identities for open PRs and checks every
retained commit patch against the target base branch. Its outcomes are:

| Outcome | Behavior |
| --- | --- |
| `already_landed` | Every retained patch is on the base branch. This is the only automatically closable outcome. |
| `canonical_open` | Preferred representative of an exact open patch cluster; land it first. |
| `exact_open_duplicate` | Exact open peer of the canonical PR; keep it open until the canonical PR lands. |
| `embark_candidate` | Different patch with overlapping files; compare retained scope and validate both merge-commit orders in an isolated cohort. |
| `unverified_duplicate` | The label is not supported by exact evidence; compare retained scope and synthesize unique work. |
| `analysis_failed` | Evidence collection was incomplete; do not mutate the PR. |

Analysis is read-only from the PR author's perspective. It may fetch remote Git
objects, but it does not rewrite branches, open the database, comment, label,
or close PRs. To close only exact patches already represented on the base:

```bash
npx tsx merge-god.ts duplicates --close-landed
```

Each closure receives a comment with the stable patch ID and canonical merged
PR when GitHub can identify it, then receives `merge:complete`. Similar titles
or overlapping files never satisfy the automatic-close threshold. Overlap with
different patch identities is routed to embark planning so unique behavior can
be combined and tested without rewriting either source branch.

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

## Process or resume one PR

From inside a repository checkout, one command syncs current PR context and
runs the agent:

```bash
npx tsx merge-god.ts pr 123
```

The current checkout is preferred over repositories in `config.yaml`. Pass
`--repo-path` only when invoking the command from somewhere else. If PR 123 has
an unfinished trajectory, `pr` resumes it automatically instead of creating a
second run.

Resume interrupted work without looking up a database run ID:

```bash
npx tsx merge-god.ts resume      # latest resumable PR in this checkout
npx tsx merge-god.ts resume 123  # require resumable work for PR 123
```

`resume` fails cleanly when no matching trajectory is resumable. Add
`--dry-run` to either command to inspect the inferred repository, database, and
operation without syncing or invoking an agent. The lower-level `scan` and
`agent` commands remain available for process-isolation debugging.

## Bounded loop runs

Use bounded controls when testing merge-god against a whole repository without
starting a long-running daemon:

```bash
npx tsx merge-god.ts repo --once --dry-run
npx tsx merge-god.ts run --once
npx tsx merge-god.ts run --once --dry-run
npx tsx merge-god.ts duplicates
npx tsx pr-loop.ts /path/to/repo --once --dry-run
npx tsx merge-god.ts pr-loop /path/to/repo --max-iterations 3 --idle-sleep-seconds 30
```

`repo` infers the current git checkout. `run` uses the sole enabled repository
from `config.yaml`, including its optional `repo` identity guard, for dashboards
and automation. Pass a path to `pr-loop` explicitly when more than one
repository is enabled. The root CLI and dashboard pass one central state
database to repository workers; target checkouts no longer receive a stray
`merge-god-state.db`.

- `--once` runs one loop iteration and exits.
- `--max-iterations N` runs at most `N` loop iterations.
- `--dry-run` inspects the current checkout, discovers PRs, and plans stack
  order without fetching, switching branches, pulling, opening a state
  database, invoking agents, or changing PR state labels.
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
