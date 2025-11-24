#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Database Sync CLI - Sync PR context from GitHub to SQLite database

This script reads config.yaml, scans for PRs with for-landing/for-review labels,
and saves their complete context to the database for offline agent testing.

Usage:
    ./sync_pr_context.py [--config config.yaml] [--repo REPO_NAME] [--pr PR_NUMBER]

Examples:
    # Sync all PRs from all repos in config
    ./sync_pr_context.py

    # Sync specific repo
    ./sync_pr_context.py --repo merge-god

    # Sync specific PR
    ./sync_pr_context.py --repo merge-god --pr 134

    # Use different config file
    ./sync_pr_context.py --config /path/to/config.yaml
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from db_operations import StateDatabase
from github_ops import gather_pr_context
from git_ops import get_repo_prs_with_labels, get_default_branch


def log_json(event_type: str, data: dict[str, Any]) -> None:
    """Emit structured JSON logs with timestamp"""
    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "event": event_type,
        "data": data,
    }
    print(json.dumps(log_entry), flush=True)


def load_config(config_path: Path) -> dict[str, Any]:
    """Load configuration from YAML file"""
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path) as f:
        config = yaml.safe_load(f)

    if not config or "repos" not in config:
        raise ValueError(f"Invalid config file: missing 'repos' section")

    return config


