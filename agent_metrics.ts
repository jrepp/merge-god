/**
 * Agent observability instruments sourced from persisted trajectory data.
 *
 * A registry collector drains new `trajectory_events` rows (pi runtime) and
 * `agent_sessions` rows (Claude runtime) on every scrape and folds them into
 * Prometheus counters, so dashboards can chart token usage, turns, tool
 * calls, tasks, and workflow outcomes without touching the agent stack.
 */

import { DatabaseSync } from "node:sqlite";

import type { MetricsRegistry } from "./metrics_server";

export interface AgentMetricsOptions {
  /** Path to the merge-god state database (read-only connection). */
  dbPath: string;
  /** Repository identity stamped onto every sample (e.g. OWNER/REPO). */
  repo?: string;
  /** Basename-style repo name used to filter shared-database rows. */
  repoName?: string;
}

const TOKEN_FIELDS: ReadonlyArray<[direction: string, eventKey: string]> = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cache_creation", "cache_creation_input_tokens"],
  ["cache_read", "cache_read_input_tokens"],
  ["total", "total_tokens"],
];

/** Non-negative finite number, else 0. */
function count(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

interface TrajectoryRow {
  rid: number;
  event_type: string;
  payload: string | null;
}

interface SessionRow {
  id: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  api_calls: number | null;
  tasks_completed: number | null;
  tasks_failed: number | null;
}

export function registerAgentMetrics(registry: MetricsRegistry, options: AgentMetricsOptions): void {
  const repo = options.repo;
  const stamp = (labels: Record<string, string>) => (repo ? { repo, ...labels } : labels);

  registry.define(
    "merge_god_agent_tokens_total",
    "Cumulative agent token usage by direction (input, output, cache_creation, cache_read, total)",
    "counter",
  );
  registry.define("merge_god_agent_turns_total", "Agent turns by status (completed, interrupted)", "counter");
  registry.define(
    "merge_god_agent_api_calls_total",
    "Model API requests: reported by the Claude runtime; derived from completed turns in the pi runtime (one request per turn)",
    "counter",
  );
  registry.define(
    "merge_god_agent_tool_calls_total",
    "Agent tool calls by tool and status (succeeded, failed, incomplete)",
    "counter",
  );
  registry.define("merge_god_agent_workflows_total", "Agent workflows by result (success, failure)", "counter");
  registry.define("merge_god_agent_runs_total", "Completed agent runs by final status", "counter");
  registry.define("merge_god_agent_run_duration_seconds", "Duration of the most recent completed agent run", "gauge");
  registry.define(
    "merge_god_agent_tasks_total",
    "Agent-reported task outcomes (completed, failed); the pi runtime does not emit per-task breakdowns",
    "counter",
  );

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.dbPath, { readOnly: true });
  } catch {
    return; // Database unavailable; agent metrics stay at zero rather than failing the loop.
  }

  let lastEventRowid = 0;
  let lastSessionId = 0;

  const drain = (): void => {
    try {
      // A shared state database stores runs from every repository; scope this
      // loop's counters to its own runs. When unfiltered, totals are global.
      const repoFilter = options.repoName;
      const events = (repoFilter
        ? db
            .prepare(
              "SELECT e.rowid AS rid, e.event_type, e.payload FROM trajectory_events e" +
                " JOIN orchestration_runs o ON e.run_id = o.run_id" +
                " WHERE e.rowid > ? AND o.repo_name = ? ORDER BY e.rowid",
            )
            .all(lastEventRowid, repoFilter)
        : db
            .prepare("SELECT rowid AS rid, event_type, payload FROM trajectory_events WHERE rowid > ? ORDER BY rowid")
            .all(lastEventRowid)) as unknown as TrajectoryRow[];
      for (const event of events) {
        lastEventRowid = Math.max(lastEventRowid, Number(event.rid) || lastEventRowid);
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(event.payload ?? "{}") as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (event.event_type) {
          case "pi.agent_turn.completed": {
            for (const [direction, key] of TOKEN_FIELDS) {
              const value = count(payload[key]);
              if (value > 0) registry.inc("merge_god_agent_tokens_total", stamp({ direction }), value);
            }
            registry.inc("merge_god_agent_turns_total", stamp({ status: "completed" }));
            registry.inc("merge_god_agent_api_calls_total", stamp({}));
            break;
          }
          case "pi.agent_turn.interrupted": {
            registry.inc("merge_god_agent_turns_total", stamp({ status: "interrupted" }));
            break;
          }
          case "pi.tool_call.completed": {
            registry.inc(
              "merge_god_agent_tool_calls_total",
              stamp({
                tool: text(payload["tool_name"], "unknown"),
                status: text(payload["status"], "unknown"),
              }),
            );
            break;
          }
          case "pi.agent.completed": {
            const status = text(payload["status"], "unknown");
            registry.inc("merge_god_agent_runs_total", stamp({ status }));
            const durationMs = count(payload["duration_ms"]);
            if (durationMs > 0) {
              registry.set("merge_god_agent_run_duration_seconds", durationMs / 1000, stamp({ status }));
            }
            break;
          }
          case "runtime.workflow.completing": {
            registry.inc(
              "merge_god_agent_workflows_total",
              stamp({ result: payload["success"] === true ? "success" : "failure" }),
            );
            break;
          }
          default:
            break;
        }
      }

      const sessions = (repoFilter
        ? db
            .prepare(
              "SELECT id, input_tokens, output_tokens, total_tokens, api_calls, tasks_completed, tasks_failed" +
                " FROM agent_sessions WHERE id > ? AND repo_name = ? ORDER BY id",
            )
            .all(lastSessionId, repoFilter)
        : db
            .prepare(
              "SELECT id, input_tokens, output_tokens, total_tokens, api_calls, tasks_completed, tasks_failed" +
                " FROM agent_sessions WHERE id > ? ORDER BY id",
            )
            .all(lastSessionId)) as unknown as SessionRow[];
      for (const session of sessions) {
        lastSessionId = Math.max(lastSessionId, Number(session.id) || lastSessionId);
        const tokens: ReadonlyArray<[string, unknown]> = [
          ["input", session.input_tokens],
          ["output", session.output_tokens],
          ["total", session.total_tokens],
        ];
        for (const [direction, value] of tokens) {
          const amount = count(value);
          if (amount > 0) registry.inc("merge_god_agent_tokens_total", stamp({ direction }), amount);
        }
        const apiCalls = count(session.api_calls);
        if (apiCalls > 0) registry.inc("merge_god_agent_api_calls_total", stamp({}), apiCalls);
        const completed = count(session.tasks_completed);
        if (completed > 0) registry.inc("merge_god_agent_tasks_total", stamp({ result: "completed" }), completed);
        const failed = count(session.tasks_failed);
        if (failed > 0) registry.inc("merge_god_agent_tasks_total", stamp({ result: "failed" }), failed);
      }
    } catch {
      // Missing tables or transient lock: keep previously rendered values.
    }
  };

  registry.addCollector(drain);
}
