---
title: Development
description: Set up a dev environment, run quality checks, and contribute to merge-god.
group: Project
order: 20
---

## Repository layout

```text
merge-god/
├── dashboard.ts        # Root entrypoint: TUI dashboard (what users run)
├── pr-loop.ts          # Root entrypoint: per-repo processing loop
├── merge-god.ts        # Unified CLI dispatcher (dashboard|scan|agent|validate|test|status)
├── coordination.ts     # merge-god coordination API + runPiAgent
├── state_tracker.ts    # Branch/PR state correlation
├── models.ts           # Shared data models
├── app_store.ts        # Merge-god-specific SQLite store
├── config.example.yaml # Sample configuration
├── merge_god/          # Packaged refactor (CLI: dashboard, scan, agent, …)
│   └── agents/         # Agent prompt/guideline assets
├── agents/             # Claude Agent SDK integration (claude_agent.ts, callbacks.ts)
├── packages/github-sync/  # @merge-god/github-sync: multi-forge async sync library (TS)
├── tests/              # node:test suite (.test.ts)
├── site/               # This documentation site (Astro)
├── package.json        # Project metadata, deps, scripts (typecheck/test/ci/dashboard/...)
├── tsconfig.json       # TypeScript config (strict, noUncheckedIndexedAccess, ESM)
├── justfile            # Local shortcuts for the CI checks
└── .pre-commit-config.yaml
```

> The project is mid-refactor: the root-level scripts (`dashboard.ts`,
> `pr-loop.ts`) are the documented user interface; `merge_god/` is the packaged
> form exposing a `merge-god` CLI (`dashboard`, `scan`, `agent`, `validate`,
> `test`, `status`, `pr-loop`, `send-approval`). Shared modules in `merge_god/`
> are thin re-export shims — edit the root `.ts` copy. Both coexist today.

## One-time setup

```bash
# Install dependencies
npm install

# Install git hooks (runs markdownlint + file checks)
pre-commit install
```

## Daily workflow

The `justfile` wraps the same checks CI runs. If you have
[`just`](https://github.com/casey/just) installed:

```bash
just ci          # run the full CI suite locally (tsc + tests + markdownlint)
```

Without `just`, the underlying commands are:

```bash
npx tsc --noEmit                              # typecheck
npm test                                      # tests (node --test via tsx)
node --import tsx --test tests/*.test.ts      # tests, explicit
```

Dependencies are declared in `package.json` and installed with `npm install`.

## Code standards

Enforced by `tsc` (config in `tsconfig.json`):

- **Node.js 22+**, strict TypeScript, `noUncheckedIndexedAccess`, ESM,
  `moduleResolution: "Bundler"`.
- Data property names stay **snake_case** (DB columns / API JSON compatibility)
  while functions and class methods are **camelCase**.

## CI

Pull requests run three workflows (`.github/workflows/`):

1. **Lint and Check** — `tsc --noEmit`, pre-commit file checks, markdownlint.
2. **Tests** — `npm run ci` (`tsc --noEmit && node --import tsx --test`).
3. **Docs Validation** — validates the `docs-cms` knowledge base.

> Note: `@merge-god/github-sync` (`packages/github-sync/`) is a workspace
> package — typechecked and tested alongside the app via the root `tsc` /
> `npm run ci`.

Run `just ci` (or `npm run ci`) to emulate all of this locally before pushing.
