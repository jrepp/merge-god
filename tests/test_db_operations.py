"""
Unit tests for database operations module.

Tests all CRUD operations, state persistence, and recovery scenarios.
"""

import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

from db_operations import StateDatabase, DatabaseError
from models import (
    RepositoryState, BranchPRState, PullRequest, Branch, CIStatus,
    PRState, BranchStatus, CICheck
)


class TestStateDatabase(unittest.TestCase):
    """Test cases for StateDatabase class"""

    def setUp(self):
        """Create temporary database for each test"""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        self.db = StateDatabase(self.db_path)

    def tearDown(self):
        """Clean up temporary database"""
        if self.db_path.exists():
            self.db_path.unlink()

    def test_database_initialization(self):
        """Test that database schema is created correctly"""
        self.assertTrue(self.db_path.exists())

        # Verify all tables exist
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table'
                ORDER BY name
            """)
            tables = [row[0] for row in cursor.fetchall()]

            expected_tables = [
                'branch_states',
                'dashboard_state',
                'processing_history',
                'pull_requests',
                'repositories'
            ]
            for table in expected_tables:
                self.assertIn(table, tables)

    def test_save_and_get_repository(self):
        """Test saving and retrieving repository metadata"""
        self.db.save_repository(
            name="test-repo",
            path="/path/to/repo",
            default_branch="main"
        )

        repo = self.db.get_repository("test-repo")
        self.assertIsNotNone(repo)
        self.assertEqual(repo["name"], "test-repo")
        self.assertEqual(repo["path"], "/path/to/repo")
        self.assertEqual(repo["default_branch"], "main")

    def test_update_repository(self):
        """Test updating existing repository"""
        self.db.save_repository("test-repo", "/old/path", "master")
        self.db.save_repository("test-repo", "/new/path", "main")

        repo = self.db.get_repository("test-repo")
        self.assertEqual(repo["path"], "/new/path")
        self.assertEqual(repo["default_branch"], "main")

    def test_save_pr_snapshot(self):
        """Test saving PR snapshot"""
        pr_data = {
            "number": 123,
            "title": "Test PR",
            "state": "open",
            "head_branch": "feature-branch",
            "base_branch": "main",
            "author": "testuser",
            "draft": False,
            "ci_status": "success",
            "labels": ["for-review", "bug"],
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }

        self.db.save_pr_snapshot("test-repo", pr_data)

        # Retrieve and verify
        retrieved = self.db.get_latest_pr_snapshot("test-repo", 123)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["pr_number"], 123)
        self.assertEqual(retrieved["title"], "Test PR")
        self.assertEqual(retrieved["labels"], ["for-review", "bug"])

    def test_multiple_pr_snapshots(self):
        """Test that multiple snapshots are saved and latest is retrieved"""
        pr_data = {
            "number": 123,
            "title": "Test PR v1",
            "state": "open",
            "head_branch": "feature",
            "base_branch": "main",
            "ci_status": "pending"
        }

        # Save first snapshot
        self.db.save_pr_snapshot("test-repo", pr_data)

        # Update and save second snapshot
        pr_data["title"] = "Test PR v2"
        pr_data["ci_status"] = "success"
        self.db.save_pr_snapshot("test-repo", pr_data)

        # Should get latest
        latest = self.db.get_latest_pr_snapshot("test-repo", 123)
        self.assertEqual(latest["title"], "Test PR v2")
        self.assertEqual(latest["ci_status"], "success")

    def test_get_active_prs(self):
        """Test retrieving all active PRs for a repository"""
        # Save multiple PRs
        for i in range(1, 4):
            pr_data = {
                "number": i,
                "title": f"PR {i}",
                "state": "open",
                "head_branch": f"feature-{i}",
                "base_branch": "main",
                "ci_status": "success"
            }
            self.db.save_pr_snapshot("test-repo", pr_data)

        # Add a closed PR
        pr_data = {
            "number": 4,
            "title": "PR 4",
            "state": "closed",
            "head_branch": "feature-4",
            "base_branch": "main"
        }
        self.db.save_pr_snapshot("test-repo", pr_data)

        # Get active PRs
        active_prs = self.db.get_active_prs("test-repo")
        self.assertEqual(len(active_prs), 3)
        self.assertEqual(active_prs[0]["pr_number"], 1)
        self.assertEqual(active_prs[2]["pr_number"], 3)

    def test_processing_history(self):
        """Test recording and retrieving processing history"""
        # Start processing
        record_id = self.db.record_processing_start(
            repo_name="test-repo",
            pr_number=123,
            action_type="review",
            metadata={"mode": "for-review", "commit": "abc123"}
        )

        self.assertIsNotNone(record_id)
        self.assertGreater(record_id, 0)

        # Complete processing
        self.db.record_processing_complete(
            record_id=record_id,
            success=True,
            error_message=None
        )

        # Retrieve history
        history = self.db.get_processing_history("test-repo", pr_number=123)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["pr_number"], 123)
        self.assertEqual(history[0]["action_type"], "review")
        self.assertEqual(history[0]["success"], 1)
        self.assertIsNotNone(history[0]["completed_at"])
        self.assertIsNotNone(history[0]["duration_seconds"])
        self.assertEqual(history[0]["metadata"]["mode"], "for-review")

    def test_processing_failure(self):
        """Test recording processing failure"""
        record_id = self.db.record_processing_start(
            repo_name="test-repo",
            pr_number=456,
            action_type="landing"
        )

        self.db.record_processing_complete(
            record_id=record_id,
            success=False,
            error_message="CI checks failed"
        )

        history = self.db.get_processing_history("test-repo", pr_number=456)
        self.assertEqual(history[0]["success"], 0)
        self.assertEqual(history[0]["error_message"], "CI checks failed")

    def test_processing_history_limit(self):
        """Test that processing history respects limit parameter"""
        # Create 15 processing records
        for i in range(15):
            record_id = self.db.record_processing_start(
                repo_name="test-repo",
                pr_number=i,
                action_type="review"
            )
            self.db.record_processing_complete(record_id, success=True)

        # Get with limit
        history = self.db.get_processing_history("test-repo", limit=10)
        self.assertEqual(len(history), 10)

        # Verify most recent first
        self.assertEqual(history[0]["pr_number"], 14)

    def test_dashboard_state_save_and_get(self):
        """Test saving and retrieving dashboard state"""
        stats = {
            "prs_processed": 10,
            "successes": 8,
            "failures": 2,
            "iteration": 5
        }

        state_data = {
            "pr_queue": {"for_review": [1, 2], "for_landing": [3]},
            "last_error": None
        }

        self.db.save_dashboard_state(
            repo_name="test-repo",
            status="running",
            stats=stats,
            current_pr_number=123,
            state_data=state_data
        )

        # Retrieve state
        state = self.db.get_dashboard_state("test-repo")
        self.assertIsNotNone(state)
        self.assertEqual(state["status"], "running")
        self.assertEqual(state["prs_processed"], 10)
        self.assertEqual(state["successes"], 8)
        self.assertEqual(state["current_pr_number"], 123)
        self.assertEqual(state["state_data"]["pr_queue"]["for_review"], [1, 2])

    def test_dashboard_state_update(self):
        """Test updating existing dashboard state"""
        stats1 = {"prs_processed": 5, "successes": 5, "failures": 0, "iteration": 1}
        self.db.save_dashboard_state("test-repo", "running", stats1)

        stats2 = {"prs_processed": 10, "successes": 9, "failures": 1, "iteration": 2}
        self.db.save_dashboard_state("test-repo", "idle", stats2)

        state = self.db.get_dashboard_state("test-repo")
        self.assertEqual(state["status"], "idle")
        self.assertEqual(state["prs_processed"], 10)
        self.assertEqual(state["successes"], 9)

    def test_save_repository_state(self):
        """Test saving complete repository state"""
        # Create mock repository state
        repo_state = RepositoryState(
            repo_path="/path/to/repo",
            default_branch="main"
        )

        # Add branch with PR
        pr = PullRequest(
            number=123,
            title="Test PR",
            state=PRState.OPEN,
            head_branch="feature-branch",
            base_branch="main",
            author="testuser",
            url="https://github.com/test/repo/pull/123",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            labels=["for-review"],
            ci_checks=[
                CICheck(name="test", status=CIStatus.SUCCESS)
            ]
        )

        local_branch = Branch(
            name="feature-branch",
            sha="abc123",
            is_local=True,
            is_remote=True,
            status=BranchStatus.UP_TO_DATE,
            ahead_by=0,
            behind_by=0
        )

        branch_state = BranchPRState(
            branch_name="feature-branch",
            local_branch=local_branch,
            remote_branch=local_branch,
            pr=pr
        )

        repo_state.add_state(branch_state)

        # Save to database
        self.db.save_repository_state("test-repo", repo_state)

        # Verify repository saved
        repo = self.db.get_repository("test-repo")
        self.assertIsNotNone(repo)
        self.assertEqual(repo["default_branch"], "main")

        # Verify PR saved
        pr_snapshot = self.db.get_latest_pr_snapshot("test-repo", 123)
        self.assertIsNotNone(pr_snapshot)
        self.assertEqual(pr_snapshot["title"], "Test PR")

        # Verify branch state saved
        summary = self.db.get_repository_state_summary("test-repo")
        self.assertIsNotNone(summary)
        self.assertEqual(summary["total_branches"], 1)
        self.assertEqual(summary["branches_with_prs"], 1)

    def test_repository_state_summary(self):
        """Test getting repository state summary"""
        # Create repository with multiple branches
        repo_state = RepositoryState(
            repo_path="/path/to/repo",
            default_branch="main"
        )

        # Add branches with different states
        for i in range(3):
            has_pr = i < 2  # First 2 have PRs
            pr = None
            if has_pr:
                pr = PullRequest(
                    number=i + 1,
                    title=f"PR {i+1}",
                    state=PRState.OPEN,
                    head_branch=f"branch-{i}",
                    base_branch="main",
                    author="testuser",
                    url=f"https://github.com/test/repo/pull/{i+1}",
                    created_at=datetime.now(timezone.utc),
                    updated_at=datetime.now(timezone.utc),
                    ci_checks=[
                        CICheck(
                            name="test",
                            status=CIStatus.FAILURE if i == 0 else CIStatus.SUCCESS
                        )
                    ]
                )

            branch = Branch(
                name=f"branch-{i}",
                sha=f"sha{i}",
                is_local=True,
                is_remote=True,
                status=BranchStatus.AHEAD if i == 2 else BranchStatus.UP_TO_DATE,
                ahead_by=1 if i == 2 else 0,
                behind_by=0
            )

            branch_state = BranchPRState(
                branch_name=f"branch-{i}",
                local_branch=branch,
                remote_branch=branch,
                pr=pr
            )

            repo_state.add_state(branch_state)

        # Save state
        self.db.save_repository_state("test-repo", repo_state)

        # Get summary
        summary = self.db.get_repository_state_summary("test-repo")
        self.assertIsNotNone(summary)
        self.assertEqual(summary["total_branches"], 3)
        self.assertEqual(summary["branches_with_prs"], 2)
        self.assertEqual(summary["branches_needing_sync"], 1)
        self.assertEqual(summary["failing_ci"], 1)

    def test_cleanup_old_snapshots(self):
        """Test cleaning up old snapshots"""
        # Create old snapshots
        old_time = datetime.now(timezone.utc) - timedelta(days=10)

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()

            # Insert old PR snapshot
            cursor.execute("""
                INSERT INTO pull_requests (
                    repo_name, pr_number, title, state,
                    head_branch, base_branch, snapshot_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, ("test-repo", 1, "Old PR", "open", "feature", "main", old_time))

            # Insert old branch state
            cursor.execute("""
                INSERT INTO branch_states (
                    repo_name, branch_name, is_local, is_remote, snapshot_time
                ) VALUES (?, ?, ?, ?, ?)
            """, ("test-repo", "old-branch", 1, 1, old_time))

            conn.commit()

        # Add recent snapshots
        pr_data = {
            "number": 2,
            "title": "Recent PR",
            "state": "open",
            "head_branch": "new-feature",
            "base_branch": "main"
        }
        self.db.save_pr_snapshot("test-repo", pr_data)

        # Cleanup old snapshots
        deleted = self.db.cleanup_old_snapshots(days=7)
        self.assertGreater(deleted, 0)

        # Verify recent snapshots remain
        recent_prs = self.db.get_active_prs("test-repo")
        self.assertEqual(len(recent_prs), 1)
        self.assertEqual(recent_prs[0]["pr_number"], 2)

    def test_get_statistics(self):
        """Test getting overall database statistics"""
        # Add some data
        self.db.save_repository("test-repo", "/path/to/repo", "main")

        pr_data = {
            "number": 1,
            "title": "Test PR",
            "state": "open",
            "head_branch": "feature",
            "base_branch": "main"
        }
        self.db.save_pr_snapshot("test-repo", pr_data)

        record_id = self.db.record_processing_start("test-repo", 1, "review")
        self.db.record_processing_complete(record_id, success=True)

        # Get statistics
        stats = self.db.get_statistics()
        self.assertEqual(stats["repositories"], 1)
        self.assertEqual(stats["pr_snapshots"], 1)
        self.assertEqual(stats["processing_records"], 1)
        self.assertEqual(stats["success_rate"], 100.0)
        self.assertGreater(stats["database_size_bytes"], 0)

    def test_database_error_handling(self):
        """Test that database errors are properly handled"""
        # Try to get non-existent repository
        repo = self.db.get_repository("nonexistent")
        self.assertIsNone(repo)

        # Try to get non-existent PR
        pr = self.db.get_latest_pr_snapshot("nonexistent", 999)
        self.assertIsNone(pr)

    def test_concurrent_snapshots(self):
        """Test handling multiple snapshots for same PR"""
        # Save multiple snapshots with different CI statuses
        for status in ["pending", "success", "failure"]:
            pr_data = {
                "number": 123,
                "title": "Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "ci_status": status
            }
            self.db.save_pr_snapshot("test-repo", pr_data)

        # Latest should be 'failure'
        latest = self.db.get_latest_pr_snapshot("test-repo", 123)
        self.assertEqual(latest["ci_status"], "failure")

    def test_null_values_handling(self):
        """Test handling of null/optional values"""
        pr_data = {
            "number": 123,
            "title": "Minimal PR",
            "state": "open",
            "head_branch": "feature",
            "base_branch": "main"
            # No author, draft, ci_status, labels
        }

        self.db.save_pr_snapshot("test-repo", pr_data)

        retrieved = self.db.get_latest_pr_snapshot("test-repo", 123)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["pr_number"], 123)
        self.assertEqual(retrieved["labels"], [])

    def test_json_serialization(self):
        """Test that complex data structures are properly serialized"""
        metadata = {
            "commits": ["abc123", "def456"],
            "reviewers": ["user1", "user2"],
            "nested": {"key": "value", "list": [1, 2, 3]}
        }

        record_id = self.db.record_processing_start(
            repo_name="test-repo",
            pr_number=123,
            action_type="review",
            metadata=metadata
        )
        self.db.record_processing_complete(record_id, success=True)

        history = self.db.get_processing_history("test-repo", pr_number=123)
        self.assertEqual(history[0]["metadata"]["commits"], ["abc123", "def456"])
        self.assertEqual(history[0]["metadata"]["nested"]["list"], [1, 2, 3])


