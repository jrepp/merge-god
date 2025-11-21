# uv Support

All scripts in this project use [uv](https://github.com/astral-sh/uv) for Python execution and dependency management.

## What is uv?

**uv** is a modern, extremely fast Python package and project manager written in Rust. It's designed to replace pip, pip-tools, pipx, poetry, pyenv, and virtualenv with a single tool.

## Why uv?

### Performance
- ⚡ **10-100x faster** than pip
- 🚀 **Instant startup** with cached environments
- 💾 **Efficient caching** across projects

### Simplicity
- 📦 **No virtual environments** needed for scripts
- 🔧 **Single tool** for all Python needs
- 📝 **Inline metadata** (PEP 723) in scripts

### Reliability
- 🔒 **Reproducible** builds
- ✅ **Type-safe** dependency resolution
- 🎯 **Cross-platform** compatibility

## How Scripts Use uv

All Python scripts include this header:

```python
#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
```

### Shebang Breakdown

```python
#!/usr/bin/env -S uv run --quiet --script
```
- `#!/usr/bin/env -S` - Use env with `-S` flag for multi-arg shebang
- `uv run` - Execute script with uv
- `--quiet` - Suppress uv output
- `--script` - Treat as standalone script

```python
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
```
- PEP 723 inline script metadata
- `requires-python` - Minimum Python version
- `dependencies` - External packages (empty for this project)

## Scripts with uv Support

| Script | Purpose | Dependencies |
|--------|---------|--------------|
| **pr-loop.py** | Main PR processing loop | stdlib only |
| **test-prompt.py** | PR prompt preview utility | stdlib only |
| **test_fixes.py** | Unit tests for validation | stdlib only |

## Installation

### Install uv

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Via pip (not recommended but works)
pip install uv

# Via Homebrew
brew install uv

# Via cargo
cargo install --git https://github.com/astral-sh/uv uv
```

### Verify Installation

```bash
uv --version
# Should output: uv 0.5.x or later
```

## Usage

### Direct Execution

Scripts can be executed directly with the shebang:

```bash
./pr-loop.py /path/to/repo
./test_fixes.py
./test-prompt.py /path/to/repo 123
```

uv automatically:
1. Checks Python version requirement
2. Creates isolated environment if needed
3. Installs dependencies (none for this project)
4. Executes the script

### Explicit uv Execution

You can also run scripts explicitly with uv:

```bash
uv run pr-loop.py /path/to/repo
uv run test_fixes.py
uv run test-prompt.py /path/to/repo 123
```

## Adding Dependencies

If you need to add external dependencies to a script:

```python
#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.31.0",
#     "click>=8.1.0",
# ]
# ///
```

uv will automatically install and cache these dependencies.

## Benefits for This Project

### 1. No Setup Overhead
```bash
# Traditional approach
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python pr-loop.py

# With uv
./pr-loop.py  # Just works!
```

### 2. Consistent Environments
- Each script runs in its own isolated environment
- No conflicts between script dependencies
- Reproducible across machines

### 3. Fast Iteration
- First run: uv creates environment (~100ms)
- Subsequent runs: Instant from cache
- No activation/deactivation needed

### 4. Distribution
- Scripts are self-contained
- No separate requirements.txt
- Dependencies documented in script header

## Troubleshooting

### Script not executable
```bash
chmod +x pr-loop.py test-prompt.py test_fixes.py
```

### uv not found
```bash
# Check installation
which uv

# Add to PATH if needed
export PATH="$HOME/.local/bin:$PATH"  # Linux/macOS
```

### Python version mismatch
```bash
# uv will show clear error if Python < 3.12
# Install Python 3.12+ first
```

### Permission denied on macOS
```bash
# macOS may block scripts from internet
xattr -d com.apple.quarantine pr-loop.py
```

## Performance Comparison

| Operation | pip/venv | uv | Speedup |
|-----------|----------|-----|---------|
| Cold install | ~30s | ~300ms | **100x** |
| Warm execution | ~5s | ~10ms | **500x** |
| Dependency resolution | ~10s | ~100ms | **100x** |

## Learn More

- [uv Documentation](https://docs.astral.sh/uv/)
- [PEP 723 - Inline Script Metadata](https://peps.python.org/pep-0723/)
- [uv GitHub](https://github.com/astral-sh/uv)

## Migration from Traditional Python

If you want to run with traditional Python instead of uv:

```bash
# Works but slower and requires Python 3.12+
python3 pr-loop.py /path/to/repo
python3 test_fixes.py
python3 test-prompt.py /path/to/repo 123
```

Note: The scripts are standard Python and will work without uv, but you'll miss out on the performance and convenience benefits.
