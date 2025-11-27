# github_sync

A fully async Python library for syncing GitHub repository data (branches, PRs, CI status) to SQLite for offline processing and analysis.

## Features

- **Async-first**: Built with `aiosqlite` and `httpx` for embedding in FastAPI background tasks
- **SQLite storage**: Persistent snapshots of PR and branch state with history tracking
- **GitHub API integration**: Fetch PRs, diffs, comments, CI checks, and more
- **Export/Import**: Portable artifact formats (JSON, JSONL, compressed)
- **Extensible actions**: Command pattern for customizable database operations
- **Schema migrations**: Built-in versioning and migration support
- **Project metadata**: Flexible JSON metadata storage for linking to external systems
- **Project manager**: Git worktree leases for parallel workers sharing the same bare clone

## Installation

```bash
pip install github_sync
# or with uv
uv add github_sync
```

## Quick Start

### Basic Sync Workflow

```python
import asyncio
from github_sync import SyncStore, SyncEngine

async def main():
    # Create a database
    store = SyncStore("my-sync.db")
    await store.initialize()

    # Sync a repository
    engine = SyncEngine(store)
    result = await engine.sync_repository("/path/to/local/repo")

    if result.success:
        print(f"Synced {result.prs_synced} PRs, {result.branches_synced} branches")
    else:
        print(f"Sync failed: {result.error_message}")

asyncio.run(main())
```

### Streaming Progress (for FastAPI)

```python
from github_sync import SyncStore, SyncEngine
from github_sync.sync_engine import SyncProgress, SyncResult

async def sync_with_progress(repo_path: str):
    store = SyncStore("sync.db")
    await store.initialize()
    engine = SyncEngine(store)

    async for update in engine.sync_repository_stream(repo_path):
        if isinstance(update, SyncProgress):
            yield f"Stage: {update.stage}, Progress: {update.percent:.0f}%"
        elif isinstance(update, SyncResult):
            yield f"Complete: {update.prs_synced} PRs synced"
```

### Export and Import

```python
from github_sync import SyncStore, export_database, import_database, ArtifactFormat

async def export_example():
    store = SyncStore("source.db")
    await store.initialize()

    # Export to compressed JSON
    result = await export_database(
        store,
        "backup.json.gz",
        format=ArtifactFormat.JSON_GZ,
        include_contexts=True,
    )
    print(f"Exported {result['repositories']} repos, {result['pull_requests']} PRs")

async def import_example():
    store = SyncStore("destination.db")
    await store.initialize()

    result = await import_database(store, "backup.json.gz")
    print(f"Imported {result['repositories_imported']} repos")
```

### Using Actions

```python
from github_sync import (
    SyncStore, ActionRegistry,
    SaveRepository, ListActivePRs, GetStatistics
)

async def action_example():
    store = SyncStore("sync.db")
    await store.initialize()
    registry = ActionRegistry(store)

    # Save a repository
    await registry.execute(SaveRepository(
        repo_name="my-repo",
        repo_path="/path/to/repo",
        default_branch="main",
    ))

    # Get active PRs
    result = await registry.execute(ListActivePRs(repo_name="my-repo"))
    for pr in result.data["result"]:
        print(f"PR #{pr['pr_number']}: {pr['title']}")

    # Get statistics
    stats = await registry.execute(GetStatistics())
    print(f"Total repos: {stats.data['result']['repositories']}")
```

### Project Metadata

Store flexible project identification and metadata alongside your sync data:

```python
from github_sync import SyncStore

async def metadata_example():
    store = SyncStore("sync.db")
    await store.initialize()

    # Set project identifier and metadata
    await store.set_project_metadata(
        project_id="my-project-123",
        metadata={
            "environment": "production",
            "team": "backend",
            "config": {"auto_merge": True, "required_approvals": 2},
        }
    )

    # Get project metadata
    meta = await store.get_project_metadata()
    print(f"Project: {meta['project_id']}")
    print(f"Team: {meta['metadata']['team']}")

    # Update a single key (merges with existing)
    await store.update_project_metadata("version", "2.0.0")

    # Delete a metadata key
    await store.delete_project_metadata_key("deprecated_field")

    # Replace all metadata (instead of merging)
    await store.set_project_metadata(
        metadata={"fresh": "start"},
        merge=False
    )
```

