#!/usr/bin/env node
/**
 * Process Flow Validation Script (port of tests/validate_process_flow.py).
 *
 * Validates that data flows correctly through the 3 processes:
 *   1. PR/branch scanning -> Database
 *   2. Database -> PRContext preparation
 *   3. PRContext -> Agent invocation
 *
 * Checks the database schema, required tables, PR context completeness, data
 * load/transform, and process boundaries. Uses `SyncStore` from
 * `@merge-god/github-sync`.
 *
 * Referenced by merge-god.ts `validate` command (`tests/validate_process_flow.ts`).
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { SyncStore } from "@merge-god/github-sync";
import { prAgentContextFromDict } from "../pr_agent_context_model";
import { validateAgentReplayContext } from "../pr_context_validation_model";

/** Per-process validation result (mirrors types.ts ValidationResult). */
interface ValidationResult {
  name: string;
  valid: boolean;
  errors: string[];
  note?: string;
  pr_count?: number;
}

interface ProcessValidationResults {
  process_1: ValidationResult;
  process_2: ValidationResult;
  process_3: ValidationResult;
}

/** Render an unknown caught value as a message string. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Validate that the database has all required tables.
 * Returns a tuple of [success, errors].
 */
export function validateDatabaseSchema(db: SyncStore): [boolean, string[]] {
  const errors: string[] = [];
  const tables = [
    "repositories",
    "pull_requests",
    "processing_history",
    "dashboard_state",
    "branch_states",
    "pr_context", // Critical for process isolation
  ];

  let conn: DatabaseSync;
  try {
    conn = new DatabaseSync(db.dbPath);
  } catch (e) {
    return [false, [`Database schema validation failed: ${errMsg(e)}`]];
  }
  try {
    for (const table of tables) {
      try {
        conn.prepare(`SELECT COUNT(*) FROM ${table}`).get();
      } catch (e) {
        errors.push(`Table '${table}' is missing or invalid: ${errMsg(e)}`);
      }
    }
  } finally {
    conn.close();
  }
  return [errors.length === 0, errors];
}

/**
 * Validate that PR context has all required fields for agent invocation.
 * Returns a tuple of [success, errors].
 */
export async function validatePrContextCompleteness(
  repoName: string,
  prNumber: number,
  db: SyncStore,
): Promise<[boolean, string[]]> {
  const errors: string[] = [];

  if (!repoName || typeof repoName !== "string") {
    errors.push("repo_name must be a non-empty string");
    return [false, errors];
  }
  if (typeof prNumber !== "number" || prNumber <= 0) {
    errors.push(`pr_number must be a positive integer, got: ${prNumber}`);
    return [false, errors];
  }

  try {
    // PROCESS 1 -> PROCESS 2 boundary check
    const result = await db.getPrContextForAgent(repoName, prNumber);
    if (!result) {
      errors.push(`No PR context found for ${repoName} PR #${prNumber}`);
      return [false, errors];
    }

    const [prDetails, prContext] = result;

    errors.push(...validateAgentReplayContext(prDetails, prContext));

    // PROCESS 2 -> PROCESS 3 boundary check
    try {
      const prContextObj = prAgentContextFromDict(prDetails, prContext);
      const requiredAttrs = [
        "pr_number",
        "title",
        "head_branch",
        "base_branch",
        "author",
        "url",
        "diff",
        "has_conflicts",
        "has_failing_ci",
        "review_comments",
        "general_comments",
        "changed_files",
        "commits",
        "guidelines",
        "commit_examples",
      ];
      for (const attr of requiredAttrs) {
        if (!(attr in prContextObj)) {
          errors.push(`PRContext missing required attribute: ${attr}`);
        }
      }
    } catch (e) {
      errors.push(`Failed to create PRContext object: ${errMsg(e)}`);
    }

    return [errors.length === 0, errors];
  } catch (e) {
    return [false, [`PR context validation failed: ${errMsg(e)}`]];
  }
}

