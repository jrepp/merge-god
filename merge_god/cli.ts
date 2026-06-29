#!/usr/bin/env node
/**
 * merge-god - Unified CLI for PR automation pipeline (packaged entrypoint).
 *
 * Ported from merge_god/cli.py. The package-relative CLI dispatched by the
 * `merge-god` console script. Each subcommand either shells out to a sibling
 * .ts script at the repo root (process isolation, matching the Python design)
 * or, for `status`, queries the SQLite database directly.
 *
 *   Process 1: PR/branch scanning and state management
 *   Process 2: PR context gathering and database caching
 *   Process 3: Agent invocation and PR processing
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import chalk from "chalk";
import YAML from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CWD = process.cwd();

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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isKeyboardInterrupt(e: unknown): boolean {
  return e instanceof Error && e.name === "KeyboardInterrupt";
}

/** Run a sibling .ts script (repo-root relative) in a child process. */
function runChild(script: string, args: string[]): number {
  const scriptPath = resolve(REPO_ROOT, script);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      stdio: "inherit",
    });
    if (result.error) {
      logText(`Failed to start ${script}: ${result.error.message}`, "error");
      return 1;
    }
    return result.status ?? 1;
  } catch (e) {
    logText(`Failed to run ${script}: ${errMsg(e)}`, "error");
    return 1;
  }
}

function resolvePath(p: string | undefined, fallback: string): string {
  if (!p) return resolve(CWD, fallback);
  return isAbsolute(p) ? p : resolve(CWD, p);
}

