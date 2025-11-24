# Development Guide

This guide covers development best practices, tooling, and workflow for the merge-god repository.

---

## Quick Start

### Install Development Dependencies

```bash
# Using pip
pip install -e ".[dev]"

# Using UV (recommended)
uv pip install -e ".[dev]"
```

This installs:

- pytest - Test framework
- pytest-asyncio - Async test support
- ruff - Linting and formatting
- mypy - Type checking
- pre-commit - Git hooks
- types-PyYAML - Type stubs

### Install Pre-commit Hooks

```bash
pre-commit install
```

This ensures code quality checks run automatically before each commit.

---

## Code Quality Tools

### Ruff - Linting and Formatting

**Fast Python linter and formatter** replacing multiple tools (black, isort, flake8, etc.)

```bash
# Check for issues
ruff check .

# Auto-fix issues
ruff check --fix .

# Format code
ruff format .

# Check formatting without changing
ruff format --check .
```

**Configuration:** See `[tool.ruff]` in `pyproject.toml`

**Key rules enabled:**

- E/W - pycodestyle (PEP 8 compliance)
- F - pyflakes (logical errors)
- I - isort (import sorting)
- B - bugbear (common bugs)
- S - security checks (bandit)
- PL - pylint rules
- Many more (see pyproject.toml)

**What it catches:**

- Style violations
- Unused imports
- Security issues
- Performance problems
- Code complexity
- Import order

---

### Mypy - Static Type Checking

**Optional but recommended** for catching type errors before runtime.

```bash
# Type check the package
mypy merge_god/

# Type check specific file
mypy merge_god/agents/claude_agent.py
```

**Configuration:** See `[tool.mypy]` in `pyproject.toml`

**Settings:**

- Python 3.12 target
- Permissive mode (not requiring all type hints)
- Checks existing type hints thoroughly
- Ignores external libraries without stubs

---

### Pre-commit Hooks

**Automated checks** that run before each commit.

```bash
# Install hooks
pre-commit install

# Run manually on all files
pre-commit run --all-files

# Run specific hook
pre-commit run ruff --all-files

# Update hooks to latest versions
pre-commit autoupdate
```

**Hooks configured:**

1. **File checks** - trailing whitespace, EOF, large files
2. **Format checks** - YAML, JSON, TOML validation
3. **Security** - detect private keys, merge conflicts
4. **Ruff** - linting and formatting
5. **Mypy** - type checking (skipped in CI for speed)
6. **Bandit** - security scanning
7. **Markdown** - documentation linting

**Configuration:** See `.pre-commit-config.yaml`

---

## Development Workflow

### Making Changes

1. **Create a branch**

   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make your changes**
   - Edit code
   - Add tests
   - Update documentation

3. **Run quality checks**

   ```bash
   # Format code
   ruff format .

   # Fix linting issues
   ruff check --fix .

   # Type check (if you added type hints)
   mypy merge_god/

   # Run tests
   pytest
   ```

4. **Commit changes**

   ```bash
   git add .
   git commit -m "Add feature X"
   ```

   Pre-commit hooks will run automatically. If they fail:
   - Review the errors
   - Fix issues
   - Stage changes again
   - Retry commit

5. **Push and create PR**

   ```bash
   git push origin feature/my-feature
   ```

---

## Testing

### Running Tests

```bash
# All tests
pytest

# Specific test file
pytest test_db_operations.py

# Specific test function
pytest test_db_operations.py::test_save_pr_context -v

# With coverage
pytest --cov=merge_god

# Using merge-god CLI
merge-god test
merge-god test --type isolation
merge-god test --type db
merge-god test --type agent
```

### Test Organization

- `test_*.py` - Unit and integration tests
- `test_process_isolation.py` - Process boundary tests
- `test_db_operations.py` - Database tests
- `test_agent_integration.py` - Agent workflow tests

### Writing Tests

```python
import pytest
from merge_god.db_operations import StateDatabase

def test_feature():
    # Arrange
    db = StateDatabase(":memory:")

    # Act
    result = db.some_operation()

    # Assert
    assert result is not None
```

---

## Code Standards

### Style Guide

- **Line length**: 100 characters max
- **Python version**: 3.12+
- **Indentation**: 4 spaces (no tabs)
- **Quotes**: Double quotes for strings (enforced by ruff)
- **Imports**: Sorted automatically by ruff (stdlib, third-party, local)

### Import Order

Automatically sorted by ruff:

```python
# 1. Standard library
import json
import sys
from pathlib import Path

# 2. Third-party
import yaml
from anthropic import AsyncAnthropic

# 3. Local
from .models import PRContext
from .db_operations import StateDatabase
```

### Type Hints

**Optional but encouraged:**

```python
def process_pr(pr_number: int, repo_path: Path) -> ProcessingResult:
    """Process a pull request."""
    ...
```

### Docstrings

Use for public APIs:

