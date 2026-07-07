import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { prContextTelemetrySummary } from "../pr_context_log_model";

describe("PR context log model", () => {
  test("summarizes cached collection aliases for sync telemetry", () => {
    assert.deepEqual(
      prContextTelemetrySummary({
        diffText: "diff --git a/api.ts b/api.ts\n+ok\n",
        issueComments: [{ body: "queued" }],
        reviewComments: {
          nodes: [{ body: "please fix" }],
        },
        changedFiles: {
          edges: [
            { node: { filename: "api.ts" } },
            { node: null },
          ],
        },
      }),
      {
        diff_size: 33,
        comment_count: 1,
        review_comment_count: 1,
        file_count: 1,
      },
    );
  });

  test("summarizes whole edge-shaped cached context for sync telemetry", () => {
    assert.deepEqual(
      prContextTelemetrySummary({
        cursor: "context-edge",
        node: {
          rawDiff: "diff --git a/web.ts b/web.ts\n+ok\n",
          issueComments: {
            edges: [{ node: { body: "queued" } }],
          },
          reviewComments: [{ node: { body: "please fix" } }],
          changedFiles: [{ node: { path: "web.ts" } }],
        },
      }),
      {
        diff_size: 33,
        comment_count: 1,
        review_comment_count: 1,
        file_count: 1,
      },
    );
  });

  test("uses zero counts for absent telemetry fields", () => {
    assert.deepEqual(
      prContextTelemetrySummary({ diff: null, comments: [], review_comments: [], files: [] }),
      {
        diff_size: 0,
        comment_count: 0,
        review_comment_count: 0,
        file_count: 0,
      },
    );
  });
});
