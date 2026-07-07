import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateMergeBlockerStatus,
  dedupeMergeBlockers,
  excludeRepeatedMergeBlockers,
  mergeBlockerDisplayIdentity,
  MERGE_BLOCKER_EXPLANATION_LIMIT,
  mergeBlockerExplanation,
  mergeBlockerKindLabel,
  mergeBlockerSeverityRank,
  MERGE_BLOCKER_SUMMARY_LIMIT,
  mergeBlockerStatusLabel,
  mergeBlockerSummary,
  mergeBlockerStatusRank,
  mergeBlockerSummaryLabel,
  prioritizedMergeBlockers,
} from "../merge_blocker_model";

describe("merge blocker model", () => {
  test("exports default merge-blocker display limits", () => {
    assert.equal(MERGE_BLOCKER_EXPLANATION_LIMIT, 5);
    assert.equal(MERGE_BLOCKER_SUMMARY_LIMIT, 8);
  });

  test("normalizes display labels with explicit fallbacks", () => {
    const blocker = { kind: "", status: "", summary: "" };

    assert.equal(mergeBlockerKindLabel(blocker), "unknown");
    assert.equal(mergeBlockerKindLabel({ kind: " Review Required " }), "review_required");
    assert.equal(mergeBlockerKindLabel({ kind: "review-required" }), "review_required");
    assert.equal(mergeBlockerKindLabel({ kind: "External Gate" }), "external_gate");
    assert.equal(mergeBlockerStatusLabel(blocker), "unknown");
    assert.equal(mergeBlockerStatusLabel({ status: " SUCCESS " }), "pass");
    assert.equal(mergeBlockerStatusLabel({ status: "succeeded" }), "pass");
    assert.equal(mergeBlockerStatusLabel({ status: "failed" }), "blocked");
    assert.equal(mergeBlockerStatusLabel({ status: "ACTION REQUIRED" }), "blocked");
    assert.equal(mergeBlockerStatusLabel({ status: "timed-out" }), "blocked");
    assert.equal(mergeBlockerStatusLabel({ status: "in progress" }), "pending");
    assert.equal(mergeBlockerStatusLabel({ status: "queued" }), "pending");
    assert.equal(mergeBlockerStatusLabel({ status: "surprise" }), "unknown");
    assert.equal(mergeBlockerSummaryLabel(blocker), "No summary.");
    assert.equal(
      mergeBlockerDisplayIdentity(blocker),
      "unknown\u0000unknown\u0000No summary.",
    );
  });

  test("normalizes cached blocker field aliases before display and severity", () => {
    const blocker = {
      type: "external_gate",
      state: "ACTION REQUIRED",
      message: "Release manager approval is required.",
    };

    assert.equal(mergeBlockerKindLabel(blocker), "external_gate");
    assert.equal(mergeBlockerStatusLabel(blocker), "blocked");
    assert.equal(mergeBlockerSummaryLabel(blocker), "Release manager approval is required.");
    assert.equal(mergeBlockerSeverityRank(blocker), 0);
    assert.equal(
      mergeBlockerDisplayIdentity(blocker),
      "external_gate\u0000blocked\u0000Release manager approval is required.",
    );
  });

  test("normalizes direct edge-shaped blockers before display and severity", () => {
    const blocker = {
      __typename: "MergeBlockerEdge",
      cursor: "review",
      node: {
        type: "review_required",
        outcome: "ACTION REQUIRED",
        description: "Review is required.",
      },
    };

    assert.equal(mergeBlockerKindLabel(blocker), "review_required");
    assert.equal(mergeBlockerStatusLabel(blocker), "blocked");
    assert.equal(mergeBlockerSummaryLabel(blocker), "Review is required.");
    assert.equal(mergeBlockerSeverityRank(blocker), 0);
    assert.equal(
      mergeBlockerDisplayIdentity(blocker),
      "review_required\u0000blocked\u0000Review is required.",
    );
  });

  test("ranks blocker statuses by merge severity", () => {
    assert.equal(mergeBlockerStatusRank(" BLOCKED "), 0);
    assert.equal(mergeBlockerStatusRank("failed"), 0);
    assert.equal(mergeBlockerStatusRank("action_required"), 0);
    assert.equal(mergeBlockerStatusRank("pending"), 1);
    assert.equal(mergeBlockerStatusRank("running"), 1);
    assert.equal(mergeBlockerStatusRank(""), 2);
    assert.equal(mergeBlockerStatusRank("unknown"), 2);
    assert.equal(mergeBlockerStatusRank("surprise"), 2);
    assert.equal(mergeBlockerStatusRank("pass"), 3);
    assert.equal(mergeBlockerStatusRank("success"), 3);
  });

  test("prioritizes blockers stably by severity", () => {
    const blockers = [
      { kind: "ci_pending", status: "pending", summary: "Pending 1." },
      { kind: "unknown", status: "unknown", summary: "Unknown." },
      { kind: "ci_failed", status: "blocked", summary: "Blocked." },
      { kind: "merge_state_blocked", status: "pending", summary: "Pending 2." },
    ];

    assert.deepEqual(
      prioritizedMergeBlockers(blockers).map(({ item }) => item.summary),
      ["Blocked.", "Pending 1.", "Pending 2.", "Unknown."],
    );
  });

  test("deduplicates and excludes blockers by display identity", () => {
    const first = {
      kind: "review_required",
      status: "blocked",
      summary: "Review is required.",
      evidence_refs: ["github:reviewDecision"],
    };
    const duplicate = {
      type: "review_required",
      state: "failed",
      message: "Review is required.",
      evidence_refs: ["comment:copied-review"],
    };
    const distinct = {
      kind: "ci_failed",
      status: "blocked",
      summary: "CI failed.",
      evidence_refs: ["ci:failed"],
    };

    assert.deepEqual(dedupeMergeBlockers([first, duplicate, distinct]), [
      {
        ...first,
        evidence_refs: ["github:reviewDecision", "comment:copied-review"],
      },
      distinct,
    ]);
    assert.deepEqual(excludeRepeatedMergeBlockers([duplicate, distinct], [first]), [distinct]);
  });

  test("deduplicates blockers without dropping duplicate evidence refs", () => {
    assert.deepEqual(
      dedupeMergeBlockers([
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
        },
        {
          type: "external_gate",
          state: "ACTION REQUIRED",
          message: "Release approval is required.",
          evidenceRefs: ["comment:release-approval"],
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
          evidence_refs: ["label:release-hold"],
        },
      ]),
      [
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
          evidence_refs: ["comment:release-approval", "label:release-hold"],
        },
      ],
    );
  });

  test("deduplicates and excludes blocker kind spelling aliases", () => {
    const first = {
      kind: "Review Required",
      status: "ACTION REQUIRED",
      summary: "Review is required.",
      evidenceRef: "review:api",
    };
    const duplicate = {
      kind: "review-required",
      status: "blocked",
      summary: "Review is required.",
      evidence_refs: ["review:comment"],
    };

    assert.deepEqual(dedupeMergeBlockers([first, duplicate]), [
      {
        ...first,
        evidence_refs: ["review:api", "review:comment"],
      },
    ]);
    assert.deepEqual(excludeRepeatedMergeBlockers([duplicate], [first]), []);
  });

  test("deduplicates and excludes blocker summary whitespace aliases", () => {
    const first = {
      kind: "external_gate",
      status: "blocked",
      summary: "Release approval is required.",
      evidenceRef: "release:api",
    };
    const duplicate = {
      kind: "external_gate",
      status: "blocked",
      summary: "Release  approval\nis required.",
      evidence_refs: ["release:comment"],
    };

    assert.deepEqual(dedupeMergeBlockers([first, duplicate]), [
      {
        ...first,
        evidence_refs: ["release:api", "release:comment"],
      },
    ]);
    assert.deepEqual(excludeRepeatedMergeBlockers([duplicate], [first]), []);
  });

  test("deduplicates edge-shaped blockers without dropping edge metadata or refs", () => {
    assert.deepEqual(
      dedupeMergeBlockers([
        {
          cursor: "release-edge",
          node: {
            type: "external_gate",
            outcome: "ACTION REQUIRED",
            description: "Release approval is required.",
            evidenceRef: "edge:release",
          },
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
          evidence_refs: ["comment:release", "edge:release"],
        },
      ]),
      [
        {
          cursor: "release-edge",
          node: {
            type: "external_gate",
            outcome: "ACTION REQUIRED",
            description: "Release approval is required.",
            evidenceRef: "edge:release",
            evidence_refs: ["edge:release", "comment:release"],
          },
        },
      ],
    );
  });

  test("aggregates and explains blockers using the shared severity order", () => {
    const blockers = [
      { kind: "ci_pending", status: "pending", summary: "CI is still running." },
      { kind: "ci_failed", status: " BLOCKED ", summary: "A required check failed." },
      { kind: "unknown", status: "", summary: "" },
    ];

    assert.equal(aggregateMergeBlockerStatus(blockers), "blocked");
    assert.equal(
      mergeBlockerExplanation(blockers, 2),
      "ci_failed: A required check failed.; ci_pending: CI is still running.",
    );
    assert.equal(aggregateMergeBlockerStatus([]), "pass");
    assert.equal(mergeBlockerExplanation([]), "No modeled merge blockers were detected.");
  });

  test("uses the default explanation cap for gate summaries", () => {
    const blockers = [
      { kind: "ci_failed", status: "blocked", summary: "Blocked." },
      ...Array.from({ length: MERGE_BLOCKER_EXPLANATION_LIMIT }, (_, index) => ({
        kind: "ci_pending",
        status: "pending",
        summary: `Pending ${index + 1}.`,
      })),
    ];

    const explanation = mergeBlockerExplanation(blockers);
    assert.match(explanation, /^ci_failed: Blocked\.; ci_pending: Pending 1\./);
    assert.match(explanation, /Pending 4\./);
    assert.doesNotMatch(explanation, /Pending 5\./);
  });

  test("summarizes blockers for evidence comments with severity capping and defaults", () => {
    const blockers = [
      ...Array.from({ length: MERGE_BLOCKER_SUMMARY_LIMIT }, (_, index) => ({
        kind: "merge_state_blocked",
        status: "pending",
        summary: `Pending queue blocker ${index + 1}.`,
      })),
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed validation evidence item.",
      },
    ];

    const summary = mergeBlockerSummary(blockers);
    assert.match(summary, /^1 omitted; ci_failed \(blocked\): Queue validation scope packages\/api/);
    assert.match(summary, /Pending queue blocker 7\./);
    assert.doesNotMatch(summary, /Pending queue blocker 8\./);
    assert.equal(mergeBlockerSummary([]), "none");
    assert.equal(mergeBlockerSummary([{}]), "unknown (unknown): No summary.");
  });
});
