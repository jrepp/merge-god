# LLM Integration Guide

This guide covers how to integrate the `github_sync` workflow system with a tool-calling LLM for autonomous git operations like merges, rebases, and PR reviews.

## Overview

The workflow system provides:

- **Workflow tracking** - Track multi-step operations (merge, rebase, pr_review, ci_fix)
- **Step management** - Individual steps with tool call counting
- **Context storage** - Persist state across steps
- **Timing/audit trail** - Automatic timing and error recording
- **Pause/resume** - Human-in-the-loop support

This document explains how to wire these into your LLM tool-calling loop.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Application                          │
├─────────────────────────────────────────────────────────────────┤
│  1. Receive trigger (PR comment, webhook, manual)                │
│  2. Create WorkflowExecutor                                      │
│  3. Call executor.execute_merge(repo, branch, target)            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     WorkflowExecutor                             │
├─────────────────────────────────────────────────────────────────┤
│  For each step:                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  1. Build system prompt with workflow/step context          ││
│  │  2. Call LLM with available tools                           ││
│  │  3. For each tool call:                                     ││
│  │     - Auto-record: step.record_tool_call()                  ││
│  │     - Execute tool (git/fs/workflow control)                ││
│  │     - Return result to LLM                                  ││
│  │  4. Loop until step_complete or error                       ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌──────────┐     ┌──────────┐     ┌──────────────┐
   │ Git Tools│     │ FS Tools │     │Workflow Tools│
   ├──────────┤     ├──────────┤     ├──────────────┤
   │git_status│     │read_file │     │step_complete │
   │git_diff  │     │write_file│     │step_output   │
   │git_add   │     │list_dir  │     │request_pause │
   │git_commit│     │...       │     │abort_workflow│
   │git_push  │                      │get_status    │
   │git_merge │                      └──────────────┘
   │git_rebase│
   │git_fetch │
   └──────────┘
```

---

## Core Design Decisions

### 1. Workflow Lifecycle Ownership

**Recommended: Orchestrator-driven**

The orchestrator (your code) creates and manages workflows. The LLM focuses on executing work within each step.

```
Orchestrator creates workflow → defines steps → LLM executes each step → orchestrator completes
```

Benefits:

- Predictable, controllable flow
- LLM focuses on doing work, not managing state
- You maintain control of the overall operation

Alternative approaches:

- **LLM-driven**: LLM creates/manages workflows (risk: inconsistent state)
- **Hybrid**: Orchestrator creates workflow, LLM can signal transitions

### 2. Automatic Tool Call Recording

Tool calls should be recorded automatically in your loop, not by the LLM:

```python
async def execute_tool(tool_name: str, args: dict) -> Any:
    # Automatically record before execution
    if self.current_step:
        await self.current_step.record_tool_call()

    # Execute the actual tool
    result = await self.tools[tool_name](**args)
    return result
```

The LLM never needs to think about recording - it just happens.

### 3. LLM Context via System Prompt

Inject workflow state into the system prompt:

```python
def build_system_prompt(workflow: Workflow, step: WorkflowStep, step_def: StepDefinition) -> str:
    return f"""
You are performing a {workflow.workflow_type} operation on {workflow.repo_name}/{workflow.branch_name}.

## Current Step: {step.step_name}
{step_def.instructions}

## Context
{json.dumps(workflow._context, indent=2)}

## Progress
- Steps completed: {workflow._step_order - 1}
- Tool calls this step: {step.tool_calls}

## When Done
Call `step_complete` when you've finished this step's objective.
Call `request_pause` if you need human input.
"""
```

---

## Workflow Tools for LLM

Give the LLM these control tools alongside git/filesystem tools:

### Query Tools (Read-only)

| Tool | Description | Returns |
|------|-------------|---------|
| `get_workflow_status` | Get current workflow state | `{workflow_id, type, current_step, context, steps_completed}` |
| `get_step_context` | Get current step details | `{step_name, input_data, tool_calls, elapsed_time}` |

### Control Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `step_complete` | Signal current step is done | `summary: str` |
| `step_output` | Record structured output data | `data: dict` |
| `request_pause` | Pause for human review | `reason: str` |
| `abort_workflow` | Abort due to unrecoverable error | `error_type: str, message: str` |

### Tool Definitions (OpenAI Format)

```python
WORKFLOW_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_workflow_status",
            "description": "Get current workflow state including completed steps and context",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "step_complete",
            "description": "Signal that the current step is complete. Call when you've achieved the step's objective.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Brief summary of what was accomplished"
                    }
                },
                "required": ["summary"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "step_output",
            "description": "Record structured output data from the current step",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "object",
                        "description": "Structured data to record as step output"
                    }
                },
                "required": ["data"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "request_pause",
            "description": "Pause the workflow to request human review or input",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Why human input is needed"
                    }
                },
                "required": ["reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "abort_workflow",
            "description": "Abort the workflow due to an unrecoverable error",
            "parameters": {
                "type": "object",
                "properties": {
                    "error_type": {
                        "type": "string",
                        "description": "Category of error (e.g., 'MergeConflict', 'TestFailure')"
                    },
                    "message": {
                        "type": "string",
                        "description": "Detailed error message"
                    }
                },
                "required": ["error_type", "message"]
            }
        }
    }
]
```

---

## Step Definitions

Define expected steps with instructions, allowed tools, and budgets:

```python
from dataclasses import dataclass, field
from typing import Callable

