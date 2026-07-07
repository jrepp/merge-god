import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PRState } from "@merge-god/github-sync";

import { pullRequestSnapshotFromDetails } from "../pr_snapshot_model";

describe("PR snapshot model", () => {
  test("normalizes PR detail aliases and cached context into a store snapshot", () => {
    const snapshot = pullRequestSnapshotFromDetails(
      {
        prNumber: "205",
        name: "Replay queue",
        description: "Persist replayable state",
        state: "open",
        author: { username: "octocat" },
        headBranch: "queue/replay",
        base_branch: "develop",
        htmlUrl: "https://example.test/pull/205",
        createdDate: "2026-07-01T10:00:00Z",
        updatedDate: "2026-07-01T10:05:00Z",
        labels: {
          nodes: [
            { name: "for-landing" },
            { label: "do-not-merge" },
            { title: "for-landing" },
          ],
        },
        mergeable: "false",
        review_decision: "changes requested",
        additions_count: "12",
        linesDeleted: "3",
        filesChanged: "2",
        commits: { total_count: "4" },
      },
      {
        ciStatus: {
          totalChecks: 0,
          passedCount: 1,
          failedChecks: [{ name: "api", conclusion: "FAILURE" }],
          pendingCount: 1,
          unknownCount: 1,
          skippedCount: 1,
        },
        mergeConflicts: {
          hasConflicts: "yes",
          conflictCount: 1,
          conflictingFiles: [" packages/api/src/replay.ts ", "packages/api/src/replay.ts"],
        },
      },
      { now: new Date("2026-07-01T00:00:00Z") },
    );

    assert.equal(snapshot.number, 205);
    assert.equal(snapshot.title, "Replay queue");
    assert.equal(snapshot.state, PRState.OPEN);
    assert.equal(snapshot.head_branch, "queue/replay");
    assert.equal(snapshot.base_branch, "develop");
    assert.equal(snapshot.author, "octocat");
    assert.equal(snapshot.url, "https://example.test/pull/205");
    assert.equal(snapshot.created_at.toISOString(), "2026-07-01T10:00:00.000Z");
    assert.equal(snapshot.updated_at.toISOString(), "2026-07-01T10:05:00.000Z");
    assert.equal(snapshot.body, "Persist replayable state");
    assert.equal(snapshot.mergeable, false);
    assert.deepEqual(snapshot.labels, ["for-landing", "do-not-merge"]);
    assert.deepEqual(snapshot.ci_summary, { total: 5, success: 1, failure: 1, pending: 1, none: 2 });
    assert.equal(snapshot.review_decision, "changes requested");
    assert.equal(snapshot.additions, 12);
    assert.equal(snapshot.deletions, 3);
    assert.equal(snapshot.changed_files, 2);
    assert.equal(snapshot.commits, 4);
    assert.equal(snapshot.has_conflicts, true);
    assert.deepEqual(snapshot.conflicting_files, ["packages/api/src/replay.ts"]);
  });

  test("normalizes edge-shaped PR details and context into a store snapshot", () => {
    const snapshot = pullRequestSnapshotFromDetails(
      {
        cursor: "pr-206",
        node: {
          number: 206,
          title: "Edge replay",
          status: "closed",
          mergedDate: "2026-07-01T11:00:00Z",
          author: { login: "octocat" },
          headRefName: "queue/edge",
          baseRefName: "main",
          url: "https://example.test/pull/206",
          createdAt: "2026-07-01T10:00:00Z",
          updatedAt: "2026-07-01T10:10:00Z",
          body: "Replay edge-shaped context",
          linesAdded: "5",
          removedLines: "2",
          fileCount: "1",
          commits: {
            edges: [
              { node: { oid: "abc206" } },
              { node: null },
              { node: {} },
            ],
          },
        },
      },
      {
        cursor: "context-206",
        node: {
          ciStatus: {
            totalChecks: 0,
            passedCount: 1,
            failedChecks: [{ node: { name: "api", conclusion: "FAILURE" } }],
          },
          mergeConflicts: {
            hasConflicts: true,
            conflictingFiles: ["packages/api/src/edge.ts"],
          },
        },
      },
      { now: new Date("2026-07-01T00:00:00Z") },
    );

    assert.equal(snapshot.number, 206);
    assert.equal(snapshot.title, "Edge replay");
    assert.equal(snapshot.state, PRState.MERGED);
    assert.equal(snapshot.head_branch, "queue/edge");
    assert.equal(snapshot.base_branch, "main");
    assert.equal(snapshot.author, "octocat");
    assert.equal(snapshot.created_at.toISOString(), "2026-07-01T10:00:00.000Z");
    assert.equal(snapshot.updated_at.toISOString(), "2026-07-01T10:10:00.000Z");
    assert.equal(snapshot.body, "Replay edge-shaped context");
    assert.deepEqual(snapshot.ci_summary, { total: 2, success: 1, failure: 1, pending: 0, none: 0 });
    assert.equal(snapshot.additions, 5);
    assert.equal(snapshot.deletions, 2);
    assert.equal(snapshot.changed_files, 1);
    assert.equal(snapshot.commits, 1);
    assert.equal(snapshot.has_conflicts, true);
    assert.deepEqual(snapshot.conflicting_files, ["packages/api/src/edge.ts"]);
  });

  test("uses explicit fallbacks for malformed optional details", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    const snapshot = pullRequestSnapshotFromDetails(
      {
        number: "0",
        title: "",
        author: {},
        isDraft: "true",
        createdAt: "not a date",
      },
      { url: "https://example.test/pull/0" },
      { url: "https://fallback.test/pull/0", now },
    );

    assert.equal(snapshot.number, 0);
    assert.equal(snapshot.title, "");
    assert.equal(snapshot.state, PRState.DRAFT);
    assert.equal(snapshot.author, "unknown");
    assert.equal(snapshot.url, "https://fallback.test/pull/0");
    assert.equal(snapshot.created_at, now);
    assert.equal(snapshot.updated_at, now);
    assert.deepEqual(snapshot.labels, []);
    assert.deepEqual(snapshot.ci_summary, { total: 0, success: 0, failure: 0, pending: 0, none: 0 });
  });
});
