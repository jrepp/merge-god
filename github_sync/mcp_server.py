"""
MCP (Model Context Protocol) Server for github_sync.

This module provides an STDIO-based MCP server that exposes github_sync
functionality as tools for LLM tool calling.

Usage:
    # Start the server
    python -m github_sync.mcp_server --workspace /path/to/workspace

    # Or use as a module
    from github_sync.mcp_server import MCPServer
    server = MCPServer(workspace_path="/path/to/workspace")
    await server.run()

Configuration (claude_desktop_config.json):
    {
        "mcpServers": {
            "github-sync": {
                "command": "python",
                "args": ["-m", "github_sync.mcp_server", "--workspace", "/path/to/workspace"]
            }
        }
    }
"""

import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from github_sync.project_manager import ProjectManager
from github_sync.sync_store import SyncStore
from github_sync.workflow import Workflow, WorkflowManager, WorkflowStep

# Configure logging to stderr (stdout is for MCP protocol)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("mcp_server")


# =============================================================================
# MCP Protocol Types
# =============================================================================

@dataclass
class MCPError:
    code: int
    message: str
    data: Any = None

    # Standard JSON-RPC error codes
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603


@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: dict = field(default_factory=dict)


# =============================================================================
# Tool Implementations
# =============================================================================

class GitTools:
    """Git operation tools."""

    def __init__(self, working_dir: Path):
        self.working_dir = working_dir

    async def _run_git(self, *args, cwd: Path | None = None) -> tuple[int, str, str]:
        """Run a git command and return (returncode, stdout, stderr)."""
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=cwd or self.working_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        return proc.returncode, stdout.decode(), stderr.decode()

    async def status(self, path: str | None = None) -> dict:
        """Get git status."""
        cwd = Path(path) if path else self.working_dir
        code, stdout, stderr = await self._run_git("status", "--porcelain=v1", cwd=cwd)

        if code != 0:
            return {"error": stderr or "Git status failed"}

        # Parse porcelain output
        files = {"staged": [], "unstaged": [], "untracked": [], "conflicts": []}
        for line in stdout.strip().split("\n"):
            if not line:
                continue
            status = line[:2]
            filename = line[3:]

            if status == "??":
                files["untracked"].append(filename)
            elif status in ("UU", "AA", "DD"):
                files["conflicts"].append(filename)
            elif status[0] != " ":
                files["staged"].append(filename)
            elif status[1] != " ":
                files["unstaged"].append(filename)

        # Get branch info
        code, branch_out, _ = await self._run_git("branch", "--show-current", cwd=cwd)
        branch = branch_out.strip() if code == 0 else "unknown"

        return {
            "branch": branch,
            "clean": not any(files.values()),
            "files": files,
            "has_conflicts": len(files["conflicts"]) > 0,
        }

    async def diff(self, path: str | None = None, staged: bool = False, file: str | None = None) -> dict:
        """Get git diff."""
        cwd = Path(path) if path else self.working_dir
        args = ["diff"]
        if staged:
            args.append("--staged")
        if file:
            args.extend(["--", file])

        code, stdout, stderr = await self._run_git(*args, cwd=cwd)

        if code != 0:
            return {"error": stderr or "Git diff failed"}

        return {"diff": stdout, "size": len(stdout)}

    async def fetch(self, remote: str = "origin", path: str | None = None) -> dict:
        """Fetch from remote."""
        cwd = Path(path) if path else self.working_dir
        code, stdout, stderr = await self._run_git("fetch", remote, cwd=cwd)

        if code != 0:
            return {"error": stderr or "Git fetch failed"}

        return {"success": True, "output": stdout or stderr or "Fetch complete"}

    async def merge(self, branch: str, path: str | None = None, no_commit: bool = False) -> dict:
        """Merge a branch."""
        cwd = Path(path) if path else self.working_dir
        args = ["merge", branch]
        if no_commit:
            args.append("--no-commit")

        code, stdout, stderr = await self._run_git(*args, cwd=cwd)
        output = stdout + stderr

        if code != 0:
            # Check for conflicts
            if "CONFLICT" in output or "Automatic merge failed" in output:
                status = await self.status(path)
                return {
                    "success": False,
                    "has_conflicts": True,
                    "conflict_files": status.get("files", {}).get("conflicts", []),
                    "output": output,
                }
            return {"success": False, "error": output}

        return {"success": True, "output": output}

    async def rebase(self, onto: str, path: str | None = None) -> dict:
        """Rebase onto a branch."""
        cwd = Path(path) if path else self.working_dir
        code, stdout, stderr = await self._run_git("rebase", onto, cwd=cwd)
        output = stdout + stderr

        if code != 0:
            if "CONFLICT" in output:
                return {
                    "success": False,
                    "has_conflicts": True,
                    "output": output,
                }
            return {"success": False, "error": output}

        return {"success": True, "output": output}

    async def add(self, files: list[str] | str = ".", path: str | None = None) -> dict:
        """Stage files."""
        cwd = Path(path) if path else self.working_dir
        if isinstance(files, str):
            files = [files]

        code, stdout, stderr = await self._run_git("add", *files, cwd=cwd)

        if code != 0:
            return {"error": stderr or "Git add failed"}

        return {"success": True, "files": files}

    async def commit(self, message: str, path: str | None = None) -> dict:
        """Create a commit."""
        cwd = Path(path) if path else self.working_dir
        code, stdout, stderr = await self._run_git("commit", "-m", message, cwd=cwd)

        if code != 0:
            return {"error": stderr or stdout or "Git commit failed"}

        # Get commit hash
        code, hash_out, _ = await self._run_git("rev-parse", "HEAD", cwd=cwd)
        commit_hash = hash_out.strip() if code == 0 else "unknown"

        return {"success": True, "commit": commit_hash, "output": stdout}

    async def push(self, remote: str = "origin", branch: str | None = None,
                   force: bool = False, path: str | None = None) -> dict:
        """Push to remote."""
        cwd = Path(path) if path else self.working_dir
        args = ["push", remote]
        if branch:
            args.append(branch)
        if force:
            args.append("--force-with-lease")

        code, stdout, stderr = await self._run_git(*args, cwd=cwd)

        if code != 0:
            return {"error": stderr or stdout or "Git push failed"}

        return {"success": True, "output": stdout or stderr or "Push complete"}

    async def log(self, count: int = 10, path: str | None = None) -> dict:
        """Get recent commits."""
        cwd = Path(path) if path else self.working_dir
        code, stdout, stderr = await self._run_git(
            "log", f"-{count}", "--format=%H|%s|%an|%ae|%ai", cwd=cwd
        )

        if code != 0:
            return {"error": stderr or "Git log failed"}

        commits = []
        for line in stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("|", 4)
            if len(parts) >= 5:
                commits.append({
                    "hash": parts[0],
                    "subject": parts[1],
                    "author": parts[2],
                    "email": parts[3],
                    "date": parts[4],
                })

        return {"commits": commits}

    async def checkout(self, ref: str, path: str | None = None, create: bool = False) -> dict:
        """Checkout a branch or commit."""
        cwd = Path(path) if path else self.working_dir
        args = ["checkout"]
        if create:
            args.append("-b")
        args.append(ref)

        code, stdout, stderr = await self._run_git(*args, cwd=cwd)

        if code != 0:
            return {"error": stderr or stdout or "Git checkout failed"}

        return {"success": True, "ref": ref, "output": stdout or stderr}


