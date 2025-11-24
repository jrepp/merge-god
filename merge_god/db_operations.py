"""
Database operations module for merge-god dashboard state persistence.

This module provides SQLite-based persistence for:
- Repository state snapshots
- Pull request history
- Processing history and metrics
- Dashboard state for recovery after crashes
"""

import json
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import RepositoryState


class DatabaseError(Exception):
    """Exception raised for database operation errors"""


class StateDatabase:
    """SQLite database for persisting dashboard and repository state"""

    def __init__(self, db_path: Path | str):
        """
        Initialize database connection.

        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self._initialize_database()

    @contextmanager
    def _get_connection(self) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for database connections"""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise DatabaseError(f"Database operation failed: {e}") from e
        finally:
            conn.close()

    def _initialize_database(self) -> None:
        """Create database schema if it doesn't exist"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Repositories table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS repositories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    path TEXT NOT NULL,
                    default_branch TEXT,
                    last_updated TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Pull requests table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pull_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_name TEXT NOT NULL,
                    pr_number INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    state TEXT NOT NULL,
                    head_branch TEXT NOT NULL,
                    base_branch TEXT NOT NULL,
                    author TEXT,
                    draft INTEGER DEFAULT 0,
                    ci_status TEXT,
                    labels TEXT,
                    created_at TIMESTAMP,
                    updated_at TIMESTAMP,
                    snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(repo_name, pr_number, snapshot_time)
                )
            """)

            # Processing history table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS processing_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_name TEXT NOT NULL,
                    pr_number INTEGER NOT NULL,
                    action_type TEXT NOT NULL,
                    success INTEGER DEFAULT 0,
                    error_message TEXT,
                    started_at TIMESTAMP NOT NULL,
                    completed_at TIMESTAMP,
                    duration_seconds REAL,
                    metadata TEXT
                )
            """)

            # Dashboard state table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dashboard_state (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_name TEXT NOT NULL UNIQUE,
                    status TEXT,
                    current_pr_number INTEGER,
                    prs_processed INTEGER DEFAULT 0,
                    successes INTEGER DEFAULT 0,
                    failures INTEGER DEFAULT 0,
                    iteration INTEGER DEFAULT 0,
                    last_update TIMESTAMP,
                    state_data TEXT
                )
            """)

            # Branch state table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS branch_states (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_name TEXT NOT NULL,
                    branch_name TEXT NOT NULL,
                    is_local INTEGER DEFAULT 0,
                    is_remote INTEGER DEFAULT 0,
                    ahead_by INTEGER DEFAULT 0,
                    behind_by INTEGER DEFAULT 0,
                    has_pr INTEGER DEFAULT 0,
                    pr_number INTEGER,
                    needs_sync INTEGER DEFAULT 0,
                    snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(repo_name, branch_name, snapshot_time)
                )
            """)

            # PR context table - stores complete context for agent invocation
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pr_context (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_name TEXT NOT NULL,
                    pr_number INTEGER NOT NULL,
                    pr_url TEXT,
                    diff TEXT,
                    body TEXT,
                    comments TEXT,
                    review_comments TEXT,
                    commits TEXT,
                    files TEXT,
                    conflicts TEXT,
                    ci_checks TEXT,
                    guidelines TEXT,
                    commit_examples TEXT,
                    captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(repo_name, pr_number, captured_at)
                )
            """)

            # Create indexes for performance
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_pr_repo_number
                ON pull_requests(repo_name, pr_number)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_processing_repo_pr
                ON processing_history(repo_name, pr_number, started_at DESC)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_branch_repo
                ON branch_states(repo_name, branch_name)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_pr_context_repo_pr
                ON pr_context(repo_name, pr_number, captured_at DESC)
            """)

            # Agent sessions table - track agent invocations
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS agent_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_name TEXT NOT NULL,
                    pr_number INTEGER NOT NULL,
                    session_id TEXT NOT NULL UNIQUE,
                    mode TEXT NOT NULL,
                    started_at TIMESTAMP NOT NULL,
                    completed_at TIMESTAMP,
                    status TEXT NOT NULL,
                    success INTEGER DEFAULT 0,
                    error_message TEXT,

                    -- Task tracking
                    tasks_total INTEGER DEFAULT 0,
                    tasks_completed INTEGER DEFAULT 0,
                    tasks_failed INTEGER DEFAULT 0,

                    -- Action tracking
                    actions_total INTEGER DEFAULT 0,

                    -- Token usage
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0,
                    total_tokens INTEGER DEFAULT 0,
                    estimated_cost REAL DEFAULT 0.0,

                    -- Performance
                    duration_seconds REAL,
                    api_calls INTEGER DEFAULT 0,

                    -- Metadata
                    model TEXT,
                    agent_version TEXT,

                    FOREIGN KEY (repo_name, pr_number) REFERENCES pull_requests(repo_name, pr_number)
                )
            """)

            # Agent actions table - detailed action log
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS agent_actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    action_number INTEGER NOT NULL,
                    action_type TEXT NOT NULL,
                    target TEXT,
                    status TEXT NOT NULL,
                    started_at TIMESTAMP NOT NULL,
                    completed_at TIMESTAMP,
                    success INTEGER DEFAULT 0,
                    error_message TEXT,
                    details TEXT,
                    result TEXT,
                    duration_ms INTEGER,

                    FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
                )
            """)

            # Agent turns table - conversation turn tracking
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS agent_turns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    turn_number INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    content_preview TEXT,
                    tool_uses INTEGER DEFAULT 0,
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0,
                    created_at TIMESTAMP NOT NULL,

                    FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
                )
            """)

            # Agent errors table - error tracking
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS agent_errors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    error_type TEXT NOT NULL,
                    error_message TEXT NOT NULL,
                    error_details TEXT,
                    occurred_at TIMESTAMP NOT NULL,
                    is_transient INTEGER DEFAULT 0,
                    retry_count INTEGER DEFAULT 0,

                    FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
                )
            """)

            # Create indexes for agent tables
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_sessions_repo_pr
                ON agent_sessions(repo_name, pr_number, started_at DESC)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
                ON agent_sessions(status, started_at DESC)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_actions_session
                ON agent_actions(session_id, action_number)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_turns_session
                ON agent_turns(session_id, turn_number)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_errors_session
                ON agent_errors(session_id, occurred_at DESC)
            """)

            # Agent file operations table - track file read/write/edit
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS agent_file_operations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    action_id INTEGER,
                    operation_type TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_size INTEGER,
                    lines_added INTEGER DEFAULT 0,
                    lines_removed INTEGER DEFAULT 0,
                    success INTEGER DEFAULT 1,
                    error_message TEXT,
                    occurred_at TIMESTAMP NOT NULL,

                    FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id),
                    FOREIGN KEY (action_id) REFERENCES agent_actions(id)
                )
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_file_ops_session
                ON agent_file_operations(session_id, occurred_at)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_file_ops_path
                ON agent_file_operations(file_path, operation_type)
            """)

    # Repository Operations

    def save_repository(self, name: str, path: str, default_branch: str | None = None) -> None:
        """
        Save or update repository metadata.

        Args:
            name: Repository name
            path: Repository path
            default_branch: Default branch name
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO repositories (name, path, default_branch, last_updated)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    path = excluded.path,
                    default_branch = excluded.default_branch,
                    last_updated = excluded.last_updated
            """, (name, path, default_branch, datetime.now(UTC)))

    def get_repository(self, name: str) -> dict[str, Any] | None:
        """Get repository metadata by name"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM repositories WHERE name = ?", (name,))
            row = cursor.fetchone()
            return dict(row) if row else None

    # Pull Request Operations

    def save_pr_snapshot(self, repo_name: str, pr_data: dict[str, Any]) -> None:
        """
        Save a snapshot of a PR's state.

        Args:
            repo_name: Repository name
            pr_data: PR data dictionary
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO pull_requests (
                    repo_name, pr_number, title, state, head_branch, base_branch,
                    author, draft, ci_status, labels, created_at, updated_at, snapshot_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                repo_name,
                pr_data["number"],
                pr_data["title"],
                pr_data.get("state", "open"),
                pr_data["head_branch"],
                pr_data["base_branch"],
                pr_data.get("author"),
                1 if pr_data.get("draft", False) else 0,
                pr_data.get("ci_status"),
                json.dumps(pr_data.get("labels", [])),
                pr_data.get("created_at"),
                pr_data.get("updated_at"),
                datetime.now(UTC),
            ))

    def get_latest_pr_snapshot(self, repo_name: str, pr_number: int) -> dict[str, Any] | None:
        """Get the latest snapshot of a specific PR"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM pull_requests
                WHERE repo_name = ? AND pr_number = ?
                ORDER BY snapshot_time DESC
                LIMIT 1
            """, (repo_name, pr_number))
            row = cursor.fetchone()
            if row:
                data = dict(row)
                data["labels"] = json.loads(data["labels"]) if data["labels"] else []
                return data
            return None

    def get_active_prs(self, repo_name: str) -> list[dict[str, Any]]:
        """Get all active PRs for a repository (latest snapshots only)"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM pull_requests p1
                WHERE repo_name = ?
                AND state = 'open'
                AND snapshot_time = (
                    SELECT MAX(snapshot_time)
                    FROM pull_requests p2
                    WHERE p2.repo_name = p1.repo_name
                    AND p2.pr_number = p1.pr_number
                )
                ORDER BY pr_number
            """, (repo_name,))
            results = []
            for row in cursor.fetchall():
                data = dict(row)
                data["labels"] = json.loads(data["labels"]) if data["labels"] else []
                results.append(data)
            return results

    # Processing History Operations

    def record_processing_start(
        self,
        repo_name: str,
        pr_number: int,
        action_type: str,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        """
        Record the start of PR processing.

        Args:
            repo_name: Repository name
            pr_number: PR number
            action_type: Type of action (e.g., 'review', 'landing')
            metadata: Additional metadata

        Returns:
            Processing record ID
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO processing_history (
                    repo_name, pr_number, action_type, started_at, metadata
                ) VALUES (?, ?, ?, ?, ?)
            """, (
                repo_name,
                pr_number,
                action_type,
                datetime.now(UTC),
                json.dumps(metadata) if metadata else None,
            ))
            lastrowid = cursor.lastrowid
            if lastrowid is None:
                raise DatabaseError("Failed to get lastrowid after insert")
            return lastrowid

    def record_processing_complete(
        self,
        record_id: int,
        success: bool,
        error_message: str | None = None,
    ) -> None:
        """
        Record the completion of PR processing.

        Args:
            record_id: Processing record ID from record_processing_start
            success: Whether processing succeeded
            error_message: Error message if failed
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            completed_at = datetime.now(UTC)
            cursor.execute("""
                UPDATE processing_history
                SET success = ?,
                    error_message = ?,
                    completed_at = ?,
                    duration_seconds = (
                        julianday(?) - julianday(started_at)
                    ) * 86400
                WHERE id = ?
            """, (
                1 if success else 0,
                error_message,
                completed_at,
                completed_at,
                record_id,
            ))

    def get_processing_history(
        self,
        repo_name: str,
        pr_number: int | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """
        Get processing history for a repository or specific PR.

        Args:
            repo_name: Repository name
            pr_number: Optional PR number to filter by
            limit: Maximum number of records to return

        Returns:
            List of processing history records
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            if pr_number is not None:
                cursor.execute("""
                    SELECT * FROM processing_history
                    WHERE repo_name = ? AND pr_number = ?
                    ORDER BY started_at DESC
                    LIMIT ?
                """, (repo_name, pr_number, limit))
            else:
                cursor.execute("""
                    SELECT * FROM processing_history
                    WHERE repo_name = ?
                    ORDER BY started_at DESC
                    LIMIT ?
                """, (repo_name, limit))

            results = []
            for row in cursor.fetchall():
                data = dict(row)
                if data.get("metadata"):
                    data["metadata"] = json.loads(data["metadata"])
                results.append(data)
            return results

    # Dashboard State Operations

    def save_dashboard_state(
        self,
        repo_name: str,
        status: str,
        stats: dict[str, Any],
        current_pr_number: int | None = None,
        state_data: dict[str, Any] | None = None,
    ) -> None:
        """
        Save dashboard state for a repository.

        Args:
            repo_name: Repository name
            status: Current status
            stats: Processing statistics
            current_pr_number: Currently processing PR number
            state_data: Additional state data
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO dashboard_state (
                    repo_name, status, current_pr_number,
                    prs_processed, successes, failures, iteration,
                    last_update, state_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo_name) DO UPDATE SET
                    status = excluded.status,
                    current_pr_number = excluded.current_pr_number,
                    prs_processed = excluded.prs_processed,
                    successes = excluded.successes,
                    failures = excluded.failures,
                    iteration = excluded.iteration,
                    last_update = excluded.last_update,
                    state_data = excluded.state_data
            """, (
                repo_name,
                status,
                current_pr_number,
                stats.get("prs_processed", 0),
                stats.get("successes", 0),
                stats.get("failures", 0),
                stats.get("iteration", 0),
                datetime.now(UTC),
                json.dumps(state_data) if state_data else None,
            ))

    def get_dashboard_state(self, repo_name: str) -> dict[str, Any] | None:
        """Get dashboard state for a repository"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM dashboard_state WHERE repo_name = ?
            """, (repo_name,))
            row = cursor.fetchone()
            if row:
                data = dict(row)
                if data.get("state_data"):
                    data["state_data"] = json.loads(data["state_data"])
                return data
            return None

    # Branch State Operations

    def save_repository_state(self, repo_name: str, repo_state: RepositoryState) -> None:
        """
        Save complete repository state snapshot.

        Args:
            repo_name: Repository name
            repo_state: RepositoryState object
        """
        snapshot_time = datetime.now(UTC)

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Save repository metadata
            cursor.execute("""
                INSERT INTO repositories (name, path, default_branch, last_updated)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    path = excluded.path,
                    default_branch = excluded.default_branch,
                    last_updated = excluded.last_updated
            """, (repo_name, repo_state.repo_path, repo_state.default_branch, snapshot_time))

            # Save branch states
            for branch_state in repo_state.branch_pr_states:
                cursor.execute("""
                    INSERT INTO branch_states (
                        repo_name, branch_name, is_local, is_remote,
                        ahead_by, behind_by, has_pr, pr_number, needs_sync, snapshot_time
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    repo_name,
                    branch_state.branch_name,
                    1 if branch_state.local_branch else 0,
                    1 if branch_state.remote_branch else 0,
                    branch_state.local_branch.ahead_by if branch_state.local_branch else 0,
                    branch_state.local_branch.behind_by if branch_state.local_branch else 0,
                    1 if branch_state.has_pr else 0,
                    branch_state.pr.number if branch_state.pr else None,
                    1 if (branch_state.needs_push or branch_state.needs_pull) else 0,
                    snapshot_time,
                ))

                # Save PR snapshot if exists
                if branch_state.pr:
                    pr = branch_state.pr
                    cursor.execute("""
                        INSERT INTO pull_requests (
                            repo_name, pr_number, title, state, head_branch, base_branch,
                            author, draft, ci_status, labels, created_at, updated_at, snapshot_time
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        repo_name,
                        pr.number,
                        pr.title,
                        pr.state.value,
                        pr.head_branch,
                        pr.base_branch,
                        pr.author,
                        1 if pr.draft else 0,
                        pr.get_ci_status().value,
                        json.dumps(pr.labels),
                        pr.created_at,
                        pr.updated_at,
                        snapshot_time,
                    ))

    def get_repository_state_summary(self, repo_name: str) -> dict[str, Any] | None:
        """Get summary of latest repository state"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Get latest snapshot time
            cursor.execute("""
                SELECT MAX(snapshot_time) as latest
                FROM branch_states
                WHERE repo_name = ?
            """, (repo_name,))
            row = cursor.fetchone()
            if not row or not row["latest"]:
                return None

            snapshot_time = row["latest"]

            # Get branch statistics
            cursor.execute("""
                SELECT
                    COUNT(*) as total_branches,
                    SUM(has_pr) as branches_with_prs,
                    SUM(needs_sync) as branches_needing_sync,
                    SUM(CASE WHEN is_local = 1 THEN 1 ELSE 0 END) as local_branches,
                    SUM(CASE WHEN is_remote = 1 THEN 1 ELSE 0 END) as remote_branches
                FROM branch_states
                WHERE repo_name = ? AND snapshot_time = ?
            """, (repo_name, snapshot_time))

            stats = dict(cursor.fetchone())

            # Get failing CI count
            cursor.execute("""
                SELECT COUNT(*) as failing_ci
                FROM pull_requests
                WHERE repo_name = ?
                AND snapshot_time = ?
                AND ci_status = 'failure'
            """, (repo_name, snapshot_time))

            stats["failing_ci"] = cursor.fetchone()["failing_ci"]
            stats["snapshot_time"] = snapshot_time

            return stats

    # PR Context Operations

    def save_pr_context(
        self,
        repo_name: str,
        pr_number: int,
        pr_details: dict[str, Any],
        pr_context: dict[str, Any],
    ) -> None:
        """
        Save complete PR context for agent invocation.

        This stores all the data needed to run the agent standalone,
        including diff, comments, review comments, files, conflicts, CI checks, etc.

        Args:
            repo_name: Repository name
            pr_number: PR number
            pr_details: PR details from GitHub API
            pr_context: Full PR context including diff, comments, etc.

        Raises:
            DatabaseError: If save fails
            ValueError: If required data is missing or invalid
        """
        # Validate inputs
        if not repo_name or not isinstance(repo_name, str):
            raise ValueError("repo_name must be a non-empty string")
        if not isinstance(pr_number, int) or pr_number <= 0:
            raise ValueError("pr_number must be a positive integer")
        if not isinstance(pr_details, dict):
            raise ValueError("pr_details must be a dictionary")
        if not isinstance(pr_context, dict):
            raise ValueError("pr_context must be a dictionary")

        # Size limits (prevent excessive database growth)
        max_diff_size = 10 * 1024 * 1024  # 10MB
        diff = pr_context.get("diff", "")
        if len(diff) > max_diff_size:
            # Truncate large diffs but keep metadata
            diff = diff[:max_diff_size] + f"\n\n... [Diff truncated - original size: {len(diff)} bytes]"

        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT INTO pr_context (
                        repo_name, pr_number, pr_url, diff, body,
                        comments, review_comments, commits, files,
                        conflicts, ci_checks, guidelines, commit_examples, captured_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    repo_name,
                    pr_number,
                    pr_context.get("url", ""),
                    diff,
                    pr_details.get("body", ""),
                    json.dumps(pr_context.get("comments", []), ensure_ascii=False),
                    json.dumps(pr_context.get("review_comments", []), ensure_ascii=False),
                    json.dumps(pr_context.get("commits", []), ensure_ascii=False),
                    json.dumps(pr_context.get("files", []), ensure_ascii=False),
                    json.dumps(pr_context.get("conflicts", {}), ensure_ascii=False),
                    json.dumps(pr_context.get("ci_status", {}), ensure_ascii=False),
                    pr_context.get("guidelines", ""),
                    pr_context.get("commit_examples", ""),
                    datetime.now(UTC),
                ))
        except Exception as e:
            raise DatabaseError(f"Failed to save PR context: {e}") from e

    def get_latest_pr_context(self, repo_name: str, pr_number: int) -> dict[str, Any] | None:
        """
        Get the latest complete PR context for agent invocation.

        Returns all data needed to invoke the agent, including diff, comments, etc.

        Args:
            repo_name: Repository name
            pr_number: PR number

        Returns:
            Complete PR context dictionary or None if not found

        Raises:
            DatabaseError: If retrieval or deserialization fails
        """
        # Validate inputs
        if not repo_name or not isinstance(repo_name, str):
            raise ValueError("repo_name must be a non-empty string")
        if not isinstance(pr_number, int) or pr_number <= 0:
            raise ValueError("pr_number must be a positive integer")

        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT * FROM pr_context
                    WHERE repo_name = ? AND pr_number = ?
                    ORDER BY captured_at DESC
                    LIMIT 1
                """, (repo_name, pr_number))
                row = cursor.fetchone()
                if row:
                    data = dict(row)
                    # Deserialize JSON fields with error handling
                    try:
                        data["comments"] = json.loads(data["comments"]) if data["comments"] else []
                    except json.JSONDecodeError:
                        data["comments"] = []

                    try:
                        data["review_comments"] = json.loads(data["review_comments"]) if data["review_comments"] else []
                    except json.JSONDecodeError:
                        data["review_comments"] = []

                    try:
                        data["commits"] = json.loads(data["commits"]) if data["commits"] else []
                    except json.JSONDecodeError:
                        data["commits"] = []

                    try:
                        data["files"] = json.loads(data["files"]) if data["files"] else []
                    except json.JSONDecodeError:
                        data["files"] = []

                    try:
                        data["conflicts"] = json.loads(data["conflicts"]) if data["conflicts"] else {}
                    except json.JSONDecodeError:
                        data["conflicts"] = {}

                    try:
                        data["ci_checks"] = json.loads(data["ci_checks"]) if data["ci_checks"] else {}
                    except json.JSONDecodeError:
                        data["ci_checks"] = {}

                    return data
                return None
        except Exception as e:
            raise DatabaseError(f"Failed to retrieve PR context: {e}") from e

    def get_pr_context_for_agent(self, repo_name: str, pr_number: int) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """
        Get PR details and context in the format expected by gather_pr_context().

        This returns data in the same format as pr-loop.py's gather_pr_context(),
        allowing the agent to run from database data alone.

        Args:
            repo_name: Repository name
            pr_number: PR number

        Returns:
            Tuple of (pr_details, pr_context) or None if not found

        Raises:
            DatabaseError: If data retrieval fails
            ValueError: If data format is invalid
        """
        # Validate inputs
        if not repo_name or not isinstance(repo_name, str):
            raise ValueError("repo_name must be a non-empty string")
        if not isinstance(pr_number, int) or pr_number <= 0:
            raise ValueError("pr_number must be a positive integer")

        # Get latest PR snapshot
        pr_snapshot = self.get_latest_pr_snapshot(repo_name, pr_number)
        if not pr_snapshot:
            return None

        # Get latest PR context
        context_data = self.get_latest_pr_context(repo_name, pr_number)
        if not context_data:
            return None

        # Validate required fields exist
        required_snapshot_fields = ["pr_number", "title", "head_branch", "base_branch", "author"]
        for field in required_snapshot_fields:
            if field not in pr_snapshot or pr_snapshot[field] is None:
                raise ValueError(f"PR snapshot missing required field: {field}")

        # Build pr_details in the format expected by PRContext.from_dict()
        pr_details = {
            "number": pr_snapshot["pr_number"],
            "title": pr_snapshot["title"],
            "body": context_data.get("body", ""),
            "headRefName": pr_snapshot["head_branch"],
            "baseRefName": pr_snapshot["base_branch"],
            "author": {"login": pr_snapshot["author"] or "unknown"},
            "labels": pr_snapshot.get("labels", []),
            "reviewDecision": None,  # Not stored in snapshot, could be added
        }

        # Build pr_context in the format expected by PRContext.from_dict()
        pr_context = {
            "url": context_data.get("pr_url", ""),
            "diff": context_data.get("diff", ""),
            "comments": context_data.get("comments", []),
            "review_comments": context_data.get("review_comments", []),
            "commits": context_data.get("commits", []),
            "files": context_data.get("files", []),
            "conflicts": context_data.get("conflicts", {}),
            "ci_status": context_data.get("ci_checks", {}),
            "guidelines": context_data.get("guidelines", ""),
            "commit_examples": context_data.get("commit_examples", ""),
        }

        return pr_details, pr_context

    # Agent Session Operations

    def create_agent_session(
        self,
        repo_name: str,
        pr_number: int,
        session_id: str,
        mode: str,
        model: str,
        agent_version: str = "1.0",
    ) -> None:
        """Create a new agent session record"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO agent_sessions (
                    repo_name, pr_number, session_id, mode, model, agent_version,
                    started_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                repo_name, pr_number, session_id, mode, model, agent_version,
                datetime.now(UTC), "running",
            ))

    def update_agent_session(
        self,
        session_id: str,
        status: str | None = None,
        success: bool | None = None,
        error_message: str | None = None,
        tasks_total: int | None = None,
        tasks_completed: int | None = None,
        tasks_failed: int | None = None,
        actions_total: int | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        api_calls: int | None = None,
    ) -> None:
        """Update agent session with progress/completion data"""
        updates: list[str] = []
        params: list[Any] = []

        if status is not None:
            updates.append("status = ?")
            params.append(status)
            if status in ["completed", "failed", "aborted"]:
                updates.append("completed_at = ?")
                params.append(datetime.now(UTC))

        if success is not None:
            updates.append("success = ?")
            params.append(1 if success else 0)

        if error_message is not None:
            updates.append("error_message = ?")
            params.append(error_message)

        if tasks_total is not None:
            updates.append("tasks_total = ?")
            params.append(tasks_total)

        if tasks_completed is not None:
            updates.append("tasks_completed = ?")
            params.append(tasks_completed)

        if tasks_failed is not None:
            updates.append("tasks_failed = ?")
            params.append(tasks_failed)

        if actions_total is not None:
            updates.append("actions_total = ?")
            params.append(actions_total)

        if input_tokens is not None:
            updates.append("input_tokens = ?")
            params.append(input_tokens)

        if output_tokens is not None:
            updates.append("output_tokens = ?")
            params.append(output_tokens)
            if input_tokens is not None:
                updates.append("total_tokens = ?")
                params.append(input_tokens + output_tokens)
                # Rough cost estimation (Sonnet 4.5 pricing)
                updates.append("estimated_cost = ?")
                cost = (input_tokens * 0.003 / 1000) + (output_tokens * 0.015 / 1000)
                params.append(cost)

        if api_calls is not None:
            updates.append("api_calls = ?")
            params.append(api_calls)

        # Calculate duration if completing
        if status in ["completed", "failed", "aborted"]:
            updates.append("""duration_seconds = (
                julianday(?) - julianday(started_at)
            ) * 86400""")
            params.append(datetime.now(UTC))

        if not updates:
            return

        params.append(session_id)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(f"""
                UPDATE agent_sessions
                SET {', '.join(updates)}
                WHERE session_id = ?
            """, params)

    def record_agent_action(
        self,
        session_id: str,
        action_number: int,
        action_type: str,
        target: str = "",
        details: dict[str, Any] | None = None,
        status: str = "started",
        success: bool | None = None,
        error_message: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> int:
        """Record an agent action"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO agent_actions (
                    session_id, action_number, action_type, target, status,
                    started_at, success, error_message, details, result
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id, action_number, action_type, target, status,
                datetime.now(UTC),
                1 if success else 0 if success is not None else None,
                error_message,
                json.dumps(details) if details else None,
                json.dumps(result) if result else None,
            ))
            lastrowid = cursor.lastrowid
            if lastrowid is None:
                raise DatabaseError("Failed to get lastrowid after insert")
            return lastrowid

    def record_agent_turn(
        self,
        session_id: str,
        turn_number: int,
        role: str,
        content_type: str,
        content_preview: str | None = None,
        tool_uses: int = 0,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        """Record a conversation turn"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO agent_turns (
                    session_id, turn_number, role, content_type, content_preview,
                    tool_uses, input_tokens, output_tokens, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id, turn_number, role, content_type, content_preview,
                tool_uses, input_tokens, output_tokens, datetime.now(UTC),
            ))

    def record_agent_error(
        self,
        session_id: str,
        error_type: str,
        error_message: str,
        error_details: str | None = None,
        is_transient: bool = False,
        retry_count: int = 0,
    ) -> None:
        """Record an agent error"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO agent_errors (
                    session_id, error_type, error_message, error_details,
                    is_transient, retry_count, occurred_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id, error_type, error_message, error_details,
                1 if is_transient else 0, retry_count, datetime.now(UTC),
            ))

    def record_file_operation(
        self,
        session_id: str,
        operation_type: str,
        file_path: str,
        action_id: int | None = None,
        file_size: int | None = None,
        lines_added: int = 0,
        lines_removed: int = 0,
        success: bool = True,
        error_message: str | None = None,
    ) -> None:
        """Record a file operation"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO agent_file_operations (
                    session_id, action_id, operation_type, file_path, file_size,
                    lines_added, lines_removed, success, error_message, occurred_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id, action_id, operation_type, file_path, file_size,
                lines_added, lines_removed, 1 if success else 0,
                error_message, datetime.now(UTC),
            ))

    def get_agent_sessions(
        self,
        repo_name: str | None = None,
        pr_number: int | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Get agent session history"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            query = "SELECT * FROM agent_sessions"
            params: list[Any] = []
            conditions: list[str] = []

            if repo_name:
                conditions.append("repo_name = ?")
                params.append(repo_name)

            if pr_number is not None:
                conditions.append("pr_number = ?")
                params.append(pr_number)

            if conditions:
                query += " WHERE " + " AND ".join(conditions)

            query += " ORDER BY started_at DESC LIMIT ?"
            params.append(limit)

            cursor.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    def get_session_details(self, session_id: str) -> dict[str, Any] | None:
        """Get complete session details with actions, turns, and errors"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Get session
            cursor.execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,))
            session_row = cursor.fetchone()
            if not session_row:
                return None

            session = dict(session_row)

            # Get actions
            cursor.execute("""
                SELECT * FROM agent_actions
                WHERE session_id = ?
                ORDER BY action_number
            """, (session_id,))
            session["actions"] = [dict(row) for row in cursor.fetchall()]

            # Get turns
            cursor.execute("""
                SELECT * FROM agent_turns
                WHERE session_id = ?
                ORDER BY turn_number
            """, (session_id,))
            session["turns"] = [dict(row) for row in cursor.fetchall()]

            # Get errors
            cursor.execute("""
                SELECT * FROM agent_errors
                WHERE session_id = ?
                ORDER BY occurred_at
            """, (session_id,))
            session["errors"] = [dict(row) for row in cursor.fetchall()]

            # Get file operations
            cursor.execute("""
                SELECT * FROM agent_file_operations
                WHERE session_id = ?
                ORDER BY occurred_at
            """, (session_id,))
            session["file_operations"] = [dict(row) for row in cursor.fetchall()]

            return session

    # Cleanup Operations

    def cleanup_old_snapshots(self, days: int = 7) -> int:
        """
        Remove snapshots older than specified days.

        Args:
            days: Number of days to keep

        Returns:
            Number of records deleted
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cutoff = datetime.now(UTC).timestamp() - (days * 86400)

            cursor.execute("""
                DELETE FROM pull_requests
                WHERE snapshot_time < datetime(?, 'unixepoch')
            """, (cutoff,))
            pr_deleted = cursor.rowcount

            cursor.execute("""
                DELETE FROM branch_states
                WHERE snapshot_time < datetime(?, 'unixepoch')
            """, (cutoff,))
            branch_deleted = cursor.rowcount

            cursor.execute("""
                DELETE FROM pr_context
                WHERE captured_at < datetime(?, 'unixepoch')
            """, (cutoff,))
            context_deleted = cursor.rowcount

            return pr_deleted + branch_deleted + context_deleted

    def get_statistics(self) -> dict[str, Any]:
        """Get overall database statistics"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            stats = {}

            # Repository count
            cursor.execute("SELECT COUNT(*) as count FROM repositories")
            stats["repositories"] = cursor.fetchone()["count"]

            # PR snapshot count
            cursor.execute("SELECT COUNT(*) as count FROM pull_requests")
            stats["pr_snapshots"] = cursor.fetchone()["count"]

            # Processing history count
            cursor.execute("SELECT COUNT(*) as count FROM processing_history")
            stats["processing_records"] = cursor.fetchone()["count"]

            # Success rate
            cursor.execute("""
                SELECT
                    SUM(success) as successes,
                    COUNT(*) as total
                FROM processing_history
                WHERE completed_at IS NOT NULL
            """)
            row = cursor.fetchone()
            if row["total"] > 0:
                stats["success_rate"] = round(row["successes"] / row["total"] * 100, 2)
            else:
                stats["success_rate"] = 0.0

            # Database size
            cursor.execute("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
            stats["database_size_bytes"] = cursor.fetchone()["size"]

            return stats
