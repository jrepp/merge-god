#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "PyGithub>=2.1.0",
#     "anthropic[bedrock]>=0.39.0",
# ]
# ///

"""
PR Merge Loop - Automatically processes and merges PRs using bob (AI assistant wrapper)
Continuously loops through open PRs, syncing repo, fixing conflicts, responding to reviews, and fixing CI.

Usage: ./pr-loop.py <repo_path>
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Import agent system
try:
    from agents import (
        PRAgent,
        PRContext,
        PRProcessingCallbacks,
        create_claude_client,
        get_model_name,
    )

    AGENT_SDK_AVAILABLE = True
except ImportError:
    AGENT_SDK_AVAILABLE = False
    PRAgent = None
    PRContext = None
    PRProcessingCallbacks = None
    create_claude_client = None
    get_model_name = None

# Import database operations
try:
    from db_operations import StateDatabase

    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False
    StateDatabase = None


def log_json(event_type: str, data: dict[str, Any]) -> None:
    """Emit structured JSON logs with timestamp"""
    log_entry = {
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "event": event_type,
        "data": data,
    }
    print(json.dumps(log_entry), flush=True)


def request_confirmation(
    action_type: str,
    description: str,
    pr_number: str | None = None,
    details: dict[str, Any] | None = None,
    timeout: int = 300,
) -> bool:
    """Request user confirmation for an action (interactive mode only)

    Args:
        action_type: Type of action (e.g., "process_pr", "push_changes", "merge_pr")
        description: Human-readable description of the action
        pr_number: Optional PR number
        details: Optional additional details to show user
        timeout: Timeout in seconds (default: 5 minutes)

    Returns:
        True if user approved, False if declined or timeout
    """
    # Emit confirmation request
    log_json(
        "request_confirmation",
        {
            "action_type": action_type,
            "description": description,
            "pr_number": pr_number,
            "details": details or {},
        },
    )

    # Use polling approach instead of select() for better compatibility with pipes
    import sys
    import time

    start_time = time.time()
    poll_interval = 0.1  # Check every 100ms

    # Make stdin non-blocking using fcntl on Unix systems
    import fcntl
    import os

    try:
        # Get current flags
        stdin_fd = sys.stdin.fileno()
        flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
        # Set non-blocking
        fcntl.fcntl(stdin_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    except Exception as e:
        log_json(
            "confirmation_warning",
            {
                "warning": "Could not set stdin non-blocking",
                "error": str(e),
            },
        )

    # Poll for input with timeout
    while time.time() - start_time < timeout:
        try:
            line = sys.stdin.readline()
            if line:
                line = line.strip()
                if line:
                    try:
                        response = json.loads(line)
                        approved = response.get("approved", False)

                        log_json(
                            "confirmation_received",
                            {
                                "action_type": action_type,
                                "approved": approved,
                            },
                        )

                        return approved
                    except json.JSONDecodeError as e:
                        log_json(
                            "confirmation_error",
                            {
                                "action_type": action_type,
                                "error": f"JSON decode error: {e!s}",
                                "line": line[:100],
                            },
                        )
                        return False
        except (OSError, BlockingIOError):
            # No input available yet, continue polling
            pass
        except Exception as e:
            log_json(
                "confirmation_error",
                {
                    "action_type": action_type,
                    "error": str(e),
                },
            )
            return False

        time.sleep(poll_interval)

    # Timeout - decline by default
    log_json(
        "confirmation_timeout",
        {
            "action_type": action_type,
            "timeout_seconds": timeout,
        },
    )
    return False


def send_notification(
    message: str,
    title: str | None = None,
    priority: str = "default",
    tags: list[str] | None = None,
) -> bool:
    """Send notification to ntfy.sh topic

    Args:
        message: Notification message body
        title: Optional notification title
        priority: Priority level (min, low, default, high, urgent)
        tags: Optional list of tags/emojis

    Returns:
        True if notification sent successfully, False otherwise
    """
    topic_url = "https://ntfy.sh/merge-god-sez"

    try:
        headers = {
            "Content-Type": "text/plain; charset=utf-8",
        }

        if title:
            headers["Title"] = title

        if priority:
            headers["Priority"] = priority

        if tags:
            headers["Tags"] = ",".join(tags)

        req = urllib.request.Request(
            topic_url,
            data=message.encode("utf-8"),
            headers=headers,
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                log_json(
                    "notification",
                    {
                        "action": "sent",
                        "title": title,
                        "message_length": len(message),
                    },
                )
                return True
            log_json(
                "notification",
                {
                    "action": "failed",
                    "status": response.status,
                    "title": title,
                },
            )
            return False

    except urllib.error.URLError as e:
        log_json(
            "notification",
            {
                "action": "error",
                "error": str(e),
                "title": title,
            },
        )
        return False
    except Exception as e:
        log_json(
            "notification",
            {
                "action": "exception",
                "error": str(e),
                "title": title,
            },
        )
        return False


def run_command(
    cmd: list[str],
    cwd: Path | None = None,
    timeout: int = 300,  # 5 minutes default
    max_output_size: int = 50 * 1024 * 1024,  # 50MB default
) -> tuple[int, str, str]:
    """Run a command and return exit code, stdout, stderr

    Args:
        cmd: Command and arguments as list
        cwd: Working directory for command
        timeout: Timeout in seconds (default 5 minutes)
        max_output_size: Maximum output size in bytes (default 50MB)

    Returns:
        Tuple of (returncode, stdout, stderr)
    """
    try:
        result = subprocess.run(
            cmd,
            check=False,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        # Check output size
        stdout_size = len(result.stdout.encode("utf-8"))
        stderr_size = len(result.stderr.encode("utf-8"))

        if stdout_size > max_output_size:
            log_json(
                "command_warning",
                {
                    "warning": "stdout truncated",
                    "size": stdout_size,
                    "max_size": max_output_size,
                    "command": cmd[0] if cmd else "unknown",
                },
            )
            result.stdout = result.stdout[: max_output_size // 2] + "\n... [truncated] ..."

        if stderr_size > max_output_size:
            log_json(
                "command_warning",
                {
                    "warning": "stderr truncated",
                    "size": stderr_size,
                    "max_size": max_output_size,
                    "command": cmd[0] if cmd else "unknown",
                },
            )
            result.stderr = result.stderr[: max_output_size // 2] + "\n... [truncated] ..."

        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"Command timed out after {timeout} seconds"
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0] if cmd else 'unknown'}"
    except Exception as e:
        return -1, "", f"Command failed: {e!s}"


def get_open_prs() -> dict[str, list[dict[str, Any]]]:
    """Fetch open PRs and categorize by processing mode labels

    Returns:
        Dictionary with keys:
        - "for-review": PRs labeled for code review (comprehensive review + improvements)
        - "for-landing": PRs labeled for landing (basic processing to merge)
        - "untagged": PRs without processing labels (skipped)
    """
    log_json("fetch_prs", {"action": "start"})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "pr",
            "list",
            "--json",
            "number,title,headRefName,baseRefName,isDraft,labels,url,author,createdAt,updatedAt",
            "--limit",
            "100",
        ],
        timeout=60,
    )

    if returncode != 0:
        log_json("fetch_prs", {"action": "error", "stderr": stderr})
        return {"for-review": [], "for-landing": [], "untagged": []}

    if not stdout or not stdout.strip():
        log_json("fetch_prs", {"action": "empty_response"})
        return {"for-review": [], "for-landing": [], "untagged": []}

    try:
        all_prs = json.loads(stdout)
    except json.JSONDecodeError as e:
        log_json("fetch_prs", {"action": "parse_error", "error": str(e), "stdout": stdout[:200]})
        return {"for-review": [], "for-landing": [], "untagged": []}

    # Validate it's a list
    if not isinstance(all_prs, list):
        log_json("fetch_prs", {"action": "invalid_type", "type": type(all_prs).__name__})
        return {"for-review": [], "for-landing": [], "untagged": []}

    # Categorize PRs by labels
    categorized: dict[str, list[dict[str, Any]]] = {
        "for-review": [],
        "for-landing": [],
        "untagged": [],
    }

    # Track filtered PRs for detailed logging
    filtered_prs = {
        "draft": [],
        "wip": [],
        "invalid": [],
    }

    for pr in all_prs:
        if not isinstance(pr, dict):
            continue

        pr_number = pr.get("number")
        pr_title = pr.get("title", "Unknown")

        # Validate required fields exist
        if not all(key in pr for key in ["number", "headRefName", "url"]):
            log_json("fetch_prs", {"action": "invalid_pr", "pr": pr})
            filtered_prs["invalid"].append(
                {"number": pr_number, "title": pr_title, "reason": "missing_fields"}
            )
            continue

        # Skip draft PRs
        if pr.get("isDraft", False):
            filtered_prs["draft"].append({"number": pr_number, "title": pr_title})
            log_json(
                "fetch_prs", {"action": "skip_draft", "pr_number": pr_number, "title": pr_title}
            )
            continue

        # Safely get labels
        labels = []
        for label in pr.get("labels", []):
            if isinstance(label, dict) and "name" in label:
                labels.append(label["name"].lower())

        # Skip WIP PRs
        wip_label_found = None
        for label in labels:
            for wip in ["wip", "work-in-process", "work in process"]:
                if wip in label:
                    wip_label_found = label
                    break
            if wip_label_found:
                break

        if wip_label_found:
            filtered_prs["wip"].append(
                {"number": pr_number, "title": pr_title, "label": wip_label_found}
            )
            log_json(
                "fetch_prs",
                {
                    "action": "skip_wip",
                    "pr_number": pr_number,
                    "title": pr_title,
                    "wip_label": wip_label_found,
                },
            )
            continue

        # Categorize by processing mode labels
        if "for-review" in labels:
            categorized["for-review"].append(pr)
            log_json(
                "fetch_prs",
                {
                    "action": "categorized",
                    "pr_number": pr_number,
                    "title": pr_title,
                    "category": "for-review",
                    "labels": labels,
                },
            )
        elif "for-landing" in labels:
            categorized["for-landing"].append(pr)
            log_json(
                "fetch_prs",
                {
                    "action": "categorized",
                    "pr_number": pr_number,
                    "title": pr_title,
                    "category": "for-landing",
                    "labels": labels,
                },
            )
        else:
            # PRs without processing labels are untagged (will be skipped)
            categorized["untagged"].append(pr)
            log_json(
                "fetch_prs",
                {
                    "action": "categorized",
                    "pr_number": pr_number,
                    "title": pr_title,
                    "category": "untagged",
                    "labels": labels,
                },
            )

    log_json(
        "fetch_prs",
        {
            "action": "complete",
            "total": len(all_prs),
            "for_review": len(categorized["for-review"]),
            "for_landing": len(categorized["for-landing"]),
            "untagged": len(categorized["untagged"]),
            "filtered_draft": len(filtered_prs["draft"]),
            "filtered_wip": len(filtered_prs["wip"]),
            "filtered_invalid": len(filtered_prs["invalid"]),
            "filtered_prs": filtered_prs,
        },
    )

    return categorized


def get_open_issues() -> list[dict[str, Any]]:
    """Fetch open issues labeled for implementation

    Returns:
        List of issues with "for-impl" label that should be implemented
    """
    log_json("fetch_issues", {"action": "start"})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "issue",
            "list",
            "--json",
            "number,title,body,labels,url,author,createdAt,updatedAt,state",
            "--label",
            "for-impl",
            "--state",
            "open",
            "--limit",
            "100",
        ],
        timeout=60,
    )

    if returncode != 0:
        log_json("fetch_issues", {"action": "error", "stderr": stderr})
        return []

    if not stdout or not stdout.strip():
        log_json("fetch_issues", {"action": "empty_response"})
        return []

    try:
        all_issues = json.loads(stdout)
    except json.JSONDecodeError as e:
        log_json("fetch_issues", {"action": "parse_error", "error": str(e), "stdout": stdout[:200]})
        return []

    # Validate it's a list
    if not isinstance(all_issues, list):
        log_json("fetch_issues", {"action": "invalid_type", "type": type(all_issues).__name__})
        return []

    # Filter and validate issues
    valid_issues = []
    for issue in all_issues:
        if not isinstance(issue, dict):
            continue

        # Validate required fields
        if not all(key in issue for key in ["number", "title", "url"]):
            log_json("fetch_issues", {"action": "invalid_issue", "issue": issue})
            continue

        # Verify it has the for-impl label (should already be filtered by gh)
        labels = []
        for label in issue.get("labels", []):
            if isinstance(label, dict) and "name" in label:
                labels.append(label["name"].lower())

        if "for-impl" in labels:
            valid_issues.append(issue)

    log_json(
        "fetch_issues",
        {
            "action": "complete",
            "total": len(all_issues),
            "for_impl": len(valid_issues),
        },
    )

    return valid_issues


def validate_git_ref(ref: str) -> bool:
    """Validate that a string is a safe git reference name

    Prevents command injection through malicious branch names.
    """
    if not ref or not isinstance(ref, str):
        return False

    # Git ref names should not contain these characters
    unsafe_chars = ["\0", "\n", "\r", " ", "~", "^", ":", "?", "*", "[", "\\", "..", "@{", "//"]
    if any(char in ref for char in unsafe_chars):
        return False

    # Should not start or end with certain characters
    if ref.startswith((".", "/")) or ref.endswith((".", "/", ".lock")):
        return False

    # Reasonable length check (git allows 255 but be conservative)
    return not len(ref) > 200


def detect_default_branch() -> str:
    """Detect the default branch of the repository"""
    # Try to get the default branch from remote
    returncode, stdout, stderr = run_command(
        [
            "git",
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
        ],
        timeout=10,
    )

    if returncode == 0 and stdout:
        # Output is like "refs/remotes/origin/main"
        branch = stdout.strip().split("/")[-1]
        if branch:
            return branch

    # Fallback: try common names
    for branch in ["main", "master", "develop"]:
        returncode, stdout, _stderr = run_command(
            [
                "git",
                "rev-parse",
                "--verify",
                f"origin/{branch}",
            ],
            timeout=10,
        )
        if returncode == 0:
            return branch

    # Last resort
    log_json(
        "branch_detection",
        {
            "warning": "Could not detect default branch, using 'main'",
        },
    )
    return "main"


def get_pr_details(pr_number: int) -> dict[str, Any]:
    """Fetch comprehensive PR details"""
    log_json("get_pr_details", {"action": "start", "pr_number": pr_number})

    # Get full PR information
    returncode, stdout, stderr = run_command(
        [
            "gh",
            "pr",
            "view",
            str(pr_number),
            "--json",
            "number,title,body,state,headRefName,baseRefName,isDraft,mergeable,"
            "author,createdAt,updatedAt,closedAt,mergedAt,labels,assignees,reviewers,"
            "additions,deletions,changedFiles,commits,reviews,reviewDecision,statusCheckRollup",
        ]
    )

    if returncode != 0:
        log_json("get_pr_details", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return {}

    try:
        details = json.loads(stdout)
    except json.JSONDecodeError as e:
        log_json(
            "get_pr_details", {"action": "parse_error", "pr_number": pr_number, "error": str(e)}
        )
        return {}

    log_json("get_pr_details", {"action": "complete", "pr_number": pr_number})
    return details


def get_pr_comments(pr_number: int) -> list[dict[str, Any]]:
    """Fetch all PR comments (discussion/issue comments)"""
    log_json("get_pr_comments", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "api",
            f"repos/{{owner}}/{{repo}}/issues/{pr_number}/comments",
            "--jq",
            ".",
        ]
    )

    if returncode != 0:
        log_json("get_pr_comments", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return []

    try:
        comments = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json(
            "get_pr_comments", {"action": "parse_error", "pr_number": pr_number, "error": str(e)}
        )
        return []

    log_json(
        "get_pr_comments",
        {
            "action": "complete",
            "pr_number": pr_number,
            "comment_count": len(comments),
        },
    )
    return comments


def get_pr_review_comments(pr_number: int) -> list[dict[str, Any]]:
    """Fetch all PR review comments (inline code review comments)"""
    log_json("get_pr_review_comments", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "api",
            f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments",
            "--jq",
            ".",
        ]
    )

    if returncode != 0:
        log_json(
            "get_pr_review_comments",
            {
                "action": "error",
                "pr_number": pr_number,
                "stderr": stderr,
            },
        )
        return []

    try:
        comments = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json(
            "get_pr_review_comments",
            {
                "action": "parse_error",
                "pr_number": pr_number,
                "error": str(e),
            },
        )
        return []

    log_json(
        "get_pr_review_comments",
        {
            "action": "complete",
            "pr_number": pr_number,
            "review_comment_count": len(comments),
        },
    )
    return comments


def get_pr_diff(pr_number: int) -> str:
    """Get the PR diff"""
    log_json("get_pr_diff", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "pr",
            "diff",
            str(pr_number),
        ]
    )

    if returncode != 0:
        log_json("get_pr_diff", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return ""

    log_json(
        "get_pr_diff",
        {
            "action": "complete",
            "pr_number": pr_number,
            "diff_size": len(stdout),
        },
    )
    return stdout


def check_merge_conflicts(pr_number: int, head_branch: str, base_branch: str) -> dict[str, Any]:
    """Check if PR has merge conflicts with base branch"""
    log_json(
        "check_merge_conflicts",
        {
            "action": "start",
            "pr_number": pr_number,
            "head_branch": head_branch,
            "base_branch": base_branch,
        },
    )

    # Validate branch names
    if not validate_git_ref(head_branch):
        log_json(
            "check_merge_conflicts",
            {
                "action": "invalid_branch",
                "pr_number": pr_number,
                "branch": "head",
                "value": head_branch,
            },
        )
        return {
            "has_conflicts": False,
            "conflicting_files": [],
            "conflict_count": 0,
            "error": "Invalid head branch name",
        }

    if not validate_git_ref(base_branch):
        log_json(
            "check_merge_conflicts",
            {
                "action": "invalid_branch",
                "pr_number": pr_number,
                "branch": "base",
                "value": base_branch,
            },
        )
        return {
            "has_conflicts": False,
            "conflicting_files": [],
            "conflict_count": 0,
            "error": "Invalid base branch name",
        }

    # Fetch latest
    returncode, stdout, stderr = run_command(
        [
            "git",
            "fetch",
            "origin",
            head_branch,
            base_branch,
        ],
        timeout=120,
    )

    if returncode != 0:
        log_json(
            "check_merge_conflicts",
            {
                "action": "fetch_error",
                "pr_number": pr_number,
                "stderr": stderr,
            },
        )
        return {
            "has_conflicts": False,
            "conflicting_files": [],
            "conflict_count": 0,
            "error": "Failed to fetch branches",
        }

    # Check if merge would conflict using merge-tree
    returncode, stdout, stderr = run_command(
        [
            "git",
            "merge-tree",
            f"origin/{base_branch}",
            f"origin/{head_branch}",
        ],
        timeout=120,
    )

    # More robust conflict detection
    has_conflicts = False
    if returncode == 0 and stdout:
        # Look for conflict markers in a way that reduces false positives
        lines = stdout.split("\n")
        conflict_marker_count = sum(1 for line in lines if line.startswith("<<<<<<<"))
        has_conflicts = conflict_marker_count > 0

    # Get list of conflicting files if any
    conflicting_files = []
    if has_conflicts:
        lines = stdout.split("\n")
        current_file = None
        for line in lines:
            if line.startswith(("+++", "---")):
                parts = line.split()
                if len(parts) > 1 and parts[1] != "/dev/null":
                    file_path = parts[1].lstrip("ab/")
                    if file_path and file_path not in conflicting_files:
                        current_file = file_path
            elif line.startswith("<<<<<<<") and current_file:
                if current_file not in conflicting_files:
                    conflicting_files.append(current_file)

    result = {
        "has_conflicts": has_conflicts,
        "conflicting_files": conflicting_files,
        "conflict_count": len(conflicting_files),
    }

    log_json(
        "check_merge_conflicts",
        {
            "action": "complete",
            "pr_number": pr_number,
            **result,
        },
    )

    return result


def get_pr_commits(pr_number: int) -> list[dict[str, Any]]:
    """Get all commits in the PR"""
    log_json("get_pr_commits", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "api",
            f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/commits",
            "--jq",
            ".",
        ]
    )

    if returncode != 0:
        log_json("get_pr_commits", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return []

    try:
        commits = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json(
            "get_pr_commits", {"action": "parse_error", "pr_number": pr_number, "error": str(e)}
        )
        return []

    log_json(
        "get_pr_commits",
        {
            "action": "complete",
            "pr_number": pr_number,
            "commit_count": len(commits),
        },
    )
    return commits


def get_pr_files(pr_number: int) -> list[dict[str, Any]]:
    """Get list of changed files in the PR"""
    log_json("get_pr_files", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command(
        [
            "gh",
            "api",
            f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/files",
            "--jq",
            ".",
        ]
    )

    if returncode != 0:
        log_json("get_pr_files", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return []

    try:
        files = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json("get_pr_files", {"action": "parse_error", "pr_number": pr_number, "error": str(e)})
        return []

    log_json(
        "get_pr_files",
        {
            "action": "complete",
            "pr_number": pr_number,
            "file_count": len(files),
        },
    )
    return files


def analyze_ci_status(status_checks: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Analyze CI/CD status from status checks"""
    if not status_checks:
        return {
            "total_checks": 0,
            "passed": 0,
            "failed": 0,
            "pending": 0,
            "skipped": 0,
            "failed_checks": [],
        }

    passed = 0
    failed = 0
    pending = 0
    skipped = 0
    failed_checks = []

    for check in status_checks:
        status = check.get("state", "").upper()
        conclusion = check.get("conclusion", "").upper()

        if conclusion == "SUCCESS":
            passed += 1
        elif conclusion in ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]:
            failed += 1
            failed_checks.append(
                {
                    "name": check.get("name", "unknown"),
                    "conclusion": conclusion,
                    "details_url": check.get("detailsUrl", ""),
                }
            )
        elif status in {"PENDING", "IN_PROGRESS"}:
            pending += 1
        elif conclusion in {"SKIPPED", "NEUTRAL"}:
            skipped += 1

    return {
        "total_checks": len(status_checks),
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "skipped": skipped,
        "failed_checks": failed_checks,
    }


