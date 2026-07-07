import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppStore } from "../app_store";
import { EMBARK_COHORT_WORKFLOW, ONE_SHOT_PR_AGENT_WORKFLOW, TrajectoryRuntime } from "../trajectory_runtime";

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
      const bridge = runtime.bridgeForPiAgent(started.ids);
      bridge.appendEvent({
        event_type: "decision.made",
        actor: "pi-agent",
        payload: { summary: "continue with validation" },
      });
      bridge.heartbeat?.({ phase: "validation" });
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
          "decision.made",
          "runtime.workflow.heartbeat",
          "runtime.workflow.completing",
          "compatibility_trajectory.completed",
        ],
      );
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates a PR queue, claims activities, evaluates guardrails, and completes the run", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-runtime-"));
    const dbPath = path.join(tempDir, "runtime.db");
    const store = new AppStore(dbPath);
    try {
      const runtime = new TrajectoryRuntime(store);
      const queued = runtime.startPrQueueWorkflow({
        repo_name: "test-repo",
        repo_path: "/repo",
        base_branch: "main",
        objective: "process two PRs",
        items: [
          {
            repo_name: "test-repo",
            number: 2,
            title: "Second priority",
            mode: "for-landing",
            labels: ["for-landing"],
            priority: 2,
          },
          {
            repo_name: "test-repo",
            number: 1,
            title: "First priority",
            mode: "for-review",
            labels: ["for-review"],
            priority: 1,
          },
        ],
      });

      assert.equal(queued.workflow.id, "workflow://merge-god/pr-queue");
      assert.equal(queued.state.work_items.length, 2);
      assert.equal(queued.state.activities.every((activity) => activity.status === "ready"), true);

      const firstClaim = runtime.claimNextActivity(queued.ids.run_id);
      assert.ok(firstClaim !== null);
      assert.equal(firstClaim!.work_item?.number, 1);
      assert.equal(firstClaim!.activity.status, "claimed");
      const firstGuardrails = runtime.evaluateActivityGuardrails(firstClaim!);
      assert.equal(firstGuardrails.passed, true);
      const firstStarted = runtime.startClaimedActivity(firstClaim!, "session-1", "test-model");
      assert.ok(firstStarted.ids.activity_session_id);
      const proposal = runtime.proposeNextAction(firstStarted.ids, {
        next_action: "create_child_activity",
        rationale: "CI needs a scoped follow-up.",
        evidence_refs: ["evidence://ci/failure"],
      });
      assert.equal(proposal.accepted, true);
      const rejectedMissingModelTier = runtime.createChildActivity(firstStarted.ids, {
        type: "ci_diagnosis",
        summary: "Diagnose failing CI before merge gate.",
        evidence_refs: ["evidence://ci/failure"],
      });
      assert.equal(rejectedMissingModelTier.accepted, false);
      assert.match(rejectedMissingModelTier.reason ?? "", /model_tier/);
      const child = runtime.createChildActivity(firstStarted.ids, {
        type: "ci_diagnosis",
        summary: "Diagnose failing CI before merge gate.",
        model_tier: "standard",
        model_reason: "CI diagnosis needs enough reasoning to interpret failing checks.",
        evidence_refs: ["evidence://ci/failure"],
      });
      assert.equal(child.accepted, true);
      assert.ok(child.child_activity_id);
      const stateAfterChild = runtime.getRunState(queued.ids.run_id);
      const childActivity = stateAfterChild?.activities.find((activity) => activity.activity_id === child.child_activity_id);
      assert.deepEqual(childActivity?.model_profile, {
        model_tier: "standard",
        model_reason: "CI diagnosis needs enough reasoning to interpret failing checks.",
      });
      const rejectedChild = runtime.createChildActivity(firstStarted.ids, {
        type: "embark_planning",
        summary: "Invalid child for review workflow.",
        model_tier: "high",
        model_reason: "Would coordinate a cohort, but this parent cannot create that activity type.",
      });
      assert.equal(rejectedChild.accepted, false);
      runtime.completeActivity(firstStarted, { success: true, summary: "first done" });
      const afterParentComplete = runtime.getRunState(queued.ids.run_id);
      const firstItemAfterParent = afterParentComplete?.work_items.find((item) => item.number === 1);
      assert.equal(firstItemAfterParent?.status, "running");
      assert.equal(firstItemAfterParent?.next_action, "claim_activity");

      const secondClaim = runtime.claimNextActivity(queued.ids.run_id);
      assert.ok(secondClaim !== null);
      assert.equal(secondClaim!.work_item?.number, 1);
      const secondGuardrails = runtime.evaluateActivityGuardrails(secondClaim!);
      assert.equal(secondGuardrails.passed, true);
      const secondStarted = runtime.startClaimedActivity(secondClaim!, "session-2", "test-model");
      runtime.completeActivity(secondStarted, { success: true, summary: "second done" });

      const thirdClaim = runtime.claimNextActivity(queued.ids.run_id);
      assert.ok(thirdClaim !== null);
      assert.equal(thirdClaim!.work_item?.number, 2);
      const thirdGuardrails = runtime.evaluateActivityGuardrails(thirdClaim!);
      assert.equal(thirdGuardrails.passed, true);
      const thirdStarted = runtime.startClaimedActivity(thirdClaim!, "session-3", "test-model");
      runtime.completeActivity(thirdStarted, { success: true, summary: "third done" });

      const finalState = runtime.getRunState(queued.ids.run_id);
      assert.ok(finalState !== null);
      assert.equal(finalState!.run.status, "completed");
      assert.equal(finalState!.worksets[0]!.status, "completed");
      assert.deepEqual(
        finalState!.work_items.map((item) => [item.number, item.status]),
        [
          [1, "validated"],
          [2, "validated"],
        ],
      );
      assert.ok(finalState!.events.some((event) => event.event_type === "runtime.queue.created"));
      assert.ok(finalState!.events.some((event) => event.event_type === "guardrail.evaluated"));
      assert.ok(finalState!.events.some((event) => event.event_type === "activity.next_action.proposed"));
      assert.ok(finalState!.events.some((event) => event.event_type === "activity.child_created"));
      assert.ok(finalState!.events.some((event) => event.event_type === "activity.child_rejected"));
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("captures an embark cohort for grouped merge-commit validation", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-runtime-"));
    const dbPath = path.join(tempDir, "runtime.db");
    const store = new AppStore(dbPath);
    try {
      const runtime = new TrajectoryRuntime(store);
      const started = runtime.startEmbarkCohortWorkflow({
        repo_name: "test-repo",
        repo_path: "/repo",
        base_branch: "main",
        cohort_id: "cohort-1",
        integration_branch: "merge-god/embark/cohort-1",
        output_pr_number: 99,
        output_pr_url: "https://example.test/pull/99",
        validation_commands: ["npm run ci"],
        items: [
          {
            repo_name: "test-repo",
            number: 10,
            title: "Ready dependency PR A",
            labels: ["for-landing", "merge:ready"],
            head_ref: "renovate/a",
            priority: 1,
          },
          {
            repo_name: "test-repo",
            number: 11,
            title: "Ready dependency PR B",
            labels: ["for-landing", "merge:ready"],
            head_ref: "renovate/b",
            priority: 2,
          },
        ],
      });

      assert.equal(started.workflow.id, EMBARK_COHORT_WORKFLOW.id);
      assert.equal(started.state.run.current_phase, "embark_cohort_ready");
      assert.equal(started.state.worksets[0]!.kind, "embark_cohort");
      assert.equal(started.state.worksets[0]!.approval_state, "pending");
      assert.equal(started.state.worksets[0]!.metadata["cohort_id"], "cohort-1");
      assert.deepEqual(
        started.state.work_items.map((item) => [item.number, item.status, item.metadata["merge_order"]]),
        [
          [10, "embarked", 1],
          [11, "embarked", 2],
        ],
      );
      assert.equal(started.state.activities.length, 1);
      assert.equal(started.state.activities[0]!.type, "merge_gate");
      assert.equal(started.state.activities[0]!.work_item_id, null);
      assert.deepEqual(started.state.activities[0]!.metadata["validation_commands"], ["npm run ci"]);
      assert.deepEqual(
        started.state.events.map((event) => event.event_type),
        ["runtime.embark_cohort.created", "runtime.workflow.started"],
      );
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