### Project Manager (Git Worktree Leases)

Manage multiple parallel workers against the same repository using git worktrees with a lease system:

```python
from github_sync import ProjectManager, SyncStore

async def parallel_workers_example():
    # Optional: use SyncStore for lease persistence
    store = SyncStore("sync.db")
    await store.initialize()

    async with ProjectManager("/var/projects", store=store) as pm:
        # Create/update a project from a git URL (creates a bare clone)
        project = await pm.ensure_project(
            "my-repo",
            "https://github.com/org/repo.git",
            metadata={"team": "backend"}
        )

        # Acquire a worktree lease for parallel work
        async with await pm.acquire_worktree(
            "my-repo",
            "feature-branch",
            worker_id="worker-1",
        ) as lease:
            # Work with the repository at lease.path
            print(f"Working in: {lease.path}")
            print(f"Branch: {lease.branch}")
            print(f"Expires in: {lease.remaining_seconds}s")

            # Run commands, tests, builds, etc.
            # subprocess.run(["make", "test"], cwd=lease.path)

        # Lease is automatically released when exiting the context

        # Multiple workers can work on different branches concurrently
        lease1 = await pm.acquire_worktree("my-repo", "main", worker_id="w1")
        lease2 = await pm.acquire_worktree("my-repo", "feature-x", worker_id="w2")

        # Cleanup expired leases
        cleaned = await pm.cleanup_expired_leases()
        print(f"Cleaned up {cleaned} expired leases")
```

---

## API Reference

### Core Classes

#### `SyncStore`

The main database interface for storing sync data.

```python
SyncStore(db_path: str | Path)
```

**Methods:**

| Method | Description |
|--------|-------------|
| `initialize()` | Create database schema or run migrations |
| `save_repository(name, path, default_branch)` | Save/update a repository |
| `get_repository(name) -> dict \| None` | Get repository by name |
| `get_all_repositories() -> list[dict]` | List all repositories |
| `get_project_metadata() -> dict` | Get project ID and metadata |
| `set_project_metadata(project_id, metadata, merge)` | Set project ID and/or metadata |
| `update_project_metadata(key, value)` | Update single metadata key |
| `delete_project_metadata_key(key) -> bool` | Delete a metadata key |
| `save_pr_snapshot(repo_name, pr_data)` | Save a PR state snapshot |
| `get_latest_pr_snapshot(repo_name, pr_number) -> dict \| None` | Get latest PR snapshot |
| `get_active_prs(repo_name) -> list[dict]` | Get open PRs for a repo |
| `get_all_prs(repo_name=None, limit=100) -> list[dict]` | Get all PRs |
| `save_pr_context(context: PRContext)` | Save full PR context |
| `get_latest_pr_context(repo_name, pr_number) -> PRContext \| None` | Get PR context |
| `get_all_pr_contexts(repo_name=None) -> list[PRContext]` | Get all contexts |
| `save_branch_state(repo_name, branch_name, ...)` | Save branch state |
| `record_sync_start(repo_name, sync_type) -> int` | Start sync recording |
| `record_sync_complete(record_id, success, ...)` | Complete sync recording |
| `cleanup_old_snapshots(days=30) -> int` | Delete old snapshots |
| `get_statistics() -> dict` | Get database statistics (includes project_id) |
| `get_schema_info() -> dict` | Get schema version info |

---

#### `SyncEngine`

Orchestrates repository synchronization.

```python
SyncEngine(db: SyncStore, progress_callback: Callable | None = None)
```

