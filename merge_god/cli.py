#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "anthropic[bedrock]>=0.39.0",
#     "pyyaml>=6.0",
# ]
# ///

"""
merge-god - Unified CLI for PR automation pipeline

This script provides a unified interface to run and test all components
of the merge-god pipeline:

Process 1: PR/branch scanning and state management
Process 2: PR context gathering and database caching
Process 3: Agent invocation and PR processing

Usage:
    ./merge-god.py [command] [options]

Commands:
    dashboard      Run the TUI dashboard (all processes)
    scan           Scan PRs and sync to database (Process 1+2)
    agent          Run agent on cached PR data (Process 3)
    validate       Validate process boundaries and data flow
    test           Run test suite
    status         Show system status and statistics
    help           Show detailed help

Examples:
    # Run full dashboard
    ./merge-god.py dashboard

    # Scan and cache PR context
    ./merge-god.py scan --repo merge-god --pr 134

    # Run agent on cached data
    ./merge-god.py agent --repo merge-god --pr 134

    # Validate process isolation
    ./merge-god.py validate

    # Show status
    ./merge-god.py status
"""

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

# Import main functions from modules
from . import dashboard as dashboard_module
from . import run_agent as run_agent_module
from . import validate as validate_module

# Lazy imports for modules with external dependencies
# (imported only when needed to avoid import errors)
sync_module = None
pr_loop_module = None
send_approval_module = None


def log_json(event_type: str, data: dict[str, Any]) -> None:
    """Emit structured JSON logs with timestamp"""
    log_entry = {
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "event": event_type,
        "data": data,
    }
    print(json.dumps(log_entry), flush=True)


def log_text(message: str, level: str = "info") -> None:
    """Emit text log with color"""
    colors = {
        "info": "\033[0;36m",  # Cyan
        "success": "\033[0;32m",  # Green
        "warning": "\033[1;33m",  # Yellow
        "error": "\033[0;31m",  # Red
    }
    reset = "\033[0m"
    prefix = {
        "info": "i",
        "success": "✓",
        "warning": "⚠",
        "error": "✗",
    }
    print(f"{colors[level]}{prefix[level]} {message}{reset}", file=sys.stderr)


def cmd_dashboard(args: argparse.Namespace) -> int:
    """Run the TUI dashboard (all processes)"""
    # Temporarily manipulate sys.argv for dashboard's argparse
    original_argv = sys.argv.copy()
    try:
        sys.argv = ["merge-god dashboard"]

        config_path = args.config or Path("config.yaml")
        sys.argv.append(str(config_path))

        if args.non_interactive:
            sys.argv.append("--non-interactive")
        if args.log_file:
            sys.argv.extend(["--log-file", args.log_file])

        result = dashboard_module.main()
        return result if isinstance(result, int) else 0
    finally:
        sys.argv = original_argv


def cmd_scan(args: argparse.Namespace) -> int:
    """Scan PRs and sync to database (Process 1+2)"""
    # Lazy import to avoid initialization issues
    from . import sync as sync_module

    # Temporarily manipulate sys.argv for sync's argparse
    original_argv = sys.argv.copy()
    try:
        sys.argv = ["merge-god scan"]

        if args.config:
            sys.argv.extend(["--config", str(args.config)])
        if args.db:
            sys.argv.extend(["--db", str(args.db)])
        if args.repo:
            sys.argv.extend(["--repo", args.repo])
        if args.pr:
            sys.argv.extend(["--pr", str(args.pr)])

        result = sync_module.main()
        return result if isinstance(result, int) else 0
    finally:
        sys.argv = original_argv


def cmd_agent(args: argparse.Namespace) -> int:
    """Run agent on cached PR data (Process 3)"""
    # Temporarily manipulate sys.argv for run_agent's argparse
    original_argv = sys.argv.copy()
    try:
        sys.argv = [
            "merge-god agent",
            args.repo,
            str(args.pr),
            "--mode",
            args.mode or "for-landing",
        ]

        if args.db:
            sys.argv.extend(["--db", str(args.db)])
        if args.repo_path:
            sys.argv.extend(["--repo-path", str(args.repo_path)])

        result = run_agent_module.main()  # type: ignore[func-returns-value]
        return result if isinstance(result, int) else 0
    finally:
        sys.argv = original_argv


