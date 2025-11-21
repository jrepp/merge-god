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

Usage:
    ./dashboard.py [config_file]

Default config file: config.yaml
"""

import argparse
import json
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text


class RepoMonitor:
    """Monitors a single repository's PR processing"""

    def __init__(self, repo_config: dict[str, Any], script_path: Path):
        self.config = repo_config
        self.script_path = script_path
        self.name = repo_config.get("name", "Unknown")
        self.path = repo_config.get("path", "")
        self.enabled = repo_config.get("enabled", True)

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

    def start(self) -> bool:
        """Start pr-loop.py subprocess for this repo"""
        if not self.enabled:
            self.status = "disabled"
            return False

        if self.process and self.process.poll() is None:
            return True  # Already running

        try:
            self.process = subprocess.Popen(
                [str(self.script_path), self.path],
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

    def __init__(self, config_path: Path, script_path: Path):
        self.config_path = config_path
        self.script_path = script_path
        self.monitors: list[RepoMonitor] = []
        self.console = Console()
        self.start_time = datetime.now(timezone.utc)

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

                monitor = RepoMonitor(repo_config, self.script_path)
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

    def run(self):
        """Run the dashboard"""
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


def parse_args() -> argparse.Namespace:
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="TUI Dashboard for merge-god PR automation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  ./dashboard.py                    # Use config.yaml
  ./dashboard.py my-config.yaml     # Use custom config file

Config file format (YAML):
  repos:
    - path: /path/to/repo
      name: "Repo Name"
      enabled: true

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

    return parser.parse_args()


def main():
    """Main entry point"""
    args = parse_args()

    # Find pr-loop.py script
    script_path = Path(__file__).parent / "pr-loop.py"
    if not script_path.exists():
        print(f"Error: pr-loop.py not found at {script_path}", file=sys.stderr)
        sys.exit(1)

    # Create and run dashboard
    dashboard = Dashboard(args.config, script_path)

    if not dashboard.load_config():
        sys.exit(1)

    console = Console()
    console.print(f"[green]✓ Loaded {len(dashboard.monitors)} repositories from {args.config}[/green]")
    console.print("[cyan]Starting dashboard...[/cyan]\n")

    # Give user a moment to see startup message
    time.sleep(1)

    dashboard.start_all()
    dashboard.run()


if __name__ == "__main__":
    main()