def sync_repo(default_branch: str = "main") -> bool:
    """Sync the repository with origin

    Args:
        default_branch: The default branch to sync (detected at startup)

    Returns:
        True if sync successful, False otherwise
    """
    log_json("sync_repo", {"action": "start", "branch": default_branch})

    # Validate branch name
    if not validate_git_ref(default_branch):
        log_json(
            "sync_repo",
            {
                "action": "error",
                "step": "validation",
                "error": f"Invalid branch name: {default_branch}",
            },
        )
        return False

    # Fetch all remotes
    returncode, stdout, stderr = run_command(
        ["git", "fetch", "--all", "--prune"],
        timeout=180,
    )
    if returncode != 0:
        log_json("sync_repo", {"action": "error", "step": "fetch", "stderr": stderr})
        return False

    # Checkout default branch
    returncode, stdout, stderr = run_command(
        ["git", "checkout", default_branch],
        timeout=30,
    )
    if returncode != 0:
        log_json(
            "sync_repo",
            {
                "action": "error",
                "step": "checkout",
                "branch": default_branch,
                "stderr": stderr,
            },
        )
        return False

    # Pull latest changes
    returncode, _stdout, stderr = run_command(
        ["git", "pull", "origin", default_branch],
        timeout=120,
    )
    if returncode != 0:
        log_json(
            "sync_repo",
            {
                "action": "error",
                "step": "pull",
                "branch": default_branch,
                "stderr": stderr,
            },
        )
        return False

    log_json("sync_repo", {"action": "complete"})
    return True


