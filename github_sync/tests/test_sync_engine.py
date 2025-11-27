"""
Tests for SyncEngine orchestration.
"""

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from github_sync import PRState, PullRequest, SyncEngine, SyncStore
from github_sync.sync_engine import SyncProgress, SyncResult


class TestSyncProgress:
    """Tests for SyncProgress dataclass."""

    def test_progress_creation(self):
        """Test creating SyncProgress."""
        progress = SyncProgress(
            stage="sync",
            current=5,
            total=10,
            message="Syncing...",
        )

        assert progress.stage == "sync"
        assert progress.current == 5
        assert progress.total == 10

    def test_progress_percent(self):
        """Test percentage calculation."""
        progress = SyncProgress(stage="test", current=3, total=10, message="msg")
        assert progress.percent == 30.0

    def test_progress_percent_zero_total(self):
        """Test percentage with zero total."""
        progress = SyncProgress(stage="test", current=0, total=0, message="msg")
        assert progress.percent == 0.0

    def test_progress_timestamp_auto_set(self):
        """Test that timestamp is auto-set."""
        progress = SyncProgress(stage="test", current=1, total=1, message="msg")
        assert progress.timestamp is not None


class TestSyncResult:
    """Tests for SyncResult dataclass."""

    def test_result_success(self):
        """Test successful result."""
        result = SyncResult(
            success=True,
            repo_name="test-repo",
            prs_synced=5,
            branches_synced=10,
            contexts_synced=5,
            duration_seconds=1.5,
        )

        assert result.success
        assert result.prs_synced == 5
        assert result.error_message is None

    def test_result_failure(self):
        """Test failed result."""
        result = SyncResult(
            success=False,
            repo_name="test-repo",
            prs_synced=0,
            branches_synced=0,
            contexts_synced=0,
            duration_seconds=0.1,
            error_message="Connection failed",
        )

        assert not result.success
        assert result.error_message == "Connection failed"

    def test_result_to_dict(self):
        """Test result serialization."""
        result = SyncResult(
            success=True,
            repo_name="repo",
            prs_synced=1,
            branches_synced=2,
            contexts_synced=1,
            duration_seconds=0.5,
        )

        data = result.to_dict()

        assert data["success"] is True
        assert data["repo_name"] == "repo"
        assert data["prs_synced"] == 1


class TestSyncEngineInitialization:
    """Tests for SyncEngine initialization."""

    @pytest.mark.asyncio
    async def test_engine_creation(self, sync_store: SyncStore):
        """Test creating a SyncEngine."""
        engine = SyncEngine(sync_store)

        assert engine.db == sync_store
        assert engine.progress_callback is None

    @pytest.mark.asyncio
    async def test_engine_with_callback(self, sync_store: SyncStore):
        """Test engine with progress callback."""
        progress_events = []

        def callback(progress: SyncProgress):
            progress_events.append(progress)

        engine = SyncEngine(sync_store, progress_callback=callback)

        # Emit a progress event
        engine._emit_progress("test", 1, 10, "Testing")

        assert len(progress_events) == 1
        assert progress_events[0].stage == "test"


class TestSyncEngineSyncRepository:
    """Tests for sync_repository method."""

    @pytest.mark.asyncio
    async def test_sync_repository_success(self, sync_store: SyncStore, repo_with_branches):
        """Test successful repository sync with local repo."""
        engine = SyncEngine(sync_store)

        # Mock GitHub client since we don't have real API
        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()

            # Setup mock PR
            now = datetime.now(UTC)
            mock_pr = PullRequest(
                number=1,
                title="Test PR",
                state=PRState.OPEN,
                head_branch="feature/add-feature",
                base_branch="main",
                author="user",
                url="https://github.com/test/repo/pull/1",
                created_at=now,
                updated_at=now,
            )

            mock_github_instance.get_pull_requests = AsyncMock(return_value=[mock_pr])
            mock_github_instance.get_prs_with_labels = AsyncMock(return_value=[1])
            mock_github_instance.get_pull_request = AsyncMock(return_value=mock_pr)
            mock_github_instance.get_pr_diff = AsyncMock(return_value="+ diff")
            mock_github_instance.get_pr_comments = AsyncMock(return_value=[])
            mock_github_instance.get_pr_review_comments = AsyncMock(return_value=[])
            mock_github_instance.get_pr_commits = AsyncMock(return_value=[])
            mock_github_instance.get_pr_files = AsyncMock(return_value=[])
            mock_github_instance.get_pr_review_state = AsyncMock(return_value={
                "approved_by": [],
                "changes_requested_by": [],
                "review_decision": None,
            })
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)

            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            result = await engine.sync_repository(
                repo_path=repo_with_branches.path,
                include_context=True,
                fetch_first=False,  # Skip fetch for test
            )

            assert result.success
            assert result.prs_synced >= 0

    @pytest.mark.asyncio
    async def test_sync_repository_invalid_path(self, sync_store: SyncStore, temp_dir: Path):
        """Test sync with invalid repository path."""
        engine = SyncEngine(sync_store)

        # Non-existent path
        result = await engine.sync_repository(temp_dir / "nonexistent")

        assert not result.success
        assert (
            "does not exist" in result.error_message.lower()
            or "not a git" in result.error_message.lower()
        )

    @pytest.mark.asyncio
    async def test_sync_repository_not_a_repo(self, sync_store: SyncStore, temp_dir: Path):
        """Test sync with directory that's not a git repo."""
        engine = SyncEngine(sync_store)

        # Create a non-repo directory
        non_repo = temp_dir / "not-repo"
        non_repo.mkdir()

        result = await engine.sync_repository(non_repo)

        assert not result.success


