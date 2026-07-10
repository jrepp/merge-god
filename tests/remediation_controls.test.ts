import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppStore } from "../app_store";
import { resolveRemediationPolicy } from "../remediation_policy_model";
import { reviewGateStatusesFromContext } from "../review_gate_status";
import { TrajectoryRuntime } from "../trajectory_runtime";

function withRuntime(run: (runtime: TrajectoryRuntime) => void): void {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mg-remediation-"));
  const store = new AppStore(path.join(tempDir, "runtime.db"));
  try {
    run(new TrajectoryRuntime(store));
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("remediation controls", () => {
  test("persists a label-capped budget and blocks a mutating activity", () => {
    withRuntime((runtime) => {
      const started = runtime.startPrQueueWorkflow({
        repo_name: "test-repo",
        repository_remediation_mode: "bounded-fixes",
        items: [{
          repo_name: "test-repo",
          number: 41,
          title: "Validate without mutation",
          mode: "for-review",
          labels: ["for-review", "remediation:validate-only"],
        }],
      });

      const item = started.state.work_items[0]!;
      const activity = started.state.activities[0]!;
      assert.equal(item.disposition_setting, "validate-only");
      assert.equal(item.risk_signals["remediation_policy"] instanceof Object, true);
      assert.deepEqual(activity.tool_policy, {
        remediation_mode: "validate-only",
        mutating_allowed: false,
        budget: {
          mutating_allowed: false,
          max_fix_attempts: 0,
          max_files_changed: 0,
          max_changed_lines: 0,
          max_duration_minutes: 20,
          max_input_tokens: 16_000,
        },
      });

      const claim = runtime.claimNextActivity(started.ids.run_id);
      assert.ok(claim);
      const guardrails = runtime.evaluateActivityGuardrails(claim!);
      assert.equal(guardrails.passed, false);
      assert.equal(
        guardrails.checks.find((check) => check.name === "disposition_cap")?.passed,
        false,
      );
    });
  });

  test("fails closed on ambiguous labels before tool execution", () => {
    withRuntime((runtime) => {
      const started = runtime.startPrQueueWorkflow({
        repo_name: "test-repo",
        repository_remediation_mode: "bounded-fixes",
        items: [{
          repo_name: "test-repo",
          number: 42,
          title: "Ambiguous autonomy",
          mode: "for-landing",
          labels: [
            "for-landing",
            "remediation:mechanical-fixes",
            "remediation:bounded-fixes",
          ],
        }],
      });

      assert.equal(started.state.work_items[0]!.disposition_setting, "observe-only");
      assert.equal(started.state.work_items[0]!.blockers.length, 1);
      const claim = runtime.claimNextActivity(started.ids.run_id);
      assert.ok(claim);
      const guardrails = runtime.evaluateActivityGuardrails(claim!);
      assert.equal(guardrails.passed, false);
      assert.equal(
        guardrails.checks.find((check) => check.name === "remediation_policy")?.passed,
        false,
      );
    });
  });

  test("allows mechanical mutation within the derived tool budget", () => {
    withRuntime((runtime) => {
      const started = runtime.startPrQueueWorkflow({
        repo_name: "test-repo",
        repository_remediation_mode: "bounded-fixes",
        items: [{
          repo_name: "test-repo",
          number: 43,
          title: "Mechanical repair",
          mode: "for-landing",
          labels: ["for-landing", "remediation:mechanical-fixes"],
        }],
      });

      assert.equal(started.state.work_items[0]!.disposition_setting, "mechanical-fixes");
      assert.equal(started.state.activities[0]!.tool_policy["mutating_allowed"], true);
      assert.equal(
        (started.state.activities[0]!.tool_policy["budget"] as Record<string, unknown>)["max_fix_attempts"],
        2,
      );
      const claim = runtime.claimNextActivity(started.ids.run_id);
      assert.ok(claim);
      assert.equal(runtime.evaluateActivityGuardrails(claim!).passed, true);
    });
  });

  test("projects the effective decision into the PR review-gate summary", () => {
    const decision = resolveRemediationPolicy({
      labels: ["remediation:mechanical-fixes"],
      repository_mode: "bounded-fixes",
      risk_ceiling: "validate-only",
    });
    const gates = reviewGateStatusesFromContext(
      { number: 44, title: "Visible threshold", headRefName: "feature", baseRefName: "main" },
      { remediation_policy: decision },
      "Source: `commandments.yaml`",
    );
    const gate = gates.find((candidate) => candidate.rule === "remediation-policy");

    assert.equal(gate?.status, "pass");
    assert.match(gate?.explanation ?? "", /effective validate-only/);
    assert.match(gate?.explanation ?? "", /0 fix attempts/);
    assert.match(gate?.explanation ?? "", /reduced/);
  });
});
