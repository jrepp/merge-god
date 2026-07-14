---
title: Architecture decisions
description: Architectural decision records (ADRs) for merge-god and the rationale behind each.
group: Reference
order: 21
---

This document tracks significant architectural decisions made during the development of merge-god.

---

## ADR-001: Use Node.js + TypeScript (ESM) for the Application

**Date**: 2025-11-20 (revised after the Python → TypeScript port)
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need a reliable, modern runtime and dependency story for the application,
without manual virtual-environment or build steps.

### Decision

Implement merge-god in **TypeScript** on **Node.js 22+** (ESM). Run scripts
through [`tsx`](https://github.com/privatenumber/tsx) (no separate build step)
and manage dependencies with **npm** via `package.json`. Typecheck with
`tsc --noEmit`; test with the built-in `node:test` runner.

> Historical note: the application was ported from Python. The standalone Python
> `github_sync/` sub-project was replaced by the TypeScript workspace package
> `@merge-god/github-sync` (`packages/github-sync/`) — a multi-forge (GitHub /
> Gitea / Codeberg / GitLab) async sync library that merge-god consumes.

### Rationale

- **Type safety**: strict TypeScript catches a large class of bugs at edit time.
- **Single runtime**: Node's built-in modules (fs, sqlite, test runner, fetch)
  cover most needs with no extra frameworks.
- **No build step**: `tsx` transpiles and executes `.ts` sources directly.
- **Reproducible**: dependencies are pinned in `package.json` / `lockfile`.
- **Modern standard**: ESM throughout; `moduleResolution: "Bundler"`.

### Consequences

**Positive:**

- Simplified setup (`npm install`)
- One toolchain for app + tests
- Strong typing across the codebase
- Rich npm ecosystem (e.g. `@octokit/rest`, `chalk`, `yaml`)

**Negative:**

- Requires Node.js 22+ and npm

---

## ADR-002: Use GitHub CLI (gh) for PR Operations

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need to interact with GitHub API to fetch PR data, comments, reviews, etc.

### Decision

Use GitHub CLI (`gh`) command-line tool instead of direct API calls or a GitHub library.

### Rationale

- **Authentication handled**: Uses existing gh auth
- **Well-tested**: Official GitHub tool
- **JSON output**: Easy to parse with --json flag
- **No dependencies**: No need for `@octokit/rest` or similar for this path
- **Simplified code**: CLI commands simpler than REST API calls

### Consequences

**Positive:**

- No extra runtime dependency for GitHub interaction
- Works with 2FA and SSO
- Automatic token refresh
- Less code to maintain

**Negative:**

- Requires gh CLI to be installed
- Less control over API calls
- Subprocess overhead
- Error messages may be less structured

---

## ADR-003: Structured JSON Logging

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need observable, parseable logs for automated PR processing that runs unattended.

### Decision

Emit all logs as structured JSON with timestamp, event type, and data payload.

### Rationale

- **Machine readable**: Easy to parse with jq, logstash, etc.
- **Structured**: Consistent format across all events
- **Queryable**: Can filter/search by event type or fields
- **Time-ordered**: ISO8601 timestamps for sorting
- **Integration ready**: Works with log aggregators

### Consequences

**Positive:**

- Easy to analyze logs programmatically
- Works with modern logging infrastructure
- Consistent format reduces parsing errors
- Can pipe to jq for pretty printing

**Negative:**

- Less human-readable in raw form
- More verbose than plain text
- Requires jq for nice viewing

### Format

```json
{
  "timestamp": "2025-11-21T12:00:00Z",
  "event": "event_type",
  "data": {...}
}
```

---

## ADR-004: Label-Based Processing Control

**Date**: 2025-11-21
**Status**: ✅ Accepted
**Deciders**: System designer
**Supersedes**: ADR-007 (--review flag)

### Context

Need flexible way to control PR processing mode without restarting the service or changing configuration.

### Decision

Use GitHub labels (`for-review`, `for-landing`) to control how PRs are processed, rather than command-line flags.

### Rationale

- **Per-PR control**: Different PRs can have different processing modes
- **No restart needed**: Change processing by adding/removing labels
- **Visible in GitHub**: Labels show processing intent to team
- **Self-documenting**: PR history shows processing decisions
- **Flexible**: Easy to add new processing modes via labels

### Consequences

**Positive:**

- Dynamic control without service restart
- Team can see and manage processing modes
- Natural fit with GitHub workflow
- Easy to change processing mode mid-stream

**Negative:**

- Requires labeling PRs manually
- Labels must be created in repo
- Unlabeled PRs are skipped (could be surprising)
- Less obvious than command-line flag

### Implementation

- `for-landing`: Basic processing (conflicts, reviews, CI)
- `for-review`: Comprehensive review with code improvements
- `duplicate`: Hold agent processing pending exact patch and base-containment analysis
- No label: Skip PR entirely

---

## ADR-005: Use pi (with the merge-god extension) for PR Processing

**Date**: 2025-11-20 (revised)
**Status**: ✅ Accepted
**Supersedes**: the earlier `bob --json <prompt>` subprocess contract.

### Context

Need an AI agent to actually perform PR fixes (resolve conflicts, address reviews, fix CI).

### Decision

Drive the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent
through a small **coordination API** (`coordination.ts`) plus a custom
**pi extension** (`pi/extensions/merge-god`). merge-god publishes a work item
(the gathered prompt/context); the extension's `mg_*` tools pull it and
report results back over HTTP.

### Rationale

- **Tool-based**: the agent interacts with merge-god through named tools instead of a one-shot prompt argument.
- **Coordination API**: a clean HTTP boundary (work item + result) between orchestrator and agent.
- **Comprehensive**: pi has read/bash/edit/write tools, so it can handle git, tests, code edits, and commits.
- **JSON mode**: pi's `--print --mode json` gives structured, non-interactive output.

### Consequences

**Positive:**

- Powerful, tool-mediated agent capabilities
- Can handle complex multi-step tasks
- Clean boundary between merge-god and the agent (extensible, swappable)

**Negative:**

- Requires `pi` to be installed and the merge-god extension available
- API costs for LLM usage
- Non-deterministic outcomes
- May need prompt/tool tuning

---

## PR Loop Decomposition Pattern

The PR loop is the outer shell for an automated workflow, not the home for every
rule. New PR-processing behavior should follow a functional-core,
imperative-shell pattern, migrated with a strangler approach: each new behavior
gets added behind a small pure module or async port, then the old inline logic is
deleted once callers are moved.

- Put queue inference, blocker analysis, state transitions, prompt rendering,
  and comment rendering in pure modules that accept plain data and return plain
  data.
- Put GitHub, git, database, notification, and agent calls behind small async
  ports with concrete adapters.
- Keep `pr-loop.ts` focused on CLI setup, process lifecycle, polling, and
  composition.
- Prefer async orchestration and `Promise.all` for independent I/O instead of
  adding new synchronous subprocess helpers.
- Avoid one large `PrProcessor` object. Use narrow application services that
  compose ports for one workflow step, such as context gathering, PR processing,
  issue processing, final merge execution, or review-gate commenting.

Current examples are `merge_pr_model.ts`, `ci_status_model.ts`,
`queue_validation_model.ts`, `pr_merge_blocker_model.ts`,
`evidence_comment.ts`, `git_ref.ts`, `command_runner.ts`,
`pr_context_source.ts`, `pr_context_gatherer.ts`, `pr_prompt.ts`,
`agent_gate_summary_model.ts`, `pr_processor_model.ts`,
`pr_snapshot_model.ts`, and `pr_state.ts`. Agent context replay is projected in
`pr_agent_context_model.ts`, and PR replay
logging plus trajectory metadata live in `pr_replay_model.ts`, so the DB runner
only loads cached context, creates durable records, and invokes the agent. Sync
telemetry counts are projected in `pr_context_log_model.ts` before CLI logging.
Process validation uses `pr_context_validation_model.ts` so the validator checks
the same canonical and cached alias shapes that agent replay consumes.
PR discovery categorization lives in `pr_loop_model.ts`, processing-state label
policy lives in `pr_state.ts`, and PR processing input normalization lives in
`pr_processor_model.ts`; these modules use the same PR-detail access helpers
before side effects start. PR processing lifecycle decisions, including
start/failure notifications and review-gate rows for context gathering or agent
completion, are also planned in `pr_processor_model.ts` as plain data.
`pr-loop.ts` fetches raw PR data, emits the resulting structured events, and
executes those plans through GitHub, notification, database, and agent ports.
PR queue display rows are projected in
`pr_queue_display_model.ts` before they are logged or rendered, and dashboard
event summaries are normalized in `dashboard_event_model.ts` before the TUI
turns them into user-facing log lines.
Follow-up remediation PR requests are normalized in `follow_up_pr_model.ts`
before the coordination API performs git or GitHub operations.
Design intent and migration rules are tracked in
`docs-cms/adr/adr-014-pr-loop-functional-core.md`.

---

## ADR-006: Real-Time Notifications via ntfy.sh

**Date**: 2025-11-21
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need real-time visibility into PR processing events without monitoring logs constantly.

### Decision

Use ntfy.sh for push notifications to mobile/desktop/web.

### Rationale

- **No setup**: Public topic, no registration needed
- **Multi-platform**: iOS, Android, desktop, web
- **No dependencies**: Uses Node's built-in `fetch`
- **Free**: Public topics are free
- **Simple API**: Just HTTP POST
- **Priorities**: Support urgent/high/default/low

### Consequences

**Positive:**

- Instant visibility into processing status
- Works on phone, desktop, browser
- No infrastructure to manage
- Simple implementation

**Negative:**

- Public topic (anyone can subscribe)
- No authentication on public topics
- Dependent on ntfy.sh availability
- Limited message history

### Implementation

- Topic: `merge-god-sez`
- Notifications: Start, Complete, Failure, Review status
- Emoji tags for visual identification
- High priority for failures

---

## ADR-007: Command-Line --review Flag (DEPRECATED)

**Date**: 2025-11-21
**Status**: ❌ Superseded by ADR-004
**Deciders**: System designer

### Context

Initially needed way to enable code review pass as optional feature.

### Decision

Use `--review` command-line flag to enable comprehensive code review.

### Rationale

- Simple on/off switch
- Clear opt-in behavior
- Easy to understand

### Why Superseded

Replaced by label-based control (ADR-004) for better flexibility:

- Can't change mode without restart
- Global setting affects all PRs equally
- Less visible to team
- Labels provide per-PR control

---

## ADR-008: Single Repository Target

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Script needs to know which repository to process.

### Decision

Accept repository path as command-line argument. One instance processes one repository.

### Rationale

- **Simple**: One concern per process
- **Scalable**: Run multiple instances for multiple repos
- **Isolated**: Failures in one repo don't affect others
- **Clear ownership**: Each process has single responsibility

### Consequences

**Positive:**

- Simple process model
- Easy to reason about
- Natural scaling (N processes for N repos)
- Process failures are isolated

**Negative:**

- Need multiple processes for multiple repos
- No centralized coordination
- More resource usage

### Future Consideration

Could add multi-repo support in future PRD if needed.

---

## ADR-009: 5-Minute Processing Loop

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need to balance responsiveness with resource usage and API rate limits.

### Decision

Poll for PRs every 5 minutes (300 seconds).

### Rationale

- **Rate limit friendly**: Avoids hammering GitHub API
- **Reasonable latency**: PRs processed within 5 minutes
- **Resource efficient**: CPU mostly idle
- **Configurable**: Easy to adjust if needed

### Consequences

**Positive:**

- Gentle on GitHub API
- Low CPU/memory usage when idle
- Unlikely to hit rate limits
- Reasonable response time

**Negative:**

- Not real-time (up to 5 minute delay)
- May be too slow for urgent PRs
- Multiple PRs processed sequentially

### Configuration

Currently hardcoded. Could be made configurable via environment variable if needed.

---

## ADR-010: TUI Dashboard with ANSI Live-Renderer

**Date**: 2025-11-21 (revised after the Python → TypeScript port)
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need real-time monitoring of PR processing across multiple repositories without constantly tailing logs.

### Decision

Build a TUI (Text User Interface) dashboard that renders live processing status
to the terminal using an **ANSI live-renderer** (backed by `chalk` for color and
React/`ink` for the live layout), run on Node.js.

### Rationale

- **ANSI rendering**: Tables, live updates, and color in any modern terminal
- **Terminal-based**: Works in tmux/screen sessions
- **Real-time updates**: Live display without manual refresh
- **Readable**: Better than raw JSON logs
- **No web server needed**: Simpler than web dashboard
- **Cross-platform**: Works on Linux, macOS, Windows

### Consequences

**Positive:**

- Visual monitoring without log parsing
- Real-time status updates
- Works in existing terminal workflow
- No additional infrastructure needed
- Rich formatting (colors, tables, progress)

**Negative:**

- Requires terminal window/pane
- Limited to text interface
- No remote access without tmux/screen
- Adds `chalk` / `ink` / `react` dependencies

### Implementation

- Dashboard runs as a separate process
- Spawns `pr-loop.ts` subprocesses for each repo
- Reads JSON logs from subprocess stdout
- Updates display in real-time using the ANSI live-renderer

---

## ADR-011: YAML Configuration for Multi-Repo

**Date**: 2025-11-21
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need to manage multiple repository configurations without command-line complexity.

### Decision

Use YAML configuration file for multi-repository setup.

### Rationale

- **Human-readable**: Easy to edit and understand
- **Comments**: Support for inline documentation
- **Structured**: Clear hierarchy for repo settings
- **Standard**: Well-known format
- **Per-repo settings**: Can customize each repo independently
- **Enable/disable**: Easy to turn repos on/off

### Consequences

**Positive:**

- Single file for all configuration
- Easy to add/remove repositories
- Can commit to version control
- Supports comments for documentation
- Per-repo customization possible

**Negative:**

- Adds `yaml` dependency
- Another file to manage
- Needs validation on load
- Breaking changes require migration

### Configuration Format

```yaml
repos:
  - path: /path/to/repo
    name: "Repo Name"
    enabled: true
    # Future: custom settings per repo
```

### Future Extensions

- Per-repo polling intervals
- Per-repo notification settings
- Custom prompt templates
- Label filters per repo

---

## ADR-012: Automatic Doormat Credential Loading

**Date**: 2025-11-21
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Long-running dashboard sessions may have expired AWS credentials. Need automatic credential refresh without manual intervention.

### Decision

Automatically detect and use `doormat` (if available) to refresh AWS credentials before launching each repository monitor.

### Rationale

- **Automatic**: No manual intervention needed
- **Optional**: Works with or without doormat
- **Non-blocking**: Doesn't fail if doormat unavailable
- **Per-repo**: Credentials refreshed for each repo launch
- **Transparent**: Logs attempts in dashboard

### Consequences

**Positive:**

- AWS credentials always fresh for long sessions
- No manual `doormat refresh` needed
- Graceful degradation if doormat not installed
- Works in tmux sessions without user interaction

**Negative:**

- Adds 1-2 second delay at startup per repo
- Assumes doormat command name and arguments
- No configuration for doormat command/args

### Implementation

```typescript
// In RepoMonitor.start()
this.loadDoormatCredentials();  // Non-fatal
spawnChild(["npx", "tsx", "pr-loop.ts", repoPath]);
```

Doormat check:

1. Check if `doormat` command exists
2. Run `doormat refresh` with 30s timeout
3. Log success/failure
4. Continue regardless of outcome (non-fatal)

---

## Template for New ADRs

```markdown
## ADR-XXX: [Decision Title]
**Date**: YYYY-MM-DD
**Status**: ✅ Accepted | 🚧 Proposed | ❌ Rejected | 💤 Superseded
**Deciders**: [Who made this decision]
**Supersedes/Superseded by**: [If applicable]

### Context
What is the issue we're trying to solve? What constraints exist?

### Decision
What did we decide to do?

### Rationale
Why this approach? What alternatives were considered?

### Consequences
**Positive:**
- Good outcome 1
- Good outcome 2

**Negative:**
- Tradeoff 1
- Limitation 1

### Implementation Details
Any code snippets, configs, or technical details.
```
