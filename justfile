# Justfile for merge-god local development automation
# Requires: just (https://github.com/casey/just), uv (https://docs.astral.sh/uv/)
# Install: brew install just && brew install uv

# Default recipe - show available commands
default:
    @just --list

# === CI and Quality Checks ===

# Run all CI checks locally (emulates GitHub Actions workflow)
ci: pre-commit-file-checks isort-check ruff-lint ruff-format-check mypy bandit markdownlint
    @echo "✅ All CI checks passed!"

# Run pre-commit file checks only (trailing whitespace, EOF, YAML, etc.)
pre-commit-file-checks:
    @echo "🔍 Running pre-commit file checks..."
    @pre-commit run --hook-stage manual trailing-whitespace --all-files
    @pre-commit run --hook-stage manual end-of-file-fixer --all-files
    @pre-commit run --hook-stage manual check-yaml --all-files
    @pre-commit run --hook-stage manual check-added-large-files --all-files
    @pre-commit run --hook-stage manual check-json --all-files
    @pre-commit run --hook-stage manual check-toml --all-files
    @pre-commit run --hook-stage manual check-merge-conflict --all-files
    @pre-commit run --hook-stage manual check-case-conflict --all-files
    @pre-commit run --hook-stage manual detect-private-key --all-files
    @pre-commit run --hook-stage manual mixed-line-ending --all-files

# Check import sorting with isort
isort-check:
    @echo "🔍 Checking import sorting..."
    @isort --profile black --check-only --diff .

# Fix import sorting with isort
isort-fix:
    @echo "🔧 Fixing import sorting..."
    @isort --profile black .

# Run Ruff linting
ruff-lint:
    @echo "🔍 Running Ruff linting..."
    @ruff check .

# Run Ruff linting with auto-fix
ruff-fix:
    @echo "🔧 Fixing Ruff issues..."
    @ruff check --fix .

# Check code formatting with Ruff
ruff-format-check:
    @echo "🔍 Checking code formatting..."
    @ruff format --check .

# Format code with Ruff
ruff-format:
    @echo "🔧 Formatting code..."
    @ruff format .

# Run mypy type checking
mypy:
    @echo "🔍 Running mypy type checking..."
    @uv run mypy merge_god/

# Run Bandit security checks
bandit:
    @echo "🔍 Running Bandit security checks..."
    @uv run bandit -c pyproject.toml -r . --exclude './.venv,./test_*.py,./tests'

# Run Markdown linting
markdownlint:
    @echo "🔍 Running Markdown linting..."
    @npx markdownlint --config .markdownlintrc --ignore node_modules --ignore .venv '**/*.md'

# Fix Markdown formatting
markdownlint-fix:
    @echo "🔧 Fixing Markdown formatting..."
    @npx markdownlint --config .markdownlintrc --ignore node_modules --ignore .venv --fix '**/*.md'

# Run all linters and formatters
lint: ruff-lint mypy bandit markdownlint
    @echo "✅ All linting checks passed!"

# Auto-fix all fixable issues
fix: isort-fix ruff-fix ruff-format markdownlint-fix
    @echo "✅ Auto-fixes applied!"

# === Testing ===

# Run all tests
test:
    @echo "🧪 Running tests..."
    @uv run pytest tests/ -v

# Run tests with coverage
test-coverage:
    @echo "🧪 Running tests with coverage..."
    @uv run pytest tests/ --cov=merge_god --cov-report=html --cov-report=term

# Run specific test file
test-file FILE:
    @echo "🧪 Running test file: {{FILE}}"
    @uv run pytest {{FILE}} -v

# Run tests matching pattern
test-pattern PATTERN:
    @echo "🧪 Running tests matching: {{PATTERN}}"
    @uv run pytest tests/ -k "{{PATTERN}}" -v

# Run tests and show output
test-verbose:
    @echo "🧪 Running tests (verbose)..."
    @uv run pytest tests/ -vv -s

# === Building and Publishing ===

# Build distribution packages
build:
    @echo "📦 Building distribution packages..."
    @uv run python -m build