def cmd_validate(args: argparse.Namespace) -> int:
    """Validate process boundaries and data flow"""
    # Temporarily manipulate sys.argv for validate's argparse
    original_argv = sys.argv.copy()
    try:
        sys.argv = ["merge-god validate"]

        if args.db:
            sys.argv.extend(["--db", str(args.db)])
        if args.repo:
            sys.argv.extend(["--repo", args.repo])
        if args.pr:
            sys.argv.extend(["--pr", str(args.pr)])

        result = validate_module.main()  # type: ignore[func-returns-value]
        return result if isinstance(result, int) else 0
    finally:
        sys.argv = original_argv


def cmd_pr_loop(args: argparse.Namespace) -> int:
    """Run legacy PR processing loop"""
    # Lazy import to avoid initialization issues
    from . import pr_loop as pr_loop_module

    # Temporarily manipulate sys.argv for pr_loop's argparse
    original_argv = sys.argv.copy()
    try:
        sys.argv = ["merge-god pr-loop", str(args.repo_path)]
        result = pr_loop_module.main()  # type: ignore[func-returns-value]
        return result if isinstance(result, int) else 0
    finally:
        sys.argv = original_argv


def cmd_send_approval(_args: argparse.Namespace) -> int:
    """Send approval to running pr-loop process"""
    # Lazy import to avoid initialization issues
    from . import send_approval as send_approval_module

    # send_approval doesn't take arguments
    original_argv = sys.argv.copy()
    try:
        sys.argv = ["merge-god send-approval"]
        result = send_approval_module.main()
        return result if isinstance(result, int) else 0
    finally:
        sys.argv = original_argv


def cmd_test(args: argparse.Namespace) -> int:
    """Run test suite"""
    log_text("Running test suite...")

    if args.test_type == "all":
        cmd = ["./test_all.py"]
    elif args.test_type == "isolation":
        cmd = ["python3", "-m", "pytest", "test_process_isolation.py", "-v"]
    elif args.test_type == "db":
        cmd = ["python3", "-m", "pytest", "test_db_operations.py", "-v"]
    elif args.test_type == "agent":
        cmd = ["./test_agent_integration.py"]
    else:
        log_text(f"Unknown test type: {args.test_type}", "error")
        return 1

    try:
        result = subprocess.run(cmd, check=False)
        if result.returncode == 0:
            log_text("Tests passed", "success")
        else:
            log_text("Tests failed", "error")
        return result.returncode
    except Exception as e:
        log_text(f"Failed to run tests: {e}", "error")
        return 1