@dataclass
class StepBudget:
    """Resource limits for a step."""
    max_tool_calls: int = 50
    max_seconds: int = 300
    max_file_edits: int = 20

@dataclass
class StepDefinition:
    """Definition of a workflow step."""
    name: str
    instructions: str
    initial_prompt: str
    allowed_tools: list[str] | None = None  # None = all tools
    required_tools: list[str] | None = None  # Must use at least these
    budget: StepBudget | None = None
    skip_condition: Callable | None = None  # Skip if returns True
    input_data: dict = field(default_factory=dict)
```

### Example Step Definitions

```python
MERGE_WORKFLOW_STEPS = {
    "fetch": StepDefinition(
        name="fetch",
        instructions="""
Fetch the latest changes from the remote repository.
This ensures you have the most recent commits before merging.
""",
        initial_prompt="Fetch the latest changes from origin.",
        allowed_tools=["git_fetch", "git_status", "step_complete"],
        budget=StepBudget(max_tool_calls=5, max_seconds=60),
    ),

    "merge": StepDefinition(
        name="merge",
        instructions="""
Attempt to merge the target branch into the current branch.
Check the result - if there are conflicts, record them in step_output
but don't try to resolve them here.
""",
        initial_prompt="Merge {target_branch} into the current branch. Report any conflicts.",
        allowed_tools=["git_merge", "git_status", "step_complete", "step_output"],
        budget=StepBudget(max_tool_calls=10, max_seconds=60),
    ),

    "resolve_conflicts": StepDefinition(
        name="resolve_conflicts",
        instructions="""
Resolve merge conflicts in the listed files.
For each conflicted file:
1. Read the file to understand the conflict markers
2. Decide how to resolve (keep ours, keep theirs, or combine)
3. Write the resolved content (remove conflict markers)
4. Stage the file with git_add

Be careful to preserve important changes from both sides when appropriate.
If you're unsure how to resolve a conflict, use request_pause.
""",
        initial_prompt="Resolve the merge conflicts in these files: {conflict_files}",
        allowed_tools=[
            "read_file", "write_file", "git_add", "git_status", "git_diff",
            "step_output", "step_complete", "request_pause"
        ],
        budget=StepBudget(max_tool_calls=100, max_seconds=600, max_file_edits=50),
        skip_condition=lambda wf: not wf._context.get("has_conflicts", False),
    ),

    "validate": StepDefinition(
        name="validate",
        instructions="""
Validate the merge result:
1. Check git status is clean (no uncommitted changes)
2. Run any relevant tests if available
3. Check for obvious syntax errors

If validation fails, report the issues via step_output.
""",
        initial_prompt="Validate the merge. Check status and run basic validation.",
        allowed_tools=[
            "git_status", "run_command", "read_file",
            "step_output", "step_complete", "request_pause", "abort_workflow"
        ],
        budget=StepBudget(max_tool_calls=30, max_seconds=300),
    ),

    "push": StepDefinition(
        name="push",
        instructions="""
Push the changes to the remote repository.
If the push fails due to remote changes, report the issue.
""",
        initial_prompt="Push the merged changes to origin.",
        allowed_tools=["git_push", "git_status", "step_complete", "abort_workflow"],
        budget=StepBudget(max_tool_calls=5, max_seconds=60),
    ),
}
```

---

## WorkflowExecutor Implementation

```python
import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Callable