**Methods:**

| Method | Description |
|--------|-------------|
| `sync_repository(repo_path, include_context=True, fetch_first=True, labels=None) -> SyncResult` | Sync a repository |
| `sync_repository_stream(repo_path, ...) -> AsyncIterator[SyncProgress \| SyncResult]` | Stream sync with progress |
| `sync_single_pr(repo_path, pr_number) -> SyncResult` | Sync a single PR |
| `get_sync_status(repo_name=None) -> dict` | Get sync status |

**SyncResult fields:**

- `success: bool` - Whether sync succeeded
- `repo_name: str` - Repository name
- `prs_synced: int` - Number of PRs synced
- `branches_synced: int` - Number of branches synced
- `contexts_synced: int` - Number of contexts synced
- `duration_seconds: float` - Sync duration
- `error_message: str | None` - Error message if failed

---

#### `GitHubClient`

GitHub API client for fetching PR data.

```python
GitHubClient(
    repo_owner: str,
    repo_name: str,
    token: str | None = None,  # Falls back to GITHUB_TOKEN env var
)

# Or create from local repo
client = await GitHubClient.from_repo_path("/path/to/repo", token="...")
```

**Methods:**

| Method | Description |
|--------|-------------|
| `get_pull_requests(state="open") -> list[PullRequest]` | Get PRs |
| `get_pull_request(number) -> PullRequest \| None` | Get single PR |
| `get_prs_with_labels(labels) -> list[int]` | Get PR numbers by labels |
| `get_pr_diff(number) -> str` | Get PR diff |
| `get_pr_comments(number) -> list[dict]` | Get PR comments |
| `get_pr_review_comments(number) -> list[dict]` | Get review comments |
| `get_pr_commits(number) -> list[dict]` | Get PR commits |
| `get_pr_files(number) -> list[dict]` | Get changed files |

---

#### `GitClient`

Local git repository operations.

```python
GitClient(repo_path: str | Path)
```

**Methods:**

| Method | Description |
|--------|-------------|
| `validate_repo()` | Validate repo exists |
| `get_repository_info() -> dict` | Get repo metadata |
| `get_all_branches_with_status() -> tuple[list[Branch], list[Branch]]` | Get local and remote branches |
| `fetch(remote="origin")` | Fetch from remote |
| `get_current_branch() -> str` | Get current branch name |

---

#### `ProjectManager`

Manages git worktree leases for parallel workers.

```python
ProjectManager(
    base_dir: Path | str,
    store: SyncStore | None = None,  # For persistent lease tracking
    default_lease_duration: timedelta = timedelta(hours=1),
    max_worktrees_per_project: int = 10,
)
```

**Methods:**

| Method | Description |
|--------|-------------|
| `initialize()` | Create directories and load state |
| `ensure_project(name, git_url, fetch=True, metadata=None) -> Project` | Create/update project bare clone |
| `get_project(name) -> Project \| None` | Get project by name |
| `list_projects() -> list[Project]` | List all projects |
| `delete_project(name, force=False) -> bool` | Delete project and worktrees |
| `acquire_worktree(project, branch, worker_id, duration=None, ...) -> WorktreeLease` | Acquire a worktree lease |
| `release_worktree(lease)` | Release a worktree lease |
| `extend_lease(lease_id, duration=None) -> WorktreeLease \| None` | Extend lease expiration |
| `get_lease(lease_id) -> WorktreeLease \| None` | Get lease by ID |
| `list_leases(project=None, worker_id=None) -> list[WorktreeLease]` | List active leases |
| `cleanup_expired_leases() -> int` | Clean up expired leases |
| `get_worktree_status(lease) -> dict` | Get worktree git status |
| `worktree_context(project, branch, worker_id, ...)` | Context manager for worktree |

**Project fields:**

- `name: str` - Project name
- `git_url: str` - Source git URL
- `bare_path: Path` - Path to bare clone
- `default_branch: str` - Default branch name
- `metadata: dict` - Custom metadata