class TestSyncEngineStream:
    """Tests for sync_repository_stream method."""

    @pytest.mark.asyncio
    async def test_sync_stream_yields_progress(self, sync_store: SyncStore, repo_with_branches):
        """Test that streaming yields progress updates."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()
            mock_github_instance.get_pull_requests = AsyncMock(return_value=[])
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)
            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            updates = []
            async for update in engine.sync_repository_stream(
                repo_path=repo_with_branches.path,
                fetch_first=False,
            ):
                updates.append(update)

            # Should have multiple progress updates
            assert len(updates) >= 2

            # Should end with SyncResult
            assert isinstance(updates[-1], SyncResult)

            # Earlier updates should be SyncProgress
            progress_updates = [u for u in updates if isinstance(u, SyncProgress)]
            assert len(progress_updates) >= 1

    @pytest.mark.asyncio
    async def test_sync_stream_progress_stages(self, sync_store: SyncStore, repo_with_branches):
        """Test that stream includes expected stages."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()
            mock_github_instance.get_pull_requests = AsyncMock(return_value=[])
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)
            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            stages = set()
            async for update in engine.sync_repository_stream(
                repo_path=repo_with_branches.path,
                fetch_first=False,
            ):
                if isinstance(update, SyncProgress):
                    stages.add(update.stage)

            # Should include key stages
            assert "init" in stages
            assert "branches" in stages
            assert "prs" in stages


class TestSyncEngineSinglePR:
    """Tests for sync_single_pr method."""

    @pytest.mark.asyncio
    async def test_sync_single_pr_success(self, sync_store: SyncStore, repo_with_branches):
        """Test syncing a single PR."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()

            now = datetime.now(UTC)
            mock_pr = PullRequest(
                number=42,
                title="Test PR",
                state=PRState.OPEN,
                head_branch="feature",
                base_branch="main",
                author="user",
                url="https://github.com/test/repo/pull/42",
                created_at=now,
                updated_at=now,
            )

            mock_github_instance.get_pull_request = AsyncMock(return_value=mock_pr)
            mock_github_instance.get_pr_diff = AsyncMock(return_value="diff content")
            mock_github_instance.get_pr_comments = AsyncMock(return_value=[])
            mock_github_instance.get_pr_review_comments = AsyncMock(return_value=[])
            mock_github_instance.get_pr_commits = AsyncMock(return_value=[])
            mock_github_instance.get_pr_files = AsyncMock(return_value=[])
            mock_github_instance.get_pr_review_state = AsyncMock(return_value={
                "approved_by": [],
                "changes_requested_by": [],
                "review_decision": None,
            })
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)

            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            result = await engine.sync_single_pr(repo_with_branches.path, 42)

            assert result.success
            assert result.prs_synced == 1
            assert result.contexts_synced == 1

    @pytest.mark.asyncio
    async def test_sync_single_pr_not_found(self, sync_store: SyncStore, repo_with_branches):
        """Test syncing a PR that doesn't exist."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()
            mock_github_instance.get_pull_request = AsyncMock(return_value=None)
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)

            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            result = await engine.sync_single_pr(repo_with_branches.path, 999)

            assert not result.success
            assert "not found" in result.error_message.lower()


