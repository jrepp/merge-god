#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "PyGithub>=2.1.0",
#     "rich>=13.0.0",
#     "pyyaml>=6.0",
# ]
# ///

"""Test that all modules import correctly"""

import sys

def test_imports():
    """Test all module imports"""
    errors = []

    # Test models
    try:
        from models import Branch, PullRequest, BranchPRState, RepositoryState, CIStatus
        print("✓ models.py imports successfully")
    except Exception as e:
        errors.append(f"✗ models.py: {e}")

    # Test git_ops
    try:
        from git_ops import GitOperations
        print("✓ git_ops.py imports successfully")
    except Exception as e:
        errors.append(f"✗ git_ops.py: {e}")

    # Test github_ops
    try:
        from github_ops import GitHubOperations
        print("✓ github_ops.py imports successfully")
    except Exception as e:
        errors.append(f"✗ github_ops.py: {e}")

    # Test state_tracker
    try:
        from state_tracker import StateTracker
        print("✓ state_tracker.py imports successfully")
    except Exception as e:
        errors.append(f"✗ state_tracker.py: {e}")

    if errors:
        print("\n❌ Import errors:")
        for error in errors:
            print(f"  {error}")
        return 1

    print("\n✅ All modules import successfully!")
    return 0

if __name__ == "__main__":
    sys.exit(test_imports())
