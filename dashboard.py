#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "rich>=13.0.0",
#     "pyyaml>=6.0",
# ]
# ///

"""
TUI Dashboard for merge-god PR automation

Monitors multiple repositories and displays real-time PR processing status.
Runs pr-loop.py as subprocesses for each configured repository.

Features:
- Real-time TUI display (when TTY available)
- Non-TUI mode for no-TTY environments (CI, background, testing)
- All operations logged to file (default: merge-god-dashboard.log)
- Multi-repository monitoring
- Automatic doormat credential loading

Usage:
    ./dashboard.py [config_file] [--log-file PATH]
    ./dashboard.py --dry-run          # Validate configuration
    ./dashboard.py | cat              # Force non-TUI mode (no TTY)

Default config file: config.yaml
Default log file: merge-god-dashboard.log
"""

import argparse
import json
import os
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone
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


class LogWriter:
    """Handles logging to both file and console"""

    def __init__(self, log_file_path: Path | None = None):
        self.log_file_path = log_file_path
        self.log_file: TextIO | None = None

        if self.log_file_path:
            try:
                # Open log file in append mode
                self.log_file = open(self.log_file_path, 'a', buffering=1)  # Line buffered
                self._write_separator()
                self.log(f"=== Dashboard started at {datetime.now(timezone.utc).isoformat()} ===")
            except Exception as e:
                print(f"Warning: Could not open log file {self.log_file_path}: {e}", file=sys.stderr)

    def _write_separator(self):
        """Write a separator line to the log file"""
        if self.log_file:
            self.log_file.write("\n" + "=" * 80 + "\n")
            self.log_file.flush()

    def log(self, message: str):
        """Write a message to the log file"""
        if self.log_file:
            timestamp = datetime.now(timezone.utc).isoformat()
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
            self.log(f"=== Dashboard stopped at {datetime.now(timezone.utc).isoformat()} ===")
            self._write_separator()
            self.log_file.close()
            self.log_file = None


