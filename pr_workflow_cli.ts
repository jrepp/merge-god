#!/usr/bin/env node
/** One-command PR sync/process and trajectory resume workflow. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

import {
  parsePositivePrNumber,
  selectCliRepository,
  type ConfiguredCliRepository,
  type PrWorkflowAction,
} from "./pr_cli_model";
import { parseRepositoryIdentity, repositoryIdentityMatches } from "./repository_identity_model";

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

interface ResumeTarget {
  pr_number: number;
  run_id: string;
}

function gitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : null;
}

function configuredRepos(configPath: string): ConfiguredCliRepository[] {
  if (!existsSync(configPath)) return [];
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as { repos?: ConfiguredCliRepository[] } | null;
  return Array.isArray(parsed?.repos) ? parsed.repos : [];
}

function validateTargetIdentity(repoPath: string, expectedRepo: string | null): void {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (remote.status !== 0) throw new Error(`Could not inspect origin for ${repoPath}`);
  const actual = parseRepositoryIdentity(remote.stdout.trim());
  if (!actual) throw new Error(`Could not parse origin repository identity: ${remote.stdout.trim()}`);
  if (expectedRepo) {
    const expected = parseRepositoryIdentity(expectedRepo);
    if (!expected || !repositoryIdentityMatches(actual, expected)) {
      throw new Error(`Checkout ${actual.host}/${actual.name_with_owner} does not match ${expectedRepo}`);
    }
  }
  if (actual.host) process.env.GH_HOST = actual.host;
}

function findResumeTarget(dbPath: string, repoName: string, requestedPr: number | null): ResumeTarget | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const prPredicate = requestedPr === null ? "" : "AND wi.number = ?";
    const params: Array<string | number> = [repoName];
    if (requestedPr !== null) params.push(requestedPr);
    const row = db.prepare(
      `SELECT r.run_id, wi.number AS pr_number
       FROM orchestration_runs r
       JOIN worksets ws ON ws.run_id = r.run_id
       JOIN work_items wi ON wi.workset_id = ws.workset_id
       JOIN activities a ON a.run_id = r.run_id AND a.work_item_id = wi.work_item_id
       WHERE r.repo_name = ? ${prPredicate}
         AND r.strategy_version = 'compatibility-v1'
         AND r.status IN ('created', 'surveying', 'planning', 'executing', 'waiting')
         AND a.parent_activity_id IS NULL
         AND a.status IN ('created', 'ready', 'claimed', 'running')
       ORDER BY r.started_at DESC, a.created_at
       LIMIT 1`,
    ).get(...params) as { run_id?: unknown; pr_number?: unknown } | undefined;
    if (!row || typeof row.run_id !== "string" || typeof row.pr_number !== "number") return null;
    return { run_id: row.run_id, pr_number: row.pr_number };
  } finally {
    db.close();
  }
}

function runTsScript(script: string, args: string[], cwd: string): number {
  const scriptPath = fileURLToPath(new URL(script, import.meta.url));
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, scriptPath, ...args], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        config: { type: "string", default: "config.yaml" },
        db: { type: "string", default: "merge-god-state.db" },
        "repo-path": { type: "string" },
        repo: { type: "string" },
        mode: { type: "string", default: "for-landing" },
        runtime: { type: "string", default: "pi" },
        timeout: { type: "string", default: "3600" },
        "no-sync": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const action = parsed.positionals[0] as PrWorkflowAction | undefined;
    if (action !== "pr" && action !== "resume") {
      throw new Error("usage: pr_workflow_cli.ts <pr|resume> [PR_NUMBER] [options]");
    }
    const configPath = resolve(cwd, parsed.values.config ?? "config.yaml");
    const dbPath = resolve(cwd, parsed.values.db ?? "merge-god-state.db");
    const target = selectCliRepository({
      cwd,
      git_root: gitRoot(cwd),
      explicit_path: parsed.values["repo-path"],
      explicit_repo_name: parsed.values.repo,
      configured_repos: configuredRepos(configPath),
    });
    if (!gitRoot(target.path)) throw new Error(`Not a git checkout: ${target.path}`);
    validateTargetIdentity(target.path, target.expected_repo);

    const requestedPr = parsed.positionals[1] === undefined
      ? null
      : parsePositivePrNumber(parsed.positionals[1]);
    let prNumber: number;
    let runId: string | null = null;
    if (action === "pr") {
      if (requestedPr === null) throw new Error("PR number is required: merge-god pr <number>");
      prNumber = requestedPr;
    } else {
      const resumeTarget = findResumeTarget(dbPath, target.name, requestedPr);
      if (!resumeTarget) {
        const scope = requestedPr === null ? target.name : `${target.name} PR #${requestedPr}`;
        throw new Error(`No resumable trajectory found for ${scope}`);
      }
      prNumber = resumeTarget.pr_number;
      runId = resumeTarget.run_id;
    }

    const mode = parsed.values.mode ?? "for-landing";
    if (mode !== "for-landing" && mode !== "for-review") throw new Error(`Invalid mode: ${mode}`);
    const runtime = parsed.values.runtime ?? "pi";
    if (runtime !== "pi" && runtime !== "claude") throw new Error(`Invalid runtime: ${runtime}`);
    const timeout = Number(parsed.values.timeout ?? "3600");
    if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("--timeout must be a positive integer");

    const plan = {
      action,
      repository: target.name,
      repo_path: target.path,
      repository_source: target.source,
      pr_number: prNumber,
      run_id: runId,
      mode,
      runtime,
      db_path: dbPath,
      sync: !parsed.values["no-sync"],
      resume: action === "resume" ? "required" : "auto",
    };
    if (parsed.values["dry-run"]) {
      console.log(JSON.stringify({ workflow: "pr", plan }, null, 2));
      return 0;
    }

    console.error(
      `${action === "resume" ? "Resuming" : "Processing"} ${target.name} PR #${prNumber}` +
      `${runId ? ` (run ${runId})` : ""}`,
    );
    if (!parsed.values["no-sync"]) {
      const syncStatus = runTsScript("./sync_pr_context.ts", [
        "--repo-path", target.path,
        "--repo", target.name,
        "--pr", String(prNumber),
        "--db", dbPath,
      ], target.path);
      if (syncStatus !== 0) return syncStatus;
    }
    return runTsScript("./run_agent_from_db.ts", [
      target.name,
      String(prNumber),
      "--repo-path", target.path,
      "--db", dbPath,
      "--mode", mode,
      "--runtime", runtime,
      "--timeout", String(timeout),
      "--resume", action === "resume" ? "required" : "auto",
    ], target.path);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
