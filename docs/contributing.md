---
title: Contributing
description: Repository workflow, commit style, and validation expectations for contributors.
group: Project
order: 20
---

This project is TypeScript, Node.js, ESM, and strict `tsc`. Public docs live in
`docs/`, design and governance records live in `docs-cms/`, and the Astro site
renders the public docs directly.

## Workflow

1. Create a focused branch.
2. Keep edits scoped to the requested behavior or documentation.
3. Run the checks that match the changed surface.
4. Commit with a Conventional Commit message.
5. Open a PR with a clear validation summary.

Do not mix unrelated cleanup with a behavior change unless the cleanup is
required to make the change safe.

## Commits

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Common types:

| Type | Use |
| --- | --- |
| `feat` | User-visible feature |
| `fix` | Bug fix |
| `docs` | Documentation-only change |
| `test` | Test-only change |
| `refactor` | Behavior-preserving code change |
| `perf` | Performance improvement |
| `build` | Build, dependency, or packaging change |
| `ci` | CI configuration change |
| `chore` | Maintenance that does not fit another type |

Examples:

```text
docs: add scenario-based configuration examples
fix(github): handle missing PR labels
test(sync): cover failed context persistence
```

## Validation

Run the narrowest useful check while iterating, then run the broad check before
handoff when the change touches application behavior.

```bash
npm run typecheck
npm test
npm run ci
```

Use these checks for docs and site changes:

```bash
npm run markdownlint
cd site && npm run build
docuchango validate --verbose
```

`docuchango` validates `docs-cms/` design metadata. The public docs site is
validated by the Astro build.

## Where to edit

| Change | Edit |
| --- | --- |
| User-facing docs | `docs/*.md` |
| Website shell, layout, and styling | `site/` |
| PRDs, ADRs, RFCs, memos | `docs-cms/` |
| GitHub sync library | `packages/github-sync/src/` |
| Shared runtime modules | Root `*.ts` files |
| Packaged CLI shims | Usually edit root files first; `merge_god/` contains packaged entrypoints and shims |

The website renders `docs/` directly. Do not copy public docs into `site/`.

## Pull requests

PR descriptions should include what changed, why it changed, validation
performed, and any known follow-up work. Draft PRs are appropriate while
validation, review, or scope confirmation is still pending.
