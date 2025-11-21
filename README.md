# PR Merge Loop

Automated PR processing system that uses `bob` (an AI assistant wrapper) to continuously process and merge pull requests.

## Features

- **Automatic PR Processing**: Loops through open PRs and processes them in order
- **Smart Filtering**: Excludes draft PRs and those labeled with WIP/work-in-process
- **Comprehensive Context Gathering**: Before processing each PR, the script gathers:
  - Full PR details (title, description, author, dates, statistics)
  - All discussion comments (general PR conversation)
  - All review comments (inline code review feedback)
  - Complete commit history for the PR
  - List of changed files with additions/deletions
  - Merge conflict detection and conflicting file identification
  - CI/CD status (passed, failed, pending checks with failure details)
  - Review decision status (approved, changes requested, pending)
  - PR diff for complete code changes
- **Repository Syncing**: Automatically syncs with origin/main before processing
- **Conflict Resolution**: Detects and instructs agent to resolve merge conflicts
- **Review Response**: Provides agent with all review comments to address
- **CI/CD Fixes**: Identifies failing checks and instructs agent to fix them
- **Guideline Adherence**: Follows PR guidelines or learns from commit history
- **Structured Logging**: Emits all inputs/outputs in JSON format
- **Rich Prompt Generation**: Creates comprehensive prompts with all context for optimal agent understanding

## Requirements