from github_sync import SyncStore, WorkflowManager, Workflow, WorkflowStep


@dataclass
class StepCompleteSignal:
    summary: str

@dataclass
class PauseSignal:
    reason: str

@dataclass
class AbortSignal:
    error_type: str
    message: str

@dataclass
class WorkflowResult:
    status: str  # "completed", "paused", "failed"
    workflow_id: int | None = None
    reason: str | None = None
    error_type: str | None = None
    error_message: str | None = None


class WorkflowPaused(Exception):
    pass

class WorkflowAborted(Exception):
    pass

class StepFailed(Exception):
    pass

class StepSkipped(Exception):
    pass


class WorkflowExecutor:
    """Drives the LLM tool-calling loop within workflow context."""

    def __init__(
        self,
        store: SyncStore,
        llm_client,  # Your LLM client (OpenAI, Anthropic, etc.)
        tools: dict[str, Callable],  # git_status, read_file, etc.
        step_definitions: dict[str, StepDefinition] | None = None,
        event_callback: Callable | None = None,  # For progress monitoring
    ):
        self.store = store
        self.wm = WorkflowManager(store)
        self.llm = llm_client
        self.tools = tools
        self.step_defs = step_definitions or {}
        self.event_callback = event_callback

        self._current_workflow: Workflow | None = None
        self._current_step: WorkflowStep | None = None

    async def execute_merge(
        self,
        repo_name: str,
        branch: str,
        target: str = "main",
        pr_number: int | None = None,
    ) -> WorkflowResult:
        """Execute a complete merge workflow."""

        steps = ["fetch", "merge", "resolve_conflicts", "validate", "push"]

        async with self.wm.merge_workflow(
            repo_name, branch, target_branch=target, pr_number=pr_number
        ) as wf:
            self._current_workflow = wf

            try:
                for step_name in steps:
                    step_def = self.step_defs.get(step_name, self._default_step_def(step_name))

                    # Check skip condition
                    if step_def.skip_condition and step_def.skip_condition(wf):
                        await self._emit_event("step_skipped", {"step": step_name})
                        continue

                    async with wf.step(step_name, input_data=step_def.input_data) as step:
                        self._current_step = step
                        await self._emit_event("step_started", {"step": step_name})

                        try:
                            await self._execute_step(wf, step, step_def)
                            await self._emit_event("step_completed", {
                                "step": step_name,
                                "tool_calls": step.tool_calls
                            })
                        except StepSkipped:
                            continue

                wf.set_result(f"Successfully merged {branch} into {target}")
                return WorkflowResult(status="completed", workflow_id=wf.workflow_id)

            except WorkflowPaused as e:
                return WorkflowResult(
                    status="paused",
                    workflow_id=wf.workflow_id,
                    reason=str(e)
                )
            except WorkflowAborted as e:
                return WorkflowResult(
                    status="failed",
                    workflow_id=wf.workflow_id,
                    error_type="Aborted",
                    error_message=str(e)
                )
            except Exception as e:
                return WorkflowResult(
                    status="failed",
                    workflow_id=wf.workflow_id,
                    error_type=type(e).__name__,
                    error_message=str(e)
                )

    async def execute_rebase(
        self,
        repo_name: str,
        branch: str,
        onto: str = "main",
        pr_number: int | None = None,
    ) -> WorkflowResult:
        """Execute a rebase workflow."""

        steps = ["fetch", "rebase", "resolve_conflicts", "validate", "force_push"]

        async with self.wm.rebase_workflow(
            repo_name, branch, onto_branch=onto, pr_number=pr_number
        ) as wf:
            self._current_workflow = wf

            try:
                for step_name in steps:
                    step_def = self.step_defs.get(step_name, self._default_step_def(step_name))

                    if step_def.skip_condition and step_def.skip_condition(wf):
                        continue

                    async with wf.step(step_name) as step:
                        self._current_step = step
                        await self._execute_step(wf, step, step_def)

                wf.set_result(f"Successfully rebased {branch} onto {onto}")
                return WorkflowResult(status="completed", workflow_id=wf.workflow_id)

            except WorkflowPaused as e:
                return WorkflowResult(status="paused", workflow_id=wf.workflow_id, reason=str(e))
            except Exception as e:
                return WorkflowResult(
                    status="failed",
                    workflow_id=wf.workflow_id,
                    error_type=type(e).__name__,
                    error_message=str(e)
                )

    async def _execute_step(
        self,
        wf: Workflow,
        step: WorkflowStep,
        step_def: StepDefinition,
    ):
        """Run the LLM loop for a single step."""

        system_prompt = self._build_prompt(wf, step, step_def)

        # Format initial prompt with context
        initial_prompt = step_def.initial_prompt.format(**wf._context)
        messages = [{"role": "user", "content": initial_prompt}]

        # Budget enforcement
        budget = step_def.budget or StepBudget()
        step_start = time.time()

        while True:
            # Check budget limits
            if step.tool_calls >= budget.max_tool_calls:
                step.fail("BudgetExceeded", f"Exceeded {budget.max_tool_calls} tool calls")
                raise StepFailed("Tool call budget exceeded")

            elapsed = time.time() - step_start
            if elapsed > budget.max_seconds:
                step.fail("Timeout", f"Step exceeded {budget.max_seconds}s")
                raise StepFailed("Step timeout")

            # Get available tools for this step
            available_tools = self._get_tools_for_step(step_def)

            # Call LLM
            response = await self.llm.chat(
                system=system_prompt,
                messages=messages,
                tools=available_tools,
            )

            # No tool calls = LLM is done talking
            if not response.tool_calls:
                messages.append({"role": "assistant", "content": response.content})
                continue

            # Process tool calls
            for tool_call in response.tool_calls:
                result = await self._execute_tool(tool_call, step_def)

                if isinstance(result, StepCompleteSignal):
                    step.set_output({"summary": result.summary})
                    return
                elif isinstance(result, PauseSignal):
                    wf.update_context({"pause_reason": result.reason})
                    await self.wm.pause_current_workflow(wf.workflow_id, result.reason)
                    raise WorkflowPaused(result.reason)
                elif isinstance(result, AbortSignal):
                    step.fail(result.error_type, result.message)
                    wf.fail(result.error_type, result.message)
                    raise WorkflowAborted(result.message)
                else:
                    # Normal tool result - add to messages
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": self._format_result(result)
                    })

            # Add assistant message to history
            if response.content:
                messages.append({"role": "assistant", "content": response.content})

    async def _execute_tool(self, tool_call, step_def: StepDefinition) -> Any:
        """Execute a tool call with automatic recording."""

        tool_name = tool_call.name
        args = tool_call.arguments if hasattr(tool_call, 'arguments') else tool_call.get('arguments', {})

        # Record the call (automatic!)
        if self._current_step:
            await self._current_step.record_tool_call()

        # Emit event for monitoring
        await self._emit_event("tool_call", {
            "tool": tool_name,
            "step": self._current_step.step_name if self._current_step else None,
            "tool_calls_count": self._current_step.tool_calls if self._current_step else 0,
        })

        # Handle workflow control tools
        if tool_name == "step_complete":
            return StepCompleteSignal(summary=args.get("summary", ""))
        elif tool_name == "request_pause":
            return PauseSignal(reason=args["reason"])
        elif tool_name == "abort_workflow":
            return AbortSignal(error_type=args["error_type"], message=args["message"])
        elif tool_name == "step_output":
            if self._current_step:
                self._current_step.set_output(args["data"])
            return "Output recorded"
        elif tool_name == "get_workflow_status":
            return self._get_workflow_status()
        elif tool_name == "get_step_context":
            return self._get_step_context()

        # Check if tool is allowed for this step
        if step_def.allowed_tools and tool_name not in step_def.allowed_tools:
            return f"Error: Tool '{tool_name}' not allowed in this step"

        # Execute regular tool (git, filesystem, etc.)
        if tool_name not in self.tools:
            return f"Error: Unknown tool '{tool_name}'"

        try:
            result = await self.tools[tool_name](**args)

            # Cache certain results in workflow context
            if tool_name == "git_status" and self._current_workflow:
                # Parse conflicts from status
                if "both modified" in str(result).lower():
                    self._current_workflow.update_context({"has_conflicts": True})

            return result
        except Exception as e:
            return f"Error executing {tool_name}: {e}"

    def _build_prompt(self, wf: Workflow, step: WorkflowStep, step_def: StepDefinition) -> str:
        """Build system prompt with workflow context."""

        return f"""You are performing a {wf.workflow_type} operation on {wf.repo_name}.
Branch: {wf.branch_name or 'N/A'}

## Current Step: {step.step_name}

{step_def.instructions}

## Workflow Context
{self._format_context(wf._context)}

## Progress
- Steps completed: {wf._step_order - 1}
- Tool calls this step: {step.tool_calls}

## Instructions
- Use the available tools to complete this step's objective
- Call `step_complete` with a summary when you've finished
- Call `step_output` to record structured data (e.g., list of conflicts)
- Call `request_pause` if you need human review or are unsure how to proceed
- Call `abort_workflow` only for unrecoverable errors

Stay focused on the current step. Don't try to do work for future steps.
"""

    def _get_tools_for_step(self, step_def: StepDefinition) -> list[dict]:
        """Get tool definitions available for a step."""

        # Always include workflow control tools
        workflow_tools = ["step_complete", "step_output", "request_pause",
                         "abort_workflow", "get_workflow_status"]

        if step_def.allowed_tools:
            allowed = set(step_def.allowed_tools) | set(workflow_tools)
        else:
            allowed = set(self.tools.keys()) | set(workflow_tools)

        # Return tool definitions (implement based on your tool format)
        return [self._get_tool_definition(name) for name in allowed]

    def _get_tool_definition(self, tool_name: str) -> dict:
        """Get OpenAI-format tool definition."""
        # Implement based on your tool registry
        raise NotImplementedError("Implement tool definition lookup")

    def _get_workflow_status(self) -> dict:
        """Get current workflow status for LLM."""
        if not self._current_workflow:
            return {"error": "No active workflow"}

        wf = self._current_workflow
        return {
            "workflow_id": wf.workflow_id,
            "type": wf.workflow_type,
            "repo": wf.repo_name,
            "branch": wf.branch_name,
            "current_step": self._current_step.step_name if self._current_step else None,
            "steps_completed": wf._step_order - 1,
            "context": wf._context,
        }

    def _get_step_context(self) -> dict:
        """Get current step context for LLM."""
        if not self._current_step:
            return {"error": "No active step"}

        step = self._current_step
        return {
            "step_name": step.step_name,
            "tool_calls": step.tool_calls,
            "input_data": step._input_data,
            "output_data": step._output_data,
        }

    def _format_context(self, context: dict) -> str:
        """Format context dict for prompt."""
        if not context:
            return "(none)"

        lines = []
        for key, value in context.items():
            if isinstance(value, (list, dict)):
                lines.append(f"- {key}: {len(value)} items")
            else:
                lines.append(f"- {key}: {value}")
        return "\n".join(lines)

    def _format_result(self, result: Any) -> str:
        """Format tool result for LLM message."""
        if isinstance(result, str):
            return result
        elif isinstance(result, dict):
            import json
            return json.dumps(result, indent=2, default=str)
        else:
            return str(result)

    def _default_step_def(self, step_name: str) -> StepDefinition:
        """Create a default step definition."""
        return StepDefinition(
            name=step_name,
            instructions=f"Complete the {step_name} step.",
            initial_prompt=f"Execute the {step_name} operation.",
        )

    async def _emit_event(self, event_type: str, data: dict):
        """Emit event for monitoring."""
        if self.event_callback:
            await self.event_callback(event_type, {
                "workflow_id": self._current_workflow.workflow_id if self._current_workflow else None,
                "timestamp": datetime.now(UTC).isoformat(),
                **data,
            })