# Build and check distribution
build-check: build
    @echo "🔍 Checking distribution..."
    @uv run twine check dist/*

# Publish to PyPI (requires credentials)
publish: build-check
    @echo "📤 Publishing to PyPI..."
    @uv run twine upload dist/*

# Publish to TestPyPI (for testing)
publish-test: build-check
    @echo "📤 Publishing to TestPyPI..."
    @uv run twine upload --repository testpypi dist/*

# === Installation and Setup ===

# Install package in development mode
install-dev:
    @echo "📥 Installing package in development mode..."
    @uv pip install -e .

# Install all development dependencies
install-deps:
    @echo "📥 Installing development dependencies..."
    @uv pip install -r requirements.txt
    @uv pip install build twine pytest pytest-cov pre-commit

# Install pre-commit hooks
install-hooks:
    @echo "🔗 Installing pre-commit hooks..."
    @pre-commit install
    @pre-commit install --hook-type commit-msg

# Uninstall pre-commit hooks
uninstall-hooks:
    @echo "🔗 Uninstalling pre-commit hooks..."
    @pre-commit uninstall
    @pre-commit uninstall --hook-type commit-msg

# Set up complete development environment
setup: install-deps install-dev install-hooks
    @echo "✅ Development environment setup complete!"

# === Cleanup ===

# Clean build artifacts
clean:
    @echo "🧹 Cleaning build artifacts..."
    @rm -rf build/
    @rm -rf dist/
    @rm -rf *.egg-info
    @rm -rf .pytest_cache/
    @rm -rf .mypy_cache/
    @rm -rf .ruff_cache/
    @rm -rf htmlcov/
    @rm -rf .coverage
    @find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
    @find . -type f -name "*.pyc" -delete
    @find . -type f -name "*.pyo" -delete

# Clean everything including database
clean-all: clean
    @echo "🧹 Cleaning all temporary files..."
    @rm -f merge-god-state.db
    @rm -f merge-god-dashboard.log
    @rm -f .DS_Store
    @find . -name ".DS_Store" -delete

# === Development Helpers ===

# Run the dashboard in non-TUI mode
dashboard:
    @echo "🖥️  Starting dashboard (non-TUI mode)..."
    @uv run python -m merge_god.dashboard | cat

# Run the dashboard in TUI mode
dashboard-tui:
    @echo "🖥️  Starting dashboard (TUI mode)..."
    @uv run python -m merge_god.dashboard

# Validate configuration file
validate-config FILE="config.yaml":
    @echo "✅ Validating configuration: {{FILE}}"
    @uv run python -m merge_god.validate {{FILE}}

# Sync PR context to database
sync-pr REPO PR:
    @echo "🔄 Syncing PR context for {{REPO}}#{{PR}}..."
    @uv run python -m merge_god.sync {{REPO}} {{PR}}

# Run agent from database
run-agent REPO PR:
    @echo "🤖 Running agent for {{REPO}}#{{PR}}..."
    @uv run python -m merge_god.run_agent {{REPO}} {{PR}}

# Show help for merge-god CLI
help:
    @uv run python -m merge_god --help

# === Git Helpers ===

# Show git status
status:
    @git status

# Show recent commits
log:
    @git log --oneline -10

# Create a new branch
branch NAME:
    @git checkout -b {{NAME}}

# === Documentation ===

# Serve documentation locally (if using mkdocs)
docs-serve:
    @echo "📚 Serving documentation..."
    @mkdocs serve

# Build documentation
docs-build:
    @echo "📚 Building documentation..."
    @mkdocs build

# === Quick Development Workflows ===

# Quick check before commit (fast checks only)
quick-check: ruff-lint ruff-format-check
    @echo "✅ Quick checks passed!"

# Full check before push (all checks)
full-check: ci test
    @echo "✅ All checks passed, ready to push!"

# Pre-commit workflow (fix + check)
pre-commit: fix lint
    @echo "✅ Ready to commit!"

# Watch mode - run tests on file changes (requires entr)
watch:
    @echo "👀 Watching for changes..."
    @find merge_god tests -name "*.py" | entr -c just test

# === Utilities ===

# Show lint statistics
lint-stats:
    @echo "📊 Lint statistics:"
    @ruff check . --statistics || true

# Count lines of code
loc:
    @echo "📊 Lines of code:"
    @find merge_god -name "*.py" -not -path "*/test_*" | xargs wc -l | tail -1

# Show project structure
tree:
    @tree -I '__pycache__|*.pyc|*.egg-info|.git|.mypy_cache|.ruff_cache|.pytest_cache' -L 3

# Check for security vulnerabilities with pip-audit (requires pip-audit)
security-audit:
    @echo "🔒 Running security audit..."
    @uv run pip-audit

# Update pre-commit hooks
update-hooks:
    @echo "🔄 Updating pre-commit hooks..."
    @pre-commit autoupdate

# Show Python and tool versions
versions:
    @echo "🐍 Python version:"
    @python --version
    @echo "\n📦 uv version:"
    @uv --version
    @echo "\n📦 Tool versions:"
    @ruff --version || echo "ruff not installed"
    @uv run mypy --version || echo "mypy not installed"
    @isort --version || echo "isort not installed"
    @uv run pytest --version || echo "pytest not installed"
    @pre-commit --version || echo "pre-commit not installed"
