"""
Extensible action system for sync_store operations.

Actions provide a high-level, composable API for common operations.
They can be extended, customized, and combined to build complex workflows.

Example usage:
    from github_sync import SyncStore, ActionRegistry
    from github_sync.actions import SavePRContext, SyncRepository

    store = SyncStore("my.db")
    await store.initialize()

    # Use built-in actions
    registry = ActionRegistry(store)
    await registry.execute(SavePRContext(repo_name="my-repo", pr_number=123, ...))

    # Register custom actions
    @registry.register("my_custom_action")
    class MyAction(Action):
        async def execute(self, store: SyncStore) -> ActionResult:
            # Custom logic
            pass
"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Generic, TypeVar

from github_sync.models import PRContext, PullRequest, RepositoryState


class ActionStatus(Enum):
    """Status of an action execution."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class ActionResult:
    """Result of an action execution."""

    status: ActionStatus
    action_name: str
    started_at: datetime
    completed_at: datetime | None = None
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def success(self) -> bool:
        return self.status == ActionStatus.SUCCESS

    @property
    def duration_ms(self) -> float | None:
        if self.completed_at and self.started_at:
            return (self.completed_at - self.started_at).total_seconds() * 1000
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "action_name": self.action_name,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_ms": self.duration_ms,
            "data": self.data,
            "error": self.error,
        }


T = TypeVar("T")


class Action(ABC, Generic[T]):
    """
    Base class for all store actions.

    Actions encapsulate a single operation that can be executed against a SyncStore.
    They are composable, testable, and can be extended for custom behavior.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique name for this action type."""

    @abstractmethod
    async def execute(self, store: "SyncStore") -> T:
        """
        Execute the action against the store.

        Args:
            store: The SyncStore instance to operate on

        Returns:
            Action-specific result data
        """

    async def validate(self, store: "SyncStore") -> list[str]:
        """
        Validate the action before execution.

        Override to add custom validation logic.

        Returns:
            List of validation error messages (empty if valid)
        """
        return []


# Import here to avoid circular imports
from github_sync.sync_store import SyncStore

# =============================================================================
# Repository Actions
# =============================================================================


@dataclass
class SaveRepository(Action[None]):
    """Save or update repository metadata."""

    repo_name: str
    repo_path: str
    default_branch: str | None = None

    @property
    def name(self) -> str:
        return "save_repository"

    async def execute(self, store: SyncStore) -> None:
        await store.save_repository(self.repo_name, self.repo_path, self.default_branch)

    async def validate(self, store: SyncStore) -> list[str]:
        errors = []
        if not self.repo_name:
            errors.append("repo_name is required")
        if not self.repo_path:
            errors.append("repo_path is required")
        return errors


@dataclass
class GetRepository(Action[dict[str, Any] | None]):
    """Get repository metadata by name."""

    repo_name: str

    @property
    def name(self) -> str:
        return "get_repository"

    async def execute(self, store: SyncStore) -> dict[str, Any] | None:
        return await store.get_repository(self.repo_name)


@dataclass
class ListRepositories(Action[list[dict[str, Any]]]):
    """List all repositories."""

    @property
    def name(self) -> str:
        return "list_repositories"

    async def execute(self, store: SyncStore) -> list[dict[str, Any]]:
        return await store.get_all_repositories()


# =============================================================================
# Pull Request Actions
# =============================================================================