**WorktreeLease fields:**

- `id: str` - Unique lease ID
- `project_name: str` - Parent project name
- `branch: str` - Checked out branch
- `path: Path` - Worktree directory path
- `worker_id: str` - Worker identifier
- `expires_at: datetime` - Lease expiration time
- `is_expired: bool` - Whether lease is expired
- `remaining_seconds: float` - Seconds until expiration

---

### Data Models

#### `PullRequest`

Represents a GitHub pull request.

```python
@dataclass
class PullRequest:
    number: int
    title: str
    state: PRState  # OPEN, CLOSED, MERGED, DRAFT
    head_branch: str
    base_branch: str
    author: str
    url: str
    created_at: datetime
    updated_at: datetime
    body: str = ""
    draft: bool = False
    labels: list[str] = []
    ci_checks: list[CICheck] = []
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0
    commits: int = 0
    mergeable: bool | None = None
```

**Methods:**

- `get_ci_status() -> CIStatus` - Aggregate CI status
- `get_processing_mode() -> str | None` - Returns "for-landing" or "for-review" based on labels
- `to_dict() -> dict` - Serialize to dictionary
- `from_dict(data) -> PullRequest` - Deserialize

---

#### `PRContext`

Complete PR context for offline processing.

```python
@dataclass
class PRContext:
    repo_name: str
    pr_number: int
    pr_url: str
    diff: str
    body: str
    comments: list[dict] = []
    review_comments: list[dict] = []
    commits: list[dict] = []
    files: list[dict] = []
    conflicts: dict = {}
    ci_checks: dict = {}
    guidelines: str = ""
    commit_examples: str = ""
    captured_at: datetime | None = None
```

---

#### `Branch`

Represents a git branch.

```python
@dataclass
class Branch:
    name: str
    sha: str
    is_local: bool
    is_remote: bool
    upstream: str | None = None
    status: BranchStatus = BranchStatus.UNKNOWN
    ahead_by: int = 0
    behind_by: int = 0
    last_commit_date: datetime | None = None
    last_commit_author: str | None = None
    last_commit_message: str | None = None
```

---

#### `CICheck`

Represents a CI check result.

```python
@dataclass
class CICheck:
    name: str
    status: CIStatus  # SUCCESS, FAILURE, PENDING, NONE
    conclusion: str | None = None
    details_url: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
```

---

### Enums

```python
class PRState(Enum):
    OPEN = "open"
    CLOSED = "closed"
    MERGED = "merged"
    DRAFT = "draft"

class CIStatus(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    PENDING = "pending"
    NONE = "none"

class BranchStatus(Enum):
    UP_TO_DATE = "up_to_date"
    AHEAD = "ahead"
    BEHIND = "behind"
    DIVERGED = "diverged"
    LOCAL_ONLY = "local_only"
    REMOTE_ONLY = "remote_only"
    UNKNOWN = "unknown"

class ArtifactFormat(Enum):
    JSON = "json"
    JSON_GZ = "json.gz"
    JSONL = "jsonl"
    JSONL_GZ = "jsonl.gz"
```

---

### Actions

Actions provide a command pattern for database operations with validation, hooks, and consistent result handling.

#### Using the ActionRegistry

```python
from github_sync import ActionRegistry, SyncStore

store = SyncStore("sync.db")
await store.initialize()
registry = ActionRegistry(store)

# Execute an action
result = await registry.execute(SomeAction(...))

if result.success:
    data = result.data["result"]
else:
    print(f"Failed: {result.error}")
```

#### Available Actions

**Repository Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `SaveRepository` | `repo_name`, `repo_path`, `default_branch` | None |
| `GetRepository` | `repo_name` | `dict \| None` |
| `ListRepositories` | - | `list[dict]` |

