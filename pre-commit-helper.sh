#!/bin/bash
# Pre-commit helper script for merge-god
# Provides convenient shortcuts for common pre-commit operations

set -e

COMMAND="${1:-help}"

case "$COMMAND" in
    run|all)
        echo "Running pre-commit on all files..."
        pre-commit run --all-files
        ;;

    staged)
        echo "Running pre-commit on staged files..."
        pre-commit run
        ;;

    update)
        echo "Updating pre-commit hooks to latest versions..."
        pre-commit autoupdate
        ;;

    clean)
        echo "Cleaning pre-commit cache..."
        pre-commit clean
        ;;

    install)
        echo "Installing pre-commit hooks..."
        pre-commit install
        ;;

    uninstall)
        echo "Uninstalling pre-commit hooks..."
        pre-commit uninstall
        ;;

    hook)
        if [ -z "$2" ]; then
            echo "Error: Please specify a hook name"
            echo "Usage: $0 hook <hook-name>"
            exit 1
        fi
        echo "Running hook: $2"
        pre-commit run "$2" --all-files
        ;;

    help|--help|-h)
        cat << EOF
Pre-commit Helper Script for merge-god

Usage: $0 <command> [options]

Commands:
  run, all      Run pre-commit on all files
  staged        Run pre-commit on staged files only (default git behavior)
  update        Update hooks to latest versions
  clean         Clean pre-commit cache
  install       Install pre-commit hooks
  uninstall     Uninstall pre-commit hooks
  hook <name>   Run a specific hook on all files
  help          Show this help message

Examples:
  $0 run                  # Run all hooks on all files
  $0 staged               # Run hooks on staged files only
  $0 hook markdownlint    # Run only the markdownlint hook
  $0 update               # Update all hooks

Configured hooks:
  - trailing-whitespace, end-of-file-fixer, check-yaml, etc. (file checks)
  - markdownlint
  (TypeScript typecheck + node:test run via `just ci`, not as commit hooks.)
EOF
        ;;

    *)
        echo "Error: Unknown command '$COMMAND'"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac
