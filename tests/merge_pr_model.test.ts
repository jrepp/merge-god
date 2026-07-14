import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { analyzeMergeBlockers, inferMergeQueueContext } from "../merge_pr_model";
import { REVIEW_GATE_CACHE_MARKER } from "../review_gate_cache";

describe("merge PR model", () => {
  test("uses explicit merge conflict counts when file lists are incomplete", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflict_count: 3,
          conflicting_files: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected in 3 file(s).",
        evidence_refs: ["git:merge-tree"],
      },
    );
  });

  test("preserves explicit merge conflict evidence refs on blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflict_count: 2,
          conflicting_files: ["packages/api/src/routes.ts"],
          evidence_refs: [" conflict:merge-tree ", "", "   ", "conflict:merge-tree", "conflict:rerere"],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected in 2 file(s).",
        evidence_refs: ["conflict:merge-tree", "conflict:rerere"],
      },
    );
  });

  test("does not report zero merge conflict files when conflict count is unavailable", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflicting_files: [],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected, but the conflicting file count was unavailable.",
        evidence_refs: ["git:merge-tree"],
      },
    );
  });

  test("does not let explicit merge conflict counts understate listed files", () => {
    const blockers = analyzeMergeBlockers(
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
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected in 2 file(s).",
        evidence_refs: ["git:merge-tree"],
      },
    );
  });

  test("counts only unique listed merge conflict file names", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: {
          has_conflicts: true,
          conflicting_files: [
            "packages/api/src/routes.ts",
            "",
            null,
            "packages/api/src/routes.ts",
            "apps/web/src/App.tsx",
          ],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected in 2 file(s).",
        evidence_refs: ["git:merge-tree"],
      },
    );
  });

  test("normalizes serialized active conflict flags when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: {
          has_conflicts: "true",
          conflictCount: 2,
          conflictingFiles: ["packages/api/src/routes.ts"],
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected in 2 file(s).",
        evidence_refs: ["git:merge-tree"],
      },
    );
  });

  test("falls back past unknown conflict placeholders when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
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
          evidenceRef: "conflict:cached",
        },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "merge_conflicts"),
      {
        kind: "merge_conflicts",
        status: "blocked",
        summary: "Merge conflicts detected in 2 file(s).",
        evidence_refs: ["conflict:cached"],
      },
    );
  });

  test("uses a default diff-unavailable summary when the cached error is blank", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: {
          available: "too-large",
          error: "   ",
        },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "diff_unavailable"),
      {
        kind: "diff_unavailable",
        status: "blocked",
        summary: "PR diff was unavailable during context gathering.",
        evidence_refs: ["gh:pr-diff"],
      },
    );
  });

  test("normalizes cached diff availability aliases before blocker modeling", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diffAvailability: {
          available: "   ",
          isAvailable: "timeout",
          error: "   ",
          errorMessage: "GitHub diff timed out.",
          sourceUrl: "diff:timeout",
        },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "diff_unavailable"),
      {
        kind: "diff_unavailable",
        status: "blocked",
        summary: "GitHub diff timed out.",
        evidence_refs: ["diff:timeout"],
      },
    );
  });

  test("preserves link-map diff refs on unavailable-diff blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: {
          available: false,
          error: "Provider refused the diff.",
          links: {
            html: { href: "diff:provider-log" },
          },
        },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "diff_unavailable"),
      {
        kind: "diff_unavailable",
        status: "blocked",
        summary: "Provider refused the diff.",
        evidence_refs: ["diff:provider-log"],
      },
    );
  });

  test("treats malformed negative cached CI counts as missing checks", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: -1,
          failed: -2,
          pending: -3,
          unknown: -4,
          passed: -5,
        },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "ci_missing"),
      {
        kind: "ci_missing",
        status: "unknown",
        summary: "No status checks were reported for this PR.",
        evidence_refs: ["github:statusCheckRollup"],
      },
    );
    assert.equal(blockers.some((blocker) => /-\d/.test(blocker.summary)), false);
  });

  test("does not let zero cached CI counts hide failed check details", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: 0,
          failed: 0,
          pending: 0,
          unknown: 0,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          ],
        },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "ci_failed"),
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "1 CI check(s) failed.",
        evidence_refs: ["ci:api"],
      },
    );
  });

  test("analyzes direct edge-shaped whole PR context records", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        cursor: "context-204",
        node: {
          mergeConflicts: {
            node: {
              hasConflicts: true,
              conflictingFiles: ["packages/api/src/edge.ts"],
              evidenceRefs: ["conflict:edge"],
            },
          },
          ciStatus: {
            node: {
              totalChecks: 1,
              failedChecks: [
                { node: { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api-edge" } },
              ],
            },
          },
          diffAvailability: {
            node: { available: true },
          },
        },
      },
    );

    assert.deepEqual(
      blockers.filter((blocker) => blocker.kind === "merge_conflicts" || blocker.kind === "ci_failed"),
      [
        {
          kind: "merge_conflicts",
          status: "blocked",
          summary: "Merge conflicts detected in 1 file(s).",
          evidence_refs: ["conflict:edge"],
        },
        {
          kind: "ci_failed",
          status: "blocked",
          summary: "1 CI check(s) failed.",
          evidence_refs: ["ci:api-edge"],
        },
      ],
    );
  });

  test("uses cached CI count aliases when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
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
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "ci_failed"),
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "1 CI check(s) failed.",
        evidence_refs: ["github:statusCheckRollup"],
      },
    );
  });

  test("preserves concrete CI detail refs on pending and unknown blockers", () => {
    const pendingBlockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: 2,
          failed: 0,
          pending: 2,
          unknown: 0,
          pending_checks: [
            { name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" },
          ],
        },
        diff_availability: { available: true },
      },
    );
    assert.deepEqual(
      pendingBlockers.find((blocker) => blocker.kind === "ci_pending"),
      {
        kind: "ci_pending",
        status: "pending",
        summary: "2 CI check(s) are pending.",
        evidence_refs: ["ci:deploy", "github:statusCheckRollup"],
      },
    );

    const unknownBlockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: {
          total_checks: 1,
          failed: 0,
          pending: 0,
          unknown: 1,
          unknown_checks: [
            { name: "manual", state: "WAITING", url: "ci:manual" },
          ],
        },
        diff_availability: { available: true },
      },
    );
    assert.deepEqual(
      unknownBlockers.find((blocker) => blocker.kind === "unknown"),
      {
        kind: "unknown",
        status: "unknown",
        summary: "1 CI check(s) could not be classified.",
        evidence_refs: ["ci:manual"],
      },
    );
  });

  test("normalizes GitHub review and merge state statuses before classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        reviewDecision: " changes_requested ",
        mergeStateStatus: " has-hooks ",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["changes_requested", "blocked", "GitHub review decision has requested changes."],
        ["merge_state_blocked", "pending", "GitHub reports the PR merge state as HAS_HOOKS."],
      ],
    );
  });

  test("uses cached top-level PR context aliases when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        mergeConflicts: {
          hasConflicts: true,
          conflict_count: 0,
          conflictCount: 3,
          conflictingFiles: ["packages/api/src/app.ts", "packages/ui/src/view.ts"],
          evidenceRefs: ["conflict:cached"],
        },
        ciStatus: {
          totalChecks: 0,
          failed: 0,
          failedChecks: [
            { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          ],
        },
        diffAvailability: {
          available: "too_large",
          error: "diff exceeded provider limit",
        },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "merge_conflicts",
          "blocked",
          "Merge conflicts detected in 3 file(s).",
          ["conflict:cached"],
        ],
        [
          "ci_failed",
          "blocked",
          "1 CI check(s) failed.",
          ["ci:api"],
        ],
        [
          "diff_unavailable",
          "blocked",
          "diff exceeded provider limit",
          ["gh:pr-diff"],
        ],
      ],
    );
  });

  test("falls back past empty canonical top-level records when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: {},
        ci_status: {},
        diff_availability: {},
        mergeConflicts: {
          hasConflicts: true,
          conflictCount: 1,
          conflictingFiles: ["packages/api/src/app.ts"],
          evidenceRefs: ["conflict:cached"],
        },
        ciStatus: {
          totalChecks: 0,
          failed: 0,
          failedChecks: [
            { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          ],
        },
        diffAvailability: {
          available: "too_large",
          error: "diff exceeded provider limit",
        },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "merge_conflicts",
          "blocked",
          "Merge conflicts detected in 1 file(s).",
          ["conflict:cached"],
        ],
        [
          "ci_failed",
          "blocked",
          "1 CI check(s) failed.",
          ["ci:api"],
        ],
        [
          "diff_unavailable",
          "blocked",
          "diff exceeded provider limit",
          ["gh:pr-diff"],
        ],
      ],
    );
  });

  test("falls back past unknown diff availability placeholders when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        diff_availability: {
          available: "surprise",
          source: "gh-pr-diff",
        },
        diffAvailability: {
          available: false,
          message: "Diff timed out.",
          evidenceRef: "diff:timeout",
        },
      },
    );

    assert.deepEqual(
      blockers.find((blocker) => blocker.kind === "diff_unavailable"),
      {
        kind: "diff_unavailable",
        status: "blocked",
        summary: "Diff timed out.",
        evidence_refs: ["diff:timeout"],
      },
    );
  });

  test("uses normalized PR detail aliases when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        draft: "true",
        review_decision: "review required",
        merge_state_status: "dirty",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["draft", "blocked", "GitHub reports this PR is still marked as draft."],
        ["review_required", "blocked", "GitHub requires review before this PR can merge."],
        ["merge_state_blocked", "blocked", "GitHub reports the PR merge state as DIRTY."],
      ],
    );
  });

  test("uses direct edge-shaped PR details when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        __typename: "PullRequestEdge",
        cursor: "pr-209",
        node: {
          isDraft: "true",
          reviewDecision: "changes_requested",
          mergeStateStatus: "has-hooks",
        },
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["draft", "blocked", "GitHub reports this PR is still marked as draft."],
        ["changes_requested", "blocked", "GitHub review decision has requested changes."],
        ["merge_state_blocked", "pending", "GitHub reports the PR merge state as HAS_HOOKS."],
      ],
    );
  });

  test("normalizes serialized PR detail booleans when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        isDraft: "yes",
        merge_state_status: "clean",
        isMergeable: "not-mergeable",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["draft", "blocked", "GitHub reports this PR is still marked as draft."],
        ["merge_state_blocked", "blocked", "GitHub reports this PR is not mergeable."],
      ],
    );
  });

  test("falls back past malformed PR detail boolean placeholders when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        isDraft: "surprise",
        is_draft: "yes",
        merge_state_status: "clean",
        mergeable: "surprise",
        is_mergeable: "not-mergeable",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["draft", "blocked", "GitHub reports this PR is still marked as draft."],
        ["merge_state_blocked", "blocked", "GitHub reports this PR is not mergeable."],
      ],
    );
  });

  test("falls back past blank canonical PR detail text when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        reviewDecision: "   ",
        review_decision: "changes requested",
        mergeStateStatus: "",
        merge_state_status: "has hooks",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["changes_requested", "blocked", "GitHub review decision has requested changes."],
        ["merge_state_blocked", "pending", "GitHub reports the PR merge state as HAS_HOOKS."],
      ],
    );
  });

  test("falls back past unknown canonical PR detail status placeholders when classifying blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        reviewDecision: "UNKNOWN",
        review_decision: "changes requested",
        mergeStateStatus: "calculating",
        merge_state_status: "dirty",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        ["changes_requested", "blocked", "GitHub review decision has requested changes."],
        ["merge_state_blocked", "blocked", "GitHub reports the PR merge state as DIRTY."],
      ],
    );
  });

  test("projects explicit manual merge gates from PR comments into blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-hold",
            created_at: "2026-07-01T10:00:00.000Z",
            body: "Do not merge: release approval is required",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-ready",
            created_at: "2026-07-01T10:05:00.000Z",
            body: "merge-god: ready",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-human",
            created_at: "2026-07-01T10:10:00.000Z",
            body: "Human gate: product approval is required",
          },
        ],
        review_comments: [
          {
            url: "https://example.test/pull/203#discussion_r_security",
            submitted_at: "2026-07-01T10:11:00.000Z",
            body: "merge-god: blocked - security approval is required",
          },
        ],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "external_gate",
          "blocked",
          "Manual merge gate is blocked: product approval is required.",
          ["https://example.test/pull/203#issuecomment-human"],
        ],
        [
          "external_gate",
          "blocked",
          "Manual merge gate is blocked: security approval is required.",
          ["https://example.test/pull/203#discussion_r_security"],
        ],
      ],
    );
  });

  test("projects real-world release decision holds into external gate blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-rc1-hold",
            body: "Remaining RC1 decision: HOLD, not approve. Blocking items are the Safari fresh `/chat` catastrophic panel and incomplete Safari ISOF route evidence.",
          },
        ],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "external_gate",
          "blocked",
          "Manual merge gate is blocked: Blocking items are the Safari fresh `/chat` catastrophic panel and incomplete Safari ISOF route evidence.",
          ["https://example.test/pull/183#issuecomment-rc1-hold"],
        ],
      ],
    );
  });

  test("clears release decision hold blockers with later explicit pass decisions", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-rc1-hold",
            created_at: "2026-07-01T22:00:00.000Z",
            body: [
              "Scenario 2 datacenter redirect: PASS.",
              "Remaining RC1 decision: HOLD, not approve. Blocking items are Safari coverage gaps.",
            ].join("\n"),
          },
          {
            html_url: "https://example.test/pull/183#issuecomment-rc1-pass",
            created_at: "2026-07-01T23:00:00.000Z",
            body: "Final RC1 decision: PASS. Ready for merge.",
          },
        ],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(blockers, []);
  });

  test("projects active hold labels into external gate blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        labels: {
          nodes: [
            { name: "for-landing" },
            { name: "do-not-merge" },
            { name: "needs-rebase" },
            { name: "ci failing" },
            { name: "needs approval" },
            { name: "merge:blocked" },
            { name: "needs review" },
          ],
        },
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "external_gate",
          "blocked",
          "Label 'do-not-merge' marks this PR as blocked for landing.",
          ["github:label:do-not-merge"],
        ],
        [
          "external_gate",
          "blocked",
          "Label 'needs-rebase' marks this PR as blocked for landing.",
          ["github:label:needs-rebase"],
        ],
        [
          "external_gate",
          "blocked",
          "Label 'ci failing' marks this PR as blocked for landing.",
          ["github:label:ci-failing"],
        ],
        [
          "external_gate",
          "blocked",
          "Label 'needs approval' marks this PR as blocked for landing.",
          ["github:label:needs-approval"],
        ],
        [
          "external_gate",
          "blocked",
          "Label 'needs review' marks this PR as blocked for landing.",
          ["github:label:needs-review"],
        ],
      ],
    );
  });

  test("does not use unbackticked validation lines as constituent titles", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #207 and #208" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/209#issuecomment-validation",
            body: [
              "- #207 npm run e2e -> skipped",
              "- #208 npm run canary => inconclusive",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [207, null, "unknown"],
        [208, null, "unknown"],
      ],
    );
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm run e2e",
        status: "unknown",
        scope: "#207",
        evidence_ref: "https://example.test/pull/209#issuecomment-validation",
      },
      {
        command: "npm run canary",
        status: "unknown",
        scope: "#208",
        evidence_ref: "https://example.test/pull/209#issuecomment-validation",
      },
    ]);
  });

  test("does not use markdown-linked validation lines as constituent titles", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, and #203" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- [#201](https://github.example.test/org/repo/pull/201) `npm test` -> failed",
              "- [PR #202](https://github.example.test/org/repo/pull/202) npm run smoke => passed",
              "- [PR 203](https://github.example.test/org/repo/pull/203) npm run canary => failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, null, "blocked"],
        [202, null, "validated"],
        [203, null, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "failed"],
      ["#202", "npm run smoke", "passed"],
      ["#203", "npm run canary", "failed"],
    ]);
  });

  test("uses markdown-linked table scopes as constituent validation", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #210 and #211" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/212#issuecomment-validation-table",
            body: [
              "| Scope | Command | Result |",
              "| --- | --- | --- |",
              "| [#210](https://github.example.test/org/repo/pull/210) | npm run linked -- api | failed |",
              "| [PR 211](https://github.example.test/org/repo/pull/211) | npm run linked -- ui | passed |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [210, null, "blocked"],
        [211, null, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#210", "npm run linked -- api", "failed"],
      ["#211", "npm run linked -- ui", "passed"],
    ]);
  });

  test("uses descriptive markdown PR links as validation scopes", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #226, #227, and #228" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/229#issuecomment-descriptive-links",
            body: [
              "- [API validation](https://github.example.test/org/repo/pull/226) npm run descriptive-link => failed",
              "- Scope: [Worker validation](https://api.github.example.test/repos/org/repo/pulls/227) | Command: npm run descriptive-field | Result: passed",
              "| Scope | Command | Result |",
              "| --- | --- | --- |",
              "| [MR validation](https://gitlab.example.test/org/repo/-/merge_requests/228) | npm run descriptive-table | blocked |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [226, "blocked"],
        [227, "validated"],
        [228, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#226", "npm run descriptive-link", "failed"],
      ["#227", "npm run descriptive-field", "passed"],
      ["#228", "npm run descriptive-table", "blocked"],
    ]);
  });

  test("uses constituent validation table synonyms as queue evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #212 and #213" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/214#issuecomment-validation-table",
            body: [
              "| Constituent | Validation | Conclusion |",
              "| --- | --- | --- |",
              "| #212 API cleanup | npm run smoke | failure |",
              "| [PR #213](https://github.example.test/org/repo/pull/213) API bridge | pnpm test --filter api | success |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [212, null, "blocked"],
        [213, null, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#212", "npm run smoke", "failed"],
      ["#213", "pnpm test --filter api", "passed"],
    ]);
  });

  test("uses pull request and merge request validation table headers as queue evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge MRs !301 and !302" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/303#issuecomment-forge-validation-table",
            body: [
              "| Merge Request | Command | Result |",
              "| --- | --- | --- |",
              "| MR !301 | npm run mr-api | failed |",
              "| !302 | pnpm test --filter mr-ui | success |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [301, "blocked"],
        [302, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#301", "npm run mr-api", "failed"],
      ["#302", "pnpm test --filter mr-ui", "passed"],
    ]);
  });

  test("uses narrative validation result tables as queue-wide and package blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-rc1-validation",
            body: [
              "| Flow | Evidence | Result |",
              "| --- | --- | --- |",
              "| Create LPAR workflow | Session reached approval gate. | PASS |",
              "| Safari fresh chat | Carbon shadow DOM contained `Something went wrong`. | HOLD/INCOMPLETE |",
              "",
              "| Package | Evidence | Result |",
              "| --- | --- | --- |",
              "| packages/chat | Focused Storybook timed out. | HOLD |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.scope, item.command, item.status]),
      [
        [null, "Create LPAR workflow", "passed"],
        [null, "Safari fresh chat", "blocked"],
        ["packages/chat", "Focused Storybook timed out.", "blocked"],
      ],
    );
    assert.deepEqual(
      context!.unresolved_blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [
        [
          "ci_failed",
          "blocked",
          "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        ],
        [
          "ci_failed",
          "blocked",
          "Queue validation scope packages/chat has 1 failed or blocked validation evidence item(s).",
        ],
      ],
    );
  });

  test("uses later narrative workflow evidence to supersede earlier prompt blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-old-rc1-validation",
            created_at: "2026-07-01T10:00:00Z",
            body: [
              "| Flow | Evidence | Result |",
              "| --- | --- | --- |",
              "| Create LPAR final gate | Initial prompt did not reach approval. | Blocker |",
              "| Edit-LPAR rename workflow | Rename proposal was not surfaced. | Blocker |",
              "| Edit LPAR proposed-property prompt | Continuation completed without model work. | Blocker |",
              "| Fresh live edit run | Provider returned no choices after table selection. | Blocker |",
            ].join("\n"),
          },
          {
            html_url: "https://example.test/pull/183#issuecomment-new-rc1-validation",
            created_at: "2026-07-01T11:00:00Z",
            body: [
              "| Flow | Evidence | Result |",
              "| --- | --- | --- |",
              "| Create LPAR workflow | Later run reached approval. | PASS |",
              "| Edit LPAR workflow | Later run reached approval. | PASS |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.command, item.status]),
      [
        ["Create LPAR final gate", "blocked"],
        ["Edit-LPAR rename workflow", "blocked"],
        ["Edit LPAR proposed-property prompt", "blocked"],
        ["Fresh live edit run", "blocked"],
        ["Create LPAR workflow", "passed"],
        ["Edit LPAR workflow", "passed"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("uses raw PR URL scopes as constituent validation", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #214, #215, and #216" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/216#issuecomment-url-scope",
            body: [
              "- https://github.example.test/org/repo/pull/214 `npm run url-smoke` -> failed",
              "- scope: https://github.example.test/org/repo/pull/215 npm run scoped-url => passed",
              "- <https://github.example.test/org/repo/pull/216> npm run autolink => failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [214, "blocked"],
        [215, "validated"],
        [216, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#214", "npm run url-smoke", "failed"],
      ["#215", "npm run scoped-url", "passed"],
      ["#216", "npm run autolink", "failed"],
    ]);
  });

  test("uses repo-qualified shorthand as constituent hints and validation scopes", () => {
    const context = inferMergeQueueContext(
      {
        title: "Manual queue",
        body: [
          "- example-org/example-repo#217 - Metro API lane",
          "- group/subgroup/repo!218 - GitLab UI lane",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/219#issuecomment-repo-qualified",
            body: [
              "- example-org/example-repo#217 npm run metro -> failed",
              "- group/subgroup/repo!218 npm run gitlab => passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [217, "Metro API lane", "blocked"],
        [218, "GitLab UI lane", "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#217", "npm run metro", "failed"],
      ["#218", "npm run gitlab", "passed"],
    ]);
    assert.deepEqual(
      context!.unresolved_blockers.map((blocker) => [blocker.kind, blocker.status, blocker.evidence_refs]),
      [["ci_failed", "blocked", ["https://example.test/pull/219#issuecomment-repo-qualified"]]],
    );
  });

  test("uses HTML code-tag validation commands as constituent validation", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-html-code",
            body: [
              "- #201 <code>npm test</code> -> failed",
              "- #202 <code>pnpm test --filter ui</code> => passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "blocked"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "failed"],
      ["#202", "pnpm test --filter ui", "passed"],
    ]);
  });

  test("does not use unbackticked checkbox validation as constituent titles", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, #203, #204, #205, and #206" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/204#issuecomment-checkbox",
            body: [
              "- [x] #201 npm test",
              "- [ ] PR #202 npm run smoke",
              "- [x] [#204](https://github.example.test/org/repo/pull/204) npm run linked",
              "- [ ] [PR 205](https://github.example.test/org/repo/pull/205) pnpm test",
              "- [x] #203 API update",
              "- [x] [#206](https://github.example.test/org/repo/pull/206) API update",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, null, "validated"],
        [202, null, "unknown"],
        [203, "API update", "queued"],
        [204, null, "validated"],
        [205, null, "unknown"],
        [206, "API update", "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "unknown"],
      ["#204", "npm run linked", "passed"],
      ["#205", "pnpm test", "unknown"],
    ]);
  });

  test("uses body constituent hints whose titles contain backticks", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue integration branch",
        body: [
          "- #201 `Renderer` cleanup",
          "- #202 API `bridge` support",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "`Renderer` cleanup", "queued"],
        [202, "API `bridge` support", "queued"],
      ],
    );
  });

  test("ignores non-authoritative copied text when extracting constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue integration branch",
        body: [
          "- #201 Visible constituent",
          "```",
          "- #202 Fenced stale constituent",
          "```",
          "> - #203 Quoted stale constituent",
          "<!-- - #204 Hidden stale constituent -->",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/205#issuecomment-copied-hints",
            body: [
              "<details>",
              "<summary>Old membership</summary>",
              "- #205 Details stale constituent",
              "</details>",
              "<pre>- #206 Pre stale constituent</pre>",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "Visible constituent", "queued"],
      ],
    );
  });

  test("uses latest validation evidence per scope and command for active queue status", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- #201 `npm run test -- api` -> pending",
              "- #202 `npm run test -- ui` -> passed",
              "- scope: packages/api `npm run lint -- api` -> failed",
              "- #201 `npm run test -- api` -> passed",
              "- #202 `npm run test -- ui` -> failed",
              "- scope: packages/api `npm run lint -- api` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "blocked"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #202 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
    ]);
    assert.equal(context!.validation_evidence.length, 6);
  });

  test("uses later comprehensive queue-wide passes to clear stale queue-wide validation blockers", () => {
    const context = inferMergeQueueContext(
      { title: "RC1 Merge queue: PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-old-suite",
            body: [
              "| Gate | Result | Notes |",
              "| --- | --- | --- |",
              "| `npm run test` | Fail | Unit and integration lanes failed. |",
              "| `npm run test:storybook` | Fail | Storybook interaction tests failed. |",
            ].join("\n"),
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-full-suite",
            body: "- Full RC1 deterministic suite passed from agent: run `1b4507932556e9a0`, 12/12 PASS.",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.unresolved_blockers, []);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.command, item.status]),
      [
        ["npm run test", "failed"],
        ["npm run test:storybook", "failed"],
        ["Full RC1 deterministic suite", "passed"],
      ],
    );
  });

  test("does not let unrelated validation scopes expand declared queue membership", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/202#issuecomment-validation",
            body: [
              "- #201 npm test -> failed",
              "- #999 npm test -> failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "blocked"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "failed"],
      ["#999", "npm test", "failed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/202#issuecomment-validation"],
      },
    ]);
  });

  test("uses scoped validation as membership when an explicit queue title has no list", () => {
    const context = inferMergeQueueContext(
      { title: "Manual queue" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation-only",
            body: [
              "- #201 npm run api -> passed",
              "- #202 npm run ui -> failed",
              "- scope: packages/api npm run lint -> failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "unknown");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "blocked"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #202 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation-only"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation-only"],
      },
    ]);
  });

  test("uses one scoped validation row as membership for an explicit queue title", () => {
    const context = inferMergeQueueContext(
      { title: "Manual queue" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-single-validation",
            body: "- #201 npm run api -> passed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.is_queue, true);
    assert.deepEqual(context!.constituent_prs, [
      {
        number: 201,
        title: null,
        url: null,
        head_sha: null,
        status: "validated",
        evidence_refs: ["https://example.test/pull/203#issuecomment-single-validation", "pr:#201"],
      },
    ]);
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm run api",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-single-validation",
      },
    ]);
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("treats validation scoped to the queue PR itself as queue-wide evidence", () => {
    const context = inferMergeQueueContext(
      { number: 203, title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-self-validation",
            body: [
              "- #203 npm run aggregate-smoke -> failed",
              "- PR #203 npm run explicit-self -> blocked",
              "- scope: [#203](https://example.test/pull/203) npm run linked-self -> failed",
              "- scope: https://example.test/pull/203 npm run url-self -> failed",
              "- #999 npm run unrelated -> failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "queued"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run aggregate-smoke", "failed"],
      [null, "npm run explicit-self", "blocked"],
      [null, "npm run linked-self", "failed"],
      [null, "npm run url-self", "failed"],
      ["#999", "npm run unrelated", "failed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 4 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-self-validation"],
      },
    ]);
  });

  test("uses cached PR detail number title and body aliases for queue inference", () => {
    const context = inferMergeQueueContext(
      {
        pr_number: "203",
        name: "Merge PRs #201 and #202",
        description: "- #201 API service head abcdef1234567890",
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-self-validation",
            body: [
              "- #203 npm run aggregate-smoke -> failed",
              "- #202 npm run ui -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.status]),
      [
        [201, "API service", "abcdef1234567890", "queued"],
        [202, null, null, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run aggregate-smoke", "failed"],
      ["#202", "npm run ui", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-self-validation"],
      },
    ]);
  });

  test("uses queue merge-forward prose to mark constituents merged into the queue", () => {
    const context = inferMergeQueueContext(
      {
        number: 300,
        title: "RC1 Merge queue: PRs 189, 194, 197",
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/300#issuecomment-215622762",
            body: "After reviewing PR #188, consolidation update after merging PRs 189 and 194 into this queue branch; follow-up PR #197 remains queued.",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status, pr.evidence_refs]),
      [
        [189, "merged_into_queue", ["https://example.test/pull/300#issuecomment-215622762", "pr:#189"]],
        [194, "merged_into_queue", ["https://example.test/pull/300#issuecomment-215622762", "pr:#194"]],
        [197, "queued", ["pr:#197"]],
      ],
    );
  });

  test("uses direct edge-shaped PR details for queue inference", () => {
    const context = inferMergeQueueContext(
      {
        __typename: "PullRequestEdge",
        cursor: "pr-203",
        node: {
          prNumber: "203",
          title: "Merge PRs #201 and #202",
          bodyText: "- #201 API service head abcdef1234567890",
          baseRefName: "main",
        },
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-edge-details",
            body: [
              "- #203 npm run aggregate-smoke -> failed",
              "- #202 npm run ui -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.status]),
      [
        [201, "API service", "abcdef1234567890", "queued"],
        [202, null, null, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run aggregate-smoke", "failed"],
      ["#202", "npm run ui", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-edge-details"],
      },
    ]);
  });

  test("uses latest validation evidence when command spacing changes", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- #201 `npm   run   test -- api` -> failed",
              "- #201 `npm run test -- api` -> passed",
              "- #202 `npm run test -- ui` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("uses comment timestamps across issue and review comments for latest evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-new",
            created_at: "2026-07-01T12:00:00Z",
            body: [
              "- #201 `npm run test -- api` -> passed",
              "- #202 `npm run test -- ui` -> passed",
            ].join("\n"),
          },
        ],
        review_comments: [
          {
            html_url: "https://example.test/pull/203#discussion-old",
            created_at: "2026-07-01T10:00:00Z",
            body: "- #201 `npm run test -- api` -> failed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]),
      [
        ["#201", "npm run test -- api", "failed", "https://example.test/pull/203#discussion-old"],
        ["#201", "npm run test -- api", "passed", "https://example.test/pull/203#issuecomment-new"],
        ["#202", "npm run test -- ui", "passed", "https://example.test/pull/203#issuecomment-new"],
      ],
    );
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("uses edited comment timestamps when choosing latest validation evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-edited",
            created_at: "2026-07-01T09:00:00Z",
            updated_at: "2026-07-01T13:00:00Z",
            body: "- #201 `npm run test -- api` -> passed",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-stale",
            created_at: "2026-07-01T12:00:00Z",
            updated_at: "2026-07-01T12:00:00Z",
            body: "- #201 `npm run test -- api` -> failed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]),
      [
        ["#201", "npm run test -- api", "failed", "https://example.test/pull/203#issuecomment-stale"],
        ["#201", "npm run test -- api", "passed", "https://example.test/pull/203#issuecomment-edited"],
      ],
    );
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("uses edited and published timestamp aliases when choosing latest validation evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-edited-alias",
            created_at: "2026-07-01T09:00:00Z",
            editedAt: "2026-07-01T13:00:00Z",
            body: "- #201 `npm run test -- api` -> passed",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-published-alias",
            publishedAt: "2026-07-01T12:00:00Z",
            body: "- #201 `npm run test -- api` -> failed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]),
      [
        ["#201", "npm run test -- api", "failed", "https://example.test/pull/203#issuecomment-published-alias"],
        ["#201", "npm run test -- api", "passed", "https://example.test/pull/203#issuecomment-edited-alias"],
      ],
    );
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("falls back past blank and malformed edited timestamps when ordering validation evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-new",
            created_at: "2026-07-01T13:00:00Z",
            updated_at: "   ",
            body: "- #201 `npm run test -- api` -> passed",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-stale",
            created_at: "2026-07-01T12:00:00Z",
            updated_at: "not a timestamp",
            body: "- #201 `npm run test -- api` -> failed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]),
      [
        ["#201", "npm run test -- api", "failed", "https://example.test/pull/203#issuecomment-stale"],
        ["#201", "npm run test -- api", "passed", "https://example.test/pull/203#issuecomment-new"],
      ],
    );
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not let untimestamped validation override timestamped evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-new",
            created_at: "2026-07-01T12:00:00Z",
            body: "- #201 `npm run test -- api` -> passed",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-untimestamped",
            body: "- #201 `npm run test -- api` -> failed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.validation_evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]),
      [
        ["#201", "npm run test -- api", "failed", "https://example.test/pull/203#issuecomment-untimestamped"],
        ["#201", "npm run test -- api", "passed", "https://example.test/pull/203#issuecomment-new"],
      ],
    );
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not promote fenced command logs into queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-fenced-log",
            body: [
              "- #201 `npm test` -> passed",
              "```text",
              "npm run queue-smoke: failed",
              "#202 npm run e2e -> failed",
              "```",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not promote indented Markdown command logs into queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-indented-log",
            body: [
              "- #201 `npm test` -> passed",
              "    #201 npm test -> failed",
              "    #202 npm run e2e -> failed",
              "    npm run queue-smoke: failed",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not let quoted stale validation override active evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-quoted-status",
            body: [
              "- #201 `npm test` -> passed",
              "> #201 `npm test` -> failed",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not let struck-through stale validation override active evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-struck-status",
            body: [
              "- #201 `npm test` -> passed",
              "- ~~#201 `npm test` -> failed~~",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not let struck-through table validation override active evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-struck-table",
            body: [
              "| Scope | Command | Result |",
              "| --- | --- | --- |",
              "| #201 | npm test | passed |",
              "| ~~#201~~ | ~~npm test~~ | ~~failed~~ |",
              "| ~~#202~~ | ~~npm test~~ | ~~failed~~ |",
              "| #202 | npm test | passed |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not let review gate cache comments define active validation", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-cache",
            body: [
              REVIEW_GATE_CACHE_MARKER,
              "## merge-god review gate status",
              "- #201 `npm test` -> failed",
              "- #202 `npm test` -> failed",
            ].join("\n"),
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-real-validation",
            body: [
              "- #201 `npm test` -> passed",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not let review gate cache comments define constituent hints", () => {
    const context = inferMergeQueueContext(
      { title: "Task queue cleanup" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-cache",
            body: [
              REVIEW_GATE_CACHE_MARKER,
              "## Merge queue evidence",
              "",
              "| Area | Count | Detail |",
              "| --- | ---: | --- |",
              "| Constituent PRs | 2 | #201, #202 |",
              "| Constituent status | 2 | #201 (blocked); #202 (validated) |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.equal(context, null);
  });

  test("does not let review gate cache comments enrich explicit queue constituents", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-cache",
            body: [
              REVIEW_GATE_CACHE_MARKER,
              "| PR | Title | Head |",
              "| --- | --- | --- |",
              "| #201 | stale title | deadbee |",
              "| #202 | stale title | cafed00 |",
            ].join("\n"),
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-markerless-cache",
            body: [
              "## merge-god review gate status",
              "| PR | Title | Head |",
              "| --- | --- | --- |",
              "| #201 | markerless stale title | badbad1 |",
              "| #202 | markerless stale title | badbad2 |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [201, null, null, ["pr:#201"]],
        [202, null, null, ["pr:#202"]],
      ],
    );
  });

  test("uses code-spanned validation scopes without misclassifying commands", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-coded-scope",
            body: [
              "- scope: `#201` `npm test` -> failed",
              "- scope=`#202`: `npm test` => passed",
              "- scope: `packages/api` `pnpm lint --filter api` -> blocked",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "failed"],
      ["#202", "npm test", "passed"],
      ["packages/api", "pnpm lint --filter api", "blocked"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "blocked"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-coded-scope"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-coded-scope"],
      },
    ]);
  });

  test("does not promote details-block command logs into queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-details-log",
            body: [
              "- #201 `npm test` -> passed",
              "<details>",
              "<summary>Old run output</summary>",
              "#201 npm test -> failed",
              "scope: packages/api pnpm lint --filter api -> failed",
              "</details>",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not promote preformatted HTML command logs into queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-pre-log",
            body: [
              "- #201 `npm test` -> passed",
              "<pre>",
              "#201 npm test -> failed",
              "scope: packages/api pnpm lint --filter api -> failed",
              "</pre>",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not promote inline HTML command logs into queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-inline-log",
            body: [
              "- #201 `npm test` -> passed",
              "<pre>#201 npm test -> failed</pre>",
              "<details><summary>Old run output</summary>#202 npm test -> failed</details>",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("does not promote HTML comment command logs into queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-hidden-log",
            body: [
              "- #201 `npm test` -> passed <!-- trailing note is hidden -->",
              "<!-- #201 npm test -> failed -->",
              "<!--",
              "#202 npm test -> failed",
              "-->",
              "- #202 `npm test` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm test", "passed"],
    ]);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "validated"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, []);
  });

  test("promotes canceled and timeout validation outcomes into non-passing queue state", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, and #203" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- #201 `npm run e2e` -> cancelled",
              "- #202 `npm run load-test` -> timed out",
              "- #203 npm run soak: timeout",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, null, "unknown"],
        [202, null, "blocked"],
        [203, null, "blocked"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue constituent PR #201 has 1 inconclusive validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #202 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #203 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
    ]);
  });

  test("does not use GitHub-style validation conclusion tokens as constituent titles", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, #203, #204, #205, and #206" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/204#issuecomment-validation-tokens",
            body: [
              "- #201 npm run soak: TIMED_OUT",
              "- #202 npm run manual-gate: ACTION_REQUIRED",
              "- #203 npm run queue: IN_PROGRESS",
              "- #204 npm run setup: STARTUP_FAILURE",
              "- #205 npm run provider-error: ERROR",
              "- #206 npm run provider-expired: EXPIRED",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, null, "blocked"],
        [202, null, "unknown"],
        [203, null, "unknown"],
        [204, null, "blocked"],
        [205, null, "blocked"],
        [206, null, "unknown"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm run soak", "failed"],
      ["#202", "npm run manual-gate", "unknown"],
      ["#203", "npm run queue", "unknown"],
      ["#204", "npm run setup", "failed"],
      ["#205", "npm run provider-error", "failed"],
      ["#206", "npm run provider-expired", "unknown"],
    ]);
  });

  test("does not use linked colon-result validation lines as constituent titles", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #205 and #206" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/206#issuecomment-linked-validation-tokens",
            body: [
              "- [#205](https://github.example.test/org/repo/pull/205) npm run linked: TIMED_OUT",
              "- https://github.example.test/org/repo/pull/206 npm run url-scope: ACTION_REQUIRED",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [205, null, "blocked"],
        [206, null, "unknown"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#205", "npm run linked", "failed"],
      ["#206", "npm run url-scope", "unknown"],
    ]);
  });

  test("uses status-first validation lines as constituent evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, #203, #204, #205, #206, #207, #208, #209, #210, #211, #212, #213, and #214" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/204#issuecomment-status-first",
            body: [
              "- failed: #201 npm test",
              "- passed - PR #202 pnpm test --filter api",
              "- ✅ [#203](https://github.example.test/org/repo/pull/203): yarn lint",
              "- action required: https://github.example.test/org/repo/pull/204 npm run manual",
              "- #205 ✅ npm run inline-pass",
              "- #206 pnpm lint (failed)",
              "- #207 npm run dash-fail — failed",
              "- Scope: #208; Command: npm run inline-field; Result: passed",
              "- passed for PR #209: npm run status-for-pr",
              "- failed for pull request #210 - pnpm test --filter status-for-pull",
              "- blocked for MR !211: npm run status-for-mr",
              "- ✅ for [#212](https://github.example.test/org/repo/pull/212): yarn status-for-link",
              "- passed on PR #213: npm run status-on-pr",
              "- failed for [API validation](https://github.example.test/org/repo/pull/214): npm run status-for-markdown",
              "- failed for PR #215 and PR #216: npm run status-for-shared",
              "- failed for packages/api: npm run status-for-path",
              "- passed for queue: npm run status-for-queue",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, null, "blocked"],
        [202, null, "validated"],
        [203, null, "validated"],
        [204, null, "unknown"],
        [205, null, "validated"],
        [206, null, "blocked"],
        [207, null, "blocked"],
        [208, null, "validated"],
        [209, null, "validated"],
        [210, null, "blocked"],
        [211, null, "blocked"],
        [212, null, "validated"],
        [213, null, "validated"],
        [214, null, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "failed"],
      ["#202", "pnpm test --filter api", "passed"],
      ["#203", "yarn lint", "passed"],
      ["#204", "npm run manual", "unknown"],
      ["#205", "npm run inline-pass", "passed"],
      ["#206", "pnpm lint", "failed"],
      ["#207", "npm run dash-fail", "failed"],
      ["#208", "npm run inline-field", "passed"],
      ["#209", "npm run status-for-pr", "passed"],
      ["#210", "pnpm test --filter status-for-pull", "failed"],
      ["#211", "npm run status-for-mr", "blocked"],
      ["#212", "yarn status-for-link", "passed"],
      ["#213", "npm run status-on-pr", "passed"],
      ["#214", "npm run status-for-markdown", "failed"],
      [null, "npm run status-for-shared", "failed"],
      ["packages/api", "npm run status-for-path", "failed"],
      [null, "npm run status-for-queue", "passed"],
    ]);
  });

  test("uses target-status validation lines as constituent evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #217, #218, #219, and #220" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/220#issuecomment-target-status",
            body: [
              "- PR #217 passed: npm run target-pr",
              "- pull request #218 failed - pnpm test --filter target-pull",
              "- MR !219 blocked: npm run target-mr",
              "- [API validation](https://github.example.test/org/repo/pull/220) failed: npm run target-markdown",
              "- PR #221 and PR #222 failed: npm run target-shared",
              "- packages/api failed: npm run target-path",
              "- queue passed: npm run target-queue",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [217, "validated"],
        [218, "blocked"],
        [219, "blocked"],
        [220, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#217", "npm run target-pr", "passed"],
      ["#218", "pnpm test --filter target-pull", "failed"],
      ["#219", "npm run target-mr", "blocked"],
      ["#220", "npm run target-markdown", "failed"],
      [null, "npm run target-shared", "failed"],
      ["packages/api", "npm run target-path", "failed"],
      [null, "npm run target-queue", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #218 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/220#issuecomment-target-status"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #219 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/220#issuecomment-target-status"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #220 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/220#issuecomment-target-status"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/220#issuecomment-target-status"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/220#issuecomment-target-status"],
      },
    ]);
  });

  test("uses pipe-separated inline field validation without label leakage", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #301 and #302" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/303#issuecomment-pipe-fields",
            body: [
              "- Pull Request: #301 | Command: npm run pipe-field | Result: failed",
              "- PR: #302 | Check: pnpm test --filter api | Status: passed",
              "- Scope: packages/api | Command: npm run lint | Result: failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [301, "blocked"],
        [302, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#301", "npm run pipe-field", "failed"],
      ["#302", "pnpm test --filter api", "passed"],
      ["packages/api", "npm run lint", "failed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #301 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/303#issuecomment-pipe-fields"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/303#issuecomment-pipe-fields"],
      },
    ]);
  });

  test("uses PR label-prefixed validation lines as constituent evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #206, #207, #208, #209, #210, #211, #212, and #213" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/208#issuecomment-pr-label-prefix",
            body: [
              "- PR: #206 npm run colon-scope => passed",
              "- Pull request #207: npm run pull-request-scope -> failed",
              "- pull request: #208 pnpm test --filter docs => passed",
              "- scope: pull request #209 npm run scope-pull-request => blocked",
              "- PR #210: [x] npm run scoped-task",
              "- Pull request #211 - [ ] pnpm test --filter pending-task",
              "- constituent #212 npm run constituent-smoke -> passed",
              "- source PR #213 npm run source-smoke -> failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [206, "validated"],
        [207, "blocked"],
        [208, "validated"],
        [209, "blocked"],
        [210, "validated"],
        [211, "unknown"],
        [212, "validated"],
        [213, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#206", "npm run colon-scope", "passed"],
      ["#207", "npm run pull-request-scope", "failed"],
      ["#208", "pnpm test --filter docs", "passed"],
      ["#209", "npm run scope-pull-request", "blocked"],
      ["#210", "npm run scoped-task", "passed"],
      ["#211", "pnpm test --filter pending-task", "unknown"],
      ["#212", "npm run constituent-smoke", "passed"],
      ["#213", "npm run source-smoke", "failed"],
    ]);
  });

  test("uses PR section-scoped validation as constituent evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, and #203" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-section-scope",
            body: [
              "### PR #201",
              "- npm test -> passed",
              "",
              "#### Validation for pull request #202",
              "- pnpm test --filter ui -> failed",
              "",
              "### Queue-wide",
              "- npm run queue-smoke -> passed",
              "- #203 npm run explicit -> passed",
              "",
              "### packages/api",
              "- npm run lint -- api -> failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "blocked"],
        [203, "validated"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "pnpm test --filter ui", "failed"],
      [null, "npm run queue-smoke", "passed"],
      ["#203", "npm run explicit", "passed"],
      ["packages/api", "npm run lint -- api", "failed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #202 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-section-scope"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-section-scope"],
      },
    ]);
  });

  test("does not attribute ambiguous multi-PR section validation to the first constituent", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-ambiguous-section-scope",
            body: [
              "### PR #201 and PR #202",
              "- npm run shared -> failed",
              "",
              "### PR #201",
              "- npm run exact -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run shared", "failed"],
      ["#201", "npm run exact", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-ambiguous-section-scope"],
      },
    ]);
  });

  test("does not attribute inline multi-PR validation to the first constituent", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-inline-multi-pr-scope",
            body: [
              "- PR #201 and PR #202 npm run shared -> failed",
              "- scope: #201 and #202 npm run scoped-shared -> blocked",
              "- [Pull request 201](https://github.example.test/org/repo/pull/201) and [Pull request 202](https://github.example.test/org/repo/pull/202) npm run linked-shared -> failed",
              "- [Merge request 201](https://gitlab.example.test/org/repo/-/merge_requests/201) + [Merge request 202](https://gitlab.example.test/org/repo/-/merge_requests/202) npm run mr-linked-shared -> blocked",
              "- #201 npm run exact -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run shared", "failed"],
      [null, "npm run scoped-shared", "blocked"],
      [null, "npm run linked-shared", "failed"],
      [null, "npm run mr-linked-shared", "blocked"],
      ["#201", "npm run exact", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 4 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-inline-multi-pr-scope"],
      },
    ]);
  });

  test("does not attribute mismatched markdown-linked validation scopes to the visible or linked constituent", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #230 and #231" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/232#issuecomment-mismatched-linked-scope",
            body: [
              "- [#230](https://github.example.test/org/repo/pull/231) npm run swapped => failed",
              "- #230 npm run exact -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [230, "validated"],
        [231, "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run swapped", "failed"],
      ["#230", "npm run exact", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/232#issuecomment-mismatched-linked-scope"],
      },
    ]);
  });

  test("does not attribute inline PR-range validation to the first constituent", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201-#203" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-inline-range-scope",
            body: [
              "- PRs #201-#203 npm run range -> failed",
              "- PRs 202-203 npm run bare-range -> blocked",
              "- #201 npm run exact -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
        [203, "queued"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run range", "failed"],
      [null, "npm run bare-range", "blocked"],
      ["#201", "npm run exact", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 2 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-inline-range-scope"],
      },
    ]);
  });

  test("keeps explicit constituent scope when validation command text mentions another PR", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201, #202, and #203" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-command-pr-ref",
            body: [
              "- #201 npm run release-notes -- --related #202 -> passed",
              "- #203 pnpm test -- --grep PR #204 => failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "queued"],
        [203, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm run release-notes -- --related #202", "passed"],
      ["#203", "pnpm test -- --grep PR #204", "failed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #203 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-command-pr-ref"],
      },
    ]);
  });

  test("treats explicit queue-wide scope aliases as queue-wide validation", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- scope: queue `npm run queue-smoke` -> failed",
              "- `npm run queue-smoke` -> passed",
              "- scope: all `npm run queue-e2e` -> timed out",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.command, item.status, item.scope]), [
      ["npm run queue-smoke", "failed", null],
      ["npm run queue-smoke", "passed", null],
      ["npm run queue-e2e", "failed", null],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
    ]);
  });

  test("uses package path scopes with scoped npm package names as queue blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-scoped-package",
            body: [
              "- scope: packages/@merge-god/api npm run test -- api -> failed",
              "- scope=packages/@merge-god/ui: pnpm test --filter @merge-god/ui => passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.validation_evidence.map((item) => [item.scope, item.command, item.status]), [
      ["packages/@merge-god/api", "npm run test -- api", "failed"],
      ["packages/@merge-god/ui", "pnpm test --filter @merge-god/ui", "passed"],
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/@merge-god/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-scoped-package"],
      },
    ]);
  });

  test("does not let status words in validation command names affect constituent status", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- #201 `npm run failure-report` -> passed",
              "- #202 `npm run success-repro` -> failed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "blocked"],
      ],
    );
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #202 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
    ]);
  });

  test("expands bounded PR number ranges in merge queue titles", () => {
    for (const title of [
      "Merge queue: PRs #201-#204",
      "Merge queue: PRs 201-204",
      "Merge PRs 201 through 204",
      "Merge pull requests #201 through #204",
      "Pull requests queue #201-#204",
      "Merge train PRs #201-#204",
      "Merge PR #201-204",
    ]) {
      const context = inferMergeQueueContext(
        { title },
        {
          commits: [],
          comments: [],
        },
      );

      assert.ok(context !== null, title);
      assert.deepEqual(
        context!.constituent_prs.map((pr) => [pr.number, pr.status]),
        [
          [201, "queued"],
          [202, "queued"],
          [203, "queued"],
          [204, "queued"],
        ],
        title,
      );
      assert.equal(context!.strategy, "title_pr_list", title);
    }
  });

  test("models long comma-separated queue title lists without truncating constituents", () => {
    const context = inferMergeQueueContext(
      {
        title: "RC1 Merge queue: PRs 178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198",
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [178, "queued"],
        [179, "queued"],
        [180, "queued"],
        [182, "queued"],
        [185, "queued"],
        [189, "queued"],
        [190, "queued"],
        [191, "queued"],
        [192, "queued"],
        [193, "queued"],
        [194, "queued"],
        [197, "queued"],
        [198, "queued"],
      ],
    );
  });

  test("does not add status-table counts or cross-repo evidence links to explicit queue title constituents", () => {
    const context = inferMergeQueueContext(
      {
        title: "RC1 Merge queue: PRs 178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198",
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://github.example.test/example-org/example-repo/pull/183#issuecomment-status",
            body: [
              "| Command | Status | Detail |",
              "| --- | --- | --- |",
              "| `npm run test` | Fail | `unit-node`, `unit-jsdom`, and storybook lanes failed. |",
              "",
              "| Area | Observed failures |",
              "| --- | --- |",
              "| `unit-jsdom` chat/settings/design-system tests | 5 files failed, 99 passed; 16 failed tests, 1146 passed, 8 skipped. |",
              "",
              "| Area | Commit | Evidence |",
              "| --- | --- | --- |",
              "| Agent completion budget | [`0fa6461`](https://github.example.test/example-org/example-agent/commit/0fa6461) in [agent PR #92](https://github.example.test/example-org/example-agent/pull/92) | Runtime budget change. |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => pr.number),
      [178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198],
    );
  });

  test("does not use merge commit table cells as constituent titles", () => {
    const context = inferMergeQueueContext(
      {
        title: "RC1 Merge queue: PRs 191, 192, 193",
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://github.example.test/org/repo/pull/183#issuecomment-merge-commits",
            body: [
              "Added PRs #191, #192, and #193 to the queue with explicit merge commits.",
              "",
              "| Merge commit | PR | Purpose | Notes |",
              "| --- | --- | --- | --- |",
              "| [`740e4fc9`](https://github.example.test/org/repo/commit/740e4fc91b7612ecdbbe75fd207d952f8ad4757f) | #191 | Connector/settings refresh. | Merged cleanly. |",
              "| [`ca4bee0e`](https://github.example.test/org/repo/commit/ca4bee0ef5c558e41877694cdc90e3f69848ba54) | #192 | Carbon card-step rendering. | Resolved fixture cleanup conflicts. |",
              "| [`bf3e7964`](https://github.example.test/org/repo/commit/bf3e7964a5dbcf9dbb573bd298be9c3b4487d988) | #193 | Target-selection launch wiring. | Preserved target-selection launch wiring. |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status, pr.evidence_refs]),
      [
        [191, "Connector/settings refresh.", "merged_into_queue", ["https://github.example.test/org/repo/pull/183#issuecomment-merge-commits", "pr:#191"]],
        [192, "Carbon card-step rendering.", "merged_into_queue", ["https://github.example.test/org/repo/pull/183#issuecomment-merge-commits", "pr:#192"]],
        [193, "Target-selection launch wiring.", "merged_into_queue", ["https://github.example.test/org/repo/pull/183#issuecomment-merge-commits", "pr:#193"]],
      ],
    );
    assert.deepEqual(
      context!.merge_commits.map((commit) => [commit.sha, commit.pr_number, commit.subject]),
      [
        ["740e4fc91b7612ecdbbe75fd207d952f8ad4757f", 191, "Merge PR #191"],
        ["ca4bee0ef5c558e41877694cdc90e3f69848ba54", 192, "Merge PR #192"],
        ["bf3e7964a5dbcf9dbb573bd298be9c3b4487d988", 193, "Merge PR #193"],
      ],
    );
  });

  test("expands bounded MR number ranges in merge queue titles", () => {
    for (const title of [
      "Merge MRs !201-!204",
      "Merge requests !201 through !204",
      "MRs queue !201 to !204",
      "Merge train MRs !201 to !204",
      "MR train !201-!204",
    ]) {
      const context = inferMergeQueueContext(
        { title },
        {
          commits: [],
          comments: [],
        },
      );

      assert.ok(context !== null, title);
      assert.deepEqual(
        context!.constituent_prs.map((pr) => [pr.number, pr.status]),
        [
          [201, "queued"],
          [202, "queued"],
          [203, "queued"],
          [204, "queued"],
        ],
        title,
      );
      assert.equal(context!.strategy, "title_pr_list", title);
    }
  });

  test("does not expand overly broad PR number ranges in merge queue titles", () => {
    for (const title of [
      "Merge queue: PRs #201-#999",
      "Merge queue: PRs 201-999",
      "Merge PRs 201 through 999",
    ]) {
      const context = inferMergeQueueContext(
        { title },
        {
          commits: [],
          comments: [],
        },
      );

      assert.ok(context !== null, title);
      assert.deepEqual(
        context!.constituent_prs.map((pr) => pr.number),
        [201, 999],
        title,
      );
    }
  });

  test("does not expand plain numeric ranges in queue titles as PR ranges", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue 2024-2026 refresh for PRs #201 and #202" },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => pr.number),
      [201, 202],
    );
  });

  test("does not infer queues from incidental queue vocabulary", () => {
    assert.equal(
      inferMergeQueueContext(
        { title: "Fix stack overflow in request parser" },
        { commits: [], comments: [] },
      ),
      null,
    );

    assert.equal(
      inferMergeQueueContext(
        {
          title: "Queue worker cleanup",
          body: "- #201: Related worker cleanup",
        },
        { commits: [], comments: [] },
      ),
      null,
    );

    assert.equal(
      inferMergeQueueContext(
        { title: "Batch job retry fix #202" },
        { commits: [], comments: [] },
      ),
      null,
    );
  });

  test("does not treat GitHub closing references as constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Manual queue",
        body: [
          "Closes [#999](https://github.example.test/org/repo/pull/999)",
          "Fixes https://github.example.test/org/repo/pull/998",
          "Resolves <https://github.example.test/org/repo/pull/997>",
          "This PR closes [#996](https://github.example.test/org/repo/pull/996).",
          "Follow-up work references https://github.example.test/org/repo/pull/995.",
          "- #201: API update",
          "- #202: UI update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [202, "UI update", "queued"],
      ],
    );
  });

  test("does not infer a merge queue from a singular merge PR title", () => {
    assert.equal(
      inferMergeQueueContext(
        { title: "Merge PR #201" },
        { commits: [], comments: [] },
      ),
      null,
    );

    const context = inferMergeQueueContext(
      { title: "Merge PR #201 and #202" },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => pr.number),
      [201, 202],
    );
  });

  test("keeps manual stack titles when multiple constituent hints are present", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "Stack constituents:",
          "- #201: API update",
          "- #202: UI update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [202, "UI update", "queued"],
      ],
    );
  });

  test("uses long-form pull request and merge request constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Manual queue",
        body: [
          "- Pull Request #201: API update head: abcdef1",
          "- Merge Request: !202 - UI update sha=abcdef2",
          "| PR | Title | Head |",
          "| --- | --- | --- |",
          "| Pull Request: #203 | Worker update | abcdef3 |",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.status]),
      [
        [201, "API update", "abcdef1", "queued"],
        [202, "UI update", "abcdef2", "queued"],
        [203, "Worker update", "abcdef3", "queued"],
      ],
    );
  });

  test("extracts constituent head SHA hints without leaking them into titles", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "Stack constituents:",
          "- #201: API update head: abcdef1234567890",
          "- #202: UI update sha=1234567890abcdef",
          "- #203: Worker update (head `fedcba9876543210`)",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.status]),
      [
        [201, "API update", "abcdef1234567890", "queued"],
        [202, "UI update", "1234567890abcdef", "queued"],
        [203, "Worker update", "fedcba9876543210", "queued"],
      ],
    );
  });

  test("uses Markdown table rows as manual constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "| PR | Title | Head |",
          "| --- | --- | --- |",
          "| #201 | API update | abcdef1234567890 |",
          "| [#202](https://example.test/pull/202) | UI \\| worker | head `1234567890abcdef` |",
          "| <https://example.test/pull/203> | Worker update | fedcba9876543210 |",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.url, pr.head_sha, pr.status, pr.evidence_refs]),
      [
        [201, "API update", null, "abcdef1234567890", "queued", ["github:pr-body", "pr:#201"]],
        [202, "UI | worker", "https://example.test/pull/202", "1234567890abcdef", "queued", ["github:pr-body", "pr:#202"]],
        [203, "Worker update", "https://example.test/pull/203", "fedcba9876543210", "queued", ["github:pr-body", "pr:#203"]],
      ],
    );
  });

  test("uses comment Markdown table rows as manual constituent hints", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-constituents",
            body: [
              "| PR | Title | Head |",
              "| --- | --- | --- |",
              "| #201 | API update | abcdef1234567890 |",
              "| [#202](https://example.test/pull/202) | UI worker | 1234567890abcdef |",
              "| https://example.test/pull/203 | Worker update | fedcba9876543210 |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.url, pr.head_sha, pr.status, pr.evidence_refs]),
      [
        [
          201,
          "API update",
          null,
          "abcdef1234567890",
          "queued",
          ["https://example.test/pull/203#issuecomment-constituents", "pr:#201"],
        ],
        [
          202,
          "UI worker",
          "https://example.test/pull/202",
          "1234567890abcdef",
          "queued",
          ["https://example.test/pull/203#issuecomment-constituents", "pr:#202"],
        ],
        [
          203,
          "Worker update",
          "https://example.test/pull/203",
          "fedcba9876543210",
          "queued",
          ["https://example.test/pull/203#issuecomment-constituents", "pr:#203"],
        ],
      ],
    );
  });

  test("uses comment url as constituent evidence ref when html_url is blank", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [],
        comments: [
          {
            html_url: "   ",
            url: " https://api.example.test/repos/org/repo/issues/comments/42 ",
            body: "- #201 API update head abcdef1234567890",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [
          201,
          "API update",
          "abcdef1234567890",
          ["https://api.example.test/repos/org/repo/issues/comments/42", "pr:#201"],
        ],
      ],
    );
  });

  test("uses stable fallback evidence ref when constituent hint comments lack URL aliases", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [],
        comments: [
          {
            body: "- #201 API update head abcdef1234567890",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [
          201,
          "API update",
          "abcdef1234567890",
          ["github:pr-comment", "pr:#201"],
        ],
      ],
    );
  });

  test("uses descriptive markdown link labels as constituent titles", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "- [API bridge](https://example.test/pull/201)",
          "| PR | Title | Head |",
          "| --- | --- | --- |",
          "| [Worker label](https://gitlab.example.test/org/repo/-/merge_requests/202) | Worker explicit title | abcdef1234567890 |",
          "| [Only table label](https://example.test/pull/203) | | 1234567890abcdef |",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/204#issuecomment-link-label",
            body: "- [Comment label](https://example.test/pull/204)",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.url, pr.head_sha, pr.evidence_refs]),
      [
        [201, "API bridge", "https://example.test/pull/201", null, ["github:pr-body", "pr:#201"]],
        [
          202,
          "Worker explicit title",
          "https://gitlab.example.test/org/repo/-/merge_requests/202",
          "abcdef1234567890",
          ["github:pr-body", "pr:#202"],
        ],
        [203, "Only table label", "https://example.test/pull/203", "1234567890abcdef", ["github:pr-body", "pr:#203"]],
        [
          204,
          "Comment label",
          "https://example.test/pull/204",
          null,
          ["https://example.test/pull/204#issuecomment-link-label", "pr:#204"],
        ],
      ],
    );
  });

  test("uses cached issue comment collection aliases as constituent hint sources", () => {
    const context = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        issueComments: [
          {
            url: "https://api.example.test/repos/org/repo/issues/comments/43",
            body: [
              "- #201 API update head abcdef1234567890",
              "- #202 UI update head 1234567890abcdef",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [
          201,
          "API update",
          "abcdef1234567890",
          ["https://api.example.test/repos/org/repo/issues/comments/43", "pr:#201"],
        ],
        [
          202,
          "UI update",
          "1234567890abcdef",
          ["https://api.example.test/repos/org/repo/issues/comments/43", "pr:#202"],
        ],
      ],
    );
  });

  test("uses cached issue comment ref aliases as constituent hint evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [],
        comments: [
          { body: "", html_url: " " },
        ],
        issueComments: [
          {
            commentRef: "comment:queue-hints",
            body: "- #201 API update head abcdef1234567890",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [
          201,
          "API update",
          "abcdef1234567890",
          ["comment:queue-hints", "pr:#201"],
        ],
      ],
    );
  });

  test("uses review-comment Markdown table rows as manual constituent hints", () => {
    const reviewCommentUrl = "https://example.test/pull/203#discussion_r_constituents";
    const context = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        comments: [],
        review_comments: [
          {
            html_url: reviewCommentUrl,
            body: [
              "| PR | Title | Head |",
              "| --- | --- | --- |",
              "| [#201](https://example.test/pull/201) | API review lane | abcdef12 |",
              "| #202 | UI review lane | head: fedcba98 |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.url, pr.head_sha, pr.status, pr.evidence_refs]),
      [
        [201, "API review lane", "https://example.test/pull/201", "abcdef12", "queued", [reviewCommentUrl, "pr:#201"]],
        [202, "UI review lane", null, "fedcba98", "queued", [reviewCommentUrl, "pr:#202"]],
      ],
    );
  });

  test("uses cached review comment collection aliases as validation evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [],
        comments: [],
        reviewComments: [
          {
            url: "https://example.test/pull/203#discussion_r_validation",
            body: "- #201 `npm test` -> failed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status, pr.evidence_refs]),
      [
        [201, "blocked", ["https://example.test/pull/203#discussion_r_validation", "pr:#201"]],
        [202, "queued", ["pr:#202"]],
      ],
    );
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm test",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#discussion_r_validation",
      },
    ]);
    assert.deepEqual(
      context!.unresolved_blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "ci_failed",
          "blocked",
          "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
          ["https://example.test/pull/203#discussion_r_validation"],
        ],
      ],
    );
  });

  test("uses cached comment connection objects for constituent and validation evidence", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/44";
    const reviewCommentUrl = "https://example.test/pull/203#discussion_r_connection_validation";
    const context = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        issueComments: {
          nodes: [
            {
              url: issueCommentUrl,
              body: [
                "- #201 API node head abcdef1234567890",
                "- #202 UI node head 1234567890abcdef",
              ].join("\n"),
            },
          ],
        },
        reviewComments: {
          edges: [
            {
              node: {
                url: reviewCommentUrl,
                body: "- #201 `npm test` -> failed",
              },
            },
            { node: null },
          ],
        },
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.status, pr.evidence_refs]),
      [
        [201, "API node", "abcdef1234567890", "blocked", [issueCommentUrl, reviewCommentUrl, "pr:#201"]],
        [202, "UI node", "1234567890abcdef", "queued", [issueCommentUrl, "pr:#202"]],
      ],
    );
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm test",
        status: "failed",
        scope: "#201",
        evidence_ref: reviewCommentUrl,
      },
    ]);
    assert.deepEqual(
      context!.unresolved_blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary, blocker.evidence_refs]),
      [
        [
          "ci_failed",
          "blocked",
          "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
          [reviewCommentUrl],
        ],
      ],
    );
  });

  test("falls back past empty canonical comment connections to useful aliases", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/45";
    const context = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        comments: {
          nodes: [
            null,
            {},
          ],
        },
        issueComments: {
          nodes: [
            {
              url: issueCommentUrl,
              body: [
                "- #201 API alias head abcdef1234567890",
                "- #202 UI alias head 1234567890abcdef",
              ].join("\n"),
            },
          ],
        },
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [201, "API alias", "abcdef1234567890", [issueCommentUrl, "pr:#201"]],
        [202, "UI alias", "1234567890abcdef", [issueCommentUrl, "pr:#202"]],
      ],
    );
  });

  test("falls back past placeholder canonical comment arrays to useful aliases", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/46";
    const context = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        comments: [
          null,
          {},
        ],
        issueComments: [
          {
            url: issueCommentUrl,
            body: [
              "- #201 API direct head abcdef1234567890",
              "- #202 UI direct head 1234567890abcdef",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [201, "API direct", "abcdef1234567890", [issueCommentUrl, "pr:#201"]],
        [202, "UI direct", "1234567890abcdef", [issueCommentUrl, "pr:#202"]],
      ],
    );
  });

  test("falls back past blank canonical comment rows to useful aliases", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/47";
    const context = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        comments: [
          {
            body: " ",
            url: " ",
          },
        ],
        issueComments: [
          {
            url: issueCommentUrl,
            body: [
              "- #201 API blank-row head abcdef1234567890",
              "- #202 UI blank-row head 1234567890abcdef",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.evidence_refs]),
      [
        [201, "API blank-row", "abcdef1234567890", [issueCommentUrl, "pr:#201"]],
        [202, "UI blank-row", "1234567890abcdef", [issueCommentUrl, "pr:#202"]],
      ],
    );
  });

  test("uses ordered Markdown list constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "Stack constituents:",
          "1. #201: API update",
          "2. #202: UI update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [202, "UI update", "queued"],
      ],
    );
  });

  test("uses plus-bullet Markdown constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "Stack constituents:",
          "+ #201: API update",
          "+ #202: UI update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [202, "UI update", "queued"],
      ],
    );
  });

  test("preserves four-space nested constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "Stack constituents:",
          "    - #201: API update",
          "    - #202: UI update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [202, "UI update", "queued"],
      ],
    );
  });

  test("preserves visible constituent hints around inline hidden HTML blocks", () => {
    const context = inferMergeQueueContext(
      {
        title: "Manual queue",
        body: [
          "- #201: API update <details><summary>old</summary>- #202: stale hidden</details>",
          "<pre>- #203: stale pre</pre> - #204: Web update",
          "- #205: Worker update <details>",
          "- #206: stale multiline",
          "</details> - #207: Docs update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [204, "Web update", "queued"],
        [205, "Worker update", "queued"],
        [207, "Docs update", "queued"],
      ],
    );
  });

  test("ignores HTML-struck stale constituent hints", () => {
    const context = inferMergeQueueContext(
      {
        title: "Manual queue",
        body: [
          "- #201: API update",
          "- <del>#202: stale deleted</del>",
          "- <s>#203: stale short tag</s>",
          "- <strike>#204: stale strike tag</strike>",
          "1. ~~#206: stale ordered markdown strike~~",
          "2. <del>#207: stale ordered HTML deleted</del>",
          "- #205: Web update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.status]),
      [
        [201, "API update", "queued"],
        [205, "Web update", "queued"],
      ],
    );
  });

  test("recognizes squash-style queue commit subjects when the title has queue context", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [
          {
            sha: "abc2010",
            commit: { message: "Add API bridge support (#201)" },
          },
          {
            sha: "abc2020",
            commit: { message: "Refresh UI shell (!202)" },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "merge_commits");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
      ],
    );
    assert.deepEqual(
      context!.merge_commits.map((commit) => [commit.sha, commit.pr_number, commit.subject]),
      [
        ["abc2010", 201, "Add API bridge support (#201)"],
        ["abc2020", 202, "Refresh UI shell (!202)"],
      ],
    );
  });

  test("recognizes normalized commit message shapes as queue merge commits", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201, #202, and #203" },
      {
        commits: [
          {
            oid: "oid2010",
            messageHeadline: "Merge PR #201",
            messageBody: [
              "# Conflicts:",
              "#\tpackages/api/src/top.ts",
            ].join("\n"),
          },
          {
            sha: "sha2020",
            message: [
              "Merge PR #202",
              "",
              "# Conflicts:",
              "#\tpackages/ui/src/view.ts",
            ].join("\n"),
          },
          {
            sha: "sha2030",
            commit: {
              messageHeadline: "Merge pull request #203",
              messageBody: [
                "# Conflicts:",
                "#\tpackages/workers/src/job.ts",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
        [203, "merged_into_queue"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "oid2010",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: ["packages/api/src/top.ts"],
        evidence_refs: ["commit:oid2010"],
      },
      {
        sha: "sha2020",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: ["packages/ui/src/view.ts"],
        evidence_refs: ["commit:sha2020"],
      },
      {
        sha: "sha2030",
        pr_number: 203,
        subject: "Merge pull request #203",
        conflict_files: ["packages/workers/src/job.ts"],
        evidence_refs: ["commit:sha2030"],
      },
    ]);
  });

  test("recognizes PR merge commit subjects without hash markers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs 201 and 202" },
      {
        commits: [
          {
            sha: "plain201",
            message: "Merge PR 201 from org/api",
          },
          {
            sha: "plain202",
            commit: {
              messageHeadline: "Merge pull request 202 from org/ui",
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "plain201",
        pr_number: 201,
        subject: "Merge PR 201 from org/api",
        conflict_files: [],
        evidence_refs: ["commit:plain201"],
      },
      {
        sha: "plain202",
        pr_number: 202,
        subject: "Merge pull request 202 from org/ui",
        conflict_files: [],
        evidence_refs: ["commit:plain202"],
      },
    ]);
  });

  test("recognizes GitLab merge request commit lineage", () => {
    const context = inferMergeQueueContext(
      { title: "GitLab queue integration" },
      {
        commits: [
          {
            id: "gitlab201",
            message: "Merge MR !201",
          },
          {
            id: "gitlab202",
            message: "Merge request !202 from group/project",
          },
          {
            id: "gitlab203",
            message: [
              "Merge branch 'feature/ui' into 'queue/main'",
              "",
              "UI work",
              "",
              "See merge request org/repo!203",
            ].join("\n"),
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "merge_commits");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
        [203, "merged_into_queue"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "gitlab201",
        pr_number: 201,
        subject: "Merge MR !201",
        conflict_files: [],
        evidence_refs: ["commit:gitlab201"],
      },
      {
        sha: "gitlab202",
        pr_number: 202,
        subject: "Merge request !202 from group/project",
        conflict_files: [],
        evidence_refs: ["commit:gitlab202"],
      },
      {
        sha: "gitlab203",
        pr_number: 203,
        subject: "Merge branch 'feature/ui' into 'queue/main'",
        conflict_files: [],
        evidence_refs: ["commit:gitlab203"],
      },
    ]);
  });

  test("recognizes merged PR and MR commit lineage", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [
          {
            sha: "ado201",
            message: "Merged PR 201: API update",
          },
          {
            sha: "ado202",
            message: "Merged pull request 202: UI update",
          },
          {
            sha: "ado203",
            message: "Merged MR !203: GitLab update",
          },
          {
            sha: "ado204",
            message: "Merged merge request !204: GitLab update",
          },
          {
            sha: "ordinary205",
            message: "Merged feature branch for release 205",
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "merge_commits");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
        [203, "merged_into_queue"],
        [204, "merged_into_queue"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "ado201",
        pr_number: 201,
        subject: "Merged PR 201: API update",
        conflict_files: [],
        evidence_refs: ["commit:ado201"],
      },
      {
        sha: "ado202",
        pr_number: 202,
        subject: "Merged pull request 202: UI update",
        conflict_files: [],
        evidence_refs: ["commit:ado202"],
      },
      {
        sha: "ado203",
        pr_number: 203,
        subject: "Merged MR !203: GitLab update",
        conflict_files: [],
        evidence_refs: ["commit:ado203"],
      },
      {
        sha: "ado204",
        pr_number: 204,
        subject: "Merged merge request !204: GitLab update",
        conflict_files: [],
        evidence_refs: ["commit:ado204"],
      },
    ]);
  });

  test("falls back past blank commit message fields to normalized headline/body shapes", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            sha: "sha2010",
            message: "   ",
            messageHeadline: "Merge PR #201",
            messageBody: [
              "# Conflicts:",
              "#\tpackages/api/src/fallback.ts",
            ].join("\n"),
          },
          {
            sha: "sha2020",
            commit: {
              message: "   ",
              messageHeadline: "Merge PR #202",
              messageBody: [
                "# Conflicts:",
                "#\tpackages/ui/src/fallback.ts",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "sha2010",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: ["packages/api/src/fallback.ts"],
        evidence_refs: ["commit:sha2010"],
      },
      {
        sha: "sha2020",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: ["packages/ui/src/fallback.ts"],
        evidence_refs: ["commit:sha2020"],
      },
    ]);
  });

  test("uses commit id fields as queue merge commit evidence refs", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            id: "gitlab201",
            message: "Merge PR #201",
          },
          {
            commit: {
              id: "nested202",
              message: "Merge PR #202",
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "gitlab201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:gitlab201"],
      },
      {
        sha: "nested202",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: [],
        evidence_refs: ["commit:nested202"],
      },
    ]);
  });

  test("uses explicit commit evidence refs as queue merge commit identifiers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            message: "Merge PR #201",
            evidenceRefs: ["commit:evidence201"],
          },
          {
            commit: {
              message: "Merge PR #202",
              evidence_refs: ["commit:nested202"],
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "evidence201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:evidence201"],
      },
      {
        sha: "nested202",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: [],
        evidence_refs: ["commit:nested202"],
      },
    ]);
  });

  test("uses evidence-ref-only cached PR context commits for queue lineage", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            evidenceRefs: ["commit:evidence201", "pr:#201"],
          },
          {
            commit: {
              evidence_refs: ["commit:nested202", "merge-request:!202"],
            },
          },
        ],
        commitNodes: [
          {
            sha: "alias203",
            message: "Merge PR #203",
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "evidence201",
        pr_number: 201,
        subject: "",
        conflict_files: [],
        evidence_refs: ["commit:evidence201", "pr:#201"],
      },
      {
        sha: "nested202",
        pr_number: 202,
        subject: "",
        conflict_files: [],
        evidence_refs: ["commit:nested202", "merge-request:!202"],
      },
    ]);
  });

  test("trims merge commit sha fields and falls back past blank identifiers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            sha: "   ",
            oid: " oid201 ",
            message: "Merge PR #201",
          },
          {
            sha: "   ",
            commit: {
              id: " nested202 ",
              message: "Merge PR #202",
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "oid201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:oid201"],
      },
      {
        sha: "nested202",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: [],
        evidence_refs: ["commit:nested202"],
      },
    ]);
  });

  test("uses PR detail commits as merge queue fallback when context commits are unavailable", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
        commits: {
          nodes: [
            {
              commit: {
                oid: "detail201",
                messageHeadline: "Merge pull request #201",
                messageBody: [
                  "Conflicts:",
                  "\tpackages/api/src/detail.ts",
                ].join("\n"),
              },
            },
            {
              oid: "detail202",
              message: [
                "Merge PR #202",
                "",
                "# Conflicts:",
                "#\tpackages/ui/src/detail.ts",
              ].join("\n"),
            },
          ],
        },
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "detail201",
        pr_number: 201,
        subject: "Merge pull request #201",
        conflict_files: ["packages/api/src/detail.ts"],
        evidence_refs: ["commit:detail201"],
      },
      {
        sha: "detail202",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: ["packages/ui/src/detail.ts"],
        evidence_refs: ["commit:detail202"],
      },
    ]);
  });

  test("uses evidence-ref-only PR detail commits as merge queue fallback", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
        commits: [
          {
            evidenceRefs: ["commit:detail201", "pr:#201"],
          },
          {
            commit: {
              evidence_refs: ["commit:detail202", "merge-request:!202"],
            },
          },
        ],
        commitNodes: [
          {
            sha: "alias203",
            message: "Merge PR #203",
          },
        ],
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "detail201",
        pr_number: 201,
        subject: "",
        conflict_files: [],
        evidence_refs: ["commit:detail201", "pr:#201"],
      },
      {
        sha: "detail202",
        pr_number: 202,
        subject: "",
        conflict_files: [],
        evidence_refs: ["commit:detail202", "merge-request:!202"],
      },
    ]);
  });

  test("uses GraphQL edge commits and normalized message aliases for queue inference", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201, #202, and #203",
        commits: {
          nodes: [
            {
              oid: "detail999",
              message: "Merge PR #999",
            },
          ],
        },
      },
      {
        commits: {
          edges: [
            {
              node: {
                sha: "snake201",
                message_headline: "Merge PR #201",
                message_body: [
                  "# Conflicts:",
                  "#\tpackages/api/src/snake.ts",
                ].join("\n"),
              },
            },
            {
              node: {
                sha: "commit202",
                commit_message: [
                  "Merge PR #202",
                  "",
                  "Conflicts:",
                  "\tpackages/ui/src/commit-message.ts",
                ].join("\n"),
              },
            },
            {
              node: {
                sha: "subject203",
                commit: {
                  subject: "Merge pull request #203",
                  body: [
                    "Conflicts:",
                    "\tpackages/workers/src/subject.ts",
                  ].join("\n"),
                },
              },
            },
          ],
        },
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "merged_into_queue"],
        [203, "merged_into_queue"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "snake201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: ["packages/api/src/snake.ts"],
        evidence_refs: ["commit:snake201"],
      },
      {
        sha: "commit202",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: ["packages/ui/src/commit-message.ts"],
        evidence_refs: ["commit:commit202"],
      },
      {
        sha: "subject203",
        pr_number: 203,
        subject: "Merge pull request #203",
        conflict_files: ["packages/workers/src/subject.ts"],
        evidence_refs: ["commit:subject203"],
      },
    ]);
  });

  test("preserves base-branch merge commits as queue-head conflict evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            sha: "base1234",
            commit: {
              message: [
                "Merge origin/main into PR 203 merge queue",
                "",
                "# Conflicts:",
                "#\tpackages/api/src/server.ts",
                "#\tapps/web/src/App.tsx",
                "",
                "# Please enter a commit message to explain why this merge is necessary.",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "queued"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "base1234",
        pr_number: null,
        subject: "Merge origin/main into PR 203 merge queue",
        conflict_files: ["packages/api/src/server.ts", "apps/web/src/App.tsx"],
        evidence_refs: ["commit:base1234"],
      },
    ]);
  });

  test("preserves common base-branch merge subjects as queue-head conflict evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202", baseRefName: "release/2026.07" },
      {
        commits: [
          {
            sha: "branchmain",
            commit: {
              message: [
                "Merge branch 'main' into PR 203 merge queue",
                "",
                "Conflicts:",
                "\tpackages/api/src/main.ts",
              ].join("\n"),
            },
          },
          {
            sha: "remote2026",
            commit: {
              message: [
                "Merge remote-tracking branch 'origin/release/2026.07' into queue/release",
                "",
                "# Conflicts:",
                "#\tpackages/ui/src/release.ts",
              ].join("\n"),
            },
          },
          {
            sha: "qualified2026",
            commit: {
              message: [
                "Merge branch 'release/2026.07' of github.example.test:example-org/example-repo into queue/release",
                "",
                "Conflicts:",
                "\tpackages/web/src/qualified.ts",
              ].join("\n"),
            },
          },
          {
            sha: "feature123",
            commit: {
              message: [
                "Merge branch 'feature/stale' into queue/release",
                "",
                "# Conflicts:",
                "#\tpackages/api/src/stale.ts",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "branchmain",
        pr_number: null,
        subject: "Merge branch 'main' into PR 203 merge queue",
        conflict_files: ["packages/api/src/main.ts"],
        evidence_refs: ["commit:branchmain"],
      },
      {
        sha: "remote2026",
        pr_number: null,
        subject: "Merge remote-tracking branch 'origin/release/2026.07' into queue/release",
        conflict_files: ["packages/ui/src/release.ts"],
        evidence_refs: ["commit:remote2026"],
      },
      {
        sha: "qualified2026",
        pr_number: null,
        subject: "Merge branch 'release/2026.07' of github.example.test:example-org/example-repo into queue/release",
        conflict_files: ["packages/web/src/qualified.ts"],
        evidence_refs: ["commit:qualified2026"],
      },
    ]);
  });

  test("uses normalized base-branch detail aliases for queue-head merge evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202", base_branch: "release/2026.07" },
      {
        commits: [
          {
            sha: "remote2026",
            commit: {
              message: [
                "Merge remote-tracking branch 'origin/release/2026.07' into queue/release",
                "",
                "# Conflicts:",
                "#\tpackages/ui/src/release.ts",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "remote2026",
        pr_number: null,
        subject: "Merge remote-tracking branch 'origin/release/2026.07' into queue/release",
        conflict_files: ["packages/ui/src/release.ts"],
        evidence_refs: ["commit:remote2026"],
      },
    ]);
  });

  test("uses cached context commit aliases for queue merge-commit inference", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commitNodes: [
          {
            sha: "context201",
            message: "Merge PR #201",
          },
        ],
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "context201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:context201"],
      },
    ]);
  });

  test("falls back past blank PR detail commit rows to cached detail commit aliases", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
        commits: [
          { sha: " ", oid: "", message: " ", commit: { messageHeadline: "" } },
        ],
        commitNodes: [
          {
            oid: "detail201",
            message: "Merge PR #201",
          },
        ],
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "detail201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:detail201"],
      },
    ]);
  });

  test("uses cached PR detail commit edge aliases for queue merge-commit inference", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
        commits: [],
        commitEdges: [
          {
            node: {
              oid: "detail201",
              message: "Merge PR #201",
            },
          },
        ],
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "detail201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:detail201"],
      },
    ]);
  });

  test("falls back past blank canonical commit rows to cached commit aliases", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          { sha: " ", oid: "", message: " ", commit: { messageHeadline: "" } },
        ],
        commitNodes: [
          {
            sha: "context201",
            message: "Merge PR #201",
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "context201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: [],
        evidence_refs: ["commit:context201"],
      },
    ]);
  });

  test("preserves plain merge commit conflict blocks as queue evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            sha: "plain201",
            commit: {
              message: [
                "Merge PR #201",
                "",
                "Conflicts:",
                "\tpackages/api/src/plain.ts",
                "    apps/web/src/plain.ts",
                "",
                "Resolved by keeping the queue head API shape.",
              ].join("\n"),
            },
          },
          {
            sha: "plain202",
            commit: {
              message: [
                "Merge PR #202",
                "",
                "Conflicts:",
                "  - packages/ui/src/card.ts",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "plain201",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: ["packages/api/src/plain.ts", "apps/web/src/plain.ts"],
        evidence_refs: ["commit:plain201"],
      },
      {
        sha: "plain202",
        pr_number: 202,
        subject: "Merge PR #202",
        conflict_files: ["packages/ui/src/card.ts"],
        evidence_refs: ["commit:plain202"],
      },
    ]);
  });

  test("preserves merge commits without sha while omitting empty evidence refs", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            commit: {
              message: [
                "Merge PR #201",
                "",
                "# Conflicts:",
                "#\tpackages/api/src/routes.ts",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "merged_into_queue"],
        [202, "queued"],
      ],
    );
    assert.deepEqual(context!.merge_commits, [
      {
        sha: "",
        pr_number: 201,
        subject: "Merge PR #201",
        conflict_files: ["packages/api/src/routes.ts"],
        evidence_refs: [],
      },
    ]);
  });

  test("does not infer queues from squash-style issue references without queue context", () => {
    const context = inferMergeQueueContext(
      { title: "Worker cleanup" },
      {
        commits: [
          {
            sha: "abc2010",
            commit: { message: "Fix worker timeout (#201)" },
          },
          {
            sha: "abc2020",
            commit: { message: "Reduce retry burst (#202)" },
          },
        ],
        comments: [],
      },
    );

    assert.equal(context, null);
  });
});
