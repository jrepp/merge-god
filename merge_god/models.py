"""
Data models for branch and PR tracking system.

This module defines the core data structures used throughout the tracking system.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class BranchStatus(Enum):
    """Status of a branch relative to its remote"""
    UP_TO_DATE = "up_to_date"
    AHEAD = "ahead"
    BEHIND = "behind"
    DIVERGED = "diverged"
    LOCAL_ONLY = "local_only"
    REMOTE_ONLY = "remote_only"
    UNKNOWN = "unknown"


class PRState(Enum):
    """State of a pull request"""
    OPEN = "open"
    CLOSED = "closed"
    MERGED = "merged"
    DRAFT = "draft"


class CIStatus(Enum):
    """CI/CD check status"""
    SUCCESS = "success"
    FAILURE = "failure"
    PENDING = "pending"
    NONE = "none"


@dataclass
class Branch:
    """Represents a git branch with tracking information"""
    name: str
    sha: str
    is_local: bool
    is_remote: bool
    upstream: str | None = None
    status: BranchStatus = BranchStatus.UNKNOWN
    ahead_by: int = 0
    behind_by: int = 0
    last_commit_date: datetime | None = None
    last_commit_author: str | None = None
    last_commit_message: str | None = None


@dataclass
class CICheck:
    """Represents a single CI/CD check"""
    name: str
    status: CIStatus
    conclusion: str | None = None
    details_url: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass
class PullRequest:
    """Represents a GitHub pull request with comprehensive tracking"""
    number: int
    title: str
    state: PRState
    head_branch: str
    base_branch: str
    author: str
    url: str
    created_at: datetime
    updated_at: datetime

    # Optional fields
    body: str | None = None
    draft: bool = False
    mergeable: bool = True
    labels: list[str] = field(default_factory=list)

    # CI/CD tracking
    ci_checks: list[CICheck] = field(default_factory=list)
    ci_summary: dict[str, int] = field(default_factory=dict)

    # Review tracking
    review_decision: str | None = None
    approved_by: list[str] = field(default_factory=list)
    changes_requested_by: list[str] = field(default_factory=list)

    # Statistics
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0
    commits: int = 0

    # Conflict tracking
    has_conflicts: bool = False
    conflicting_files: list[str] = field(default_factory=list)

    def get_ci_status(self) -> CIStatus:
        """Get overall CI status"""
        if not self.ci_checks:
            return CIStatus.NONE

        if any(check.status == CIStatus.FAILURE for check in self.ci_checks):
            return CIStatus.FAILURE
        if any(check.status == CIStatus.PENDING for check in self.ci_checks):
            return CIStatus.PENDING
        if all(check.status == CIStatus.SUCCESS for check in self.ci_checks):
            return CIStatus.SUCCESS

        return CIStatus.NONE

    def get_processing_mode(self) -> str | None:
        """Determine processing mode from labels"""
        label_set = {label.lower() for label in self.labels}

        if "for-review" in label_set:
            return "for-review"
        if "for-landing" in label_set:
            return "for-landing"

        return None


@dataclass
class BranchPRState:
    """
    Represents the combined state of a branch and its associated PR.

    This is the primary data structure that correlates local/remote branches
    with their corresponding PRs, providing a unified view.
    """
    branch_name: str

    # Branch information
    local_branch: Branch | None = None
    remote_branch: Branch | None = None
    branch_status: BranchStatus = BranchStatus.UNKNOWN

    # PR information
    pr: PullRequest | None = None

    # Computed state
    is_tracked: bool = False
    needs_push: bool = False
    needs_pull: bool = False
    has_pr: bool = False
    ci_status: CIStatus = CIStatus.NONE

    def __post_init__(self):
        """Compute derived state after initialization"""
        self.has_pr = self.pr is not None

        if self.local_branch and self.remote_branch:
            self.branch_status = self.local_branch.status
            self.is_tracked = True
            self.needs_push = self.local_branch.status in [BranchStatus.AHEAD, BranchStatus.DIVERGED]
            self.needs_pull = self.local_branch.status in [BranchStatus.BEHIND, BranchStatus.DIVERGED]
        elif self.local_branch:
            self.branch_status = BranchStatus.LOCAL_ONLY
            self.is_tracked = False
        elif self.remote_branch:
            self.branch_status = BranchStatus.REMOTE_ONLY
            self.is_tracked = False

        if self.pr:
            self.ci_status = self.pr.get_ci_status()

    def summary_dict(self) -> dict[str, Any]:
        """Get a summary dictionary for display/logging"""
        return {
            "branch": self.branch_name,
            "status": self.branch_status.value,
            "has_pr": self.has_pr,
            "pr_number": self.pr.number if self.pr else None,
            "pr_state": self.pr.state.value if self.pr else None,
            "ci_status": self.ci_status.value,
            "ahead_by": self.local_branch.ahead_by if self.local_branch else 0,
            "behind_by": self.local_branch.behind_by if self.local_branch else 0,
            "needs_push": self.needs_push,
            "needs_pull": self.needs_pull,
        }


@dataclass
class RepositoryState:
    """
    Complete state of a repository including all branches and PRs.

    This is the top-level data structure that aggregates all tracking information.
    """
    repo_path: str
    default_branch: str

    # All tracked items
    branch_pr_states: list[BranchPRState] = field(default_factory=list)

    # Indexes for fast lookup
    _by_branch: dict[str, BranchPRState] = field(default_factory=dict, repr=False)
    _by_pr_number: dict[int, BranchPRState] = field(default_factory=dict, repr=False)

    # Metadata
    last_updated: datetime | None = None

    def add_state(self, state: BranchPRState) -> None:
        """Add a branch/PR state and update indexes"""
        self.branch_pr_states.append(state)
        self._by_branch[state.branch_name] = state
        if state.pr:
            self._by_pr_number[state.pr.number] = state

    def get_by_branch(self, branch_name: str) -> BranchPRState | None:
        """Get state by branch name"""
        return self._by_branch.get(branch_name)

    def get_by_pr(self, pr_number: int) -> BranchPRState | None:
        """Get state by PR number"""
        return self._by_pr_number.get(pr_number)

    def get_branches_with_prs(self) -> list[BranchPRState]:
        """Get all branches that have associated PRs"""
        return [state for state in self.branch_pr_states if state.has_pr]

    def get_branches_without_prs(self) -> list[BranchPRState]:
        """Get all branches without PRs"""
        return [state for state in self.branch_pr_states if not state.has_pr]

    def get_branches_needing_sync(self) -> list[BranchPRState]:
        """Get branches that need push or pull"""
        return [state for state in self.branch_pr_states
                if state.needs_push or state.needs_pull]

    def get_failing_ci(self) -> list[BranchPRState]:
        """Get branches with failing CI"""
        return [state for state in self.branch_pr_states
                if state.ci_status == CIStatus.FAILURE]

    def summary_dict(self) -> dict[str, Any]:
        """Get a summary dictionary for display/logging"""
        return {
            "repo_path": self.repo_path,
            "default_branch": self.default_branch,
            "total_branches": len(self.branch_pr_states),
            "branches_with_prs": len(self.get_branches_with_prs()),
            "branches_without_prs": len(self.get_branches_without_prs()),
            "branches_needing_sync": len(self.get_branches_needing_sync()),
            "failing_ci": len(self.get_failing_ci()),
            "last_updated": self.last_updated.isoformat() if self.last_updated else None,
        }
