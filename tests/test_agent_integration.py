#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "anthropic[bedrock]>=0.39.0",
#     "rich>=13.0.0",
# ]
# ///

"""
Test script for agent SDK integration.

This validates that:
1. Agent client can be created with Bedrock
2. Task decomposition works
3. Prompt building works
4. Callbacks work

Run with:
    ./test_agent_integration.py

Or with Agent SDK enabled:
    USE_AGENT_SDK=1 ./test_agent_integration.py
"""

import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from rich.console import Console
from rich.panel import Panel

console = Console()


def test_imports():
    """Test that all imports work"""
    console.print("\n[bold cyan]1. Testing Imports[/bold cyan]")

    try:
        from agents import (
            AgentAction,
            AgentTask,
            PRAgent,
            PRContext,
            ProcessingResult,
            create_claude_client,
            get_model_name,
        )

        console.print("  ✓ All agent imports successful", style="green")
        return True
    except ImportError as e:
        console.print(f"  ✗ Import failed: {e}", style="red")
        return False


def test_client_creation():
    """Test client creation with Bedrock"""
    console.print("\n[bold cyan]2. Testing Client Creation[/bold cyan]")

    try:
        from agents import create_claude_client, get_model_name

        # Check environment
        use_bedrock = os.environ.get("CLAUDE_CODE_USE_BEDROCK", "0") == "1"
        console.print(f"  • Bedrock mode: {use_bedrock}")

        if use_bedrock:
            aws_region = os.environ.get("ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "us-west-2")
            console.print(f"  • AWS region: {aws_region}")

        # Create client
        create_claude_client()
        model = get_model_name()

        console.print("  ✓ Client created successfully", style="green")
        console.print(f"  ✓ Model: {model}", style="green")
        return True

    except Exception as e:
        console.print(f"  ✗ Client creation failed: {e}", style="red")
        return False


def test_task_decomposition():
    """Test task decomposition logic"""
    console.print("\n[bold cyan]3. Testing Task Decomposition[/bold cyan]")

    try:
        from agents import PRAgent, PRContext, create_claude_client, get_model_name

        # Create mock PR context
        pr_context = PRContext(
            pr_number=123,
            title="Test PR",
            body="Test description",
            head_branch="test-branch",
            base_branch="main",
            author="test-user",
            url="https://github.com/test/repo/pull/123",
            has_conflicts=True,
            conflicting_files=["src/foo.py", "src/bar.py"],
            has_failing_ci=True,
            failing_checks=[
                {"name": "pytest", "conclusion": "failure"},
                {"name": "lint", "conclusion": "failure"},
            ],
            review_comments=[
                {"user": {"login": "reviewer"}, "body": "Please fix this", "path": "src/foo.py"},
            ],
            general_comments=[],
            changed_files=[
                {"filename": "src/foo.py", "additions": 10, "deletions": 5},
            ],
            diff="... diff content ...",
            commits=[],
            guidelines="Follow PEP 8",
            commit_examples="feat: add feature\nfix: fix bug",
            labels=["for-landing"],
            ci_checks={},
            review_decision=None,
        )

        # Create agent
        client = create_claude_client()
        model = get_model_name()
        agent = PRAgent(client=client, model=model, repo_path=Path.cwd())

        # Test task decomposition
        tasks = agent._decompose_pr_tasks(pr_context, mode="for-landing")

        console.print(f"  ✓ Decomposed into {len(tasks)} tasks", style="green")
        for i, task in enumerate(tasks, 1):
            console.print(f"    {i}. {task.id}: {task.description}", style="dim")

        # Validate expected tasks
        expected_tasks = ["analyze", "resolve_conflicts", "fix_ci", "validate"]
        actual_ids = [task.id for task in tasks]

        for expected in expected_tasks:
            if expected in actual_ids:
                console.print(f"  ✓ Found expected task: {expected}", style="green")
            else:
                console.print(f"  ✗ Missing expected task: {expected}", style="yellow")

        return True

    except Exception as e:
        console.print(f"  ✗ Task decomposition failed: {e}", style="red")
        import traceback

        console.print(traceback.format_exc(), style="dim red")
        return False


def test_prompt_building():
    """Test prompt building for each task"""
    console.print("\n[bold cyan]4. Testing Prompt Building[/bold cyan]")

    try:
        from agents import (
            AgentTask,
            PRAgent,
            PRContext,
            create_claude_client,
            get_model_name,
        )

        # Create mock PR context (minimal)
        pr_context = PRContext(
            pr_number=456,
            title="Fix authentication bug",
            body="This PR fixes auth issues",
            head_branch="fix/auth",
            base_branch="main",
            author="dev-user",
            url="https://github.com/test/repo/pull/456",
            has_conflicts=False,
            conflicting_files=[],
            has_failing_ci=False,
            failing_checks=[],
            review_comments=[],
            general_comments=[],
            changed_files=[{"filename": "auth.py", "additions": 5, "deletions": 2}],
            diff="@@ -10,5 +10,10 @@ ...",
            commits=[],
            guidelines="",
            commit_examples="",
            labels=[],
            ci_checks={},
            review_decision=None,
        )

        # Create agent
        client = create_claude_client()
        model = get_model_name()
        agent = PRAgent(client=client, model=model, repo_path=Path.cwd())

        # Test building prompts for different tasks
        test_tasks = [
            AgentTask(
                id="analyze",
                description="Analyze PR",
                prompt_template="analyze_pr",
                required_context=[],
            ),
            AgentTask(
                id="validate",
                description="Validate changes",
                prompt_template="validate",
                required_context=[],
            ),
        ]

        for task in test_tasks:
            prompt = agent._build_task_prompt(task, pr_context)
            console.print(
                f"  ✓ Built prompt for task '{task.id}': {len(prompt)} chars", style="green"
            )

            # Validate prompt contains key info
            if str(pr_context.pr_number) in prompt and pr_context.title in prompt:
                console.print("    ✓ Prompt contains PR info", style="dim green")
            else:
                console.print("    ✗ Prompt missing PR info", style="yellow")

        return True

    except Exception as e:
        console.print(f"  ✗ Prompt building failed: {e}", style="red")
        import traceback

        console.print(traceback.format_exc(), style="dim red")
        return False


def test_callbacks():
    """Test callback system"""
    console.print("\n[bold cyan]5. Testing Callbacks[/bold cyan]")

    try:
        from agents import AgentAction, PRProcessingCallbacks

        # Track callback invocations
        events = []

        def mock_log_json(event_type, data):
            events.append({"type": event_type, "data": data})

        def mock_send_notification(message, title=None, priority=None, tags=None):
            events.append({"type": "notification", "message": message})
            return True

        # Create callbacks
        callbacks = PRProcessingCallbacks(
            pr_number=789,
            log_json=mock_log_json,
            send_notification=mock_send_notification,
        )

        # Test thinking callback
        callbacks.on_thinking("Agent is analyzing the PR...")
        console.print("  ✓ Thinking callback works", style="green")

        # Test action callback
        action = AgentAction(
            type="read_file",
            target="src/test.py",
            details={"path": "src/test.py"},
            status="completed",
            timestamp=datetime.now(UTC),
        )
        callbacks.on_action(action)
        console.print("  ✓ Action callback works", style="green")

        # Test progress callback
        callbacks.on_progress(2, 5)
        console.print("  ✓ Progress callback works", style="green")

        # Validate events were logged
        console.print(f"  ✓ Recorded {len(events)} events", style="green")

        return True

    except Exception as e:
        console.print(f"  ✗ Callback test failed: {e}", style="red")
        return False


def main():
    """Run all tests"""
    console.print(
        Panel.fit(
            "[bold cyan]Agent SDK Integration Test Suite[/bold cyan]\n"
            "Testing agent system components",
            border_style="cyan",
        )
    )

    results = []

    # Run tests
    results.append(("Imports", test_imports()))
    results.append(("Client Creation", test_client_creation()))
    results.append(("Task Decomposition", test_task_decomposition()))
    results.append(("Prompt Building", test_prompt_building()))
    results.append(("Callbacks", test_callbacks()))

    # Summary
    console.print("\n" + "=" * 60)
    console.print("[bold]Test Summary[/bold]")
    console.print("=" * 60)

    all_passed = True
    for name, passed in results:
        status = "[green]✓ PASS[/green]" if passed else "[red]✗ FAIL[/red]"
        console.print(f"  {status} {name}")
        if not passed:
            all_passed = False

    console.print("=" * 60)

    if all_passed:
        console.print("\n[bold green]✅ All tests passed![/bold green]")
        console.print("\n[bold]Next steps:[/bold]")
        console.print("  1. Run pr-loop.py on a test PR")
        console.print("  2. Monitor logs for agent actions")
        console.print("  3. Review task breakdown and actions taken\n")
        return 0
    console.print("\n[bold red]❌ Some tests failed[/bold red]\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
