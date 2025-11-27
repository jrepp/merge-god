"""Tests for command parsing, queue, and PR memos."""

from datetime import UTC, datetime

import pytest

from github_sync import (
    BotCommand,
    CommandParser,
    CommandResult,
    CommandStatus,
    QueuedCommand,
    SyncStore,
)


class TestCommandParser:
    """Tests for CommandParser."""

    def test_parse_simple_commands(self):
        """Test parsing simple commands."""
        parser = CommandParser(bot_mention="@agfcmd")

        # Single commands
        assert parser.extract_from_text("@agfcmd merge") == [(BotCommand.MERGE, None)]
        assert parser.extract_from_text("@agfcmd rebase") == [(BotCommand.REBASE, None)]
        assert parser.extract_from_text("@agfcmd close") == [(BotCommand.CLOSE, None)]
        assert parser.extract_from_text("@agfcmd reopen") == [(BotCommand.REOPEN, None)]
        assert parser.extract_from_text("@agfcmd recreate") == [(BotCommand.RECREATE, None)]

    def test_parse_multi_word_commands(self):
        """Test parsing multi-word commands."""
        parser = CommandParser(bot_mention="@agfcmd")

        assert parser.extract_from_text("@agfcmd squash and merge") == [
            (BotCommand.SQUASH_AND_MERGE, None)
        ]
        assert parser.extract_from_text("@agfcmd cancel merge") == [
            (BotCommand.CANCEL_MERGE, None)
        ]

    def test_parse_ignore_commands(self):
        """Test parsing ignore commands."""
        parser = CommandParser(bot_mention="@agfcmd")

        assert parser.extract_from_text("@agfcmd ignore this major version") == [
            (BotCommand.IGNORE_MAJOR, None)
        ]
        assert parser.extract_from_text("@agfcmd ignore this minor version") == [
            (BotCommand.IGNORE_MINOR, None)
        ]
        assert parser.extract_from_text("@agfcmd ignore this dependency") == [
            (BotCommand.IGNORE_DEPENDENCY, None)
        ]

    def test_parse_show_ignore_conditions(self):
        """Test parsing show ignore conditions with dependency name."""
        parser = CommandParser(bot_mention="@agfcmd")

        result = parser.extract_from_text("@agfcmd show lodash ignore conditions")
        assert len(result) == 1
        assert result[0][0] == BotCommand.SHOW_IGNORE_CONDITIONS
        assert result[0][1] == "lodash"

        result = parser.extract_from_text("@agfcmd show ignore conditions")
        assert len(result) == 1
        assert result[0][0] == BotCommand.SHOW_IGNORE_CONDITIONS
        assert result[0][1] is None

    def test_parse_case_insensitive(self):
        """Test that parsing is case insensitive."""
        parser = CommandParser(bot_mention="@agfcmd")

        assert parser.extract_from_text("@AGFCMD merge") == [(BotCommand.MERGE, None)]
        assert parser.extract_from_text("@AgfCmd REBASE") == [(BotCommand.REBASE, None)]
        assert parser.extract_from_text("@agfcmd SQUASH AND MERGE") == [
            (BotCommand.SQUASH_AND_MERGE, None)
        ]

    def test_parse_with_surrounding_text(self):
        """Test parsing commands embedded in longer text."""
        parser = CommandParser(bot_mention="@agfcmd")

        text = "Thanks for the PR! @agfcmd merge when CI passes."
        assert parser.extract_from_text(text) == [(BotCommand.MERGE, None)]

        text = "Please @agfcmd rebase this PR to get the latest changes."
        assert parser.extract_from_text(text) == [(BotCommand.REBASE, None)]

    def test_parse_no_commands(self):
        """Test that text without commands returns empty list."""
        parser = CommandParser(bot_mention="@agfcmd")

        assert parser.extract_from_text("This is a regular comment") == []
        assert parser.extract_from_text("@someone else mentioned") == []
        assert parser.extract_from_text("agfcmd without @") == []

    def test_parse_different_bot_mention(self):
        """Test with different bot mention."""
        parser = CommandParser(bot_mention="@dependabot")

        assert parser.extract_from_text("@dependabot merge") == [(BotCommand.MERGE, None)]
        assert parser.extract_from_text("@agfcmd merge") == []  # Wrong bot

    def test_extract_from_comments(self):
        """Test extracting commands from a list of comments."""
        parser = CommandParser(bot_mention="@agfcmd")

        comments = [
            {
                "id": 1,
                "author": "user1",
                "body": "Looks good! @agfcmd merge",
                "created_at": "2024-01-15T10:00:00Z",
            },
            {
                "id": 2,
                "author": "user2",
                "body": "Actually wait, @agfcmd cancel merge",
                "created_at": "2024-01-15T11:00:00Z",
            },
            {
                "id": 3,
                "author": "user3",
                "body": "No commands here",
                "created_at": "2024-01-15T12:00:00Z",
            },
        ]

        queued = parser.extract_from_comments(comments, "test-repo", 42)

        assert len(queued) == 2
        assert queued[0].command == BotCommand.MERGE
        assert queued[0].comment_id == 1
        assert queued[0].comment_author == "user1"
        assert queued[0].pr_number == 42
        assert queued[0].repo_name == "test-repo"
        assert queued[0].status == CommandStatus.PENDING

        assert queued[1].command == BotCommand.CANCEL_MERGE
        assert queued[1].comment_id == 2

    def test_no_duplicate_commands_from_same_comment(self):
        """Test that duplicate commands from same comment are not extracted."""
        parser = CommandParser(bot_mention="@agfcmd")

        comments = [
            {
                "id": 1,
                "author": "user1",
                "body": "@agfcmd merge @agfcmd merge please",  # Same command twice
                "created_at": "2024-01-15T10:00:00Z",
            },
        ]

        queued = parser.extract_from_comments(comments, "test-repo", 42)
        assert len(queued) == 1  # Only one merge command


