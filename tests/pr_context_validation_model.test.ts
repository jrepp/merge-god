import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  validateAgentReplayContext,
  validateAgentReplayPrContext,
  validateAgentReplayPrDetails,
} from "../pr_context_validation_model";
import {
  prContextCiStatus,
  prContextComments,
  prContextCommits,
  prContextFiles,
  prContextReviewComments,
} from "../pr_context_access_model";

describe("PR context validation model", () => {
  test("accepts canonical gathered context with empty collections", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 201,
          title: "Ready PR",
          headRefName: "feature/ready",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: [],
        },
        {
          url: "https://github.example.test/org/repo/pull/201",
          diff: "",
          comments: [],
          review_comments: [],
          commits: [],
          files: [],
          conflicts: { has_conflicts: false },
          ci_status: { total_checks: 1, passed: 1 },
          guidelines: "",
          commit_examples: "",
        },
      ),
      [],
    );
  });

  test("accepts cached aliases that the agent replay projection can consume", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          prNumber: "202",
          name: "Cached replay",
          sourceBranch: "feature/cached",
          targetBranch: "develop",
          author: { username: "octocat" },
          htmlUrl: "https://github.example.test/org/repo/pull/202",
          labels: { nodes: [{ name: "for-review" }] },
        },
        {
          diffAvailability: { available: false, provider: "gh-pr-diff", message: "too large" },
          issueComments: { nodes: [{ body: "queued" }] },
          reviewComments: [{ body: "fix", path: "src/app.ts" }],
          commitNodes: { edges: [{ node: { oid: "abc", message: "work" } }] },
          files: [{ filename: "", path: " " }],
          changedFiles: [{ filename: "src/app.ts" }],
          mergeConflicts: { hasConflicts: "no" },
          ciStatus: { totalChecks: 1, passedCount: 1 },
          guidelines: "",
          commit_examples: "",
        },
      ),
      [],
    );
  });

  test("accepts direct edge-shaped replay details and context", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          cursor: "pr-204",
          node: {
            number: 204,
            title: "Edge replay",
            headRefName: "queue/edge",
            baseRefName: "main",
            author: { cursor: "author", node: { login: "octocat" } },
            labels: { edges: [{ node: { name: "for-review" } }] },
          },
        },
        {
          cursor: "context-204",
          node: {
            webUrl: "https://github.example.test/org/repo/pull/204",
            diffAvailability: { cursor: "diff", node: { available: false } },
            issueComments: { edges: [{ node: { body: "queued" } }] },
            reviewComments: { edges: [{ node: { body: "fix" } }] },
            commitNodes: { edges: [{ node: { oid: "abc" } }] },
            changedFiles: { edges: [{ node: { path: "src/app.ts" } }] },
            mergeConflicts: { cursor: "conflicts", node: { hasConflicts: false } },
            ciStatus: { cursor: "ci", node: { totalChecks: 1, passedCount: 1 } },
            guidelines: "",
            commit_examples: "",
          },
        },
      ),
      [],
    );
  });

  test("accepts empty PR label connections at replay validation", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 209,
          title: "No labels replay",
          headRefName: "feature/no-labels",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: { nodes: [] },
        },
        {
          url: "https://github.example.test/org/repo/pull/209",
          diffAvailability: { available: false, provider: "gh-pr-diff" },
          comments: [],
          reviewComments: [],
          commits: [],
          changedFiles: [],
          mergeConflicts: { hasConflicts: false },
          ciStatus: { totalChecks: 1, passedCount: 1 },
          guidelines: "",
          commit_examples: "",
        },
      ),
      [],
    );

    assert.deepEqual(
      validateAgentReplayPrDetails({
        number: 210,
        title: "No labels edge replay",
        headRefName: "feature/no-label-edges",
        baseRefName: "main",
        author: { login: "octocat" },
        label_names: { edges: [] },
      }),
      [],
    );
  });

  test("accepts raw adapter CI and merge queue context aliases", () => {
    const prContext = {
      url: "https://github.example.test/org/repo/pull/205",
      diffAvailability: { available: false, provider: "gh-pr-diff" },
      issueComments: [],
      reviewComments: [],
      commitEdges: { edges: [{ node: { oid: "abc", message: "work" } }] },
      changedFiles: [],
      mergeConflicts: { hasConflicts: "no" },
      statusCheckRollup: [
        { name: "api", conclusion: "SUCCESS", detailsUrl: "ci:api" },
      ],
      mergeQueueContext: {
        pullRequests: [{ prNumber: 201 }],
      },
      guidelines: "",
      commit_examples: "",
    };

    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 205,
          title: "Raw adapter replay",
          headRefName: "queue/raw",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: [],
        },
        prContext,
      ),
      [],
    );
    assert.deepEqual(prContextCommits(prContext), [{ oid: "abc", message: "work" }]);
  });

  test("accepts aliased diff text without separate diff availability", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 207,
          title: "Diff alias replay",
          headRefName: "feature/diff-alias",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: [],
        },
        {
          url: "https://github.example.test/org/repo/pull/207",
          rawDiff: "diff --git a/src/app.ts b/src/app.ts\n+ok\n",
          comments: [],
          reviewComments: [],
          commits: [],
          changedFiles: [],
          mergeConflicts: { hasConflicts: false },
          ciStatus: { totalChecks: 1, passedCount: 1 },
          guidelines: "",
          commit_examples: "",
        },
      ),
      [],
    );
  });

  test("accepts useful collection aliases after primitive placeholders", () => {
    const prContext = {
      url: "https://github.example.test/org/repo/pull/208",
      diffAvailability: { available: false },
      comments: "placeholder",
      issueComments: [{ body: "queued" }],
      review_comments: 42,
      reviewComments: [{ body: "fix", path: "src/app.ts" }],
      commits: false,
      commitEdges: { edges: [{ node: { oid: "abc", message: "work" } }] },
      files: "src/app.ts",
      changedFiles: [{ filename: "src/app.ts" }],
      statusCheckRollup: "placeholder",
      statusChecks: [{ name: "api", conclusion: "SUCCESS", detailsUrl: "ci:api" }],
      mergeConflicts: { hasConflicts: false },
      guidelines: "",
      commit_examples: "",
    };

    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 208,
          title: "Alias replay",
          headRefName: "feature/alias",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: [],
        },
        prContext,
      ),
      [],
    );
    assert.deepEqual(prContextComments(prContext), [{ body: "queued" }]);
    assert.deepEqual(prContextReviewComments(prContext), [{ body: "fix", path: "src/app.ts" }]);
    assert.deepEqual(prContextCommits(prContext), [{ oid: "abc", message: "work" }]);
    assert.deepEqual(prContextFiles(prContext), [{ filename: "src/app.ts" }]);
    assert.deepEqual(prContextCiStatus(prContext), {
      total_checks: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      failed_checks: [],
      pending_checks: [],
      unknown_checks: [],
    });
  });

  test("reports missing required detail and context fields", () => {
    assert.deepEqual(validateAgentReplayPrDetails({}), [
      "Missing required PR detail: positive PR number",
      "Missing required PR detail: title",
      "Missing required PR detail: head branch",
      "Missing required PR detail: base branch",
      "Missing required PR detail: author login",
    ]);

    assert.deepEqual(validateAgentReplayPrContext({}, {}), [
      "Missing required PR context: URL",
      "Missing required PR context: diff or diff availability",
      "Missing required PR context: conflicts",
      "Missing required PR context: CI status",
      "Missing required PR context: guidelines",
      "Missing required PR context: commit examples",
    ]);
  });

  test("reports primitive malformed collections without rejecting empty arrays", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 203,
          title: "Malformed cached context",
          headRefName: "feature/bad",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: "for-review",
        },
        {
          url: "https://github.example.test/org/repo/pull/203",
          diff: "",
          comments: "bad",
          reviewComments: 42,
          commits: false,
          files: "src/app.ts",
          conflicts: { has_conflicts: false },
          ci_status: { total_checks: 1 },
          guidelines: "",
          commit_examples: "",
        },
      ),
      [
        "Malformed PR detail: labels must be strings, label records, or a label connection",
        "Malformed PR context: comments must be records or a comment connection",
        "Malformed PR context: review comments must be records or a review-comment connection",
        "Malformed PR context: commits must be records or a commit connection",
        "Malformed PR context: changed files must be records or a file connection",
      ],
    );
  });

  test("reports primitive malformed raw adapter status-check collections", () => {
    assert.deepEqual(
      validateAgentReplayContext(
        {
          number: 206,
          title: "Malformed raw adapter context",
          headRefName: "feature/bad",
          baseRefName: "main",
          author: { login: "octocat" },
          labels: [],
        },
        {
          url: "https://github.example.test/org/repo/pull/206",
          diffAvailability: { available: false },
          comments: [],
          reviewComments: [],
          commitEdges: "bad",
          changedFiles: [],
          mergeConflicts: { hasConflicts: false },
          statusCheckRollup: "bad",
          guidelines: "",
          commit_examples: "",
        },
      ),
      [
        "Malformed PR context: commits must be records or a commit connection",
        "Malformed PR context: CI status checks must be records or a status-check connection",
        "Missing required PR context: CI status",
      ],
    );
  });
});
