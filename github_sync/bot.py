"""
Bot command executor with precondition checking and automatic audit trail.

This module provides BotHelper for executing bot commands on PRs
with comprehensive precondition checks, automatic timing, and audit trail.

All command executions are automatically:
- Timed (start, end, duration)
- Tracked with success/failure status
- Logged to command_queue with error details
- Available via get_command_execution_stats()

Example:
    from github_sync import GitHubClient, BotHelper, BotCommand, SyncStore

    store = SyncStore("sync.db")
    await store.initialize()

    client = GitHubClient(repo_owner="org", repo_name="repo")
    helper = BotHelper(client, store=store)  # Pass store for audit trail

    # Execute with automatic timing and audit
    result = await helper.execute(42, BotCommand.MERGE)
    print(f"Duration: {result.duration_ms}ms, Success: {result.success}")

    # Get execution statistics
    stats = await store.get_command_execution_stats()
    print(f"Success rate: {stats['success_rate']}%")
"""

from datetime import UTC, datetime
from typing import Any

from github_sync.commands import (
    BOT_AUTHORS,
    BotCommand,
    CommandResult,
    PreconditionResult,
    is_bot_pr,
    parse_dependency_update,
)
from github_sync.github_client import GitHubClient
from github_sync.models import CIStatus, PRState, PullRequest


