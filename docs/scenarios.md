---
title: Scenarios
description: Example merge-god setups for common repo and team workflows.
group: Guides
order: 13
---

Use these examples as starting points. The installed CLI creates a real
`config.yaml`; the repository also ships `config.example.yaml` as the commented
template.

## One repo, human approval

Good first setup: one repository, issue watching off, and TUI confirmations on.

```yaml
repos:
  - path: /Users/you/dev/product-api
    name: "Product API"
    enabled: true
    watch_issues: false
    interactive: true
```

Run it with:

```bash
npx merge-god@latest dashboard
```

Label a PR `for-landing` when it is safe for merge-god to resolve conflicts,
address reviews, fix CI, and merge.

## Multi-repo landing queue

Use the dashboard when several repos need the same label-driven loop.

```yaml
repos:
  - path: /Users/you/dev/web
    name: "Web"
    enabled: true
    interactive: true

  - path: /Users/you/dev/api
    name: "API"
    enabled: true
    interactive: true

  - path: /Users/you/dev/mobile
    name: "Mobile"
    enabled: false
```

Disabled repos remain visible in config but are skipped. This is useful when a
repo is in a freeze or you want to pause automation without deleting the entry.

## Issue-to-PR implementation

Turn on issue watching per repo when `for-impl` issues should become branches
and PRs.

```yaml
repos:
  - path: /Users/you/dev/internal-tools
    name: "Internal Tools"
    enabled: true
    watch_issues: true
    interactive: true
```

merge-god processes watched issues before PRs. Keep `interactive: true` while
you are learning the flow so the TUI asks before mutating branches or PRs.

## Background runner

For a long-running session, put the dashboard inside `tmux` or `screen`.

```yaml
repos:
  - path: /srv/repos/service-a
    name: "Service A"
    enabled: true
    interactive: false

  - path: /srv/repos/service-b
    name: "Service B"
    enabled: true
    interactive: false
```

```bash
tmux new -s merge-god
npx merge-god@latest --config /srv/merge-god/config.yaml dashboard
```

In non-TUI mode, repository-level `interactive` settings are ignored and the
loop runs non-interactively.

## AWS credential refresh

If target repos need short-lived AWS credentials, configure the global
`doormat` command. Credential refresh is logged but non-fatal.

```yaml
doormat:
  command: ["doormat", "aws", "login"]
  timeout: 30

repos:
  - path: /Users/you/dev/aws-service
    name: "AWS Service"
    enabled: true
    interactive: true
```

## Repo-local merge policy

Use `config.yaml` to choose watched repos. Put merge policy in each target
repository's `.merge-rules.yaml`.

```yaml
repos:
  - path: /Users/you/dev/platform
    name: "Platform"
    enabled: true
```

Example `.merge-rules.yaml` in `/Users/you/dev/platform`:

```yaml
version: 1
title: Platform merge rules

rules:
  - Run applicable gates before making a final merge decision.
  - Preserve the PR's retained scope during remediation.
  - Escalate when remediation requires product judgment.

remediation:
  threshold: bounded
```

See [Configuration](./configuration/) for the full field reference.
