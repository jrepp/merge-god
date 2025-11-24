"""
Claude Agent SDK integration for PR processing.

This module wraps the Claude Agent SDK to provide structured PR processing
with task decomposition, streaming updates, and tool calling.
"""

import asyncio
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Protocol

from anthropic import AsyncAnthropic
try:
    from anthropic import AsyncAnthropicBedrock
    BEDROCK_AVAILABLE = True
except ImportError:
    AsyncAnthropicBedrock = None
    BEDROCK_AVAILABLE = False


def create_claude_client() -> AsyncAnthropic | AsyncAnthropicBedrock:
    """
    Create Claude client based on environment configuration.

    Automatically detects if using Bedrock or direct API based on
    CLAUDE_CODE_USE_BEDROCK environment variable.

    Returns:
        Configured AsyncAnthropic or AsyncAnthropicBedrock client
    """
    use_bedrock = os.environ.get("CLAUDE_CODE_USE_BEDROCK", "0") == "1"

    if use_bedrock:
        if not BEDROCK_AVAILABLE:
            raise RuntimeError(
                "Bedrock support requested but anthropic[bedrock] not installed. "
                "Install with: uv add 'anthropic[bedrock]'"
            )

        # Use AWS region from env or default
        aws_region = os.environ.get("ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "us-west-2")

        return AsyncAnthropicBedrock(
            aws_region=aws_region
        )
    else:
        # Use direct API
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY environment variable not set. "
                "Either set this variable or use Bedrock with CLAUDE_CODE_USE_BEDROCK=1"
            )

        return AsyncAnthropic(api_key=api_key)


def get_model_name() -> str:
    """
    Get the Claude model name from environment or default.

    Returns:
        Model identifier string
    """
    # Check for explicit model override
    model = os.environ.get("ANTHROPIC_MODEL")
    if model:
        return model

    # Default to Sonnet 4.5
    use_bedrock = os.environ.get("CLAUDE_CODE_USE_BEDROCK", "0") == "1"
    if use_bedrock:
        # Bedrock format
        return "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
    else:
        # Direct API format
        return "claude-sonnet-4-5-20250929"


@dataclass
class AgentAction:
    """Represents a single action taken by the agent"""
    type: str  # "git_commit", "file_edit", "run_tests", etc.
    target: str  # What the action applies to
    details: dict[str, Any]
    status: str  # "planned", "executing", "completed", "failed"
    timestamp: datetime
    result: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class AgentTask:
    """Represents a discrete task in PR processing"""
    id: str
    description: str
    prompt_template: str
    required_context: list[str]
    status: str = "pending"  # pending, running, completed, failed
    started_at: datetime | None = None
    completed_at: datetime | None = None
    actions: list[AgentAction] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class AgentEvent:
    """Event emitted during agent execution"""
    type: str  # "thinking", "action", "progress", "error", "complete"
    content: str | None = None
    action: AgentAction | None = None
    progress: tuple[int, int] | None = None  # (current, total)
    error: Exception | None = None


@dataclass
class PRContext:
    """Context for PR processing"""
    pr_number: int
    title: str
    body: str | None
    head_branch: str
    base_branch: str
    author: str
    url: str

    # PR state
    has_conflicts: bool
    conflicting_files: list[str]
    has_failing_ci: bool
    failing_checks: list[dict[str, Any]]

    # Review information
    review_comments: list[dict[str, Any]]
    general_comments: list[dict[str, Any]]

    # Files and diff
    changed_files: list[dict[str, Any]]
    diff: str

    # Commits
    commits: list[dict[str, Any]]

    # Guidelines
    guidelines: str
    commit_examples: str

    # Metadata
    labels: list[str]
    ci_checks: list[dict[str, Any]]
    review_decision: str | None

    @classmethod
    def from_dict(cls, pr_details: dict[str, Any], pr_context: dict[str, Any]) -> "PRContext":
        """Create PRContext from pr-loop.py data structures"""
        return cls(
            pr_number=pr_details.get("number"),
            title=pr_details.get("title", ""),
            body=pr_details.get("body"),
            head_branch=pr_details.get("headRefName", ""),
            base_branch=pr_details.get("baseRefName", "main"),
            author=pr_details.get("author", {}).get("login", "unknown"),
            url=pr_context.get("url", ""),
            has_conflicts=pr_context.get("conflicts", {}).get("has_conflicts", False),
            conflicting_files=pr_context.get("conflicts", {}).get("conflicting_files", []),
            has_failing_ci=pr_context.get("ci_status", {}).get("failed", 0) > 0,
            failing_checks=pr_context.get("ci_status", {}).get("failed_checks", []),
            review_comments=pr_context.get("review_comments", []),
            general_comments=pr_context.get("comments", []),
            changed_files=pr_context.get("files", []),
            diff=pr_context.get("diff", ""),
            commits=pr_context.get("commits", []),
            guidelines=pr_context.get("guidelines", ""),
            commit_examples=pr_context.get("commit_examples", ""),
            labels=pr_details.get("labels", []),
            ci_checks=pr_context.get("ci_status", {}),
            review_decision=pr_details.get("reviewDecision"),
        )


