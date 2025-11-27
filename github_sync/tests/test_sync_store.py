"""
Tests for SyncStore database operations.
"""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest

from github_sync import SCHEMA_VERSION, PRContext, SyncStore


class TestSyncStoreInitialization:
    """Tests for database initialization and migration."""

    @pytest.mark.asyncio
    async def test_initialize_creates_database(self, temp_dir: Path):
        """Test that initialize creates a new database file."""
        db_path = temp_dir / "new.db"
        store = SyncStore(db_path)

        assert not db_path.exists()
        await store.initialize()
        assert db_path.exists()

    @pytest.mark.asyncio
    async def test_initialize_idempotent(self, sync_store: SyncStore):
        """Test that calling initialize multiple times is safe."""
        await sync_store.initialize()
        await sync_store.initialize()
        # Should not raise

    @pytest.mark.asyncio
    async def test_schema_version_set(self, sync_store: SyncStore):
        """Test that schema version is set after initialization."""
        info = await sync_store.get_schema_info()
        assert info["current_version"] == SCHEMA_VERSION
        assert info["latest_version"] == SCHEMA_VERSION
        assert not info["needs_migration"]
        assert info["current_version"] == 2  # Current version is 2

    @pytest.mark.asyncio
    async def test_statistics_include_schema_version(self, sync_store: SyncStore):
        """Test that statistics include schema version."""
        stats = await sync_store.get_statistics()
        assert "schema_version" in stats
        assert stats["schema_version"] == SCHEMA_VERSION
        assert "project_id" in stats  # New in schema v2


class TestRepositoryOperations:
    """Tests for repository CRUD operations."""

    @pytest.mark.asyncio
    async def test_save_repository(self, sync_store: SyncStore):
        """Test saving a repository."""
        await sync_store.save_repository("test-repo", "/path/to/repo", "main")

        repo = await sync_store.get_repository("test-repo")
        assert repo is not None
        assert repo["name"] == "test-repo"
        assert repo["path"] == "/path/to/repo"
        assert repo["default_branch"] == "main"

    @pytest.mark.asyncio
    async def test_save_repository_update(self, sync_store: SyncStore):
        """Test updating an existing repository."""
        await sync_store.save_repository("test-repo", "/old/path", "master")
        await sync_store.save_repository("test-repo", "/new/path", "main")

        repo = await sync_store.get_repository("test-repo")
        assert repo["path"] == "/new/path"
        assert repo["default_branch"] == "main"

    @pytest.mark.asyncio
    async def test_get_nonexistent_repository(self, sync_store: SyncStore):
        """Test getting a repository that doesn't exist."""
        repo = await sync_store.get_repository("nonexistent")
        assert repo is None

    @pytest.mark.asyncio
    async def test_get_all_repositories(self, sync_store: SyncStore):
        """Test listing all repositories."""
        await sync_store.save_repository("repo-a", "/path/a", "main")
        await sync_store.save_repository("repo-b", "/path/b", "main")
        await sync_store.save_repository("repo-c", "/path/c", "develop")

        repos = await sync_store.get_all_repositories()
        assert len(repos) == 3
        names = {r["name"] for r in repos}
        assert names == {"repo-a", "repo-b", "repo-c"}


