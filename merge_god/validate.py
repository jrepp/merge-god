#!/usr/bin/env python3
"""
Process Flow Validation Script

This script validates that data flows correctly through all 3 processes:
1. PR/branch scanning -> Database
2. Database -> PRContext preparation
3. PRContext -> Agent invocation

It checks:
- Database schema is correct
- All required tables exist
- PR context data is complete
- Data can be loaded and transformed
- Process boundaries are intact
"""

import sys
from pathlib import Path
from typing import Any

from .agents import PRContext
from .db_operations import StateDatabase


def validate_database_schema(db: StateDatabase) -> tuple[bool, list[str]]:
    """
    Validate that database has all required tables and columns.

    Returns:
        Tuple of (success, errors)
    """
    errors = []

    try:
        # Test table access
        tables = [
            "repositories",
            "pull_requests",
            "processing_history",
            "dashboard_state",
            "branch_states",
            "pr_context",  # Critical for process isolation
        ]

        for table in tables:
            try:
                with db._get_connection() as conn:
                    cursor = conn.cursor()
                    cursor.execute(f"SELECT COUNT(*) FROM {table}")
                    cursor.fetchone()
            except Exception as e:
                errors.append(f"Table '{table}' is missing or invalid: {e}")

        return len(errors) == 0, errors

    except Exception as e:
        return False, [f"Database schema validation failed: {e}"]


def validate_pr_context_completeness(
    repo_name: str,
    pr_number: int,
    db: StateDatabase,
) -> tuple[bool, list[str]]:
    """
    Validate that PR context has all required fields for agent invocation.

    Returns:
        Tuple of (success, errors)
    """
    errors = []

    # Validate inputs
    if not repo_name or not isinstance(repo_name, str):
        errors.append("repo_name must be a non-empty string")
        return False, errors

    if not isinstance(pr_number, int) or pr_number <= 0:
        errors.append(f"pr_number must be a positive integer, got: {pr_number}")
        return False, errors

    try:
        # PROCESS 1 -> PROCESS 2 boundary check
        result = db.get_pr_context_for_agent(repo_name, pr_number)

        if not result:
            errors.append(f"No PR context found for {repo_name} PR #{pr_number}")
            return False, errors

        pr_details, pr_context = result

        # Validate pr_details structure
        required_pr_details = [
            "number", "title", "headRefName", "baseRefName", "author",
        ]
        for field in required_pr_details:
            if field not in pr_details:
                errors.append(f"Missing required field in pr_details: {field}")

        # Validate pr_context structure
        required_pr_context = [
            "url", "diff", "comments", "review_comments", "commits",
            "files", "conflicts", "ci_status", "guidelines", "commit_examples",
        ]
        for field in required_pr_context:
            if field not in pr_context:
                errors.append(f"Missing required field in pr_context: {field}")

        # Validate types and structure
        if not isinstance(pr_context.get("comments"), list):
            errors.append("pr_context['comments'] must be a list")
        if not isinstance(pr_context.get("review_comments"), list):
            errors.append("pr_context['review_comments'] must be a list")
        if not isinstance(pr_context.get("conflicts"), dict):
            errors.append("pr_context['conflicts'] must be a dict")
        if not isinstance(pr_context.get("ci_status"), dict):
            errors.append("pr_context['ci_status'] must be a dict")

        # Validate author structure
        if "author" in pr_details:
            if not isinstance(pr_details["author"], dict):
                errors.append("pr_details['author'] must be a dict")
            elif "login" not in pr_details["author"]:
                errors.append("pr_details['author'] must have 'login' field")

        # Validate labels is a list
        if "labels" in pr_details and not isinstance(pr_details["labels"], list):
            errors.append("pr_details['labels'] must be a list")

        # PROCESS 2 -> PROCESS 3 boundary check
        try:
            pr_context_obj = PRContext.from_dict(pr_details, pr_context)

            # Validate PRContext has required attributes
            required_attrs = [
                "pr_number", "title", "head_branch", "base_branch",
                "author", "url", "diff", "has_conflicts", "has_failing_ci",
                "review_comments", "general_comments", "changed_files",
                "commits", "guidelines", "commit_examples",
            ]

            for attr in required_attrs:
                if not hasattr(pr_context_obj, attr):
                    errors.append(f"PRContext missing required attribute: {attr}")

        except Exception as e:
            errors.append(f"Failed to create PRContext object: {e}")

        return len(errors) == 0, errors

    except Exception as e:
        return False, [f"PR context validation failed: {e}"]