@dataclass
class ProcessingResult:
    """Result of PR processing"""
    success: bool
    tasks: list[AgentTask]
    actions: list[AgentAction]
    duration: float
    error: str | None = None

    def all_tasks_successful(self) -> bool:
        """Check if all tasks completed successfully"""
        return all(task.status == "completed" for task in self.tasks)

    def get_failed_tasks(self) -> list[AgentTask]:
        """Get list of failed tasks"""
        return [task for task in self.tasks if task.status == "failed"]


@dataclass
class ToolResult:
    """Result of a tool execution"""
    success: bool
    output: str | None = None
    error: str | None = None
    data: dict[str, Any] | None = None

    def to_content(self) -> list[dict[str, Any]]:
        """Convert to Claude API tool result format"""
        if self.success:
            return [{
                "type": "text",
                "text": self.output or "Operation completed successfully"
            }]
        else:
            return [{
                "type": "text",
                "text": f"Error: {self.error}"
            }]


class AgentCallbacks(Protocol):
    """Protocol for agent callbacks"""

    def on_thinking(self, content: str) -> None:
        """Called when agent is thinking/planning"""
        ...

    def on_action(self, action: AgentAction) -> None:
        """Called when agent takes an action"""
        ...

    def on_progress(self, current: int, total: int) -> None:
        """Called with progress updates"""
        ...

    def on_error(self, error: Exception) -> bool:
        """Called on error, return True to continue, False to abort"""
        ...


