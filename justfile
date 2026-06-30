# Justfile for merge-god local development automation
# Requires: just (https://github.com/casey/just), Node.js >= 22, npm
# Install: brew install just && brew install node

# Default recipe - show available commands
default:
    @just --list

# === CI and Quality Checks ===

# Run all CI checks locally (emulates GitHub Actions workflow)
ci:
    @npm run ci
    @echo "✅ All CI checks passed!"

# TypeScript typecheck (tsc --noEmit)
typecheck:
    @npm run typecheck

# Run the test suite (Node built-in test runner, tsx loader)
test:
    @npm test

# Run a single test file
test-file FILE:
    @echo "🧪 Running test file: {{FILE}}"
    @node --import tsx --test {{FILE}}

# Markdown linting
markdownlint:
    @npm run markdownlint

# Fix Markdown formatting
markdownlint-fix:
    @echo "🔧 Fixing Markdown formatting..."
    @npx markdownlint --config .markdownlintrc --ignore node_modules --ignore .venv --ignore site --fix '**/*.md'

# Run pre-commit file-check hooks (trailing whitespace, EOF, YAML, etc.)
pre-commit-file-checks:
    @echo "🔍 Running pre-commit file checks..."
    @pre-commit run --hook-stage manual trailing-whitespace --all-files
    @pre-commit run --hook-stage manual end-of-file-fixer --all-files
    @pre-commit run --hook-stage manual check-yaml --all-files
    @pre-commit run --hook-stage manual check-added-large-files --all-files
    @pre-commit run --hook-stage manual check-json --all-files
    @pre-commit run --hook-stage manual check-merge-conflict --all-files
    @pre-commit run --hook-stage manual check-case-conflict --all-files
    @pre-commit run --hook-stage manual detect-private-key --all-files
    @pre-commit run --hook-stage manual mixed-line-ending --all-files

# Alias: lint = typecheck + markdownlint
lint: typecheck markdownlint
    @echo "✅ Lint checks passed!"

# === Installation and Setup ===

# Install dependencies
install-deps:
    @echo "📥 Installing npm dependencies..."
    @npm install

# Install pre-commit hooks
install-hooks:
    @echo "🔗 Installing pre-commit hooks..."
    @pre-commit install

# Set up complete development environment
setup: install-deps install-hooks
    @echo "✅ Development environment setup complete!"

# === Running ===

# Run the TUI dashboard
dashboard:
    @npx tsx dashboard.ts

# Validate configuration
validate-config FILE="config.yaml":
    @npx tsx merge_god/validate.ts {{FILE}}

# Show system status
status:
    @npx tsx merge-god.ts status

# Run the per-repo processing loop
scan REPO:
    @npx tsx pr-loop.ts {{REPO}}

# Send approval to a running pr-loop
send-approval:
    @npx tsx send_approval.ts

# === Site (unchanged, Astro) ===

docs-serve:
    @cd site && npm run dev

docs-build:
    @cd site && npm run build

# === Cleanup ===

clean:
    @echo "🧹 Cleaning build artifacts..."
    @rm -rf node_modules/.cache
    @rm -f merge-god-state.db merge-god-dashboard.log .DS_Store
    @find . -name ".DS_Store" -delete 2>/dev/null || true

# === Quick Development Workflows ===

quick-check: typecheck
    @echo "✅ Quick checks passed!"

full-check: ci
    @echo "✅ All checks passed, ready to push!"

# Show tool versions
versions:
    @echo "📦 Node:" && node --version
    @echo "📦 npm:" && npm --version
    @echo "📦 TypeScript:" && npx tsc --version
    @echo "📦 tsx:" && npx tsx --version
