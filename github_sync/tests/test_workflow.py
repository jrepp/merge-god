"""Tests for multi-step workflow management."""

import pytest

from github_sync import SyncStore, Workflow, WorkflowManager, WorkflowStep


class TestWorkflowStore:
    """Tests for workflow database operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_create_workflow(self, store):
        """Test creating a workflow."""
        workflow_id = await store.create_workflow(
            workflow_type="merge",
            repo_name="test-repo",
            branch_name="feature-branch",
            pr_number=42,
            context={"target_branch": "main"},
        )

        assert workflow_id > 0

        workflow = await store.get_workflow(workflow_id)
        assert workflow is not None
        assert workflow["workflow_type"] == "merge"
        assert workflow["repo_name"] == "test-repo"
        assert workflow["branch_name"] == "feature-branch"
        assert workflow["pr_number"] == 42
        assert workflow["status"] == "created"
        assert workflow["context"]["target_branch"] == "main"

    @pytest.mark.asyncio
    async def test_workflow_lifecycle(self, store):
        """Test full workflow lifecycle."""
        import time

        # Create
        workflow_id = await store.create_workflow("merge", "repo", "branch")

        # Start
        await store.start_workflow(workflow_id)
        workflow = await store.get_workflow(workflow_id)
        assert workflow["status"] == "running"
        assert workflow["started_at"] is not None

        time.sleep(0.01)

        # Complete
        duration = await store.complete_workflow(
            workflow_id,
            success=True,
            result="Merged successfully",
        )

        assert duration >= 0

        workflow = await store.get_workflow(workflow_id)
        assert workflow["status"] == "completed"
        assert workflow["success"] == 1
        assert workflow["result"] == "Merged successfully"
        assert workflow["duration_ms"] is not None

    @pytest.mark.asyncio
    async def test_workflow_failure(self, store):
        """Test workflow failure."""
        workflow_id = await store.create_workflow("merge", "repo", "branch")
        await store.start_workflow(workflow_id)

        await store.complete_workflow(
            workflow_id,
            success=False,
            error_type="MergeConflict",
            error_message="Conflict in file.py",
        )

        workflow = await store.get_workflow(workflow_id)
        assert workflow["status"] == "failed"
        assert workflow["success"] == 0
        assert workflow["error_type"] == "MergeConflict"
        assert workflow["error_message"] == "Conflict in file.py"

    @pytest.mark.asyncio
    async def test_workflow_pause_resume(self, store):
        """Test pausing and resuming a workflow."""
        workflow_id = await store.create_workflow("merge", "repo", "branch")
        await store.start_workflow(workflow_id)

        # Pause
        await store.pause_workflow(workflow_id, "Waiting for user input")
        workflow = await store.get_workflow(workflow_id)
        assert workflow["status"] == "paused"

        # Resume
        await store.resume_workflow(workflow_id)
        workflow = await store.get_workflow(workflow_id)
        assert workflow["status"] == "running"

    @pytest.mark.asyncio
    async def test_workflow_context_update(self, store):
        """Test updating workflow context."""
        workflow_id = await store.create_workflow(
            "merge", "repo", "branch", context={"key1": "value1"}
        )

        # Merge update
        await store.update_workflow_context(
            workflow_id, {"key2": "value2"}, merge=True
        )

        workflow = await store.get_workflow(workflow_id)
        assert workflow["context"]["key1"] == "value1"
        assert workflow["context"]["key2"] == "value2"

        # Replace update
        await store.update_workflow_context(
            workflow_id, {"key3": "value3"}, merge=False
        )

        workflow = await store.get_workflow(workflow_id)
        assert "key1" not in workflow["context"]
        assert workflow["context"]["key3"] == "value3"

    @pytest.mark.asyncio
    async def test_get_active_workflows(self, store):
        """Test getting active workflows."""
        # Create workflows in different states
        wf1 = await store.create_workflow("merge", "repo1", "branch1")
        wf2 = await store.create_workflow("rebase", "repo1", "branch2")
        wf3 = await store.create_workflow("merge", "repo2", "branch3")

        await store.start_workflow(wf1)  # running
        await store.start_workflow(wf2)  # running
        await store.start_workflow(wf3)
        await store.complete_workflow(wf3, success=True)  # completed

        # All active
        active = await store.get_active_workflows()
        assert len(active) == 2

        # Filter by repo
        active = await store.get_active_workflows(repo_name="repo1")
        assert len(active) == 2

        # Filter by type
        active = await store.get_active_workflows(workflow_type="merge")
        assert len(active) == 1


class TestWorkflowSteps:
    """Tests for workflow step operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_add_and_complete_step(self, store):
        """Test adding and completing a workflow step."""
        import time

        workflow_id = await store.create_workflow("merge", "repo", "branch")

        step_id = await store.add_workflow_step(
            workflow_id,
            step_name="fetch",
            step_order=1,
            input_data={"remote": "origin"},
        )

        assert step_id > 0

        # Start step
        await store.start_workflow_step(step_id)

        time.sleep(0.01)

        # Complete step
        duration = await store.complete_workflow_step(
            step_id,
            success=True,
            output_data={"refs_fetched": 5},
        )

        assert duration >= 0

        steps = await store.get_workflow_steps(workflow_id)
        assert len(steps) == 1
        assert steps[0]["step_name"] == "fetch"
        assert steps[0]["status"] == "completed"
        assert steps[0]["success"] == 1
        assert steps[0]["input_data"]["remote"] == "origin"
        assert steps[0]["output_data"]["refs_fetched"] == 5

    @pytest.mark.asyncio
    async def test_step_tool_call_tracking(self, store):
        """Test tracking tool calls within a step."""
        workflow_id = await store.create_workflow("merge", "repo", "branch")
        step_id = await store.add_workflow_step(workflow_id, "resolve_conflicts", 1)

        # Increment tool calls
        count1 = await store.increment_step_tool_calls(step_id)
        assert count1 == 1

        count2 = await store.increment_step_tool_calls(step_id)
        assert count2 == 2

        count3 = await store.increment_step_tool_calls(step_id)
        assert count3 == 3

        steps = await store.get_workflow_steps(workflow_id)
        assert steps[0]["tool_calls"] == 3

    @pytest.mark.asyncio
    async def test_multiple_steps_ordering(self, store):
        """Test multiple steps maintain order."""
        workflow_id = await store.create_workflow("merge", "repo", "branch")

        await store.add_workflow_step(workflow_id, "fetch", 1)
        await store.add_workflow_step(workflow_id, "merge", 2)
        await store.add_workflow_step(workflow_id, "push", 3)

        steps = await store.get_workflow_steps(workflow_id)

        assert len(steps) == 3
        assert steps[0]["step_name"] == "fetch"
        assert steps[0]["step_order"] == 1
        assert steps[1]["step_name"] == "merge"
        assert steps[1]["step_order"] == 2
        assert steps[2]["step_name"] == "push"
        assert steps[2]["step_order"] == 3

    @pytest.mark.asyncio
    async def test_step_failure(self, store):
        """Test step failure with error info."""
        workflow_id = await store.create_workflow("merge", "repo", "branch")
        step_id = await store.add_workflow_step(workflow_id, "merge", 1)

        await store.start_workflow_step(step_id)
        await store.complete_workflow_step(
            step_id,
            success=False,
            error_type="MergeConflict",
            error_message="Conflict in file.py line 42",
        )

        steps = await store.get_workflow_steps(workflow_id)
        assert steps[0]["success"] == 0
        assert steps[0]["error_type"] == "MergeConflict"
        assert steps[0]["error_message"] == "Conflict in file.py line 42"


