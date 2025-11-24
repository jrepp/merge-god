"""
Integration tests for dashboard with database persistence.

Tests the complete flow including state recovery, processing tracking,
and dashboard operations with database integration.
"""

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from dashboard import RepoMonitor
from db_operations import StateDatabase
from models import (
    Branch,
    BranchPRState,
    BranchStatus,
    CICheck,
    CIStatus,
    PRState,
    PullRequest,
    RepositoryState,
)


class TestRepoMonitorWithDatabase(unittest.TestCase):
    """Test RepoMonitor with database integration"""

    def setUp(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        self.db = StateDatabase(self.db_path)

        self.repo_config = {
            "name": "test-repo",
            "path": "/path/to/test-repo",
            "enabled": True,
            "watch_issues": False,
            "interactive": False,
        }

        self.script_path = Path("/fake/pr-loop.py")

    def tearDown(self):
        """Clean up"""
        if self.db_path.exists():
            self.db_path.unlink()

    def test_state_recovery_on_init(self):
        """Test that monitor recovers state from database on initialization"""
        # Pre-populate database with state
        self.db.save_dashboard_state(
            repo_name="test-repo",
            status="idle",
            stats={
                "prs_processed": 10,
                "successes": 8,
                "failures": 2,
                "iteration": 5,
            },
        )

        # Create monitor - should recover state
        monitor = RepoMonitor(
            self.repo_config,
            self.script_path,
            db=self.db,
        )

        # Verify state recovered
        assert monitor.stats["prs_processed"] == 10
        assert monitor.stats["successes"] == 8
        assert monitor.stats["failures"] == 2
        assert monitor.stats["iteration"] == 5

        # Check logs show recovery
        logs = list(monitor.logs)
        assert any("Recovered state" in log for log in logs)

    def test_persist_state_after_pr_completion(self):
        """Test that state is persisted after PR completion"""
        monitor = RepoMonitor(
            self.repo_config,
            self.script_path,
            db=self.db,
        )

        # Simulate PR processing start
        start_event = {
            "event": "process_pr",
            "data": {
                "action": "start",
                "pr_number": 123,
                "title": "Test PR",
                "mode": "for-review",
                "head_branch": "feature",
                "base_branch": "main",
            },
        }
        monitor.process_event(start_event)

        # Verify processing record created
        assert monitor.current_processing_id is not None
        history = self.db.get_processing_history("test-repo", pr_number=123)
        assert len(history) == 1
        assert history[0]["completed_at"] is None

        # Simulate PR completion
        complete_event = {
            "event": "process_pr",
            "data": {
                "action": "complete",
                "pr_number": 123,
                "success": True,
            },
        }
        monitor.process_event(complete_event)

        # Verify processing completion recorded
        history = self.db.get_processing_history("test-repo", pr_number=123)
        assert history[0]["success"] == 1
        assert history[0]["completed_at"] is not None
        assert history[0]["duration_seconds"] is not None

        # Verify dashboard state persisted
        state = self.db.get_dashboard_state("test-repo")
        assert state is not None
        assert state["prs_processed"] == 1
        assert state["successes"] == 1

    def test_persist_state_after_pr_failure(self):
        """Test that failures are properly recorded"""
        monitor = RepoMonitor(
            self.repo_config,
            self.script_path,
            db=self.db,
        )

        # Start and fail a PR
        monitor.process_event(
            {
                "event": "process_pr",
                "data": {
                    "action": "start",
                    "pr_number": 456,
                    "title": "Failing PR",
                    "mode": "for-landing",
                    "head_branch": "bugfix",
                    "base_branch": "main",
                },
            }
        )

        monitor.process_event(
            {
                "event": "process_pr",
                "data": {
                    "action": "complete",
                    "pr_number": 456,
                    "success": False,
                    "reason": "CI checks failed",
                },
            }
        )

        # Verify failure recorded
        history = self.db.get_processing_history("test-repo", pr_number=456)
        assert history[0]["success"] == 0
        assert history[0]["error_message"] == "CI checks failed"

        state = self.db.get_dashboard_state("test-repo")
        assert state["failures"] == 1

    def test_repository_state_persistence(self):
        """Test saving repository state to database"""
        monitor = RepoMonitor(
            self.repo_config,
            self.script_path,
            db=self.db,
        )

        # Create mock repository state
        repo_state = RepositoryState(
            repo_path="/path/to/test-repo",
            default_branch="main",
        )

        pr = PullRequest(
            number=789,
            title="Test PR for State",
            state=PRState.OPEN,
            head_branch="state-test",
            base_branch="main",
            author="developer",
            url="https://github.com/test/repo/pull/789",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-review"],
            ci_checks=[CICheck(name="test", status=CIStatus.SUCCESS)],
        )

        branch = Branch(
            name="state-test",
            sha="abc123",
            is_local=True,
            is_remote=True,
            status=BranchStatus.UP_TO_DATE,
        )

        branch_state = BranchPRState(
            branch_name="state-test",
            local_branch=branch,
            remote_branch=branch,
            pr=pr,
        )

        repo_state.add_state(branch_state)
        monitor.repo_state = repo_state

        # Persist state
        monitor._persist_state()

        # Verify state saved
        summary = self.db.get_repository_state_summary("test-repo")
        assert summary is not None
        assert summary["total_branches"] == 1
        assert summary["branches_with_prs"] == 1

        # Verify PR snapshot saved
        pr_snapshot = self.db.get_latest_pr_snapshot("test-repo", 789)
        assert pr_snapshot is not None
        assert pr_snapshot["title"] == "Test PR for State"

    def test_multiple_processing_cycles(self):
        """Test tracking multiple PR processing cycles"""
        monitor = RepoMonitor(
            self.repo_config,
            self.script_path,
            db=self.db,
        )

        # Process multiple PRs
        prs = [
            (1, True, None),
            (2, False, "Merge conflict"),
            (3, True, None),
            (4, True, None),
            (5, False, "CI failed"),
        ]

        for pr_num, success, reason in prs:
            monitor.process_event(
                {
                    "event": "process_pr",
                    "data": {
                        "action": "start",
                        "pr_number": pr_num,
                        "title": f"PR {pr_num}",
                        "mode": "for-review",
                        "head_branch": f"feature-{pr_num}",
                        "base_branch": "main",
                    },
                }
            )

            monitor.process_event(
                {
                    "event": "process_pr",
                    "data": {
                        "action": "complete",
                        "pr_number": pr_num,
                        "success": success,
                        "reason": reason,
                    },
                }
            )

        # Verify all tracked
        history = self.db.get_processing_history("test-repo", limit=10)
        assert len(history) == 5

        # Verify statistics
        state = self.db.get_dashboard_state("test-repo")
        assert state["prs_processed"] == 5
        assert state["successes"] == 3
        assert state["failures"] == 2

        # Verify success rate
        stats = self.db.get_statistics()
        assert stats["success_rate"] == 60.0


class TestDatabasePersistenceScenarios(unittest.TestCase):
    """Test various persistence and recovery scenarios"""

    def setUp(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"

    def tearDown(self):
        """Clean up"""
        if self.db_path.exists():
            self.db_path.unlink()

    def test_crash_recovery(self):
        """Test recovering from a crash mid-processing"""
        # Initialize database and start processing
        db1 = StateDatabase(self.db_path)

        repo_config = {
            "name": "crash-test",
            "path": "/path/to/repo",
            "enabled": True,
        }

        monitor1 = RepoMonitor(
            repo_config,
            Path("/fake/script.py"),
            db=db1,
        )

        # Start processing a PR
        monitor1.process_event(
            {
                "event": "process_pr",
                "data": {
                    "action": "start",
                    "pr_number": 999,
                    "title": "Crashed PR",
                    "mode": "for-review",
                    "head_branch": "crash",
                    "base_branch": "main",
                },
            }
        )

        # Simulate crash (don't complete processing)
        del monitor1
        del db1

        # Create new database connection (simulating restart)
        db2 = StateDatabase(self.db_path)

        # Create new monitor - should recover stats
        RepoMonitor(
            repo_config,
            Path("/fake/script.py"),
            db=db2,
        )

        # Check that incomplete processing is recorded
        history = db2.get_processing_history("crash-test", pr_number=999)
        assert len(history) == 1
        assert history[0]["completed_at"] is None  # Incomplete
        assert history[0]["pr_number"] == 999

    def test_state_continuity_across_restarts(self):
        """Test that state persists across multiple restarts"""
        repo_config = {
            "name": "continuity-test",
            "path": "/path/to/repo",
            "enabled": True,
        }

        # First session
        db1 = StateDatabase(self.db_path)
        monitor1 = RepoMonitor(repo_config, Path("/fake/script.py"), db=db1)

        for i in range(3):
            monitor1.process_event(
                {
                    "event": "process_pr",
                    "data": {
                        "action": "start",
                        "pr_number": i,
                        "title": f"PR {i}",
                        "mode": "for-review",
                        "head_branch": f"feature-{i}",
                        "base_branch": "main",
                    },
                }
            )
            monitor1.process_event(
                {
                    "event": "process_pr",
                    "data": {
                        "action": "complete",
                        "pr_number": i,
                        "success": True,
                    },
                }
            )

        assert monitor1.stats["prs_processed"] == 3
        del monitor1
        del db1

        # Second session (restart)
        db2 = StateDatabase(self.db_path)
        monitor2 = RepoMonitor(repo_config, Path("/fake/script.py"), db=db2)

        # Should start with previous stats
        assert monitor2.stats["prs_processed"] == 3
        assert monitor2.stats["successes"] == 3

        # Process more PRs
        for i in range(3, 5):
            monitor2.process_event(
                {
                    "event": "process_pr",
                    "data": {
                        "action": "start",
                        "pr_number": i,
                        "title": f"PR {i}",
                        "mode": "for-review",
                        "head_branch": f"feature-{i}",
                        "base_branch": "main",
                    },
                }
            )
            monitor2.process_event(
                {
                    "event": "process_pr",
                    "data": {
                        "action": "complete",
                        "pr_number": i,
                        "success": True,
                    },
                }
            )

        assert monitor2.stats["prs_processed"] == 5

        # Verify all history present
        history = db2.get_processing_history("continuity-test", limit=10)
        assert len(history) == 5


class TestPRQueueWithDatabase(unittest.TestCase):
    """Test PR queue population and persistence"""

    def setUp(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        self.db = StateDatabase(self.db_path)

        self.repo_config = {
            "name": "queue-test",
            "path": "/path/to/repo",
            "enabled": True,
        }

    def tearDown(self):
        """Clean up"""
        if self.db_path.exists():
            self.db_path.unlink()

    def test_pr_queue_populated_from_state(self):
        """Test that PR queue is populated from repository state"""
        monitor = RepoMonitor(
            self.repo_config,
            Path("/fake/script.py"),
            db=self.db,
        )

        # Create repository state with PRs
        repo_state = RepositoryState(
            repo_path="/path/to/repo",
            default_branch="main",
        )

        # Add for-review PR
        pr1 = PullRequest(
            number=1,
            title="Review PR",
            state=PRState.OPEN,
            head_branch="feature-1",
            base_branch="main",
            author="dev1",
            url="https://github.com/test/repo/pull/1",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-review"],
            ci_checks=[CICheck(name="ci", status=CIStatus.SUCCESS)],
        )

        # Add for-landing PR with failing CI
        pr2 = PullRequest(
            number=2,
            title="Landing PR",
            state=PRState.OPEN,
            head_branch="feature-2",
            base_branch="main",
            author="dev2",
            url="https://github.com/test/repo/pull/2",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-landing"],
            ci_checks=[CICheck(name="ci", status=CIStatus.FAILURE)],
        )

        for pr in [pr1, pr2]:
            branch = Branch(
                name=pr.head_branch,
                sha="abc123",
                is_local=True,
                is_remote=True,
                status=BranchStatus.UP_TO_DATE,
            )
            branch_state = BranchPRState(
                branch_name=pr.head_branch,
                local_branch=branch,
                remote_branch=branch,
                pr=pr,
            )
            repo_state.add_state(branch_state)

        monitor.repo_state = repo_state
        monitor.populate_pr_queue_from_state(force=True)

        # Verify queue populated
        assert len(monitor.pr_queue["for_review"]) == 1
        assert len(monitor.pr_queue["for_landing"]) == 1

        # Verify sorting (failing CI first)
        landing = monitor.pr_queue["for_landing"][0]
        assert landing["ci_failing"]

    def test_pr_queue_filters_correctly(self):
        """Test that PR queue correctly filters draft and WIP PRs"""
        monitor = RepoMonitor(
            self.repo_config,
            Path("/fake/script.py"),
            db=self.db,
        )

        repo_state = RepositoryState(
            repo_path="/path/to/repo",
            default_branch="main",
        )

        # Add draft PR (should be filtered)
        draft_pr = PullRequest(
            number=10,
            title="Draft PR",
            state=PRState.OPEN,
            draft=True,
            head_branch="draft",
            base_branch="main",
            author="dev",
            url="https://github.com/test/repo/pull/10",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-review"],
        )

        # Add WIP PR (should be filtered)
        wip_pr = PullRequest(
            number=11,
            title="WIP PR",
            state=PRState.OPEN,
            head_branch="wip",
            base_branch="main",
            author="dev",
            url="https://github.com/test/repo/pull/11",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-review", "wip"],
        )

        # Add normal PR (should be included)
        normal_pr = PullRequest(
            number=12,
            title="Normal PR",
            state=PRState.OPEN,
            head_branch="feature",
            base_branch="main",
            author="dev",
            url="https://github.com/test/repo/pull/12",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-review"],
        )

        for pr in [draft_pr, wip_pr, normal_pr]:
            branch = Branch(
                name=pr.head_branch,
                sha="abc123",
                is_local=True,
                is_remote=True,
                status=BranchStatus.UP_TO_DATE,
            )
            branch_state = BranchPRState(
                branch_name=pr.head_branch,
                local_branch=branch,
                remote_branch=branch,
                pr=pr,
            )
            repo_state.add_state(branch_state)

        monitor.repo_state = repo_state
        monitor.populate_pr_queue_from_state(force=True)

        # Only normal PR should be in queue
        assert len(monitor.pr_queue["for_review"]) == 1
        assert monitor.pr_queue["for_review"][0]["number"] == 12


def run_tests():
    """Run all integration tests"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # Add all test classes
    suite.addTests(loader.loadTestsFromTestCase(TestRepoMonitorWithDatabase))
    suite.addTests(loader.loadTestsFromTestCase(TestDatabasePersistenceScenarios))
    suite.addTests(loader.loadTestsFromTestCase(TestPRQueueWithDatabase))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    return result.wasSuccessful()


if __name__ == "__main__":
    import sys

    success = run_tests()
    sys.exit(0 if success else 1)