# Convenience function
async def resume_paused_workflow(
    executor: WorkflowExecutor,
    workflow_id: int,
    human_input: dict | None = None,
) -> WorkflowResult:
    """Resume a paused workflow with optional human input."""

    workflow = await executor.wm.resume_workflow(workflow_id)

    if human_input:
        workflow.update_context({"human_input": human_input})

    # Continue from current step
    # (Implementation depends on how you want to handle resumption)

    return WorkflowResult(status="resumed", workflow_id=workflow_id)
```

---

## Usage Example

```python
import asyncio
from github_sync import SyncStore, WorkflowManager

# Your tools (implement these based on your environment)
async def git_status(path: str = ".") -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", "status", cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, _ = await proc.communicate()
    return stdout.decode()

async def git_fetch(remote: str = "origin", path: str = ".") -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", "fetch", remote, cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    return stdout.decode() or stderr.decode() or "Fetch complete"

async def git_merge(branch: str, path: str = ".") -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", "merge", branch, cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    return stdout.decode() + stderr.decode()

async def read_file(file_path: str) -> str:
    with open(file_path) as f:
        return f.read()

async def write_file(file_path: str, content: str) -> str:
    with open(file_path, "w") as f:
        f.write(content)
    return f"Wrote {len(content)} bytes to {file_path}"