def get_pr_guidelines() -> str:
    """Check for PR guidelines in common locations"""
    guideline_files = [
        "CONTRIBUTING.md",
        ".github/CONTRIBUTING.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "docs/CONTRIBUTING.md",
        "PULL_REQUEST_TEMPLATE.md",
    ]

    for filename in guideline_files:
        filepath = Path.cwd() / filename
        if filepath.exists():
            try:
                return filepath.read_text()
            except Exception:
                continue

    return ""


def get_commit_history_examples(default_branch: str = "main") -> str:
    """Get recent commit messages as examples

    Args:
        default_branch: The default branch to get commits from

    Returns:
        String of commit messages, one per line
    """
    if not validate_git_ref(default_branch):
        log_json(
            "commit_history",
            {
                "warning": f"Invalid branch name: {default_branch}",
            },
        )
        return ""

    returncode, stdout, _stderr = run_command(
        [
            "git",
            "log",
            "--pretty=format:%s",
            "-n",
            "20",
            f"origin/{default_branch}",
        ],
        timeout=30,
    )

    if returncode == 0 and stdout:
        return stdout

    return ""


def build_pr_prompt(
    pr_details: dict[str, Any],
    pr_context: dict[str, Any],
    guidelines: str,
    commit_examples: str,
) -> str:
    """Build comprehensive prompt for bob to process the PR with full context"""

    pr_number = pr_details.get("number", "unknown")
    title = pr_details.get("title", "")
    body = pr_details.get("body", "")
    head_branch = pr_details.get("headRefName", "")
    base_branch = pr_details.get("baseRefName", "main")
    url = pr_context.get("url", "")
    author = pr_details.get("author", {}).get("login", "unknown")

    prompt_parts = [
        f"# PR #{pr_number}: {title}",
        "",
        f"**Author**: {author}",
        f"**Branch**: {head_branch} → {base_branch}",
        f"**URL**: {url}",
        "",
    ]

    # Add PR description
    if body:
        prompt_parts.extend(
            [
                "## PR Description",
                "",
                body,
                "",
            ]
        )

    # Add PR statistics
    additions = pr_details.get("additions", 0)
    deletions = pr_details.get("deletions", 0)
    changed_files = pr_details.get("changedFiles", 0)

    prompt_parts.extend(
        [
            "## PR Statistics",
            "",
            f"- **Files changed**: {changed_files}",
            f"- **Additions**: +{additions}",
            f"- **Deletions**: -{deletions}",
            "",
        ]
    )

    # Add merge conflict information
    conflict_info = pr_context.get("conflicts", {})
    if conflict_info.get("has_conflicts"):
        conflicting_files = conflict_info.get("conflicting_files", [])
        prompt_parts.extend(
            [
                "## ⚠️ Merge Conflicts Detected",
                "",
                f"This PR has merge conflicts with {base_branch}. You MUST resolve these conflicts:",
                "",
            ]
        )
        for file in conflicting_files:
            prompt_parts.append(f"- `{file}`")
        prompt_parts.append("")

    # Add CI/CD status
    ci_status = pr_context.get("ci_status", {})
    if ci_status.get("total_checks", 0) > 0:
        prompt_parts.extend(
            [
                "## CI/CD Status",
                "",
                f"- **Total checks**: {ci_status['total_checks']}",
                f"- **Passed**: ✅ {ci_status['passed']}",
                f"- **Failed**: ❌ {ci_status['failed']}",
                f"- **Pending**: ⏳ {ci_status['pending']}",
                f"- **Skipped**: ⏭️ {ci_status['skipped']}",
                "",
            ]
        )

        failed_checks = ci_status.get("failed_checks", [])
        if failed_checks:
            prompt_parts.extend(
                [
                    "### Failed Checks (MUST FIX)",
                    "",
                ]
            )
            for check in failed_checks:
                prompt_parts.append(f"- **{check['name']}**: {check['conclusion']}")
                if check.get("details_url"):
                    prompt_parts.append(f"  - Details: {check['details_url']}")
            prompt_parts.append("")

    # Add review decision
    review_decision = pr_details.get("reviewDecision", "")
    if review_decision:
        emoji = (
            "✅"
            if review_decision == "APPROVED"
            else "⚠️"
            if review_decision == "CHANGES_REQUESTED"
            else "⏳"
        )
        prompt_parts.extend(
            [
                "## Review Status",
                "",
                f"{emoji} **{review_decision}**",
                "",
            ]
        )

    # Add review comments
    review_comments = pr_context.get("review_comments", [])
    if review_comments:
        prompt_parts.extend(
            [
                "## Code Review Comments (MUST ADDRESS)",
                "",
                "These are inline code review comments that require your attention:",
                "",
            ]
        )
        for i, comment in enumerate(review_comments[:20], 1):  # Limit to 20 most recent
            author = comment.get("user", {}).get("login", "unknown")
            body = comment.get("body", "")
            path = comment.get("path", "")
            line = comment.get("line", "") or comment.get("original_line", "")

            prompt_parts.extend(
                [
                    f"### Review Comment {i}",
                    f"**File**: `{path}` (line {line})",
                    f"**Author**: {author}",
                    "",
                    body,
                    "",
                ]
            )

    # Add general PR comments
    comments = pr_context.get("comments", [])
    if comments:
        prompt_parts.extend(
            [
                "## Discussion Comments",
                "",
            ]
        )
        for i, comment in enumerate(comments[-10:], 1):  # Last 10 comments
            author = comment.get("user", {}).get("login", "unknown")
            body = comment.get("body", "")

            prompt_parts.extend(
                [
                    f"### Comment {i}",
                    f"**Author**: {author}",
                    "",
                    body,
                    "",
                ]
            )

    # Add changed files summary
    changed_files_list = pr_context.get("files", [])
    if changed_files_list:
        prompt_parts.extend(
            [
                "## Changed Files",
                "",
            ]
        )
        for file in changed_files_list[:50]:  # Limit to 50 files
            filename = file.get("filename", "")
            status = file.get("status", "modified")
            additions = file.get("additions", 0)
            deletions = file.get("deletions", 0)

            status_emoji = {"added": "✨", "removed": "🗑️", "modified": "📝", "renamed": "🔄"}.get(
                status, "📝"
            )
            prompt_parts.append(f"- {status_emoji} `{filename}` (+{additions}/-{deletions})")
        prompt_parts.append("")

    # Add commit history
    commits = pr_context.get("commits", [])
    if commits:
        prompt_parts.extend(
            [
                "## Commit History",
                "",
            ]
        )
        for commit in commits[-10:]:  # Last 10 commits
            message = commit.get("commit", {}).get("message", "").split("\n")[0]
            sha = commit.get("sha", "")
            # Safely slice SHA (handle short or missing SHAs)
            short_sha = sha[:7] if sha and len(sha) >= 7 else (sha if sha else "unknown")
            prompt_parts.append(f"- `{short_sha}` {message}")
        prompt_parts.append("")

    # Add guidelines
    prompt_parts.extend(
        [
            "---",
            "",
            "## Your Mission",
            "",
            f"**Working on**: {title}",
            "",
        ]
    )

    # Add PR description if available to reinforce the original intent
    if body:
        # Take first paragraph or first 500 chars as a summary
        description_lines = body.strip().split("\n")
        summary = description_lines[0] if description_lines else body[:500]
        prompt_parts.extend(
            [
                f"**Purpose**: {summary}",
                "",
            ]
        )

    prompt_parts.extend(
        [
            "Get this PR merged successfully by completing ALL of the following:",
            "",
        ]
    )

    tasks = []
    if conflict_info.get("has_conflicts"):
        tasks.append("1. **RESOLVE MERGE CONFLICTS** - This is CRITICAL and must be done first")

    task_num = len(tasks) + 1
    tasks.extend(
        [
            f"{task_num}. Checkout the PR branch: `{head_branch}`",
            f"{task_num + 1}. Sync with `{base_branch}` (fetch and merge/rebase)",
        ]
    )

    task_num += 2
    if review_comments:
        tasks.append(
            f"{task_num}. Address ALL {len(review_comments)} code review comments with appropriate changes"
        )
        task_num += 1

    if ci_status.get("failed", 0) > 0:
        tasks.append(f"{task_num}. Fix ALL {ci_status['failed']} failing CI checks")
        task_num += 1

    tasks.extend(
        [
            f"{task_num}. Run tests and checks locally to verify everything passes",
            f"{task_num + 1}. Push changes back to `{head_branch}`",
            f"{task_num + 2}. Verify CI passes on GitHub after pushing",
        ]
    )

    prompt_parts.extend(tasks)
    prompt_parts.append("")

    # Add guidelines or commit examples
    if guidelines:
        prompt_parts.extend(
            [
                "## Project Guidelines",
                "",
                "Follow these PR and contribution guidelines:",
                "",
                "```",
                guidelines,
                "```",
                "",
            ]
        )
    elif commit_examples:
        prompt_parts.extend(
            [
                "## Commit Style Examples",
                "",
                "No explicit guidelines found. Follow the style of recent commits:",
                "",
                "```",
                commit_examples,
                "```",
                "",
            ]
        )

    # Add important rules
    prompt_parts.extend(
        [
            "## Critical Rules",
            "",
            "- ❌ **NO assistant branding** in commits, comments, or code",
            "- ✅ Write clear, professional commit messages matching project style",
            "- ✅ Make focused, minimal changes addressing specific issues only",
            "- ✅ Test thoroughly before pushing",
            "- ✅ Respond to review comments on GitHub when appropriate",
            "- ✅ If blocked, clearly document the issue and what's needed",
            "",
            "## Execution",
            "",
            "Work autonomously through all tasks. Report progress and any blockers.",
            "",
        ]
    )

    return "\n".join(prompt_parts)


def build_review_prompt(
    pr_number: int,
    title: str,
    head_branch: str,
    url: str,
    diff: str,
    changed_files: list[dict[str, Any]],
) -> str:
    """Build a code review prompt for targeted improvements

    This prompt is used in a second agent pass to review all changes
    and make targeted improvements to code quality, best practices, etc.

    Args:
        pr_number: PR number
        title: PR title
        head_branch: Branch being reviewed
        url: PR URL
        diff: Full diff of changes
        changed_files: List of changed files with stats

    Returns:
        Markdown formatted prompt for code review
    """

    prompt_parts = [
        f"# Code Review: PR #{pr_number} - {title}",
        "",
        f"**Branch**: {head_branch}",
        f"**URL**: {url}",
        "",
        "## Your Mission: Code Review and Targeted Improvements",
        "",
        "You are conducting a thorough code review of this PR. Your goal is to:",
        "",
        "1. **Review all code changes** for quality, correctness, and best practices",
        "2. **Identify issues** such as:",
        "   - Bugs or logical errors",
        "   - Security vulnerabilities",
        "   - Performance issues",
        "   - Code duplication",
        "   - Poor error handling",
        "   - Missing edge case handling",
        "   - Inconsistent coding style",
        "   - Missing or inadequate tests",
        "   - Unclear or missing documentation",
        "3. **Make targeted improvements** to fix identified issues",
        "4. **Commit your improvements** with clear, descriptive messages",
        "",
        "## Changed Files",
        "",
    ]

    # Add file list with statistics
    for file in changed_files[:50]:
        filename = file.get("filename", "")
        additions = file.get("additions", 0)
        deletions = file.get("deletions", 0)
        status = file.get("status", "modified")

        status_emoji = {
            "added": "✨",
            "removed": "🗑️",
            "modified": "📝",
            "renamed": "🔄",
        }.get(status, "📝")

        prompt_parts.append(f"- {status_emoji} `{filename}` (+{additions}/-{deletions})")

    prompt_parts.extend(
        [
            "",
            "## Full Diff",
            "",
            "Below is the complete diff of all changes in this PR. Review each change carefully:",
            "",
            "```diff",
            diff[:100000] if len(diff) > 100000 else diff,  # Cap at ~100KB to avoid overwhelming
            "```",
            "",
            "## Review Guidelines",
            "",
            "### Code Quality Checks",
            "- ✅ **Correctness**: Does the code do what it's supposed to do?",
            "- ✅ **Error Handling**: Are errors handled gracefully?",
            "- ✅ **Edge Cases**: Are boundary conditions and edge cases handled?",
            "- ✅ **Resource Management**: Are resources (files, connections, etc.) properly managed?",
            "- ✅ **Type Safety**: Are types used correctly? Any type errors?",
            "",
            "### Security Checks",
            "- 🔒 **Input Validation**: Is user input properly validated?",
            "- 🔒 **SQL Injection**: Are queries parameterized?",
            "- 🔒 **XSS**: Is output properly escaped?",
            "- 🔒 **Authentication/Authorization**: Are permissions checked?",
            "- 🔒 **Secrets**: Are there any hardcoded secrets or credentials?",
            "",
            "### Performance Checks",
            "- ⚡ **Algorithmic Efficiency**: Are algorithms efficient?",
            "- ⚡ **Database Queries**: Are queries optimized? N+1 queries?",
            "- ⚡ **Memory Usage**: Any memory leaks or excessive allocations?",
            "- ⚡ **Caching**: Should results be cached?",
            "",
            "### Best Practices",
            "- 📚 **DRY**: Is code duplicated? Can it be refactored?",
            "- 📚 **SOLID**: Does code follow SOLID principles?",
            "- 📚 **Naming**: Are variables and functions clearly named?",
            "- 📚 **Comments**: Are complex sections documented?",
            "- 📚 **Tests**: Are tests adequate? Missing test cases?",
            "",
            "## Making Improvements",
            "",
            "For each issue you identify:",
            "",
            "1. **Fix it directly** - Make the code changes",
            "2. **Write clear commits** - Explain what you fixed and why",
            "3. **Run tests** - Ensure your changes don't break anything",
            "4. **Be surgical** - Make focused, minimal changes",
            "",
            "### Commit Message Format",
            "",
            "Use clear, descriptive commit messages:",
            "",
            "```",
            "Fix: [brief description]",
            "",
            "[Detailed explanation of what was wrong and how you fixed it]",
            "```",
            "",
            "Examples:",
            "- `Fix: Add input validation to prevent SQL injection in user search`",
            "- `Refactor: Extract duplicate error handling into helper function`",
            "- `Performance: Add caching to reduce redundant API calls`",
            "- `Security: Remove hardcoded API key, use environment variable`",
            "",
            "## Critical Rules",
            "",
            "- ❌ **NO assistant branding** in commits or comments",
            "- ✅ **Be thorough** but don't over-engineer",
            "- ✅ **Preserve intent** - don't change functionality unless it's wrong",
            "- ✅ **Test your changes** before committing",
            "- ✅ **If unsure**, skip that change and document why",
            "",
            "## Execution",
            "",
            "Review the diff systematically. For each file:",
            "1. Understand what the code does",
            "2. Look for issues based on guidelines above",
            "3. Make improvements where needed",
            "4. Commit with clear messages",
            "",
            "Focus on high-impact improvements. Don't waste time on trivial style issues.",
            "",
        ]
    )

    return "\n".join(prompt_parts)


