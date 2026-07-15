---
title: Installation
description: Prerequisites and setup for merge-god.
group: Getting Started
order: 2
---

## Prerequisites

| Tool | Why | Notes |
| --- | --- | --- |
| **Node.js 22+** | Runtime | Check with `node --version` |
| **npm / npx** | Package runner | Ships with Node.js |
| **[gh](https://cli.github.com/)** | GitHub API access | Existing token auth is fine; use `gh auth login` only if needed |
| **`pi`** | The AI coding agent | Must be on your `PATH`. Follow [Pi provider setup](./pi-provider-setup/) to configure credentials and a default model. |
| **Git** | Repo operations | With a GitHub remote |

> All dependencies are declared in `package.json` and installed with
> `npm install`. The dashboard uses `chalk` and an ANSI live-renderer for the
> TUI; `@octokit/rest` provides the GitHub client; `yaml` parses `config.yaml`.

### Optional

- **`doormat`** — AWS credential manager. If present, the dashboard refreshes
  credentials before launching each repo monitor. See
  [Configuration](./configuration/#doormat-aws-credentials).

## 1. Check prerequisites

```bash
node --version
gh --version
pi --version
```

## 2. Make sure GitHub API auth is available

merge-god uses existing auth in this order: `GITHUB_TOKEN`, `GH_TOKEN`, then
`gh auth token`. If `gh auth token` already prints a token, you are done.

```bash
gh auth token >/dev/null || gh auth login
```

## 3. Initialize merge-god

Install the command globally, or substitute `npx merge-god@latest` in the
commands below:

```bash
npm install --global merge-god
```

The package includes merge-god's internal GitHub synchronization workspace;
you do not install repository workspace packages separately.

Create `config.yaml` in the current directory:

```bash
merge-god init
```

You can seed one or more repos explicitly:

```bash
merge-god init --repo /path/to/repo --repo /path/to/another-repo
```

## 4. Verify

Run the doctor before starting the dashboard:

```bash
merge-god doctor
```

## 5. Run

Run the dashboard (best inside `tmux` or `screen` for long sessions):

```bash
merge-god dashboard
```

You're ready — head to the [Quickstart](./quickstart/).

## Source checkout

For development, clone the repo and run scripts directly:

```bash
git clone https://github.com/jrepp/merge-god.git
cd merge-god
npm install
npm link
npm run dashboard
```

`npm link` exposes the same `merge-god` command from the checkout. Packaging is
verified by an isolated tarball install with `npm run test:package`.

## Why npm + tsx?

The application is written in **TypeScript (Node.js, ESM)**. Scripts are run
through [`tsx`](https://github.com/privatenumber/tsx), which transpiles and
executes `.ts` files directly — no separate build step. Dependencies and
scripts are managed by npm in `package.json`, giving you fast, reproducible
runs. See the [Node.js & tsx guide](./uv-guide.md) for an in-depth guide.
