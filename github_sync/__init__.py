"""
github_sync - A reusable library for syncing GitHub branches and PRs to SQLite.

This library provides:
- SQLite database for storing PR and branch state snapshots
- GitHub API integration for fetching PR data
- Git operations for branch analysis
- Export/import functionality for portable artifacts

Example usage:
    from github_sync import SyncStore, GitHubClient, SyncEngine

    # Create or open a database
    db = SyncStore("my-sync.db")

    # Sync a repository
    engine = SyncEngine(db)
    engine.sync_repository("/path/to/repo")

    # Export to portable format
    from github_sync import export_database
    export_database(db, "my-sync-artifact.json.gz")
"""

from github_sync.actions import (  # Maintenance actions; Sync history actions; Branch actions; Context actions; PR actions; Repository actions; Composite actions
    Action,
    ActionRegistry,
    ActionResult,
    ActionStatus,
    CleanupOldSnapshots,
    GetPRContext,
    GetPRSnapshot,
    GetRepository,
    GetSchemaInfo,
    GetStatistics,
    ListActivePRs,
    ListAllPRs,
    ListPRContexts,
    ListRepositories,
    RecordSyncComplete,
    RecordSyncStart,
    SaveBranchState,
    SavePRContext,
    SavePRFromModel,
    SavePRSnapshot,
    SaveRepository,
    SaveRepositoryState,
    SyncPRWithContext,
)
from github_sync.bot import DependabotHelper  # Backwards compatibility alias
from github_sync.bot import BotHelper

# Bot commands and execution
from github_sync.commands import DependabotCommand  # Backwards compatibility alias
from github_sync.commands import (
    BotCommand,
    CommandParser,
    CommandResult,
    CommandStatus,
    PreconditionResult,
    QueuedCommand,
    is_bot_pr,
    parse_dependency_update,
)
from github_sync.export import ArtifactFormat, export_database, import_database
from github_sync.git_client import GitClient
from github_sync.github_client import GitHubClient
from github_sync.mcp_server import (
    FileTools,
    GitTools,
    MCPServer,
    SyncTools,
    WorkflowTools,
)
from github_sync.models import (
    Branch,
    BranchPRState,
    BranchStatus,
    CICheck,
    CIStatus,
    PRContext,
    PRState,
    PullRequest,
    RepositoryState,
)
from github_sync.project_manager import (
    LeaseError,
    Project,
    ProjectManager,
    ProjectManagerError,
    ProjectNotFoundError,
    ValidationError,
    WorktreeError,
    WorktreeLease,
)
from github_sync.sync_engine import SyncEngine
from github_sync.sync_store import (
    SCHEMA_VERSION,
    DatabaseError,
    MigrationError,
    SyncStore,
)
from github_sync.workflow import Workflow, WorkflowManager, WorkflowStep

__version__ = "0.1.0"
__all__ = [
    # Store
    "SyncStore",
    "DatabaseError",
    "MigrationError",
    "SCHEMA_VERSION",
    # Clients
    "GitClient",
    "GitHubClient",
    # Engine
    "SyncEngine",
    # Project Manager
    "ProjectManager",
    "Project",
    "WorktreeLease",
    "ProjectManagerError",
    "ProjectNotFoundError",
    "WorktreeError",
    "LeaseError",
    "ValidationError",
    # Models
    "Branch",
    "BranchPRState",
    "BranchStatus",
    "CICheck",
    "CIStatus",
    "PRContext",
    "PRState",
    "PullRequest",
    "RepositoryState",
    # Actions
    "Action",
    "ActionResult",
    "ActionStatus",
    "ActionRegistry",
    "SaveRepository",
    "GetRepository",
    "ListRepositories",
    "SavePRSnapshot",
    "SavePRFromModel",
    "GetPRSnapshot",
    "ListActivePRs",
    "ListAllPRs",
    "SavePRContext",
    "GetPRContext",
    "ListPRContexts",
    "SaveBranchState",
    "SaveRepositoryState",
    "RecordSyncStart",
    "RecordSyncComplete",
    "CleanupOldSnapshots",
    "GetStatistics",
    "GetSchemaInfo",
    "SyncPRWithContext",
    # Export/Import
    "export_database",
    "import_database",
    "ArtifactFormat",
    # Bot Commands
    "BotCommand",
    "BotHelper",
    "CommandParser",
    "CommandResult",
    "CommandStatus",
    "PreconditionResult",
    "QueuedCommand",
    "is_bot_pr",
    "parse_dependency_update",
    # Backwards compatibility aliases
    "DependabotCommand",
    "DependabotHelper",
    # Workflows
    "Workflow",
    "WorkflowManager",
    "WorkflowStep",
    # MCP Server
    "MCPServer",
    "GitTools",
    "FileTools",
    "WorkflowTools",
    "SyncTools",
]