def gather_pr_context(
    pr_number: int, head_branch: str, base_branch: str, url: str
) -> dict[str, Any]:
    """Gather comprehensive context about a PR before processing"""
    log_json("gather_pr_context", {"action": "start", "pr_number": pr_number})

    context = {
        "url": url,
        "comments": [],
        "review_comments": [],
        "commits": [],
        "files": [],
        "conflicts": {},
        "ci_status": {},
        "diff": "",
    }

    # Get PR details
    details = get_pr_details(pr_number)

    # Extract and analyze CI status
    status_checks = details.get("statusCheckRollup", [])
    context["ci_status"] = analyze_ci_status(status_checks)

    # Get all comments
    context["comments"] = get_pr_comments(pr_number)

    # Get review comments
    context["review_comments"] = get_pr_review_comments(pr_number)

    # Get commits
    context["commits"] = get_pr_commits(pr_number)

    # Get changed files
    context["files"] = get_pr_files(pr_number)

    # Check for merge conflicts
    context["conflicts"] = check_merge_conflicts(pr_number, head_branch, base_branch)

    # Get diff (can be large, so we log size but don't include in JSON logs)
    context["diff"] = get_pr_diff(pr_number)

    log_json(
        "gather_pr_context",
        {
            "action": "complete",
            "pr_number": pr_number,
            "context_summary": {
                "comments": len(context["comments"]),
                "review_comments": len(context["review_comments"]),
                "commits": len(context["commits"]),
                "files": len(context["files"]),
                "has_conflicts": context["conflicts"].get("has_conflicts", False),
                "ci_checks": context["ci_status"].get("total_checks", 0),
                "ci_failed": context["ci_status"].get("failed", 0),
                "diff_size": len(context["diff"]),
            },
        },
    )

    return details, context


# Global agent client (initialized once)
_agent_client = None
_agent_model = None


def get_agent_client():
    """Get or create the global agent client"""
    global _agent_client, _agent_model
    if _agent_client is None:
        if not AGENT_SDK_AVAILABLE:
            raise RuntimeError("Agent SDK not available. Install with: uv add 'anthropic[bedrock]'")
        _agent_client = create_claude_client()
        _agent_model = get_model_name()
    return _agent_client, _agent_model


