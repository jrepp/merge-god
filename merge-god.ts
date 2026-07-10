#!/usr/bin/env node
/**
 * merge-god - Unified CLI for PR automation pipeline.
 *
 * Ported from merge-god.py. A unified interface to run and test all components
 * of the merge-god pipeline. Each subcommand shells out to a sibling .ts script
 * (process isolation is intentional, matching the Python design).
 *
 *   Process 1: PR/branch scanning and state management
 *   Process 2: PR context gathering and database caching
 *   Process 3: Agent invocation and PR processing
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import YAML from "yaml";

function nowIso(): string {
  return new Date().toISOString();
}

function logJson(eventType: string, data: Record<string, unknown>): void {
  const entry = { timestamp: nowIso().replace("+00:00", "Z"), event: eventType, data };
  console.log(JSON.stringify(entry));
}

type LogLevel = "info" | "success" | "warning" | "error";

function logText(message: string, level: LogLevel = "info"): void {
  const colors: Record<LogLevel, (s: string) => string> = {
    info: chalk.cyan,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
  };
  const prefix: Record<LogLevel, string> = {
    info: "i",
    success: String.fromCharCode(0x2713),
    warning: String.fromCharCode(0x26a0),
    error: String.fromCharCode(0x2717),
  };
  console.error(colors[level](`${prefix[level]} ${message}`));
}

/** Run a sibling .ts script in a child process (process isolation). */
function runChild(script: string, args: string[]): number {
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      stdio: "inherit",
    });
    if (result.error) {
      logText(`Failed to start ${script}: ${result.error.message}`, "error");
      return 1;
    }
    return result.status ?? 1;
  } catch (e) {
    logText(`Failed to run ${script}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return 1;
  }
}

function resolvePath(p: string | undefined, fallback: string): string {
  if (!p) return resolve(fallback);
  return isAbsolute(p) ? p : resolve(p);
}

function inferRepoName(repoPath: string | undefined): string {
  return basename(resolvePath(repoPath, "."));
}

interface GlobalArgs {
  config?: string;
  db?: string;
  command: string | undefined;
  rest: string[];
}

function parseGlobal(argv: string[]): GlobalArgs {
  // Extract optional --config/--db (globals) and the first positional subcommand.
  const rest: string[] = [];
  let config: string | undefined;
  let db: string | undefined;
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "--db") {
      const val = argv[++i];
      if (a === "--config") config = val;
      else db = val;
    } else if (a.startsWith("--config=")) {
      config = a.slice("--config=".length);
    } else if (a.startsWith("--db=")) {
      db = a.slice("--db=".length);
    } else if (!command && !a.startsWith("-")) {
      command = a;
    } else {
      rest.push(a);
    }
  }
  return { config, db, command, rest };
}

function cmdDashboard(g: GlobalArgs): number {
  logText("Starting merge-god dashboard...");
  const configPath = resolvePath(g.config, "config.yaml");
  const args = ["dashboard.ts", configPath];
  const parsed = parseArgs({
    args: g.rest,
    options: {
      "non-interactive": { type: "boolean", default: false },
      "log-file": { type: "string" },
      screen: { type: "string" },
    },
    allowPositionals: true,
  });
  if (parsed.values["non-interactive"]) args.push("--non-interactive");
  if (parsed.values["log-file"]) args.push("--log-file", parsed.values["log-file"]);
  if (parsed.values.screen) args.push("--screen", parsed.values.screen);
  try {
    return runChild(args[0]!, args.slice(1));
  } catch (e) {
    if (isKeyboardInterrupt(e)) {
      logText("Dashboard interrupted by user", "warning");
      return 130;
    }
    logText(`Failed to start dashboard: ${errMsg(e)}`, "error");
    return 1;
  }
}

function cmdDoctor(g: GlobalArgs): number {
  const args = ["doctor", ...g.rest];
  if (g.config) args.push("--config", g.config);
  return runChild("merge_god/cli.ts", args);
}

function cmdScan(g: GlobalArgs): number {
  logText("Scanning and caching PR context...");
  const parsed = parseArgs({
    args: g.rest,
    options: {
      config: { type: "string" },
      db: { type: "string" },
      repo: { type: "string" },
      "repo-path": { type: "string" },
      pr: { type: "string" },
    },
    allowPositionals: true,
  });
  const args = ["sync_pr_context.ts"];
  const config = parsed.values.config ?? g.config;
  const db = parsed.values.db ?? g.db;
  if (config) args.push("--config", config);
  if (db) args.push("--db", db);
  if (parsed.values.repo) args.push("--repo", parsed.values.repo);
  if (parsed.values["repo-path"]) {
    args.push("--repo-path", parsed.values["repo-path"]);
    if (!parsed.values.repo) args.push("--repo", inferRepoName(parsed.values["repo-path"]));
  }
  if (parsed.values.pr) args.push("--pr", parsed.values.pr);
  const rc = runChild(args[0]!, args.slice(1));
  if (rc === 0) logText("PR context synced successfully", "success");
  else logText(`Sync failed with exit code ${rc}`, "error");
  return rc;
}

function cmdAgent(g: GlobalArgs): number {
  const parsed = parseArgs({
    args: g.rest,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      mode: { type: "string" },
      runtime: { type: "string" },
      timeout: { type: "string" },
      db: { type: "string" },
      "repo-path": { type: "string" },
    },
    allowPositionals: true,
  });
  const repo = parsed.values.repo ?? inferRepoName(parsed.values["repo-path"]);
  const pr = parsed.values.pr;
  if (!pr) {
    logText("--pr is required for agent command", "error");
    return 1;
  }
  logText(`Running agent for ${repo} PR #${pr}...`);
  const args = ["run_agent_from_db.ts", repo, pr, "--mode", parsed.values.mode ?? "for-landing"];
  if (parsed.values.runtime) args.push("--runtime", parsed.values.runtime);
  if (parsed.values.timeout) args.push("--timeout", parsed.values.timeout);
  const db = parsed.values.db ?? g.db;
  if (db) args.push("--db", db);
  if (parsed.values["repo-path"]) args.push("--repo-path", parsed.values["repo-path"]);
  const rc = runChild(args[0]!, args.slice(1));
  if (rc === 0) logText("Agent completed successfully", "success");
  else logText(`Agent failed with exit code ${rc}`, "error");
  return rc;
}

const PR_LOOP_VALUE_OPTIONS = new Set([
  "--max-iterations",
  "--idle-sleep-seconds",
  "--sync-failure-sleep-seconds",
  "--between-items-sleep-seconds",
]);

export function prLoopChildArgs(rest: string[]): string[] | null {
  let repoPathIndex = -1;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("-")) {
      const optionName = arg.split("=", 1)[0]!;
      if (!arg.includes("=") && PR_LOOP_VALUE_OPTIONS.has(optionName) && i + 1 < rest.length) i++;
      continue;
    }
    repoPathIndex = i;
    break;
  }
  if (repoPathIndex < 0) return null;
  return [rest[repoPathIndex]!, ...rest.slice(0, repoPathIndex), ...rest.slice(repoPathIndex + 1)];
}

