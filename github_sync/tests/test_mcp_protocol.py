"""
MCP Protocol Conformance Tests.

Tests that the MCP server conforms to the MCP protocol specification
using JSON-RPC 2.0 over STDIO.
"""

import pytest

from .conftest import MCPClient

pytestmark = pytest.mark.integration


class TestMCPInitialization:
    """Test MCP server initialization."""

    async def test_initialize_returns_valid_response(self, mcp_client_uninit: MCPClient):
        """Test that initialize returns proper MCP response."""
        result = await mcp_client_uninit.initialize()

        # Validate required fields per MCP spec
        assert "protocolVersion" in result
        assert "capabilities" in result
        assert "serverInfo" in result

        # Validate server info
        assert result["serverInfo"]["name"] == "github-sync"
        assert "version" in result["serverInfo"]

        # Validate capabilities includes tools
        assert "tools" in result["capabilities"]


class TestMCPToolsDiscovery:
    """Test MCP tools discovery."""

    async def test_tools_list_returns_all_documented_tools(self, mcp_client: MCPClient):
        """Test that tools/list returns all tools documented in README."""
        tools = await mcp_client.list_tools()
        tool_names = {t["name"] for t in tools}

        # Git tools from README
        git_tools = {
            "git_status",
            "git_diff",
            "git_fetch",
            "git_merge",
            "git_rebase",
            "git_add",
            "git_commit",
            "git_push",
            "git_log",
            "git_checkout",
        }
        assert git_tools.issubset(tool_names), f"Missing git tools: {git_tools - tool_names}"

        # File tools from README
        file_tools = {"read_file", "write_file", "list_directory", "file_exists"}
        assert file_tools.issubset(tool_names), f"Missing file tools: {file_tools - tool_names}"

        # Workflow tools from README
        workflow_tools = {
            "workflow_start",
            "workflow_step_start",
            "workflow_step_complete",
            "workflow_step_fail",
            "workflow_step_output",
            "workflow_complete",
            "workflow_pause",
            "workflow_status",
            "workflow_get",
            "workflow_list_active",
            "workflow_stats",
        }
        assert workflow_tools.issubset(
            tool_names
        ), f"Missing workflow tools: {workflow_tools - tool_names}"

        # PR/Sync tools from README
        sync_tools = {
            "get_active_prs",
            "get_pr_snapshot",
            "get_pr_context",
            "get_statistics",
            "get_memo",
            "set_memo",
        }
        assert sync_tools.issubset(tool_names), f"Missing sync tools: {sync_tools - tool_names}"

    async def test_tools_have_valid_schemas(self, mcp_client: MCPClient):
        """Test that all tools have valid input schemas."""
        tools = await mcp_client.list_tools()

        for tool in tools:
            assert "name" in tool, "Tool must have name"
            assert "description" in tool, f"Tool {tool['name']} must have description"
            assert "inputSchema" in tool, f"Tool {tool['name']} must have inputSchema"

            schema = tool["inputSchema"]
            assert (
                schema.get("type") == "object"
            ), f"Tool {tool['name']} schema must be object type"


class TestMCPProtocolMethods:
    """Test MCP protocol methods."""

    async def test_ping(self, mcp_client: MCPClient):
        """Test ping request."""
        assert await mcp_client.ping()

    async def test_unknown_method_returns_error(self, mcp_client: MCPClient):
        """Test that unknown methods return proper JSON-RPC error."""
        response = await mcp_client.send_request("unknown/method")

        assert "error" in response
        assert response["error"]["code"] == -32601  # Method not found

    async def test_invalid_tool_returns_error(self, mcp_client: MCPClient):
        """Test that calling unknown tool returns error in result."""
        result = await mcp_client.call_tool("nonexistent_tool", {})

        assert "error" in result
