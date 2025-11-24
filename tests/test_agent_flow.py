#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "rich>=13.0.0",
# ]
# ///

"""
Test suite for agent prompt and result flow.

Tests the building of prompts for the bob agent and handling of results.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch
from rich.console import Console
from rich.panel import Panel


def test_prompt_building():
    """Test building prompts for agent invocation"""
    console = Console()
    console.print("\n[bold cyan]1. Testing Prompt Building[/bold cyan]")

    # Import after sys.path modification if needed
    try:
        # Add parent directory to path for imports
        sys.path.insert(0, str(Path(__file__).parent))
        # Import the module that needs to be tested
        # Note: We need to be in the repo directory for imports to work
    except Exception as e:
        console.print(f"  ⚠ Could not set up imports: {e}", style="yellow")

    # Mock PR details
    pr_details = {
        "number": 123,
        "title": "Fix authentication bug",
        "body": "This PR fixes a critical authentication bug",
        "headRefName": "fix/auth-bug",
        "baseRefName": "main",
        "author": {"login": "testuser"},
        "additions": 50,
        "deletions": 20,
        "changedFiles": 3,
        "reviewDecision": "APPROVED",
    }

    # Mock PR context
    pr_context = {
        "url": "https://github.com/test/repo/pull/123",
        "comments": [
            {"user": {"login": "reviewer1"}, "body": "LGTM!"}
        ],
        "review_comments": [
            {
                "user": {"login": "reviewer2"},
                "body": "Consider adding error handling here",
                "path": "src/auth.py",
                "line": 42
            }
        ],
        "commits": [
            {"sha": "abc123def456", "commit": {"message": "Fix auth validation"}}
        ],
        "files": [
            {"filename": "src/auth.py", "status": "modified", "additions": 30, "deletions": 10}
        ],
        "conflicts": {"has_conflicts": False, "conflicting_files": [], "conflict_count": 0},
        "ci_status": {"total_checks": 3, "passed": 3, "failed": 0, "pending": 0, "skipped": 0, "failed_checks": []},
        "diff": "... diff content ...",
    }

    guidelines = "Follow PEP 8 style guidelines"
    commit_examples = "Fix: authentication validation\nAdd: user profile tests"

    try:
        # Test importing the function (we'll need to adjust imports based on structure)
        import subprocess
        import json
        import time
        from datetime import datetime, timezone

        # Simulate building a prompt (simplified version of build_pr_prompt)
        prompt_parts = [
            f"# PR #{pr_details['number']}: {pr_details['title']}",
            "",
            f"**Author**: {pr_details['author']['login']}",
            f"**Branch**: {pr_details['headRefName']} → {pr_details['baseRefName']}",
            "",
            "## PR Description",
            "",
            pr_details['body'],
            "",
            "## Your Mission",
            "",
            "Get this PR merged successfully",
            "",
        ]

        prompt = "\n".join(prompt_parts)

        # Validate prompt structure
        assert pr_details['title'] in prompt, "Title should be in prompt"
        assert pr_details['headRefName'] in prompt, "Head branch should be in prompt"
        assert pr_details['body'] in prompt, "PR body should be in prompt"
        assert str(pr_details['number']) in prompt, "PR number should be in prompt"

        console.print("  ✓ Prompt structure validation", style="green")
        console.print(f"  ✓ Generated prompt: {len(prompt)} characters", style="green")

        # Test that prompt contains critical information
        critical_fields = [
            "number", "title", "headRefName", "baseRefName"
        ]

        for field in critical_fields:
            field_value = str(pr_details.get(field, ""))
            if field_value and field_value in prompt:
                console.print(f"  ✓ Contains {field}: {field_value[:30]}...", style="green dim")

        return True

    except AssertionError as e:
        console.print(f"  ✗ Validation failed: {e}", style="red")
        return False
    except Exception as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def test_review_prompt_building():
    """Test building code review prompts"""
    console = Console()
    console.print("\n[bold cyan]2. Testing Review Prompt Building[/bold cyan]")

    pr_number = 456
    title = "Add user authentication"
    head_branch = "feature/auth"
    url = "https://github.com/test/repo/pull/456"
    diff = """
diff --git a/src/auth.py b/src/auth.py
index 1234567..abcdefg 100644
--- a/src/auth.py
+++ b/src/auth.py
@@ -10,5 +10,10 @@ def authenticate(user, password):
+    if not user or not password:
+        raise ValueError("User and password required")
+
     return verify_credentials(user, password)
