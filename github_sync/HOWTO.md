# github_sync HOWTO

A comprehensive guide to using `github_sync` as a cache artifact for quickly processing GitHub PRs, comments, and review feedback.

## Workspace Structure

A `github_sync` workspace has this layout:

```
workspace/
├── sync.db                    # PR cache database
├── projects/
│   └── my-repo/               # Bare clone (read-only, shared objects)
│       ├── HEAD
│       ├── objects/
│       └── project.json
└── worktrees/
    └── my-repo/
        ├── feature-branch_abc123/   # Worker worktree
        └── fix-bug_def456/          # Another worktree
```

## Overview

`github_sync` is an async Python library that syncs GitHub repository data (PRs, branches, CI status, comments) to a local SQLite database. This allows you to:

- **Quickly identify PRs needing work** - Query cached PR state without hitting GitHub API
- **Process review feedback offline** - All comments/reviews stored locally
- **Track CI status** - Monitor which PRs are passing/failing
- **Export portable artifacts** - Share sync state between machines/workers

## CLI Quick Start

The fastest way to use `github_sync`:

```bash
# Initialize a workspace
python -m github_sync.cli init ./my-workspace git@github.com:org/repo.git

# Sync PRs from GitHub
cd my-workspace
python -m github_sync.cli sync

# See what needs attention
python -m github_sync.cli triage

# Work on a specific PR (creates worktree)
python -m github_sync.cli workon 123
# Output: cd /path/to/worktree

# Show PR details and review comments
python -m github_sync.cli show 123

# List active worktrees
python -m github_sync.cli worktrees
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `init <workspace> <url>` | Initialize workspace with bare clone |
| `sync` | Sync PRs and contexts from GitHub |
| `triage` | Show PRs needing attention (CI fail, reviews) |
| `workon <pr>` | Create/get worktree for PR's branch |
| `show <pr>` | Show PR details, review state, comments |
| `worktrees` | List active worktrees |

---

## Quick Start (Python API)

### 1. Create and Sync a Database

```python
import asyncio
from github_sync import SyncStore, SyncEngine

async def main():
    # Create database (or open existing)
    store = SyncStore("prs.db")
    await store.initialize()

    # Sync repository
    engine = SyncEngine(store)
    result = await engine.sync_repository("/path/to/local/repo")

    print(f"Synced {result.prs_synced} PRs, {result.contexts_synced} contexts")

asyncio.run(main())
```

### 2. Query PRs That Need Work

```python
async def find_prs_needing_work(store: SyncStore, repo_name: str):
    # Get all active PRs
    active_prs = await store.get_active_prs(repo_name)

    for pr in active_prs:
        pr_number = pr["pr_number"]

        # Get full context including comments
        context = await store.get_latest_pr_context(repo_name, pr_number)

        if context:
            # Check for unresolved review comments
            if context.review_comments:
                print(f"PR #{pr_number}: {len(context.review_comments)} review comments")

            # Check for recent activity
            if context.comments:
                print(f"PR #{pr_number}: {len(context.comments)} discussion comments")
```

---

## Available Queries

### Repository Queries

| Query | Method | Description |
|-------|--------|-------------|
| Get all repos | `store.get_all_repositories()` | List all synced repositories |
| Get single repo | `store.get_repository(name)` | Get repository metadata by name |
| Get statistics | `store.get_statistics()` | Database stats (counts, sync rate, size) |

### Pull Request Queries

| Query | Method | Description |
|-------|--------|-------------|
| Active PRs | `store.get_active_prs(repo_name)` | All open PRs (latest snapshot) |
| All PRs | `store.get_all_prs(repo_name, limit)` | All PRs with optional limit |
| Single PR | `store.get_latest_pr_snapshot(repo, number)` | Latest snapshot of specific PR |

### PR Context Queries (Comments, Diffs, Reviews)

| Query | Method | Description |
|-------|--------|-------------|
| PR Context | `store.get_latest_pr_context(repo, number)` | Full context: diff, comments, reviews |
| All Contexts | `store.get_all_pr_contexts(repo_name)` | All PR contexts for repo |

### Project Metadata

| Query | Method | Description |
|-------|--------|-------------|
| Get metadata | `store.get_project_metadata()` | Project ID and custom metadata |
| Set metadata | `store.set_project_metadata(id, meta)` | Store project identification |
| Update key | `store.update_project_metadata(key, val)` | Update single metadata field |

---

## Data Structures

### PRContext - Complete PR Information

```python
@dataclass
class PRContext:
    repo_name: str           # Repository name
    pr_number: int           # PR number
    pr_url: str             # GitHub URL
    diff: str               # Full diff text
    body: str               # PR description
    comments: list[dict]     # Issue comments (discussion)
    review_comments: list[dict]  # Inline code review comments
    commits: list[dict]      # Commit list
    files: list[dict]        # Changed files with patches
    conflicts: dict          # Merge conflict info
    ci_checks: dict          # CI status summary
    captured_at: datetime    # When synced
```

### PR Snapshot Fields

```python
{
    "pr_number": int,
    "title": str,
    "state": str,           # "open", "closed", "merged", "draft"
    "head_branch": str,
    "base_branch": str,
    "author": str,
    "draft": bool,
    "ci_status": str,       # "success", "failure", "pending", "none"
    "labels": list[str],
    "snapshot_time": datetime
}
```

---

## Common Workflows

### Workflow 1: Find PRs with Unaddressed Review Comments

```python
async def prs_with_pending_reviews(store: SyncStore, repo: str):
    """Find PRs that have review comments (likely need attention)."""
    contexts = await store.get_all_pr_contexts(repo)

    pending = []
    for ctx in contexts:
        if ctx.review_comments:
            pending.append({
                "pr": ctx.pr_number,
                "url": ctx.pr_url,
                "review_comments": len(ctx.review_comments),
                "latest_comment": ctx.review_comments[-1] if ctx.review_comments else None
            })

    return sorted(pending, key=lambda x: x["review_comments"], reverse=True)
```

### Workflow 2: Find PRs by Label (for-review, for-landing)

```python
async def prs_by_processing_mode(store: SyncStore, repo: str):
    """Categorize PRs by their processing mode labels."""
    prs = await store.get_active_prs(repo)

    for_review = []
    for_landing = []
    no_label = []

    for pr in prs:
        labels = {l.lower() for l in pr.get("labels", [])}
        if "for-review" in labels:
            for_review.append(pr)
        elif "for-landing" in labels:
            for_landing.append(pr)
        else:
            no_label.append(pr)

    return {
        "for_review": for_review,
        "for_landing": for_landing,
        "unlabeled": no_label
    }