# ... more tools ...

TOOLS = {
    "git_status": git_status,
    "git_fetch": git_fetch,
    "git_merge": git_merge,
    "read_file": read_file,
    "write_file": write_file,
    # ... add more tools
}

async def main():
    # Initialize
    store = SyncStore("workflow.db")
    await store.initialize()

    # Create executor with your LLM client
    executor = WorkflowExecutor(
        store=store,
        llm_client=your_llm_client,  # OpenAI, Anthropic, etc.
        tools=TOOLS,
        step_definitions=MERGE_WORKFLOW_STEPS,
        event_callback=lambda event, data: print(f"[{event}] {data}"),
    )

    # Execute a merge
    result = await executor.execute_merge(
        repo_name="my-repo",
        branch="feature-branch",
        target="main",
        pr_number=42,
    )

    print(f"Workflow {result.status}: {result.workflow_id}")

    if result.status == "paused":
        print(f"Paused for: {result.reason}")
        # Handle human-in-the-loop...

asyncio.run(main())
```

---

## Advanced Patterns

### 1. Checkpointing for Long Workflows

Save state periodically for recovery:

```python
async def _execute_step(self, ...):
    checkpoint_interval = 10

    while True:
        # ... tool execution ...

        if step.tool_calls % checkpoint_interval == 0:
            await self._checkpoint(wf, step, messages)

