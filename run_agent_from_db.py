#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "anthropic[bedrock]>=0.39.0",
# ]
# ///

"""
Standalone Agent Runner - Run agent invocation from SQLite database only

This script demonstrates Process 3 isolation: it reads all necessary data from
the SQLite database and invokes the agent without needing any GitHub or git operations.

This is useful for:
1. Testing agent behavior with cached PR data
2. Debugging agent issues without API rate limits
3. Replaying failed agent runs
4. Validating agent prompts and responses

Usage:
    ./run_agent_from_db.py <repo_name> <pr_number> [--mode for-review|for-landing]
"""

import argparse
import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from db_operations import StateDatabase
from agents import (
    PRAgent,
    PRContext,
    PRProcessingCallbacks,
    create_claude_client,
    get_model_name,
)


def log_json(event_type: str, data: dict[str, Any]) -> None:
    """Emit structured JSON logs with timestamp"""
    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "event": event_type,
        "data": data,
    }
    print(json.dumps(log_entry), flush=True)


async def run_agent_from_db(
    db_path: Path,
    repo_name: str,
    pr_number: int,
    mode: str = "for-landing",
    repo_path: Path | None = None
) -> bool:
    """
    Run agent invocation using only data from SQLite database.

    This demonstrates Process 3 isolation: no GitHub API calls, no git operations,
    just agent invocation with cached data.

    Args:
        db_path: Path to SQLite database
        repo_name: Repository name
        pr_number: PR number to process
        mode: Processing mode ("for-review" or "for-landing")
        repo_path: Optional repository path for git operations

    Returns:
        True if processing successful, False otherwise
    """
    # Validate inputs
    if not repo_name or not isinstance(repo_name, str):
        log_json("agent_from_db", {
            "action": "error",
            "error": "repo_name must be a non-empty string"
        })
        return False

    if not isinstance(pr_number, int) or pr_number <= 0:
        log_json("agent_from_db", {
            "action": "error",
            "error": f"pr_number must be a positive integer, got: {pr_number}"
        })
        return False

    if mode not in ["for-review", "for-landing"]:
        log_json("agent_from_db", {
            "action": "error",
            "error": f"mode must be 'for-review' or 'for-landing', got: {mode}"
        })
        return False

    log_json("agent_from_db", {
        "action": "start",
        "repo_name": repo_name,
        "pr_number": pr_number,
        "mode": mode,
        "db_path": str(db_path)
    })

    # Initialize database
    try:
        db = StateDatabase(db_path)
    except Exception as e:
        log_json("agent_from_db", {
            "action": "error",
            "error": f"Failed to initialize database: {e}",
            "hint": "Check database file exists and is not corrupted"
        })
        return False

    # Load PR context from database
    log_json("agent_from_db", {
        "action": "loading_context",
        "pr_number": pr_number
    })

    try:
        result = db.get_pr_context_for_agent(repo_name, pr_number)
        if not result:
            log_json("agent_from_db", {
                "action": "error",
                "error": f"No PR context found in database for {repo_name} PR #{pr_number}",
                "hint": "Run pr-loop.py first to capture PR context, or use the sync script"
            })
            return False

        pr_details, pr_context_dict = result

        log_json("agent_from_db", {
            "action": "context_loaded",
            "pr_number": pr_number,
            "has_diff": bool(pr_context_dict.get("diff")),
            "has_comments": bool(pr_context_dict.get("comments")),
            "has_review_comments": bool(pr_context_dict.get("review_comments")),
            "has_conflicts": pr_context_dict.get("conflicts", {}).get("has_conflicts", False),
            "has_failing_ci": pr_context_dict.get("ci_status", {}).get("failed", 0) > 0,
        })

    except Exception as e:
        log_json("agent_from_db", {
            "action": "error",
            "error": f"Failed to load PR context: {e}"
        })
        return False

    # Convert to PRContext
    log_json("agent_from_db", {
        "action": "building_pr_context",
        "pr_number": pr_number
    })

    try:
        pr_context = PRContext.from_dict(pr_details, pr_context_dict)

        # Validate PRContext has required data
        if not pr_context.diff:
            log_json("agent_from_db", {
                "action": "warning",
                "warning": "PR context has no diff - this may be an empty PR or incomplete data"
            })

        # Log context summary for debugging
        log_json("agent_from_db", {
            "action": "context_summary",
            "pr_number": pr_number,
            "diff_size": len(pr_context.diff),
            "comment_count": len(pr_context.general_comments),
            "review_comment_count": len(pr_context.review_comments),
            "commit_count": len(pr_context.commits),
            "file_count": len(pr_context.changed_files),
            "has_conflicts": pr_context.has_conflicts,
            "has_failing_ci": pr_context.has_failing_ci
        })

    except Exception as e:
        log_json("agent_from_db", {
            "action": "error",
            "error": f"Failed to build PR context: {e}",
            "hint": "PR data in database may be incomplete or corrupted"
        })
        return False

    # Initialize agent client
    log_json("agent_from_db", {
        "action": "initializing_agent",
        "pr_number": pr_number
    })

    try:
        client = create_claude_client()
        model = get_model_name()

        log_json("agent_from_db", {
            "action": "agent_initialized",
            "model": model
        })
    except Exception as e:
        log_json("agent_from_db", {
            "action": "error",
            "error": f"Failed to initialize agent client: {e}"
        })
        return False

    # Generate session ID and create session record
    session_id = str(uuid.uuid4())

    try:
        db.create_agent_session(
            repo_name=repo_name,
            pr_number=pr_number,
            session_id=session_id,
            mode=mode,
            model=model,
            agent_version="1.0"
        )
        log_json("agent_from_db", {
            "action": "session_created",
            "session_id": session_id
        })
    except Exception as e:
        log_json("agent_from_db", {
            "action": "warning",
            "warning": f"Failed to create session record: {e}",
            "hint": "Session telemetry will not be recorded"
        })
        session_id = None

    # Create agent
    agent = PRAgent(
        client=client,
        model=model,
        repo_path=repo_path or Path.cwd(),
        database=db,
        session_id=session_id
    )

    # Create callbacks
    callbacks = PRProcessingCallbacks(
        pr_number=pr_number,
        log_json=log_json,
        send_notification=lambda *args, **kwargs: None  # Disable notifications
    )

    # Run agent
    log_json("agent_from_db", {
        "action": "agent_processing",
        "pr_number": pr_number,
        "mode": mode
    })

    try:
        result = await agent.process_pr_streaming(
            pr_context=pr_context,
            mode=mode,
            callbacks=callbacks
        )

        # Update session with final results
        if session_id:
            try:
                db.update_agent_session(
                    session_id=session_id,
                    status="completed" if result.success else "failed",
                    success=result.success,
                    tasks_total=len(result.tasks),
                    tasks_completed=len([t for t in result.tasks if t.status == "completed"]),
                    tasks_failed=len([t for t in result.tasks if t.status == "failed"]),
                    actions_total=len(result.actions)
                )
            except Exception as e:
                log_json("agent_from_db", {
                    "action": "warning",
                    "warning": f"Failed to update session record: {e}"
                })

        log_json("agent_from_db", {
            "action": "complete",
            "pr_number": pr_number,
            "session_id": session_id,
            "success": result.success,
            "duration": result.duration,
            "tasks_total": len(result.tasks),
            "tasks_completed": len([t for t in result.tasks if t.status == "completed"]),
            "tasks_failed": len([t for t in result.tasks if t.status == "failed"]),
            "actions_taken": len(result.actions),
            "mode": mode,
        })

        return result.success

    except Exception as e:
        # Update session with error
        if session_id:
            try:
                db.update_agent_session(
                    session_id=session_id,
                    status="failed",
                    success=False,
                    error_message=str(e)
                )
                db.record_agent_error(
                    session_id=session_id,
                    error_type=type(e).__name__,
                    error_message=str(e),
                    is_transient=False
                )
            except Exception as db_error:
                log_json("agent_from_db", {
                    "action": "warning",
                    "warning": f"Failed to record error in session: {db_error}"
                })

        log_json("agent_from_db", {
            "action": "exception",
            "pr_number": pr_number,
            "session_id": session_id,
            "error": str(e),
            "error_type": type(e).__name__
        })
        return False


