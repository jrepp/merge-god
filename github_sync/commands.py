"""
Bot command types, parsing, and queue management.

This module provides:
- BotCommand: Enum of supported bot commands
- CommandParser: Extracts commands from PR comments
- QueuedCommand: A command in the execution queue
- CommandStatus: Status of queued commands

Example:
    from github_sync.commands import CommandParser, BotCommand

    parser = CommandParser(bot_mention="@agfcmd")
    commands = parser.extract_from_text("@agfcmd merge")
    # Returns: [(BotCommand.MERGE, None)]
"""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any


class BotCommand(Enum):
    """Supported bot commands."""

    REBASE = "rebase"
    RECREATE = "recreate"
    MERGE = "merge"
    SQUASH_AND_MERGE = "squash and merge"
    CANCEL_MERGE = "cancel merge"
    REOPEN = "reopen"
    CLOSE = "close"
    SHOW_IGNORE_CONDITIONS = "show ignore conditions"
    IGNORE_MAJOR = "ignore this major version"
    IGNORE_MINOR = "ignore this minor version"
    IGNORE_DEPENDENCY = "ignore this dependency"


class CommandStatus(Enum):
    """Status of a queued command."""

    PENDING = "pending"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class QueuedCommand:
    """A command extracted from PR comments and queued for execution."""

    id: str | None  # Database ID
    repo_name: str
    pr_number: int
    command: BotCommand
    status: CommandStatus
    comment_id: int  # Source comment ID
    comment_author: str
    comment_body: str
    extracted_at: datetime
    # Timing fields
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_ms: int | None = None
    # Result fields
    success: bool | None = None
    error_type: str | None = None
    error_message: str | None = None
    result_message: str | None = None
    retry_count: int = 0
    dependency: str | None = None  # For show ignore conditions

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "repo_name": self.repo_name,
            "pr_number": self.pr_number,
            "command": self.command.value,
            "status": self.status.value,
            "comment_id": self.comment_id,
            "comment_author": self.comment_author,
            "comment_body": self.comment_body,
            "extracted_at": self.extracted_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_ms": self.duration_ms,
            "success": self.success,
            "error_type": self.error_type,
            "error_message": self.error_message,
            "result_message": self.result_message,
            "retry_count": self.retry_count,
            "dependency": self.dependency,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "QueuedCommand":
        return cls(
            id=data.get("id"),
            repo_name=data["repo_name"],
            pr_number=data["pr_number"],
            command=BotCommand(data["command"]),
            status=CommandStatus(data["status"]),
            comment_id=data["comment_id"],
            comment_author=data["comment_author"],
            comment_body=data["comment_body"],
            extracted_at=datetime.fromisoformat(data["extracted_at"]),
            started_at=datetime.fromisoformat(data["started_at"])
            if data.get("started_at")
            else None,
            completed_at=datetime.fromisoformat(data["completed_at"])
            if data.get("completed_at")
            else None,
            duration_ms=data.get("duration_ms"),
            success=data.get("success"),
            error_type=data.get("error_type"),
            error_message=data.get("error_message"),
            result_message=data.get("result_message"),
            retry_count=data.get("retry_count", 0),
            dependency=data.get("dependency"),
        )


@dataclass
class PreconditionResult:
    """Result of checking preconditions for a command."""

    command: BotCommand
    can_execute: bool
    blockers: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    pr_state: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command.value,
            "can_execute": self.can_execute,
            "blockers": self.blockers,
            "warnings": self.warnings,
            "pr_state": self.pr_state,
        }


@dataclass
class CommandResult:
    """Result of executing a bot command with timing and error info."""

    command: BotCommand
    success: bool
    pr_number: int
    comment_id: int | None = None
    message: str = ""
    # Timing
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None
    duration_ms: int | None = None
    # Error info
    error_type: str | None = None
    error_message: str | None = None
    # Audit
    command_queue_id: int | None = None  # ID in command_queue table

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command.value,
            "success": self.success,
            "pr_number": self.pr_number,
            "comment_id": self.comment_id,
            "message": self.message,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_ms": self.duration_ms,
            "error_type": self.error_type,
            "error_message": self.error_message,
            "command_queue_id": self.command_queue_id,
        }

    def complete(self, success: bool, message: str = "", error_type: str | None = None, error_message: str | None = None) -> "CommandResult":
        """Mark the result as complete with timing."""
        self.success = success
        self.message = message
        self.error_type = error_type
        self.error_message = error_message
        self.completed_at = datetime.now(UTC)
        self.duration_ms = int((self.completed_at - self.started_at).total_seconds() * 1000)
        return self