class TestDatabaseIntegration(unittest.TestCase):
    """Integration tests for database operations"""

    def setUp(self):
        """Create temporary database for each test"""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test_integration.db"
        self.db = StateDatabase(self.db_path)

    def tearDown(self):
        """Clean up temporary database"""
        if self.db_path.exists():
            self.db_path.unlink()

    def test_full_workflow(self):
        """Test complete workflow from state save to retrieval"""
        # 1. Save repository
        self.db.save_repository("my-repo", "/path/to/repo", "main")

        # 2. Create and save repository state
        repo_state = RepositoryState(
            repo_path="/path/to/repo",
            default_branch="main"
        )

        pr = PullRequest(
            number=42,
            title="Fix critical bug",
            state=PRState.OPEN,
            head_branch="bugfix",
            base_branch="main",
            author="developer",
            url="https://github.com/test/repo/pull/42",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            labels=["for-landing", "urgent"],
            ci_checks=[CICheck(name="ci", status=CIStatus.SUCCESS)]
        )

        branch = Branch(
            name="bugfix",
            sha="abc123",
            is_local=True,
            is_remote=True,
            status=BranchStatus.UP_TO_DATE
        )

        branch_state = BranchPRState(
            branch_name="bugfix",
            local_branch=branch,
            remote_branch=branch,
            pr=pr
        )

        repo_state.add_state(branch_state)
        self.db.save_repository_state("my-repo", repo_state)

        # 3. Record processing
        record_id = self.db.record_processing_start(
            "my-repo",
            42,
            "landing",
            metadata={"urgency": "high"}
        )
        self.db.record_processing_complete(record_id, success=True)

        # 4. Save dashboard state
        stats = {"prs_processed": 1, "successes": 1, "failures": 0, "iteration": 1}
        self.db.save_dashboard_state("my-repo", "idle", stats)

        # 5. Verify all data
        repo = self.db.get_repository("my-repo")
        self.assertEqual(repo["name"], "my-repo")

        pr_snapshot = self.db.get_latest_pr_snapshot("my-repo", 42)
        self.assertEqual(pr_snapshot["title"], "Fix critical bug")
        self.assertIn("urgent", pr_snapshot["labels"])

        history = self.db.get_processing_history("my-repo")
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["success"], 1)

        dashboard = self.db.get_dashboard_state("my-repo")
        self.assertEqual(dashboard["prs_processed"], 1)

        summary = self.db.get_repository_state_summary("my-repo")
        self.assertEqual(summary["branches_with_prs"], 1)

        # 6. Check statistics
        stats = self.db.get_statistics()
        self.assertEqual(stats["repositories"], 1)
        self.assertEqual(stats["success_rate"], 100.0)


def run_tests():
    """Run all tests and print results"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # Add all test classes
    suite.addTests(loader.loadTestsFromTestCase(TestStateDatabase))
    suite.addTests(loader.loadTestsFromTestCase(TestDatabaseIntegration))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    return result.wasSuccessful()


if __name__ == "__main__":
    import sys
    success = run_tests()
    sys.exit(0 if success else 1)
