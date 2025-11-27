"""
Multi-step workflow management for LLM-driven operations.

This module provides WorkflowManager for tracking complex, multi-step operations
where an LLM may perform multiple tool calls to complete a task.

Common workflows:
- Merge: fetch -> merge -> resolve conflicts (multiple rounds) -> push
- Rebase: fetch -> rebase -> resolve conflicts -> push
- PR Review: fetch context -> analyze feedback -> make changes -> push
- CI Fix: analyze failure -> fix issue -> run tests -> push

Example:
    from github_sync import SyncStore, WorkflowManager

    store = SyncStore("sync.db")
    await store.initialize()

    wm = WorkflowManager(store)

    # Start a merge workflow
    async with wm.merge_workflow("repo", "feature-branch") as workflow:
        # Step 1: Fetch
        async with workflow.step("fetch") as step:
            await step.record_tool_call()
            # ... do fetch ...

        # Step 2: Merge
        async with workflow.step("merge") as step:
            result = ...  # git merge
            if has_conflicts:
                # Multiple rounds of conflict resolution
                while has_conflicts:
                    await step.record_tool_call()
                    # ... resolve conflict ...
                step.set_output({"conflicts_resolved": 5})

        # Step 3: Push
        async with workflow.step("push") as step:
            await step.record_tool_call()
            # ... git push ...

    print(f"Workflow completed in {workflow.duration_ms}ms")
"""

from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, AsyncIterator

from github_sync.sync_store import SyncStore


@dataclass
class WorkflowStep:
    """Context manager for a workflow step."""

    store: SyncStore
    workflow_id: int
    step_id: int
    step_name: str
    _input_data: dict[str, Any] = field(default_factory=dict)
    _output_data: dict[str, Any] = field(default_factory=dict)
    _success: bool = True
    _error_type: str | None = None
    _error_message: str | None = None
    duration_ms: int = 0
    tool_calls: int = 0

    async def record_tool_call(self) -> int:
        """Record a tool call within this step. Returns new count."""
        self.tool_calls = await self.store.increment_step_tool_calls(self.step_id)
        return self.tool_calls

    def set_output(self, data: dict[str, Any]) -> None:
        """Set output data for this step."""
        self._output_data.update(data)

    def fail(self, error_type: str, error_message: str) -> None:
        """Mark step as failed."""
        self._success = False
        self._error_type = error_type
        self._error_message = error_message


@dataclass
class Workflow:
    """Context manager for a workflow."""

    store: SyncStore
    workflow_id: int
    workflow_type: str
    repo_name: str
    branch_name: str | None
    pr_number: int | None
    _context: dict[str, Any] = field(default_factory=dict)
    _success: bool = True
    _error_type: str | None = None
    _error_message: str | None = None
    _result: str | None = None
    duration_ms: int = 0
    _step_order: int = 0
    _current_step: WorkflowStep | None = None

    @asynccontextmanager
    async def step(
        self, step_name: str, input_data: dict[str, Any] | None = None
    ) -> AsyncIterator[WorkflowStep]:
        """
        Create and execute a workflow step.

        Usage:
            async with workflow.step("merge") as step:
                await step.record_tool_call()
                # do work...
                step.set_output({"result": "done"})
        """
        self._step_order += 1
        step_id = await self.store.add_workflow_step(
            self.workflow_id,
            step_name,
            self._step_order,
            input_data,
        )

        # Update workflow's current step
        await self.store.update_workflow_step(self.workflow_id, step_name)

        step = WorkflowStep(
            store=self.store,
            workflow_id=self.workflow_id,
            step_id=step_id,
            step_name=step_name,
            _input_data=input_data or {},
        )
        self._current_step = step

        # Start step
        await self.store.start_workflow_step(step_id)

        try:
            yield step
            # Complete step successfully
            step.duration_ms = await self.store.complete_workflow_step(
                step_id,
                success=step._success,
                output_data=step._output_data,
                error_type=step._error_type,
                error_message=step._error_message,
            )
            if not step._success:
                self._success = False
                self._error_type = step._error_type
                self._error_message = step._error_message
        except Exception as e:
            # Complete step with error
            step.duration_ms = await self.store.complete_workflow_step(
                step_id,
                success=False,
                error_type=type(e).__name__,
                error_message=str(e),
            )
            self._success = False
            self._error_type = type(e).__name__
            self._error_message = str(e)
            raise

    def update_context(self, data: dict[str, Any]) -> None:
        """Update workflow context (stored in memory, synced on completion)."""
        self._context.update(data)

    def set_result(self, result: str) -> None:
        """Set the workflow result message."""
        self._result = result

    def fail(self, error_type: str, error_message: str) -> None:
        """Mark workflow as failed."""
        self._success = False
        self._error_type = error_type
        self._error_message = error_message