```

### Workflow 3: Find PRs with Failing CI

```python
async def prs_with_failing_ci(store: SyncStore, repo: str):
    """Find PRs where CI is failing."""
    prs = await store.get_active_prs(repo)
    return [pr for pr in prs if pr.get("ci_status") == "failure"]
```

### Workflow 4: Get PR Diff and Review Comments Together

```python
async def get_review_context(store: SyncStore, repo: str, pr_number: int):
    """Get everything needed to review a PR."""
    context = await store.get_latest_pr_context(repo, pr_number)
    snapshot = await store.get_latest_pr_snapshot(repo, pr_number)

    return {
        "pr_info": snapshot,
        "diff": context.diff if context else "",
        "body": context.body if context else "",
        "comments": context.comments if context else [],
        "review_comments": context.review_comments if context else [],
        "files": context.files if context else [],
        "ci": context.ci_checks if context else {}
    }
```

### Workflow 5: Export for Offline Analysis

```python
from github_sync import export_database, ArtifactFormat

async def export_for_analysis(store: SyncStore):
    """Export all data for offline analysis or sharing."""
    result = await export_database(
        store,
        "pr-cache.json.gz",
        format=ArtifactFormat.JSON_GZ,
        include_contexts=True
    )
    print(f"Exported {result['pull_requests']} PRs, {result['pr_contexts']} contexts")
    print(f"File size: {result['file_size_mb']:.2f} MB")
```

---

## Using the Action Registry

The Action Registry provides a high-level API with validation and hooks:

```python
from github_sync import ActionRegistry, ListActivePRs, GetPRContext, GetStatistics

async def query_with_registry(store: SyncStore):
    registry = ActionRegistry(store)

    # List active PRs
    result = await registry.execute(ListActivePRs(repo_name="my-repo"))
    if result.success:
        for pr in result.data["result"]:
            print(f"PR #{pr['pr_number']}: {pr['title']}")

    # Get specific PR context
    result = await registry.execute(GetPRContext(repo_name="my-repo", pr_number=123))
    if result.success and result.data.get("result"):
        ctx = result.data["result"]
        print(f"Diff size: {len(ctx.diff)} chars")
        print(f"Comments: {len(ctx.comments)}")

    # Get database stats
    result = await registry.execute(GetStatistics())
    print(f"Stats: {result.data['result']}")
```

### Available Actions

| Action | Purpose |
|--------|---------|
| `ListActivePRs(repo_name)` | Get all open PRs |
| `ListAllPRs(repo_name, limit)` | Get all PRs with limit |
| `GetPRSnapshot(repo_name, pr_number)` | Get single PR snapshot |
| `GetPRContext(repo_name, pr_number)` | Get full PR context |
| `ListPRContexts(repo_name)` | Get all PR contexts |
| `GetStatistics()` | Get database stats |
| `GetRepository(repo_name)` | Get repo metadata |
| `ListRepositories()` | List all repos |
| `CleanupOldSnapshots(days)` | Remove old data |

---

## Syncing Options

### Full Repository Sync

```python
# Sync all open PRs with full context
result = await engine.sync_repository(
    "/path/to/repo",
    include_context=True,   # Fetch diffs, comments, etc.
    fetch_first=True        # git fetch before analyzing
)
```

### Sync Specific PRs by Label

```python
# Only sync PRs with specific labels
result = await engine.sync_repository(
    "/path/to/repo",
    labels=["for-review", "for-landing"]
)
```

### Sync Single PR

```python
# Update just one PR
result = await engine.sync_single_pr("/path/to/repo", pr_number=123)
```

### Streaming Progress (for UI/FastAPI)

```python
async for update in engine.sync_repository_stream("/path/to/repo"):
    if isinstance(update, SyncProgress):
        print(f"{update.stage}: {update.percent:.0f}%")
    elif isinstance(update, SyncResult):
        print(f"Done: {update.prs_synced} PRs synced")
```

---

## Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `repositories` | Repository metadata (name, path, default_branch) |
| `pull_requests` | PR snapshots with state, labels, CI status |
| `pr_context` | Full PR context (diff, comments, commits, files) |
| `branch_states` | Local/remote branch tracking info |
| `sync_history` | Sync operation logs |
| `project_metadata` | Flexible project identification |
| `schema_version` | Database version for migrations |

### Indexes

- `idx_pr_repo_number` - Fast PR lookup by repo+number
- `idx_branch_repo` - Fast branch lookup by repo
- `idx_pr_context_repo_pr` - Fast context lookup

---

## CLI Quick Reference

```bash
# Initialize and sync (using Python directly)
python -c "
import asyncio
from github_sync import SyncStore, SyncEngine

async def main():
    store = SyncStore('prs.db')
    await store.initialize()
    engine = SyncEngine(store)
    result = await engine.sync_repository('.')
    print(f'Synced {result.prs_synced} PRs')

asyncio.run(main())
"

# Export to portable format
python -c "
import asyncio
from github_sync import SyncStore, export_database, ArtifactFormat

async def main():
    store = SyncStore('prs.db')
    await store.initialize()
    await export_database(store, 'export.json.gz', format=ArtifactFormat.JSON_GZ)

asyncio.run(main())
"
```

---

## Tips for Fast PR Triage

1. **Sync once at the start of your session** - Database queries are instant after sync
2. **Use labels** - Filter PRs by `for-review` or `for-landing` labels
3. **Check CI status first** - Skip PRs with failing CI until fixed
4. **Review comments indicate work needed** - PRs with `review_comments` likely need changes
5. **Export/import for teams** - Share cached state between team members

---

## Error Handling

```python
from github_sync import DatabaseError, MigrationError

try:
    await store.initialize()
except MigrationError as e:
    print(f"Database needs upgrade: {e}")
except DatabaseError as e:
    print(f"Database error: {e}")
```

---

## Requirements

- Python 3.10+
- `aiosqlite` - Async SQLite
- `httpx` - Async HTTP client
- `GITHUB_TOKEN` environment variable (or `gh auth` configured)
- `filelock` (optional) - For multi-process safety

---

## Integrated Workspace Workflow

This is the full workflow for picking up a workspace and quickly working on PRs.

### Initialize a Workspace

```python
import asyncio
from pathlib import Path
from github_sync import SyncStore, SyncEngine, ProjectManager