def cmd_status(args: argparse.Namespace) -> int:
    """Show system status and statistics"""
    log_text("System Status", "info")

    db_path = args.db or Path("merge-god-state.db")
    config_path = args.config or Path("config.yaml")

    # Check database
    if db_path.exists():
        log_text(f"Database: {db_path} ({db_path.stat().st_size / 1024:.1f} KB)", "success")

        try:
            from db_operations import StateDatabase

            db = StateDatabase(db_path)

            # Query stats
            with db._get_connection() as conn:
                cursor = conn.cursor()

                # Count PRs
                cursor.execute("SELECT COUNT(*) FROM pr_context")
                pr_count = cursor.fetchone()[0]
                log_text(f"  Cached PRs: {pr_count}", "info")

                # Count sessions
                cursor.execute("SELECT COUNT(*) FROM agent_sessions")
                session_count = cursor.fetchone()[0]
                log_text(f"  Agent sessions: {session_count}", "info")

                if session_count > 0:
                    # Recent session
                    cursor.execute(
                        """
                        SELECT repo_name, pr_number, status, success, duration_seconds
                        FROM agent_sessions
                        ORDER BY started_at DESC
                        LIMIT 1
                    """
                    )
                    row = cursor.fetchone()
                    if row:
                        repo, pr, status, success, duration = row
                        status_icon = "✓" if success else "✗"
                        log_text(
                            f"  Last session: {repo} PR #{pr} - {status} {status_icon} ({duration:.1f}s)",
                            "info",
                        )

                # Total actions
                cursor.execute("SELECT COUNT(*) FROM agent_actions")
                action_count = cursor.fetchone()[0]
                log_text(f"  Total actions: {action_count}", "info")

        except Exception as e:
            log_text(f"  Warning: Could not read database: {e}", "warning")
    else:
        log_text(f"Database: Not found at {db_path}", "warning")

    # Check config
    if config_path.exists():
        log_text(f"Config: {config_path}", "success")
        try:
            with config_path.open() as f:
                config = yaml.safe_load(f)
            repo_count = len(config.get("repos", []))
            enabled_count = sum(1 for r in config.get("repos", []) if r.get("enabled", True))
            log_text(f"  Repositories: {enabled_count}/{repo_count} enabled", "info")
        except Exception as e:
            log_text(f"  Warning: Could not parse config: {e}", "warning")
    else:
        log_text(f"Config: Not found at {config_path}", "warning")

    # Check scripts
    scripts = [
        ("dashboard.py", "TUI Dashboard"),
        ("run_agent_from_db.py", "Agent Runner"),
        ("sync_pr_context.py", "PR Sync"),
        ("validate_process_flow.py", "Validator"),
    ]

    log_text("Scripts:", "info")
    for script, desc in scripts:
        path = Path(script)
        if path.exists():
            log_text(f"  ✓ {desc}: {script}", "success")
        else:
            log_text(f"  ✗ {desc}: {script} (missing)", "error")

    return 0


def cmd_help(_args: argparse.Namespace) -> int:
    """Show detailed help"""
    help_text = """
merge-god - Unified CLI for PR automation pipeline

OVERVIEW:

  merge-god automates PR review and landing using Claude AI agents.
  It consists of 3 isolated processes:

    Process 1: PR/branch scanning and state management
    Process 2: PR context gathering and database caching
    Process 3: Agent invocation and PR processing

COMMANDS:

  dashboard
    Run the full TUI dashboard with all processes.
    Options:
      --config PATH          Config file (default: config.yaml)
      --non-interactive      Run without prompts
      --log-file PATH        Write logs to file

  scan
    Scan PRs and sync their context to the database.
    Options:
      --config PATH          Config file (default: config.yaml)
      --db PATH              Database file (default: merge-god-state.db)
      --repo NAME            Sync specific repository
      --pr NUMBER            Sync specific PR number

  agent
    Run agent on cached PR data (Process 3 isolation).
    Options:
      --repo NAME            Repository name (required)
      --pr NUMBER            PR number (required)
      --mode MODE            for-landing or for-review (default: for-landing)
      --db PATH              Database file (default: merge-god-state.db)
      --repo-path PATH       Repository path for git operations

  validate
    Validate process boundaries and data flow.
    Options:
      --db PATH              Database file (default: merge-god-state.db)
      --repo NAME            Validate specific repository
      --pr NUMBER            Validate specific PR

  test
    Run test suite.
    Options:
      --type TYPE            Test type: all, isolation, db, agent (default: all)

  status
    Show system status and statistics.
    Options:
      --config PATH          Config file (default: config.yaml)
      --db PATH              Database file (default: merge-god-state.db)

  help
    Show this help message.

TESTING WORKFLOW:

  1. Scan and cache PR data:
     ./merge-god.py scan --repo my-repo --pr 123

  2. Validate data flow:
     ./merge-god.py validate --repo my-repo --pr 123

  3. Run agent on cached data:
     ./merge-god.py agent --repo my-repo --pr 123

  4. Check results:
     ./merge-god.py status

DEBUGGING TUI:

  Use monitor_dashboard.sh to capture TUI snapshots:
    ./monitor_dashboard.sh

  This creates dashboard_captures/ with tmux screen captures
  for debugging TUI rendering issues.

ENVIRONMENT:

  AWS Bedrock (recommended):
    export CLAUDE_CODE_USE_BEDROCK=1
    export ANTHROPIC_MODEL="global.anthropic.claude-sonnet-4-5-20250929-v1:0"

  Direct API:
    export ANTHROPIC_API_KEY="your-key"
    export ANTHROPIC_MODEL="claude-sonnet-4-5-20250929"

DOCUMENTATION:

  See README.md for full documentation.
  See PROCESS_ISOLATION_GUIDE.md for testing details.
"""
    print(help_text)
    return 0


