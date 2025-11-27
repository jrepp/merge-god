"""
Export and import functionality for github_sync artifacts.

Supports exporting the database to portable formats that can be
shared, versioned, and imported into other systems.
"""

import gzip
import json
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from github_sync.models import PRContext
from github_sync.sync_store import SyncStore


class ArtifactFormat(Enum):
    """Supported artifact formats."""

    JSON = "json"
    JSON_GZ = "json.gz"
    JSONL = "jsonl"
    JSONL_GZ = "jsonl.gz"


# Artifact schema version for compatibility checking
ARTIFACT_SCHEMA_VERSION = "1.0"


async def export_database(
    db: SyncStore,
    output_path: Path | str,
    format: ArtifactFormat = ArtifactFormat.JSON_GZ,
    repo_filter: str | None = None,
    include_contexts: bool = True,
    pretty: bool = False,
) -> dict[str, Any]:
    """
    Export database contents to a portable artifact file.

    Args:
        db: Database to export from
        output_path: Path for output file
        format: Output format
        repo_filter: Optional repository name to filter by
        include_contexts: Whether to include full PR contexts
        pretty: Use pretty-printed JSON (larger files)

    Returns:
        Export metadata including counts and file size
    """
    await db.initialize()

    output_path = Path(output_path)

    # Gather all data
    export_data = await _gather_export_data(db, repo_filter, include_contexts)

    # Add metadata
    artifact = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "format": format.value,
        "repo_filter": repo_filter,
        "include_contexts": include_contexts,
        "counts": {
            "repositories": len(export_data["repositories"]),
            "pull_requests": len(export_data["pull_requests"]),
            "pr_contexts": len(export_data.get("pr_contexts", [])),
        },
        "data": export_data,
    }

    # Write to file
    json_opts = {"indent": 2} if pretty else {"separators": (",", ":")}

    if format == ArtifactFormat.JSON:
        with open(output_path, "w") as f:
            json.dump(artifact, f, **json_opts)

    elif format == ArtifactFormat.JSON_GZ:
        with gzip.open(output_path, "wt", encoding="utf-8") as f:
            json.dump(artifact, f, **json_opts)

    elif format == ArtifactFormat.JSONL:
        with open(output_path, "w") as f:
            # Write metadata line
            f.write(
                json.dumps(
                    {"type": "metadata", **{k: v for k, v in artifact.items() if k != "data"}}
                )
                + "\n"
            )
            # Write data lines
            f.writelines(
                json.dumps({"type": "repository", "data": repo}) + "\n"
                for repo in export_data["repositories"]
            )
            f.writelines(
                json.dumps({"type": "pull_request", "data": pr}) + "\n"
                for pr in export_data["pull_requests"]
            )
            f.writelines(
                json.dumps({"type": "pr_context", "data": ctx}) + "\n"
                for ctx in export_data.get("pr_contexts", [])
            )

    elif format == ArtifactFormat.JSONL_GZ:
        with gzip.open(output_path, "wt", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {"type": "metadata", **{k: v for k, v in artifact.items() if k != "data"}}
                )
                + "\n"
            )
            for repo in export_data["repositories"]:
                f.write(json.dumps({"type": "repository", "data": repo}) + "\n")
            for pr in export_data["pull_requests"]:
                f.write(json.dumps({"type": "pull_request", "data": pr}) + "\n")
            for ctx in export_data.get("pr_contexts", []):
                f.write(json.dumps({"type": "pr_context", "data": ctx}) + "\n")

    # Return metadata
    file_size = output_path.stat().st_size
    return {
        "path": str(output_path),
        "format": format.value,
        "file_size_bytes": file_size,
        "file_size_mb": round(file_size / (1024 * 1024), 2),
        **artifact["counts"],
    }


