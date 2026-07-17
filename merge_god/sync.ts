#!/usr/bin/env node
/**
 * Database Sync CLI - Sync PR context from GitHub to SQLite database.
 *
 * Ported from merge_god/sync.py. Reads config.yaml, scans for PRs with
 * for-landing/for-review labels, and saves their complete context to the
 * database for offline agent testing.
 *
 * Usage:
 *     ./sync.ts [--config config.yaml] [--repo REPO_NAME] [--pr PR_NUMBER]
 */

import { chdir } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { SyncStore, GitClient } from "@merge-god/github-sync";
import { prContextTelemetrySummary } from "../pr_context_log_model";
import { prDetailsBaseBranch, prDetailsHeadBranch, prDetailsUrl } from "../pr_details_access_model";
import { categorizedPrNumbers } from "../pr_loop_model";
import { pullRequestSnapshotFromDetails } from "../pr_snapshot_model";
import { gather_pr_context, getOpenPrs, getPrDetails } from "../pr-loop";
import { parseOperatorConfig } from "../schemas/config";

interface RepoConfig {
  path?: string;
  name?: string;
  enabled?: boolean;
}

interface SyncStats {
  repo: string;
  total: number;
  succeeded: number;
  failed: number;
  prs: number[];
  success?: boolean;
  error?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function typeName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

function logJson(eventType: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString().replace("+00:00", "Z"),
    event: eventType,
    data,
  };
  console.log(JSON.stringify(entry));
}

function loadConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const text = readFileSync(configPath, "utf8");
  return parseOperatorConfig(YAML.parse(text));
}

async function syncPrToDatabase(
  db: SyncStore,
  repoPath: string,
  repoName: string,
  prNumber: number,
): Promise<boolean> {
  logJson("sync_pr", { action: "start", repo: repoName, pr_number: prNumber });

  try {
    chdir(repoPath);

    const details = getPrDetails(prNumber);
    const headBranch = prDetailsHeadBranch(details);
    const baseBranch = prDetailsBaseBranch(details);
    const url = prDetailsUrl(details);

    const [prDetails, prContext] = await gather_pr_context(
      prNumber,
      headBranch,
      baseBranch,
      url,
    );

    if (!prDetails || Object.keys(prDetails).length === 0) {
      logJson("sync_pr", {
        action: "error",
        repo: repoName,
        pr_number: prNumber,
        error: "Failed to gather PR context",
      });
      return false;
    }

    await db.savePrContext(repoName, prNumber, prDetails, prContext);

    const pr = pullRequestSnapshotFromDetails(prDetails, prContext, { url });
    await db.savePrSnapshot(repoName, pr);

    const contextSummary = prContextTelemetrySummary(prContext);

    logJson("sync_pr", {
      action: "complete",
      repo: repoName,
      pr_number: prNumber,
      ...contextSummary,
    });

    return true;
  } catch (e) {
    logJson("sync_pr", {
      action: "error",
      repo: repoName,
      pr_number: prNumber,
      error: errMsg(e),
      error_type: typeName(e),
    });
    return false;
  }
}

