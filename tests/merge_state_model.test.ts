import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeableFlagBlocker,
  mergeStateBlockerFromDetails,
  mergeStateStatusSignal,
  mergeStateStatusBlocker,
  normalizeMergeStateStatus,
} from "../merge_state_model";

describe("merge state model", () => {
  test("normalizes merge-state status strings", () => {
    assert.equal(normalizeMergeStateStatus(" dirty "), "DIRTY");
    assert.equal(normalizeMergeStateStatus(" has hooks "), "HAS_HOOKS");
    assert.equal(normalizeMergeStateStatus("has-hooks"), "HAS_HOOKS");
    assert.equal(normalizeMergeStateStatus(null), "");
    assert.equal(mergeStateStatusSignal("CLEAN"), "clean");
    assert.equal(mergeStateStatusSignal("DIRTY"), "blocking");
    assert.equal(mergeStateStatusSignal("HAS_HOOKS"), "pending");
    assert.equal(mergeStateStatusSignal("UNKNOWN"), "unknown");
    assert.equal(mergeStateStatusSignal("CALCULATING"), "unrecognized");
  });

  test("projects GitHub merge-state statuses into blockers", () => {
    assert.equal(mergeStateStatusBlocker(""), null);
    assert.equal(mergeStateStatusBlocker("CLEAN"), null);

    assert.deepEqual(mergeStateStatusBlocker("DIRTY"), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports the PR merge state as DIRTY.",
      evidence_refs: ["github:mergeStateStatus"],
    });

    assert.deepEqual(mergeStateStatusBlocker("BEHIND"), {
      kind: "merge_state_blocked",
      status: "pending",
      summary: "GitHub reports the PR merge state as BEHIND.",
      evidence_refs: ["github:mergeStateStatus"],
    });

    assert.deepEqual(mergeStateStatusBlocker(normalizeMergeStateStatus("has hooks")), {
      kind: "merge_state_blocked",
      status: "pending",
      summary: "GitHub reports the PR merge state as HAS_HOOKS.",
      evidence_refs: ["github:mergeStateStatus"],
    });

    assert.deepEqual(mergeStateStatusBlocker("UNKNOWN"), {
      kind: "merge_state_blocked",
      status: "unknown",
      summary: "GitHub reports the PR merge state as UNKNOWN.",
      evidence_refs: ["github:mergeStateStatus"],
    });
  });

  test("uses mergeable=false only when merge-state status is clean or absent", () => {
    assert.deepEqual(mergeableFlagBlocker({ mergeable: false }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
    assert.equal(mergeableFlagBlocker({ mergeable: true }), null);

    assert.deepEqual(mergeStateBlockerFromDetails({ mergeStateStatus: " clean ", mergeable: false }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
    assert.deepEqual(mergeStateBlockerFromDetails({ mergeStateStatus: "behind", mergeable: false }), {
      kind: "merge_state_blocked",
      status: "pending",
      summary: "GitHub reports the PR merge state as BEHIND.",
      evidence_refs: ["github:mergeStateStatus"],
    });
  });

  test("uses normalized cached merge-state aliases", () => {
    assert.deepEqual(mergeStateBlockerFromDetails({ merge_state_status: " dirty " }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports the PR merge state as DIRTY.",
      evidence_refs: ["github:mergeStateStatus"],
    });
    assert.deepEqual(mergeStateBlockerFromDetails({ mergeStateStatus: "   ", merge_state_status: "behind" }), {
      kind: "merge_state_blocked",
      status: "pending",
      summary: "GitHub reports the PR merge state as BEHIND.",
      evidence_refs: ["github:mergeStateStatus"],
    });
    assert.deepEqual(mergeStateBlockerFromDetails({ mergeStateStatus: "UNKNOWN", merge_state_status: "dirty" }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports the PR merge state as DIRTY.",
      evidence_refs: ["github:mergeStateStatus"],
    });
    assert.deepEqual(mergeStateBlockerFromDetails({ mergeStateStatus: "calculating", merge_state_status: "has hooks" }), {
      kind: "merge_state_blocked",
      status: "pending",
      summary: "GitHub reports the PR merge state as HAS_HOOKS.",
      evidence_refs: ["github:mergeStateStatus"],
    });
    assert.equal(mergeStateBlockerFromDetails({ mergeStateStatus: "clean", merge_state_status: "dirty" }), null);
    assert.deepEqual(mergeStateBlockerFromDetails({ merge_state_status: " clean ", mergeable: false }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
  });

  test("normalizes direct edge-shaped merge-state details", () => {
    assert.deepEqual(
      mergeStateBlockerFromDetails({
        cursor: "pr-301",
        node: {
          mergeStateStatus: " dirty ",
          mergeable: true,
        },
      }),
      {
        kind: "merge_state_blocked",
        status: "blocked",
        summary: "GitHub reports the PR merge state as DIRTY.",
        evidence_refs: ["github:mergeStateStatus"],
      },
    );
  });

  test("normalizes cached mergeable boolean aliases", () => {
    assert.deepEqual(mergeableFlagBlocker({ mergeable: "false" }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
    assert.deepEqual(mergeableFlagBlocker({ isMergeable: "no" }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
    assert.deepEqual(mergeableFlagBlocker({ mergeable: "surprise", is_mergeable: "not-mergeable" }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
    assert.equal(mergeableFlagBlocker({ mergeable: "true" }), null);
    assert.equal(mergeableFlagBlocker({ mergeable: "mergeable", is_mergeable: "not-mergeable" }), null);

    assert.deepEqual(mergeStateBlockerFromDetails({ merge_state_status: " clean ", is_mergeable: "unmergeable" }), {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: "GitHub reports this PR is not mergeable.",
      evidence_refs: ["github:mergeable"],
    });
  });
});
