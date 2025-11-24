"""
Callback implementations for agent event handling.

This module provides callback implementations for different contexts
(logging, notifications, dashboard updates, etc.)
"""

import json
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .claude_agent import AgentAction, AgentCallbacks

# Constants for display and truncation
MAX_THINKING_PREVIEW_LENGTH = 50  # Max length before truncating thinking content
MAX_THINKING_LOG_LENGTH = 100  # Max length for logged thinking content


class PRProcessingCallbacks:
    """
    Callbacks for PR processing events.

    This integrates with pr-loop.py's logging and notification systems.
    """

    def __init__(
        self,
        pr_number: int,
        log_json: Callable[[str, dict[str, Any]], None],
        send_notification: Callable[[str, str | None, str, list[str] | None], bool] | None = None,
        max_retries: int = 3,
    ):
        self.pr_number = pr_number
        self.log_json = log_json
        self.send_notification = send_notification
        self.current_task = None
        self.current_task_start = None
        self.action_count = 0
        self.max_retries = max_retries
        self.retry_count = 0
        self.error_count = 0
        self.task_count = 0

    def on_thinking(self, content: str) -> None:
        """Agent is thinking/planning"""
        # Log abbreviated thinking to avoid spam
        if len(content) > MAX_THINKING_PREVIEW_LENGTH:
            self.log_json("agent_thinking", {
                "pr_number": self.pr_number,
                "task": self.current_task,
                "content": content[:MAX_THINKING_LOG_LENGTH] + "...",
                "full_length": len(content),
            })

    def on_action(self, action: AgentAction) -> None:
        """Agent is taking an action"""
        self.action_count += 1

        self.log_json("agent_action", {
            "pr_number": self.pr_number,
            "action_number": self.action_count,
            "action_type": action.type,
            "target": action.target,
            "status": action.status,
            "timestamp": action.timestamp.isoformat(),
        })

        # Send notification for important actions
        if action.type in ["git_commit", "gh_comment", "merge_pr"] and self.send_notification:
            self.send_notification(
                f"PR #{self.pr_number}: {action.type}",
                f"Agent performed {action.type} on {action.target}",
                "default",
                ["robot", "white_check_mark"] if action.status == "completed" else ["robot", "warning"],
            )

    def on_progress(self, current: int, total: int) -> None:
        """Progress update"""
        percentage = (current / total) * 100 if total > 0 else 0

        self.log_json("agent_progress", {
            "pr_number": self.pr_number,
            "current": current,
            "total": total,
            "percentage": round(percentage, 1),
        })

    def on_error(self, error: Exception) -> bool:
        """
        Error occurred - return True to continue/retry, False to abort.

        Implements retry logic for transient errors with exponential backoff.
        """
        self.error_count += 1
        error_type = type(error).__name__
        error_msg = str(error)

        # Check if error is transient (retryable)
        transient_errors = [
            "RateLimitError",
            "APIConnectionError",
            "APITimeoutError",
            "ServiceUnavailableError",
            "InternalServerError",
            "ConnectionError",
            "Timeout",
        ]

        is_transient = any(err in error_type for err in transient_errors)

        # Determine if we should retry
        should_retry = is_transient and self.retry_count < self.max_retries

        self.log_json("agent_error", {
            "pr_number": self.pr_number,
            "task": self.current_task,
            "error": error_msg,
            "error_type": error_type,
            "action_count": self.action_count,
            "error_count": self.error_count,
            "retry_count": self.retry_count,
            "is_transient": is_transient,
            "will_retry": should_retry,
        })

        if should_retry:
            self.retry_count += 1
            backoff_delay = min(2 ** self.retry_count, 32)  # Max 32 seconds

            self.log_json("agent_retry", {
                "pr_number": self.pr_number,
                "task": self.current_task,
                "retry_attempt": self.retry_count,
                "max_retries": self.max_retries,
                "backoff_seconds": backoff_delay,
            })

            if self.send_notification:
                self.send_notification(
                    f"PR #{self.pr_number}: Retrying after error",
                    f"Attempt {self.retry_count}/{self.max_retries}, waiting {backoff_delay}s",
                    "default",
                    ["warning", "arrows_counterclockwise"],
                )

            time.sleep(backoff_delay)
            return True  # Continue/retry

        # Permanent error or max retries exceeded
        self.log_json("agent_abort", {
            "pr_number": self.pr_number,
            "task": self.current_task,
            "reason": "max_retries_exceeded" if is_transient else "permanent_error",
            "total_errors": self.error_count,
            "total_retries": self.retry_count,
        })

        if self.send_notification:
            reason = f"Max retries ({self.max_retries}) exceeded" if is_transient else "Permanent error"
            self.send_notification(
                f"PR #{self.pr_number}: Agent Aborted",
                f"{reason}: {error_msg[:100]}",
                "high",
                ["x", "warning"],
            )

        return False  # Abort


