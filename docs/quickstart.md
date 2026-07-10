---
title: Quickstart
description: Get merge-god processing pull requests in under a minute.
group: Getting Started
order: 3
---

Make sure Node.js 22+, `gh`, and `pi` are on your `PATH`.

## 1. Initialize

Create `config.yaml` in the current directory. The CLI writes the runtime file
from the same shape documented in `config.example.yaml`:

```bash
npx merge-god@latest init
```

Or seed it with known repo paths:

```bash
npx merge-god@latest init --repo /Users/you/dev/my-project
```

The generated config is plain YAML:

```yaml
repos:
  - path: /Users/you/dev/my-project
    name: "My Project"
    enabled: true
```

See [Configuration](./configuration/) for every option.

## 2. Check your machine

`doctor` verifies Node, git, `gh`, GitHub API auth, `pi`, and repo paths:

```bash
npx merge-god@latest doctor
```

It accepts existing GitHub auth from `GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token`. Run `gh auth login` only if no token is available.

## 3. Run

Run the dashboard (ideally inside `tmux` or `screen` so it persists):

```bash
npx merge-god@latest dashboard
# or point at a specific config:
npx merge-god@latest --config path/to/config.yaml dashboard
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
