"""
Async SQLite store for GitHub sync state persistence.

This module provides an async SQLite-based persistence layer for:
- Repository state snapshots
- Pull request history
- Branch state tracking
- PR context for offline processing

Includes automatic schema migration support.
"""

import json
import logging
from collections.abc import AsyncGenerator, Callable, Coroutine
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite

from github_sync.models import PRContext, RepositoryState

logger = logging.getLogger(__name__)

# Current schema version - increment when adding migrations
SCHEMA_VERSION = 2


class DatabaseError(Exception):
    """Exception raised for database operation errors."""


class MigrationError(Exception):
    """Exception raised for migration errors."""


# Type alias for migration functions
MigrationFunc = Callable[[aiosqlite.Connection], Coroutine[Any, Any, None]]


class SyncStore:
    """Async SQLite store for persisting sync state."""

    def __init__(self, db_path: Path | str):
        """
        Initialize database connection.

        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the database schema and run any pending migrations."""
        if self._initialized:
            return

        async with self._get_connection() as conn:
            # Create schema version table first
            await self._ensure_schema_version_table(conn)

            # Get current version
            current_version = await self._get_schema_version(conn)

            if current_version == 0:
                # Fresh database - create initial schema
                await self._create_initial_schema(conn)
                await self._set_schema_version(conn, SCHEMA_VERSION)
                logger.info(f"Created fresh database at schema version {SCHEMA_VERSION}")
            elif current_version < SCHEMA_VERSION:
                # Run migrations
                await self._run_migrations(conn, current_version, SCHEMA_VERSION)
                logger.info(f"Migrated database from version {current_version} to {SCHEMA_VERSION}")
            elif current_version > SCHEMA_VERSION:
                raise MigrationError(
                    f"Database schema version {current_version} is newer than "
                    f"supported version {SCHEMA_VERSION}. Please upgrade the library."
                )

        self._initialized = True

    async def _ensure_schema_version_table(self, conn: aiosqlite.Connection) -> None:
        """Create the schema_version table if it doesn't exist."""
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

    async def _get_schema_version(self, conn: aiosqlite.Connection) -> int:
        """Get current schema version, 0 if not set."""
        cursor = await conn.execute("SELECT version FROM schema_version WHERE id = 1")
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def _set_schema_version(self, conn: aiosqlite.Connection, version: int) -> None:
        """Set the schema version."""
        await conn.execute(
            """
            INSERT INTO schema_version (id, version, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                version = excluded.version,
                updated_at = excluded.updated_at
        """,
            (version, datetime.now(UTC)),
        )

    async def _run_migrations(
        self, conn: aiosqlite.Connection, from_version: int, to_version: int
    ) -> None:
        """Run migrations from from_version to to_version."""
        migrations = self._get_migrations()

        for version in range(from_version + 1, to_version + 1):
            if version not in migrations:
                raise MigrationError(f"Missing migration for version {version}")

            logger.info(f"Running migration to version {version}")
            try:
                await migrations[version](conn)
                await self._set_schema_version(conn, version)
            except Exception as e:
                raise MigrationError(f"Migration to version {version} failed: {e}")

    def _get_migrations(self) -> dict[int, MigrationFunc]:
        """
        Get all available migrations.

        Returns a dict mapping version number to migration function.
        Each migration brings the database FROM the previous version TO that version.
        """
        return {
            # Version 1 is the initial schema, created by _create_initial_schema
            2: self._migrate_v1_to_v2,
        }

    async def _migrate_v1_to_v2(self, conn: aiosqlite.Connection) -> None:
        """Migration from v1 to v2: Add project_metadata table for flexible project identification."""
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                project_id TEXT,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )
        # Initialize with empty metadata
        await conn.execute(
            """
            INSERT OR IGNORE INTO project_metadata (id, metadata)
            VALUES (1, '{}')
        """
        )

    @asynccontextmanager
    async def _get_connection(self) -> AsyncGenerator[aiosqlite.Connection, None]:
        """Async context manager for database connections."""
        conn = await aiosqlite.connect(str(self.db_path))
        conn.row_factory = aiosqlite.Row
        try:
            yield conn
            await conn.commit()
        except Exception as e:
            await conn.rollback()
            raise DatabaseError(f"Database operation failed: {e}")
        finally:
            await conn.close()

    async def _create_initial_schema(self, conn: aiosqlite.Connection) -> None:
        """Create the initial database schema (version 1)."""
        # Repositories table
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS repositories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                path TEXT NOT NULL,
                default_branch TEXT,
                last_updated TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        # Pull requests table
        await conn.execute(
            """
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
        """
        )

        # Branch states table
        await conn.execute(
            """
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
        """
        )

        # PR context table - stores complete context for offline processing
        await conn.execute(
            """
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
        """
        )

        # Sync history table
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_name TEXT NOT NULL,
                sync_type TEXT NOT NULL,
                started_at TIMESTAMP NOT NULL,
                completed_at TIMESTAMP,
                success INTEGER DEFAULT 0,
                error_message TEXT,
                prs_synced INTEGER DEFAULT 0,
                branches_synced INTEGER DEFAULT 0
            )
        """
        )

        # Project metadata table - stores flexible project identification and metadata
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                project_id TEXT,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        # Initialize with empty metadata
        await conn.execute(
            """
            INSERT OR IGNORE INTO project_metadata (id, metadata)
            VALUES (1, '{}')
        """
        )

        # Command queue table - stores extracted bot commands for execution
        # Includes automatic timing, error tracking, and audit trail
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS command_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_name TEXT NOT NULL,
                pr_number INTEGER NOT NULL,
                command TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                comment_id INTEGER NOT NULL,
                comment_author TEXT,
                comment_body TEXT,
                dependency TEXT,
                extracted_at TIMESTAMP NOT NULL,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                duration_ms INTEGER,
                success INTEGER,
                error_type TEXT,
                error_message TEXT,
                result_message TEXT,
                retry_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        # PR memos table - bot's shadow memory for each PR (todos, plans, notes)
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pr_memos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_name TEXT NOT NULL,
                pr_number INTEGER NOT NULL,
                memo_type TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(repo_name, pr_number, memo_type)
            )
        """
        )

        # Create indexes
        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_pr_repo_number
            ON pull_requests(repo_name, pr_number)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_branch_repo
            ON branch_states(repo_name, branch_name)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_pr_context_repo_pr
            ON pr_context(repo_name, pr_number, captured_at DESC)
        """
        )

        # Global memory table - bot's persistent memory across all repos/PRs
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS global_memory (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        # Branch memory table - bot's memory per branch
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS branch_memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_name TEXT NOT NULL,
                branch_name TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(repo_name, branch_name, key)
            )
        """
        )

        # Branch timing table - timing info for branch operations
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS branch_timing (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_name TEXT NOT NULL,
                branch_name TEXT NOT NULL,
                operation TEXT NOT NULL,
                started_at TIMESTAMP NOT NULL,
                completed_at TIMESTAMP,
                duration_ms INTEGER,
                success INTEGER DEFAULT 1,
                metadata TEXT,
                UNIQUE(repo_name, branch_name, operation, started_at)
            )
        """
        )

        # Workflows table - tracks multi-step LLM operations
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workflows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_type TEXT NOT NULL,
                repo_name TEXT NOT NULL,
                branch_name TEXT,
                pr_number INTEGER,
                status TEXT NOT NULL DEFAULT 'created',
                current_step TEXT,
                context TEXT NOT NULL DEFAULT '{}',
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                duration_ms INTEGER,
                success INTEGER,
                error_type TEXT,
                error_message TEXT,
                result TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        # Workflow steps table - individual steps within a workflow
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workflow_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id INTEGER NOT NULL,
                step_name TEXT NOT NULL,
                step_order INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                input_data TEXT,
                output_data TEXT,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                duration_ms INTEGER,
                success INTEGER,
                error_type TEXT,
                error_message TEXT,
                tool_calls INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (workflow_id) REFERENCES workflows(id)
            )
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_workflows_repo_status
            ON workflows(repo_name, status, workflow_type)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow
            ON workflow_steps(workflow_id, step_order)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_command_queue_repo_pr
            ON command_queue(repo_name, pr_number, status)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_command_queue_status
            ON command_queue(status, extracted_at)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_pr_memos_repo_pr
            ON pr_memos(repo_name, pr_number)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_branch_memory_repo_branch
            ON branch_memory(repo_name, branch_name)
        """
        )

        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_branch_timing_repo_branch
            ON branch_timing(repo_name, branch_name, operation)
        """
        )

    # Repository Operations

    async def save_repository(
        self, name: str, path: str, default_branch: str | None = None
    ) -> None:
        """Save or update repository metadata."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO repositories (name, path, default_branch, last_updated)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    path = excluded.path,
                    default_branch = excluded.default_branch,
                    last_updated = excluded.last_updated
            """,
                (name, path, default_branch, datetime.now(UTC)),
            )

    async def get_repository(self, name: str) -> dict[str, Any] | None:
        """Get repository metadata by name."""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT * FROM repositories WHERE name = ?", (name,))
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def get_all_repositories(self) -> list[dict[str, Any]]:
        """Get all repositories."""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT * FROM repositories ORDER BY name")
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    # Project Metadata Operations

    async def get_project_metadata(self) -> dict[str, Any]:
        """
        Get project metadata including project_id and flexible metadata.

        Returns:
            Dict with project_id (str|None) and metadata (dict)
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT project_id, metadata, created_at, updated_at FROM project_metadata WHERE id = 1"
            )
            row = await cursor.fetchone()
            if row:
                return {
                    "project_id": row["project_id"],
                    "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            return {"project_id": None, "metadata": {}, "created_at": None, "updated_at": None}

    async def set_project_metadata(
        self,
        project_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        merge: bool = True,
    ) -> None:
        """
        Set project metadata.

        Args:
            project_id: Optional project identifier string
            metadata: Optional dict of flexible metadata (stored as JSON)
            merge: If True, merge with existing metadata. If False, replace entirely.
        """
        async with self._get_connection() as conn:
            # Get existing metadata if merging
            existing_metadata: dict[str, Any] = {}
            if merge and metadata is not None:
                cursor = await conn.execute("SELECT metadata FROM project_metadata WHERE id = 1")
                row = await cursor.fetchone()
                if row and row["metadata"]:
                    existing_metadata = json.loads(row["metadata"])

            # Prepare the new metadata
            if metadata is not None:
                if merge:
                    existing_metadata.update(metadata)
                    final_metadata = existing_metadata
                else:
                    final_metadata = metadata
            else:
                final_metadata = existing_metadata

            # Update or insert
            if project_id is not None:
                await conn.execute(
                    """
                    INSERT INTO project_metadata (id, project_id, metadata, updated_at)
                    VALUES (1, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        project_id = excluded.project_id,
                        metadata = excluded.metadata,
                        updated_at = excluded.updated_at
                """,
                    (project_id, json.dumps(final_metadata, ensure_ascii=False), datetime.now(UTC)),
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO project_metadata (id, metadata, updated_at)
                    VALUES (1, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        metadata = excluded.metadata,
                        updated_at = excluded.updated_at
                """,
                    (json.dumps(final_metadata, ensure_ascii=False), datetime.now(UTC)),
                )

    async def update_project_metadata(self, key: str, value: Any) -> None:
        """
        Update a single key in project metadata.

        Args:
            key: The metadata key to update
            value: The value to set (will be JSON-serialized)
        """
        await self.set_project_metadata(metadata={key: value}, merge=True)

    async def delete_project_metadata_key(self, key: str) -> bool:
        """
        Delete a single key from project metadata.

        Args:
            key: The metadata key to delete

        Returns:
            True if key was deleted, False if key didn't exist
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT metadata FROM project_metadata WHERE id = 1")
            row = await cursor.fetchone()
            if row and row["metadata"]:
                metadata = json.loads(row["metadata"])
                if key in metadata:
                    del metadata[key]
                    await conn.execute(
                        """
                        UPDATE project_metadata
                        SET metadata = ?, updated_at = ?
                        WHERE id = 1
                    """,
                        (json.dumps(metadata, ensure_ascii=False), datetime.now(UTC)),
                    )
                    return True
            return False

    # Pull Request Operations

    async def save_pr_snapshot(self, repo_name: str, pr_data: dict[str, Any]) -> None:
        """Save a snapshot of a PR's state."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO pull_requests (
                    repo_name, pr_number, title, state, head_branch, base_branch,
                    author, draft, ci_status, labels, created_at, updated_at, snapshot_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
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
                ),
            )

    async def get_latest_pr_snapshot(self, repo_name: str, pr_number: int) -> dict[str, Any] | None:
        """Get the latest snapshot of a specific PR."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT * FROM pull_requests
                WHERE repo_name = ? AND pr_number = ?
                ORDER BY snapshot_time DESC
                LIMIT 1
            """,
                (repo_name, pr_number),
            )
            row = await cursor.fetchone()
            if row:
                data = dict(row)
                data["labels"] = json.loads(data["labels"]) if data["labels"] else []
                return data
            return None

    async def get_active_prs(self, repo_name: str) -> list[dict[str, Any]]:
        """Get all active PRs for a repository (latest snapshots only)."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
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
            """,
                (repo_name,),
            )
            results = []
            async for row in cursor:
                data = dict(row)
                data["labels"] = json.loads(data["labels"]) if data["labels"] else []
                results.append(data)
            return results

    async def get_all_prs(
        self, repo_name: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """Get all PR snapshots, optionally filtered by repo."""
        async with self._get_connection() as conn:
            if repo_name:
                cursor = await conn.execute(
                    """
                    SELECT DISTINCT repo_name, pr_number, title, state, head_branch,
                           base_branch, author, draft, ci_status, labels,
                           MAX(snapshot_time) as snapshot_time
                    FROM pull_requests
                    WHERE repo_name = ?
                    GROUP BY repo_name, pr_number
                    ORDER BY pr_number DESC
                    LIMIT ?
                """,
                    (repo_name, limit),
                )
            else:
                cursor = await conn.execute(
                    """
                    SELECT DISTINCT repo_name, pr_number, title, state, head_branch,
                           base_branch, author, draft, ci_status, labels,
                           MAX(snapshot_time) as snapshot_time
                    FROM pull_requests
                    GROUP BY repo_name, pr_number
                    ORDER BY snapshot_time DESC
                    LIMIT ?
                """,
                    (limit,),
                )
            results = []
            async for row in cursor:
                data = dict(row)
                data["labels"] = json.loads(data["labels"]) if data["labels"] else []
                results.append(data)
            return results

    # PR Context Operations

    async def save_pr_context(self, context: PRContext) -> None:
        """
        Save complete PR context for offline processing.

        Args:
            context: PRContext object with all PR data
        """
        # Size limits (prevent excessive database growth)
        MAX_DIFF_SIZE = 10 * 1024 * 1024  # 10MB
        diff = context.diff
        if len(diff) > MAX_DIFF_SIZE:
            diff = (
                diff[:MAX_DIFF_SIZE]
                + f"\n\n... [Diff truncated - original size: {len(context.diff)} bytes]"
            )

        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO pr_context (
                    repo_name, pr_number, pr_url, diff, body,
                    comments, review_comments, commits, files,
                    conflicts, ci_checks, guidelines, commit_examples, captured_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    context.repo_name,
                    context.pr_number,
                    context.pr_url,
                    diff,
                    context.body,
                    json.dumps(context.comments, ensure_ascii=False),
                    json.dumps(context.review_comments, ensure_ascii=False),
                    json.dumps(context.commits, ensure_ascii=False),
                    json.dumps(context.files, ensure_ascii=False),
                    json.dumps(context.conflicts, ensure_ascii=False),
                    json.dumps(context.ci_checks, ensure_ascii=False),
                    context.guidelines,
                    context.commit_examples,
                    datetime.now(UTC),
                ),
            )

    async def get_latest_pr_context(self, repo_name: str, pr_number: int) -> PRContext | None:
        """Get the latest complete PR context."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT * FROM pr_context
                WHERE repo_name = ? AND pr_number = ?
                ORDER BY captured_at DESC
                LIMIT 1
            """,
                (repo_name, pr_number),
            )
            row = await cursor.fetchone()
            if row:
                data = dict(row)
                return PRContext(
                    repo_name=data["repo_name"],
                    pr_number=data["pr_number"],
                    pr_url=data.get("pr_url", ""),
                    diff=data.get("diff", ""),
                    body=data.get("body", ""),
                    comments=json.loads(data["comments"]) if data.get("comments") else [],
                    review_comments=json.loads(data["review_comments"])
                    if data.get("review_comments")
                    else [],
                    commits=json.loads(data["commits"]) if data.get("commits") else [],
                    files=json.loads(data["files"]) if data.get("files") else [],
                    conflicts=json.loads(data["conflicts"]) if data.get("conflicts") else {},
                    ci_checks=json.loads(data["ci_checks"]) if data.get("ci_checks") else {},
                    guidelines=data.get("guidelines", ""),
                    commit_examples=data.get("commit_examples", ""),
                    captured_at=datetime.fromisoformat(data["captured_at"])
                    if data.get("captured_at")
                    else None,
                )
            return None

    async def get_all_pr_contexts(self, repo_name: str | None = None) -> list[PRContext]:
        """Get all PR contexts, optionally filtered by repo."""
        async with self._get_connection() as conn:
            if repo_name:
                cursor = await conn.execute(
                    """
                    SELECT * FROM pr_context
                    WHERE repo_name = ?
                    AND captured_at = (
                        SELECT MAX(captured_at)
                        FROM pr_context pc2
                        WHERE pc2.repo_name = pr_context.repo_name
                        AND pc2.pr_number = pr_context.pr_number
                    )
                    ORDER BY pr_number
                """,
                    (repo_name,),
                )
            else:
                cursor = await conn.execute(
                    """
                    SELECT * FROM pr_context
                    WHERE captured_at = (
                        SELECT MAX(captured_at)
                        FROM pr_context pc2
                        WHERE pc2.repo_name = pr_context.repo_name
                        AND pc2.pr_number = pr_context.pr_number
                    )
                    ORDER BY repo_name, pr_number
                """
                )

            results = []
            async for row in cursor:
                data = dict(row)
                results.append(
                    PRContext(
                        repo_name=data["repo_name"],
                        pr_number=data["pr_number"],
                        pr_url=data.get("pr_url", ""),
                        diff=data.get("diff", ""),
                        body=data.get("body", ""),
                        comments=json.loads(data["comments"]) if data.get("comments") else [],
                        review_comments=json.loads(data["review_comments"])
                        if data.get("review_comments")
                        else [],
                        commits=json.loads(data["commits"]) if data.get("commits") else [],
                        files=json.loads(data["files"]) if data.get("files") else [],
                        conflicts=json.loads(data["conflicts"]) if data.get("conflicts") else {},
                        ci_checks=json.loads(data["ci_checks"]) if data.get("ci_checks") else {},
                        guidelines=data.get("guidelines", ""),
                        commit_examples=data.get("commit_examples", ""),
                        captured_at=datetime.fromisoformat(data["captured_at"])
                        if data.get("captured_at")
                        else None,
                    )
                )
            return results

    # Branch State Operations

    async def save_branch_state(
        self,
        repo_name: str,
        branch_name: str,
        is_local: bool = False,
        is_remote: bool = False,
        ahead_by: int = 0,
        behind_by: int = 0,
        has_pr: bool = False,
        pr_number: int | None = None,
        needs_sync: bool = False,
    ) -> None:
        """Save a branch state snapshot."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO branch_states (
                    repo_name, branch_name, is_local, is_remote,
                    ahead_by, behind_by, has_pr, pr_number, needs_sync, snapshot_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    repo_name,
                    branch_name,
                    1 if is_local else 0,
                    1 if is_remote else 0,
                    ahead_by,
                    behind_by,
                    1 if has_pr else 0,
                    pr_number,
                    1 if needs_sync else 0,
                    datetime.now(UTC),
                ),
            )

    async def save_repository_state(self, repo_name: str, repo_state: RepositoryState) -> None:
        """Save complete repository state snapshot."""
        snapshot_time = datetime.now(UTC)

        async with self._get_connection() as conn:
            # Save repository metadata
            await conn.execute(
                """
                INSERT INTO repositories (name, path, default_branch, last_updated)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    path = excluded.path,
                    default_branch = excluded.default_branch,
                    last_updated = excluded.last_updated
            """,
                (repo_name, repo_state.repo_path, repo_state.default_branch, snapshot_time),
            )

            # Save branch states
            for branch_state in repo_state.branch_pr_states:
                await conn.execute(
                    """
                    INSERT INTO branch_states (
                        repo_name, branch_name, is_local, is_remote,
                        ahead_by, behind_by, has_pr, pr_number, needs_sync, snapshot_time
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
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
                    ),
                )

                # Save PR snapshot if exists
                if branch_state.pr:
                    pr = branch_state.pr
                    await conn.execute(
                        """
                        INSERT INTO pull_requests (
                            repo_name, pr_number, title, state, head_branch, base_branch,
                            author, draft, ci_status, labels, created_at, updated_at, snapshot_time
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                        (
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
                            pr.created_at.isoformat() if pr.created_at else None,
                            pr.updated_at.isoformat() if pr.updated_at else None,
                            snapshot_time,
                        ),
                    )

    # Sync History Operations

    async def record_sync_start(self, repo_name: str, sync_type: str = "full") -> int:
        """Record the start of a sync operation. Returns the record ID."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO sync_history (repo_name, sync_type, started_at)
                VALUES (?, ?, ?)
            """,
                (repo_name, sync_type, datetime.now(UTC)),
            )
            return cursor.lastrowid or 0

    async def record_sync_complete(
        self,
        record_id: int,
        success: bool,
        error_message: str | None = None,
        prs_synced: int = 0,
        branches_synced: int = 0,
    ) -> None:
        """Record the completion of a sync operation."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE sync_history
                SET completed_at = ?,
                    success = ?,
                    error_message = ?,
                    prs_synced = ?,
                    branches_synced = ?
                WHERE id = ?
            """,
                (
                    datetime.now(UTC),
                    1 if success else 0,
                    error_message,
                    prs_synced,
                    branches_synced,
                    record_id,
                ),
            )

    # Cleanup Operations

    async def cleanup_old_snapshots(self, days: int = 7) -> int:
        """Remove snapshots older than specified days. Returns count deleted."""
        async with self._get_connection() as conn:
            cutoff = datetime.now(UTC).timestamp() - (days * 86400)

            cursor = await conn.execute(
                """
                DELETE FROM pull_requests
                WHERE snapshot_time < datetime(?, 'unixepoch')
            """,
                (cutoff,),
            )
            pr_deleted = cursor.rowcount

            cursor = await conn.execute(
                """
                DELETE FROM branch_states
                WHERE snapshot_time < datetime(?, 'unixepoch')
            """,
                (cutoff,),
            )
            branch_deleted = cursor.rowcount

            cursor = await conn.execute(
                """
                DELETE FROM pr_context
                WHERE captured_at < datetime(?, 'unixepoch')
            """,
                (cutoff,),
            )
            context_deleted = cursor.rowcount

            return pr_deleted + branch_deleted + context_deleted

    async def get_schema_info(self) -> dict[str, Any]:
        """Get schema version and migration information."""
        async with self._get_connection() as conn:
            current_version = await self._get_schema_version(conn)
            return {
                "current_version": current_version,
                "latest_version": SCHEMA_VERSION,
                "needs_migration": current_version < SCHEMA_VERSION,
                "is_newer": current_version > SCHEMA_VERSION,
            }

    async def get_statistics(self) -> dict[str, Any]:
        """Get overall database statistics."""
        async with self._get_connection() as conn:
            stats: dict[str, Any] = {}

            # Add schema version
            stats["schema_version"] = await self._get_schema_version(conn)

            # Add project_id if set
            cursor = await conn.execute("SELECT project_id FROM project_metadata WHERE id = 1")
            row = await cursor.fetchone()
            stats["project_id"] = row["project_id"] if row else None

            cursor = await conn.execute("SELECT COUNT(*) as count FROM repositories")
            row = await cursor.fetchone()
            stats["repositories"] = row["count"] if row else 0

            cursor = await conn.execute("SELECT COUNT(*) as count FROM pull_requests")
            row = await cursor.fetchone()
            stats["pr_snapshots"] = row["count"] if row else 0

            cursor = await conn.execute("SELECT COUNT(*) as count FROM pr_context")
            row = await cursor.fetchone()
            stats["pr_contexts"] = row["count"] if row else 0

            cursor = await conn.execute("SELECT COUNT(*) as count FROM branch_states")
            row = await cursor.fetchone()
            stats["branch_snapshots"] = row["count"] if row else 0

            cursor = await conn.execute(
                """
                SELECT
                    SUM(success) as successes,
                    COUNT(*) as total
                FROM sync_history
                WHERE completed_at IS NOT NULL
            """
            )
            row = await cursor.fetchone()
            if row and row["total"] and row["total"] > 0:
                stats["sync_success_rate"] = round(row["successes"] / row["total"] * 100, 2)
            else:
                stats["sync_success_rate"] = 0.0

            cursor = await conn.execute(
                "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"
            )
            row = await cursor.fetchone()
            stats["database_size_bytes"] = row["size"] if row else 0

            return stats

    # Export helpers for artifact generation

    async def export_all_data(self) -> dict[str, Any]:
        """Export all database content for artifact generation."""
        repositories = await self.get_all_repositories()
        prs = await self.get_all_prs()
        contexts = await self.get_all_pr_contexts()
        stats = await self.get_statistics()

        return {
            "repositories": repositories,
            "pull_requests": prs,
            "pr_contexts": [ctx.to_dict() for ctx in contexts],
            "statistics": stats,
            "exported_at": datetime.now(UTC).isoformat(),
        }

    # ==========================================================================
    # Command Queue Operations
    # ==========================================================================

    async def queue_command(
        self,
        repo_name: str,
        pr_number: int,
        command: str,
        comment_id: int,
        comment_author: str,
        comment_body: str,
        extracted_at: datetime,
        dependency: str | None = None,
    ) -> int:
        """
        Queue a command for execution.

        Args:
            repo_name: Repository name
            pr_number: PR number
            command: Command value (e.g., "merge", "rebase")
            comment_id: Source comment ID
            comment_author: Comment author
            comment_body: Comment body text
            extracted_at: When the command was extracted
            dependency: Optional dependency name (for show ignore conditions)

        Returns:
            ID of the queued command
        """
        async with self._get_connection() as conn:
            # Check if this command from this comment already exists
            cursor = await conn.execute(
                """
                SELECT id FROM command_queue
                WHERE repo_name = ? AND pr_number = ? AND command = ? AND comment_id = ?
                """,
                (repo_name, pr_number, command, comment_id),
            )
            existing = await cursor.fetchone()
            if existing:
                return existing["id"]

            cursor = await conn.execute(
                """
                INSERT INTO command_queue
                (repo_name, pr_number, command, comment_id, comment_author, comment_body, dependency, extracted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    repo_name,
                    pr_number,
                    command,
                    comment_id,
                    comment_author,
                    comment_body,
                    dependency,
                    extracted_at,
                ),
            )
            return cursor.lastrowid or 0

    async def get_pending_commands(
        self, repo_name: str | None = None, pr_number: int | None = None
    ) -> list[dict[str, Any]]:
        """Get pending commands, optionally filtered by repo/PR."""
        async with self._get_connection() as conn:
            query = "SELECT * FROM command_queue WHERE status = 'pending'"
            params: list[Any] = []

            if repo_name:
                query += " AND repo_name = ?"
                params.append(repo_name)

            if pr_number:
                query += " AND pr_number = ?"
                params.append(pr_number)

            query += " ORDER BY extracted_at ASC"

            cursor = await conn.execute(query, params)
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def update_command_status(
        self,
        command_id: int,
        status: str,
        result_message: str | None = None,
        success: bool | None = None,
        error_type: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """Update the status of a queued command."""
        async with self._get_connection() as conn:
            if status in ("completed", "failed"):
                await conn.execute(
                    """
                    UPDATE command_queue
                    SET status = ?, result_message = ?, completed_at = ?,
                        success = ?, error_type = ?, error_message = ?
                    WHERE id = ?
                    """,
                    (
                        status,
                        result_message,
                        datetime.now(UTC),
                        1 if success else 0 if success is not None else None,
                        error_type,
                        error_message,
                        command_id,
                    ),
                )
            else:
                await conn.execute(
                    """
                    UPDATE command_queue
                    SET status = ?, result_message = ?
                    WHERE id = ?
                    """,
                    (status, result_message, command_id),
                )

    async def get_command_history(
        self, repo_name: str, pr_number: int | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """Get command history for a repo or PR."""
        async with self._get_connection() as conn:
            if pr_number:
                cursor = await conn.execute(
                    """
                    SELECT * FROM command_queue
                    WHERE repo_name = ? AND pr_number = ?
                    ORDER BY extracted_at DESC
                    LIMIT ?
                    """,
                    (repo_name, pr_number, limit),
                )
            else:
                cursor = await conn.execute(
                    """
                    SELECT * FROM command_queue
                    WHERE repo_name = ?
                    ORDER BY extracted_at DESC
                    LIMIT ?
                    """,
                    (repo_name, limit),
                )
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def start_command_execution(self, command_id: int) -> None:
        """
        Mark a command as executing and record start time.

        Args:
            command_id: ID of the command to start
        """
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE command_queue
                SET status = 'executing', started_at = ?
                WHERE id = ?
                """,
                (datetime.now(UTC), command_id),
            )

    async def complete_command_execution(
        self,
        command_id: int,
        success: bool,
        result_message: str | None = None,
        error_type: str | None = None,
        error_message: str | None = None,
    ) -> int:
        """
        Complete a command execution with timing and result.

        Automatically calculates duration from started_at.

        Args:
            command_id: ID of the command
            success: Whether execution succeeded
            result_message: Human-readable result message
            error_type: Type of error (e.g., "PreconditionError", "APIError")
            error_message: Detailed error message

        Returns:
            Duration in milliseconds
        """
        completed_at = datetime.now(UTC)
        async with self._get_connection() as conn:
            # Get started_at to calculate duration
            cursor = await conn.execute(
                "SELECT started_at FROM command_queue WHERE id = ?",
                (command_id,),
            )
            row = await cursor.fetchone()

            duration_ms = 0
            if row and row["started_at"]:
                started_at = datetime.fromisoformat(row["started_at"])
                duration_ms = int((completed_at - started_at).total_seconds() * 1000)

            status = "completed" if success else "failed"
            await conn.execute(
                """
                UPDATE command_queue
                SET status = ?, completed_at = ?, duration_ms = ?,
                    success = ?, error_type = ?, error_message = ?, result_message = ?
                WHERE id = ?
                """,
                (
                    status,
                    completed_at,
                    duration_ms,
                    1 if success else 0,
                    error_type,
                    error_message,
                    result_message,
                    command_id,
                ),
            )
            return duration_ms

    async def increment_retry_count(self, command_id: int) -> int:
        """Increment retry count for a command. Returns new count."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE command_queue
                SET retry_count = retry_count + 1, status = 'pending'
                WHERE id = ?
                """,
                (command_id,),
            )
            cursor = await conn.execute(
                "SELECT retry_count FROM command_queue WHERE id = ?",
                (command_id,),
            )
            row = await cursor.fetchone()
            return row["retry_count"] if row else 0

    async def get_command_execution_stats(
        self,
        repo_name: str | None = None,
        command: str | None = None,
    ) -> dict[str, Any]:
        """
        Get execution statistics for commands.

        Args:
            repo_name: Optional filter by repository
            command: Optional filter by command type

        Returns:
            Dict with avg_duration_ms, min_duration_ms, max_duration_ms,
            total_count, success_count, failure_count, success_rate
        """
        async with self._get_connection() as conn:
            query = """
                SELECT
                    AVG(duration_ms) as avg_duration_ms,
                    MIN(duration_ms) as min_duration_ms,
                    MAX(duration_ms) as max_duration_ms,
                    COUNT(*) as total_count,
                    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count
                FROM command_queue
                WHERE completed_at IS NOT NULL
            """
            params: list[Any] = []

            if repo_name:
                query += " AND repo_name = ?"
                params.append(repo_name)

            if command:
                query += " AND command = ?"
                params.append(command)

            cursor = await conn.execute(query, params)
            row = await cursor.fetchone()

            if row and row["total_count"] > 0:
                return {
                    "avg_duration_ms": row["avg_duration_ms"] or 0,
                    "min_duration_ms": row["min_duration_ms"] or 0,
                    "max_duration_ms": row["max_duration_ms"] or 0,
                    "total_count": row["total_count"],
                    "success_count": row["success_count"] or 0,
                    "failure_count": row["failure_count"] or 0,
                    "success_rate": (row["success_count"] / row["total_count"]) * 100
                    if row["total_count"] > 0
                    else 0,
                }

            return {
                "avg_duration_ms": 0,
                "min_duration_ms": 0,
                "max_duration_ms": 0,
                "total_count": 0,
                "success_count": 0,
                "failure_count": 0,
                "success_rate": 0,
            }

    async def get_failed_commands(
        self, repo_name: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """Get failed commands for debugging/retry."""
        async with self._get_connection() as conn:
            if repo_name:
                cursor = await conn.execute(
                    """
                    SELECT * FROM command_queue
                    WHERE status = 'failed' AND repo_name = ?
                    ORDER BY completed_at DESC
                    LIMIT ?
                    """,
                    (repo_name, limit),
                )
            else:
                cursor = await conn.execute(
                    """
                    SELECT * FROM command_queue
                    WHERE status = 'failed'
                    ORDER BY completed_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                )
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    # ==========================================================================
    # PR Memos (Shadow Memory) Operations
    # ==========================================================================

    async def set_memo(
        self,
        repo_name: str,
        pr_number: int,
        memo_type: str,
        content: str,
    ) -> None:
        """
        Set or update a memo for a PR.

        Memo types can be anything, common ones:
        - "todo": Bot's todo list for this PR
        - "plan": Bot's execution plan
        - "notes": General notes
        - "context": Cached context/summary

        Args:
            repo_name: Repository name
            pr_number: PR number
            memo_type: Type of memo (e.g., "todo", "plan", "notes")
            content: Memo content (typically JSON or plain text)
        """
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO pr_memos (repo_name, pr_number, memo_type, content, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(repo_name, pr_number, memo_type) DO UPDATE SET
                    content = excluded.content,
                    updated_at = excluded.updated_at
                """,
                (repo_name, pr_number, memo_type, content, datetime.now(UTC)),
            )

    async def get_memo(
        self, repo_name: str, pr_number: int, memo_type: str
    ) -> str | None:
        """Get a specific memo for a PR."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT content FROM pr_memos
                WHERE repo_name = ? AND pr_number = ? AND memo_type = ?
                """,
                (repo_name, pr_number, memo_type),
            )
            row = await cursor.fetchone()
            return row["content"] if row else None

    async def get_all_memos(
        self, repo_name: str, pr_number: int
    ) -> dict[str, str]:
        """Get all memos for a PR as a dict of memo_type -> content."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT memo_type, content FROM pr_memos
                WHERE repo_name = ? AND pr_number = ?
                """,
                (repo_name, pr_number),
            )
            rows = await cursor.fetchall()
            return {row["memo_type"]: row["content"] for row in rows}

    async def delete_memo(
        self, repo_name: str, pr_number: int, memo_type: str
    ) -> bool:
        """Delete a specific memo. Returns True if deleted."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                DELETE FROM pr_memos
                WHERE repo_name = ? AND pr_number = ? AND memo_type = ?
                """,
                (repo_name, pr_number, memo_type),
            )
            return cursor.rowcount > 0

    async def delete_all_memos(self, repo_name: str, pr_number: int) -> int:
        """Delete all memos for a PR. Returns count deleted."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                DELETE FROM pr_memos
                WHERE repo_name = ? AND pr_number = ?
                """,
                (repo_name, pr_number),
            )
            return cursor.rowcount

    # ==========================================================================
    # Global Memory Operations
    # ==========================================================================

    async def set_global(self, key: str, value: str) -> None:
        """Set a global memory value."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO global_memory (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, value, datetime.now(UTC)),
            )

    async def get_global(self, key: str) -> str | None:
        """Get a global memory value."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT value FROM global_memory WHERE key = ?",
                (key,),
            )
            row = await cursor.fetchone()
            return row["value"] if row else None

    async def get_all_global(self) -> dict[str, str]:
        """Get all global memory values."""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT key, value FROM global_memory")
            rows = await cursor.fetchall()
            return {row["key"]: row["value"] for row in rows}

    async def delete_global(self, key: str) -> bool:
        """Delete a global memory value. Returns True if deleted."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "DELETE FROM global_memory WHERE key = ?",
                (key,),
            )
            return cursor.rowcount > 0

    # ==========================================================================
    # Branch Memory Operations
    # ==========================================================================

    async def set_branch_memory(
        self, repo_name: str, branch_name: str, key: str, value: str
    ) -> None:
        """Set a branch memory value."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO branch_memory (repo_name, branch_name, key, value, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(repo_name, branch_name, key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (repo_name, branch_name, key, value, datetime.now(UTC)),
            )

    async def get_branch_memory(
        self, repo_name: str, branch_name: str, key: str
    ) -> str | None:
        """Get a branch memory value."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT value FROM branch_memory
                WHERE repo_name = ? AND branch_name = ? AND key = ?
                """,
                (repo_name, branch_name, key),
            )
            row = await cursor.fetchone()
            return row["value"] if row else None

    async def get_all_branch_memory(
        self, repo_name: str, branch_name: str
    ) -> dict[str, str]:
        """Get all memory values for a branch."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT key, value FROM branch_memory
                WHERE repo_name = ? AND branch_name = ?
                """,
                (repo_name, branch_name),
            )
            rows = await cursor.fetchall()
            return {row["key"]: row["value"] for row in rows}

    async def delete_branch_memory(
        self, repo_name: str, branch_name: str, key: str
    ) -> bool:
        """Delete a branch memory value. Returns True if deleted."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                DELETE FROM branch_memory
                WHERE repo_name = ? AND branch_name = ? AND key = ?
                """,
                (repo_name, branch_name, key),
            )
            return cursor.rowcount > 0

    async def delete_all_branch_memory(
        self, repo_name: str, branch_name: str
    ) -> int:
        """Delete all memory for a branch. Returns count deleted."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                DELETE FROM branch_memory
                WHERE repo_name = ? AND branch_name = ?
                """,
                (repo_name, branch_name),
            )
            return cursor.rowcount

    # ==========================================================================
    # Branch Timing Operations
    # ==========================================================================

    async def record_branch_timing(
        self,
        repo_name: str,
        branch_name: str,
        operation: str,
        started_at: datetime,
        completed_at: datetime | None = None,
        success: bool = True,
        metadata: str | None = None,
    ) -> int:
        """
        Record timing information for a branch operation.

        Args:
            repo_name: Repository name
            branch_name: Branch name
            operation: Operation type (e.g., "checkout", "push", "rebase", "build")
            started_at: When the operation started
            completed_at: When the operation completed (None if still running)
            success: Whether the operation succeeded
            metadata: Optional JSON metadata

        Returns:
            ID of the timing record
        """
        duration_ms = None
        if completed_at:
            duration_ms = int((completed_at - started_at).total_seconds() * 1000)

        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO branch_timing
                (repo_name, branch_name, operation, started_at, completed_at, duration_ms, success, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    repo_name,
                    branch_name,
                    operation,
                    started_at,
                    completed_at,
                    duration_ms,
                    1 if success else 0,
                    metadata,
                ),
            )
            return cursor.lastrowid or 0

    async def complete_branch_timing(
        self,
        timing_id: int,
        success: bool = True,
        metadata: str | None = None,
    ) -> None:
        """Mark a timing record as complete."""
        completed_at = datetime.now(UTC)
        async with self._get_connection() as conn:
            # Get started_at to calculate duration
            cursor = await conn.execute(
                "SELECT started_at FROM branch_timing WHERE id = ?",
                (timing_id,),
            )
            row = await cursor.fetchone()
            if row:
                started_at = datetime.fromisoformat(row["started_at"])
                duration_ms = int((completed_at - started_at).total_seconds() * 1000)

                await conn.execute(
                    """
                    UPDATE branch_timing
                    SET completed_at = ?, duration_ms = ?, success = ?, metadata = COALESCE(?, metadata)
                    WHERE id = ?
                    """,
                    (completed_at, duration_ms, 1 if success else 0, metadata, timing_id),
                )

    async def get_branch_timing(
        self,
        repo_name: str,
        branch_name: str,
        operation: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Get timing records for a branch."""
        async with self._get_connection() as conn:
            if operation:
                cursor = await conn.execute(
                    """
                    SELECT * FROM branch_timing
                    WHERE repo_name = ? AND branch_name = ? AND operation = ?
                    ORDER BY started_at DESC
                    LIMIT ?
                    """,
                    (repo_name, branch_name, operation, limit),
                )
            else:
                cursor = await conn.execute(
                    """
                    SELECT * FROM branch_timing
                    WHERE repo_name = ? AND branch_name = ?
                    ORDER BY started_at DESC
                    LIMIT ?
                    """,
                    (repo_name, branch_name, limit),
                )
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def get_average_timing(
        self,
        repo_name: str,
        branch_name: str | None = None,
        operation: str | None = None,
    ) -> dict[str, float]:
        """
        Get average timing statistics.

        Returns dict with avg_duration_ms, min_duration_ms, max_duration_ms, count.
        """
        async with self._get_connection() as conn:
            query = """
                SELECT
                    AVG(duration_ms) as avg_duration_ms,
                    MIN(duration_ms) as min_duration_ms,
                    MAX(duration_ms) as max_duration_ms,
                    COUNT(*) as count,
                    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
                FROM branch_timing
                WHERE repo_name = ? AND completed_at IS NOT NULL
            """
            params: list[Any] = [repo_name]

            if branch_name:
                query += " AND branch_name = ?"
                params.append(branch_name)

            if operation:
                query += " AND operation = ?"
                params.append(operation)

            cursor = await conn.execute(query, params)
            row = await cursor.fetchone()

            if row and row["count"] > 0:
                return {
                    "avg_duration_ms": row["avg_duration_ms"] or 0,
                    "min_duration_ms": row["min_duration_ms"] or 0,
                    "max_duration_ms": row["max_duration_ms"] or 0,
                    "count": row["count"],
                    "success_rate": (row["successes"] / row["count"]) * 100 if row["count"] > 0 else 0,
                }

            return {
                "avg_duration_ms": 0,
                "min_duration_ms": 0,
                "max_duration_ms": 0,
                "count": 0,
                "success_rate": 0,
            }

    # ==========================================================================
    # Workflow Operations (Multi-step LLM Operations)
    # ==========================================================================

    async def create_workflow(
        self,
        workflow_type: str,
        repo_name: str,
        branch_name: str | None = None,
        pr_number: int | None = None,
        context: dict[str, Any] | None = None,
    ) -> int:
        """
        Create a new workflow for tracking multi-step operations.

        Common workflow types:
        - "merge": Merge operation (fetch, merge, resolve conflicts, push)
        - "rebase": Rebase operation
        - "pr_review": Review and address PR feedback
        - "ci_fix": Fix CI failures

        Args:
            workflow_type: Type of workflow (e.g., "merge", "rebase")
            repo_name: Repository name
            branch_name: Optional branch name
            pr_number: Optional PR number
            context: Initial context dict (stored as JSON)

        Returns:
            Workflow ID
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO workflows
                (workflow_type, repo_name, branch_name, pr_number, context, status)
                VALUES (?, ?, ?, ?, ?, 'created')
                """,
                (
                    workflow_type,
                    repo_name,
                    branch_name,
                    pr_number,
                    json.dumps(context or {}, ensure_ascii=False),
                ),
            )
            return cursor.lastrowid or 0

    async def start_workflow(self, workflow_id: int) -> None:
        """Mark a workflow as started."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE workflows
                SET status = 'running', started_at = ?
                WHERE id = ?
                """,
                (datetime.now(UTC), workflow_id),
            )

    async def update_workflow_step(
        self, workflow_id: int, current_step: str
    ) -> None:
        """Update the current step of a workflow."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE workflows
                SET current_step = ?
                WHERE id = ?
                """,
                (current_step, workflow_id),
            )

    async def update_workflow_context(
        self, workflow_id: int, context: dict[str, Any], merge: bool = True
    ) -> None:
        """Update workflow context."""
        async with self._get_connection() as conn:
            if merge:
                cursor = await conn.execute(
                    "SELECT context FROM workflows WHERE id = ?",
                    (workflow_id,),
                )
                row = await cursor.fetchone()
                existing = json.loads(row["context"]) if row and row["context"] else {}
                existing.update(context)
                context = existing

            await conn.execute(
                """
                UPDATE workflows
                SET context = ?
                WHERE id = ?
                """,
                (json.dumps(context, ensure_ascii=False), workflow_id),
            )

    async def pause_workflow(self, workflow_id: int, reason: str | None = None) -> None:
        """Pause a workflow (e.g., waiting for user input)."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE workflows
                SET status = 'paused', current_step = ?
                WHERE id = ?
                """,
                (reason or "paused", workflow_id),
            )

    async def resume_workflow(self, workflow_id: int) -> None:
        """Resume a paused workflow."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE workflows
                SET status = 'running'
                WHERE id = ?
                """,
                (workflow_id,),
            )

    async def complete_workflow(
        self,
        workflow_id: int,
        success: bool,
        result: str | None = None,
        error_type: str | None = None,
        error_message: str | None = None,
    ) -> int:
        """
        Complete a workflow with result.

        Returns:
            Duration in milliseconds
        """
        completed_at = datetime.now(UTC)
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT started_at FROM workflows WHERE id = ?",
                (workflow_id,),
            )
            row = await cursor.fetchone()

            duration_ms = 0
            if row and row["started_at"]:
                started_at = datetime.fromisoformat(row["started_at"])
                duration_ms = int((completed_at - started_at).total_seconds() * 1000)

            status = "completed" if success else "failed"
            await conn.execute(
                """
                UPDATE workflows
                SET status = ?, completed_at = ?, duration_ms = ?,
                    success = ?, result = ?, error_type = ?, error_message = ?
                WHERE id = ?
                """,
                (
                    status,
                    completed_at,
                    duration_ms,
                    1 if success else 0,
                    result,
                    error_type,
                    error_message,
                    workflow_id,
                ),
            )
            return duration_ms

    async def get_workflow(self, workflow_id: int) -> dict[str, Any] | None:
        """Get a workflow by ID."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT * FROM workflows WHERE id = ?",
                (workflow_id,),
            )
            row = await cursor.fetchone()
            if row:
                data = dict(row)
                data["context"] = json.loads(data["context"]) if data["context"] else {}
                return data
            return None

    async def get_active_workflows(
        self, repo_name: str | None = None, workflow_type: str | None = None
    ) -> list[dict[str, Any]]:
        """Get active workflows (running or paused)."""
        async with self._get_connection() as conn:
            query = """
                SELECT * FROM workflows
                WHERE status IN ('created', 'running', 'paused')
            """
            params: list[Any] = []

            if repo_name:
                query += " AND repo_name = ?"
                params.append(repo_name)

            if workflow_type:
                query += " AND workflow_type = ?"
                params.append(workflow_type)

            query += " ORDER BY created_at DESC"

            cursor = await conn.execute(query, params)
            rows = await cursor.fetchall()
            results = []
            for row in rows:
                data = dict(row)
                data["context"] = json.loads(data["context"]) if data["context"] else {}
                results.append(data)
            return results

    # ==========================================================================
    # Workflow Step Operations
    # ==========================================================================

    async def add_workflow_step(
        self,
        workflow_id: int,
        step_name: str,
        step_order: int,
        input_data: dict[str, Any] | None = None,
    ) -> int:
        """
        Add a step to a workflow.

        Args:
            workflow_id: Parent workflow ID
            step_name: Name of the step (e.g., "fetch", "merge", "resolve_conflicts")
            step_order: Order of the step (1, 2, 3, ...)
            input_data: Input data for the step

        Returns:
            Step ID
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO workflow_steps
                (workflow_id, step_name, step_order, input_data)
                VALUES (?, ?, ?, ?)
                """,
                (
                    workflow_id,
                    step_name,
                    step_order,
                    json.dumps(input_data or {}, ensure_ascii=False),
                ),
            )
            return cursor.lastrowid or 0

    async def start_workflow_step(self, step_id: int) -> None:
        """Mark a workflow step as started."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE workflow_steps
                SET status = 'running', started_at = ?
                WHERE id = ?
                """,
                (datetime.now(UTC), step_id),
            )

    async def increment_step_tool_calls(self, step_id: int) -> int:
        """Increment tool call count for a step. Returns new count."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                UPDATE workflow_steps
                SET tool_calls = tool_calls + 1
                WHERE id = ?
                """,
                (step_id,),
            )
            cursor = await conn.execute(
                "SELECT tool_calls FROM workflow_steps WHERE id = ?",
                (step_id,),
            )
            row = await cursor.fetchone()
            return row["tool_calls"] if row else 0

    async def complete_workflow_step(
        self,
        step_id: int,
        success: bool,
        output_data: dict[str, Any] | None = None,
        error_type: str | None = None,
        error_message: str | None = None,
    ) -> int:
        """
        Complete a workflow step.

        Returns:
            Duration in milliseconds
        """
        completed_at = datetime.now(UTC)
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT started_at FROM workflow_steps WHERE id = ?",
                (step_id,),
            )
            row = await cursor.fetchone()

            duration_ms = 0
            if row and row["started_at"]:
                started_at = datetime.fromisoformat(row["started_at"])
                duration_ms = int((completed_at - started_at).total_seconds() * 1000)

            status = "completed" if success else "failed"
            await conn.execute(
                """
                UPDATE workflow_steps
                SET status = ?, completed_at = ?, duration_ms = ?,
                    success = ?, output_data = ?, error_type = ?, error_message = ?
                WHERE id = ?
                """,
                (
                    status,
                    completed_at,
                    duration_ms,
                    1 if success else 0,
                    json.dumps(output_data or {}, ensure_ascii=False),
                    error_type,
                    error_message,
                    step_id,
                ),
            )
            return duration_ms

    async def get_workflow_steps(self, workflow_id: int) -> list[dict[str, Any]]:
        """Get all steps for a workflow."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT * FROM workflow_steps
                WHERE workflow_id = ?
                ORDER BY step_order
                """,
                (workflow_id,),
            )
            rows = await cursor.fetchall()
            results = []
            for row in rows:
                data = dict(row)
                data["input_data"] = json.loads(data["input_data"]) if data["input_data"] else {}
                data["output_data"] = json.loads(data["output_data"]) if data["output_data"] else {}
                results.append(data)
            return results

    async def get_workflow_stats(
        self, repo_name: str | None = None, workflow_type: str | None = None
    ) -> dict[str, Any]:
        """Get workflow execution statistics."""
        async with self._get_connection() as conn:
            query = """
                SELECT
                    AVG(duration_ms) as avg_duration_ms,
                    MIN(duration_ms) as min_duration_ms,
                    MAX(duration_ms) as max_duration_ms,
                    COUNT(*) as total_count,
                    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count
                FROM workflows
                WHERE completed_at IS NOT NULL
            """
            params: list[Any] = []

            if repo_name:
                query += " AND repo_name = ?"
                params.append(repo_name)

            if workflow_type:
                query += " AND workflow_type = ?"
                params.append(workflow_type)

            cursor = await conn.execute(query, params)
            row = await cursor.fetchone()

            if row and row["total_count"] > 0:
                return {
                    "avg_duration_ms": row["avg_duration_ms"] or 0,
                    "min_duration_ms": row["min_duration_ms"] or 0,
                    "max_duration_ms": row["max_duration_ms"] or 0,
                    "total_count": row["total_count"],
                    "success_count": row["success_count"] or 0,
                    "failure_count": row["failure_count"] or 0,
                    "success_rate": (row["success_count"] / row["total_count"]) * 100
                    if row["total_count"] > 0
                    else 0,
                }

            return {
                "avg_duration_ms": 0,
                "min_duration_ms": 0,
                "max_duration_ms": 0,
                "total_count": 0,
                "success_count": 0,
                "failure_count": 0,
                "success_rate": 0,
            }
