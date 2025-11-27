"""
Async GitHub API client for PR and CI tracking.

Uses httpx for async HTTP requests to the GitHub API.
"""

import asyncio
import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from github_sync.models import CICheck, CIStatus, PRState, PullRequest


class GitHubClientError(Exception):
    """Exception raised for GitHub API errors."""


class GitHubClient:
    """Async GitHub API client for fetching PRs and CI status."""

    BASE_URL = "https://api.github.com"

    def __init__(
        self,
        token: str | None = None,
        repo_owner: str | None = None,
        repo_name: str | None = None,
        timeout: float = 30.0,
    ):
        """
        Initialize GitHub client.

        Args:
            token: GitHub token (optional, will try to get from environment)
            repo_owner: Repository owner/organization
            repo_name: Repository name
            timeout: Request timeout in seconds
        """
        self.token = token or self._get_token()
        self.repo_owner = repo_owner
        self.repo_name = repo_name
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    @classmethod
    async def from_repo_path(cls, repo_path: Path, token: str | None = None) -> "GitHubClient":
        """
        Create a GitHubClient by extracting repo info from a local git repository.

        Args:
            repo_path: Path to local git repository
            token: Optional GitHub token

        Returns:
            Configured GitHubClient instance
        """
        # Get remote URL in a separate thread to not block
        loop = asyncio.get_event_loop()
        owner, name = await loop.run_in_executor(None, cls._get_repo_from_path, repo_path)

        if not owner or not name:
            raise GitHubClientError(f"Could not determine GitHub repository from path: {repo_path}")

        return cls(token=token, repo_owner=owner, repo_name=name)

    @staticmethod
    def _get_repo_from_path(repo_path: Path) -> tuple[str | None, str | None]:
        """Extract owner/repo from git remote URL."""
        try:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                check=False,
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result.returncode != 0:
                return None, None

            url = result.stdout.strip()

            if "github.com" not in url:
                return None, None

            # Parse SSH format: git@github.com:owner/repo.git
            if url.startswith("git@github.com:"):
                repo_part = url.replace("git@github.com:", "").replace(".git", "")
            # Parse HTTPS format: https://github.com/owner/repo.git
            elif "github.com/" in url:
                repo_part = url.split("github.com/")[-1].replace(".git", "")
            else:
                return None, None

            parts = repo_part.split("/")
            if len(parts) >= 2:
                return parts[0], parts[1]

            return None, None

        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None, None

    def _get_token(self) -> str | None:
        """Get GitHub token from environment or gh CLI."""
        # Try environment variables
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if token:
            return token

        # Try gh CLI
        try:
            result = subprocess.run(
                ["gh", "auth", "token"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        return None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the async HTTP client."""
        if self._client is None:
            headers = {
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"

            self._client = httpx.AsyncClient(
                base_url=self.BASE_URL,
                headers=headers,
                timeout=self.timeout,
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> "GitHubClient":
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.close()

    def _api_path(self, endpoint: str) -> str:
        """Build API path for the configured repository."""
        if not self.repo_owner or not self.repo_name:
            raise GitHubClientError("Repository not configured")
        return f"/repos/{self.repo_owner}/{self.repo_name}{endpoint}"

    async def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json_data: dict[str, Any] | None = None,
    ) -> dict[str, Any] | list[Any]:
        """Make an API request."""
        client = await self._get_client()

        try:
            response = await client.request(
                method,
                path,
                params=params,
                json=json_data,
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            raise GitHubClientError(f"GitHub API error {e.response.status_code}: {error_body}")
        except httpx.RequestError as e:
            raise GitHubClientError(f"Request error: {e}")

    def _parse_pr_state(self, state_str: str, is_draft: bool) -> PRState:
        """Parse PR state from API response."""
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
        """Parse CI status from check data."""
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

    async def get_pull_requests(
        self,
        state: str = "open",
        limit: int = 100,
    ) -> list[PullRequest]:
        """
        Fetch pull requests.

        Args:
            state: Filter by state ("open", "closed", "all")
            limit: Maximum number to fetch

        Returns:
            List of PullRequest objects
        """
        path = self._api_path("/pulls")
        params = {"state": state, "per_page": min(limit, 100)}

        data = await self._request("GET", path, params=params)
        if not isinstance(data, list):
            return []

        prs = []
        for pr_data in data[:limit]:
            pr = await self._parse_pr_data(pr_data)
            if pr:
                prs.append(pr)

        return prs

    async def get_pull_request(self, pr_number: int) -> PullRequest | None:
        """Fetch a specific PR by number."""
        path = self._api_path(f"/pulls/{pr_number}")

        try:
            data = await self._request("GET", path)
            if isinstance(data, dict):
                return await self._parse_pr_data(data)
        except GitHubClientError:
            pass

        return None

    async def _parse_pr_data(self, data: dict[str, Any]) -> PullRequest | None:
        """Parse PR data from API response."""
        try:
            is_draft = data.get("draft", False)
            state = self._parse_pr_state(data["state"], is_draft)

            # Parse author
            author = data.get("user", {}).get("login", "unknown")

            # Parse labels
            labels = [label["name"] for label in data.get("labels", [])]

            # Get CI checks
            ci_checks = await self._get_ci_checks(data["head"]["sha"])
            ci_summary = self._compute_ci_summary(ci_checks)

            # Parse dates
            created_at = datetime.fromisoformat(data["created_at"].replace("Z", "+00:00"))
            updated_at = datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00"))

            return PullRequest(
                number=data["number"],
                title=data["title"],
                state=state,
                head_branch=data["head"]["ref"],
                base_branch=data["base"]["ref"],
                author=author,
                url=data["html_url"],
                created_at=created_at,
                updated_at=updated_at,
                body=data.get("body"),
                draft=is_draft,
                mergeable=data.get("mergeable", True) or True,
                labels=labels,
                ci_checks=ci_checks,
                ci_summary=ci_summary,
                additions=data.get("additions", 0),
                deletions=data.get("deletions", 0),
                changed_files=data.get("changed_files", 0),
                commits=data.get("commits", 0),
            )

        except (KeyError, ValueError):
            return None

    async def _get_ci_checks(self, commit_sha: str) -> list[CICheck]:
        """Get CI checks for a commit."""
        checks = []

        try:
            # Get check runs
            path = self._api_path(f"/commits/{commit_sha}/check-runs")
            data = await self._request("GET", path)

            if isinstance(data, dict):
                for run in data.get("check_runs", []):
                    status = self._parse_ci_status(run.get("status"), run.get("conclusion"))

                    started_at = None
                    if run.get("started_at"):
                        started_at = datetime.fromisoformat(
                            run["started_at"].replace("Z", "+00:00")
                        )

                    completed_at = None
                    if run.get("completed_at"):
                        completed_at = datetime.fromisoformat(
                            run["completed_at"].replace("Z", "+00:00")
                        )

                    checks.append(
                        CICheck(
                            name=run["name"],
                            status=status,
                            conclusion=run.get("conclusion"),
                            details_url=run.get("html_url"),
                            started_at=started_at,
                            completed_at=completed_at,
                        )
                    )

            # Also get status checks (older API)
            path = self._api_path(f"/commits/{commit_sha}/statuses")
            data = await self._request("GET", path)

            if isinstance(data, list):
                state_to_status = {
                    "success": CIStatus.SUCCESS,
                    "failure": CIStatus.FAILURE,
                    "error": CIStatus.FAILURE,
                    "pending": CIStatus.PENDING,
                }

                for status_obj in data:
                    status = state_to_status.get(status_obj["state"], CIStatus.NONE)

                    created_at = None
                    if status_obj.get("created_at"):
                        created_at = datetime.fromisoformat(
                            status_obj["created_at"].replace("Z", "+00:00")
                        )

                    updated_at = None
                    if status_obj.get("updated_at"):
                        updated_at = datetime.fromisoformat(
                            status_obj["updated_at"].replace("Z", "+00:00")
                        )

                    checks.append(
                        CICheck(
                            name=status_obj["context"],
                            status=status,
                            conclusion=status_obj["state"],
                            details_url=status_obj.get("target_url"),
                            started_at=created_at,
                            completed_at=updated_at,
                        )
                    )

        except GitHubClientError:
            pass

        return checks

    def _compute_ci_summary(self, checks: list[CICheck]) -> dict[str, int]:
        """Compute summary statistics for CI checks."""
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

    async def get_pr_diff(self, pr_number: int) -> str:
        """Get the diff for a PR."""
        path = self._api_path(f"/pulls/{pr_number}")
        client = await self._get_client()

        try:
            response = await client.get(
                path,
                headers={"Accept": "application/vnd.github.diff"},
            )
            response.raise_for_status()
            return response.text
        except httpx.HTTPError:
            return ""

    async def get_pr_comments(self, pr_number: int) -> list[dict[str, Any]]:
        """Get issue comments on a PR."""
        path = self._api_path(f"/issues/{pr_number}/comments")

        try:
            data = await self._request("GET", path)
            if isinstance(data, list):
                return [
                    {
                        "id": c["id"],
                        "author": c.get("user", {}).get("login", "unknown"),
                        "body": c.get("body", ""),
                        "created_at": c.get("created_at"),
                        "updated_at": c.get("updated_at"),
                    }
                    for c in data
                ]
        except GitHubClientError:
            pass

        return []

    async def get_pr_review_comments(self, pr_number: int) -> list[dict[str, Any]]:
        """Get review comments on a PR."""
        path = self._api_path(f"/pulls/{pr_number}/comments")

        try:
            data = await self._request("GET", path)
            if isinstance(data, list):
                return [
                    {
                        "id": c["id"],
                        "author": c.get("user", {}).get("login", "unknown"),
                        "body": c.get("body", ""),
                        "path": c.get("path"),
                        "line": c.get("line"),
                        "created_at": c.get("created_at"),
                        "updated_at": c.get("updated_at"),
                    }
                    for c in data
                ]
        except GitHubClientError:
            pass

        return []

    async def get_pr_commits(self, pr_number: int) -> list[dict[str, Any]]:
        """Get commits in a PR."""
        path = self._api_path(f"/pulls/{pr_number}/commits")

        try:
            data = await self._request("GET", path)
            if isinstance(data, list):
                return [
                    {
                        "sha": c["sha"],
                        "message": c.get("commit", {}).get("message", ""),
                        "author": c.get("commit", {}).get("author", {}).get("name", "unknown"),
                        "date": c.get("commit", {}).get("author", {}).get("date"),
                    }
                    for c in data
                ]
        except GitHubClientError:
            pass

        return []

    async def get_pr_files(self, pr_number: int) -> list[dict[str, Any]]:
        """Get files changed in a PR."""
        path = self._api_path(f"/pulls/{pr_number}/files")

        try:
            data = await self._request("GET", path)
            if isinstance(data, list):
                return [
                    {
                        "filename": f["filename"],
                        "status": f.get("status"),
                        "additions": f.get("additions", 0),
                        "deletions": f.get("deletions", 0),
                        "changes": f.get("changes", 0),
                        "patch": f.get("patch", ""),
                    }
                    for f in data
                ]
        except GitHubClientError:
            pass

        return []

    async def get_prs_with_labels(self, labels: list[str]) -> list[int]:
        """Get PR numbers that have any of the specified labels."""
        prs = await self.get_pull_requests(state="open")
        label_set = {label.lower() for label in labels}

        matching = []
        for pr in prs:
            pr_labels = {label.lower() for label in pr.labels}
            if pr_labels & label_set:
                matching.append(pr.number)

        return matching

    async def get_pr_reviews(self, pr_number: int) -> list[dict[str, Any]]:
        """
        Get reviews for a PR.

        Returns list of reviews with state (APPROVED, CHANGES_REQUESTED, COMMENTED, etc.)
        """
        path = self._api_path(f"/pulls/{pr_number}/reviews")

        try:
            data = await self._request("GET", path)
            if isinstance(data, list):
                return [
                    {
                        "id": r["id"],
                        "author": r.get("user", {}).get("login", "unknown"),
                        "state": r.get("state"),  # APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
                        "body": r.get("body", ""),
                        "submitted_at": r.get("submitted_at"),
                    }
                    for r in data
                ]
        except GitHubClientError:
            pass

        return []

    async def get_pr_review_state(self, pr_number: int) -> dict[str, Any]:
        """
        Get aggregated review state for a PR.

        Returns dict with:
        - approved_by: list of usernames who approved
        - changes_requested_by: list of usernames who requested changes
        - review_decision: overall decision (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or None)
        """
        reviews = await self.get_pr_reviews(pr_number)

        # Track the latest review state per author
        latest_by_author: dict[str, dict] = {}
        for review in reviews:
            author = review["author"]
            # Keep only the latest review per author
            if author not in latest_by_author:
                latest_by_author[author] = review
            else:
                # Compare timestamps
                existing_time = latest_by_author[author].get("submitted_at", "")
                new_time = review.get("submitted_at", "")
                if new_time > existing_time:
                    latest_by_author[author] = review

        approved_by = []
        changes_requested_by = []

        for author, review in latest_by_author.items():
            state = review.get("state", "").upper()
            if state == "APPROVED":
                approved_by.append(author)
            elif state == "CHANGES_REQUESTED":
                changes_requested_by.append(author)

        # Determine overall decision
        review_decision = None
        if changes_requested_by:
            review_decision = "CHANGES_REQUESTED"
        elif approved_by:
            review_decision = "APPROVED"

        return {
            "approved_by": approved_by,
            "changes_requested_by": changes_requested_by,
            "review_decision": review_decision,
        }

    # ==========================================================================
    # Write Operations
    # ==========================================================================

    async def post_comment(self, pr_number: int, body: str) -> dict[str, Any] | None:
        """
        Post a comment on a PR (issue comment).

        Args:
            pr_number: PR number
            body: Comment body text

        Returns:
            Created comment data or None on failure
        """
        path = self._api_path(f"/issues/{pr_number}/comments")

        try:
            data = await self._request("POST", path, json_data={"body": body})
            if isinstance(data, dict):
                return {
                    "id": data["id"],
                    "body": data.get("body", ""),
                    "created_at": data.get("created_at"),
                }
        except GitHubClientError:
            pass

        return None

    async def close_pr(self, pr_number: int) -> bool:
        """Close a pull request."""
        path = self._api_path(f"/pulls/{pr_number}")

        try:
            await self._request("PATCH", path, json_data={"state": "closed"})
            return True
        except GitHubClientError:
            return False

    async def reopen_pr(self, pr_number: int) -> bool:
        """Reopen a closed pull request."""
        path = self._api_path(f"/pulls/{pr_number}")

        try:
            await self._request("PATCH", path, json_data={"state": "open"})
            return True
        except GitHubClientError:
            return False

    async def merge_pr(
        self,
        pr_number: int,
        merge_method: str = "merge",
        commit_title: str | None = None,
        commit_message: str | None = None,
    ) -> dict[str, Any]:
        """
        Merge a pull request.

        Args:
            pr_number: PR number
            merge_method: "merge", "squash", or "rebase"
            commit_title: Optional commit title (for squash/merge)
            commit_message: Optional commit message

        Returns:
            Dict with success status and message
        """
        path = self._api_path(f"/pulls/{pr_number}/merge")

        json_data: dict[str, Any] = {"merge_method": merge_method}
        if commit_title:
            json_data["commit_title"] = commit_title
        if commit_message:
            json_data["commit_message"] = commit_message

        try:
            data = await self._request("PUT", path, json_data=json_data)
            if isinstance(data, dict):
                return {
                    "success": True,
                    "merged": data.get("merged", False),
                    "sha": data.get("sha"),
                    "message": data.get("message", "Merged"),
                }
        except GitHubClientError as e:
            return {
                "success": False,
                "merged": False,
                "message": str(e),
            }

        return {"success": False, "merged": False, "message": "Unknown error"}

    async def get_pr_mergeable_state(self, pr_number: int) -> dict[str, Any]:
        """
        Get detailed mergeable state for a PR.

        Returns dict with:
        - mergeable: bool or None (null means GitHub is still computing)
        - mergeable_state: "clean", "dirty", "blocked", "behind", "unstable", etc.
        - rebaseable: bool
        """
        path = self._api_path(f"/pulls/{pr_number}")

        try:
            data = await self._request("GET", path)
            if isinstance(data, dict):
                return {
                    "mergeable": data.get("mergeable"),
                    "mergeable_state": data.get("mergeable_state"),
                    "rebaseable": data.get("rebaseable"),
                    "merge_commit_sha": data.get("merge_commit_sha"),
                }
        except GitHubClientError:
            pass

        return {
            "mergeable": None,
            "mergeable_state": "unknown",
            "rebaseable": None,
        }

    async def add_labels(self, pr_number: int, labels: list[str]) -> bool:
        """Add labels to a PR."""
        path = self._api_path(f"/issues/{pr_number}/labels")

        try:
            await self._request("POST", path, json_data={"labels": labels})
            return True
        except GitHubClientError:
            return False

    async def remove_label(self, pr_number: int, label: str) -> bool:
        """Remove a label from a PR."""
        path = self._api_path(f"/issues/{pr_number}/labels/{label}")

        try:
            client = await self._get_client()
            response = await client.delete(path)
            return response.status_code in (200, 204)
        except Exception:
            return False