async def init_workspace(workspace_dir: str, repo_url: str, repo_name: str):
    """Initialize a workspace with bare clone and PR cache."""
    workspace = Path(workspace_dir)
    workspace.mkdir(parents=True, exist_ok=True)

    # Initialize database
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    # Initialize project manager (manages bare clone + worktrees)
    async with ProjectManager(workspace, store=store) as pm:
        # Create/fetch bare clone
        project = await pm.ensure_project(repo_name, repo_url)
        print(f"Project ready: {project.bare_path}")

    return store

# Example:
# asyncio.run(init_workspace("./my-workspace", "git@github.com:org/repo.git", "repo"))
```

### Sync PRs and Find Work

```python
async def sync_and_find_work(workspace_dir: str, repo_name: str):
    """Sync latest PR state and find PRs needing attention."""
    workspace = Path(workspace_dir)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    async with ProjectManager(workspace, store=store) as pm:
        project = await pm.get_project(repo_name)
        if not project:
            raise ValueError(f"Project {repo_name} not found")

        # Sync PRs from GitHub
        engine = SyncEngine(store)
        result = await engine.sync_repository(
            project.bare_path,
            include_context=True,
            fetch_first=True
        )
        print(f"Synced {result.prs_synced} PRs")

        # Find PRs needing work
        return await find_prs_needing_attention(store, repo_name)

async def find_prs_needing_attention(store: SyncStore, repo_name: str) -> dict:
    """Categorize PRs by what needs attention."""
    prs = await store.get_active_prs(repo_name)
    contexts = {ctx.pr_number: ctx for ctx in await store.get_all_pr_contexts(repo_name)}

    needs_attention = {
        "ci_failing": [],
        "has_review_comments": [],
        "has_new_comments": [],
        "ready_to_land": [],
    }

    for pr in prs:
        pr_num = pr["pr_number"]
        ctx = contexts.get(pr_num)
        labels = {l.lower() for l in pr.get("labels", [])}

        # CI failing
        if pr.get("ci_status") == "failure":
            needs_attention["ci_failing"].append({
                "number": pr_num,
                "title": pr["title"],
                "branch": pr["head_branch"],
                "reason": "CI failing"
            })

        # Has review comments (inline code feedback)
        elif ctx and ctx.review_comments:
            needs_attention["has_review_comments"].append({
                "number": pr_num,
                "title": pr["title"],
                "branch": pr["head_branch"],
                "comment_count": len(ctx.review_comments),
                "latest": ctx.review_comments[-1].get("body", "")[:100]
            })

        # Has discussion comments
        elif ctx and ctx.comments:
            needs_attention["has_new_comments"].append({
                "number": pr_num,
                "title": pr["title"],
                "branch": pr["head_branch"],
                "comment_count": len(ctx.comments)
            })

        # Ready to land (CI passing, labeled for-landing)
        elif pr.get("ci_status") == "success" and "for-landing" in labels:
            needs_attention["ready_to_land"].append({
                "number": pr_num,
                "title": pr["title"],
                "branch": pr["head_branch"],
            })

    return needs_attention
```

### Jump to a PR Branch and Work

```python
async def work_on_pr(
    workspace_dir: str,
    repo_name: str,
    pr_number: int,
    worker_id: str = "default"
) -> Path:
    """
    Get a worktree for a PR's branch, ready to work.

    Returns the path to the worktree where you can make changes.
    """
    workspace = Path(workspace_dir)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    # Get PR info to find the branch
    pr = await store.get_latest_pr_snapshot(repo_name, pr_number)
    if not pr:
        raise ValueError(f"PR #{pr_number} not found in cache")

    branch = pr["head_branch"]

    async with ProjectManager(workspace, store=store) as pm:
        # Fetch latest
        project = await pm.get_project(repo_name)
        await pm._fetch_project(project)

        # Acquire worktree for this branch
        lease = await pm.acquire_worktree(
            project_name=repo_name,
            branch=branch,
            worker_id=worker_id,
            metadata={"pr_number": pr_number}
        )

        print(f"Worktree ready at: {lease.path}")
        print(f"Branch: {branch}")
        print(f"PR: #{pr_number} - {pr['title']}")

        # Get context for reference
        ctx = await store.get_latest_pr_context(repo_name, pr_number)
        if ctx and ctx.review_comments:
            print(f"\nReview comments to address ({len(ctx.review_comments)}):")
            for rc in ctx.review_comments[:5]:
                print(f"  - {rc.get('path', '?')}:{rc.get('line', '?')}: {rc.get('body', '')[:80]}")

        return lease.path
```

### Complete Triage Session Example

```python
async def triage_session(workspace_dir: str, repo_name: str):
    """
    Full triage workflow:
    1. Sync latest state
    2. Show what needs attention
    3. Provide paths to work on each
    """
    workspace = Path(workspace_dir)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    async with ProjectManager(workspace, store=store) as pm:
        # Ensure project exists and fetch
        project = await pm.get_project(repo_name)
        if project:
            await pm._fetch_project(project)

        # Sync from GitHub
        engine = SyncEngine(store)
        result = await engine.sync_repository(
            project.bare_path if project else ".",
            include_context=True
        )

        print(f"=== Sync Complete ===")
        print(f"PRs: {result.prs_synced}, Contexts: {result.contexts_synced}")
        print()

        # Find work
        attention = await find_prs_needing_attention(store, repo_name)

        print("=== PRs Needing Attention ===\n")

        if attention["ci_failing"]:
            print("🔴 CI FAILING:")
            for pr in attention["ci_failing"]:
                print(f"   PR #{pr['number']}: {pr['title']}")
                print(f"      Branch: {pr['branch']}")
            print()

        if attention["has_review_comments"]:
            print("💬 HAS REVIEW COMMENTS:")
            for pr in attention["has_review_comments"]:
                print(f"   PR #{pr['number']}: {pr['title']} ({pr['comment_count']} comments)")
                print(f"      Branch: {pr['branch']}")
                print(f"      Latest: {pr['latest']}...")
            print()

        if attention["ready_to_land"]:
            print("✅ READY TO LAND:")
            for pr in attention["ready_to_land"]:
                print(f"   PR #{pr['number']}: {pr['title']}")
            print()

        # Show existing worktrees
        leases = await pm.list_leases(project_name=repo_name)
        if leases:
            print("=== Active Worktrees ===")
            for lease in leases:
                status = await pm.get_worktree_status(lease)
                print(f"   {lease.branch}: {lease.path}")
                print(f"      Changes: {'Yes' if status.get('has_changes') else 'No'}")
                print(f"      Expires in: {lease.remaining_seconds:.0f}s")
            print()