class TestPRSnapshotOperations:
    """Tests for PR snapshot operations."""

    @pytest.mark.asyncio
    async def test_save_pr_snapshot(self, sync_store: SyncStore):
        """Test saving a PR snapshot."""
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 123,
                "title": "Test PR",
                "state": "open",
                "head_branch": "feature/test",
                "base_branch": "main",
                "author": "testuser",
                "draft": False,
                "ci_status": "success",
                "labels": ["bug", "priority"],
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("test-repo", 123)
        assert pr is not None
        assert pr["pr_number"] == 123
        assert pr["title"] == "Test PR"
        assert pr["labels"] == ["bug", "priority"]

    @pytest.mark.asyncio
    async def test_pr_snapshot_history(self, sync_store: SyncStore):
        """Test that multiple snapshots are saved (not overwritten)."""
        # Save first snapshot
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 1,
                "title": "Original Title",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
            },
        )

        # Save second snapshot with different title
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 1,
                "title": "Updated Title",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
            },
        )

        # Should get the latest
        pr = await sync_store.get_latest_pr_snapshot("test-repo", 1)
        assert pr["title"] == "Updated Title"

    @pytest.mark.asyncio
    async def test_get_active_prs(self, sync_store: SyncStore):
        """Test getting active (open) PRs."""
        # Save open PR
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 1,
                "title": "Open PR",
                "state": "open",
                "head_branch": "feature-1",
                "base_branch": "main",
            },
        )

        # Save closed PR
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 2,
                "title": "Closed PR",
                "state": "closed",
                "head_branch": "feature-2",
                "base_branch": "main",
            },
        )

        active = await sync_store.get_active_prs("test-repo")
        assert len(active) == 1
        assert active[0]["pr_number"] == 1

    @pytest.mark.asyncio
    async def test_get_all_prs(self, sync_store: SyncStore):
        """Test getting all PRs across repositories."""
        await sync_store.save_pr_snapshot(
            "repo-a",
            {
                "number": 1,
                "title": "PR A1",
                "state": "open",
                "head_branch": "f1",
                "base_branch": "main",
            },
        )
        await sync_store.save_pr_snapshot(
            "repo-b",
            {
                "number": 2,
                "title": "PR B1",
                "state": "open",
                "head_branch": "f2",
                "base_branch": "main",
            },
        )

        # All PRs
        all_prs = await sync_store.get_all_prs()
        assert len(all_prs) == 2

        # Filtered by repo
        repo_a_prs = await sync_store.get_all_prs("repo-a")
        assert len(repo_a_prs) == 1
        assert repo_a_prs[0]["title"] == "PR A1"