async def _checkpoint(self, wf: Workflow, step: WorkflowStep, messages: list):
    """Save state for potential recovery."""
    import json

    await self.store.update_workflow_context(wf.workflow_id, {
        "checkpoint": {
            "step": step.step_name,
            "tool_calls": step.tool_calls,
            "messages_count": len(messages),
            "timestamp": datetime.now(UTC).isoformat(),
        }
    })

    # Optionally save full message history
    await self.store.set_memo(
        wf.repo_name,
        wf.pr_number or 0,
        f"workflow_{wf.workflow_id}_messages",
        json.dumps(messages)
    )
```

### 2. Human-in-the-Loop Processing

```python
async def process_paused_workflows(store: SyncStore, executor: WorkflowExecutor):
    """Check and process workflows waiting on human input."""

    wm = WorkflowManager(store)
    paused = await wm.get_active_workflows()
    paused = [w for w in paused if w["status"] == "paused"]

    for wf_data in paused:
        print(f"Workflow {wf_data['id']} paused: {wf_data['context'].get('pause_reason')}")

        # Get human decision (implement based on your UI)
        decision = await get_human_decision(wf_data)

        if decision.approved:
            # Resume with human input
            workflow = await wm.resume_workflow(wf_data["id"])
            workflow.update_context({"human_decision": decision.data})

            # Continue execution (you may need to track which step to resume)
            result = await executor.continue_workflow(workflow)
        else:
            # Abort workflow
            await wm.complete_resumed_workflow(
                await wm.resume_workflow(wf_data["id"]),
                success=False,
                error_type="HumanRejected",
                error_message=decision.reason,
            )
```

### 3. Event Streaming for Real-Time Monitoring

```python
async def event_handler(event_type: str, data: dict):
    """Handle workflow events for real-time updates."""

    if event_type == "tool_call":
        print(f"  [{data['step']}] Tool: {data['tool']} (call #{data['tool_calls_count']})")

    elif event_type == "step_started":
        print(f"Starting step: {data['step']}")

    elif event_type == "step_completed":
        print(f"Completed step: {data['step']} ({data['tool_calls']} tool calls)")

    elif event_type == "step_skipped":
        print(f"Skipped step: {data['step']}")

    # For web UI: send via WebSocket
    # await websocket.send_json({"type": event_type, **data})

executor = WorkflowExecutor(
    store=store,
    llm_client=llm,
    tools=TOOLS,
    event_callback=event_handler,
)
```

### 4. Learning from Past Workflows

```python
async def _build_prompt(self, wf: Workflow, step: WorkflowStep, step_def: StepDefinition) -> str:
    base_prompt = f"""..."""

    # Add learnings from past failures
    stats = await self.store.get_workflow_stats(
        repo_name=wf.repo_name,
        workflow_type=wf.workflow_type,
    )

    if stats["failure_count"] > 0:
        # Get recent failure patterns
        recent_failed = await self._get_recent_failures(wf.repo_name, wf.workflow_type, limit=5)

        if recent_failed:
            failure_summary = self._summarize_failures(recent_failed)
            base_prompt += f"""

## Known Issues in This Repository
Previous {wf.workflow_type} workflows have encountered these issues:
{failure_summary}

Be mindful of these patterns and handle them proactively.
"""

    return base_prompt