class TestWorkflowManager:
    """Tests for WorkflowManager class."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.fixture
    def manager(self, store):
        """Create a WorkflowManager."""
        return WorkflowManager(store)

    @pytest.mark.asyncio
    async def test_workflow_context_manager(self, manager):
        """Test workflow as context manager."""
        async with manager.workflow("merge", "repo", "branch") as wf:
            assert wf.workflow_id > 0
            assert wf.workflow_type == "merge"
            assert wf.repo_name == "repo"

        # After context manager, workflow should be completed
        workflow = await manager.get_workflow(wf.workflow_id)
        assert workflow["status"] == "completed"

    @pytest.mark.asyncio
    async def test_workflow_with_steps(self, manager):
        """Test workflow with multiple steps."""
        async with manager.workflow("merge", "repo", "branch") as wf:
            async with wf.step("fetch") as step:
                await step.record_tool_call()

            async with wf.step("merge") as step:
                await step.record_tool_call()
                await step.record_tool_call()
                step.set_output({"merged": True})

            async with wf.step("push") as step:
                await step.record_tool_call()

        workflow = await manager.get_workflow(wf.workflow_id)
        assert workflow["status"] == "completed"
        assert len(workflow["steps"]) == 3

        assert workflow["steps"][0]["step_name"] == "fetch"
        assert workflow["steps"][0]["tool_calls"] == 1

        assert workflow["steps"][1]["step_name"] == "merge"
        assert workflow["steps"][1]["tool_calls"] == 2
        assert workflow["steps"][1]["output_data"]["merged"] is True

        assert workflow["steps"][2]["step_name"] == "push"

    @pytest.mark.asyncio
    async def test_workflow_step_failure(self, manager):
        """Test workflow when a step fails."""
        try:
            async with manager.workflow("merge", "repo", "branch") as wf:
                async with wf.step("fetch") as step:
                    pass

                async with wf.step("merge") as step:
                    step.fail("MergeConflict", "Conflict in file.py")

        except Exception:
            pass  # Step failure shouldn't raise

        workflow = await manager.get_workflow(wf.workflow_id)
        # Workflow completes but with failure
        assert workflow["status"] in ("completed", "failed")

    @pytest.mark.asyncio
    async def test_workflow_exception(self, manager):
        """Test workflow when an exception is raised."""
        with pytest.raises(ValueError):
            async with manager.workflow("merge", "repo", "branch") as wf:
                async with wf.step("fetch") as step:
                    raise ValueError("Test error")

        workflow = await manager.get_workflow(wf.workflow_id)
        assert workflow["status"] == "failed"
        assert workflow["error_type"] == "ValueError"
        assert workflow["error_message"] == "Test error"

    @pytest.mark.asyncio
    async def test_merge_workflow_convenience(self, manager):
        """Test merge_workflow convenience method."""
        async with manager.merge_workflow("repo", "feature", target_branch="develop") as wf:
            assert wf.workflow_type == "merge"
            assert wf._context["target_branch"] == "develop"

    @pytest.mark.asyncio
    async def test_rebase_workflow_convenience(self, manager):
        """Test rebase_workflow convenience method."""
        async with manager.rebase_workflow("repo", "feature", onto_branch="main") as wf:
            assert wf.workflow_type == "rebase"
            assert wf._context["onto_branch"] == "main"

    @pytest.mark.asyncio
    async def test_pr_review_workflow_convenience(self, manager):
        """Test pr_review_workflow convenience method."""
        async with manager.pr_review_workflow("repo", pr_number=42) as wf:
            assert wf.workflow_type == "pr_review"
            assert wf.pr_number == 42

    @pytest.mark.asyncio
    async def test_ci_fix_workflow_convenience(self, manager):
        """Test ci_fix_workflow convenience method."""
        async with manager.ci_fix_workflow("repo", "branch", ci_check="lint") as wf:
            assert wf.workflow_type == "ci_fix"
            assert wf._context["ci_check"] == "lint"

    @pytest.mark.asyncio
    async def test_workflow_stats(self, manager, store):
        """Test getting workflow statistics."""
        # Create some completed workflows
        for i in range(3):
            wf_id = await store.create_workflow("merge", "repo", f"branch{i}")
            await store.start_workflow(wf_id)
            await store.complete_workflow(wf_id, success=True)

        for i in range(2):
            wf_id = await store.create_workflow("merge", "repo", f"fail{i}")
            await store.start_workflow(wf_id)
            await store.complete_workflow(wf_id, success=False)

        stats = await manager.get_stats("repo", "merge")

        assert stats["total_count"] == 5
        assert stats["success_count"] == 3
        assert stats["failure_count"] == 2
        assert stats["success_rate"] == 60.0


class TestWorkflowStats:
    """Tests for workflow statistics."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a test store."""
        store = SyncStore(tmp_path / "test.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_workflow_stats_empty(self, store):
        """Test stats with no workflows."""
        stats = await store.get_workflow_stats()

        assert stats["total_count"] == 0
        assert stats["success_rate"] == 0

    @pytest.mark.asyncio
    async def test_workflow_stats_filtering(self, store):
        """Test stats filtering by repo and type."""
        # Create workflows for different repos/types
        for repo in ["repo1", "repo2"]:
            for wtype in ["merge", "rebase"]:
                wf_id = await store.create_workflow(wtype, repo, "branch")
                await store.start_workflow(wf_id)
                await store.complete_workflow(wf_id, success=True)

        # All workflows
        stats = await store.get_workflow_stats()
        assert stats["total_count"] == 4

        # Filter by repo
        stats = await store.get_workflow_stats(repo_name="repo1")
        assert stats["total_count"] == 2

        # Filter by type
        stats = await store.get_workflow_stats(workflow_type="merge")
        assert stats["total_count"] == 2

        # Filter by both
        stats = await store.get_workflow_stats(repo_name="repo1", workflow_type="merge")
        assert stats["total_count"] == 1