async def _gather_export_data(
    db: SyncStore,
    repo_filter: str | None,
    include_contexts: bool,
) -> dict[str, Any]:
    """Gather all data for export."""
    if repo_filter:
        repositories = []
        repo = await db.get_repository(repo_filter)
        if repo:
            repositories = [repo]
        pull_requests = await db.get_all_prs(repo_filter)
        pr_contexts = await db.get_all_pr_contexts(repo_filter) if include_contexts else []
    else:
        repositories = await db.get_all_repositories()
        pull_requests = await db.get_all_prs()
        pr_contexts = await db.get_all_pr_contexts() if include_contexts else []

    return {
        "repositories": repositories,
        "pull_requests": pull_requests,
        "pr_contexts": [ctx.to_dict() for ctx in pr_contexts],
    }


async def import_database(
    db: SyncStore,
    input_path: Path | str,
    merge_strategy: str = "replace",
) -> dict[str, Any]:
    """
    Import data from an artifact file into the database.

    Args:
        db: Database to import into
        input_path: Path to artifact file
        merge_strategy: How to handle existing data
            - "replace": Replace existing records
            - "skip": Skip if record exists
            - "merge": Merge/update existing records

    Returns:
        Import statistics
    """
    await db.initialize()

    input_path = Path(input_path)

    # Determine format from extension
    if input_path.suffix == ".gz":
        if ".json.gz" in str(input_path):
            format = ArtifactFormat.JSON_GZ
        else:
            format = ArtifactFormat.JSONL_GZ
    elif str(input_path).endswith(".jsonl"):
        format = ArtifactFormat.JSONL
    else:
        format = ArtifactFormat.JSON

    # Load data
    artifact = await _load_artifact(input_path, format)

    # Validate schema version
    schema_version = artifact.get("schema_version", "unknown")
    if not _is_compatible_version(schema_version):
        raise ValueError(
            f"Incompatible artifact schema version: {schema_version}. "
            f"Expected: {ARTIFACT_SCHEMA_VERSION}"
        )

    # Import data
    stats = {
        "repositories_imported": 0,
        "pull_requests_imported": 0,
        "pr_contexts_imported": 0,
        "skipped": 0,
        "errors": 0,
    }

    data = artifact.get("data", artifact)

    # Import repositories
    for repo in data.get("repositories", []):
        try:
            await db.save_repository(
                name=repo["name"],
                path=repo["path"],
                default_branch=repo.get("default_branch"),
            )
            stats["repositories_imported"] += 1
        except Exception:
            stats["errors"] += 1

    # Import pull requests
    for pr in data.get("pull_requests", []):
        try:
            # Normalize field names (handle both 'number' and 'pr_number')
            if "pr_number" in pr and "number" not in pr:
                pr["number"] = pr["pr_number"]
            await db.save_pr_snapshot(pr["repo_name"], pr)
            stats["pull_requests_imported"] += 1
        except Exception:
            stats["errors"] += 1

    # Import PR contexts
    for ctx_data in data.get("pr_contexts", []):
        try:
            ctx = PRContext.from_dict(ctx_data)
            await db.save_pr_context(ctx)
            stats["pr_contexts_imported"] += 1
        except Exception:
            stats["errors"] += 1

    return {
        "source": str(input_path),
        "schema_version": schema_version,
        **stats,
    }


async def _load_artifact(
    input_path: Path,
    format: ArtifactFormat,
) -> dict[str, Any]:
    """Load artifact data from file."""
    if format == ArtifactFormat.JSON:
        with open(input_path) as f:
            return json.load(f)

    elif format == ArtifactFormat.JSON_GZ:
        with gzip.open(input_path, "rt", encoding="utf-8") as f:
            return json.load(f)

    elif format in (ArtifactFormat.JSONL, ArtifactFormat.JSONL_GZ):
        # For JSONL, reconstruct the artifact structure
        data: dict[str, Any] = {
            "repositories": [],
            "pull_requests": [],
            "pr_contexts": [],
        }
        metadata: dict[str, Any] = {}

        opener = gzip.open if format == ArtifactFormat.JSONL_GZ else open
        with opener(input_path, "rt", encoding="utf-8") as f:  # type: ignore
            for line in f:
                line = line.strip()
                if not line:
                    continue

                record = json.loads(line)
                record_type = record.get("type")

                if record_type == "metadata":
                    metadata = record
                elif record_type == "repository":
                    data["repositories"].append(record["data"])
                elif record_type == "pull_request":
                    data["pull_requests"].append(record["data"])
                elif record_type == "pr_context":
                    data["pr_contexts"].append(record["data"])

        return {**metadata, "data": data}

    raise ValueError(f"Unknown format: {format}")


