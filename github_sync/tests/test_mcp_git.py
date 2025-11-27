"""
MCP Git Tools Acceptance Tests.

Tests git operations via the MCP server using STDIO protocol.
"""

import subprocess
from pathlib import Path

import pytest

from .conftest import MCPClient

pytestmark = pytest.mark.integration


class TestGitStatus:
    """Test git_status tool."""

    async def test_git_status_clean_repo(self, mcp_client: MCPClient):
        """Test git_status on clean repository."""
        result = await mcp_client.call_tool("git_status")

        # Matches README: "branch, staged/unstaged files, conflicts"
        assert "branch" in result
        assert "files" in result
        assert "clean" in result
        assert "has_conflicts" in result

        # Note: sync.db is created in workspace, so "untracked" may have it
        # But there should be no staged/unstaged/conflicts
        assert result["files"]["staged"] == []
        assert result["files"]["unstaged"] == []
        assert result["files"]["conflicts"] == []
        assert result["has_conflicts"] is False

    async def test_git_status_with_changes(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test git_status with unstaged changes."""
        # Create unstaged change
        (mcp_workspace / "new_file.txt").write_text("content")

        result = await mcp_client.call_tool("git_status")

        assert result["clean"] is False
        assert "new_file.txt" in result["files"]["untracked"]


class TestGitDiff:
    """Test git_diff tool."""

    async def test_git_diff(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test git_diff shows changes."""
        # Modify tracked file
        (mcp_workspace / "README.md").write_text("# Modified\n")

        result = await mcp_client.call_tool("git_diff")

        assert "diff" in result
        assert "Modified" in result["diff"]


class TestGitAddCommit:
    """Test git_add and git_commit tools."""

    async def test_git_add_and_commit(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test staging and committing files."""
        (mcp_workspace / "test.txt").write_text("test content")

        # Stage
        add_result = await mcp_client.call_tool("git_add", {"files": ["test.txt"]})
        assert add_result.get("success") is True

        # Commit
        commit_result = await mcp_client.call_tool("git_commit", {"message": "Add test file"})
        assert commit_result.get("success") is True
        assert "commit" in commit_result


class TestGitLog:
    """Test git_log tool."""

    async def test_git_log(self, mcp_client: MCPClient):
        """Test git_log returns commit history."""
        result = await mcp_client.call_tool("git_log", {"count": 5})

        assert "commits" in result
        assert len(result["commits"]) >= 1

        # Validate commit structure
        commit = result["commits"][0]
        assert "hash" in commit
        assert "subject" in commit
        assert "author" in commit


class TestGitCheckout:
    """Test git_checkout tool."""

    async def test_git_checkout_create_branch(self, mcp_client: MCPClient):
        """Test creating a new branch."""
        result = await mcp_client.call_tool(
            "git_checkout", {"ref": "test-branch", "create": True}
        )

        assert result.get("success") is True

        # Verify branch switch
        status = await mcp_client.call_tool("git_status")
        assert status["branch"] == "test-branch"


class TestGitMerge:
    """Test git_merge tool."""

    async def test_git_merge_with_conflict_detection(
        self, mcp_client: MCPClient, mcp_workspace: Path
    ):
        """Test merge detects conflicts properly."""
        # Get the default branch name (could be master or main)
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )
        default_branch = result.stdout.decode().strip()

        # Create a branch with changes
        subprocess.run(
            ["git", "checkout", "-b", "feature"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )
        (mcp_workspace / "conflict.txt").write_text("feature content\n")
        subprocess.run(["git", "add", "."], cwd=mcp_workspace, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Feature change"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )

        # Go back to default branch and make conflicting change
        subprocess.run(
            ["git", "checkout", default_branch],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )
        (mcp_workspace / "conflict.txt").write_text("main content\n")
        subprocess.run(["git", "add", "."], cwd=mcp_workspace, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Main change"],
            cwd=mcp_workspace,
            check=True,
            capture_output=True,
        )

        # Attempt merge
        result = await mcp_client.call_tool("git_merge", {"branch": "feature"})

        # Should detect conflict
        assert result.get("success") is False
        assert result.get("has_conflicts") is True
        assert "conflict_files" in result
