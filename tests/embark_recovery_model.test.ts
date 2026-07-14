import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { planEmbarkRecovery } from "../embark_recovery_model";

describe("embark recovery model", () => {
  const members = [
    { pr_number: 201, priority: 1 },
    { pr_number: 202, priority: 2 },
    { pr_number: 203, priority: 3 },
  ];

  test("splits a validated prefix and replans from merge failure evidence", () => {
    const plan = planEmbarkRecovery({
      members,
      validated_pr_numbers: [201],
      failure: {
        pr_number: 202,
        summary: "merge conflict in command wrapper",
        conflict_files: ["scripts/start-dev", "scripts/start-dev", " "],
        evidence_refs: ["comment:202", "comment:202"],
        disposition: "needs-redesign",
      },
    });

    assert.deepEqual(plan, {
      strategy: "split-and-replan",
      validated_pr_numbers: [201],
      failed_pr_number: 202,
      deferred_pr_numbers: [203],
      conflict_files: ["scripts/start-dev"],
      evidence_refs: ["comment:202"],
      summary: "merge conflict in command wrapper",
      disposition: "needs-redesign",
    });
  });

  test("replans the failed member when no prefix validated", () => {
    const plan = planEmbarkRecovery({
      members,
      failure: {
        pr_number: 201,
        summary: "first merge failed",
        evidence_refs: ["git:merge-tree"],
      },
    });
    assert.equal(plan.strategy, "replan-failed-member");
    assert.deepEqual(plan.deferred_pr_numbers, [202, 203]);
  });

  test("rejects failure claims without durable evidence", () => {
    assert.throws(
      () => planEmbarkRecovery({
        members,
        failure: { pr_number: 202, summary: "conflict" },
      }),
      /requires conflict files or evidence refs/,
    );
  });

  test("rejects a validated member that follows the failed PR", () => {
    assert.throws(
      () => planEmbarkRecovery({
        members,
        validated_pr_numbers: [203],
        failure: {
          pr_number: 202,
          summary: "conflict",
          conflict_files: ["scripts/start-dev"],
        },
      }),
      /must precede the failed PR/,
    );
  });
});
