# PR Merge Loop

Automated PR processing system that uses `bob` (an AI assistant wrapper) to continuously process and merge pull requests.

## Documentation

- **[PRD.md](PRD.md)** - Product requirements tracker (features, priorities, status)
- **[ADR.md](ADR.md)** - Architecture decision records (design choices, rationale)
- **[UV_SUPPORT.md](UV_SUPPORT.md)** - Comprehensive guide to uv usage
- **[PROMPT_EXAMPLE.md](PROMPT_EXAMPLE.md)** - Example of generated PR prompt
- **[CHANGELOG.md](CHANGELOG.md)** - Version history and changes
- **[docs/](docs/)** - Historical documentation (code reviews, fixes)

## Features

- **TUI Dashboard**: Real-time monitoring dashboard for multiple repositories
  - Live status updates and processing visualization
  - Runs in tmux/screen sessions
  - Shows PRs being processed, stats, and recent activity
  - Automatic non-TUI mode when no TTY (CI, background, testing)
- **Comprehensive Logging**: All operations logged to file
  - Default: `merge-god-dashboard.log`
  - JSON events with timestamps and repo context
  - Configurable log file path
  - Real-time writes for debugging
- **Multi-Repository Support**: Process PRs across multiple repos with single dashboard
  - YAML configuration file for easy repo management
  - Per-repo enable/disable control
  - Independent processing per repository
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
- **Issue Watching (Optional)**: Monitor and automatically implement GitHub issues
  - Watch for issues labeled `for-impl` (feature/fix implementation requests)
  - Issues are PRIMARY tasks (processed before PRs)
  - Creates branch, implements solution, creates PR, links back to issue
  - Enable per-repository with `watch_issues: true` in config
- **Label-Based Processing Control**: Use GitHub labels to control how PRs are processed:
  - `for-review` label: Comprehensive review with code quality improvements
  - `for-landing` label: Basic processing to merge (conflicts, reviews, CI fixes)
  - No label: PR is skipped (will not be processed)
- **Two-Pass Processing for Review**: PRs labeled `for-review` get:
  - Initial pass: Resolve conflicts, address reviews, fix CI
  - Second pass: Code review for quality, security, performance, best practices
  - Targeted improvements with focused commits
  - Comprehensive review guidelines (SOLID, DRY, security, performance)
- **Structured Logging**: Emits all inputs/outputs in JSON format
- **Rich Prompt Generation**: Creates comprehensive prompts with all context for optimal agent understanding
- **Real-time Notifications**: Sends updates to ntfy.sh for PR processing events (start, complete, errors)

## Requirements

