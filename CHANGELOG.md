# Changelog

## 2025-11-21 - TUI Dashboard & Multi-Repo Support

### Major Changes

- **TUI Dashboard**: Added real-time monitoring dashboard with Rich library
  - Visual monitoring of PR processing across multiple repositories
  - Live status updates, processing stats, and recent activity logs
  - Color-coded status indicators for each repository
  - Runs in terminal (perfect for tmux/screen sessions)
  - New script: `dashboard.py`

- **Multi-Repository Support**: Process PRs across multiple repos
  - YAML configuration file (`config.yaml`) for repo management
  - Configure multiple repositories in single file
  - Enable/disable repos individually
  - Independent processing per repository
  - Dashboard monitors all configured repos simultaneously

- **Templated Prompts**: Added future PRD for customizable prompt templates
  - Placeholder for template system (not yet implemented)
  - Will allow per-repo and per-scenario prompt customization

### New Files

- `dashboard.py` - TUI dashboard with Rich library
- `config.example.yaml` - Example configuration file
- Updated `PRD.md` with PRD-007 (Dashboard) and future templating idea
- Updated `ADR.md` with ADR-010 (TUI) and ADR-011 (YAML config)

### Dependencies

- Added `rich>=13.0.0` for TUI dashboard
- Added `pyyaml>=6.0` for config file parsing
- Both managed by uv (PEP 723 inline metadata)

### Usage

**Dashboard (recommended):**
```bash
cp config.example.yaml config.yaml
vi config.yaml  # Add your repos
./dashboard.py
```

**Single repo (as before):**
```bash
./pr-loop.py /path/to/repo
```

### Configuration Format

```yaml
repos:
  - path: /path/to/repo
    name: "Repo Name"
    enabled: true
```

---

## 2025-11-21 - Label-Based Control & Documentation Restructure

### Major Changes

- **Label-Based Processing Control**: Replaced `--review` flag with GitHub label-based system
  - Add `for-landing` label: Basic PR processing (conflicts, reviews, CI)
  - Add `for-review` label: Comprehensive review with code improvements
  - No label: PR is skipped
  - PRs categorized at fetch time for efficient processing

- **Real-Time Notifications**: Added ntfy.sh integration
  - Notifications for: Processing start, complete, failure, review results
  - Topic: `merge-god-sez` at https://ntfy.sh/merge-god-sez
  - Emoji tags and priorities for visual identification
  - No external dependencies (uses urllib)

- **Documentation Restructure**: Organized documentation for better maintainability
  - Created **PRD.md** - Product requirements tracker
  - Created **ADR.md** - Architecture decision records
  - Moved historical code review docs to `docs/` directory
  - Added "For Maintainers" section to README
  - Added documentation index at top of README

### Technical Changes

- `get_open_prs()` now returns categorized dict instead of flat list
- `process_pr()` takes `mode` parameter instead of `review_enabled` boolean
- Main loop processes PRs by label category
- Added `send_notification()` function with configurable priorities and tags
- Enhanced logging with categorization details

### Documentation

- All examples updated to show label-based usage
- Added notification system documentation
- Consolidated filtering and control guidelines
- Added maintainer guide for PRD/ADR usage

### Migration

**Before:**
```bash
./pr-loop.py /path/to/repo --review
```

**After:**
```bash
# No command-line flag needed
./pr-loop.py /path/to/repo

# Control processing with GitHub labels:
# - Add 'for-review' label to PR for comprehensive review
# - Add 'for-landing' label to PR for basic processing
# - No label = PR is skipped
```

---

## 2025-11-20 - Added Repository Argument

### Changes

- **Repository Argument Required**: Script now requires a repository path as an argument
  - Usage: `./pr-loop.py <repo_path>`
  - Example: `./pr-loop.py /path/to/repo` or `./pr-loop.py .`
  
- **Repository Validation**: Added comprehensive validation before starting
  - Checks if path exists and is a directory
  - Verifies it's a git repository (has `.git` directory)
  - Tests git commands work in the directory
  - Validates GitHub CLI is authenticated (`gh auth status`)
  
- **Argument Parsing**: Added `argparse` with helpful usage examples
  - `./pr-loop.py --help` shows usage information
  - Clear error messages for missing or invalid arguments
  
- **Updated test-prompt.py**: Now also requires repository path
  - Usage: `./test-prompt.py <repo_path> <pr_number>`
  - Example: `./test-prompt.py /path/to/repo 123`
  
- **Fixed Deprecation Warning**: Updated `datetime.utcnow()` to `datetime.now(timezone.utc)`
  - Removed Python 3.13+ deprecation warning
  - Compatible with Python 3.12+

- **Updated Documentation**: All examples in README.md now include repository argument
  - Usage examples
  - Background execution
  - systemd service configuration
  - launchd plist configuration

### Migration

If you were using the script without arguments (running in current directory):

**Before:**
```bash
cd /path/to/repo
./pr-loop.py
```

**After:**
```bash
./pr-loop.py /path/to/repo
# or if already in the repo directory:
./pr-loop.py .
```

### Benefits

- Can process PRs in any repository without changing directories
- Better for automation and service configuration
- Clear validation and error messages
- More flexible deployment options
