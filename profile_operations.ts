#!/usr/bin/env node
/** Read-only operations profiler for large PR inventories. */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { buildOperationsProfile } from "./operations_profile_model";
import { ExecutionPolicy } from "./execution_policy";

function positiveInteger(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer`);
  return parsed;
}

function loadCapturedInventory(path: string): unknown[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const pullRequests = (parsed as Record<string, unknown>)["pull_requests"];
    if (Array.isArray(pullRequests)) return pullRequests;
  }
  throw new Error("input must be a JSON array or an object with a pull_requests array");
}

function fetchInventory(repo: string | undefined, limit: number): unknown[] {
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,headRefName,baseRefName,isDraft,labels,url,author,createdAt,updatedAt",
  ];
  if (repo) args.push("--repo", repo);
  const result = new ExecutionPolicy().runCommandSync("gh", args, { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh exited ${result.status ?? "unknown"}`);
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("gh returned a non-array PR inventory");
  return parsed;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      repo: { type: "string" },
      limit: { type: "string", default: "10000" },
      "deepening-limit": { type: "string", default: "25" },
      "sample-limit": { type: "string", default: "25" },
      now: { type: "string" },
    },
  });
  const limit = positiveInteger(parsed.values.limit, 10_000, "--limit");
  const deepeningLimit = nonNegativeInteger(parsed.values["deepening-limit"], 25, "--deepening-limit");
  const sampleLimit = nonNegativeInteger(parsed.values["sample-limit"], 25, "--sample-limit");
  const now = parsed.values.now ? new Date(parsed.values.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("--now must be a valid date");

  const collectionStarted = performance.now();
  const pullRequests = parsed.values.input
    ? loadCapturedInventory(parsed.values.input)
    : fetchInventory(parsed.values.repo, limit);
  const collectionDurationMs = performance.now() - collectionStarted;
  const analysisStarted = performance.now();
  const profile = buildOperationsProfile(pullRequests, {
    now,
    deepening_limit: deepeningLimit,
    sample_limit: sampleLimit,
  });
  const analysisDurationMs = performance.now() - analysisStarted;

  console.log(JSON.stringify({
    ...profile,
    runtime: {
      source: parsed.values.input ? "capture" : "github",
      collection_duration_ms: Math.round(collectionDurationMs * 100) / 100,
      analysis_duration_ms: Math.round(analysisDurationMs * 100) / 100,
      analysis_items_per_second: analysisDurationMs === 0
        ? null
        : Math.round((pullRequests.length / analysisDurationMs) * 1000),
    },
  }, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
