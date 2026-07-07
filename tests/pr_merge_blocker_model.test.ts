import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isDedicatedReviewGateBlocker,
  topLevelModeledMergeBlockers,
} from "../pr_merge_blocker_model";

describe("PR merge blocker model", () => {
  test("classifies cached CI-unknown blocker variants as dedicated gate blockers", () => {
    assert.equal(
      isDedicatedReviewGateBlocker({
        kind: "ci_unknown",
        status: "unknown",
        summary: "Status checks could not be normalized.",
        evidence_refs: ["github:statusCheckRollup"],
      }),
      true,
    );
    assert.equal(
      isDedicatedReviewGateBlocker({
        kind: "unknown",
        status: "unknown",
        summary: "Cached status rollup is incomplete.",
        evidenceRefs: ["github:statusCheckRollup"],
      }),
      true,
    );
    assert.equal(
      isDedicatedReviewGateBlocker({
        kind: "unknown",
        status: "unknown",
        summary: "External deployment state is unknown.",
        evidence_refs: ["deploy:unknown"],
      }),
      false,
    );
  });

  test("classifies common cached dedicated blocker kind spellings", () => {
    for (const kind of [
      "CI Failed",
      "ci-failed",
      "ci pending",
      "CI Missing",
      "merge-conflicts",
      "review required",
      "Changes Requested",
    ]) {
      assert.equal(
        isDedicatedReviewGateBlocker({
          kind,
          status: "blocked",
          summary: `${kind} is represented by a dedicated gate row.`,
        }),
        true,
        kind,
      );
    }
  });

  test("classifies cached unknown CI summaries without depending on case", () => {
    for (const summary of [
      "1 ci check(s) could not be classified.",
      "CI checks could not be classified.",
      "Status check could not be normalized.",
      "Status checks could not be normalized.",
    ]) {
      assert.equal(
        isDedicatedReviewGateBlocker({
          kind: "UNKNOWN",
          status: "unknown",
          summary,
        }),
        true,
        summary,
      );
    }
  });

  test("filters dedicated top-level blockers without dropping supplemental unknown blockers", () => {
    const supplementalUnknown = {
      kind: "unknown",
      status: "unknown",
      summary: "External deployment state is unknown.",
      evidence_refs: ["deploy:unknown"],
    };

    assert.deepEqual(
      topLevelModeledMergeBlockers([
        {
          type: "ci_unknown",
          state: "unknown",
          message: "Status checks could not be normalized.",
          evidenceRefs: ["github:statusCheckRollup"],
        },
        {
          category: "review_required",
          outcome: "blocked",
          description: "Review is required.",
          evidence_refs: ["github:reviewDecision"],
        },
        supplementalUnknown,
      ]),
      [supplementalUnknown],
    );
  });
});
