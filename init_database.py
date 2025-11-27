#!/usr/bin/env python3
"""Simple script to initialize the merge-god database"""

import sys
from pathlib import Path

# Add project to path
sys.path.insert(0, str(Path(__file__).parent))

from merge_god.db_operations import StateDatabase  # noqa: E402


def main():
    """Initialize database with schema"""
    db_path = Path("merge-god-state.db")

    print(f"Creating database at: {db_path}")
    db = StateDatabase(db_path)
    print("✅ Database initialized successfully!")

    # Get statistics
    stats = db.get_statistics()
    print("\nDatabase statistics:")
    for key, value in stats.items():
        print(f"  {key}: {value}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
