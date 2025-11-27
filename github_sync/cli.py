#!/usr/bin/env python3
"""
CLI tool for github_sync workspace operations.

Usage:
    python -m github_sync.cli init <workspace> <repo_url> [--name NAME]
    python -m github_sync.cli sync [--workspace PATH]
    python -m github_sync.cli triage [--workspace PATH]
    python -m github_sync.cli workon <pr_number> [--workspace PATH]
    python -m github_sync.cli show <pr_number> [--workspace PATH]
    python -m github_sync.cli worktrees [--workspace PATH]
"""

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

from github_sync import ProjectManager, SyncEngine, SyncStore
from github_sync.models import PRContext


async def find_workspace(start_path: Path | None = None) -> Path:
    """Find workspace by looking for sync.db in current or parent directories."""
    if start_path:
        if (start_path / "sync.db").exists():
            return start_path
        raise ValueError(f"No sync.db found in {start_path}")

    current = Path.cwd()
    while current != current.parent:
        if (current / "sync.db").exists():
            return current
        current = current.parent

    raise ValueError("No workspace found. Run 'init' first or specify --workspace")


async def get_repo_name(store: SyncStore) -> str:
    """Get the first (typically only) repository name."""
    repos = await store.get_all_repositories()
    if not repos:
        raise ValueError("No repositories synced. Run 'sync' first.")
    return repos[0]["name"]


async def cmd_init(args: argparse.Namespace) -> int:
    """Initialize a new workspace."""
    workspace = Path(args.workspace)
    workspace.mkdir(parents=True, exist_ok=True)

    # Determine repo name from URL if not provided
    repo_name = args.name
    if not repo_name:
        url = args.repo_url
        # Extract from git@github.com:org/repo.git or https://github.com/org/repo.git
        if "github.com" in url:
            repo_name = url.split("/")[-1].replace(".git", "")
        else:
            repo_name = "repo"

    print(f"Initializing workspace: {workspace}")
    print(f"Repository: {repo_name}")
    print(f"URL: {args.repo_url}")

    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    async with ProjectManager(workspace, store=store) as pm:
        project = await pm.ensure_project(repo_name, args.repo_url)
        print(f"Bare clone created: {project.bare_path}")

    print(f"\nWorkspace initialized at: {workspace}")
    print(f"Next: cd {workspace} && python -m github_sync.cli sync")
    return 0


async def cmd_sync(args: argparse.Namespace) -> int:
    """Sync PRs from GitHub."""
    workspace = await find_workspace(Path(args.workspace) if args.workspace else None)
    print(f"Workspace: {workspace}")

    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    async with ProjectManager(workspace, store=store) as pm:
        projects = await pm.list_projects()
        if not projects:
            print("No projects found. Run 'init' first.")
            return 1

        for project in projects:
            print(f"\nSyncing {project.name}...")
            await pm._fetch_project(project)

            engine = SyncEngine(store)
            result = await engine.sync_repository(
                project.bare_path,
                include_context=True,
                fetch_first=False,  # Already fetched
            )

            if result.success:
                print(f"  PRs synced: {result.prs_synced}")
                print(f"  Contexts synced: {result.contexts_synced}")
                print(f"  Duration: {result.duration_seconds:.1f}s")
            else:
                print(f"  Error: {result.error_message}")
                return 1

    return 0


