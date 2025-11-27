#!/usr/bin/env python3
"""Update database with repository information from config.yaml"""

import sys
from pathlib import Path

import yaml

# Add project to path
sys.path.insert(0, str(Path(__file__).parent))

from merge_god.db_operations import StateDatabase  # noqa: E402


def main():
    """Load config and update database"""
    config_path = Path("config.yaml")
    db_path = Path("merge-god-state.db")

    if not config_path.exists():
        print(f"❌ Config file not found: {config_path}")
        return 1

    print(f"Loading config from: {config_path}")
    with open(config_path) as f:
        config = yaml.safe_load(f)

    if not config or "repos" not in config:
        print("❌ Invalid config: missing 'repos' section")
        return 1

    print(f"Updating database: {db_path}")
    db = StateDatabase(db_path)

    # Process each repository in config
    for repo_config in config["repos"]:
        if not repo_config.get("enabled", True):
            print(f"  Skipping disabled repo: {repo_config.get('name', 'unknown')}")
            continue

        repo_path = Path(repo_config["path"])
        repo_name = repo_config.get("name", repo_path.name)

        if not repo_path.exists():
            print(f"  ⚠️  Repository path not found: {repo_path}")
            continue

        # Get default branch (try main first, fallback to master)
        default_branch = "main"  # Could query git here if needed

        print(f"  Adding repository: {repo_name}")
        print(f"    Path: {repo_path}")
        print(f"    Default branch: {default_branch}")

        db.save_repository(name=repo_name, path=str(repo_path), default_branch=default_branch)

    print("\n✅ Database updated successfully!")

    # Show statistics
    stats = db.get_statistics()
    print("\nDatabase statistics:")
    print(f"  Repositories: {stats['repositories']}")
    print(f"  PR snapshots: {stats['pr_snapshots']}")
    print(f"  Processing records: {stats['processing_records']}")
    print(f"  Database size: {stats['database_size_bytes']} bytes")

    return 0


if __name__ == "__main__":
    sys.exit(main())