def main() -> int:
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="merge-god - Unified CLI for PR automation pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run './merge-god.py help' for detailed usage information.",
    )

    # Global options
    parser.add_argument(
        "--config",
        type=Path,
        help="Path to config.yaml file",
    )
    parser.add_argument(
        "--db",
        type=Path,
        help="Path to database file",
    )

    # Subcommands
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Dashboard command
    dashboard_parser = subparsers.add_parser("dashboard", help="Run TUI dashboard")
    dashboard_parser.add_argument(
        "--non-interactive", action="store_true", help="Run without prompts"
    )
    dashboard_parser.add_argument("--log-file", type=str, help="Write logs to file")

    # Scan command
    scan_parser = subparsers.add_parser("scan", help="Scan and cache PR context")
    scan_parser.add_argument("--repo", type=str, help="Repository name")
    scan_parser.add_argument("--pr", type=int, help="PR number")

    # Agent command
    agent_parser = subparsers.add_parser("agent", help="Run agent on cached data")
    agent_parser.add_argument("--repo", type=str, required=True, help="Repository name")
    agent_parser.add_argument("--pr", type=int, required=True, help="PR number")
    agent_parser.add_argument(
        "--mode", type=str, choices=["for-landing", "for-review"], help="Processing mode"
    )
    agent_parser.add_argument("--repo-path", type=Path, help="Repository path")

    # Validate command
    validate_parser = subparsers.add_parser("validate", help="Validate process flow")
    validate_parser.add_argument("--repo", type=str, help="Repository name")
    validate_parser.add_argument("--pr", type=int, help="PR number")

    # Test command
    test_parser = subparsers.add_parser("test", help="Run test suite")
    test_parser.add_argument(
        "--type",
        type=str,
        default="all",
        choices=["all", "isolation", "db", "agent"],
        help="Test type to run",
    )

    # Status command
    subparsers.add_parser("status", help="Show system status")

    # PR Loop command
    pr_loop_parser = subparsers.add_parser("pr-loop", help="Run legacy PR processing loop")
    pr_loop_parser.add_argument("repo_path", type=Path, help="Repository path")

    # Send Approval command
    subparsers.add_parser("send-approval", help="Send approval to pr-loop")

    # Help command
    subparsers.add_parser("help", help="Show detailed help")

    args = parser.parse_args()

    # If no command, show help
    if not args.command:
        parser.print_help()
        return 0

    # Route to command handler
    commands = {
        "dashboard": cmd_dashboard,
        "scan": cmd_scan,
        "agent": cmd_agent,
        "validate": cmd_validate,
        "test": cmd_test,
        "status": cmd_status,
        "pr-loop": cmd_pr_loop,
        "send-approval": cmd_send_approval,
        "help": cmd_help,
    }

    handler = commands.get(args.command)
    if not handler:
        log_text(f"Unknown command: {args.command}", "error")
        return 1

    try:
        return handler(args)
    except KeyboardInterrupt:
        log_text("Interrupted by user", "warning")
        return 130
    except Exception as e:
        log_text(f"Command failed: {e}", "error")
        return 1


if __name__ == "__main__":
    sys.exit(main())