def sync_pr_to_database(
    db: StateDatabase,
    repo_path: Path,
    repo_name: str,
    pr_number: int
) -> bool:
    """
    Sync a single PR's context to the database.

    Args:
        db: Database instance
        repo_path: Path to git repository
        repo_name: Repository name
        pr_number: PR number

    Returns:
        True if sync successful, False otherwise
    """
    log_json("sync_pr", {
        "action": "start",
        "repo": repo_name,
        "pr_number": pr_number
    })

    try:
        # Gather PR context using existing functions
        pr_details, pr_context = gather_pr_context(
            repo_path=repo_path,
            pr_number=pr_number,
            mode="for-landing"  # Default mode, doesn't matter for context gathering
        )

        if not pr_details or not pr_context:
            log_json("sync_pr", {
                "action": "error",
                "repo": repo_name,
                "pr_number": pr_number,
                "error": "Failed to gather PR context"
            })
            return False

        # Save to database
        db.save_pr_context(
            repo_name=repo_name,
            pr_number=pr_number,
            pr_details=pr_details,
            pr_context=pr_context
        )

        # Also save PR snapshot
        pr_snapshot = {
            "number": pr_number,
            "title": pr_details.get("title", ""),
            "state": "open",
            "head_branch": pr_details.get("headRefName", ""),
            "base_branch": pr_details.get("baseRefName", "main"),
            "author": pr_details.get("author", {}).get("login", "unknown"),
            "draft": False,
            "ci_status": "unknown",
            "labels": pr_details.get("labels", []),
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        db.save_pr_snapshot(repo_name, pr_snapshot)

        log_json("sync_pr", {
            "action": "complete",
            "repo": repo_name,
            "pr_number": pr_number,
            "diff_size": len(pr_context.get("diff", "")),
            "comment_count": len(pr_context.get("comments", [])),
            "review_comment_count": len(pr_context.get("review_comments", [])),
            "file_count": len(pr_context.get("files", []))
        })

        return True

    except Exception as e:
        log_json("sync_pr", {
            "action": "error",
            "repo": repo_name,
            "pr_number": pr_number,
            "error": str(e),
            "error_type": type(e).__name__
        })
        return False


def sync_repo(
    db: StateDatabase,
    repo_config: dict[str, Any],
    specific_pr: int | None = None
) -> dict[str, Any]:
    """
    Sync all PRs (or specific PR) from a repository.

    Args:
        db: Database instance
        repo_config: Repository configuration from config.yaml
        specific_pr: Optional specific PR number to sync

    Returns:
        Statistics about the sync operation
    """
    repo_path = Path(repo_config["path"])
    repo_name = repo_config.get("name", repo_path.name)

    if not repo_path.exists():
        log_json("sync_repo", {
            "action": "error",
            "repo": repo_name,
            "error": f"Repository path does not exist: {repo_path}"
        })
        return {"success": False, "error": "path_not_found"}

    log_json("sync_repo", {
        "action": "start",
        "repo": repo_name,
        "path": str(repo_path),
        "specific_pr": specific_pr
    })

    stats = {
        "repo": repo_name,
        "total": 0,
        "succeeded": 0,
        "failed": 0,
        "prs": []
    }

    try:
        if specific_pr:
            # Sync specific PR
            stats["total"] = 1
            success = sync_pr_to_database(db, repo_path, repo_name, specific_pr)
            if success:
                stats["succeeded"] = 1
                stats["prs"].append(specific_pr)
            else:
                stats["failed"] = 1
        else:
            # Discover PRs with for-landing or for-review labels
            default_branch = get_default_branch(repo_path)
            prs_for_landing = get_repo_prs_with_labels(repo_path, ["for-landing"])
            prs_for_review = get_repo_prs_with_labels(repo_path, ["for-review"])

            all_prs = set(prs_for_landing + prs_for_review)
            stats["total"] = len(all_prs)

            log_json("sync_repo", {
                "action": "discovered_prs",
                "repo": repo_name,
                "pr_count": len(all_prs),
                "pr_numbers": sorted(list(all_prs))
            })

            if not all_prs:
                log_json("sync_repo", {
                    "action": "warning",
                    "repo": repo_name,
                    "warning": "No PRs found with for-landing or for-review labels"
                })

            # Sync each PR
            for pr_number in sorted(all_prs):
                success = sync_pr_to_database(db, repo_path, repo_name, pr_number)
                if success:
                    stats["succeeded"] += 1
                    stats["prs"].append(pr_number)
                else:
                    stats["failed"] += 1

        stats["success"] = stats["failed"] == 0

        log_json("sync_repo", {
            "action": "complete",
            "repo": repo_name,
            "stats": stats
        })

        return stats

    except Exception as e:
        log_json("sync_repo", {
            "action": "error",
            "repo": repo_name,
            "error": str(e),
            "error_type": type(e).__name__
        })
        return {
            **stats,
            "success": False,
            "error": str(e)
        }


def main() -> int:
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Sync PR context from GitHub to SQLite database",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Sync all PRs from all repos in config
  ./sync_pr_context.py

  # Sync specific repo
  ./sync_pr_context.py --repo merge-god

  # Sync specific PR
  ./sync_pr_context.py --repo merge-god --pr 134

  # Use different config file
  ./sync_pr_context.py --config /path/to/config.yaml

This script enables database caching for offline agent testing and debugging.
It gathers complete PR context (diff, comments, CI status) and stores it in
SQLite for use with run_agent_from_db.py.
        """
    )

    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config.yaml"),
        help="Path to config.yaml file (default: config.yaml)"
    )

    parser.add_argument(
        "--db",
        type=Path,
        default=Path("merge-god-state.db"),
        help="Path to SQLite database (default: merge-god-state.db)"
    )

    parser.add_argument(
        "--repo",
        type=str,
        help="Sync specific repository by name"
    )

    parser.add_argument(
        "--pr",
        type=int,
        help="Sync specific PR number (requires --repo)"
    )

    args = parser.parse_args()

    # Validate arguments
    if args.pr and not args.repo:
        log_json("error", {
            "error": "--pr requires --repo to be specified"
        })
        return 1

    # Load configuration
    try:
        config = load_config(args.config)
    except Exception as e:
        log_json("error", {
            "error": f"Failed to load config: {e}",
            "config_path": str(args.config)
        })
        return 1

    # Initialize database
    try:
        db = StateDatabase(args.db)
    except Exception as e:
        log_json("error", {
            "error": f"Failed to initialize database: {e}",
            "db_path": str(args.db)
        })
        return 1

    log_json("sync", {
        "action": "start",
        "config": str(args.config),
        "database": str(args.db),
        "repo_filter": args.repo,
        "pr_filter": args.pr
    })

    # Sync repositories
    all_stats = []
    for repo_config in config["repos"]:
        # Skip if not enabled
        if not repo_config.get("enabled", True):
            log_json("sync", {
                "action": "skip",
                "repo": repo_config.get("name", repo_config["path"]),
                "reason": "disabled in config"
            })
            continue

        # Skip if filtering by repo and this isn't it
        if args.repo and repo_config.get("name") != args.repo:
            continue

        stats = sync_repo(db, repo_config, specific_pr=args.pr)
        all_stats.append(stats)

    # Summary
    total_prs = sum(s["total"] for s in all_stats)
    succeeded = sum(s["succeeded"] for s in all_stats)
    failed = sum(s["failed"] for s in all_stats)

    log_json("sync", {
        "action": "complete",
        "total_prs": total_prs,
        "succeeded": succeeded,
        "failed": failed,
        "success_rate": round(succeeded / total_prs * 100, 1) if total_prs > 0 else 0
    })

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log_json("shutdown", {"reason": "keyboard_interrupt"})
        sys.exit(130)
    except Exception as e:
        log_json("fatal_error", {
            "error": str(e),
            "error_type": type(e).__name__
        })
        sys.exit(1)
