---
title: Quickstart
description: Get merge-god processing pull requests in under a minute.
group: Getting Started
order: 3
---

Make sure you've completed [Installation](./installation/) first.

## 1. Create your config

If `config.yaml` doesn't exist, the dashboard offers to build one interactively
(validates paths, suggests names, writes commented YAML). You can also copy the
example:

```bash
cp config.example.yaml config.yaml
$EDITOR config.yaml
```

Add at least one repository:

```yaml
repos:
  - path: /Users/you/dev/my-project
    name: "My Project"
    enabled: true
```

See [Configuration](./configuration/) for every option.

## 2. Validate

Dry-run checks that paths exist, are valid git repos, and that `pr-loop.ts` is
present — without starting anything:

```bash
npx tsx dashboard.ts --dry-run
```

## 3. Run

Run the dashboard (ideally inside `tmux` or `screen` so it persists):

```bash
npx tsx dashboard.ts
# or point at a specific config:
npx tsx dashboard.ts path/to/config.yaml
```

You'll see a live, color-coded view of every repo, the PRs being processed, and
recent activity.

## 4. Drive it with labels

merge-god only acts on PRs you label. From GitHub, add one of:

| Label | Behavior |
| --- | --- |
| `for-landing` | Basic processing — resolve conflicts, address reviews, fix CI, then merge. |
| `for-review` | Everything above, **plus** a second pass for code quality, security, and best practices. |
| _(no label)_ | Skipped. |

Want the agent to implement issues too? Enable
[issue watching](./usage/#issue-watching) and label issues `for-impl`.

## 5. Watch it work

As the loop runs you'll see PRs move through conflict resolution → review
response → CI fixes → merge. That's it — you're running merge-god.