class RepoMonitor:
    """Monitors a single repository's PR processing"""

    def __init__(self, repo_config: dict[str, Any], script_path: Path, doormat_config: dict[str, Any] | None = None, log_writer: LogWriter | None = None):
        self.config = repo_config
        self.script_path = script_path
        self.doormat_config = doormat_config or {}
        self.log_writer = log_writer
        self.name = repo_config.get("name", "Unknown")
        self.path = repo_config.get("path", "")
        self.enabled = repo_config.get("enabled", True)
        self.watch_issues = repo_config.get("watch_issues", False)

        self.process: subprocess.Popen | None = None
        self.status = "idle"
        self.current_pr: str | None = None
        self.current_action: str | None = None
        self.last_update: datetime | None = None
        self.logs: deque[str] = deque(maxlen=50)
        self.stats = {
            "prs_processed": 0,
            "successes": 0,
            "failures": 0,
            "iteration": 0,
        }

    def load_doormat_credentials(self) -> bool:
        """Load doormat credentials if doormat is available"""
        try:
            # Check if doormat command exists
            result = subprocess.run(
                ["which", "doormat"],
                capture_output=True,
                text=True,
                timeout=5
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
                    ["doormat"],                    # Some versions: just 'doormat' refreshes
                    ["doormat", "login"],           # Common pattern
                    ["doormat", "aws", "login"],    # AWS-specific
                    ["doormat", "exec"],            # Exec pattern
                ]

            self.logs.append("Loading doormat credentials...")

            success = False
            last_error = None
            for cmd in doormat_commands:
                try:
                    result = subprocess.run(
                        cmd,
                        capture_output=True,
                        text=True,
                        timeout=timeout
                    )

                    if result.returncode == 0:
                        self.logs.append(f"✓ Doormat credentials loaded ({' '.join(cmd)})")
                        success = True
                        break
                    else:
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
                    error_msg = last_error[:100] if last_error != "timeout" else "operation timed out"
                    self.logs.append(f"  Error: {error_msg}")
                self.logs.append("  Continuing without credential refresh...")

            return True  # Always non-fatal

        except subprocess.TimeoutExpired:
            self.logs.append("⚠ Doormat refresh timed out")
            return True  # Non-fatal
        except Exception as e:
            self.logs.append(f"⚠ Doormat error: {str(e)[:100]}")
            return True  # Non-fatal

    def start(self) -> bool:
        """Start pr-loop.py subprocess for this repo"""
        if not self.enabled:
            self.status = "disabled"
            return False

        if self.process and self.process.poll() is None:
            return True  # Already running

        # Load doormat credentials before starting
        self.load_doormat_credentials()

        try:
            # Build command
            cmd = [str(self.script_path), self.path]
            if self.watch_issues:
                cmd.append("--watch-issues")

            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,  # Line buffered
            )
            self.status = "starting"
            return True
        except Exception as e:
            self.status = f"error: {str(e)}"
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
        events = []
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
        except Exception:
            pass

        # Check if process died
        if self.process.poll() is not None:
            self.status = "crashed"

        return events

    def process_event(self, event: dict[str, Any]):
        """Process a JSON log event and update state"""
        self.last_update = datetime.now(timezone.utc)
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
                    f"(review:{for_review}, landing:{for_landing}, skip:{untagged})"
                )
            elif action == "complete":
                self.status = "idle"
                self.current_pr = None
                self.current_action = "Waiting for next cycle"

        elif event_type == "process_pr":
            action = data.get("action", "")
            pr_number = data.get("pr_number", "?")

            if action == "start":
                self.current_pr = f"PR #{pr_number}"
                self.status = "processing"
                title = data.get("title", "")[:50]
                mode = data.get("mode", data.get("head_branch", ""))
                self.current_action = f"Processing {title}... (mode: {mode})"
                self.logs.append(f"▶ Started PR #{pr_number}: {title}")

            elif action == "complete":
                success = data.get("success", False)
                if success:
                    self.stats["successes"] += 1
                    self.logs.append(f"✓ Completed PR #{pr_number}")
                else:
                    self.stats["failures"] += 1
                    reason = data.get("reason", "unknown")
                    self.logs.append(f"✗ Failed PR #{pr_number}: {reason}")
                self.stats["prs_processed"] += 1

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
            if action == "start":
                self.current_action = "Gathering PR context"