def main() -> None:
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Run agent invocation from SQLite database only (Process 3 isolation)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run agent for PR #123 in for-landing mode
  ./run_agent_from_db.py my-repo 123

  # Run agent in for-review mode
  ./run_agent_from_db.py my-repo 123 --mode for-review

  # Use specific database file
  ./run_agent_from_db.py my-repo 123 --db /path/to/db.sqlite

  # Specify repo path for git operations
  ./run_agent_from_db.py my-repo 123 --repo-path /path/to/repo

This script demonstrates Process 3 isolation by running the agent using only
cached data from the database, without any GitHub API calls or git fetches.
        """
    )

    parser.add_argument(
        "repo_name",
        help="Repository name"
    )

    parser.add_argument(
        "pr_number",
        type=int,
        help="PR number to process"
    )

    parser.add_argument(
        "--mode",
        choices=["for-review", "for-landing"],
        default="for-landing",
        help="Processing mode (default: for-landing)"
    )

    parser.add_argument(
        "--db",
        type=Path,
        default=Path("merge-god-state.db"),
        help="Path to SQLite database (default: merge-god-state.db)"
    )

    parser.add_argument(
        "--repo-path",
        type=Path,
        help="Repository path for git operations (default: current directory)"
    )

    args = parser.parse_args()

    # Validate database exists
    if not args.db.exists():
        log_json("error", {
            "error": f"Database not found: {args.db}",
            "hint": "Run pr-loop.py first to create and populate the database"
        })
        sys.exit(1)

    # Validate database is not empty
    try:
        import sqlite3
        with sqlite3.connect(args.db) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM pr_context")
            count = cursor.fetchone()[0]
            if count == 0:
                log_json("warning", {
                    "warning": "Database has no PR context data",
                    "hint": "Run pr-loop.py to populate the database with PR data"
                })
    except Exception as e:
        log_json("warning", {
            "warning": f"Could not check database: {e}",
            "hint": "Database may be corrupted or incomplete"
        })

    # Validate PR number is positive
    if args.pr_number <= 0:
        log_json("error", {
            "error": f"Invalid PR number: {args.pr_number}",
            "hint": "PR number must be a positive integer"
        })
        sys.exit(1)

    # Run agent
    success = asyncio.run(run_agent_from_db(
        db_path=args.db,
        repo_name=args.repo_name,
        pr_number=args.pr_number,
        mode=args.mode,
        repo_path=args.repo_path
    ))

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log_json("shutdown", {"reason": "keyboard_interrupt"})
        sys.exit(130)
    except Exception as e:
        log_json("fatal_error", {
            "error": str(e),
            "error_type": type(e).__name__
        })
        sys.exit(1)