async def cmd_triage(args: argparse.Namespace) -> int:
    """Show PRs needing attention."""
    workspace = await find_workspace(Path(args.workspace) if args.workspace else None)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    repo_name = await get_repo_name(store)
    prs = await store.get_active_prs(repo_name)
    contexts = {ctx.pr_number: ctx for ctx in await store.get_all_pr_contexts(repo_name)}

    print(f"=== {repo_name}: {len(prs)} active PRs ===\n")

    ci_failing = []
    changes_requested = []
    has_review_comments = []
    ready_to_land = []
    other = []

    for pr in prs:
        pr_num = pr["pr_number"]
        ctx = contexts.get(pr_num)
        labels = {l.lower() for l in pr.get("labels", [])}

        # Get review state from context
        review_state = ctx.ci_checks.get("review_state", {}) if ctx else {}

        entry = {
            "number": pr_num,
            "title": pr["title"],
            "branch": pr["head_branch"],
            "author": pr.get("author", "?"),
        }

        if pr.get("ci_status") == "failure":
            ci_failing.append(entry)
        elif review_state.get("changes_requested_by"):
            entry["requested_by"] = review_state["changes_requested_by"]
            changes_requested.append(entry)
        elif ctx and ctx.review_comments:
            entry["comment_count"] = len(ctx.review_comments)
            has_review_comments.append(entry)
        elif pr.get("ci_status") == "success" and "for-landing" in labels:
            entry["approved_by"] = review_state.get("approved_by", [])
            ready_to_land.append(entry)
        else:
            other.append(entry)

    if ci_failing:
        print("CI FAILING:")
        for pr in ci_failing:
            print(f"  #{pr['number']}: {pr['title']}")
            print(f"    Branch: {pr['branch']} | Author: {pr['author']}")
        print()

    if changes_requested:
        print("CHANGES REQUESTED:")
        for pr in changes_requested:
            print(f"  #{pr['number']}: {pr['title']}")
            print(f"    Branch: {pr['branch']} | By: {', '.join(pr['requested_by'])}")
        print()

    if has_review_comments:
        print("HAS REVIEW COMMENTS:")
        for pr in has_review_comments:
            print(f"  #{pr['number']}: {pr['title']} ({pr['comment_count']} comments)")
            print(f"    Branch: {pr['branch']}")
        print()

    if ready_to_land:
        print("READY TO LAND:")
        for pr in ready_to_land:
            approved = ", ".join(pr["approved_by"]) if pr["approved_by"] else "no approvals"
            print(f"  #{pr['number']}: {pr['title']}")
            print(f"    Approved by: {approved}")
        print()

    if other and args.all:
        print("OTHER:")
        for pr in other:
            print(f"  #{pr['number']}: {pr['title']}")
            print(f"    Branch: {pr['branch']}")
        print()

    # Show worktrees
    async with ProjectManager(workspace, store=store) as pm:
        leases = await pm.list_leases()
        if leases:
            print("ACTIVE WORKTREES:")
            for lease in leases:
                status = await pm.get_worktree_status(lease)
                changes = "has changes" if status.get("has_changes") else "clean"
                print(f"  {lease.branch}: {lease.path}")
                print(f"    Status: {changes} | Expires in: {lease.remaining_seconds:.0f}s")
            print()

    return 0


async def cmd_workon(args: argparse.Namespace) -> int:
    """Get a worktree for a PR's branch."""
    workspace = await find_workspace(Path(args.workspace) if args.workspace else None)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    repo_name = await get_repo_name(store)
    pr = await store.get_latest_pr_snapshot(repo_name, args.pr_number)

    if not pr:
        print(f"PR #{args.pr_number} not found. Run 'sync' first.")
        return 1

    branch = pr["head_branch"]

    async with ProjectManager(workspace, store=store) as pm:
        project = await pm.get_project(repo_name)
        if not project:
            print(f"Project {repo_name} not found.")
            return 1

        # Fetch latest
        await pm._fetch_project(project)

        # Acquire worktree
        lease = await pm.acquire_worktree(
            project_name=repo_name,
            branch=branch,
            worker_id=args.worker or "cli",
            metadata={"pr_number": args.pr_number},
        )

        print(f"PR #{args.pr_number}: {pr['title']}")
        print(f"Branch: {branch}")
        print(f"Author: {pr.get('author', '?')}")
        print(f"CI: {pr.get('ci_status', '?')}")
        print()
        print(f"Worktree ready at:")
        print(f"  cd {lease.path}")
        print()

        # Show review comments if any
        ctx = await store.get_latest_pr_context(repo_name, args.pr_number)
        if ctx:
            review_state = ctx.ci_checks.get("review_state", {})
            if review_state.get("changes_requested_by"):
                print(f"Changes requested by: {', '.join(review_state['changes_requested_by'])}")
            if review_state.get("approved_by"):
                print(f"Approved by: {', '.join(review_state['approved_by'])}")

            if ctx.review_comments:
                print(f"\nReview comments ({len(ctx.review_comments)}):")
                for rc in ctx.review_comments[:10]:
                    path = rc.get("path", "?")
                    line = rc.get("line", "?")
                    body = rc.get("body", "")[:100].replace("\n", " ")
                    print(f"  {path}:{line}: {body}")
                if len(ctx.review_comments) > 10:
                    print(f"  ... and {len(ctx.review_comments) - 10} more")

    return 0


