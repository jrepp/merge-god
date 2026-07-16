/** Durable Pi trajectory timing, usage, and optimization profile models. */

export type TrajectorySpanKind = "agent" | "agent_turn" | "tool_call";

export interface TrajectoryTimingSpan {
  span_id: string;
  operation_id: string;
  run_id: string;
  activity_id: string | null;
  activity_session_id: string | null;
  parent_span_id: string | null;
  kind: TrajectorySpanKind;
  name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  metadata: Record<string, unknown>;
}

export interface TrajectoryRunProfile {
  run_id: string;
  repo_name: string;
  pr_numbers: number[];
  status: string;
  current_phase: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  agent_duration_ms: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  turn_count: number;
  tool_call_count: number;
  failed_tool_call_count: number;
  incomplete_tool_call_count: number;
  tool_duration_ms: number;
}

export interface TrajectoryRunDrilldown {
  summary: TrajectoryRunProfile;
  spans: TrajectoryTimingSpan[];
}

export interface ToolOptimizationProfile {
  name: string;
  calls: number;
  failures: number;
  incomplete: number;
  total_duration_ms: number;
  average_duration_ms: number;
  p95_duration_ms: number;
}

export interface TrajectoryOptimizationProfile {
  run_count: number;
  completed_count: number;
  failed_count: number;
  total_duration_ms: number;
  average_duration_ms: number;
  p95_duration_ms: number;
  total_cost: number | null;
  total_tokens: number | null;
  average_turns: number;
  average_tool_calls: number;
  slowest_runs: TrajectoryRunProfile[];
  tools: ToolOptimizationProfile[];
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}

export function buildTrajectoryOptimizationProfile(
  runs: TrajectoryRunProfile[],
  spans: TrajectoryTimingSpan[],
): TrajectoryOptimizationProfile {
  const durations = runs.map((run) => run.duration_ms);
  const costs = runs.flatMap((run) => run.estimated_cost === null ? [] : [run.estimated_cost]);
  const tokens = runs.flatMap((run) => run.total_tokens === null ? [] : [run.total_tokens]);
  const toolGroups = new Map<string, TrajectoryTimingSpan[]>();
  for (const span of spans.filter((candidate) => candidate.kind === "tool_call")) {
    const group = toolGroups.get(span.name) ?? [];
    group.push(span);
    toolGroups.set(span.name, group);
  }
  const tools = [...toolGroups.entries()].map(([name, calls]) => {
    const toolDurations = calls.flatMap((call) => call.duration_ms === null ? [] : [call.duration_ms]);
    const totalDuration = toolDurations.reduce((sum, value) => sum + value, 0);
    return {
      name,
      calls: calls.length,
      failures: calls.filter((call) => call.status === "failed").length,
      incomplete: calls.filter((call) => call.status === "incomplete").length,
      total_duration_ms: totalDuration,
      average_duration_ms: toolDurations.length === 0 ? 0 : totalDuration / toolDurations.length,
      p95_duration_ms: percentile(toolDurations, 0.95),
    };
  }).sort((a, b) => b.total_duration_ms - a.total_duration_ms || a.name.localeCompare(b.name));
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  return {
    run_count: runs.length,
    completed_count: runs.filter((run) => run.status === "completed").length,
    failed_count: runs.filter((run) => run.status === "failed" || run.status === "blocked").length,
    total_duration_ms: totalDuration,
    average_duration_ms: runs.length === 0 ? 0 : totalDuration / runs.length,
    p95_duration_ms: percentile(durations, 0.95),
    total_cost: costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0),
    total_tokens: tokens.length === 0 ? null : tokens.reduce((sum, value) => sum + value, 0),
    average_turns: runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + run.turn_count, 0) / runs.length,
    average_tool_calls: runs.length === 0
      ? 0
      : runs.reduce((sum, run) => sum + run.tool_call_count, 0) / runs.length,
    slowest_runs: [...runs].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5),
    tools,
  };
}