class Dashboard:
    """Main dashboard that manages multiple repository monitors"""

    def __init__(self, config_path: Path, script_path: Path, dry_run: bool = False, log_writer: LogWriter | None = None):
        self.config_path = config_path
        self.script_path = script_path
        self.dry_run = dry_run
        self.log_writer = log_writer
        self.monitors: list[RepoMonitor] = []
        self.console = Console()
        self.start_time = datetime.now(timezone.utc)
        self.has_tty = sys.stdout.isatty()

        if log_writer:
            log_writer.log(f"Dashboard initialized (TTY: {self.has_tty}, dry_run: {dry_run})")

    def load_config(self) -> bool:
        """Load configuration from YAML file"""
        try:
            with open(self.config_path) as f:
                config = yaml.safe_load(f)

            if not config or "repos" not in config:
                self.console.print(f"[red]Error: No 'repos' section in {self.config_path}[/red]")
                return False

            repos = config["repos"]
            if not isinstance(repos, list) or not repos:
                self.console.print(f"[red]Error: 'repos' must be a non-empty list[/red]")
                return False

            # Extract doormat config if present
            doormat_config = config.get("doormat", {})

            # Create monitors for each repo
            for repo_config in repos:
                if not isinstance(repo_config, dict):
                    continue

                # Validate required fields
                if "path" not in repo_config:
                    self.console.print(f"[yellow]Warning: Skipping repo without 'path'[/yellow]")
                    continue

                # Set defaults
                if "name" not in repo_config:
                    repo_config["name"] = Path(repo_config["path"]).name
                if "enabled" not in repo_config:
                    repo_config["enabled"] = True

                monitor = RepoMonitor(repo_config, self.script_path, doormat_config, self.log_writer)
                self.monitors.append(monitor)

            if not self.monitors:
                self.console.print(f"[red]Error: No valid repositories found in config[/red]")
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
            Layout(name="footer", size=3)
        )

        # Header
        uptime = datetime.now(timezone.utc) - self.start_time
        uptime_str = str(uptime).split('.')[0]  # Remove microseconds

        header_text = Text()
        header_text.append("merge-god ", style="bold cyan")
        header_text.append("Dashboard", style="bold")
        header_text.append(f" | Uptime: {uptime_str}", style="dim")
        header_text.append(f" | Repos: {len([m for m in self.monitors if m.enabled])}", style="dim")

        layout["header"].update(Panel(header_text, border_style="cyan"))

        # Body - Repository tables
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

        # Footer
        footer_text = Text()
        footer_text.append("Press ", style="dim")
        footer_text.append("Ctrl+C", style="bold")
        footer_text.append(" to quit | Config: ", style="dim")
        footer_text.append(str(self.config_path), style="cyan dim")

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
            Text(f"{monitor.stats['prs_processed']} ", style="white") +
            Text(f"(✓ {monitor.stats['successes']} ", style="green") +
            Text(f"✗ {monitor.stats['failures']})", style="red")
        )
        status_table.add_row("Iteration:", Text(str(monitor.stats['iteration']), style="white"))

        if monitor.last_update:
            ago = (datetime.now(timezone.utc) - monitor.last_update).total_seconds()
            status_table.add_row("Last update:", Text(f"{int(ago)}s ago", style="dim"))

        # Recent logs
        logs_text = Text()
        for log in list(monitor.logs)[-8:]:  # Show last 8 log lines
            logs_text.append(log + "\n", style="dim")

        # Combine status and logs
        content = Table.grid()
        content.add_row(status_table)
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

    def validate_repo(self, monitor: RepoMonitor) -> dict[str, Any]:
        """Validate a repository configuration and return status"""
        result = {
            "name": monitor.name,
            "path": monitor.path,
            "enabled": monitor.enabled,
            "valid": True,
            "warnings": [],
            "errors": []
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
                capture_output=True,
                timeout=5
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            result["warnings"].append("GitHub CLI (gh) may not be authenticated")

        return result

    def perform_dry_run(self):
        """Validate configuration and display what would be launched"""
        from rich.table import Table
        from rich.panel import Panel

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
        import os
        if not os.access(self.script_path, os.X_OK):
            self.console.print(f"[yellow]⚠ {self.script_path} is not executable (run: chmod +x pr-loop.py)[/yellow]")

        self.console.print(f"[green]✓ Found pr-loop.py at {self.script_path}[/green]\n")

        # Create summary table
        table = Table(title="Repository Configuration", show_header=True, header_style="bold magenta")
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
                status
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
            border_style="cyan"
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

        print("\n" + "=" * 60 + "\n")

        # Track last status print time
        last_status_time = time.time()
        status_interval = 60  # Print status every 60 seconds

        try:
            while True:
                self.update()

                # Print periodic status updates
                current_time = time.time()
                if current_time - last_status_time >= status_interval:
                    uptime = datetime.now(timezone.utc) - self.start_time
                    uptime_str = str(uptime).split('.')[0]
                    print(f"[{datetime.now(timezone.utc).isoformat()}] Status update (uptime: {uptime_str})")

                    for monitor in self.monitors:
                        if monitor.enabled:
                            pr_info = f" - {monitor.current_pr}" if monitor.current_pr else ""
                            print(f"  {monitor.name}: {monitor.status}{pr_info}")
                            print(f"    Processed: {monitor.stats['prs_processed']} "
                                  f"(✓ {monitor.stats['successes']} ✗ {monitor.stats['failures']})")

                    print()
                    last_status_time = current_time

                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\n\nShutting down...")
            self.stop_all()
            print("✓ Dashboard stopped\n")

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
            with Live(self.generate_layout(), console=self.console, refresh_per_second=2) as live:
                while True:
                    self.update()
                    live.update(self.generate_layout())
                    time.sleep(0.5)
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

    if use_console:
        # Rich formatted output
        console.print("\n[bold cyan]Selection Criteria[/bold cyan]")
        console.print("[dim]" + "─" * 60 + "[/dim]")

        if has_issue_watching:
            console.print("\n[bold magenta]⚡ PRIMARY: Issues (processed first)[/bold magenta]")
            console.print("  [magenta]•[/magenta] [bold]for-impl[/bold] - Feature/fix implementation requests")
            console.print("  [dim]  → Creates branch, implements, creates PR, links to issue[/dim]")

        console.print("\n[bold green]✓ PRs will be processed if labeled:[/bold green]")
        console.print("  [green]•[/green] [bold]for-review[/bold] - Comprehensive review with code improvements")
        console.print("  [green]•[/green] [bold]for-landing[/bold] - Basic processing to merge (conflicts, reviews, CI)")
        console.print("\n[bold red]✗ PRs will be skipped if:[/bold red]")
        console.print("  [red]•[/red] Draft PRs ([dim]isDraft: true[/dim])")
        console.print("  [red]•[/red] WIP labels ([dim]wip, work-in-process, work in process[/dim])")
        console.print("  [red]•[/red] No processing label ([dim]missing for-review or for-landing[/dim])")
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
        console.print(f"You can create {config_path} manually or use config.example.yaml as a template.\n")
        return False

    console.print("\n[bold cyan]Interactive Configuration Setup[/bold cyan]")
    console.print("Let's configure repositories for PR automation.\n")

    repos = []

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
                console.print(f"  [yellow]⚠ Not a git repository (no .git directory)[/yellow]")
                if not Confirm.ask("  Use this path anyway?", default=False):
                    continue
            else:
                console.print(f"  [green]✓ Valid git repository[/green]")

            break

        # Get repository name
        default_name = Path(repo_path).name
        repo_name = Prompt.ask("  Repository name (display name)", default=default_name)

        # Ask if enabled
        enabled = Confirm.ask("  Enable this repository?", default=True)

        # Add to list
        repos.append({
            "path": repo_path,
            "name": repo_name,
            "enabled": enabled
        })

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
            repo["name"],
            repo["path"],
            enabled_display
        )

    console.print(table)
    console.print()

    # Confirm creation
    if not Confirm.ask(f"Save configuration to {config_path}?", default=True):
        console.print("\n[yellow]Configuration creation cancelled.[/yellow]\n")
        return False

    # Create config structure
    config = {
        "repos": repos
    }

    # Write config file
    try:
        # Ensure parent directory exists
        config_path.parent.mkdir(parents=True, exist_ok=True)

        with open(config_path, 'w') as f:
            # Write with nice formatting and comments
            f.write("# merge-god Configuration File\n")
            f.write("# Generated by interactive setup\n")
            f.write(f"# Created: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n")
            f.write("\n")
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)

        console.print(f"\n[green]✓ Configuration saved to {config_path}[/green]\n")

        # Offer to run dry-run validation
        if Confirm.ask("Validate configuration now (dry-run)?", default=True):
            console.print()
            return True  # Signal to run dry-run

        console.print("\n[cyan]Configuration complete! Run the dashboard:[/cyan]")
        console.print(f"  [bold]./dashboard.py[/bold]\n")

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
        """
    )

    parser.add_argument(
        "config",
        type=Path,
        nargs="?",
        default=Path("config.yaml"),
        help="Path to YAML config file (default: config.yaml)"
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration and show what would be launched without starting"
    )

    parser.add_argument(
        "--log-file",
        type=Path,
        default=Path("merge-god-dashboard.log"),
        help="Path to log file for all operations (default: merge-god-dashboard.log)"
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
    dashboard = Dashboard(args.config, script_path, dry_run=args.dry_run, log_writer=log_writer)

    if not dashboard.load_config():
        if log_writer:
            log_writer.close()
        sys.exit(1)

    if args.dry_run:
        # Run validation and display
        success = dashboard.run()
        sys.exit(0 if success else 1)

    console = Console()
    console.print(f"[green]✓ Loaded {len(dashboard.monitors)} repositories from {args.config}[/green]")

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
