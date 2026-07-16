#!/usr/bin/env node
/** One-shot historical trajectory summaries, drill-down, and optimization profiles. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { AppStore } from "./app_store";
import type {
  ToolOptimizationProfile,
  TrajectoryOptimizationProfile,
  TrajectoryRunDrilldown,
  TrajectoryRunProfile,
} from "./trajectory_telemetry";

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function cost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function tokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function renderRuns(runs: TrajectoryRunProfile[]): void {
  if (runs.length === 0) {
    console.log("No trajectory history found.");
    return;
  }
  console.log(
    [pad("RUN", 10), pad("STATUS", 10), pad("REPOSITORY", 18), pad("PR", 8), pad("TIME", 9), pad("COST", 10),
      pad("TOKENS", 10), pad("TURNS", 7), pad("TOOLS", 7), "STARTED"].join(" "),
  );
  for (const run of runs) {
    console.log([
      pad(run.run_id.slice(0, 8), 10),
      pad(run.status, 10),
      pad(run.repo_name, 18),
      pad(run.pr_numbers.map((number) => `#${number}`).join(",") || "—", 8),
      pad(duration(run.duration_ms), 9),
      pad(cost(run.estimated_cost), 10),
      pad(tokens(run.total_tokens), 10),
      pad(String(run.turn_count), 7),
      pad(`${run.tool_call_count}/${run.failed_tool_call_count}`, 7),
      run.started_at,
    ].join(" "));
  }
  console.log("\nUse: merge-god history <run-prefix> for turn/tool timing details.");
}

function renderDrilldown(value: TrajectoryRunDrilldown): void {
  const run = value.summary;
  console.log(`Run ${run.run_id}`);
  console.log(`Repository: ${run.repo_name}  PR: ${run.pr_numbers.map((number) => `#${number}`).join(", ") || "—"}`);
  console.log(`Status: ${run.status} (${run.current_phase})`);
  console.log(`Elapsed: ${duration(run.duration_ms)}  Agent: ${duration(run.agent_duration_ms)}  Cost: ${cost(run.estimated_cost)}`);
  console.log(`Tokens: ${tokens(run.total_tokens)}  Turns: ${run.turn_count}  Tools: ${run.tool_call_count} (${run.failed_tool_call_count} failed, ${run.incomplete_tool_call_count} incomplete)`);
  console.log(`Started: ${run.started_at}`);
  if (run.completed_at) console.log(`Completed: ${run.completed_at}`);
  console.log("\nTIMELINE");
  console.log([pad("TYPE", 12), pad("OPERATION", 24), pad("STATUS", 12), pad("TIME", 10), pad("COST", 10), "STARTED"].join(" "));
  for (const span of value.spans) {
    const prefix = span.kind === "agent" ? "" : span.kind === "agent_turn" ? "  " : "    ";
    console.log([
      pad(span.kind, 12),
      pad(`${prefix}${span.name}`, 24),
      pad(span.status, 12),
      pad(duration(span.duration_ms), 10),
      pad(cost(span.estimated_cost), 10),
      span.started_at,
    ].join(" "));
  }
}

function renderTool(tool: ToolOptimizationProfile): string {
  return [
    pad(tool.name, 26),
    pad(String(tool.calls), 8),
    pad(String(tool.failures), 8),
    pad(duration(tool.total_duration_ms), 12),
    pad(duration(tool.average_duration_ms), 12),
    duration(tool.p95_duration_ms),
  ].join(" ");
}

function renderProfile(profile: TrajectoryOptimizationProfile): void {
  console.log(`Runs: ${profile.run_count}  Completed: ${profile.completed_count}  Failed/blocked: ${profile.failed_count}`);
  console.log(`Average: ${duration(profile.average_duration_ms)}  p95: ${duration(profile.p95_duration_ms)}  Total cost: ${cost(profile.total_cost)}  Tokens: ${tokens(profile.total_tokens)}`);
  console.log(`Average turns: ${profile.average_turns.toFixed(1)}  Average tool calls: ${profile.average_tool_calls.toFixed(1)}`);
  console.log("\nTOOL BOTTLENECKS");
  console.log([pad("TOOL", 26), pad("CALLS", 8), pad("FAILED", 8), pad("TOTAL", 12), pad("AVERAGE", 12), "P95"].join(" "));
  for (const tool of profile.tools) console.log(renderTool(tool));
  console.log("\nSLOWEST RUNS");
  for (const run of profile.slowest_runs) {
    console.log(`${run.run_id.slice(0, 8)}  ${duration(run.duration_ms)}  ${cost(run.estimated_cost)}  ${run.repo_name} ${run.pr_numbers.map((number) => `#${number}`).join(",")}`);
  }
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        db: { type: "string", default: "merge-god-state.db" },
        repo: { type: "string" },
        limit: { type: "string", default: "20" },
        profile: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 1) throw new Error("usage: merge-god history [RUN_ID] [--profile] [--json]");
    if (parsed.values.profile && parsed.positionals.length > 0) throw new Error("--profile cannot be combined with RUN_ID");
    const limit = Number(parsed.values.limit ?? "20");
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
    const dbPath = resolve(parsed.values.db ?? "merge-god-state.db");
    if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
    const store = new AppStore(dbPath);
    try {
      const runReference = parsed.positionals[0];
      if (runReference) {
        const drilldown = store.getTrajectoryRunDrilldown(runReference);
        if (!drilldown) throw new Error(`Trajectory run not found: ${runReference}`);
        if (parsed.values.json) console.log(JSON.stringify(drilldown, null, 2));
        else renderDrilldown(drilldown);
      } else if (parsed.values.profile) {
        const profile = store.getTrajectoryOptimizationProfile(parsed.values.repo ?? null, limit);
        if (parsed.values.json) console.log(JSON.stringify(profile, null, 2));
        else renderProfile(profile);
      } else {
        const runs = store.getTrajectoryRunProfiles(parsed.values.repo ?? null, limit);
        if (parsed.values.json) console.log(JSON.stringify(runs, null, 2));
        else renderRuns(runs);
      }
    } finally {
      store.close();
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
