#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "rich>=13.0.0",
#     "pyyaml>=6.0",
#     "PyGithub>=2.1.0",
# ]
# ///

"""
TUI Dashboard for merge-god PR automation

Monitors multiple repositories and displays real-time PR processing status.
Runs pr-loop.py as subprocesses for each configured repository.

Features:
- Real-time TUI display (when TTY available)
- Non-TUI mode for no-TTY environments (CI, background, testing)
  * Real-time event logging to stdout (PR starts, completions, failures)
  * Periodic status summaries every 5 minutes
  * Timestamped actionable information for monitoring
- All operations logged to file (default: merge-god-dashboard.log)
  * JSON structured events for programmatic parsing
  * Complete audit trail of all operations
- Multi-repository monitoring
- Automatic doormat credential loading

Usage:
    ./dashboard.py [config_file] [--log-file PATH]
    ./dashboard.py --dry-run          # Validate configuration
    ./dashboard.py | cat              # Force non-TUI mode (no TTY)
    ./dashboard.py 2>&1 | tee out.log # Non-TUI with file capture

Default config file: config.yaml
Default log file: merge-god-dashboard.log

Non-TUI mode outputs actionable information in real-time:
- Repository startup and initialization
- PR processing events (start, complete, failure with reasons)
- Doormat credential loading status
- Critical errors and crashes
- Periodic status summaries with stats
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

import yaml
from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table
from rich.text import Text

from .db_operations import DatabaseError, StateDatabase
from .models import CIStatus, PRState, RepositoryState

# Import our state tracking modules
from .state_tracker import StateTracker, StateTrackerError

# Constants
WIP_LABELS = {"wip", "work-in-process", "work in process"}
ERROR_TRUNCATE_LENGTH = 100
DEFAULT_DB_PATH = Path("merge-god-state.db")

# Display limits for dashboard
MAX_UNTAGGED_PRS_DISPLAY = 5  # Max untagged PRs to show
MAX_LIST_ITEMS_DISPLAY = 3  # Max items to show in state/queue lists


@dataclass
class AgentInvocation:
    """Represents a single agent (bob) invocation with full context"""

    pr_number: int | None
    mode: str
    prompt: str
    prompt_size: int
    timestamp: datetime
    result: dict[str, Any] = field(default_factory=dict)
    duration: float | None = None
    success: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "pr_number": self.pr_number,
            "mode": self.mode,
            "prompt": self.prompt[:500],  # Truncate prompt for display
            "prompt_size": self.prompt_size,
            "timestamp": self.timestamp.isoformat(),
            "result": {
                "returncode": self.result.get("returncode"),
                "stdout": self.result.get("stdout", "")[:200],  # Truncate
                "stderr": self.result.get("stderr", "")[:200],  # Truncate
            },
            "duration": self.duration,
            "success": self.success,
        }


class LogWriter:
    """Handles logging to both file and console"""

    def __init__(self, log_file_path: Path | None = None):
        self.log_file_path = log_file_path
        self.log_file: TextIO | None = None

        if self.log_file_path:
            try:
                # Open log file in append mode
                self.log_file = self.log_file_path.open("a", buffering=1)  # Line buffered
                self._write_separator()
                self.log(f"=== Dashboard started at {datetime.now(UTC).isoformat()} ===")
            except Exception as e:
                print(
                    f"Warning: Could not open log file {self.log_file_path}: {e}", file=sys.stderr
                )

    def _write_separator(self):
        """Write a separator line to the log file"""
        if self.log_file:
            self.log_file.write("\n" + "=" * 80 + "\n")
            self.log_file.flush()

    def log(self, message: str):
        """Write a message to the log file"""
        if self.log_file:
            timestamp = datetime.now(UTC).isoformat()
            self.log_file.write(f"[{timestamp}] {message}\n")
            self.log_file.flush()

    def log_json(self, event: dict[str, Any]):
        """Write a JSON event to the log file"""
        if self.log_file:
            self.log_file.write(json.dumps(event) + "\n")
            self.log_file.flush()

    def close(self):
        """Close the log file"""
        if self.log_file:
            self.log(f"=== Dashboard stopped at {datetime.now(UTC).isoformat()} ===")
            self._write_separator()
            self.log_file.close()
            self.log_file = None


class RepoMonitor:
    """Monitors a single repository's PR processing"""

    def __init__(
        self,
        repo_config: dict[str, Any],
        script_path: Path,
        doormat_config: dict[str, Any] | None = None,
        log_writer: LogWriter | None = None,
        has_tty: bool = False,
        db: StateDatabase | None = None,
    ):
        self.config = repo_config
        self.script_path = script_path
        self.doormat_config = doormat_config or {}
        self.log_writer = log_writer
        self.has_tty = has_tty
        self.db = db  # Optional database for state persistence
        self.name = repo_config.get("name", "Unknown")
        self.path = repo_config.get("path", "")
        self.enabled = repo_config.get("enabled", True)
        self.watch_issues = repo_config.get("watch_issues", False)
        self.interactive = repo_config.get("interactive", True)  # Default to true

        self.process: subprocess.Popen | None = None
        self.status = "idle"
        self.current_pr: str | None = None
        self.current_action: str | None = None
        self.last_update: datetime | None = None
        self.logs: deque[str] = deque(maxlen=50)
        self.pending_confirmation: dict[
            str, Any
        ] | None = None  # Stores pending confirmation request
        self.stats = {
            "prs_processed": 0,
            "successes": 0,
            "failures": 0,
            "iteration": 0,
        }

        # State tracking
        self.state_tracker: StateTracker | None = None
        self.repo_state: RepositoryState | None = None
        self.state_load_error: str | None = None
        self.state_loading: bool = False
        self.state_loaded: bool = False

        # PR queue information (thread-safe access)
        self._pr_queue_lock = threading.Lock()
        self.pr_queue: dict[str, list[dict[str, Any]]] = {
            "for_review": [],
            "for_landing": [],
            "untagged": [],
        }

        # Currently processing PR details
        self.processing_pr: dict[str, Any] | None = None
        self.current_processing_id: int | None = None  # Database record ID for current processing

        # Agent invocation tracking
        self.agent_history: deque[AgentInvocation] = deque(maxlen=50)  # Last 50 invocations
        self.current_agent_invocation: AgentInvocation | None = None
        self.agent_running: bool = False

        # Try to recover previous state from database
        if self.db:
            self._recover_state_from_db()

    def _recover_state_from_db(self) -> None:
        """Recover previous dashboard state from database"""
        if not self.db:
            return

        try:
            # Register repository
            self.db.save_repository(self.name, self.path)

            # Try to recover previous dashboard state
            prev_state = self.db.get_dashboard_state(self.name)
            if prev_state:
                self.stats["prs_processed"] = prev_state.get("prs_processed", 0)
                self.stats["successes"] = prev_state.get("successes", 0)
                self.stats["failures"] = prev_state.get("failures", 0)
                self.stats["iteration"] = prev_state.get("iteration", 0)
                self.logs.append(f"↻ Recovered state: {self.stats['prs_processed']} PRs processed")

                # Log recent processing history
                history = self.db.get_processing_history(self.name, limit=3)
                if history:
                    self.logs.append(f"  Recent history: {len(history)} records")
        except DatabaseError as e:
            self.logs.append(f"⚠ Failed to recover state: {str(e)[:ERROR_TRUNCATE_LENGTH]}")

    def load_agent_history_from_db(self) -> bool:
        """Load agent invocation history from database"""
        if not self.db:
            return False

        try:
            # Get recent processing history from database
            history = self.db.get_processing_history(self.name, limit=50)

            # Clear existing agent history
            self.agent_history.clear()

            # Convert database records to AgentInvocation objects
            for record in reversed(history):  # Reverse to maintain chronological order
                # Only include completed records
                if record.get("completed_at"):
                    metadata = record.get("metadata", {}) or {}

                    # Create agent invocation from database record
                    invocation = AgentInvocation(
                        pr_number=record["pr_number"],
                        mode=record["action_type"],
                        prompt=metadata.get("title", f"PR #{record['pr_number']}"),
                        prompt_size=0,  # Not stored in DB
                        timestamp=datetime.fromisoformat(record["started_at"])
                        if isinstance(record["started_at"], str)
                        else record["started_at"],
                    )

                    # Set result and completion status
                    invocation.success = bool(record.get("success", 0))
                    invocation.duration = record.get("duration_seconds")
                    invocation.result = {
                        "returncode": 0 if invocation.success else 1,
                        "stdout": "" if invocation.success else record.get("error_message", ""),
                        "stderr": record.get("error_message", "") if not invocation.success else "",
                    }

                    self.agent_history.append(invocation)

            if len(self.agent_history) > 0:
                self.logs.append(
                    f"↻ Loaded {len(self.agent_history)} agent invocations from database"
                )

            return True

        except DatabaseError as e:
            self.logs.append(f"⚠ Failed to load agent history: {str(e)[:ERROR_TRUNCATE_LENGTH]}")
            return False

    def refresh_data_for_view(self, view_name: str) -> None:
        """Refresh data needed for a specific view

        Args:
            view_name: Name of the view ("pr_dashboard" or "agent_dashboard")
        """
        if view_name == "agent_dashboard":
            # Load agent history from database if not already loaded
            if len(self.agent_history) == 0 and self.db:
                self.load_agent_history_from_db()

            # Ensure repository state is loaded
            if not self.state_loaded and not self.state_loading:
                self.logs.append("⏳ Loading repository state for agent view...")
                # Initialize in background if not done yet
                if not self.state_tracker:
                    state_thread = threading.Thread(
                        target=self.initialize_state_tracker,
                        daemon=True,
                        name=f"StateTracker-{self.name}",
                    )
                    state_thread.start()

        elif view_name == "pr_dashboard":
            # Ensure PR queue is populated from state if available
            if self.repo_state and not self.processing_pr:
                with self._pr_queue_lock:
                    # Only populate if queue is empty
                    if sum(len(prs) for prs in self.pr_queue.values()) == 0:
                        self.populate_pr_queue_from_state()

    def _persist_state(self) -> None:
        """Persist current state to database"""
        if not self.db:
            return

        try:
            # Save dashboard state
            self.db.save_dashboard_state(
                repo_name=self.name,
                status=self.status,
                stats=self.stats,
                current_pr_number=self.processing_pr.get("number") if self.processing_pr else None,
                state_data={
                    "pr_queue_sizes": {
                        "for_review": len(self.pr_queue["for_review"]),
                        "for_landing": len(self.pr_queue["for_landing"]),
                        "untagged": len(self.pr_queue["untagged"]),
                    },
                },
            )

            # Save repository state if available
            if self.repo_state:
                self.db.save_repository_state(self.name, self.repo_state)

        except DatabaseError as e:
            self.logs.append(f"⚠ Failed to persist state: {str(e)[:ERROR_TRUNCATE_LENGTH]}")

    def load_doormat_credentials(self) -> bool:
        """Load doormat credentials if doormat is available"""
        try:
            # Check if doormat command exists
            result = subprocess.run(
                ["which", "doormat"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )

            if result.returncode != 0:
                # doormat not installed, skip
                return True

            # Get timeout from config or use default
            timeout = self.doormat_config.get("timeout", 30)

            # Check if custom command specified in config
            if "command" in self.doormat_config:
                doormat_commands = [self.doormat_config["command"]]
            else:
                # Try different doormat commands in order of likelihood
                # Different versions/installations may use different commands
                doormat_commands = [
                    ["doormat"],  # Some versions: just 'doormat' refreshes
                    ["doormat", "login"],  # Common pattern
                    ["doormat", "aws", "login"],  # AWS-specific
                    ["doormat", "exec"],  # Exec pattern
                ]

            self.logs.append("Loading doormat credentials...")

            success = False
            last_error = None
            for cmd in doormat_commands:
                try:
                    result = subprocess.run(
                        cmd,
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                    )

                    if result.returncode == 0:
                        self.logs.append(f"✓ Doormat credentials loaded ({' '.join(cmd)})")
                        success = True
                        break
                    last_error = result.stderr
                    # Try next command if this one failed
                except subprocess.TimeoutExpired:
                    last_error = "timeout"
                    # Try next command
                    continue
                except Exception as e:
                    last_error = str(e)
                    # Try next command
                    continue

            if not success:
                self.logs.append("⚠ Could not load doormat credentials (tried multiple commands)")
                if last_error and len(doormat_commands) == 1:
                    # Only show error if custom command was specified
                    error_msg = (
                        last_error[:ERROR_TRUNCATE_LENGTH]
                        if last_error != "timeout"
                        else "operation timed out"
                    )
                    self.logs.append(f"  Error: {error_msg}")
                self.logs.append("  Continuing without credential refresh...")

            return True  # Always non-fatal

        except subprocess.TimeoutExpired:
            self.logs.append("⚠ Doormat refresh timed out")
            return True  # Non-fatal
        except Exception as e:
            self.logs.append(f"⚠ Doormat error: {str(e)[:ERROR_TRUNCATE_LENGTH]}")
            return True  # Non-fatal

    def populate_pr_queue_from_state(self, force: bool = False) -> None:
        """
        Populate PR queue from repository state for immediate dashboard display.

        Args:
            force: If True, overwrite existing queue. If False, only populate if empty.
        """
        if not self.repo_state:
            return

        with self._pr_queue_lock:
            # Check if we should populate (avoid overwriting pr-loop data unless forced)
            if not force:
                existing_count = sum(len(prs) for prs in self.pr_queue.values())
                if existing_count > 0:
                    # Queue already populated by pr-loop, don't overwrite
                    return

            # Get all branches with PRs
            branches_with_prs = self.repo_state.get_branches_with_prs()

            for_review_prs = []
            for_landing_prs = []
            untagged_prs = []

            for branch_state in branches_with_prs:
                pr = branch_state.pr
                if not pr:
                    continue

                # Skip non-open PRs (closed, merged, or draft state)
                if pr.state != PRState.OPEN or pr.draft:
                    continue

                # Skip WIP PRs
                pr_labels_lower = {label.lower() for label in pr.labels}
                if pr_labels_lower & WIP_LABELS:
                    continue

                # Get CI status for sorting and display
                ci_status = pr.get_ci_status()

                # Convert to dict format for display with additional metadata
                pr_info = {
                    "number": pr.number,
                    "title": pr.title,
                    "head_branch": pr.head_branch,
                    "base_branch": pr.base_branch,
                    "ci_status": ci_status.value,
                    "ci_failing": ci_status == CIStatus.FAILURE,
                }

                # Categorize by processing mode
                processing_mode = pr.get_processing_mode()
                if processing_mode == "for-review":
                    for_review_prs.append(pr_info)
                elif processing_mode == "for-landing":
                    for_landing_prs.append(pr_info)
                else:
                    untagged_prs.append(pr_info)

            # Sort PRs: failing CI first, then by PR number
            def sort_key(pr: dict[str, Any]) -> tuple[bool, int]:
                ci_failing = bool(pr.get("ci_failing", False))
                pr_number = int(pr.get("number", 0))
                return (not ci_failing, pr_number)

            for_review_prs.sort(key=sort_key)
            for_landing_prs.sort(key=sort_key)
            untagged_prs.sort(key=lambda pr: int(pr.get("number") or 0))  # type: ignore[call-overload]

            # Update PR queue (thread-safe)
            self.pr_queue = {
                "for_review": for_review_prs,
                "for_landing": for_landing_prs,
                "untagged": untagged_prs,
            }

            # Log the PR queue
            total_prs = len(for_review_prs) + len(for_landing_prs) + len(untagged_prs)
            if total_prs > 0:
                failing_count = sum(
                    1 for pr in for_review_prs + for_landing_prs if pr["ci_failing"]
                )
                self.logs.append(
                    f"✓ Found {total_prs} PRs "
                    f"(review:{len(for_review_prs)}, landing:{len(for_landing_prs)}, skip:{len(untagged_prs)}"
                    f"{f', {failing_count} failing CI' if failing_count > 0 else ''})",
                )

    def initialize_state_tracker(self) -> bool:
        """Initialize state tracker and load initial repository state"""
        if not self.enabled:
            return False

        self.state_loading = True
        import time

        start_time = time.time()

        try:
            self.logs.append("⏳ [1/3] Initializing state tracker...")
            phase_start = time.time()
            self.state_tracker = StateTracker(self.path)
            self.logs.append(
                f"✓ [1/3] State tracker initialized ({time.time() - phase_start:.1f}s)"
            )

            # Build initial state WITHOUT fetching for faster startup
            # pr-loop.py will fetch when it syncs the repo anyway
            self.logs.append("⏳ [2/3] Loading branches and PRs from local cache...")
            phase_start = time.time()
            self.repo_state = self.state_tracker.build_repository_state(
                fetch_first=False,  # Skip fetch for faster dashboard startup
                include_closed_prs=False,
            )
            summary = self.repo_state.summary_dict()
            self.logs.append(
                f"✓ [2/3] Loaded in {time.time() - phase_start:.1f}s: "
                f"{summary['total_branches']} branches, "
                f"{summary['branches_with_prs']} with PRs",
            )
            if summary["failing_ci"] > 0:
                self.logs.append(f"  ⚠ {summary['failing_ci']} PRs with failing CI")

            # Populate PR queue for immediate dashboard display
            self.logs.append("⏳ [3/3] Building PR processing queue...")
            phase_start = time.time()
            self.populate_pr_queue_from_state()
            self.logs.append(f"✓ [3/3] Queue built ({time.time() - phase_start:.1f}s)")

            # Final summary
            elapsed = time.time() - start_time
            self.logs.append(f"✓ State initialization complete in {elapsed:.1f}s")

            # Log state to file if available
            if self.log_writer:
                self.log_writer.log_json(
                    {
                        "event": "repo_state_initialized",
                        "repo": self.name,
                        "data": summary,
                        "elapsed_seconds": elapsed,
                    }
                )

            self.state_loaded = True
            self.state_loading = False
            return True

        except StateTrackerError as e:
            elapsed = time.time() - start_time
            error_msg = f"Failed to initialize state tracker: {str(e)[:ERROR_TRUNCATE_LENGTH]}"
            self.logs.append(f"⚠ {error_msg} (after {elapsed:.1f}s)")
            self.state_load_error = error_msg
            self.state_loading = False
            self.state_loaded = False

            if self.log_writer:
                self.log_writer.log_json(
                    {
                        "event": "repo_state_error",
                        "repo": self.name,
                        "error": str(e),
                        "elapsed_seconds": elapsed,
                    }
                )

            return False

    def refresh_repository_state(self, fetch_first: bool = False) -> bool:
        """Refresh the repository state and PR queue"""
        if not self.state_tracker:
            return False

        try:
            self.repo_state = self.state_tracker.build_repository_state(
                fetch_first=fetch_first,
                include_closed_prs=False,
            )
            # Force repopulate PR queue with fresh data (overwrite existing)
            self.populate_pr_queue_from_state(force=True)
            return True
        except StateTrackerError as e:
            self.logs.append(f"⚠ State refresh failed: {str(e)[:ERROR_TRUNCATE_LENGTH]}")
            return False

    def start(self) -> bool:
        """Start pr-loop.py subprocess for this repo"""
        if not self.enabled:
            self.status = "disabled"
            return False

        if self.process and self.process.poll() is None:
            return True  # Already running

        # Initialize state tracker in background thread (non-blocking)
        self.logs.append("⏳ Loading branch/PR state in background...")
        state_thread = threading.Thread(
            target=self.initialize_state_tracker,
            daemon=True,
            name=f"StateTracker-{self.name}",
        )
        state_thread.start()

        # Load doormat credentials before starting
        self.load_doormat_credentials()

        try:
            # Build command
            cmd = [str(self.script_path), self.path]
            if self.watch_issues:
                cmd.append("--watch-issues")

            # Only pass interactive mode if we have TTY and it's enabled
            if self.has_tty and self.interactive:
                cmd.append("--interactive")

            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,  # Enable stdin for sending responses
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,  # Line buffered
            )
            self.status = "starting"
            mode_str = " (interactive)" if (self.has_tty and self.interactive) else " (automated)"
            self.logs.append(f"▶ Starting pr-loop.py for {self.name}{mode_str}")
            return True
        except Exception as e:
            error_msg = str(e)[:ERROR_TRUNCATE_LENGTH]
            self.status = f"error: {error_msg}"
            self.logs.append(f"✗ CRITICAL: Failed to start: {error_msg}")
            return False

    def send_confirmation_response(self, approved: bool):
        """Send confirmation response to pr-loop.py via stdin"""
        if not self.process or not self.process.stdin:
            return False

        try:
            response = {"approved": approved}
            self.process.stdin.write(json.dumps(response) + "\n")
            self.process.stdin.flush()
            self.pending_confirmation = None
            return True
        except Exception as e:
            self.logs.append(f"⚠ Error sending confirmation: {str(e)[:ERROR_TRUNCATE_LENGTH]}")
            return False

    def stop(self):
        """Stop the subprocess"""
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.status = "stopped"

    def read_output(self) -> list[dict[str, Any]]:
        """Read and parse JSON logs from subprocess"""
        events: list[dict[str, Any]] = []
        if not self.process or not self.process.stdout:
            return events

        try:
            # Non-blocking read
            import select

            if select.select([self.process.stdout], [], [], 0)[0]:
                line = self.process.stdout.readline()
                if line:
                    # Try to parse as JSON
                    try:
                        event = json.loads(line.strip())
                        events.append(event)
                        self.process_event(event)
                    except json.JSONDecodeError:
                        # Not JSON, treat as plain text log
                        self.logs.append(line.strip())
        except Exception as e:
            self.logs.append(f"⚠ Error reading output: {str(e)[:ERROR_TRUNCATE_LENGTH]}")

        # Check if process died
        if self.process.poll() is not None:
            exit_code = self.process.returncode
            if self.status != "crashed":  # Only log once
                self.status = "crashed"
                self.logs.append(f"✗ CRITICAL: Process crashed (exit code: {exit_code})")

        return events

    def process_event(self, event: dict[str, Any]):
        """Process a JSON log event and update state"""
        self.last_update = datetime.now(UTC)
        event_type = event.get("event", "")
        data = event.get("data", {})

        # Log event to file
        if self.log_writer:
            event_with_repo = {**event, "repo": self.name}
            self.log_writer.log_json(event_with_repo)

        # Update status based on event type
        if event_type == "startup":
            self.status = "running"
            self.logs.append(f"✓ Started monitoring {self.name}")

        elif event_type == "iteration":
            action = data.get("action", "")
            self.stats["iteration"] = data.get("number", 0)

            if action == "start":
                self.status = "scanning"
                self.current_action = "Scanning for PRs"
            elif action == "prs_categorized":
                for_review = data.get("for_review", 0)
                for_landing = data.get("for_landing", 0)
                untagged = data.get("untagged", 0)
                self.logs.append(
                    f"Found {for_review + for_landing} PRs "
                    f"(review:{for_review}, landing:{for_landing}, skip:{untagged})",
                )

                # Store PR queue information for display (thread-safe)
                pr_details = data.get("pr_details", {})
                if pr_details:
                    with self._pr_queue_lock:
                        self.pr_queue = {
                            "for_review": pr_details.get("for_review", []),
                            "for_landing": pr_details.get("for_landing", []),
                            "untagged": pr_details.get("untagged", []),
                        }

                    if for_review > 0:
                        review_prs = pr_details.get("for_review", [])
                        for pr in review_prs:
                            self.logs.append(f"  ✓ for-review: PR #{pr['number']} - {pr['title']}")

                    if for_landing > 0:
                        landing_prs = pr_details.get("for_landing", [])
                        for pr in landing_prs:
                            self.logs.append(f"  ✓ for-landing: PR #{pr['number']} - {pr['title']}")

                    if untagged > 0:
                        untagged_prs = pr_details.get("untagged", [])
                        for pr in untagged_prs[:MAX_UNTAGGED_PRS_DISPLAY]:
                            self.logs.append(f"  ⊗ untagged: PR #{pr['number']} - {pr['title']}")
                        if len(untagged_prs) > MAX_UNTAGGED_PRS_DISPLAY:
                            self.logs.append(
                                f"  ⊗ ... and {len(untagged_prs) - MAX_UNTAGGED_PRS_DISPLAY} more untagged"
                            )

            elif action == "complete":
                self.status = "idle"
                self.current_pr = None
                self.current_action = "Waiting for next cycle"

        elif event_type == "fetch_prs":
            action = data.get("action", "")
            if action == "skip_draft":
                pr_number = data.get("pr_number", "?")
                title = data.get("title", "")[:40]
                self.logs.append(f"  ⊗ Skipped draft: PR #{pr_number} - {title}")
            elif action == "skip_wip":
                pr_number = data.get("pr_number", "?")
                title = data.get("title", "")[:40]
                wip_label = data.get("wip_label", "wip")
                self.logs.append(f"  ⊗ Skipped WIP: PR #{pr_number} - {title} (label: {wip_label})")

        elif event_type == "process_pr":
            action = data.get("action", "")
            pr_number = data.get("pr_number", "?")

            if action == "start":
                self.current_pr = f"PR #{pr_number}"
                self.status = "processing"
                title = data.get("title", "")
                mode = data.get("mode", data.get("head_branch", ""))
                head_branch = data.get("head_branch", "")
                base_branch = data.get("base_branch", "")

                # Store detailed processing info
                self.processing_pr = {
                    "number": pr_number,
                    "title": title,
                    "mode": mode,
                    "head_branch": head_branch,
                    "base_branch": base_branch,
                    "started_at": datetime.now(UTC),
                }

                self.current_action = f"Processing {title[:50]}... (mode: {mode})"
                mode_emoji = "🔍" if mode == "for-review" else "🚀"
                self.logs.append(f"{mode_emoji} PR #{pr_number} started: {title[:50]}")
                self.logs.append(f"  Mode: {mode} | Branch: {head_branch} → {base_branch}")

                # Record processing start in database
                if self.db:
                    try:
                        self.current_processing_id = self.db.record_processing_start(
                            repo_name=self.name,
                            pr_number=pr_number,
                            action_type=mode,
                            metadata={
                                "title": title,
                                "head_branch": head_branch,
                                "base_branch": base_branch,
                            },
                        )
                    except DatabaseError as e:
                        self.logs.append(f"⚠ DB error: {str(e)[:ERROR_TRUNCATE_LENGTH]}")

            elif action == "gathering_context":
                phase = data.get("phase", "")
                phase_name = data.get("phase_name", "Gathering context")
                self.current_action = f"[{phase}] {phase_name}..."
                self.logs.append(f"  [{phase}] {phase_name}...")

            elif action == "context_gathered":
                phase = data.get("phase", "")
                self.logs.append(f"  ✓ [{phase}] Context gathered")

            elif action == "building_context":
                phase = data.get("phase", "")
                phase_name = data.get("phase_name", "Building context")
                self.current_action = f"[{phase}] {phase_name}..."
                self.logs.append(f"  [{phase}] {phase_name}...")

            elif action == "context_built":
                phase = data.get("phase", "")
                self.logs.append(f"  ✓ [{phase}] Context ready")

            elif action == "initializing_agent":
                phase = data.get("phase", "")
                phase_name = data.get("phase_name", "Initializing agent")
                self.current_action = f"[{phase}] {phase_name}..."
                self.logs.append(f"  [{phase}] {phase_name}...")

            elif action == "agent_initialized":
                phase = data.get("phase", "")
                model = data.get("model", "unknown")
                self.logs.append(f"  ✓ [{phase}] Agent ready (model: {model})")

            elif action == "agent_processing":
                phase = data.get("phase", "")
                phase_name = data.get("phase_name", "Processing")
                self.current_action = f"[{phase}] {phase_name}..."
                self.logs.append(f"  🤖 [{phase}] {phase_name}...")
                self.agent_running = True

                # Start tracking agent invocation
                if self.processing_pr:
                    self.current_agent_invocation = AgentInvocation(
                        pr_number=self.processing_pr.get("number"),
                        mode=self.processing_pr.get("mode", "unknown"),
                        prompt=f"Processing PR #{self.processing_pr.get('number')}",
                        prompt_size=0,
                        timestamp=datetime.now(UTC),
                    )

            elif action == "prompt_generated":
                prompt_size = data.get("prompt_size", 0)
                self.current_action = f"Prompt generated ({prompt_size} chars), starting agent..."

            elif action == "running_bob":
                self.current_action = "Running agent to process PR..."
                self.agent_running = True

            elif action == "bob_complete":
                returncode = data.get("returncode", -1)
                stdout = data.get("stdout", "")
                stderr = data.get("stderr", "")

                if returncode == 0:
                    self.current_action = "Agent completed successfully"
                else:
                    self.current_action = f"Agent completed with errors (code: {returncode})"

                self.agent_running = False

                # Complete agent invocation tracking
                if self.current_agent_invocation:
                    self.current_agent_invocation.result = {
                        "returncode": returncode,
                        "stdout": stdout,
                        "stderr": stderr,
                    }
                    self.current_agent_invocation.success = returncode == 0
                    self.current_agent_invocation.duration = (
                        datetime.now(UTC) - self.current_agent_invocation.timestamp
                    ).total_seconds()

                    # Add to history
                    self.agent_history.append(self.current_agent_invocation)
                    self.current_agent_invocation = None

            elif action == "review_pass_start":
                self.current_action = "Starting second pass for code review..."

            elif action == "complete":
                success = data.get("success", False)
                duration = data.get("duration", 0)
                tasks_total = data.get("tasks_total", 0)
                tasks_completed = data.get("tasks_completed", 0)
                actions_taken = data.get("actions_taken", 0)

                if success:
                    self.stats["successes"] += 1
                    self.logs.append(
                        f"✓ Completed PR #{pr_number} in {duration:.1f}s "
                        f"({tasks_completed}/{tasks_total} tasks, {actions_taken} actions)",
                    )
                else:
                    self.stats["failures"] += 1
                    reason = data.get("reason", "unknown")
                    self.logs.append(f"✗ Failed PR #{pr_number}: {reason} (after {duration:.1f}s)")
                self.stats["prs_processed"] += 1

                # Record processing completion in database
                if self.db and self.current_processing_id:
                    try:
                        self.db.record_processing_complete(
                            record_id=self.current_processing_id,
                            success=success,
                            error_message=data.get("reason") if not success else None,
                        )
                    except DatabaseError as e:
                        self.logs.append(f"⚠ DB error: {str(e)[:ERROR_TRUNCATE_LENGTH]}")

                # Persist updated stats
                self._persist_state()

                # Clear processing PR
                self.processing_pr = None
                self.current_action = None
                self.current_processing_id = None

        elif event_type == "agent_action":
            action_type = data.get("action_type", "unknown")
            target = data.get("target", "")
            status = data.get("status", "")
            action_number = data.get("action_number", 0)

            # Show action with appropriate emoji
            action_emojis = {
                "git_commit": "💾",
                "gh_comment": "💬",
                "merge_pr": "🔀",
                "file_edit": "✏️",
                "run_tests": "🧪",
                "read_file": "📖",
            }
            emoji = action_emojis.get(action_type, "⚙️")

            if status == "completed":
                self.logs.append(
                    f"  {emoji} Action #{action_number}: {action_type} - {target[:40]}"
                )
                self.current_action = f"Completed: {action_type} - {target[:40]}"
            elif status == "failed":
                self.logs.append(
                    f"  ✗ Action #{action_number} failed: {action_type} - {target[:40]}"
                )

        elif event_type == "agent_progress":
            current = data.get("current", 0)
            total = data.get("total", 0)
            percentage = data.get("percentage", 0)
            self.current_action = f"Progress: {current}/{total} ({percentage:.0f}%)"

        elif event_type == "agent_error":
            error = data.get("error", "Unknown error")
            error_type = data.get("error_type", "")
            will_retry = data.get("will_retry", False)

            if will_retry:
                retry_count = data.get("retry_count", 0)
                self.logs.append(f"  ⚠ {error_type}: {error[:60]}... (retrying {retry_count})")
            else:
                self.logs.append(f"  ✗ {error_type}: {error[:60]}")

        elif event_type == "agent_retry":
            retry_attempt = data.get("retry_attempt", 0)
            max_retries = data.get("max_retries", 3)
            backoff_seconds = data.get("backoff_seconds", 0)
            self.logs.append(
                f"  🔄 Retry {retry_attempt}/{max_retries} (waiting {backoff_seconds}s)"
            )
            self.current_action = f"Retrying ({retry_attempt}/{max_retries})..."

        elif event_type == "notification":
            action = data.get("action", "")
            if action == "sent":
                title = data.get("title", "")
                self.logs.append(f"📱 Notification: {title}")

        elif event_type == "sync_repo":
            action = data.get("action", "")
            if action == "start":
                self.current_action = "Syncing repository"
            elif action == "complete":
                self.current_action = None

        elif event_type == "gather_pr_context":
            action = data.get("action", "")
            pr_number = data.get("pr_number", "?")
            if action == "start":
                self.current_action = f"Gathering context for PR #{pr_number}..."
                self.logs.append("  📋 Gathering PR context...")
            elif action == "complete":
                # Get summary info from context
                context_summary = data.get("context_summary", {})
                comments = context_summary.get("comments", 0)
                review_comments = context_summary.get("review_comments", 0)
                commits = context_summary.get("commits", 0)
                files = context_summary.get("files", 0)
                has_conflicts = context_summary.get("has_conflicts", False)
                ci_failed = context_summary.get("ci_failed", 0)

                self.logs.append(
                    f"  ✓ Context: {comments} comments, {review_comments} reviews, "
                    f"{commits} commits, {files} files",
                )
                if has_conflicts:
                    self.logs.append("  ⚠ Merge conflicts detected")
                if ci_failed > 0:
                    self.logs.append(f"  ✗ {ci_failed} CI checks failing")

        elif event_type == "request_confirmation":
            # Store the pending confirmation request
            self.pending_confirmation = event
            action_type = data.get("action_type", "unknown")
            description = data.get("description", "Perform action")
            self.current_action = f"⚠ Awaiting confirmation: {description}"
            self.logs.append(f"⚠ Confirmation needed: {action_type}")


