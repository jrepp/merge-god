"""
Tests for ProjectManager with git worktree leases.

Uses temporary directories to simulate an in-memory filesystem approach.
Creates real git repositories for testing worktree functionality.
"""

import asyncio
import subprocess
from datetime import timedelta
from pathlib import Path

import pytest

from github_sync import (
    LeaseError,
    Project,
    ProjectManager,
    ProjectNotFoundError,
    SyncStore,
    WorktreeLease,
)

# Fixtures for creating test git repositories


@pytest.fixture
def create_test_repo(tmp_path: Path):
    """Factory fixture to create test git repositories."""

    def _create(name: str = "test-repo", with_branches: bool = False) -> Path:
        repo_path = tmp_path / f"source_{name}"
        repo_path.mkdir(parents=True)

        # Initialize git repo
        subprocess.run(["git", "init"], cwd=repo_path, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@test.local"],
            cwd=repo_path,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=repo_path,
            check=True,
            capture_output=True,
        )

        # Create initial commit
        (repo_path / "README.md").write_text(f"# {name}\n\nTest repository")
        subprocess.run(["git", "add", "."], cwd=repo_path, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"],
            cwd=repo_path,
            check=True,
            capture_output=True,
        )

        # Set default branch to main
        subprocess.run(
            ["git", "branch", "-M", "main"],
            cwd=repo_path,
            check=True,
            capture_output=True,
        )

        if with_branches:
            # Create feature branch
            subprocess.run(
                ["git", "checkout", "-b", "feature/test"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )
            (repo_path / "feature.txt").write_text("Feature content")
            subprocess.run(["git", "add", "."], cwd=repo_path, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", "Add feature"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )

            # Create another branch
            subprocess.run(
                ["git", "checkout", "main"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "checkout", "-b", "bugfix/issue-1"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )
            (repo_path / "bugfix.txt").write_text("Bugfix content")
            subprocess.run(["git", "add", "."], cwd=repo_path, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", "Fix issue"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )

            # Return to main
            subprocess.run(
                ["git", "checkout", "main"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )

        return repo_path

    return _create


@pytest.fixture
def project_manager_dir(tmp_path: Path) -> Path:
    """Directory for project manager data."""
    pm_dir = tmp_path / "project_manager"
    pm_dir.mkdir()
    return pm_dir


@pytest.fixture
async def project_manager(project_manager_dir: Path) -> ProjectManager:
    """Create an initialized project manager without database."""
    pm = ProjectManager(project_manager_dir)
    await pm.initialize()
    return pm


@pytest.fixture
async def project_manager_with_store(project_manager_dir: Path, tmp_path: Path) -> ProjectManager:
    """Create a project manager with database store."""
    store = SyncStore(tmp_path / "pm_store.db")
    await store.initialize()
    pm = ProjectManager(project_manager_dir, store=store)
    await pm.initialize()
    return pm


class TestProjectManagerInitialization:
    """Tests for project manager initialization."""

    @pytest.mark.asyncio
    async def test_initialize_creates_directories(self, project_manager_dir: Path):
        """Test that initialization creates required directories."""
        pm = ProjectManager(project_manager_dir)
        await pm.initialize()

        assert (project_manager_dir / "projects").exists()
        assert (project_manager_dir / "worktrees").exists()

    @pytest.mark.asyncio
    async def test_context_manager(self, project_manager_dir: Path):
        """Test using project manager as context manager."""
        async with ProjectManager(project_manager_dir) as pm:
            assert (project_manager_dir / "projects").exists()
            assert pm is not None

    @pytest.mark.asyncio
    async def test_custom_lease_duration(self, project_manager_dir: Path):
        """Test custom default lease duration."""
        pm = ProjectManager(
            project_manager_dir,
            default_lease_duration=timedelta(minutes=30),
        )
        await pm.initialize()
        assert pm.default_lease_duration == timedelta(minutes=30)


class TestProjectManagement:
    """Tests for project creation and management."""

    @pytest.mark.asyncio
    async def test_ensure_project_creates_bare_clone(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test that ensure_project creates a bare clone."""
        source_repo = create_test_repo("my-project")

        project = await project_manager.ensure_project("my-project", str(source_repo))

        assert project.name == "my-project"
        assert project.bare_path.exists()
        assert (project.bare_path / "HEAD").exists()  # Bare repo indicator
        assert project.default_branch == "main"

    @pytest.mark.asyncio
    async def test_ensure_project_with_metadata(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test creating project with custom metadata."""
        source_repo = create_test_repo("meta-project")

        project = await project_manager.ensure_project(
            "meta-project",
            str(source_repo),
            metadata={"team": "backend", "priority": "high"},
        )

        assert project.metadata["team"] == "backend"
        assert project.metadata["priority"] == "high"

    @pytest.mark.asyncio
    async def test_ensure_project_idempotent(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test that ensure_project is idempotent."""
        source_repo = create_test_repo("idem-project")

        project1 = await project_manager.ensure_project("idem-project", str(source_repo))
        project2 = await project_manager.ensure_project("idem-project", str(source_repo))

        assert project1.name == project2.name
        assert project1.bare_path == project2.bare_path

    @pytest.mark.asyncio
    async def test_get_project(self, project_manager: ProjectManager, create_test_repo):
        """Test getting a project by name."""
        source_repo = create_test_repo("get-project")
        await project_manager.ensure_project("get-project", str(source_repo))

        project = await project_manager.get_project("get-project")
        assert project is not None
        assert project.name == "get-project"

        nonexistent = await project_manager.get_project("nonexistent")
        assert nonexistent is None

    @pytest.mark.asyncio
    async def test_list_projects(self, project_manager: ProjectManager, create_test_repo):
        """Test listing all projects."""
        for i in range(3):
            source = create_test_repo(f"list-project-{i}")
            await project_manager.ensure_project(f"list-project-{i}", str(source))

        projects = await project_manager.list_projects()
        assert len(projects) == 3
        names = {p.name for p in projects}
        assert names == {"list-project-0", "list-project-1", "list-project-2"}

    @pytest.mark.asyncio
    async def test_delete_project(self, project_manager: ProjectManager, create_test_repo):
        """Test deleting a project."""
        source_repo = create_test_repo("delete-project")
        project = await project_manager.ensure_project("delete-project", str(source_repo))
        bare_path = project.bare_path

        result = await project_manager.delete_project("delete-project")

        assert result is True
        assert not bare_path.exists()
        assert await project_manager.get_project("delete-project") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_project(self, project_manager: ProjectManager):
        """Test deleting a project that doesn't exist."""
        result = await project_manager.delete_project("nonexistent")
        assert result is False


class TestWorktreeLeases:
    """Tests for worktree lease management."""

    @pytest.mark.asyncio
    async def test_acquire_worktree(self, project_manager: ProjectManager, create_test_repo):
        """Test acquiring a worktree lease."""
        source_repo = create_test_repo("worktree-project", with_branches=True)
        await project_manager.ensure_project("worktree-project", str(source_repo))

        lease = await project_manager.acquire_worktree(
            "worktree-project",
            "main",
            worker_id="worker-1",
        )

        assert lease.project_name == "worktree-project"
        assert lease.branch == "main"
        assert lease.worker_id == "worker-1"
        assert lease.path.exists()
        assert (lease.path / "README.md").exists()

    @pytest.mark.asyncio
    async def test_acquire_worktree_with_duration(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test acquiring worktree with custom duration."""
        source_repo = create_test_repo("duration-project")
        await project_manager.ensure_project("duration-project", str(source_repo))

        lease = await project_manager.acquire_worktree(
            "duration-project",
            "main",
            worker_id="worker-1",
            duration=timedelta(hours=2),
        )

        assert lease.remaining_seconds > 7000  # Close to 2 hours

    @pytest.mark.asyncio
    async def test_acquire_worktree_for_branch(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test acquiring worktree for a specific branch."""
        source_repo = create_test_repo("branch-project", with_branches=True)
        await project_manager.ensure_project("branch-project", str(source_repo))

        lease = await project_manager.acquire_worktree(
            "branch-project",
            "feature/test",
            worker_id="worker-1",
        )

        assert lease.branch == "feature/test"
        assert (lease.path / "feature.txt").exists()

    @pytest.mark.asyncio
    async def test_acquire_worktree_project_not_found(self, project_manager: ProjectManager):
        """Test error when project doesn't exist."""
        with pytest.raises(ProjectNotFoundError) as exc_info:
            await project_manager.acquire_worktree(
                "nonexistent",
                "main",
                worker_id="worker-1",
            )

        assert "nonexistent" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_release_worktree(self, project_manager: ProjectManager, create_test_repo):
        """Test releasing a worktree lease."""
        source_repo = create_test_repo("release-project")
        await project_manager.ensure_project("release-project", str(source_repo))

        lease = await project_manager.acquire_worktree(
            "release-project",
            "main",
            worker_id="worker-1",
        )
        worktree_path = lease.path
        assert worktree_path.exists()

        await project_manager.release_worktree(lease)

        assert not worktree_path.exists()
        assert await project_manager.get_lease(lease.id) is None

    @pytest.mark.asyncio
    async def test_worktree_context_manager(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test using worktree as context manager."""
        source_repo = create_test_repo("ctx-project")
        await project_manager.ensure_project("ctx-project", str(source_repo))

        async with await project_manager.acquire_worktree(
            "ctx-project",
            "main",
            worker_id="worker-1",
        ) as lease:
            assert lease.path.exists()
            worktree_path = lease.path

        # Lease should be released automatically
        assert not worktree_path.exists()

    @pytest.mark.asyncio
    async def test_worktree_context_helper(self, project_manager: ProjectManager, create_test_repo):
        """Test worktree_context helper method."""
        source_repo = create_test_repo("helper-project")
        await project_manager.ensure_project("helper-project", str(source_repo))

        async with project_manager.worktree_context(
            "helper-project",
            "main",
            worker_id="worker-1",
        ) as lease:
            assert lease.path.exists()
            worktree_path = lease.path

        assert not worktree_path.exists()


class TestMultipleWorktrees:
    """Tests for multiple concurrent worktrees."""

    @pytest.mark.asyncio
    async def test_multiple_worktrees_same_project(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test creating multiple worktrees for the same project."""
        source_repo = create_test_repo("multi-project", with_branches=True)
        await project_manager.ensure_project("multi-project", str(source_repo))

        lease1 = await project_manager.acquire_worktree(
            "multi-project", "main", worker_id="worker-1"
        )
        lease2 = await project_manager.acquire_worktree(
            "multi-project", "feature/test", worker_id="worker-2"
        )

        assert lease1.path != lease2.path
        assert lease1.path.exists()
        assert lease2.path.exists()

        # Verify different content
        assert (lease1.path / "README.md").exists()
        assert (lease2.path / "feature.txt").exists()

    @pytest.mark.asyncio
    async def test_max_worktrees_limit(self, project_manager_dir: Path, create_test_repo):
        """Test that max worktrees limit is enforced."""
        pm = ProjectManager(project_manager_dir, max_worktrees_per_project=2)
        await pm.initialize()

        source_repo = create_test_repo("limit-project", with_branches=True)
        await pm.ensure_project("limit-project", str(source_repo))

        await pm.acquire_worktree("limit-project", "main", worker_id="w1")
        await pm.acquire_worktree("limit-project", "feature/test", worker_id="w2")

        with pytest.raises(LeaseError) as exc_info:
            await pm.acquire_worktree("limit-project", "bugfix/issue-1", worker_id="w3")

        assert "Maximum worktrees" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_same_worker_same_branch_extends_lease(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test that same worker acquiring same branch extends the lease."""
        source_repo = create_test_repo("extend-project")
        await project_manager.ensure_project("extend-project", str(source_repo))

        lease1 = await project_manager.acquire_worktree(
            "extend-project", "main", worker_id="worker-1"
        )
        original_expires = lease1.expires_at

        await asyncio.sleep(0.01)

        lease2 = await project_manager.acquire_worktree(
            "extend-project", "main", worker_id="worker-1"
        )

        assert lease1.id == lease2.id
        assert lease2.expires_at >= original_expires

    @pytest.mark.asyncio
    async def test_list_leases(self, project_manager: ProjectManager, create_test_repo):
        """Test listing active leases."""
        source_repo = create_test_repo("list-lease-project", with_branches=True)
        await project_manager.ensure_project("list-lease-project", str(source_repo))

        await project_manager.acquire_worktree("list-lease-project", "main", worker_id="w1")
        await project_manager.acquire_worktree("list-lease-project", "feature/test", worker_id="w2")

        all_leases = await project_manager.list_leases()
        assert len(all_leases) == 2

        worker_leases = await project_manager.list_leases(worker_id="w1")
        assert len(worker_leases) == 1
        assert worker_leases[0].worker_id == "w1"


class TestLeaseExpiration:
    """Tests for lease expiration and cleanup."""

    @pytest.mark.asyncio
    async def test_lease_expiration_check(self, project_manager_dir: Path, create_test_repo):
        """Test checking if a lease is expired."""
        pm = ProjectManager(
            project_manager_dir,
            default_lease_duration=timedelta(milliseconds=50),
        )
        await pm.initialize()

        source_repo = create_test_repo("expire-project")
        await pm.ensure_project("expire-project", str(source_repo))

        lease = await pm.acquire_worktree("expire-project", "main", worker_id="w1")
        assert not lease.is_expired

        await asyncio.sleep(0.1)
        assert lease.is_expired

    @pytest.mark.asyncio
    async def test_cleanup_expired_leases(self, project_manager_dir: Path, create_test_repo):
        """Test cleaning up expired leases."""
        pm = ProjectManager(
            project_manager_dir,
            default_lease_duration=timedelta(milliseconds=50),
        )
        await pm.initialize()

        source_repo = create_test_repo("cleanup-project")
        await pm.ensure_project("cleanup-project", str(source_repo))

        lease = await pm.acquire_worktree("cleanup-project", "main", worker_id="w1")
        worktree_path = lease.path

        await asyncio.sleep(0.1)

        cleaned = await pm.cleanup_expired_leases()

        assert cleaned == 1
        assert not worktree_path.exists()

    @pytest.mark.asyncio
    async def test_extend_lease(self, project_manager: ProjectManager, create_test_repo):
        """Test extending a lease."""
        source_repo = create_test_repo("extend-lease-project")
        await project_manager.ensure_project("extend-lease-project", str(source_repo))

        lease = await project_manager.acquire_worktree(
            "extend-lease-project",
            "main",
            worker_id="w1",
            duration=timedelta(minutes=1),
        )
        original_expires = lease.expires_at

        extended = await project_manager.extend_lease(
            lease.id,
            duration=timedelta(hours=2),
        )

        assert extended is not None
        assert extended.expires_at > original_expires


class TestWorktreeStatus:
    """Tests for worktree status reporting."""

    @pytest.mark.asyncio
    async def test_get_worktree_status(self, project_manager: ProjectManager, create_test_repo):
        """Test getting worktree status."""
        source_repo = create_test_repo("status-project")
        await project_manager.ensure_project("status-project", str(source_repo))

        lease = await project_manager.acquire_worktree("status-project", "main", worker_id="w1")

        status = await project_manager.get_worktree_status(lease)

        assert status["exists"] is True
        assert status["current_sha"] is not None
        assert status["has_changes"] is False
        assert status["current_branch"] == "main"
        assert not status["is_expired"]

    @pytest.mark.asyncio
    async def test_worktree_status_with_changes(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test status when worktree has uncommitted changes."""
        source_repo = create_test_repo("changes-project")
        await project_manager.ensure_project("changes-project", str(source_repo))

        lease = await project_manager.acquire_worktree("changes-project", "main", worker_id="w1")

        # Make a change
        (lease.path / "new_file.txt").write_text("new content")

        status = await project_manager.get_worktree_status(lease)
        assert status["has_changes"] is True


class TestPersistence:
    """Tests for state persistence with database."""

    @pytest.mark.asyncio
    async def test_persistence_with_store(
        self, project_manager_with_store: ProjectManager, create_test_repo
    ):
        """Test that state is persisted to database."""
        source_repo = create_test_repo("persist-project")
        await project_manager_with_store.ensure_project("persist-project", str(source_repo))

        lease = await project_manager_with_store.acquire_worktree(
            "persist-project", "main", worker_id="w1"
        )

        # Verify stored in database
        meta = await project_manager_with_store.store.get_project_metadata()
        pm_data = meta["metadata"].get("project_manager", {})

        assert "persist-project" in pm_data.get("projects", {})
        assert lease.id in pm_data.get("leases", {})

    @pytest.mark.asyncio
    async def test_reload_state_from_store(
        self, project_manager_dir: Path, tmp_path: Path, create_test_repo
    ):
        """Test reloading state from database after restart."""
        store = SyncStore(tmp_path / "reload_store.db")
        await store.initialize()

        # Create project with first manager
        pm1 = ProjectManager(project_manager_dir, store=store)
        await pm1.initialize()

        source_repo = create_test_repo("reload-project")
        await pm1.ensure_project("reload-project", str(source_repo))

        # Create second manager (simulates restart)
        pm2 = ProjectManager(project_manager_dir, store=store)
        await pm2.initialize()

        # Should see the project
        project = await pm2.get_project("reload-project")
        assert project is not None
        assert project.name == "reload-project"


class TestProjectSerialization:
    """Tests for Project and WorktreeLease serialization."""

    def test_project_to_dict(self, tmp_path: Path):
        """Test Project serialization."""
        from datetime import UTC, datetime

        project = Project(
            name="test-proj",
            git_url="https://github.com/test/repo.git",
            bare_path=tmp_path / "bare",
            created_at=datetime.now(UTC),
            last_fetch=datetime.now(UTC),
            default_branch="main",
            metadata={"key": "value"},
        )

        data = project.to_dict()
        assert data["name"] == "test-proj"
        assert data["git_url"] == "https://github.com/test/repo.git"
        assert data["metadata"]["key"] == "value"

        # Round-trip
        restored = Project.from_dict(data)
        assert restored.name == project.name
        assert restored.metadata == project.metadata

    def test_worktree_lease_to_dict(self, tmp_path: Path):
        """Test WorktreeLease serialization."""
        from datetime import UTC, datetime

        now = datetime.now(UTC)
        lease = WorktreeLease(
            id="abc123",
            project_name="test-proj",
            branch="feature/test",
            path=tmp_path / "worktree",
            worker_id="worker-1",
            acquired_at=now,
            expires_at=now + timedelta(hours=1),
            commit_sha="deadbeef",
            metadata={"job_id": "123"},
        )

        data = lease.to_dict()
        assert data["id"] == "abc123"
        assert data["branch"] == "feature/test"
        assert data["metadata"]["job_id"] == "123"

        # Round-trip
        restored = WorktreeLease.from_dict(data)
        assert restored.id == lease.id
        assert restored.branch == lease.branch


class TestConcurrentAccess:
    """Tests for concurrent access patterns."""

    @pytest.mark.asyncio
    async def test_concurrent_worktree_creation(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test creating worktrees concurrently."""
        source_repo = create_test_repo("concurrent-project", with_branches=True)
        await project_manager.ensure_project("concurrent-project", str(source_repo))

        async def acquire(worker_id: str, branch: str):
            return await project_manager.acquire_worktree(
                "concurrent-project", branch, worker_id=worker_id
            )

        leases = await asyncio.gather(
            acquire("w1", "main"),
            acquire("w2", "feature/test"),
            acquire("w3", "bugfix/issue-1"),
        )

        assert len(leases) == 3
        paths = {l.path for l in leases}
        assert len(paths) == 3  # All different paths

    @pytest.mark.asyncio
    async def test_concurrent_release(self, project_manager: ProjectManager, create_test_repo):
        """Test releasing worktrees concurrently."""
        source_repo = create_test_repo("release-concurrent", with_branches=True)
        await project_manager.ensure_project("release-concurrent", str(source_repo))

        leases = []
        for i, branch in enumerate(["main", "feature/test", "bugfix/issue-1"]):
            lease = await project_manager.acquire_worktree(
                "release-concurrent", branch, worker_id=f"w{i}"
            )
            leases.append(lease)

        await asyncio.gather(*[project_manager.release_worktree(l) for l in leases])

        remaining = await project_manager.list_leases()
        assert len(remaining) == 0


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    @pytest.mark.asyncio
    async def test_delete_project_with_active_leases(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test deleting project with active leases requires force."""
        source_repo = create_test_repo("active-lease-project")
        await project_manager.ensure_project("active-lease-project", str(source_repo))

        await project_manager.acquire_worktree("active-lease-project", "main", worker_id="w1")

        with pytest.raises(LeaseError) as exc_info:
            await project_manager.delete_project("active-lease-project")

        assert "active leases" in str(exc_info.value)

        # Force delete should work
        result = await project_manager.delete_project("active-lease-project", force=True)
        assert result is True

    @pytest.mark.asyncio
    async def test_release_already_released_lease(
        self, project_manager: ProjectManager, create_test_repo
    ):
        """Test releasing an already released lease is safe."""
        source_repo = create_test_repo("double-release")
        await project_manager.ensure_project("double-release", str(source_repo))

        lease = await project_manager.acquire_worktree("double-release", "main", worker_id="w1")

        await project_manager.release_worktree(lease)
        await project_manager.release_worktree(lease)  # Should not raise

    @pytest.mark.asyncio
    async def test_extend_nonexistent_lease(self, project_manager: ProjectManager):
        """Test extending a nonexistent lease returns None."""
        result = await project_manager.extend_lease("nonexistent-id")
        assert result is None
