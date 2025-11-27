"""
Async sync engine for orchestrating GitHub/Git sync operations.

This module provides the main orchestration layer that coordinates
between the Git client, GitHub client, and database.
"""

import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from github_sync.git_client import GitClient
from github_sync.github_client import GitHubClient
from github_sync.models import BranchPRState, PRContext, PullRequest, RepositoryState
from github_sync.sync_store import SyncStore


@dataclass
class SyncProgress:
    """Progress update during sync operation."""

    stage: str
    current: int
    total: int
    message: str
    timestamp: datetime = None  # type: ignore

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now(UTC)

    @property
    def percent(self) -> float:
        """Calculate percentage complete."""
        if self.total == 0:
            return 0.0
        return round(self.current / self.total * 100, 1)


@dataclass
class SyncResult:
    """Result of a sync operation."""

    success: bool
    repo_name: str
    prs_synced: int
    branches_synced: int
    contexts_synced: int
    duration_seconds: float
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "success": self.success,
            "repo_name": self.repo_name,
            "prs_synced": self.prs_synced,
            "branches_synced": self.branches_synced,
            "contexts_synced": self.contexts_synced,
            "duration_seconds": self.duration_seconds,
            "error_message": self.error_message,
        }


class SyncEngine:
    """
    Async engine for syncing GitHub repositories to the database.

    The engine provides both simple sync methods and streaming methods
    that yield progress updates for use in async contexts like FastAPI.
    """

    def __init__(
        self,
        db: SyncStore,
        progress_callback: Callable[[SyncProgress], None] | None = None,
    ):
        """
        Initialize sync engine.

        Args:
            db: Database instance for persistence
            progress_callback: Optional callback for progress updates
        """
        self.db = db
        self.progress_callback = progress_callback

    def _emit_progress(
        self,
        stage: str,
        current: int,
        total: int,
        message: str,
    ) -> SyncProgress:
        """Emit a progress update."""
        progress = SyncProgress(
            stage=stage,
            current=current,
            total=total,
            message=message,
        )
        if self.progress_callback:
            self.progress_callback(progress)
        return progress

    async def sync_repository(
        self,
        repo_path: Path | str,
        labels: list[str] | None = None,
        include_context: bool = True,
        fetch_first: bool = True,
    ) -> SyncResult:
        """
        Sync a repository's PRs and branches to the database.

        Args:
            repo_path: Path to the git repository
            labels: Optional list of labels to filter PRs by
            include_context: Whether to sync full PR context (diff, comments)
            fetch_first: Whether to fetch from remote first

        Returns:
            SyncResult with statistics
        """
        start_time = datetime.now(UTC)
        repo_path = Path(repo_path)

        # Initialize database
        await self.db.initialize()

        try:
            # Initialize clients
            git = GitClient(repo_path)
            await git.validate_repo()

            github = await GitHubClient.from_repo_path(repo_path)

            repo_name = await git.get_repo_name() or repo_path.name

            # Record sync start
            record_id = await self.db.record_sync_start(repo_name, "full")

            self._emit_progress("init", 0, 4, f"Starting sync for {repo_name}")

            # Fetch from remote if requested
            if fetch_first:
                self._emit_progress("fetch", 1, 4, "Fetching from remote")
                await git.fetch_all()

            # Get branch and PR data
            self._emit_progress("branches", 2, 4, "Analyzing branches")
            local_branches, remote_branches = await git.get_all_branches_with_status()
            default_branch = await git.get_default_branch()

            # Get PRs
            self._emit_progress("prs", 3, 4, "Fetching pull requests")

            async with github:
                if labels:
                    pr_numbers = await github.get_prs_with_labels(labels)
                    prs = []
                    for pr_num in pr_numbers:
                        pr = await github.get_pull_request(pr_num)
                        if pr:
                            prs.append(pr)
                else:
                    prs = await github.get_pull_requests(state="open")

                # Build repository state
                repo_state = RepositoryState(
                    repo_path=str(repo_path),
                    default_branch=default_branch,
                    last_updated=datetime.now(UTC),
                )

                # Create branch lookup
                remote_lookup = {b.name: b for b in remote_branches}
                pr_lookup = {pr.head_branch: pr for pr in prs}

                # Build combined states
                processed_branches = set()
                for local_branch in local_branches:
                    remote_branch = remote_lookup.get(local_branch.name)
                    pr = pr_lookup.get(local_branch.name)

                    state = BranchPRState(
                        branch_name=local_branch.name,
                        local_branch=local_branch,
                        remote_branch=remote_branch,
                        pr=pr,
                    )
                    repo_state.add_state(state)
                    processed_branches.add(local_branch.name)

                # Add remote-only branches
                for remote_branch in remote_branches:
                    if remote_branch.name not in processed_branches:
                        pr = pr_lookup.get(remote_branch.name)
                        state = BranchPRState(
                            branch_name=remote_branch.name,
                            remote_branch=remote_branch,
                            pr=pr,
                        )
                        repo_state.add_state(state)

                # Save to database
                await self.db.save_repository_state(repo_name, repo_state)

                # Sync PR contexts if requested
                contexts_synced = 0
                if include_context:
                    self._emit_progress("context", 4, 4, f"Syncing context for {len(prs)} PRs")

                    for i, pr in enumerate(prs):
                        self._emit_progress(
                            "context",
                            i + 1,
                            len(prs),
                            f"Syncing PR #{pr.number}",
                        )

                        context = await self._gather_pr_context(github, repo_name, pr)
                        await self.db.save_pr_context(context)
                        contexts_synced += 1

            # Record success
            duration = (datetime.now(UTC) - start_time).total_seconds()
            await self.db.record_sync_complete(
                record_id,
                success=True,
                prs_synced=len(prs),
                branches_synced=len(local_branches) + len(remote_branches),
            )

            return SyncResult(
                success=True,
                repo_name=repo_name,
                prs_synced=len(prs),
                branches_synced=len(local_branches) + len(remote_branches),
                contexts_synced=contexts_synced,
                duration_seconds=duration,
            )

        except Exception as e:
            duration = (datetime.now(UTC) - start_time).total_seconds()
            return SyncResult(
                success=False,
                repo_name=str(repo_path),
                prs_synced=0,
                branches_synced=0,
                contexts_synced=0,
                duration_seconds=duration,
                error_message=str(e),
            )

    async def sync_repository_stream(
        self,
        repo_path: Path | str,
        labels: list[str] | None = None,
        include_context: bool = True,
        fetch_first: bool = True,
    ) -> AsyncIterator[SyncProgress | SyncResult]:
        """
        Sync a repository with streaming progress updates.

        This is ideal for use in FastAPI background tasks or WebSocket handlers.

        Args:
            repo_path: Path to the git repository
            labels: Optional list of labels to filter PRs by
            include_context: Whether to sync full PR context
            fetch_first: Whether to fetch from remote first

        Yields:
            SyncProgress updates and final SyncResult
        """
        start_time = datetime.now(UTC)
        repo_path = Path(repo_path)

        await self.db.initialize()

        try:
            git = GitClient(repo_path)
            await git.validate_repo()

            github = await GitHubClient.from_repo_path(repo_path)
            repo_name = await git.get_repo_name() or repo_path.name

            record_id = await self.db.record_sync_start(repo_name, "full")

            yield SyncProgress("init", 0, 4, f"Starting sync for {repo_name}")

            if fetch_first:
                yield SyncProgress("fetch", 1, 4, "Fetching from remote")
                await git.fetch_all()

            yield SyncProgress("branches", 2, 4, "Analyzing branches")
            local_branches, remote_branches = await git.get_all_branches_with_status()
            default_branch = await git.get_default_branch()

            yield SyncProgress("prs", 3, 4, "Fetching pull requests")

            async with github:
                if labels:
                    pr_numbers = await github.get_prs_with_labels(labels)
                    prs = []
                    for pr_num in pr_numbers:
                        pr = await github.get_pull_request(pr_num)
                        if pr:
                            prs.append(pr)
                else:
                    prs = await github.get_pull_requests(state="open")

                # Build and save state
                repo_state = RepositoryState(
                    repo_path=str(repo_path),
                    default_branch=default_branch,
                    last_updated=datetime.now(UTC),
                )

                remote_lookup = {b.name: b for b in remote_branches}
                pr_lookup = {pr.head_branch: pr for pr in prs}

                processed_branches = set()
                for local_branch in local_branches:
                    remote_branch = remote_lookup.get(local_branch.name)
                    pr = pr_lookup.get(local_branch.name)
                    state = BranchPRState(
                        branch_name=local_branch.name,
                        local_branch=local_branch,
                        remote_branch=remote_branch,
                        pr=pr,
                    )
                    repo_state.add_state(state)
                    processed_branches.add(local_branch.name)

                for remote_branch in remote_branches:
                    if remote_branch.name not in processed_branches:
                        pr = pr_lookup.get(remote_branch.name)
                        state = BranchPRState(
                            branch_name=remote_branch.name,
                            remote_branch=remote_branch,
                            pr=pr,
                        )
                        repo_state.add_state(state)

                await self.db.save_repository_state(repo_name, repo_state)

                contexts_synced = 0
                if include_context and prs:
                    yield SyncProgress(
                        "context", 0, len(prs), f"Syncing context for {len(prs)} PRs"
                    )

                    for i, pr in enumerate(prs):
                        yield SyncProgress("context", i + 1, len(prs), f"Syncing PR #{pr.number}")
                        context = await self._gather_pr_context(github, repo_name, pr)
                        await self.db.save_pr_context(context)
                        contexts_synced += 1

            duration = (datetime.now(UTC) - start_time).total_seconds()
            await self.db.record_sync_complete(
                record_id,
                success=True,
                prs_synced=len(prs),
                branches_synced=len(local_branches) + len(remote_branches),
            )

            yield SyncResult(
                success=True,
                repo_name=repo_name,
                prs_synced=len(prs),
                branches_synced=len(local_branches) + len(remote_branches),
                contexts_synced=contexts_synced,
                duration_seconds=duration,
            )

        except Exception as e:
            duration = (datetime.now(UTC) - start_time).total_seconds()
            yield SyncResult(
                success=False,
                repo_name=str(repo_path),
                prs_synced=0,
                branches_synced=0,
                contexts_synced=0,
                duration_seconds=duration,
                error_message=str(e),
            )

    async def sync_single_pr(
        self,
        repo_path: Path | str,
        pr_number: int,
    ) -> SyncResult:
        """
        Sync a single PR's complete context.

        Args:
            repo_path: Path to the git repository
            pr_number: PR number to sync

        Returns:
            SyncResult
        """
        start_time = datetime.now(UTC)
        repo_path = Path(repo_path)

        await self.db.initialize()

        try:
            git = GitClient(repo_path)
            await git.validate_repo()

            github = await GitHubClient.from_repo_path(repo_path)
            repo_name = await git.get_repo_name() or repo_path.name

            async with github:
                pr = await github.get_pull_request(pr_number)
                if not pr:
                    return SyncResult(
                        success=False,
                        repo_name=repo_name,
                        prs_synced=0,
                        branches_synced=0,
                        contexts_synced=0,
                        duration_seconds=(datetime.now(UTC) - start_time).total_seconds(),
                        error_message=f"PR #{pr_number} not found",
                    )

                # Save PR snapshot
                await self.db.save_pr_snapshot(
                    repo_name,
                    {
                        "number": pr.number,
                        "title": pr.title,
                        "state": pr.state.value,
                        "head_branch": pr.head_branch,
                        "base_branch": pr.base_branch,
                        "author": pr.author,
                        "draft": pr.draft,
                        "ci_status": pr.get_ci_status().value,
                        "labels": pr.labels,
                        "created_at": pr.created_at.isoformat(),
                        "updated_at": pr.updated_at.isoformat(),
                    },
                )

                # Sync context
                context = await self._gather_pr_context(github, repo_name, pr)
                await self.db.save_pr_context(context)

            duration = (datetime.now(UTC) - start_time).total_seconds()
            return SyncResult(
                success=True,
                repo_name=repo_name,
                prs_synced=1,
                branches_synced=0,
                contexts_synced=1,
                duration_seconds=duration,
            )

        except Exception as e:
            duration = (datetime.now(UTC) - start_time).total_seconds()
            return SyncResult(
                success=False,
                repo_name=str(repo_path),
                prs_synced=0,
                branches_synced=0,
                contexts_synced=0,
                duration_seconds=duration,
                error_message=str(e),
            )

    async def _gather_pr_context(
        self,
        github: GitHubClient,
        repo_name: str,
        pr: PullRequest,
    ) -> PRContext:
        """Gather complete PR context from GitHub."""
        # Fetch all context data concurrently
        diff_task = github.get_pr_diff(pr.number)
        comments_task = github.get_pr_comments(pr.number)
        review_comments_task = github.get_pr_review_comments(pr.number)
        commits_task = github.get_pr_commits(pr.number)
        files_task = github.get_pr_files(pr.number)
        review_state_task = github.get_pr_review_state(pr.number)

        diff, comments, review_comments, commits, files, review_state = await asyncio.gather(
            diff_task,
            comments_task,
            review_comments_task,
            commits_task,
            files_task,
            review_state_task,
        )

        # Update PR with review state
        pr.approved_by = review_state.get("approved_by", [])
        pr.changes_requested_by = review_state.get("changes_requested_by", [])
        pr.review_decision = review_state.get("review_decision")

        return PRContext(
            repo_name=repo_name,
            pr_number=pr.number,
            pr_url=pr.url,
            diff=diff,
            body=pr.body or "",
            comments=comments,
            review_comments=review_comments,
            commits=commits,
            files=files,
            conflicts={},  # Would need to check mergeable status
            ci_checks={
                **pr.ci_summary,
                "review_state": review_state,
            },
            captured_at=datetime.now(UTC),
        )

    async def get_sync_status(self, repo_name: str | None = None) -> dict[str, Any]:
        """Get current sync status for repository or all repos."""
        await self.db.initialize()

        stats = await self.db.get_statistics()

        if repo_name:
            repo = await self.db.get_repository(repo_name)
            prs = await self.db.get_active_prs(repo_name)
            contexts = await self.db.get_all_pr_contexts(repo_name)

            return {
                "repository": repo,
                "active_prs": len(prs),
                "synced_contexts": len(contexts),
                "database_stats": stats,
            }

        repos = await self.db.get_all_repositories()
        return {
            "repositories": repos,
            "database_stats": stats,
        }
