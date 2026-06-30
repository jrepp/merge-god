---
title: Node.js & tsx guide
description: How merge-god runs TypeScript via tsx and manages dependencies with npm.
group: Reference
order: 22
---

> **Note:** The main application (and the `@merge-god/github-sync` library) are
> **TypeScript / Node.js (ESM)**. This guide covers the Node.js + `tsx` workflow
> used throughout the app. The filename is kept for link stability. The Python
> `uv` workflow described in older revisions is no longer used — the former
> Python `github_sync/` sub-project was replaced by the TS
> `@merge-god/github-sync` workspace package.

## What is tsx?

[**tsx**](https://github.com/privatenumber/tsx) is a TypeScript executor for
Node.js. It transpiles and runs `.ts` files directly — no separate compile step,
no `tsc -b` before every run. merge-god's scripts are all `.ts`, so `tsx` is how
you run them.

## Why tsx?

- ⚡ **No build step** — edit a `.ts` file and run it immediately
- 🔧 **ESM-native** — handles `.ts` imports in ES modules out of the box
- 🧩 **Type-aware** — respects `tsconfig.json` (paths, target, JSX, …)
- 🪶 **Zero config** — works as soon as it's installed

## Running scripts

Every root script (e.g. `dashboard.ts`, `pr-loop.ts`, `merge-god.ts`) is run
through tsx. Use whichever form you prefer:

```bash
# via npx (no global install needed)
npx tsx dashboard.ts --dry-run
npx tsx pr-loop.ts /path/to/repo
npx tsx merge-god.ts status

# equivalent: node with tsx as a loader
node --import tsx dashboard.ts --dry-run
```

A few handy aliases are defined in `package.json`:

```bash
npm run dashboard       # = tsx dashboard.ts
npm run status          # = tsx merge-god.ts status
npm run dashboard -- --dry-run   # extra args after --
```

| Script | Purpose |
| ------ | ------- |
| **dashboard.ts** | TUI dashboard (the main user entrypoint) |
| **pr-loop.ts** | Per-repo processing loop |
| **merge-god.ts** | Unified CLI dispatcher (`dashboard\|scan\|agent\|validate\|test\|status`) |
| **sync_pr_context.ts** | Gather PR context and cache it to the DB |
| **run_agent_from_db.ts** | Run the agent on a cached PR |
| **evaluate_agent_results.ts** | Inspect recorded agent sessions |

## Dependencies

Dependencies are declared in `package.json` and installed with npm:

```bash
npm install            # install everything (first run / after pulling)
npm ci                 # clean install from the lockfile (reproducible)
npm install <pkg>      # add a dependency (also writes it to package.json)
npm install -D <pkg>   # add a devDependency
```

Key runtime deps: `@octokit/rest` (GitHub), `@merge-god/github-sync`
(forge sync + GitClient), `yaml` (config parsing), `chalk` (terminal color),
`ink` + `react` (the ANSI live-renderer for the dashboard), and
`systeminformation`.

## Checking types

Type-check the whole project with the TypeScript compiler (no emit):

```bash
npx tsc --noEmit
# or
npm run typecheck
```

This is the direct equivalent of a linter/typecheck pass in other ecosystems.
The config lives in `tsconfig.json` (strict mode,
`noUncheckedIndexedAccess`, ESM, `moduleResolution: "Bundler"`).

## Tests

Tests use Node's built-in test runner (`node:test`), executed through tsx so
they can import `.ts` sources:

```bash
npm test                                       # all tests
node --import tsx --test tests/*.test.ts       # explicit
node --import tsx --test tests/stores.test.ts          # one file
```

## Running the full CI suite locally

The combined typecheck + test gate (what CI runs):

```bash
npm run ci          # = tsc --noEmit && node --import tsx --test tests/*.test.ts
```

If you have [`just`](https://github.com/casey/just) installed, `just ci` adds
markdownlint on top.

## Troubleshooting

### `npx tsx` not found

```bash
npm install          # tsx is a devDependency in package.json
```

### Wrong Node version

```bash
node --version       # must be 22+ (see "engines" in package.json)
```

### TypeScript errors before a run

`tsx` skips type-checking for speed. To catch type errors, run the typecheck
explicitly:

```bash
npx tsc --noEmit
```

## Learn more

- [tsx documentation](https://github.com/privatenumber/tsx)
- [Node.js test runner](https://nodejs.org/api/test.html)
- [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