@dataclass
class SavePRSnapshot(Action[None]):
    """Save a snapshot of a PR's current state."""

    repo_name: str
    pr_number: int
    title: str
    head_branch: str
    base_branch: str
    state: str = "open"
    author: str | None = None
    draft: bool = False
    ci_status: str | None = None
    labels: list[str] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @property
    def name(self) -> str:
        return "save_pr_snapshot"

    async def execute(self, store: SyncStore) -> None:
        await store.save_pr_snapshot(
            self.repo_name,
            {
                "number": self.pr_number,
                "title": self.title,
                "state": self.state,
                "head_branch": self.head_branch,
                "base_branch": self.base_branch,
                "author": self.author,
                "draft": self.draft,
                "ci_status": self.ci_status,
                "labels": self.labels,
                "created_at": self.created_at.isoformat() if self.created_at else None,
                "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            },
        )

    async def validate(self, store: SyncStore) -> list[str]:
        errors = []
        if not self.repo_name:
            errors.append("repo_name is required")
        if self.pr_number <= 0:
            errors.append("pr_number must be positive")
        if not self.title:
            errors.append("title is required")
        return errors


@dataclass
class SavePRFromModel(Action[None]):
    """Save a PR snapshot from a PullRequest model."""

    repo_name: str
    pr: PullRequest

    @property
    def name(self) -> str:
        return "save_pr_from_model"

    async def execute(self, store: SyncStore) -> None:
        await store.save_pr_snapshot(
            self.repo_name,
            {
                "number": self.pr.number,
                "title": self.pr.title,
                "state": self.pr.state.value,
                "head_branch": self.pr.head_branch,
                "base_branch": self.pr.base_branch,
                "author": self.pr.author,
                "draft": self.pr.draft,
                "ci_status": self.pr.get_ci_status().value,
                "labels": self.pr.labels,
                "created_at": self.pr.created_at.isoformat(),
                "updated_at": self.pr.updated_at.isoformat(),
            },
        )


@dataclass
class GetPRSnapshot(Action[dict[str, Any] | None]):
    """Get the latest snapshot of a PR."""

    repo_name: str
    pr_number: int

    @property
    def name(self) -> str:
        return "get_pr_snapshot"

    async def execute(self, store: SyncStore) -> dict[str, Any] | None:
        return await store.get_latest_pr_snapshot(self.repo_name, self.pr_number)


@dataclass
class ListActivePRs(Action[list[dict[str, Any]]]):
    """List all active (open) PRs for a repository."""

    repo_name: str

    @property
    def name(self) -> str:
        return "list_active_prs"

    async def execute(self, store: SyncStore) -> list[dict[str, Any]]:
        return await store.get_active_prs(self.repo_name)


@dataclass
class ListAllPRs(Action[list[dict[str, Any]]]):
    """List all PRs, optionally filtered by repository."""

    repo_name: str | None = None
    limit: int = 100

    @property
    def name(self) -> str:
        return "list_all_prs"

    async def execute(self, store: SyncStore) -> list[dict[str, Any]]:
        return await store.get_all_prs(self.repo_name, self.limit)


# =============================================================================
# PR Context Actions
# =============================================================================


@dataclass
class SavePRContext(Action[None]):
    """Save complete PR context for offline processing."""

    context: PRContext

    @property
    def name(self) -> str:
        return "save_pr_context"

    async def execute(self, store: SyncStore) -> None:
        await store.save_pr_context(self.context)

    async def validate(self, store: SyncStore) -> list[str]:
        errors = []
        if not self.context.repo_name:
            errors.append("context.repo_name is required")
        if self.context.pr_number <= 0:
            errors.append("context.pr_number must be positive")
        return errors


@dataclass
class GetPRContext(Action[PRContext | None]):
    """Get the latest PR context."""

    repo_name: str
    pr_number: int

    @property
    def name(self) -> str:
        return "get_pr_context"

    async def execute(self, store: SyncStore) -> PRContext | None:
        return await store.get_latest_pr_context(self.repo_name, self.pr_number)


@dataclass
class ListPRContexts(Action[list[PRContext]]):
    """List all PR contexts, optionally filtered by repository."""

    repo_name: str | None = None

    @property
    def name(self) -> str:
        return "list_pr_contexts"

    async def execute(self, store: SyncStore) -> list[PRContext]:
        return await store.get_all_pr_contexts(self.repo_name)


# =============================================================================
# Branch State Actions
# =============================================================================


@dataclass
class SaveBranchState(Action[None]):
    """Save a branch state snapshot."""

    repo_name: str
    branch_name: str
    is_local: bool = False
    is_remote: bool = False
    ahead_by: int = 0
    behind_by: int = 0
    has_pr: bool = False
    pr_number: int | None = None
    needs_sync: bool = False

    @property
    def name(self) -> str:
        return "save_branch_state"

    async def execute(self, store: SyncStore) -> None:
        await store.save_branch_state(
            repo_name=self.repo_name,
            branch_name=self.branch_name,
            is_local=self.is_local,
            is_remote=self.is_remote,
            ahead_by=self.ahead_by,
            behind_by=self.behind_by,
            has_pr=self.has_pr,
            pr_number=self.pr_number,
            needs_sync=self.needs_sync,
        )


@dataclass
class SaveRepositoryState(Action[None]):
    """Save complete repository state including all branches and PRs."""

    repo_name: str
    state: RepositoryState

    @property
    def name(self) -> str:
        return "save_repository_state"

    async def execute(self, store: SyncStore) -> None:
        await store.save_repository_state(self.repo_name, self.state)


# =============================================================================
# Sync History Actions
# =============================================================================


@dataclass
class RecordSyncStart(Action[int]):
    """Record the start of a sync operation. Returns record ID."""

    repo_name: str
    sync_type: str = "full"

    @property
    def name(self) -> str:
        return "record_sync_start"

    async def execute(self, store: SyncStore) -> int:
        return await store.record_sync_start(self.repo_name, self.sync_type)


@dataclass
class RecordSyncComplete(Action[None]):
    """Record the completion of a sync operation."""

    record_id: int
    success: bool
    error_message: str | None = None
    prs_synced: int = 0
    branches_synced: int = 0

    @property
    def name(self) -> str:
        return "record_sync_complete"

    async def execute(self, store: SyncStore) -> None:
        await store.record_sync_complete(
            self.record_id,
            self.success,
            self.error_message,
            self.prs_synced,
            self.branches_synced,
        )


# =============================================================================
# Maintenance Actions
# =============================================================================


@dataclass
class CleanupOldSnapshots(Action[int]):
    """Remove snapshots older than specified days. Returns count deleted."""

    days: int = 7

    @property
    def name(self) -> str:
        return "cleanup_old_snapshots"

    async def execute(self, store: SyncStore) -> int:
        return await store.cleanup_old_snapshots(self.days)


@dataclass
class GetStatistics(Action[dict[str, Any]]):
    """Get database statistics."""

    @property
    def name(self) -> str:
        return "get_statistics"

    async def execute(self, store: SyncStore) -> dict[str, Any]:
        return await store.get_statistics()


@dataclass
class GetSchemaInfo(Action[dict[str, Any]]):
    """Get schema version and migration info."""

    @property
    def name(self) -> str:
        return "get_schema_info"

    async def execute(self, store: SyncStore) -> dict[str, Any]:
        return await store.get_schema_info()


# =============================================================================
# Action Registry
# =============================================================================


class ActionRegistry:
    """
    Registry for managing and executing actions.

    Provides middleware support, action hooks, and custom action registration.
    """

    def __init__(self, store: SyncStore):
        self.store = store
        self._custom_actions: dict[str, type[Action]] = {}
        self._before_hooks: list[Callable[[Action], Awaitable[None]]] = []
        self._after_hooks: list[Callable[[Action, ActionResult], Awaitable[None]]] = []

    def register(self, name: str) -> Callable[[type[Action]], type[Action]]:
        """
        Decorator to register a custom action.

        Example:
            @registry.register("my_action")
            class MyAction(Action):
                ...
        """

        def decorator(cls: type[Action]) -> type[Action]:
            self._custom_actions[name] = cls
            return cls

        return decorator

    def add_before_hook(self, hook: Callable[[Action], Awaitable[None]]) -> None:
        """Add a hook that runs before each action."""
        self._before_hooks.append(hook)

    def add_after_hook(self, hook: Callable[[Action, ActionResult], Awaitable[None]]) -> None:
        """Add a hook that runs after each action."""
        self._after_hooks.append(hook)

    async def execute(self, action: Action[T]) -> ActionResult:
        """
        Execute an action with full lifecycle management.

        Runs validation, before hooks, the action, and after hooks.
        Returns an ActionResult with status and timing information.
        """
        started_at = datetime.now(UTC)
        result = ActionResult(
            status=ActionStatus.RUNNING,
            action_name=action.name,
            started_at=started_at,
        )

        try:
            # Validate
            errors = await action.validate(self.store)
            if errors:
                result.status = ActionStatus.FAILED
                result.error = f"Validation failed: {'; '.join(errors)}"
                result.completed_at = datetime.now(UTC)
                return result

            # Before hooks
            for hook in self._before_hooks:
                await hook(action)

            # Execute
            data = await action.execute(self.store)
            result.status = ActionStatus.SUCCESS
            if data is not None:
                result.data = {"result": data}

        except Exception as e:
            result.status = ActionStatus.FAILED
            result.error = str(e)

        finally:
            result.completed_at = datetime.now(UTC)

            # After hooks (even on failure)
            for hook in self._after_hooks:
                try:
                    await hook(action, result)
                except Exception:
                    pass  # Don't let hook errors mask action errors

        return result

    async def execute_many(self, actions: list[Action]) -> list[ActionResult]:
        """Execute multiple actions in sequence."""
        results = []
        for action in actions:
            result = await self.execute(action)
            results.append(result)
            # Stop on first failure by default
            if not result.success:
                break
        return results

    async def execute_all(self, actions: list[Action]) -> list[ActionResult]:
        """Execute all actions, continuing even on failures."""
        return [await self.execute(action) for action in actions]


# =============================================================================
# Composite Actions
# =============================================================================


@dataclass
class SyncPRWithContext(Action[dict[str, Any]]):
    """
    Composite action: Save both PR snapshot and context together.

    This is an example of a higher-level action that composes multiple
    lower-level actions.
    """

    repo_name: str
    pr: PullRequest
    context: PRContext

    @property
    def name(self) -> str:
        return "sync_pr_with_context"

    async def execute(self, store: SyncStore) -> dict[str, Any]:
        # Save PR snapshot
        await store.save_pr_snapshot(
            self.repo_name,
            {
                "number": self.pr.number,
                "title": self.pr.title,
                "state": self.pr.state.value,
                "head_branch": self.pr.head_branch,
                "base_branch": self.pr.base_branch,
                "author": self.pr.author,
                "draft": self.pr.draft,
                "ci_status": self.pr.get_ci_status().value,
                "labels": self.pr.labels,
                "created_at": self.pr.created_at.isoformat(),
                "updated_at": self.pr.updated_at.isoformat(),
            },
        )

        # Save context
        await store.save_pr_context(self.context)

        return {
            "pr_number": self.pr.number,
            "context_size": len(self.context.diff),
        }

    async def validate(self, store: SyncStore) -> list[str]:
        errors = []
        if not self.repo_name:
            errors.append("repo_name is required")
        if self.pr.number != self.context.pr_number:
            errors.append("PR number mismatch between pr and context")
        return errors