class Dashboard:
    """Main dashboard that manages multiple repository monitors"""

    def __init__(
        self,
        config_path: Path,
        script_path: Path,
        dry_run: bool = False,
        log_writer: LogWriter | None = None,
        db_path: Path | None = None,
    ):
        self.config_path = config_path
        self.script_path = script_path
        self.dry_run = dry_run
        self.log_writer = log_writer
        self.monitors: list[RepoMonitor] = []
        self.console = Console()
        self.start_time = datetime.now(UTC)
        self.has_tty = sys.stdout.isatty()

        # Screen management
        self.current_screen = "pr_dashboard"  # or "agent_dashboard"
        self.screens = ["pr_dashboard", "agent_dashboard"]

        # Initialize database for state persistence
        self.db: StateDatabase | None = None
        if not dry_run and db_path:
            try:
                self.db = StateDatabase(db_path)
                if log_writer:
                    log_writer.log(f"Database initialized: {db_path}")
            except DatabaseError as e:
                if log_writer:
                    log_writer.log(f"Warning: Failed to initialize database: {e}")

        if log_writer:
            log_writer.log(f"Dashboard initialized (TTY: {self.has_tty}, dry_run: {dry_run})")

    def load_config(self) -> bool:
        """Load configuration from YAML file"""
        try:
            with self.config_path.open() as f:
                config = yaml.safe_load(f)

            if not config or "repos" not in config:
                self.console.print(f"[red]Error: No 'repos' section in {self.config_path}[/red]")
                return False

            repos = config["repos"]
            if not isinstance(repos, list) or not repos:
                self.console.print("[red]Error: 'repos' must be a non-empty list[/red]")
                return False

            # Extract doormat config if present
            doormat_config = config.get("doormat", {})

            # Create monitors for each repo
            for repo_config in repos:
                if not isinstance(repo_config, dict):
                    continue

                # Validate required fields
                if "path" not in repo_config:
                    self.console.print("[yellow]Warning: Skipping repo without 'path'[/yellow]")
                    continue

                # Set defaults
                if "name" not in repo_config:
                    repo_config["name"] = Path(repo_config["path"]).name
                if "enabled" not in repo_config:
                    repo_config["enabled"] = True

                monitor = RepoMonitor(
                    repo_config,
                    self.script_path,
                    doormat_config,
                    self.log_writer,
                    self.has_tty,
                    self.db,
                )
                self.monitors.append(monitor)

            if not self.monitors:
                self.console.print("[red]Error: No valid repositories found in config[/red]")
                return False

            return True

        except FileNotFoundError:
            self.console.print(f"[red]Error: Config file not found: {self.config_path}[/red]")
            return False
        except yaml.YAMLError as e:
            self.console.print(f"[red]Error parsing YAML: {e}[/red]")
            return False
        except Exception as e:
            self.console.print(f"[red]Error loading config: {e}[/red]")
            return False

    def start_all(self):
        """Start all enabled repository monitors"""
        for monitor in self.monitors:
            if monitor.enabled:
                monitor.start()

    def stop_all(self):
        """Stop all repository monitors"""
        for monitor in self.monitors:
            monitor.stop()

    def update(self):
        """Update all monitors by reading their output"""
        for monitor in self.monitors:
            if monitor.enabled and monitor.status != "disabled":
                monitor.read_output()

    def generate_layout(self) -> Layout:
        """Generate Rich layout for display"""
        layout = Layout()
        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="body"),
            Layout(name="footer", size=3),
        )

        # Header
        uptime = datetime.now(UTC) - self.start_time
        uptime_str = str(uptime).split(".")[0]  # Remove microseconds

        header_text = Text()
        header_text.append("merge-god ", style="bold cyan")
        header_text.append("Dashboard", style="bold")
        header_text.append(f" | Uptime: {uptime_str}", style="dim")
        header_text.append(f" | Repos: {len([m for m in self.monitors if m.enabled])}", style="dim")

        # Show current screen
        screen_name = "PR Dashboard" if self.current_screen == "pr_dashboard" else "Agent Dashboard"
        header_text.append(f" | Screen: {screen_name}", style="bold yellow")

        layout["header"].update(Panel(header_text, border_style="cyan"))

        # Body - Repository tables or agent history based on current screen
        if self.current_screen == "pr_dashboard":
            # PR Dashboard
            if len(self.monitors) == 1:
                layout["body"].update(self.generate_repo_panel(self.monitors[0]))
            else:
                # Split body for multiple repos
                body_layouts = []
                for monitor in self.monitors:
                    if monitor.enabled:
                        body_layouts.append(Layout(self.generate_repo_panel(monitor)))

                if body_layouts:
                    layout["body"].split_column(*body_layouts)
                else:
                    layout["body"].update(Panel("[yellow]No enabled repositories[/yellow]"))

        elif self.current_screen == "agent_dashboard":
            # Agent Dashboard
            if len(self.monitors) == 1:
                layout["body"].update(self.generate_agent_screen(self.monitors[0]))
            else:
                # Split body for multiple repos
                body_layouts = []
                for monitor in self.monitors:
                    if monitor.enabled:
                        body_layouts.append(Layout(self.generate_agent_screen(monitor)))

                if body_layouts:
                    layout["body"].split_column(*body_layouts)
                else:
                    layout["body"].update(Panel("[yellow]No enabled repositories[/yellow]"))

        # Footer
        footer_text = Text()
        footer_text.append("Press ", style="dim")
        footer_text.append("1", style="bold")
        footer_text.append(" for PR Dashboard | ", style="dim")
        footer_text.append("2", style="bold")
        footer_text.append(" for Agent Dashboard | ", style="dim")
        footer_text.append("R", style="bold")
        footer_text.append(" to Refresh | ", style="dim")
        footer_text.append("Ctrl+C", style="bold")
        footer_text.append(" to quit", style="dim")

        layout["footer"].update(Panel(footer_text, border_style="cyan"))

        return layout

    def generate_repo_panel(self, monitor: RepoMonitor) -> Panel:
        """Generate panel for a single repository"""
        # Status table
        status_table = Table.grid(padding=(0, 2))
        status_table.add_column(style="bold", justify="right")
        status_table.add_column()

        # Status with color
        status_style = {
            "running": "green",
            "processing": "yellow",
            "scanning": "blue",
            "idle": "dim",
            "starting": "cyan",
            "disabled": "dim",
            "stopped": "red",
            "crashed": "bold red",
        }.get(monitor.status.split(":")[0], "white")

        status_table.add_row("Status:", Text(monitor.status, style=status_style))
        status_table.add_row("Path:", Text(monitor.path, style="dim"))

        if monitor.current_pr:
            status_table.add_row("Current:", Text(monitor.current_pr, style="cyan"))
        if monitor.current_action:
            status_table.add_row("Action:", Text(monitor.current_action, style="yellow"))

        # Stats
        status_table.add_row(
            "Processed:",
            Text(f"{monitor.stats['prs_processed']} ", style="white")
            + Text(f"(✓ {monitor.stats['successes']} ", style="green")
            + Text(f"✗ {monitor.stats['failures']})", style="red"),
        )
        status_table.add_row("Iteration:", Text(str(monitor.stats["iteration"]), style="white"))

        if monitor.last_update:
            ago = (datetime.now(UTC) - monitor.last_update).total_seconds()
            status_table.add_row("Last update:", Text(f"{int(ago)}s ago", style="dim"))

        # Add repository state information if available
        state_text = Text()
        if monitor.state_loading:
            # Show loading status
            state_text.append("\n", style="dim")
            state_text.append("⏳ Loading branch/PR state...\n", style="cyan")
        elif monitor.repo_state:
            state_text.append("\n", style="dim")
            state_text.append("Branch/PR Sync Status:\n", style="bold cyan")

            summary = monitor.repo_state.summary_dict()
            state_text.append(f"  Branches: {summary['total_branches']}", style="white")
            state_text.append(f" ({summary['branches_with_prs']} with PRs)\n", style="dim")

            # All synced indicator
            if summary["branches_needing_sync"] == 0 and summary["total_branches"] > 0:
                state_text.append("  ✓ All branches synced\n", style="green")

            if summary["branches_needing_sync"] > 0:
                state_text.append(
                    f"  ⚠ Needs sync: {summary['branches_needing_sync']}\n",
                    style="yellow",
                )

            if summary["failing_ci"] > 0:
                state_text.append(
                    f"  ✗ Failing CI: {summary['failing_ci']}\n",
                    style="red",
                )
            elif summary["branches_with_prs"] > 0:
                state_text.append("  ✓ All CI passing\n", style="green")

            # Show top failing/behind branches
            failing = monitor.repo_state.get_failing_ci()
            if failing:
                state_text.append("  Failing CI: ", style="red")
                failing_names = [s.branch_name for s in failing[:MAX_LIST_ITEMS_DISPLAY]]
                state_text.append(", ".join(failing_names), style="red dim")
                if len(failing) > MAX_LIST_ITEMS_DISPLAY:
                    state_text.append(
                        f" +{len(failing) - MAX_LIST_ITEMS_DISPLAY} more", style="dim"
                    )
                state_text.append("\n")

            needing_sync = monitor.repo_state.get_branches_needing_sync()
            if needing_sync:
                state_text.append("  Out of sync: ", style="yellow")
                sync_names = [
                    f"{s.branch_name} ({'↑' if s.needs_push else ''}{'↓' if s.needs_pull else ''})"
                    for s in needing_sync[:MAX_LIST_ITEMS_DISPLAY]
                ]
                state_text.append(", ".join(sync_names), style="yellow dim")
                if len(needing_sync) > MAX_LIST_ITEMS_DISPLAY:
                    state_text.append(
                        f" +{len(needing_sync) - MAX_LIST_ITEMS_DISPLAY} more", style="dim"
                    )
                state_text.append("\n")

        elif monitor.state_load_error:
            state_text.append("\n", style="dim")
            state_text.append("State Load Error: ", style="red bold")
            state_text.append(monitor.state_load_error[:ERROR_TRUNCATE_LENGTH], style="red dim")
            state_text.append("\n")

        # PR Queue display
        pr_queue_text = Text()

        # Show currently processing PR with detailed info (most prominent)
        if monitor.processing_pr:
            pr_queue_text.append("\n", style="dim")
            pr_queue_text.append("⚙  Currently Processing:\n", style="bold yellow")

            pr = monitor.processing_pr
            pr_queue_text.append(f"    PR #{pr['number']}: ", style="bold white")
            pr_queue_text.append(f"{pr['title']}\n", style="white")

            # Show branch info
            pr_queue_text.append("    Branch: ", style="dim")
            pr_queue_text.append(f"{pr['head_branch']}", style="cyan")
            pr_queue_text.append(" → ", style="dim")
            pr_queue_text.append(f"{pr['base_branch']}\n", style="cyan")

            # Show mode
            mode_style = "green" if pr["mode"] == "for-review" else "cyan"
            pr_queue_text.append("    Mode: ", style="dim")
            pr_queue_text.append(f"{pr['mode']}\n", style=mode_style)

            # Show elapsed time
            elapsed = (datetime.now(UTC) - pr["started_at"]).total_seconds()
            elapsed_mins = int(elapsed / 60)
            elapsed_secs = int(elapsed % 60)
            pr_queue_text.append("    Elapsed: ", style="dim")
            pr_queue_text.append(f"{elapsed_mins}m {elapsed_secs}s\n", style="yellow")

            # Show current action if available
            if monitor.current_action:
                pr_queue_text.append("    Action: ", style="dim")
                pr_queue_text.append(f"{monitor.current_action}\n", style="yellow dim")

        # Show queued PRs (excluding the one currently being processed) - thread-safe access
        processing_pr_number = (
            monitor.processing_pr.get("number") if monitor.processing_pr else None
        )

        # Filter out currently processing PR from queue (thread-safe)
        with monitor._pr_queue_lock:
            queued_for_review = [
                pr
                for pr in monitor.pr_queue.get("for_review", [])
                if pr.get("number") != processing_pr_number
            ]
            queued_for_landing = [
                pr
                for pr in monitor.pr_queue.get("for_landing", [])
                if pr.get("number") != processing_pr_number
            ]
            queued_untagged = monitor.pr_queue.get("untagged", [])  # These aren't processed anyway

        total_queued = len(queued_for_review) + len(queued_for_landing) + len(queued_untagged)

        if total_queued > 0:
            pr_queue_text.append("\n", style="dim")
            pr_queue_text.append("PR Processing Queue:\n", style="bold cyan")

            # Show for-review PRs
            if queued_for_review:
                pr_queue_text.append(
                    f"  for-review ({len(queued_for_review)}):\n", style="green bold"
                )
                for pr in queued_for_review[:MAX_LIST_ITEMS_DISPLAY]:
                    pr_queue_text.append(
                        f"    • PR #{pr['number']}: {pr['title'][:40]}\n", style="green dim"
                    )
                if len(queued_for_review) > MAX_LIST_ITEMS_DISPLAY:
                    pr_queue_text.append(
                        f"    • ... +{len(queued_for_review) - MAX_LIST_ITEMS_DISPLAY} more\n",
                        style="green dim",
                    )

            # Show for-landing PRs
            if queued_for_landing:
                pr_queue_text.append(
                    f"  for-landing ({len(queued_for_landing)}):\n", style="cyan bold"
                )
                for pr in queued_for_landing[:MAX_LIST_ITEMS_DISPLAY]:
                    pr_queue_text.append(
                        f"    • PR #{pr['number']}: {pr['title'][:40]}\n", style="cyan dim"
                    )
                if len(queued_for_landing) > MAX_LIST_ITEMS_DISPLAY:
                    pr_queue_text.append(
                        f"    • ... +{len(queued_for_landing) - MAX_LIST_ITEMS_DISPLAY} more\n",
                        style="cyan dim",
                    )

            # Show untagged PRs (skipped)
            if queued_untagged:
                pr_queue_text.append(
                    f"  untagged/skipped ({len(queued_untagged)}):\n", style="yellow bold"
                )
                for pr in queued_untagged[:MAX_LIST_ITEMS_DISPLAY]:
                    pr_queue_text.append(
                        f"    ⊗ PR #{pr['number']}: {pr['title'][:40]}\n", style="yellow dim"
                    )
                if len(queued_untagged) > MAX_LIST_ITEMS_DISPLAY:
                    pr_queue_text.append(
                        f"    ⊗ ... +{len(queued_untagged) - MAX_LIST_ITEMS_DISPLAY} more\n",
                        style="yellow dim",
                    )

        # Recent logs
        logs_text = Text()
        for log in list(monitor.logs)[-8:]:  # Show last 8 log lines
            logs_text.append(log + "\n", style="dim")

        # Combine status, state info, PR queue, and logs
        content = Table.grid()
        content.add_row(status_table)
        if state_text.plain:
            content.add_row(state_text)
        if pr_queue_text.plain:
            content.add_row(pr_queue_text)
        content.add_row("")  # Spacer
        content.add_row(logs_text)

        title = f" {monitor.name} "
        border_style = {
            "running": "green",
            "processing": "yellow",
            "scanning": "blue",
            "idle": "dim",
            "disabled": "dim",
            "crashed": "red",
        }.get(monitor.status.split(":")[0], "white")

        return Panel(content, title=title, border_style=border_style)

    def generate_agent_screen(self, monitor: RepoMonitor) -> Panel:
        """Generate panel showing agent invocation history"""
        content = Table.grid(padding=(0, 1))
        content.add_column(style="bold", justify="left", width=120)

        # Header
        header_text = Text()
        header_text.append("Agent Invocation History", style="bold cyan")
        if monitor.agent_running:
            header_text.append(" ⚙ RUNNING", style="bold yellow")
        content.add_row(header_text)
        content.add_row("")

        # Current invocation (if active)
        if monitor.current_agent_invocation:
            inv = monitor.current_agent_invocation
            elapsed = (datetime.now(UTC) - inv.timestamp).total_seconds()

            current_text = Text()
            current_text.append("🤖 Currently Running:\n", style="bold yellow")
            current_text.append(f"   PR #{inv.pr_number} | Mode: {inv.mode}\n", style="white")
            current_text.append(f"   Prompt size: {inv.prompt_size} chars\n", style="dim")
            current_text.append(f"   Started: {inv.timestamp.strftime('%H:%M:%S')}\n", style="dim")
            current_text.append(f"   Elapsed: {int(elapsed)}s\n", style="yellow")

            content.add_row(current_text)
            content.add_row("")

        # Agent history
        if monitor.agent_history:
            history_text = Text()
            history_text.append(
                f"Recent Invocations ({len(monitor.agent_history)}):", style="bold cyan"
            )
            content.add_row(history_text)
            content.add_row("")

            # Show last 10 invocations
            for _i, inv in enumerate(reversed(list(monitor.agent_history)[-10:]), 1):
                inv_text = Text()

                # Status indicator
                if inv.success:
                    status_icon = "✅"
                    status_style = "green"
                elif inv.success is False:
                    status_icon = "❌"
                    status_style = "red"
                else:
                    status_icon = "❓"
                    status_style = "yellow"

                inv_text.append(f"{status_icon} ", style=status_style)
                inv_text.append(f"PR #{inv.pr_number or 'N/A'} ", style="bold white")
                inv_text.append(f"({inv.mode})", style="cyan")
                inv_text.append(f" - {inv.timestamp.strftime('%H:%M:%S')}", style="dim")

                if inv.duration:
                    inv_text.append(f" [{int(inv.duration)}s]", style="yellow dim")

                content.add_row(inv_text)

                # Show result details (expandable)
                if inv.result:
                    result_text = Text()
                    result_text.append("   ", style="dim")

                    returncode = inv.result.get("returncode")
                    if returncode == 0:
                        result_text.append("✓ Success", style="green dim")
                    else:
                        result_text.append(f"✗ Failed (code: {returncode})", style="red dim")

                    # Show truncated output
                    stdout = inv.result.get("stdout", "")
                    stderr = inv.result.get("stderr", "")

                    if stdout:
                        stdout_preview = stdout[:80].replace("\n", " ")
                        result_text.append(f" | Output: {stdout_preview}...", style="dim")
                    if stderr:
                        stderr_preview = stderr[:80].replace("\n", " ")
                        result_text.append(f" | Error: {stderr_preview}...", style="red dim")

                    content.add_row(result_text)

                content.add_row("")  # Spacer

        else:
            no_history = Text("No agent invocations yet", style="dim italic")
            content.add_row(no_history)

        # Statistics
        content.add_row("")
        stats_text = Text()
        stats_text.append("Statistics:\n", style="bold")

        total_invocations = len(monitor.agent_history)
        successful = sum(1 for inv in monitor.agent_history if inv.success is True)
        failed = sum(1 for inv in monitor.agent_history if inv.success is False)

        if total_invocations > 0:
            success_rate = (successful / total_invocations) * 100
            stats_text.append(f"  Total invocations: {total_invocations}\n", style="white")
            stats_text.append(f"  Successful: {successful} ", style="green")
            stats_text.append(f"| Failed: {failed}\n", style="red")
            stats_text.append(f"  Success rate: {success_rate:.1f}%\n", style="cyan")

            # Average duration
            durations = [inv.duration for inv in monitor.agent_history if inv.duration]
            if durations:
                avg_duration = sum(durations) / len(durations)
                stats_text.append(f"  Average duration: {int(avg_duration)}s", style="yellow")
        else:
            stats_text.append("  No statistics available yet", style="dim")

        content.add_row(stats_text)

        title = f" {monitor.name} - Agent History "
        return Panel(content, title=title, border_style="magenta")

    def validate_repo(self, monitor: RepoMonitor) -> dict[str, Any]:
        """Validate a repository configuration and return status"""
        result = {
            "name": monitor.name,
            "path": monitor.path,
            "enabled": monitor.enabled,
            "valid": True,
            "warnings": [],
            "errors": [],
        }

        if not monitor.enabled:
            result["warnings"].append("Repository is disabled")
            return result

        # Check if path exists
        repo_path = Path(monitor.path)
        if not repo_path.exists():
            result["valid"] = False
            result["errors"].append(f"Path does not exist: {monitor.path}")
            return result

        if not repo_path.is_dir():
            result["valid"] = False
            result["errors"].append(f"Path is not a directory: {monitor.path}")
            return result

        # Check if it's a git repository
        git_dir = repo_path / ".git"
        if not git_dir.exists():
            result["valid"] = False
            result["errors"].append("Not a git repository (no .git directory)")
            return result

        # Check if gh CLI is available
        import subprocess

        try:
            subprocess.run(
                ["gh", "auth", "status"],
                check=False,
                capture_output=True,
                timeout=5,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            result["warnings"].append("GitHub CLI (gh) may not be authenticated")

        return result

    def perform_dry_run(self):
        """Validate configuration and display what would be launched"""
        from rich.panel import Panel
        from rich.table import Table

        self.console.print("\n[bold cyan]Dry Run Mode[/bold cyan]")
        self.console.print(f"Config file: [cyan]{self.config_path}[/cyan]\n")

        # Validate configuration loaded
        if not self.monitors:
            self.console.print("[red]✗ No repositories configured[/red]")
            return False

        # Validate pr-loop.py
        if not self.script_path.exists():
            self.console.print(f"[red]✗ pr-loop.py not found at {self.script_path}[/red]")
            return False

        if not self.script_path.is_file():
            self.console.print(f"[red]✗ {self.script_path} is not a file[/red]")
            return False

        # Check if executable
        if not os.access(self.script_path, os.X_OK):
            self.console.print(
                f"[yellow]⚠ {self.script_path} is not executable (run: chmod +x pr-loop.py)[/yellow]"
            )

        self.console.print(f"[green]✓ Found pr-loop.py at {self.script_path}[/green]\n")

        # Create summary table
        table = Table(
            title="Repository Configuration", show_header=True, header_style="bold magenta"
        )
        table.add_column("#", style="dim", width=3)
        table.add_column("Name", style="cyan")
        table.add_column("Path", style="white")
        table.add_column("Enabled", justify="center")
        table.add_column("Status", justify="center")

        enabled_count = 0
        disabled_count = 0
        error_count = 0

        for i, monitor in enumerate(self.monitors, 1):
            validation = self.validate_repo(monitor)

            # Determine status icon and style
            if not monitor.enabled:
                status = "[dim]⊘ Disabled[/dim]"
                disabled_count += 1
            elif not validation["valid"]:
                status = "[red]✗ Invalid[/red]"
                error_count += 1
            elif validation["warnings"]:
                status = "[yellow]⚠ Warning[/yellow]"
                enabled_count += 1
            else:
                status = "[green]✓ Valid[/green]"
                enabled_count += 1

            enabled_display = "[green]Yes[/green]" if monitor.enabled else "[dim]No[/dim]"

            table.add_row(
                str(i),
                monitor.name,
                monitor.path,
                enabled_display,
                status,
            )

        self.console.print(table)
        self.console.print()

        # Show detailed errors and warnings
        has_issues = False
        for i, monitor in enumerate(self.monitors, 1):
            validation = self.validate_repo(monitor)

            if validation["errors"] or validation["warnings"]:
                has_issues = True
                self.console.print(f"[bold]{i}. {monitor.name}[/bold]")

                for error in validation["errors"]:
                    self.console.print(f"  [red]✗ {error}[/red]")

                for warning in validation["warnings"]:
                    self.console.print(f"  [yellow]⚠ {warning}[/yellow]")

                self.console.print()

        # Summary
        summary = Panel(
            f"[bold]Summary[/bold]\n\n"
            f"Total repositories: [white]{len(self.monitors)}[/white]\n"
            f"Enabled: [green]{enabled_count}[/green]\n"
            f"Disabled: [dim]{disabled_count}[/dim]\n"
            f"Errors: [red]{error_count}[/red]\n\n"
            f"{'[yellow]⚠ Issues detected - review above[/yellow]' if has_issues else '[green]✓ All enabled repos valid[/green]'}\n\n"
            f"[dim]To run: ./dashboard.py {self.config_path}[/dim]",
            border_style="cyan",
        )
        self.console.print(summary)

        return error_count == 0

    def run_non_tui(self):
        """Run dashboard in non-TUI mode (for no TTY environments)"""
        print("\n=== merge-god Dashboard (Non-TUI Mode) ===")
        print(f"Config: {self.config_path}")
        print(f"Repositories: {len([m for m in self.monitors if m.enabled])} enabled")
        print(f"Started: {self.start_time.isoformat()}")

        if self.log_writer and self.log_writer.log_file_path:
            print(f"Log file: {self.log_writer.log_file_path}")

        # Check if any repo has issue watching enabled
        has_issue_watching = any(m.watch_issues for m in self.monitors if m.enabled)

        # Show tag selection criteria
        show_tag_criteria(console=None, has_issue_watching=has_issue_watching)

        print("Monitoring repositories (Ctrl+C to stop):\n")

        for monitor in self.monitors:
            if monitor.enabled:
                status = "✓ enabled" if monitor.enabled else "○ disabled"
                print(f"  {status} {monitor.name} ({monitor.path})")

                # Show repository state if available
                if monitor.repo_state:
                    summary = monitor.repo_state.summary_dict()
                    print(
                        f"    State: {summary['total_branches']} branches, "
                        f"{summary['branches_with_prs']} with PRs, "
                        f"{summary['branches_needing_sync']} need sync, "
                        f"{summary['failing_ci']} failing CI"
                    )

        print("\n" + "=" * 60 + "\n")

        # Track last status print time and last log position for each monitor
        last_status_time = time.time()
        status_interval = 300  # Print status summary every 5 minutes
        last_log_positions = {monitor.name: 0 for monitor in self.monitors if monitor.enabled}

        try:
            while True:
                self.update()

                # Print new log messages from each monitor in real-time
                for monitor in self.monitors:
                    if not monitor.enabled:
                        continue

                    # Get new logs since last check
                    last_pos = last_log_positions[monitor.name]
                    current_logs = list(monitor.logs)

                    # Print any new logs
                    if len(current_logs) > last_pos:
                        new_logs = current_logs[last_pos:]
                        for log_line in new_logs:
                            timestamp = datetime.now(UTC).strftime("%H:%M:%S")
                            print(f"[{timestamp}] [{monitor.name}] {log_line}")

                        last_log_positions[monitor.name] = len(current_logs)

                # Print periodic status summaries (less frequently)
                current_time = time.time()
                if current_time - last_status_time >= status_interval:
                    uptime = datetime.now(UTC) - self.start_time
                    uptime_str = str(uptime).split(".")[0]
                    print(f"\n{'=' * 60}")
                    print(
                        f"[{datetime.now(UTC).isoformat()}] STATUS SUMMARY (uptime: {uptime_str})"
                    )
                    print(f"{'=' * 60}")

                    for monitor in self.monitors:
                        if monitor.enabled:
                            pr_info = (
                                f" | Current: {monitor.current_pr}" if monitor.current_pr else ""
                            )
                            print(f"  {monitor.name}: {monitor.status}{pr_info}")
                            print(
                                f"    Stats: {monitor.stats['prs_processed']} processed "
                                f"(✓ {monitor.stats['successes']} ✗ {monitor.stats['failures']}) "
                                f"| Iteration: {monitor.stats['iteration']}"
                            )

                    print(f"{'=' * 60}\n")
                    last_status_time = current_time

                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\n\nShutting down...")
            self.stop_all()
            print("✓ Dashboard stopped\n")

    def check_keyboard_input(self) -> bool:
        """Check for keyboard input (non-blocking) and handle screen switching

        Returns:
            True if a key was pressed and handled, False otherwise
        """
        import select
        import sys
        import termios

        # Only works in TTY mode
        if not self.has_tty:
            return False

        # Non-blocking check for input
        try:
            # Save terminal settings
            old_settings = termios.tcgetattr(sys.stdin)

            try:
                # Set terminal to cbreak mode with echo disabled
                new_settings = termios.tcgetattr(sys.stdin)
                new_settings[3] = new_settings[3] & ~termios.ECHO  # Disable echo
                new_settings[3] = new_settings[3] & ~termios.ICANON  # Disable canonical mode
                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, new_settings)

                # Check if input is available (non-blocking)
                if select.select([sys.stdin], [], [], 0)[0]:
                    key = sys.stdin.read(1)

                    # Handle screen switching
                    if key == "1":
                        old_screen = self.current_screen
                        self.current_screen = "pr_dashboard"
                        # Refresh data if switching to this view
                        if old_screen != self.current_screen:
                            for monitor in self.monitors:
                                if monitor.enabled:
                                    monitor.refresh_data_for_view(self.current_screen)
                        return True
                    if key == "2":
                        old_screen = self.current_screen
                        self.current_screen = "agent_dashboard"
                        # Refresh data if switching to this view
                        if old_screen != self.current_screen:
                            for monitor in self.monitors:
                                if monitor.enabled:
                                    monitor.refresh_data_for_view(self.current_screen)
                        return True
                    if key.upper() == "R":
                        # Manual refresh - trigger repository state refresh for all monitors
                        for monitor in self.monitors:
                            if monitor.enabled:
                                self.trigger_manual_refresh(monitor)
                        return True

            finally:
                # Restore terminal settings
                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)

        except Exception:
            # If anything goes wrong, just skip keyboard handling
            pass

        return False

    def trigger_manual_refresh(self, monitor: RepoMonitor):
        """Trigger a manual refresh of repository state in background thread"""
        monitor.logs.append("⟳ Manual refresh triggered...")

        def refresh_task():
            try:
                if monitor.state_tracker:
                    # Refresh with fetch from remote
                    success = monitor.refresh_repository_state(fetch_first=True)
                    if success:
                        monitor.logs.append("✓ Manual refresh complete")
                    else:
                        monitor.logs.append("⚠ Manual refresh failed")
                else:
                    # Initialize state tracker if not done yet
                    monitor.logs.append("⏳ Initializing state tracker...")
                    success = monitor.initialize_state_tracker()
                    if success:
                        monitor.logs.append("✓ State tracker initialized")
                    else:
                        monitor.logs.append("⚠ State tracker initialization failed")
            except Exception as e:
                monitor.logs.append(f"⚠ Refresh error: {str(e)[:ERROR_TRUNCATE_LENGTH]}")

        # Run refresh in background thread to avoid blocking UI
        refresh_thread = threading.Thread(
            target=refresh_task,
            daemon=True,
            name=f"ManualRefresh-{monitor.name}",
        )
        refresh_thread.start()

    def check_pending_confirmations(self, live: Live) -> bool:
        """Check for pending confirmations and prompt user if needed"""
        for monitor in self.monitors:
            if monitor.pending_confirmation:
                # Pause the live display to show prompt
                live.stop()

                # Extract confirmation details
                data = monitor.pending_confirmation.get("data", {})
                action_type = data.get("action_type", "unknown")
                description = data.get("description", "Perform action")
                pr_number = data.get("pr_number", "")
                details = data.get("details", {})

                # Build prompt message
                self.console.print()
                self.console.print(
                    Panel(
                        f"[bold yellow]Confirmation Required[/bold yellow]\n\n"
                        f"[bold]Repository:[/bold] {monitor.name}\n"
                        f"[bold]Action:[/bold] {action_type}\n"
                        f"[bold]Description:[/bold] {description}\n"
                        + (f"[bold]PR:[/bold] #{pr_number}\n" if pr_number else "")
                        + "\n".join([f"[dim]{k}:[/dim] {v}" for k, v in details.items()]),
                        border_style="yellow",
                        title="⚠ User Action Required",
                    )
                )

                # Prompt for confirmation
                from rich.prompt import Confirm

                approved = Confirm.ask(
                    "\n[bold cyan]Proceed with this action?[/bold cyan]",
                    default=False,
                )

                # Send response
                monitor.send_confirmation_response(approved)

                if approved:
                    self.console.print("[green]✓ Action approved[/green]")
                else:
                    self.console.print("[yellow]✗ Action declined[/yellow]")

                self.console.print()

                # Resume the live display
                live.start()
                return True

        return False

    def run(self):
        """Run the dashboard"""
        if self.dry_run:
            return self.perform_dry_run()

        # Choose TUI or non-TUI mode based on TTY availability
        if not self.has_tty:
            if self.log_writer:
                self.log_writer.log("Running in non-TUI mode (no TTY detected)")
            return self.run_non_tui()

        # TUI mode
        if self.log_writer:
            self.log_writer.log("Running in TUI mode")

        try:
            with Live(
                self.generate_layout(),
                console=self.console,
                refresh_per_second=4,  # Higher refresh rate for smoother updates
                screen=False,  # Don't use alternate screen (reduces flicker)
                transient=False,  # Keep display persistent
            ) as live:
                while True:
                    self.update()

                    # Check for keyboard input (screen switching)
                    key_pressed = self.check_keyboard_input()

                    # Check for pending confirmations
                    if self.check_pending_confirmations(live):
                        # Redraw after confirmation prompt
                        live.update(self.generate_layout(), refresh=True)
                    elif key_pressed:
                        # Redraw after screen switch
                        live.update(self.generate_layout(), refresh=True)
                    else:
                        # Normal update
                        live.update(self.generate_layout())

                    time.sleep(0.25)  # Faster polling for more responsive UI
        except KeyboardInterrupt:
            self.console.print("\n[yellow]Shutting down...[/yellow]")
            self.stop_all()
            self.console.print("[green]✓ Dashboard stopped[/green]")


