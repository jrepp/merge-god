# Architecture Decision Records (ADR)

This document tracks significant architectural decisions made during the development of merge-god.

---

## ADR-001: Use Python with uv for Script Execution

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need a reliable, modern way to manage dependencies and execute scripts without manual virtual environment setup.

### Decision

Use Python 3.12+ with uv (PEP 723 inline script metadata) for all scripts.

### Rationale

- **No venv needed**: uv manages dependencies automatically
- **Fast execution**: Cached environments start quickly
- **Reproducible**: Dependencies pinned in script headers
- **Modern standard**: Uses latest Python packaging standards (PEP 723)
- **Self-contained**: Scripts declare their own dependencies

### Consequences

**Positive:**

- Simplified deployment (just install uv)
- No requirements.txt to manage
- Scripts are self-documenting
- Fast cold starts

**Negative:**

- Requires uv to be installed
- Less familiar than traditional venv approach
- Limited IDE support for inline metadata

### Implementation

```python
#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
```

---

## ADR-002: Use GitHub CLI (gh) for PR Operations

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need to interact with GitHub API to fetch PR data, comments, reviews, etc.

### Decision

Use GitHub CLI (`gh`) command-line tool instead of direct API calls or Python libraries.

### Rationale

- **Authentication handled**: Uses existing gh auth
- **Well-tested**: Official GitHub tool
- **JSON output**: Easy to parse with --json flag
- **No dependencies**: No need for PyGithub or requests library
- **Simplified code**: CLI commands simpler than REST API calls

### Consequences

**Positive:**

- No Python dependencies for GitHub interaction
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
- No label: Skip PR entirely

---

## ADR-005: Use bob (Claude Code Wrapper) for PR Processing

**Date**: 2025-11-20
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need an AI agent to actually perform PR fixes (resolve conflicts, address reviews, fix CI).

### Decision

Use `bob` (Claude Code wrapper) as the agent interface.

### Rationale

- **JSON mode**: Supports --json for structured interaction
- **Comprehensive**: Can handle git, tests, code edits, commits
- **Context aware**: Claude can understand full PR context
- **Autonomous**: Can work through multiple steps independently

### Consequences

**Positive:**

- Powerful agent capabilities
- Can handle complex multi-step tasks
- Natural language prompts
- Good at following guidelines

**Negative:**

- Requires bob to be installed and configured
- API costs for Claude usage
- Non-deterministic outcomes
- May need prompt tuning

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
- **No dependencies**: Use urllib (Python stdlib)
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

## ADR-010: TUI Dashboard with Rich Library

**Date**: 2025-11-21
**Status**: ✅ Accepted
**Deciders**: System designer

### Context

Need real-time monitoring of PR processing across multiple repositories without constantly tailing logs.

### Decision

Build TUI (Text User Interface) dashboard using Python Rich library to display live processing status.

### Rationale

- **Rich library**: Excellent TUI capabilities with tables, live updates, colors
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
- Adds dependency on Rich library

### Implementation

- Dashboard runs as separate process
- Spawns pr-loop.py subprocesses for each repo
- Reads JSON logs from subprocess stdout
- Updates display in real-time using Rich Live

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

- Adds PyYAML dependency
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

```python
# In RepoMonitor.start()
self.load_doormat_credentials()  # Non-fatal
subprocess.Popen([pr-loop.py, repo_path])
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
