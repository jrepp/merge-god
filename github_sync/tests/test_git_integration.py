"""
Integration tests using local git repositories.

These tests don't require Gitea and test the git client against real git repos.
"""

from pathlib import Path

import pytest

from github_sync import BranchStatus, GitClient


class TestGitClientWithEmptyRepo:
    """Tests against an empty git repository."""

    @pytest.mark.asyncio
    async def test_validate_repo(self, empty_repo):
        """Test validating a git repository."""
        client = GitClient(empty_repo.path)
        await client.validate_repo()  # Should not raise

    @pytest.mark.asyncio
    async def test_validate_invalid_path(self, temp_dir: Path):
        """Test validation fails for non-repo directory."""
        non_repo = temp_dir / "not-a-repo"
        non_repo.mkdir()

        client = GitClient(non_repo)
        with pytest.raises(Exception) as exc_info:
            await client.validate_repo()
        assert "Not a git repository" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_default_branch(self, empty_repo):
        """Test detecting default branch."""
        client = GitClient(empty_repo.path)
        await client.validate_repo()

        # In a new repo without remote, should return fallback
        branch = await client.get_default_branch()
        assert branch in ["main", "master", "develop"]

    @pytest.mark.asyncio
    async def test_get_current_branch(self, empty_repo):
        """Test getting current branch."""
        client = GitClient(empty_repo.path)
        branch = await client.get_current_branch()
        assert branch in ["main", "master"]

    @pytest.mark.asyncio
    async def test_get_local_branches(self, empty_repo):
        """Test listing local branches."""
        client = GitClient(empty_repo.path)
        branches = await client.get_local_branches()

        assert len(branches) >= 1
        branch_names = [b.name for b in branches]
        assert any(name in branch_names for name in ["main", "master"])


class TestGitClientWithBranches:
    """Tests against a repository with multiple branches."""

    @pytest.mark.asyncio
    async def test_get_local_branches_multiple(self, repo_with_branches):
        """Test listing multiple local branches."""
        client = GitClient(repo_with_branches.path)
        branches = await client.get_local_branches()

        branch_names = {b.name for b in branches}
        assert "feature/add-feature" in branch_names
        assert "bugfix/fix-issue" in branch_names

    @pytest.mark.asyncio
    async def test_branch_metadata(self, repo_with_branches):
        """Test that branch metadata is populated."""
        client = GitClient(repo_with_branches.path)
        branches = await client.get_local_branches()

        for branch in branches:
            assert branch.sha  # Should have commit SHA
            assert branch.is_local
            assert not branch.is_remote
            assert branch.last_commit_message


class TestGitClientWithHistory:
    """Tests against a repository with commit history."""

    @pytest.mark.asyncio
    async def test_repository_info(self, repo_with_history):
        """Test getting repository information."""
        client = GitClient(repo_with_history.path)
        info = await client.get_repository_info()

        assert info["path"] == str(repo_with_history.path)
        assert "default_branch" in info
        assert "current_branch" in info


class TestGitClientWithRemote:
    """Tests against a repository with a remote (simulated)."""

    @pytest.mark.asyncio
    async def test_branch_ahead_status(self, repo_ahead_behind):
        """Test detecting branch ahead of remote."""
        client = GitClient(repo_ahead_behind.path)
        local_branches, remote_branches = await client.get_all_branches_with_status()

        # Find main branch
        main_branch = next((b for b in local_branches if b.name in ["main", "master"]), None)

        assert main_branch is not None
        assert main_branch.status == BranchStatus.AHEAD
        assert main_branch.ahead_by >= 1

    @pytest.mark.asyncio
    async def test_get_remote_branches(self, repo_ahead_behind):
        """Test listing remote branches."""
        client = GitClient(repo_ahead_behind.path)
        remote_branches = await client.get_remote_branches()

        assert len(remote_branches) >= 1
        for branch in remote_branches:
            assert branch.is_remote
            assert not branch.is_local


class TestGitClientConflicts:
    """Tests against a repository with potential conflicts."""

    @pytest.mark.asyncio
    async def test_list_conflict_branches(self, repo_with_conflicts):
        """Test listing branches that could conflict."""
        client = GitClient(repo_with_conflicts.path)
        branches = await client.get_local_branches()

        branch_names = {b.name for b in branches}
        assert "branch-a" in branch_names
        assert "branch-b" in branch_names


class TestGitClientConcurrency:
    """Tests for concurrent operations."""

    @pytest.mark.asyncio
    async def test_concurrent_branch_listing(self, repo_with_branches):
        """Test that concurrent operations work correctly."""
        import asyncio

        client = GitClient(repo_with_branches.path)

        # Run multiple operations concurrently
        results = await asyncio.gather(
            client.get_local_branches(),
            client.get_current_branch(),
            client.get_default_branch(),
            client.get_repository_info(),
        )

        branches, current, default, info = results

        assert len(branches) > 0
        assert current is not None
        assert default is not None
        assert "path" in info
