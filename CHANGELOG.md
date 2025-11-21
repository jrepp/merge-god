# Changelog

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