async def process_pr_async(
    pr: dict[str, Any],
    guidelines: str,
    commit_examples: str,
    default_branch: str = "main",
    mode: str = "for-landing",
    interactive: bool = False,
    db: StateDatabase | None = None,
    repo_name: str | None = None,
) -> bool:
    """
    Process a single PR using structured tasks and streaming.

    Breaks down PR processing into discrete tasks (analyze, resolve conflicts,
    address reviews, fix CI, validate) with real-time streaming and tool calling.

    Args:
        pr: PR data from GitHub API
        guidelines: Project contribution guidelines
        commit_examples: Example commit messages
        default_branch: Default branch of the repository
        mode: Processing mode - "for-review" or "for-landing"
        interactive: Whether to request confirmation before processing

    Returns:
        True if processing successful, False otherwise
    """
    # Extract and validate PR info (same as before)
    pr_number = pr.get("number")
    head_branch = pr.get("headRefName")
    base_branch = pr.get("baseRefName", default_branch)
    url = pr.get("url")
    title = pr.get("title", "Unknown")

    # Validate required fields
    if not pr_number:
        log_json(
            "process_pr",
            {
                "action": "validation_error",
                "error": "Missing PR number",
                "pr": pr,
            },
        )
        return False

    if not head_branch:
        log_json(
            "process_pr",
            {
                "action": "validation_error",
                "pr_number": pr_number,
                "error": "Missing head branch",
            },
        )
        return False

    if not url:
        log_json(
            "process_pr",
            {
                "action": "validation_error",
                "pr_number": pr_number,
                "error": "Missing PR URL",
            },
        )
        return False

    # Validate branch names
    if not validate_git_ref(head_branch):
        log_json(
            "process_pr",
            {
                "action": "validation_error",
                "pr_number": pr_number,
                "error": f"Invalid head branch name: {head_branch}",
            },
        )
        return False

    if not validate_git_ref(base_branch):
        log_json(
            "process_pr",
            {
                "action": "validation_error",
                "pr_number": pr_number,
                "error": f"Invalid base branch name: {base_branch}",
            },
        )
        return False

    # Request confirmation if interactive mode
    if interactive:
        approved = request_confirmation(
            action_type="process_pr",
            description=f"Process PR #{pr_number}: {title}",
            pr_number=str(pr_number),
            details={
                "title": title,
                "mode": mode,
                "head_branch": head_branch,
                "base_branch": base_branch,
                "url": url,
            },
        )

        if not approved:
            log_json(
                "process_pr",
                {
                    "action": "declined_by_user",
                    "pr_number": pr_number,
                },
            )
            return False

    log_json(
        "process_pr",
        {
            "action": "start",
            "pr_number": pr_number,
            "title": title,
            "head_branch": head_branch,
            "base_branch": base_branch,
            "mode": mode,
        },
    )

    send_notification(
        f"Processing PR #{pr_number}: {title}\nMode: {mode}",
        title=f"PR #{pr_number} - Processing Started",
        tags=["robot", "arrows_clockwise"],
    )

    # Gather comprehensive PR context
    log_json(
        "process_pr",
        {
            "action": "gathering_context",
            "pr_number": pr_number,
            "phase": "1/4",
            "phase_name": "Context Gathering",
        },
    )

    try:
        pr_details, pr_context_dict = gather_pr_context(pr_number, head_branch, base_branch, url)

        log_json(
            "process_pr",
            {
                "action": "context_gathered",
                "pr_number": pr_number,
                "phase": "1/4",
                "phase_name": "Context Gathering Complete",
            },
        )
    except Exception as e:
        log_json(
            "process_pr",
            {
                "action": "context_gather_error",
                "pr_number": pr_number,
                "error": str(e),
            },
        )
        send_notification(
            f"PR #{pr_number} failed: {title}\nError gathering context: {str(e)[:100]}",
            title=f"PR #{pr_number} - Error",
            priority="high",
            tags=["x", "warning"],
        )
        return False

    # Validate we got details
    if not pr_details or not isinstance(pr_details, dict):
        log_json(
            "process_pr",
            {
                "action": "empty_details",
                "pr_number": pr_number,
                "error": "Failed to fetch PR details",
            },
        )
        return False

    # Add guidelines to context
    pr_context_dict["guidelines"] = guidelines
    pr_context_dict["commit_examples"] = commit_examples

    # Save PR context to database for later replay/testing (Process 1 output)
    if db and repo_name:
        try:
            db.save_pr_context(repo_name, pr_number, pr_details, pr_context_dict)
            log_json(
                "process_pr",
                {
                    "action": "context_saved_to_db",
                    "pr_number": pr_number,
                    "db_enabled": True,
                },
            )
        except Exception as e:
            log_json(
                "process_pr",
                {
                    "action": "context_save_warning",
                    "pr_number": pr_number,
                    "error": str(e),
                    "hint": "PR processing will continue, but context won't be cached for replay",
                },
            )

    # Convert to structured PRContext
    log_json(
        "process_pr",
        {
            "action": "building_context",
            "pr_number": pr_number,
            "phase": "2/4",
            "phase_name": "Building PR Context",
        },
    )

    try:
        pr_context = PRContext.from_dict(pr_details, pr_context_dict)
        log_json(
            "process_pr",
            {
                "action": "context_built",
                "pr_number": pr_number,
                "phase": "2/4",
                "phase_name": "PR Context Ready",
            },
        )
    except Exception as e:
        log_json(
            "process_pr",
            {
                "action": "context_conversion_error",
                "pr_number": pr_number,
                "error": str(e),
            },
        )
        return False

    # Get agent client
    log_json(
        "process_pr",
        {
            "action": "initializing_agent",
            "pr_number": pr_number,
            "phase": "3/4",
            "phase_name": "Initializing Agent",
        },
    )

    try:
        client, model = get_agent_client()
        log_json(
            "process_pr",
            {
                "action": "agent_initialized",
                "pr_number": pr_number,
                "phase": "3/4",
                "model": model,
            },
        )
    except Exception as e:
        log_json(
            "process_pr",
            {
                "action": "agent_client_error",
                "pr_number": pr_number,
                "error": str(e),
            },
        )
        return False

    # Create agent
    agent = PRAgent(
        client=client,
        model=model,
        repo_path=Path.cwd(),
    )

    # Create callbacks for event handling
    callbacks = PRProcessingCallbacks(
        pr_number=pr_number,
        log_json=log_json,
        send_notification=send_notification,
    )

    # Process PR with streaming and structured tasks
    log_json(
        "process_pr",
        {
            "action": "agent_processing",
            "pr_number": pr_number,
            "phase": "4/4",
            "phase_name": "Agent Processing PR",
            "mode": mode,
        },
    )

    try:
        result = await agent.process_pr_streaming(
            pr_context=pr_context,
            mode=mode,
            callbacks=callbacks,
        )

        # Log detailed results
        log_json(
            "process_pr",
            {
                "action": "complete",
                "pr_number": pr_number,
                "phase": "4/4",
                "success": result.success,
                "duration": result.duration,
                "tasks_total": len(result.tasks),
                "tasks_completed": len([t for t in result.tasks if t.status == "completed"]),
                "tasks_failed": len([t for t in result.tasks if t.status == "failed"]),
                "actions_taken": len(result.actions),
                "mode": mode,
            },
        )

        # Send notification based on result
        if result.success:
            send_notification(
                f"PR #{pr_number} completed: {title}\n"
                f"Mode: {mode}\n"
                f"Tasks: {len(result.tasks)}, Actions: {len(result.actions)}\n"
                f"Duration: {result.duration:.1f}s",
                title=f"PR #{pr_number} - Complete",
                tags=["white_check_mark", "rocket"],
            )
        else:
            failed_tasks = result.get_failed_tasks()
            send_notification(
                f"PR #{pr_number} failed: {title}\n"
                f"Failed tasks: {', '.join(t.id for t in failed_tasks)}\n"
                f"Duration: {result.duration:.1f}s",
                title=f"PR #{pr_number} - Failed",
                priority="high",
                tags=["x", "warning"],
            )

        return result.success

    except Exception as e:
        log_json(
            "process_pr",
            {
                "action": "exception",
                "pr_number": pr_number,
                "error": str(e),
                "error_type": type(e).__name__,
            },
        )

        send_notification(
            f"PR #{pr_number} exception: {str(e)[:100]}",
            title=f"PR #{pr_number} - Error",
            priority="urgent",
            tags=["x", "warning"],
        )

        return False