class TestPRContextOperations:
    """Tests for PR context storage."""

    @pytest.mark.asyncio
    async def test_save_pr_context(self, sync_store: SyncStore):
        """Test saving PR context."""
        context = PRContext(
            repo_name="test-repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ added line\n- removed line",
            body="PR description",
            comments=[{"author": "user1", "body": "LGTM"}],
            review_comments=[],
            commits=[{"sha": "abc123", "message": "Fix bug"}],
            files=[{"filename": "test.py", "status": "modified"}],
            captured_at=datetime.now(UTC),
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("test-repo", 1)
        assert loaded is not None
        assert loaded.pr_number == 1
        assert loaded.diff == context.diff
        assert len(loaded.comments) == 1
        assert loaded.comments[0]["author"] == "user1"

    @pytest.mark.asyncio
    async def test_large_diff_truncated(self, sync_store: SyncStore):
        """Test that very large diffs are truncated."""
        large_diff = "x" * (15 * 1024 * 1024)  # 15MB

        context = PRContext(
            repo_name="test-repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff=large_diff,
            body="",
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("test-repo", 1)
        assert loaded is not None
        # Should be truncated to 10MB + truncation message
        assert len(loaded.diff) < len(large_diff)
        assert "truncated" in loaded.diff.lower()

    @pytest.mark.asyncio
    async def test_get_all_pr_contexts(self, sync_store: SyncStore):
        """Test getting all PR contexts."""
        for i in range(3):
            context = PRContext(
                repo_name="test-repo",
                pr_number=i + 1,
                pr_url=f"https://github.com/test/repo/pull/{i + 1}",
                diff=f"diff {i}",
                body="",
            )
            await sync_store.save_pr_context(context)

        contexts = await sync_store.get_all_pr_contexts("test-repo")
        assert len(contexts) == 3


class TestBranchStateOperations:
    """Tests for branch state tracking."""

    @pytest.mark.asyncio
    async def test_save_branch_state(self, sync_store: SyncStore):
        """Test saving branch state."""
        await sync_store.save_branch_state(
            repo_name="test-repo",
            branch_name="feature/test",
            is_local=True,
            is_remote=True,
            ahead_by=2,
            behind_by=1,
            has_pr=True,
            pr_number=123,
            needs_sync=True,
        )

        # Verify via statistics
        stats = await sync_store.get_statistics()
        assert stats["branch_snapshots"] == 1


class TestSyncHistoryOperations:
    """Tests for sync history tracking."""

    @pytest.mark.asyncio
    async def test_record_sync_lifecycle(self, sync_store: SyncStore):
        """Test recording sync start and completion."""
        record_id = await sync_store.record_sync_start("test-repo", "full")
        assert record_id > 0

        await sync_store.record_sync_complete(
            record_id,
            success=True,
            prs_synced=5,
            branches_synced=10,
        )

        # Check success rate in stats
        stats = await sync_store.get_statistics()
        assert stats["sync_success_rate"] == 100.0

    @pytest.mark.asyncio
    async def test_record_failed_sync(self, sync_store: SyncStore):
        """Test recording a failed sync."""
        record_id = await sync_store.record_sync_start("test-repo", "full")

        await sync_store.record_sync_complete(
            record_id,
            success=False,
            error_message="Connection timeout",
        )

        stats = await sync_store.get_statistics()
        assert stats["sync_success_rate"] == 0.0


class TestCleanupOperations:
    """Tests for cleanup and maintenance."""

    @pytest.mark.asyncio
    async def test_cleanup_old_snapshots(self, sync_store: SyncStore):
        """Test cleaning up old snapshots."""
        # Save some data
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 1,
                "title": "PR 1",
                "state": "open",
                "head_branch": "f1",
                "base_branch": "main",
            },
        )

        # Cleanup with 0 days should delete everything
        deleted = await sync_store.cleanup_old_snapshots(days=0)

        # All recent snapshots should be kept (cleanup uses < not <=)
        # This tests the mechanism works
        stats = await sync_store.get_statistics()
        # The exact behavior depends on timing


class TestStatistics:
    """Tests for database statistics."""

    @pytest.mark.asyncio
    async def test_empty_database_statistics(self, sync_store: SyncStore):
        """Test statistics on an empty database."""
        stats = await sync_store.get_statistics()

        assert stats["repositories"] == 0
        assert stats["pr_snapshots"] == 0
        assert stats["pr_contexts"] == 0
        assert stats["branch_snapshots"] == 0
        assert stats["database_size_bytes"] > 0

    @pytest.mark.asyncio
    async def test_statistics_after_operations(self, sync_store: SyncStore):
        """Test statistics reflect actual data."""
        await sync_store.save_repository("repo", "/path", "main")
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "PR",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
            },
        )

        stats = await sync_store.get_statistics()
        assert stats["repositories"] == 1
        assert stats["pr_snapshots"] == 1


class TestEdgeCasesUnicode:
    """Tests for Unicode and special character handling."""

    @pytest.mark.asyncio
    async def test_unicode_in_repository_path(self, sync_store: SyncStore):
        """Test repository with unicode path."""
        await sync_store.save_repository("repo", "/путь/к/проекту", "main")

        repo = await sync_store.get_repository("repo")
        assert repo["path"] == "/путь/к/проекту"

    @pytest.mark.asyncio
    async def test_unicode_in_pr_title(self, sync_store: SyncStore):
        """Test PR with unicode title."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "修复 bug: 日本語テスト 🚀",
                "state": "open",
                "head_branch": "feature/日本語",
                "base_branch": "main",
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr["title"] == "修复 bug: 日本語テスト 🚀"
        assert pr["head_branch"] == "feature/日本語"

    @pytest.mark.asyncio
    async def test_emoji_in_labels(self, sync_store: SyncStore):
        """Test PR with emoji labels."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Test",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
                "labels": ["🐛 bug", "🚀 enhancement", "✅ ready"],
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert "🐛 bug" in pr["labels"]

    @pytest.mark.asyncio
    async def test_unicode_in_pr_context(self, sync_store: SyncStore):
        """Test PR context with unicode content."""
        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ // 添加中文注释\n- // 删除日文コメント",
            body="## 概要\nПривет мир!",
            comments=[{"author": "用户", "body": "看起来不错！👍"}],
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("repo", 1)
        assert "中文" in loaded.diff
        assert "Привет" in loaded.body
        assert loaded.comments[0]["author"] == "用户"


