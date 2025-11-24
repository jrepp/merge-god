"""
GitHub operations module for PR and CI tracking.

This module handles all GitHub-related operations including:
- Fetching PRs
- Extracting CI/CD status
- Parsing PR metadata

Uses PyGithub SDK for reliable GitHub API access.
"""

import os
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

from github import Auth, Github, GithubException
from github.PullRequest import PullRequest as GhPullRequest

from .models import CICheck, CIStatus, PRState, PullRequest

if TYPE_CHECKING:
    from github.Repository import Repository


class GitHubOperationsError(Exception):
    """Exception raised for GitHub operation errors"""


class GitHubOperations:
    """Handles GitHub operations for PR and CI tracking"""

    def __init__(self, repo_path: Path, token: str | None = None):
        """
        Initialize GitHub operations.

        Args:
            repo_path: Path to the git repository
            token: GitHub token (optional, will try to get from environment or gh CLI)
        """
        self.repo_path = repo_path
        self.github: Github | None = None
        self.repo: Repository | None = None

        # Get token and initialize
        self.token = token or self._get_token()
        if self.token:
            self._initialize_github()

    def _get_token(self) -> str | None:
        """
        Get GitHub token from various sources.

        Priority:
        1. GITHUB_TOKEN environment variable
        2. GH_TOKEN environment variable
        3. gh CLI token

        Returns:
            Token string or None if not found
        """
        # Try environment variables
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if token:
            return token

        # Try gh CLI
        try:
            result = subprocess.run(
                ["gh", "auth", "token"],
                check=False, capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        return None

    def _initialize_github(self) -> None:
        """Initialize GitHub API client and repository"""
        if not self.token:
            raise GitHubOperationsError(
                "No GitHub token found. Set GITHUB_TOKEN environment variable "
                "or authenticate with gh CLI",
            )

        try:
            # Create GitHub client with timeout
            auth = Auth.Token(self.token)
            # Set timeout for all API requests (connection timeout, read timeout)
            self.github = Github(auth=auth, timeout=30)

            # Get repository from remote URL
            repo_name = self._get_repo_name()
            if repo_name:
                self.repo = self.github.get_repo(repo_name)
        except GithubException as e:
            raise GitHubOperationsError(f"GitHub API error: {e.data.get('message', str(e))}") from e
        except Exception as e:
            raise GitHubOperationsError(f"Failed to initialize GitHub: {e}") from e

    def _get_repo_name(self) -> str | None:
        """
        Extract repository name (owner/repo) from git remote.

        Returns:
            Repository name like "owner/repo" or None
        """
        try:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                check=False, cwd=self.repo_path,
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result.returncode != 0:
                return None

            url = result.stdout.strip()

            # Parse various GitHub URL formats
            # SSH: git@github.com:owner/repo.git
            # HTTPS: https://github.com/owner/repo.git
            # HTTPS: https://github.com/owner/repo

            if "github.com" not in url:
                return None

            if url.startswith("git@github.com:"):
                # SSH format
                repo_name = url.replace("git@github.com:", "").replace(".git", "")
            elif "github.com/" in url:
                # HTTPS format
                repo_name = url.split("github.com/")[-1].replace(".git", "")
            else:
                return None

            return repo_name

        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None

    def _parse_pr_state(self, state_str: str, is_draft: bool) -> PRState:
        """
        Parse PR state from GitHub API response.

        Args:
            state_str: State string from API
            is_draft: Whether PR is draft

        Returns:
            PRState enum value
        """
        if is_draft:
            return PRState.DRAFT

        state_lower = state_str.lower()
        if state_lower == "open":
            return PRState.OPEN
        if state_lower == "closed":
            return PRState.CLOSED
        if state_lower == "merged":
            return PRState.MERGED

        return PRState.OPEN

    def _parse_ci_status(self, status_str: str | None, conclusion_str: str | None) -> CIStatus:
        """
        Parse CI status from GitHub check.

        Args:
            status_str: Status string (e.g., "completed", "in_progress")
            conclusion_str: Conclusion string (e.g., "success", "failure")

        Returns:
            CIStatus enum value
        """
        if not status_str and not conclusion_str:
            return CIStatus.NONE

        if conclusion_str:
            conclusion_lower = conclusion_str.lower()
            if conclusion_lower == "success":
                return CIStatus.SUCCESS
            if conclusion_lower in ["failure", "timed_out", "startup_failure", "action_required"]:
                return CIStatus.FAILURE

        if status_str:
            status_lower = status_str.lower()
            if status_lower in ["pending", "in_progress", "queued", "waiting"]:
                return CIStatus.PENDING

        return CIStatus.NONE

    def _parse_ci_checks(self, gh_pr: GhPullRequest) -> list[CICheck]:
        """
        Parse CI checks from GitHub PR.

        Args:
            gh_pr: PyGithub PullRequest object

        Returns:
            List of CICheck objects
        """
        checks: list[CICheck] = []

        if not self.repo:
            return checks

        try:
            # Get commit for check runs
            commit = self.repo.get_commit(gh_pr.head.sha)

            # Get check runs
            check_runs = commit.get_check_runs()
            for run in check_runs:
                status = self._parse_ci_status(run.status, run.conclusion)

                check = CICheck(
                    name=run.name,
                    status=status,
                    conclusion=run.conclusion,
                    details_url=run.html_url,
                    started_at=run.started_at,
                    completed_at=run.completed_at,
                )
                checks.append(check)

            # Also get status checks (older API)
            statuses = commit.get_statuses()
            for status_obj in statuses:
                # Convert status API to check format
                state_to_status = {
                    "success": CIStatus.SUCCESS,
                    "failure": CIStatus.FAILURE,
                    "error": CIStatus.FAILURE,
                    "pending": CIStatus.PENDING,
                }
                status = state_to_status.get(status_obj.state, CIStatus.NONE)

                check = CICheck(
                    name=status_obj.context,
                    status=status,
                    conclusion=status_obj.state,
                    details_url=status_obj.target_url,
                    started_at=status_obj.created_at,
                    completed_at=status_obj.updated_at,
                )
                checks.append(check)

        except GithubException:
            # If we can't get checks, return empty list
            pass

        return checks

    def _compute_ci_summary(self, checks: list[CICheck]) -> dict[str, int]:
        """
        Compute summary statistics for CI checks.

        Args:
            checks: List of CI checks

        Returns:
            Dictionary with counts by status
        """
        summary = {
            "total": len(checks),
            "success": 0,
            "failure": 0,
            "pending": 0,
            "none": 0,
        }

        for check in checks:
            if check.status == CIStatus.SUCCESS:
                summary["success"] += 1
            elif check.status == CIStatus.FAILURE:
                summary["failure"] += 1
            elif check.status == CIStatus.PENDING:
                summary["pending"] += 1
            else:
                summary["none"] += 1

        return summary

    def get_all_prs(self, state: str = "all", limit: int = 100) -> list[PullRequest]:
        """
        Fetch all PRs from the repository.

        Args:
            state: PR state filter ("all", "open", "closed")
            limit: Maximum number of PRs to fetch

        Returns:
            List of PullRequest objects
        """
        if not self.repo:
            raise GitHubOperationsError("Repository not initialized")

        prs = []

        try:
            # Map state parameter to GitHub API
            if state == "all":
                gh_state = "all"
            elif state == "open":
                gh_state = "open"
            elif state == "closed":
                gh_state = "closed"
            else:
                gh_state = "open"

            # Fetch PRs
            gh_prs = self.repo.get_pulls(state=gh_state)

            # Process up to limit
            count = 0
            for gh_pr in gh_prs:
                if count >= limit:
                    break

                pr = self._parse_pr_data(gh_pr)
                if pr:
                    prs.append(pr)
                    count += 1

        except GithubException as e:
            raise GitHubOperationsError(f"Failed to fetch PRs: {e.data.get('message', str(e))}") from e

        return prs

    def _parse_pr_data(self, gh_pr: GhPullRequest) -> PullRequest | None:
        """
        Parse PR data from PyGithub PullRequest object.

        Args:
            gh_pr: PyGithub PullRequest object

        Returns:
            PullRequest object or None if parsing fails
        """
        try:
            # Parse state
            is_draft = gh_pr.draft
            state = self._parse_pr_state(gh_pr.state, is_draft)

            # Parse author
            author = gh_pr.user.login if gh_pr.user else "unknown"

            # Parse labels
            labels = [label.name for label in gh_pr.labels]

            # Parse CI checks
            ci_checks = self._parse_ci_checks(gh_pr)
            ci_summary = self._compute_ci_summary(ci_checks)

            # Parse review decision (from reviews)
            review_decision = None
            try:
                reviews = list(gh_pr.get_reviews())
                if reviews:
                    # Get most recent review state
                    latest_review = reviews[-1]
                    if latest_review.state == "APPROVED":
                        review_decision = "APPROVED"
                    elif latest_review.state in ["CHANGES_REQUESTED", "REQUEST_CHANGES"]:
                        review_decision = "CHANGES_REQUESTED"
                    elif latest_review.state == "COMMENTED":
                        review_decision = "COMMENTED"
            except GithubException:
                pass

            # Create PR object
            return PullRequest(
                number=gh_pr.number,
                title=gh_pr.title,
                state=state,
                head_branch=gh_pr.head.ref,
                base_branch=gh_pr.base.ref,
                author=author,
                url=gh_pr.html_url,
                created_at=gh_pr.created_at,
                updated_at=gh_pr.updated_at or gh_pr.created_at,
                body=gh_pr.body,
                draft=is_draft,
                mergeable=gh_pr.mergeable if gh_pr.mergeable is not None else True,
                labels=labels,
                ci_checks=ci_checks,
                ci_summary=ci_summary,
                review_decision=review_decision,
                additions=gh_pr.additions,
                deletions=gh_pr.deletions,
                changed_files=gh_pr.changed_files,
                commits=gh_pr.commits,
            )


        except (AttributeError, GithubException):
            # Log the error but don't fail the entire operation
            return None

    def get_pr_by_number(self, pr_number: int) -> PullRequest | None:
        """
        Fetch a specific PR by number.

        Args:
            pr_number: PR number

        Returns:
            PullRequest object or None if not found
        """
        if not self.repo:
            raise GitHubOperationsError("Repository not initialized")

        try:
            gh_pr = self.repo.get_pull(pr_number)
            return self._parse_pr_data(gh_pr)
        except GithubException:
            return None

    def get_open_prs(self) -> list[PullRequest]:
        """
        Fetch all open PRs.

        Returns:
            List of open PullRequest objects
        """
        return self.get_all_prs(state="open")

    def get_prs_by_branch(self, branch_name: str) -> list[PullRequest]:
        """
        Find PRs by head branch name.

        Args:
            branch_name: Branch name to search for

        Returns:
            List of PullRequest objects with matching head branch
        """
        all_prs = self.get_all_prs(state="all")
        return [pr for pr in all_prs if pr.head_branch == branch_name]

    def refresh_pr_ci_status(self, pr: PullRequest) -> PullRequest:
        """
        Refresh CI status for a PR by fetching latest data.

        Args:
            pr: PullRequest object to refresh

        Returns:
            Updated PullRequest object
        """
        fresh_pr = self.get_pr_by_number(pr.number)
        if fresh_pr:
            return fresh_pr
        return pr