class FileTools:
    """File system tools."""

    def __init__(self, working_dir: Path):
        self.working_dir = working_dir

    def _resolve_path(self, path: str) -> Path:
        """Resolve a path relative to working directory."""
        p = Path(path)
        if not p.is_absolute():
            p = self.working_dir / p
        return p.resolve()

    async def read_file(self, path: str, encoding: str = "utf-8") -> dict:
        """Read a file."""
        try:
            file_path = self._resolve_path(path)
            content = file_path.read_text(encoding=encoding)
            return {
                "content": content,
                "path": str(file_path),
                "size": len(content),
            }
        except FileNotFoundError:
            return {"error": f"File not found: {path}"}
        except Exception as e:
            return {"error": f"Error reading file: {e}"}

    async def write_file(self, path: str, content: str, encoding: str = "utf-8") -> dict:
        """Write a file."""
        try:
            file_path = self._resolve_path(path)
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding=encoding)
            return {
                "success": True,
                "path": str(file_path),
                "size": len(content),
            }
        except Exception as e:
            return {"error": f"Error writing file: {e}"}

    async def list_directory(self, path: str = ".", pattern: str = "*") -> dict:
        """List directory contents."""
        try:
            dir_path = self._resolve_path(path)
            if not dir_path.is_dir():
                return {"error": f"Not a directory: {path}"}

            entries = []
            for entry in dir_path.glob(pattern):
                entries.append({
                    "name": entry.name,
                    "path": str(entry.relative_to(self.working_dir)),
                    "is_dir": entry.is_dir(),
                    "size": entry.stat().st_size if entry.is_file() else None,
                })

            return {"entries": sorted(entries, key=lambda e: (not e["is_dir"], e["name"]))}
        except Exception as e:
            return {"error": f"Error listing directory: {e}"}

    async def file_exists(self, path: str) -> dict:
        """Check if a file exists."""
        file_path = self._resolve_path(path)
        return {
            "exists": file_path.exists(),
            "is_file": file_path.is_file(),
            "is_dir": file_path.is_dir(),
        }


