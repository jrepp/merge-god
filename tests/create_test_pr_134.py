#!/usr/bin/env python3
"""Create test data for PR #134"""

from db_operations import StateDatabase
from datetime import datetime, timezone

# Initialize database
db = StateDatabase("merge-god-state.db")

# Create realistic test data for PR #134
pr_details = {
    "number": 134,
    "title": "Add process isolation for testing and debugging",
    "body": """This PR implements 3-process isolation to enable independent testing of:
1. PR/branch scanning and state caching
2. Context preparation and data marshaling
3. Agent invocation

This allows debugging failures without full GitHub/git access.""",
    "headRefName": "feature/process-isolation",
    "baseRefName": "main",
    "author": {"login": "test-user"},
    "labels": ["for-landing", "enhancement"],
    "reviewDecision": "APPROVED"
}

pr_context = {
    "url": "https://github.com/test/merge-god/pull/134",
    "diff": (
        "--- a/db_operations.py\n"
        "+++ b/db_operations.py\n"
        "@@ -139,6 +139,20 @@ class StateDatabase:\n"
        "                 )\n"
        "             \"\"\")\n"
        " \n"
        "+            # PR context table\n"
        "+            cursor.execute('''\n"
        "+                CREATE TABLE IF NOT EXISTS pr_context (\n"
        "+                    id INTEGER PRIMARY KEY AUTOINCREMENT,\n"
        "+                    repo_name TEXT NOT NULL,\n"
        "+                    pr_number INTEGER NOT NULL,\n"
        "+                    diff TEXT\n"
        "+                )\n"
        "+            ''')\n"
        "+\n"
        "             # Create indexes for performance\n"
    ),
    "comments": [
        {
            "user": {"login": "reviewer1"},
            "body": "Great work on the isolation! This will make debugging much easier."
        }
    ],
    "review_comments": [
        {
            "user": {"login": "reviewer2"},
            "body": "Consider adding size limits for the diff field to prevent database bloat.",
            "path": "db_operations.py",
            "line": 150
        }
    ],
    "commits": [
        {
            "sha": "abc123def456",
            "commit": {
                "message": "Add pr_context table for agent isolation"
            }
        },
        {
            "sha": "def456ghi789",
            "commit": {
                "message": "Create standalone agent runner script"
            }
        }
    ],
    "files": [
        {
            "filename": "db_operations.py",
            "additions": 150,
            "deletions": 10,
            "status": "modified"
        },
        {
            "filename": "run_agent_from_db.py",
            "additions": 250,
            "deletions": 0,
            "status": "added"
        },
        {
            "filename": "test_process_isolation.py",
            "additions": 400,
            "deletions": 0,
            "status": "added"
        }
    ],
    "conflicts": {
        "has_conflicts": False,
        "conflicting_files": [],
        "conflict_count": 0
    },
    "ci_status": {
        "total_checks": 3,
        "passed": 3,
        "failed": 0,
        "pending": 0,
        "failed_checks": []
    },
    "guidelines": "Follow PEP 8 style guide. Add docstrings to all public methods.",
    "commit_examples": "feat: add new feature\nfix: resolve bug\ntest: add test coverage"
}

# Save to database
print("Creating test data for PR #134...")
db.save_pr_context("merge-god", 134, pr_details, pr_context)

# Also save PR snapshot
pr_snapshot = {
    "number": 134,
    "title": pr_details["title"],
    "state": "open",
    "head_branch": "feature/process-isolation",
    "base_branch": "main",
    "author": "test-user",
    "draft": False,
    "ci_status": "success",
    "labels": ["for-landing", "enhancement"],
    "created_at": datetime.now(timezone.utc),
    "updated_at": datetime.now(timezone.utc)
}
db.save_pr_snapshot("merge-god", pr_snapshot)

print("✓ Test data created successfully!")
print(f"  PR #134: {pr_details['title']}")
print(f"  Files changed: {len(pr_context['files'])}")
print(f"  Diff size: {len(pr_context['diff'])} bytes")
print(f"  Comments: {len(pr_context['comments'])}")
print(f"  Review comments: {len(pr_context['review_comments'])}")
