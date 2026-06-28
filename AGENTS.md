# AGENTS.md

A guide for AI agents (and humans pairing with them) working in this repository.
Read this first.

## What this is

merge-god is an automated PR-processing system: it loops over open PRs and uses
the pi coding agent (driven through the bundled `merge-god` pi extension + a
coordination API) to resolve conflicts, respond to reviews, fix CI, and merge.
The PR-processing path uses the Claude Agent SDK directly. The user drives it
with GitHub labels. A TUI dashboard (`dashboard.ts`) monitors many repos at once.

**The application is written in TypeScript** (Node.js, ESM). It was ported from
Python; no application `.py` sources remain. GitHub integration lives in the
dedicated `@merge-god/github-sync` workspace package
(`packages/github-sync/`).

## Context map

```text
README.md            concise front door (pointers only)
AGENTS.md            this file
CHANGELOG.md         version history
PRD.md               product requirements / planning

docs/                CANONICAL prose documentation for users and contributors.
                     The website (site/) renders these files directly.
docs-cms/            Design knowledge base: PRDs, ADRs, RFCs, and memos used for
                     planning and architecture work. Not the public docs source.

package.json         Node project + deps + scripts (typecheck/test/ci/dashboard/...)
tsconfig.json        TypeScript config (strict, noUncheckedIndexedAccess, Bundler)

dashboard.ts         USER ENTRYPOINT — TUI dashboard (ANSI live-render), reads config.yaml
pr-loop.ts           per-repo processing loop (the main orchestration; defines gather_pr_context)
merge-god.ts         unified CLI dispatcher (dashboard | scan | agent | validate | test | status)
coordination.ts      merge-god coordination API + runPiAgent (bridges merge-god to the pi agent
                     over local HTTP; replaces the former `bob --json` contract)
github_ops.ts        GitHub API via @octokit/rest (token still resolved via gh CLI)
git_ops.ts           local git operations (subprocess -> spawnSync)
state_tracker.ts     branch/PR state correlation
models.ts            shared data models (interfaces + factory fns + enums)
types.ts             TypedDict-style interfaces / enums (PR context, agent, DB, dashboard)
app_store.ts         merge-god-specific SQLite store for processing/dashboard/agent data
send_approval.ts     send `{"approved": true}` to a running pr-loop
evaluate_agent_results.ts  inspect recorded agent sessions from the DB
run_agent_from_db.ts run the Claude agent on a cached PR (Process 3)
sync_pr_context.ts   gather PR context, cache to DB (Process 1+2)
init_database.ts / update_db_from_config.ts / test-prompt.ts  small utilities
config.example.yaml  sample configuration

agents/              Claude Agent SDK integration — claude_agent.ts (Anthropic SDK streaming
                     + tool-use loop), callbacks.ts. __init__.ts re-exports both.
                     NOTE: the Bedrock runtime branch throws "not yet supported in TS".

pi/                  the `merge-god` pi extension package — registers the
                     `merge_god_context` / `merge_god_complete` tools that talk
                     to the coordination API. Loaded by `pi --extension`.
merge_god/           packaged refactor exposing the `merge-god` CLI (cli.ts) and
                     validate.ts / sync.ts / run_agent.ts. Shared modules in this
                     folder are thin re-export shims of the root .ts modules — edit
                     the root copy.

tests/               node:test suite (.test.ts). Run: `npm run ci` or
                     `node --import tsx --test tests/*.test.ts`.
                     validate_process_flow.ts + test_all.ts are referenced by the CLI.

github_sync/         (removed) — superseded by packages/github-sync/ (the TS
                     @merge-god/github-sync library). The old Python sub-project
                     was deleted once the TS library covered its core.
packages/github-sync/  WORKSPACE PACKAGE — @merge-god/github-sync. Async,
                     multi-forge (GitHub / Gitea / Codeberg / GitLab) sync
                     library: normalized models + Forge abstraction + SyncStore
                     (node:sqlite) + SyncEngine. merge-god's dedicated
                     GitHub-integration layer. Own package.json + tsconfig.

site/                Astro marketing + docs site -> https://jrepp.github.io/merge-god/
                     Renders docs/*.md via a content collection (glob on ../docs).
archive/             historical code-review notes (superseded; keep but don't edit).

.github/workflows/   lint.yml (tsc + pre-commit file checks + markdownlint),
                     test.yml (tsc + node --test), docs.yml (docs-cms), site.yml (Pages)
justfile             local shortcuts for the CI checks (`just ci`)
.pre-commit-config.yaml   git hooks (file-check hooks + markdownlint only)
pyproject.toml / requirements.txt   (removed) — Python packaging is gone; the
                     app + library are npm/TS workspaces.
```

## Pointers

- **Concepts & usage:** [docs/](docs/) — start at [introduction](docs/introduction.md),
  [how-it-works](docs/how-it-works.md), [usage](docs/usage.md).
- **Config reference:** [docs/configuration.md](docs/configuration.md),
  [config.example.yaml](config.example.yaml).
- **Working on the site:** [site/README.md](site/README.md).
- **Agent eval workflow:** [docs/agent-testing.md](docs/agent-testing.md).
- **Decisions & rationale:** [docs/architecture.md](docs/architecture.md).
- **Design knowledge:** [docs-cms/](docs-cms/) for PRDs, ADRs, RFCs, and memos.

## Running

```bash
npm install                 # install deps
npx tsx merge-god.ts status # system status
npx tsx dashboard.ts        # TUI dashboard (or: npm run dashboard)
npx tsx pr-loop.ts <repo>   # per-repo loop
npm run ci                  # tsc --noEmit + node --test
```

Sibling `.ts` scripts are spawned with `node --import tsx <script.ts>` (see
`runChild` in `merge-god.ts` / `merge_god/cli.ts`).

## Principles of operation

1. **`docs/` is the single source of truth for public prose.** The website renders it
   directly — never duplicate public doc content into `site/`. Edit the markdown in
   `docs/` once; both GitHub and the site update. Keep frontmatter
   (`title`, `description`, `group`, `order`) valid on every file.

2. **`docs-cms/` is for design and governance.** Use it for PRDs, ADRs, RFCs, and
   technical memos that capture planning or architecture intent. Validate it with
   `docuchango validate --verbose` after edits.

3. **Verify with the TypeScript tooling.** Typecheck: `npx tsc --noEmit`.
   Tests: `node --import tsx --test tests/*.test.ts`. Both via `npm run ci` or
   `just ci`. The Python linters (ruff/mypy/isort/bandit) have been removed —
   there is no application Python left to lint. Conventions: strict TS,
   `noUncheckedIndexedAccess`, ESM, `moduleResolution: "Bundler"`; data property
   names stay snake_case (DB columns / API JSON compatibility) while functions
   and class methods are camelCase.

4. **`@merge-god/github-sync` is a workspace package.** It lives in
   `packages/github-sync/` with its own `package.json` + `tsconfig.json`. It is
   typechecked and tested alongside the app (root `tsc`/`npm run ci` include it).
   merge-god imports models / `GitClient` / `Forge` / `SyncStore` / `SyncEngine`
   from it — edit the library in `packages/github-sync/src/`.

5. **Two coexisting entrypoints.** Root scripts (`dashboard.ts`, `pr-loop.ts`,
   `merge-god.ts`) are the documented user interface; `merge_god/` is the
   packaged CLI refactor. Shared modules in `merge_god/` are re-export shims —
   edit the root `.ts` copy. Match the surrounding file's style.

6. **Labels drive behavior.** `for-landing` / `for-review` (PRs) and `for-impl`
   (issues). No label = the PR is skipped. When changing processing logic,
   respect this contract.

7. **Before declaring done, verify.**
   - App: `npm run ci` (tsc + node:test). Optionally `just ci` (adds markdownlint).
   - Site: `cd site && npm run build`.
   - Docs: if you touched `docs/`, confirm the site build still passes.
   - Design docs: if you touched `docs-cms/`, run `docuchango validate --verbose`.

8. **Use repository workflow for commits and PRs.** Follow
   [CONTRIBUTING.md](CONTRIBUTING.md), use Conventional Commits, and prefer one
   focused commit per coherent change unless the user asks for a different
   history shape.

9. **Scope control matters.** Before staging, inspect `git status` and avoid
   committing unrelated user files. If unrelated files are present, leave them
   unstaged and mention them in the handoff.

10. **Don't commit or push unless explicitly asked.** Don't update git config or
    use `-i`/force-push. Match existing code style; don't add comments unless asked.

11. **Keep CI green.** Workflows use path filters (e.g. `site/**`, `docs-cms/**`).
    The pre-commit CI job runs only file-check hooks (heavy tooling has dedicated
    jobs). If you add a new top-level concern, wire it into the right workflow
    rather than duplicating.
