import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_REF_DETAIL_LIMIT,
  EVIDENCE_REF_ITEM_DETAIL_LIMIT,
  EVIDENCE_REF_RENDER_LIMIT,
  MERGE_BLOCKER_RENDER_LIMIT,
  QUEUE_VALIDATION_EVIDENCE_DETAIL_LIMIT,
  renderEvidenceSummaryRows,
} from "../review_gate_evidence_comment_model";

describe("review gate evidence comment model", () => {
  test("exports render caps used by comment rows", () => {
    assert.equal(EVIDENCE_REF_RENDER_LIMIT, 10);
    assert.equal(EVIDENCE_REF_DETAIL_LIMIT, 360);
    assert.equal(EVIDENCE_REF_ITEM_DETAIL_LIMIT, 72);
    assert.equal(MERGE_BLOCKER_RENDER_LIMIT, 12);
    assert.equal(QUEUE_VALIDATION_EVIDENCE_DETAIL_LIMIT, 520);
  });

  test("renders no rows when no evidence is available", () => {
    assert.deepEqual(renderEvidenceSummaryRows(null), []);
  });

  test("renders one evidence summary header for multiple evidence rows", () => {
    const rows = renderEvidenceSummaryRows({
      ci_status: {
        total_checks: 2,
        failed: 1,
        pending: 0,
        unknown: 0,
        passed: 1,
        failed_checks: [{ name: "unit | api", conclusion: "FAILURE", details_url: "https://ci.test/fail" }],
      },
      diff_availability: {
        available: false,
        source: "gh-pr-diff",
        error: "too large",
      },
    });

    assert.equal(rows.filter((row) => row === "## Evidence summary").length, 1);
    assert.ok(rows.some((row) => row.startsWith("| CI checks | blocked |")));
    assert.ok(rows.some((row) => row.startsWith("| Diff availability | blocked |")));
    assert.ok(rows.some((row) => row.includes("unit \\| api")));
    assert.ok(rows.some((row) => row.includes("https://ci.test/fail")));
    assert.ok(rows.some((row) => row.includes("gh:pr-diff")));
  });

  test("renders edge-shaped top-level evidence records", () => {
    const rows = renderEvidenceSummaryRows({
      ci_status: {
        cursor: "ci",
        node: {
          totalChecks: 1,
          failedChecks: [
            {
              node: { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
            },
          ],
        },
      },
      diff_availability: {
        node: {
          available: false,
          error: "Diff timed out.",
          evidenceRef: "diff:timeout",
        },
      },
      conflicts: {
        node: {
          hasConflicts: true,
          conflictingFiles: ["packages/api/src/app.ts"],
          evidenceRefs: ["conflict:merge-tree"],
        },
      },
      merge_blockers: {
        edges: [
          {
            node: {
              kind: "ci_pending",
              status: "pending",
              summary: "CI is pending.",
              evidenceRefs: ["blocker:pending"],
            },
          },
          {
            node: {
              kind: "review_required",
              status: "blocked",
              summary: "Review is required.",
              evidenceRefs: ["blocker:blocked"],
            },
          },
        ],
      },
    });

    assert.ok(rows.some((row) => row.includes("| CI checks | blocked |")));
    assert.ok(rows.some((row) => row.includes("api (FAILURE, ci:api)")));
    assert.ok(rows.some((row) => row.includes("| Diff availability | blocked | Diff timed out. |")));
    assert.ok(rows.some((row) => row.includes("| Merge conflicts | blocked | 1 active conflict file(s): packages/api/src/app.ts |")));
    assert.ok(rows.some((row) => row.includes("| review_required | blocked | Review is required. |")));
    assert.ok(rows.some((row) => row.includes("| ci_pending | pending | CI is pending. |")));
    assert.ok(rows.some((row) =>
      row.includes("| Evidence refs | 5 | ci:api, blocker:blocked, blocker:pending, diff:timeout, conflict:merge-tree |")
    ));
  });

  test("renders direct edge-shaped evidence summary records", () => {
    const rows = renderEvidenceSummaryRows({
      cursor: "summary-edge",
      node: {
        ciStatus: {
          node: {
            totalChecks: 1,
            failedChecks: [{ node: { name: "api", conclusion: "FAILURE", detailsUrl: "ci:edge" } }],
          },
        },
        diffAvailability: {
          node: {
            available: false,
            error: "Diff timed out.",
            evidenceRef: "diff:edge",
          },
        },
        queueContext: {
          node: {
            isQueue: true,
            queueStrategy: "manual",
            constituentPrs: [{ node: { prNumber: 201, status: "queued", evidenceRefs: ["pr:#201"] } }],
            validationEvidence: [{ node: { command: "npm test", status: "failed", scope: "#201", evidenceRef: "validation:edge" } }],
          },
        },
      },
    } as unknown as Parameters<typeof renderEvidenceSummaryRows>[0]);

    assert.ok(rows.some((row) => row.includes("| CI checks | blocked |")));
    assert.ok(rows.some((row) => row.includes("api (FAILURE, ci:edge)")));
    assert.ok(rows.some((row) => row.includes("| Diff availability | blocked | Diff timed out. |")));
    assert.ok(rows.some((row) => row.includes("| Evidence refs | 4 | ci:edge, diff:edge, validation:edge, pr:#201 |")));
    assert.ok(rows.includes("## Merge queue evidence"));
    assert.ok(rows.some((row) => row.includes("| Constituent PRs | 1 | #201 |")));
  });

  test("renders raw adapter top-level evidence aliases", () => {
    const rows = renderEvidenceSummaryRows({
      statusCheckRollup: [
        { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
        { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
      ],
      mergeQueueContext: {
        isQueue: true,
        queueStrategy: "manual",
        pullRequests: [{ prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] }],
        validationResults: [
          { command: "npm test", status: "failed", scope: "#207", evidenceRef: "validation:raw-207" },
        ],
        blockers: [
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "Queue constituent PR #207 has failed validation.",
            evidenceRefs: ["queue:blocker-raw"],
          },
        ],
      },
    } as unknown as Parameters<typeof renderEvidenceSummaryRows>[0]);

    assert.ok(rows.some((row) => row.includes("| CI checks | blocked |")));
    assert.ok(rows.some((row) => row.includes("api (FAILURE, ci:api)")));
    assert.ok(rows.includes("## Merge queue evidence"));
    assert.ok(rows.includes("Strategy: manual"));
    assert.ok(rows.some((row) => row.includes("| Constituent PRs | 1 | #207 |")));
    assert.ok(rows.some((row) => row.includes("| Validation evidence | 1 | failed [#207]: npm test |")));
    assert.ok(rows.some((row) =>
      row.includes("| Evidence refs | 5 | ci:api, validation:raw-207, queue:blocker-raw, ci:deploy, pr:#207 |")
    ));
  });

  test("renders queue evidence rows and excludes top-level duplicate blockers", () => {
    const duplicateBlocker = {
      kind: "review_required",
      status: "blocked",
      summary: "GitHub requires review before this PR can merge.",
      evidence_refs: ["github:reviewDecision"],
    };
    const rows = renderEvidenceSummaryRows({
      merge_blockers: [duplicateBlocker],
      queue_context: {
        is_queue: true,
        strategy: "manual",
        constituent_prs: [
          { number: 201, status: "validated", evidence_refs: ["pr:#201"] },
          { number: 202, status: "blocked", evidence_refs: ["pr:#202", "validation:202"] },
        ],
        merge_commits: [
          { sha: "abc123456789", pr_number: 201, conflict_files: ["packages/api/src/server.ts"], evidence_refs: ["commit:abc123456789"] },
        ],
        validation_evidence: [
          { command: "npm test", status: "failed", scope: "#202", evidence_ref: "validation:202" },
        ],
        unresolved_blockers: [
          { ...duplicateBlocker, evidence_refs: ["comment:duplicate"] },
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "Queue constituent PR #202 has 1 failed validation evidence item.",
            evidence_refs: ["validation:202"],
          },
        ],
      },
    });

    assert.ok(rows.includes("## Merge queue evidence"));
    assert.ok(rows.includes("Strategy: manual"));
    assert.ok(rows.some((row) => row.includes("| Constituent PRs | 2 | #202, #201 |")));
    assert.ok(rows.some((row) => row.includes("| Conflict files | 1 | packages/api/src/server.ts |")));
    assert.ok(rows.some((row) =>
      row.includes("| Unresolved blockers | 1 | ci_failed (blocked): Queue constituent PR #202 has 1 failed validation evidence item. |")
    ));
  });

  test("deduplicates repeated top-level blockers before rendering evidence rows", () => {
    const rows = renderEvidenceSummaryRows({
      merge_blockers: [
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
          evidence_refs: ["blocker:label"],
        },
        {
          type: "external-gate",
          outcome: "failed",
          description: "Release approval is required.",
          evidence_refs: ["blocker:comment"],
        },
      ],
      queue_context: {
        is_queue: true,
        unresolved_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release approval is required.",
            evidence_refs: ["blocker:queue-copy"],
          },
        ],
      },
    });

    assert.equal(
      rows.filter((row) => row.includes("| external_gate | blocked | Release approval is required. |")).length,
      1,
    );
    assert.ok(rows.some((row) => row.includes("| Evidence refs | 2 | blocker:label, blocker:comment |")));
    assert.ok(rows.some((row) => row.includes("| Unresolved blockers | 0 | none |")));
  });

  test("deduplicates repeated queue-only blockers before rendering evidence rows", () => {
    const rows = renderEvidenceSummaryRows({
      queue_context: {
        is_queue: true,
        unresolved_blockers: [
          {
            kind: "queue_validation_failed",
            status: "blocked",
            summary: "Queue validation failed.",
            evidence_refs: ["queue:first"],
          },
          {
            type: "queue-validation-failed",
            outcome: "failure",
            description: "Queue validation failed.",
            evidence_refs: ["queue:second"],
          },
        ],
      },
    });

    assert.ok(rows.some((row) =>
      row.includes("| Unresolved blockers | 1 | queue_validation_failed (blocked): Queue validation failed. |")
    ));
    assert.ok(rows.some((row) => row.includes("| Evidence refs | 2 | queue:first, queue:second |")));
  });

  test("keeps omitted evidence-ref marker visible when refs are long", () => {
    const rows = renderEvidenceSummaryRows({
      merge_blockers: Array.from({ length: 12 }, (_, index) => ({
        kind: "external_gate",
        status: "blocked",
        summary: `External gate ${index + 1}`,
        evidence_refs: [
          `https://github.example.test/very/deep/path/to/repositories/org/repo/pull/203#issuecomment-${String(index + 1).padStart(3, "0")}`,
        ],
      })),
    });

    const refsRow = rows.find((row) => row.startsWith("| Evidence refs |"));
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 12 \|/);
    assert.match(refsRow, /8 more/);
    assert.match(refsRow, /https:\/\/github\.example\.test\/very\/d\.\.\.\/org\/repo\/pull\/203#issuecomment-001/);
    assert.ok(refsRow.length <= EVIDENCE_REF_DETAIL_LIMIT + 40, refsRow);
  });
});
