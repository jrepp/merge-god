"""
Project directory management with git worktree leases.

This module provides a system for managing multiple parallel workers
against the same repository by:
- Maintaining a single read-only bare clone (shared git object cache)
- Creating git worktrees for individual work units
- Managing leases on worktrees to prevent conflicts

Usage:
    async with ProjectManager(base_dir, store) as pm:
        # Create/update a project from a git URL
        project = await pm.ensure_project("my-repo", "https://github.com/org/repo.git")

        # Acquire a worktree lease for a branch
        async with await pm.acquire_worktree("my-repo", "feature-branch", worker_id="worker-1") as lease:
            # Work with the repository at lease.path
            result = subprocess.run(["make", "test"], cwd=lease.path)

        # Lease is automatically released when exiting the context
"""

import asyncio
import json
import logging
import re
import shutil
import subprocess
import uuid
import weakref
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

try:
    from filelock import FileLock
except ImportError:
    FileLock = None  # Optional dependency for multi-process safety

if TYPE_CHECKING:
    from github_sync.sync_store import SyncStore
else:
    from github_sync.sync_store import SyncStore


logger = logging.getLogger(__name__)


class ProjectManagerError(Exception):
    """Base exception for project manager errors."""


class ProjectNotFoundError(ProjectManagerError):
    """Raised when a project doesn't exist."""


class WorktreeError(ProjectManagerError):
    """Raised for worktree-related errors."""


class LeaseError(ProjectManagerError):
    """Raised for lease-related errors."""


class ValidationError(ProjectManagerError):
    """Raised for invalid input values."""


# Valid project name pattern: alphanumeric, hyphens, underscores only
PROJECT_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")


@dataclass
class Project:
    """Represents a managed project (bare clone)."""

    name: str
    git_url: str
    bare_path: Path
    created_at: datetime
    last_fetch: datetime | None = None
    default_branch: str = "main"
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "git_url": self.git_url,
            "bare_path": str(self.bare_path),
            "created_at": self.created_at.isoformat(),
            "last_fetch": self.last_fetch.isoformat() if self.last_fetch else None,
            "default_branch": self.default_branch,
            "metadata": dict(self.metadata),  # Return copy to prevent mutation
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Project":
        return cls(
            name=data["name"],
            git_url=data["git_url"],
            bare_path=Path(data["bare_path"]),
            created_at=datetime.fromisoformat(data["created_at"]),
            last_fetch=datetime.fromisoformat(data["last_fetch"])
            if data.get("last_fetch")
            else None,
            default_branch=data.get("default_branch", "main"),
            metadata=data.get("metadata", {}),
        )


@dataclass
class WorktreeLease:
    """Represents a lease on a git worktree."""

    id: str
    project_name: str
    branch: str
    path: Path
    worker_id: str
    acquired_at: datetime
    expires_at: datetime
    commit_sha: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    # Weak reference to manager for context manager support (prevents memory leaks)
    _manager_ref: "weakref.ref[ProjectManager] | None" = field(default=None, repr=False)

    @property
    def _manager(self) -> "ProjectManager | None":
        """Get the manager from weak reference."""
        return self._manager_ref() if self._manager_ref else None

    def _set_manager(self, manager: "ProjectManager | None") -> None:
        """Set the manager as a weak reference."""
        self._manager_ref = weakref.ref(manager) if manager else None

    @property
    def is_expired(self) -> bool:
        return datetime.now(UTC) > self.expires_at

    @property
    def remaining_seconds(self) -> float:
        return max(0, (self.expires_at - datetime.now(UTC)).total_seconds())

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_name": self.project_name,
            "branch": self.branch,
            "path": str(self.path),
            "worker_id": self.worker_id,
            "acquired_at": self.acquired_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "commit_sha": self.commit_sha,
            "metadata": dict(self.metadata),  # Return copy to prevent mutation
        }

    @classmethod
    def from_dict(
        cls, data: dict[str, Any], manager: "ProjectManager | None" = None
    ) -> "WorktreeLease":
        lease = cls(
            id=data["id"],
            project_name=data["project_name"],
            branch=data["branch"],
            path=Path(data["path"]),
            worker_id=data["worker_id"],
            acquired_at=datetime.fromisoformat(data["acquired_at"]),
            expires_at=datetime.fromisoformat(data["expires_at"]),
            commit_sha=data.get("commit_sha"),
            metadata=data.get("metadata", {}),
        )
        lease._set_manager(manager)
        return lease

    async def __aenter__(self) -> "WorktreeLease":
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._manager:
            await self._manager.release_worktree(self)