```python
def important_function(arg: str) -> bool:
    """
    Short description.

    Longer description if needed.

    Args:
        arg: Description of argument

    Returns:
        Description of return value
    """
    ...
```

---

## Common Tasks

### Fix Linting Errors

```bash
# See what's wrong
ruff check .

# Auto-fix what can be fixed
ruff check --fix .

# Some issues need manual fixes
ruff check . --show-fixes
```

### Format Code

```bash
# Format all Python files
ruff format .

# Format specific file
ruff format merge_god/cli.py

# Check if formatted (CI)
ruff format --check .
```

### Type Check Code

```bash
# Check all code
mypy merge_god/

# Check specific module
mypy merge_god/agents/

# Ignore specific errors
mypy merge_god/ --disable-error-code=import-untyped
```

### Run Pre-commit on All Files

```bash
# Useful after updating hooks
pre-commit run --all-files
```

### Update Dependencies

```bash
# Update pre-commit hooks
pre-commit autoupdate

# Update Python dependencies
uv pip compile pyproject.toml --upgrade
```

---

## CI/CD

### CI Checks (Future)

When CI is set up, these checks will run:

1. **Linting** - `ruff check .`
2. **Formatting** - `ruff format --check .`
3. **Type checking** - `mypy merge_god/`
4. **Tests** - `pytest`
5. **Security** - `bandit -r merge_god/`
6. **Package build** - `uv build`

### Local CI Simulation

Run all checks locally before pushing:

```bash
#!/bin/bash
# save as check_all.sh

set -e

echo "🔍 Running linting..."
ruff check .

echo "📝 Checking formatting..."
ruff format --check .

echo "🔬 Type checking..."
mypy merge_god/ || echo "⚠️  Type check warnings (non-blocking)"

echo "🧪 Running tests..."
pytest

echo "📦 Testing package build..."
uv build

echo "✅ All checks passed!"
```

---

## Troubleshooting

### Pre-commit Hooks Failing

**Issue:** Hooks fail on commit

**Solutions:**

```bash
# See what failed
git commit -m "message"  # Read the output

# Fix automatically if possible
ruff check --fix .
ruff format .

# Retry commit
git commit -m "message"

# Skip hooks if absolutely necessary (not recommended)
git commit --no-verify -m "message"
```

### Ruff Errors

**Issue:** `E501 line too long`

**Solution:**

- We ignore this in config, but sometimes appears
- Break long lines:

  ```python
  # Before
  result = some_function(very_long_arg1, very_long_arg2, very_long_arg3)

  # After
  result = some_function(
      very_long_arg1,
      very_long_arg2,
      very_long_arg3,
  )
  ```

**Issue:** `F401 imported but unused`

**Solution:** Remove the import or add `# noqa: F401` if needed for re-export

**Issue:** `I001 import block unsorted`

**Solution:** Run `ruff check --fix .` to auto-sort

### Mypy Errors

**Issue:** `error: Cannot find implementation or library stub`

**Solution:**

- Add to `[tool.mypy.overrides]` in pyproject.toml:

  ```toml
  [[tool.mypy.overrides]]
  module = ["problematic_module"]
  ignore_missing_imports = true
  ```

**Issue:** Too many type errors

**Solution:**

- Mypy is optional and permissive in this project
- Focus on typing new code
- Add `# type: ignore` for legacy code

### Test Failures

**Issue:** Tests fail locally

**Solutions:**

```bash
# Run with verbose output
pytest -v

# Run specific test
pytest test_file.py::test_function -v

# See full output (no capture)
pytest -s

# Drop into debugger on failure
pytest --pdb
```

---

## Agent Prompts

The Claude Agent is now aware of these development tools and will:

- Run `ruff check --fix .` before committing
- Run `ruff format .` to format code
- Run `pytest` to verify tests
- Run `mypy merge_god/` for type checking
- Use these tools when fixing CI failures
- Include quality checks in code reviews

**Agent guidelines location:** `agents/claude_agent.py` → `PRAgent.DEV_GUIDELINES`

---

## Resources

- **Ruff docs**: <https://docs.astral.sh/ruff/>
- **Mypy docs**: <https://mypy.readthedocs.io/>
- **Pre-commit docs**: <https://pre-commit.com/>
- **Pytest docs**: <https://docs.pytest.org/>

---

## Quick Reference

```bash
# Daily workflow
ruff format .           # Format code
ruff check --fix .      # Fix linting
pytest                  # Run tests
git commit -m "msg"     # Commit (hooks run automatically)

# Before PR
ruff check .            # Check linting (no auto-fix)
ruff format --check .   # Check formatting
mypy merge_god/         # Type check
pytest                  # All tests
merge-god validate      # Process validation

# Maintenance
pre-commit autoupdate   # Update hooks
pre-commit run --all    # Run all hooks manually
```

---

**Last Updated:** 2025-11-23
**Version:** 0.1.0