def show_tag_criteria(console: Console | None = None, has_issue_watching: bool = False):
    """Display PR and issue selection criteria

    Args:
        console: Rich Console for TUI mode (None for non-TUI)
        has_issue_watching: Whether any repo has issue watching enabled
    """
    use_console = console is not None

    if use_console and console:
        # Rich formatted output
        console.print("\n[bold cyan]Selection Criteria[/bold cyan]")
        console.print("[dim]" + "─" * 60 + "[/dim]")

        if has_issue_watching:
            console.print("\n[bold magenta]⚡ PRIMARY: Issues (processed first)[/bold magenta]")
            console.print(
                "  [magenta]•[/magenta] [bold]for-impl[/bold] - Feature/fix implementation requests"
            )
            console.print("  [dim]  → Creates branch, implements, creates PR, links to issue[/dim]")

        console.print("\n[bold green]✓ PRs will be processed if labeled:[/bold green]")
        console.print(
            "  [green]•[/green] [bold]for-review[/bold] - Comprehensive review with code improvements"
        )
        console.print(
            "  [green]•[/green] [bold]for-landing[/bold] - Basic processing to merge (conflicts, reviews, CI)"
        )
        console.print("\n[bold red]✗ PRs will be skipped if:[/bold red]")
        console.print("  [red]•[/red] Draft PRs ([dim]isDraft: true[/dim])")
        console.print(
            "  [red]•[/red] WIP labels ([dim]wip, work-in-process, work in process[/dim])"
        )
        console.print(
            "  [red]•[/red] No processing label ([dim]missing for-review or for-landing[/dim])"
        )
        console.print("\n[dim]" + "─" * 60 + "[/dim]\n")
    else:
        # Plain text output for non-TUI mode
        print("\n" + "=" * 60)
        print("Selection Criteria")
        print("=" * 60)

        if has_issue_watching:
            print("\n⚡ PRIMARY: Issues (processed first)")
            print("  • for-impl - Feature/fix implementation requests")
            print("    → Creates branch, implements, creates PR, links to issue")

        print("\n✓ PRs will be processed if labeled:")
        print("  • for-review - Comprehensive review with code improvements")
        print("  • for-landing - Basic processing to merge (conflicts, reviews, CI)")
        print("\n✗ PRs will be skipped if:")
        print("  • Draft PRs (isDraft: true)")
        print("  • WIP labels (wip, work-in-process, work in process)")
        print("  • No processing label (missing for-review or for-landing)")
        print("\n" + "=" * 60 + "\n")


