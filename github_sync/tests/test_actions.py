"""
Tests for the action system.
"""

from datetime import UTC, datetime

import pytest

from github_sync import (  # Maintenance actions; Sync actions; Context actions; PR actions; Repository actions
    ActionRegistry,
    ActionStatus,
    CleanupOldSnapshots,
    GetPRContext,
    GetPRSnapshot,
    GetRepository,
    GetSchemaInfo,
    GetStatistics,
    ListActivePRs,
    ListRepositories,
    PRContext,
    RecordSyncComplete,
    RecordSyncStart,
    SavePRContext,
    SavePRSnapshot,
    SaveRepository,
    SyncStore,
)


class TestActionExecution:
    """Tests for basic action execution."""

    @pytest.mark.asyncio
    async def test_save_repository_action(self, sync_store: SyncStore):
        """Test SaveRepository action."""
        registry = ActionRegistry(sync_store)

        action = SaveRepository(
            repo_name="test-repo",
            repo_path="/path/to/repo",
            default_branch="main",
        )

        result = await registry.execute(action)

        assert result.success
        assert result.action_name == "save_repository"
        assert result.duration_ms is not None
        assert result.duration_ms >= 0

    @pytest.mark.asyncio
    async def test_get_repository_action(self, sync_store: SyncStore):
        """Test GetRepository action."""
        registry = ActionRegistry(sync_store)

        # First save
        await registry.execute(
            SaveRepository(
                repo_name="test-repo",
                repo_path="/path",
                default_branch="main",
            )
        )

        # Then get
        action = GetRepository(repo_name="test-repo")
        result = await registry.execute(action)

        assert result.success
        assert result.data["result"]["name"] == "test-repo"

    @pytest.mark.asyncio
    async def test_list_repositories_action(self, sync_store: SyncStore):
        """Test ListRepositories action."""
        registry = ActionRegistry(sync_store)

        # Save multiple repos
        for i in range(3):
            await registry.execute(
                SaveRepository(
                    repo_name=f"repo-{i}",
                    repo_path=f"/path/{i}",
                )
            )

        result = await registry.execute(ListRepositories())

        assert result.success
        assert len(result.data["result"]) == 3


class TestPRActions:
    """Tests for PR-related actions."""

    @pytest.mark.asyncio
    async def test_save_pr_snapshot_action(self, sync_store: SyncStore):
        """Test SavePRSnapshot action."""
        registry = ActionRegistry(sync_store)

        action = SavePRSnapshot(
            repo_name="test-repo",
            pr_number=123,
            title="Test PR",
            head_branch="feature/test",
            base_branch="main",
            state="open",
            labels=["bug", "priority"],
        )

        result = await registry.execute(action)
        assert result.success

        # Verify saved
        get_result = await registry.execute(
            GetPRSnapshot(
                repo_name="test-repo",
                pr_number=123,
            )
        )
        assert get_result.success
        assert get_result.data["result"]["title"] == "Test PR"

    @pytest.mark.asyncio
    async def test_list_active_prs_action(self, sync_store: SyncStore):
        """Test ListActivePRs action."""
        registry = ActionRegistry(sync_store)

        # Save open and closed PRs
        await registry.execute(
            SavePRSnapshot(
                repo_name="test-repo",
                pr_number=1,
                title="Open PR",
                head_branch="feature-1",
                base_branch="main",
                state="open",
            )
        )
        await registry.execute(
            SavePRSnapshot(
                repo_name="test-repo",
                pr_number=2,
                title="Closed PR",
                head_branch="feature-2",
                base_branch="main",
                state="closed",
            )
        )

        result = await registry.execute(ListActivePRs(repo_name="test-repo"))

        assert result.success
        assert len(result.data["result"]) == 1


class TestContextActions:
    """Tests for PR context actions."""

    @pytest.mark.asyncio
    async def test_save_and_get_context(self, sync_store: SyncStore):
        """Test SavePRContext and GetPRContext actions."""
        registry = ActionRegistry(sync_store)

        context = PRContext(
            repo_name="test-repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ new line",
            body="Description",
            captured_at=datetime.now(UTC),
        )

        save_result = await registry.execute(SavePRContext(context=context))
        assert save_result.success

        get_result = await registry.execute(
            GetPRContext(
                repo_name="test-repo",
                pr_number=1,
            )
        )
        assert get_result.success
        assert get_result.data["result"].diff == "+ new line"


class TestActionValidation:
    """Tests for action validation."""

    @pytest.mark.asyncio
    async def test_validation_failure(self, sync_store: SyncStore):
        """Test that validation errors prevent execution."""
        registry = ActionRegistry(sync_store)

        # Empty repo name should fail validation
        action = SaveRepository(
            repo_name="",
            repo_path="/path",
        )

        result = await registry.execute(action)

        assert not result.success
        assert result.status == ActionStatus.FAILED
        assert "repo_name is required" in result.error

    @pytest.mark.asyncio
    async def test_pr_validation(self, sync_store: SyncStore):
        """Test PR snapshot validation."""
        registry = ActionRegistry(sync_store)

        action = SavePRSnapshot(
            repo_name="",
            pr_number=0,
            title="",
            head_branch="feature",
            base_branch="main",
        )

        result = await registry.execute(action)

        assert not result.success
        assert "repo_name is required" in result.error


