#!/usr/bin/env python3
"""
Quick script to send approval to a waiting pr-loop.py process
"""

import json
import sys
from pathlib import Path

import psutil


def find_pr_loop_process():
    """Find the running pr-loop.py process"""
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmdline = proc.info.get("cmdline", [])
            if cmdline and "pr-loop.py" in " ".join(cmdline):
                return proc.info["pid"]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


def send_approval(pid):
    """Send approval JSON to process stdin"""
    try:
        # Open the stdin fd of the process
        stdin_path = f"/proc/{pid}/fd/0"
        approval = {"approved": True}

        # Try to write to stdin
        with Path(stdin_path).open("w") as stdin:
            stdin.write(json.dumps(approval) + "\n")
            stdin.flush()

        print(f"✓ Sent approval to pr-loop.py (PID {pid})")
        return True
    except Exception as e:
        print(f"✗ Failed to send approval: {e}", file=sys.stderr)
        return False


def main():
    print("Looking for pr-loop.py process...")
    pid = find_pr_loop_process()

    if not pid:
        print("✗ No pr-loop.py process found", file=sys.stderr)
        sys.exit(1)

    print(f"Found pr-loop.py process (PID {pid})")
    print("Sending approval...")

    if send_approval(pid):
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