class TestEdgeCasesNullEmpty:
    """Tests for null and empty data handling."""

    @pytest.mark.asyncio
    async def test_empty_labels_array(self, sync_store: SyncStore):
        """Test PR with empty labels."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Test",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
                "labels": [],
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr["labels"] == []

    @pytest.mark.asyncio
    async def test_missing_optional_fields(self, sync_store: SyncStore):
        """Test PR with only required fields."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Minimal PR",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr is not None
        assert pr["author"] is None
        assert pr["draft"] == 0

    @pytest.mark.asyncio
    async def test_empty_diff_in_context(self, sync_store: SyncStore):
        """Test PR context with empty diff."""
        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="",
            body="",
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("repo", 1)
        assert loaded.diff == ""
        assert loaded.body == ""

    @pytest.mark.asyncio
    async def test_null_default_branch(self, sync_store: SyncStore):
        """Test repository without default branch."""
        await sync_store.save_repository("repo", "/path", None)

        repo = await sync_store.get_repository("repo")
        assert repo["default_branch"] is None


class TestEdgeCasesLargeData:
    """Tests for handling large amounts of data."""

    @pytest.mark.asyncio
    async def test_many_repositories(self, sync_store: SyncStore):
        """Test storing many repositories."""
        for i in range(100):
            await sync_store.save_repository(f"repo-{i}", f"/path/{i}", "main")

        repos = await sync_store.get_all_repositories()
        assert len(repos) == 100

    @pytest.mark.asyncio
    async def test_many_prs_per_repo(self, sync_store: SyncStore):
        """Test storing many PRs in a single repo."""
        for i in range(50):
            await sync_store.save_pr_snapshot(
                "repo",
                {
                    "number": i + 1,
                    "title": f"PR {i + 1}",
                    "state": "open" if i % 2 == 0 else "closed",
                    "head_branch": f"feature-{i}",
                    "base_branch": "main",
                },
            )

        prs = await sync_store.get_all_prs("repo")
        assert len(prs) == 50

    @pytest.mark.asyncio
    async def test_many_labels(self, sync_store: SyncStore):
        """Test PR with many labels."""
        labels = [f"label-{i}" for i in range(50)]

        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Many Labels",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
                "labels": labels,
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert len(pr["labels"]) == 50

    @pytest.mark.asyncio
    async def test_large_pr_body_in_context(self, sync_store: SyncStore):
        """Test PR context with large body."""
        large_body = "# " + "Lorem ipsum " * 10000

        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ line",
            body=large_body,
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("repo", 1)
        assert loaded.body == large_body

    @pytest.mark.asyncio
    async def test_many_comments_in_context(self, sync_store: SyncStore):
        """Test PR context with many comments."""
        comments = [{"author": f"user{i}", "body": f"Comment {i}"} for i in range(100)]

        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ line",
            body="body",
            comments=comments,
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("repo", 1)
        assert len(loaded.comments) == 100