class BotHelper:
    """
    Helper for executing bot commands with precondition checks.

    All commands work by posting a comment mentioning the bot with the
    appropriate command text. The bot mention is configurable.
    """

    DEFAULT_BOT_MENTION = "@agfcmd"

    def __init__(
        self,
        client: GitHubClient,
        store: "SyncStore | None" = None,
        bot_mention: str | None = None,
    ):
        """
        Initialize BotHelper.

        Args:
            client: GitHubClient for API operations
            store: Optional SyncStore for caching/tracking
            bot_mention: Bot mention to use in commands (default: "@agfcmd")
        """
        self.client = client
        self.store = store
        self.bot_mention = bot_mention or self.DEFAULT_BOT_MENTION

    @staticmethod
    def is_bot_pr(pr: PullRequest | dict[str, Any]) -> bool:
        """Check if a PR was created by a known bot (Dependabot, Renovate, etc.)."""
        if isinstance(pr, PullRequest):
            return is_bot_pr(pr.author)
        return is_bot_pr(str(pr.get("author", "")))

    @staticmethod
    def parse_dependency_info(pr: PullRequest | dict[str, Any]) -> dict[str, Any] | None:
        """Parse dependency update information from PR title."""
        title = pr.title if isinstance(pr, PullRequest) else pr.get("title", "")
        return parse_dependency_update(title)

    async def get_pr_state(self, pr_number: int) -> dict[str, Any]:
        """
        Get comprehensive PR state for precondition checking.

        Returns dict with all relevant state information.
        """
        pr = await self.client.get_pull_request(pr_number)
        if not pr:
            return {"exists": False, "pr_number": pr_number}

        mergeable = await self.client.get_pr_mergeable_state(pr_number)
        review_state = await self.client.get_pr_review_state(pr_number)

        return {
            "exists": True,
            "pr_number": pr_number,
            "title": pr.title,
            "state": pr.state.value,
            "is_open": pr.state == PRState.OPEN,
            "is_closed": pr.state == PRState.CLOSED,
            "is_merged": pr.state == PRState.MERGED,
            "is_draft": pr.draft,
            "author": pr.author,
            "is_bot_pr": self.is_bot_pr(pr),
            "ci_status": pr.get_ci_status().value,
            "ci_passing": pr.get_ci_status() == CIStatus.SUCCESS,
            "ci_failing": pr.get_ci_status() == CIStatus.FAILURE,
            "ci_pending": pr.get_ci_status() == CIStatus.PENDING,
            "labels": pr.labels,
            "mergeable": mergeable.get("mergeable"),
            "mergeable_state": mergeable.get("mergeable_state"),
            "rebaseable": mergeable.get("rebaseable"),
            "review_decision": review_state.get("review_decision"),
            "approved_by": review_state.get("approved_by", []),
            "changes_requested_by": review_state.get("changes_requested_by", []),
            "dependency_info": self.parse_dependency_info(pr),
            "head_branch": pr.head_branch,
            "base_branch": pr.base_branch,
        }

    async def check_preconditions(
        self, pr_number: int, command: BotCommand
    ) -> PreconditionResult:
        """
        Check if preconditions are met for executing a command.

        Args:
            pr_number: PR number
            command: Command to check

        Returns:
            PreconditionResult with can_execute flag and any blockers/warnings
        """
        state = await self.get_pr_state(pr_number)
        blockers: list[str] = []
        warnings: list[str] = []

        # PR must exist
        if not state.get("exists"):
            return PreconditionResult(
                command=command,
                can_execute=False,
                blockers=["PR does not exist"],
                pr_state=state,
            )

        # Command-specific checks
        if command == BotCommand.REBASE:
            if not state.get("is_open"):
                blockers.append("PR is not open")
            if not state.get("rebaseable"):
                warnings.append("PR may not be rebaseable")

        elif command == BotCommand.RECREATE:
            if not state.get("is_open"):
                blockers.append("PR is not open")

        elif command in (BotCommand.MERGE, BotCommand.SQUASH_AND_MERGE):
            if not state.get("is_open"):
                blockers.append("PR is not open")
            if state.get("ci_failing"):
                blockers.append("CI is failing")
            if state.get("ci_pending"):
                warnings.append("CI is still pending")
            if state.get("mergeable") is False:
                blockers.append("PR is not mergeable (conflicts or other issues)")
            if state.get("mergeable_state") == "blocked":
                blockers.append("PR is blocked by branch protection rules")
            if state.get("changes_requested_by"):
                warnings.append(f"Changes requested by: {state['changes_requested_by']}")

        elif command == BotCommand.CANCEL_MERGE:
            if not state.get("is_open"):
                blockers.append("PR is not open")

        elif command == BotCommand.REOPEN:
            if not state.get("is_closed"):
                blockers.append("PR is not closed")
            if state.get("is_merged"):
                blockers.append("PR was already merged")

        elif command == BotCommand.CLOSE:
            if not state.get("is_open"):
                blockers.append("PR is not open")

        elif command in (
            BotCommand.IGNORE_MAJOR,
            BotCommand.IGNORE_MINOR,
            BotCommand.IGNORE_DEPENDENCY,
        ):
            if not state.get("is_open"):
                blockers.append("PR is not open")
            if not state.get("dependency_info"):
                warnings.append("Could not parse dependency information from PR title")

        return PreconditionResult(
            command=command,
            can_execute=len(blockers) == 0,
            blockers=blockers,
            warnings=warnings,
            pr_state=state,
        )

    def _get_command_text(self, command: BotCommand, dependency: str | None = None) -> str:
        """Get the bot command text."""
        bot = self.bot_mention

        command_suffixes = {
            BotCommand.REBASE: "rebase",
            BotCommand.RECREATE: "recreate",
            BotCommand.MERGE: "merge",
            BotCommand.SQUASH_AND_MERGE: "squash and merge",
            BotCommand.CANCEL_MERGE: "cancel merge",
            BotCommand.REOPEN: "reopen",
            BotCommand.CLOSE: "close",
            BotCommand.IGNORE_MAJOR: "ignore this major version",
            BotCommand.IGNORE_MINOR: "ignore this minor version",
            BotCommand.IGNORE_DEPENDENCY: "ignore this dependency",
        }

        if command == BotCommand.SHOW_IGNORE_CONDITIONS:
            if dependency:
                return f"{bot} show {dependency} ignore conditions"
            return f"{bot} show ignore conditions"

        suffix = command_suffixes.get(command)
        if suffix:
            return f"{bot} {suffix}"
        return ""

    async def execute(
        self,
        pr_number: int,
        command: BotCommand,
        dependency: str | None = None,
        skip_preconditions: bool = False,
        command_queue_id: int | None = None,
    ) -> CommandResult:
        """
        Execute a bot command by posting a comment.

        Automatically records timing, success/failure, and audit trail.
        If a store is configured, the execution is logged to command_queue.

        Args:
            pr_number: PR number
            command: Command to execute
            dependency: Dependency name (for show ignore conditions)
            skip_preconditions: If True, skip precondition checks
            command_queue_id: Optional ID of existing queue entry to update

        Returns:
            CommandResult with timing and success status
        """
        # Create result with start time
        result = CommandResult(
            command=command,
            success=False,
            pr_number=pr_number,
            command_queue_id=command_queue_id,
        )

        # If we have a store and queue ID, mark as executing
        if self.store and command_queue_id:
            await self.store.start_command_execution(command_queue_id)

        try:
            # Check preconditions unless skipped
            if not skip_preconditions:
                preconditions = await self.check_preconditions(pr_number, command)
                if not preconditions.can_execute:
                    result.complete(
                        success=False,
                        message=f"Preconditions not met: {preconditions.blockers}",
                        error_type="PreconditionError",
                        error_message="; ".join(preconditions.blockers),
                    )
                    await self._record_execution(result)
                    return result

            # Get command text
            command_text = self._get_command_text(command, dependency)
            if not command_text:
                result.complete(
                    success=False,
                    message=f"Unknown command: {command}",
                    error_type="InvalidCommand",
                    error_message=f"No command text for {command.value}",
                )
                await self._record_execution(result)
                return result

            # Post comment
            api_result = await self.client.post_comment(pr_number, command_text)

            if api_result:
                result.comment_id = api_result.get("id")
                result.complete(
                    success=True,
                    message=f"Posted: {command_text}",
                )
            else:
                result.complete(
                    success=False,
                    message="Failed to post comment",
                    error_type="APIError",
                    error_message="post_comment returned None",
                )

        except Exception as e:
            result.complete(
                success=False,
                message=f"Exception during execution: {e}",
                error_type=type(e).__name__,
                error_message=str(e),
            )

        # Record execution to audit trail
        await self._record_execution(result)
        return result

    async def _record_execution(self, result: CommandResult) -> None:
        """Record execution result to audit trail if store is configured."""
        if not self.store:
            return

        # If we have a queue ID, update the existing entry
        if result.command_queue_id:
            await self.store.complete_command_execution(
                command_id=result.command_queue_id,
                success=result.success,
                result_message=result.message,
                error_type=result.error_type,
                error_message=result.error_message,
            )
        else:
            # Create a new audit entry for ad-hoc executions
            repo_name = getattr(self.client, "repo_name", "unknown")
            cmd_id = await self.store.queue_command(
                repo_name=repo_name,
                pr_number=result.pr_number,
                command=result.command.value,
                comment_id=result.comment_id or 0,
                comment_author="bot_helper",
                comment_body=f"Ad-hoc execution: {result.command.value}",
                extracted_at=result.started_at,
                dependency=None,
            )
            # Complete immediately with our timing
            await self.store.complete_command_execution(
                command_id=cmd_id,
                success=result.success,
                result_message=result.message,
                error_type=result.error_type,
                error_message=result.error_message,
            )

    async def merge_when_ready(
        self,
        pr_number: int,
        squash: bool = False,
        use_bot_command: bool = True,
    ) -> CommandResult:
        """
        Merge a PR when CI passes.

        If use_bot_command is True and it's a bot PR, uses bot command.
        Otherwise, attempts direct merge via API.

        Args:
            pr_number: PR number
            squash: Use squash merge
            use_bot_command: Use bot command if available

        Returns:
            CommandResult
        """
        state = await self.get_pr_state(pr_number)

        if not state.get("exists"):
            return CommandResult(
                command=BotCommand.MERGE,
                success=False,
                pr_number=pr_number,
                message="PR does not exist",
            )

        # For bot PRs, prefer bot command (handles CI waiting)
        if use_bot_command and state.get("is_bot_pr"):
            command = BotCommand.SQUASH_AND_MERGE if squash else BotCommand.MERGE
            return await self.execute(pr_number, command)

        # Direct merge (only if CI passing)
        if not state.get("ci_passing"):
            return CommandResult(
                command=BotCommand.MERGE,
                success=False,
                pr_number=pr_number,
                message=f"CI not passing (status: {state.get('ci_status')})",
            )

        merge_method = "squash" if squash else "merge"
        result = await self.client.merge_pr(pr_number, merge_method=merge_method)

        return CommandResult(
            command=BotCommand.MERGE,
            success=result.get("success", False),
            pr_number=pr_number,
            message=result.get("message", ""),
        )

    async def batch_execute(
        self,
        pr_numbers: list[int],
        command: BotCommand,
        stop_on_failure: bool = False,
    ) -> list[CommandResult]:
        """
        Execute a command on multiple PRs.

        Args:
            pr_numbers: List of PR numbers
            command: Command to execute
            stop_on_failure: Stop on first failure

        Returns:
            List of CommandResults
        """
        results = []
        for pr_number in pr_numbers:
            result = await self.execute(pr_number, command)
            results.append(result)
            if stop_on_failure and not result.success:
                break
        return results

    async def find_bot_prs(
        self,
        state: str = "open",
        ci_status: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Find bot-created PRs matching criteria.

        Args:
            state: PR state filter ("open", "closed", "all")
            ci_status: Optional CI status filter ("success", "failure", "pending")

        Returns:
            List of PR state dicts for matching bot PRs
        """
        prs = await self.client.get_pull_requests(state=state)
        bot_prs = []

        for pr in prs:
            if not self.is_bot_pr(pr):
                continue

            pr_state = await self.get_pr_state(pr.number)

            if ci_status:
                if pr_state.get("ci_status") != ci_status:
                    continue

            bot_prs.append(pr_state)

        return bot_prs

    async def auto_merge_ready_prs(
        self, squash: bool = True, dry_run: bool = False
    ) -> list[CommandResult]:
        """
        Auto-merge all bot PRs that are ready (CI passing, mergeable).

        Args:
            squash: Use squash merge
            dry_run: If True, only return what would be merged

        Returns:
            List of CommandResults (or dry run results)
        """
        prs = await self.find_bot_prs(state="open", ci_status="success")
        results = []

        for pr_state in prs:
            pr_number = pr_state["pr_number"]
            command = BotCommand.SQUASH_AND_MERGE if squash else BotCommand.MERGE

            preconditions = await self.check_preconditions(pr_number, command)

            if dry_run:
                results.append(
                    CommandResult(
                        command=command,
                        success=preconditions.can_execute,
                        pr_number=pr_number,
                        message=f"DRY RUN: {'Would merge' if preconditions.can_execute else preconditions.blockers}",
                    )
                )
            elif preconditions.can_execute:
                result = await self.execute(pr_number, command, skip_preconditions=True)
                results.append(result)

        return results

    async def process_pending_commands(
        self,
        repo_name: str | None = None,
        max_retries: int = 3,
        stop_on_failure: bool = False,
    ) -> list[CommandResult]:
        """
        Process all pending commands from the queue with automatic audit trail.

        Each command is:
        - Marked as executing with start time
        - Executed with precondition checking
        - Completed with duration, success/failure, and error info

        Args:
            repo_name: Optional filter by repository
            max_retries: Maximum retries for failed commands
            stop_on_failure: Stop processing on first failure

        Returns:
            List of CommandResults with timing and audit info
        """
        if not self.store:
            raise ValueError("Store required for processing pending commands")

        pending = await self.store.get_pending_commands(repo_name=repo_name)
        results = []

        for cmd in pending:
            # Skip if max retries exceeded
            if cmd.get("retry_count", 0) >= max_retries:
                await self.store.update_command_status(
                    cmd["id"],
                    "skipped",
                    f"Max retries ({max_retries}) exceeded",
                )
                continue

            # Execute with queue ID for audit trail
            command = BotCommand(cmd["command"])
            result = await self.execute(
                pr_number=cmd["pr_number"],
                command=command,
                dependency=cmd.get("dependency"),
                command_queue_id=cmd["id"],
            )
            results.append(result)

            if stop_on_failure and not result.success:
                break

        return results

    async def get_execution_stats(
        self, repo_name: str | None = None, command: str | None = None
    ) -> dict[str, Any]:
        """
        Get command execution statistics.

        Args:
            repo_name: Optional filter by repository
            command: Optional filter by command type

        Returns:
            Dict with avg_duration_ms, success_rate, total_count, etc.
        """
        if not self.store:
            return {
                "error": "Store not configured",
                "avg_duration_ms": 0,
                "success_rate": 0,
                "total_count": 0,
            }

        return await self.store.get_command_execution_stats(
            repo_name=repo_name, command=command
        )

    async def get_failed_commands(
        self, repo_name: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """
        Get failed commands for debugging/retry.

        Args:
            repo_name: Optional filter by repository
            limit: Maximum number of results

        Returns:
            List of failed command records with error details
        """
        if not self.store:
            return []

        return await self.store.get_failed_commands(repo_name=repo_name, limit=limit)

    async def retry_failed_command(self, command_id: int) -> CommandResult | None:
        """
        Retry a failed command.

        Args:
            command_id: ID of the failed command

        Returns:
            CommandResult from retry, or None if command not found
        """
        if not self.store:
            return None

        # Get the command
        history = await self.store.get_command_history(repo_name="", pr_number=None, limit=1000)
        cmd = next((c for c in history if c["id"] == command_id), None)

        if not cmd:
            return None

        # Increment retry count
        new_count = await self.store.increment_retry_count(command_id)

        # Execute with the same queue ID
        command = BotCommand(cmd["command"])
        return await self.execute(
            pr_number=cmd["pr_number"],
            command=command,
            dependency=cmd.get("dependency"),
            command_queue_id=command_id,
        )


# Backwards compatibility alias
DependabotHelper = BotHelper


# Type hint import for optional store
try:
    from github_sync.sync_store import SyncStore
except ImportError:
    SyncStore = None  # type: ignore
