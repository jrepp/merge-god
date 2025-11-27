"""
MCP Workflow Tools Acceptance Tests.

Tests workflow tracking via the MCP server using STDIO protocol.
Validates README examples for multi-step LLM operations.
"""

import pytest

from .conftest import MCPClient

pytestmark = pytest.mark.integration


class TestWorkflowLifecycle:
    """Test complete workflow lifecycle from README example."""

    async def test_multi_step_workflow_from_readme(self, mcp_client: MCPClient):
        """
        Test the multi-step workflow example from README:

        workflow_start -> workflow_step_start("fetch") -> git_fetch ->
        workflow_step_complete -> workflow_step_start("merge") ->
        git_merge -> workflow_step_complete -> workflow_complete
        """
        # Start workflow
        start_result = await mcp_client.call_tool(
            "workflow_start",
            {
                "workflow_type": "merge",
                "repo_name": "my-repo",
                "branch_name": "feature-branch",
            },
        )

        assert "workflow_id" in start_result
        workflow_id = start_result["workflow_id"]

        # Step 1: Fetch
        step1 = await mcp_client.call_tool("workflow_step_start", {"step_name": "fetch"})
        assert "step_id" in step1

        # Simulate fetch (would normally call git_fetch)
        await mcp_client.call_tool("git_status")  # Some operation

        step1_complete = await mcp_client.call_tool(
            "workflow_step_complete", {"summary": "Fetched latest changes"}
        )
        assert step1_complete["success"] is True

        # Step 2: Merge
        step2 = await mcp_client.call_tool("workflow_step_start", {"step_name": "merge"})
        assert step2["step_name"] == "merge"

        step2_complete = await mcp_client.call_tool(
            "workflow_step_complete", {"summary": "Merged main, no conflicts"}
        )
        assert step2_complete["success"] is True

        # Complete workflow
        complete_result = await mcp_client.call_tool(
            "workflow_complete", {"result": "Successfully merged main into feature-branch"}
        )

        assert complete_result["workflow_id"] == workflow_id
        assert complete_result["success"] is True
        assert "duration_ms" in complete_result


class TestWorkflowStepOutput:
    """Test workflow_step_output for storing data during steps."""

    async def test_workflow_with_step_output(self, mcp_client: MCPClient):
        """Test workflow_step_output for storing conflict data (per README)."""
        await mcp_client.call_tool(
            "workflow_start",
            {"workflow_type": "merge", "repo_name": "repo", "branch_name": "branch"},
        )

        await mcp_client.call_tool("workflow_step_start", {"step_name": "merge"})

        # Record conflict output like in README example
        output_result = await mcp_client.call_tool(
            "workflow_step_output",
            {"data": {"has_conflicts": True, "files": ["src/utils.py", "src/config.py"]}},
        )

        assert output_result.get("success") is True

        await mcp_client.call_tool(
            "workflow_step_complete", {"summary": "Resolved 2 conflicts"}
        )


class TestWorkflowPause:
    """Test pausing workflows for human review."""

    async def test_workflow_pause_for_human_review(self, mcp_client: MCPClient):
        """Test workflow_pause as shown in README."""
        start = await mcp_client.call_tool(
            "workflow_start",
            {"workflow_type": "merge", "repo_name": "repo", "branch_name": "branch"},
        )
        workflow_id = start["workflow_id"]

        # Pause for human review
        pause_result = await mcp_client.call_tool(
            "workflow_pause", {"reason": "Complex conflict in auth.py - need human decision"}
        )

        assert pause_result["status"] == "paused"
        assert pause_result["reason"] == "Complex conflict in auth.py - need human decision"

        # Verify workflow shows as paused
        active = await mcp_client.call_tool("workflow_list_active")
        paused_workflows = [w for w in active["workflows"] if w["status"] == "paused"]
        assert len(paused_workflows) == 1
        assert paused_workflows[0]["id"] == workflow_id


class TestWorkflowStepFail:
    """Test failing workflow steps."""

    async def test_workflow_step_fail(self, mcp_client: MCPClient):
        """Test failing a step with error details."""
        await mcp_client.call_tool(
            "workflow_start",
            {"workflow_type": "ci_fix", "repo_name": "repo", "branch_name": "branch"},
        )

        await mcp_client.call_tool("workflow_step_start", {"step_name": "run_tests"})

        fail_result = await mcp_client.call_tool(
            "workflow_step_fail",
            {"error_type": "TestFailure", "error_message": "3 tests failed in test_auth.py"},
        )

        assert fail_result["success"] is False
        assert fail_result["error_type"] == "TestFailure"


class TestWorkflowStatus:
    """Test workflow status queries."""

    async def test_workflow_status(self, mcp_client: MCPClient):
        """Test getting workflow status."""
        # No active workflow
        status1 = await mcp_client.call_tool("workflow_status")
        assert status1["active"] is False

        # Start workflow
        await mcp_client.call_tool(
            "workflow_start",
            {"workflow_type": "rebase", "repo_name": "repo", "branch_name": "feature"},
        )

        status2 = await mcp_client.call_tool("workflow_status")
        assert status2["active"] is True
        assert status2["type"] == "rebase"
        assert status2["repo"] == "repo"


class TestWorkflowStats:
    """Test workflow statistics."""

    async def test_workflow_stats(self, mcp_client: MCPClient):
        """Test getting workflow statistics."""
        # Complete a workflow first
        await mcp_client.call_tool(
            "workflow_start", {"workflow_type": "merge", "repo_name": "repo"}
        )
        await mcp_client.call_tool("workflow_complete", {"result": "done"})

        stats = await mcp_client.call_tool(
            "workflow_stats", {"repo_name": "repo", "workflow_type": "merge"}
        )

        assert stats["total_count"] >= 1
        assert "success_rate" in stats
        assert "avg_duration_ms" in stats


class TestAutomaticToolCallRecording:
    """Test automatic recording of tool calls within workflow steps."""

    async def test_automatic_tool_call_recording(self, mcp_client: MCPClient):
        """Test that tool calls are automatically recorded in workflow steps."""
        await mcp_client.call_tool(
            "workflow_start", {"workflow_type": "merge", "repo_name": "repo"}
        )

        await mcp_client.call_tool("workflow_step_start", {"step_name": "analyze"})

        # Make several tool calls
        await mcp_client.call_tool("git_status")
        await mcp_client.call_tool("git_log", {"count": 5})
        await mcp_client.call_tool("read_file", {"path": "README.md"})

        # Complete step and check tool call count
        step_complete = await mcp_client.call_tool(
            "workflow_step_complete", {"summary": "Analysis complete"}
        )

        # Tool calls should have been recorded
        # (3 explicit calls + the step_complete itself might count)
        assert step_complete["tool_calls"] >= 3
