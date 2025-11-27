# github_sync MCP Server

An MCP (Model Context Protocol) server that exposes git operations, file management, workflow tracking, and PR context as tools for LLM applications.

## Quick Start

### Installation

```bash
# Install the package
pip install -e /path/to/merge-god

# Or with uv
uv pip install -e /path/to/merge-god
```

### Running the Server

```bash
# Start the MCP server with a workspace directory
python -m github_sync.mcp_server --workspace /path/to/workspace

# With debug logging
python -m github_sync.mcp_server --workspace /path/to/workspace --debug
```

The server will:

1. Create the workspace directory if it doesn't exist
2. Create or load the SQLite database (`sync.db`) in the workspace
3. Listen for MCP commands on STDIO

## Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "github-sync": {
            "command": "python",
            "args": ["-m", "github_sync.mcp_server", "--workspace", "/path/to/your/workspace"]
        }
    }
}
```

### Using with uv

```json
{
    "mcpServers": {
        "github-sync": {
            "command": "uv",
            "args": ["run", "--directory", "/path/to/merge-god", "python", "-m", "github_sync.mcp_server", "--workspace", "/path/to/workspace"]
        }
    }
}
```

### Using with a Virtual Environment

```json
{
    "mcpServers": {
        "github-sync": {
            "command": "/path/to/venv/bin/python",
            "args": ["-m", "github_sync.mcp_server", "--workspace", "/path/to/workspace"]
        }
    }
}
```

## Available Tools

### Git Tools

| Tool | Description |
|------|-------------|
| `git_status` | Get repository status (branch, staged/unstaged files, conflicts) |
| `git_diff` | Get diff of changes (staged or unstaged, specific file) |
| `git_fetch` | Fetch changes from remote |
| `git_merge` | Merge a branch (with conflict detection) |
| `git_rebase` | Rebase onto another branch |
| `git_add` | Stage files for commit |
| `git_commit` | Create a commit |
| `git_push` | Push to remote (supports force-with-lease) |
| `git_log` | Get commit history |
| `git_checkout` | Switch branches (can create new branch) |

### File Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read contents of a file |
| `write_file` | Write contents to a file (creates parent directories) |
| `list_directory` | List directory contents with glob pattern support |
| `file_exists` | Check if a file or directory exists |

### Workflow Tools

Track multi-step LLM operations with automatic timing and tool call counting.

| Tool | Description |
|------|-------------|
| `workflow_start` | Start a new workflow (merge, rebase, pr_review, ci_fix) |
| `workflow_step_start` | Start a step within the workflow |
| `workflow_step_complete` | Complete the current step with summary |
| `workflow_step_fail` | Fail the current step with error details |
| `workflow_step_output` | Add structured output data to current step |
| `workflow_complete` | Complete the entire workflow |
| `workflow_pause` | Pause workflow for human review |
| `workflow_status` | Get current workflow and step status |
| `workflow_get` | Get a workflow by ID (with all steps) |
| `workflow_list_active` | List active/paused workflows |
| `workflow_stats` | Get workflow statistics (success rate, timing) |

### PR/Sync Tools

| Tool | Description |
|------|-------------|
| `get_active_prs` | Get all active PRs for a repository |
| `get_pr_snapshot` | Get PR details (title, state, CI status, labels) |
| `get_pr_context` | Get full PR context (diff, comments, reviews) |
| `get_statistics` | Get database statistics |
| `get_memo` | Get bot's notes for a PR |
| `set_memo` | Store bot's notes for a PR |

## Usage Examples

### Basic Git Operations

```
User: What's the status of the repository?

Claude: [calls git_status]
The repository is on branch 'feature-xyz' with 2 unstaged files:
- src/main.py (modified)
- tests/test_main.py (modified)
```

### Multi-Step Workflow

```
User: Merge the main branch into feature-branch

Claude: I'll perform this merge operation and track it as a workflow.

[calls workflow_start with type="merge", repo_name="my-repo", branch_name="feature-branch"]
Started workflow #1

[calls workflow_step_start with step_name="fetch"]
[calls git_fetch]
[calls workflow_step_complete with summary="Fetched latest changes"]

[calls workflow_step_start with step_name="merge"]
[calls git_merge with branch="main"]
[calls workflow_step_complete with summary="Merged main, no conflicts"]

[calls workflow_complete with result="Successfully merged main into feature-branch"]

Workflow completed in 1.2 seconds.
```

### Handling Merge Conflicts

```
Claude: [calls git_merge with branch="main"]
Merge has conflicts in: src/utils.py, src/config.py

