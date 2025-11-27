"""Tests for MCP server implementation."""

import json
from pathlib import Path

import pytest

from github_sync import SyncStore
from github_sync.mcp_server import (
    FileTools,
    GitTools,
    MCPServer,
    SyncTools,
    WorkflowTools,
)


class TestGitTools:
    """Tests for GitTools."""

    @pytest.fixture
    def git_repo(self, tmp_path):
        """Create a temporary git repository."""
        import subprocess

        repo_path = tmp_path / "repo"
        repo_path.mkdir()

        # Initialize git repo
        subprocess.run(["git", "init"], cwd=repo_path, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
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
        (repo_path / "README.md").write_text("# Test Repo\n")
        subprocess.run(["git", "add", "."], cwd=repo_path, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"],
            cwd=repo_path,
            check=True,
            capture_output=True,
        )

        return repo_path

    @pytest.fixture
    def git_tools(self, git_repo):
        """Create GitTools instance."""
        return GitTools(git_repo)

    @pytest.mark.asyncio
    async def test_status_clean(self, git_tools):
        """Test git status on clean repo."""
        result = await git_tools.status()

        assert "error" not in result
        assert result["clean"] is True
        assert result["has_conflicts"] is False
        assert result["branch"] == "master" or result["branch"] == "main"

    @pytest.mark.asyncio
    async def test_status_with_changes(self, git_tools, git_repo):
        """Test git status with uncommitted changes."""
        # Create a new file
        (git_repo / "new_file.txt").write_text("new content")

        result = await git_tools.status()

        assert result["clean"] is False
        assert "new_file.txt" in result["files"]["untracked"]

    @pytest.mark.asyncio
    async def test_add_and_commit(self, git_tools, git_repo):
        """Test staging and committing files."""
        # Create a new file
        (git_repo / "test.txt").write_text("test content")

        # Stage it
        add_result = await git_tools.add(files=["test.txt"])
        assert add_result.get("success") is True

        # Commit it
        commit_result = await git_tools.commit(message="Add test file")
        assert commit_result.get("success") is True
        assert "commit" in commit_result

    @pytest.mark.asyncio
    async def test_log(self, git_tools):
        """Test git log."""
        result = await git_tools.log(count=5)

        assert "error" not in result
        assert "commits" in result
        assert len(result["commits"]) >= 1
        assert result["commits"][0]["subject"] == "Initial commit"

    @pytest.mark.asyncio
    async def test_diff(self, git_tools, git_repo):
        """Test git diff."""
        # Modify a file
        (git_repo / "README.md").write_text("# Modified\n")

        result = await git_tools.diff()

        assert "error" not in result
        assert "Modified" in result["diff"]

    @pytest.mark.asyncio
    async def test_checkout_create_branch(self, git_tools):
        """Test creating a new branch."""
        result = await git_tools.checkout(ref="test-branch", create=True)

        assert result.get("success") is True

        # Verify we're on the new branch
        status = await git_tools.status()
        assert status["branch"] == "test-branch"


class TestFileTools:
    """Tests for FileTools."""

    @pytest.fixture
    def file_tools(self, tmp_path):
        """Create FileTools instance."""
        return FileTools(tmp_path)

    @pytest.mark.asyncio
    async def test_read_file(self, file_tools, tmp_path):
        """Test reading a file."""
        # Create a test file
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        result = await file_tools.read_file("test.txt")

        assert "error" not in result
        assert result["content"] == "Hello, World!"
        assert result["size"] == 13

    @pytest.mark.asyncio
    async def test_read_file_not_found(self, file_tools):
        """Test reading a non-existent file."""
        result = await file_tools.read_file("nonexistent.txt")

        assert "error" in result

    @pytest.mark.asyncio
    async def test_write_file(self, file_tools, tmp_path):
        """Test writing a file."""
        result = await file_tools.write_file("output.txt", "Test content")

        assert result.get("success") is True
        assert (tmp_path / "output.txt").read_text() == "Test content"

    @pytest.mark.asyncio
    async def test_write_file_creates_dirs(self, file_tools, tmp_path):
        """Test that write_file creates parent directories."""
        result = await file_tools.write_file("subdir/nested/file.txt", "content")

        assert result.get("success") is True
        assert (tmp_path / "subdir" / "nested" / "file.txt").read_text() == "content"

    @pytest.mark.asyncio
    async def test_list_directory(self, file_tools, tmp_path):
        """Test listing directory contents."""
        # Create some files
        (tmp_path / "file1.txt").write_text("1")
        (tmp_path / "file2.txt").write_text("2")
        (tmp_path / "subdir").mkdir()

        result = await file_tools.list_directory()

        assert "error" not in result
        names = [e["name"] for e in result["entries"]]
        assert "file1.txt" in names
        assert "file2.txt" in names
        assert "subdir" in names

    @pytest.mark.asyncio
    async def test_file_exists(self, file_tools, tmp_path):
        """Test checking file existence."""
        (tmp_path / "exists.txt").write_text("yes")

        exists_result = await file_tools.file_exists("exists.txt")
        assert exists_result["exists"] is True
        assert exists_result["is_file"] is True

        not_exists_result = await file_tools.file_exists("nope.txt")
        assert not_exists_result["exists"] is False


class TestWorkflowTools:
    """Tests for WorkflowTools."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.fixture
    def workflow_tools(self, store):
        """Create WorkflowTools instance."""
        return WorkflowTools(store)

    @pytest.mark.asyncio
    async def test_workflow_lifecycle(self, workflow_tools):
        """Test complete workflow lifecycle."""
        # Start workflow
        start_result = await workflow_tools.workflow_start(
            workflow_type="merge",
            repo_name="test-repo",
            branch_name="feature",
        )

        assert "workflow_id" in start_result
        assert start_result["status"] == "running"
        workflow_id = start_result["workflow_id"]

        # Start a step
        step_result = await workflow_tools.workflow_step_start(
            step_name="fetch",
            input_data={"remote": "origin"},
        )

        assert "step_id" in step_result
        assert step_result["step_name"] == "fetch"

        # Complete the step
        complete_step = await workflow_tools.workflow_step_complete(
            summary="Fetched latest changes",
            output_data={"refs_fetched": 5},
        )

        assert complete_step["success"] is True

        # Complete workflow
        complete_result = await workflow_tools.workflow_complete(
            result="Merge successful"
        )

        assert complete_result["workflow_id"] == workflow_id
        assert complete_result["success"] is True

    @pytest.mark.asyncio
    async def test_workflow_status(self, workflow_tools):
        """Test getting workflow status."""
        # No active workflow
        status = await workflow_tools.workflow_status()
        assert status["active"] is False

        # Start a workflow
        await workflow_tools.workflow_start(
            workflow_type="rebase",
            repo_name="repo",
            branch_name="branch",
        )

        status = await workflow_tools.workflow_status()
        assert status["active"] is True
        assert status["type"] == "rebase"

    @pytest.mark.asyncio
    async def test_workflow_pause(self, workflow_tools):
        """Test pausing a workflow."""
        await workflow_tools.workflow_start(
            workflow_type="merge",
            repo_name="repo",
            branch_name="branch",
        )

        result = await workflow_tools.workflow_pause(reason="Need human review")

        assert result["status"] == "paused"
        assert result["reason"] == "Need human review"

    @pytest.mark.asyncio
    async def test_workflow_step_fail(self, workflow_tools):
        """Test failing a step."""
        await workflow_tools.workflow_start(
            workflow_type="merge",
            repo_name="repo",
            branch_name="branch",
        )
        await workflow_tools.workflow_step_start(step_name="merge")

        result = await workflow_tools.workflow_step_fail(
            error_type="MergeConflict",
            error_message="Conflict in file.py",
        )

        assert result["success"] is False
        assert result["error_type"] == "MergeConflict"


class TestSyncTools:
    """Tests for SyncTools."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store with some data."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()

        # Add some test data
        await store.save_pr_snapshot("test-repo", {
            "number": 42,
            "title": "Test PR",
            "state": "open",
            "head_branch": "feature",
            "base_branch": "main",
            "author": "tester",
        })

        return store

    @pytest.fixture
    def sync_tools(self, store):
        """Create SyncTools instance."""
        return SyncTools(store)

    @pytest.mark.asyncio
    async def test_get_active_prs(self, sync_tools):
        """Test getting active PRs."""
        result = await sync_tools.get_active_prs("test-repo")

        assert "prs" in result
        assert len(result["prs"]) == 1
        assert result["prs"][0]["pr_number"] == 42

    @pytest.mark.asyncio
    async def test_get_pr_snapshot(self, sync_tools):
        """Test getting a PR snapshot."""
        result = await sync_tools.get_pr_snapshot("test-repo", 42)

        assert result["title"] == "Test PR"
        assert result["head_branch"] == "feature"

    @pytest.mark.asyncio
    async def test_get_pr_snapshot_not_found(self, sync_tools):
        """Test getting a non-existent PR."""
        result = await sync_tools.get_pr_snapshot("test-repo", 999)

        assert "error" in result

    @pytest.mark.asyncio
    async def test_get_statistics(self, sync_tools):
        """Test getting statistics."""
        result = await sync_tools.get_statistics()

        assert "pr_snapshots" in result
        assert result["pr_snapshots"] >= 1

    @pytest.mark.asyncio
    async def test_memo_operations(self, sync_tools, store):
        """Test memo get/set."""
        # Set memo
        set_result = await sync_tools.set_memo(
            "test-repo", 42, "todo", "- [ ] Fix tests"
        )
        assert set_result["success"] is True

        # Get memo
        get_result = await sync_tools.get_memo("test-repo", 42, "todo")
        assert get_result["exists"] is True
        assert get_result["content"] == "- [ ] Fix tests"

        # Get non-existent memo
        missing = await sync_tools.get_memo("test-repo", 42, "nonexistent")
        assert missing["exists"] is False


class TestMCPServer:
    """Tests for MCPServer request handling."""

    @pytest.fixture
    async def server(self, tmp_path):
        """Create and initialize an MCP server."""
        # Create a minimal git repo for the workspace
        import subprocess

        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )

        server = MCPServer(workspace_path=tmp_path)
        await server.initialize()
        return server

    @pytest.mark.asyncio
    async def test_initialize_request(self, server):
        """Test initialize request."""
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {},
        })

        assert response["id"] == 1
        assert "result" in response
        assert response["result"]["serverInfo"]["name"] == "github-sync"

    @pytest.mark.asyncio
    async def test_tools_list(self, server):
        """Test tools/list request."""
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        })

        assert response["id"] == 2
        assert "result" in response
        tools = response["result"]["tools"]
        assert len(tools) > 0

        # Check some expected tools exist
        tool_names = [t["name"] for t in tools]
        assert "git_status" in tool_names
        assert "read_file" in tool_names
        assert "workflow_start" in tool_names
        assert "get_active_prs" in tool_names

    @pytest.mark.asyncio
    async def test_tools_call_git_status(self, server):
        """Test calling git_status tool."""
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "git_status",
                "arguments": {},
            },
        })

        assert response["id"] == 3
        assert "result" in response
        content = response["result"]["content"][0]["text"]
        result = json.loads(content)
        assert "branch" in result

    @pytest.mark.asyncio
    async def test_tools_call_workflow(self, server):
        """Test workflow tools via MCP."""
        # Start workflow
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "workflow_start",
                "arguments": {
                    "workflow_type": "merge",
                    "repo_name": "test-repo",
                    "branch_name": "feature",
                },
            },
        })

        content = response["result"]["content"][0]["text"]
        result = json.loads(content)
        assert "workflow_id" in result

        # Check status
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "workflow_status",
                "arguments": {},
            },
        })

        content = response["result"]["content"][0]["text"]
        result = json.loads(content)
        assert result["active"] is True

    @pytest.mark.asyncio
    async def test_method_not_found(self, server):
        """Test unknown method."""
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "unknown/method",
            "params": {},
        })

        assert "error" in response
        assert response["error"]["code"] == -32601

    @pytest.mark.asyncio
    async def test_ping(self, server):
        """Test ping request."""
        response = await server._handle_request({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "ping",
            "params": {},
        })

        assert response["id"] == 7
        assert "result" in response
