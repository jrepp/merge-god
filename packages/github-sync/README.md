# @merge-god/github-sync

Async, **multi-forge** sync library: normalize PR / branch / CI data from GitHub,
Gitea/Codeberg, and GitLab onto shared models and persist to SQLite for offline
processing. This is merge-god's dedicated GitHub-integration layer — the
TypeScript successor to the standalone Python `github_sync/` sub-project.

## Why

merge-god previously re-implemented its GitHub/git/db layer inline (synchronously
and crudely). This library consolidates that into one async, forge-agnostic,
library-grade package with a clean test surface.

## Forges

| Forge | Backend | Status |
|---|---|---|
| GitHub | `GitHubForge` — Octokit (GraphQL reads + REST writes, throttling/pagination/retry) | full |
| Gitea | `GiteaForge` — REST (`/api/v1`) | full |
| Codeberg | `GiteaForge` (Codeberg runs Gitea) | full |
| GitLab | `GitLabForge` — `@gitbeaker/rest` | list/get MRs; others stubbed |

All backends implement the `Forge` interface (`src/forge/types.ts`); consumers
depend only on that interface.

## Quick start

```ts
import { createForgeFromRepo, SyncStore, SyncEngine } from "@merge-god/github-sync";

const store = new SyncStore("sync.db");
await store.initialize();

const { forge } = await createForgeFromRepo("/path/to/repo");
const engine = new SyncEngine(store, { forge });

// Sync all open PRs (+ branches):
const result = await engine.syncRepository("/path/to/repo");

// Or stream progress:
for await (const ev of engine.syncRepositoryStream("/path/to/repo")) {
  if ("stage" in ev) console.log(ev.stage, `${ev.percent}%`);
}
```

## Architecture

```text
src/
  models.ts        normalized models (PullRequest, PRContext, Branch, CICheck, …) + enums
  forge/
    types.ts       the Forge interface (the contract every backend implements)
    detect.ts      remote URL → RepoIdentity (forge kind + owner/repo)
    github.ts      Octokit GraphQL+REST backend
    gitea.ts       Gitea/Codeberg REST backend
    gitlab.ts      GitLab (@gitbeaker) backend
    index.ts       createForge() / createForgeFromRepo() factory
  git-client.ts    local git (branches w/ status, fetch, default branch)
  store.ts         node:sqlite (migrations, PR snapshots, PR context cache, sync history)
  engine.ts        SyncEngine: syncRepository / syncSinglePr (streaming)
  index.ts         public barrel
tests/             detect + store round-trip tests
```

## Testing

```bash
node --import tsx --test packages/github-sync/tests/*.test.ts
```
