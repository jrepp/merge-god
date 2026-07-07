import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  extractLabelMergeGateBlockers,
  isBlockingMergeLabel,
} from "../label_gate_model";

describe("label gate model", () => {
  test("classifies explicit hold labels without treating processing labels as blockers", () => {
    assert.equal(isBlockingMergeLabel("do-not-merge"), true);
    assert.equal(isBlockingMergeLabel("blocked-by-dependency"), true);
    assert.equal(isBlockingMergeLabel("needs-rebase"), true);
    assert.equal(isBlockingMergeLabel("merge conflicts"), true);
    assert.equal(isBlockingMergeLabel("ci failing"), true);
    assert.equal(isBlockingMergeLabel("failing tests"), true);
    assert.equal(isBlockingMergeLabel("needs approval"), true);
    assert.equal(isBlockingMergeLabel("waiting-on-security"), true);
    assert.equal(isBlockingMergeLabel("human gate"), true);
    assert.equal(isBlockingMergeLabel("for-landing"), false);
    assert.equal(isBlockingMergeLabel("for-review"), false);
    assert.equal(isBlockingMergeLabel("merge:blocked"), false);
    assert.equal(isBlockingMergeLabel("needs review"), false);
    assert.equal(isBlockingMergeLabel("security review"), false);
  });

  test("projects current blocking labels into external gate blockers", () => {
    assert.deepEqual(
      extractLabelMergeGateBlockers([
        "for-landing",
        "Do Not Merge",
        "needs-rebase",
        "ci failing",
        "do-not-merge",
        "needs approval",
        "merge:blocked",
        "needs review",
      ]),
      [
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Label 'Do Not Merge' marks this PR as blocked for landing.",
          evidence_refs: ["github:label:do-not-merge"],
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Label 'needs-rebase' marks this PR as blocked for landing.",
          evidence_refs: ["github:label:needs-rebase"],
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Label 'ci failing' marks this PR as blocked for landing.",
          evidence_refs: ["github:label:ci-failing"],
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Label 'needs approval' marks this PR as blocked for landing.",
          evidence_refs: ["github:label:needs-approval"],
        },
      ],
    );
  });
});