async def cmd_show(args: argparse.Namespace) -> int:
    """Show details for a PR."""
    workspace = await find_workspace(Path(args.workspace) if args.workspace else None)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    repo_name = await get_repo_name(store)
    pr = await store.get_latest_pr_snapshot(repo_name, args.pr_number)

    if not pr:
        print(f"PR #{args.pr_number} not found. Run 'sync' first.")
        return 1

    ctx = await store.get_latest_pr_context(repo_name, args.pr_number)

    print(f"=== PR #{args.pr_number}: {pr['title']} ===\n")
    print(f"State: {pr.get('state', '?')}")
    print(f"Branch: {pr['head_branch']} -> {pr['base_branch']}")
    print(f"Author: {pr.get('author', '?')}")
    print(f"CI: {pr.get('ci_status', '?')}")
    print(f"Draft: {'Yes' if pr.get('draft') else 'No'}")
    print(f"Labels: {', '.join(pr.get('labels', [])) or 'none'}")
    print()

    if ctx:
        review_state = ctx.ci_checks.get("review_state", {})
        if review_state:
            print("Review State:")
            if review_state.get("approved_by"):
                print(f"  Approved by: {', '.join(review_state['approved_by'])}")
            if review_state.get("changes_requested_by"):
                print(f"  Changes requested by: {', '.join(review_state['changes_requested_by'])}")
            print(f"  Decision: {review_state.get('review_decision', 'pending')}")
            print()

        if ctx.comments:
            print(f"Discussion Comments ({len(ctx.comments)}):")
            for c in ctx.comments[-5:]:
                author = c.get("author", "?")
                body = c.get("body", "")[:100].replace("\n", " ")
                print(f"  @{author}: {body}")
            print()

        if ctx.review_comments:
            print(f"Review Comments ({len(ctx.review_comments)}):")
            for rc in ctx.review_comments:
                path = rc.get("path", "?")
                line = rc.get("line", "?")
                author = rc.get("author", "?")
                body = rc.get("body", "").replace("\n", " ")
                print(f"  {path}:{line} (@{author}):")
                print(f"    {body[:200]}")
            print()

        if args.diff:
            print("=== Diff ===")
            print(ctx.diff[:5000])
            if len(ctx.diff) > 5000:
                print(f"\n... truncated ({len(ctx.diff)} total chars)")

    return 0


async def cmd_worktrees(args: argparse.Namespace) -> int:
    """List active worktrees."""
    workspace = await find_workspace(Path(args.workspace) if args.workspace else None)
    store = SyncStore(workspace / "sync.db")
    await store.initialize()

    async with ProjectManager(workspace, store=store) as pm:
        leases = await pm.list_leases()

        if not leases:
            print("No active worktrees.")
            return 0

        print(f"Active Worktrees ({len(leases)}):\n")
        for lease in leases:
            status = await pm.get_worktree_status(lease)
            changes = "has changes" if status.get("has_changes") else "clean"
            pr_num = lease.metadata.get("pr_number", "?")
            print(f"  {lease.branch} (PR #{pr_num})")
            print(f"    Path: {lease.path}")
            print(f"    Status: {changes}")
            print(f"    Worker: {lease.worker_id}")
            print(f"    Expires in: {lease.remaining_seconds:.0f}s")
            print()

    return 0


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="github_sync workspace CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # init
    init_parser = subparsers.add_parser("init", help="Initialize a workspace")
    init_parser.add_argument("workspace", help="Workspace directory path")
    init_parser.add_argument("repo_url", help="Git repository URL")
    init_parser.add_argument("--name", help="Repository name (default: from URL)")

    # sync
    sync_parser = subparsers.add_parser("sync", help="Sync PRs from GitHub")
    sync_parser.add_argument("--workspace", "-w", help="Workspace directory")

    # triage
    triage_parser = subparsers.add_parser("triage", help="Show PRs needing attention")
    triage_parser.add_argument("--workspace", "-w", help="Workspace directory")
    triage_parser.add_argument("--all", "-a", action="store_true", help="Show all PRs")

    # workon
    workon_parser = subparsers.add_parser("workon", help="Get worktree for a PR")
    workon_parser.add_argument("pr_number", type=int, help="PR number")
    workon_parser.add_argument("--workspace", "-w", help="Workspace directory")
    workon_parser.add_argument("--worker", help="Worker ID (default: cli)")

    # show
    show_parser = subparsers.add_parser("show", help="Show PR details")
    show_parser.add_argument("pr_number", type=int, help="PR number")
    show_parser.add_argument("--workspace", "-w", help="Workspace directory")
    show_parser.add_argument("--diff", "-d", action="store_true", help="Show diff")

    # worktrees
    wt_parser = subparsers.add_parser("worktrees", help="List active worktrees")
    wt_parser.add_argument("--workspace", "-w", help="Workspace directory")

    args = parser.parse_args()

    commands = {
        "init": cmd_init,
        "sync": cmd_sync,
        "triage": cmd_triage,
        "workon": cmd_workon,
        "show": cmd_show,
        "worktrees": cmd_worktrees,
    }

    try:
        return asyncio.run(commands[args.command](args))
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
