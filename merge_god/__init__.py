"""
merge-god - Automated PR processing and merging system

This package provides tools for automating GitHub PR review and landing
using Claude AI agents with process isolation and telemetry.
"""

__version__ = "0.1.0"

from . import agents, db_operations, git_ops, github_ops, models, state_tracker

__all__ = [
    "__version__",
    "agents",
    "db_operations",
    "git_ops",
    "github_ops",
    "models",
    "state_tracker",
]
