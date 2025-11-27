"""
MCP File Tools Acceptance Tests.

Tests file operations via the MCP server using STDIO protocol.
"""

from pathlib import Path

import pytest

from .conftest import MCPClient

pytestmark = pytest.mark.integration


class TestReadFile:
    """Test read_file tool."""

    async def test_read_file(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test reading a file."""
        (mcp_workspace / "test.txt").write_text("Hello, World!")

        result = await mcp_client.call_tool("read_file", {"path": "test.txt"})

        assert result["content"] == "Hello, World!"
        assert result["size"] == 13

    async def test_read_file_not_found(self, mcp_client: MCPClient):
        """Test reading non-existent file returns error."""
        result = await mcp_client.call_tool("read_file", {"path": "nonexistent.txt"})

        assert "error" in result


class TestWriteFile:
    """Test write_file tool."""

    async def test_write_file(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test writing a file."""
        result = await mcp_client.call_tool(
            "write_file", {"path": "output.txt", "content": "Test content"}
        )

        assert result.get("success") is True
        assert (mcp_workspace / "output.txt").read_text() == "Test content"

    async def test_write_file_creates_directories(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test write_file creates parent directories (per README)."""
        result = await mcp_client.call_tool(
            "write_file", {"path": "subdir/nested/file.txt", "content": "nested content"}
        )

        assert result.get("success") is True
        assert (mcp_workspace / "subdir" / "nested" / "file.txt").read_text() == "nested content"


class TestListDirectory:
    """Test list_directory tool."""

    async def test_list_directory(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test listing directory contents."""
        (mcp_workspace / "file1.txt").write_text("1")
        (mcp_workspace / "file2.txt").write_text("2")
        (mcp_workspace / "subdir").mkdir()

        result = await mcp_client.call_tool("list_directory", {"path": "."})

        assert "entries" in result
        names = [e["name"] for e in result["entries"]]
        assert "file1.txt" in names
        assert "file2.txt" in names
        assert "subdir" in names

    async def test_list_directory_with_glob(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test list_directory with glob pattern (per README)."""
        (mcp_workspace / "test1.txt").write_text("1")
        (mcp_workspace / "test2.txt").write_text("2")
        (mcp_workspace / "other.md").write_text("md")

        result = await mcp_client.call_tool("list_directory", {"path": ".", "pattern": "*.txt"})

        names = [e["name"] for e in result["entries"]]
        assert "test1.txt" in names
        assert "test2.txt" in names
        assert "other.md" not in names


class TestFileExists:
    """Test file_exists tool."""

    async def test_file_exists(self, mcp_client: MCPClient, mcp_workspace: Path):
        """Test checking file existence."""
        (mcp_workspace / "exists.txt").write_text("yes")

        exists_result = await mcp_client.call_tool("file_exists", {"path": "exists.txt"})
        assert exists_result["exists"] is True
        assert exists_result["is_file"] is True

        not_exists_result = await mcp_client.call_tool("file_exists", {"path": "nope.txt"})
        assert not_exists_result["exists"] is False