**PR Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `SavePRSnapshot` | `repo_name`, `pr_number`, `title`, `head_branch`, `base_branch`, `state`, `author`, `draft`, `ci_status`, `labels` | None |
| `SavePRFromModel` | `repo_name`, `pr: PullRequest` | None |
| `GetPRSnapshot` | `repo_name`, `pr_number` | `dict \| None` |
| `ListActivePRs` | `repo_name` | `list[dict]` |
| `ListAllPRs` | `repo_name` (optional), `limit` | `list[dict]` |

**Context Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `SavePRContext` | `context: PRContext` | None |
| `GetPRContext` | `repo_name`, `pr_number` | `PRContext \| None` |
| `ListPRContexts` | `repo_name` (optional) | `list[PRContext]` |

**Branch Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `SaveBranchState` | `repo_name`, `branch_name`, `is_local`, `is_remote`, `ahead_by`, `behind_by`, `has_pr`, `pr_number`, `needs_sync` | None |
| `SaveRepositoryState` | `state: RepositoryState` | None |

**Sync History Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `RecordSyncStart` | `repo_name`, `sync_type` | `int` (record_id) |
| `RecordSyncComplete` | `record_id`, `success`, `prs_synced`, `branches_synced`, `error_message` | None |

**Maintenance Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `CleanupOldSnapshots` | `days` | `int` (deleted count) |
| `GetStatistics` | - | `dict` |
| `GetSchemaInfo` | - | `dict` |

**Composite Actions:**

| Action | Parameters | Returns |
|--------|------------|---------|
| `SyncPRWithContext` | `repo_path`, `pr_number` | `dict` |

---

### Export/Import Functions

#### `export_database`

```python
async def export_database(
    db: SyncStore,
    output_path: Path | str,
    format: ArtifactFormat = ArtifactFormat.JSON_GZ,
    repo_filter: str | None = None,
    include_contexts: bool = True,
    pretty: bool = False,
) -> dict[str, Any]
```

**Returns:**

```python
{
    "path": "/path/to/export.json.gz",
    "format": "json.gz",
    "file_size_bytes": 12345,
    "file_size_mb": 0.01,
    "repositories": 2,
    "pull_requests": 15,
    "pr_contexts": 10,
}
```

#### `import_database`

```python
async def import_database(
    db: SyncStore,
    input_path: Path | str,
    merge_strategy: str = "replace",
) -> dict[str, Any]
```

**Returns:**

```python
{
    "source": "/path/to/import.json.gz",
    "schema_version": "1.0",
    "repositories_imported": 2,
    "pull_requests_imported": 15,
    "pr_contexts_imported": 10,
    "skipped": 0,
    "errors": 0,
}
```

---

### Exceptions

| Exception | Description |
|-----------|-------------|
| `DatabaseError` | General database operation error |
| `MigrationError` | Schema migration failed |
| `ProjectManagerError` | Base exception for project manager |
| `ProjectNotFoundError` | Project doesn't exist |
| `WorktreeError` | Worktree operation failed |
| `LeaseError` | Lease operation failed (e.g., max worktrees reached) |

---

### Constants

| Constant | Description |
|----------|-------------|
| `SCHEMA_VERSION` | Current database schema version (currently 2) |

---

## Testing

Run the test suite:

```bash
# All tests (excluding slow Docker tests) - 252 tests
uv run pytest tests/ --ignore=tests/test_gitea_integration.py -v

# Include Docker-based integration tests (requires Docker)
uv run pytest tests/ -v

# With coverage
uv run pytest tests/ --ignore=tests/test_gitea_integration.py --cov=github_sync --cov-report=html
```

## Schema Migrations

The library automatically handles database migrations. When you upgrade to a new version:

- **v1 → v2**: Adds `project_metadata` table for flexible project identification

Migrations run automatically on `store.initialize()`. Check current version:

```python
info = await store.get_schema_info()
print(f"Schema version: {info['current_version']}")
```

## License

MIT