function hasCommand(cmd: string, args = ["--version"]): boolean {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hasGitHubAuth(): boolean {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return true;
  try {
    const token = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
    return token.status === 0 && token.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function discoverGitRepos(root: string): { path: string; name: string; enabled: boolean }[] {
  const repos: { path: string; name: string; enabled: boolean }[] = [];
  const seen = new Set<string>();
  for (const candidate of [root, resolve(root, "..")]) {
    if (!existsSync(candidate)) continue;
    try {
      const status = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (status.status === 0) {
        const repoPath = status.stdout.trim();
        if (repoPath && !seen.has(repoPath)) {
          seen.add(repoPath);
          repos.push({ path: repoPath, name: repoPath.split(/[\\/]/).pop() ?? "repo", enabled: true });
        }
      }
    } catch {
      // ignore discovery failures
    }
  }
  return repos;
}

interface GlobalArgs {
  config?: string;
  db?: string;
  command: string | undefined;
  rest: string[];
}

function parseGlobal(argv: string[]): GlobalArgs {
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
  const args = ["dashboard.ts"];
  if (g.config) args.push(g.config);
  else args.push(resolvePath(undefined, "config.yaml"));
  const parsed = parseArgs({
    args: g.rest,
    options: {
      "non-interactive": { type: "boolean", default: false },
      "log-file": { type: "string" },
    },
    allowPositionals: true,
  });
  if (parsed.values["non-interactive"]) args.push("--non-interactive");
  if (parsed.values["log-file"]) args.push("--log-file", parsed.values["log-file"]);
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

function cmdScan(g: GlobalArgs): number {
  const parsed = parseArgs({
    args: g.rest,
    options: {
      config: { type: "string" },
      db: { type: "string" },
      repo: { type: "string" },
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
  if (parsed.values.pr) args.push("--pr", parsed.values.pr);
  return runChild(args[0]!, args.slice(1));
}

function cmdAgent(g: GlobalArgs): number {
  const parsed = parseArgs({
    args: g.rest,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      mode: { type: "string" },
      db: { type: "string" },
      "repo-path": { type: "string" },
    },
    allowPositionals: true,
  });
  const repo = parsed.values.repo;
  const pr = parsed.values.pr;
  if (!repo) {
    logText("--repo is required for agent command", "error");
    return 1;
  }
  if (!pr) {
    logText("--pr is required for agent command", "error");
    return 1;
  }
  const args = ["run_agent_from_db.ts", repo, pr, "--mode", parsed.values.mode ?? "for-landing"];
  const db = parsed.values.db ?? g.db;
  if (db) args.push("--db", db);
  if (parsed.values["repo-path"]) args.push("--repo-path", parsed.values["repo-path"]);
  return runChild(args[0]!, args.slice(1));
}

function cmdValidate(g: GlobalArgs): number {
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
  return runChild(args[0]!, args.slice(1));
}

function cmdPrLoop(g: GlobalArgs): number {
  const parsed = parseArgs({ args: g.rest, options: {}, allowPositionals: true });
  const repoPath = parsed.positionals[0];
  if (!repoPath) {
    logText("repo_path is required for pr-loop command", "error");
    return 1;
  }
  return runChild("pr-loop.ts", [repoPath]);
}

function cmdSendApproval(): number {
  return runChild("send_approval.ts", []);
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
    logText("Use --force to overwrite it.", "info");
    return 1;
  }

  const explicitRepos = parsed.values.repo ?? parsed.positionals;
  const repos = explicitRepos.length > 0
    ? explicitRepos.map((p) => {
        const repoPath = resolve(CWD, p);
        return { path: repoPath, name: repoPath.split(/[\\/]/).pop() ?? "repo", enabled: true };
      })
    : discoverGitRepos(CWD);

  const config = {
    repos: repos.length > 0 ? repos : [{ path: "/absolute/path/to/repo", name: "my-repo", enabled: true }],
  };

  const header = [
    "# merge-god configuration",
    "# Label PRs with for-landing or for-review. Unlabeled PRs are skipped.",
    "",
  ].join("\n");
  writeFileSync(configPath, header + YAML.stringify(config));
  logText(`Created ${configPath}`, "success");
  if (repos.length === 0) {
    logText("Edit repos[0].path before running the dashboard.", "warning");
  }
  logText("Next: merge-god doctor", "info");
  return 0;
}

function cmdDoctor(g: GlobalArgs): number {
  const configPath = resolvePath(g.config, "config.yaml");
  let failures = 0;

  const check = (ok: boolean, label: string, fix?: string): void => {
    if (ok) {
      logText(label, "success");
    } else {
      failures += 1;
      logText(label, "error");
      if (fix) logText(`  ${fix}`, "info");
    }
  };

  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  check(nodeMajor >= 22, `Node.js ${process.versions.node}`, "Install Node.js 22 or newer.");
  check(hasCommand("git"), "git is available", "Install git and ensure it is on PATH.");
  check(hasCommand("gh"), "gh is available", "Install GitHub CLI: https://cli.github.com/");
  check(
    hasGitHubAuth(),
    "GitHub API auth is available",
    "Set GITHUB_TOKEN/GH_TOKEN or run gh auth login if no existing token is available.",
  );
  check(hasCommand("pi"), "pi is available", "Install pi and ensure it is on PATH.");

  if (!existsSync(configPath)) {
    failures += 1;
    logText(`Config missing: ${configPath}`, "error");
    logText("  Run: merge-god init", "info");
  } else {
    logText(`Config found: ${configPath}`, "success");
    try {
      const parsed = YAML.parse(readFileSync(configPath, "utf8")) as
        | { repos?: { path?: string; enabled?: boolean }[] }
        | null;
      const repos = parsed?.repos ?? [];
      check(repos.length > 0, `Configured repos: ${repos.length}`, "Add at least one repo to config.yaml.");
      for (const repo of repos.filter((r) => r.enabled ?? true)) {
        const repoPath = repo.path ? resolve(CWD, repo.path) : "";
        check(
          repoPath.length > 0 && existsSync(resolve(repoPath, ".git")),
          `Repo path is a git repo: ${repo.path ?? "(missing path)"}`,
          "Set repos[].path to a local checkout with a .git directory.",
        );
      }
    } catch (e) {
      failures += 1;
      logText(`Could not parse ${configPath}: ${errMsg(e)}`, "error");
    }
  }

  if (failures === 0) {
    logText("Ready. Run: merge-god dashboard", "success");
    return 0;
  }
  logText(`${failures} check(s) failed.`, "error");
  return 1;
}

function cmdTest(g: GlobalArgs): number {
  logText("Running test suite...", "info");
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
  const scriptPath = resolve(REPO_ROOT, script);
  try {
    const rc =
      spawnSync(process.execPath, ["--import", "tsx", "--test", scriptPath], {
        stdio: "inherit",
      }).status ?? 1;
    if (rc === 0) logText("Tests passed", "success");
    else logText("Tests failed", "error");
    return rc;
  } catch (e) {
    logText(`Failed to run tests: ${errMsg(e)}`, "error");
    return 1;
  }
}

function countRows(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
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
            .get() as
            | { repo: string; pr: number; status: string; success: number; duration: number }
            | undefined;
          if (row) {
            const icon = row.success
              ? String.fromCharCode(0x2713)
              : String.fromCharCode(0x2717);
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
      const config = YAML.parse(readFileSync(configPath, "utf8")) as
        | { repos?: { enabled?: boolean }[] }
        | null;
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
    const scriptPath = resolve(REPO_ROOT, script);
    if (existsSync(scriptPath))
      logText(`  ${String.fromCharCode(0x2713)} ${desc}: ${script}`, "success");
    else logText(`  ${String.fromCharCode(0x2717)} ${desc}: ${script} (missing)`, "error");
  }

  return 0;
}

const HELP_TEXT = `
merge-god - Unified CLI for PR automation pipeline

OVERVIEW:

  merge-god automates PR review and landing using Claude AI agents.
  It consists of 3 isolated processes:

    Process 1: PR/branch scanning and state management
    Process 2: PR context gathering and database caching
    Process 3: Agent invocation and PR processing

  COMMANDS:

  init
    Create config.yaml in the current directory.
    Options:
      --repo PATH            Add a repository path (repeatable)
      --force                Overwrite an existing config file

  doctor
    Check local prerequisites: Node, git, gh auth, pi, and config paths.

  dashboard
    Run the full TUI dashboard with all processes.
    Options:
      --config PATH          Config file (default: config.yaml)
      --non-interactive      Run without prompts
      --log-file PATH        Write logs to file

  scan
    Scan PRs and sync their context to the database.
    Options:
      --config PATH          Config file (default: config.yaml)
      --db PATH              Database file (default: merge-god-state.db)
      --repo NAME            Sync specific repository
      --pr NUMBER            Sync specific PR number

  agent
    Run agent on cached PR data (Process 3 isolation).
    Options:
      --repo NAME            Repository name (required)
      --pr NUMBER            PR number (required)
      --mode MODE            for-landing or for-review (default: for-landing)
      --db PATH              Database file (default: merge-god-state.db)
      --repo-path PATH       Repository path for git operations

  validate
    Validate process boundaries and data flow.
    Options:
      --db PATH              Database file (default: merge-god-state.db)
      --repo NAME            Validate specific repository
      --pr NUMBER            Validate specific PR

  test
    Run test suite.
    Options:
      --type TYPE            Test type: all, isolation, db, agent (default: all)

  status
    Show system status and statistics.
    Options:
      --config PATH          Config file (default: config.yaml)
      --db PATH              Database file (default: merge-god-state.db)

  pr-loop
    Run the legacy PR processing loop.
    Args:
      repo_path              Repository path (required)

  send-approval
    Send approval to a running pr-loop process.

  help
    Show this help message.

TESTING WORKFLOW:

  1. Scan and cache PR data:
     merge-god scan --repo my-repo --pr 123

  2. Validate data flow:
     merge-god validate --repo my-repo --pr 123

  3. Run agent on cached data:
     merge-god agent --repo my-repo --pr 123

  4. Check results:
     merge-god status

ENVIRONMENT:

  AWS Bedrock (recommended):
    export CLAUDE_CODE_USE_BEDROCK=1
    export ANTHROPIC_MODEL="global.anthropic.claude-sonnet-4-5-20250929-v1:0"

  Direct API:
    export ANTHROPIC_API_KEY="your-key"
    export ANTHROPIC_MODEL="claude-sonnet-4-5-20250929"

DOCUMENTATION:

  See README.md for full documentation.
`;

function cmdHelp(): number {
  console.log(HELP_TEXT);
  return 0;
}

export function main(): number {
  const argv = process.argv.slice(2);
  const g = parseGlobal(argv);

  if (!g.command) {
    console.log(HELP_TEXT);
    return 0;
  }

  const handlers: Record<string, () => number> = {
    dashboard: () => cmdDashboard(g),
    init: () => cmdInit(g),
    doctor: () => cmdDoctor(g),
    scan: () => cmdScan(g),
    agent: () => cmdAgent(g),
    validate: () => cmdValidate(g),
    test: () => cmdTest(g),
    status: () => cmdStatus(g),
    "pr-loop": () => cmdPrLoop(g),
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