def bootstrap_config(config_path: Path) -> bool:
    """Interactive wizard to create initial config.yaml"""
    console = Console()

    console.print("\n[bold cyan]Config File Not Found[/bold cyan]")
    console.print(f"No configuration file found at: [yellow]{config_path}[/yellow]\n")

    # Ask if user wants to create config
    if not Confirm.ask("Would you like to create a configuration file now?", default=True):
        console.print("\n[yellow]Configuration creation cancelled.[/yellow]")
        console.print(
            f"You can create {config_path} manually or use config.example.yaml as a template.\n"
        )
        return False

    console.print("\n[bold cyan]Interactive Configuration Setup[/bold cyan]")
    console.print("Let's configure repositories for PR automation.\n")

    repos: list[dict[str, Any]] = []

    while True:
        console.print(f"\n[bold]Repository #{len(repos) + 1}[/bold]")

        # Get repository path
        while True:
            repo_path = Prompt.ask("  Repository path (absolute path)", default="")

            if not repo_path:
                console.print("  [red]✗ Path cannot be empty[/red]")
                continue

            # Expand user home directory
            repo_path = str(Path(repo_path).expanduser().resolve())

            # Validate path
            path_obj = Path(repo_path)
            if not path_obj.exists():
                console.print(f"  [yellow]⚠ Path does not exist: {repo_path}[/yellow]")
                if not Confirm.ask("  Use this path anyway?", default=False):
                    continue
            elif not path_obj.is_dir():
                console.print(f"  [red]✗ Path is not a directory: {repo_path}[/red]")
                continue
            elif not (path_obj / ".git").exists():
                console.print("  [yellow]⚠ Not a git repository (no .git directory)[/yellow]")
                if not Confirm.ask("  Use this path anyway?", default=False):
                    continue
            else:
                console.print("  [green]✓ Valid git repository[/green]")

            break

        # Get repository name
        default_name = Path(repo_path).name
        repo_name = Prompt.ask("  Repository name (display name)", default=default_name)

        # Ask if enabled
        enabled = Confirm.ask("  Enable this repository?", default=True)

        # Add to list
        repos.append(
            {
                "path": repo_path,
                "name": repo_name,
                "enabled": enabled,
            }
        )

        console.print(f"\n[green]✓ Added: {repo_name}[/green]")

        # Ask if user wants to add another
        if not Confirm.ask("\nAdd another repository?", default=False):
            break

    # Show summary
    console.print("\n[bold cyan]Configuration Summary[/bold cyan]\n")

    table = Table(show_header=True, header_style="bold magenta")
    table.add_column("#", style="dim", width=3)
    table.add_column("Name", style="cyan")
    table.add_column("Path", style="white")
    table.add_column("Enabled", justify="center")

    for i, repo in enumerate(repos, 1):
        enabled_display = "[green]Yes[/green]" if repo["enabled"] else "[dim]No[/dim]"
        table.add_row(
            str(i),
            str(repo["name"]),
            str(repo["path"]),
            enabled_display,
        )

    console.print(table)
    console.print()

    # Confirm creation
    if not Confirm.ask(f"Save configuration to {config_path}?", default=True):
        console.print("\n[yellow]Configuration creation cancelled.[/yellow]\n")
        return False

    # Create config structure
    config = {
        "repos": repos,
    }

    # Write config file
    try:
        # Ensure parent directory exists
        config_path.parent.mkdir(parents=True, exist_ok=True)

        with config_path.open("w") as f:
            # Write with nice formatting and comments
            f.write("# merge-god Configuration File\n")
            f.write("# Generated by interactive setup\n")
            f.write(f"# Created: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}\n")
            f.write("\n")
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)

        console.print(f"\n[green]✓ Configuration saved to {config_path}[/green]\n")

        # Offer to run dry-run validation
        if Confirm.ask("Validate configuration now (dry-run)?", default=True):
            console.print()
            return True  # Signal to run dry-run

        console.print("\n[cyan]Configuration complete! Run the dashboard:[/cyan]")
        console.print("  [bold]./dashboard.py[/bold]\n")

        return False  # Don't run dry-run

    except Exception as e:
        console.print(f"\n[red]✗ Error saving configuration: {e}[/red]\n")
        return False


