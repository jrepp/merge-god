import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeReviewDecision,
  reviewDecisionGateStatus,
  reviewDecisionMergeBlocker,
  reviewDecisionSignalStatus,
  reviewDecisionSummary,
} from "../review_decision_model";

describe("review decision model", () => {
  test("normalizes review decisions before classification", () => {
    assert.equal(normalizeReviewDecision(" review_required "), "REVIEW_REQUIRED");
    assert.equal(normalizeReviewDecision(" changes requested "), "CHANGES_REQUESTED");
    assert.equal(normalizeReviewDecision("review-required"), "REVIEW_REQUIRED");
    assert.equal(normalizeReviewDecision("", "UNKNOWN"), "UNKNOWN");
    assert.equal(normalizeReviewDecision(null, "UNKNOWN"), "UNKNOWN");
  });

  test("projects review decisions into gate statuses and summaries", () => {
    assert.equal(reviewDecisionGateStatus("APPROVED"), "pass");
    assert.equal(reviewDecisionSummary("APPROVED"), "GitHub review decision is approved.");

    assert.equal(reviewDecisionGateStatus("REVIEW_REQUIRED"), "blocked");
    assert.equal(reviewDecisionSummary("REVIEW_REQUIRED"), "GitHub requires review before this PR can merge.");

    assert.equal(reviewDecisionGateStatus("CHANGES_REQUESTED"), "blocked");
    assert.equal(reviewDecisionSummary("CHANGES_REQUESTED"), "GitHub review decision has requested changes.");

    assert.equal(reviewDecisionGateStatus("UNKNOWN"), "unknown");
    assert.equal(reviewDecisionSignalStatus("UNKNOWN"), "unknown");
    assert.equal(reviewDecisionSummary("UNKNOWN"), "GitHub review decision is UNKNOWN.");

    assert.equal(reviewDecisionGateStatus("STALE"), "pending");
    assert.equal(reviewDecisionSignalStatus("STALE"), "unrecognized");
    assert.equal(reviewDecisionSummary("STALE"), "GitHub review decision is STALE.");
    assert.equal(reviewDecisionSignalStatus("APPROVED"), "decisive");
    assert.equal(reviewDecisionSignalStatus("CHANGES_REQUESTED"), "decisive");
  });

  test("projects non-approved review decisions into merge blockers", () => {
    assert.equal(reviewDecisionMergeBlocker("APPROVED"), null);
    assert.equal(reviewDecisionMergeBlocker(""), null);

    assert.deepEqual(reviewDecisionMergeBlocker("REVIEW_REQUIRED"), {
      kind: "review_required",
      status: "blocked",
      summary: "GitHub requires review before this PR can merge.",
      evidence_refs: ["github:reviewDecision"],
    });

    assert.deepEqual(reviewDecisionMergeBlocker("CHANGES_REQUESTED"), {
      kind: "changes_requested",
      status: "blocked",
      summary: "GitHub review decision has requested changes.",
      evidence_refs: ["github:reviewDecision"],
    });

    assert.deepEqual(reviewDecisionMergeBlocker("STALE"), {
      kind: "unknown",
      status: "unknown",
      summary: "GitHub review decision is STALE.",
      evidence_refs: ["github:reviewDecision"],
    });

    assert.deepEqual(reviewDecisionMergeBlocker(normalizeReviewDecision("changes requested")), {
      kind: "changes_requested",
      status: "blocked",
      summary: "GitHub review decision has requested changes.",
      evidence_refs: ["github:reviewDecision"],
    });
  });
});