def _is_compatible_version(version: str) -> bool:
    """Check if artifact version is compatible."""
    try:
        artifact_major = int(version.split(".")[0])
        current_major = int(ARTIFACT_SCHEMA_VERSION.split(".")[0])
        return artifact_major == current_major
    except (ValueError, IndexError):
        return False


async def export_pr_context(
    db: SyncStore,
    repo_name: str,
    pr_number: int,
    output_path: Path | str,
) -> dict[str, Any]:
    """
    Export a single PR's context to a file.

    Useful for sharing specific PR data or debugging.

    Args:
        db: Database to export from
        repo_name: Repository name
        pr_number: PR number
        output_path: Output file path

    Returns:
        Export metadata
    """
    await db.initialize()

    output_path = Path(output_path)

    context = await db.get_latest_pr_context(repo_name, pr_number)
    if not context:
        raise ValueError(f"No context found for {repo_name}#{pr_number}")

    export_data = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "type": "pr_context",
        "repo_name": repo_name,
        "pr_number": pr_number,
        "data": context.to_dict(),
    }

    if str(output_path).endswith(".gz"):
        with gzip.open(output_path, "wt", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2)
    else:
        with open(output_path, "w") as f:
            json.dump(export_data, f, indent=2)

    file_size = output_path.stat().st_size
    return {
        "path": str(output_path),
        "repo_name": repo_name,
        "pr_number": pr_number,
        "diff_size": len(context.diff),
        "comment_count": len(context.comments),
        "file_size_bytes": file_size,
    }


async def list_artifact_contents(
    input_path: Path | str,
) -> dict[str, Any]:
    """
    List contents of an artifact file without fully loading it.

    Args:
        input_path: Path to artifact file

    Returns:
        Summary of artifact contents
    """
    input_path = Path(input_path)

    # Determine format
    if input_path.suffix == ".gz":
        if ".json.gz" in str(input_path):
            opener = lambda p: gzip.open(p, "rt", encoding="utf-8")
        else:
            opener = lambda p: gzip.open(p, "rt", encoding="utf-8")
    else:
        opener = lambda p: open(p)

    # For JSON, we need to load the whole thing
    if ".jsonl" not in str(input_path):
        with opener(input_path) as f:
            data = json.load(f)
            return {
                "format": "json",
                "schema_version": data.get("schema_version"),
                "exported_at": data.get("exported_at"),
                "counts": data.get("counts", {}),
                "file_size_bytes": input_path.stat().st_size,
            }

    # For JSONL, just read the metadata line
    with opener(input_path) as f:
        first_line = f.readline()
        metadata = json.loads(first_line)

        # Count records (map singular type names to plural for consistency)
        counts = {"repositories": 0, "pull_requests": 0, "pr_contexts": 0}
        type_map = {
            "repository": "repositories",
            "pull_request": "pull_requests",
            "pr_context": "pr_contexts",
        }
        for line in f:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            record_type = record.get("type")
            if record_type in type_map:
                counts[type_map[record_type]] += 1

        return {
            "format": "jsonl",
            "schema_version": metadata.get("schema_version"),
            "exported_at": metadata.get("exported_at"),
            "counts": counts,
            "file_size_bytes": input_path.stat().st_size,
        }
