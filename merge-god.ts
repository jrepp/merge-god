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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import chalk from "chalk";
import YAML from "yaml";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

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
    const result = spawnSync(process.execPath, ["--import", TSX_LOADER, resolve(REPO_ROOT, script), ...args], {
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

function hasCommand(command: string, args = ["--version"]): boolean {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000, stdio: "ignore" });
  return result.status === 0;
}

function hasGitHubAuth(): boolean {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return true;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function isGitRepository(repoPath: string): boolean {
  if (!repoPath) return false;
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: "ignore",
  });
  return result.status === 0;
}

function discoverCurrentRepository(): { path: string; name: string; enabled: true }[] {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const repoPath = result.status === 0 ? result.stdout.trim() : "";
  return repoPath ? [{ path: repoPath, name: basename(repoPath), enabled: true }] : [];
}

function cmdInit(g: GlobalArgs): number {
  const parsed = parseArgs({
    args: g.rest,
    options: {
      config: { type: "string" },
      repo: { type: "string", multiple: true },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const configPath = resolvePath(parsed.values.config ?? g.config, "config.yaml");
  if (existsSync(configPath) && !parsed.values.force) {
    logText(`Config already exists: ${configPath}`, "warning");
    logText("Use --force to overwrite it.");
    return 1;
  }
  const explicitRepos = parsed.values.repo ?? parsed.positionals;
  const repos = explicitRepos.length > 0
    ? explicitRepos.map((value) => {
        const repoPath = resolve(value);
        return { path: repoPath, name: basename(repoPath), enabled: true };
      })
    : discoverCurrentRepository();
  const config = {
    repos: repos.length > 0 ? repos : [{ path: "/absolute/path/to/repo", name: "my-repo", enabled: true }],
  };
  writeFileSync(
    configPath,
    "# merge-god configuration\n# Label PRs with for-landing or for-review. Unlabeled PRs are skipped.\n\n" +
      YAML.stringify(config),
  );
  logText(`Created ${configPath}`, "success");
  if (repos.length === 0) logText("Edit repos[0].path before running merge-god.", "warning");
  logText("Next: merge-god doctor");
  return 0;
}

function cmdDoctor(g: GlobalArgs): number {
  const configPath = resolvePath(g.config, "config.yaml");
  let failures = 0;
  const check = (ok: boolean, label: string, fix?: string): void => {
    logText(label, ok ? "success" : "error");
    if (!ok) {
      failures++;
      if (fix) logText(`  ${fix}`);
    }
  };
  check(Number(process.versions.node.split(".")[0] ?? 0) >= 22, `Node.js ${process.versions.node}`);
  check(hasCommand("git"), "git is available", "Install git and ensure it is on PATH.");
  check(hasCommand("gh"), "gh is available", "Install GitHub CLI: https://cli.github.com/");
  check(hasGitHubAuth(), "GitHub API auth is available", "Set GH_TOKEN or run gh auth login.");
  check(hasCommand("pi"), "pi is available", "Install pi and ensure it is on PATH.");
  if (!existsSync(configPath)) {
    check(false, `Config missing: ${configPath}`, "Run: merge-god init");
  } else {
    try {
      const config = YAML.parse(readFileSync(configPath, "utf8")) as
        | { repos?: { path?: unknown; enabled?: boolean }[] }
        | null;
      const repos = config?.repos ?? [];
      check(repos.length > 0, `Configured repos: ${repos.length}`, "Add at least one repo to config.yaml.");
      for (const repo of repos.filter((item) => item.enabled ?? true)) {
        const repoPath = typeof repo.path === "string" ? resolve(dirname(configPath), repo.path) : "";
        check(isGitRepository(repoPath), `Repo path is a git repo: ${repo.path ?? "(missing path)"}`);
      }
    } catch (error) {
      check(false, `Could not parse ${configPath}: ${errMsg(error)}`);
    }
  }
  if (failures === 0) logText("Ready. Run: merge-god repo", "success");
  else logText(`${failures} check(s) failed.`, "error");
  return failures === 0 ? 0 : 1;
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
      resume: { type: "string" },
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
  if (parsed.values.resume) args.push("--resume", parsed.values.resume);
  const db = parsed.values.db ?? g.db;
  if (db) args.push("--db", db);
  if (parsed.values["repo-path"]) args.push("--repo-path", parsed.values["repo-path"]);
  const rc = runChild(args[0]!, args.slice(1));
  if (rc === 0) logText("Agent completed successfully", "success");
  else logText(`Agent failed with exit code ${rc}`, "error");
  return rc;
}

function cmdPrWorkflow(g: GlobalArgs, action: "pr" | "resume"): number {
  const args = [action, ...g.rest];
  if (g.config) args.push("--config", g.config);
  if (g.db) args.push("--db", g.db);
  return runChild("pr_workflow_cli.ts", args);
}

function cmdNewPr(g: GlobalArgs): number {
  return runChild("new_pr_cli.ts", g.rest);
}

function cmdCurrentRepo(g: GlobalArgs): number {
  if (prLoopChildArgs(g.rest)) return cmdPrLoop(g);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const repoPath = result.status === 0 ? result.stdout.trim() : "";
  if (!repoPath) {
    logText("Not inside a git checkout; pass a checkout path or use 'merge-god run' with config.yaml", "error");
    return 1;
  }
  return cmdPrLoop({ ...g, rest: [repoPath, ...g.rest] });
}

const PR_LOOP_VALUE_OPTIONS = new Set([
  "--repo",
  "--db",
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

function hasCliOption(rest: string[], name: string): boolean {
  return rest.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** Resolve a single configured repository when the operator omits repo_path. */
export function configuredPrLoopChildArgs(rest: string[], configPath: string): string[] {
  const explicit = prLoopChildArgs(rest);
  if (explicit) return explicit;
  if (!existsSync(configPath)) {
    throw new Error(`repo_path was omitted and config was not found at ${configPath}`);
  }
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as
    | { repos?: { path?: unknown; repo?: unknown; enabled?: boolean }[] }
    | null;
  const repos = (parsed?.repos ?? []).filter((repo) => repo.enabled ?? true);
  if (repos.length !== 1) {
    throw new Error(
      `repo_path was omitted, but ${repos.length} enabled repositories are configured; pass a checkout path explicitly`,
    );
  }
  const selected = repos[0]!;
  if (typeof selected.path !== "string" || !selected.path.trim()) {
    throw new Error("the enabled repository is missing repos[].path");
  }
  const args = [selected.path, ...rest];
  if (typeof selected.repo === "string" && selected.repo.trim() && !hasCliOption(rest, "--repo")) {
    args.push("--repo", selected.repo);
  }
  return args;
}

function cmdPrLoop(g: GlobalArgs): number {
  let args: string[];
  try {
    args = configuredPrLoopChildArgs(g.rest, resolvePath(g.config, "config.yaml"));
  } catch (e) {
    logText(errMsg(e), "error");
    return 1;
  }
  if (!prLoopChildArgs(g.rest)) logText(`Using configured repository: ${args[0]}`, "info");
  if (!hasCliOption(args, "--db")) args.push("--db", resolvePath(g.db, "merge-god-state.db"));
  return runChild("pr-loop.ts", args);
}

function cmdDuplicates(g: GlobalArgs): number {
  let args: string[];
  try {
    args = configuredPrLoopChildArgs(g.rest, resolvePath(g.config, "config.yaml"));
  } catch (e) {
    logText(errMsg(e), "error");
    return 1;
  }
  if (!prLoopChildArgs(g.rest)) logText(`Using configured repository: ${args[0]}`, "info");
  return runChild("analyze_duplicates.ts", args);
}

function cmdProfile(g: GlobalArgs): number {
  const parsed = parseArgs({
    args: g.rest,
    options: {
      input: { type: "string" },
      repo: { type: "string" },
      limit: { type: "string" },
      "deepening-limit": { type: "string" },
      "sample-limit": { type: "string" },
      now: { type: "string" },
    },
    allowPositionals: true,
  });
  const args = ["profile_operations.ts"];
  for (const option of ["input", "repo", "limit", "deepening-limit", "sample-limit", "now"] as const) {
    const value = parsed.values[option];
    if (value) args.push(`--${option}`, value);
  }
  return runChild(args[0]!, args.slice(1));
}

function cmdCohort(g: GlobalArgs): number {
  const args = ["embark_cohort.ts", ...g.rest];
  if (g.db) args.push("--db", g.db);
  return runChild(args[0]!, args.slice(1));
}

function cmdSendApproval(): number {
  return runChild("send_approval.ts", []);
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
  ];
  logText("Scripts:", "info");
  for (const [script, desc] of scripts) {
    if (existsSync(resolve(REPO_ROOT, script))) logText(`  ${String.fromCharCode(0x2713)} ${desc}: ${script}`, "success");
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

PRIMARY COMMANDS:
  init        Create config.yaml for the current checkout.
  doctor      Check local prerequisites and configured repository paths.
  status      Show system status and statistics.
  repo        Process the current repository queue.
  pr          Sync and process one PR; resumes interrupted work automatically.
  resume      Resume the latest interrupted PR, or a specified PR number.
  new-pr      Prepare a branch/worktree and open a tagged draft PR.
  dashboard   Run the World HUD TUI dashboard (also the default command).
  duplicates  Analyze duplicate PRs; optionally close patches already on base.

ADVANCED COMMANDS:
  run         Run the configured repository queue.
  scan        Scan PRs and sync their context to the database.
  agent       Run agent on cached PR data (Process 3 isolation).
  pr-loop     Run bounded or continuous PR processing loop.
  profile     Profile a shallow PR inventory without agent or mutation calls.
  cohort      Inspect, approve, or evidence-recover an embark cohort.
  send-approval  Approve a waiting interactive processing loop.
  help        Show this help message.

Dashboard screens: --screen world|prs|agents (default: world).
COMMON WORKFLOWS:
  merge-god doctor
  merge-god repo --once --dry-run
  merge-god pr 14
  merge-god new-pr feat/my-change --worktree ../my-change
  merge-god resume
  merge-god status
Run 'merge-god help' for details.
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

export function main(): number {
  const argv = process.argv.slice(2);
  const g = parseGlobal(argv);

  if (!g.command) {
    if (argv.includes("--help") || argv.includes("-h")) return cmdHelp();
    return cmdDashboard(g);
  }

  const handlers: Record<string, () => number> = {
    init: () => cmdInit(g),
    dashboard: () => cmdDashboard(g),
    repo: () => cmdCurrentRepo(g),
    pr: () => cmdPrWorkflow(g, "pr"),
    resume: () => cmdPrWorkflow(g, "resume"),
    "new-pr": () => cmdNewPr(g),
    scan: () => cmdScan(g),
    agent: () => cmdAgent(g),
    status: () => cmdStatus(g),
    "pr-loop": () => cmdPrLoop(g),
    run: () => cmdPrLoop(g),
    duplicates: () => cmdDuplicates(g),
    doctor: () => cmdDoctor(g),
    profile: () => cmdProfile(g),
    cohort: () => cmdCohort(g),
    "send-approval": () => cmdSendApproval(),
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
