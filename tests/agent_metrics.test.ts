import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import { MetricsRegistry } from "../metrics_server";
import { registerAgentMetrics } from "../agent_metrics";

let dir: string;
let dbPath: string;
let db: DatabaseSync;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-god-agent-metrics-"));
  dbPath = join(dir, "state.db");
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT
    );
    CREATE TABLE orchestration_runs (
      run_id TEXT PRIMARY KEY,
      repo_name TEXT
    );
    CREATE TABLE agent_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_name TEXT,
      status TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      api_calls INTEGER,
      tasks_completed INTEGER,
      tasks_failed INTEGER,
      tasks_total INTEGER,
      estimated_cost REAL
    );
  `);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertEvent(eventType: string, payload: unknown, runId = "run-hosting"): void {
  db.prepare("INSERT INTO trajectory_events (run_id, event_type, payload) VALUES (?, ?, ?)").run(
    runId,
    eventType,
    JSON.stringify(payload),
  );
}

function insertRun(runId: string, repoName: string): void {
  db.prepare("INSERT INTO orchestration_runs (run_id, repo_name) VALUES (?, ?)").run(runId, repoName);
}

function renderAgentMetrics(): string {
  const registry = new MetricsRegistry();
  registerAgentMetrics(registry, { dbPath, repo: "jrepp/hosting", repoName: "hosting" });
  return registry.render();
}

test("agent metrics drain trajectory events into labeled counters", () => {
  insertRun("run-hosting", "hosting");
  insertRun("run-other", "sdk");
  insertEvent("pi.agent_turn.completed", {
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 50,
    total_tokens: 160,
    estimated_cost: 0,
  });
  insertEvent("pi.tool_call.completed", { tool_name: "bash", status: "succeeded" });
  insertEvent("pi.tool_call.completed", { tool_name: "bash", status: "failed" });
  insertEvent("runtime.workflow.completing", { success: true });
  insertEvent("pi.agent.completed", { status: "success", duration_ms: 2500 });
  insertEvent("pi.agent_turn.completed", { input_tokens: 999, total_tokens: 999 }, "run-other");

  const text = renderAgentMetrics();
  assert.ok(text.includes('merge_god_agent_tokens_total{direction="input",repo="jrepp/hosting"} 100'));
  assert.ok(text.includes('merge_god_agent_tokens_total{direction="cache_read",repo="jrepp/hosting"} 50'));
  assert.ok(text.includes('merge_god_agent_tokens_total{direction="total",repo="jrepp/hosting"} 160'));
  assert.ok(text.includes('merge_god_agent_turns_total{repo="jrepp/hosting",status="completed"} 1'));
  assert.ok(text.includes('merge_god_agent_api_calls_total{repo="jrepp/hosting"} 1'));
  assert.ok(text.includes('merge_god_agent_tool_calls_total{repo="jrepp/hosting",status="succeeded",tool="bash"} 1'));
  assert.ok(text.includes('merge_god_agent_tool_calls_total{repo="jrepp/hosting",status="failed",tool="bash"} 1'));
  assert.ok(text.includes('merge_god_agent_workflows_total{repo="jrepp/hosting",result="success"} 1'));
  assert.ok(text.includes('merge_god_agent_runs_total{repo="jrepp/hosting",status="success"} 1'));
  assert.ok(text.includes('merge_god_agent_run_duration_seconds{repo="jrepp/hosting",status="success"} 2.5'));
});

test("collectors drain only new rows on subsequent renders", () => {
  const before = renderAgentMetrics();
  const turnsBefore = before
    .split("\n")
    .find((line) => line.includes("merge_god_agent_turns_total") && line.includes('status="completed"'));
  assert.ok(turnsBefore?.endsWith(" 1"));

  insertEvent("pi.agent_turn.completed", { input_tokens: 5, output_tokens: 1, total_tokens: 6 });
  const after = renderAgentMetrics();
  const turnsLine = after
    .split("\n")
    .find((line) => line.includes("merge_god_agent_turns_total") && line.includes('status="completed"'));
  assert.ok(turnsLine?.endsWith(" 2"));
  assert.ok(after.includes('merge_god_agent_tokens_total{direction="input",repo="jrepp/hosting"} 105'));
});

test("agent_sessions rows feed api calls and task outcomes", () => {
  db.prepare(
    "INSERT INTO agent_sessions (repo_name, status, input_tokens, output_tokens, total_tokens, api_calls, tasks_completed, tasks_failed, tasks_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("hosting", "success", 200, 20, 220, 4, 3, 1, 4);
  db.prepare(
    "INSERT INTO agent_sessions (repo_name, status, input_tokens, output_tokens, total_tokens, api_calls, tasks_completed, tasks_failed, tasks_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("sdk", "success", 500, 50, 550, 9, 7, 0, 7);

  const text = renderAgentMetrics();
  assert.ok(text.includes('merge_god_agent_tokens_total{direction="output",repo="jrepp/hosting"} 31'));
  assert.ok(text.includes('merge_god_agent_api_calls_total{repo="jrepp/hosting"} 6'));
  assert.ok(text.includes('merge_god_agent_tasks_total{repo="jrepp/hosting",result="completed"} 3'));
  assert.ok(text.includes('merge_god_agent_tasks_total{repo="jrepp/hosting",result="failed"} 1'));
});

test("interrupted turns and non-object payloads do not break the collector", () => {
  insertEvent("pi.agent_turn.interrupted", { turn_index: 3 });
  insertEvent("pi.agent_turn.completed", "not-json");
  const text = renderAgentMetrics();
  assert.ok(text.includes('merge_god_agent_turns_total{repo="jrepp/hosting",status="interrupted"} 1'));
  assert.ok(text.includes('merge_god_agent_turns_total{repo="jrepp/hosting",status="completed"} 3'));
});