function cmdPrLoop(g: GlobalArgs): number {
  const args = prLoopChildArgs(g.rest);
  if (!args) {
    logText("repo_path is required for pr-loop command", "error");
    return 1;
  }
  return runChild("pr-loop.ts", args);
}

function cmdValidate(g: GlobalArgs): number {
  logText("Validating process isolation and data flow...");
  const parsed = parseArgs({
    args: g.rest,
    options: { db: { type: "string" }, repo: { type: "string" }, pr: { type: "string" } },
    allowPositionals: true,
  });
  const args = ["tests/validate_process_flow.ts"];
  const db = parsed.values.db ?? g.db;
  if (db) args.push("--db", db);
  if (parsed.values.repo) args.push("--repo", parsed.values.repo);
  if (parsed.values.pr) args.push("--pr", parsed.values.pr);
  const rc = runChild(args[0]!, args.slice(1));
  if (rc === 0) logText("Validation passed", "success");
  else logText("Validation failed", "error");
  return rc;
}

function cmdTest(g: GlobalArgs): number {
  logText("Running test suite...");
  const parsed = parseArgs({
    args: g.rest,
    options: { type: { type: "string", default: "all" } },
    allowPositionals: true,
  });
  const testType = parsed.values.type ?? "all";
  let script: string | null = null;
  if (testType === "all") script = "tests/test_all.ts";
  else if (testType === "isolation") script = "tests/test_process_isolation.ts";
  else if (testType === "db") script = "tests/stores.test.ts";
  else if (testType === "agent") script = "tests/test_agent_integration.ts";
  else {
    logText(`Unknown test type: ${testType}`, "error");
    return 1;
  }
  // node:test runner
  const rc = spawnSync(process.execPath, ["--import", "tsx", "--test", script!], {
    stdio: "inherit",
  }).status ?? 1;
  if (rc === 0) logText("Tests passed", "success");
  else logText("Tests failed", "error");
  return rc;
}