class CommandParser:
    """
    Parser for extracting bot commands from PR comments.

    Recognizes commands like:
        @agfcmd merge
        @agfcmd squash and merge
        @agfcmd rebase
        @agfcmd ignore this major version
        @agfcmd show lodash ignore conditions
    """

    # Command patterns (suffix after bot mention)
    COMMAND_PATTERNS = [
        (r"squash\s+and\s+merge", BotCommand.SQUASH_AND_MERGE),
        (r"cancel\s+merge", BotCommand.CANCEL_MERGE),
        (r"ignore\s+this\s+major\s+version", BotCommand.IGNORE_MAJOR),
        (r"ignore\s+this\s+minor\s+version", BotCommand.IGNORE_MINOR),
        (r"ignore\s+this\s+dependency", BotCommand.IGNORE_DEPENDENCY),
        (r"show\s+(\S+)\s+ignore\s+conditions", BotCommand.SHOW_IGNORE_CONDITIONS),
        (r"show\s+ignore\s+conditions", BotCommand.SHOW_IGNORE_CONDITIONS),
        (r"rebase", BotCommand.REBASE),
        (r"recreate", BotCommand.RECREATE),
        (r"merge", BotCommand.MERGE),
        (r"reopen", BotCommand.REOPEN),
        (r"close", BotCommand.CLOSE),
    ]

    DEFAULT_BOT_MENTION = "@agfcmd"

    def __init__(self, bot_mention: str | None = None):
        """
        Initialize command parser.

        Args:
            bot_mention: Bot mention to look for (default: "@agfcmd")
        """
        self.bot_mention = bot_mention or self.DEFAULT_BOT_MENTION
        # Escape special regex chars in bot mention
        escaped_bot = re.escape(self.bot_mention)
        # Build patterns with bot mention prefix
        self._patterns = [
            (re.compile(rf"{escaped_bot}\s+{pattern}", re.IGNORECASE), cmd)
            for pattern, cmd in self.COMMAND_PATTERNS
        ]

    def extract_from_text(self, text: str) -> list[tuple[BotCommand, str | None]]:
        """
        Extract commands from a text string.

        Args:
            text: Comment body text

        Returns:
            List of (command, dependency) tuples. Dependency is only set for
            SHOW_IGNORE_CONDITIONS when a package name is provided.
        """
        results = []
        for pattern, command in self._patterns:
            match = pattern.search(text)
            if match:
                # Extract dependency name for show ignore conditions
                dependency = None
                if command == BotCommand.SHOW_IGNORE_CONDITIONS:
                    groups = match.groups()
                    if groups:
                        dependency = groups[0]
                results.append((command, dependency))
        return results

    def extract_from_comments(
        self,
        comments: list[dict[str, Any]],
        repo_name: str,
        pr_number: int,
    ) -> list[QueuedCommand]:
        """
        Extract commands from a list of PR comments.

        Args:
            comments: List of comment dicts with 'id', 'author', 'body', 'created_at'
            repo_name: Repository name
            pr_number: PR number

        Returns:
            List of QueuedCommand objects
        """
        queued = []
        seen_commands = set()  # Avoid duplicates from same comment

        for comment in comments:
            comment_id = comment.get("id", 0)
            author = comment.get("author", "unknown")
            body = comment.get("body", "")
            created_at = comment.get("created_at")

            if isinstance(created_at, str):
                try:
                    extracted_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                except ValueError:
                    extracted_at = datetime.now(UTC)
            else:
                extracted_at = datetime.now(UTC)

            commands = self.extract_from_text(body)
            for command, dependency in commands:
                # Dedupe key: comment_id + command
                key = (comment_id, command)
                if key in seen_commands:
                    continue
                seen_commands.add(key)

                queued.append(
                    QueuedCommand(
                        id=None,
                        repo_name=repo_name,
                        pr_number=pr_number,
                        command=command,
                        status=CommandStatus.PENDING,
                        comment_id=comment_id,
                        comment_author=author,
                        comment_body=body[:500],  # Truncate for storage
                        extracted_at=extracted_at,
                        dependency=dependency,
                    )
                )

        return queued

    @classmethod
    def create(cls, bot_mention: str | None = None) -> "CommandParser":
        """Factory method for creating a parser."""
        return cls(bot_mention=bot_mention)


# Patterns for parsing Dependabot/bot PR titles
PR_TITLE_PATTERNS = [
    # "Bump foo from 1.0.0 to 2.0.0"
    re.compile(r"^Bump (?P<dependency>.+?) from (?P<from_version>\S+) to (?P<to_version>\S+)"),
    # "Update foo requirement from ~1.0 to ~2.0"
    re.compile(
        r"^Update (?P<dependency>.+?) requirement from (?P<from_version>\S+) to (?P<to_version>\S+)"
    ),
    # "chore(deps): bump foo from 1.0 to 2.0"
    re.compile(
        r"^chore\(deps(?:-dev)?\): [Bb]ump (?P<dependency>.+?) from (?P<from_version>\S+) to (?P<to_version>\S+)"
    ),
]

BOT_AUTHORS = {"dependabot[bot]", "dependabot-preview[bot]", "dependabot", "renovate[bot]"}


def is_bot_pr(author: str) -> bool:
    """Check if a PR author is a known bot."""
    return author.lower() in BOT_AUTHORS


def parse_dependency_update(title: str) -> dict[str, Any] | None:
    """
    Parse dependency update information from PR title.

    Returns dict with:
    - dependency: Package name
    - from_version: Previous version
    - to_version: New version
    - is_major: Whether this is a major version bump
    - is_minor: Whether this is a minor version bump
    """
    for pattern in PR_TITLE_PATTERNS:
        match = pattern.match(title)
        if match:
            groups = match.groupdict()
            from_v = groups["from_version"]
            to_v = groups["to_version"]

            # Determine version bump type
            is_major = False
            is_minor = False

            try:
                from_parts = from_v.lstrip("v~^>=<").split(".")
                to_parts = to_v.lstrip("v~^>=<").split(".")

                if len(from_parts) >= 1 and len(to_parts) >= 1:
                    if from_parts[0] != to_parts[0]:
                        is_major = True
                    elif len(from_parts) >= 2 and len(to_parts) >= 2:
                        if from_parts[1] != to_parts[1]:
                            is_minor = True
            except (ValueError, IndexError):
                pass

            return {
                "dependency": groups["dependency"],
                "from_version": from_v,
                "to_version": to_v,
                "is_major": is_major,
                "is_minor": is_minor,
            }

    return None


# Backwards compatibility aliases
DependabotCommand = BotCommand  # Alias for backwards compatibility
