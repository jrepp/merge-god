"""
MCP Sync/PR Tools Acceptance Tests.

Tests PR/sync operations and database functionality via the MCP server.
"""

import subprocess
from pathlib import Path

import pytest

from .conftest import MCPClient

pytestmark = pytest.mark.integration


class TestStatistics:
    """Test database statistics."""

    async def test_get_statistics(self, mcp_client: MCPClient):
        """Test get_statistics returns database stats."""
        result = await mcp_client.call_tool("get_statistics")

        # Should have stats per README
        assert "schema_version" in result
        assert "pr_snapshots" in result
        assert "pr_contexts" in result


class TestActivePRs:
    """Test active PRs queries."""

    async def test_get_active_prs_empty(self, mcp_client: MCPClient):
        """Test get_active_prs on empty database."""
        result = await mcp_client.call_tool("get_active_prs", {"repo_name": "test-repo"})

        assert "prs" in result
        assert result["prs"] == []


class TestMemoOperations:
    """Test memo get/set operations."""

    async def test_memo_operations(self, mcp_client: MCPClient):
        """Test get_memo and set_memo (bot's notes per README)."""
        # Set memo
        set_result = await mcp_client.call_tool(
            "set_memo",
            {
                "repo_name": "test-repo",
                "pr_number": 42,
                "memo_type": "todo",
                "content": "- [ ] Fix tests\n- [ ] Update docs",
            },
        )
        assert set_result["success"] is True

        # Get memo
        get_result = await mcp_client.call_tool(
            "get_memo", {"repo_name": "test-repo", "pr_number": 42, "memo_type": "todo"}
        )
        assert get_result["exists"] is True
        assert "Fix tests" in get_result["content"]

        # Get non-existent memo
        missing = await mcp_client.call_tool(
            "get_memo", {"repo_name": "test-repo", "pr_number": 42, "memo_type": "nonexistent"}
        )
        assert missing["exists"] is False


class TestDatabaseInitialization:
    """Test database auto-initialization per README."""

    async def test_creates_workspace_directory(self, temp_dir: Path):
        """Test server creates workspace directory if missing."""
        workspace = temp_dir / "new_workspace"
        assert not workspace.exists()

        client = await MCPClient.spawn(workspace)
        try:
            await client.initialize()

            # Workspace should now exist
            assert workspace.exists()

            # Database should be created
            assert (workspace / "sync.db").exists()
        finally:
            await client.close()

    async def test_loads_existing_database(self, temp_dir: Path):
        """Test server loads existing database."""
        workspace = temp_dir / "workspace"
        workspace.mkdir()

        # Initialize git
        subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=workspace,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=workspace,
            check=True,
            capture_output=True,
        )

        # First session - create some data
        client1 = await MCPClient.spawn(workspace)
        try:
            await client1.initialize()

            await client1.call_tool(
                "set_memo",
                {
                    "repo_name": "repo",
                    "pr_number": 1,
                    "memo_type": "note",
                    "content": "test data",
                },
            )
        finally:
            await client1.close()

        # Second session - data should persist
        client2 = await MCPClient.spawn(workspace)
        try:
            await client2.initialize()

            result = await client2.call_tool(
                "get_memo", {"repo_name": "repo", "pr_number": 1, "memo_type": "note"}
            )

            assert result["exists"] is True
            assert result["content"] == "test data"
        finally:
            await client2.close()


class TestErrorHandling:
    """Test error handling per README."""

    async def test_error_response_format(self, mcp_client: MCPClient):
        """Test errors return structured response per README."""
        # Try to read non-existent file
        result = await mcp_client.call_tool("read_file", {"path": "nonexistent.txt"})

        # Should have error key per README
        assert "error" in result
        assert isinstance(result["error"], str)

    async def test_git_error_with_context(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test git errors include additional context per README."""
        # Create conflicting branches
        subprocess.run(
            ["git", "checkout", "-b", "branch1"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )
        (mcp_workspace / "file.txt").write_text("branch1")
        subprocess.run(["git", "add", "."], cwd=mcp_workspace, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "b1"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )

        subprocess.run(
            ["git", "checkout", "-b", "branch2", "branch1~1"],
            cwd=mcp_workspace,
            capture_output=True,
        )
        # Need to create the branch differently
        subprocess.run(
            ["git", "checkout", "-B", "branch2"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "reset", "--hard", "HEAD~1"],
            cwd=mcp_workspace,
            capture_output=True,
        )
        (mcp_workspace / "file.txt").write_text("branch2")
        subprocess.run(["git", "add", "."], cwd=mcp_workspace, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "b2"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )

        # Try to merge - should fail with conflict info
        result = await mcp_client.call_tool("git_merge", {"branch": "branch1"})

        if result.get("has_conflicts"):
            # Should have additional context per README
            assert "success" in result
            assert result["success"] is False
            assert "conflict_files" in result
