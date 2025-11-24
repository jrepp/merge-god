#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Test script for git operations module.

Tests git operations without requiring GitHub remote.
"""

import sys
from pathlib import Path

from git_ops import GitOperations, GitOperationsError


def test_git_ops(repo_path: str):
    """Test git operations on a repository"""
    print(f"Testing git operations on: {repo_path}\n")

    try:
        # Initialize
        print("1. Initializing git operations...")
        git_ops = GitOperations(Path(repo_path))
        print("   ✓ Git operations initialized\n")

        # Get repo info
        print("2. Getting repository info...")
        info = git_ops.get_repository_info()
        print(f"   Path: {info['path']}")
        print(f"   Default branch: {info['default_branch']}")
        print(f"   Current branch: {info['current_branch']}")
        if "remote_url" in info:
            print(f"   Remote URL: {info['remote_url']}")
        print()

        # Get local branches
        print("3. Getting local branches...")
        local_branches = git_ops.get_local_branches()
        print(f"   ✓ Found {len(local_branches)} local branches\n")

        # Show first few branches
        print("4. Local branches (first 5):")
        for branch in local_branches[:5]:
            print(f"   - {branch.name}")
            print(f"     SHA: {branch.sha[:8]}")
            print(f"     Upstream: {branch.upstream or 'none'}")
            print(
                f"     Last commit: {branch.last_commit_message[:50] if branch.last_commit_message else 'N/A'}"
            )

        if len(local_branches) > 5:
            print(f"   ... and {len(local_branches) - 5} more")
        print()

        # Try to get remote branches (may fail if no remote)
        print("5. Getting remote branches...")
        try:
            remote_branches = git_ops.get_remote_branches()
            print(f"   ✓ Found {len(remote_branches)} remote branches\n")

            if remote_branches:
                print("6. Remote branches (first 5):")
                for branch in remote_branches[:5]:
                    print(f"   - {branch.name}")
                    print(f"     SHA: {branch.sha[:8]}")

                if len(remote_branches) > 5:
                    print(f"   ... and {len(remote_branches) - 5} more")
        except GitOperationsError:
            print("   (No remote branches - no remote configured)")
        print()

        # Try to compute branch status
        print("7. Computing branch status...")
        try:
            local_branches, remote_branches = git_ops.get_all_branches_with_status()
            print("   ✓ Status computed for all branches\n")

            # Show branches that are ahead/behind
            print("8. Branch status summary:")
            for branch in local_branches:
                if branch.status.value not in ["up_to_date", "local_only"]:
                    print(
                        f"   {branch.name}: {branch.status.value} "
                        f"(ahead: {branch.ahead_by}, behind: {branch.behind_by})"
                    )
        except GitOperationsError as e:
            print(f"   (Could not compute status: {e})")
        print()

        print("✓ All git operations tests passed!")
        return 0

    except GitOperationsError as e:
        print(f"✗ Git operations error: {e}")
        return 1
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        import traceback

        traceback.print_exc()
        return 1


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_git_ops.py <repo_path>")
        print("\nExample:")
        print("  python test_git_ops.py /path/to/repo")
        print("  python test_git_ops.py .")
        sys.exit(1)

    repo_path = sys.argv[1]
    exit_code = test_git_ops(repo_path)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
