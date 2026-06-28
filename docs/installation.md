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
| **npm** | Dependency & script management | Ships with Node.js |
| **[gh](https://cli.github.com/)** | GitHub API access | Authenticate with `gh auth login` |
| **`pi`** | The AI coding agent | Must be on your `PATH`. merge-god talks to it through a [coordination API](./how-it-works/) and the `merge-god` extension (`pi/extensions/merge-god`). |
| **Git** | Repo operations | With a GitHub remote |

> All dependencies are declared in `package.json` and installed with
> `npm install`. The dashboard uses `chalk` and an ANSI live-renderer for the
> TUI; `@octokit/rest` provides the GitHub client; `yaml` parses `config.yaml`.

### Optional

- **`doormat`** — AWS credential manager. If present, the dashboard refreshes
  credentials before launching each repo monitor. See
  [Configuration](./configuration/#doormat-aws-credentials).

## 1. Install dependencies

```bash
npm install
```

## 2. Install & authenticate the GitHub CLI

```bash
# macOS
brew install gh
# Linux: apt install gh   |   Windows: winget install --id GitHub.cli

gh auth login   # complete the login flow
```

## 3. Ensure `pi` is available

merge-god drives the [pi](https://github.com/earendil-works/pi-coding-agent) AI
coding agent through a small coordination API and a custom extension that ships
in this repo (`pi/extensions/merge-god`). Verify `pi` is reachable:

```bash
pi --version     # should print a version
```

The extension is loaded automatically when merge-god runs pi (via
`pi --extension`); you can also install it as a package with `pi install ./pi`.

## 4. Clone merge-god

```bash
git clone https://github.com/jrepp/merge-god.git
cd merge-god
```

## 5. Verify

Run the dashboard in dry-run mode to confirm everything wires up before going
live:

```bash
npx tsx dashboard.ts --dry-run
```

You're ready — head to the [Quickstart](./quickstart/).

## Why npm + tsx?

The application is written in **TypeScript (Node.js, ESM)**. Scripts are run
through [`tsx`](https://github.com/privatenumber/tsx), which transpiles and
executes `.ts` files directly — no separate build step. Dependencies and
scripts are managed by npm in `package.json`, giving you fast, reproducible
runs. See the [Node.js & tsx guide](./uv-guide.md) for an in-depth guide.