- Python 3.12+
- [uv](https://github.com/astral-sh/uv) - Modern Python package and project manager (required)
- [gh](https://cli.github.com/) - GitHub CLI
- `bob` - AI assistant wrapper command (must be in PATH)
- Git repository with GitHub remote

### Why uv?

All scripts use **uv** for dependency management and execution via PEP 723 inline script metadata. Benefits:

- **No virtual environment needed** - uv manages dependencies automatically
- **Fast execution** - Scripts start quickly with cached environments
- **Reproducible** - Dependencies pinned in script headers
- **Modern** - Uses latest Python packaging standards

**See [UV_SUPPORT.md](UV_SUPPORT.md) for detailed documentation on uv usage and benefits.**

## Installation

1. Install dependencies:
```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install GitHub CLI
brew install gh  # macOS
# or: apt install gh  # Linux
# or: winget install --id GitHub.cli  # Windows

# Authenticate with GitHub
gh auth login
```

2. Ensure `bob` is in your PATH:
```bash
which bob  # Should output the path to bob
```

3. Clone this repository:
```bash
cd /path/to/your/repo
git clone <this-repo-url> .
```

## How It Works

### Context Gathering Phase

Before invoking `bob` (Claude Code), the script performs extensive pre-work to gather comprehensive PR context:

1. **PR Metadata**: Title, description, author, dates, branch names, statistics (files changed, additions, deletions)
2. **Comments & Reviews**: All discussion comments and inline code review comments with file paths and line numbers
3. **Commit History**: Complete list of commits in the PR with messages and SHAs
4. **Changed Files**: Detailed list of all modified files with their change statistics
5. **Merge Conflicts**: Proactive detection of merge conflicts with origin/main, including list of conflicting files
6. **CI/CD Status**: Complete status of all checks (passed, failed, pending) with failure details and links
7. **Review Status**: Overall review decision (approved, changes requested, pending)
8. **Code Diff**: Full diff of all changes in the PR

### Prompt Generation

The script then generates a comprehensive markdown prompt containing:

- **PR Overview**: Number, title, author, branches, URL
- **PR Description**: Full description from the PR body
- **Statistics**: Files changed, additions, deletions
- **⚠️ Merge Conflicts** (if any): List of conflicting files that MUST be resolved
- **CI/CD Status**: Breakdown of check results with failed check details
- **Review Status**: Approval state
- **Code Review Comments**: All inline review comments with file paths and line numbers
- **Discussion Comments**: Recent PR conversation
- **Changed Files**: Complete list with change statistics
- **Commit History**: Recent commits in the PR
- **Mission**: Prioritized task list based on PR state (conflicts first, then reviews, then CI fixes)
- **Guidelines**: Project contribution guidelines or commit style examples
- **Critical Rules**: No branding, professional commits, focused changes

### Execution

The comprehensive prompt is passed to `bob --json`, which processes the PR autonomously.

**See [PROMPT_EXAMPLE.md](PROMPT_EXAMPLE.md) for a complete example of a generated prompt.**

## Usage

### Run the PR loop

```bash
# Process PRs in a specific repository
./pr-loop.py /path/to/repo

# Process PRs in current directory
./pr-loop.py .

# Show help
./pr-loop.py --help
```

The script will:
1. Validate the repository (git repo, GitHub CLI authenticated)
2. Change to the repository directory
3. Fetch all open PRs (excluding drafts and WIP-labeled)
4. For each PR:
   - Sync the repository with origin/main
   - Gather comprehensive PR context (see above)
   - Generate rich prompt with all context
   - Run `bob` with the detailed prompt to:
     - Checkout the PR branch
     - Merge/rebase with main and resolve conflicts
     - Read and address code review comments
     - Fix CI/CD failures
     - Push changes back to the PR
5. Wait 5 minutes between cycles
6. Loop forever

### Test prompt generation

Before running the full loop, you can test what prompt would be generated for a specific PR:

```bash
# Generate and display prompt for PR #123 in a specific repo
./test-prompt.py /path/to/repo 123

# Generate prompt for PR in current directory
./test-prompt.py . 456

# Save prompt to file
./test-prompt.py /path/to/repo 123 > prompt.txt

# Pipe directly to bob for testing
./test-prompt.py /path/to/repo 123 | bob --json
```

This is useful for:
- Understanding what context the agent receives
- Debugging prompt generation
- Testing with specific PRs before full automation

### Run in background with logging

```bash
# Run with output to file
./pr-loop.py /path/to/repo > pr-loop.log 2>&1 &

# Or use nohup
nohup ./pr-loop.py /path/to/repo > pr-loop.log 2>&1 &

# Follow the logs
tail -f pr-loop.log | jq .  # Pretty print JSON logs
```

### Monitor with systemd (Linux)

Create `/etc/systemd/system/pr-loop.service`:

```ini
[Unit]
Description=PR Merge Loop
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/merge-god
ExecStart=/path/to/merge-god/pr-loop.py /path/to/target-repo
Restart=always
RestartSec=30
StandardOutput=append:/var/log/pr-loop.log
StandardError=append:/var/log/pr-loop.error.log

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable pr-loop
sudo systemctl start pr-loop
sudo systemctl status pr-loop
```

### Monitor with launchd (macOS)

Create `~/Library/LaunchAgents/com.user.pr-loop.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.pr-loop</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/merge-god/pr-loop.py</string>
        <string>/path/to/target-repo</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/merge-god</string>
    <key>StandardOutPath</key>
    <string>/tmp/pr-loop.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/pr-loop.error.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.user.pr-loop.plist
launchctl start com.user.pr-loop
```

## Configuration

### PR Guidelines

The script automatically looks for PR guidelines in these locations (in order):
- `CONTRIBUTING.md`
- `.github/CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/CONTRIBUTING.md`
- `PULL_REQUEST_TEMPLATE.md`

If no guidelines are found, it uses the last 20 commit messages from `origin/main` as examples.

### Filtering PRs

PRs are automatically excluded if they:
- Are marked as draft
- Have labels containing: `wip`, `work-in-process`, or `work in process` (case-insensitive)

To skip a PR, simply:
- Mark it as draft, OR
- Add a label with "WIP" in the name

## JSON Log Format

All logs are emitted as JSON with this structure:

```json
{
  "timestamp": "2025-11-20T15:30:00Z",
  "event": "event_type",
  "data": {
    "key": "value"
  }
}
```

### Event Types

- `startup` - Script initialization
- `iteration` - Loop iteration start/complete
- `fetch_prs` - Fetching PR list
- `sync_repo` - Repository sync operation
- `gather_pr_context` - Gathering comprehensive PR context
- `get_pr_details` - Fetching full PR information
- `get_pr_comments` - Fetching discussion comments
- `get_pr_review_comments` - Fetching inline code review comments
- `get_pr_commits` - Fetching commit history
- `get_pr_files` - Fetching changed files list
- `get_pr_diff` - Fetching PR diff
- `check_merge_conflicts` - Detecting merge conflicts
- `process_pr` - PR processing steps
- `shutdown` - Clean shutdown
- `fatal_error` - Unrecoverable error

### Example Log Output

```json
{"timestamp": "2025-11-20T15:30:00Z", "event": "startup", "data": {"cwd": "/Users/jrepp/dev/merge-god", "python_version": "3.12.0"}}
{"timestamp": "2025-11-20T15:30:01Z", "event": "fetch_prs", "data": {"action": "complete", "total": 5, "filtered": 3}}
{"timestamp": "2025-11-20T15:30:02Z", "event": "process_pr", "data": {"action": "start", "pr_number": 123, "title": "Add new feature"}}
{"timestamp": "2025-11-20T15:30:03Z", "event": "gather_pr_context", "data": {"action": "start", "pr_number": 123}}
{"timestamp": "2025-11-20T15:30:05Z", "event": "get_pr_review_comments", "data": {"action": "complete", "pr_number": 123, "review_comment_count": 8}}
{"timestamp": "2025-11-20T15:30:06Z", "event": "check_merge_conflicts", "data": {"action": "complete", "pr_number": 123, "has_conflicts": true, "conflicting_files": ["src/main.py"], "conflict_count": 1}}
{"timestamp": "2025-11-20T15:30:08Z", "event": "gather_pr_context", "data": {"action": "complete", "pr_number": 123, "context_summary": {"comments": 5, "review_comments": 8, "commits": 12, "files": 6, "has_conflicts": true, "ci_checks": 4, "ci_failed": 2, "diff_size": 4521}}}
{"timestamp": "2025-11-20T15:30:08Z", "event": "process_pr", "data": {"action": "prompt_generated", "pr_number": 123, "prompt_size": 8934}}
{"timestamp": "2025-11-20T15:30:09Z", "event": "process_pr", "data": {"action": "running_bob", "pr_number": 123}}
```

## Stopping the Script

```bash
# If running in foreground
Ctrl+C

# If running in background
pkill -f pr-loop.py

# With systemd
sudo systemctl stop pr-loop

# With launchd
launchctl stop com.user.pr-loop
```

## Troubleshooting

### `bob` command not found

Ensure `bob` is in your PATH:
```bash
export PATH="$PATH:/path/to/bob/directory"
```

### GitHub authentication issues

Re-authenticate with GitHub:
```bash
gh auth login
gh auth status
```

### Permission errors

Ensure the script is executable:
```bash
chmod +x pr-loop.py
```

### No PRs being processed

Check that:
- PRs are not marked as draft
- PRs don't have WIP-related labels
- GitHub CLI is authenticated: `gh auth status`
- Repository has a `main` branch (or update the script for `master`)

## Customization

Edit `pr-loop.py` to customize:
- **Polling interval**: Change `time.sleep(300)` (currently 5 minutes)
- **Main branch name**: Change `"main"` to `"master"` if needed
- **Timeout duration**: Change `timeout=3600` in `run_command()` (currently 1 hour)
- **PR limit**: Change `--limit 100` in `get_open_prs()`
- **WIP label patterns**: Modify the filter in `get_open_prs()`

## License

MIT
