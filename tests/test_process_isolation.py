#!/usr/bin/env python3
"""
Isolation tests for the 3 distinct processes in merge-god.

This test suite validates that each process can run independently and
produces the correct data for the next process:

Process 1: PR/branch scanning and state cache management
  - Input: Repository path, GitHub credentials
  - Output: Database with PR snapshots, branch states, PR context

Process 2: Context preparation and data marshaling
  - Input: Database with PR context
  - Output: PRContext objects ready for agent invocation

Process 3: Agent invocation
  - Input: PRContext objects
  - Output: Agent actions, results, processing history

Each test validates both the process in isolation and the boundary
between processes (data format compatibility).
"""

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from db_operations import StateDatabase
from models import RepositoryState, BranchPRState, PullRequest, PRState, CIStatus, Branch, BranchStatus
from state_tracker import StateTracker
from agents import PRContext


class TestProcess1Isolation:
    """
    Test Process 1: PR/branch scanning and state cache management

    This process should:
    1. Fetch PRs and branches from GitHub/git
    2. Store them in SQLite database
    3. Create RepositoryState snapshots
    4. Store full PR context for agent invocation
    """

    @pytest.fixture
    def temp_db(self):
        """Create temporary database for testing"""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = Path(f.name)

        yield db_path

        # Cleanup
        if db_path.exists():
            db_path.unlink()

    def test_process1_creates_database_schema(self, temp_db):
        """Test that Process 1 creates the correct database schema"""
        db = StateDatabase(temp_db)

        # Verify all tables exist
        with sqlite3.connect(temp_db) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table'
                ORDER BY name
            """)
            tables = [row[0] for row in cursor.fetchall()]

        expected_tables = [
            'repositories',
            'pull_requests',
            'processing_history',
            'dashboard_state',
            'branch_states',
            'pr_context'  # Critical for Process 2/3 isolation
        ]

        for table in expected_tables:
            assert table in tables, f"Missing table: {table}"

    def test_process1_saves_pr_snapshot(self, temp_db):
        """Test that Process 1 correctly saves PR snapshots"""
        db = StateDatabase(temp_db)
        repo_name = "test-repo"

        # Mock PR data from GitHub API
        pr_data = {
            "number": 123,
            "title": "Test PR",
            "state": "open",
            "head_branch": "feature/test",
            "base_branch": "main",
            "author": "test-user",
            "draft": False,
            "ci_status": "success",
            "labels": ["for-landing"],
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }

        # Save PR snapshot (Process 1 output)
        db.save_pr_snapshot(repo_name, pr_data)

        # Verify data can be retrieved
        retrieved = db.get_latest_pr_snapshot(repo_name, 123)
        assert retrieved is not None
        assert retrieved["pr_number"] == 123
        assert retrieved["title"] == "Test PR"
        assert retrieved["head_branch"] == "feature/test"
        assert "for-landing" in retrieved["labels"]

    def test_process1_saves_full_pr_context(self, temp_db):
        """Test that Process 1 saves complete PR context for agent invocation"""
        db = StateDatabase(temp_db)
        repo_name = "test-repo"
        pr_number = 123

        # Mock complete PR context (what Process 2/3 needs)
        pr_details = {
            "number": pr_number,
            "title": "Test PR",
            "body": "This is a test PR",
            "headRefName": "feature/test",
            "baseRefName": "main",
            "author": {"login": "test-user"},
            "labels": ["for-landing"],
            "reviewDecision": "APPROVED"
        }

        pr_context = {
            "url": "https://github.com/test/repo/pull/123",
            "diff": "--- a/file.py\n+++ b/file.py\n@@ -1,3 +1,3 @@\n-old line\n+new line",
            "comments": [
                {"user": {"login": "reviewer"}, "body": "Looks good"}
            ],
            "review_comments": [
                {
                    "user": {"login": "reviewer"},
                    "body": "Consider optimizing this",
                    "path": "file.py",
                    "line": 10
                }
            ],
            "commits": [
                {"sha": "abc123", "commit": {"message": "Initial commit"}}
            ],
            "files": [
                {"filename": "file.py", "additions": 10, "deletions": 5, "status": "modified"}
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
            "guidelines": "Follow PEP 8",
            "commit_examples": "feat: add feature\nfix: fix bug"
        }

        # Save full PR context (Process 1 output)
        db.save_pr_context(repo_name, pr_number, pr_details, pr_context)

        # Verify context can be retrieved for Process 2/3
        retrieved = db.get_latest_pr_context(repo_name, pr_number)
        assert retrieved is not None
        assert retrieved["diff"] != ""
        assert len(retrieved["comments"]) == 1
        assert len(retrieved["review_comments"]) == 1
        assert len(retrieved["commits"]) == 1
        assert len(retrieved["files"]) == 1
        assert retrieved["conflicts"]["has_conflicts"] is False
        assert retrieved["ci_checks"]["total_checks"] == 3


class TestProcess2Isolation:
    """
    Test Process 2: Context preparation and data marshaling

    This process should:
    1. Read PR context from database
    2. Transform it into PRContext objects
    3. Prepare data for agent invocation
    4. Validate data completeness
    """

    @pytest.fixture
    def populated_db(self):
        """Create database with test data"""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = Path(f.name)

        db = StateDatabase(db_path)
        repo_name = "test-repo"

        # Populate with test data (simulating Process 1 output)
        pr_details = {
            "number": 123,
            "title": "Test PR",
            "body": "Test body",
            "headRefName": "feature/test",
            "baseRefName": "main",
            "author": {"login": "test-user"},
            "labels": ["for-landing"],
            "reviewDecision": None
        }

        pr_context = {
            "url": "https://github.com/test/repo/pull/123",
            "diff": "test diff",
            "comments": [],
            "review_comments": [],
            "commits": [],
            "files": [],
            "conflicts": {"has_conflicts": False, "conflicting_files": []},
            "ci_status": {"total_checks": 0, "passed": 0, "failed": 0, "pending": 0},
            "guidelines": "Test guidelines",
            "commit_examples": "Test examples"
        }

        db.save_pr_context(repo_name, 123, pr_details, pr_context)

        # Also save PR snapshot
        pr_data = {
            "number": 123,
            "title": "Test PR",
            "state": "open",
            "head_branch": "feature/test",
            "base_branch": "main",
            "author": "test-user",
            "draft": False,
            "ci_status": "none",
            "labels": ["for-landing"],
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        db.save_pr_snapshot(repo_name, pr_data)

        yield db_path, db, repo_name

        # Cleanup
        if db_path.exists():
            db_path.unlink()

    def test_process2_loads_pr_context_from_db(self, populated_db):
        """Test that Process 2 can load PR context from database"""
        db_path, db, repo_name = populated_db

        # Process 2: Load context from database
        result = db.get_pr_context_for_agent(repo_name, 123)

        assert result is not None
        pr_details, pr_context = result

        # Verify structure matches what gather_pr_context() returns
        assert "number" in pr_details
        assert "title" in pr_details
        assert "headRefName" in pr_details
        assert "baseRefName" in pr_details

        assert "url" in pr_context
        assert "diff" in pr_context
        assert "comments" in pr_context
        assert "review_comments" in pr_context
        assert "conflicts" in pr_context
        assert "ci_status" in pr_context

    def test_process2_creates_pr_context_object(self, populated_db):
        """Test that Process 2 creates valid PRContext objects for Process 3"""
        db_path, db, repo_name = populated_db

        # Process 2: Load and transform data
        result = db.get_pr_context_for_agent(repo_name, 123)
        assert result is not None

        pr_details, pr_context_dict = result

        # Create PRContext (Process 2 output -> Process 3 input)
        pr_context = PRContext.from_dict(pr_details, pr_context_dict)

        # Verify PRContext has all required fields
        assert pr_context.pr_number == 123
        assert pr_context.title == "Test PR"
        assert pr_context.head_branch == "feature/test"
        assert pr_context.base_branch == "main"
        assert pr_context.author == "test-user"
        assert pr_context.has_conflicts is False
        assert isinstance(pr_context.has_failing_ci, bool)
        assert isinstance(pr_context.diff, str)
        assert isinstance(pr_context.guidelines, str)

    def test_process2_validates_missing_data(self, populated_db):
        """Test that Process 2 handles missing data gracefully"""
        db_path, db, repo_name = populated_db

        # Try to load non-existent PR
        result = db.get_pr_context_for_agent(repo_name, 999)

        assert result is None  # Should return None, not crash


class TestProcess3Isolation:
    """
    Test Process 3: Agent invocation

    This process should:
    1. Accept PRContext objects
    2. Invoke agent with proper tools
    3. Handle streaming responses
    4. Produce actions and results
    5. Work without GitHub/git access (using mocked tools)
    """

    def test_process3_accepts_pr_context(self):
        """Test that Process 3 can accept PRContext from Process 2"""
        # Create PRContext (Process 2 output)
        pr_context = PRContext(
            pr_number=123,
            title="Test PR",
            body="Test body",
            head_branch="feature/test",
            base_branch="main",
            author="test-user",
            url="https://github.com/test/repo/pull/123",
            has_conflicts=False,
            conflicting_files=[],
            has_failing_ci=False,
            failing_checks=[],
            review_comments=[],
            general_comments=[],
            changed_files=[],
            diff="test diff",
            commits=[],
            guidelines="Test guidelines",
            commit_examples="Test examples",
            labels=["for-landing"],
            ci_checks={},
            review_decision=None
        )

        # Verify PRContext is valid for Process 3
        assert pr_context.pr_number == 123
        assert pr_context.title == "Test PR"

        # This is what Process 3 receives - validate structure
        assert hasattr(pr_context, 'pr_number')
        assert hasattr(pr_context, 'diff')
        assert hasattr(pr_context, 'has_conflicts')
        assert hasattr(pr_context, 'has_failing_ci')
        assert hasattr(pr_context, 'review_comments')

    def test_process3_task_decomposition(self):
        """Test that Process 3 correctly decomposes PR into tasks"""
        from agents.claude_agent import PRAgent
        from unittest.mock import MagicMock

        # Create mock client
        mock_client = MagicMock()
        agent = PRAgent(client=mock_client, model="test-model")

        # Create test PR context with various issues
        pr_context = PRContext(
            pr_number=123,
            title="Test PR",
            body="Test body",
            head_branch="feature/test",
            base_branch="main",
            author="test-user",
            url="https://github.com/test/repo/pull/123",
            has_conflicts=True,
            conflicting_files=["file1.py", "file2.py"],
            has_failing_ci=True,
            failing_checks=[{"name": "test", "conclusion": "FAILURE"}],
            review_comments=[{"user": {"login": "reviewer"}, "body": "Fix this"}],
            general_comments=[],
            changed_files=[],
            diff="test diff",
            commits=[],
            guidelines="Test guidelines",
            commit_examples="Test examples",
            labels=["for-review"],
            ci_checks={"failed": 1},
            review_decision=None
        )

        # Test task decomposition (Process 3 internal logic)
        tasks = agent._decompose_pr_tasks(pr_context, mode="for-review")

        # Verify tasks are created for all issues
        task_ids = [task.id for task in tasks]
        assert "analyze" in task_ids  # Always first
        assert "resolve_conflicts" in task_ids  # Has conflicts
        assert "address_reviews" in task_ids  # Has review comments
        assert "fix_ci" in task_ids  # Has failing CI
        assert "code_review" in task_ids  # for-review mode
        assert "validate" in task_ids  # Always last


class TestProcessBoundaryValidation:
    """
    Test data flow and compatibility between process boundaries
    """

    @pytest.fixture
    def full_pipeline_db(self):
        """Create database and simulate full pipeline"""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = Path(f.name)

        yield db_path

        if db_path.exists():
            db_path.unlink()

    def test_boundary_process1_to_process2(self, full_pipeline_db):
        """Test data flows correctly from Process 1 to Process 2"""
        db = StateDatabase(full_pipeline_db)
        repo_name = "test-repo"

        # PROCESS 1: Save PR context
        pr_details_p1 = {
            "number": 123,
            "title": "Test PR",
            "body": "Test body",
            "headRefName": "feature/test",
            "baseRefName": "main",
            "author": {"login": "test-user"},
            "labels": ["for-landing"],
            "reviewDecision": "APPROVED"
        }

        pr_context_p1 = {
            "url": "https://github.com/test/repo/pull/123",
            "diff": "test diff content",
            "comments": [{"user": {"login": "u1"}, "body": "comment1"}],
            "review_comments": [{"user": {"login": "u2"}, "body": "review1"}],
            "commits": [{"sha": "abc", "commit": {"message": "msg"}}],
            "files": [{"filename": "test.py", "additions": 1}],
            "conflicts": {"has_conflicts": True, "conflicting_files": ["test.py"]},
            "ci_status": {"total_checks": 2, "passed": 1, "failed": 1},
            "guidelines": "Follow style guide",
            "commit_examples": "fix: bug"
        }

        db.save_pr_context(repo_name, 123, pr_details_p1, pr_context_p1)

        # Also save snapshot
        pr_data = {
            "number": 123,
            "title": "Test PR",
            "state": "open",
            "head_branch": "feature/test",
            "base_branch": "main",
            "author": "test-user",
            "labels": ["for-landing"],
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        db.save_pr_snapshot(repo_name, pr_data)

        # PROCESS 2: Load and transform
        result = db.get_pr_context_for_agent(repo_name, 123)
        assert result is not None

        pr_details_p2, pr_context_p2 = result

        # VALIDATE BOUNDARY: All Process 1 data is accessible in Process 2
        assert pr_details_p2["number"] == pr_details_p1["number"]
        assert pr_details_p2["title"] == pr_details_p1["title"]
        assert pr_context_p2["diff"] == pr_context_p1["diff"]
        assert len(pr_context_p2["comments"]) == len(pr_context_p1["comments"])
        assert len(pr_context_p2["review_comments"]) == len(pr_context_p1["review_comments"])
        assert pr_context_p2["conflicts"]["has_conflicts"] == pr_context_p1["conflicts"]["has_conflicts"]
        assert pr_context_p2["guidelines"] == pr_context_p1["guidelines"]

    def test_boundary_process2_to_process3(self, full_pipeline_db):
        """Test data flows correctly from Process 2 to Process 3"""
        db = StateDatabase(full_pipeline_db)
        repo_name = "test-repo"

        # Setup Process 1 data
        pr_details = {
            "number": 456,
            "title": "Another PR",
            "body": "Test body",
            "headRefName": "feature/another",
            "baseRefName": "main",
            "author": {"login": "user"},
            "labels": ["for-review"],
            "reviewDecision": None
        }

        pr_context = {
            "url": "https://github.com/test/repo/pull/456",
            "diff": "diff content",
            "comments": [],
            "review_comments": [],
            "commits": [],
            "files": [],
            "conflicts": {"has_conflicts": False, "conflicting_files": []},
            "ci_status": {"total_checks": 1, "passed": 1, "failed": 0, "pending": 0},
            "guidelines": "Test",
            "commit_examples": "Test"
        }

        db.save_pr_context(repo_name, 456, pr_details, pr_context)

        pr_data = {
            "number": 456,
            "title": "Another PR",
            "state": "open",
            "head_branch": "feature/another",
            "base_branch": "main",
            "author": "user",
            "labels": ["for-review"],
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        db.save_pr_snapshot(repo_name, pr_data)

        # PROCESS 2: Load and create PRContext
        result = db.get_pr_context_for_agent(repo_name, 456)
        assert result is not None

        pr_details_p2, pr_context_p2 = result
        pr_context_obj = PRContext.from_dict(pr_details_p2, pr_context_p2)

        # VALIDATE BOUNDARY: PRContext has all data Process 3 needs
        assert pr_context_obj.pr_number == 456
        assert pr_context_obj.title == "Another PR"
        assert pr_context_obj.diff != ""
        assert pr_context_obj.has_conflicts is False
        assert pr_context_obj.has_failing_ci is False
        assert isinstance(pr_context_obj.guidelines, str)
        assert isinstance(pr_context_obj.commit_examples, str)

        # Process 3 should be able to work with this object
        assert hasattr(pr_context_obj, 'pr_number')
        assert hasattr(pr_context_obj, 'head_branch')
        assert hasattr(pr_context_obj, 'base_branch')
        assert hasattr(pr_context_obj, 'author')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