def _summarize_failures(self, failed_workflows: list[dict]) -> str:
    """Summarize common failure patterns."""
    error_types = {}
    for wf in failed_workflows:
        error_type = wf.get("error_type", "Unknown")
        error_types[error_type] = error_types.get(error_type, 0) + 1

    lines = []
    for error_type, count in sorted(error_types.items(), key=lambda x: -x[1]):
        lines.append(f"- {error_type}: {count} occurrences")
    return "\n".join(lines)
```

### 5. Parallel Step Execution

For independent steps that can run concurrently:

```python
async def execute_parallel_steps(
    self,
    wf: Workflow,
    step_names: list[str],
) -> list[dict]:
    """Execute multiple independent steps in parallel."""

    async def run_step(step_name: str) -> dict:
        step_def = self.step_defs.get(step_name, self._default_step_def(step_name))

        async with wf.step(step_name) as step:
            self._current_step = step
            try:
                await self._execute_step(wf, step, step_def)
                return {"step": step_name, "success": True}
            except Exception as e:
                return {"step": step_name, "success": False, "error": str(e)}

    results = await asyncio.gather(*[run_step(name) for name in step_names])
    return results
```

---

## Monitoring and Debugging

### Query Active Workflows

```python
async def show_active_workflows(store: SyncStore):
    wm = WorkflowManager(store)
    active = await wm.get_active_workflows()

    for wf in active:
        print(f"\nWorkflow {wf['id']}: {wf['workflow_type']}")
        print(f"  Repo: {wf['repo_name']}")
        print(f"  Branch: {wf.get('branch_name', 'N/A')}")
        print(f"  Status: {wf['status']}")
        print(f"  Current step: {wf.get('current_step', 'N/A')}")
        print(f"  Started: {wf.get('started_at', 'N/A')}")

        # Get step details
        full_wf = await wm.get_workflow(wf['id'])
        if full_wf and full_wf.get('steps'):
            print(f"  Steps:")
            for step in full_wf['steps']:
                icon = "✓" if step.get('success') else "✗" if step.get('success') == 0 else "..."
                print(f"    {icon} {step['step_name']}: {step.get('tool_calls', 0)} calls, {step.get('duration_ms', 0)}ms")
```

### Get Workflow Statistics

```python
async def show_workflow_stats(store: SyncStore, repo_name: str):
    wm = WorkflowManager(store)

    for wf_type in ["merge", "rebase", "pr_review", "ci_fix"]:
        stats = await wm.get_stats(repo_name, wf_type)
        if stats["total_count"] > 0:
            print(f"\n{wf_type.upper()} workflows:")
            print(f"  Total: {stats['total_count']}")
            print(f"  Success rate: {stats['success_rate']:.1f}%")
            print(f"  Avg duration: {stats['avg_duration_ms']:.0f}ms")
```

---

## Best Practices

### 1. Keep Steps Focused

Each step should have a single, clear objective. Don't combine "merge and resolve conflicts" into one step.

### 2. Set Appropriate Budgets

- Simple steps (fetch, push): 5-10 tool calls, 60s
- Complex steps (conflict resolution): 50-100 tool calls, 10min
- Validation steps: 20-30 tool calls, 5min

### 3. Use step_output for Structured Data

When a step produces data needed by later steps, use `step_output`:

```python
# In merge step
step_output({"has_conflicts": True, "conflict_files": ["a.py", "b.py"]})

# This data is available in workflow context for the next step
```

### 4. Prefer request_pause Over abort_workflow

Use `request_pause` when:

- Unsure how to resolve a conflict
- Need clarification on requirements
- Want human review before destructive action

Use `abort_workflow` only for:

- Unrecoverable errors (repo corrupted, permissions denied)
- Budget exceeded
- Repeated failures

### 5. Cache Expensive Operations

Store results of expensive operations in workflow context:

```python
if tool_name == "git_diff":
    result = await tools["git_diff"](**args)
    wf.update_context({"cached_diff": result[:10000]})  # Truncate if large
    return result
```