def validate_process_outputs(db: StateDatabase, repo_name: str) -> dict[str, Any]:
    """
    Validate outputs of each process.

    Returns:
        Dictionary with validation results for each process
    """
    results: dict[str, Any] = {
        "process_1": {"name": "PR/Branch Scanning", "valid": False, "errors": []},
        "process_2": {"name": "Context Preparation", "valid": False, "errors": []},
        "process_3": {"name": "Agent Invocation", "valid": False, "errors": []},
    }

    # Process 1: Check if data is being saved
    try:
        # Check if we have any PR snapshots
        prs = db.get_active_prs(repo_name)
        if len(prs) == 0:
            results["process_1"]["errors"].append(
                "No PR snapshots found. Process 1 may not be running or saving data.",
            )
        else:
            results["process_1"]["valid"] = True
            results["process_1"]["pr_count"] = len(prs)

        # Check if we have PR context data
        has_context = False
        for pr in prs[:5]:  # Check first 5
            context = db.get_latest_pr_context(repo_name, pr["pr_number"])
            if context:
                has_context = True
                break

        if not has_context and len(prs) > 0:
            results["process_1"]["errors"].append(
                "PR snapshots exist but no PR context data. "
                "Ensure pr-loop.py is using latest version that saves context.",
            )

    except Exception as e:
        results["process_1"]["errors"].append(f"Process 1 validation error: {e}")

    # Process 2: Check if data can be loaded and transformed
    try:
        prs = db.get_active_prs(repo_name)
        if len(prs) > 0:
            pr_number = prs[0]["pr_number"]
            valid, errors = validate_pr_context_completeness(repo_name, pr_number, db)

            if valid:
                results["process_2"]["valid"] = True
            else:
                results["process_2"]["errors"] = errors
        else:
            results["process_2"]["errors"].append(
                "Cannot validate Process 2: no PRs available",
            )

    except Exception as e:
        results["process_2"]["errors"].append(f"Process 2 validation error: {e}")

    # Process 3: Check if agent can accept the data (structure check only)
    try:
        prs = db.get_active_prs(repo_name)
        if len(prs) > 0:
            pr_number = prs[0]["pr_number"]
            result = db.get_pr_context_for_agent(repo_name, pr_number)

            if result:
                pr_details, pr_context = result
                # Try to create PRContext (what agent needs)
                pr_context_obj = PRContext.from_dict(pr_details, pr_context)

                # Validate it has expected structure
                if hasattr(pr_context_obj, "pr_number") and hasattr(pr_context_obj, "diff"):
                    results["process_3"]["valid"] = True
                    results["process_3"]["note"] = (
                        "PRContext structure is valid. "
                        "Use run_agent_from_db.py to test actual agent invocation."
                    )
                else:
                    results["process_3"]["errors"].append(
                        "PRContext object missing required attributes",
                    )
            else:
                results["process_3"]["errors"].append(
                    "Cannot load PR context for agent invocation",
                )
        else:
            results["process_3"]["errors"].append(
                "Cannot validate Process 3: no PRs available",
            )

    except Exception as e:
        results["process_3"]["errors"].append(f"Process 3 validation error: {e}")

    return results


def print_validation_results(results: dict[str, Any]) -> None:
    """Pretty print validation results"""
    print("\n" + "=" * 70)
    print("PROCESS FLOW VALIDATION RESULTS")
    print("=" * 70 + "\n")

    overall_success = True

    for process_key in ["process_1", "process_2", "process_3"]:
        process = results[process_key]
        status = "✓ PASS" if process["valid"] else "✗ FAIL"
        print(f"{process['name']}: {status}")

        if not process["valid"]:
            overall_success = False
            print("  Errors:")
            for error in process["errors"]:
                print(f"    - {error}")
        else:
            if "pr_count" in process:
                print(f"  Found {process['pr_count']} PRs")
            if "note" in process:
                print(f"  Note: {process['note']}")

        print()

    print("=" * 70)
    if overall_success:
        print("✓ All processes validated successfully!")
        print("\nYou can now:")
        print("  1. Run pr-loop.py to scan PRs (Process 1)")
        print("  2. Use run_agent_from_db.py to invoke agents (Process 3)")
        print("  3. Run test_process_isolation.py for unit tests")
    else:
        print("✗ Some processes have validation errors")
        print("\nTo fix:")
        print("  1. Ensure pr-loop.py has run at least once")
        print("  2. Check that database is being populated correctly")
        print("  3. Review error messages above")
    print("=" * 70 + "\n")


def main() -> None:
    """Main validation entry point"""
    import argparse

    parser = argparse.ArgumentParser(
        description="Validate data flow between the 3 processes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
This script validates that:
1. Database schema is correct
2. Process 1 is saving PR data correctly
3. Process 2 can load and transform data
4. Process 3 can accept PRContext objects

Example:
  ./validate_process_flow.py --db merge-god-state.db --repo merge-god
        """,
    )

    parser.add_argument(
        "--db",
        type=Path,
        default=Path("merge-god-state.db"),
        help="Path to SQLite database (default: merge-god-state.db)",
    )

    parser.add_argument(
        "--repo",
        required=True,
        help="Repository name to validate",
    )

    args = parser.parse_args()

    # Validate database exists
    if not args.db.exists():
        print(f"✗ Error: Database not found: {args.db}")
        print("\nRun pr-loop.py first to create the database.")
        sys.exit(1)

    try:
        db = StateDatabase(args.db)
    except Exception as e:
        print(f"✗ Error: Failed to open database: {e}")
        sys.exit(1)

    # Validate schema
    print("Validating database schema...")
    schema_valid, schema_errors = validate_database_schema(db)

    if not schema_valid:
        print("✗ Database schema validation failed:")
        for error in schema_errors:
            print(f"  - {error}")
        print("\nDatabase may be from an old version. Delete it and run pr-loop.py again.")
        sys.exit(1)

    print("✓ Database schema is valid\n")

    # Validate process outputs
    print(f"Validating process outputs for repo: {args.repo}...")
    results = validate_process_outputs(db, args.repo)

    # Print results
    print_validation_results(results)

    # Exit with appropriate code
    all_valid = all(results[k]["valid"] for k in ["process_1", "process_2", "process_3"])
    sys.exit(0 if all_valid else 1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nValidation interrupted by user")
        sys.exit(130)
    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