class DashboardCallbacks:
    """
    Callbacks for dashboard monitoring.

    This integrates with dashboard.py's RepoMonitor to show real-time
    agent activity in the TUI.
    """

    def __init__(self, monitor):
        """
        Args:
            monitor: RepoMonitor instance from dashboard.py
        """
        self.monitor = monitor

    def on_thinking(self, content: str) -> None:
        """Update dashboard with agent thinking"""
        if self.monitor.current_agent_invocation:
            self.monitor.current_agent_invocation.thinking_content = content[:200]

        # Add to logs
        self.monitor.logs.append(f"🤖 Thinking: {content[:60]}...")

    def on_action(self, action: AgentAction) -> None:
        """Update dashboard with agent action"""
        if self.monitor.current_agent_invocation:
            self.monitor.current_agent_invocation.actions.append(action)

        # Add to logs with emoji based on action type
        action_emoji = {
            "read_file": "📖",
            "edit_file": "✏️",
            "run_tests": "🧪",
            "git_commit": "💾",
            "gh_comment": "💬",
        }.get(action.type, "⚙️")

        status_emoji = {
            "executing": "⏳",
            "completed": "✅",
            "failed": "❌",
        }.get(action.status, "❓")

        self.monitor.logs.append(
            f"{action_emoji} {status_emoji} {action.type}: {action.target[:40]}",
        )

    def on_progress(self, current: int, total: int) -> None:
        """Update dashboard with progress"""
        if self.monitor.current_agent_invocation:
            self.monitor.current_agent_invocation.progress = (current, total)

        percentage = (current / total) * 100 if total > 0 else 0
        self.monitor.current_action = f"Progress: {current}/{total} ({percentage:.0f}%)"

    def on_error(self, error: Exception) -> bool:
        """Handle error in dashboard"""
        self.monitor.logs.append(f"❌ Error: {str(error)[:60]}...")

        # Set error state
        self.monitor.status = "error"
        self.monitor.current_action = f"Error: {str(error)[:40]}..."

        # For interactive mode, could prompt user here
        # For now, abort
        return False


class CompositeCallbacks:
    """
    Composite callback that forwards to multiple callback implementations.

    Useful when you want both logging AND dashboard updates.
    """

    def __init__(self, *callbacks: AgentCallbacks):
        self.callbacks = callbacks

    def on_thinking(self, content: str) -> None:
        for callback in self.callbacks:
            callback.on_thinking(content)

    def on_action(self, action: AgentAction) -> None:
        for callback in self.callbacks:
            callback.on_action(action)

    def on_progress(self, current: int, total: int) -> None:
        for callback in self.callbacks:
            callback.on_progress(current, total)

    def on_error(self, error: Exception) -> bool:
        """Return True only if ALL callbacks say continue"""
        results = [callback.on_error(error) for callback in self.callbacks]
        return all(results)


class LoggingCallbacks:
    """
    Simple logging-only callbacks for testing and debugging.
    """

    def __init__(self, log_file: str | None = None):
        self.log_file = log_file
        self.events: list[dict[str, Any]] = []

    def _log(self, event_type: str, data: dict[str, Any]) -> None:
        """Log an event"""
        event = {
            "timestamp": datetime.now(UTC).isoformat(),
            "type": event_type,
            "data": data,
        }
        self.events.append(event)

        # Print to console
        print(f"[{event_type}] {data}")

        # Write to file if configured
        if self.log_file:
            with Path(self.log_file).open("a") as f:
                f.write(json.dumps(event) + "\n")

    def on_thinking(self, content: str) -> None:
        self._log("thinking", {"content": content[:100]})

    def on_action(self, action: AgentAction) -> None:
        self._log("action", {
            "type": action.type,
            "target": action.target,
            "status": action.status,
        })

    def on_progress(self, current: int, total: int) -> None:
        self._log("progress", {"current": current, "total": total})

    def on_error(self, error: Exception) -> bool:
        self._log("error", {"error": str(error), "type": type(error).__name__})
        return False
