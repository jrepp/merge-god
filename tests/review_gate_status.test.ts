import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { reviewGateStatusesFromContext } from "../review_gate_status";

describe("reviewGateStatusesFromContext", () => {
  test("uses normalized PR detail metadata when projecting context-gathered status", () => {
    assert.deepEqual(
      reviewGateStatusesFromContext(
        { node: {} },
        {
          conflicts: { has_conflicts: false, conflicting_files: [] },
          ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
          merge_blockers: [],
          queue_context: null,
        },
        "",
      ).find((gate) => gate.rule === "context-gathered"),
      {
        rule: "context-gathered",
        status: "blocked",
        explanation: "PR details could not be loaded.",
      },
    );

    assert.deepEqual(
      reviewGateStatusesFromContext(
        { node: { number: 203, reviewDecision: "APPROVED" } },
        {
          conflicts: { has_conflicts: false, conflicting_files: [] },
          ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
          merge_blockers: [],
          queue_context: null,
        },
        "",
      ).find((gate) => gate.rule === "context-gathered"),
      {
        rule: "context-gathered",
        status: "pass",
        explanation: "PR metadata, comments, commits, files, diff, conflicts, and CI state were gathered.",
      },
    );
  });

  test("uses explicit merge conflict counts when file lists are incomplete", () => {
    const gates = reviewGateStatusesFromContext(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflict_count: 3,
          conflicting_files: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "merge-conflicts"),
      {
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected in 3 file(s).",
      },
    );
  });

  test("does not report zero merge conflict files when conflict count is unavailable", () => {
    const gates = reviewGateStatusesFromContext(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflicting_files: [],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "merge-conflicts"),
      {
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected, but the conflicting file count was unavailable.",
      },
    );
  });

  test("does not let explicit merge conflict counts understate listed files", () => {
    const gates = reviewGateStatusesFromContext(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflict_count: 1,
          conflicting_files: [
            "packages/api/src/routes.ts",
            "apps/web/src/App.tsx",
          ],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "merge-conflicts"),
      {
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected in 2 file(s).",
      },
    );
  });

  test("counts only unique listed merge conflict file names", () => {
    const gates = reviewGateStatusesFromContext(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflicting_files: [
            "packages/api/src/routes.ts",
            "",
            null,
            " packages/api/src/routes.ts ",
            "apps/web/src/App.tsx",
          ],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "merge-conflicts"),
      {
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected in 2 file(s).",
      },
    );
  });

  test("normalizes serialized active conflict flags in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      {},
      {
        conflicts: {
          hasConflicts: "yes",
          conflictCount: 2,
          conflictingFiles: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "merge-conflicts"),
      {
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected in 2 file(s).",
      },
    );
  });

  test("falls back past unknown conflict placeholders in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      {},
      {
        conflicts: {
          has_conflicts: "surprise",
          source: "merge-tree",
        },
        mergeConflicts: {
          hasConflicts: true,
          conflictCount: 2,
          conflictingFiles: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "merge-conflicts"),
      {
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected in 2 file(s).",
      },
    );
  });

  test("normalizes GitHub review decisions before projecting review status", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: " changes requested " },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "review-decision"),
      {
        rule: "review-decision",
        status: "blocked",
        explanation: "GitHub review decision has requested changes.",
      },
    );
  });

  test("uses normalized review-decision detail aliases in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { review_decision: "review required" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "review-decision"),
      {
        rule: "review-decision",
        status: "blocked",
        explanation: "GitHub requires review before this PR can merge.",
      },
    );
  });

  test("falls back past blank canonical review-decision text in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "   ", review_decision: "changes requested" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "review-decision"),
      {
        rule: "review-decision",
        status: "blocked",
        explanation: "GitHub review decision has requested changes.",
      },
    );
  });

  test("falls back past unknown canonical review-decision text in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "UNKNOWN", review_decision: "changes requested" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "review-decision"),
      {
        rule: "review-decision",
        status: "blocked",
        explanation: "GitHub review decision has requested changes.",
      },
    );
  });

  test("deduplicates blockers repeated in top-level and queue context", () => {
    const repeatedBlocker = {
      kind: "review_required",
      status: "blocked",
      summary: "GitHub requires review before this PR can merge.",
      evidence_refs: ["github:reviewDecision"],
    };

    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "REVIEW_REQUIRED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [repeatedBlocker],
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            repeatedBlocker,
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #12 has 1 failed or blocked validation evidence item(s).",
              evidence_refs: ["https://example.test/comment"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: [
          "review_required: GitHub requires review before this PR can merge.",
          "ci_failed: Queue constituent PR #12 has 1 failed or blocked validation evidence item(s).",
        ].join("; "),
      },
    );
  });

  test("deduplicates repeated blockers even when evidence refs differ", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "REVIEW_REQUIRED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
            evidence_refs: ["github:reviewDecision"],
          },
        ],
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            {
              kind: "review_required",
              status: "blocked",
              summary: "GitHub requires review before this PR can merge.",
              evidence_refs: ["comment:queue-copy"],
            },
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #12 has 1 failed or blocked validation evidence item(s).",
              evidence_refs: ["comment:queue-validation"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: [
          "review_required: GitHub requires review before this PR can merge.",
          "ci_failed: Queue constituent PR #12 has 1 failed or blocked validation evidence item(s).",
        ].join("; "),
      },
    );
  });

  test("projects blocked diff availability into modeled blockers", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: {
          available: false,
          error: "GitHub diff timed out.",
          evidenceRef: "diff:timeout",
        },
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "diff_unavailable: GitHub diff timed out.",
      },
    );
  });

  test("deduplicates synthesized diff blockers already present in modeled blockers", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: {
          available: false,
          error: "GitHub diff timed out.",
          evidenceRef: "diff:timeout",
        },
        merge_blockers: [
          {
            kind: "diff_unavailable",
            status: "blocked",
            summary: "GitHub diff timed out.",
            evidence_refs: ["diff:cached"],
          },
        ],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "diff_unavailable: GitHub diff timed out.",
      },
    );
  });

  test("projects supplemental PR detail and comment blockers into modeled blockers", () => {
    const gates = reviewGateStatusesFromContext(
      {
        isDraft: true,
        reviewDecision: "APPROVED",
        mergeStateStatus: "BEHIND",
        labels: ["for-review", "do not merge"],
      },
      {
        comments: [
          {
            body: "merge-god: blocked waiting on release",
            html_url: "comment:manual-gate",
          },
        ],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: [
          "draft: GitHub reports this PR is still marked as draft.",
          "external_gate: Label 'do not merge' marks this PR as blocked for landing.",
          "external_gate: Manual merge gate is blocked: waiting on release.",
          "merge_state_blocked: GitHub reports the PR merge state as BEHIND.",
        ].join("; "),
      },
    );
  });

  test("keeps dedicated CI review and conflict blockers out of synthesized modeled blockers", () => {
    const gates = reviewGateStatusesFromContext(
      {
        reviewDecision: "REVIEW_REQUIRED",
      },
      {
        conflicts: {
          has_conflicts: true,
          conflict_count: 1,
          conflicting_files: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 1, pending: 0, unknown: 0, passed: 0 },
        diff_availability: { available: true },
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.filter((gate) => ["modeled-blockers", "merge-conflicts", "ci-status", "review-decision"].includes(gate.rule)),
      [
        {
          rule: "modeled-blockers",
          status: "pass",
          explanation: "No modeled merge blockers were detected.",
        },
        {
          rule: "merge-conflicts",
          status: "blocked",
          explanation: "Merge conflicts detected in 1 file(s).",
        },
        {
          rule: "ci-status",
          status: "fail",
          explanation: "1 failed, 0 pending, 0 unknown, 0 passed out of 1 check(s).",
        },
        {
          rule: "review-decision",
          status: "blocked",
          explanation: "GitHub requires review before this PR can merge.",
        },
      ],
    );
  });

  test("keeps dedicated gathered blockers out of modeled blockers", () => {
    const gates = reviewGateStatusesFromContext(
      {
        reviewDecision: "REVIEW_REQUIRED",
      },
      {
        conflicts: {
          has_conflicts: true,
          conflict_count: 1,
          conflicting_files: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 1, pending: 0, unknown: 0, passed: 0 },
        diff_availability: { available: true },
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
            evidence_refs: ["github:reviewDecision"],
          },
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "1 CI check(s) failed.",
            evidence_refs: ["github:statusCheckRollup"],
          },
          {
            kind: "merge_conflicts",
            status: "blocked",
            summary: "Merge conflicts detected in 1 file(s).",
            evidence_refs: ["git:merge-tree"],
          },
          {
            kind: "merge_state_blocked",
            status: "pending",
            summary: "GitHub reports the PR merge state as BEHIND.",
            evidence_refs: ["github:mergeStateStatus"],
          },
        ],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.filter((gate) => ["modeled-blockers", "merge-conflicts", "ci-status", "review-decision"].includes(gate.rule)),
      [
        {
          rule: "modeled-blockers",
          status: "pending",
          explanation: "merge_state_blocked: GitHub reports the PR merge state as BEHIND.",
        },
        {
          rule: "merge-conflicts",
          status: "blocked",
          explanation: "Merge conflicts detected in 1 file(s).",
        },
        {
          rule: "ci-status",
          status: "fail",
          explanation: "1 failed, 0 pending, 0 unknown, 0 passed out of 1 check(s).",
        },
        {
          rule: "review-decision",
          status: "blocked",
          explanation: "GitHub requires review before this PR can merge.",
        },
      ],
    );
  });

  test("uses cached camelCase unresolved blockers in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          isQueue: true,
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue constituent PR #201 has 1 failed validation evidence item.",
      },
    );
  });

  test("uses integration vocabulary queue blockers in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          queueStrategy: "manual",
          pullRequests: [{ prNumber: 206, status: "blocked" }],
          validationResults: [{ command: "npm test", status: "failed", scope: "#206" }],
          blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #206 has 1 failed validation evidence item.",
              evidenceRefs: ["queue:blocker-alias"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue constituent PR #206 has 1 failed validation evidence item.",
      },
    );
  });

  test("uses raw adapter CI and queue context aliases in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        statusCheckRollup: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "lint", conclusion: "SUCCESS", detailsUrl: "ci:lint" },
        ],
        merge_blockers: [],
        mergeQueueContext: {
          blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #207 has 1 failed validation evidence item.",
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.filter((gate) => ["modeled-blockers", "ci-status"].includes(gate.rule)),
      [
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: "ci_failed: Queue constituent PR #207 has 1 failed validation evidence item.",
        },
        {
          rule: "ci-status",
          status: "fail",
          explanation: "1 failed, 0 pending, 0 unknown, 1 passed out of 2 check(s).",
        },
      ],
    );
  });

  test("does not project stale queue blockers when queue context is explicitly disabled", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          isQueue: false,
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Stale queue validation failed.",
              evidenceRefs: ["queue:stale"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "pass",
        explanation: "No modeled merge blockers were detected.",
      },
    );
  });

  test("uses queue context aliases after non-decisive canonical queue context records", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: { is_queue: "surprise", strategy: " " },
        queueContext: {
          isQueue: true,
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation failed.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue validation failed.",
      },
    );
  });

  test("infers missing queue context before projecting modeled blocker gates", () => {
    const gates = reviewGateStatusesFromContext(
      {
        title: "Merge queue: PRs #201 and #202",
        number: 300,
        reviewDecision: "APPROVED",
      },
      {
        comments: [
          {
            html_url: "comment:validation",
            body: "- #201 `npm test` -> failed",
          },
        ],
        review_comments: [],
        commits: [],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
      },
    );
  });

  test("uses queue blocker aliases after blank canonical queue blocker rows", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          isQueue: true,
          unresolved_blockers: [
            { kind: "", status: " ", summary: "" },
          ],
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation failed.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue validation failed.",
      },
    );
  });

  test("uses cached top-level PR context aliases in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        mergeConflicts: {
          hasConflicts: true,
          conflict_count: 0,
          conflictCount: 3,
          conflictingFiles: ["packages/api/src/app.ts", "packages/ui/src/view.ts"],
        },
        ciStatus: {
          totalChecks: 0,
          failed: 0,
          failedChecks: [
            { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          ],
        },
        mergeBlockers: [
          {
            kind: "external_gate",
            status: "ACTION REQUIRED",
            summary: "External approval is required.",
          },
        ],
        queueContext: {
          isQueue: true,
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.filter((gate) => ["modeled-blockers", "merge-conflicts", "ci-status"].includes(gate.rule)),
      [
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: [
            "external_gate: External approval is required.",
            "ci_failed: Queue constituent PR #201 has 1 failed validation evidence item.",
          ].join("; "),
        },
        {
          rule: "merge-conflicts",
          status: "blocked",
          explanation: "Merge conflicts detected in 3 file(s).",
        },
        {
          rule: "ci-status",
          status: "fail",
          explanation: "1 failed, 0 pending, 0 unknown, 0 passed out of 1 check(s).",
        },
      ],
    );
  });

  test("uses direct edge-shaped whole PR context records in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { node: { number: 204, reviewDecision: "APPROVED" } },
      {
        cursor: "context-204",
        node: {
          mergeConflicts: {
            node: {
              hasConflicts: true,
              conflictCount: 1,
              conflictingFiles: ["packages/api/src/edge.ts"],
            },
          },
          ciStatus: {
            node: {
              totalChecks: 1,
              pendingChecks: [
                { node: { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" } },
              ],
            },
          },
          mergeBlockers: {
            edges: [
              {
                node: {
                  type: "external_gate",
                  state: "ACTION REQUIRED",
                  message: "Release manager approval is required.",
                },
              },
            ],
          },
          queueContext: {
            node: {
              isQueue: true,
              unresolvedBlockers: [
                {
                  node: {
                    category: "queue_validation",
                    outcome: "running",
                    description: "Queue validation is still running.",
                  },
                },
              ],
            },
          },
        },
      },
      "",
    );

    assert.deepEqual(
      gates.filter((gate) => ["context-gathered", "modeled-blockers", "merge-conflicts", "ci-status"].includes(gate.rule)),
      [
        {
          rule: "context-gathered",
          status: "pass",
          explanation: "PR metadata, comments, commits, files, diff, conflicts, and CI state were gathered.",
        },
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: "external_gate: Release manager approval is required.; queue_validation: Queue validation is still running.",
        },
        {
          rule: "merge-conflicts",
          status: "blocked",
          explanation: "Merge conflicts detected in 1 file(s).",
        },
        {
          rule: "ci-status",
          status: "pending",
          explanation: "0 failed, 1 pending, 0 unknown, 0 passed out of 1 check(s).",
        },
      ],
    );
  });

  test("falls back past empty canonical top-level records in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: {},
        ci_status: {},
        queue_context: {},
        mergeConflicts: {
          hasConflicts: true,
          conflictCount: 1,
          conflictingFiles: ["packages/api/src/app.ts"],
        },
        ciStatus: {
          totalChecks: 0,
          failed: 0,
          failedChecks: [
            { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          ],
        },
        queueContext: {
          isQueue: true,
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.filter((gate) => ["modeled-blockers", "merge-conflicts", "ci-status"].includes(gate.rule)),
      [
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: "ci_failed: Queue constituent PR #201 has 1 failed validation evidence item.",
        },
        {
          rule: "merge-conflicts",
          status: "blocked",
          explanation: "Merge conflicts detected in 1 file(s).",
        },
        {
          rule: "ci-status",
          status: "fail",
          explanation: "1 failed, 0 pending, 0 unknown, 0 passed out of 1 check(s).",
        },
      ],
    );
  });

  test("treats malformed blockers as unknown instead of passing", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "UNKNOWN" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "",
            status: "",
            summary: "",
            evidence_refs: ["blocker:top"],
          },
        ],
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            {
              evidence_refs: ["blocker:queue-copy"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "unknown",
        explanation: "unknown: No summary.",
      },
    );
  });

  test("falls back past blank canonical blocker rows in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "",
            status: " ",
            summary: "",
          },
        ],
        mergeBlockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External gate blocked.",
          },
        ],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "external_gate: External gate blocked.",
      },
    );
  });

  test("uses useful flat blockers after blank canonical blocker rows in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "",
            status: " ",
            summary: "",
          },
        ],
        blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Flat gate blocked.",
          },
        ],
        queue_context: null,
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "external_gate: Flat gate blocked.",
      },
    );
  });

  test("treats unrecognized blocker statuses as unknown instead of passing", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "external_gate",
            status: "surprise",
            summary: "An external gate reported an unexpected state.",
          },
        ],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "unknown",
        explanation: "external_gate: An external gate reported an unexpected state.",
      },
    );
  });

  test("normalizes cached blocker status aliases before gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "external_gate",
            status: "ACTION REQUIRED",
            summary: "External approval is required.",
          },
          {
            kind: "merge_state_blocked",
            status: "in-progress",
            summary: "Mergeability is still being computed.",
          },
        ],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "external_gate: External approval is required.; merge_state_blocked: Mergeability is still being computed.",
      },
    );
  });

  test("normalizes cached blocker field aliases before gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        mergeBlockers: [
          {
            type: "external_gate",
            state: "ACTION REQUIRED",
            message: "External release approval is required.",
          },
        ],
        queueContext: {
          isQueue: true,
          unresolvedBlockers: [
            {
              category: "queue_validation",
              outcome: "running",
              description: "Queue validation is still running.",
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "external_gate: External release approval is required.; queue_validation: Queue validation is still running.",
      },
    );
  });

  test("treats malformed negative cached CI counts as no reported checks", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: -1,
          failed: -2,
          pending: -3,
          unknown: -4,
          passed: -5,
        },
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "ci-status"),
      {
        rule: "ci-status",
        status: "unknown",
        explanation: "No CI status checks were reported.",
      },
    );
  });

  test("does not let zero cached CI counts hide failed check details", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: 0,
          failed: 0,
          pending: 0,
          unknown: 0,
          passed: 0,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          ],
        },
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "ci-status"),
      {
        rule: "ci-status",
        status: "fail",
        explanation: "1 failed, 0 pending, 0 unknown, 0 passed out of 1 check(s).",
      },
    );
  });

  test("does not let zero cached CI summaries hide status-check rollups", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
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
        ],
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "ci-status"),
      {
        rule: "ci-status",
        status: "fail",
        explanation: "1 failed, 1 pending, 0 unknown, 0 passed out of 2 check(s).",
      },
    );
  });

  test("does not let blank canonical status-check rows hide useful rollup aliases", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        status_check_rollup: [
          { name: " ", conclusion: "", status: "", detailsUrl: "" },
        ],
        statusChecks: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        ],
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "ci-status"),
      {
        rule: "ci-status",
        status: "fail",
        explanation: "1 failed, 1 pending, 0 unknown, 0 passed out of 2 check(s).",
      },
    );
  });

  test("uses cached CI count aliases in gate projection", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: 0,
          totalCount: 4,
          failed: 0,
          failedCount: 1,
          pending: 0,
          pending_count: 1,
          unknown: 0,
          unknownCount: 1,
          passed: 0,
          passed_count: 1,
        },
        merge_blockers: [],
        queue_context: {},
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "ci-status"),
      {
        rule: "ci-status",
        status: "fail",
        explanation: "1 failed, 1 pending, 1 unknown, 1 passed out of 4 check(s).",
      },
    );
  });

  test("treats blank merge rules as absent and non-empty rules as pending", () => {
    const blankRulesGate = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {},
      },
      "   \n\t  ",
    ).find((gate) => gate.rule === "repo-merge-rules");

    const loadedRulesGate = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {},
      },
      "rules:\n  require: ci",
    ).find((gate) => gate.rule === "repo-merge-rules");

    assert.deepEqual(blankRulesGate, {
      rule: "repo-merge-rules",
      status: "skipped",
      explanation: "No repository merge rules were loaded.",
    });
    assert.deepEqual(loadedRulesGate, {
      rule: "repo-merge-rules",
      status: "pending",
      explanation: "Repository merge rules were loaded and still require final gate evaluation.",
    });
  });
});
