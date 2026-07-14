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
      const closeout = runtime.completePrAgentWorkflow(started.ids, {
        success: true,
        summary: "runtime test completed",
      });
      assert.equal(closeout.complete, true);

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
          "runtime.workflow.closed",
        ],
      );
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects successful closeout while child remediation remains open", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-runtime-closeout-"));
    const store = new AppStore(path.join(tempDir, "runtime.db"));
    try {
      const runtime = new TrajectoryRuntime(store);
      const started = runtime.startPrAgentWorkflow({
        repo_name: "test-repo",
        pr_number: 13,
        mode: "for-landing",
        labels: ["for-landing"],
      });
      const child = runtime.createChildActivity(started.ids, {
        type: "ci_diagnosis",
        summary: "Diagnose the low-level failure before closeout.",
        model_tier: "standard",
        model_reason: "Diagnosis requires repository and CI context.",
      });
      assert.equal(child.accepted, true);

      assert.throws(
        () => runtime.completePrAgentWorkflow(started.ids, { success: true, summary: "premature" }),
        /child activities remain open/,
      );
      const open = runtime.getCloseoutReport(started.ids.run_id);
      assert.equal(open.complete, false);
      assert.ok(open.open_activity_ids.includes(started.ids.activity_id));
      assert.ok(open.open_activity_ids.includes(child.child_activity_id!));

      const closed = runtime.completePrAgentWorkflow(started.ids, {
        success: false,
        summary: "Canceled after incomplete remediation was detected.",
      });
      assert.equal(closed.complete, true);
      const state = runtime.getRunState(started.ids.run_id);
      assert.equal(
        state?.activities.find((activity) => activity.activity_id === child.child_activity_id)?.status,
        "canceled",
      );
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resumes an open PR trajectory with a replacement session and reconciled execution leaves", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-runtime-resume-"));
    const store = new AppStore(path.join(tempDir, "runtime.db"));
    try {
      const runtime = new TrajectoryRuntime(store);
      const started = runtime.startOrResumePrAgentWorkflow({
        repo_name: "test-repo",
        pr_number: 14,
        mode: "for-landing",
        labels: ["for-landing"],
        session_id: "pi-session-1",
      });
      assert.equal(started.resumed, false);
      runtime.appendWorkflowEvent(started.ids, "pi.agent_turn.started", {
        turn_id: `${started.ids.activity_session_id}:turn:0`,
        turn_index: 0,
      }, "pi-extension");
      runtime.appendWorkflowEvent(started.ids, "pi.tool_call.started", {
        call_id: "call-open",
        tool_name: "bash",
        turn_id: `${started.ids.activity_session_id}:turn:0`,
        status: "started",
      }, "pi-extension");

      const open = runtime.getRunState(started.ids.run_id);
      assert.equal(open?.resume.resumable, true);
      assert.deepEqual(open?.resume.open_agent_turn_ids, [`${started.ids.activity_session_id}:turn:0`]);
      assert.deepEqual(open?.resume.open_tool_call_ids, ["call-open"]);

      const resumed = runtime.startOrResumePrAgentWorkflow({
        repo_name: "test-repo",
        pr_number: 14,
        mode: "for-landing",
        labels: ["for-landing"],
        session_id: "pi-session-2",
      });
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.ids.run_id, started.ids.run_id);
      assert.notEqual(resumed.ids.activity_session_id, started.ids.activity_session_id);
      const priorSession = resumed.state.activity_sessions.find((session) =>
        session.activity_session_id === started.ids.activity_session_id
      );
      assert.equal(priorSession?.status, "interrupted");
      assert.ok(priorSession?.completed_at);
      assert.deepEqual(resumed.state.resume.open_agent_turn_ids, []);
      assert.deepEqual(resumed.state.resume.open_tool_call_ids, []);
      assert.equal(resumed.state.resume.open_activity_session_ids.length, 1);
      const reconciledToolCall = resumed.state.hierarchy.find((record) =>
        record.level === "tool_call" && record.id === "call-open"
      );
      assert.equal(reconciledToolCall?.parent_level, "agent_turn");
      assert.equal(reconciledToolCall?.parent_id, `${started.ids.activity_session_id}:turn:0`);
      assert.equal(reconciledToolCall?.state, "failed");
      assert.ok(resumed.state.events.some((event) => event.event_type === "compatibility_trajectory.resumed"));
      assert.ok(resumed.state.events.some((event) => event.event_type === "runtime.workflow.resumed"));

      const closeout = runtime.completePrAgentWorkflow(resumed.ids, {
        success: false,
        summary: "resume test closeout",
      });
      assert.equal(closeout.complete, true);
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
