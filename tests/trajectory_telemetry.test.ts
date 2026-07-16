import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { AppStore } from "../app_store";
import { piAgentCompletionTelemetry, type PiToolingSnapshot } from "../coordination";
import { main as historyMain } from "../trajectory_history";
import { TrajectoryRuntime } from "../trajectory_runtime";

const tooling: PiToolingSnapshot = {
  injection: { method: "pi-cli-extension", extension_path: null, surface_scope: "extension" },
  surface: [],
  turns: [
    { turn_id: "turn-1", turn_index: 1, status: "completed", started_at: "2026-01-01T00:00:01.000Z", completed_at: "2026-01-01T00:00:04.000Z", tool_call_ids: ["call-1"] },
  ],
  calls: [],
  reliability: {
    started: 1,
    completed: 1,
    succeeded: 1,
    failed: 0,
    incomplete: 0,
    protocol_errors: 0,
    completion_ratio: 1,
  },
};

describe("trajectory telemetry", () => {
  test("normalizes exact provider timing, usage, cost, turns, and tool reliability", () => {
    const result = piAgentCompletionTelemetry(
      {
        status: "success",
        telemetry: {
          model: "provider/model-v1",
          usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_read_input_tokens: 400,
            total_tokens: 1250,
            cost_usd: 0.0125,
            cost_source: "provider-response",
            source: "pi-provider-usage",
          },
        },
      },
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:05.000Z",
      5000,
      tooling,
    );

    assert.equal(result["model"], "provider/model-v1");
    assert.equal(result["duration_ms"], 5000);
    assert.equal(result["total_tokens"], 1250);
    assert.equal(result["estimated_cost"], 0.0125);
    assert.equal(result["cost_source"], "provider-response");
    assert.equal(result["turn_count"], 1);
    assert.equal(result["tool_call_count"], 1);
  });

  test("materializes Pi event spans and exposes history, drill-down, and optimization profiles", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-trajectory-telemetry-"));
    const dbPath = path.join(tempDir, "history.db");
    const store = new AppStore(dbPath);
    let runId = "";
    try {
      const runtime = new TrajectoryRuntime(store);
      const started = runtime.startPrAgentWorkflow({
        repo_name: "test-repo",
        pr_number: 88,
        mode: "for-review",
        labels: ["for-review"],
        session_id: "pi-session-88",
        model: "provider/model-v1",
      });
      runId = started.ids.run_id;
      runtime.appendWorkflowEvent(started.ids, "pi.agent_turn.started", {
        turn_id: "turn-1",
        turn_index: 1,
        status: "started",
        started_at: "2026-01-01T00:00:01.000Z",
      }, "pi-extension");
      runtime.appendWorkflowEvent(started.ids, "pi.tool_call.started", {
        call_id: "call-1",
        turn_id: "turn-1",
        tool_name: "read",
        status: "started",
        started_at: "2026-01-01T00:00:02.000Z",
      }, "pi-extension");
      runtime.appendWorkflowEvent(started.ids, "pi.tool_call.completed", {
        call_id: "call-1",
        turn_id: "turn-1",
        tool_name: "read",
        status: "succeeded",
        started_at: "2026-01-01T00:00:02.000Z",
        completed_at: "2026-01-01T00:00:03.500Z",
        duration_ms: 1500,
      }, "pi-extension");
      runtime.appendWorkflowEvent(started.ids, "pi.agent_turn.completed", {
        turn_id: "turn-1",
        turn_index: 1,
        status: "completed",
        started_at: "2026-01-01T00:00:01.000Z",
        completed_at: "2026-01-01T00:00:04.000Z",
        total_tokens: 1250,
        estimated_cost: 0.0125,
      }, "pi-extension");
      runtime.appendWorkflowEvent(started.ids, "pi.agent.completed", {
        status: "success",
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:00:05.000Z",
        duration_ms: 5000,
        model: "provider/model-v1",
        input_tokens: 1000,
        output_tokens: 250,
        cache_read_input_tokens: 400,
        total_tokens: 1250,
        estimated_cost: 0.0125,
      });
      runtime.completePrAgentWorkflow(started.ids, { success: true, summary: "done" });

      const profiles = store.getTrajectoryRunProfiles("test-repo", 10);
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0]?.agent_duration_ms, 5000);
      assert.equal(profiles[0]?.estimated_cost, 0.0125);
      assert.equal(profiles[0]?.total_tokens, 1250);
      assert.equal(profiles[0]?.turn_count, 1);
      assert.equal(profiles[0]?.tool_call_count, 1);
      assert.equal(profiles[0]?.tool_duration_ms, 1500);

      const drilldown = store.getTrajectoryRunDrilldown(runId.slice(0, 8));
      assert.ok(drilldown);
      assert.deepEqual(drilldown.spans.map((span) => span.kind), ["agent", "agent_turn", "tool_call"]);
      assert.equal(drilldown.spans.find((span) => span.kind === "agent_turn")?.total_tokens, 1250);
      assert.equal(drilldown.spans.find((span) => span.kind === "agent_turn")?.estimated_cost, 0.0125);
      assert.equal(drilldown.spans.find((span) => span.kind === "tool_call")?.parent_span_id, `${runId}:agent_turn:turn-1`);

      const profile = store.getTrajectoryOptimizationProfile("test-repo", 10);
      assert.equal(profile.run_count, 1);
      assert.equal(profile.total_cost, 0.0125);
      assert.equal(profile.tools[0]?.name, "read");
      assert.equal(profile.tools[0]?.p95_duration_ms, 1500);
    } finally {
      store.close();
    }

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => output.push(String(value));
    try {
      assert.equal(historyMain([runId.slice(0, 8), "--db", dbPath, "--json"]), 0);
      const parsed = JSON.parse(output.join("\n")) as { summary: { total_tokens: number }; spans: unknown[] };
      assert.equal(parsed.summary.total_tokens, 1250);
      assert.equal(parsed.spans.length, 3);
    } finally {
      console.log = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