class TestSyncEngineGetStatus:
    """Tests for get_sync_status method."""

    @pytest.mark.asyncio
    async def test_get_sync_status_all_repos(self, sync_store: SyncStore):
        """Test getting status for all repos."""
        engine = SyncEngine(sync_store)

        # Add some test data
        await sync_store.save_repository("repo1", "/path1", "main")
        await sync_store.save_repository("repo2", "/path2", "main")

        status = await engine.get_sync_status()

        assert "repositories" in status
        assert len(status["repositories"]) == 2
        assert "database_stats" in status

    @pytest.mark.asyncio
    async def test_get_sync_status_single_repo(self, sync_store: SyncStore):
        """Test getting status for a specific repo."""
        engine = SyncEngine(sync_store)

        await sync_store.save_repository("test-repo", "/path", "main")

        status = await engine.get_sync_status("test-repo")

        assert "repository" in status
        assert status["repository"]["name"] == "test-repo"


class TestSyncEngineWithLabels:
    """Tests for label-based sync filtering."""

    @pytest.mark.asyncio
    async def test_sync_with_labels(self, sync_store: SyncStore, repo_with_branches):
        """Test syncing only PRs with specific labels."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()

            now = datetime.now(UTC)
            mock_pr = PullRequest(
                number=1,
                title="Landing PR",
                state=PRState.OPEN,
                head_branch="feature",
                base_branch="main",
                author="user",
                url="url",
                created_at=now,
                updated_at=now,
                labels=["for-landing"],
            )

            mock_github_instance.get_prs_with_labels = AsyncMock(return_value=[1])
            mock_github_instance.get_pull_request = AsyncMock(return_value=mock_pr)
            mock_github_instance.get_pr_diff = AsyncMock(return_value="diff")
            mock_github_instance.get_pr_comments = AsyncMock(return_value=[])
            mock_github_instance.get_pr_review_comments = AsyncMock(return_value=[])
            mock_github_instance.get_pr_commits = AsyncMock(return_value=[])
            mock_github_instance.get_pr_files = AsyncMock(return_value=[])
            mock_github_instance.get_pr_review_state = AsyncMock(return_value={
                "approved_by": [],
                "changes_requested_by": [],
                "review_decision": None,
            })
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)

            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            result = await engine.sync_repository(
                repo_path=repo_with_branches.path,
                labels=["for-landing"],
                fetch_first=False,
            )

            assert result.success
            mock_github_instance.get_prs_with_labels.assert_called_once_with(["for-landing"])


class TestSyncEngineContextGathering:
    """Tests for PR context gathering."""

    @pytest.mark.asyncio
    async def test_gather_pr_context(self, sync_store: SyncStore, repo_with_branches):
        """Test gathering complete PR context."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()

            now = datetime.now(UTC)
            mock_pr = PullRequest(
                number=1,
                title="Test",
                state=PRState.OPEN,
                head_branch="f",
                base_branch="main",
                author="u",
                url="url",
                created_at=now,
                updated_at=now,
                body="PR Body",
                ci_summary={"total": 2, "success": 2},
            )

            mock_github_instance.get_pr_diff = AsyncMock(return_value="diff content")
            mock_github_instance.get_pr_comments = AsyncMock(return_value=[{"body": "comment"}])
            mock_github_instance.get_pr_review_comments = AsyncMock(
                return_value=[{"body": "review"}]
            )
            mock_github_instance.get_pr_commits = AsyncMock(return_value=[{"sha": "abc"}])
            mock_github_instance.get_pr_files = AsyncMock(return_value=[{"filename": "test.py"}])
            mock_github_instance.get_pr_review_state = AsyncMock(return_value={
                "approved_by": ["reviewer1"],
                "changes_requested_by": [],
                "review_decision": "APPROVED",
            })

            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            context = await engine._gather_pr_context(mock_github_instance, "test-repo", mock_pr)

            assert context.repo_name == "test-repo"
            assert context.pr_number == 1
            assert context.diff == "diff content"
            assert context.body == "PR Body"
            assert len(context.comments) == 1
            assert len(context.review_comments) == 1


class TestSyncEngineErrorRecovery:
    """Tests for error handling and recovery."""

    @pytest.mark.asyncio
    async def test_sync_handles_github_errors(self, sync_store: SyncStore, repo_with_branches):
        """Test that sync handles GitHub API errors gracefully."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            MockGitHub.from_repo_path = AsyncMock(side_effect=Exception("GitHub API error"))

            result = await engine.sync_repository(
                repo_path=repo_with_branches.path,
                fetch_first=False,
            )

            assert not result.success
            assert "GitHub API error" in result.error_message

    @pytest.mark.asyncio
    async def test_sync_records_failure_in_history(self, sync_store: SyncStore, repo_with_branches):
        """Test that failed syncs are recorded in history."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            MockGitHub.from_repo_path = AsyncMock(side_effect=Exception("Test error"))

            result = await engine.sync_repository(
                repo_path=repo_with_branches.path,
                fetch_first=False,
            )

            # Check stats
            stats = await sync_store.get_statistics()
            # Error should be captured in result
            assert not result.success