- Python 3.12+
- [uv](https://github.com/astral-sh/uv) - Modern Python package and project manager (required)
- [gh](https://cli.github.com/) - GitHub CLI
- `bob` - AI assistant wrapper command (must be in PATH)
- Git repository with GitHub remote

**Optional:**
- `doormat` - AWS credential manager (automatically detected and used if available)

**Python dependencies** (automatically installed by uv):
- `rich>=13.0.0` - For TUI dashboard (dashboard.py only)
- `pyyaml>=6.0` - For config file parsing (dashboard.py only)

Note: `pr-loop.py` has no external dependencies (only stdlib)

### Doormat Integration

If `doormat` is installed, the dashboard will automatically refresh credentials before launching each repository monitor. This ensures AWS credentials are always up-to-date for long-running sessions.

**How it works:**
- Dashboard checks for `doormat` command at startup
- Tries multiple doormat commands automatically:
  - `doormat` (some versions)
  - `doormat login` (common pattern)
  - `doormat aws login` (AWS-specific)
  - `doormat exec` (exec pattern)
- Non-fatal: if doormat fails, processing continues
- Logs credential refresh attempts in dashboard

**Custom doormat command:**
If your doormat installation uses a different command, specify it in config.yaml:
```yaml
doormat:
  command: ["doormat", "your-command"]  # Custom command
  timeout: 30  # Optional timeout in seconds (default: 30)
```

Example for different doormat versions:
```yaml
# Just 'doormat'
doormat:
  command: ["doormat"]

# With subcommand
doormat:
  command: ["doormat", "login"]

# AWS-specific
doormat:
  command: ["doormat", "aws", "login"]
```

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

## Quick Start

### Option 1: TUI Dashboard (Recommended)

For monitoring multiple repositories with a visual dashboard:

```bash
# Option A: Interactive Setup (First Time)
# If config.yaml doesn't exist, dashboard will offer to create it interactively
./dashboard.py

# Follow the prompts to:
# - Add repository paths
# - Set display names
# - Enable/disable repos
# - Optionally validate after creation

# Option B: Manual Configuration
# 1. Copy example config
cp config.example.yaml config.yaml

# 2. Edit config with your repositories
vi config.yaml

# 3. Validate configuration (dry-run)
./dashboard.py --dry-run

# 4. Run dashboard (best in tmux/screen)
./dashboard.py

# Or specify custom config
./dashboard.py my-config.yaml
```

**Interactive Bootstrap**: When config.yaml doesn't exist, the dashboard automatically offers to create it interactively:
- Prompts for repository paths with live validation
- Suggests repository names based on directory
- Validates git repositories as you add them
- Shows summary before saving
- Optionally runs dry-run validation after creation
- Creates properly formatted YAML with comments

**Dry-run mode**: Use `--dry-run` to validate your configuration before launching:
- Checks that all repository paths exist and are valid git repos
- Verifies pr-loop.py is present and executable
- Displays summary of what would be launched
- Shows any errors or warnings
- Exits without starting processes

The dashboard provides:
- **Tag selection criteria** displayed at startup (shows which labels trigger PR processing)
- Real-time status for all configured repos
- Live updates as PRs are processed
- Processing statistics and recent activity
- Color-coded status indicators
- Recent logs per repository

**Interactive Setup Example:**
```
$ ./dashboard.py

Config File Not Found
No configuration file found at: config.yaml

Would you like to create a configuration file now? [Y/n]: y

Interactive Configuration Setup
Let's configure repositories for PR automation.

Repository #1
  Repository path (absolute path): /Users/me/projects/my-app
  ✓ Valid git repository
  Repository name (display name) [my-app]: My App
  Enable this repository? [Y/n]: y

✓ Added: My App

Add another repository? [y/N]: n

Configuration Summary
┏━━━━━┳━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┓
┃ #   ┃ Name   ┃ Path                         ┃ Enabled ┃
┡━━━━━╇━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━┩
│ 1   │ My App │ /Users/me/projects/my-app    │   Yes   │
└─────┴────────┴──────────────────────────────┴─────────┘

Save configuration to config.yaml? [Y/n]: y

✓ Configuration saved to config.yaml

Validate configuration now (dry-run)? [Y/n]: y
```

**Recommended for tmux/screen:**
```bash
# In tmux
tmux new -s merge-god
./dashboard.py

# Detach with Ctrl+B, then D
# Reattach: tmux attach -t merge-god
```

**Non-TUI Mode (for testing/CI/background):**
```bash
# Force non-TUI mode with pipe
./dashboard.py | cat

# Run in background (automatically uses non-TUI mode)
./dashboard.py > output.txt 2>&1 &

# Custom log file
./dashboard.py --log-file /path/to/custom.log
```

The dashboard automatically detects TTY availability:
- **With TTY**: Rich TUI interface with live updates
- **Without TTY**: Simple text output with periodic status (every 60s)
- **Log file**: All operations logged regardless of mode (default: `merge-god-dashboard.log`)

### Option 2: Single Repository

For processing a single repository without dashboard:

```bash
./pr-loop.py /path/to/repo
```

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

**Note**: Processing mode is now controlled by GitHub labels, not command-line flags. Add the `for-review` or `for-landing` label to your PRs.

**Dashboard Startup**: When you start the dashboard, it displays the tag selection criteria so you immediately understand which PRs will be processed and which will be skipped.

#### How It Works

The script will:
1. Validate the repository (git repo, GitHub CLI authenticated)
2. Change to the repository directory
3. Fetch all open PRs and categorize by labels:
   - `for-review`: Comprehensive review + improvements
   - `for-landing`: Basic processing to merge
   - No label: Skipped (not processed)
4. For each labeled PR:
   - Sync the repository with origin/main
   - Gather comprehensive PR context (see above)
   - Generate rich prompt with all context
   - Run `bob` with the detailed prompt to:
     - Checkout the PR branch
     - Merge/rebase with main and resolve conflicts
     - Read and address code review comments
     - Fix CI/CD failures
     - Push changes back to the PR
   - **If labeled `for-review`**: Run second agent pass for code review
5. Wait 5 minutes between cycles
6. Loop forever

#### Label-Based Processing Modes

**`for-landing` Label** (Basic Mode):
- Resolve merge conflicts with base branch
- Address code review comments
- Fix failing CI/CD checks
- Push changes to get PR ready to merge
- ✅ Use for: Routine PRs, bug fixes, simple features

**`for-review` Label** (Comprehensive Mode):
After initial processing succeeds, runs a **second agent pass**:

1. **Fresh diff fetched** - Gets current PR state after initial processing
2. **Code review prompt generated** with:
   - Complete diff of all changes
   - List of changed files with statistics
   - Comprehensive review guidelines covering:
     - **Code Quality**: Correctness, error handling, edge cases, type safety
     - **Security**: Input validation, SQL injection, XSS, auth checks, secrets
     - **Performance**: Algorithm efficiency, query optimization, memory usage, caching
     - **Best Practices**: DRY principle, SOLID, naming, documentation, tests
3. **Second agent session runs** to:
   - Review all code changes systematically
   - Identify bugs, security issues, performance problems
   - Make targeted improvements with focused commits
   - Fix code quality issues and apply best practices

✅ **Use `for-review` for**:
- High-stakes PRs requiring thorough code review
- PRs from junior developers or external contributors
- Security-sensitive changes
- Performance-critical code
- Complex refactorings

**Note**: Review pass only runs if initial processing succeeds. Failed checks or merge conflicts are handled in the first pass.

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

### Dashboard Configuration

Create a `config.yaml` file to configure multiple repositories:

```yaml
repos:
  - path: /path/to/repo1
    name: "Project A"
    enabled: true

  - path: /path/to/repo2
    name: "Project B"
    enabled: true

  - path: /path/to/repo3
    name: "Disabled Project"
    enabled: false  # Set to false to skip
```

**Configuration fields:**
- `path` (required): Absolute path to git repository
- `name` (optional): Display name (defaults to directory name)
- `enabled` (optional): Whether to process this repo (defaults to true)

**Example:**
```bash
# Copy example config
cp config.example.yaml config.yaml

# Edit with your repos
vi config.yaml

# Run dashboard
./dashboard.py
```

### PR Guidelines

The script automatically looks for PR guidelines in these locations (in order):
- `CONTRIBUTING.md`
- `.github/CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/CONTRIBUTING.md`
- `PULL_REQUEST_TEMPLATE.md`

If no guidelines are found, it uses the last 20 commit messages from `origin/main` as examples.

### Filtering and Controlling PRs

PRs are automatically excluded if they:
- Are marked as draft
- Have labels containing: `wip`, `work-in-process`, or `work in process` (case-insensitive)
- Don't have a processing mode label (`for-review` or `for-landing`)

To control PR processing:
- Add `for-landing` label: Basic processing (conflicts, reviews, CI)
- Add `for-review` label: Comprehensive review + improvements
- No label: PR is skipped

To skip a PR entirely:
- Mark it as draft, OR
- Add a label with "WIP" in the name, OR
- Don't add `for-review` or `for-landing` label

## Real-time Notifications

The script sends real-time notifications to ntfy.sh for key PR processing events:

### Notification Types

- **Processing Started**: When PR processing begins
  - Tags: 🤖 ⏳
  - Includes: PR number, title, mode, branch info

- **Processing Complete**: When PR processing succeeds
  - Tags: ✅ 🚀
  - Includes: PR number, title, mode

- **Processing Failed**: When initial processing fails
  - Tags: ❌ ⚠️
  - Priority: High
  - Includes: PR number, title, failure reason

- **Review Complete**: When code review pass succeeds
  - Tags: ✅ 🔍
  - Includes: PR number, title

- **Review Failed**: When code review pass fails
  - Tags: ❌ 🔍
  - Priority: High
  - Includes: PR number, title

### Receiving Notifications

Subscribe to notifications using the ntfy.sh app or web interface:
- **Topic**: `merge-god-sez`
- **URL**: https://ntfy.sh/merge-god-sez

**Mobile App**:
1. Install ntfy from App Store (iOS) or Play Store (Android)
2. Subscribe to topic: `merge-god-sez`
3. Receive push notifications on your phone

**Web**:
- Visit https://ntfy.sh/merge-god-sez in your browser

**Desktop**:
- Install ntfy desktop app from https://ntfy.sh
- Subscribe to topic: `merge-god-sez`

**Note**: The topic name `merge-god-sez` is public. For production use, consider using a private topic with authentication.

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
- `notification` - Notification sent to ntfy.sh
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
- PRs have `for-review` or `for-landing` label
- GitHub CLI is authenticated: `gh auth status`
- Repository has a `main` branch (or update the script for `master`)

### Dashboard not showing updates

If the dashboard is running but not updating:
- Check that repositories in config.yaml exist and are valid git repos
- Verify `pr-loop.py` is executable: `chmod +x pr-loop.py`
- Check the log file for errors: `tail -f merge-god-dashboard.log`
- Try running `pr-loop.py` directly to see if it works: `./pr-loop.py /path/to/repo`

### Debugging with log file

All dashboard operations are logged to `merge-god-dashboard.log` by default:

```bash
# Watch logs in real-time
tail -f merge-god-dashboard.log

# View JSON events with pretty formatting
cat merge-god-dashboard.log | jq .

# Search for errors
grep -i error merge-god-dashboard.log

# Filter by repository
grep '"repo": "My Repo"' merge-god-dashboard.log | jq .

# Use custom log file
./dashboard.py --log-file debug.log
```

### Config file errors

If config file won't load:
- Verify YAML syntax is correct (use a YAML validator)
- Check that all `path` fields have absolute paths
- Ensure file is named `config.yaml` or specify custom path
- See `config.example.yaml` for reference

## Customization

Edit `pr-loop.py` to customize:
- **Polling interval**: Change `time.sleep(300)` (currently 5 minutes)
- **Main branch name**: Change `"main"` to `"master"` if needed
- **Timeout duration**: Change `timeout=3600` in `run_command()` (currently 1 hour)
- **PR limit**: Change `--limit 100` in `get_open_prs()`
- **WIP label patterns**: Modify the filter in `get_open_prs()`

## For Maintainers

### Adding Features
When adding new features:
1. Create a PRD entry in [PRD.md](PRD.md) with requirements and success criteria
2. Document any architectural decisions in [ADR.md](ADR.md)
3. Update CHANGELOG.md with user-visible changes
4. Update this README if it affects usage

### Making Architectural Decisions
For significant technical choices:
1. Add new ADR entry in [ADR.md](ADR.md)
2. Include context, decision, rationale, and consequences
3. Reference related PRD items if applicable
4. Mark superseded ADRs when decisions change

### Documentation Structure
- **PRD.md** - What we're building (features, requirements)
- **ADR.md** - How/why we built it (technical decisions)
- **README.md** - How to use it (user guide)
- **CHANGELOG.md** - What changed (version history)
- **docs/** - Historical/archived documentation

## License

MIT