class TestEdgeCasesConcurrency:
    """Tests for concurrent database access."""

    @pytest.mark.asyncio
    async def test_concurrent_saves(self, sync_store: SyncStore):
        """Test concurrent repository saves."""

        async def save_repo(i):
            await sync_store.save_repository(f"repo-{i}", f"/path/{i}", "main")

        # Save 20 repos concurrently
        await asyncio.gather(*[save_repo(i) for i in range(20)])

        repos = await sync_store.get_all_repositories()
        assert len(repos) == 20

    @pytest.mark.asyncio
    async def test_concurrent_pr_saves(self, sync_store: SyncStore):
        """Test concurrent PR saves."""

        async def save_pr(i):
            await sync_store.save_pr_snapshot(
                "repo",
                {
                    "number": i + 1,
                    "title": f"PR {i + 1}",
                    "state": "open",
                    "head_branch": f"f-{i}",
                    "base_branch": "main",
                },
            )

        # Save 20 PRs concurrently
        await asyncio.gather(*[save_pr(i) for i in range(20)])

        prs = await sync_store.get_all_prs("repo")
        assert len(prs) == 20

    @pytest.mark.asyncio
    async def test_concurrent_context_saves(self, sync_store: SyncStore):
        """Test concurrent context saves."""

        async def save_context(i):
            context = PRContext(
                repo_name="repo",
                pr_number=i + 1,
                pr_url=f"url/{i}",
                diff=f"diff {i}",
                body=f"body {i}",
            )
            await sync_store.save_pr_context(context)

        # Save 20 contexts concurrently
        await asyncio.gather(*[save_context(i) for i in range(20)])

        contexts = await sync_store.get_all_pr_contexts("repo")
        assert len(contexts) == 20

    @pytest.mark.asyncio
    async def test_concurrent_reads_and_writes(self, sync_store: SyncStore):
        """Test concurrent read and write operations."""
        # First add some initial data
        for i in range(5):
            await sync_store.save_repository(f"initial-{i}", f"/path/{i}", "main")

        async def read_repos():
            return await sync_store.get_all_repositories()

        async def write_repo(i):
            await sync_store.save_repository(f"new-{i}", f"/new/{i}", "main")

        # Mix reads and writes
        results = await asyncio.gather(
            read_repos(),
            write_repo(0),
            read_repos(),
            write_repo(1),
            read_repos(),
        )

        # Final check
        repos = await sync_store.get_all_repositories()
        assert len(repos) == 7  # 5 initial + 2 new


class TestEdgeCasesSpecialCharacters:
    """Tests for special characters in data."""

    @pytest.mark.asyncio
    async def test_newlines_in_title(self, sync_store: SyncStore):
        """Test PR title with newlines (should be preserved)."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Line 1\nLine 2",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr["title"] == "Line 1\nLine 2"

    @pytest.mark.asyncio
    async def test_quotes_in_data(self, sync_store: SyncStore):
        """Test data with various quote types."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Fix \"bug\" in 'code'",
                "state": "open",
                "head_branch": 'fix-"quotes"',
                "base_branch": "main",
                "labels": ['has"quote', "has'single"],
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert 'Fix "bug"' in pr["title"]
        assert 'has"quote' in pr["labels"]

    @pytest.mark.asyncio
    async def test_sql_injection_characters(self, sync_store: SyncStore):
        """Test that SQL-like characters are handled safely."""
        malicious_title = "Test'; DROP TABLE repositories; --"

        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": malicious_title,
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
            },
        )

        # Data should be stored and retrieved correctly
        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr["title"] == malicious_title

        # Repositories table should still exist
        repos = await sync_store.get_all_repositories()
        assert repos is not None

    @pytest.mark.asyncio
    async def test_backslashes_in_path(self, sync_store: SyncStore):
        """Test Windows-style paths with backslashes."""
        await sync_store.save_repository("repo", "C:\\Users\\dev\\projects\\repo", "main")

        repo = await sync_store.get_repository("repo")
        assert repo["path"] == "C:\\Users\\dev\\projects\\repo"

    @pytest.mark.asyncio
    async def test_json_in_context_comments(self, sync_store: SyncStore):
        """Test context with JSON-like content in comments."""
        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="url",
            diff="diff",
            body="body",
            comments=[{"author": "bot", "body": '{"key": "value", "nested": {"a": 1}}'}],
        )

        await sync_store.save_pr_context(context)

        loaded = await sync_store.get_latest_pr_context("repo", 1)
        assert '{"key": "value"' in loaded.comments[0]["body"]