function cmdStatus(g: GlobalArgs): number {
  logText("System Status", "info");
  const dbPath = resolvePath(g.db, "merge-god-state.db");
  const configPath = resolvePath(g.config, "config.yaml");

  if (existsSync(dbPath)) {
    const sizeKb = statSync(dbPath).size / 1024;
    logText(`Database: ${dbPath} (${sizeKb.toFixed(1)} KB)`, "success");
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const prCount = countRows(db, "pr_context");
        logText(`  Cached PRs: ${prCount}`, "info");
        const sessionCount = countRows(db, "agent_sessions");
        logText(`  Agent sessions: ${sessionCount}`, "info");
        const runCount = countRows(db, "orchestration_runs");
        logText(`  Orchestration runs: ${runCount}`, "info");
        if (runCount > 0) {
          const row = db
            .prepare(
              "SELECT repo_name, status, current_phase FROM orchestration_runs ORDER BY started_at DESC LIMIT 1",
            )
            .get() as { repo_name: string; status: string; current_phase: string } | undefined;
          if (row) {
            logText(`  Latest trajectory: ${row.repo_name} - ${row.status} (${row.current_phase})`, "info");
          }
        }
        if (sessionCount > 0) {
          const row = db
            .prepare(
              "SELECT repo_name AS repo, pr_number AS pr, status, success, duration_seconds AS duration FROM agent_sessions ORDER BY started_at DESC LIMIT 1",
            )
            .get() as { repo: string; pr: number; status: string; success: number; duration: number } | undefined;
          if (row) {
            const icon = row.success ? String.fromCharCode(0x2713) : String.fromCharCode(0x2717);
            logText(
              `  Last session: ${row.repo} PR #${row.pr} - ${row.status} ${icon} (${row.duration.toFixed(1)}s)`,
              "info",
            );
          }
        }
        const actionCount = countRows(db, "agent_actions");
        logText(`  Total actions: ${actionCount}`, "info");
      } finally {
        db.close();
      }
    } catch (e) {
      logText(`  Warning: Could not read database: ${errMsg(e)}`, "warning");
    }
  } else {
    logText(`Database: Not found at ${dbPath}`, "warning");
  }

  if (existsSync(configPath)) {
    logText(`Config: ${configPath}`, "success");
    try {
      const config = YAML.parse(readFileSync(configPath, "utf8")) as { repos?: { enabled?: boolean }[] } | null;
      const repos = config?.repos ?? [];
      const repoCount = repos.length;
      const enabledCount = repos.filter((r) => r.enabled ?? true).length;
      logText(`  Repositories: ${enabledCount}/${repoCount} enabled`, "info");
    } catch (e) {
      logText(`  Warning: Could not parse config: ${errMsg(e)}`, "warning");
    }
  } else {
    logText(`Config: Not found at ${configPath}`, "warning");
  }

  const scripts: [string, string][] = [
    ["dashboard.ts", "TUI Dashboard"],
    ["run_agent_from_db.ts", "Agent Runner"],
    ["sync_pr_context.ts", "PR Sync"],
    ["tests/validate_process_flow.ts", "Validator"],
  ];
  logText("Scripts:", "info");
  for (const [script, desc] of scripts) {
    if (existsSync(script)) logText(`  ${String.fromCharCode(0x2713)} ${desc}: ${script}`, "success");
    else logText(`  ${String.fromCharCode(0x2717)} ${desc}: ${script} (missing)`, "error");
  }

  return 0;
}

function countRows(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

const HELP_TEXT = `
merge-god - Unified CLI for PR automation pipeline

OVERVIEW:
  merge-god automates PR review and landing. It consists of 3 isolated processes:
    Process 1: PR/branch scanning and state management
    Process 2: PR context gathering and database caching
    Process 3: Agent invocation and PR processing

COMMANDS:
  (default)   Run the World HUD TUI dashboard.
  dashboard   Run the full TUI dashboard with all processes.
  scan        Scan PRs and sync their context to the database.
  agent       Run agent on cached PR data (Process 3 isolation).
  validate    Validate process boundaries and data flow.
  test        Run test suite (--type all|isolation|db|agent).
  status      Show system status and statistics.
  pr-loop     Run bounded or continuous PR processing loop.
  doctor      Check local prerequisites and config paths.
  help        Show this help message.

Dashboard screens: --screen world|prs|agents (default: world).
Quick self-test:
  tsx merge-god.ts scan --repo-path . --pr 14
  tsx merge-god.ts agent --repo-path . --pr 14 --mode for-review
  tsx merge-god.ts pr-loop . --once --dry-run
Run 'tsx merge-god.ts help' for details.
`;

function cmdHelp(): number {
  console.log(HELP_TEXT);
  return 0;
}

function isKeyboardInterrupt(e: unknown): boolean {
  return e instanceof Error && e.name === "KeyboardInterrupt";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function main(): number {
  const argv = process.argv.slice(2);
  const g = parseGlobal(argv);

  if (!g.command) {
    if (argv.includes("--help") || argv.includes("-h")) return cmdHelp();
    return cmdDashboard(g);
  }

  const handlers: Record<string, () => number> = {
    dashboard: () => cmdDashboard(g),
    scan: () => cmdScan(g),
    agent: () => cmdAgent(g),
    validate: () => cmdValidate(g),
    test: () => cmdTest(g),
    status: () => cmdStatus(g),
    "pr-loop": () => cmdPrLoop(g),
    doctor: () => cmdDoctor(g),
    help: () => cmdHelp(),
  };

  const handler = handlers[g.command];
  if (!handler) {
    logText(`Unknown command: ${g.command}`, "error");
    return 1;
  }

  try {
    return handler();
  } catch (e) {
    if (isKeyboardInterrupt(e)) {
      logText("Interrupted by user", "warning");
      return 130;
    }
    logText(`Command failed: ${errMsg(e)}`, "error");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
