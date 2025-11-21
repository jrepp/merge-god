#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Test script to generate and display the prompt for a specific PR without running bob.
Usage: ./test-prompt.py <repo_path> <pr_number>
"""

import os
import sys
import subprocess
from pathlib import Path

# Import functions from pr-loop.py by executing it in the same namespace
exec(Path("pr-loop.py").read_text())


def main():
    if len(sys.argv) != 3:
        print("Usage: ./test-prompt.py <repo_path> <pr_number>", file=sys.stderr)
        print("\nExamples:", file=sys.stderr)
        print("  ./test-prompt.py /path/to/repo 123", file=sys.stderr)
        print("  ./test-prompt.py . 456", file=sys.stderr)
        sys.exit(1)

    repo_path = Path(sys.argv[1]).resolve()

    # Validate repository
    if not validate_repository(repo_path):
        sys.exit(1)

    # Change to repository directory
    os.chdir(repo_path)

    try:
        pr_number = int(sys.argv[2])
    except ValueError:
        print(f"Error: '{sys.argv[2]}' is not a valid PR number", file=sys.stderr)
        sys.exit(1)

    print(f"Gathering context for PR #{pr_number}...\n", file=sys.stderr)

    # Get PR basic info
    returncode, stdout, stderr = run_command([
        "gh", "pr", "view", str(pr_number),
        "--json", "number,title,headRefName,baseRefName,url"
    ])

    if returncode != 0:
        print(f"Error fetching PR #{pr_number}: {stderr}", file=sys.stderr)
        sys.exit(1)

    import json
    pr_info = json.loads(stdout)

    # Get guidelines and commit examples
    guidelines = get_pr_guidelines()
    commit_examples = get_commit_history_examples() if not guidelines else ""

    # Gather context
    head_branch = pr_info["headRefName"]
    base_branch = pr_info.get("baseRefName", "main")
    url = pr_info["url"]

    pr_details, pr_context = gather_pr_context(pr_number, head_branch, base_branch, url)

    # Build prompt
    prompt = build_pr_prompt(pr_details, pr_context, guidelines, commit_examples)

    # Print summary to stderr
    print("\n" + "="*80, file=sys.stderr)
    print("PROMPT GENERATION SUMMARY", file=sys.stderr)
    print("="*80, file=sys.stderr)
    print(f"PR: #{pr_number} - {pr_info['title']}", file=sys.stderr)
    print(f"Branch: {head_branch} → {base_branch}", file=sys.stderr)
    print(f"Prompt size: {len(prompt)} characters", file=sys.stderr)
    print(f"Comments: {len(pr_context['comments'])}", file=sys.stderr)
    print(f"Review comments: {len(pr_context['review_comments'])}", file=sys.stderr)
    print(f"Commits: {len(pr_context['commits'])}", file=sys.stderr)
    print(f"Files changed: {len(pr_context['files'])}", file=sys.stderr)
    print(f"Has conflicts: {pr_context['conflicts'].get('has_conflicts', False)}", file=sys.stderr)
    print(f"CI checks: {pr_context['ci_status'].get('total_checks', 0)}", file=sys.stderr)
    print(f"Failed checks: {pr_context['ci_status'].get('failed', 0)}", file=sys.stderr)
    print("="*80, file=sys.stderr)
    print("\nGenerated prompt (stdout):\n", file=sys.stderr)

    # Print the actual prompt to stdout so it can be piped
    print(prompt)


if __name__ == "__main__":
    main()
