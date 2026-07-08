import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  evidenceSummaryFromContext,
  prContextCiStatus,
  prContextComments,
  prContextCommits,
  prContextConflicts,
  prContextDiffAvailability,
  prContextDiffText,
  prContextFiles,
  prContextMergeBlockers,
  prContextQueueContext,
  prContextReviewComments,
  prContextUrl,
} from "../pr_context_access_model";

describe("PR context access model", () => {
  test("falls back past primitive direct collection placeholders to useful aliases", () => {
    assert.deepEqual(
      prContextMergeBlockers({
        merge_blockers: ["placeholder"],
        mergeBlockers: [{ kind: "external_gate" }],
      }),
      [{ kind: "external_gate" }],
    );
    assert.deepEqual(
      prContextComments({
        comments: ["placeholder"],
        issueComments: [{ body: "queue comment" }],
      }),
      [{ body: "queue comment" }],
    );
    assert.deepEqual(
      prContextReviewComments({
        review_comments: ["placeholder"],
        reviewComments: [{ body: "review comment" }],
      }),
      [{ body: "review comment" }],
    );
    assert.deepEqual(
      prContextCommits({
        commits: ["placeholder"],
        commitNodes: [{ oid: "abc123" }],
      }),
      [{ oid: "abc123" }],
    );
  });

  test("falls back past blank canonical blocker rows to useful aliases", () => {
    assert.deepEqual(
      prContextMergeBlockers({
        merge_blockers: [
          { kind: "", status: " ", summary: "" },
        ],
        mergeBlockers: [
          { kind: "external_gate", status: "blocked", summary: "External gate blocked." },
        ],
      }),
      [{ kind: "external_gate", status: "blocked", summary: "External gate blocked." }],
    );

    assert.deepEqual(
      prContextMergeBlockers({
        merge_blockers: [
          { status: "unknown" },
        ],
        mergeBlockers: [
          { kind: "external_gate", status: "blocked", summary: "External gate blocked." },
        ],
      }),
      [{ status: "unknown" }],
    );

    assert.deepEqual(
      prContextMergeBlockers({
        merge_blockers: [
          { kind: "", status: " ", summary: "" },
        ],
        blockers: [
          { kind: "external_gate", status: "blocked", summary: "Flat gate blocked." },
        ],
      }),
      [{ kind: "external_gate", status: "blocked", summary: "Flat gate blocked." }],
    );
  });

  test("falls back past blank canonical comment rows to useful aliases", () => {
    assert.deepEqual(
      prContextComments({
        comments: [
          { body: "", html_url: " " },
        ],
        issueComments: [
          { bodyText: "queue comment", url: "https://example.test/comment/1" },
        ],
      }),
      [{ bodyText: "queue comment", url: "https://example.test/comment/1" }],
    );
    assert.deepEqual(
      prContextReviewComments({
        review_comments: [
          { body: "", path: "src/app.ts" },
        ],
        reviewComments: [
          { body: "review comment", path: "src/app.ts" },
        ],
      }),
      [{ body: "", path: "src/app.ts" }],
    );
    assert.deepEqual(
      prContextComments({
        comments: [
          { body: "", html_url: " " },
        ],
        issueComments: [
          { commentRef: "comment:queue-hint" },
        ],
      }),
      [{ commentRef: "comment:queue-hint" }],
    );
    assert.deepEqual(
      prContextReviewComments({
        review_comments: [
          { body: "", html_url: " " },
        ],
        reviewComments: [
          { source_refs: ["review:source-hint"] },
        ],
      }),
      [{ source_refs: ["review:source-hint"] }],
    );
  });

  test("falls back past blank canonical commit rows to useful aliases", () => {
    assert.deepEqual(
      prContextCommits({
        commits: [
          { sha: " ", oid: "", message: " ", commit: { messageHeadline: "" } },
        ],
        commitNodes: [
          { oid: "abc123", message: "Merge PR #201 from org/feature" },
        ],
      }),
      [{ oid: "abc123", message: "Merge PR #201 from org/feature" }],
    );
    assert.deepEqual(
      prContextCommits({
        commits: [
          { oid: "abc123" },
        ],
        commitNodes: [
          { oid: "def456", message: "Merge PR #202 from org/feature" },
        ],
      }),
      [{ oid: "abc123" }],
    );
    assert.deepEqual(
      prContextCommits({
        commits: [
          { conflictFiles: { nodes: [{ path: "packages/api/src/app.ts" }] } },
        ],
        commitNodes: [
          { oid: "def456", message: "Merge PR #202 from org/feature" },
        ],
      }),
      [{ conflictFiles: { nodes: [{ path: "packages/api/src/app.ts" }] } }],
    );
    assert.deepEqual(
      prContextCommits({
        commits: [
          { conflictFiles: { nodes: [] }, commit: { conflictFiles: { edges: [] } } },
        ],
        commitNodes: [
          { commit: { conflictFiles: { edges: [{ node: { filename: "packages/ui/src/view.ts" } }] } } },
        ],
      }),
      [{ commit: { conflictFiles: { edges: [{ node: { filename: "packages/ui/src/view.ts" } }] } } }],
    );
    assert.deepEqual(
      prContextCommits({
        commits: [
          { evidenceRefs: ["commit:canonical"] },
          { commit: { source_ref: "commit:nested-source" } },
        ],
        commitNodes: [
          { oid: "def456", message: "Merge PR #202 from org/feature" },
        ],
      }),
      [
        { evidenceRefs: ["commit:canonical"] },
        { commit: { source_ref: "commit:nested-source" } },
      ],
    );
  });

  test("falls back past blank canonical file rows to useful aliases", () => {
    assert.deepEqual(
      prContextFiles({
        files: [
          { filename: "", path: " ", status: "modified", additions: 0, deletions: 0 },
        ],
        changedFiles: [
          { path: "src/replay.ts", changeType: "UPDATED", additionsCount: "3", deletionsCount: "1" },
        ],
      }),
      [{ path: "src/replay.ts", changeType: "UPDATED", additionsCount: "3", deletionsCount: "1" }],
    );
    assert.deepEqual(
      prContextFiles({
        files: [
          { filename: "src/authoritative.ts" },
        ],
        changedFiles: [
          { path: "src/alias.ts" },
        ],
      }),
      [{ filename: "src/authoritative.ts" }],
    );
    assert.deepEqual(
      prContextFiles({
        files: [
          { filename: "", path: " " },
        ],
        fileNodes: [
          { path: "src/file-node.ts" },
        ],
      }),
      [{ path: "src/file-node.ts" }],
    );
  });

  test("normalizes direct edge-array collections", () => {
    assert.deepEqual(
      prContextMergeBlockers({
        mergeBlockers: [
          { cursor: "blocker", node: { kind: "ci_failed" } },
          { cursor: "empty", node: {} },
        ],
      }),
      [{ kind: "ci_failed" }],
    );
    assert.deepEqual(
      prContextComments({
        issueComments: [
          { node: { body: "queue comment" } },
        ],
      }),
      [{ body: "queue comment" }],
    );
    assert.deepEqual(
      prContextReviewComments({
        reviewComments: [
          { node: { body: "review comment" } },
        ],
      }),
      [{ body: "review comment" }],
    );
    assert.deepEqual(
      prContextCommits({
        commits: [
          { __typename: "CommitEdge", node: { oid: "context201", message: "Merge PR #201" } },
        ],
      }),
      [{ oid: "context201", message: "Merge PR #201" }],
    );
    assert.deepEqual(
      prContextCommits({
        commitEdges: {
          edges: [
            { node: { oid: "context202", message: "Merge PR #202" } },
          ],
        },
      }),
      [{ oid: "context202", message: "Merge PR #202" }],
    );
    assert.deepEqual(
      prContextCommits({
        commit_edges: [
          { node: { oid: "context203", message: "Merge PR #203" } },
        ],
      }),
      [{ oid: "context203", message: "Merge PR #203" }],
    );
    assert.deepEqual(
      prContextFiles({
        fileEdges: {
          edges: [
            { node: { filename: "packages/web/src/file-edge.ts" } },
          ],
        },
      }),
      [{ filename: "packages/web/src/file-edge.ts" }],
    );
    assert.deepEqual(
      prContextFiles({
        file_edges: [
          { node: { path: "packages/api/src/file-edge.ts" } },
        ],
      }),
      [{ path: "packages/api/src/file-edge.ts" }],
    );
  });

  test("uses flat blockers as top-level blockers only outside flattened queue context", () => {
    assert.deepEqual(
      prContextMergeBlockers({
        blockers: [
          { node: { kind: "external_gate", status: "blocked", evidenceRef: "blocker:flat" } },
        ],
      }),
      [{ kind: "external_gate", status: "blocked", evidenceRef: "blocker:flat" }],
    );
    assert.deepEqual(
      prContextMergeBlockers({
        isQueue: true,
        blockers: [
          { node: { kind: "ci_failed", status: "blocked", evidenceRef: "queue:blocker" } },
        ],
      }),
      [],
    );
    assert.deepEqual(
      prContextMergeBlockers({
        isQueue: false,
        blockers: [
          { node: { kind: "external_gate", status: "blocked", evidenceRef: "blocker:false-queue" } },
        ],
      }),
      [{ kind: "external_gate", status: "blocked", evidenceRef: "blocker:false-queue" }],
    );
    assert.deepEqual(
      prContextMergeBlockers({
        strategy: "squash",
        blockers: [
          { node: { kind: "external_gate", status: "blocked", evidenceRef: "blocker:squash" } },
        ],
      }),
      [{ kind: "external_gate", status: "blocked", evidenceRef: "blocker:squash" }],
    );
    assert.deepEqual(
      prContextQueueContext({
        strategy: "squash",
        blockers: [
          { node: { kind: "external_gate", status: "blocked", evidenceRef: "blocker:squash" } },
        ],
      }),
      {},
    );
    assert.deepEqual(
      prContextQueueContext({
        isQueue: true,
        blockers: [
          { node: { kind: "ci_failed", status: "blocked", evidenceRef: "queue:blocker" } },
        ],
      }),
      {
        is_queue: true,
        unresolved_blockers: [{ kind: "ci_failed", status: "blocked", evidenceRef: "queue:blocker" }],
      },
    );
    assert.deepEqual(
      prContextMergeBlockers({
        is_queue: "surprise",
        isQueue: true,
        blockers: [
          { node: { kind: "ci_failed", status: "blocked", evidenceRef: "queue:blocker-alias" } },
        ],
      }),
      [],
    );
    assert.deepEqual(
      prContextQueueContext({
        is_queue: "surprise",
        isQueue: true,
        blockers: [
          { node: { kind: "ci_failed", status: "blocked", evidenceRef: "queue:blocker-alias" } },
        ],
      }),
      {
        is_queue: true,
        unresolved_blockers: [{ kind: "ci_failed", status: "blocked", evidenceRef: "queue:blocker-alias" }],
      },
    );
  });

  test("normalizes raw adapter top-level PR context aliases", () => {
    const context = {
      statusCheckRollup: [
        { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
        { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        { name: "lint", conclusion: "SUCCESS", detailsUrl: "ci:lint" },
      ],
      mergeQueueContext: {
        isQueue: true,
        pullRequests: [{ prNumber: 206 }],
      },
    };

    assert.deepEqual(prContextCiStatus(context), {
      total_checks: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      skipped: 0,
      unknown: 0,
      failed_checks: [{ name: "api", conclusion: "FAILURE", details_url: "ci:api" }],
      pending_checks: [{ name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" }],
      unknown_checks: [],
    });
    assert.deepEqual(prContextQueueContext(context), {
      isQueue: true,
      pullRequests: [{ prNumber: 206 }],
    });
    assert.equal(prContextUrl({ permalink: " https://example.test/pull/206 " }), "https://example.test/pull/206");
    assert.equal(prContextDiffText({ diffText: " diff --git a/api.ts b/api.ts " }), " diff --git a/api.ts b/api.ts ");
    assert.equal(prContextDiffText({ rawDiff: "   ", patch: "@@ -1 +1 @@" }), "@@ -1 +1 @@");
    assert.deepEqual(evidenceSummaryFromContext(context), {
      ci_status: {
        total_checks: 3,
        passed: 1,
        failed: 1,
        pending: 1,
        skipped: 0,
        unknown: 0,
        failed_checks: [{ name: "api", conclusion: "FAILURE", details_url: "ci:api" }],
        pending_checks: [{ name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" }],
        unknown_checks: [],
      },
      conflicts: undefined,
      diff_availability: undefined,
      merge_blockers: undefined,
      queue_context: {
        isQueue: true,
        pullRequests: [{ prNumber: 206 }],
      },
    });
  });

  test("does not synthesize queue context from ordinary top-level PR commits", () => {
    assert.deepEqual(
      prContextQueueContext({
        commits: [
          {
            oid: "61a9070",
            messageHeadline: "fix(pr-loop): avoid success-derived blocker labels",
          },
        ],
      }),
      {},
    );
    assert.deepEqual(
      prContextQueueContext({
        mergeCommits: [
          {
            oid: "merge201",
            prNumber: 201,
          },
        ],
      }),
      {
        merge_commits: [{ oid: "merge201", prNumber: 201 }],
      },
    );
  });

  test("falls back past non-decisive canonical queue context records to useful aliases", () => {
    assert.deepEqual(
      prContextQueueContext({
        queue_context: { is_queue: "surprise", strategy: " " },
        queueContext: {
          isQueue: true,
          constituentPrs: [{ prNumber: 206 }],
        },
      }),
      {
        isQueue: true,
        constituentPrs: [{ prNumber: 206 }],
      },
    );
    assert.deepEqual(
      prContextQueueContext({
        queue_context: { isQueue: false },
        queueContext: {
          isQueue: true,
          constituentPrs: [{ prNumber: 206 }],
        },
      }),
      { isQueue: false },
    );
  });

  test("does not let zero-count CI placeholders hide raw status-check rollups", () => {
    assert.deepEqual(
      prContextCiStatus({
        ci_status: {
          total_checks: 0,
          failed: 0,
          pending: 0,
          unknown: 0,
          passed: 0,
        },
        statusCheckRollup: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
          { name: "lint", conclusion: "SUCCESS", detailsUrl: "ci:lint" },
        ],
      }),
      {
        total_checks: 3,
        passed: 1,
        failed: 1,
        pending: 1,
        skipped: 0,
        unknown: 0,
        failed_checks: [{ name: "api", conclusion: "FAILURE", details_url: "ci:api" }],
        pending_checks: [{ name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" }],
        unknown_checks: [],
      },
    );
  });

  test("enriches nonzero CI summaries with raw status-check rollup details", () => {
    assert.deepEqual(
      prContextCiStatus({
        ci_status: {
          total_checks: 4,
          failed: 2,
          pending: 1,
          unknown: 0,
          passed: 1,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          ],
        },
        statusCheckRollup: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "worker", conclusion: "FAILURE", detailsUrl: "ci:worker" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
          { name: "lint", conclusion: "SUCCESS", detailsUrl: "ci:lint" },
        ],
      }),
      {
        total_checks: 4,
        failed: 2,
        pending: 1,
        unknown: 0,
        passed: 1,
        failed_checks: [
          { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          { name: "worker", conclusion: "FAILURE", details_url: "ci:worker" },
        ],
        pending_checks: [
          { name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" },
        ],
        unknown_checks: [],
      },
    );
  });

  test("does not let blank canonical status-check rows hide useful rollup aliases", () => {
    assert.deepEqual(
      prContextCiStatus({
        status_check_rollup: [
          { name: " ", conclusion: "", status: "", detailsUrl: "" },
        ],
        statusChecks: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        ],
      }),
      {
        total_checks: 2,
        passed: 0,
        failed: 1,
        pending: 1,
        skipped: 0,
        unknown: 0,
        failed_checks: [{ name: "api", conclusion: "FAILURE", details_url: "ci:api" }],
        pending_checks: [{ name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" }],
        unknown_checks: [],
      },
    );
    assert.deepEqual(
      prContextCiStatus({
        status_check_rollup: [
          { name: "api" },
        ],
        statusChecks: [
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        ],
      }),
      {
        total_checks: 1,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        unknown: 1,
        failed_checks: [],
        pending_checks: [],
        unknown_checks: [{ name: "api", state: "", status: "", conclusion: "", details_url: "" }],
      },
    );
  });

  test("does not let unknown diff availability placeholders hide useful aliases", () => {
    assert.deepEqual(
      prContextDiffAvailability({
        diff_availability: {
          available: "surprise",
          source: "gh-pr-diff",
        },
        diffAvailability: {
          available: false,
          message: "Diff timed out.",
          evidenceRef: "diff:timeout",
        },
      }),
      {
        available: false,
        message: "Diff timed out.",
        evidenceRef: "diff:timeout",
      },
    );

    assert.deepEqual(
      evidenceSummaryFromContext({
        diff_availability: {
          available: "surprise",
          source: "gh-pr-diff",
        },
        diffAvailability: {
          available: false,
          message: "Diff timed out.",
          evidenceRef: "diff:timeout",
        },
      }).diff_availability,
      {
        available: false,
        message: "Diff timed out.",
        evidenceRef: "diff:timeout",
      },
    );
  });

  test("does not let unknown conflict placeholders hide useful aliases", () => {
    assert.deepEqual(
      prContextConflicts({
        conflicts: {
          has_conflicts: "surprise",
          source: "merge-tree",
        },
        mergeConflicts: {
          hasConflicts: true,
          conflictCount: 2,
          conflictingFiles: ["packages/api/src/app.ts"],
          evidenceRef: "conflict:cached",
        },
      }),
      {
        hasConflicts: true,
        conflictCount: 2,
        conflictingFiles: ["packages/api/src/app.ts"],
        evidenceRef: "conflict:cached",
      },
    );

    assert.deepEqual(
      prContextConflicts({
        conflicts: {
          has_conflicts: false,
        },
        mergeConflicts: {
          hasConflicts: true,
          conflictCount: 2,
        },
      }),
      {
        has_conflicts: false,
      },
    );
  });

  test("synthesizes flattened raw adapter queue context aliases", () => {
    const context = {
      isQueue: "true",
      queueStrategy: "manual",
      pullRequests: [
        { node: { prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] } },
      ],
      mergeCommits: [
        { node: { oid: "abc123", message: "Merge PR #207 from org/feature" } },
      ],
      validationResults: [
        { node: { command: "npm test", result: "failure", scope: "#207", evidenceRef: "validation:207" } },
      ],
      blockers: [
        { node: { kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRef: "queue:blocker" } },
      ],
    };

    assert.deepEqual(prContextQueueContext(context), {
      is_queue: true,
      strategy: "manual",
      constituent_prs: [{ prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] }],
      merge_commits: [{ oid: "abc123", message: "Merge PR #207 from org/feature" }],
      validation_evidence: [{ command: "npm test", result: "failure", scope: "#207", evidenceRef: "validation:207" }],
      unresolved_blockers: [{ kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRef: "queue:blocker" }],
    });
    assert.deepEqual(evidenceSummaryFromContext(context), {
      ci_status: undefined,
      conflicts: undefined,
      diff_availability: undefined,
      merge_blockers: undefined,
      queue_context: {
        is_queue: true,
        strategy: "manual",
        constituent_prs: [{ prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] }],
        merge_commits: [{ oid: "abc123", message: "Merge PR #207 from org/feature" }],
        validation_evidence: [{ command: "npm test", result: "failure", scope: "#207", evidenceRef: "validation:207" }],
        unresolved_blockers: [{ kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRef: "queue:blocker" }],
      },
    });
  });

  test("synthesizes flattened queue aliases after blank canonical queue rows", () => {
    const context = {
      isQueue: "true",
      queueStrategy: "manual",
      constituent_prs: [{ number: "", title: " ", status: "" }],
      constituentPrs: [{ prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] }],
      merge_commits: [{ oid: "", message: " " }],
      mergeCommits: [{ oid: "abc123", message: "Merge PR #207 from org/feature" }],
      validation_evidence: [{ command: " ", status: "", scope: "" }],
      validationResults: [{ command: "npm test", result: "failure", scope: "#207", evidenceRef: "validation:207" }],
      unresolved_blockers: [{ kind: "", status: " ", summary: "" }],
      queueBlockers: [{ kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRef: "queue:blocker" }],
      blockers: [{ kind: "", status: " ", summary: "" }],
    };

    assert.deepEqual(prContextQueueContext(context), {
      is_queue: true,
      strategy: "manual",
      constituent_prs: [{ prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] }],
      merge_commits: [{ oid: "abc123", message: "Merge PR #207 from org/feature" }],
      validation_evidence: [{ command: "npm test", result: "failure", scope: "#207", evidenceRef: "validation:207" }],
      unresolved_blockers: [{ kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRef: "queue:blocker" }],
    });
  });

  test("normalizes direct edge-shaped top-level records for evidence projection", () => {
    const context = {
      ciStatus: {
        __typename: "StatusCheckRollupEdge",
        cursor: "ci",
        node: { totalChecks: 1, failedChecks: [{ detailsUrl: "ci:api" }] },
      },
      mergeConflicts: {
        node: { hasConflicts: true, conflictingFiles: ["packages/api/src/app.ts"] },
      },
      queueContext: {
        node: {
          isQueue: true,
          constituentPrs: [{ prNumber: 201, evidenceRefs: ["pr:#201"] }],
        },
      },
    };

    assert.deepEqual(prContextCiStatus(context), { totalChecks: 1, failedChecks: [{ detailsUrl: "ci:api" }] });
    assert.deepEqual(prContextConflicts(context), { hasConflicts: true, conflictingFiles: ["packages/api/src/app.ts"] });
    assert.deepEqual(prContextQueueContext(context), {
      isQueue: true,
      constituentPrs: [{ prNumber: 201, evidenceRefs: ["pr:#201"] }],
    });
    assert.deepEqual(evidenceSummaryFromContext(context), {
      ci_status: { totalChecks: 1, failedChecks: [{ detailsUrl: "ci:api" }] },
      conflicts: { hasConflicts: true, conflictingFiles: ["packages/api/src/app.ts"] },
      merge_blockers: undefined,
      diff_availability: undefined,
      queue_context: {
        isQueue: true,
        constituentPrs: [{ prNumber: 201, evidenceRefs: ["pr:#201"] }],
      },
    });
  });

  test("normalizes direct edge-shaped whole context records", () => {
    const context = {
      cursor: "context-201",
      node: {
        webUrl: "https://github.example.test/org/repo/pull/204",
        ciStatus: {
          cursor: "ci",
          node: { totalChecks: 1, pendingChecks: [{ node: { name: "deploy", detailsUrl: "ci:deploy" } }] },
        },
        mergeConflicts: {
          node: { hasConflicts: true, conflictingFiles: ["packages/web/src/app.ts"] },
        },
        issueComments: {
          edges: [{ node: { body: "Manual queue for #201 and #202" } }],
        },
        reviewComments: {
          edges: [{ node: { body: "PR #202: follow-up" } }],
        },
        commitNodes: {
          edges: [{ node: { oid: "abc1234", message: "Merge pull request #201" } }],
        },
        changedFiles: {
          edges: [{ node: { filename: "packages/web/src/app.ts" } }],
        },
        queueContext: {
          node: { isQueue: true, strategy: "manual" },
        },
      },
    };

    assert.deepEqual(prContextCiStatus(context), {
      totalChecks: 1,
      pendingChecks: [{ node: { name: "deploy", detailsUrl: "ci:deploy" } }],
    });
    assert.equal(prContextUrl(context), "https://github.example.test/org/repo/pull/204");
    assert.deepEqual(prContextConflicts(context), {
      hasConflicts: true,
      conflictingFiles: ["packages/web/src/app.ts"],
    });
    assert.deepEqual(prContextComments(context), [{ body: "Manual queue for #201 and #202" }]);
    assert.deepEqual(prContextReviewComments(context), [{ body: "PR #202: follow-up" }]);
    assert.deepEqual(prContextCommits(context), [{ oid: "abc1234", message: "Merge pull request #201" }]);
    assert.deepEqual(prContextFiles(context), [{ filename: "packages/web/src/app.ts" }]);
    assert.deepEqual(prContextQueueContext(context), { isQueue: true, strategy: "manual" });
    assert.deepEqual(evidenceSummaryFromContext(context), {
      ci_status: {
        totalChecks: 1,
        pendingChecks: [{ node: { name: "deploy", detailsUrl: "ci:deploy" } }],
      },
      conflicts: {
        hasConflicts: true,
        conflictingFiles: ["packages/web/src/app.ts"],
      },
      merge_blockers: undefined,
      diff_availability: undefined,
      queue_context: { isQueue: true, strategy: "manual" },
    });
  });
});