class WorkflowTools:
    """Workflow management tools."""

    def __init__(self, store: SyncStore):
        self.store = store
        self.wm = WorkflowManager(store)
        self._current_workflow: Workflow | None = None
        self._current_step: WorkflowStep | None = None

    async def workflow_start(
        self,
        workflow_type: str,
        repo_name: str,
        branch_name: str | None = None,
        pr_number: int | None = None,
        context: dict | None = None,
    ) -> dict:
        """Start a new workflow."""
        workflow_id = await self.store.create_workflow(
            workflow_type=workflow_type,
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            context=context,
        )
        await self.store.start_workflow(workflow_id)

        # Create workflow object for tracking
        self._current_workflow = Workflow(
            store=self.store,
            workflow_id=workflow_id,
            workflow_type=workflow_type,
            repo_name=repo_name,
            branch_name=branch_name,
            pr_number=pr_number,
            _context=context or {},
        )

        return {
            "workflow_id": workflow_id,
            "type": workflow_type,
            "repo": repo_name,
            "branch": branch_name,
            "status": "running",
        }

    async def workflow_step_start(
        self,
        step_name: str,
        input_data: dict | None = None,
    ) -> dict:
        """Start a new step in the current workflow."""
        if not self._current_workflow:
            return {"error": "No active workflow. Call workflow_start first."}

        wf = self._current_workflow
        wf._step_order += 1

        step_id = await self.store.add_workflow_step(
            wf.workflow_id,
            step_name,
            wf._step_order,
            input_data,
        )
        await self.store.update_workflow_step(wf.workflow_id, step_name)
        await self.store.start_workflow_step(step_id)

        self._current_step = WorkflowStep(
            store=self.store,
            workflow_id=wf.workflow_id,
            step_id=step_id,
            step_name=step_name,
            _input_data=input_data or {},
        )

        return {
            "step_id": step_id,
            "step_name": step_name,
            "step_order": wf._step_order,
            "workflow_id": wf.workflow_id,
        }

    async def workflow_step_complete(
        self,
        summary: str = "",
        output_data: dict | None = None,
    ) -> dict:
        """Complete the current step."""
        if not self._current_step:
            return {"error": "No active step. Call workflow_step_start first."}

        step = self._current_step
        if output_data:
            step._output_data.update(output_data)
        if summary:
            step._output_data["summary"] = summary

        duration = await self.store.complete_workflow_step(
            step.step_id,
            success=True,
            output_data=step._output_data,
        )

        result = {
            "success": True,
            "step_name": step.step_name,
            "duration_ms": duration,
            "tool_calls": step.tool_calls,
        }

        self._current_step = None
        return result

    async def workflow_step_fail(
        self,
        error_type: str,
        error_message: str,
    ) -> dict:
        """Fail the current step."""
        if not self._current_step:
            return {"error": "No active step."}

        step = self._current_step
        duration = await self.store.complete_workflow_step(
            step.step_id,
            success=False,
            error_type=error_type,
            error_message=error_message,
        )

        # Also fail the workflow
        if self._current_workflow:
            self._current_workflow._success = False
            self._current_workflow._error_type = error_type
            self._current_workflow._error_message = error_message

        result = {
            "success": False,
            "step_name": step.step_name,
            "duration_ms": duration,
            "error_type": error_type,
            "error_message": error_message,
        }

        self._current_step = None
        return result

    async def workflow_record_tool_call(self) -> dict:
        """Record a tool call in the current step."""
        if not self._current_step:
            return {"error": "No active step."}

        count = await self._current_step.record_tool_call()
        return {"tool_calls": count}

    async def workflow_step_output(self, data: dict) -> dict:
        """Add output data to the current step."""
        if not self._current_step:
            return {"error": "No active step."}

        self._current_step.set_output(data)
        return {"success": True, "data": data}

    async def workflow_complete(
        self,
        result: str | None = None,
    ) -> dict:
        """Complete the current workflow."""
        if not self._current_workflow:
            return {"error": "No active workflow."}

        wf = self._current_workflow

        if wf._context:
            await self.store.update_workflow_context(wf.workflow_id, wf._context)

        duration = await self.store.complete_workflow(
            wf.workflow_id,
            success=wf._success,
            result=result,
            error_type=wf._error_type,
            error_message=wf._error_message,
        )

        result_dict = {
            "workflow_id": wf.workflow_id,
            "success": wf._success,
            "duration_ms": duration,
            "result": result,
        }

        if not wf._success:
            result_dict["error_type"] = wf._error_type
            result_dict["error_message"] = wf._error_message

        self._current_workflow = None
        self._current_step = None
        return result_dict

    async def workflow_pause(self, reason: str) -> dict:
        """Pause the current workflow for human input."""
        if not self._current_workflow:
            return {"error": "No active workflow."}

        wf = self._current_workflow
        wf.update_context({"pause_reason": reason})
        await self.store.update_workflow_context(wf.workflow_id, wf._context)
        await self.store.pause_workflow(wf.workflow_id, reason)

        return {
            "workflow_id": wf.workflow_id,
            "status": "paused",
            "reason": reason,
        }

    async def workflow_status(self) -> dict:
        """Get current workflow and step status."""
        if not self._current_workflow:
            return {"active": False}

        wf = self._current_workflow
        result = {
            "active": True,
            "workflow_id": wf.workflow_id,
            "type": wf.workflow_type,
            "repo": wf.repo_name,
            "branch": wf.branch_name,
            "steps_completed": wf._step_order - (1 if self._current_step else 0),
            "context": wf._context,
        }

        if self._current_step:
            result["current_step"] = {
                "name": self._current_step.step_name,
                "tool_calls": self._current_step.tool_calls,
            }

        return result

    async def workflow_get(self, workflow_id: int) -> dict:
        """Get a workflow by ID."""
        workflow = await self.wm.get_workflow(workflow_id)
        if not workflow:
            return {"error": f"Workflow {workflow_id} not found"}
        return workflow

    async def workflow_list_active(
        self,
        repo_name: str | None = None,
        workflow_type: str | None = None,
    ) -> dict:
        """List active workflows."""
        workflows = await self.wm.get_active_workflows(repo_name, workflow_type)
        return {"workflows": workflows}

    async def workflow_stats(
        self,
        repo_name: str | None = None,
        workflow_type: str | None = None,
    ) -> dict:
        """Get workflow statistics."""
        return await self.wm.get_stats(repo_name, workflow_type)


