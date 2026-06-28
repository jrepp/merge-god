---
title: Introduction
description: What merge-god is, why it exists, and the problems it solves.
group: Getting Started
order: 1
---

## What is merge-god?

merge-god is an automated pull-request processing system. It continuously loops
over the open PRs in your repositories and uses an AI agent to do the tedious
work of **landing them**: resolving merge conflicts, responding to code reviews,
fixing failing CI, and then merging — all without babysitting.

A single live TUI dashboard watches every configured repository at once, so you
can monitor a fleet of repos from one terminal.

## Why?

Review backlog, flaky CI, and trivial merge conflicts drain a team's velocity.
merge-god offloads the mechanical parts of PR merging to an agent. You stay in
control through **GitHub labels** — you decide *which* PRs get processed and
*how*, and the agent does the rest.

## How it fits together

```text
            ┌─────────────┐    labels decide
   your repo ─────────────▶│  for-landing / for-review
            │             │
            ▼             ▼
      ┌──────────────────────────┐
      │       dashboard.ts       │  monitors N repos
      │  spawns one pr-loop/repo │
      └─────────────┬────────────┘
                    ▼
      ┌──────────────────────────┐
      │        pr-loop.ts        │  for each open PR:
      │  gather → prompt → act   │  conflicts, reviews, CI, merge
      └─────────────┬────────────┘
                    ▼
                pi + merge-god extension  ── lands the PR
```

- **`dashboard.ts`** — the orchestrator and live UI. Reads `config.yaml`,
  launches one monitor per repo, and renders status.
- **`pr-loop.ts`** — the per-repo processing loop. Gathers full PR context,
  builds a structured prompt, and hands it to the agent.
- **`pi` + merge-god extension** — the AI coding agent (must be on your `PATH`).
  merge-god talks to pi through a tiny **coordination API** and a custom pi
  extension (`pi/extensions/merge-god`) that exposes `merge_god_*` tools. See
  [how it works](./how-it-works/).

## Where to next?

- New here? Follow the **[Installation](./installation/)** guide, then the
  **[Quickstart](./quickstart/)**.
- Want the details? Read **[How it works](./how-it-works/)**.
- Ready to configure repos? See **[Configuration](./configuration/)**.