def parse_args() -> argparse.Namespace:
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="TUI Dashboard for merge-god PR automation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  ./dashboard.py                    # Use config.yaml
  ./dashboard.py my-config.yaml     # Use custom config file
  ./dashboard.py --dry-run          # Validate config without launching

Config file format (YAML):
  repos:
    - path: /path/to/repo
      name: "Repo Name"
      enabled: true

Use --dry-run to validate configuration before launching.
Runs in tmux/screen for persistent sessions.
Press Ctrl+C to quit.
        """,
    )

    parser.add_argument(
        "config",
        type=Path,
        nargs="?",
        default=Path("config.yaml"),
        help="Path to YAML config file (default: config.yaml)",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration and show what would be launched without starting",
    )

    parser.add_argument(
        "--log-file",
        type=Path,
        default=Path("merge-god-dashboard.log"),
        help="Path to log file for all operations (default: merge-god-dashboard.log)",
    )

    parser.add_argument(
        "--db-path",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Path to SQLite database for state persistence (default: {DEFAULT_DB_PATH})",
    )

    return parser.parse_args()


def main():
    """Main entry point"""
    args = parse_args()

    # Create log writer (unless dry-run mode)
    log_writer: LogWriter | None = None
    if not args.dry_run:
        log_writer = LogWriter(args.log_file)

        # Show log file location at the very top
        console = Console()
        console.print(f"\n[dim]Log file: {args.log_file.absolute()}[/dim]\n")

    # Check if config file exists
    if not args.config.exists():
        # Offer interactive bootstrap
        run_dry_run = bootstrap_config(args.config)

        # If config still doesn't exist, exit
        if not args.config.exists():
            sys.exit(1)

        # If user requested dry-run validation, run it
        if run_dry_run:
            args.dry_run = True

    # Find pr-loop.py script
    script_path = Path(__file__).parent / "pr-loop.py"
    if not script_path.exists():
        print(f"Error: pr-loop.py not found at {script_path}", file=sys.stderr)
        sys.exit(1)

    # Create and run dashboard
    dashboard = Dashboard(
        args.config, script_path, dry_run=args.dry_run, log_writer=log_writer, db_path=args.db_path
    )

    if not dashboard.load_config():
        if log_writer:
            log_writer.close()
        sys.exit(1)

    if args.dry_run:
        # Run validation and display
        success = dashboard.run()
        sys.exit(0 if success else 1)

    console = Console()
    console.print(
        f"[green]✓ Loaded {len(dashboard.monitors)} repositories from {args.config}[/green]"
    )

    # Check if any repo has issue watching enabled
    has_issue_watching = any(m.watch_issues for m in dashboard.monitors if m.enabled)

    # Show tag selection criteria
    show_tag_criteria(console, has_issue_watching=has_issue_watching)

    console.print("[cyan]Starting dashboard...[/cyan]\n")

    # Give user a moment to see startup message
    time.sleep(1)

    try:
        dashboard.start_all()
        dashboard.run()
    finally:
        # Clean up log writer
        if log_writer:
            log_writer.close()


if __name__ == "__main__":
    main()
