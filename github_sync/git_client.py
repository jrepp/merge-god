"""
Async Git operations client for branch state analysis.

Wraps git commands in async executors for non-blocking operation.
"""

import asyncio
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from github_sync.models import Branch, BranchStatus


class GitClientError(Exception):
    """Exception raised for git operation errors."""


class GitClient:
    """Async wrapper for git operations."""

    def __init__(self, repo_path: Path | str):
        """
        Initialize git client for a repository.

        Args:
            repo_path: Path to the git repository
        """
        self.repo_path = Path(repo_path)

    async def validate_repo(self) -> None:
        """Validate that the path is a valid git repository."""
        if not self.repo_path.exists():
            raise GitClientError(f"Repository path does not exist: {self.repo_path}")

        git_dir = self.repo_path / ".git"
        if not git_dir.exists():
            raise GitClientError(f"Not a git repository: {self.repo_path}")

    async def _run_command(
        self,
        cmd: list[str],
        timeout: int = 30,
        check: bool = True,
    ) -> tuple[int, str, str]:
        """
        Run a git command asynchronously.

        Args:
            cmd: Command and arguments
            timeout: Timeout in seconds
            check: Raise exception on non-zero exit code

        Returns:
            Tuple of (returncode, stdout, stderr)
        """
        loop = asyncio.get_event_loop()

        def run_sync() -> tuple[int, str, str]:
            try:
                result = subprocess.run(
                    cmd,
                    check=False,
                    cwd=self.repo_path,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                )
                return result.returncode, result.stdout, result.stderr
            except subprocess.TimeoutExpired:
                raise GitClientError(f"Command timed out: {' '.join(cmd)}")

        returncode, stdout, stderr = await loop.run_in_executor(None, run_sync)

        if check and returncode != 0:
            raise GitClientError(
                f"Command failed: {' '.join(cmd)}\nExit code: {returncode}\nStderr: {stderr}"
            )

        return returncode, stdout, stderr

    async def fetch_all(self, prune: bool = True) -> None:
        """
        Fetch all remotes.

        Args:
            prune: Whether to prune deleted remote branches
        """
        cmd = ["git", "fetch", "--all"]
        if prune:
            cmd.append("--prune")

        await self._run_command(cmd, timeout=60)

    async def get_local_branches(self) -> list[Branch]:
        """Get all local branches with their information."""
        cmd = [
            "git",
            "for-each-ref",
            "--format=%(refname:short)|%(objectname)|%(upstream:short)|%(committerdate:iso8601)|%(authorname)|%(subject)",
            "refs/heads/",
        ]

        _, stdout, _ = await self._run_command(cmd)

        branches = []
        for line in stdout.strip().split("\n"):
            if not line:
                continue

            parts = line.split("|")
            if len(parts) < 6:
                continue

            name, sha, upstream, date_str, author, message = parts
            upstream_value: str | None = upstream if upstream else None

            # Parse date
            try:
                commit_date = datetime.fromisoformat(date_str.replace(" ", "T"))
            except (ValueError, AttributeError):
                commit_date = None

            branch = Branch(
                name=name,
                sha=sha,
                is_local=True,
                is_remote=False,
                upstream=upstream_value,
                last_commit_date=commit_date,
                last_commit_author=author,
                last_commit_message=message,
            )

            branches.append(branch)

        return branches

    async def get_remote_branches(self, remote: str = "origin") -> list[Branch]:
        """Get all remote branches."""
        cmd = [
            "git",
            "for-each-ref",
            "--format=%(refname:short)|%(objectname)|%(committerdate:iso8601)|%(authorname)|%(subject)",
            f"refs/remotes/{remote}/",
        ]

        _, stdout, _ = await self._run_command(cmd)

        branches = []
        for line in stdout.strip().split("\n"):
            if not line:
                continue

            parts = line.split("|")
            if len(parts) < 5:
                continue

            full_name, sha, date_str, author, message = parts

            # Remove remote prefix from name
            name = full_name.replace(f"{remote}/", "")

            # Skip HEAD reference
            if name == "HEAD":
                continue

            # Parse date
            try:
                commit_date = datetime.fromisoformat(date_str.replace(" ", "T"))
            except (ValueError, AttributeError):
                commit_date = None

            branch = Branch(
                name=name,
                sha=sha,
                is_local=False,
                is_remote=True,
                last_commit_date=commit_date,
                last_commit_author=author,
                last_commit_message=message,
            )

            branches.append(branch)

        return branches

    async def compute_branch_status(
        self,
        local_branch: Branch,
        remote_branch: Branch | None,
        remote: str = "origin",
    ) -> tuple[BranchStatus, int, int]:
        """
        Compute the status of a local branch relative to its remote.

        Args:
            local_branch: Local branch object
            remote_branch: Remote branch object (or None if no remote)
            remote: Remote name

        Returns:
            Tuple of (status, ahead_count, behind_count)
        """
        if remote_branch is None:
            return BranchStatus.LOCAL_ONLY, 0, 0

        # Compare SHAs
        if local_branch.sha == remote_branch.sha:
            return BranchStatus.UP_TO_DATE, 0, 0

        # Get ahead/behind counts
        try:
            cmd = [
                "git",
                "rev-list",
                "--left-right",
                "--count",
                f"{local_branch.name}...{remote}/{remote_branch.name}",
            ]

            returncode, stdout, _ = await self._run_command(cmd, check=False)

            if returncode != 0:
                return BranchStatus.UNKNOWN, 0, 0

            parts = stdout.strip().split()
            if len(parts) != 2:
                return BranchStatus.UNKNOWN, 0, 0

            ahead = int(parts[0])
            behind = int(parts[1])

            if ahead > 0 and behind > 0:
                return BranchStatus.DIVERGED, ahead, behind
            if ahead > 0:
                return BranchStatus.AHEAD, ahead, behind
            if behind > 0:
                return BranchStatus.BEHIND, ahead, behind
            return BranchStatus.UP_TO_DATE, ahead, behind

        except (ValueError, GitClientError):
            return BranchStatus.UNKNOWN, 0, 0

    async def get_all_branches_with_status(
        self,
        remote: str = "origin",
    ) -> tuple[list[Branch], list[Branch]]:
        """
        Get all branches (local and remote) with computed status.

        Args:
            remote: Remote name

        Returns:
            Tuple of (local_branches, remote_branches) with status computed
        """
        # Fetch local and remote branches concurrently
        local_branches, remote_branches = await asyncio.gather(
            self.get_local_branches(),
            self.get_remote_branches(remote),
        )

        # Build lookup for remote branches
        remote_lookup = {branch.name: branch for branch in remote_branches}

        # Compute status for each local branch
        for local_branch in local_branches:
            remote_branch = remote_lookup.get(local_branch.name)

            if remote_branch:
                status, ahead, behind = await self.compute_branch_status(
                    local_branch,
                    remote_branch,
                    remote,
                )
                local_branch.status = status
                local_branch.ahead_by = ahead
                local_branch.behind_by = behind
            else:
                local_branch.status = BranchStatus.LOCAL_ONLY

        return local_branches, remote_branches

    async def get_default_branch(self) -> str:
        """Detect the default branch of the repository."""
        # Try to get from remote HEAD
        cmd = ["git", "symbolic-ref", "refs/remotes/origin/HEAD"]
        returncode, stdout, _ = await self._run_command(cmd, check=False)

        if returncode == 0 and stdout:
            branch = stdout.strip().split("/")[-1]
            if branch:
                return branch

        # Fallback: check common branch names
        for branch in ["main", "master", "develop"]:
            cmd = ["git", "rev-parse", "--verify", f"origin/{branch}"]
            returncode, _, _ = await self._run_command(cmd, check=False)
            if returncode == 0:
                return branch

        return "main"

    async def get_current_branch(self) -> str | None:
        """Get the currently checked out branch."""
        cmd = ["git", "rev-parse", "--abbrev-ref", "HEAD"]
        returncode, stdout, _ = await self._run_command(cmd, check=False)

        if returncode == 0 and stdout:
            branch = stdout.strip()
            if branch != "HEAD":
                return branch

        return None

    async def get_repository_info(self) -> dict[str, Any]:
        """Get general repository information."""
        info: dict[str, Any] = {
            "path": str(self.repo_path),
        }

        # Run these concurrently
        default_branch_task = self.get_default_branch()
        current_branch_task = self.get_current_branch()

        info["default_branch"], info["current_branch"] = await asyncio.gather(
            default_branch_task, current_branch_task
        )

        # Get remote URL
        cmd = ["git", "remote", "get-url", "origin"]
        returncode, stdout, _ = await self._run_command(cmd, check=False)
        if returncode == 0:
            info["remote_url"] = stdout.strip()

        return info

    async def get_repo_name(self) -> str | None:
        """Extract repository name from remote URL."""
        cmd = ["git", "remote", "get-url", "origin"]
        returncode, stdout, _ = await self._run_command(cmd, check=False)

        if returncode != 0:
            return None

        url = stdout.strip()

        if "github.com" not in url:
            return None

        if url.startswith("git@github.com:"):
            repo_part = url.replace("git@github.com:", "").replace(".git", "")
        elif "github.com/" in url:
            repo_part = url.split("github.com/")[-1].replace(".git", "")
        else:
            return None

        parts = repo_part.split("/")
        if len(parts) >= 2:
            return parts[1]  # Return just the repo name

        return None

    async def get_repo_full_name(self) -> str | None:
        """Extract owner/repo from remote URL."""
        cmd = ["git", "remote", "get-url", "origin"]
        returncode, stdout, _ = await self._run_command(cmd, check=False)

        if returncode != 0:
            return None

        url = stdout.strip()

        if "github.com" not in url:
            return None

        if url.startswith("git@github.com:"):
            return url.replace("git@github.com:", "").replace(".git", "")
        if "github.com/" in url:
            return url.split("github.com/")[-1].replace(".git", "")

        return None