def process_pr(
    pr: dict[str, Any],
    guidelines: str,
    commit_examples: str,
    default_branch: str = "main",
    mode: str = "for-landing",
    interactive: bool = False,
    db: StateDatabase | None = None,
    repo_name: str | None = None,
) -> bool:
    """Process a single PR using Claude Agent SDK.

    This function processes PRs with structured tasks, real-time streaming,
    and tool calling capabilities using the Claude Agent SDK.

    Args:
        pr: PR data from GitHub API
        guidelines: Project contribution guidelines
        commit_examples: Example commit messages
        default_branch: Default branch of the repository
        mode: Processing mode - "for-review" for comprehensive review, "for-landing" for basic merge
        interactive: Whether to request confirmation before processing

    Returns:
        True if processing successful, False otherwise
    """
    if not AGENT_SDK_AVAILABLE:
        log_json(
            "process_pr",
            {
                "action": "agent_sdk_unavailable",
                "pr_number": pr.get("number"),
                "error": "Agent SDK not installed. Install with: uv pip install -e .",
            },
        )
        return False

    # Use Agent SDK implementation
    return asyncio.run(
        process_pr_async(
            pr,
            guidelines,
            commit_examples,
            default_branch,
            mode,
            interactive,
            db,
            repo_name,
        )
    )


def process_issue(
    issue: dict[str, Any],
    guidelines: str,
    commit_examples: str,
    default_branch: str = "main",
    interactive: bool = False,
) -> bool:
    """Process a GitHub issue labeled for implementation

    Creates a branch, implements the feature/fix, creates a PR, and links it to the issue.

    Args:
        issue: Issue data from GitHub API
        guidelines: Project contribution guidelines
        commit_examples: Example commit messages
        default_branch: Default branch of the repository
        interactive: Whether to request confirmation before processing

    Returns:
        True if processing successful, False otherwise
    """
    # Extract required fields
    issue_number = issue.get("number")
    title = issue.get("title", "Unknown")
    body = issue.get("body", "")
    url = issue.get("url")

    # Validate required fields
    if not issue_number:
        log_json(
            "process_issue",
            {
                "action": "validation_error",
                "error": "Missing issue number",
                "issue": issue,
            },
        )
        return False

    if not url:
        log_json(
            "process_issue",
            {
                "action": "validation_error",
                "issue_number": issue_number,
                "error": "Missing issue URL",
            },
        )
        return False

    # Request confirmation if interactive mode
    if interactive:
        approved = request_confirmation(
            action_type="implement_issue",
            description=f"Implement issue #{issue_number}: {title}",
            pr_number=None,
            details={
                "issue_number": issue_number,
                "title": title,
                "url": url,
            },
        )

        if not approved:
            log_json(
                "process_issue",
                {
                    "action": "declined_by_user",
                    "issue_number": issue_number,
                },
            )
            return False

    log_json(
        "process_issue",
        {
            "action": "start",
            "issue_number": issue_number,
            "title": title,
        },
    )

    # Send notification
    send_notification(
        f"Implementing issue #{issue_number}: {title}",
        title=f"Issue #{issue_number} - Implementation Started",
        tags=["construction", "bulb"],
    )

    # Create branch name from issue
    # Format: issue-{number}-{sanitized-title}
    sanitized_title = title.lower().replace(" ", "-")[:50]
    # Remove unsafe characters
    sanitized_title = "".join(c for c in sanitized_title if c.isalnum() or c == "-")
    branch_name = f"issue-{issue_number}-{sanitized_title}"

    # Validate branch name
    if not validate_git_ref(branch_name):
        log_json(
            "process_issue",
            {
                "action": "validation_error",
                "issue_number": issue_number,
                "error": f"Invalid branch name: {branch_name}",
            },
        )
        return False

    # Sync with default branch first
    log_json(
        "process_issue",
        {
            "action": "sync_branch",
            "branch": default_branch,
        },
    )

    returncode, stdout, stderr = run_command(["git", "checkout", default_branch])
    if returncode != 0:
        log_json(
            "process_issue",
            {
                "action": "checkout_error",
                "issue_number": issue_number,
                "error": stderr,
            },
        )
        return False

    returncode, stdout, stderr = run_command(["git", "pull", "origin", default_branch])
    if returncode != 0:
        log_json(
            "process_issue",
            {
                "action": "pull_error",
                "issue_number": issue_number,
                "error": stderr,
            },
        )
        return False

    # Create new branch for the issue
    log_json(
        "process_issue",
        {
            "action": "create_branch",
            "issue_number": issue_number,
            "branch": branch_name,
        },
    )

    returncode, stdout, stderr = run_command(["git", "checkout", "-b", branch_name])
    if returncode != 0:
        # Branch might already exist, try to checkout
        returncode, stdout, stderr = run_command(["git", "checkout", branch_name])
        if returncode != 0:
            log_json(
                "process_issue",
                {
                    "action": "branch_error",
                    "issue_number": issue_number,
                    "error": stderr,
                },
            )
            return False

    # Build implementation prompt
    prompt = f"""# Issue Implementation Task

You are tasked with implementing a GitHub issue in this repository.

## Issue Details

**Issue Number:** #{issue_number}
**Title:** {title}
**URL:** {url}

**Description:**
{body if body else "No description provided"}

## Your Task

1. **Implement the feature or fix described in the issue**
   - Read and understand the issue requirements carefully
   - Implement the solution following best practices
   - Ensure code quality, security, and performance

2. **Write tests for your implementation**
   - Add appropriate unit tests
   - Ensure existing tests still pass

3. **Commit your changes**
   - Make focused, logical commits
   - Write clear commit messages following project conventions
   - Reference the issue in commits (e.g., "Fixes #{issue_number}")

4. **Create a pull request**
   - Use: `gh pr create --fill --head {branch_name} --base {default_branch}`
   - Link to the issue in PR description (use "Closes #{issue_number}")
   - Request any necessary reviews

## Project Guidelines

{guidelines if guidelines else "No specific guidelines available"}

## Commit Message Examples

{commit_examples if commit_examples else "No examples available"}

## Important Notes

- You are currently on branch: `{branch_name}`
- Base branch: `{default_branch}`
- This implementation should close issue #{issue_number}
- Focus on completing the requirements in the issue
- Ask questions if requirements are unclear
- Test thoroughly before creating the PR

Begin implementing the issue now.
"""

    log_json(
        "process_issue",
        {
            "action": "prompt_generated",
            "issue_number": issue_number,
            "prompt_size": len(prompt),
        },
    )

    # Run bob to implement the issue
    log_json(
        "process_issue",
        {
            "action": "running_bob",
            "issue_number": issue_number,
        },
    )

    returncode, stdout, stderr = run_command(
        [
            "bob",
            "--json",
            prompt,
        ],
        timeout=3600,
    )  # 1 hour for implementation

    log_json(
        "process_issue",
        {
            "action": "bob_complete",
            "issue_number": issue_number,
            "returncode": returncode,
            "stdout": stdout,
            "stderr": stderr,
        },
    )

    success = returncode == 0

    if success:
        # Send success notification
        send_notification(
            f"Issue #{issue_number} implementation completed: {title}\nCheck the created PR for details",
            title=f"Issue #{issue_number} - Complete",
            tags=["white_check_mark", "bulb"],
        )
    else:
        # Send failure notification
        send_notification(
            f"Issue #{issue_number} implementation failed: {title}\nCheck logs for details",
            title=f"Issue #{issue_number} - Failed",
            priority="high",
            tags=["x", "warning"],
        )

    log_json(
        "process_issue",
        {
            "action": "complete",
            "issue_number": issue_number,
            "success": success,
        },
    )

    return success


def validate_repository(repo_path: Path) -> bool:
    """Validate that the path is a valid git repository"""
    if not repo_path.exists():
        log_json(
            "validation_error",
            {
                "error": "Repository path does not exist",
                "path": str(repo_path),
            },
        )
        return False

    if not repo_path.is_dir():
        log_json(
            "validation_error",
            {
                "error": "Repository path is not a directory",
                "path": str(repo_path),
            },
        )
        return False

    git_dir = repo_path / ".git"
    if not git_dir.exists():
        log_json(
            "validation_error",
            {
                "error": "Not a git repository (no .git directory)",
                "path": str(repo_path),
            },
        )
        return False

    # Test git command works in this directory
    returncode, stdout, stderr = run_command(["git", "status"], cwd=repo_path)
    if returncode != 0:
        log_json(
            "validation_error",
            {
                "error": "Git command failed",
                "path": str(repo_path),
                "stderr": stderr,
            },
        )
        return False

    # Check if gh CLI is authenticated and works
    returncode, _stdout, stderr = run_command(["gh", "auth", "status"])
    if returncode != 0:
        log_json(
            "validation_error",
            {
                "error": "GitHub CLI not authenticated. Run 'gh auth login'",
                "stderr": stderr,
            },
        )
        return False

    log_json(
        "validation",
        {
            "success": True,
            "path": str(repo_path),
        },
    )
    return True


