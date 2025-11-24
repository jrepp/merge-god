"""
State tracking module for correlating branches and PRs.

This module combines data from git and GitHub to create a unified view
of repository state, matching branches with their corresponding PRs.
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from git_ops import GitOperations, GitOperationsError
from github_ops import GitHubOperations, GitHubOperationsError
from models import Branch, BranchPRState, PullRequest, RepositoryState


class StateTrackerError(Exception):
    """Exception raised for state tracker errors"""


class StateTracker:
    """
    Tracks and correlates branch and PR state for a repository.

    This is the main coordinator that uses GitOperations and GitHubOperations
    to build a complete RepositoryState.
    """

    def __init__(self, repo_path: Path | str):
        """
        Initialize state tracker for a repository.

        Args:
            repo_path: Path to the git repository
        """
        self.repo_path = Path(repo_path).resolve()

        # Initialize operations
        try:
            self.git_ops = GitOperations(self.repo_path)
            self.github_ops = GitHubOperations(self.repo_path)
        except (GitOperationsError, GitHubOperationsError) as e:
            raise StateTrackerError(f"Failed to initialize operations: {e}")

        # Cache
        self._cached_state: RepositoryState | None = None
        self._cache_time: datetime | None = None

    def fetch_and_update(self, force_fetch: bool = True) -> None:
        """
        Fetch latest data from remotes.

        Args:
            force_fetch: Whether to force git fetch (default: True)
        """
        if force_fetch:
            try:
                self.git_ops.fetch_all(prune=True)
            except GitOperationsError as e:
                raise StateTrackerError(f"Failed to fetch: {e}")

    def build_repository_state(
        self,
        fetch_first: bool = True,
        include_closed_prs: bool = False,
    ) -> RepositoryState:
        """
        Build complete repository state by correlating branches and PRs.

        This is the main entry point for getting repository state.

        Args:
            fetch_first: Whether to fetch from remotes first
            include_closed_prs: Whether to include closed/merged PRs

        Returns:
            Complete RepositoryState object
        """
        # Fetch if requested
        if fetch_first:
            self.fetch_and_update()

        # Get default branch
        try:
            default_branch = self.git_ops.get_default_branch()
        except GitOperationsError as e:
            raise StateTrackerError(f"Failed to get default branch: {e}")

        # Create repository state
        repo_state = RepositoryState(
            repo_path=str(self.repo_path),
            default_branch=default_branch,
        )

        # Get branches
        try:
            local_branches, remote_branches = self.git_ops.get_all_branches_with_status()
        except GitOperationsError as e:
            raise StateTrackerError(f"Failed to get branches: {e}")

        # Get PRs
        try:
            if include_closed_prs:
                prs = self.github_ops.get_all_prs(state="all")
            else:
                prs = self.github_ops.get_open_prs()
        except GitHubOperationsError as e:
            raise StateTrackerError(f"Failed to get PRs: {e}")

        # Build correlation
        self._correlate_branches_and_prs(
            repo_state=repo_state,
            local_branches=local_branches,
            remote_branches=remote_branches,
            prs=prs,
        )

        # Update timestamp
        repo_state.last_updated = datetime.now(UTC)

        # Cache the state
        self._cached_state = repo_state
        self._cache_time = datetime.now(UTC)

        return repo_state

    def _correlate_branches_and_prs(
        self,
        repo_state: RepositoryState,
        local_branches: list[Branch],
        remote_branches: list[Branch],
        prs: list[PullRequest],
    ) -> None:
        """
        Correlate branches with PRs and add to repository state.

        This uses an efficient algorithm to match branches with PRs:
        1. Build lookup maps for O(1) access
        2. Process all branches
        3. Match with PRs by head branch name
        4. Handle remote-only PRs

        Args:
            repo_state: RepositoryState to populate
            local_branches: List of local branches
            remote_branches: List of remote branches
            prs: List of pull requests
        """
        # Build lookup maps for efficient matching
        {branch.name: branch for branch in local_branches}
        remote_lookup = {branch.name: branch for branch in remote_branches}
        pr_lookup = {pr.head_branch: pr for pr in prs}

        # Track processed branches
        processed_branches = set()

        # Process all local branches
        for local_branch in local_branches:
            branch_name = local_branch.name
            remote_branch = remote_lookup.get(branch_name)
            pr = pr_lookup.get(branch_name)

            state = BranchPRState(
                branch_name=branch_name,
                local_branch=local_branch,
                remote_branch=remote_branch,
                pr=pr,
            )

            repo_state.add_state(state)
            processed_branches.add(branch_name)

        # Process remote-only branches (not in local)
        for remote_branch in remote_branches:
            branch_name = remote_branch.name

            if branch_name in processed_branches:
                continue

            pr = pr_lookup.get(branch_name)

            state = BranchPRState(
                branch_name=branch_name,
                local_branch=None,
                remote_branch=remote_branch,
                pr=pr,
            )

            repo_state.add_state(state)
            processed_branches.add(branch_name)

        # Process PRs without matching branches (edge case)
        # This can happen if PR branch was deleted but PR still open
        for pr in prs:
            if pr.head_branch not in processed_branches:
                state = BranchPRState(
                    branch_name=pr.head_branch,
                    local_branch=None,
                    remote_branch=None,
                    pr=pr,
                )

                repo_state.add_state(state)

    def get_cached_state(
        self,
        max_age_seconds: int | None = None,
    ) -> RepositoryState | None:
        """
        Get cached state if available and not too old.

        Args:
            max_age_seconds: Maximum cache age in seconds (None = no limit)

        Returns:
            Cached RepositoryState or None if not available/too old
        """
        if not self._cached_state or not self._cache_time:
            return None

        if max_age_seconds is not None:
            age = (datetime.now(UTC) - self._cache_time).total_seconds()
            if age > max_age_seconds:
                return None

        return self._cached_state

    def invalidate_cache(self) -> None:
        """Invalidate cached state"""
        self._cached_state = None
        self._cache_time = None

    def get_or_build_state(
        self,
        max_cache_age: int = 60,
        fetch_first: bool = True,
    ) -> RepositoryState:
        """
        Get cached state or build new one if cache is stale.

        Args:
            max_cache_age: Maximum cache age in seconds
            fetch_first: Whether to fetch if building new state

        Returns:
            RepositoryState (cached or fresh)
        """
        cached = self.get_cached_state(max_age_seconds=max_cache_age)
        if cached:
            return cached

        return self.build_repository_state(fetch_first=fetch_first)

    def get_summary(self) -> dict[str, Any]:
        """
        Get a quick summary without building full state.

        Returns:
            Dictionary with repository summary
        """
        try:
            repo_info = self.git_ops.get_repository_info()

            # Try to use cached state for counts
            if self._cached_state:
                summary = self._cached_state.summary_dict()
                summary.update(repo_info)
                return summary

            return repo_info

        except GitOperationsError as e:
            return {"error": str(e)}

    def refresh_pr_ci_status(self, pr_number: int) -> PullRequest | None:
        """
        Refresh CI status for a specific PR.

        Args:
            pr_number: PR number to refresh

        Returns:
            Updated PullRequest or None if not found
        """
        try:
            return self.github_ops.get_pr_by_number(pr_number)
        except GitHubOperationsError:
            return None


def quick_status(repo_path: Path | str) -> dict[str, Any]:
    """
    Quick helper function to get repository status.

    Args:
        repo_path: Path to repository

    Returns:
        Dictionary with status information
    """
    try:
        tracker = StateTracker(repo_path)
        state = tracker.build_repository_state(fetch_first=True)
        return state.summary_dict()
    except StateTrackerError as e:
        return {"error": str(e)}