class WorkflowManager:
    """
    High-level manager for multi-step LLM workflows.

    Provides context managers for common workflow types that automatically
    handle timing, step tracking, and error recording.
    """

    def __init__(self, store: SyncStore):
        """
        Initialize WorkflowManager.

        Args:
            store: SyncStore for persistence
        """
        self.store = store

    @asynccontextmanager
    async def workflow(
        self,
        workflow_type: str,
        repo_name: str,
        branch_name: str | None = None,
        pr_number: int | None = None,
        context: dict[str, Any] | None = None,
    ) -> AsyncIterator[Workflow]:
        """
        Create and execute a workflow.

        Usage:
            async with wm.workflow("merge", "repo", "branch") as wf:
                async with wf.step("fetch") as step:
                    # do work...
        """
        workflow_id = await self.store.create_workflow(
            workflow_type=workflow_type,
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            context=context,
        )

        wf = Workflow(
            store=self.store,
            workflow_id=workflow_id,
            workflow_type=workflow_type,
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            _context=context or {},
        )

        # Start workflow
        await self.store.start_workflow(workflow_id)

        try:
            yield wf
            # Sync context to database
            if wf._context:
                await self.store.update_workflow_context(workflow_id, wf._context)
            # Complete workflow
            wf.duration_ms = await self.store.complete_workflow(
                workflow_id,
                success=wf._success,
                result=wf._result,
                error_type=wf._error_type,
                error_message=wf._error_message,
            )
        except Exception as e:
            # Complete workflow with error
            wf.duration_ms = await self.store.complete_workflow(
                workflow_id,
                success=False,
                error_type=type(e).__name__,
                error_message=str(e),
            )
            raise

    # Convenience methods for common workflow types

    @asynccontextmanager
    async def merge_workflow(
        self,
        repo_name: str,
        branch_name: str,
        target_branch: str = "main",
        pr_number: int | None = None,
    ) -> AsyncIterator[Workflow]:
        """Create a merge workflow."""
        async with self.workflow(
            workflow_type="merge",
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            context={"target_branch": target_branch},
        ) as wf:
            yield wf

    @asynccontextmanager
    async def rebase_workflow(
        self,
        repo_name: str,
        branch_name: str,
        onto_branch: str = "main",
        pr_number: int | None = None,
    ) -> AsyncIterator[Workflow]:
        """Create a rebase workflow."""
        async with self.workflow(
            workflow_type="rebase",
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            context={"onto_branch": onto_branch},
        ) as wf:
            yield wf

    @asynccontextmanager
    async def pr_review_workflow(
        self,
        repo_name: str,
        pr_number: int,
        branch_name: str | None = None,
    ) -> AsyncIterator[Workflow]:
        """Create a PR review workflow."""
        async with self.workflow(
            workflow_type="pr_review",
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
        ) as wf:
            yield wf

    @asynccontextmanager
    async def ci_fix_workflow(
        self,
        repo_name: str,
        branch_name: str,
        pr_number: int | None = None,
        ci_check: str | None = None,
    ) -> AsyncIterator[Workflow]:
        """Create a CI fix workflow."""
        async with self.workflow(
            workflow_type="ci_fix",
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            context={"ci_check": ci_check} if ci_check else None,
        ) as wf:
            yield wf

    # Query methods

    async def get_active_workflows(
        self, repo_name: str | None = None, workflow_type: str | None = None
    ) -> list[dict[str, Any]]:
        """Get active workflows."""
        return await self.store.get_active_workflows(repo_name, workflow_type)

    async def get_workflow(self, workflow_id: int) -> dict[str, Any] | None:
        """Get a workflow by ID with its steps."""
        workflow = await self.store.get_workflow(workflow_id)
        if workflow:
            workflow["steps"] = await self.store.get_workflow_steps(workflow_id)
        return workflow

    async def get_stats(
        self, repo_name: str | None = None, workflow_type: str | None = None
    ) -> dict[str, Any]:
        """Get workflow statistics."""
        return await self.store.get_workflow_stats(repo_name, workflow_type)

    async def resume_workflow(self, workflow_id: int) -> Workflow:
        """
        Resume a paused workflow.

        Returns a Workflow object that can be used to continue execution.
        Note: This returns a Workflow but NOT as a context manager.
        The caller is responsible for calling complete_workflow.
        """
        workflow_data = await self.store.get_workflow(workflow_id)
        if not workflow_data:
            raise ValueError(f"Workflow {workflow_id} not found")

        if workflow_data["status"] != "paused":
            raise ValueError(f"Workflow {workflow_id} is not paused (status: {workflow_data['status']})")

        await self.store.resume_workflow(workflow_id)

        # Get existing step count
        steps = await self.store.get_workflow_steps(workflow_id)
        step_order = len(steps)

        return Workflow(
            store=self.store,
            workflow_id=workflow_id,
            workflow_type=workflow_data["workflow_type"],
            repo_name=workflow_data["repo_name"],
            branch_name=workflow_data.get("branch_name"),
            pr_number=workflow_data.get("pr_number"),
            _context=workflow_data.get("context", {}),
            _step_order=step_order,
        )

    async def pause_current_workflow(self, workflow_id: int, reason: str) -> None:
        """Pause a workflow for later resumption."""
        await self.store.pause_workflow(workflow_id, reason)

    async def complete_resumed_workflow(
        self,
        workflow: Workflow,
        success: bool,
        result: str | None = None,
        error_type: str | None = None,
        error_message: str | None = None,
    ) -> int:
        """
        Complete a resumed workflow.

        Use this after resuming a workflow with resume_workflow().
        """
        if workflow._context:
            await self.store.update_workflow_context(workflow.workflow_id, workflow._context)

        return await self.store.complete_workflow(
            workflow.workflow_id,
            success=success,
            result=result,
            error_type=error_type,
            error_message=error_message,
        )
