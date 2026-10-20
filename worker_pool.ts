#!/usr/bin/env node
/**
 * Striped multi-repo worker pool.
 *
 * Partitions the configured repositories across N workers (round-robin by
 * name). Each worker loop rotates through its stripe, running one bounded
 * `pr-loop --max-iterations 1` pass per repository before moving to the next,
 * so at most N repositories are processed concurrently portfolio-wide.
 *
 * One metrics endpoint serves the whole pool: process gauges, per-repo agent
 * metrics drained from the shared state database, and per-repo pass counters.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import YAML from "yaml";

import { MetricsRegistry, registerProcessMetrics, startMetricsServer, type MetricsServer } from "./metrics_server";
import { registerAgentMetrics } from "./agent_metrics";
import { parseOperatorConfig } from "./schemas/config";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

export interface PoolRepo {
  name: string;
  path: string;
  slug: string;
}

export interface WorkerStripe {
  index: number;
  metricsPort: number;
  repos: PoolRepo[];
}

/** Extract OWNER/REPO from a git remote URL (https, ssh, or scp-like syntax). */
export function slugFromRemote(url: string): string | null {
  const cleaned = url.trim().replace(/\.git\/?$/i, "");
  const patterns = [
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

/** Round-robin stripe of already-ordered items across worker buckets. */
export function stripeRepos<T>(items: T[], workers: number): T[][] {
  const buckets: T[][] = Array.from({ length: Math.max(workers, 1) }, () => []);
  items.forEach((item, index) => buckets[index % buckets.length]!.push(item));
  return buckets;
}

export interface PoolPlanOptions {
  configPath: string;
  workers: number;
  metricsBasePort: number;
  only?: string[];
  /** Resolves the git remote URL for a checkout; defaults to `git remote get-url origin`. */
  resolveRemote?: (repoPath: string) => string | null;
}

export interface PoolPlan {
  workers: WorkerStripe[];
  skipped: string[];
}

/** Load the operator config and build the striped worker plan. */
export function buildPoolPlan(options: PoolPlanOptions): PoolPlan {
  const parsed = parseOperatorConfig(YAML.parse(readFileSync(options.configPath, "utf8")));
  const enabled = parsed.repos.filter((repo) => repo.enabled ?? true);
  const only = options.only ? new Set(options.only) : null;
  const skipped: string[] = [];
  const repos: PoolRepo[] = [];
  for (const repo of enabled) {
    if (typeof repo.path !== "string" || !repo.path.trim()) {
      skipped.push(`${repo.name ?? repo.path}: missing path`);
      continue;
    }
    const name = typeof repo.name === "string" && repo.name.trim() ? repo.name : repo.path;
    if (only && !only.has(name)) {
      skipped.push(`${name}: excluded by --only`);
      continue;
    }
    let slug: string | null = typeof repo.repo === "string" && repo.repo.trim() ? repo.repo : null;
    if (!slug) {
      try {
        const remote = options.resolveRemote
          ? options.resolveRemote(repo.path)
          : execFileSync("git", ["-C", repo.path, "remote", "get-url", "origin"], { encoding: "utf8" });
        slug = remote ? slugFromRemote(remote) : null;
      } catch {
        slug = null;
      }
    }
    if (!slug) {
      skipped.push(`${name}: could not determine OWNER/REPO slug`);
      continue;
    }
    repos.push({ name, path: repo.path, slug });
  }
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const buckets = stripeRepos(repos, options.workers);
  return {
    workers: buckets.map((bucket, index) => ({
      index,
      metricsPort: options.metricsBasePort + index,
      repos: bucket,
    })),
    skipped,
  };
}

function logJson(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, data }));
}