async function syncRepo(
  db: SyncStore,
  repoConfig: RepoConfig,
  specificPr?: number,
): Promise<SyncStats> {
  const repoPathStr = repoConfig.path;
  if (!repoPathStr) {
    const fallbackName = repoConfig.name ?? "<unknown>";
    logJson("sync_repo", {
      action: "error",
      repo: fallbackName,
      error: "Repository config missing 'path'",
    });
    return {
      repo: fallbackName,
      total: 0,
      succeeded: 0,
      failed: 0,
      prs: [],
      success: false,
      error: "missing_path",
    };
  }

  const repoPath = resolve(repoPathStr);
  const repoName = repoConfig.name ?? basename(repoPath);

  if (!existsSync(repoPath)) {
    logJson("sync_repo", {
      action: "error",
      repo: repoName,
      error: `Repository path does not exist: ${repoPath}`,
    });
    return {
      repo: repoName,
      total: 0,
      succeeded: 0,
      failed: 0,
      prs: [],
      success: false,
      error: "path_not_found",
    };
  }

  logJson("sync_repo", {
    action: "start",
    repo: repoName,
    path: repoPath,
    specific_pr: specificPr ?? null,
  });

  const stats: SyncStats = {
    repo: repoName,
    total: 0,
    succeeded: 0,
    failed: 0,
    prs: [],
  };

  try {
    chdir(repoPath);

    if (specificPr !== undefined) {
      stats.total = 1;
      const success = await syncPrToDatabase(db, repoPath, repoName, specificPr);
      if (success) {
        stats.succeeded = 1;
        stats.prs.push(specificPr);
      } else {
        stats.failed = 1;
      }
    } else {
      await new GitClient(repoPath).getDefaultBranch();

      const categorized = getOpenPrs();
      const sortedPrs = categorizedPrNumbers(categorized, ["for-landing", "for-review"]);
      stats.total = sortedPrs.length;

      logJson("sync_repo", {
        action: "discovered_prs",
        repo: repoName,
        pr_count: sortedPrs.length,
        pr_numbers: sortedPrs,
      });

      if (sortedPrs.length === 0) {
        logJson("sync_repo", {
          action: "warning",
          repo: repoName,
          warning: "No PRs found with for-landing or for-review labels",
        });
      }

      for (const prNumber of sortedPrs) {
        const success = await syncPrToDatabase(db, repoPath, repoName, prNumber);
        if (success) {
          stats.succeeded += 1;
          stats.prs.push(prNumber);
        } else {
          stats.failed += 1;
        }
      }
    }

    stats.success = stats.failed === 0;

    logJson("sync_repo", { action: "complete", repo: repoName, stats });

    return stats;
  } catch (e) {
    logJson("sync_repo", {
      action: "error",
      repo: repoName,
      error: errMsg(e),
      error_type: typeName(e),
    });
    return { ...stats, success: false, error: errMsg(e) };
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "config.yaml" },
      db: { type: "string", default: "merge-god-state.db" },
      repo: { type: "string" },
      pr: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  let prNumber: number | undefined;
  if (values.pr !== undefined) {
    prNumber = Number.parseInt(values.pr, 10);
    if (Number.isNaN(prNumber)) {
      logJson("error", { error: `Invalid --pr value: ${values.pr}` });
      return 1;
    }
  }

  if (prNumber !== undefined && !values.repo) {
    logJson("error", { error: "--pr requires --repo to be specified" });
    return 1;
  }

  const configPath = values.config ?? "config.yaml";
  let config: Record<string, unknown>;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    logJson("error", {
      error: `Failed to load config: ${errMsg(e)}`,
      config_path: configPath,
    });
    return 1;
  }

  const dbPath = values.db ?? "merge-god-state.db";
  const db = new SyncStore(dbPath);
  try {
    await db.initialize();
  } catch (e) {
    logJson("error", {
      error: `Failed to initialize database: ${errMsg(e)}`,
      db_path: dbPath,
    });
    await db.close();
    return 1;
  }

  logJson("sync", {
    action: "start",
    config: configPath,
    database: dbPath,
    repo_filter: values.repo ?? null,
    pr_filter: prNumber ?? null,
  });

  const repos = config["repos"];
  if (!Array.isArray(repos)) {
    logJson("error", { error: "Config 'repos' section is not a list" });
    return 1;
  }

  const allStats: SyncStats[] = [];
  for (const repoRaw of repos) {
    const repoConfig = repoRaw as RepoConfig;

    if (!(repoConfig.enabled ?? true)) {
      logJson("sync", {
        action: "skip",
        repo: repoConfig.name ?? repoConfig.path,
        reason: "disabled in config",
      });
      continue;
    }

    if (values.repo && repoConfig.name !== values.repo) {
      continue;
    }

    const stats = await syncRepo(db, repoConfig, prNumber);
    allStats.push(stats);
  }

  const totalPrs = allStats.reduce((sum, s) => sum + s.total, 0);
  const succeeded = allStats.reduce((sum, s) => sum + s.succeeded, 0);
  const failed = allStats.reduce((sum, s) => sum + s.failed, 0);

  logJson("sync", {
    action: "complete",
    total_prs: totalPrs,
    succeeded,
    failed,
    success_rate: totalPrs > 0 ? Math.round((succeeded / totalPrs) * 1000) / 10 : 0,
  });

  await db.close();

  return failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.on("SIGINT", () => {
    logJson("shutdown", { reason: "keyboard_interrupt" });
    process.exit(130);
  });
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      logJson("fatal_error", { error: errMsg(e), error_type: typeName(e) });
      process.exit(1);
    });
}
