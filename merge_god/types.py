"""
Type definitions for merge-god.

This module contains TypedDict definitions, enums, and other type structures
used throughout the application to replace dict[str, Any] with proper types.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import NotRequired, TypedDict

# ============================================================================
# Enums
# ============================================================================


class ProcessingMode(str, Enum):
    """PR processing modes"""

    FOR_REVIEW = "for-review"
    FOR_LANDING = "for-landing"


class AgentStatus(str, Enum):
    """Agent execution status"""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"


class TaskStatus(str, Enum):
    """Task execution status"""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


class ActionType(str, Enum):
    """Agent action types"""

    READ_FILE = "read_file"
    EDIT_FILE = "edit_file"
    LIST_FILES = "list_files"
    RUN_TESTS = "run_tests"
    GIT_COMMIT = "git_commit"


class ProcessStatus(str, Enum):
    """Process execution status"""

    IDLE = "idle"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"


# ============================================================================
# Configuration Types
# ============================================================================


class RepoConfig(TypedDict):
    """Repository configuration"""

    name: str
    path: str
    enabled: bool
    tags: NotRequired[list[str]]
    watch_issues: NotRequired[bool]


class Config(TypedDict):
    """Application configuration"""

    repos: list[RepoConfig]
    default_mode: NotRequired[str]
    model: NotRequired[str]
    database_path: NotRequired[str]


# ============================================================================
# PR Context Types
# ============================================================================


class PRComment(TypedDict):
    """PR comment data"""

    id: int
    author: str
    body: str
    created_at: str
    updated_at: NotRequired[str]


class ReviewComment(TypedDict):
    """PR review comment data"""

    id: int
    author: str
    body: str
    path: str
    line: NotRequired[int]
    created_at: str


class CommitInfo(TypedDict):
    """Commit information"""

    sha: str
    message: str
    author: str
    date: str


class FileChange(TypedDict):
    """File change information"""

    filename: str
    status: str
    additions: int
    deletions: int
    changes: int
    patch: NotRequired[str]


class ConflictInfo(TypedDict):
    """Merge conflict information"""

    has_conflicts: bool
    conflicting_files: list[str]
    conflict_count: NotRequired[int]
    error: NotRequired[str]


class CIStatusInfo(TypedDict):
    """CI status information"""

    total: int
    passed: int
    failed: int
    pending: int
    failed_checks: list[str]


class PRDetails(TypedDict):
    """PR details from GitHub API"""

    number: int
    title: str
    body: NotRequired[str]
    headRefName: str
    baseRefName: str
    author: dict[str, str]
    isDraft: bool
    labels: list[str]
    statusCheckRollup: NotRequired[list[dict[str, str]]]


class PRContextDict(TypedDict):
    """Complete PR context for agent processing"""

    url: str
    comments: list[PRComment]
    review_comments: list[ReviewComment]
    commits: list[CommitInfo]
    files: list[FileChange]
    conflicts: ConflictInfo
    ci_status: CIStatusInfo
    diff: str
    guidelines: NotRequired[str]
    commit_examples: NotRequired[str]


# ============================================================================
# Agent Types
# ============================================================================


class ActionDetails(TypedDict, total=False):
    """Details for agent actions (total=False means all fields are optional)"""

    path: str
    pattern: str
    changes: list[dict[str, str]]
    message: str
    files: list[str]
    test_path: str


class ToolResult(TypedDict):
    """Result from tool execution"""

    success: bool
    data: NotRequired[dict[str, str | int | list[str]]]
    error: NotRequired[str]


class AgentActionDict(TypedDict):
    """Agent action dictionary"""

    type: str
    details: ActionDetails
    status: str
    result: NotRequired[ToolResult]


class SessionStats(TypedDict):
    """Agent session statistics"""

    tasks_total: int
    tasks_completed: int
    tasks_failed: int
    actions_total: int
    input_tokens: NotRequired[int]
    output_tokens: NotRequired[int]
    total_tokens: NotRequired[int]
    estimated_cost: NotRequired[float]


# ============================================================================
# Event/Log Types
# ============================================================================


class LogEvent(TypedDict):
    """Structured log event"""

    timestamp: str
    event: str
    data: dict[str, str | int | bool | list[str]]


class ThinkingEvent(TypedDict):
    """Agent thinking event"""

    type: str  # "thinking"
    content: str


class ActionEvent(TypedDict):
    """Agent action event"""

    type: str  # "action"
    action: AgentActionDict


class ErrorEvent(TypedDict):
    """Agent error event"""

    type: str  # "error"
    error: str


# ============================================================================
# Database Types
# ============================================================================


class PRSnapshot(TypedDict):
    """PR snapshot from database"""

    id: int
    repo_name: str
    pr_number: int
    title: str
    state: str
    head_branch: str
    base_branch: str
    author: str
    url: str
    snapshot_at: str
    pr_data: str  # JSON


class AgentSessionRecord(TypedDict):
    """Agent session database record"""

    id: int
    repo_name: str
    pr_number: int
    session_id: str
    mode: str
    model: str
    agent_version: str
    status: str
    started_at: str
    completed_at: NotRequired[str]
    success: NotRequired[bool]
    error_message: NotRequired[str]
    tasks_total: NotRequired[int]
    tasks_completed: NotRequired[int]
    tasks_failed: NotRequired[int]
    actions_total: NotRequired[int]
    input_tokens: NotRequired[int]
    output_tokens: NotRequired[int]
    total_tokens: NotRequired[int]
    estimated_cost: NotRequired[float]
    duration_seconds: NotRequired[float]


class FileOperationRecord(TypedDict):
    """File operation database record"""

    id: int
    session_id: str
    action_id: NotRequired[int]
    operation_type: str
    file_path: str
    file_size: NotRequired[int]
    lines_added: NotRequired[int]
    lines_deleted: NotRequired[int]
    success: bool
    error_message: NotRequired[str]
    timestamp: str


# ============================================================================
# Dashboard Types
# ============================================================================


class PRQueueItem(TypedDict):
    """PR in the processing queue"""

    number: int
    title: str
    author: str
    labels: list[str]
    ci_failing: bool
    has_conflicts: bool
    draft: bool


class DashboardState(TypedDict):
    """Dashboard state"""

    prs_processed: int
    successes: int
    failures: int
    iteration: int


class ProcessingHistoryItem(TypedDict):
    """Processing history item"""

    id: int
    repo_name: str
    pr_number: int
    action_type: str
    started_at: str
    completed_at: NotRequired[str]
    success: NotRequired[bool]
    error_message: NotRequired[str]
    duration_seconds: NotRequired[float]


# ============================================================================
# Validation Types
# ============================================================================


class ValidationResult(TypedDict):
    """Validation result"""

    name: str
    valid: bool
    errors: list[str]
    note: NotRequired[str]
    pr_count: NotRequired[int]


class ProcessValidationResults(TypedDict):
    """Process validation results"""

    process_1: ValidationResult
    process_2: ValidationResult
    process_3: ValidationResult


# ============================================================================
# Dataclasses for Complex Structures
# ============================================================================


@dataclass
class GitHubCredentials:
    """GitHub authentication credentials"""

    token: str
    api_url: str = "https://api.github.com"


@dataclass
class AgentConfig:
    """Agent configuration"""

    model: str
    mode: ProcessingMode
    repo_path: str
    session_id: str | None = None
    max_retries: int = 3
    timeout_seconds: int = 300


@dataclass
class ProcessingMetrics:
    """Processing metrics"""

    start_time: datetime
    end_time: datetime | None = None
    total_prs: int = 0
    processed_prs: int = 0
    successful: int = 0
    failed: int = 0
    skipped: int = 0

    @property
    def duration_seconds(self) -> float:
        """Calculate duration in seconds"""
        if self.end_time:
            return (self.end_time - self.start_time).total_seconds()
        return (datetime.now(UTC) - self.start_time).total_seconds()

    @property
    def success_rate(self) -> float:
        """Calculate success rate"""
        if self.processed_prs == 0:
            return 0.0
        return self.successful / self.processed_prs
