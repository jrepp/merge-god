import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { prAgentContextFromDict } from "../pr_agent_context_model";

describe("PR agent context model", () => {
  test("normalizes cached PR details and context aliases for agent replay", () => {
    const context = prAgentContextFromDict(
      {
        prNumber: "205",
        name: "Replay queue",
        description: "Persist replayable state",
        author: { username: "octocat" },
        sourceBranch: "queue/replay",
        targetBranch: "develop",
        htmlUrl: "https://fallback.test/pull/205",
        labels: {
          nodes: [
            { name: "for-landing" },
            { label: "do-not-merge" },
            { title: "for-landing" },
          ],
        },
        review_decision: "CHANGES_REQUESTED",
      },
      {
        webUrl: "https://example.test/pull/205",
        diffText: "diff --git a/api.ts b/api.ts\n+ok\n",
        issueComments: [{ body: "queued" }],
        reviewComments: [{ path: "api.ts", body: "please fix" }],
        files: [{ filename: "", path: " " }],
        changedFiles: {
          nodes: [
            { filename: "api.ts", additions: 1 },
            {},
          ],
        },
        commitNodes: {
          edges: [
            { node: { oid: "abc", message: "Merge PR #201" } },
            { node: null },
          ],
        },
        mergeConflicts: {
          hasConflicts: "yes",
          conflictingFiles: [" packages/api/src/replay.ts ", "packages/api/src/replay.ts"],
        },
        ciStatus: {
          totalChecks: 0,
          failedChecks: [{ name: "api", conclusion: "FAILURE" }],
        },
        mergeBlockers: [
          {
            type: "review_required",
            state: "blocked",
            message: "Review is required.",
          },
          {
            type: "ci_failed",
            state: "blocked",
            message: "1 CI check failed.",
          },
          {
            type: "merge_conflicts",
            state: "blocked",
            message: "Merge conflicts detected.",
          },
          {
            type: "external_gate",
            state: "ACTION REQUIRED",
            message: "Release approval required.",
          },
        ],
        queueContext: {
          isQueue: true,
          strategy: "manual",
          unresolvedBlockers: [
            {
              type: "ci_failed",
              state: "failed",
              message: "Queue validation failed.",
            },
          ],
        },
        guidelines: "Follow repo style.",
        commit_examples: "fix: repair api",
        merge_rules: "No force push.",
      },
    );

    assert.equal(context.pr_number, 205);
    assert.equal(context.title, "Replay queue");
    assert.equal(context.body, "Persist replayable state");
    assert.equal(context.head_branch, "queue/replay");
    assert.equal(context.base_branch, "develop");
    assert.equal(context.author, "octocat");
    assert.equal(context.url, "https://example.test/pull/205");
    assert.equal(context.has_conflicts, true);
    assert.deepEqual(context.conflicting_files, ["packages/api/src/replay.ts"]);
    assert.equal(context.has_failing_ci, true);
    assert.deepEqual(context.failing_checks, [{ name: "api", conclusion: "FAILURE" }]);
    assert.deepEqual(context.review_comments, [{ path: "api.ts", body: "please fix" }]);
    assert.deepEqual(context.general_comments, [{ body: "queued" }]);
    assert.deepEqual(context.merge_blockers, [
      {
        type: "external_gate",
        state: "ACTION REQUIRED",
        message: "Release approval required.",
      },
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Label 'do-not-merge' marks this PR as blocked for landing.",
        evidence_refs: ["github:label:do-not-merge"],
      },
    ]);
    assert.deepEqual(context.queue_context, {
      isQueue: true,
      strategy: "manual",
      unresolvedBlockers: [
        {
          type: "ci_failed",
          state: "failed",
          message: "Queue validation failed.",
        },
      ],
    });
    assert.deepEqual(context.changed_files, [{ filename: "api.ts", additions: 1 }]);
    assert.equal(context.diff, "diff --git a/api.ts b/api.ts\n+ok\n");
    assert.deepEqual(context.commits, [{ oid: "abc", message: "Merge PR #201" }]);
    assert.equal(context.guidelines, "Follow repo style.");
    assert.equal(context.commit_examples, "fix: repair api");
    assert.equal(context.merge_rules, "No force push.");
    assert.deepEqual(context.labels, ["for-landing", "do-not-merge"]);
    assert.deepEqual(context.ci_checks, {
      totalChecks: 0,
      failedChecks: [{ name: "api", conclusion: "FAILURE" }],
    });
    assert.equal(context.review_decision, "CHANGES_REQUESTED");
  });

  test("projects supplemental blockers and inferred queue context into agent replay", () => {
    const context = prAgentContextFromDict(
      {
        number: 300,
        title: "Merge queue: PRs #201 and #202",
        isDraft: true,
        mergeStateStatus: "BEHIND",
        labels: ["for-review", "do not merge"],
        reviewDecision: "APPROVED",
      },
      {
        comments: [
          {
            html_url: "comment:manual-gate",
            body: "merge-god: blocked waiting on release",
          },
          {
            html_url: "comment:validation",
            body: "- #201 `npm test` -> failed",
          },
        ],
        review_comments: [],
        commits: [],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
        merge_blockers: [],
      },
    );

    assert.deepEqual(context.merge_blockers, [
      {
        kind: "draft",
        status: "blocked",
        summary: "GitHub reports this PR is still marked as draft.",
        evidence_refs: ["github:isDraft"],
      },
      {
        kind: "merge_state_blocked",
        status: "pending",
        summary: "GitHub reports the PR merge state as BEHIND.",
        evidence_refs: ["github:mergeStateStatus"],
      },
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Label 'do not merge' marks this PR as blocked for landing.",
        evidence_refs: ["github:label:do-not-merge"],
      },
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: waiting on release.",
        evidence_refs: ["comment:manual-gate"],
      },
    ]);
    assert.deepEqual(context.queue_context?.["constituent_prs"], [
      {
        number: 201,
        title: null,
        url: null,
        head_sha: null,
        status: "blocked",
        evidence_refs: ["comment:validation", "pr:#201"],
      },
      {
        number: 202,
        title: null,
        url: null,
        head_sha: null,
        status: "queued",
        evidence_refs: ["pr:#202"],
      },
    ]);
    assert.deepEqual(context.queue_context?.["unresolved_blockers"], [
      ...context.merge_blockers,
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["comment:validation"],
      },
    ]);
  });

  test("projects cached file edge aliases into agent changed files", () => {
    const context = prAgentContextFromDict(
      {
        prNumber: "207",
        name: "File edge replay",
      },
      {
        files: [null, {}],
        file_edges: {
          edges: [
            { node: { filename: "src/file-edge.ts", additionsCount: "2" } },
          ],
        },
      },
    );

    assert.deepEqual(context.changed_files, [
      { filename: "src/file-edge.ts", additionsCount: "2" },
    ]);
  });

  test("normalizes direct edge-shaped records for agent replay", () => {
    const context = prAgentContextFromDict(
      {
        cursor: "pr-206",
        node: {
          prNumber: "206",
          name: "Edge agent",
          sourceBranch: "queue/edge",
          targetBranch: "main",
          author: { cursor: "author", node: { username: "octocat" } },
          labels: { edges: [{ node: { name: "for-landing" } }] },
        },
      },
      {
        cursor: "context-206",
        node: {
          webUrl: "https://example.test/pull/206",
          issueComments: { edges: [{ node: { bodyText: "queue #201" } }] },
          reviewComments: { edges: [{ node: { body: "fix" } }] },
          changedFiles: { edges: [{ node: { filename: "src/app.ts" } }] },
          commitNodes: { edges: [{ node: { oid: "abc", message: "work" } }] },
          ciStatus: {
            cursor: "ci",
            node: {
              failedChecks: [{ cursor: "check", node: { name: "api", conclusion: "FAILURE" } }],
            },
          },
          mergeBlockers: {
            edges: [
              {
                node: {
                  type: "review_required",
                  outcome: "ACTION REQUIRED",
                  description: "Review is required.",
                },
              },
            ],
          },
          queueContext: {
            cursor: "queue",
            node: {
              isQueue: true,
              unresolvedBlockers: {
                edges: [
                  {
                    node: {
                      type: "ci_failed",
                      outcome: "failed",
                      description: "Queue validation failed.",
                    },
                  },
                ],
              },
            },
          },
        },
      },
    );

    assert.equal(context.pr_number, 206);
    assert.equal(context.author, "octocat");
    assert.equal(context.url, "https://example.test/pull/206");
    assert.deepEqual(context.general_comments, [{ bodyText: "queue #201" }]);
    assert.deepEqual(context.review_comments, [{ body: "fix" }]);
    assert.deepEqual(context.changed_files, [{ filename: "src/app.ts" }]);
    assert.deepEqual(context.commits, [{ oid: "abc", message: "work" }]);
    assert.deepEqual(context.failing_checks, [{ name: "api", conclusion: "FAILURE" }]);
    assert.deepEqual(context.labels, ["for-landing"]);
    assert.deepEqual(context.merge_blockers, []);
    assert.deepEqual(context.queue_context, {
      isQueue: true,
      unresolvedBlockers: {
        edges: [
          {
            node: {
              type: "ci_failed",
              outcome: "failed",
              description: "Queue validation failed.",
            },
          },
        ],
      },
    });
  });

  test("uses explicit defaults for absent optional agent context", () => {
    const context = prAgentContextFromDict({ title: "   ", labels: [] }, {});

    assert.equal(context.pr_number, 0);
    assert.equal(context.title, "");
    assert.equal(context.body, null);
    assert.equal(context.head_branch, "");
    assert.equal(context.base_branch, "main");
    assert.equal(context.author, "unknown");
    assert.equal(context.url, "");
    assert.equal(context.has_conflicts, false);
    assert.deepEqual(context.conflicting_files, []);
    assert.equal(context.has_failing_ci, false);
    assert.deepEqual(context.failing_checks, []);
    assert.deepEqual(context.review_comments, []);
    assert.deepEqual(context.general_comments, []);
    assert.deepEqual(context.merge_blockers, []);
    assert.equal(context.queue_context, null);
    assert.deepEqual(context.changed_files, []);
    assert.deepEqual(context.commits, []);
    assert.deepEqual(context.labels, []);
    assert.deepEqual(context.ci_checks, {});
    assert.equal(context.review_decision, null);
  });
});
