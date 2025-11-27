"""
Data models for the github_sync library.

This module defines the core data structures for branch and PR tracking.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class BranchStatus(Enum):
    """Status of a branch relative to its remote."""

    UP_TO_DATE = "up_to_date"
    AHEAD = "ahead"
    BEHIND = "behind"
    DIVERGED = "diverged"
    LOCAL_ONLY = "local_only"
    REMOTE_ONLY = "remote_only"
    UNKNOWN = "unknown"


class PRState(Enum):
    """State of a pull request."""

    OPEN = "open"
    CLOSED = "closed"
    MERGED = "merged"
    DRAFT = "draft"


class CIStatus(Enum):
    """CI/CD check status."""

    SUCCESS = "success"
    FAILURE = "failure"
    PENDING = "pending"
    NONE = "none"


@dataclass
class Branch:
    """Represents a git branch with tracking information."""

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

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "sha": self.sha,
            "is_local": self.is_local,
            "is_remote": self.is_remote,
            "upstream": self.upstream,
            "status": self.status.value,
            "ahead_by": self.ahead_by,
            "behind_by": self.behind_by,
            "last_commit_date": self.last_commit_date.isoformat()
            if self.last_commit_date
            else None,
            "last_commit_author": self.last_commit_author,
            "last_commit_message": self.last_commit_message,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Branch":
        """Create from dictionary."""
        return cls(
            name=data["name"],
            sha=data["sha"],
            is_local=data["is_local"],
            is_remote=data["is_remote"],
            upstream=data.get("upstream"),
            status=BranchStatus(data.get("status", "unknown")),
            ahead_by=data.get("ahead_by", 0),
            behind_by=data.get("behind_by", 0),
            last_commit_date=(
                datetime.fromisoformat(data["last_commit_date"])
                if data.get("last_commit_date")
                else None
            ),
            last_commit_author=data.get("last_commit_author"),
            last_commit_message=data.get("last_commit_message"),
        )


@dataclass
class CICheck:
    """Represents a single CI/CD check."""

    name: str
    status: CIStatus
    conclusion: str | None = None
    details_url: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "status": self.status.value,
            "conclusion": self.conclusion,
            "details_url": self.details_url,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CICheck":
        """Create from dictionary."""
        return cls(
            name=data["name"],
            status=CIStatus(data.get("status", "none")),
            conclusion=data.get("conclusion"),
            details_url=data.get("details_url"),
            started_at=(
                datetime.fromisoformat(data["started_at"]) if data.get("started_at") else None
            ),
            completed_at=(
                datetime.fromisoformat(data["completed_at"]) if data.get("completed_at") else None
            ),
        )


@dataclass
class PullRequest:
    """Represents a GitHub pull request with comprehensive tracking."""

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
        """Get overall CI status."""
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
        """Determine processing mode from labels."""
        label_set = {label.lower() for label in self.labels}

        if "for-review" in label_set:
            return "for-review"
        if "for-landing" in label_set:
            return "for-landing"

        return None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "number": self.number,
            "title": self.title,
            "state": self.state.value,
            "head_branch": self.head_branch,
            "base_branch": self.base_branch,
            "author": self.author,
            "url": self.url,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "body": self.body,
            "draft": self.draft,
            "mergeable": self.mergeable,
            "labels": self.labels,
            "ci_checks": [check.to_dict() for check in self.ci_checks],
            "ci_summary": self.ci_summary,
            "review_decision": self.review_decision,
            "approved_by": self.approved_by,
            "changes_requested_by": self.changes_requested_by,
            "additions": self.additions,
            "deletions": self.deletions,
            "changed_files": self.changed_files,
            "commits": self.commits,
            "has_conflicts": self.has_conflicts,
            "conflicting_files": self.conflicting_files,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PullRequest":
        """Create from dictionary."""
        return cls(
            number=data["number"],
            title=data["title"],
            state=PRState(data["state"]),
            head_branch=data["head_branch"],
            base_branch=data["base_branch"],
            author=data["author"],
            url=data["url"],
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
            body=data.get("body"),
            draft=data.get("draft", False),
            mergeable=data.get("mergeable", True),
            labels=data.get("labels", []),
            ci_checks=[CICheck.from_dict(c) for c in data.get("ci_checks", [])],
            ci_summary=data.get("ci_summary", {}),
            review_decision=data.get("review_decision"),
            approved_by=data.get("approved_by", []),
            changes_requested_by=data.get("changes_requested_by", []),
            additions=data.get("additions", 0),
            deletions=data.get("deletions", 0),
            changed_files=data.get("changed_files", 0),
            commits=data.get("commits", 0),
            has_conflicts=data.get("has_conflicts", False),
            conflicting_files=data.get("conflicting_files", []),
        )


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
        """Compute derived state after initialization."""
        self.has_pr = self.pr is not None

        if self.local_branch and self.remote_branch:
            self.branch_status = self.local_branch.status
            self.is_tracked = True
            self.needs_push = self.local_branch.status in [
                BranchStatus.AHEAD,
                BranchStatus.DIVERGED,
            ]
            self.needs_pull = self.local_branch.status in [
                BranchStatus.BEHIND,
                BranchStatus.DIVERGED,
            ]
        elif self.local_branch:
            self.branch_status = BranchStatus.LOCAL_ONLY
            self.is_tracked = False
        elif self.remote_branch:
            self.branch_status = BranchStatus.REMOTE_ONLY
            self.is_tracked = False

        if self.pr:
            self.ci_status = self.pr.get_ci_status()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "branch_name": self.branch_name,
            "local_branch": self.local_branch.to_dict() if self.local_branch else None,
            "remote_branch": self.remote_branch.to_dict() if self.remote_branch else None,
            "branch_status": self.branch_status.value,
            "pr": self.pr.to_dict() if self.pr else None,
            "is_tracked": self.is_tracked,
            "needs_push": self.needs_push,
            "needs_pull": self.needs_pull,
            "has_pr": self.has_pr,
            "ci_status": self.ci_status.value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BranchPRState":
        """Create from dictionary."""
        return cls(
            branch_name=data["branch_name"],
            local_branch=Branch.from_dict(data["local_branch"])
            if data.get("local_branch")
            else None,
            remote_branch=Branch.from_dict(data["remote_branch"])
            if data.get("remote_branch")
            else None,
            pr=PullRequest.from_dict(data["pr"]) if data.get("pr") else None,
        )


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
        """Add a branch/PR state and update indexes."""
        self.branch_pr_states.append(state)
        self._by_branch[state.branch_name] = state
        if state.pr:
            self._by_pr_number[state.pr.number] = state

    def get_by_branch(self, branch_name: str) -> BranchPRState | None:
        """Get state by branch name."""
        return self._by_branch.get(branch_name)

    def get_by_pr(self, pr_number: int) -> BranchPRState | None:
        """Get state by PR number."""
        return self._by_pr_number.get(pr_number)

    def get_branches_with_prs(self) -> list[BranchPRState]:
        """Get all branches that have associated PRs."""
        return [state for state in self.branch_pr_states if state.has_pr]

    def get_branches_without_prs(self) -> list[BranchPRState]:
        """Get all branches without PRs."""
        return [state for state in self.branch_pr_states if not state.has_pr]

    def get_branches_needing_sync(self) -> list[BranchPRState]:
        """Get branches that need push or pull."""
        return [state for state in self.branch_pr_states if state.needs_push or state.needs_pull]

    def get_failing_ci(self) -> list[BranchPRState]:
        """Get branches with failing CI."""
        return [state for state in self.branch_pr_states if state.ci_status == CIStatus.FAILURE]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "repo_path": self.repo_path,
            "default_branch": self.default_branch,
            "branch_pr_states": [state.to_dict() for state in self.branch_pr_states],
            "last_updated": self.last_updated.isoformat() if self.last_updated else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RepositoryState":
        """Create from dictionary."""
        state = cls(
            repo_path=data["repo_path"],
            default_branch=data["default_branch"],
            last_updated=(
                datetime.fromisoformat(data["last_updated"]) if data.get("last_updated") else None
            ),
        )
        for bps_data in data.get("branch_pr_states", []):
            state.add_state(BranchPRState.from_dict(bps_data))
        return state


@dataclass
class PRContext:
    """Complete context for a PR, including diff, comments, and metadata."""

    repo_name: str
    pr_number: int
    pr_url: str
    diff: str
    body: str
    comments: list[dict[str, Any]] = field(default_factory=list)
    review_comments: list[dict[str, Any]] = field(default_factory=list)
    commits: list[dict[str, Any]] = field(default_factory=list)
    files: list[dict[str, Any]] = field(default_factory=list)
    conflicts: dict[str, Any] = field(default_factory=dict)
    ci_checks: dict[str, Any] = field(default_factory=dict)
    guidelines: str = ""
    commit_examples: str = ""
    captured_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "repo_name": self.repo_name,
            "pr_number": self.pr_number,
            "pr_url": self.pr_url,
            "diff": self.diff,
            "body": self.body,
            "comments": self.comments,
            "review_comments": self.review_comments,
            "commits": self.commits,
            "files": self.files,
            "conflicts": self.conflicts,
            "ci_checks": self.ci_checks,
            "guidelines": self.guidelines,
            "commit_examples": self.commit_examples,
            "captured_at": self.captured_at.isoformat() if self.captured_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PRContext":
        """Create from dictionary."""
        return cls(
            repo_name=data["repo_name"],
            pr_number=data["pr_number"],
            pr_url=data.get("pr_url", ""),
            diff=data.get("diff", ""),
            body=data.get("body", ""),
            comments=data.get("comments", []),
            review_comments=data.get("review_comments", []),
            commits=data.get("commits", []),
            files=data.get("files", []),
            conflicts=data.get("conflicts", {}),
            ci_checks=data.get("ci_checks", {}),
            guidelines=data.get("guidelines", ""),
            commit_examples=data.get("commit_examples", ""),
            captured_at=(
                datetime.fromisoformat(data["captured_at"]) if data.get("captured_at") else None
            ),
        )
