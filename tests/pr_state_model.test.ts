import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  activePrStateLabel,
  isPrStateLabel,
  prStateFromAgentDecision,
  prStateLabel,
  prStateLabelNames,
  stalePrStateLabelNames,
} from "../pr_state";

describe("PR state model", () => {
  test("defines stable label metadata for processing states", () => {
    assert.deepEqual(prStateLabel("processing"), {
      name: "merge:processing",
      color: "1D76DB",
      description: "merge-god is actively processing this PR",
    });
    assert.deepEqual(prStateLabelNames(), [
      "merge:ready",
      "merge:processing",
      "merge:embarked",
      "merge:blocked",
      "merge:failed",
      "merge:complete",
    ]);
  });

  test("recognizes state labels and active skip labels case-insensitively", () => {
    assert.equal(isPrStateLabel(" MERGE:READY "), true);
    assert.equal(isPrStateLabel("for-landing"), false);
    assert.equal(activePrStateLabel(["for-landing", " MERGE:BLOCKED "]), "merge:blocked");
    assert.equal(activePrStateLabel(["merge:ready", "for-review"]), null);
  });

  test("plans stale labels for a target state without side effects", () => {
    assert.deepEqual(stalePrStateLabelNames("blocked"), [
      "merge:ready",
      "merge:processing",
      "merge:embarked",
      "merge:failed",
      "merge:complete",
    ]);
  });

  test("maps agent decisions to final processing states", () => {
    assert.equal(prStateFromAgentDecision({ success: true, failure_state: "failed" }), "complete");
    assert.equal(prStateFromAgentDecision({ success: false, failure_state: "blocked" }), "blocked");
    assert.equal(prStateFromAgentDecision({ success: false, failure_state: "failed" }), "failed");
    assert.equal(prStateFromAgentDecision({ success: false, failure_state: null }), "failed");
  });
});