# Run it:
# asyncio.run(triage_session("./my-workspace", "my-repo"))
```

### Quick Commands Reference

```python
# Initialize workspace
store = SyncStore("workspace/sync.db")
await store.initialize()
pm = ProjectManager("workspace", store=store)
await pm.initialize()

# Ensure project (creates bare clone if needed)
project = await pm.ensure_project("repo", "git@github.com:org/repo.git")

# Sync PRs
engine = SyncEngine(store)
await engine.sync_repository(project.bare_path)

# Find PRs with issues
failing = [pr for pr in await store.get_active_prs("repo") if pr["ci_status"] == "failure"]

# Get worktree for a branch
lease = await pm.acquire_worktree("repo", "feature-branch", "worker-1")
print(f"Work here: {lease.path}")

# Get review comments for a PR
ctx = await store.get_latest_pr_context("repo", 123)
for rc in ctx.review_comments:
    print(f"{rc['path']}:{rc['line']}: {rc['body']}")

# Release worktree when done
await pm.release_worktree(lease)

# Or use context manager
async with await pm.acquire_worktree("repo", "branch", "worker") as lease:
    # work in lease.path
    pass  # auto-released
```

### CLI One-Liner for Triage

```bash
python -c "
import asyncio
from pathlib import Path
from github_sync import SyncStore, ProjectManager

