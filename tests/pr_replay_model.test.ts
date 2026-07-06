import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  replayPrContextSummary,
  replayTrajectoryWorkItemFromContext,
} from "../pr_replay_model";

describe("PR replay model", () => {
  test("summarizes cached context aliases before runner logging", () => {
    assert.deepEqual(
      replayPrContextSummary({
        rawDiff: "diff --git a/api.ts b/api.ts",
        issueComments: [{ body: "queued" }],
        reviewComments: [{ body: "please fix" }],
        mergeConflicts: {
          hasConflicts: "yes",
          conflictingFiles: ["packages/api/src/replay.ts"],
        },
        ciStatus: {
          totalChecks: 0,
          failedChecks: [{ name: "api", conclusion: "FAILURE" }],
        },
      }),
      {
        has_diff: true,
        diff_status: "pass",
        diff_unavailable_reason: null,
        has_comments: true,
        has_review_comments: true,
        has_conflicts: true,
        has_failing_ci: true,
      },
    );
  });

  test("keeps replay summary false for empty payloads", () => {
    assert.deepEqual(
      replayPrContextSummary({
        diff: "   ",
        comments: [],
        review_comments: [],
        conflicts: { has_conflicts: "no" },
        ci_status: { failed: 0, total_checks: 1, passed: 1 },
      }),
      {
        has_diff: false,
        diff_status: "missing",
        diff_unavailable_reason: null,
        has_comments: false,
        has_review_comments: false,
        has_conflicts: false,
        has_failing_ci: false,
      },
    );
  });

  test("summarizes degraded diff availability for replay logs", () => {
    assert.deepEqual(
      replayPrContextSummary({
        diffAvailability: {
          available: false,
          message: "diff cache unavailable",
        },
        comments: [],
        review_comments: [],
        conflicts: { has_conflicts: false },
        ci_status: { failed: 0, total_checks: 1, passed: 1 },
      }),
      {
        has_diff: false,
        diff_status: "blocked",
        diff_unavailable_reason: "diff cache unavailable",
        has_comments: false,
        has_review_comments: false,
        has_conflicts: false,
        has_failing_ci: false,
      },
    );
  });

  test("projects cached PR details into trajectory work item metadata", () => {
    assert.deepEqual(
      replayTrajectoryWorkItemFromContext(
        {
          name: "Replay queue",
          labels: {
            nodes: [
              { name: "for-landing" },
              { label: "do-not-merge" },
              { title: "for-landing" },
            ],
          },
          targetBranch: "develop",
          source_branch: "queue/replay",
          head: { oid: "head-oid" },
          htmlUrl: "https://fallback.test/pull/205",
        },
        {
          webUrl: "https://example.test/pull/205",
        },
      ),
      {
        title: "Replay queue",
        url: "https://example.test/pull/205",
        labels: ["for-landing", "do-not-merge"],
        base_ref: "develop",
        head_ref: "queue/replay",
        current_sha: "head-oid",
      },
    );
  });

  test("projects edge-shaped cached context into trajectory work item metadata", () => {
    assert.deepEqual(
      replayTrajectoryWorkItemFromContext(
        {
          node: {
            title: "Edge replay queue",
            labels: {
              edges: [
                { node: { name: "for-landing" } },
                { node: { name: "for-review" } },
              ],
            },
            baseRefName: "main",
            headRefName: "queue/edge",
            head: {
              node: { oid: "edge-head" },
            },
          },
        },
        {
          cursor: "context-206",
          node: {
            webUrl: "https://example.test/pull/206",
          },
        },
      ),
      {
        title: "Edge replay queue",
        url: "https://example.test/pull/206",
        labels: ["for-landing", "for-review"],
        base_ref: "main",
        head_ref: "queue/edge",
        current_sha: "edge-head",
      },
    );
  });

  test("returns nullable trajectory fields when metadata is absent", () => {
    assert.deepEqual(
      replayTrajectoryWorkItemFromContext(
        {
          title: "   ",
          labels: [],
        },
        {},
      ),
      {
        title: null,
        url: null,
        labels: [],
        base_ref: null,
        head_ref: null,
        current_sha: null,
      },
    );
  });

  test("treats empty edge-shaped replay payloads as absent", () => {
    assert.deepEqual(
      replayPrContextSummary({
        diff: { node: {} },
        comments: [{ node: {} }],
        reviewComments: { edges: [{ node: null }] },
        mergeConflicts: { node: {} },
        ciStatus: { node: {} },
      }),
      {
        has_diff: false,
        diff_status: "missing",
        diff_unavailable_reason: null,
        has_comments: false,
        has_review_comments: false,
        has_conflicts: false,
        has_failing_ci: false,
      },
    );
  });
});
