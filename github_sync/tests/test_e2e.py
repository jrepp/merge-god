"""
End-to-end integration tests for the github_sync library.

These tests verify the complete workflow of the library without
requiring Docker (those are in test_gitea_integration.py).
"""

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from github_sync import (
    ActionRegistry,
    ArtifactFormat,
    CICheck,
    CIStatus,
    GetRepository,
    GetStatistics,
    ListActivePRs,
    PRContext,
    PRState,
    PullRequest,
    SavePRSnapshot,
    SaveRepository,
    SyncEngine,
    SyncStore,
    export_database,
    import_database,
)
from github_sync.sync_engine import SyncProgress, SyncResult


class TestFullSyncWorkflow:
    """Tests for the complete sync workflow."""

    @pytest.mark.asyncio
    async def test_complete_sync_to_export_workflow(
        self, sync_store: SyncStore, temp_dir: Path, repo_with_branches
    ):
        """Test the full flow: sync repository -> store data -> export artifact."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()

            now = datetime.now(UTC)
            mock_pr1 = PullRequest(
                number=1,
                title="Feature: Add authentication",
                state=PRState.OPEN,
                head_branch="feature/auth",
                base_branch="main",
                author="developer1",
                url="https://github.com/test/repo/pull/1",
                created_at=now,
                updated_at=now,
                labels=["enhancement", "for-review"],
                ci_checks=[
                    CICheck(name="build", status=CIStatus.SUCCESS),
                    CICheck(name="test", status=CIStatus.SUCCESS),
                ],
            )
            mock_pr2 = PullRequest(
                number=2,
                title="Fix: Resolve login bug",
                state=PRState.OPEN,
                head_branch="fix/login",
                base_branch="main",
                author="developer2",
                url="https://github.com/test/repo/pull/2",
                created_at=now,
                updated_at=now,
                labels=["bug", "for-landing"],
                ci_checks=[
                    CICheck(name="build", status=CIStatus.SUCCESS),
                    CICheck(name="test", status=CIStatus.PENDING),
                ],
            )

            mock_github_instance.get_pull_requests = AsyncMock(return_value=[mock_pr1, mock_pr2])
            mock_github_instance.get_prs_with_labels = AsyncMock(return_value=[1, 2])
            mock_github_instance.get_pull_request = AsyncMock(
                side_effect=lambda n: mock_pr1 if n == 1 else mock_pr2
            )
            mock_github_instance.get_pr_diff = AsyncMock(return_value="+ new code\n- old code")
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

            # Step 1: Sync the repository
            result = await engine.sync_repository(
                repo_path=repo_with_branches.path,
                include_context=True,
                fetch_first=False,
            )

            assert result.success
            assert result.prs_synced >= 0

        # Step 2: Verify data is stored
        stats = await sync_store.get_statistics()
        assert stats["repositories"] >= 1

        # Step 3: Export to artifact
        export_path = temp_dir / "full_export.json.gz"
        export_result = await export_database(
            sync_store,
            export_path,
            format=ArtifactFormat.JSON_GZ,
            include_contexts=True,
        )

        assert export_path.exists()
        assert export_result["file_size_bytes"] > 0

        # Step 4: Import into new database
        new_store = SyncStore(temp_dir / "imported.db")
        import_result = await import_database(new_store, export_path)

        assert import_result["errors"] == 0

        # Verify imported data matches
        new_stats = await new_store.get_statistics()
        assert new_stats["repositories"] == stats["repositories"]


class TestActionWorkflow:
    """Tests for the action-based workflow."""

    @pytest.mark.asyncio
    async def test_action_registry_full_workflow(self, sync_store: SyncStore):
        """Test using the action registry for a complete workflow."""
        registry = ActionRegistry(sync_store)

        # Step 1: Save repository
        save_result = await registry.execute(
            SaveRepository(
                repo_name="test-repo",
                repo_path="/path/to/repo",
                default_branch="main",
            )
        )
        assert save_result.success

        # Step 2: Save multiple PRs
        for i in range(3):
            pr_result = await registry.execute(
                SavePRSnapshot(
                    repo_name="test-repo",
                    pr_number=i + 1,
                    title=f"PR {i + 1}: Feature implementation",
                    state="open" if i < 2 else "merged",
                    head_branch=f"feature-{i + 1}",
                    base_branch="main",
                    author=f"developer{i + 1}",
                    labels=["enhancement"] if i == 0 else ["bug"],
                )
            )
            assert pr_result.success

        # Step 3: Query data
        repo_result = await registry.execute(GetRepository(repo_name="test-repo"))
        assert repo_result.success
        assert repo_result.data["result"]["name"] == "test-repo"

        active_prs_result = await registry.execute(ListActivePRs(repo_name="test-repo"))
        assert active_prs_result.success
        assert len(active_prs_result.data["result"]) == 2  # 2 open PRs

        # Step 4: Get statistics
        stats_result = await registry.execute(GetStatistics())
        assert stats_result.success
        assert stats_result.data["result"]["repositories"] == 1
        assert stats_result.data["result"]["pr_snapshots"] == 3


class TestStreamingSyncWorkflow:
    """Tests for streaming sync workflow."""

    @pytest.mark.asyncio
    async def test_streaming_sync_with_progress(self, sync_store: SyncStore, repo_with_branches):
        """Test that streaming sync yields proper progress updates."""
        engine = SyncEngine(sync_store)
        progress_updates = []
        final_result = None

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            mock_github_instance = AsyncMock()
            mock_github_instance.get_pull_requests = AsyncMock(return_value=[])
            mock_github_instance.__aenter__ = AsyncMock(return_value=mock_github_instance)
            mock_github_instance.__aexit__ = AsyncMock(return_value=None)

            MockGitHub.from_repo_path = AsyncMock(return_value=mock_github_instance)

            async for update in engine.sync_repository_stream(
                repo_path=repo_with_branches.path,
                fetch_first=False,
            ):
                if isinstance(update, SyncProgress):
                    progress_updates.append(update)
                elif isinstance(update, SyncResult):
                    final_result = update

        # Verify progress was reported
        assert len(progress_updates) >= 1
        assert final_result is not None
        assert final_result.success

        # Verify progress stages
        stages = {p.stage for p in progress_updates}
        assert "init" in stages


class TestExportImportFormats:
    """Tests for different export/import format workflows."""

    @pytest.mark.asyncio
    async def test_json_format_roundtrip(self, sync_store: SyncStore, temp_dir: Path):
        """Test export/import with plain JSON format."""
        await self._test_format_roundtrip(sync_store, temp_dir, ArtifactFormat.JSON, "export.json")

    @pytest.mark.asyncio
    async def test_json_gz_format_roundtrip(self, sync_store: SyncStore, temp_dir: Path):
        """Test export/import with compressed JSON format."""
        await self._test_format_roundtrip(
            sync_store, temp_dir, ArtifactFormat.JSON_GZ, "export.json.gz"
        )

    @pytest.mark.asyncio
    async def test_jsonl_format_roundtrip(self, sync_store: SyncStore, temp_dir: Path):
        """Test export/import with JSONL format."""
        await self._test_format_roundtrip(
            sync_store, temp_dir, ArtifactFormat.JSONL, "export.jsonl"
        )

    @pytest.mark.asyncio
    async def test_jsonl_gz_format_roundtrip(self, sync_store: SyncStore, temp_dir: Path):
        """Test export/import with compressed JSONL format."""
        await self._test_format_roundtrip(
            sync_store, temp_dir, ArtifactFormat.JSONL_GZ, "export.jsonl.gz"
        )

    async def _test_format_roundtrip(
        self,
        sync_store: SyncStore,
        temp_dir: Path,
        format: ArtifactFormat,
        filename: str,
    ):
        """Helper to test format roundtrip."""
        # Setup test data
        await sync_store.save_repository("roundtrip-repo", "/path", "main")
        await sync_store.save_pr_snapshot(
            "roundtrip-repo",
            {
                "number": 1,
                "title": "Roundtrip Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "labels": ["test", "roundtrip"],
            },
        )

        context = PRContext(
            repo_name="roundtrip-repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ added\n- removed",
            body="Test body",
            comments=[{"author": "tester", "body": "LGTM"}],
        )
        await sync_store.save_pr_context(context)

        # Export
        export_path = temp_dir / filename
        await export_database(sync_store, export_path, format=format, include_contexts=True)

        assert export_path.exists()

        # Import into new store
        new_store = SyncStore(temp_dir / f"imported_{filename.replace('.', '_')}.db")
        result = await import_database(new_store, export_path)

        # Verify
        assert result["repositories_imported"] == 1
        assert result["pull_requests_imported"] == 1
        assert result["pr_contexts_imported"] == 1
        assert result["errors"] == 0

        # Verify data integrity
        repo = await new_store.get_repository("roundtrip-repo")
        assert repo is not None
        assert repo["path"] == "/path"

        pr = await new_store.get_latest_pr_snapshot("roundtrip-repo", 1)
        assert pr is not None
        assert pr["title"] == "Roundtrip Test PR"
        assert "test" in pr["labels"]

        ctx = await new_store.get_latest_pr_context("roundtrip-repo", 1)
        assert ctx is not None
        assert ctx.diff == "+ added\n- removed"


class TestPRContextWorkflow:
    """Tests for PR context-specific workflows."""

    @pytest.mark.asyncio
    async def test_context_lifecycle(self, sync_store: SyncStore):
        """Test complete lifecycle of PR context data."""
        # Save multiple context snapshots for different PRs
        for i in range(3):
            context = PRContext(
                repo_name="ctx-repo",
                pr_number=i + 1,  # Different PR numbers
                pr_url=f"https://github.com/test/repo/pull/{i + 1}",
                diff=f"+ version {i + 1}",
                body=f"Body version {i + 1}",
                comments=[{"author": "reviewer", "body": f"Review {i + 1}"}],
                captured_at=datetime.now(UTC),
            )
            await sync_store.save_pr_context(context)

        # Get latest context for a specific PR
        latest = await sync_store.get_latest_pr_context("ctx-repo", 3)
        assert latest is not None
        assert "version 3" in latest.diff

        # Get all contexts (returns latest per PR)
        all_contexts = await sync_store.get_all_pr_contexts("ctx-repo")
        assert len(all_contexts) == 3  # One per PR

    @pytest.mark.asyncio
    async def test_context_with_large_diff(self, sync_store: SyncStore):
        """Test context handling with realistically large diff."""
        # Simulate a large diff (but below truncation limit)
        large_diff = "\n".join([f"+ line {i}" for i in range(10000)])

        context = PRContext(
            repo_name="large-diff-repo",
            pr_number=1,
            pr_url="url",
            diff=large_diff,
            body="Large diff PR",
        )
        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("large-diff-repo", 1)
        assert loaded is not None
        assert "line 9999" in loaded.diff


class TestErrorHandlingWorkflows:
    """Tests for error handling in various workflows."""

    @pytest.mark.asyncio
    async def test_sync_handles_api_failures(self, sync_store: SyncStore, repo_with_branches):
        """Test that sync gracefully handles API failures."""
        engine = SyncEngine(sync_store)

        with patch("github_sync.sync_engine.GitHubClient") as MockGitHub:
            MockGitHub.from_repo_path = AsyncMock(
                side_effect=Exception("Network error: Connection refused")
            )

            result = await engine.sync_repository(
                repo_path=repo_with_branches.path,
                fetch_first=False,
            )

            assert not result.success
            assert "Network error" in result.error_message

    @pytest.mark.asyncio
    async def test_import_invalid_file_fails_gracefully(
        self, sync_store: SyncStore, temp_dir: Path
    ):
        """Test that importing invalid file produces clear error."""
        # Create invalid JSON file
        invalid_file = temp_dir / "invalid.json"
        invalid_file.write_text("not valid json {{{")

        with pytest.raises(Exception):
            await import_database(sync_store, invalid_file)

    @pytest.mark.asyncio
    async def test_export_to_readonly_fails_gracefully(self, sync_store: SyncStore, temp_dir: Path):
        """Test export error handling for permission issues."""
        # This test is platform-dependent, skip if we can't make readonly
        readonly_dir = temp_dir / "readonly"
        readonly_dir.mkdir()

        try:
            readonly_dir.chmod(0o444)
            export_path = readonly_dir / "export.json"

            with pytest.raises(Exception):
                await export_database(sync_store, export_path)
        finally:
            readonly_dir.chmod(0o755)


class TestMultiRepoWorkflow:
    """Tests for multi-repository workflows."""

    @pytest.mark.asyncio
    async def test_manage_multiple_repositories(self, sync_store: SyncStore):
        """Test managing multiple repositories simultaneously."""
        repos = ["frontend", "backend", "shared-lib", "docs"]

        # Setup multiple repos
        for repo in repos:
            await sync_store.save_repository(repo, f"/path/to/{repo}", "main")

            # Add PRs to each repo
            for pr_num in range(1, 4):
                await sync_store.save_pr_snapshot(
                    repo,
                    {
                        "number": pr_num,
                        "title": f"{repo} PR #{pr_num}",
                        "state": "open" if pr_num < 3 else "closed",
                        "head_branch": f"feature-{pr_num}",
                        "base_branch": "main",
                    },
                )

        # Verify all repos stored
        all_repos = await sync_store.get_all_repositories()
        assert len(all_repos) == 4

        # Verify PRs per repo
        for repo in repos:
            prs = await sync_store.get_all_prs(repo)
            assert len(prs) == 3

            active = await sync_store.get_active_prs(repo)
            assert len(active) == 2  # 2 open PRs

        # Verify total statistics
        stats = await sync_store.get_statistics()
        assert stats["repositories"] == 4
        assert stats["pr_snapshots"] == 12  # 4 repos * 3 PRs

    @pytest.mark.asyncio
    async def test_export_single_repo_from_multi(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting only one repo from a multi-repo database."""
        # Setup multiple repos
        for repo in ["repo-a", "repo-b", "repo-c"]:
            await sync_store.save_repository(repo, f"/path/{repo}", "main")
            await sync_store.save_pr_snapshot(
                repo,
                {
                    "number": 1,
                    "title": f"PR in {repo}",
                    "state": "open",
                    "head_branch": "feature",
                    "base_branch": "main",
                },
            )

        # Export only repo-b
        export_path = temp_dir / "single_repo.json"
        result = await export_database(
            sync_store,
            export_path,
            format=ArtifactFormat.JSON,
            repo_filter="repo-b",
        )

        assert result["repositories"] == 1
        assert result["pull_requests"] == 1

        # Import and verify only repo-b data
        new_store = SyncStore(temp_dir / "filtered.db")
        await import_database(new_store, export_path)

        repos = await new_store.get_all_repositories()
        assert len(repos) == 1
        assert repos[0]["name"] == "repo-b"


class TestCIStatusWorkflow:
    """Tests for CI status tracking workflows."""

    @pytest.mark.asyncio
    async def test_track_ci_status_changes(self, sync_store: SyncStore):
        """Test tracking CI status changes over time."""
        # Initial PR with pending CI
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "CI Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "ci_status": "pending",
            },
        )

        # CI passes
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "CI Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "ci_status": "success",
            },
        )

        # New commit, CI pending again
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "CI Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "ci_status": "pending",
            },
        )

        # CI fails
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "CI Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "ci_status": "failure",
            },
        )

        # Verify latest status
        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr["ci_status"] == "failure"

        # All snapshots should be preserved
        stats = await sync_store.get_statistics()
        assert stats["pr_snapshots"] == 4