async def main():
    store = SyncStore('sync.db')
    await store.initialize()

    # Show PRs needing attention
    for pr in await store.get_active_prs('my-repo'):
        ctx = await store.get_latest_pr_context('my-repo', pr['pr_number'])
        issues = []
        if pr.get('ci_status') == 'failure':
            issues.append('CI-FAIL')
        if ctx and ctx.review_comments:
            issues.append(f'{len(ctx.review_comments)}-reviews')
        if issues:
            print(f\"PR #{pr['pr_number']} [{', '.join(issues)}]: {pr['title']}\")
            print(f\"   Branch: {pr['head_branch']}\")

asyncio.run(main())
"
```

---

## What's Tracked for Review Feedback

The `PRContext` captures everything needed to process feedback:

| Field | Content | Use Case |
|-------|---------|----------|
| `review_comments` | Inline code review comments | Address specific code feedback |
| `comments` | Issue-level discussion | General PR discussion |
| `diff` | Full PR diff | Understand changes |
| `files` | Changed files with patches | See what's modified |
| `ci_checks` | CI status per check | Debug failures |
| `commits` | Commit list | Review history |

### Review Comment Structure

```python
{
    "id": 12345,
    "author": "reviewer",
    "body": "This should use a constant instead of magic number",
    "path": "src/utils.py",      # File path
    "line": 42,                   # Line number in diff
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
}
```

### Review State Tracking

The sync now captures **review approval state** from GitHub:

```python
# Review state is stored in ctx.ci_checks["review_state"]
review_state = ctx.ci_checks.get("review_state", {})

# Available fields:
review_state["approved_by"]           # List of users who approved
review_state["changes_requested_by"]  # List of users requesting changes
review_state["review_decision"]       # "APPROVED", "CHANGES_REQUESTED", or None
```

Example usage:

```python
ctx = await store.get_latest_pr_context(repo_name, pr_number)
review_state = ctx.ci_checks.get("review_state", {})

if review_state.get("changes_requested_by"):
    print(f"Changes requested by: {review_state['changes_requested_by']}")
elif review_state.get("approved_by"):
    print(f"Approved by: {review_state['approved_by']}")
```

### Detecting "Work to Do"

```python
def pr_needs_work(pr: dict, ctx: PRContext | None) -> list[str]:
    """Return list of reasons this PR needs attention."""
    reasons = []

    # CI failure
    if pr.get("ci_status") == "failure":
        reasons.append("CI failing")

    # Changes requested (from review state)
    if ctx:
        review_state = ctx.ci_checks.get("review_state", {})
        if review_state.get("changes_requested_by"):
            reasons.append(f"Changes requested by {review_state['changes_requested_by']}")

    # Unaddressed review comments
    if ctx and ctx.review_comments:
        reasons.append(f"{len(ctx.review_comments)} review comments")

    # Discussion activity
    if ctx and ctx.comments:
        reasons.append(f"{len(ctx.comments)} discussion comments")

    # Draft status
    if pr.get("draft"):
        reasons.append("Still in draft")

    return reasons
```

---

## Limitations

### Not Tracked (GitHub API Limitations)

| Feature | Status | Notes |
|---------|--------|-------|
| Resolved conversations | Not available | GitHub API doesn't expose "resolved" state for review threads |
| Review thread grouping | Partial | Comments are flat; threading by `in_reply_to_id` not captured |
| Suggested changes | Not parsed | Suggestions are in comment body as markdown |
| Required reviewers | Not tracked | Would need GraphQL API |

### Workarounds

**For resolved conversations:**

- GitHub doesn't provide this via REST API
- Workaround: Track which comments you've addressed manually
- Or: Use PR labels like "addressed-feedback" to signal

**For review thread grouping:**

```python
# Review comments have path + line, so you can group:
comments_by_location = {}
for rc in ctx.review_comments:
    key = f"{rc['path']}:{rc['line']}"
    comments_by_location.setdefault(key, []).append(rc)
```

**Checking if feedback is addressed:**

```python
def estimate_addressed(ctx: PRContext) -> bool:
    """
    Heuristic: If the latest commit is after all review comments,
    feedback may have been addressed.
    """
    if not ctx.review_comments or not ctx.commits:
        return True

    latest_commit_date = max(c.get("date", "") for c in ctx.commits)
    latest_comment_date = max(rc.get("created_at", "") for rc in ctx.review_comments)

    return latest_commit_date > latest_comment_date
```

---

## Bot Command Automation

The `DependabotHelper` provides a simple API for executing bot commands with pre-condition checks.

The bot mention is configurable - defaults to `@agfcmd` but can be set to `@dependabot` for standard Dependabot integration.

### Supported Commands

| Command | Constant | Pre-conditions |
|---------|----------|----------------|
| `@agfcmd rebase` | `REBASE` | PR open, rebaseable |
| `@agfcmd recreate` | `RECREATE` | PR open |
| `@agfcmd merge` | `MERGE` | PR open, CI passing, mergeable |
| `@agfcmd squash and merge` | `SQUASH_AND_MERGE` | PR open, CI passing, mergeable |
| `@agfcmd cancel merge` | `CANCEL_MERGE` | PR open |
| `@agfcmd reopen` | `REOPEN` | PR closed (not merged) |
| `@agfcmd close` | `CLOSE` | PR open |
| `@agfcmd ignore this major version` | `IGNORE_MAJOR` | PR open |
| `@agfcmd ignore this minor version` | `IGNORE_MINOR` | PR open |
| `@agfcmd ignore this dependency` | `IGNORE_DEPENDENCY` | PR open |

### Quick Start

```python
from github_sync import GitHubClient, DependabotHelper, DependabotCommand

async def main():
    client = GitHubClient(repo_owner="org", repo_name="repo")

    # Default: uses @agfcmd
    helper = DependabotHelper(client)

    # Or use @dependabot for standard Dependabot integration
    # helper = DependabotHelper(client, bot_mention="@dependabot")

    async with client:
        # Check if we can merge PR #42
        result = await helper.check_preconditions(42, DependabotCommand.MERGE)

        if result.can_execute:
            cmd_result = await helper.execute(42, DependabotCommand.MERGE)
            print(f"Merge requested: {cmd_result.success}")
            # Posts comment: "@agfcmd merge"
        else:
            print(f"Cannot merge: {result.blockers}")
            print(f"Warnings: {result.warnings}")
```

### Configuring the Bot Mention

```python
# Default: @agfcmd
helper = DependabotHelper(client)
# Commands: "@agfcmd merge", "@agfcmd rebase", etc.

# For standard Dependabot
helper = DependabotHelper(client, bot_mention="@dependabot")
# Commands: "@dependabot merge", "@dependabot rebase", etc.

# Custom bot
helper = DependabotHelper(client, bot_mention="@mybot")
# Commands: "@mybot merge", "@mybot rebase", etc.
```

### Pre-condition Checking

The `check_preconditions()` method returns detailed state:

```python
result = await helper.check_preconditions(pr_number, DependabotCommand.MERGE)

print(result.can_execute)      # True/False
print(result.blockers)         # List of blocking issues
print(result.warnings)         # List of warnings (non-blocking)
print(result.pr_state)         # Full PR state dict

# PR state includes:
# - is_open, is_closed, is_merged
# - is_dependabot (True if PR author is dependabot)
# - ci_status, ci_passing, ci_failing, ci_pending
# - mergeable, mergeable_state, rebaseable
# - review_decision, approved_by, changes_requested_by
# - dependency_info (parsed from title)
```

### Dependency Info Parsing

For Dependabot PRs, dependency information is extracted from the title:

```python
info = helper.parse_dependency_info(pr)
# Returns:
# {
#     "dependency": "lodash",
#     "from_version": "4.17.20",
#     "to_version": "4.17.21",
#     "is_major": False,
#     "is_minor": False,
# }
```

### Batch Operations

```python
# Find all open Dependabot PRs with passing CI
ready_prs = await helper.find_dependabot_prs(state="open", ci_status="success")

# Auto-merge all ready PRs (squash merge)
results = await helper.auto_merge_ready_prs(squash=True)

# Or do a dry run first
dry_results = await helper.auto_merge_ready_prs(squash=True, dry_run=True)
for r in dry_results:
    print(f"PR #{r.pr_number}: {r.message}")

# Execute command on multiple PRs
results = await helper.batch_execute(
    pr_numbers=[1, 2, 3],
    command=DependabotCommand.REBASE,
    stop_on_failure=False
)
```

### Agent Integration Example

For an agent that processes Dependabot PRs:

```python
from github_sync import (
    GitHubClient, SyncStore, SyncEngine,
    DependabotHelper, DependabotCommand
)

async def process_dependabot_prs(workspace_path: str, repo_name: str):
    """Agent workflow for processing Dependabot PRs."""
    store = SyncStore(f"{workspace_path}/sync.db")
    await store.initialize()

    client = await GitHubClient.from_repo_path(workspace_path)
    helper = DependabotHelper(client, store)

    async with client:
        # Step 1: Find all Dependabot PRs
        prs = await helper.find_dependabot_prs(state="open")

        for pr_state in prs:
            pr_num = pr_state["pr_number"]
            dep_info = pr_state.get("dependency_info", {})

            print(f"PR #{pr_num}: {dep_info.get('dependency', 'unknown')}")
            print(f"  Version: {dep_info.get('from_version')} -> {dep_info.get('to_version')}")
            print(f"  CI: {pr_state['ci_status']}")
            print(f"  Mergeable: {pr_state['mergeable_state']}")

            # Step 2: Decide action based on state
            if pr_state["ci_failing"]:
                # Maybe rebase to trigger fresh CI
                pre = await helper.check_preconditions(pr_num, DependabotCommand.REBASE)
                if pre.can_execute:
                    print(f"  -> Rebasing to retry CI")
                    await helper.execute(pr_num, DependabotCommand.REBASE)

            elif pr_state["ci_passing"] and pr_state["mergeable"]:
                # Merge if CI passes
                pre = await helper.check_preconditions(pr_num, DependabotCommand.SQUASH_AND_MERGE)
                if pre.can_execute:
                    print(f"  -> Requesting merge")
                    await helper.execute(pr_num, DependabotCommand.SQUASH_AND_MERGE)
                else:
                    print(f"  -> Cannot merge: {pre.blockers}")

            elif pr_state["ci_pending"]:
                print(f"  -> Waiting for CI")
```

### Direct Merge (Without Dependabot)

For non-Dependabot PRs or when you want to merge directly:

```python
# Direct merge via GitHub API (immediate, doesn't wait for CI)
result = await client.merge_pr(pr_number, merge_method="squash")

# Or use helper which prefers Dependabot for Dependabot PRs
result = await helper.merge_when_ready(pr_number, squash=True, use_dependabot=True)
```

### Write Operations Available

The `GitHubClient` now supports these write operations:

```python
# Post a comment
await client.post_comment(pr_number, "Hello from automation!")

# Close/reopen PR
await client.close_pr(pr_number)
await client.reopen_pr(pr_number)

# Merge PR directly
result = await client.merge_pr(pr_number, merge_method="squash")

# Get detailed mergeable state
state = await client.get_pr_mergeable_state(pr_number)
# Returns: mergeable, mergeable_state, rebaseable

# Manage labels
await client.add_labels(pr_number, ["automerge", "approved"])
await client.remove_label(pr_number, "needs-review")
```

---

## Command Queue

The command queue extracts bot commands from PR comments during sync and queues them for execution.

All command executions are automatically tracked with:

- **Timing**: `started_at`, `completed_at`, `duration_ms`
- **Status**: `pending`, `executing`, `completed`, `failed`, `skipped`
- **Error info**: `error_type`, `error_message`
- **Audit**: `retry_count`, `result_message`

### Command Queue Schema

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `pending`, `executing`, `completed`, `failed`, `skipped` |
| `started_at` | timestamp | When execution started |
| `completed_at` | timestamp | When execution finished |
| `duration_ms` | integer | Execution duration in milliseconds |
| `success` | boolean | Whether command succeeded |
| `error_type` | string | Error class name (e.g., `PreconditionError`, `APIError`) |
| `error_message` | string | Detailed error message |
| `retry_count` | integer | Number of retry attempts |

### Extracting Commands from Comments

```python
from github_sync import CommandParser, DependabotCommand

# Create parser (default: @agfcmd)
parser = CommandParser(bot_mention="@agfcmd")

# Extract from a single comment
commands = parser.extract_from_text("@agfcmd merge")
# Returns: [(DependabotCommand.MERGE, None)]

# Extract with dependency for show ignore conditions
commands = parser.extract_from_text("@agfcmd show lodash ignore conditions")
# Returns: [(DependabotCommand.SHOW_IGNORE_CONDITIONS, "lodash")]

# Extract from a list of PR comments
comments = [
    {"id": 1, "author": "user1", "body": "@agfcmd merge", "created_at": "2024-01-15T10:00:00Z"},
    {"id": 2, "author": "user2", "body": "LGTM!", "created_at": "2024-01-15T11:00:00Z"},
]
queued = parser.extract_from_comments(comments, repo_name="myrepo", pr_number=42)
# Returns list of QueuedCommand objects
```

### Queueing Commands in Database

```python
from datetime import UTC, datetime

# Queue a command
cmd_id = await store.queue_command(
    repo_name="myrepo",
    pr_number=42,
    command="merge",
    comment_id=123,
    comment_author="user1",
    comment_body="@agfcmd merge",
    extracted_at=datetime.now(UTC),
)

# Get pending commands
pending = await store.get_pending_commands()
pending = await store.get_pending_commands(repo_name="myrepo")
pending = await store.get_pending_commands(repo_name="myrepo", pr_number=42)

# Update command status after execution
await store.update_command_status(cmd_id, "completed", "Merged successfully")
await store.update_command_status(cmd_id, "failed", "CI not passing")

# Get command history
history = await store.get_command_history("myrepo")
history = await store.get_command_history("myrepo", pr_number=42)
```

### Processing Queued Commands (with Automatic Audit Trail)

Commands are automatically tracked with timing, success/failure, and error details:

```python
from github_sync import BotHelper, BotCommand, SyncStore, GitHubClient

# Initialize with store for automatic audit trail
store = SyncStore("sync.db")
await store.initialize()

client = GitHubClient(repo_owner="org", repo_name="repo")
helper = BotHelper(client, store=store)  # Store enables audit trail

# Process all pending commands with automatic tracking
# Each command is automatically:
# - Marked as executing with start time
# - Timed (duration in milliseconds)
# - Recorded with success/failure status
# - Logged with error type and message on failure
results = await helper.process_pending_commands(repo_name="myrepo")

for result in results:
    print(f"PR #{result.pr_number}: {result.command.value}")
    print(f"  Success: {result.success}")
    print(f"  Duration: {result.duration_ms}ms")
    if not result.success:
        print(f"  Error: {result.error_type}: {result.error_message}")
```

### Command Execution Results

Every command execution returns a `CommandResult` with timing:

```python
result = await helper.execute(42, BotCommand.MERGE)

# Result includes timing automatically
print(f"Started: {result.started_at}")
print(f"Completed: {result.completed_at}")
print(f"Duration: {result.duration_ms}ms")
print(f"Success: {result.success}")

# Error details on failure
if not result.success:
    print(f"Error type: {result.error_type}")
    print(f"Error message: {result.error_message}")
```

### Execution Statistics

Get aggregated statistics on command execution:

```python
# Get overall stats
stats = await store.get_command_execution_stats("myrepo")
print(f"Total commands: {stats['total_count']}")
print(f"Success rate: {stats['success_rate']}%")
print(f"Avg duration: {stats['avg_duration_ms']}ms")

# Filter by command type
merge_stats = await store.get_command_execution_stats("myrepo", command="merge")
print(f"Merge success rate: {merge_stats['success_rate']}%")

# Get failed commands for debugging
failed = await store.get_failed_commands("myrepo")
for cmd in failed:
    print(f"PR #{cmd['pr_number']}: {cmd['error_type']} - {cmd['error_message']}")
```

### Retry Failed Commands

```python
# Increment retry count and re-execute
result = await helper.retry_failed_command(command_id=123)

# Or manually increment and check limit
new_count = await store.increment_retry_count(command_id)
if new_count < 3:
    # Re-queue for processing
    pass
```

---

## PR Memos (Shadow Memory)

PR memos provide persistent storage for bot notes, todos, and plans per PR.

### Basic Usage

```python
# Set a memo
await store.set_memo("myrepo", 42, "todo", "- [ ] Fix tests\n- [ ] Update docs")
await store.set_memo("myrepo", 42, "plan", "1. Run tests\n2. Fix failures\n3. Merge")

# Get a memo
content = await store.get_memo("myrepo", 42, "todo")

# Get all memos for a PR
memos = await store.get_all_memos("myrepo", 42)
# Returns: {"todo": "...", "plan": "..."}

# Delete a memo
await store.delete_memo("myrepo", 42, "todo")

# Delete all memos for a PR
count = await store.delete_all_memos("myrepo", 42)
```

### Common Memo Types

| Type | Purpose |
|------|---------|
| `todo` | Bot's todo list for this PR |
| `plan` | Execution plan |
| `notes` | General notes/observations |
| `context` | Cached summary/context |
| `history` | Execution history |

### Storing JSON in Memos

```python
import json

# Store structured data
todo_list = {
    "items": [
        {"task": "Fix tests", "done": False},
        {"task": "Update docs", "done": True},
    ],
    "priority": "high",
}
await store.set_memo("myrepo", 42, "todo", json.dumps(todo_list))

# Retrieve and parse
content = await store.get_memo("myrepo", 42, "todo")
if content:
    todo_list = json.loads(content)
```

### Agent Integration Example

```python
async def agent_process_pr(store: SyncStore, repo: str, pr_number: int):
    """Example agent workflow using memos."""

    # Load existing plan or create new one
    plan = await store.get_memo(repo, pr_number, "plan")
    if not plan:
        # Analyze PR and create plan
        ctx = await store.get_latest_pr_context(repo, pr_number)
        plan = f"""
## PR #{pr_number} Plan

### Review Comments to Address
{len(ctx.review_comments) if ctx else 0} comments

### Steps
1. Review feedback
2. Make changes
3. Push update
4. Request re-review
"""
        await store.set_memo(repo, pr_number, "plan", plan)

    # Track progress in todo
    todo = await store.get_memo(repo, pr_number, "todo") or "[]"
    todos = json.loads(todo)

    # ... do work ...

    # Update todo
    todos.append({"task": "Addressed feedback", "done": True, "at": datetime.now(UTC).isoformat()})
    await store.set_memo(repo, pr_number, "todo", json.dumps(todos))
```

---

## Global Memory

Bot-wide persistent memory that persists across all repos and PRs.

```python
# Set global memory
await store.set_global("last_sync_time", datetime.now(UTC).isoformat())
await store.set_global("config", json.dumps({"auto_merge": True}))

# Get global memory
value = await store.get_global("last_sync_time")

# Get all global memory
all_globals = await store.get_all_global()
# Returns: {"last_sync_time": "...", "config": "..."}

# Delete global memory
await store.delete_global("last_sync_time")
```

---

## Branch Memory

Per-branch persistent memory for tracking state and progress.

```python
# Set branch memory
await store.set_branch_memory("repo", "feature-branch", "status", "in_progress")
await store.set_branch_memory("repo", "feature-branch", "last_commit", "abc123")
await store.set_branch_memory("repo", "feature-branch", "todo", json.dumps(["fix tests", "update docs"]))

# Get branch memory
status = await store.get_branch_memory("repo", "feature-branch", "status")

# Get all memory for a branch
branch_data = await store.get_all_branch_memory("repo", "feature-branch")
# Returns: {"status": "in_progress", "last_commit": "abc123", "todo": "[...]"}

# Delete branch memory
await store.delete_branch_memory("repo", "feature-branch", "status")
await store.delete_all_branch_memory("repo", "feature-branch")
```

---

## Branch Timing

Track timing for branch operations to measure performance.

```python
from datetime import UTC, datetime

# Record a timing (immediate completion)
started = datetime.now(UTC)
# ... do operation ...
completed = datetime.now(UTC)

await store.record_branch_timing(
    repo_name="repo",
    branch_name="feature-branch",
    operation="build",
    started_at=started,
    completed_at=completed,
    success=True,
    metadata=json.dumps({"exit_code": 0})
)

# Record a timing (deferred completion)
timing_id = await store.record_branch_timing(
    repo_name="repo",
    branch_name="feature-branch",
    operation="deploy",
    started_at=datetime.now(UTC),
)
# ... later, when done ...
await store.complete_branch_timing(timing_id, success=True)

# Get timing history for a branch
timings = await store.get_branch_timing("repo", "feature-branch")
timings = await store.get_branch_timing("repo", "feature-branch", operation="build")

# Get average timing statistics
stats = await store.get_average_timing("repo", "feature-branch", operation="build")
# Returns: {
#     "avg_duration_ms": 1500.0,
#     "min_duration_ms": 1000,
#     "max_duration_ms": 2000,
#     "count": 10,
#     "success_rate": 90.0
# }
```

### Common Operation Types

| Operation | Description |
|-----------|-------------|
| `checkout` | Switching to a branch |
| `build` | Building the project |
| `test` | Running tests |
| `push` | Pushing changes |
| `rebase` | Rebasing onto another branch |
| `merge` | Merging branches |
| `deploy` | Deployment operations |
| `ci` | CI pipeline execution |

---

## Multi-Step Workflows (LLM Operations)

The workflow system tracks complex, multi-step operations where an LLM performs multiple tool calls to complete a task.

### Common Workflow Types

| Type | Description | Typical Steps |
|------|-------------|---------------|
| `merge` | Merge operation | fetch → merge → resolve conflicts → push |
| `rebase` | Rebase operation | fetch → rebase → resolve conflicts → push |
| `pr_review` | Address PR feedback | fetch context → analyze → make changes → push |
| `ci_fix` | Fix CI failures | analyze failure → fix issue → run tests → push |

### Basic Usage with Context Managers

```python
from github_sync import SyncStore, WorkflowManager

store = SyncStore("sync.db")
await store.initialize()

wm = WorkflowManager(store)

# Start a merge workflow
async with wm.merge_workflow("repo", "feature-branch") as workflow:
    # Step 1: Fetch
    async with workflow.step("fetch") as step:
        await step.record_tool_call()
        # ... do fetch ...

    # Step 2: Merge
    async with workflow.step("merge") as step:
        result = ...  # git merge
        if has_conflicts:
            # Multiple rounds of conflict resolution
            while has_conflicts:
                await step.record_tool_call()
                # ... resolve conflict ...
            step.set_output({"conflicts_resolved": 5})

    # Step 3: Push
    async with workflow.step("push") as step:
        await step.record_tool_call()
        # ... git push ...

print(f"Workflow completed in {workflow.duration_ms}ms")
```

### Convenience Methods

```python
# Merge workflow (sets target_branch in context)
async with wm.merge_workflow("repo", "feature", target_branch="develop") as wf:
    ...

# Rebase workflow (sets onto_branch in context)
async with wm.rebase_workflow("repo", "feature", onto_branch="main") as wf:
    ...

# PR review workflow (sets pr_number)
async with wm.pr_review_workflow("repo", pr_number=42) as wf:
    ...

# CI fix workflow (sets ci_check in context)
async with wm.ci_fix_workflow("repo", "branch", ci_check="lint") as wf:
    ...
```

### Workflow Steps

Each step within a workflow can:

- Track tool calls (for LLM monitoring)
- Store input/output data
- Record success/failure with error info

```python
async with workflow.step("resolve_conflicts", input_data={"files": ["a.py", "b.py"]}) as step:
    # Record each tool call the LLM makes
    await step.record_tool_call()  # Returns 1
    await step.record_tool_call()  # Returns 2
    await step.record_tool_call()  # Returns 3

    # Set output data
    step.set_output({"resolved": 3, "remaining": 0})

    # Or mark as failed
    # step.fail("MergeConflict", "Could not resolve conflict in utils.py")
```

### Workflow Context

Store and update context throughout the workflow:

```python
async with wm.workflow("custom", "repo", "branch", context={"key1": "value1"}) as wf:
    # Update context during execution
    wf.update_context({"step_results": [], "attempts": 0})

    # Set final result message
    wf.set_result("Successfully merged with 3 conflict resolutions")
```

### Querying Workflows

```python
# Get active workflows (running or paused)
active = await wm.get_active_workflows()
active = await wm.get_active_workflows(repo_name="repo")
active = await wm.get_active_workflows(workflow_type="merge")

# Get a specific workflow with its steps
workflow = await wm.get_workflow(workflow_id)
print(f"Status: {workflow['status']}")
print(f"Steps: {len(workflow['steps'])}")

# Get workflow statistics
stats = await wm.get_stats("repo", "merge")
print(f"Total: {stats['total_count']}")
print(f"Success rate: {stats['success_rate']}%")
print(f"Avg duration: {stats['avg_duration_ms']}ms")
```

### Pause and Resume Workflows

For workflows that need user input or external events:

```python
# Pause a workflow
await wm.pause_current_workflow(workflow_id, "Waiting for user approval")

# Later, resume the workflow
workflow = await wm.resume_workflow(workflow_id)

# Continue with more steps
async with workflow.step("final_push") as step:
    await step.record_tool_call()
    # ... push changes ...

# Complete the resumed workflow
await wm.complete_resumed_workflow(
    workflow,
    success=True,
    result="Merged successfully after approval"
)
```

### Error Handling

Exceptions in workflows and steps are automatically captured:

```python
try:
    async with wm.workflow("merge", "repo", "branch") as wf:
        async with wf.step("merge") as step:
            raise ValueError("Merge failed due to conflict")
except ValueError:
    pass  # Exception is re-raised after recording

# The workflow is now marked as failed
workflow = await wm.get_workflow(wf.workflow_id)
assert workflow["status"] == "failed"
assert workflow["error_type"] == "ValueError"
assert workflow["error_message"] == "Merge failed due to conflict"
```

### Workflow Schema

| Field | Type | Description |
|-------|------|-------------|
| `workflow_type` | string | Type of workflow (merge, rebase, etc.) |
| `repo_name` | string | Repository name |
| `branch_name` | string | Optional branch name |
| `pr_number` | integer | Optional PR number |
| `status` | string | `created`, `running`, `paused`, `completed`, `failed` |
| `current_step` | string | Name of current step |
| `context` | JSON | Workflow context data |
| `started_at` | timestamp | When workflow started |
| `completed_at` | timestamp | When workflow finished |
| `duration_ms` | integer | Total duration in milliseconds |
| `success` | boolean | Whether workflow succeeded |
| `error_type` | string | Error class name on failure |
| `error_message` | string | Error details on failure |
| `result` | string | Result message |

### Workflow Step Schema

| Field | Type | Description |
|-------|------|-------------|
| `workflow_id` | integer | Parent workflow ID |
| `step_name` | string | Name of the step |
| `step_order` | integer | Order in workflow (1, 2, 3...) |
| `status` | string | `pending`, `running`, `completed`, `failed` |
| `input_data` | JSON | Input data for the step |
| `output_data` | JSON | Output data from the step |
| `tool_calls` | integer | Number of LLM tool calls in this step |
| `started_at` | timestamp | When step started |
| `completed_at` | timestamp | When step finished |
| `duration_ms` | integer | Step duration in milliseconds |
| `success` | boolean | Whether step succeeded |
| `error_type` | string | Error class name on failure |
| `error_message` | string | Error details on failure |

### LLM Agent Integration Example

```python
async def llm_merge_workflow(
    store: SyncStore,
    repo_name: str,
    branch: str,
    target: str = "main"
):
    """Example LLM-driven merge workflow with tool call tracking."""
    wm = WorkflowManager(store)

    async with wm.merge_workflow(repo_name, branch, target_branch=target) as wf:
        # Step 1: Fetch and analyze
        async with wf.step("analyze") as step:
            await step.record_tool_call()  # LLM calls git fetch
            await step.record_tool_call()  # LLM reads merge status

            merge_status = await get_merge_status()
            step.set_output({"conflicts": merge_status.conflicts})

        # Step 2: Resolve conflicts (may take multiple rounds)
        if merge_status.has_conflicts:
            async with wf.step("resolve_conflicts") as step:
                for conflict in merge_status.conflicts:
                    # LLM analyzes conflict
                    await step.record_tool_call()
                    # LLM edits file
                    await step.record_tool_call()
                    # LLM marks resolved
                    await step.record_tool_call()

                step.set_output({
                    "resolved_count": len(merge_status.conflicts),
                    "tool_calls": step.tool_calls
                })

        # Step 3: Commit and push
        async with wf.step("finalize") as step:
            await step.record_tool_call()  # git add
            await step.record_tool_call()  # git commit
            await step.record_tool_call()  # git push

            step.set_output({"pushed": True})

        wf.set_result(f"Merged {branch} into {target}")

    return wf.workflow_id
```

### Monitoring Active Workflows

```python
# Find all active workflows for a repo
active = await wm.get_active_workflows(repo_name="my-repo")

for wf in active:
    print(f"Workflow {wf['id']}: {wf['workflow_type']}")
    print(f"  Status: {wf['status']}")
    print(f"  Current step: {wf['current_step']}")
    print(f"  Started: {wf['started_at']}")

    # Get step details
    full_wf = await wm.get_workflow(wf['id'])
    for step in full_wf['steps']:
        status_icon = "✓" if step['success'] else "✗" if step['success'] == 0 else "..."
        print(f"  {status_icon} {step['step_name']}: {step['tool_calls']} tool calls, {step['duration_ms']}ms")
```