class SyncTools:
    """PR and sync store tools."""

    def __init__(self, store: SyncStore):
        self.store = store

    async def get_active_prs(self, repo_name: str) -> dict:
        """Get active PRs for a repository."""
        prs = await self.store.get_active_prs(repo_name)
        return {"prs": prs}

    async def get_pr_snapshot(self, repo_name: str, pr_number: int) -> dict:
        """Get the latest snapshot of a PR."""
        snapshot = await self.store.get_latest_pr_snapshot(repo_name, pr_number)
        if not snapshot:
            return {"error": f"PR #{pr_number} not found"}
        return snapshot

    async def get_pr_context(self, repo_name: str, pr_number: int) -> dict:
        """Get full PR context (diff, comments, etc.)."""
        context = await self.store.get_latest_pr_context(repo_name, pr_number)
        if not context:
            return {"error": f"PR context for #{pr_number} not found"}
        return context.to_dict()

    async def get_statistics(self) -> dict:
        """Get database statistics."""
        return await self.store.get_statistics()

    async def get_memo(self, repo_name: str, pr_number: int, memo_type: str) -> dict:
        """Get a PR memo."""
        content = await self.store.get_memo(repo_name, pr_number, memo_type)
        if content is None:
            return {"exists": False}
        return {"exists": True, "content": content}

    async def set_memo(self, repo_name: str, pr_number: int, memo_type: str, content: str) -> dict:
        """Set a PR memo."""
        await self.store.set_memo(repo_name, pr_number, memo_type, content)
        return {"success": True}


