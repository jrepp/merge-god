---
title: Configuration
description: The complete reference for config.yaml — repositories, labels, issue watching, and doormat.
group: Guides
order: 10
---

merge-god is configured through a single YAML file (`config.yaml` by default).
Point the dashboard at any file with `npx tsx dashboard.ts path/to/config.yaml`.

You can also bootstrap one interactively: run `npx tsx dashboard.ts` with no
config present and it will walk you through adding repos with live validation.

## Repositories

The heart of the config is the `repos` list. Each entry is a repository to
monitor.

```yaml
repos:
  - path: /Users/you/dev/my-project
    name: "My Project"
    enabled: true
    watch_issues: false
    interactive: true
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | — **required** | Absolute path to a local git repo with a GitHub remote. |
| `name` | string | dir name | Display name in the dashboard. |
| `enabled` | bool | `true` | Set `false` to skip this repo. |
| `watch_issues` | bool | `false` | Monitor `for-impl` issues and implement them as PRs. See [Usage](./usage/#issue-watching). |
| `interactive` | bool | `true` | In TUI mode, prompt for confirmation before acting. Ignored (always off) in non-TUI mode. |

```yaml
repos:
  - path: /Users/you/dev/disabled-repo
    name: "Disabled Project"
    enabled: false   # skipped entirely
```

## Label-based processing

Labels live on GitHub, not in the config — but they're how you steer merge-god.

| Label | Applied to | Effect |
| --- | --- | --- |
| `for-landing` | PR | Process to land: conflicts → reviews → CI → merge. |
| `for-review` | PR | `for-landing` **plus** a second quality-review pass. |
| `for-impl` | Issue | Implement the issue as a PR (requires `watch_issues: true`). |

A PR with **no label is skipped**. Drafts and WIP/work-in-process PRs are always
excluded.

## Doormat (AWS credentials)

If you use `doormat` for short-lived AWS credentials, merge-god refreshes them
before launching each repo monitor. It's auto-detected — but you can pin a
custom command:

```yaml
doormat:
  command: ["doormat", "aws", "login"]   # exact invocation
  timeout: 30                            # seconds (default: 30)
```

Credential refresh is **non-fatal**: if it fails, processing continues and the
attempt is logged.

## Validating your config

Always dry-run after editing:

```bash
npx tsx dashboard.ts --dry-run
```

It verifies that every `path` exists and is a valid git repo, that
`pr-loop.ts` is present, and summarizes what would launch — then exits
without starting anything.