class ProjectManager:
    """
    Manages project directories with git worktree leases.

    This class provides:
    - Single bare clone per project (read-only, shared object cache)
    - Multiple worktrees for parallel work on different branches
    - Lease management to track active worktrees
    - Automatic cleanup of expired leases

    The bare clone is never modified directly - all work happens in worktrees.

    For multi-process safety, install the optional `filelock` package:
        pip install filelock
    """

    # Default timeout for git operations (seconds)
    DEFAULT_GIT_TIMEOUT = 300

    def __init__(
        self,
        base_dir: Path | str,
        store: SyncStore | None = None,
        default_lease_duration: timedelta = timedelta(hours=1),
        max_worktrees_per_project: int = 10,
        git_timeout: int | None = None,
    ):
        """
        Initialize the project manager.

        Args:
            base_dir: Base directory for all project data
            store: Optional SyncStore for persistent lease tracking
            default_lease_duration: Default duration for worktree leases
            max_worktrees_per_project: Maximum concurrent worktrees per project
            git_timeout: Timeout in seconds for git operations (default: 300)
        """
        self.base_dir = Path(base_dir)
        self.store = store
        self.default_lease_duration = default_lease_duration
        self.max_worktrees_per_project = max_worktrees_per_project
        self.git_timeout = git_timeout or self.DEFAULT_GIT_TIMEOUT

        # In-memory tracking (authoritative if no store)
        self._projects: dict[str, Project] = {}
        self._leases: dict[str, WorktreeLease] = {}
        self._lock = asyncio.Lock()

        # Directory structure
        self._projects_dir = self.base_dir / "projects"
        self._worktrees_dir = self.base_dir / "worktrees"

        # File-based lock for multi-process safety (if filelock is available)
        self._file_lock: FileLock | None = None
        self._file_lock_path = self.base_dir / ".lock"

    def _validate_project_name(self, name: str) -> None:
        """Validate project name to prevent path traversal and invalid characters."""
        if not name:
            raise ValidationError("Project name cannot be empty")
        if len(name) > 128:
            raise ValidationError("Project name too long (max 128 characters)")
        if not PROJECT_NAME_PATTERN.match(name):
            raise ValidationError(
                f"Invalid project name '{name}'. "
                "Must start with alphanumeric and contain only alphanumeric, hyphens, underscores."
            )

    async def _acquire_file_lock(self) -> None:
        """Acquire file-based lock for multi-process safety."""
        if FileLock is None:
            return  # filelock not installed, skip
        if self._file_lock is None:
            self._file_lock_path.parent.mkdir(parents=True, exist_ok=True)
            self._file_lock = FileLock(str(self._file_lock_path), timeout=30)
        await asyncio.to_thread(self._file_lock.acquire)

    async def _release_file_lock(self) -> None:
        """Release file-based lock."""
        if self._file_lock is not None and self._file_lock.is_locked:
            await asyncio.to_thread(self._file_lock.release)

    async def initialize(self) -> None:
        """Initialize the project manager and create directories."""
        self._projects_dir.mkdir(parents=True, exist_ok=True)
        self._worktrees_dir.mkdir(parents=True, exist_ok=True)

        if self.store:
            await self.store.initialize()
            await self._load_state_from_store()
        else:
            await self._load_state_from_disk()

    async def _load_state_from_store(self) -> None:
        """Load projects and leases from the database."""
        meta = await self.store.get_project_metadata()
        pm_data = meta.get("metadata", {}).get("project_manager", {})

        for proj_data in pm_data.get("projects", {}).values():
            project = Project.from_dict(proj_data)
            if project.bare_path.exists():
                self._projects[project.name] = project

        for lease_data in pm_data.get("leases", {}).values():
            lease = WorktreeLease.from_dict(lease_data, manager=self)
            if not lease.is_expired and lease.path.exists():
                self._leases[lease.id] = lease

    async def _load_state_from_disk(self) -> None:
        """Scan disk for existing projects."""
        if not self._projects_dir.exists():
            return

        for proj_dir in self._projects_dir.iterdir():
            if proj_dir.is_dir() and (proj_dir / "HEAD").exists():
                # This is a bare git repo
                config_file = proj_dir / "project.json"
                if config_file.exists():
                    data = json.loads(config_file.read_text())
                    self._projects[data["name"]] = Project.from_dict(data)

    async def _save_state_to_store(self) -> None:
        """Persist state to the database."""
        if not self.store:
            return

        pm_data = {
            "projects": {name: proj.to_dict() for name, proj in self._projects.items()},
            "leases": {lid: lease.to_dict() for lid, lease in self._leases.items()},
        }

        await self.store.update_project_metadata("project_manager", pm_data)

    async def _save_project_to_disk(self, project: Project) -> None:
        """Save project metadata to disk."""
        config_file = project.bare_path / "project.json"
        content = json.dumps(project.to_dict(), indent=2)
        await asyncio.to_thread(config_file.write_text, content)

    async def __aenter__(self) -> "ProjectManager":
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Cleanup on exit: release file lock and optionally cleanup expired leases."""
        try:
            # Cleanup expired leases to prevent orphaned worktrees
            await self.cleanup_expired_leases()
        except Exception:
            logger.exception("Error during cleanup in __aexit__")
        finally:
            await self._release_file_lock()

    # Project Management

    async def ensure_project(
        self,
        name: str,
        git_url: str,
        fetch: bool = True,
        metadata: dict[str, Any] | None = None,
    ) -> Project:
        """
        Ensure a project exists, creating or updating as needed.

        Args:
            name: Unique project name
            git_url: Git URL to clone from
            fetch: Whether to fetch latest changes
            metadata: Optional metadata to store with project

        Returns:
            The Project object

        Raises:
            ValidationError: If project name is invalid
            ValidationError: If project exists with different git_url
        """
        self._validate_project_name(name)

        async with self._lock:
            await self._acquire_file_lock()
            try:
                if name in self._projects:
                    project = self._projects[name]
                    # Check for URL mismatch
                    if project.git_url != git_url:
                        raise ValidationError(
                            f"Project '{name}' exists with different URL. "
                            f"Existing: {project.git_url}, Requested: {git_url}. "
                            "Delete the project first if you want to change the URL."
                        )
                    if fetch:
                        await self._fetch_project(project)
                    return project

                # Create new project (bare clone)
                project = await self._create_project(name, git_url, metadata)
                self._projects[name] = project

                await self._save_project_to_disk(project)
                await self._save_state_to_store()

                return project
            finally:
                await self._release_file_lock()

    def _run_git_sync(
        self,
        cmd: list[str],
        cwd: Path | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        """Run a git command synchronously (for use with asyncio.to_thread)."""
        return subprocess.run(
            cmd,
            cwd=cwd,
            check=check,
            capture_output=True,
            text=True,
            timeout=self.git_timeout,
        )

    async def _create_project(
        self,
        name: str,
        git_url: str,
        metadata: dict[str, Any] | None = None,
    ) -> Project:
        """Create a new bare clone for a project."""
        bare_path = self._projects_dir / name

        if bare_path.exists():
            await asyncio.to_thread(shutil.rmtree, bare_path)

        logger.info(f"Cloning {git_url} as bare repo to {bare_path}")

        # Clone as bare repository
        await asyncio.to_thread(
            self._run_git_sync,
            ["git", "clone", "--bare", "--filter=blob:none", git_url, str(bare_path)],
        )

        # Get default branch
        result = await asyncio.to_thread(
            self._run_git_sync,
            ["git", "symbolic-ref", "--short", "HEAD"],
            cwd=bare_path,
            check=False,
        )
        default_branch = result.stdout.strip() if result.returncode == 0 else "main"

        now = datetime.now(UTC)
        return Project(
            name=name,
            git_url=git_url,
            bare_path=bare_path,
            created_at=now,
            last_fetch=now,
            default_branch=default_branch,
            metadata=metadata or {},
        )

    async def _fetch_project(self, project: Project) -> None:
        """Fetch latest changes for a project."""
        logger.info(f"Fetching updates for {project.name}")

        await asyncio.to_thread(
            self._run_git_sync,
            ["git", "fetch", "--all", "--prune"],
            cwd=project.bare_path,
        )

        project.last_fetch = datetime.now(UTC)
        await self._save_project_to_disk(project)
        await self._save_state_to_store()

    async def get_project(self, name: str) -> Project | None:
        """Get a project by name."""
        return self._projects.get(name)

    async def list_projects(self) -> list[Project]:
        """List all projects."""
        return list(self._projects.values())

    async def delete_project(self, name: str, force: bool = False) -> bool:
        """
        Delete a project and all its worktrees.

        Args:
            name: Project name
            force: If True, delete even if there are active leases

        Returns:
            True if deleted, False if not found
        """
        async with self._lock:
            project = self._projects.get(name)
            if not project:
                return False

            # Check for active leases
            active_leases = [
                l for l in self._leases.values() if l.project_name == name and not l.is_expired
            ]
            if active_leases and not force:
                raise LeaseError(
                    f"Project {name} has {len(active_leases)} active leases. Use force=True to delete anyway."
                )

            # Remove worktrees
            for lease in list(self._leases.values()):
                if lease.project_name == name:
                    await self._cleanup_worktree(lease)
                    del self._leases[lease.id]

            # Remove bare repo
            if project.bare_path.exists():
                await asyncio.to_thread(shutil.rmtree, project.bare_path)

            del self._projects[name]
            await self._save_state_to_store()

            return True

    # Worktree Management

    async def acquire_worktree(
        self,
        project_name: str,
        branch: str,
        worker_id: str,
        duration: timedelta | None = None,
        create_branch: bool = False,
        start_point: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> WorktreeLease:
        """
        Acquire a lease on a worktree for a branch.

        Args:
            project_name: Name of the project
            branch: Branch to checkout in the worktree
            worker_id: Identifier for the worker acquiring the lease
            duration: Lease duration (defaults to default_lease_duration)
            create_branch: If True, create the branch if it doesn't exist
            start_point: Starting point for new branch (e.g., "origin/main")
            metadata: Optional metadata for the lease

        Returns:
            WorktreeLease object (can be used as async context manager)
        """
        async with self._lock:
            project = self._projects.get(project_name)
            if not project:
                raise ProjectNotFoundError(f"Project '{project_name}' not found")

            # Check worktree limit
            project_leases = [
                l
                for l in self._leases.values()
                if l.project_name == project_name and not l.is_expired
            ]
            if len(project_leases) >= self.max_worktrees_per_project:
                raise LeaseError(
                    f"Maximum worktrees ({self.max_worktrees_per_project}) reached for project {project_name}"
                )

            # Check for existing lease on same branch by same worker
            for lease in project_leases:
                if lease.branch == branch and lease.worker_id == worker_id:
                    # Extend existing lease
                    lease.expires_at = datetime.now(UTC) + (duration or self.default_lease_duration)
                    await self._save_state_to_store()
                    return lease

            # Create new worktree
            lease = await self._create_worktree(
                project=project,
                branch=branch,
                worker_id=worker_id,
                duration=duration or self.default_lease_duration,
                create_branch=create_branch,
                start_point=start_point,
                metadata=metadata,
            )

            self._leases[lease.id] = lease
            await self._save_state_to_store()

            return lease

    async def _create_worktree(
        self,
        project: Project,
        branch: str,
        worker_id: str,
        duration: timedelta,
        create_branch: bool,
        start_point: str | None,
        metadata: dict[str, Any] | None,
    ) -> WorktreeLease:
        """Create a new git worktree."""
        # Use full UUID to prevent collision (8 chars had birthday problem at ~65k leases)
        lease_id = str(uuid.uuid4())
        # Shorten for path but keep full ID for tracking
        short_id = lease_id[:12]
        worktree_path = (
            self._worktrees_dir / project.name / f"{branch.replace('/', '_')}_{short_id}"
        )

        await asyncio.to_thread(worktree_path.parent.mkdir, parents=True, exist_ok=True)

        # Build worktree command
        cmd = ["git", "worktree", "add"]

        if create_branch:
            cmd.extend(["-b", branch])
            cmd.append(str(worktree_path))
            if start_point:
                cmd.append(start_point)
            else:
                cmd.append(f"origin/{project.default_branch}")
        else:
            cmd.append(str(worktree_path))
            # We'll try different branch references below
            branch_ref = None

        logger.info(f"Creating worktree for branch: {branch}")

        # If not creating a new branch, try different branch references
        if not create_branch:
            # Try in order: origin/branch, branch (local)
            refs_to_try = []
            if "/" not in branch:
                refs_to_try.append(f"origin/{branch}")
            refs_to_try.append(branch)

            last_error = None
            for ref in refs_to_try:
                try_cmd = [*cmd, ref]
                logger.debug(f"Trying worktree with ref: {ref}")
                try:
                    await asyncio.to_thread(
                        self._run_git_sync,
                        try_cmd,
                        cwd=project.bare_path,
                    )
                    branch_ref = ref
                    break
                except subprocess.CalledProcessError as e:
                    last_error = e
                    continue

            if branch_ref is None:
                raise WorktreeError(
                    f"Failed to create worktree: {last_error.stderr if last_error else 'unknown error'}"
                )
        else:
            # Creating a new branch - just run the command
            try:
                await asyncio.to_thread(
                    self._run_git_sync,
                    cmd,
                    cwd=project.bare_path,
                )
            except subprocess.CalledProcessError as e:
                raise WorktreeError(f"Failed to create worktree: {e.stderr}") from e

        # Get current commit SHA
        result = await asyncio.to_thread(
            self._run_git_sync,
            ["git", "rev-parse", "HEAD"],
            cwd=worktree_path,
            check=False,
        )
        commit_sha = result.stdout.strip() if result.returncode == 0 else None

        now = datetime.now(UTC)
        lease = WorktreeLease(
            id=lease_id,
            project_name=project.name,
            branch=branch,
            path=worktree_path,
            worker_id=worker_id,
            acquired_at=now,
            expires_at=now + duration,
            commit_sha=commit_sha,
            metadata=metadata or {},
        )
        lease._set_manager(self)
        return lease

    async def release_worktree(self, lease: WorktreeLease) -> None:
        """
        Release a worktree lease.

        Args:
            lease: The lease to release
        """
        async with self._lock:
            if lease.id not in self._leases:
                return

            await self._cleanup_worktree(lease)
            del self._leases[lease.id]
            await self._save_state_to_store()

    async def _cleanup_worktree(self, lease: WorktreeLease) -> None:
        """Remove a worktree from disk."""
        project = self._projects.get(lease.project_name)
        if not project:
            # Just remove the directory
            if lease.path.exists():
                await asyncio.to_thread(shutil.rmtree, lease.path)
            return

        # Remove via git worktree
        try:
            await asyncio.to_thread(
                self._run_git_sync,
                ["git", "worktree", "remove", "--force", str(lease.path)],
                cwd=project.bare_path,
            )
        except subprocess.CalledProcessError:
            # Fallback: remove directory manually
            if lease.path.exists():
                await asyncio.to_thread(shutil.rmtree, lease.path)

        # Prune worktree list
        try:
            await asyncio.to_thread(
                self._run_git_sync,
                ["git", "worktree", "prune"],
                cwd=project.bare_path,
                check=False,
            )
        except subprocess.CalledProcessError:
            pass

    async def extend_lease(
        self, lease_id: str, duration: timedelta | None = None, additive: bool = True
    ) -> WorktreeLease | None:
        """
        Extend a lease's expiration time.

        Args:
            lease_id: ID of the lease to extend
            duration: Duration to add (defaults to default_lease_duration)
            additive: If True (default), adds duration to current expiration.
                     If False, sets expiration to now + duration.

        Returns:
            Updated lease or None if not found
        """
        async with self._lock:
            lease = self._leases.get(lease_id)
            if not lease:
                return None

            extend_by = duration or self.default_lease_duration
            if additive:
                # Add to current expiration (or now if already expired)
                base_time = max(lease.expires_at, datetime.now(UTC))
                lease.expires_at = base_time + extend_by
            else:
                # Set to now + duration
                lease.expires_at = datetime.now(UTC) + extend_by

            await self._save_state_to_store()
            return lease

    async def get_lease(self, lease_id: str) -> WorktreeLease | None:
        """Get a lease by ID."""
        return self._leases.get(lease_id)

    async def list_leases(
        self, project_name: str | None = None, worker_id: str | None = None
    ) -> list[WorktreeLease]:
        """
        List active leases.

        Args:
            project_name: Filter by project name
            worker_id: Filter by worker ID

        Returns:
            List of matching leases
        """
        leases = list(self._leases.values())

        if project_name:
            leases = [l for l in leases if l.project_name == project_name]

        if worker_id:
            leases = [l for l in leases if l.worker_id == worker_id]

        return leases

    async def cleanup_expired_leases(self) -> int:
        """
        Clean up all expired leases.

        Returns:
            Number of leases cleaned up
        """
        async with self._lock:
            expired = [l for l in self._leases.values() if l.is_expired]

            for lease in expired:
                logger.info(
                    f"Cleaning up expired lease {lease.id} for {lease.project_name}:{lease.branch}"
                )
                await self._cleanup_worktree(lease)
                del self._leases[lease.id]

            if expired:
                await self._save_state_to_store()

            return len(expired)

    # Utility Methods

    async def get_worktree_status(self, lease: WorktreeLease) -> dict[str, Any]:
        """
        Get the current status of a worktree.

        Args:
            lease: The worktree lease

        Returns:
            Dict with status information
        """
        if not lease.path.exists():
            return {"exists": False, "error": "Worktree path does not exist"}

        # Get current HEAD
        result = await asyncio.to_thread(
            self._run_git_sync,
            ["git", "rev-parse", "HEAD"],
            cwd=lease.path,
            check=False,
        )
        current_sha = result.stdout.strip() if result.returncode == 0 else None

        # Get status
        result = await asyncio.to_thread(
            self._run_git_sync,
            ["git", "status", "--porcelain"],
            cwd=lease.path,
            check=False,
        )
        has_changes = bool(result.stdout.strip()) if result.returncode == 0 else None

        # Get branch
        result = await asyncio.to_thread(
            self._run_git_sync,
            ["git", "branch", "--show-current"],
            cwd=lease.path,
            check=False,
        )
        current_branch = result.stdout.strip() if result.returncode == 0 else None

        return {
            "exists": True,
            "current_sha": current_sha,
            "original_sha": lease.commit_sha,
            "has_changes": has_changes,
            "current_branch": current_branch,
            "lease_branch": lease.branch,
            "remaining_seconds": lease.remaining_seconds,
            "is_expired": lease.is_expired,
        }

    @asynccontextmanager
    async def worktree_context(
        self,
        project_name: str,
        branch: str,
        worker_id: str,
        **kwargs,
    ):
        """
        Context manager for acquiring and automatically releasing a worktree.

        Usage:
            async with pm.worktree_context("my-project", "feature", "worker-1") as lease:
                # Do work in lease.path
                pass
            # Lease is automatically released
        """
        lease = await self.acquire_worktree(project_name, branch, worker_id, **kwargs)
        try:
            yield lease
        finally:
            await self.release_worktree(lease)
