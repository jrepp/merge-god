import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppStore } from "../app_store";
import { ONE_SHOT_PR_AGENT_WORKFLOW, TrajectoryRuntime } from "../trajectory_runtime";

describe("TrajectoryRuntime", () => {
  test("starts and completes the one-shot PR agent workflow", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-runtime-"));
    const dbPath = path.join(tempDir, "runtime.db");
    const store = new AppStore(dbPath);
    try {
      const runtime = new TrajectoryRuntime(store);
      const started = runtime.startPrAgentWorkflow({
        repo_name: "test-repo",
        pr_number: 12,
        mode: "for-landing",
        title: "Runtime PR",
        labels: ["for-landing"],
        model: "test-model",
      });

      assert.equal(started.workflow.id, ONE_SHOT_PR_AGENT_WORKFLOW.id);
      assert.equal(started.state.run.status, "executing");
      assert.deepEqual(
        started.state.events.map((event) => event.event_type),
        ["compatibility_trajectory.started", "runtime.workflow.started"],
      );

      runtime.appendWorkflowEvent(started.ids, "runtime.workflow.checkpoint", {
        phase: "agent_processing",
      });
      runtime.completePrAgentWorkflow(started.ids, {
        success: true,
        summary: "runtime test completed",
      });

      const state = runtime.getRunState(started.ids.run_id);
      assert.ok(state !== null);
      assert.equal(state!.run.status, "completed");
      assert.deepEqual(
        state!.events.map((event) => event.event_type),
        [
          "compatibility_trajectory.started",
          "runtime.workflow.started",
          "runtime.workflow.checkpoint",
          "runtime.workflow.completing",
          "compatibility_trajectory.completed",
        ],
      );
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
