#!/usr/bin/env python3
"""
Agent Results Evaluation Script

Comprehensive evaluation of agent session performance and quality.

Usage:
    # Evaluate latest session
    ./evaluate_agent_results.py --repo "prism merge" --pr 134 --latest

    # Evaluate specific session
    ./evaluate_agent_results.py --repo "prism merge" --pr 134 --session abc123

    # Compare multiple sessions
    ./evaluate_agent_results.py --repo "prism merge" --pr 134 --compare
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

# Add project to path
sys.path.insert(0, str(Path(__file__).parent))

from merge_god.db_operations import StateDatabase  # noqa: E402


def format_duration(seconds: float | None) -> str:
    """Format duration in human-readable form"""
    if seconds is None:
        return "N/A"
    if seconds < 60:
        return f"{seconds:.1f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    return f"{seconds/3600:.1f}h"


def format_cost(cost: float | None) -> str:
    """Format cost with currency"""
    if cost is None:
        return "N/A"
    return f"${cost:.4f}"


def evaluate_session(
    db: StateDatabase, session_id: str, console: Console, verbose: bool = False
) -> dict[str, Any]:
    """
    Evaluate a single agent session.

    Returns evaluation metrics dictionary.
    """
    # Get complete session details
    session = db.get_session_details(session_id)
    if not session:
        console.print(f"[red]✗ Session not found: {session_id}[/red]")
        return {}

    console.print(f"\n[bold cyan]Session Evaluation: {session_id[:8]}...[/bold cyan]")

    # Basic session info
    info_table = Table(title="Session Information", show_header=False)
    info_table.add_column("Field", style="cyan")
    info_table.add_column("Value", style="white")

    info_table.add_row("Repository", session["repo_name"])
    info_table.add_row("PR Number", str(session["pr_number"]))
    info_table.add_row("Mode", session["mode"])
    info_table.add_row("Status", session["status"])
    info_table.add_row("Success", "✅ Yes" if session["success"] else "❌ No")
    info_table.add_row("Model", session["model"] or "N/A")
    info_table.add_row(
        "Started",
        datetime.fromisoformat(session["started_at"]).strftime("%Y-%m-%d %H:%M:%S")
        if session["started_at"]
        else "N/A",
    )
    info_table.add_row(
        "Completed",
        datetime.fromisoformat(session["completed_at"]).strftime("%Y-%m-%d %H:%M:%S")
        if session["completed_at"]
        else "N/A",
    )
    info_table.add_row("Duration", format_duration(session["duration_seconds"]))

    console.print(info_table)

    # Task completion metrics
    task_table = Table(title="Task Metrics", show_header=True)
    task_table.add_column("Metric", style="cyan")
    task_table.add_column("Count", justify="right", style="white")
    task_table.add_column("Percentage", justify="right", style="white")

    total_tasks = session["tasks_total"] or 0
    completed_tasks = session["tasks_completed"] or 0
    failed_tasks = session["tasks_failed"] or 0

    if total_tasks > 0:
        completion_rate = (completed_tasks / total_tasks) * 100
        failure_rate = (failed_tasks / total_tasks) * 100
    else:
        completion_rate = 0
        failure_rate = 0

    task_table.add_row("Total Tasks", str(total_tasks), "100%")
    task_table.add_row("Completed", str(completed_tasks), f"{completion_rate:.1f}%")
    task_table.add_row("Failed", str(failed_tasks), f"{failure_rate:.1f}%")

    console.print(task_table)

    # Token usage and cost
    token_table = Table(title="Token Usage & Cost", show_header=True)
    token_table.add_column("Metric", style="cyan")
    token_table.add_column("Value", justify="right", style="white")

    token_table.add_row(
        "Input Tokens", f"{session['input_tokens']:,}" if session["input_tokens"] else "N/A"
    )
    token_table.add_row(
        "Output Tokens", f"{session['output_tokens']:,}" if session["output_tokens"] else "N/A"
    )
    token_table.add_row(
        "Total Tokens", f"{session['total_tokens']:,}" if session["total_tokens"] else "N/A"
    )
    token_table.add_row("Estimated Cost", format_cost(session["estimated_cost"]))
    token_table.add_row("API Calls", str(session["api_calls"]) if session["api_calls"] else "N/A")

    console.print(token_table)

    # Actions summary
    actions = session.get("actions", [])
    if actions:
        action_table = Table(title="Action Summary", show_header=True)
        action_table.add_column("Action Type", style="cyan")
        action_table.add_column("Count", justify="right")
        action_table.add_column("Success Rate", justify="right")
        action_table.add_column("Avg Duration", justify="right")

        # Group actions by type
        action_stats: dict[str, dict[str, Any]] = {}
        for action in actions:
            action_type = action["action_type"]
            if action_type not in action_stats:
                action_stats[action_type] = {"count": 0, "success": 0, "durations": []}

            action_stats[action_type]["count"] += 1
            if action["success"]:
                action_stats[action_type]["success"] += 1
            if action["duration_ms"]:
                action_stats[action_type]["durations"].append(action["duration_ms"])

        for action_type, stats in sorted(action_stats.items()):
            success_rate = (stats["success"] / stats["count"]) * 100
            avg_duration = (
                sum(stats["durations"]) / len(stats["durations"]) if stats["durations"] else 0
            )

            action_table.add_row(
                action_type,
                str(stats["count"]),
                f"{success_rate:.1f}%",
                f"{avg_duration:.0f}ms" if avg_duration > 0 else "N/A",
            )

        console.print(action_table)

    # File operations
    file_ops = session.get("file_operations", [])
    if file_ops:
        file_table = Table(title="File Operations", show_header=True)
        file_table.add_column("Operation", style="cyan")
        file_table.add_column("Count", justify="right")
        file_table.add_column("Lines Added", justify="right", style="green")
        file_table.add_column("Lines Removed", justify="right", style="red")

        # Group by operation type
        op_stats: dict[str, dict[str, Any]] = {}
        for op in file_ops:
            op_type = op["operation_type"]
            if op_type not in op_stats:
                op_stats[op_type] = {"count": 0, "added": 0, "removed": 0}

            op_stats[op_type]["count"] += 1
            op_stats[op_type]["added"] += op["lines_added"] or 0
            op_stats[op_type]["removed"] += op["lines_removed"] or 0

        for op_type, stats in sorted(op_stats.items()):
            file_table.add_row(
                op_type,
                str(stats["count"]),
                f"+{stats['added']}" if stats["added"] > 0 else "0",
                f"-{stats['removed']}" if stats["removed"] > 0 else "0",
            )

        console.print(file_table)

    # Errors
    errors = session.get("errors", [])
    if errors:
        console.print(f"\n[bold red]Errors Encountered: {len(errors)}[/bold red]")

        error_tree = Tree("[red]Error Details[/red]")
        for _, error in enumerate(errors, 1):
            error_node = error_tree.add(
                f"[red]{error['error_type']}[/red] at "
                f"{datetime.fromisoformat(error['occurred_at']).strftime('%H:%M:%S')}"
            )
            error_node.add(f"[dim]{error['error_message']}[/dim]")
            if error["is_transient"]:
                error_node.add(f"[yellow]Transient (retried {error['retry_count']} times)[/yellow]")

        console.print(error_tree)

    # Overall evaluation
    console.print("\n[bold]Overall Evaluation:[/bold]")

    evaluation = {
        "session_id": session_id,
        "success": session["success"],
        "completion_rate": completion_rate,
        "total_tokens": session["total_tokens"],
        "estimated_cost": session["estimated_cost"],
        "duration_seconds": session["duration_seconds"],
        "error_count": len(errors),
    }

    # Success criteria
    criteria = []
    if session["success"]:
        criteria.append("✅ Session completed successfully")
    else:
        criteria.append("❌ Session failed")

    if completion_rate >= 90:
        criteria.append("✅ High task completion rate (≥90%)")
    elif completion_rate >= 75:
        criteria.append("⚠️  Moderate task completion rate (75-90%)")
    else:
        criteria.append("❌ Low task completion rate (<75%)")

    duration = session["duration_seconds"] or 0
    if session["mode"] == "for-landing":
        if duration < 600:  # 10 minutes
            criteria.append("✅ Good duration for landing mode (<10m)")
        else:
            criteria.append("⚠️  Slow duration for landing mode (>10m)")
    elif duration < 1200:  # for-review, 20 minutes
        criteria.append("✅ Good duration for review mode (<20m)")
    else:
        criteria.append("⚠️  Slow duration for review mode (>20m)")

    if len(errors) == 0:
        criteria.append("✅ No errors encountered")
    elif len(errors) <= 3:
        criteria.append("⚠️  Few errors encountered (≤3)")
    else:
        criteria.append("❌ Many errors encountered (>3)")

    cost = session["estimated_cost"] or 0
    if cost < 0.50:
        criteria.append("✅ Low cost (<$0.50)")
    elif cost < 1.00:
        criteria.append("⚠️  Moderate cost ($0.50-$1.00)")
    else:
        criteria.append("⚠️  High cost (>$1.00)")

    for criterion in criteria:
        console.print(f"  {criterion}")

    # Overall grade
    grade_points = 0
    if session["success"]:
        grade_points += 25
    if completion_rate >= 90:
        grade_points += 25
    elif completion_rate >= 75:
        grade_points += 15
    if len(errors) == 0:
        grade_points += 25
    elif len(errors) <= 3:
        grade_points += 15
    if duration < 600:
        grade_points += 25
    elif duration < 1200:
        grade_points += 15

    console.print(f"\n[bold]Overall Grade: {grade_points}/100[/bold]")

    if grade_points >= 90:
        console.print("[green]✅ Excellent - Agent performed very well[/green]")
    elif grade_points >= 75:
        console.print("[yellow]⚠️  Good - Agent performed adequately with minor issues[/yellow]")
    elif grade_points >= 50:
        console.print("[yellow]⚠️  Fair - Agent struggled but completed some tasks[/yellow]")
    else:
        console.print("[red]❌ Poor - Agent failed to complete the task[/red]")

    return evaluation


def compare_sessions(
    db: StateDatabase, repo_name: str, pr_number: int, console: Console, limit: int = 5
) -> None:
    """Compare multiple sessions for the same PR"""
    sessions = db.get_agent_sessions(repo_name, pr_number, limit)

    if not sessions:
        console.print("[yellow]No sessions found to compare[/yellow]")
        return

    console.print(f"\n[bold cyan]Session Comparison: {repo_name} PR #{pr_number}[/bold cyan]")

    # Comparison table
    table = Table(title=f"Recent Sessions ({len(sessions)} total)", show_header=True)
    table.add_column("Session", style="dim")
    table.add_column("Mode", style="cyan")
    table.add_column("Status", justify="center")
    table.add_column("Tasks", justify="right")
    table.add_column("Duration", justify="right")
    table.add_column("Tokens", justify="right")
    table.add_column("Cost", justify="right")
    table.add_column("Started", style="dim")

    for session in sessions:
        status_icon = "✅" if session["success"] else "❌"
        task_str = f"{session['tasks_completed']}/{session['tasks_total']}"
        duration_str = format_duration(session["duration_seconds"])
        tokens_str = f"{session['total_tokens']:,}" if session["total_tokens"] else "N/A"
        cost_str = format_cost(session["estimated_cost"])
        started_str = (
            datetime.fromisoformat(session["started_at"]).strftime("%m/%d %H:%M")
            if session["started_at"]
            else "N/A"
        )

        table.add_row(
            session["session_id"][:8] + "...",
            session["mode"],
            status_icon,
            task_str,
            duration_str,
            tokens_str,
            cost_str,
            started_str,
        )

    console.print(table)

    # Statistics
    successful = sum(1 for s in sessions if s["success"])
    success_rate = (successful / len(sessions)) * 100

    avg_duration = sum(s["duration_seconds"] for s in sessions if s["duration_seconds"]) / len(
        [s for s in sessions if s["duration_seconds"]]
    )

    avg_cost = sum(s["estimated_cost"] for s in sessions if s["estimated_cost"]) / len(
        [s for s in sessions if s["estimated_cost"]]
    )

    console.print("\n[bold]Statistics:[/bold]")
    console.print(f"  Success Rate: {success_rate:.1f}% ({successful}/{len(sessions)})")
    console.print(f"  Avg Duration: {format_duration(avg_duration)}")
    console.print(f"  Avg Cost: {format_cost(avg_cost)}")


def main() -> int:
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Evaluate agent session results",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Evaluate latest session
  ./evaluate_agent_results.py --repo "prism merge" --pr 134 --latest

  # Evaluate specific session
  ./evaluate_agent_results.py --repo "prism merge" --pr 134 --session abc123

  # Compare multiple sessions
  ./evaluate_agent_results.py --repo "prism merge" --pr 134 --compare

  # Verbose output with all details
  ./evaluate_agent_results.py --repo "prism merge" --pr 134 --latest --verbose
        """,
    )

    parser.add_argument(
        "--db",
        type=Path,
        default=Path("merge-god-state.db"),
        help="Path to database (default: merge-god-state.db)",
    )

    parser.add_argument("--repo", type=str, required=True, help="Repository name")

    parser.add_argument("--pr", type=int, required=True, help="PR number")

    parser.add_argument("--session", type=str, help="Specific session ID to evaluate")

    parser.add_argument("--latest", action="store_true", help="Evaluate the latest session")

    parser.add_argument("--compare", action="store_true", help="Compare multiple sessions")

    parser.add_argument(
        "--limit", type=int, default=5, help="Number of sessions to compare (default: 5)"
    )

    parser.add_argument("--verbose", action="store_true", help="Show detailed output")

    args = parser.parse_args()

    # Validate database exists
    if not args.db.exists():
        print(f"Error: Database not found: {args.db}")
        return 1

    # Initialize
    console = Console()
    db = StateDatabase(args.db)

    try:
        if args.compare:
            # Compare mode
            compare_sessions(db, args.repo, args.pr, console, args.limit)

        elif args.latest or args.session:
            # Single session evaluation
            if args.latest:
                # Get latest session
                sessions = db.get_agent_sessions(args.repo, args.pr, limit=1)
                if not sessions:
                    console.print(f"[red]No sessions found for {args.repo} PR #{args.pr}[/red]")
                    return 1
                session_id = sessions[0]["session_id"]
            else:
                session_id = args.session

            evaluate_session(db, session_id, console, args.verbose)

        else:
            console.print("[yellow]Please specify --latest, --session, or --compare[/yellow]")
            parser.print_help()
            return 1

        return 0

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        if args.verbose:
            import traceback

            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