class TestActionHooks:
    """Tests for action hooks."""

    @pytest.mark.asyncio
    async def test_before_hook(self, sync_store: SyncStore):
        """Test that before hooks are called."""
        registry = ActionRegistry(sync_store)

        hook_called = []

        async def before_hook(action):
            hook_called.append(action.name)

        registry.add_before_hook(before_hook)

        await registry.execute(
            SaveRepository(
                repo_name="test",
                repo_path="/path",
            )
        )

        assert hook_called == ["save_repository"]

    @pytest.mark.asyncio
    async def test_after_hook(self, sync_store: SyncStore):
        """Test that after hooks are called."""
        registry = ActionRegistry(sync_store)

        results_captured = []

        async def after_hook(action, result):
            results_captured.append((action.name, result.success))

        registry.add_after_hook(after_hook)

        await registry.execute(
            SaveRepository(
                repo_name="test",
                repo_path="/path",
            )
        )

        assert results_captured == [("save_repository", True)]

    @pytest.mark.asyncio
    async def test_after_hook_on_failure(self, sync_store: SyncStore):
        """Test that after hooks are called even on failure."""
        registry = ActionRegistry(sync_store)

        results_captured = []

        async def after_hook(action, result):
            results_captured.append((action.name, result.success))

        registry.add_after_hook(after_hook)

        # Invalid action should fail but still trigger hook
        await registry.execute(
            SaveRepository(
                repo_name="",
                repo_path="/path",
            )
        )

        assert results_captured == [("save_repository", False)]


class TestActionBatching:
    """Tests for executing multiple actions."""

    @pytest.mark.asyncio
    async def test_execute_many_stops_on_failure(self, sync_store: SyncStore):
        """Test that execute_many stops on first failure."""
        registry = ActionRegistry(sync_store)

        actions = [
            SaveRepository(repo_name="repo-1", repo_path="/path1"),
            SaveRepository(repo_name="", repo_path="/path2"),  # Will fail
            SaveRepository(repo_name="repo-3", repo_path="/path3"),
        ]

        results = await registry.execute_many(actions)

        assert len(results) == 2  # Stopped after failure
        assert results[0].success
        assert not results[1].success

    @pytest.mark.asyncio
    async def test_execute_all_continues_on_failure(self, sync_store: SyncStore):
        """Test that execute_all continues even on failure."""
        registry = ActionRegistry(sync_store)

        actions = [
            SaveRepository(repo_name="repo-1", repo_path="/path1"),
            SaveRepository(repo_name="", repo_path="/path2"),  # Will fail
            SaveRepository(repo_name="repo-3", repo_path="/path3"),
        ]

        results = await registry.execute_all(actions)

        assert len(results) == 3
        assert results[0].success
        assert not results[1].success
        assert results[2].success


class TestMaintenanceActions:
    """Tests for maintenance actions."""

    @pytest.mark.asyncio
    async def test_get_statistics_action(self, sync_store: SyncStore):
        """Test GetStatistics action."""
        registry = ActionRegistry(sync_store)

        result = await registry.execute(GetStatistics())

        assert result.success
        stats = result.data["result"]
        assert "repositories" in stats
        assert "schema_version" in stats

    @pytest.mark.asyncio
    async def test_get_schema_info_action(self, sync_store: SyncStore):
        """Test GetSchemaInfo action."""
        registry = ActionRegistry(sync_store)

        result = await registry.execute(GetSchemaInfo())

        assert result.success
        info = result.data["result"]
        assert "current_version" in info
        assert "needs_migration" in info

    @pytest.mark.asyncio
    async def test_cleanup_action(self, sync_store: SyncStore):
        """Test CleanupOldSnapshots action."""
        registry = ActionRegistry(sync_store)

        result = await registry.execute(CleanupOldSnapshots(days=30))

        assert result.success
        assert isinstance(result.data["result"], int)


class TestSyncHistoryActions:
    """Tests for sync history tracking actions."""

    @pytest.mark.asyncio
    async def test_sync_lifecycle_actions(self, sync_store: SyncStore):
        """Test RecordSyncStart and RecordSyncComplete actions."""
        registry = ActionRegistry(sync_store)

        # Start sync
        start_result = await registry.execute(
            RecordSyncStart(
                repo_name="test-repo",
                sync_type="full",
            )
        )

        assert start_result.success
        record_id = start_result.data["result"]
        assert record_id > 0

        # Complete sync
        complete_result = await registry.execute(
            RecordSyncComplete(
                record_id=record_id,
                success=True,
                prs_synced=5,
                branches_synced=10,
            )
        )

        assert complete_result.success


class TestActionResult:
    """Tests for ActionResult behavior."""

    @pytest.mark.asyncio
    async def test_result_to_dict(self, sync_store: SyncStore):
        """Test ActionResult serialization."""
        registry = ActionRegistry(sync_store)

        result = await registry.execute(GetStatistics())
        result_dict = result.to_dict()

        assert "status" in result_dict
        assert "action_name" in result_dict
        assert "started_at" in result_dict
        assert "duration_ms" in result_dict