class PRAgent:
    """
    Agent for processing pull requests using Claude Agent SDK.

    This replaces the simple subprocess call to 'bob' with a structured,
    observable, and recoverable agent system.
    """

    # Development best practices for this repository
    DEV_GUIDELINES = """
## Repository Development Best Practices

### Code Quality Tools

This repository uses the following tools to maintain code quality:

1. **Ruff** - Fast Python linter and formatter
   - Run linting: `ruff check .`
   - Auto-fix issues: `ruff check --fix .`
   - Format code: `ruff format .`

2. **Mypy** - Static type checker
   - Run type checks: `mypy merge_god/`
   - Helps catch type errors before runtime

3. **Pre-commit hooks** - Automated checks before commits
   - Install: `pre-commit install`
   - Run manually: `pre-commit run --all-files`
   - Includes: ruff, mypy, security checks, file formatters

4. **Pytest** - Test framework
   - Run tests: `pytest` or `merge-god test`
   - Run specific test: `pytest test_db_operations.py -v`

### Code Standards

- **Line length**: 100 characters max
- **Python version**: 3.12+
- **Import order**: stdlib, third-party, local (automatically sorted by ruff)
- **Type hints**: Encouraged but not required (checked by mypy where present)
- **Security**: Avoid common vulnerabilities (checked by bandit via pre-commit)

### Before Committing

Always run these checks before committing code:

```bash
# Format and lint
ruff format .
ruff check --fix .

# Type check (if you added type hints)
mypy merge_god/

# Run tests
pytest

# Or use pre-commit to run all checks
pre-commit run --all-files
```

### CI/Testing Commands

- `merge-god test` - Run full test suite
- `merge-god test --type isolation` - Run process isolation tests
- `merge-god test --type db` - Run database tests
- `merge-god validate` - Validate process flow
"""

    def __init__(
        self,
        client: AsyncAnthropic | AsyncAnthropicBedrock,
        model: str = "claude-sonnet-4-5-20250929",
        repo_path: Path | None = None,
        database = None,
        session_id: str | None = None
    ):
        self.client = client
        self.model = model
        self.repo_path = repo_path
        self.database = database
        self.session_id = session_id
        self.conversation_history = []
        self.actions_taken = []
        self.is_bedrock = isinstance(client, AsyncAnthropicBedrock) if BEDROCK_AVAILABLE else False
        self.action_counter = 0
        self.turn_counter = 0

    async def process_pr_streaming(
        self,
        pr_context: PRContext,
        mode: str,
        callbacks: AgentCallbacks
    ) -> ProcessingResult:
        """
        Process a PR with streaming updates and structured actions.

        This is the main entry point that replaces run_command(["bob", "--json", prompt]).

        Args:
            pr_context: Context about the PR to process
            mode: Processing mode ("for-review" or "for-landing")
            callbacks: Callbacks for agent events

        Returns:
            ProcessingResult with all tasks and actions
        """
        start_time = datetime.now(timezone.utc)

        # Decompose PR into discrete tasks
        tasks = self._decompose_pr_tasks(pr_context, mode)

        # Process each task
        for i, task in enumerate(tasks):
            try:
                callbacks.on_progress(i, len(tasks))

                # Execute task with streaming
                task.started_at = datetime.now(timezone.utc)
                task.status = "running"

                async for event in self._execute_task_streaming(task, pr_context):
                    if event.type == "thinking":
                        callbacks.on_thinking(event.content)
                    elif event.type == "action":
                        callbacks.on_action(event.action)
                        task.actions.append(event.action)
                    elif event.type == "error":
                        # Ask callback if we should continue
                        if not callbacks.on_error(event.error):
                            task.status = "failed"
                            task.error = str(event.error)
                            break

                # Mark task complete if no errors
                if task.status == "running":
                    task.status = "completed"
                    task.completed_at = datetime.now(timezone.utc)

            except Exception as e:
                task.status = "failed"
                task.error = str(e)
                task.completed_at = datetime.now(timezone.utc)

                # Ask callback if we should abort entire processing
                if not callbacks.on_error(e):
                    break

        # Calculate results
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        all_successful = all(task.status == "completed" for task in tasks)

        return ProcessingResult(
            success=all_successful,
            tasks=tasks,
            actions=self.actions_taken,
            duration=duration,
            error=None if all_successful else "Some tasks failed"
        )

    def _decompose_pr_tasks(self, pr_context: PRContext, mode: str) -> list[AgentTask]:
        """
        Break down PR processing into discrete, manageable tasks.

        This replaces the monolithic prompt with structured subtasks.
        """
        tasks = []

        # Task 1: Always analyze the PR first
        tasks.append(AgentTask(
            id="analyze",
            description=f"Analyze PR #{pr_context.pr_number} and identify issues",
            prompt_template="analyze_pr",
            required_context=["pr_details", "diff", "ci_status"]
        ))

        # Task 2: Resolve merge conflicts (if any)
        if pr_context.has_conflicts:
            tasks.append(AgentTask(
                id="resolve_conflicts",
                description=f"Resolve {len(pr_context.conflicting_files)} merge conflicts",
                prompt_template="resolve_conflicts",
                required_context=["conflicting_files", "base_branch", "diff"]
            ))

        # Task 3: Address code review comments
        if pr_context.review_comments:
            tasks.append(AgentTask(
                id="address_reviews",
                description=f"Address {len(pr_context.review_comments)} review comments",
                prompt_template="address_reviews",
                required_context=["review_comments", "changed_files"]
            ))

        # Task 4: Fix failing CI checks
        if pr_context.has_failing_ci:
            tasks.append(AgentTask(
                id="fix_ci",
                description=f"Fix {len(pr_context.failing_checks)} failing CI checks",
                prompt_template="fix_ci",
                required_context=["failing_checks", "changed_files"]
            ))

        # Task 5: Comprehensive code review (for-review mode only)
        if mode == "for-review":
            tasks.append(AgentTask(
                id="code_review",
                description="Conduct comprehensive code review and improvements",
                prompt_template="code_review",
                required_context=["full_diff", "guidelines", "changed_files"]
            ))

        # Task 6: Final validation
        tasks.append(AgentTask(
            id="validate",
            description="Run tests and validate all changes",
            prompt_template="validate",
            required_context=["changed_files"]
        ))

        return tasks

    async def _execute_task_streaming(
        self,
        task: AgentTask,
        pr_context: PRContext
    ) -> AsyncIterator[AgentEvent]:
        """
        Execute a single task with streaming updates.

        This provides real-time visibility into what the agent is doing.
        Implements proper agentic loop with tool calling.
        """
        # Build focused prompt for this specific task
        prompt = self._build_task_prompt(task, pr_context)

        # Get tools available for this task
        tools = self._get_tools_for_task(task)

        # Add user message to conversation
        self.conversation_history.append({
            "role": "user",
            "content": prompt
        })

        # Agentic loop: continue until agent doesn't use tools
        # Higher limit for complex tasks like code review
        max_iterations = 25
        iteration = 0

        try:
            while iteration < max_iterations:
                iteration += 1

                # Call API with current conversation history
                async with self.client.messages.stream(
                    model=self.model,
                    max_tokens=4096,
                    messages=self.conversation_history,
                    tools=tools if tools else None
                ) as stream:
                    # Collect tool uses during streaming
                    tool_uses = []
                    text_content = []

                    async for event in stream:
                        if hasattr(event, 'type'):
                            if event.type == "content_block_delta":
                                # Agent is generating text response
                                if hasattr(event, 'delta') and hasattr(event.delta, 'text'):
                                    text_content.append(event.delta.text)
                                    yield AgentEvent(
                                        type="thinking",
                                        content=event.delta.text
                                    )

                            elif event.type == "content_block_start":
                                # Check if this is a tool use
                                if hasattr(event, 'content_block'):
                                    content_block = event.content_block
                                    if hasattr(content_block, 'type') and content_block.type == "tool_use":
                                        tool_uses.append(content_block)

                    # Get final message
                    final_message = await stream.get_final_message()

                    # Add assistant response to conversation
                    self.conversation_history.append({
                        "role": "assistant",
                        "content": final_message.content
                    })

                    # If no tool uses, we're done
                    if not tool_uses:
                        break

                    # Execute tools and prepare tool results
                    tool_results = []
                    for tool_use in tool_uses:
                        # Create action for tracking
                        action = AgentAction(
                            type=tool_use.name,
                            target=getattr(tool_use, 'input', {}).get("target", ""),
                            details=getattr(tool_use, 'input', {}),
                            status="executing",
                            timestamp=datetime.now(timezone.utc)
                        )

                        yield AgentEvent(type="action", action=action)

                        # Record action start in database
                        action_id = None
                        if self.database and self.session_id:
                            try:
                                self.action_counter += 1
                                action_id = self.database.record_agent_action(
                                    session_id=self.session_id,
                                    action_number=self.action_counter,
                                    action_type=action.type,
                                    target=action.target,
                                    details=action.details,
                                    status="executing"
                                )
                            except Exception:
                                pass  # Don't fail on telemetry errors

                        # Execute the tool
                        tool_result = await self._execute_tool(action, action_id)

                        # Update action status
                        action.status = "completed" if tool_result.success else "failed"
                        action.result = tool_result.data
                        action.error = tool_result.error
                        self.actions_taken.append(action)

                        # Update action in database
                        if self.database and self.session_id and action_id:
                            try:
                                self.database.update_agent_session(
                                    session_id=self.session_id,
                                    actions_total=self.action_counter
                                )
                            except Exception:
                                pass

                        # Build tool result for API
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use.id,
                            "content": tool_result.to_content()
                        })

                    # Add tool results to conversation for next iteration
                    self.conversation_history.append({
                        "role": "user",
                        "content": tool_results
                    })

            if iteration >= max_iterations:
                yield AgentEvent(
                    type="error",
                    error=Exception(f"Agent exceeded maximum iterations ({max_iterations})")
                )

        except Exception as e:
            yield AgentEvent(type="error", error=e)

    def _build_task_prompt(self, task: AgentTask, pr_context: PRContext) -> str:
        """
        Build a focused prompt for a specific task.

        This replaces the monolithic build_pr_prompt() function with
        task-specific prompts that are smaller and more focused.
        """
        # Get base context that's always included
        base_context = f"""# Task: {task.description}

## PR Context
- **PR #{pr_context.pr_number}**: {pr_context.title}
- **Branch**: {pr_context.head_branch} → {pr_context.base_branch}
- **Author**: {pr_context.author}
- **URL**: {pr_context.url}
"""

        # Add task-specific context
        if task.id == "analyze":
            return base_context + f"""
## Your Task
Analyze this PR and identify:
1. Any merge conflicts
2. Failing CI checks
3. Outstanding review comments
4. Potential issues or improvements

## PR Statistics
- Files changed: {len(pr_context.changed_files)}
- Commits: {len(pr_context.commits)}
- Review comments: {len(pr_context.review_comments)}

## Current State
- Conflicts: {"Yes" if pr_context.has_conflicts else "No"}
- Failing CI: {"Yes" if pr_context.has_failing_ci else "No"}
- Review decision: {pr_context.review_decision or "Pending"}

Provide a structured analysis of what needs to be done.
"""

        elif task.id == "resolve_conflicts":
            conflicting_files_str = "\n".join(f"- {f}" for f in pr_context.conflicting_files)
            return base_context + f"""
## Your Task
Resolve merge conflicts in the following files:
{conflicting_files_str}

## Tools Available
- read_file: Read the current state of conflicting files
- edit_file: Make changes to resolve conflicts
- git_commit: Commit the resolved conflicts

## Guidelines
1. Understand the changes in both branches
2. Preserve the intent of both changes where possible
3. Remove conflict markers (<<<<<<<, =======, >>>>>>>)
4. Test that the resolution makes sense
5. Commit with a clear message

Begin by reading the conflicting files to understand the conflicts.
"""

        elif task.id == "address_reviews":
            review_summary = "\n\n".join(
                f"**{c.get('user', {}).get('login')}** on {c.get('path')}:{c.get('line')}\n{c.get('body')}"
                for c in pr_context.review_comments[:5]  # Show first 5
            )
            return base_context + f"""
## Your Task
Address the following code review comments:

{review_summary}

{"... and " + str(len(pr_context.review_comments) - 5) + " more comments" if len(pr_context.review_comments) > 5 else ""}

## Tools Available
- read_file: Read files that need changes
- edit_file: Make requested changes
- run_command: Run tests, linting, formatting
- git_commit: Commit the fixes

## Guidelines
1. Address each comment thoughtfully
2. After making changes, run quality checks:
   - `ruff format .` - Format code
   - `ruff check --fix .` - Fix linting issues
   - `pytest` - Run tests
3. Test your changes to ensure nothing broke
4. Commit with messages referencing the review comments
5. Consider if additional improvements are needed

## Quality Workflow

For each change:
1. Make the requested change
2. Format: `ruff format <file>`
3. Lint: `ruff check --fix <file>`
4. Test: `pytest` (or specific test file)
5. Commit with clear message

Work through the comments systematically.
"""

        elif task.id == "fix_ci":
            failing_checks_str = "\n".join(
                f"- **{c.get('name')}**: {c.get('conclusion')}"
                for c in pr_context.failing_checks
            )
            return base_context + f"""
## Your Task
Fix the following failing CI checks:

{failing_checks_str}

## Tools Available
- read_file: Read test files and source code
- edit_file: Fix issues causing failures
- run_command: Run tests, linting, type checking
- git_commit: Commit the fixes

## Guidelines
1. Understand what each check is testing
2. Fix the root cause, not just the symptom
3. Run quality checks before committing:
   - `ruff check --fix .` - Fix linting issues
   - `ruff format .` - Format code
   - `pytest` - Run tests
   - `mypy merge_god/` - Type check (if applicable)
4. Verify all tests pass after your changes
5. Commit with descriptive messages

## Common CI Failures

- **Linting errors**: Run `ruff check --fix .` to auto-fix
- **Formatting issues**: Run `ruff format .`
- **Type errors**: Run `mypy merge_god/` to check
- **Test failures**: Run `pytest -v` to see details
- **Import errors**: Check for missing dependencies

Start by analyzing the failing checks.
"""

        elif task.id == "code_review":
            return base_context + f"""
## Your Task
Conduct a comprehensive code review of the changes in this PR.

## Review Focus Areas
1. **Correctness**: Does the code do what it's supposed to?
2. **Security**: Any vulnerabilities (SQL injection, XSS, etc.)?
3. **Performance**: Any inefficient algorithms or queries?
4. **Best Practices**: Following language/framework conventions?
5. **Testing**: Are tests adequate?
6. **Documentation**: Are complex parts documented?
7. **Code Quality**: Run linting and type checking

## Changed Files
{chr(10).join(f"- {f.get('filename')} (+{f.get('additions')}/-{f.get('deletions')})" for f in pr_context.changed_files[:20])}

## Quality Checks to Run

Before finalizing any changes, run these quality tools:

```bash
# Format and lint code
ruff format .
ruff check --fix .

# Type check (if type hints present)
mypy merge_god/

# Run tests
pytest
```

## Guidelines
{pr_context.guidelines if pr_context.guidelines else "Follow best practices for the codebase"}

{self.DEV_GUIDELINES}

## Tools Available
- read_file: Read source files to review
- edit_file: Make improvements
- run_command: Run linting, formatting, type checking, tests
- git_commit: Commit improvements

Review the code systematically and make targeted improvements.
"""

        elif task.id == "validate":
            return base_context + f"""
## Your Task
Final validation before marking PR ready:

1. Run all quality checks:
   - `ruff check .` - Lint checks
   - `ruff format --check .` - Format checks
   - `pytest` - All tests
   - `mypy merge_god/` - Type checks (if applicable)
2. Verify all conflicts resolved
3. Check that all review comments addressed
4. Ensure CI checks will pass
5. Validate package builds: `uv build` (if package changes)

## Pre-merge Checklist

Run this validation sequence:

```bash
# Code quality
ruff check .                 # Should have no errors
ruff format --check .        # Should be formatted

# Type safety (if applicable)
mypy merge_god/              # Should pass

# Tests
pytest                       # Should all pass
merge-god test               # Should all pass

# Packaging (if changed)
uv build                     # Should build cleanly
```

## Tools Available
- run_command: Run tests, linting, type checking
- read_file: Check any files if needed

Perform final validation and report status. Only mark as ready if all checks pass.
"""

        return base_context

    def _get_tools_for_task(self, task: AgentTask) -> list[dict] | None:
        """
        Provide task-specific tools to the agent.

        This allows the agent to perform actions autonomously.
        """
        # Common tools available to all tasks
        common_tools = [
            {
                "name": "read_file",
                "description": "Read contents of a file from the repository",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to read"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "list_files",
                "description": "List files in a directory",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory path (default: repository root)"
                        },
                        "pattern": {
                            "type": "string",
                            "description": "Optional glob pattern to filter files"
                        }
                    }
                }
            }
        ]

        # Task-specific tools
        action_tools = []

        if task.id in ["resolve_conflicts", "address_reviews", "fix_ci", "code_review"]:
            action_tools.extend([
                {
                    "name": "edit_file",
                    "description": "Edit a file in the repository",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Path to the file to edit"
                            },
                            "changes": {
                                "type": "array",
                                "description": "List of changes to make",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "old": {
                                            "type": "string",
                                            "description": "Text to replace"
                                        },
                                        "new": {
                                            "type": "string",
                                            "description": "Replacement text"
                                        }
                                    },
                                    "required": ["old", "new"]
                                }
                            }
                        },
                        "required": ["path", "changes"]
                    }
                },
                {
                    "name": "run_tests",
                    "description": "Run test suite or specific tests",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "test_path": {
                                "type": "string",
                                "description": "Path to specific test file or directory (optional)"
                            }
                        }
                    }
                },
                {
                    "name": "git_commit",
                    "description": "Create a git commit with changes",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "message": {
                                "type": "string",
                                "description": "Commit message"
                            },
                            "files": {
                                "type": "array",
                                "description": "Specific files to commit (optional, defaults to all changes)",
                                "items": {"type": "string"}
                            }
                        },
                        "required": ["message"]
                    }
                }
            ])

        return common_tools + action_tools if action_tools else common_tools

    async def _execute_tool(self, action: AgentAction, action_id: int | None = None) -> ToolResult:
        """
        Execute a tool call made by the agent.

        This is where agent actions become real operations.
        """
        try:
            if action.type == "read_file":
                result = await self._tool_read_file(action.details.get("path"))
                # Record file operation
                if self.database and self.session_id and result.success:
                    try:
                        self.database.record_file_operation(
                            session_id=self.session_id,
                            action_id=action_id,
                            operation_type="read",
                            file_path=action.details.get("path", ""),
                            file_size=result.data.get("size") if result.data else None,
                            success=True
                        )
                    except Exception:
                        pass
                return result

            elif action.type == "list_files":
                return await self._tool_list_files(
                    action.details.get("path", "."),
                    action.details.get("pattern")
                )

            elif action.type == "edit_file":
                result = await self._tool_edit_file(
                    action.details.get("path"),
                    action.details.get("changes", [])
                )
                # Record file operation
                if self.database and self.session_id:
                    try:
                        self.database.record_file_operation(
                            session_id=self.session_id,
                            action_id=action_id,
                            operation_type="edit",
                            file_path=action.details.get("path", ""),
                            lines_added=result.data.get("changes") if result.data and result.success else 0,
                            success=result.success,
                            error_message=result.error
                        )
                    except Exception:
                        pass
                return result

            elif action.type == "run_tests":
                return await self._tool_run_tests(
                    action.details.get("test_path")
                )

            elif action.type == "git_commit":
                result = await self._tool_git_commit(
                    action.details.get("message"),
                    action.details.get("files")
                )
                # Git commits don't record as file operations
                return result

            else:
                return ToolResult(
                    success=False,
                    error=f"Unknown tool: {action.type}"
                )

        except Exception as e:
            # Record error in database
            if self.database and self.session_id:
                try:
                    self.database.record_agent_error(
                        session_id=self.session_id,
                        error_type=type(e).__name__,
                        error_message=str(e),
                        error_details=f"Tool: {action.type}, Details: {action.details}",
                        is_transient=False
                    )
                except Exception:
                    pass

            return ToolResult(
                success=False,
                error=f"Tool execution failed: {str(e)}"
            )

    async def _tool_read_file(self, path: str) -> ToolResult:
        """Read a file from the repository"""
        # Safety check: repo_path must be set
        if not self.repo_path:
            return ToolResult(
                success=False,
                error="Repository path not configured. Cannot perform file operations."
            )

        try:
            file_path = self.repo_path / path

            # Safety check: prevent path traversal outside repo
            resolved_path = file_path.resolve()
            resolved_repo = self.repo_path.resolve()
            if not resolved_path.is_relative_to(resolved_repo):
                return ToolResult(
                    success=False,
                    error=f"Access denied: '{path}' is outside repository bounds. "
                          f"Only files within the repository can be accessed."
                )

            # Safety check: file must exist
            if not file_path.exists():
                return ToolResult(
                    success=False,
                    error=f"File not found: '{path}'. "
                          f"Check the path is correct and the file exists in the repository."
                )

            # Safety check: must be a file, not a directory
            if not file_path.is_file():
                return ToolResult(
                    success=False,
                    error=f"Cannot read '{path}': path is a directory, not a file. "
                          f"Use list_files tool to view directory contents."
                )

            # Safety check: file size limit (10MB)
            file_size = file_path.stat().st_size
            max_size = 10 * 1024 * 1024  # 10MB
            if file_size > max_size:
                return ToolResult(
                    success=False,
                    error=f"File too large: '{path}' is {file_size / 1024 / 1024:.1f}MB. "
                          f"Maximum file size is {max_size / 1024 / 1024}MB."
                )

            # Try to read as text
            content = file_path.read_text()
            return ToolResult(
                success=True,
                output=content,
                data={"path": path, "size": len(content)}
            )

        except UnicodeDecodeError:
            return ToolResult(
                success=False,
                error=f"Cannot read '{path}': file appears to be binary. "
                      f"This tool only supports text files."
            )
        except PermissionError:
            return ToolResult(
                success=False,
                error=f"Permission denied: cannot read '{path}'. "
                      f"Check file permissions."
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to read '{path}': {str(e)}"
            )

    async def _tool_list_files(self, path: str, pattern: str | None) -> ToolResult:
        """List files in a directory"""
        # Safety check: repo_path must be set
        if not self.repo_path:
            return ToolResult(
                success=False,
                error="Repository path not configured. Cannot perform file operations."
            )

        try:
            dir_path = self.repo_path / path

            # Safety check: prevent path traversal outside repo
            resolved_path = dir_path.resolve()
            resolved_repo = self.repo_path.resolve()
            if not resolved_path.is_relative_to(resolved_repo):
                return ToolResult(
                    success=False,
                    error=f"Access denied: '{path}' is outside repository bounds. "
                          f"Only directories within the repository can be accessed."
                )

            # Safety check: directory must exist
            if not dir_path.exists():
                return ToolResult(
                    success=False,
                    error=f"Directory not found: '{path}'. "
                          f"Check the path is correct and the directory exists in the repository."
                )

            # Safety check: must be a directory, not a file
            if not dir_path.is_dir():
                return ToolResult(
                    success=False,
                    error=f"Cannot list '{path}': path is a file, not a directory. "
                          f"Use read_file tool to read file contents."
                )

            # List files
            if pattern:
                files = list(dir_path.glob(pattern))
            else:
                files = list(dir_path.iterdir())

            # Sort for consistent output
            files.sort()

            file_list = "\n".join(str(f.relative_to(self.repo_path)) for f in files)
            return ToolResult(
                success=True,
                output=file_list,
                data={"count": len(files)}
            )

        except PermissionError:
            return ToolResult(
                success=False,
                error=f"Permission denied: cannot list '{path}'. "
                      f"Check directory permissions."
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to list files in '{path}': {str(e)}"
            )

    async def _tool_edit_file(self, path: str, changes: list[dict]) -> ToolResult:
        """Edit a file with specified changes"""
        # Safety check: repo_path must be set
        if not self.repo_path:
            return ToolResult(
                success=False,
                error="Repository path not configured. Cannot perform file operations."
            )

        # Validate changes parameter
        if not changes or not isinstance(changes, list):
            return ToolResult(
                success=False,
                error="Invalid changes parameter. Must provide a list of change objects."
            )

        try:
            file_path = self.repo_path / path

            # Safety check: prevent path traversal outside repo
            resolved_path = file_path.resolve()
            resolved_repo = self.repo_path.resolve()
            if not resolved_path.is_relative_to(resolved_repo):
                return ToolResult(
                    success=False,
                    error=f"Access denied: '{path}' is outside repository bounds. "
                          f"Only files within the repository can be edited."
                )

            # Safety check: prevent editing .git directory
            try:
                relative_path = resolved_path.relative_to(resolved_repo)
                path_parts = relative_path.parts
                if path_parts and path_parts[0] == '.git':
                    return ToolResult(
                        success=False,
                        error=f"Access denied: cannot edit files in .git directory. "
                              f"This would corrupt the git repository."
                    )
            except ValueError:
                pass  # Not relative to repo, caught by earlier check

            # Safety check: file must exist
            if not file_path.exists():
                return ToolResult(
                    success=False,
                    error=f"File not found: '{path}'. "
                          f"File must exist before it can be edited. Use git to create new files."
                )

            # Safety check: must be a file, not a directory
            if not file_path.is_file():
                return ToolResult(
                    success=False,
                    error=f"Cannot edit '{path}': path is a directory, not a file."
                )

            # Read current content
            content = file_path.read_text()
            original_content = content

            # Apply changes
            changes_applied = 0
            for i, change in enumerate(changes):
                old = change.get("old")
                new = change.get("new")

                if not old:
                    return ToolResult(
                        success=False,
                        error=f"Change #{i+1}: 'old' field is required but missing or empty."
                    )

                if new is None:
                    return ToolResult(
                        success=False,
                        error=f"Change #{i+1}: 'new' field is required but missing."
                    )

                if old in content:
                    # Count occurrences
                    occurrences = content.count(old)
                    if occurrences > 1:
                        return ToolResult(
                            success=False,
                            error=f"Change #{i+1}: Text appears {occurrences} times in file. "
                                  f"Provide more context in 'old' to make replacement unique, "
                                  f"or use multiple specific changes."
                        )
                    content = content.replace(old, new)
                    changes_applied += 1
                else:
                    return ToolResult(
                        success=False,
                        error=f"Change #{i+1}: Could not find text to replace: '{old[:100]}...'. "
                              f"Text may have already been changed, or the context doesn't match. "
                              f"Try reading the file first to see current contents."
                    )

            # Safety check: don't write if no changes
            if content == original_content:
                return ToolResult(
                    success=False,
                    error="No changes were made to the file. Content is identical to original."
                )

            # Write back
            file_path.write_text(content)

            return ToolResult(
                success=True,
                output=f"Successfully applied {changes_applied} change(s) to {path}",
                data={"changes": changes_applied, "path": path}
            )

        except UnicodeDecodeError:
            return ToolResult(
                success=False,
                error=f"Cannot edit '{path}': file appears to be binary. "
                      f"This tool only supports text files."
            )
        except PermissionError:
            return ToolResult(
                success=False,
                error=f"Permission denied: cannot edit '{path}'. "
                      f"Check file permissions."
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to edit '{path}': {str(e)}"
            )

    async def _tool_run_tests(self, test_path: str | None) -> ToolResult:
        """Run test suite"""
        # Safety check: repo_path must be set
        if not self.repo_path:
            return ToolResult(
                success=False,
                error="Repository path not configured. Cannot run tests."
            )

        try:
            # Validate test_path if provided
            if test_path:
                full_test_path = self.repo_path / test_path

                # Safety check: prevent path traversal
                resolved_path = full_test_path.resolve()
                resolved_repo = self.repo_path.resolve()
                if not resolved_path.is_relative_to(resolved_repo):
                    return ToolResult(
                        success=False,
                        error=f"Access denied: test path '{test_path}' is outside repository bounds."
                    )

                # Check if test path exists
                if not full_test_path.exists():
                    return ToolResult(
                        success=False,
                        error=f"Test path not found: '{test_path}'. "
                              f"Check the path is correct."
                    )

            # Check if pytest is available
            # Try to find pytest
            check_pytest = await asyncio.create_subprocess_exec(
                "which", "pytest",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await check_pytest.communicate()

            if check_pytest.returncode != 0:
                return ToolResult(
                    success=False,
                    error="Test runner 'pytest' not found. "
                          "Install it with: pip install pytest"
                )

            # Run tests with timeout
            cmd = ["pytest", test_path] if test_path else ["pytest"]

            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            # Wait with timeout (5 minutes)
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=300  # 5 minutes
                )
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                return ToolResult(
                    success=False,
                    error="Tests timed out after 5 minutes. "
                          "This may indicate hanging tests or an infinite loop. "
                          "Consider running specific test files instead of the entire suite."
                )

            stdout_str = stdout.decode() if stdout else ""
            stderr_str = stderr.decode() if stderr else ""

            if process.returncode == 0:
                return ToolResult(
                    success=True,
                    output=stdout_str,
                    data={"exit_code": 0, "test_path": test_path}
                )
            else:
                # Provide helpful error message
                error_msg = stderr_str if stderr_str else stdout_str
                return ToolResult(
                    success=False,
                    output=stdout_str,
                    error=f"Tests failed with exit code {process.returncode}. "
                          f"Review the output to identify failing tests.",
                    data={"exit_code": process.returncode, "stderr": error_msg[:500]}
                )

        except FileNotFoundError as e:
            return ToolResult(
                success=False,
                error=f"Command not found: {str(e)}. "
                      f"Ensure pytest is installed and in PATH."
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to run tests: {str(e)}"
            )

    async def _tool_git_commit(self, message: str, files: list[str] | None) -> ToolResult:
        """Create a git commit"""
        # Safety check: repo_path must be set
        if not self.repo_path:
            return ToolResult(
                success=False,
                error="Repository path not configured. Cannot perform git operations."
            )

        # Validate commit message
        if not message or not message.strip():
            return ToolResult(
                success=False,
                error="Commit message cannot be empty. Provide a descriptive commit message."
            )

        try:
            # Safety check: verify we're in a git repository
            check_git = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "--git-dir",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await check_git.communicate()

            if check_git.returncode != 0:
                return ToolResult(
                    success=False,
                    error=f"Not a git repository: {self.repo_path}. "
                          f"Cannot perform git operations."
                )

            # Safety check: verify there are changes to commit
            status_process = await asyncio.create_subprocess_exec(
                "git", "status", "--porcelain",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            status_stdout, _ = await status_process.communicate()

            if not status_stdout or not status_stdout.decode().strip():
                return ToolResult(
                    success=False,
                    error="No changes to commit. Working tree is clean. "
                          "Make changes to files before creating a commit."
                )

            # Validate and add files
            if files:
                for file in files:
                    file_path = self.repo_path / file

                    # Safety check: prevent path traversal
                    resolved_path = file_path.resolve()
                    resolved_repo = self.repo_path.resolve()
                    if not resolved_path.is_relative_to(resolved_repo):
                        return ToolResult(
                            success=False,
                            error=f"Access denied: '{file}' is outside repository bounds."
                        )

                    # Safety check: prevent adding .git directory
                    try:
                        relative_path = resolved_path.relative_to(resolved_repo)
                        path_parts = relative_path.parts
                        if path_parts and path_parts[0] == '.git':
                            return ToolResult(
                                success=False,
                                error=f"Access denied: cannot add files from .git directory."
                            )
                    except ValueError:
                        pass

                    # Check if file exists
                    if not file_path.exists():
                        return ToolResult(
                            success=False,
                            error=f"File not found: '{file}'. "
                                  f"Cannot add non-existent file to commit."
                        )

                    # Add the file
                    process = await asyncio.create_subprocess_exec(
                        "git", "add", file,
                        cwd=self.repo_path,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE
                    )
                    stdout, stderr = await process.communicate()

                    if process.returncode != 0:
                        return ToolResult(
                            success=False,
                            error=f"Failed to add '{file}': {stderr.decode() if stderr else 'Unknown error'}"
                        )
            else:
                # Add all changes
                process = await asyncio.create_subprocess_exec(
                    "git", "add", "-A",
                    cwd=self.repo_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                await process.communicate()

                if process.returncode != 0:
                    return ToolResult(
                        success=False,
                        error="Failed to stage changes. Check git status."
                    )

            # Create commit
            process = await asyncio.create_subprocess_exec(
                "git", "commit", "-m", message,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await process.communicate()

            if process.returncode == 0:
                return ToolResult(
                    success=True,
                    output=f"Successfully created commit: {message[:60]}{'...' if len(message) > 60 else ''}",
                    data={"message": message, "files": files if files else "all changes"}
                )
            else:
                error_output = stderr.decode() if stderr else "Unknown error"

                # Provide helpful error messages
                if "nothing to commit" in error_output.lower():
                    return ToolResult(
                        success=False,
                        error="No changes to commit. All changes may have been already committed."
                    )
                elif "hook" in error_output.lower():
                    return ToolResult(
                        success=False,
                        error=f"Git hook failed: {error_output}. "
                              f"Fix the issues identified by the pre-commit hook."
                    )
                else:
                    return ToolResult(
                        success=False,
                        error=f"Commit failed: {error_output}"
                    )

        except FileNotFoundError:
            return ToolResult(
                success=False,
                error="Git command not found. Ensure git is installed and in PATH."
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to create commit: {str(e)}"
            )