class TestQueuedCommand:
    """Tests for QueuedCommand dataclass."""

    def test_to_dict(self):
        """Test serialization to dict."""
        cmd = QueuedCommand(
            id="123",
            repo_name="test-repo",
            pr_number=42,
            command=BotCommand.MERGE,
            status=CommandStatus.PENDING,
            comment_id=456,
            comment_author="user1",
            comment_body="@agfcmd merge",
            extracted_at=datetime(2024, 1, 15, 10, 0, 0, tzinfo=UTC),
        )

        d = cmd.to_dict()
        assert d["repo_name"] == "test-repo"
        assert d["pr_number"] == 42
        assert d["command"] == "merge"
        assert d["status"] == "pending"
        assert d["comment_id"] == 456

    def test_from_dict(self):
        """Test deserialization from dict."""
        d = {
            "id": "123",
            "repo_name": "test-repo",
            "pr_number": 42,
            "command": "merge",
            "status": "pending",
            "comment_id": 456,
            "comment_author": "user1",
            "comment_body": "@agfcmd merge",
            "extracted_at": "2024-01-15T10:00:00+00:00",
        }

        cmd = QueuedCommand.from_dict(d)
        assert cmd.repo_name == "test-repo"
        assert cmd.command == BotCommand.MERGE
        assert cmd.status == CommandStatus.PENDING


