import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CIStatus, PRState, createPullRequest } from "../models";
import { prQueueInfoFromPullRequest, prQueueInfoFromRecord } from "../pr_queue_display_model";

describe("PR queue display model", () => {
  test("normalizes cached PR detail aliases for dashboard display", () => {
    const info = prQueueInfoFromRecord({
      prNumber: "183",
      name: "Agent-managed merge queue",
      sourceBranch: "queue/agent-managed",
      targetBranch: "main",
      ciSummary: { total: 4, success: 3, failure: 1, pending: 0 },
    });

    assert.deepEqual(info, {
      number: 183,
      title: "Agent-managed merge queue",
      head_branch: "queue/agent-managed",
      base_branch: "main",
      ci_status: CIStatus.FAILURE,
      ci_failing: true,
    });
  });

  test("normalizes edge-shaped PR and CI records for dashboard display", () => {
    const info = prQueueInfoFromRecord({
      cursor: "pr-186",
      node: {
        prNumber: "186",
        name: "Edge queue display",
        sourceBranch: "queue/edge",
        targetBranch: "release/2026.07",
        statusCheckRollup: {
          edges: [
            { node: { name: "api", conclusion: "SUCCESS" } },
            { node: { name: "deploy", state: "IN_PROGRESS" } },
            { node: null },
          ],
        },
      },
    });

    assert.deepEqual(info, {
      number: 186,
      title: "Edge queue display",
      head_branch: "queue/edge",
      base_branch: "release/2026.07",
      ci_status: CIStatus.PENDING,
      ci_failing: false,
    });
  });

  test("truncates loop payload titles without mutating PR shape", () => {
    const info = prQueueInfoFromRecord(
      {
        number: 184,
        title: "A title that is longer than the dashboard event preview",
        head_branch: "feature/long",
        base_branch: "develop",
        ci_status: "pending",
      },
      { titleMaxLength: 12 },
    );

    assert.equal(info.title, "A title that");
    assert.equal(info.ci_status, CIStatus.PENDING);
    assert.equal(info.ci_failing, false);
  });

  test("projects normalized pull requests through canonical CI evaluation", () => {
    const info = prQueueInfoFromPullRequest(createPullRequest({
      number: 185,
      title: "Ready PR",
      state: PRState.OPEN,
      head_branch: "feature/ready",
      base_branch: "main",
      author: "octocat",
      url: "https://example.test/pr/185",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
      ci_checks: [{
        name: "test",
        status: CIStatus.SUCCESS,
        conclusion: "success",
        details_url: null,
        started_at: null,
        completed_at: null,
      }],
    }));

    assert.deepEqual(info, {
      number: 185,
      title: "Ready PR",
      head_branch: "feature/ready",
      base_branch: "main",
      ci_status: CIStatus.SUCCESS,
      ci_failing: false,
    });
  });
});