def parse_args() -> argparse.Namespace:
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="Automated PR processing loop using bob (AI assistant wrapper)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  ./pr-loop.py /path/to/repo
  ./pr-loop.py ~/projects/my-repo
  ./pr-loop.py .

The script will continuously process open PRs in the repository,
excluding draft PRs and those labeled with WIP/work-in-process.

Use GitHub labels to control processing mode:
  - Add 'for-landing' label for basic processing (conflicts, reviews, CI)
  - Add 'for-review' label for comprehensive code review
  - No label = PR is skipped
        """,
    )

    parser.add_argument(
        "repo_path",
        type=Path,
        help="Path to the git repository to process",
    )

    parser.add_argument(
        "--watch-issues",
        action="store_true",
        help="Monitor and process issues labeled 'for-impl' (processed before PRs)",
    )

    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Request user confirmation before taking actions (for TUI mode)",
    )

    return parser.parse_args()


def main() -> None:
    """Main loop - process PRs forever"""
    args = parse_args()
    repo_path = args.repo_path.resolve()

    # Validate repository
    if not validate_repository(repo_path):
        sys.exit(1)

    # Change to repository directory
    os.chdir(repo_path)

    log_json(
        "startup",
        {
            "repo_path": str(repo_path),
            "cwd": str(Path.cwd()),
            "python_version": sys.version,
        },
    )

    # Initialize database for state persistence
    db = None
    repo_name = None
    if DB_AVAILABLE:
        try:
            db_path = Path("merge-god-state.db")
            db = StateDatabase(db_path)
            # Use the directory name as repo name
            repo_name = repo_path.name
            log_json(
                "startup",
                {
                    "database_enabled": True,
                    "db_path": str(db_path),
                    "repo_name": repo_name,
                },
            )
        except Exception as e:
            log_json(
                "startup",
                {
                    "database_error": str(e),
                    "warning": "Continuing without database persistence",
                },
            )
            db = None
    else:
        log_json(
            "startup",
            {
                "database_enabled": False,
                "warning": "Database operations module not available",
            },
        )

    # Detect default branch
    default_branch = detect_default_branch()
    log_json(
        "startup",
        {
            "default_branch": default_branch,
        },
    )

    # Get guidelines and commit examples once at startup
    guidelines = get_pr_guidelines()
    commit_examples = get_commit_history_examples(default_branch) if not guidelines else ""

    log_json(
        "startup",
        {
            "has_guidelines": bool(guidelines),
            "has_commit_examples": bool(commit_examples),
        },
    )

    iteration = 0
    processing_prs = set()  # Track PRs being processed to avoid duplicates
    processing_issues = set()  # Track issues being processed to avoid duplicates

    while True:
        iteration += 1
        log_json("iteration", {"number": iteration, "action": "start"})

        # Sync repository
        if not sync_repo(default_branch):
            log_json(
                "iteration",
                {
                    "number": iteration,
                    "action": "sync_failed",
                    "sleep_seconds": 60,
                },
            )
            time.sleep(60)
            continue

        # PRIMARY TASK: Process issues first (if watch-issues enabled)
        issues_processed = 0
        if args.watch_issues:
            open_issues = get_open_issues()

            if open_issues:
                log_json(
                    "iteration",
                    {
                        "number": iteration,
                        "action": "issues_found",
                        "count": len(open_issues),
                    },
                )

                for issue in open_issues:
                    issue_number = issue.get("number")

                    # Skip if already being processed
                    if issue_number and issue_number in processing_issues:
                        log_json(
                            "process_issue",
                            {
                                "action": "skip_duplicate",
                                "issue_number": issue_number,
                            },
                        )
                        continue

                    if issue_number:
                        processing_issues.add(issue_number)

                    try:
                        success = process_issue(
                            issue, guidelines, commit_examples, default_branch, args.interactive
                        )
                        if success and issue_number:
                            # Remove from processing set after successful completion
                            processing_issues.discard(issue_number)
                        issues_processed += 1
                    except KeyboardInterrupt:
                        log_json("shutdown", {"reason": "keyboard_interrupt"})
                        sys.exit(0)
                    except Exception as e:
                        log_json(
                            "process_issue",
                            {
                                "action": "exception",
                                "issue_number": issue_number,
                                "error": str(e),
                            },
                        )
                        # Remove from processing set on exception
                        if issue_number:
                            processing_issues.discard(issue_number)

                    # Small delay between issues
                    time.sleep(10)
            else:
                log_json(
                    "iteration",
                    {
                        "number": iteration,
                        "action": "no_issues_found",
                    },
                )

        # Get open PRs categorized by labels
        categorized_prs = get_open_prs()

        # Count total processable PRs (excluding untagged)
        total_processable = len(categorized_prs["for-review"]) + len(categorized_prs["for-landing"])

        if total_processable == 0:
            log_json(
                "iteration",
                {
                    "number": iteration,
                    "action": "no_processable_prs",
                    "untagged_count": len(categorized_prs["untagged"]),
                    "sleep_seconds": 300,
                },
            )
            # Clear processing set when no PRs
            processing_prs.clear()
            time.sleep(300)  # Wait 5 minutes if no PRs
            continue

        # Log categorization results with PR details
        pr_details = {
            "for_review": [
                {"number": pr.get("number"), "title": pr.get("title", "")[:50]}
                for pr in categorized_prs["for-review"]
            ],
            "for_landing": [
                {"number": pr.get("number"), "title": pr.get("title", "")[:50]}
                for pr in categorized_prs["for-landing"]
            ],
            "untagged": [
                {"number": pr.get("number"), "title": pr.get("title", "")[:50]}
                for pr in categorized_prs["untagged"]
            ],
        }

        log_json(
            "iteration",
            {
                "number": iteration,
                "action": "prs_categorized",
                "for_review": len(categorized_prs["for-review"]),
                "for_landing": len(categorized_prs["for-landing"]),
                "untagged": len(categorized_prs["untagged"]),
                "pr_details": pr_details,
            },
        )

        # Process PRs by mode
        total_processed = 0
        for mode in ["for-review", "for-landing"]:
            for pr in categorized_prs[mode]:
                pr_number = pr.get("number")

                # Skip if already being processed in this iteration
                if pr_number and pr_number in processing_prs:
                    log_json(
                        "process_pr",
                        {
                            "action": "skip_duplicate",
                            "pr_number": pr_number,
                            "mode": mode,
                        },
                    )
                    continue

                if pr_number:
                    processing_prs.add(pr_number)

                try:
                    success = process_pr(
                        pr,
                        guidelines,
                        commit_examples,
                        default_branch,
                        mode,
                        args.interactive,
                        db,
                        repo_name,
                    )
                    if success and pr_number:
                        # Remove from processing set after successful completion
                        processing_prs.discard(pr_number)
                    total_processed += 1
                except KeyboardInterrupt:
                    log_json("shutdown", {"reason": "keyboard_interrupt"})
                    sys.exit(0)
                except Exception as e:
                    log_json(
                        "process_pr",
                        {
                            "action": "exception",
                            "pr_number": pr_number,
                            "mode": mode,
                            "error": str(e),
                        },
                    )
                    # Remove from processing set on exception
                    if pr_number:
                        processing_prs.discard(pr_number)

                # Small delay between PRs
                time.sleep(10)

        log_json(
            "iteration",
            {
                "number": iteration,
                "action": "complete",
                "issues_processed": issues_processed,
                "prs_processed": total_processed,
                "sleep_seconds": 300,
            },
        )

        # Wait before next iteration
        time.sleep(300)  # 5 minutes between full cycles


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log_json("shutdown", {"reason": "keyboard_interrupt"})
        sys.exit(0)
    except Exception as e:
        log_json("fatal_error", {"error": str(e)})
        sys.exit(1)