class TestCommandQueue:
    """Tests for command queue database operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_queue_command(self, store):
        """Test queueing a command."""
        cmd_id = await store.queue_command(
            repo_name="test-repo",
            pr_number=42,
            command="merge",
            comment_id=123,
            comment_author="user1",
            comment_body="@agfcmd merge",
            extracted_at=datetime.now(UTC),
        )

        assert cmd_id > 0

    @pytest.mark.asyncio
    async def test_queue_duplicate_command(self, store):
        """Test that duplicate commands are not queued twice."""
        now = datetime.now(UTC)

        cmd_id1 = await store.queue_command(
            repo_name="test-repo",
            pr_number=42,
            command="merge",
            comment_id=123,
            comment_author="user1",
            comment_body="@agfcmd merge",
            extracted_at=now,
        )

        cmd_id2 = await store.queue_command(
            repo_name="test-repo",
            pr_number=42,
            command="merge",
            comment_id=123,  # Same comment
            comment_author="user1",
            comment_body="@agfcmd merge",
            extracted_at=now,
        )

        assert cmd_id1 == cmd_id2  # Returns same ID

    @pytest.mark.asyncio
    async def test_get_pending_commands(self, store):
        """Test getting pending commands."""
        now = datetime.now(UTC)

        await store.queue_command("repo1", 1, "merge", 1, "user", "body", now)
        await store.queue_command("repo1", 2, "rebase", 2, "user", "body", now)
        await store.queue_command("repo2", 3, "close", 3, "user", "body", now)

        # All pending
        pending = await store.get_pending_commands()
        assert len(pending) == 3

        # Filter by repo
        pending = await store.get_pending_commands(repo_name="repo1")
        assert len(pending) == 2

        # Filter by PR
        pending = await store.get_pending_commands(repo_name="repo1", pr_number=1)
        assert len(pending) == 1
        assert pending[0]["command"] == "merge"

    @pytest.mark.asyncio
    async def test_update_command_status(self, store):
        """Test updating command status."""
        now = datetime.now(UTC)
        cmd_id = await store.queue_command("repo", 1, "merge", 1, "user", "body", now)

        await store.update_command_status(cmd_id, "completed", "Merged successfully", success=True)

        history = await store.get_command_history("repo", pr_number=1)
        assert len(history) == 1
        assert history[0]["status"] == "completed"
        assert history[0]["result_message"] == "Merged successfully"
        assert history[0]["completed_at"] is not None

    @pytest.mark.asyncio
    async def test_command_history(self, store):
        """Test getting command history."""
        now = datetime.now(UTC)

        await store.queue_command("repo", 1, "merge", 1, "user", "body", now)
        await store.queue_command("repo", 1, "rebase", 2, "user", "body", now)
        await store.queue_command("repo", 2, "close", 3, "user", "body", now)

        # All history for repo
        history = await store.get_command_history("repo")
        assert len(history) == 3

        # History for specific PR
        history = await store.get_command_history("repo", pr_number=1)
        assert len(history) == 2


class TestPRMemos:
    """Tests for PR memos (shadow memory)."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_set_and_get_memo(self, store):
        """Test setting and getting a memo."""
        await store.set_memo("repo", 42, "todo", "- [ ] Fix tests\n- [ ] Update docs")

        content = await store.get_memo("repo", 42, "todo")
        assert content == "- [ ] Fix tests\n- [ ] Update docs"

    @pytest.mark.asyncio
    async def test_update_memo(self, store):
        """Test updating an existing memo."""
        await store.set_memo("repo", 42, "plan", "Original plan")
        await store.set_memo("repo", 42, "plan", "Updated plan")

        content = await store.get_memo("repo", 42, "plan")
        assert content == "Updated plan"

    @pytest.mark.asyncio
    async def test_get_nonexistent_memo(self, store):
        """Test getting a memo that doesn't exist."""
        content = await store.get_memo("repo", 42, "nonexistent")
        assert content is None

    @pytest.mark.asyncio
    async def test_get_all_memos(self, store):
        """Test getting all memos for a PR."""
        await store.set_memo("repo", 42, "todo", "Todo content")
        await store.set_memo("repo", 42, "plan", "Plan content")
        await store.set_memo("repo", 42, "notes", "Notes content")

        memos = await store.get_all_memos("repo", 42)

        assert len(memos) == 3
        assert memos["todo"] == "Todo content"
        assert memos["plan"] == "Plan content"
        assert memos["notes"] == "Notes content"

    @pytest.mark.asyncio
    async def test_delete_memo(self, store):
        """Test deleting a specific memo."""
        await store.set_memo("repo", 42, "todo", "Todo content")
        await store.set_memo("repo", 42, "plan", "Plan content")

        deleted = await store.delete_memo("repo", 42, "todo")
        assert deleted is True

        # Verify deleted
        content = await store.get_memo("repo", 42, "todo")
        assert content is None

        # Other memo still exists
        content = await store.get_memo("repo", 42, "plan")
        assert content == "Plan content"

    @pytest.mark.asyncio
    async def test_delete_nonexistent_memo(self, store):
        """Test deleting a memo that doesn't exist."""
        deleted = await store.delete_memo("repo", 42, "nonexistent")
        assert deleted is False

    @pytest.mark.asyncio
    async def test_delete_all_memos(self, store):
        """Test deleting all memos for a PR."""
        await store.set_memo("repo", 42, "todo", "Todo")
        await store.set_memo("repo", 42, "plan", "Plan")
        await store.set_memo("repo", 42, "notes", "Notes")

        count = await store.delete_all_memos("repo", 42)
        assert count == 3

        memos = await store.get_all_memos("repo", 42)
        assert len(memos) == 0

    @pytest.mark.asyncio
    async def test_memos_isolated_by_pr(self, store):
        """Test that memos are isolated by PR."""
        await store.set_memo("repo", 1, "todo", "PR 1 todo")
        await store.set_memo("repo", 2, "todo", "PR 2 todo")

        content1 = await store.get_memo("repo", 1, "todo")
        content2 = await store.get_memo("repo", 2, "todo")

        assert content1 == "PR 1 todo"
        assert content2 == "PR 2 todo"

    @pytest.mark.asyncio
    async def test_memo_with_json_content(self, store):
        """Test storing JSON content in a memo."""
        import json

        todo_list = {
            "items": [
                {"task": "Fix tests", "done": False},
                {"task": "Update docs", "done": True},
            ],
            "priority": "high",
        }

        await store.set_memo("repo", 42, "todo", json.dumps(todo_list))

        content = await store.get_memo("repo", 42, "todo")
        parsed = json.loads(content)

        assert parsed["priority"] == "high"
        assert len(parsed["items"]) == 2


