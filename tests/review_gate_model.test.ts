import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeReviewGateStatus,
  normalizeReviewGateStatusRow,
} from "../review_gate_model";

describe("review gate model", () => {
  test("normalizes gate status aliases and malformed statuses", () => {
    assert.equal(normalizeReviewGateStatus(" PASSED "), "pass");
    assert.equal(normalizeReviewGateStatus("success"), "pass");
    assert.equal(normalizeReviewGateStatus("ok"), "pass");
    assert.equal(normalizeReviewGateStatus("FAILED"), "fail");
    assert.equal(normalizeReviewGateStatus("failure"), "fail");
    assert.equal(normalizeReviewGateStatus("error"), "fail");
    assert.equal(normalizeReviewGateStatus("blocked"), "blocked");
    assert.equal(normalizeReviewGateStatus("skipped"), "skipped");
    assert.equal(normalizeReviewGateStatus("pending"), "pending");
    assert.equal(normalizeReviewGateStatus("unknown"), "unknown");
    assert.equal(normalizeReviewGateStatus(""), "unknown");
    assert.equal(normalizeReviewGateStatus(null), "unknown");
  });

  test("normalizes partial gate rows with explicit defaults", () => {
    assert.deepEqual(
      normalizeReviewGateStatusRow({
        rule: " ci-status ",
        status: " SUCCESS ",
        explanation: " checks passed ",
      }),
      {
        rule: "ci-status",
        status: "pass",
        explanation: "checks passed",
      },
    );

    assert.deepEqual(normalizeReviewGateStatusRow({ status: "wat" }), {
      rule: "review-gates",
      status: "unknown",
      explanation: "No gate explanation was provided.",
    });
    assert.deepEqual(normalizeReviewGateStatusRow(null), {
      rule: "review-gates",
      status: "unknown",
      explanation: "No gate explanation was provided.",
    });
  });

  test("normalizes direct edge-shaped gate rows", () => {
    assert.deepEqual(
      normalizeReviewGateStatusRow({
        cursor: "gate-1",
        node: {
          rule: " modeled-blockers ",
          status: " failure ",
          explanation: " CI failed ",
        },
      }),
      {
        rule: "modeled-blockers",
        status: "fail",
        explanation: "CI failed",
      },
    );
  });
});
