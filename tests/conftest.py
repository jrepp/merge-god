"""Shared pytest fixtures for merge-god tests."""

from pathlib import Path

import pytest


@pytest.fixture()
def repo_path() -> str:
    """Path to a real git repository for git/state integration smoke tests."""
    return str(Path(__file__).resolve().parent.parent)