class TestCommandExecutionTiming:
    """Tests for automatic command timing and audit trail."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_start_command_execution(self, store):
        """Test marking a command as executing with start time."""
        now = datetime.now(UTC)
        cmd_id = await store.queue_command(
            "repo", 42, "merge", 123, "user", "body", now
        )

        await store.start_command_execution(cmd_id)

        pending = await store.get_pending_commands("repo")
        # Command should no longer be pending (it's executing)
        assert len(pending) == 0

        history = await store.get_command_history("repo")
        assert len(history) == 1
        assert history[0]["status"] == "executing"
        assert history[0]["started_at"] is not None

    @pytest.mark.asyncio
    async def test_complete_command_execution_success(self, store):
        """Test completing a command execution with success."""
        import time

        now = datetime.now(UTC)
        cmd_id = await store.queue_command(
            "repo", 42, "merge", 123, "user", "body", now
        )

        await store.start_command_execution(cmd_id)
        time.sleep(0.01)  # Small delay to ensure duration > 0

        duration = await store.complete_command_execution(
            cmd_id, success=True, result_message="Merged successfully"
        )

        assert duration >= 0

        history = await store.get_command_history("repo")
        assert history[0]["status"] == "completed"
        assert history[0]["success"] == 1
        assert history[0]["completed_at"] is not None
        assert history[0]["duration_ms"] is not None
        assert history[0]["result_message"] == "Merged successfully"

    @pytest.mark.asyncio
    async def test_complete_command_execution_failure(self, store):
        """Test completing a command execution with failure."""
        now = datetime.now(UTC)
        cmd_id = await store.queue_command(
            "repo", 42, "merge", 123, "user", "body", now
        )

        await store.start_command_execution(cmd_id)

        await store.complete_command_execution(
            cmd_id,
            success=False,
            result_message="Merge failed",
            error_type="APIError",
            error_message="401 Unauthorized",
        )

        history = await store.get_command_history("repo")
        assert history[0]["status"] == "failed"
        assert history[0]["success"] == 0
        assert history[0]["error_type"] == "APIError"
        assert history[0]["error_message"] == "401 Unauthorized"

    @pytest.mark.asyncio
    async def test_increment_retry_count(self, store):
        """Test incrementing retry count."""
        now = datetime.now(UTC)
        cmd_id = await store.queue_command(
            "repo", 42, "merge", 123, "user", "body", now
        )

        count1 = await store.increment_retry_count(cmd_id)
        assert count1 == 1

        count2 = await store.increment_retry_count(cmd_id)
        assert count2 == 2

        count3 = await store.increment_retry_count(cmd_id)
        assert count3 == 3

    @pytest.mark.asyncio
    async def test_get_command_execution_stats(self, store):
        """Test getting execution statistics."""
        now = datetime.now(UTC)

        # Create and complete some commands
        for i in range(5):
            cmd_id = await store.queue_command(
                "repo", i, "merge", i, "user", "body", now
            )
            await store.start_command_execution(cmd_id)
            await store.complete_command_execution(
                cmd_id, success=(i % 2 == 0), result_message=f"Result {i}"
            )

        stats = await store.get_command_execution_stats("repo")

        assert stats["total_count"] == 5
        assert stats["success_count"] == 3  # i=0,2,4
        assert stats["failure_count"] == 2  # i=1,3
        assert stats["success_rate"] == 60.0
        assert "avg_duration_ms" in stats

    @pytest.mark.asyncio
    async def test_get_command_execution_stats_by_command(self, store):
        """Test getting execution statistics filtered by command."""
        now = datetime.now(UTC)

        # Create merge commands
        for i in range(3):
            cmd_id = await store.queue_command(
                "repo", i, "merge", i, "user", "body", now
            )
            await store.start_command_execution(cmd_id)
            await store.complete_command_execution(cmd_id, success=True)

        # Create rebase commands
        for i in range(2):
            cmd_id = await store.queue_command(
                "repo", 10 + i, "rebase", 10 + i, "user", "body", now
            )
            await store.start_command_execution(cmd_id)
            await store.complete_command_execution(cmd_id, success=False)

        merge_stats = await store.get_command_execution_stats("repo", command="merge")
        rebase_stats = await store.get_command_execution_stats("repo", command="rebase")

        assert merge_stats["total_count"] == 3
        assert merge_stats["success_rate"] == 100.0

        assert rebase_stats["total_count"] == 2
        assert rebase_stats["success_rate"] == 0.0

    @pytest.mark.asyncio
    async def test_get_failed_commands(self, store):
        """Test getting failed commands."""
        now = datetime.now(UTC)

        # Create some successful commands
        for i in range(2):
            cmd_id = await store.queue_command(
                "repo", i, "merge", i, "user", "body", now
            )
            await store.start_command_execution(cmd_id)
            await store.complete_command_execution(cmd_id, success=True)

        # Create some failed commands
        for i in range(3):
            cmd_id = await store.queue_command(
                "repo", 10 + i, "rebase", 10 + i, "user", "body", now
            )
            await store.start_command_execution(cmd_id)
            await store.complete_command_execution(
                cmd_id,
                success=False,
                error_type="TestError",
                error_message=f"Error {i}",
            )

        failed = await store.get_failed_commands("repo")

        assert len(failed) == 3
        assert all(f["status"] == "failed" for f in failed)
        assert all(f["error_type"] == "TestError" for f in failed)


class TestCommandResultTiming:
    """Tests for CommandResult timing methods."""

    def test_command_result_complete(self):
        """Test CommandResult.complete() method."""
        import time

        result = CommandResult(
            command=BotCommand.MERGE,
            success=False,
            pr_number=42,
        )

        time.sleep(0.01)  # Small delay

        result.complete(
            success=True,
            message="Merged",
            error_type=None,
            error_message=None,
        )

        assert result.success is True
        assert result.message == "Merged"
        assert result.completed_at is not None
        assert result.duration_ms is not None
        assert result.duration_ms >= 0

    def test_command_result_complete_with_error(self):
        """Test CommandResult.complete() with error info."""
        result = CommandResult(
            command=BotCommand.MERGE,
            success=False,
            pr_number=42,
        )

        result.complete(
            success=False,
            message="Failed to merge",
            error_type="APIError",
            error_message="401 Unauthorized",
        )

        assert result.success is False
        assert result.error_type == "APIError"
        assert result.error_message == "401 Unauthorized"

    def test_command_result_to_dict_with_timing(self):
        """Test CommandResult serialization includes timing."""
        result = CommandResult(
            command=BotCommand.MERGE,
            success=True,
            pr_number=42,
        )
        result.complete(success=True, message="Done")

        d = result.to_dict()

        assert "started_at" in d
        assert "completed_at" in d
        assert "duration_ms" in d
        assert d["duration_ms"] is not None


class TestQueuedCommandTiming:
    """Tests for QueuedCommand timing fields."""

    def test_queued_command_with_timing(self):
        """Test QueuedCommand with timing fields."""
        now = datetime.now(UTC)

        cmd = QueuedCommand(
            id="1",
            repo_name="repo",
            pr_number=42,
            command=BotCommand.MERGE,
            status=CommandStatus.COMPLETED,
            comment_id=123,
            comment_author="user",
            comment_body="@agfcmd merge",
            extracted_at=now,
            started_at=now,
            completed_at=now,
            duration_ms=150,
            success=True,
            error_type=None,
            error_message=None,
            retry_count=0,
        )

        d = cmd.to_dict()

        assert d["started_at"] is not None
        assert d["completed_at"] is not None
        assert d["duration_ms"] == 150
        assert d["success"] is True
        assert d["retry_count"] == 0

    def test_queued_command_from_dict_with_timing(self):
        """Test QueuedCommand deserialization with timing."""
        now = datetime.now(UTC)

        d = {
            "id": "1",
            "repo_name": "repo",
            "pr_number": 42,
            "command": "merge",
            "status": "completed",
            "comment_id": 123,
            "comment_author": "user",
            "comment_body": "@agfcmd merge",
            "extracted_at": now.isoformat(),
            "started_at": now.isoformat(),
            "completed_at": now.isoformat(),
            "duration_ms": 150,
            "success": True,
            "error_type": "APIError",
            "error_message": "Test error",
            "retry_count": 2,
        }

        cmd = QueuedCommand.from_dict(d)

        assert cmd.started_at is not None
        assert cmd.completed_at is not None
        assert cmd.duration_ms == 150
        assert cmd.success is True
        assert cmd.error_type == "APIError"
        assert cmd.error_message == "Test error"
        assert cmd.retry_count == 2
