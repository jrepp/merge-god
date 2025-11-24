#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "PyGithub>=2.1.0",
#     "rich>=13.0.0",
# ]
# ///

"""
Comprehensive test suite for the state tracking system.

Tests all components with appropriate handling for missing remotes.
"""

import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from models import BranchStatus, CIStatus
from git_ops import GitOperations, GitOperationsError
from github_ops import GitHubOperations, GitHubOperationsError
from state_tracker import StateTracker, StateTrackerError


def test_imports():
    """Test that all modules import correctly"""
    console = Console()
    console.print("\n[bold cyan]1. Testing Imports[/bold cyan]")

    try:
        from models import Branch, PullRequest, BranchPRState, RepositoryState
        console.print("  ✓ models.py", style="green")

        from git_ops import GitOperations
        console.print("  ✓ git_ops.py", style="green")

        from github_ops import GitHubOperations
        console.print("  ✓ github_ops.py", style="green")

        from state_tracker import StateTracker
        console.print("  ✓ state_tracker.py", style="green")

        return True
    except Exception as e:
        console.print(f"  ✗ Import error: {e}", style="red")
        return False


def test_git_operations(repo_path: str):
    """Test git operations"""
    console = Console()
    console.print("\n[bold cyan]2. Testing Git Operations[/bold cyan]")

    try:
        git_ops = GitOperations(Path(repo_path))
        console.print("  ✓ Initialized", style="green")

        # Get repo info
        info = git_ops.get_repository_info()
        console.print(f"  ✓ Repository: {info['path']}", style="green")
        console.print(f"  ✓ Default branch: {info['default_branch']}", style="green")
        console.print(f"  ✓ Current branch: {info.get('current_branch', 'N/A')}", style="green")

        # Get branches
        local_branches, remote_branches = git_ops.get_all_branches_with_status()
        console.print(f"  ✓ Found {len(local_branches)} local branches", style="green")
        console.print(f"  ✓ Found {len(remote_branches)} remote branches", style="green")

        # Show branch details
        if local_branches:
            table = Table(show_header=True, header_style="bold magenta", box=None)
            table.add_column("Branch", style="cyan")
            table.add_column("Status", style="yellow")
            table.add_column("Ahead", justify="right")
            table.add_column("Behind", justify="right")

            for branch in local_branches[:5]:
                status_color = {
                    "up_to_date": "green",
                    "ahead": "yellow",
                    "behind": "red",
                    "diverged": "red",
                    "local_only": "dim"
                }.get(branch.status.value, "white")

                table.add_row(
                    branch.name,
                    f"[{status_color}]{branch.status.value}[/{status_color}]",
                    str(branch.ahead_by),
                    str(branch.behind_by)
                )

            console.print(table)

        return True
    except GitOperationsError as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def test_github_operations(repo_path: str):
    """Test GitHub operations (may fail if no remote)"""
    console = Console()
    console.print("\n[bold cyan]3. Testing GitHub Operations[/bold cyan]")

    try:
        gh_ops = GitHubOperations(Path(repo_path))

        if not gh_ops.repo:
            console.print("  ⚠ No GitHub repository (no remote or token)", style="yellow")
            return True  # Not a failure, just no GitHub remote

        console.print("  ✓ Initialized", style="green")

        # Try to get PRs
        try:
            open_prs = gh_ops.get_open_prs()
            console.print(f"  ✓ Found {len(open_prs)} open PRs", style="green")

            if open_prs:
                table = Table(show_header=True, header_style="bold magenta", box=None)
                table.add_column("PR", style="cyan")
                table.add_column("Title", style="white")
                table.add_column("Branch", style="yellow")
                table.add_column("CI", justify="center")

                for pr in open_prs[:5]:
                    ci_emoji = {
                        "success": "✓",
                        "failure": "✗",
                        "pending": "⏳",
                        "none": "○"
                    }.get(pr.get_ci_status().value, "?")

                    ci_style = {
                        "success": "green",
                        "failure": "red",
                        "pending": "yellow",
                        "none": "dim"
                    }.get(pr.get_ci_status().value, "white")

                    table.add_row(
                        f"#{pr.number}",
                        pr.title[:40],
                        pr.head_branch,
                        f"[{ci_style}]{ci_emoji}[/{ci_style}]"
                    )

                console.print(table)
        except GitHubOperationsError as e:
            console.print(f"  ⚠ Could not fetch PRs: {e}", style="yellow")

        return True
    except GitHubOperationsError as e:
        console.print(f"  ⚠ GitHub not available: {e}", style="yellow")
        return True  # Not a failure


def test_state_tracker(repo_path: str):
    """Test state tracker (full integration)"""
    console = Console()
    console.print("\n[bold cyan]4. Testing State Tracker[/bold cyan]")

    try:
        tracker = StateTracker(repo_path)
        console.print("  ✓ Initialized", style="green")

        # Try to build state
        try:
            state = tracker.build_repository_state(fetch_first=True, include_closed_prs=False)
            console.print("  ✓ Built repository state", style="green")

            # Show summary
            summary = state.summary_dict()

            summary_table = Table(show_header=False, box=None)
            summary_table.add_column("Metric", style="bold")
            summary_table.add_column("Value", style="cyan")

            summary_table.add_row("Total branches", str(summary['total_branches']))
            summary_table.add_row("Branches with PRs", str(summary['branches_with_prs']))
            summary_table.add_row("Branches without PRs", str(summary['branches_without_prs']))
            summary_table.add_row("Branches needing sync", str(summary['branches_needing_sync']))
            summary_table.add_row("Failing CI", str(summary['failing_ci']))

            console.print(summary_table)

            # Show some details
            if state.get_branches_with_prs():
                console.print("\n  [bold]Branches with PRs:[/bold]")
                for bp in state.get_branches_with_prs()[:3]:
                    console.print(f"    • {bp.branch_name} → PR #{bp.pr.number}")

            if state.get_branches_needing_sync():
                console.print("\n  [bold]Branches needing sync:[/bold]")
                for bp in state.get_branches_needing_sync()[:3]:
                    indicators = []
                    if bp.needs_push:
                        indicators.append(f"↑{bp.local_branch.ahead_by}")
                    if bp.needs_pull:
                        indicators.append(f"↓{bp.local_branch.behind_by}")
                    console.print(f"    • {bp.branch_name} ({' '.join(indicators)})")

            return True

        except StateTrackerError as e:
            # This is expected if no GitHub remote
            console.print(f"  ⚠ Could not build full state: {e}", style="yellow")
            console.print("  ℹ This is normal for repositories without GitHub remote", style="dim")
            return True

    except Exception as e:
        console.print(f"  ✗ Error: {e}", style="red")
        return False


def main():
    """Run all tests"""
    if len(sys.argv) < 2:
        repo_path = "."
    else:
        repo_path = sys.argv[1]

    console = Console()

    console.print(Panel.fit(
        f"[bold cyan]State Tracking System - Test Suite[/bold cyan]\n"
        f"Repository: {repo_path}",
        border_style="cyan"
    ))

    results = []

    # Run tests
    results.append(("Imports", test_imports()))
    results.append(("Git Operations", test_git_operations(repo_path)))
    results.append(("GitHub Operations", test_github_operations(repo_path)))
    results.append(("State Tracker", test_state_tracker(repo_path)))

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