[calls workflow_step_output with data={"has_conflicts": true, "files": ["src/utils.py", "src/config.py"]}]

[calls read_file with path="src/utils.py"]
I can see the conflict markers. Let me resolve this...

[calls write_file with resolved content]
[calls git_add with files=["src/utils.py"]]

[calls workflow_step_complete with summary="Resolved 2 conflicts"]
```

### Requesting Human Review

```
Claude: [calls git_merge with branch="main"]
There's a complex conflict in the authentication module that requires human review.

[calls workflow_pause with reason="Complex conflict in auth.py - need human decision on which authentication method to keep"]

Workflow paused. The conflict involves choosing between OAuth and JWT implementations.
Please review src/auth.py and let me know which approach to keep.
```

## Workspace Structure

```
workspace/
├── sync.db          # SQLite database (auto-created)
├── .git/            # Git repository (if initialized)
└── ...              # Your project files
```

The database stores:

- PR snapshots and context (synced from GitHub)
- Workflow history and steps
- Bot memos and notes
- Execution statistics

## Automatic Features

### Tool Call Recording

When inside a workflow step, **all tool calls are automatically recorded**. This allows you to:

- Track how many operations each step required
- Analyze LLM efficiency over time
- Debug failed workflows

### Database Initialization

The server automatically:

- Creates the workspace directory if missing
- Creates a new database with full schema if none exists
- Loads existing database and logs statistics
- Runs any pending schema migrations

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub API token (for PR sync operations) |

## Logging

Logs are written to stderr (stdout is reserved for MCP protocol). Set `--debug` for verbose logging.

```bash
# View logs while running
python -m github_sync.mcp_server --workspace ./workspace --debug 2>server.log
```

## Programmatic Usage

```python
import asyncio
from github_sync import MCPServer

async def main():
    server = MCPServer(workspace_path="./my-workspace")
    await server.initialize()

    # Use tools directly
    status = await server.git_tools.status()
    print(f"On branch: {status['branch']}")

    # Or run the full server
    await server.run()

asyncio.run(main())
```

## Tool Input Schemas

### git_status

```json
{
    "path": "(optional) Repository path"
}
```

### git_merge

```json
{
    "branch": "(required) Branch to merge",
    "path": "(optional) Repository path",
    "no_commit": "(optional) Don't auto-commit merge"
}
```

### workflow_start

```json
{
    "workflow_type": "(required) merge|rebase|pr_review|ci_fix|custom",
    "repo_name": "(required) Repository name",
    "branch_name": "(optional) Branch name",
    "pr_number": "(optional) PR number",
    "context": "(optional) Initial context data"
}
```

### workflow_step_start

```json
{
    "step_name": "(required) Name of the step",
    "input_data": "(optional) Input data for the step"
}
```

### workflow_step_complete

```json
{
    "summary": "(optional) Summary of what was done",
    "output_data": "(optional) Structured output data"
}
```

### workflow_pause

```json
{
    "reason": "(required) Why human input is needed"
}
```

### read_file

```json
{
    "path": "(required) File path (relative to workspace)",
    "encoding": "(optional, default: utf-8) File encoding"
}
```

### write_file

```json
{
    "path": "(required) File path",
    "content": "(required) Content to write",
    "encoding": "(optional, default: utf-8) File encoding"
}
```

## Error Handling

Tools return structured error responses:

```json
{
    "error": "Description of what went wrong"
}
```

For git operations, additional context is provided:

```json
{
    "success": false,
    "has_conflicts": true,
    "conflict_files": ["file1.py", "file2.py"],
    "output": "CONFLICT (content): Merge conflict in file1.py..."
}
```

## Best Practices

1. **Always use workflows for multi-step operations** - Provides audit trail and recovery
2. **Use step_output for important data** - Makes data available to subsequent steps
3. **Call workflow_pause when uncertain** - Better to ask than make wrong decisions
4. **Check git_status before operations** - Avoid operating on dirty state
5. **Use relative paths** - All paths are relative to workspace

## Troubleshooting

### Server doesn't start

- Check that the workspace path is writable
- Verify Python can import `github_sync`
- Run with `--debug` to see detailed errors

### Tools return errors

- Check stderr for detailed error messages
- Verify git is installed and configured
- Ensure workspace has a git repository (for git tools)

### Database issues

- Delete `sync.db` to start fresh
- Check file permissions on workspace directory
