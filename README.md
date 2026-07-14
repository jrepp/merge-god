# merge-god

<p align="center">
  <img src="site/public/merge-god.png" alt="merge-god — the multi-repo PR processing dashboard" width="640" />
</p>

> Automated PR processing and merging powered by AI agents. Loop over open PRs
> across all your repos and let an agent resolve conflicts, address reviews, fix
> failing CI, and merge — from one live dashboard.

**Docs:** <https://jrepp.github.io/merge-god/> · **In-repo docs:** [`docs/`](docs/) · **Agent guide:** [`AGENTS.md`](AGENTS.md)

---

## Why

Review backlogs, trivial conflicts, and flaky CI drain velocity. merge-god
offloads the mechanical work of landing PRs to an agent. You steer it with
**GitHub labels**; the agent does the rest. A single TUI dashboard watches every
configured repository at once.

## Highlights

- **Continuous PR loop** — iterates open PRs in order, syncing with `origin/main` first.
- **Deep context** — feeds the agent full PR metadata, comments, reviews, diffs, conflict detection, and CI status.
- **Label-driven** — `for-landing` to merge, `for-review` for a quality second pass, `for-impl` on issues to implement them as PRs. No label = skipped.
- **Multi-repo dashboard** — live, color-coded status for every repo, with non-TUI fallback for CI.
- **Observable** — JSON event logging and optional real-time notifications.

See **[How it works](docs/how-it-works.md)** for the gather -> prompt -> act pipeline.

## Quick start

```bash
# Prerequisites: Node.js 22+, gh, and `pi` on PATH
npx merge-god@latest init
npx merge-god@latest doctor
npx merge-god@latest dashboard
```

`doctor` accepts existing GitHub auth from `GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token`; run `gh auth login` only if no token is available.

For local development from source:

```bash
git clone https://github.com/jrepp/merge-god.git
cd merge-god
npm install
npm run dashboard
```

Then label a PR `for-landing` or `for-review` on GitHub and watch it land.

Full setup: **[Installation](docs/installation.md)** · **[Quickstart](docs/quickstart.md)**

## Controlling PRs with labels

Labels are how you tell merge-god what to do.

| Label | On | Effect |
| --- | --- | --- |
| `for-landing` | PR | Resolve conflicts -> address reviews -> fix CI -> merge. |
| `for-review` | PR | Everything above, plus a second quality/security review pass. |
| `duplicate` | PR | Hold processing while `merge-god duplicates` proves whether the patch is already represented. |
| `for-impl` | Issue | Implement the issue as a PR (requires `watch_issues: true`). |
| _(none)_ | PR | Skipped. Drafts and WIP PRs are always excluded. |

See **[Usage](docs/usage.md)** and **[Configuration](docs/configuration.md)**.

## Documentation

The website renders the canonical public docs in [`docs/`](docs/). Read them on the
**[website](https://jrepp.github.io/merge-god/docs/)** or directly in the repo:

- **Getting started** — [Introduction](docs/introduction.md), [Installation](docs/installation.md), [Quickstart](docs/quickstart.md)
- **Guides** — [Configuration](docs/configuration.md), [Usage](docs/usage.md), [How it works](docs/how-it-works.md)
- **Reference** — [Prompt example](docs/prompt-example.md), [Architecture decisions](docs/architecture.md), [uv guide](docs/uv-guide.md)
- **Project** — [Development](docs/development.md), [Testing](docs/testing.md), [Agent testing](docs/agent-testing.md)

Design and governance docs live in [`docs-cms/`](docs-cms/): PRDs, ADRs, RFCs, and technical memos.

Other root files: [CHANGELOG.md](CHANGELOG.md) · [PRD.md](PRD.md) · [archive/](archive/) (historical review notes).

## Requirements

Node.js 22+, [`gh`](https://cli.github.com/), and
[`pi`](https://github.com/earendil-works/pi-coding-agent) on your `PATH`
(driven through the bundled `merge-god` pi extension + coordination API).
Optional: `doormat` for AWS credentials. Details in **[Installation](docs/installation.md)**.

> The core runtime is TypeScript/ESM (Node.js, no native build step — SQLite via
> the built-in `node:sqlite`). GitHub integration lives in the dedicated
> `@merge-god/github-sync` workspace package (`packages/github-sync/`) — a
> multi-forge (GitHub / Gitea / Codeberg / GitLab) async sync library.

## Contributing

PRs welcome. Install hooks with `pre-commit install`, then emulate CI locally
with `just ci` (or `npm run ci`, which runs `tsc --noEmit` and the node:test suite).

See **[Development](docs/development.md)** and **[Testing](docs/testing.md)**.

## License

[MIT](LICENSE)
