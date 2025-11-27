"""
Example usage of the github_sync library.

These examples show how to use the library in various contexts,
including standalone scripts and FastAPI background tasks.
"""

import asyncio
from pathlib import Path


# Standalone sync example
async def basic_sync_example():
    """Basic example of syncing a repository to a database."""
    from github_sync import SyncEngine, SyncStore

    # Create database
    db = SyncStore("my-sync.db")

    # Create sync engine
    engine = SyncEngine(db)

    # Sync a repository
    result = await engine.sync_repository(
        repo_path=Path(),  # Current directory
        labels=["for-landing", "for-review"],  # Filter by labels
        include_context=True,  # Include full PR context
    )

    print(f"Sync complete: {result.prs_synced} PRs, {result.branches_synced} branches")
    return result


# Streaming sync for progress updates
async def streaming_sync_example():
    """Example of streaming sync with progress updates."""
    from github_sync import SyncEngine, SyncProgress, SyncResult, SyncStore

    db = SyncStore("my-sync.db")
    engine = SyncEngine(db)

    async for update in engine.sync_repository_stream(repo_path=Path()):
        if isinstance(update, SyncProgress):
            print(f"[{update.stage}] {update.percent}% - {update.message}")
        elif isinstance(update, SyncResult):
            print(f"Done! Success: {update.success}")


# FastAPI background task example
async def fastapi_background_task_example():
    """
    Example of using github_sync in a FastAPI background task.

    This shows how to yield async futures for progress updates.
    """
    from github_sync import SyncEngine, SyncStore

    # In a real FastAPI app, this would be configured at startup
    db = SyncStore("app-sync.db")
    engine = SyncEngine(db)

    # The stream can be used with FastAPI's StreamingResponse
    # or with WebSocket connections for real-time updates
    async def sync_generator():
        async for update in engine.sync_repository_stream(
            repo_path=Path("/path/to/repo"),
            labels=["ready-to-merge"],
        ):
            # Yield JSON-serializable progress
            if hasattr(update, "to_dict"):
                yield update.to_dict()
            else:
                yield {
                    "stage": update.stage,
                    "current": update.current,
                    "total": update.total,
                    "message": update.message,
                    "percent": update.percent,
                }

    return sync_generator


# Export database to artifact
async def export_example():
    """Example of exporting database to portable artifact."""
    from github_sync import ArtifactFormat, SyncStore, export_database

    db = SyncStore("my-sync.db")

    # Export to compressed JSON
    result = await export_database(
        db,
        output_path="sync-artifact.json.gz",
        format=ArtifactFormat.JSON_GZ,
        include_contexts=True,
    )

    print(f"Exported to {result['path']} ({result['file_size_mb']} MB)")
    print(f"Contains {result['repositories']} repos, {result['pull_requests']} PRs")
    return result


# Import artifact into database
async def import_example():
    """Example of importing artifact into database."""
    from github_sync import SyncStore, import_database

    db = SyncStore("new-database.db")

    result = await import_database(
        db,
        input_path="sync-artifact.json.gz",
        merge_strategy="replace",
    )

    print(f"Imported {result['repositories_imported']} repos")
    print(f"Imported {result['pull_requests_imported']} PRs")
    return result


# Direct GitHub client usage
async def github_client_example():
    """Example of using the GitHub client directly."""
    from github_sync import GitHubClient

    # Create client from repo path (auto-detects owner/repo)
    client = await GitHubClient.from_repo_path(Path())

    async with client:
        # Fetch open PRs
        prs = await client.get_pull_requests(state="open")
        for pr in prs:
            print(f"PR #{pr.number}: {pr.title} ({pr.get_ci_status().value})")

        # Get specific PR with full context
        if prs:
            pr_num = prs[0].number
            diff = await client.get_pr_diff(pr_num)
            comments = await client.get_pr_comments(pr_num)
            print(f"PR #{pr_num} has {len(diff)} bytes diff, {len(comments)} comments")


# Direct Git client usage
async def git_client_example():
    """Example of using the Git client directly."""
    from github_sync import GitClient

    git = GitClient(Path())
    await git.validate_repo()

    # Get repository info
    info = await git.get_repository_info()
    print(f"Repo: {info.get('remote_url')}")
    print(f"Default branch: {info['default_branch']}")
    print(f"Current branch: {info['current_branch']}")

    # Get branches with status
    local, remote = await git.get_all_branches_with_status()
    print(f"Local branches: {len(local)}, Remote branches: {len(remote)}")

    for branch in local:
        print(f"  {branch.name}: {branch.status.value}")


# Query database directly
async def database_query_example():
    """Example of querying the database directly."""
    from github_sync import SyncStore

    db = SyncStore("my-sync.db")
    await db.initialize()

    # Get all repositories
    repos = await db.get_all_repositories()
    for repo in repos:
        print(f"Repo: {repo['name']} ({repo['path']})")

    # Get active PRs for a repo
    prs = await db.get_active_prs("my-repo")
    for pr in prs:
        print(f"  PR #{pr['pr_number']}: {pr['title']}")

    # Get PR context for offline processing
    context = await db.get_latest_pr_context("my-repo", 123)
    if context:
        print(f"Context for PR #123: {len(context.diff)} bytes diff")

    # Get statistics
    stats = await db.get_statistics()
    print(f"Database stats: {stats}")


# FastAPI integration example (pseudo-code showing pattern)
FASTAPI_EXAMPLE = '''
from fastapi import FastAPI, BackgroundTasks
from fastapi.responses import StreamingResponse
from github_sync import SyncStore, SyncEngine
import json

app = FastAPI()
db = SyncStore("app.db")
engine = SyncEngine(db)

@app.post("/sync/{repo_path:path}")
async def start_sync(repo_path: str, background_tasks: BackgroundTasks):
    """Start a sync operation in the background."""
    # For simple background sync without streaming
    async def do_sync():
        result = await engine.sync_repository(repo_path)
        # Store result, notify via WebSocket, etc.

    background_tasks.add_task(do_sync)
    return {"status": "started"}

@app.get("/sync-stream/{repo_path:path}")
async def sync_with_progress(repo_path: str):
    """Stream sync progress using Server-Sent Events."""
    async def generate():
        async for update in engine.sync_repository_stream(repo_path):
            if hasattr(update, "to_dict"):
                data = update.to_dict()
            else:
                data = {
                    "stage": update.stage,
                    "current": update.current,
                    "total": update.total,
                    "message": update.message,
                }
            yield f"data: {json.dumps(data)}\\n\\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream"
    )

@app.get("/contexts/{repo_name}/{pr_number}")
async def get_pr_context(repo_name: str, pr_number: int):
    """Get cached PR context for offline processing."""
    context = await db.get_latest_pr_context(repo_name, pr_number)
    if context:
        return context.to_dict()
    return {"error": "Not found"}, 404
'''


if __name__ == "__main__":
    # Run the basic example
    asyncio.run(basic_sync_example())