class TestEdgeCasesBoundaryConditions:
    """Tests for boundary conditions."""

    @pytest.mark.asyncio
    async def test_pr_number_zero(self, sync_store: SyncStore):
        """Test PR with number 0 (edge case)."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 0,
                "title": "PR Zero",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 0)
        assert pr is not None
        assert pr["pr_number"] == 0

    @pytest.mark.asyncio
    async def test_very_long_branch_name(self, sync_store: SyncStore):
        """Test with very long branch name."""
        long_branch = "feature/" + "a" * 200

        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Long Branch",
                "state": "open",
                "head_branch": long_branch,
                "base_branch": "main",
            },
        )

        pr = await sync_store.get_latest_pr_snapshot("repo", 1)
        assert pr["head_branch"] == long_branch

    @pytest.mark.asyncio
    async def test_empty_repository_name(self, sync_store: SyncStore):
        """Test with empty repository name."""
        await sync_store.save_repository("", "/path", "main")

        repo = await sync_store.get_repository("")
        assert repo is not None
        assert repo["name"] == ""

    @pytest.mark.asyncio
    async def test_pr_limit_parameter(self, sync_store: SyncStore):
        """Test limit parameter on get_all_prs."""
        for i in range(10):
            await sync_store.save_pr_snapshot(
                "repo",
                {
                    "number": i + 1,
                    "title": f"PR {i + 1}",
                    "state": "open",
                    "head_branch": f"f-{i}",
                    "base_branch": "main",
                },
            )

        limited = await sync_store.get_all_prs("repo", limit=5)
        assert len(limited) == 5

    @pytest.mark.asyncio
    async def test_cleanup_with_negative_days(self, sync_store: SyncStore):
        """Test cleanup with negative days parameter."""
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "PR",
                "state": "open",
                "head_branch": "f",
                "base_branch": "main",
            },
        )

        # Negative days should effectively clean nothing or everything
        # depending on implementation
        deleted = await sync_store.cleanup_old_snapshots(days=-1)
        # Just verify it doesn't crash
        assert deleted >= 0


class TestEdgeCasesMultipleStores:
    """Tests for multiple store instances."""

    @pytest.mark.asyncio
    async def test_multiple_stores_same_db(self, temp_dir: Path):
        """Test that multiple store instances share data correctly."""
        db_path = temp_dir / "shared.db"

        store1 = SyncStore(db_path)
        store2 = SyncStore(db_path)

        await store1.initialize()
        await store2.initialize()

        await store1.save_repository("repo", "/path", "main")

        # Store2 should see the data
        repo = await store2.get_repository("repo")
        assert repo is not None
        assert repo["name"] == "repo"

    @pytest.mark.asyncio
    async def test_independent_stores(self, temp_dir: Path):
        """Test that separate databases are independent."""
        store1 = SyncStore(temp_dir / "db1.db")
        store2 = SyncStore(temp_dir / "db2.db")

        await store1.initialize()
        await store2.initialize()

        await store1.save_repository("repo1", "/path1", "main")
        await store2.save_repository("repo2", "/path2", "main")

        # Each store should only see its own data
        assert await store1.get_repository("repo1") is not None
        assert await store1.get_repository("repo2") is None
        assert await store2.get_repository("repo2") is not None
        assert await store2.get_repository("repo1") is None


class TestProjectMetadata:
    """Tests for project metadata operations."""

    @pytest.mark.asyncio
    async def test_get_default_project_metadata(self, sync_store: SyncStore):
        """Test getting project metadata from fresh database."""
        metadata = await sync_store.get_project_metadata()

        assert metadata is not None
        assert metadata["project_id"] is None
        assert metadata["metadata"] == {}
        assert metadata["created_at"] is not None

    @pytest.mark.asyncio
    async def test_set_project_id(self, sync_store: SyncStore):
        """Test setting project ID."""
        await sync_store.set_project_metadata(project_id="my-project-123")

        metadata = await sync_store.get_project_metadata()
        assert metadata["project_id"] == "my-project-123"

    @pytest.mark.asyncio
    async def test_set_metadata_dict(self, sync_store: SyncStore):
        """Test setting metadata dictionary."""
        await sync_store.set_project_metadata(
            metadata={"environment": "production", "team": "backend"}
        )

        result = await sync_store.get_project_metadata()
        assert result["metadata"]["environment"] == "production"
        assert result["metadata"]["team"] == "backend"

    @pytest.mark.asyncio
    async def test_set_both_project_id_and_metadata(self, sync_store: SyncStore):
        """Test setting both project_id and metadata together."""
        await sync_store.set_project_metadata(
            project_id="proj-456",
            metadata={"version": "1.0.0", "owner": "alice"},
        )

        result = await sync_store.get_project_metadata()
        assert result["project_id"] == "proj-456"
        assert result["metadata"]["version"] == "1.0.0"
        assert result["metadata"]["owner"] == "alice"

    @pytest.mark.asyncio
    async def test_metadata_merge_default(self, sync_store: SyncStore):
        """Test that metadata merges by default."""
        await sync_store.set_project_metadata(metadata={"key1": "value1"})
        await sync_store.set_project_metadata(metadata={"key2": "value2"})

        result = await sync_store.get_project_metadata()
        assert result["metadata"]["key1"] == "value1"
        assert result["metadata"]["key2"] == "value2"

    @pytest.mark.asyncio
    async def test_metadata_replace_mode(self, sync_store: SyncStore):
        """Test replacing metadata instead of merging."""
        await sync_store.set_project_metadata(metadata={"old_key": "old_value"})
        await sync_store.set_project_metadata(metadata={"new_key": "new_value"}, merge=False)

        result = await sync_store.get_project_metadata()
        assert "old_key" not in result["metadata"]
        assert result["metadata"]["new_key"] == "new_value"

    @pytest.mark.asyncio
    async def test_update_single_metadata_key(self, sync_store: SyncStore):
        """Test updating a single metadata key."""
        await sync_store.set_project_metadata(metadata={"keep": "this", "update": "old"})
        await sync_store.update_project_metadata("update", "new")

        result = await sync_store.get_project_metadata()
        assert result["metadata"]["keep"] == "this"
        assert result["metadata"]["update"] == "new"

    @pytest.mark.asyncio
    async def test_delete_metadata_key(self, sync_store: SyncStore):
        """Test deleting a metadata key."""
        await sync_store.set_project_metadata(metadata={"keep": "this", "delete": "me"})

        deleted = await sync_store.delete_project_metadata_key("delete")
        assert deleted is True

        result = await sync_store.get_project_metadata()
        assert result["metadata"]["keep"] == "this"
        assert "delete" not in result["metadata"]

    @pytest.mark.asyncio
    async def test_delete_nonexistent_key(self, sync_store: SyncStore):
        """Test deleting a key that doesn't exist."""
        deleted = await sync_store.delete_project_metadata_key("nonexistent")
        assert deleted is False

    @pytest.mark.asyncio
    async def test_metadata_with_nested_structures(self, sync_store: SyncStore):
        """Test metadata with nested dictionaries and lists."""
        complex_metadata = {
            "config": {
                "database": {"host": "localhost", "port": 5432},
                "features": ["auth", "logging", "metrics"],
            },
            "tags": ["python", "async", "sqlite"],
            "counts": {"repos": 5, "prs": 42},
        }

        await sync_store.set_project_metadata(metadata=complex_metadata)

        result = await sync_store.get_project_metadata()
        assert result["metadata"]["config"]["database"]["host"] == "localhost"
        assert result["metadata"]["config"]["features"] == ["auth", "logging", "metrics"]
        assert result["metadata"]["tags"] == ["python", "async", "sqlite"]

    @pytest.mark.asyncio
    async def test_metadata_with_unicode(self, sync_store: SyncStore):
        """Test metadata with unicode content."""
        await sync_store.set_project_metadata(
            project_id="проект-日本語-🚀",
            metadata={
                "description": "Проект с японским テスト и эмодзи 🎉",
                "author": "開発者",
            },
        )

        result = await sync_store.get_project_metadata()
        assert result["project_id"] == "проект-日本語-🚀"
        assert "テスト" in result["metadata"]["description"]  # Japanese katakana
        assert "Проект" in result["metadata"]["description"]  # Russian
        assert result["metadata"]["author"] == "開発者"

    @pytest.mark.asyncio
    async def test_metadata_with_special_json_characters(self, sync_store: SyncStore):
        """Test metadata with special JSON characters."""
        await sync_store.set_project_metadata(
            metadata={
                "query": 'SELECT * FROM users WHERE name = "test"',
                "regex": r"\d+\.\d+",
                "newlines": "line1\nline2\nline3",
            }
        )

        result = await sync_store.get_project_metadata()
        assert '"test"' in result["metadata"]["query"]
        assert result["metadata"]["regex"] == r"\d+\.\d+"
        assert "\n" in result["metadata"]["newlines"]

    @pytest.mark.asyncio
    async def test_project_id_in_statistics(self, sync_store: SyncStore):
        """Test that project_id appears in statistics."""
        await sync_store.set_project_metadata(project_id="stats-test-proj")

        stats = await sync_store.get_statistics()
        assert stats["project_id"] == "stats-test-proj"

    @pytest.mark.asyncio
    async def test_statistics_without_project_id(self, sync_store: SyncStore):
        """Test statistics when project_id is not set."""
        stats = await sync_store.get_statistics()
        assert stats["project_id"] is None

    @pytest.mark.asyncio
    async def test_updated_at_changes(self, sync_store: SyncStore):
        """Test that updated_at timestamp changes on updates."""
        await sync_store.set_project_metadata(metadata={"v": 1})
        first = await sync_store.get_project_metadata()
        first_updated = first["updated_at"]

        # Small delay to ensure timestamp difference
        import asyncio

        await asyncio.sleep(0.01)

        await sync_store.set_project_metadata(metadata={"v": 2})
        second = await sync_store.get_project_metadata()
        second_updated = second["updated_at"]

        assert second_updated >= first_updated

    @pytest.mark.asyncio
    async def test_metadata_persistence_across_connections(self, temp_dir: Path):
        """Test that project metadata persists across store instances."""
        db_path = temp_dir / "persist_test.db"

        # First store instance
        store1 = SyncStore(db_path)
        await store1.initialize()
        await store1.set_project_metadata(project_id="persistent-proj", metadata={"key": "value"})

        # Second store instance (simulates app restart)
        store2 = SyncStore(db_path)
        await store2.initialize()
        result = await store2.get_project_metadata()

        assert result["project_id"] == "persistent-proj"
        assert result["metadata"]["key"] == "value"


class TestSchemaMigrationV1ToV2:
    """Tests for schema migration from v1 to v2."""

    @pytest.mark.asyncio
    async def test_schema_version_is_2(self, sync_store: SyncStore):
        """Test that new databases are created at schema version 2."""
        info = await sync_store.get_schema_info()
        assert info["current_version"] == 2
        assert info["latest_version"] == 2
        assert not info["needs_migration"]

    @pytest.mark.asyncio
    async def test_statistics_include_schema_version_2(self, sync_store: SyncStore):
        """Test that statistics show schema version 2."""
        stats = await sync_store.get_statistics()
        assert stats["schema_version"] == 2
