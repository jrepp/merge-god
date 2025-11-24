#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "PyGithub>=2.1.0",
# ]
# ///

"""
Test script for the state tracking system.

This script tests the state tracker modules to ensure they work correctly.
"""

import sys
from pathlib import Path

from state_tracker import StateTracker, StateTrackerError


def test_state_tracker(repo_path: str):
    """Test the state tracker on a repository"""
    print(f"Testing state tracker on: {repo_path}\n")

    try:
        # Initialize tracker
        print("1. Initializing state tracker...")
        tracker = StateTracker(repo_path)
        print("   ✓ Tracker initialized\n")

        # Get repository info
        print("2. Getting repository info...")
        info = tracker.get_summary()
        print(f"   ✓ Repository: {info.get('path')}")
        print(f"   ✓ Default branch: {info.get('default_branch')}")
        print(f"   ✓ Current branch: {info.get('current_branch')}\n")

        # Build full state
        print("3. Building repository state (fetching from remote)...")
        state = tracker.build_repository_state(fetch_first=True)
        print("   ✓ State built successfully\n")

        # Show summary
        print("4. Repository State Summary:")
        summary = state.summary_dict()
        print(f"   Total branches: {summary['total_branches']}")
        print(f"   Branches with PRs: {summary['branches_with_prs']}")
        print(f"   Branches without PRs: {summary['branches_without_prs']}")
        print(f"   Branches needing sync: {summary['branches_needing_sync']}")
        print(f"   Failing CI: {summary['failing_ci']}")
        print(f"   Last updated: {summary['last_updated']}\n")

        # Show branches with PRs
        print("5. Branches with PRs:")
        branches_with_prs = state.get_branches_with_prs()
        if branches_with_prs:
            for branch_pr in branches_with_prs[:5]:  # Show first 5
                pr = branch_pr.pr
                ci_emoji = {
                    "success": "✓",
                    "failure": "✗",
                    "pending": "⏳",
                    "none": "○"
                }.get(branch_pr.ci_status.value, "?")

                print(f"   {ci_emoji} {branch_pr.branch_name}")
                if pr:
                    print(f"      PR #{pr.number}: {pr.title[:50]}")
                    print(f"      State: {pr.state.value}, CI: {branch_pr.ci_status.value}")
                    if pr.ci_summary:
                        print(f"      CI checks: {pr.ci_summary}")

            if len(branches_with_prs) > 5:
                print(f"   ... and {len(branches_with_prs) - 5} more")
        else:
            print("   No branches with PRs")
        print()

        # Show branches needing sync
        print("6. Branches needing sync:")
        needing_sync = state.get_branches_needing_sync()
        if needing_sync:
            for branch_pr in needing_sync[:5]:  # Show first 5
                status_icon = "↑" if branch_pr.needs_push else ""
                status_icon += "↓" if branch_pr.needs_pull else ""
                ahead = branch_pr.local_branch.ahead_by if branch_pr.local_branch else 0
                behind = branch_pr.local_branch.behind_by if branch_pr.local_branch else 0

                print(f"   {status_icon} {branch_pr.branch_name} "
                      f"(ahead: {ahead}, behind: {behind})")

            if len(needing_sync) > 5:
                print(f"   ... and {len(needing_sync) - 5} more")
        else:
            print("   All branches in sync")
        print()

        # Show failing CI
        print("7. Branches with failing CI:")
        failing = state.get_failing_ci()
        if failing:
            for branch_pr in failing[:5]:
                pr = branch_pr.pr
                print(f"   ✗ {branch_pr.branch_name}")
                if pr:
                    print(f"      PR #{pr.number}: {pr.title[:50]}")
                    if pr.ci_summary:
                        print(f"      Failed: {pr.ci_summary.get('failure', 0)} checks")

            if len(failing) > 5:
                print(f"   ... and {len(failing) - 5} more")
        else:
            print("   No failing CI")
        print()

        print("✓ All tests passed!")
        return 0

    except StateTrackerError as e:
        print(f"✗ State tracker error: {e}")
        return 1
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 1


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_state_tracker.py <repo_path>")
        print("\nExample:")
        print("  python test_state_tracker.py /path/to/repo")
        print("  python test_state_tracker.py .")
        sys.exit(1)

    repo_path = sys.argv[1]
    exit_code = test_state_tracker(repo_path)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