/** Validate outputs of each process. Returns per-process validation results. */
export async function validateProcessOutputs(
  db: SyncStore,
  repoName: string,
): Promise<ProcessValidationResults> {
  const results: ProcessValidationResults = {
    process_1: { name: "PR/Branch Scanning", valid: false, errors: [] },
    process_2: { name: "Context Preparation", valid: false, errors: [] },
    process_3: { name: "Agent Invocation", valid: false, errors: [] },
  };

  // Process 1: data is being saved.
  try {
    const prs = await db.getActivePrs(repoName);
    if (prs.length === 0) {
      results.process_1.errors.push(
        "No PR snapshots found. Process 1 may not be running or saving data.",
      );
    } else {
      results.process_1.valid = true;
      results.process_1.pr_count = prs.length;
    }

    let hasContext = false;
    for (const pr of prs.slice(0, 5)) {
      const context = await db.getLatestPrContext(repoName, pr["pr_number"] as number);
      if (context) {
        hasContext = true;
        break;
      }
    }
    if (!hasContext && prs.length > 0) {
      results.process_1.errors.push(
        "PR snapshots exist but no PR context data. " +
          "Ensure pr-loop is using latest version that saves context.",
      );
    }
  } catch (e) {
    results.process_1.errors.push(`Process 1 validation error: ${errMsg(e)}`);
  }

  // Process 2: data can be loaded and transformed.
  try {
    const prs = await db.getActivePrs(repoName);
    if (prs.length > 0) {
      const prNumber = prs[0]!["pr_number"] as number;
      const [valid, errors] = await validatePrContextCompleteness(repoName, prNumber, db);
      if (valid) results.process_2.valid = true;
      else results.process_2.errors = errors;
    } else {
      results.process_2.errors.push("Cannot validate Process 2: no PRs available");
    }
  } catch (e) {
    results.process_2.errors.push(`Process 2 validation error: ${errMsg(e)}`);
  }

  // Process 3: agent can accept the data (structure check only).
  try {
    const prs = await db.getActivePrs(repoName);
    if (prs.length > 0) {
      const prNumber = prs[0]!["pr_number"] as number;
      const result = await db.getPrContextForAgent(repoName, prNumber);
      if (result) {
        const [prDetails, prContext] = result;
        const prContextObj = prAgentContextFromDict(prDetails, prContext);
        if ("pr_number" in prContextObj && "diff" in prContextObj) {
          results.process_3.valid = true;
          results.process_3.note =
            "PRContext structure is valid. " +
            "Use run_agent_from_db.ts to test actual agent invocation.";
        } else {
          results.process_3.errors.push("PRContext object missing required attributes");
        }
      } else {
        results.process_3.errors.push("Cannot load PR context for agent invocation");
      }
    } else {
      results.process_3.errors.push("Cannot validate Process 3: no PRs available");
    }
  } catch (e) {
    results.process_3.errors.push(`Process 3 validation error: ${errMsg(e)}`);
  }

  return results;
}

/** Pretty-print validation results to stdout. */
export function printValidationResults(results: ProcessValidationResults): void {
  const bar = "=".repeat(70);
  console.log(`\n${bar}`);
  console.log("PROCESS FLOW VALIDATION RESULTS");
  console.log(`${bar}\n`);

  let overallSuccess = true;
  const keys = ["process_1", "process_2", "process_3"] as const;

  for (const key of keys) {
    const proc = results[key];
    const status = proc.valid ? "\u2713 PASS" : "\u2717 FAIL";
    console.log(`${proc.name}: ${status}`);

    if (!proc.valid) {
      overallSuccess = false;
      console.log("  Errors:");
      for (const error of proc.errors) console.log(`    - ${error}`);
    } else {
      if (proc.pr_count !== undefined) console.log(`  Found ${proc.pr_count} PRs`);
      if (proc.note !== undefined) console.log(`  Note: ${proc.note}`);
    }
    console.log();
  }

  console.log(bar);
  if (overallSuccess) {
    console.log("\u2713 All processes validated successfully!");
    console.log("\nYou can now:");
    console.log("  1. Run pr-loop to scan PRs (Process 1)");
    console.log("  2. Use run_agent_from_db to invoke agents (Process 3)");
  } else {
    console.log("\u2717 Some processes have validation errors");
    console.log("\nTo fix:");
    console.log("  1. Ensure pr-loop has run at least once");
    console.log("  2. Check that the database is being populated correctly");
    console.log("  3. Review error messages above");
  }
  console.log(`${bar}\n`);
}

/** Main validation entry point. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string", default: "merge-god-state.db" },
      repo: { type: "string" },
    },
  });

  const dbPath = values.db;
  const repo = values.repo;

  if (!repo) {
    console.error("Error: --repo is required");
    process.exit(1);
  }
  if (dbPath === undefined) {
    console.error("Error: --db path is required");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.log(`\u2717 Error: Database not found: ${dbPath}`);
    console.log("\nRun pr-loop first to create the database.");
    process.exit(1);
  }

  const db = new SyncStore(dbPath);
  try {
    await db.initialize();
  } catch (e) {
    console.log(`\u2717 Error: Failed to open database: ${errMsg(e)}`);
    await db.close();
    process.exit(1);
  }

  console.log("Validating database schema...");
  const [schemaValid, schemaErrors] = validateDatabaseSchema(db);
  if (!schemaValid) {
    console.log("\u2717 Database schema validation failed:");
    for (const error of schemaErrors) console.log(`  - ${error}`);
    console.log(
      "\nDatabase may be from an old version. Delete it and run pr-loop again.",
    );
    await db.close();
    process.exit(1);
  }

  console.log("\u2713 Database schema is valid\n");

  console.log(`Validating process outputs for repo: ${repo}...`);
  const results = await validateProcessOutputs(db, repo);
  printValidationResults(results);

  await db.close();

  const allValid =
    results.process_1.valid && results.process_2.valid && results.process_3.valid;
  process.exit(allValid ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.on("SIGINT", () => {
    console.log("\n\nValidation interrupted by user");
    process.exit(130);
  });
  main().catch((e: unknown) => {
    console.error(`\n\u2717 Fatal error: ${errMsg(e)}`);
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exit(1);
  });
}