# =============================================================================
# MCP Server
# =============================================================================

class MCPServer:
    """MCP server exposing github_sync tools."""

    SERVER_NAME = "github-sync"
    SERVER_VERSION = "0.1.0"
    PROTOCOL_VERSION = "2024-11-05"

    def __init__(self, workspace_path: str | Path):
        self.workspace = Path(workspace_path).resolve()
        self.store: SyncStore | None = None
        self.git_tools: GitTools | None = None
        self.file_tools: FileTools | None = None
        self.workflow_tools: WorkflowTools | None = None
        self.sync_tools: SyncTools | None = None
        self._initialized = False

    async def initialize(self):
        """Initialize the server and all tools."""
        if self._initialized:
            return

        # Ensure workspace directory exists
        if not self.workspace.exists():
            self.workspace.mkdir(parents=True, exist_ok=True)
            logger.info(f"Created workspace directory: {self.workspace}")

        # Initialize database (creates if not exists)
        db_path = self.workspace / "sync.db"
        db_existed = db_path.exists()

        self.store = SyncStore(db_path)
        await self.store.initialize()

        if db_existed:
            stats = await self.store.get_statistics()
            logger.info(
                f"Loaded existing database: {db_path} "
                f"(schema v{stats.get('schema_version', '?')}, "
                f"{stats.get('pr_snapshots', 0)} PR snapshots)"
            )
        else:
            logger.info(f"Created new database: {db_path}")

        # Initialize tools
        self.git_tools = GitTools(self.workspace)
        self.file_tools = FileTools(self.workspace)
        self.workflow_tools = WorkflowTools(self.store)
        self.sync_tools = SyncTools(self.store)

        self._initialized = True
        logger.info(f"MCP server initialized with workspace: {self.workspace}")

    def _get_tool_definitions(self) -> list[dict]:
        """Get all tool definitions."""
        return [
            # Git tools
            {
                "name": "git_status",
                "description": "Get git repository status including branch, staged/unstaged files, and conflicts",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    }
                }
            },
            {
                "name": "git_diff",
                "description": "Get git diff of changes",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Repository path (optional)"},
                        "staged": {"type": "boolean", "description": "Show staged changes only"},
                        "file": {"type": "string", "description": "Specific file to diff"}
                    }
                }
            },
            {
                "name": "git_fetch",
                "description": "Fetch changes from remote",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "remote": {"type": "string", "description": "Remote name", "default": "origin"},
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    }
                }
            },
            {
                "name": "git_merge",
                "description": "Merge a branch into the current branch",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "branch": {"type": "string", "description": "Branch to merge"},
                        "path": {"type": "string", "description": "Repository path (optional)"},
                        "no_commit": {"type": "boolean", "description": "Don't auto-commit merge"}
                    },
                    "required": ["branch"]
                }
            },
            {
                "name": "git_rebase",
                "description": "Rebase current branch onto another branch",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "onto": {"type": "string", "description": "Branch to rebase onto"},
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    },
                    "required": ["onto"]
                }
            },
            {
                "name": "git_add",
                "description": "Stage files for commit",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "files": {
                            "oneOf": [
                                {"type": "string"},
                                {"type": "array", "items": {"type": "string"}}
                            ],
                            "description": "Files to stage (default: '.')"
                        },
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    }
                }
            },
            {
                "name": "git_commit",
                "description": "Create a commit with staged changes",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "message": {"type": "string", "description": "Commit message"},
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    },
                    "required": ["message"]
                }
            },
            {
                "name": "git_push",
                "description": "Push changes to remote",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "remote": {"type": "string", "description": "Remote name", "default": "origin"},
                        "branch": {"type": "string", "description": "Branch to push"},
                        "force": {"type": "boolean", "description": "Force push (with lease)"},
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    }
                }
            },
            {
                "name": "git_log",
                "description": "Get recent commit history",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "count": {"type": "integer", "description": "Number of commits", "default": 10},
                        "path": {"type": "string", "description": "Repository path (optional)"}
                    }
                }
            },
            {
                "name": "git_checkout",
                "description": "Checkout a branch or commit",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "Branch or commit to checkout"},
                        "path": {"type": "string", "description": "Repository path (optional)"},
                        "create": {"type": "boolean", "description": "Create new branch"}
                    },
                    "required": ["ref"]
                }
            },
            # File tools
            {
                "name": "read_file",
                "description": "Read contents of a file",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "File path"},
                        "encoding": {"type": "string", "description": "File encoding", "default": "utf-8"}
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "write_file",
                "description": "Write contents to a file",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "File path"},
                        "content": {"type": "string", "description": "Content to write"},
                        "encoding": {"type": "string", "description": "File encoding", "default": "utf-8"}
                    },
                    "required": ["path", "content"]
                }
            },
            {
                "name": "list_directory",
                "description": "List contents of a directory",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Directory path", "default": "."},
                        "pattern": {"type": "string", "description": "Glob pattern", "default": "*"}
                    }
                }
            },
            {
                "name": "file_exists",
                "description": "Check if a file or directory exists",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to check"}
                    },
                    "required": ["path"]
                }
            },
            # Workflow tools
            {
                "name": "workflow_start",
                "description": "Start a new workflow (merge, rebase, pr_review, ci_fix)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "workflow_type": {
                            "type": "string",
                            "enum": ["merge", "rebase", "pr_review", "ci_fix", "custom"],
                            "description": "Type of workflow"
                        },
                        "repo_name": {"type": "string", "description": "Repository name"},
                        "branch_name": {"type": "string", "description": "Branch name"},
                        "pr_number": {"type": "integer", "description": "PR number (if applicable)"},
                        "context": {"type": "object", "description": "Initial context data"}
                    },
                    "required": ["workflow_type", "repo_name"]
                }
            },
            {
                "name": "workflow_step_start",
                "description": "Start a new step in the current workflow",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "step_name": {"type": "string", "description": "Name of the step"},
                        "input_data": {"type": "object", "description": "Input data for the step"}
                    },
                    "required": ["step_name"]
                }
            },
            {
                "name": "workflow_step_complete",
                "description": "Complete the current step successfully",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string", "description": "Summary of what was done"},
                        "output_data": {"type": "object", "description": "Output data from the step"}
                    }
                }
            },
            {
                "name": "workflow_step_fail",
                "description": "Fail the current step with an error",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "error_type": {"type": "string", "description": "Error type/category"},
                        "error_message": {"type": "string", "description": "Detailed error message"}
                    },
                    "required": ["error_type", "error_message"]
                }
            },
            {
                "name": "workflow_step_output",
                "description": "Add output data to the current step",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "data": {"type": "object", "description": "Data to add to step output"}
                    },
                    "required": ["data"]
                }
            },
            {
                "name": "workflow_complete",
                "description": "Complete the current workflow",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "result": {"type": "string", "description": "Result message"}
                    }
                }
            },
            {
                "name": "workflow_pause",
                "description": "Pause the workflow for human review",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string", "description": "Why human input is needed"}
                    },
                    "required": ["reason"]
                }
            },
            {
                "name": "workflow_status",
                "description": "Get current workflow and step status",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "workflow_get",
                "description": "Get a workflow by ID",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "workflow_id": {"type": "integer", "description": "Workflow ID"}
                    },
                    "required": ["workflow_id"]
                }
            },
            {
                "name": "workflow_list_active",
                "description": "List active workflows",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Filter by repository"},
                        "workflow_type": {"type": "string", "description": "Filter by type"}
                    }
                }
            },
            {
                "name": "workflow_stats",
                "description": "Get workflow statistics",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Filter by repository"},
                        "workflow_type": {"type": "string", "description": "Filter by type"}
                    }
                }
            },
            # Sync/PR tools
            {
                "name": "get_active_prs",
                "description": "Get active PRs for a repository",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Repository name"}
                    },
                    "required": ["repo_name"]
                }
            },
            {
                "name": "get_pr_snapshot",
                "description": "Get the latest snapshot of a PR",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Repository name"},
                        "pr_number": {"type": "integer", "description": "PR number"}
                    },
                    "required": ["repo_name", "pr_number"]
                }
            },
            {
                "name": "get_pr_context",
                "description": "Get full PR context (diff, comments, reviews)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Repository name"},
                        "pr_number": {"type": "integer", "description": "PR number"}
                    },
                    "required": ["repo_name", "pr_number"]
                }
            },
            {
                "name": "get_statistics",
                "description": "Get database statistics",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "get_memo",
                "description": "Get a PR memo (bot's notes)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Repository name"},
                        "pr_number": {"type": "integer", "description": "PR number"},
                        "memo_type": {"type": "string", "description": "Memo type (todo, plan, notes, etc.)"}
                    },
                    "required": ["repo_name", "pr_number", "memo_type"]
                }
            },
            {
                "name": "set_memo",
                "description": "Set a PR memo (bot's notes)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_name": {"type": "string", "description": "Repository name"},
                        "pr_number": {"type": "integer", "description": "PR number"},
                        "memo_type": {"type": "string", "description": "Memo type (todo, plan, notes, etc.)"},
                        "content": {"type": "string", "description": "Memo content"}
                    },
                    "required": ["repo_name", "pr_number", "memo_type", "content"]
                }
            },
        ]

    async def _handle_tool_call(self, name: str, arguments: dict) -> Any:
        """Handle a tool call and return the result."""

        # Record tool call in workflow if active
        if self.workflow_tools and self.workflow_tools._current_step:
            await self.workflow_tools._current_step.record_tool_call()

        # Git tools
        if name == "git_status":
            return await self.git_tools.status(**arguments)
        elif name == "git_diff":
            return await self.git_tools.diff(**arguments)
        elif name == "git_fetch":
            return await self.git_tools.fetch(**arguments)
        elif name == "git_merge":
            return await self.git_tools.merge(**arguments)
        elif name == "git_rebase":
            return await self.git_tools.rebase(**arguments)
        elif name == "git_add":
            return await self.git_tools.add(**arguments)
        elif name == "git_commit":
            return await self.git_tools.commit(**arguments)
        elif name == "git_push":
            return await self.git_tools.push(**arguments)
        elif name == "git_log":
            return await self.git_tools.log(**arguments)
        elif name == "git_checkout":
            return await self.git_tools.checkout(**arguments)

        # File tools
        elif name == "read_file":
            return await self.file_tools.read_file(**arguments)
        elif name == "write_file":
            return await self.file_tools.write_file(**arguments)
        elif name == "list_directory":
            return await self.file_tools.list_directory(**arguments)
        elif name == "file_exists":
            return await self.file_tools.file_exists(**arguments)

        # Workflow tools
        elif name == "workflow_start":
            return await self.workflow_tools.workflow_start(**arguments)
        elif name == "workflow_step_start":
            return await self.workflow_tools.workflow_step_start(**arguments)
        elif name == "workflow_step_complete":
            return await self.workflow_tools.workflow_step_complete(**arguments)
        elif name == "workflow_step_fail":
            return await self.workflow_tools.workflow_step_fail(**arguments)
        elif name == "workflow_step_output":
            return await self.workflow_tools.workflow_step_output(**arguments)
        elif name == "workflow_complete":
            return await self.workflow_tools.workflow_complete(**arguments)
        elif name == "workflow_pause":
            return await self.workflow_tools.workflow_pause(**arguments)
        elif name == "workflow_status":
            return await self.workflow_tools.workflow_status()
        elif name == "workflow_get":
            return await self.workflow_tools.workflow_get(**arguments)
        elif name == "workflow_list_active":
            return await self.workflow_tools.workflow_list_active(**arguments)
        elif name == "workflow_stats":
            return await self.workflow_tools.workflow_stats(**arguments)

        # Sync/PR tools
        elif name == "get_active_prs":
            return await self.sync_tools.get_active_prs(**arguments)
        elif name == "get_pr_snapshot":
            return await self.sync_tools.get_pr_snapshot(**arguments)
        elif name == "get_pr_context":
            return await self.sync_tools.get_pr_context(**arguments)
        elif name == "get_statistics":
            return await self.sync_tools.get_statistics()
        elif name == "get_memo":
            return await self.sync_tools.get_memo(**arguments)
        elif name == "set_memo":
            return await self.sync_tools.set_memo(**arguments)

        else:
            return {"error": f"Unknown tool: {name}"}

    async def _handle_request(self, request: dict) -> dict:
        """Handle an MCP request and return a response."""
        method = request.get("method", "")
        request_id = request.get("id")
        params = request.get("params", {})

        try:
            if method == "initialize":
                await self.initialize()
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": self.PROTOCOL_VERSION,
                        "capabilities": {
                            "tools": {},
                        },
                        "serverInfo": {
                            "name": self.SERVER_NAME,
                            "version": self.SERVER_VERSION,
                        },
                    },
                }

            elif method == "notifications/initialized":
                # Client acknowledgment, no response needed
                return None

            elif method == "tools/list":
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "tools": self._get_tool_definitions(),
                    },
                }

            elif method == "tools/call":
                tool_name = params.get("name")
                arguments = params.get("arguments", {})

                logger.info(f"Tool call: {tool_name}")
                result = await self._handle_tool_call(tool_name, arguments)

                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2, default=str),
                            }
                        ],
                    },
                }

            elif method == "ping":
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {},
                }

            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": MCPError.METHOD_NOT_FOUND,
                        "message": f"Method not found: {method}",
                    },
                }

        except Exception as e:
            logger.exception(f"Error handling request: {e}")
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": MCPError.INTERNAL_ERROR,
                    "message": str(e),
                },
            }

    async def run(self):
        """Run the MCP server on STDIO."""
        logger.info("Starting MCP server on STDIO")

        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

        writer_transport, writer_protocol = await asyncio.get_event_loop().connect_write_pipe(
            asyncio.streams.FlowControlMixin, sys.stdout
        )
        writer = asyncio.StreamWriter(writer_transport, writer_protocol, reader, asyncio.get_event_loop())

        buffer = ""

        while True:
            try:
                # Read a line
                line = await reader.readline()
                if not line:
                    break

                line = line.decode("utf-8").strip()
                if not line:
                    continue

                # Parse JSON-RPC request
                try:
                    request = json.loads(line)
                except json.JSONDecodeError as e:
                    response = {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {
                            "code": MCPError.PARSE_ERROR,
                            "message": f"Parse error: {e}",
                        },
                    }
                    writer.write((json.dumps(response) + "\n").encode("utf-8"))
                    await writer.drain()
                    continue

                # Handle request
                response = await self._handle_request(request)

                # Send response (if any)
                if response is not None:
                    writer.write((json.dumps(response) + "\n").encode("utf-8"))
                    await writer.drain()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.exception(f"Error in main loop: {e}")

        logger.info("MCP server stopped")


# =============================================================================
# CLI Entry Point
# =============================================================================

def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="github_sync MCP Server")
    parser.add_argument(
        "--workspace", "-w",
        required=True,
        help="Path to workspace directory",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )

    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    server = MCPServer(workspace_path=args.workspace)
    asyncio.run(server.run())


if __name__ == "__main__":
    main()