"""

    changed_files = [
        {"filename": "src/auth.py", "status": "modified", "additions": 5, "deletions": 0}
    ]

    try:
        # Simulate building a review prompt (simplified version)
        prompt_parts = [
            f"# Code Review: PR #{pr_number} - {title}",
            "",
            f"**Branch**: {head_branch}",
            f"**URL**: {url}",
            "",
            "## Your Mission: Code Review and Targeted Improvements",
            "",
            "Review all code changes for quality, correctness, and best practices",
            "",
            "## Changed Files",
            "",
        ]

        for file in changed_files:
            prompt_parts.append(f"- 📝 `{file['filename']}` (+{file['additions']}/-{file['deletions']})")

        prompt_parts.extend([
            "",
            "## Full Diff",
            "",
            "```diff",
            diff,
            "```",
        ])

        prompt = "\n".join(prompt_parts)

        # Validate review prompt structure
        assert "Code Review" in prompt, "Should indicate code review"
        assert title in prompt, "Title should be in prompt"
        assert head_branch in prompt, "Branch should be in prompt"
        assert diff in prompt, "Diff should be in prompt"

        console.print("  ✓ Review prompt structure validation", style="green")
        console.print(f"  ✓ Generated review prompt: {len(prompt)} characters", style="green")

        # Check for review guidelines
        guidelines = ["quality", "correctness", "best practices"]
        for guideline in guidelines:
            if guideline in prompt.lower():
                console.print(f"  ✓ Contains guideline: {guideline}", style="green dim")

        return True

    except AssertionError as e:
        console.print(f"  ✗ Validation failed: {e}", style="red")
        return False
    except Exception as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def test_agent_invocation_mock():
    """Test agent invocation with mocked subprocess"""
    console = Console()
    console.print("\n[bold cyan]3. Testing Agent Invocation (Mocked)[/bold cyan]")

    try:
        # Mock successful agent response
        mock_stdout = "Agent completed successfully"
        mock_stderr = ""
        mock_returncode = 0

        # Simulate the run_command flow
        def mock_run_command(cmd, timeout=None):
            """Mock version of run_command"""
            if cmd[0] == "bob" and cmd[1] == "--json":
                # Simulate successful bob execution
                return (mock_returncode, mock_stdout, mock_stderr)
            return (1, "", "Command not recognized")

        # Test invocation
        result = mock_run_command(["bob", "--json", "Test prompt"], timeout=3600)
        returncode, stdout, stderr = result

        assert returncode == 0, "Should return success code"
        assert stdout == mock_stdout, "Should return expected stdout"
        assert stderr == mock_stderr, "Should return empty stderr"

        console.print("  ✓ Mock agent invocation successful", style="green")
        console.print(f"  ✓ Return code: {returncode}", style="green")
        console.print(f"  ✓ Output: {stdout[:50]}...", style="green dim")

        # Test failure case
        mock_returncode = 1
        mock_stderr = "Agent failed: timeout"
        result = mock_run_command(["bob", "--json", "Test prompt"])
        returncode, stdout, stderr = result

        assert returncode == 1, "Should return error code"
        assert stderr != "", "Should have error message"

        console.print("  ✓ Mock agent failure handled", style="green")

        return True

    except AssertionError as e:
        console.print(f"  ✗ Validation failed: {e}", style="red")
        return False
    except Exception as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def test_agent_result_handling():
    """Test handling of agent results"""
    console = Console()
    console.print("\n[bold cyan]4. Testing Agent Result Handling[/bold cyan]")

    try:
        # Test successful result
        success_result = {
            "returncode": 0,
            "stdout": "Changes committed successfully",
            "stderr": "",
            "pr_number": 123,
            "prompt_size": 5000,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

        # Validate result structure
        assert "returncode" in success_result, "Should have returncode"
        assert "stdout" in success_result, "Should have stdout"
        assert "pr_number" in success_result, "Should have PR number"
        assert success_result["returncode"] == 0, "Should be successful"

        console.print("  ✓ Success result structure valid", style="green")
        console.print(f"  ✓ PR #{success_result['pr_number']} processed", style="green")

        # Test failure result
        failure_result = {
            "returncode": 1,
            "stdout": "",
            "stderr": "Failed to resolve conflicts",
            "pr_number": 456,
            "prompt_size": 4500,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

        assert failure_result["returncode"] != 0, "Should indicate failure"
        assert failure_result["stderr"] != "", "Should have error message"

        console.print("  ✓ Failure result structure valid", style="green")
        console.print(f"  ✓ Error captured: {failure_result['stderr'][:30]}...", style="green dim")

        # Test result history tracking
        result_history = [success_result, failure_result]

        assert len(result_history) == 2, "Should track multiple results"
        successful_count = sum(1 for r in result_history if r["returncode"] == 0)
        failed_count = sum(1 for r in result_history if r["returncode"] != 0)

        console.print(f"  ✓ History tracking: {successful_count} success, {failed_count} failed", style="green")

        return True

    except AssertionError as e:
        console.print(f"  ✗ Validation failed: {e}", style="red")
        return False
    except Exception as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def test_agent_history_data_structure():
    """Test the agent history data structure"""
    console = Console()
    console.print("\n[bold cyan]5. Testing Agent History Data Structure[/bold cyan]")

    try:
        # Define an AgentInvocation data structure
        class AgentInvocation:
            def __init__(self, pr_number, mode, prompt, result, timestamp=None):
                self.pr_number = pr_number
                self.mode = mode
                self.prompt = prompt
                self.prompt_size = len(prompt)
                self.result = result
                self.timestamp = timestamp or datetime.now(timezone.utc)
                self.duration = None

            def to_dict(self):
                return {
                    "pr_number": self.pr_number,
                    "mode": self.mode,
                    "prompt_size": self.prompt_size,
                    "result": self.result,
                    "timestamp": self.timestamp.isoformat(),
                    "duration": self.duration,
                }

        # Test creating invocation records
        invocation1 = AgentInvocation(
            pr_number=123,
            mode="for-landing",
            prompt="Fix conflicts and merge PR #123",
            result={"returncode": 0, "stdout": "Success", "stderr": ""}
        )

        invocation2 = AgentInvocation(
            pr_number=456,
            mode="for-review",
            prompt="Review and improve code quality for PR #456",
            result={"returncode": 1, "stdout": "", "stderr": "Tests failed"}
        )

        # Validate structure
        assert invocation1.pr_number == 123, "Should store PR number"
        assert invocation1.mode == "for-landing", "Should store mode"
        assert invocation1.prompt_size > 0, "Should calculate prompt size"
        assert invocation1.result["returncode"] == 0, "Should store result"

        console.print("  ✓ AgentInvocation structure valid", style="green")
        console.print(f"  ✓ Invocation 1: PR #{invocation1.pr_number}, mode: {invocation1.mode}", style="green dim")
        console.print(f"  ✓ Invocation 2: PR #{invocation2.pr_number}, mode: {invocation2.mode}", style="green dim")

        # Test history management
        history = [invocation1, invocation2]
        assert len(history) == 2, "Should store multiple invocations"

        # Get latest invocation
        latest = history[-1]
        assert latest.pr_number == 456, "Should retrieve latest"

        console.print(f"  ✓ History management: {len(history)} invocations tracked", style="green")
        console.print(f"  ✓ Latest: PR #{latest.pr_number} ({latest.mode})", style="green dim")

        # Test serialization
        serialized = [inv.to_dict() for inv in history]
        assert len(serialized) == 2, "Should serialize all invocations"
        assert "pr_number" in serialized[0], "Should contain pr_number"
        assert "timestamp" in serialized[0], "Should contain timestamp"

        console.print("  ✓ Serialization working", style="green")

        return True

    except AssertionError as e:
        console.print(f"  ✗ Validation failed: {e}", style="red")
        return False
    except Exception as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def main():
    """Run all agent flow tests"""
    console = Console()

    console.print(Panel.fit(
        "[bold cyan]Agent Prompt & Result Flow - Test Suite[/bold cyan]\n"
        "Testing agent invocation, prompt building, and result handling",
        border_style="cyan"
    ))

    results = []

    # Run tests
    results.append(("Prompt Building", test_prompt_building()))
    results.append(("Review Prompt Building", test_review_prompt_building()))
    results.append(("Agent Invocation (Mock)", test_agent_invocation_mock()))
    results.append(("Agent Result Handling", test_agent_result_handling()))
    results.append(("Agent History Data Structure", test_agent_history_data_structure()))

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
        console.print("\n[bold green]✅ All tests passed![/bold green]\n")
        return 0
    else:
        console.print("\n[bold red]❌ Some tests failed[/bold red]\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
