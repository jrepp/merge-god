import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { dashboardContextSummaryFromEvent } from "../dashboard_event_model";

describe("dashboard event model", () => {
  test("normalizes gather-context event summaries", () => {
    assert.deepEqual(
      dashboardContextSummaryFromEvent({
        action: "complete",
        context_summary: {
          comments: 2,
          review_comments: 3,
          commits: 4,
          files: 5,
          has_conflicts: true,
          ci_failed: 1,
        },
      }),
      {
        comments: 2,
        reviewComments: 3,
        commits: 4,
        files: 5,
        hasConflicts: true,
        ciFailed: 1,
      },
    );
  });

  test("accepts camelCase and count aliases from cached events", () => {
    assert.deepEqual(
      dashboardContextSummaryFromEvent({
        contextSummary: {
          commentCount: 6,
          reviewCommentCount: 7,
          commitCount: 8,
          changedFiles: 9,
          hasConflicts: "yes",
          failure: 2,
        },
      }),
      {
        comments: 6,
        reviewComments: 7,
        commits: 8,
        files: 9,
        hasConflicts: true,
        ciFailed: 2,
      },
    );
  });
});
