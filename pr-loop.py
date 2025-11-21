#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
PR Merge Loop - Automatically processes and merges PRs using bob (AI assistant wrapper)
Continuously loops through open PRs, syncing repo, fixing conflicts, responding to reviews, and fixing CI.

Usage: ./pr-loop.py <repo_path>
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def log_json(event_type: str, data: dict[str, Any]) -> None:
    """Emit structured JSON logs with timestamp"""
    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "event": event_type,
        "data": data,
    }
    print(json.dumps(log_entry), flush=True)


def send_notification(
    message: str,
    title: str | None = None,
    priority: str = "default",
    tags: list[str] | None = None
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
            method="POST"
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                log_json("notification", {
                    "action": "sent",
                    "title": title,
                    "message_length": len(message)
                })
                return True
            else:
                log_json("notification", {
                    "action": "failed",
                    "status": response.status,
                    "title": title
                })
                return False

    except urllib.error.URLError as e:
        log_json("notification", {
            "action": "error",
            "error": str(e),
            "title": title
        })
        return False
    except Exception as e:
        log_json("notification", {
            "action": "exception",
            "error": str(e),
            "title": title
        })
        return False


def run_command(
    cmd: list[str],
    cwd: Path | None = None,
    timeout: int = 300,  # 5 minutes default
    max_output_size: int = 50 * 1024 * 1024  # 50MB default
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
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        # Check output size
        stdout_size = len(result.stdout.encode('utf-8'))
        stderr_size = len(result.stderr.encode('utf-8'))

        if stdout_size > max_output_size:
            log_json("command_warning", {
                "warning": "stdout truncated",
                "size": stdout_size,
                "max_size": max_output_size,
                "command": cmd[0] if cmd else "unknown"
            })
            result.stdout = result.stdout[:max_output_size // 2] + "\n... [truncated] ..."

        if stderr_size > max_output_size:
            log_json("command_warning", {
                "warning": "stderr truncated",
                "size": stderr_size,
                "max_size": max_output_size,
                "command": cmd[0] if cmd else "unknown"
            })
            result.stderr = result.stderr[:max_output_size // 2] + "\n... [truncated] ..."

        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as e:
        return -1, "", f"Command timed out after {timeout} seconds"
    except FileNotFoundError as e:
        return -1, "", f"Command not found: {cmd[0] if cmd else 'unknown'}"
    except Exception as e:
        return -1, "", f"Command failed: {str(e)}"


def get_open_prs() -> dict[str, list[dict[str, Any]]]:
    """Fetch open PRs and categorize by processing mode labels

    Returns:
        Dictionary with keys:
        - "for-review": PRs labeled for code review (comprehensive review + improvements)
        - "for-landing": PRs labeled for landing (basic processing to merge)
        - "untagged": PRs without processing labels (skipped)
    """
    log_json("fetch_prs", {"action": "start"})

    returncode, stdout, stderr = run_command([
        "gh", "pr", "list",
        "--json", "number,title,headRefName,baseRefName,isDraft,labels,url,author,createdAt,updatedAt",
        "--limit", "100",
    ], timeout=60)

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
        "untagged": []
    }

    for pr in all_prs:
        if not isinstance(pr, dict):
            continue

        # Validate required fields exist
        if not all(key in pr for key in ["number", "headRefName", "url"]):
            log_json("fetch_prs", {"action": "invalid_pr", "pr": pr})
            continue

        # Skip draft PRs
        if pr.get("isDraft", False):
            continue

        # Safely get labels
        labels = []
        for label in pr.get("labels", []):
            if isinstance(label, dict) and "name" in label:
                labels.append(label["name"].lower())

        # Skip WIP PRs
        if any(wip in label for label in labels for wip in ["wip", "work-in-process", "work in process"]):
            continue

        # Categorize by processing mode labels
        if "for-review" in labels:
            categorized["for-review"].append(pr)
        elif "for-landing" in labels:
            categorized["for-landing"].append(pr)
        else:
            # PRs without processing labels are untagged (will be skipped)
            categorized["untagged"].append(pr)

    log_json("fetch_prs", {
        "action": "complete",
        "total": len(all_prs),
        "for_review": len(categorized["for-review"]),
        "for_landing": len(categorized["for-landing"]),
        "untagged": len(categorized["untagged"]),
    })

    return categorized


def validate_git_ref(ref: str) -> bool:
    """Validate that a string is a safe git reference name

    Prevents command injection through malicious branch names.
    """
    if not ref or not isinstance(ref, str):
        return False

    # Git ref names should not contain these characters
    unsafe_chars = ['\0', '\n', '\r', ' ', '~', '^', ':', '?', '*', '[', '\\', '..', '@{', '//']
    if any(char in ref for char in unsafe_chars):
        return False

    # Should not start or end with certain characters
    if ref.startswith(('.', '/')) or ref.endswith(('.', '/', '.lock')):
        return False

    # Reasonable length check (git allows 255 but be conservative)
    if len(ref) > 200:
        return False

    return True


def detect_default_branch() -> str:
    """Detect the default branch of the repository"""
    # Try to get the default branch from remote
    returncode, stdout, stderr = run_command([
        "git", "symbolic-ref", "refs/remotes/origin/HEAD"
    ], timeout=10)

    if returncode == 0 and stdout:
        # Output is like "refs/remotes/origin/main"
        branch = stdout.strip().split('/')[-1]
        if branch:
            return branch

    # Fallback: try common names
    for branch in ["main", "master", "develop"]:
        returncode, stdout, stderr = run_command([
            "git", "rev-parse", "--verify", f"origin/{branch}"
        ], timeout=10)
        if returncode == 0:
            return branch

    # Last resort
    log_json("branch_detection", {
        "warning": "Could not detect default branch, using 'main'"
    })
    return "main"


def get_pr_details(pr_number: int) -> dict[str, Any]:
    """Fetch comprehensive PR details"""
    log_json("get_pr_details", {"action": "start", "pr_number": pr_number})

    # Get full PR information
    returncode, stdout, stderr = run_command([
        "gh", "pr", "view", str(pr_number),
        "--json", "number,title,body,state,headRefName,baseRefName,isDraft,mergeable,"
                  "author,createdAt,updatedAt,closedAt,mergedAt,labels,assignees,reviewers,"
                  "additions,deletions,changedFiles,commits,reviews,reviewDecision,statusCheckRollup"
    ])

    if returncode != 0:
        log_json("get_pr_details", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return {}

    try:
        details = json.loads(stdout)
    except json.JSONDecodeError as e:
        log_json("get_pr_details", {"action": "parse_error", "pr_number": pr_number, "error": str(e)})
        return {}

    log_json("get_pr_details", {"action": "complete", "pr_number": pr_number})
    return details


def get_pr_comments(pr_number: int) -> list[dict[str, Any]]:
    """Fetch all PR comments (discussion/issue comments)"""
    log_json("get_pr_comments", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command([
        "gh", "api", f"repos/{{owner}}/{{repo}}/issues/{pr_number}/comments",
        "--jq", "."
    ])

    if returncode != 0:
        log_json("get_pr_comments", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return []

    try:
        comments = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json("get_pr_comments", {"action": "parse_error", "pr_number": pr_number, "error": str(e)})
        return []

    log_json("get_pr_comments", {
        "action": "complete",
        "pr_number": pr_number,
        "comment_count": len(comments)
    })
    return comments


def get_pr_review_comments(pr_number: int) -> list[dict[str, Any]]:
    """Fetch all PR review comments (inline code review comments)"""
    log_json("get_pr_review_comments", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command([
        "gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments",
        "--jq", "."
    ])

    if returncode != 0:
        log_json("get_pr_review_comments", {
            "action": "error",
            "pr_number": pr_number,
            "stderr": stderr
        })
        return []

    try:
        comments = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json("get_pr_review_comments", {
            "action": "parse_error",
            "pr_number": pr_number,
            "error": str(e)
        })
        return []

    log_json("get_pr_review_comments", {
        "action": "complete",
        "pr_number": pr_number,
        "review_comment_count": len(comments)
    })
    return comments


def get_pr_diff(pr_number: int) -> str:
    """Get the PR diff"""
    log_json("get_pr_diff", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command([
        "gh", "pr", "diff", str(pr_number)
    ])

    if returncode != 0:
        log_json("get_pr_diff", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return ""

    log_json("get_pr_diff", {
        "action": "complete",
        "pr_number": pr_number,
        "diff_size": len(stdout)
    })
    return stdout


def check_merge_conflicts(pr_number: int, head_branch: str, base_branch: str) -> dict[str, Any]:
    """Check if PR has merge conflicts with base branch"""
    log_json("check_merge_conflicts", {
        "action": "start",
        "pr_number": pr_number,
        "head_branch": head_branch,
        "base_branch": base_branch
    })

    # Validate branch names
    if not validate_git_ref(head_branch):
        log_json("check_merge_conflicts", {
            "action": "invalid_branch",
            "pr_number": pr_number,
            "branch": "head",
            "value": head_branch
        })
        return {
            "has_conflicts": False,
            "conflicting_files": [],
            "conflict_count": 0,
            "error": "Invalid head branch name"
        }

    if not validate_git_ref(base_branch):
        log_json("check_merge_conflicts", {
            "action": "invalid_branch",
            "pr_number": pr_number,
            "branch": "base",
            "value": base_branch
        })
        return {
            "has_conflicts": False,
            "conflicting_files": [],
            "conflict_count": 0,
            "error": "Invalid base branch name"
        }

    # Fetch latest
    returncode, stdout, stderr = run_command([
        "git", "fetch", "origin", head_branch, base_branch
    ], timeout=120)

    if returncode != 0:
        log_json("check_merge_conflicts", {
            "action": "fetch_error",
            "pr_number": pr_number,
            "stderr": stderr
        })
        return {
            "has_conflicts": False,
            "conflicting_files": [],
            "conflict_count": 0,
            "error": "Failed to fetch branches"
        }

    # Check if merge would conflict using merge-tree
    returncode, stdout, stderr = run_command([
        "git", "merge-tree",
        f"origin/{base_branch}",
        f"origin/{head_branch}"
    ], timeout=120)

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
            if line.startswith("+++") or line.startswith("---"):
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
        "conflict_count": len(conflicting_files)
    }

    log_json("check_merge_conflicts", {
        "action": "complete",
        "pr_number": pr_number,
        **result
    })

    return result


def get_pr_commits(pr_number: int) -> list[dict[str, Any]]:
    """Get all commits in the PR"""
    log_json("get_pr_commits", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command([
        "gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/commits",
        "--jq", "."
    ])

    if returncode != 0:
        log_json("get_pr_commits", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return []

    try:
        commits = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json("get_pr_commits", {"action": "parse_error", "pr_number": pr_number, "error": str(e)})
        return []

    log_json("get_pr_commits", {
        "action": "complete",
        "pr_number": pr_number,
        "commit_count": len(commits)
    })
    return commits


def get_pr_files(pr_number: int) -> list[dict[str, Any]]:
    """Get list of changed files in the PR"""
    log_json("get_pr_files", {"action": "start", "pr_number": pr_number})

    returncode, stdout, stderr = run_command([
        "gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/files",
        "--jq", "."
    ])

    if returncode != 0:
        log_json("get_pr_files", {"action": "error", "pr_number": pr_number, "stderr": stderr})
        return []

    try:
        files = json.loads(stdout) if stdout else []
    except json.JSONDecodeError as e:
        log_json("get_pr_files", {"action": "parse_error", "pr_number": pr_number, "error": str(e)})
        return []

    log_json("get_pr_files", {
        "action": "complete",
        "pr_number": pr_number,
        "file_count": len(files)
    })
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
            "failed_checks": []
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
            failed_checks.append({
                "name": check.get("name", "unknown"),
                "conclusion": conclusion,
                "details_url": check.get("detailsUrl", "")
            })
        elif status == "PENDING" or status == "IN_PROGRESS":
            pending += 1
        elif conclusion == "SKIPPED" or conclusion == "NEUTRAL":
            skipped += 1

    return {
        "total_checks": len(status_checks),
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "skipped": skipped,
        "failed_checks": failed_checks
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
        log_json("sync_repo", {
            "action": "error",
            "step": "validation",
            "error": f"Invalid branch name: {default_branch}"
        })
        return False

    # Fetch all remotes
    returncode, stdout, stderr = run_command(
        ["git", "fetch", "--all", "--prune"],
        timeout=180
    )
    if returncode != 0:
        log_json("sync_repo", {"action": "error", "step": "fetch", "stderr": stderr})
        return False

    # Checkout default branch
    returncode, stdout, stderr = run_command(
        ["git", "checkout", default_branch],
        timeout=30
    )
    if returncode != 0:
        log_json("sync_repo", {
            "action": "error",
            "step": "checkout",
            "branch": default_branch,
            "stderr": stderr
        })
        return False

    # Pull latest changes
    returncode, stdout, stderr = run_command(
        ["git", "pull", "origin", default_branch],
        timeout=120
    )
    if returncode != 0:
        log_json("sync_repo", {
            "action": "error",
            "step": "pull",
            "branch": default_branch,
            "stderr": stderr
        })
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
        log_json("commit_history", {
            "warning": f"Invalid branch name: {default_branch}"
        })
        return ""

    returncode, stdout, stderr = run_command([
        "git", "log", "--pretty=format:%s", "-n", "20", f"origin/{default_branch}"
    ], timeout=30)

    if returncode == 0 and stdout:
        return stdout

    return ""


def build_pr_prompt(
    pr_details: dict[str, Any],
    pr_context: dict[str, Any],
    guidelines: str,
    commit_examples: str
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
        prompt_parts.extend([
            "## PR Description",
            "",
            body,
            "",
        ])

    # Add PR statistics
    additions = pr_details.get("additions", 0)
    deletions = pr_details.get("deletions", 0)
    changed_files = pr_details.get("changedFiles", 0)

    prompt_parts.extend([
        "## PR Statistics",
        "",
        f"- **Files changed**: {changed_files}",
        f"- **Additions**: +{additions}",
        f"- **Deletions**: -{deletions}",
        "",
    ])

    # Add merge conflict information
    conflict_info = pr_context.get("conflicts", {})
    if conflict_info.get("has_conflicts"):
        conflicting_files = conflict_info.get("conflicting_files", [])
        prompt_parts.extend([
            "## ⚠️ Merge Conflicts Detected",
            "",
            f"This PR has merge conflicts with {base_branch}. You MUST resolve these conflicts:",
            "",
        ])
        for file in conflicting_files:
            prompt_parts.append(f"- `{file}`")
        prompt_parts.append("")

    # Add CI/CD status
    ci_status = pr_context.get("ci_status", {})
    if ci_status.get("total_checks", 0) > 0:
        prompt_parts.extend([
            "## CI/CD Status",
            "",
            f"- **Total checks**: {ci_status['total_checks']}",
            f"- **Passed**: ✅ {ci_status['passed']}",
            f"- **Failed**: ❌ {ci_status['failed']}",
            f"- **Pending**: ⏳ {ci_status['pending']}",
            f"- **Skipped**: ⏭️ {ci_status['skipped']}",
            "",
        ])

        failed_checks = ci_status.get("failed_checks", [])
        if failed_checks:
            prompt_parts.extend([
                "### Failed Checks (MUST FIX)",
                "",
            ])
            for check in failed_checks:
                prompt_parts.append(f"- **{check['name']}**: {check['conclusion']}")
                if check.get("details_url"):
                    prompt_parts.append(f"  - Details: {check['details_url']}")
            prompt_parts.append("")

    # Add review decision
    review_decision = pr_details.get("reviewDecision", "")
    if review_decision:
        emoji = "✅" if review_decision == "APPROVED" else "⚠️" if review_decision == "CHANGES_REQUESTED" else "⏳"
        prompt_parts.extend([
            "## Review Status",
            "",
            f"{emoji} **{review_decision}**",
            "",
        ])

    # Add review comments
    review_comments = pr_context.get("review_comments", [])
    if review_comments:
        prompt_parts.extend([
            "## Code Review Comments (MUST ADDRESS)",
            "",
            "These are inline code review comments that require your attention:",
            "",
        ])
        for i, comment in enumerate(review_comments[:20], 1):  # Limit to 20 most recent
            author = comment.get("user", {}).get("login", "unknown")
            body = comment.get("body", "")
            path = comment.get("path", "")
            line = comment.get("line", "") or comment.get("original_line", "")

            prompt_parts.extend([
                f"### Review Comment {i}",
                f"**File**: `{path}` (line {line})",
                f"**Author**: {author}",
                "",
                body,
                "",
            ])

    # Add general PR comments
    comments = pr_context.get("comments", [])
    if comments:
        prompt_parts.extend([
            "## Discussion Comments",
            "",
        ])
        for i, comment in enumerate(comments[-10:], 1):  # Last 10 comments
            author = comment.get("user", {}).get("login", "unknown")
            body = comment.get("body", "")

            prompt_parts.extend([
                f"### Comment {i}",
                f"**Author**: {author}",
                "",
                body,
                "",
            ])

    # Add changed files summary
    changed_files_list = pr_context.get("files", [])
    if changed_files_list:
        prompt_parts.extend([
            "## Changed Files",
            "",
        ])
        for file in changed_files_list[:50]:  # Limit to 50 files
            filename = file.get("filename", "")
            status = file.get("status", "modified")
            additions = file.get("additions", 0)
            deletions = file.get("deletions", 0)

            status_emoji = {"added": "✨", "removed": "🗑️", "modified": "📝", "renamed": "🔄"}.get(status, "📝")
            prompt_parts.append(f"- {status_emoji} `{filename}` (+{additions}/-{deletions})")
        prompt_parts.append("")

    # Add commit history
    commits = pr_context.get("commits", [])
    if commits:
        prompt_parts.extend([
            "## Commit History",
            "",
        ])
        for commit in commits[-10:]:  # Last 10 commits
            message = commit.get("commit", {}).get("message", "").split("\n")[0]
            sha = commit.get("sha", "")
            # Safely slice SHA (handle short or missing SHAs)
            short_sha = sha[:7] if sha and len(sha) >= 7 else (sha if sha else "unknown")
            prompt_parts.append(f"- `{short_sha}` {message}")
        prompt_parts.append("")

    # Add guidelines
    prompt_parts.extend([
        "---",
        "",
        "## Your Mission",
        "",
        "Get this PR merged successfully by completing ALL of the following:",
        "",
    ])

    tasks = []
    if conflict_info.get("has_conflicts"):
        tasks.append("1. **RESOLVE MERGE CONFLICTS** - This is CRITICAL and must be done first")

    task_num = len(tasks) + 1
    tasks.extend([
        f"{task_num}. Checkout the PR branch: `{head_branch}`",
        f"{task_num + 1}. Sync with `{base_branch}` (fetch and merge/rebase)",
    ])

    task_num += 2
    if review_comments:
        tasks.append(f"{task_num}. Address ALL {len(review_comments)} code review comments with appropriate changes")
        task_num += 1

    if ci_status.get("failed", 0) > 0:
        tasks.append(f"{task_num}. Fix ALL {ci_status['failed']} failing CI checks")
        task_num += 1

    tasks.extend([
        f"{task_num}. Run tests and checks locally to verify everything passes",
        f"{task_num + 1}. Push changes back to `{head_branch}`",
        f"{task_num + 2}. Verify CI passes on GitHub after pushing",
    ])

    prompt_parts.extend(tasks)
    prompt_parts.append("")

    # Add guidelines or commit examples
    if guidelines:
        prompt_parts.extend([
            "## Project Guidelines",
            "",
            "Follow these PR and contribution guidelines:",
            "",
            "```",
            guidelines,
            "```",
            "",
        ])
    elif commit_examples:
        prompt_parts.extend([
            "## Commit Style Examples",
            "",
            "No explicit guidelines found. Follow the style of recent commits:",
            "",
            "```",
            commit_examples,
            "```",
            "",
        ])

    # Add important rules
    prompt_parts.extend([
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
    ])

    return "\n".join(prompt_parts)


def build_review_prompt(
    pr_number: int,
    title: str,
    head_branch: str,
    url: str,
    diff: str,
    changed_files: list[dict[str, Any]]
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
            "renamed": "🔄"
        }.get(status, "📝")

        prompt_parts.append(f"- {status_emoji} `{filename}` (+{additions}/-{deletions})")

    prompt_parts.extend([
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
    ])

    return "\n".join(prompt_parts)


def gather_pr_context(pr_number: int, head_branch: str, base_branch: str, url: str) -> dict[str, Any]:
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

    log_json("gather_pr_context", {
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
        }
    })

    return details, context


def process_pr(
    pr: dict[str, Any],
    guidelines: str,
    commit_examples: str,
    default_branch: str = "main",
    mode: str = "for-landing"
) -> bool:
    """Process a single PR using bob with comprehensive context

    Args:
        pr: PR data from GitHub API
        guidelines: Project contribution guidelines
        commit_examples: Example commit messages
        default_branch: Default branch of the repository
        mode: Processing mode - "for-review" for comprehensive review, "for-landing" for basic merge

    Returns:
        True if processing successful, False otherwise
    """
    # Safely extract required fields with validation
    pr_number = pr.get("number")
    head_branch = pr.get("headRefName")
    base_branch = pr.get("baseRefName", default_branch)
    url = pr.get("url")
    title = pr.get("title", "Unknown")

    # Validate required fields
    if not pr_number:
        log_json("process_pr", {
            "action": "validation_error",
            "error": "Missing PR number",
            "pr": pr
        })
        return False

    if not head_branch:
        log_json("process_pr", {
            "action": "validation_error",
            "pr_number": pr_number,
            "error": "Missing head branch"
        })
        return False

    if not url:
        log_json("process_pr", {
            "action": "validation_error",
            "pr_number": pr_number,
            "error": "Missing PR URL"
        })
        return False

    # Validate branch names
    if not validate_git_ref(head_branch):
        log_json("process_pr", {
            "action": "validation_error",
            "pr_number": pr_number,
            "error": f"Invalid head branch name: {head_branch}"
        })
        return False

    if not validate_git_ref(base_branch):
        log_json("process_pr", {
            "action": "validation_error",
            "pr_number": pr_number,
            "error": f"Invalid base branch name: {base_branch}"
        })
        return False

    log_json("process_pr", {
        "action": "start",
        "pr_number": pr_number,
        "title": title,
        "head_branch": head_branch,
        "base_branch": base_branch,
    })

    # Send notification that PR processing has started
    send_notification(
        f"Processing PR #{pr_number}: {title}\nMode: {mode}\nBranch: {head_branch} → {base_branch}",
        title=f"PR #{pr_number} - Processing Started",
        tags=["robot", "arrows_clockwise"]
    )

    # Gather comprehensive PR context
    try:
        pr_details, pr_context = gather_pr_context(pr_number, head_branch, base_branch, url)
    except Exception as e:
        log_json("process_pr", {
            "action": "context_gather_error",
            "pr_number": pr_number,
            "error": str(e),
        })
        return False

    # Validate we got details
    if not pr_details or not isinstance(pr_details, dict):
        log_json("process_pr", {
            "action": "empty_details",
            "pr_number": pr_number,
            "error": "Failed to fetch PR details"
        })
        return False

    # Build the comprehensive prompt
    try:
        prompt = build_pr_prompt(pr_details, pr_context, guidelines, commit_examples)
    except Exception as e:
        log_json("process_pr", {
            "action": "prompt_build_error",
            "pr_number": pr_number,
            "error": str(e)
        })
        return False

    log_json("process_pr", {
        "action": "prompt_generated",
        "pr_number": pr_number,
        "prompt_size": len(prompt),
    })

    # Run bob with the prompt (bob is a wrapper around claude code)
    # Use longer timeout since bob may take a while to process and fix the PR
    log_json("process_pr", {
        "action": "running_bob",
        "pr_number": pr_number,
    })

    returncode, stdout, stderr = run_command([
        "bob",
        "--json",
        prompt,
    ], timeout=3600)  # 1 hour for bob to do its work

    log_json("process_pr", {
        "action": "bob_complete",
        "pr_number": pr_number,
        "returncode": returncode,
        "stdout": stdout,
        "stderr": stderr,
    })

    success = returncode == 0

    # If first pass failed, return early
    if not success:
        log_json("process_pr", {
            "action": "complete",
            "pr_number": pr_number,
            "success": False,
            "reason": "initial_pass_failed"
        })

        # Send failure notification
        send_notification(
            f"PR #{pr_number} processing failed: {title}\nMode: {mode}\nReason: Initial pass failed",
            title=f"PR #{pr_number} - Failed",
            priority="high",
            tags=["x", "warning"]
        )

        return False

    # If mode is "for-review", run second pass for code review
    if mode == "for-review":
        log_json("process_pr", {
            "action": "review_pass_start",
            "pr_number": pr_number,
        })

        # Get fresh diff after first pass changes
        fresh_diff = get_pr_diff(pr_number)

        if not fresh_diff:
            log_json("process_pr", {
                "action": "review_pass_skip",
                "pr_number": pr_number,
                "reason": "no_diff_available"
            })
        else:
            # Build review prompt
            try:
                review_prompt = build_review_prompt(
                    pr_number=pr_number,
                    title=title,
                    head_branch=head_branch,
                    url=url,
                    diff=fresh_diff,
                    changed_files=pr_context.get("files", [])
                )
            except Exception as e:
                log_json("process_pr", {
                    "action": "review_prompt_error",
                    "pr_number": pr_number,
                    "error": str(e)
                })
                # Don't fail the whole process if review prompt fails
                review_prompt = None

            if review_prompt:
                log_json("process_pr", {
                    "action": "review_prompt_generated",
                    "pr_number": pr_number,
                    "prompt_size": len(review_prompt),
                })

                # Run bob with review prompt
                log_json("process_pr", {
                    "action": "running_bob_review",
                    "pr_number": pr_number,
                })

                review_returncode, review_stdout, review_stderr = run_command([
                    "bob",
                    "--json",
                    review_prompt,
                ], timeout=3600)  # 1 hour for review pass

                log_json("process_pr", {
                    "action": "bob_review_complete",
                    "pr_number": pr_number,
                    "returncode": review_returncode,
                    "stdout": review_stdout,
                    "stderr": review_stderr,
                })

                review_success = review_returncode == 0
                log_json("process_pr", {
                    "action": "review_pass_complete",
                    "pr_number": pr_number,
                    "success": review_success,
                })

                # Send notification about review pass
                if review_success:
                    send_notification(
                        f"PR #{pr_number} code review completed: {title}\nReview pass finished successfully",
                        title=f"PR #{pr_number} - Review Complete",
                        tags=["white_check_mark", "mag"]
                    )
                else:
                    send_notification(
                        f"PR #{pr_number} code review failed: {title}\nReview pass encountered errors",
                        title=f"PR #{pr_number} - Review Failed",
                        priority="high",
                        tags=["x", "mag"]
                    )

    log_json("process_pr", {
        "action": "complete",
        "pr_number": pr_number,
        "success": success,
        "mode": mode,
    })

    # Send final success notification (only if initial pass succeeded)
    if success:
        send_notification(
            f"PR #{pr_number} processing completed: {title}\nMode: {mode}\nAll processing steps finished successfully",
            title=f"PR #{pr_number} - Complete",
            tags=["white_check_mark", "rocket"]
        )

    return success


def validate_repository(repo_path: Path) -> bool:
    """Validate that the path is a valid git repository"""
    if not repo_path.exists():
        log_json("validation_error", {
            "error": "Repository path does not exist",
            "path": str(repo_path)
        })
        return False

    if not repo_path.is_dir():
        log_json("validation_error", {
            "error": "Repository path is not a directory",
            "path": str(repo_path)
        })
        return False

    git_dir = repo_path / ".git"
    if not git_dir.exists():
        log_json("validation_error", {
            "error": "Not a git repository (no .git directory)",
            "path": str(repo_path)
        })
        return False

    # Test git command works in this directory
    returncode, stdout, stderr = run_command(["git", "status"], cwd=repo_path)
    if returncode != 0:
        log_json("validation_error", {
            "error": "Git command failed",
            "path": str(repo_path),
            "stderr": stderr
        })
        return False

    # Check if gh CLI is authenticated and works
    returncode, stdout, stderr = run_command(["gh", "auth", "status"])
    if returncode != 0:
        log_json("validation_error", {
            "error": "GitHub CLI not authenticated. Run 'gh auth login'",
            "stderr": stderr
        })
        return False

    log_json("validation", {
        "success": True,
        "path": str(repo_path)
    })
    return True


def parse_args() -> argparse.Namespace:
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="Automated PR processing loop using bob (Claude Code wrapper)",
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
        """
    )

    parser.add_argument(
        "repo_path",
        type=Path,
        help="Path to the git repository to process"
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

    log_json("startup", {
        "repo_path": str(repo_path),
        "cwd": str(Path.cwd()),
        "python_version": sys.version,
    })

    # Detect default branch
    default_branch = detect_default_branch()
    log_json("startup", {
        "default_branch": default_branch
    })

    # Get guidelines and commit examples once at startup
    guidelines = get_pr_guidelines()
    commit_examples = get_commit_history_examples(default_branch) if not guidelines else ""

    log_json("startup", {
        "has_guidelines": bool(guidelines),
        "has_commit_examples": bool(commit_examples),
    })

    iteration = 0
    processing_prs = set()  # Track PRs being processed to avoid duplicates

    while True:
        iteration += 1
        log_json("iteration", {"number": iteration, "action": "start"})

        # Sync repository
        if not sync_repo(default_branch):
            log_json("iteration", {
                "number": iteration,
                "action": "sync_failed",
                "sleep_seconds": 60,
            })
            time.sleep(60)
            continue

        # Get open PRs categorized by labels
        categorized_prs = get_open_prs()

        # Count total processable PRs (excluding untagged)
        total_processable = len(categorized_prs["for-review"]) + len(categorized_prs["for-landing"])

        if total_processable == 0:
            log_json("iteration", {
                "number": iteration,
                "action": "no_processable_prs",
                "untagged_count": len(categorized_prs["untagged"]),
                "sleep_seconds": 300,
            })
            # Clear processing set when no PRs
            processing_prs.clear()
            time.sleep(300)  # Wait 5 minutes if no PRs
            continue

        # Log categorization results
        log_json("iteration", {
            "number": iteration,
            "action": "prs_categorized",
            "for_review": len(categorized_prs["for-review"]),
            "for_landing": len(categorized_prs["for-landing"]),
            "untagged": len(categorized_prs["untagged"]),
        })

        # Process PRs by mode
        total_processed = 0
        for mode in ["for-review", "for-landing"]:
            for pr in categorized_prs[mode]:
                pr_number = pr.get("number")

                # Skip if already being processed in this iteration
                if pr_number and pr_number in processing_prs:
                    log_json("process_pr", {
                        "action": "skip_duplicate",
                        "pr_number": pr_number,
                        "mode": mode
                    })
                    continue

                if pr_number:
                    processing_prs.add(pr_number)

                try:
                    success = process_pr(pr, guidelines, commit_examples, default_branch, mode)
                    if success and pr_number:
                        # Remove from processing set after successful completion
                        processing_prs.discard(pr_number)
                    total_processed += 1
                except KeyboardInterrupt:
                    log_json("shutdown", {"reason": "keyboard_interrupt"})
                    sys.exit(0)
                except Exception as e:
                    log_json("process_pr", {
                        "action": "exception",
                        "pr_number": pr_number,
                        "mode": mode,
                        "error": str(e),
                    })
                    # Remove from processing set on exception
                    if pr_number:
                        processing_prs.discard(pr_number)

                # Small delay between PRs
                time.sleep(10)

        log_json("iteration", {
            "number": iteration,
            "action": "complete",
            "prs_processed": total_processed,
            "sleep_seconds": 300,
        })

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
