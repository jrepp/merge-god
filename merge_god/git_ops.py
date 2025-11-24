"""
Git operations module for branch state analysis.

This module handles all git-related operations including:
- Fetching branches (local and remote)
- Computing branch status (ahead/behind)
- Analyzing branch relationships
"""

import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from .models import Branch, BranchStatus

# Constants for git command parsing
EXPECTED_LOCAL_BRANCH_FIELDS = 6  # Expected fields in local branch format output
EXPECTED_REMOTE_BRANCH_FIELDS = 5  # Expected fields in remote branch format output
EXPECTED_REV_LIST_PARTS = 2  # Expected parts in rev-list output (ahead, behind)


class GitOperationsError(Exception):
    """Exception raised for git operation errors"""


class GitOperations:
    """Handles git operations for branch analysis"""

    def __init__(self, repo_path: Path):
        """
        Initialize git operations for a repository.

        Args:
            repo_path: Path to the git repository
        """
        self.repo_path = repo_path
        self._validate_repo()

    def _validate_repo(self) -> None:
        """Validate that the path is a valid git repository"""
        if not self.repo_path.exists():
            raise GitOperationsError(f"Repository path does not exist: {self.repo_path}")

        git_dir = self.repo_path / ".git"
        if not git_dir.exists():
            raise GitOperationsError(f"Not a git repository: {self.repo_path}")

    def _run_command(
        self,
        cmd: list[str],
        timeout: int = 30,
        check: bool = True,
    ) -> tuple[int, str, str]:
        """
        Run a git command in the repository.

        Args:
            cmd: Command and arguments
            timeout: Timeout in seconds
            check: Raise exception on non-zero exit code

        Returns:
            Tuple of (returncode, stdout, stderr)
        """
        try:
            result = subprocess.run(
                cmd,
                check=False,
                cwd=self.repo_path,
                capture_output=True,
                text=True,
                timeout=timeout,
            )

            if check and result.returncode != 0:
                raise GitOperationsError(
                    f"Command failed: {' '.join(cmd)}\n"
                    f"Exit code: {result.returncode}\n"
                    f"Stderr: {result.stderr}",
                )

            return result.returncode, result.stdout, result.stderr

        except subprocess.TimeoutExpired as e:
            raise GitOperationsError(f"Command timed out: {' '.join(cmd)}") from e
        except Exception as e:
            raise GitOperationsError(f"Command error: {e}") from e

    def fetch_all(self, prune: bool = True) -> None:
        """
        Fetch all remotes.

        Args:
            prune: Whether to prune deleted remote branches
        """
        cmd = ["git", "fetch", "--all"]
        if prune:
            cmd.append("--prune")

        self._run_command(cmd, timeout=30)

    def get_local_branches(self) -> list[Branch]:
        """
        Get all local branches with their information.

        Returns:
            List of Branch objects for local branches
        """
        # Get branch info: name, sha, upstream, last commit details
        cmd = [
            "git",
            "for-each-ref",
            "--format=%(refname:short)|%(objectname)|%(upstream:short)|%(committerdate:iso8601)|%(authorname)|%(subject)",
            "refs/heads/",
        ]

        _returncode, stdout, _stderr = self._run_command(cmd)

        branches = []
        for line in stdout.strip().split("\n"):
            if not line:
                continue

            parts = line.split("|")
            if len(parts) < EXPECTED_LOCAL_BRANCH_FIELDS:
                continue

            name, sha, upstream_str, date_str, author, message = parts
            upstream: str | None = upstream_str if upstream_str else None

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
                upstream=upstream,
                last_commit_date=commit_date,
                last_commit_author=author,
                last_commit_message=message,
            )

            branches.append(branch)

        return branches

    def get_remote_branches(self, remote: str = "origin") -> list[Branch]:
        """
        Get all remote branches.

        Args:
            remote: Remote name (default: origin)

        Returns:
            List of Branch objects for remote branches
        """
        cmd = [
            "git",
            "for-each-ref",
            "--format=%(refname:short)|%(objectname)|%(committerdate:iso8601)|%(authorname)|%(subject)",
            f"refs/remotes/{remote}/",
        ]

        _returncode, stdout, _stderr = self._run_command(cmd)

        branches = []
        for line in stdout.strip().split("\n"):
            if not line:
                continue

            parts = line.split("|")
            if len(parts) < EXPECTED_REMOTE_BRANCH_FIELDS:
                continue

            full_name, sha, date_str, author, message = parts

            # Remove remote prefix from name (e.g., "origin/main" -> "main")
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

    def compute_branch_status(
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

            returncode, stdout, _stderr = self._run_command(cmd, check=False)

            if returncode != 0:
                return BranchStatus.UNKNOWN, 0, 0

            parts = stdout.strip().split()
            if len(parts) != EXPECTED_REV_LIST_PARTS:
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

        except (ValueError, GitOperationsError):
            return BranchStatus.UNKNOWN, 0, 0

    def get_all_branches_with_status(
        self,
        remote: str = "origin",
    ) -> tuple[list[Branch], list[Branch]]:
        """
        Get all branches (local and remote) with computed status.

        This is the main entry point for getting complete branch information.

        Args:
            remote: Remote name

        Returns:
            Tuple of (local_branches, remote_branches) with status computed
        """
        # Get local and remote branches
        local_branches = self.get_local_branches()
        remote_branches = self.get_remote_branches(remote)

        # Build lookup for remote branches
        remote_lookup = {branch.name: branch for branch in remote_branches}

        # Compute status for each local branch
        for local_branch in local_branches:
            remote_branch = remote_lookup.get(local_branch.name)

            if remote_branch:
                status, ahead, behind = self.compute_branch_status(
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

    def get_default_branch(self) -> str:
        """
        Detect the default branch of the repository.

        Returns:
            Default branch name (e.g., "main", "master")
        """
        # Try to get from remote HEAD
        cmd = ["git", "symbolic-ref", "refs/remotes/origin/HEAD"]
        returncode, stdout, _ = self._run_command(cmd, check=False)

        if returncode == 0 and stdout:
            # Output is like "refs/remotes/origin/main"
            branch = stdout.strip().split("/")[-1]
            if branch:
                return branch

        # Fallback: check common branch names
        for branch in ["main", "master", "develop"]:
            cmd = ["git", "rev-parse", "--verify", f"origin/{branch}"]
            returncode, stdout, _stderr = self._run_command(cmd, check=False)
            if returncode == 0:
                return branch

        # Last resort: use "main"
        return "main"

    def get_current_branch(self) -> str | None:
        """
        Get the currently checked out branch.

        Returns:
            Branch name or None if in detached HEAD state
        """
        cmd = ["git", "rev-parse", "--abbrev-ref", "HEAD"]
        returncode, stdout, _stderr = self._run_command(cmd, check=False)

        if returncode == 0 and stdout:
            branch = stdout.strip()
            if branch != "HEAD":
                return branch

        return None

    def get_repository_info(self) -> dict[str, Any]:
        """
        Get general repository information.

        Returns:
            Dictionary with repository metadata
        """
        info = {
            "path": str(self.repo_path),
            "default_branch": self.get_default_branch(),
            "current_branch": self.get_current_branch(),
        }

        # Get remote URL
        cmd = ["git", "remote", "get-url", "origin"]
        returncode, stdout, _stderr = self._run_command(cmd, check=False)
        if returncode == 0:
            info["remote_url"] = stdout.strip()

        return info
