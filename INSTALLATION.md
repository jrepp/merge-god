# Installation Guide for merge-god

## Quick Install

### From PyPI (once published)

```bash
pip install merge-god
```

### From Source

```bash
# Clone the repository
git clone https://github.com/yourusername/merge-god.git
cd merge-god

# Install with pip
pip install .

# Or install in development mode
pip install -e .
```

### Using UV (recommended)

UV is a fast Python package installer and resolver. To install merge-god with UV:

```bash
# Install UV first (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install merge-god
uv pip install merge-god

# Or from source
cd merge-god
uv pip install .

# Or in development mode
uv pip install -e .
```

## CLI Commands

After installation, the `merge-god` command will be available with the following subcommands:

```bash
merge-god [subcommand] [options]
```

### Subcommands

**Main Commands:**
- `merge-god dashboard` - Run the TUI dashboard (all processes)
- `merge-god scan` - Scan and cache PR context (Process 1+2)
- `merge-god agent` - Run agent on cached PR data (Process 3)
- `merge-god validate` - Validate process isolation and data flow
- `merge-god status` - Show system status and statistics
- `merge-god test` - Run test suite

**Utility Commands:**
- `merge-god pr-loop` - Legacy PR processing loop (single repository)
- `merge-god send-approval` - Send approval signal to running pr-loop process
- `merge-god help` - Show detailed help

**Usage Examples:**
```bash
# Run dashboard
merge-god dashboard config.yaml

# Process specific PR
merge-god agent --repo my-repo --pr 123

# Check status
merge-god status
```

## Configuration

1. **Create config file:**
   ```bash
   cp config.example.yaml config.yaml
   ```

2. **Edit config.yaml** with your repositories:
   ```yaml
   repos:
     - path: /path/to/your/repo
       name: "My Repo"
       enabled: true
   ```

3. **Set up authentication:**

   **Option 1: AWS Bedrock (recommended)**
   ```bash
   export CLAUDE_CODE_USE_BEDROCK=1
   export ANTHROPIC_MODEL="global.anthropic.claude-sonnet-4-5-20250929-v1:0"
   export ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION="us-west-2"
   ```

   **Option 2: Direct Anthropic API**
   ```bash
   export ANTHROPIC_API_KEY="your-api-key"
   export ANTHROPIC_MODEL="claude-sonnet-4-5-20250929"
   ```

4. **Authenticate GitHub CLI:**
   ```bash
   gh auth login
   ```

## Verify Installation

```bash
# Check merge-god is installed
merge-god --help

# Check system status
merge-god status

# Should show:
#   ✓ Scripts available
#   ✓ Config exists
#   ✓ Database ready
```

## Development Installation

For development, install with optional dependencies:

```bash
# Using pip
pip install -e ".[dev]"

# Using UV
uv pip install -e ".[dev]"
```

This installs additional tools:
- pytest - for running tests
- pytest-asyncio - for async test support
- ruff - for code linting and formatting

## Building from Source

To build the package yourself:

```bash
# Using UV (recommended)
uv build

# Using build
pip install build
python -m build
```

This creates:
- `dist/merge_god-0.1.0-py3-none-any.whl` - Wheel distribution
- `dist/merge_god-0.1.0.tar.gz` - Source distribution

## Uninstallation

```bash
pip uninstall merge-god
```

## Troubleshooting

### Import Errors

If you get import errors after installation:

```bash
# Check installation
pip show merge-god

# Verify package contents
python -c "import merge_god; print(merge_god.__version__)"
```

### Command Not Found

If CLI commands are not found after installation:

```bash
# Check where pip installs scripts
python -m site --user-base

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
export PATH="$HOME/.local/bin:$PATH"

# Or use python -m
python -m merge_god.cli --help
```

### Permission Errors

If you get permission errors during installation:

```bash
# Install for current user only
pip install --user merge-god

# Or use a virtual environment (recommended)
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install merge-god
```

## Virtual Environment Setup

Using a virtual environment is recommended:

```bash
# Create virtual environment
python3.12 -m venv venv

# Activate it
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install merge-god
pip install merge-god

# When done, deactivate
deactivate
```

## Requirements

- Python ≥ 3.12
- Git
- GitHub CLI (`gh`)
- Claude API access (Bedrock or direct API)

## Next Steps

After installation:

1. **Configure your repositories** - Edit `config.yaml`
2. **Set up authentication** - Configure Anthropic API
3. **Authenticate GitHub** - Run `gh auth login`
4. **Test the system** - Run `merge-god status`
5. **Read the docs** - See [AGENT_TESTING_GUIDE.md](AGENT_TESTING_GUIDE.md)

## Getting Help

```bash
# Main CLI help
merge-god help

# Command-specific help
merge-god dashboard --help
merge-god agent --help
merge-god sync --help

# Show system status
merge-god status
```

## Links

- Documentation: See README.md
- Testing Guide: See AGENT_TESTING_GUIDE.md
- Issues: https://github.com/yourusername/merge-god/issues