async function runPass(repo: PoolRepo, args: { dbPath: string; childIdleSleepSeconds: number }): Promise<number> {
  return new Promise((resolvePass) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [
        "--import", "tsx",
        resolve(REPO_ROOT, "pr-loop.ts"),
        repo.path,
        "--repo", repo.slug,
        "--db", args.dbPath,
        "--max-iterations", "1",
        "--idle-sleep-seconds", String(args.childIdleSleepSeconds),
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    const forward = (chunk: string): void => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        console.log(`[${repo.name}] ${line}`);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("exit", (code, signal) => resolvePass(signal ? 1 : code ?? 1));
    child.on("error", () => resolvePass(1));
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      workers: { type: "string", default: "3" },
      config: { type: "string", default: "config.yaml" },
      db: { type: "string", default: "merge-god-state.db" },
      "metrics-port": { type: "string", default: "9200" },
      "metrics-host": { type: "string", default: "0.0.0.0" },
      "pass-delay-seconds": { type: "string", default: "5" },
      "child-idle-sleep-seconds": { type: "string", default: "5" },
      only: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const configPath = resolve(parsed.values.config!);
  const dbPath = resolve(parsed.values.db!);
  const workers = Number(parsed.values.workers);
  const metricsBasePort = Number(parsed.values["metrics-port"]);
  const metricsHost = parsed.values["metrics-host"]!;
  const passDelaySeconds = Number(parsed.values["pass-delay-seconds"]);
  const childIdleSleepSeconds = Number(parsed.values["child-idle-sleep-seconds"]);
  const only = parsed.values.only ? parsed.values.only.split(",").map((name) => name.trim()).filter(Boolean) : undefined;
  for (const [label, value] of [["--workers", workers], ["--metrics-port", metricsBasePort], ["--pass-delay-seconds", passDelaySeconds], ["--child-idle-sleep-seconds", childIdleSleepSeconds]] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  }

  const plan = buildPoolPlan({ configPath, workers, metricsBasePort, only });
  logJson("pool_plan", {
    workers: plan.workers.map((worker) => ({
      index: worker.index,
      metrics_port: worker.metricsPort,
      repos: worker.repos.map((repo) => `${repo.name} (${repo.slug})`),
    })),
    skipped: plan.skipped,
  });
  if (parsed.values["dry-run"]) return 0;

  const activeRepos = plan.workers.flatMap((worker) => worker.repos);
  if (activeRepos.length === 0) {
    logJson("pool_plan", { warning: "no repositories assigned; nothing to do" });
    return 1;
  }

  const registry = new MetricsRegistry();
  registerProcessMetrics(registry);
  registry.define("merge_god_worker_passes_total", "Completed worker passes per repository and result (success, failure)", "counter");
  registry.define("merge_god_worker_active", "Worker passes currently running", "gauge");
  for (const repo of activeRepos) {
    registerAgentMetrics(registry, { dbPath, repo: repo.slug, repoName: repo.name });
  }

  let metrics: MetricsServer | null = null;
  try {
    metrics = await startMetricsServer({ registry, host: metricsHost, port: metricsBasePort, serviceName: "merge-god-worker-pool" });
    logJson("startup", { metrics_endpoint: `http://${metrics.host}:${metrics.port}/metrics`, workers: plan.workers.length, repos: activeRepos.length });
  } catch (e) {
    logJson("startup", { metrics_error: e instanceof Error ? e.message : String(e), warning: "continuing without metrics endpoint" });
  }

  const activeChildren = new Set<ChildProcess>();
  const shutdown = (signal: string): void => {
    logJson("shutdown", { signal, active_children: activeChildren.size });
    for (const child of activeChildren) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let active = 0;
  registry.set("merge_god_worker_active", 0, {});
  const workerLoop = async (worker: WorkerStripe): Promise<void> => {
    for (let round = 0; ; round++) {
      for (const repo of worker.repos) {
        logJson("pass", { worker: worker.index, round, repo: repo.name, slug: repo.slug, action: "start" });
        registry.set("merge_god_worker_active", ++active, {});
        const code = await runPass(repo, { dbPath, childIdleSleepSeconds });
        registry.set("merge_god_worker_active", --active, {});
        registry.inc("merge_god_worker_passes_total", { repo: repo.slug, result: code === 0 ? "success" : "failure" });
        logJson("pass", { worker: worker.index, round, repo: repo.name, action: "complete", exit_code: code });
        await new Promise((resolveSleep) => setTimeout(resolveSleep, passDelaySeconds * 1000));
      }
    }
  };

  await Promise.all(plan.workers.map((worker) => workerLoop(worker)));
  await metrics?.stop().catch(() => {});
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => {
    logJson("fatal_error", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
