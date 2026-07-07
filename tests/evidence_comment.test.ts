import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  evidenceSummaryFromPrDetailsAndContext,
  evidenceSummaryFromPrContext,
  renderReviewGateStatusComment,
} from "../evidence_comment";
import { analyzeMergeBlockers, inferMergeQueueContext } from "../merge_pr_model";
import { QUEUE_VALIDATION_EVIDENCE_DETAIL_LIMIT } from "../review_gate_evidence_comment_model";

describe("evidence comment rendering", () => {
  test("renders direct edge-shaped gate rows", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          cursor: "gate-edge",
          node: {
            rule: " modeled-blockers ",
            status: " failure ",
            explanation: " CI failed ",
          },
        },
      ] as unknown as Parameters<typeof renderReviewGateStatusComment>[0],
      "2026-07-01T00:00:00.000Z",
    );

    assert.match(rendered, /\| modeled-blockers \| fail \| CI failed \|/);
  });

  test("projects only durable evidence fields from PR context", () => {
    const ciStatus = { total_checks: 1, passed: 1 };
    const diffAvailability = { available: true, source: "gh-pr-diff", size: 42 };
    const conflicts = { has_conflicts: false };
    const mergeBlockers = [{ kind: "review_required", status: "pending", summary: "Review required." }];
    const queueContext = { is_queue: false };

    assert.deepEqual(
      evidenceSummaryFromPrContext({
        ci_status: ciStatus,
        diff_availability: diffAvailability,
        conflicts,
        merge_blockers: mergeBlockers,
        queue_context: queueContext,
        comments: [{ body: "discussion should not be copied into evidence summary" }],
        diff: "raw diff should not be copied into evidence summary",
      }),
      {
        ci_status: ciStatus,
        diff_availability: diffAvailability,
        conflicts,
        merge_blockers: mergeBlockers,
        queue_context: queueContext,
      },
    );
  });

  test("renders PR detail and comment blocker evidence from details-aware summaries", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: "Supplemental blockers were detected.",
        },
      ],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrDetailsAndContext(
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
      ),
    );

    assert.match(rendered, /\| draft \| blocked \| GitHub reports this PR is still marked as draft\. \|/);
    assert.match(rendered, /\| external_gate \| blocked \| Label 'do not merge' marks this PR as blocked for landing\. \|/);
    assert.match(rendered, /\| external_gate \| blocked \| Manual merge gate is blocked: waiting on release\. \|/);
    assert.match(rendered, /\| merge_state_blocked \| pending \| GitHub reports the PR merge state as BEHIND\. \|/);
    assert.match(
      rendered,
      /\| Evidence refs \| 4 \| github:isDraft, github:label:do-not-merge, comment:manual-gate, github:mergeStateStatus \|/,
    );
  });

  test("infers missing queue context when rendering details-aware evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: "Queue blockers were detected.",
        },
      ],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrDetailsAndContext(
        {
          title: "Merge queue: PRs #201 and #202",
          number: 300,
        },
        {
          comments: [],
          review_comments: [],
          commits: [],
          conflicts: { has_conflicts: false, conflicting_files: [] },
          ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
          diff_availability: { available: true },
          merge_blockers: [],
        },
      ),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /\| Constituent PRs \| 2 \| #201, #202 \|/);
    assert.match(rendered, /\| Constituent status \| 2 \| #201 \(queued\); #202 \(queued\) \|/);
  });

  test("does not override explicit non-queue evidence context during details-aware rendering", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "modeled-blockers",
          status: "pass",
          explanation: "Explicitly not a queue.",
        },
      ],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrDetailsAndContext(
        {
          title: "Merge queue: PRs #201 and #202",
          number: 300,
        },
        {
          comments: [],
          review_comments: [],
          commits: [],
          conflicts: { has_conflicts: false, conflicting_files: [] },
          ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
          diff_availability: { available: true },
          merge_blockers: [],
          queue_context: { isQueue: false },
        },
      ),
    );

    assert.doesNotMatch(rendered, /## Merge queue evidence/);
    assert.doesNotMatch(rendered, /\| Constituent PRs \|/);
  });

  test("preserves supplemental evidence refs when duplicate cached blockers lack refs", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "modeled-blockers",
          status: "blocked",
          explanation: "Supplemental blockers were detected.",
        },
      ],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrDetailsAndContext(
        {
          labels: ["do not merge"],
        },
        {
          conflicts: { has_conflicts: false, conflicting_files: [] },
          ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
          diff_availability: { available: true },
          merge_blockers: [
            {
              kind: "external_gate",
              status: "blocked",
              summary: "Label 'do not merge' marks this PR as blocked for landing.",
            },
          ],
          queue_context: {},
        },
      ),
    );

    assert.equal(
      rendered.match(/\| external_gate \| blocked \| Label 'do not merge' marks this PR as blocked for landing\. \|/g)?.length,
      1,
    );
    assert.match(rendered, /\| Evidence refs \| 1 \| github:label:do-not-merge \|/);
  });

  test("keeps dedicated CI review and conflict evidence out of details-aware modeled blockers", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "modeled-blockers",
          status: "pass",
          explanation: "No supplemental blockers.",
        },
      ],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrDetailsAndContext(
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
      ),
    );

    assert.match(rendered, /\| CI checks \| blocked \| 1 failed, 0 pending, 0 unknown, 0 passed, 0 skipped out of 1 check\(s\)\. \|/);
    assert.match(rendered, /\| Merge conflicts \| blocked \| 1 active conflict file\(s\): packages\/api\/src\/routes\.ts \|/);
    assert.match(rendered, /\| merge_state_blocked \| pending \| GitHub reports the PR merge state as BEHIND\. \|/);
    assert.doesNotMatch(rendered, /\| review_required \|/);
    assert.doesNotMatch(rendered, /\| ci_failed \|/);
    assert.doesNotMatch(rendered, /\| merge_conflicts \|/);
    assert.match(rendered, /\| Evidence refs \| 3 \| github:statusCheckRollup, github:mergeStateStatus, git:merge-tree \|/);
  });

  test("does not fall back to dedicated blockers when no supplemental blockers remain", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "modeled-blockers",
          status: "pass",
          explanation: "No supplemental blockers.",
        },
      ],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrDetailsAndContext(
        {
          reviewDecision: "REVIEW_REQUIRED",
        },
        {
          conflicts: { has_conflicts: true, conflict_count: 1, conflicting_files: ["src/index.ts"] },
          ci_status: {
            total_checks: 1,
            failed: 1,
            pending: 0,
            unknown: 0,
            passed: 0,
            failed_checks: [{ name: "api", conclusion: "FAILURE", details_url: "ci:api" }],
          },
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
              evidence_refs: ["ci:api"],
            },
            {
              kind: "merge_conflicts",
              status: "blocked",
              summary: "Merge conflicts detected in 1 file(s).",
              evidence_refs: ["git:merge-tree"],
            },
          ],
          queue_context: {},
        },
      ),
    );

    assert.match(rendered, /\| CI checks \| blocked \| .*Failed: api \(FAILURE, ci:api\)/);
    assert.match(rendered, /\| Merge conflicts \| blocked \| 1 active conflict file\(s\): src\/index\.ts \|/);
    assert.doesNotMatch(rendered, /\| review_required \|/);
    assert.doesNotMatch(rendered, /\| ci_failed \|/);
    assert.doesNotMatch(rendered, /\| merge_conflicts \| blocked \| Merge conflicts detected/);
    assert.match(rendered, /\| Evidence refs \| 2 \| ci:api, git:merge-tree \|/);
    assert.doesNotMatch(rendered, /github:reviewDecision/);
  });

  test("projects cached top-level PR context aliases into evidence summary", () => {
    const ciStatus = { total_checks: 1, failed: 1, failed_checks: [{ detailsUrl: "ci:api" }] };
    const diffAvailability = { available: false, source: "gh-pr-diff", error: "too large" };
    const mergeBlockers = [{ kind: "ci_failed", status: "blocked", summary: "CI failed.", evidenceRefs: ["ci:api"] }];
    const queueContext = {
      isQueue: true,
      constituentPrs: [{ number: 201, status: "blocked", evidenceRefs: ["pr:#201"] }],
      validationEvidence: [{ command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:201" }],
      unresolvedBlockers: [{ kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRefs: ["validation:201"] }],
    };

    assert.deepEqual(
      evidenceSummaryFromPrContext({
        ciStatus,
        diffAvailability,
        mergeConflicts: { has_conflicts: true, conflictingFiles: ["packages/api/src/app.ts"] },
        mergeBlockers,
        queueContext,
        comments: [{ body: "discussion should not be copied into evidence summary" }],
      }),
      {
        ci_status: ciStatus,
        diff_availability: diffAvailability,
        conflicts: { has_conflicts: true, conflictingFiles: ["packages/api/src/app.ts"] },
        merge_blockers: mergeBlockers,
        queue_context: queueContext,
      },
    );
  });

  test("renders evidence-ref-only cached validation rows without falling through to aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "cached validation ref only" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queueContext: {
          validation_evidence: [
            {
              evidenceRefs: ["validation:canonical", "ticket:canonical"],
            },
          ],
          validationEvidence: [
            {
              command: "npm test",
              status: "failed",
              scope: "#201",
              evidenceRef: "validation:alias",
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| Validation evidence \| 1 \| unknown: unknown \|/);
    assert.match(rendered, /\| Evidence refs \| 2 \| validation:canonical, ticket:canonical \|/);
    assert.doesNotMatch(rendered, /validation:alias/);
  });

  test("renders evidence-ref-only cached constituent and merge-commit rows without falling through to aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "cached lineage refs only" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queueContext: {
          constituent_prs: [{ evidenceRefs: ["pr:canonical"] }],
          constituentPrs: [{ prNumber: 201, title: "Alias PR", evidenceRef: "pr:alias" }],
          merge_commits: [{ commit: { evidenceRefs: ["commit:nested-canonical"] } }],
          mergeCommits: [{ oid: "abc", message: "Merge PR #201", evidenceRef: "commit:alias" }],
        },
      }),
    );

    assert.match(rendered, /\| Constituent PRs \| 1 \| unknown/);
    assert.match(rendered, /\| Merge commits \| 1 \| nested-c/);
    assert.match(rendered, /\| Evidence refs \| 2 \| commit:nested-canonical, pr:canonical \|/);
    assert.doesNotMatch(rendered, /commit:alias/);
    assert.doesNotMatch(rendered, /pr:alias/);
  });

  test("renders flattened raw adapter queue context aliases through the evidence summary", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "flattened queue context" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        isQueue: "true",
        queueStrategy: "manual",
        pullRequests: [
          { node: { prNumber: 207, status: "blocked", evidenceRefs: ["pr:#207"] } },
        ],
        mergeCommits: [
          { node: { oid: "abc123456789", message: "Merge PR #207 from org/feature" } },
        ],
        validationResults: [
          { node: { command: "npm test", result: "failure", scope: "#207", evidenceRef: "validation:207" } },
        ],
        blockers: [
          {
            node: {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #207 failed validation.",
              evidenceRef: "queue:blocker",
            },
          },
        ],
      }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Strategy: manual/);
    assert.match(rendered, /\| Constituent PRs \| 1 \| #207 \|/);
    assert.match(rendered, /\| Merge commits \| 1 \| abc12345 \(#207\) \|/);
    assert.match(rendered, /\| Validation evidence \| 1 \| failed \[#207\]: npm test \|/);
    assert.match(rendered, /Evidence refs \| 4 \| validation:207, queue:blocker, commit:abc123456789, pr:#207/);
    assert.doesNotMatch(rendered, /\| ci_failed \| blocked \| Queue constituent PR #207 failed validation\. \|/);
    assert.match(rendered, /\| Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #207 failed validation\. \|/);
  });

  test("renders flat top-level blocker aliases when no queue context is present", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "flat blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        blockers: [
          {
            node: {
              kind: "external_gate",
              status: "blocked",
              summary: "Release manager approval is required.",
              evidenceRef: "blocker:release",
            },
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Release manager approval is required\. \|/);
    assert.match(rendered, /\| Evidence refs \| 1 \| blocker:release \|/);
    assert.doesNotMatch(rendered, /## Merge queue evidence/);
  });

  test("does not let a false flat queue flag hide top-level blockers", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "flat blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        isQueue: false,
        blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release manager approval is required.",
            evidenceRef: "blocker:false-queue",
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Release manager approval is required\. \|/);
    assert.match(rendered, /\| Evidence refs \| 1 \| blocker:false-queue \|/);
    assert.doesNotMatch(rendered, /## Merge queue evidence/);
  });

  test("uses queue flag aliases after malformed canonical queue flags", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "flat queue blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        is_queue: "surprise",
        isQueue: true,
        blockers: [
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "Queue validation failed.",
            evidenceRef: "queue:blocker-alias",
          },
        ],
      }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /\| Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue validation failed\. \|/);
    assert.match(rendered, /\| Evidence refs \| 1 \| queue:blocker-alias \|/);
    assert.doesNotMatch(rendered, /\| ci_failed \| blocked \| Queue validation failed\. \|/);
  });

  test("does not treat ordinary flat merge strategy as queue context", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "flat blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        strategy: "squash",
        blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release manager approval is required.",
            evidenceRef: "blocker:squash",
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Release manager approval is required\. \|/);
    assert.match(rendered, /\| Evidence refs \| 1 \| blocker:squash \|/);
    assert.doesNotMatch(rendered, /## Merge queue evidence/);
  });

  test("renders edge-shaped top-level PR context records", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "edge-shaped cache" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ciStatus: {
          __typename: "StatusCheckRollupEdge",
          cursor: "ci",
          node: {
            totalChecks: 1,
            failedChecks: [{ name: "api", detailsUrl: "ci:api" }],
          },
        },
        mergeConflicts: {
          node: {
            hasConflicts: true,
            conflictCount: 1,
            evidenceRefs: ["conflict:edge"],
          },
        },
        queueContext: {
          node: {
            isQueue: true,
            strategy: "manual",
            constituentPrs: [{ prNumber: 201, status: "queued", evidenceRefs: ["pr:#201"] }],
            validationEvidence: [{ command: "npm test", status: "failed", scope: "#201", evidenceRef: "validation:edge" }],
          },
        },
      }),
    );

    assert.match(rendered, /\| CI checks \| blocked \| 1 failed, 0 pending, 0 unknown/);
    assert.match(rendered, /\| Merge conflicts \| blocked \| 1 active conflict file\(s\); file list unavailable\. \|/);
    assert.match(rendered, /\| Evidence refs \| 4 \| ci:api, conflict:edge, validation:edge, pr:#201 \|/);
    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /\| Constituent PRs \| 1 \| #201 \|/);
  });

  test("renders whole edge-shaped PR context records", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "whole edge cache" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        cursor: "context-edge",
        node: {
          ciStatus: {
            node: {
              totalChecks: 1,
              pendingChecks: [{ node: { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" } }],
            },
          },
          mergeConflicts: {
            node: {
              hasConflicts: true,
              conflictingFiles: ["packages/web/src/app.ts"],
              evidenceRefs: ["conflict:whole-edge"],
            },
          },
          queueContext: {
            node: {
              isQueue: true,
              queueStrategy: "manual",
              constituentPrs: [{ node: { prNumber: 202, status: "queued", evidenceRefs: ["pr:#202"] } }],
              validationEvidence: [{ node: { command: "npm test", status: "unknown", scope: "#202", evidenceRef: "validation:whole-edge" } }],
            },
          },
        },
      }),
    );

    assert.match(rendered, /\| CI checks \| pending \| 0 failed, 1 pending, 0 unknown/);
    assert.match(rendered, /deploy \(IN_PROGRESS, ci:deploy\)/);
    assert.match(rendered, /\| Merge conflicts \| blocked \| 1 active conflict file\(s\): packages\/web\/src\/app.ts \|/);
    assert.match(rendered, /\| Evidence refs \| 4 \| conflict:whole-edge, validation:whole-edge, ci:deploy, pr:#202 \|/);
    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Strategy: manual/);
    assert.match(rendered, /\| Constituent PRs \| 1 \| #202 \|/);
  });

  test("projects useful aliases when canonical top-level records are empty", () => {
    const ciStatus = { totalChecks: 0, failed: 1, failedChecks: [{ detailsUrl: "ci:api" }] };
    const diffAvailability = { available: false, source: "gh-pr-diff", error: "too large" };
    const queueContext = {
      isQueue: true,
      constituentPrs: [{ number: 201, status: "blocked", evidenceRefs: ["pr:#201"] }],
      validationEvidence: [{ command: "npm test", status: "failed", scope: "#201", evidenceRef: "validation:201" }],
      unresolvedBlockers: [{ kind: "ci_failed", status: "blocked", summary: "Queue validation failed.", evidenceRefs: ["validation:201"] }],
    };

    assert.deepEqual(
      evidenceSummaryFromPrContext({
        ci_status: {},
        diff_availability: {},
        conflicts: {},
        queue_context: {},
        ciStatus,
        diffAvailability,
        mergeConflicts: { hasConflicts: true, conflictingFiles: ["packages/api/src/app.ts"] },
        queueContext,
      }),
      {
        ci_status: ciStatus,
        diff_availability: diffAvailability,
        conflicts: { hasConflicts: true, conflictingFiles: ["packages/api/src/app.ts"] },
        merge_blockers: undefined,
        queue_context: queueContext,
      },
    );
  });

  test("renders useful queue context aliases when canonical queue context is non-decisive", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue alias" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: { is_queue: "surprise", strategy: " " },
        queueContext: {
          isQueue: true,
          constituentPrs: [{ number: 201, status: "blocked", evidenceRefs: ["pr:#201"] }],
          validationEvidence: [{ command: "npm test", status: "failed", scope: "#201", evidenceRef: "validation:201" }],
        },
      }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /\| Constituent PRs \| 1 \| #201 \|/);
    assert.match(rendered, /\| Validation evidence \| 1 \| failed \[#201\]: npm test \|/);
    assert.match(rendered, /\| Evidence refs \| 2 \| validation:201, pr:#201 \|/);
  });

  test("renders useful top-level blocker aliases when canonical arrays are placeholders", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          null,
          {},
          "placeholder",
        ],
        mergeBlockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External gate blocked.",
            evidenceRefs: ["blocker:external"],
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| External gate blocked\. \|/);
    assert.match(rendered, /Evidence refs \| 1 \| blocker:external/);
  });

  test("renders useful top-level blocker aliases when canonical blocker rows are blank", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
            evidenceRefs: ["blocker:external"],
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| External gate blocked\. \|/);
    assert.match(rendered, /Evidence refs \| 1 \| blocker:external/);
    assert.doesNotMatch(rendered, /\| unknown \| unknown \| No summary\. \|/);
  });

  test("renders cached top-level and nested PR context aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ciStatus: {
          totalChecks: 0,
          failed: 0,
          failedChecks: [
            { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          ],
        },
        mergeConflicts: {
          hasConflicts: true,
          conflict_count: 0,
          conflictCount: 3,
          conflictingFiles: ["packages/api/src/app.ts", "packages/ui/src/view.ts"],
          evidenceRefs: ["conflict:cached"],
        },
        mergeBlockers: [
          {
            kind: "external_gate",
            status: "ACTION REQUIRED",
            summary: "External approval is required.",
            evidenceRefs: ["blocker:external"],
          },
        ],
        queueContext: {
          isQueue: true,
          strategy: "mergeCommits",
          constituentPrs: [{ number: 201, status: "mergedIntoQueue", evidenceRefs: ["pr:#201"] }],
          mergeCommits: [{ oid: " oid201 ", evidenceRefs: ["commit:oid201"] }],
          validationEvidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:201" },
          ],
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| CI checks \| blocked \| 1 failed, 0 pending, 0 unknown, 0 passed, 0 skipped out of 1 check\(s\)\. Failed: api \(FAILURE, ci:api\) \|/);
    assert.match(rendered, /\| Merge conflicts \| blocked \| 3 active conflict file\(s\): packages\/api\/src\/app\.ts, packages\/ui\/src\/view\.ts \(2 listed\) \|/);
    assert.match(rendered, /\| external_gate \| blocked \| External approval is required\. \|/);
    assert.match(rendered, /Strategy: merge_commits/);
    assert.match(rendered, /\| Constituent status \| 1 \| #201 \(merged_into_queue\) \|/);
    assert.match(rendered, /\| Evidence refs \| \d+ \| ci:api, blocker:external, conflict:cached, validation:201, queue:blocker/);
  });

  test("renders cached queue context from direct GraphQL edge arrays", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached edge queue has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queueContext: {
          isQueue: true,
          strategy: "mergeCommits",
          constituentPrs: [
            { cursor: "constituent", node: { prNumber: "205", status: "blocked" } },
          ],
          mergeCommits: [
            { node: { oid: "edgecommit205", prNumber: "205" } },
          ],
          validationEvidence: [
            {
              node: {
                command: "npm test",
                status: "failed",
                pullRequest: "205",
                evidenceRef: "validation:edge-205",
              },
            },
          ],
          unresolvedBlockers: [
            {
              node: {
                kind: "ci_failed",
                status: "blocked",
                summary: "Queue constituent PR #205 has failed validation.",
                evidenceRefs: ["queue:blocker-edge"],
              },
            },
          ],
        },
      }),
    );

    assert.match(rendered, /Strategy: merge_commits/);
    assert.match(rendered, /Constituent PRs \| 1 \| #205/);
    assert.match(rendered, /Constituent status \| 1 \| #205 \(blocked\)/);
    assert.match(rendered, /Merge commits \| 1 \| edgecomm \(#205\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#205\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #205 has failed validation\./);
    assert.match(rendered, /Evidence refs \| 4 \| validation:edge-205, queue:blocker-edge, commit:edgecommit205, pr:#205/);
  });

  test("renders queue evidence from integration vocabulary aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "aliased queue payload has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queueContext: {
          isQueue: true,
          queueStrategy: "mergeCommits",
          pullRequests: [{ prNumber: "206", state: "failed", evidenceRefs: ["pr:#206"] }],
          commits: [{ oid: "aliascommit206", prNumber: "206" }],
          validationResults: [
            {
              command: "npm test",
              status: "failed",
              scope: "#206",
              evidenceRef: "validation:alias-206",
            },
          ],
          blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #206 has failed validation.",
              evidenceRefs: ["queue:blocker-alias"],
            },
          ],
        },
      }),
    );

    assert.match(rendered, /Strategy: merge_commits/);
    assert.match(rendered, /Constituent PRs \| 1 \| #206/);
    assert.match(rendered, /Constituent status \| 1 \| #206 \(blocked\)/);
    assert.match(rendered, /Merge commits \| 1 \| aliascom \(#206\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#206\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #206 has failed validation\./);
    assert.match(rendered, /Evidence refs \| 4 \| validation:alias-206, queue:blocker-alias, commit:aliascommit206, pr:#206/);
  });

  test("renders raw adapter CI and merge queue context aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "raw adapter payload has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        statusCheckRollup: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        ],
        mergeQueueContext: {
          queueStrategy: "manual",
          pullRequests: [{ prNumber: "207", state: "queued", evidenceRefs: ["pr:#207"] }],
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
      }),
    );

    assert.match(rendered, /\| CI checks \| blocked \| 1 failed, 1 pending, 0 unknown, 0 passed, 0 skipped out of 2 check\(s\)\. Failed: api \(FAILURE, ci:api\) Pending: deploy \(IN_PROGRESS, ci:deploy\) \|/);
    assert.match(rendered, /Strategy: manual/);
    assert.match(rendered, /Constituent PRs \| 1 \| #207/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#207\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #207 has failed validation\./);
    assert.match(rendered, /Evidence refs \| 5 \| ci:api, validation:raw-207, queue:blocker-raw, ci:deploy, pr:#207/);
  });

  test("renders status-check rollups when zero-count CI summaries are placeholders", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "fail", explanation: "raw status checks are authoritative" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
      }),
    );

    assert.match(rendered, /\| CI checks \| blocked \| 1 failed, 1 pending, 0 unknown, 0 passed, 0 skipped out of 2 check\(s\)\. Failed: api \(FAILURE, ci:api\) Pending: deploy \(IN_PROGRESS, ci:deploy\) \|/);
    assert.match(rendered, /Evidence refs \| 2 \| ci:api, ci:deploy/);
  });

  test("renders useful status-check aliases when canonical status-check rows are blank", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "fail", explanation: "raw status checks are authoritative" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        status_check_rollup: [
          { name: " ", conclusion: "", status: "", detailsUrl: "" },
        ],
        statusChecks: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        ],
      }),
    );

    assert.match(rendered, /\| CI checks \| blocked \| 1 failed, 1 pending, 0 unknown, 0 passed, 0 skipped out of 2 check\(s\)\. Failed: api \(FAILURE, ci:api\) Pending: deploy \(IN_PROGRESS, ci:deploy\) \|/);
    assert.match(rendered, /Evidence refs \| 2 \| ci:api, ci:deploy/);
  });

  test("renders malformed gate rows with explicit defaults", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "   ",
          status: "surprise",
          explanation: "   ",
        },
      ],
      "2026-07-01T00:00:00.000Z",
    );

    assert.match(rendered, /\| review-gates \| unknown \| No gate explanation was provided\. \|/);
    assert.doesNotMatch(rendered, /\|\s+\|\s+unknown\s+\|\s+\|/);
  });

  test("renders validation-derived queue membership from the merge model", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "validation-only queue summary has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Strategy: unknown/);
    assert.match(rendered, /Constituent PRs \| 2 \| #202, #201/);
    assert.match(rendered, /Constituent status \| 2 \| #202 \(blocked\); #201 \(validated\)/);
    assert.match(rendered, /Validation evidence \| 3 \| failed \[#202\]: npm run ui; failed \[packages\/api\]: npm run lint; passed \[#201\]: npm run api/);
    assert.match(rendered, /Unresolved blockers \| 2 \| ci_failed \(blocked\): Queue constituent PR #202 has 1 failed or blocked validation evidence item\(s\)\.; ci_failed \(blocked\): Queue validation scope packages\/api has 1 failed or blocked validation evidence item\(s\)\./);
    assert.match(rendered, /Evidence refs \| 3 \| https:\/\/example.test\/pull\/203#issuecomment-validation-only, pr:#202, pr:#201/);
  });

  test("renders fallback refs for validation comments without URL aliases", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Manual queue" },
      {
        commits: [],
        comments: [
          {
            body: "- #201 npm run api -> failed",
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "validation comment has no URL" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Constituent status \| 1 \| #201 \(blocked\)/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #201 has 1 failed or blocked validation evidence item\(s\)\./);
    assert.match(rendered, /Evidence refs \| 2 \| github:pr-comment, pr:#201/);
  });

  test("renders status-target validation evidence from the merge model", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Manual queue" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-status-target",
            body: [
              "- passed for PR #201: npm run api",
              "- failed for pull request #202 - pnpm test --filter ui",
              "- blocked for MR !203: npm run mr-smoke",
              "- failed for [API validation](https://github.example.test/org/repo/pull/204): npm run markdown-target",
              "- failed for PR #205 and PR #206: npm run shared-target",
              "- failed for packages/api: npm run lint -- api",
              "- passed for queue: npm run queue-smoke",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "status-target validation has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    const blockersRow = rendered.split("\n").find((line) => line.startsWith("| Unresolved blockers |"));

    assert.match(rendered, /Constituent PRs \| 4 \| #202, #203, #204, #201/);
    assert.match(rendered, /Constituent status \| 4 \| #202 \(blocked\); #203 \(blocked\); #204 \(blocked\); #201 \(validated\)/);
    assert.ok(validationRow);
    assert.match(validationRow, /Validation evidence \| 7 \|/);
    assert.match(validationRow, /failed \[#202\]: pnpm test --filter ui/);
    assert.match(validationRow, /blocked \[#203\]: npm run mr-smoke/);
    assert.match(validationRow, /failed \[#204\]: npm run markdown-target/);
    assert.match(validationRow, /failed: npm run shared-target/);
    assert.match(validationRow, /failed \[packages\/api\]: npm run lint -- api/);
    assert.doesNotMatch(validationRow, /#205/);
    assert.doesNotMatch(validationRow, /#206/);
    assert.ok(blockersRow);
    assert.match(blockersRow, /Queue constituent PR #202 has 1 failed or blocked validation evidence item/);
    assert.match(blockersRow, /Queue constituent PR #203 has 1 failed or blocked validation evidence item/);
    assert.match(blockersRow, /Queue constituent PR #204 has 1 failed or blocked validation evidence item/);
    assert.match(blockersRow, /Queue-wide validation has 1 faile/);
    assert.match(rendered, /Evidence refs \| 5 \| https:\/\/example.test\/pull\/203#issuecomment-status-target, pr:#202, pr:#203, pr:#204, pr:#201/);
  });

  test("renders long-form pull request queue titles from the merge model", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge pull requests #201 through #203" },
      {
        commits: [],
        comments: [],
      },
    );

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "long-form queue title modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const numbersRow = rendered.split("\n").find((line) => line.startsWith("| Constituent PRs |"));
    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(numbersRow);
    assert.match(numbersRow, /#201, #202, #203/);
    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued\); #202 \(queued\); #203 \(queued\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /pr:#201, pr:#202, pr:#203/);
  });

  test("renders long real-world comma-separated queue titles without truncating the count", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "RC1 Merge queue: PRs 178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198",
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "real queue title modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const numbersRow = rendered.split("\n").find((line) => line.startsWith("| Constituent PRs |"));
    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(numbersRow);
    assert.match(numbersRow, /\| Constituent PRs \| 13 \| #178, #179, #180, #182, #185, #189, #190, #191, 5 more \|/);
    assert.ok(statusRow);
    assert.match(statusRow, /\| Constituent status \| 13 \| #178 \(queued\); #179 \(queued\); #180 \(queued\); #182 \(queued\); #185 \(queued\); #189 \(queued\); #190 \(queued\); #191 \(queued\); 5 more \|/);
  });

  test("renders verbose queue constituent status without truncating the omitted count", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "RC1 Merge queue: PRs 178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198",
      },
      {
        commits: [
          {
            sha: "c56e49c5abcdef",
            message: "Merge pull request #185 from org/connector-settings",
          },
          {
            sha: "eafba5d0abcdef",
            message: "Merge pull request #189 from org/card-step",
          },
          {
            sha: "082a9bb4abcdef",
            message: "Merge pull request #190 from org/orchestration-state",
          },
        ],
        comments: [
          {
            body: [
              "| PR | Title | Status | Head |",
              "| --- | --- | --- | --- |",
              "| #185 | Connector/settings refresh plus chat orchestration trace stack integration. | merged_into_queue | c56e49c5abcdef |",
              "| #189 | Carbon card-step orchestration state rendering integration. | merged_into_queue | eafba5d0abcdef |",
              "| #190 | Orchestration state naming promotion integration. | merged_into_queue | 082a9bb4abcdef |",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "real queue status modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#185 \(merged_into_queue, Connector\/settings refresh plus chat orch\.\.\., head c56e49c5\)/);
    assert.match(statusRow, /5 more \|$/);
  });

  test("renders queue merge-forward prose as merged constituent status", () => {
    const queueContext = inferMergeQueueContext(
      {
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue merge-forward modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Constituent status \| 3 \| #189 \(merged_into_queue\); #194 \(merged_into_queue\); #197 \(queued\)/);
    assert.match(rendered, /Evidence refs \| 4 \| https:\/\/example.test\/pull\/300#issuecomment-215622762, pr:#189, pr:#194, pr:#197/);
  });

  test("prioritizes merged constituents in capped queue evidence rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue status prioritized" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "title_pr_list",
          constituent_prs: [
            { number: 178, status: "queued", evidence_refs: ["pr:#178"] },
            { number: 179, status: "queued", evidence_refs: ["pr:#179"] },
            { number: 180, status: "queued", evidence_refs: ["pr:#180"] },
            { number: 182, status: "queued", evidence_refs: ["pr:#182"] },
            { number: 185, status: "merged_into_queue", evidence_refs: ["pr:#185"] },
            { number: 189, status: "merged_into_queue", evidence_refs: ["pr:#189"] },
            { number: 190, status: "merged_into_queue", evidence_refs: ["pr:#190"] },
            { number: 191, status: "merged_into_queue", evidence_refs: ["pr:#191"] },
            { number: 192, status: "merged_into_queue", evidence_refs: ["pr:#192"] },
            { number: 193, status: "merged_into_queue", evidence_refs: ["pr:#193"] },
            { number: 194, status: "merged_into_queue", evidence_refs: ["pr:#194"] },
            { number: 197, status: "queued", evidence_refs: ["pr:#197"] },
            { number: 198, status: "queued", evidence_refs: ["pr:#198"] },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const numbersRow = rendered.split("\n").find((line) => line.startsWith("| Constituent PRs |"));
    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(numbersRow);
    assert.match(numbersRow, /#185, #189, #190, #191, #192, #193, #194, #178, 5 more/);
    assert.ok(statusRow);
    assert.match(statusRow, /#185 \(merged_into_queue\); #189 \(merged_into_queue\); #190 \(merged_into_queue\)/);
    assert.match(statusRow, /#194 \(merged_into_queue\); #178 \(queued\); 5 more \|$/);
  });

  test("keeps blocked and unknown constituent PR numbers visible in capped queue evidence rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "queue status prioritized" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            { number: 501, status: "queued", evidence_refs: ["pr:#501"] },
            { number: 502, status: "queued", evidence_refs: ["pr:#502"] },
            { number: 503, status: "queued", evidence_refs: ["pr:#503"] },
            { number: 504, status: "queued", evidence_refs: ["pr:#504"] },
            { number: 505, status: "queued", evidence_refs: ["pr:#505"] },
            { number: 506, status: "queued", evidence_refs: ["pr:#506"] },
            { number: 507, status: "queued", evidence_refs: ["pr:#507"] },
            { number: 508, status: "queued", evidence_refs: ["pr:#508"] },
            { number: 509, status: "blocked", evidence_refs: ["validation:509"] },
            { number: 510, status: "unknown", evidence_refs: ["validation:510"] },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const numbersRow = rendered.split("\n").find((line) => line.startsWith("| Constituent PRs |"));
    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(numbersRow);
    assert.match(numbersRow, /\| Constituent PRs \| 10 \| #509, #510, #501, #502, #503, #504, #505, #506, 2 more \|/);
    assert.ok(statusRow);
    assert.match(statusRow, /\| Constituent status \| 10 \| #509 \(blocked\); #510 \(unknown\); #501 \(queued\); #502 \(queued\); #503 \(queued\); #504 \(queued\); #505 \(queued\); #506 \(queued\); 2 more \|/);
  });

  test("keeps blocked and unknown constituent refs visible in capped evidence refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "queue refs prioritized" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            { number: 501, status: "queued", evidence_refs: ["pr:#501"] },
            { number: 502, status: "queued", evidence_refs: ["pr:#502"] },
            { number: 503, status: "queued", evidence_refs: ["pr:#503"] },
            { number: 504, status: "queued", evidence_refs: ["pr:#504"] },
            { number: 505, status: "queued", evidence_refs: ["pr:#505"] },
            { number: 506, status: "queued", evidence_refs: ["pr:#506"] },
            { number: 507, status: "queued", evidence_refs: ["pr:#507"] },
            { number: 508, status: "queued", evidence_refs: ["pr:#508"] },
            { number: 509, status: "blocked", evidence_refs: ["validation:509"] },
            { number: 510, status: "unknown", evidence_refs: ["validation:510"] },
            { number: 511, status: "queued", evidence_refs: ["pr:#511"] },
            { number: 512, status: "queued", evidence_refs: ["pr:#512"] },
            { number: 513, status: "queued", evidence_refs: ["pr:#513"] },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 13 \| validation:509, validation:510, pr:#501, pr:#502, pr:#503, pr:#504, pr:#505, pr:#506, pr:#507, pr:#508, 3 more \|/);
    assert.doesNotMatch(refsRow, /pr:#511, pr:#512, pr:#513/);
  });

  test("does not render merge commit table cells as constituent titles", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "RC1 Merge queue: PRs 191, 192, 193",
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://github.example.test/org/repo/pull/183#issuecomment-merge-commits",
            body: [
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "merge commit table modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    assert.ok(statusRow);
    assert.match(statusRow, /#191 \(merged_into_queue, Connector\/settings refresh\.\); #192 \(merged_into_queue, Carbon card-step rendering\.\); #193 \(merged_into_queue, Target-selection launch wiring\.\)/);
    assert.doesNotMatch(statusRow, /740e4fc9|ca4bee0e|bf3e7964|github\.example\.test\/org\/repo\/commit/);
    assert.doesNotMatch(statusRow, /Merged cleanly|Resolved fixture cleanup conflicts|Preserved target-selection launch wiring/);
    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /740e4fc9 \(#191\)/);
    assert.match(mergeCommitRow, /ca4bee0e \(#192\)/);
    assert.match(mergeCommitRow, /bf3e7964 \(#193\)/);
  });

  test("renders merge train queue titles from the merge model", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge train MRs !301 through !303" },
      {
        commits: [],
        comments: [],
      },
    );

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "merge train title modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const numbersRow = rendered.split("\n").find((line) => line.startsWith("| Constituent PRs |"));
    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(numbersRow);
    assert.match(numbersRow, /#301, #302, #303/);
    assert.ok(statusRow);
    assert.match(statusRow, /#301 \(queued\); #302 \(queued\); #303 \(queued\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /pr:#301, pr:#302, pr:#303/);
  });

  test("renders queue evidence inferred from cached PR detail aliases", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached detail queue has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({ queue_context: queueContext }),
    );

    assert.match(rendered, /Constituent PRs \| 2 \| #202, #201/);
    assert.match(rendered, /Constituent status \| 2 \| #202 \(validated\); #201 \(queued, API service, head abcdef12\)/);
    assert.match(rendered, /Validation evidence \| 2 \| failed: npm run aggregate-smoke; passed \[#202\]: npm run ui/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue-wide validation has 1 failed or blocked validation evidence item\(s\)\./);
  });

  test("renders one-constituent explicit validation-only queue evidence", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "single validation-only queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({ queue_context: queueContext }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Constituent PRs \| 1 \| #201/);
    assert.match(rendered, /Constituent status \| 1 \| #201 \(validated\)/);
    assert.match(rendered, /Validation evidence \| 1 \| passed \[#201\]: npm run api/);
    assert.match(rendered, /Evidence refs \| 2 \| https:\/\/example\.test\/pull\/203#issuecomment-single-validation, pr:#201/);
  });

  test("renders comma-separated inline validation fields from the merge model", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Manual queue" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-comma-fields",
            body: [
              "- Scope: https://gitlab.example.test/org/repo/-/merge_requests/221, Command: npm run test -- --grep \"foo, bar\", Result: failed",
              "- Package: packages/web, Validation: just ci, State: action_required",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "field summary has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Constituent PRs \| 1 \| #221/);
    assert.match(rendered, /Validation evidence \| 2 \| failed \[#221\]: npm run test -- --grep "foo, bar"; unknown \[packages\/web\]: just ci/);
    assert.match(rendered, /Unresolved blockers \| 2 \| ci_failed \(blocked\): Queue constituent PR #221 has 1 failed or blocked validation evidence item\(s\)\.; unknown \(unknown\): Queue validation scope packages\/web has 1 inconclusive validation evidence item\(s\)\./);
    assert.match(rendered, /Evidence refs \| 2 \| https:\/\/example.test\/pull\/203#issuecomment-comma-fields, pr:#221/);
  });

  test("renders merge request validation table evidence from the merge model", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge MRs !301 and !302" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/303#issuecomment-mr-validation-table",
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "MR validation table has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Constituent PRs \| 2 \| #301, #302/);
    assert.match(rendered, /Constituent status \| 2 \| #301 \(blocked\); #302 \(validated\)/);
    assert.match(rendered, /Validation evidence \| 2 \| failed \[#301\]: npm run mr-api; passed \[#302\]: pnpm test --filter mr-ui/);
    assert.match(rendered, /Evidence refs \| 3 \| https:\/\/example.test\/pull\/303#issuecomment-mr-validation-table, pr:#301, pr:#302/);
  });

  test("renders narrative validation result tables from the merge model", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "narrative validation table has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    const blockersRow = rendered.split("\n").find((line) => line.startsWith("| Unresolved blockers |"));

    assert.ok(validationRow);
    assert.match(validationRow, /blocked: Safari fresh chat/);
    assert.match(validationRow, /blocked \[packages\/chat\]: Focused Storybook timed out\./);
    assert.match(validationRow, /passed: Create LPAR workflow/);
    assert.ok(blockersRow);
    assert.match(blockersRow, /Queue-wide validation has 1 failed or blocked validation evidence item/);
    assert.match(blockersRow, /Queue validation scope packages\/chat has 1 failed or blocked validation evidence item/);
    assert.match(rendered, /Evidence refs \| 3 \| https:\/\/example.test\/pull\/183#issuecomment-rc1-validation, pr:#201, pr:#202/);
  });

  test("renders later narrative workflow evidence without stale prompt blockers", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "latest narrative validation passed" }],
      "2026-07-01T12:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    assert.ok(validationRow);
    assert.match(validationRow, /passed: Create LPAR workflow/);
    assert.match(validationRow, /passed: Edit LPAR workflow/);
    assert.match(validationRow, /4 superseded/);
    assert.doesNotMatch(validationRow, /blocked: Create LPAR final gate/);
    assert.doesNotMatch(validationRow, /blocked: Edit-LPAR rename workflow/);
    assert.doesNotMatch(validationRow, /blocked: Edit LPAR proposed-property prompt/);
    assert.doesNotMatch(validationRow, /blocked: Fresh live edit run/);
    assert.match(rendered, /\| Unresolved blockers \| 0 \| none \|/);
  });

  test("renders comprehensive queue-wide suite passes without stale broad failures", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "latest suite validation passed" }],
      "2026-07-01T12:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    assert.ok(validationRow);
    assert.match(validationRow, /2 superseded/);
    assert.match(validationRow, /passed: Full RC1 deterministic suite/);
    assert.doesNotMatch(validationRow, /failed: npm run test/);
    assert.doesNotMatch(validationRow, /failed: npm run test:storybook/);
    assert.match(rendered, /\| Unresolved blockers \| 0 \| none \|/);
  });

  test("renders comprehensive queue-wide passes before stale ordinary passing evidence", () => {
    const queueContext = inferMergeQueueContext(
      { title: "RC1 Merge queue: PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-old-passes",
            body: [
              "- PASS `npm ci`",
              "- PASS `npm run lint`",
              "- PASS `npm run build`",
              "- PASS `npm run docs`",
              "- PASS `npm run smoke`",
            ].join("\n"),
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-full-suite",
            body: "- Full RC1 deterministic suite passed from agent: run `1b4507932556e9a0`, 12/12 PASS.",
          },
          {
            html_url: "https://example.test/pull/203#issuecomment-post-check",
            body: "- PASS `npm run post-check`",
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "latest suite validation passed" }],
      "2026-07-01T12:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    assert.ok(validationRow);
    assert.match(validationRow, /5 superseded; passed: Full RC1 deterministic suite; passed: npm run post-check/);
    assert.doesNotMatch(validationRow, /npm ci/);
  });

  test("renders descriptive markdown validation links as PR scopes without label leakage", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "descriptive link validation has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#226\]: npm run descriptive-link/);
    assert.match(validationRow, /passed \[#227\]: npm run descriptive-field/);
    assert.match(validationRow, /blocked \[#228\]: npm run descriptive-table/);
    assert.doesNotMatch(validationRow, /API validation/);
    assert.doesNotMatch(validationRow, /Worker validation/);
    assert.doesNotMatch(validationRow, /MR validation/);
  });

  test("renders pipe-separated inline validation fields without label leakage", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "pipe field summary has blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const validationRow = rendered.split("\n").find((line) => line.startsWith("| Validation evidence |"));
    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#301\]: npm run pipe-field/);
    assert.match(validationRow, /failed \[packages\/api\]: npm run lint/);
    assert.match(validationRow, /passed \[#302\]: pnpm test --filter api/);
    assert.doesNotMatch(validationRow, /\| Command:/);
    assert.doesNotMatch(validationRow, /\| Result/);
  });

  test("renders base-branch merge commit conflict evidence without a constituent PR", () => {
    const queueContext = inferMergeQueueContext(
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
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Constituent PRs \| 2 \| #201, #202/);
    assert.match(rendered, /Merge commits \| 1 \| base1234/);
    assert.match(rendered, /Conflict files \| 1 \| packages\/api\/src\/server\.ts/);
    assert.match(rendered, /Evidence refs \| 3 \| commit:base1234, pr:#201, pr:#202/);
    assert.doesNotMatch(rendered, /base1234 \(#203\)/);
  });

  test("renders quoted base-branch merge commit conflict evidence", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202", baseRefName: "release/2026.07" },
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 1 \| remote20/);
    assert.match(rendered, /Conflict files \| 1 \| packages\/ui\/src\/release\.ts/);
    assert.match(rendered, /Evidence refs \| 3 \| commit:remote2026, pr:#201, pr:#202/);
    assert.doesNotMatch(rendered, /remote2026 \(#203\)/);
  });

  test("renders partial diff availability records with explicit defaults", () => {
    const availableRendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "pass", explanation: "context gathered" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        diff_availability: {
          available: "available",
          source: "   ",
        },
      }),
    );
    const unavailableRendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "blocked", explanation: "diff unavailable" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        diff_availability: {
          available: "false",
          error: "   ",
        },
      }),
    );
    const unknownRendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "unknown", explanation: "diff cache partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        diff_availability: {
          source: "gh-pr-diff",
        },
      }),
    );
    const aliasRendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "blocked", explanation: "diff unavailable" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        diffAvailability: {
          available: "   ",
          isAvailable: "timeout",
          provider: "gh-api",
          byteSize: 4096,
          error: "   ",
          errorMessage: "GitHub diff timed out.",
        },
      }),
    );
    const sizeAliasRendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "pass", explanation: "context gathered" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        diffAvailability: {
          available: "surprise",
          captured: "true",
          source: "gh-pr-diff",
          size: 0,
          byteSize: 4096,
        },
      }),
    );
    const maskedAliasRendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "blocked", explanation: "diff unavailable" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
    );

    const availableRow = availableRendered
      .split("\n")
      .find((line) => line.startsWith("| Diff availability |"));
    const unavailableRow = unavailableRendered
      .split("\n")
      .find((line) => line.startsWith("| Diff availability |"));
    const unknownRow = unknownRendered
      .split("\n")
      .find((line) => line.startsWith("| Diff availability |"));
    const aliasRow = aliasRendered
      .split("\n")
      .find((line) => line.startsWith("| Diff availability |"));
    const sizeAliasRow = sizeAliasRendered
      .split("\n")
      .find((line) => line.startsWith("| Diff availability |"));
    const maskedAliasRow = maskedAliasRendered
      .split("\n")
      .find((line) => line.startsWith("| Diff availability |"));

    assert.ok(availableRow);
    assert.match(availableRow, /\| Diff availability \| pass \| Captured from unknown \(size unavailable\)\. \|/);
    assert.doesNotMatch(availableRow, /Captured from\s+\(/);
    assert.doesNotMatch(availableRow, /0 bytes/);
    assert.ok(unavailableRow);
    assert.match(unavailableRow, /\| Diff availability \| blocked \| Diff unavailable\. \|/);
    assert.doesNotMatch(unavailableRow, /false/);
    assert.doesNotMatch(unavailableRow, /\|\s*\|$/);
    assert.ok(unknownRow);
    assert.match(unknownRow, /\| Diff availability \| unknown \| Diff availability is unknown\. \|/);
    assert.ok(aliasRow);
    assert.match(aliasRow, /\| Diff availability \| blocked \| GitHub diff timed out\. \|/);
    assert.ok(sizeAliasRow);
    assert.match(sizeAliasRow, /\| Diff availability \| pass \| Captured from gh-pr-diff \(4096 bytes\)\. \|/);
    assert.ok(maskedAliasRow);
    assert.match(maskedAliasRow, /\| Diff availability \| blocked \| Diff timed out\. \|/);
    assert.match(maskedAliasRendered, /diff:timeout/);
  });

  test("renders active merge-tree conflict files from PR context", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected in 3 file(s)." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        conflicts: {
          has_conflicts: true,
          conflict_count: 3,
          conflicting_files: [
            "packages/api/src/routes.ts",
            "apps/web/src/App.tsx",
            "packages/ui/src/Card|Panel.tsx",
          ],
        },
        merge_blockers: [
          {
            kind: "merge_conflicts",
            status: "blocked",
            summary: "Merge conflicts detected in 3 file(s).",
            evidence_refs: ["git:merge-tree"],
          },
        ],
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /3 active conflict file\(s\): apps\/web\/src\/App\.tsx, packages\/api\/src\/routes\.ts, packages\/ui\/src\/Card\\\|Panel\.tsx/);
    assert.doesNotMatch(conflictRow, /Card\|Panel/);
    assert.ok(refsRow);
    assert.match(refsRow, /git:merge-tree/);
  });

  test("renders serialized active conflict flags from cached PR context", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected in 2 file(s)." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        mergeConflicts: {
          hasConflicts: "true",
          conflictCount: 2,
          conflictingFiles: ["packages/api/src/routes.ts"],
        },
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /2 active conflict file\(s\): packages\/api\/src\/routes\.ts \(1 listed\)/);
  });

  test("renders collection-shaped active conflict file aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected in 2 file(s)." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        mergeConflicts: {
          hasConflicts: true,
          conflictCount: 1,
          conflictFiles: {
            edges: [
              { node: { path: "packages/api/src/routes.ts" } },
              { node: "apps/web/src/App.tsx" },
            ],
          },
          evidenceRefs: {
            nodes: ["conflict:cached", { ref: "git:merge-tree --name-only" }],
          },
        },
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /2 active conflict file\(s\): apps\/web\/src\/App\.tsx, packages\/api\/src\/routes\.ts/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 2 \| conflict:cached, git:merge-tree --name-only \|/);
  });

  test("renders useful conflict aliases when canonical conflict records are unknown", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected in 2 file(s)." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /2 active conflict file\(s\): packages\/api\/src\/routes\.ts \(1 listed\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /conflict:cached/);
  });

  test("renders explicit active conflict counts and refs without a blocker row", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        conflicts: {
          has_conflicts: true,
          conflict_count: 3,
          conflicting_files: ["packages/api/src/routes.ts"],
          evidence_refs: [" conflict:merge-tree ", " ", "conflict:merge-tree"],
        },
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /3 active conflict file\(s\): packages\/api\/src\/routes\.ts \(1 listed\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 1 \| conflict:merge-tree \|/);
    assert.doesNotMatch(refsRow, /git:merge-tree/);
    assert.doesNotMatch(refsRow, /\sconflict:merge-tree\s*,/);
  });

  test("renders active conflicts with unavailable file counts without saying zero files", () => {
    const rendered = renderReviewGateStatusComment(
      [{
        rule: "merge-conflicts",
        status: "blocked",
        explanation: "Merge conflicts detected, but the conflicting file count was unavailable.",
      }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        conflicts: {
          has_conflicts: true,
          conflicting_files: [],
        },
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /Active merge conflicts detected; file count and file list unavailable\./);
    assert.doesNotMatch(conflictRow, /0 active conflict file/);
    assert.ok(refsRow);
    assert.match(refsRow, /git:merge-tree/);
  });

  test("falls back to merge-tree evidence when explicit conflict refs are blank", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        conflicts: {
          has_conflicts: true,
          conflicting_files: [],
          evidence_refs: ["", "   "],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 1 \| git:merge-tree \|/);
  });

  test("does not let explicit active conflict counts understate listed files", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected in 2 file(s)." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        conflicts: {
          has_conflicts: true,
          conflict_count: 1,
          conflicting_files: [
            "packages/api/src/routes.ts",
            "apps/web/src/App.tsx",
          ],
        },
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /2 active conflict file\(s\): apps\/web\/src\/App\.tsx, packages\/api\/src\/routes\.ts/);
    assert.doesNotMatch(conflictRow, /1 active conflict file/);
  });

  test("counts and renders only unique listed active conflict file names", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "Merge conflicts detected in 2 file(s)." }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
      }),
    );

    const conflictRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Merge conflicts |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /2 active conflict file\(s\): apps\/web\/src\/App\.tsx, packages\/api\/src\/routes\.ts/);
    assert.doesNotMatch(conflictRow, /3 active conflict file/);
    assert.doesNotMatch(conflictRow, /5 active conflict file/);
  });

  test("renders normalized merge commit shapes with conflicts and refs", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 3 \| oid2010 \(#201\), sha2020 \(#202\), sha2030 \(#203\)/);
    assert.match(rendered, /Conflict files \| 3 \| packages\/api\/src\/top\.ts, packages\/ui\/src\/view\.ts, packages\/workers\/src\/job\.ts/);
    assert.match(rendered, /Evidence refs \| 6 \| commit:oid2010, commit:sha2020, commit:sha2030, pr:#201, pr:#202, pr:#203/);
  });

  test("renders modeled merge commit source refs and conflict aliases", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge queue: PRs #201 and #202" },
      {
        commits: [
          {
            oid: "oid2010",
            message: "Merge PR #201",
            evidenceRefs: {
              nodes: ["commit:source-201", { ref: "pr:#201" }],
            },
            conflictFiles: {
              nodes: [" packages/api/src/node.ts ", { path: "apps/web/src/App.tsx" }],
            },
          },
          {
            sha: "sha2020",
            commit: {
              messageHeadline: "Merge pull request #202",
              evidence_refs: {
                edges: [
                  { node: "commit:nested-source-202" },
                  { node: { value: "pr:#202" } },
                ],
              },
              conflictingFiles: {
                edges: [
                  { node: { filename: "packages/workers/src/job.ts" } },
                ],
              },
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Conflict files \| 3 \| apps\/web\/src\/App\.tsx, packages\/api\/src\/node\.ts, packages\/workers\/src\/job\.ts/);
    assert.match(rendered, /Evidence refs \| 6 \| commit:source-201, pr:#201, commit:oid2010, commit:nested-source-202, pr:#202, commit:sha2020/);
  });

  test("renders PR merge commit subjects without hash markers as queue evidence", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge queue: PRs 201 and 202" },
      {
        commits: [
          { sha: "plain201", message: "Merge PR 201 from org/api" },
          { sha: "plain202", commit: { messageHeadline: "Merge pull request 202 from org/ui" } },
        ],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({ queue_context: queueContext }),
    );

    assert.match(rendered, /Constituent PRs \| 2 \| #201, #202/);
    assert.match(rendered, /Merge commits \| 2 \| plain201 \(#201\), plain202 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:plain201, commit:plain202, pr:#201, pr:#202/);
  });

  test("renders id-based GitLab merge commit refs", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [
          {
            id: "gitlab201",
            message: "Merge MR !201",
          },
          {
            commit: {
              id: "nested202",
              message: "Refresh UI shell (!202)",
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue commits modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| gitlab20 \(#201\), nested20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:gitlab201, commit:nested202, pr:#201, pr:#202/);
  });

  test("renders explicit commit evidence refs as modeled merge commit identifiers", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue commits modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| evidence \(#201\), nested20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:evidence201, commit:nested202, pr:#201, pr:#202/);
    assert.doesNotMatch(rendered, /Merge commits \| 2 \| unknown/);
  });

  test("renders evidence-ref-only PR context commits as queue lineage", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue commits modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| evidence \(#201\), nested20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 5 \| commit:evidence201, pr:#201, commit:nested202, merge-request:!202, pr:#202/);
    assert.doesNotMatch(rendered, /alias203/);
    assert.doesNotMatch(rendered, /Merge commits \| 2 \| unknown/);
  });

  test("renders PR detail commit fallback as merge queue evidence", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| detail20 \(#201\), detail20 \(#202\)/);
    assert.match(rendered, /Conflict files \| 2 \| packages\/api\/src\/detail\.ts, packages\/ui\/src\/detail\.ts/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:detail201, commit:detail202, pr:#201, pr:#202/);
  });

  test("renders evidence-ref-only PR detail commits as queue evidence", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "cached detail queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| detail20 \(#201\), detail20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 5 \| commit:detail201, pr:#201, commit:detail202, merge-request:!202, pr:#202/);
    assert.doesNotMatch(rendered, /alias203/);
    assert.doesNotMatch(rendered, /Merge commits \| 2 \| unknown/);
  });

  test("renders cached PR detail commit alias fallback as merge queue evidence", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
        commits: [null, {}],
        commitNodes: [
          {
            oid: "detail201",
            message: "Merge PR #201",
          },
          {
            oid: "detail202",
            message: "Merge PR #202",
          },
        ],
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "cached detail queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| detail20 \(#201\), detail20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:detail201, commit:detail202, pr:#201, pr:#202/);
  });

  test("renders cached PR detail commit edge aliases as merge queue evidence", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
        commits: [],
        commit_edges: {
          edges: [
            {
              node: {
                oid: "detail201",
                message: "Merge PR #201",
              },
            },
            {
              node: {
                oid: "detail202",
                message: "Merge PR #202",
              },
            },
          ],
        },
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "cached detail queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| detail20 \(#201\), detail20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:detail201, commit:detail202, pr:#201, pr:#202/);
  });

  test("renders cached PR detail commit aliases after blank canonical detail commit rows", () => {
    const queueContext = inferMergeQueueContext(
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
          {
            oid: "detail202",
            message: "Merge PR #202",
          },
        ],
      },
      {
        commits: [],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "cached detail queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| detail20 \(#201\), detail20 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:detail201, commit:detail202, pr:#201, pr:#202/);
  });

  test("renders cached PR context commit aliases after blank canonical commit rows", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #201 and #202",
      },
      {
        commits: [
          { sha: " ", oid: "", message: " ", commit: { messageHeadline: "" } },
        ],
        commitNodes: [
          {
            oid: "context201",
            message: "Merge PR #201",
          },
          {
            oid: "context202",
            message: "Merge PR #202",
          },
        ],
        comments: [],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "cached context queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| context2 \(#201\), context2 \(#202\)/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:context201, commit:context202, pr:#201, pr:#202/);
  });

  test("renders edge commit collections with normalized message aliases", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 3 \| snake201 \(#201\), commit20 \(#202\), subject2 \(#203\)/);
    assert.match(rendered, /Conflict files \| 3 \| packages\/api\/src\/snake\.ts, packages\/ui\/src\/commit-message\.ts, packages\/workers\/src\/subject\.ts/);
    assert.match(rendered, /Evidence refs \| 6 \| commit:snake201, commit:commit202, commit:subject203, pr:#201, pr:#202, pr:#203/);
    assert.doesNotMatch(rendered, /detail999/);
  });

  test("renders plain merge commit conflict blocks as conflict-file evidence", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 2 \| plain201 \(#201\), plain202 \(#202\)/);
    assert.match(rendered, /Conflict files \| 3 \| apps\/web\/src\/plain\.ts, packages\/api\/src\/plain\.ts, packages\/ui\/src\/card\.ts/);
    assert.match(rendered, /Evidence refs \| 4 \| commit:plain201, commit:plain202, pr:#201, pr:#202/);
    assert.doesNotMatch(rendered, /Resolved by keeping/);
    assert.doesNotMatch(rendered, /- packages\/ui/);
  });

  test("renders cached merge commit conflict file aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue conflicts" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              sha: "alias201",
              pr_number: 201,
              conflictFiles: [" packages/api/src/app.ts ", "apps/web/src/App.tsx"],
              evidence_refs: ["commit:alias201"],
            },
            {
              sha: "alias202",
              pr_number: 202,
              conflicting_files: ["apps/web/src/App.tsx", "packages/workers/src/job.ts"],
              evidence_refs: ["commit:alias202"],
            },
            {
              sha: "alias203",
              pr_number: 203,
              conflictingFiles: [" packages/api/src/app.ts ", ""],
              evidence_refs: ["commit:alias203"],
            },
            {
              sha: "alias204",
              pr_number: 204,
              conflictFile: "packages/ui/src/button.ts",
              evidence_refs: ["commit:alias204"],
            },
            {
              sha: "alias205",
              pr_number: 205,
              conflicting_file: " packages/workers/src/job.ts ",
              evidence_refs: ["commit:alias205"],
            },
            {
              sha: "alias206",
              pr_number: 206,
              commit: {
                conflictFiles: ["packages/config/src/nested.ts"],
              },
              evidence_refs: ["commit:alias206"],
            },
            {
              sha: "alias207",
              pr_number: 207,
              commit: {
                conflicting_file: " packages/ui/src/nested.ts ",
              },
              evidence_refs: ["commit:alias207"],
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const conflictRow = rendered.split("\n").find((line) => line.startsWith("| Conflict files |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /\| Conflict files \| 6 \| apps\/web\/src\/App\.tsx, packages\/api\/src\/app\.ts, packages\/config\/src\/nested\.ts, packages\/ui\/src\/button\.ts, packages\/ui\/src\/nested\.ts, packages\/workers\/src\/job\.ts \|/);
    assert.doesNotMatch(conflictRow, /\| Conflict files \| 0 \| none \|/);
  });

  test("renders connection-shaped cached merge commit conflict file aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue conflicts" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              sha: "conn201",
              pr_number: 201,
              conflictFiles: {
                nodes: [" packages/api/src/node.ts ", { path: "apps/web/src/App.tsx" }],
              },
            },
            {
              sha: "conn202",
              pr_number: 202,
              conflictingFiles: {
                edges: [
                  { node: "apps/web/src/App.tsx" },
                  { node: { filename: "packages/workers/src/job.ts" } },
                ],
              },
            },
            {
              sha: "conn203",
              pr_number: 203,
              commit: {
                conflictFiles: {
                  edges: [
                    { node: { newPath: "packages/config/src/nested.ts" } },
                  ],
                },
              },
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const conflictRow = rendered.split("\n").find((line) => line.startsWith("| Conflict files |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /\| Conflict files \| 4 \| apps\/web\/src\/App\.tsx, packages\/api\/src\/node\.ts, packages\/config\/src\/nested\.ts, packages\/workers\/src\/job\.ts \|/);
    assert.doesNotMatch(conflictRow, /\| Conflict files \| 0 \| none \|/);
  });

  test("renders conflict-file-only cached merge commit rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue conflicts" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              conflictFiles: {
                nodes: [
                  { path: "packages/api/src/app.ts" },
                  "apps/web/src/App.tsx",
                ],
              },
            },
            {
              commit: {
                conflictingFiles: {
                  edges: [
                    { node: { filename: "packages/workers/src/job.ts" } },
                  ],
                },
              },
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const conflictRow = rendered.split("\n").find((line) => line.startsWith("| Conflict files |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /\| Conflict files \| 3 \| apps\/web\/src\/App\.tsx, packages\/api\/src\/app\.ts, packages\/workers\/src\/job\.ts \|/);
  });

  test("renders cached merge commit message conflict blocks", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue conflict messages" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              sha: "message201",
              subject: "Merge PR #201",
              message_body: [
                "# Conflicts:",
                "#\tpackages/api/src/message.ts",
                "    apps/web/src/message.ts",
                "",
                "Resolved by keeping the queue head API shape.",
              ].join("\n"),
              evidence_refs: ["commit:message201"],
            },
            {
              sha: "nested202",
              commit: {
                messageHeadline: "Merge PR #202",
                messageBody: [
                  "Conflicts:",
                  "  - packages/ui/src/card.ts",
                ].join("\n"),
              },
              evidence_refs: ["commit:nested202"],
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const conflictRow = rendered.split("\n").find((line) => line.startsWith("| Conflict files |"));

    assert.ok(conflictRow);
    assert.match(conflictRow, /apps\/web\/src\/message\.ts/);
    assert.match(conflictRow, /packages\/api\/src\/message\.ts/);
    assert.match(conflictRow, /packages\/ui\/src\/card\.ts/);
    assert.doesNotMatch(conflictRow, /Resolved by keeping/);
    assert.doesNotMatch(conflictRow, /\| Conflict files \| 0 \| none \|/);
  });

  test("renders merge commits without sha as unknown and omits empty refs", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Merge commits \| 1 \| unknown \(#201\)/);
    assert.match(rendered, /Conflict files \| 1 \| packages\/api\/src\/routes\.ts/);
    assert.match(rendered, /Evidence refs \| 2 \| pr:#201, pr:#202/);
    assert.doesNotMatch(rendered, /commit:/);
    assert.doesNotMatch(rendered, /Evidence refs \| 3/);
  });

  test("renders whitespace-only cached merge commit SHAs as unknown", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue head modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [
            {
              number: 201,
              title: null,
              url: null,
              head_sha: null,
              status: "merged_into_queue",
              evidence_refs: ["pr:#201"],
            },
          ],
          merge_commits: [
            {
              sha: "   ",
              pr_number: 201,
              subject: "Merge PR #201",
              conflict_files: [],
              evidence_refs: ["   "],
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    assert.match(rendered, /Merge commits \| 1 \| unknown \(#201\)/);
    assert.match(rendered, /Evidence refs \| 1 \| pr:#201/);
    assert.doesNotMatch(rendered, /commit:/);
  });

  test("renders cached merge commit identifier aliases and evidence refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            { oid: " oid201 ", pr_number: 201, evidence_refs: ["commit:explicit"] },
            { id: " id202 ", pr_number: 202, evidence_refs: [" "] },
            { commit: { oid: " nested203 " }, pr_number: 203 },
            { oid: "oid204", commit: { mergeRequestNumber: "204" } },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /oid201 \(#201\), id202 \(#202\), nested20 \(#203\), oid204 \(#204\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:explicit/);
    assert.match(refsRow, /commit:oid201/);
    assert.match(refsRow, /commit:id202/);
    assert.match(refsRow, /commit:nested203/);
    assert.match(refsRow, /commit:oid204/);
    assert.match(refsRow, /pr:#204/);
  });

  test("renders cached merge commit PR numbers from messages and URLs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            { sha: "abc201000000", subject: "Merge pull request #201 from org/api" },
            { sha: "def202000000", message: "Merge merge request !202 from group/ui" },
            { sha: "ghi203000000", commit: { messageHeadline: "Merge PR #203 from org/worker" } },
            { sha: "jkl204000000", web_url: "https://gitlab.example.test/org/repo/-/merge_requests/204" },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(
      mergeCommitRow,
      /abc20100 \(#201\), def20200 \(#202\), ghi20300 \(#203\), jkl20400 \(#204\)/,
    );
    assert.ok(refsRow);
    assert.match(refsRow, /commit:abc201000000/);
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /commit:def202000000/);
    assert.match(refsRow, /pr:#202/);
    assert.match(refsRow, /commit:ghi203000000/);
    assert.match(refsRow, /pr:#203/);
    assert.match(refsRow, /commit:jkl204000000/);
    assert.match(refsRow, /pr:#204/);
  });

  test("renders cached nested merge commit PR numbers from URL aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            { oid: "oid205", commit: { pullRequestUrl: "https://github.example.test/org/repo/pull/205" } },
            { oid: "oid206", commit: { merge_request_url: "https://gitlab.example.test/org/repo/-/merge_requests/206" } },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /oid205 \(#205\), oid206 \(#206\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:oid205/);
    assert.match(refsRow, /pr:#205/);
    assert.match(refsRow, /https:\/\/github\.example\.test\/org\/repo\/pull\/205/);
    assert.match(refsRow, /https:\/\/gitlab\.example\.test\/org\/repo\/-\/merge_requests\/206/);
    assert.match(refsRow, /commit:oid206/);
    assert.match(refsRow, /pr:#206/);
  });

  test("renders cached GitLab trailer merge commit lineage", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              sha: "gitlab205000000",
              message: [
                "Merge branch 'feature/api' into 'queue/main'",
                "",
                "See merge request org/repo!205",
              ].join("\n"),
            },
            {
              sha: "ordinary206000000",
              message: "Document API release\n\nSee merge request org/repo!206",
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /gitlab20 \(#205\), ordinary/);
    assert.doesNotMatch(mergeCommitRow, /#206/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:gitlab205000000/);
    assert.match(refsRow, /pr:#205/);
    assert.match(refsRow, /commit:ordinary206000000/);
    assert.doesNotMatch(refsRow, /pr:#206/);
  });

  test("renders cached GitLab trailer lineage split across headline and body aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              sha: "top210000000",
              subject: "Merge branch 'feature/api' into 'queue/main'",
              body: "See merge request org/repo!210",
            },
            {
              sha: "nested211000000",
              commit: {
                messageHeadline: "Merge branch 'feature/ui' into 'queue/main'",
                messageBody: "See merge request org/repo!211",
              },
            },
            {
              sha: "ordinary212000000",
              subject: "Document release",
              body: "See merge request org/repo!212",
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /top21000 \(#210\), nested21 \(#211\), ordinary/);
    assert.doesNotMatch(mergeCommitRow, /#212/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:top210000000/);
    assert.match(refsRow, /pr:#210/);
    assert.match(refsRow, /commit:nested211000000/);
    assert.match(refsRow, /pr:#211/);
    assert.match(refsRow, /commit:ordinary212000000/);
    assert.doesNotMatch(refsRow, /pr:#212/);
  });

  test("renders cached GitLab noun-style merge request subjects", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            { sha: "gitlab214000000", subject: "Merge request !214 from group/project" },
            { sha: "ordinary215000000", subject: "Merge request handling for release 215" },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /gitlab21 \(#214\), ordinary/);
    assert.doesNotMatch(mergeCommitRow, /#215/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:gitlab214000000/);
    assert.match(refsRow, /pr:#214/);
    assert.match(refsRow, /commit:ordinary215000000/);
    assert.doesNotMatch(refsRow, /pr:#215/);
  });

  test("renders cached merged PR and MR subjects", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            { sha: "ado201000000", subject: "Merged PR 201: API update" },
            { sha: "ado202000000", subject: "Merged pull request 202: UI update" },
            { sha: "ado203000000", subject: "Merged MR !203: GitLab update" },
            { sha: "ordinary204000000", subject: "Merged feature branch for release 204" },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /ado20100 \(#201\), ado20200 \(#202\), ado20300 \(#203\), ordinary/);
    assert.doesNotMatch(mergeCommitRow, /#204/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:ado201000000/);
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /commit:ado202000000/);
    assert.match(refsRow, /pr:#202/);
    assert.match(refsRow, /commit:ado203000000/);
    assert.match(refsRow, /pr:#203/);
    assert.match(refsRow, /commit:ordinary204000000/);
    assert.doesNotMatch(refsRow, /pr:#204/);
  });

  test("does not render malformed merge commit PR numbers", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [],
          merge_commits: [
            {
              sha: "zero0000",
              pr_number: 0,
              subject: "Malformed zero PR number",
              conflict_files: [],
              evidence_refs: ["commit:zero0000"],
            },
            {
              sha: "negative1",
              pr_number: -1,
              subject: "Malformed negative PR number",
              conflict_files: [],
              evidence_refs: ["commit:negative1"],
            },
            {
              sha: "string20",
              pr_number: "201",
              subject: "Cached numeric string PR number",
              conflict_files: [],
              evidence_refs: ["commit:string20"],
            },
            {
              sha: "badstr20",
              pr_number: "not-a-number",
              subject: "Malformed non-numeric PR number",
              conflict_files: [],
              evidence_refs: ["commit:badstr20"],
            },
          ],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const mergeCommitRow = rendered.split("\n").find((line) => line.startsWith("| Merge commits |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(mergeCommitRow);
    assert.match(mergeCommitRow, /\| Merge commits \| 4 \| zero0000, negative, string20 \(#201\), badstr20 \|/);
    assert.doesNotMatch(mergeCommitRow, /#0/);
    assert.doesNotMatch(mergeCommitRow, /#-1/);
    assert.doesNotMatch(mergeCommitRow, /#not-a-number/);
    assert.ok(refsRow);
    assert.match(refsRow, /commit:zero0000/);
    assert.match(refsRow, /commit:negative1/);
    assert.match(refsRow, /commit:string20/);
  });

  test("renders queue constituent titles and head SHAs with safe table escaping", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            {
              number: 201,
              title: "Renderer | cleanup @team <script> `quoted`",
              url: null,
              head_sha: "abcdef1234567890",
              status: "validated",
              evidence_refs: ["pr:#201"],
            },
            {
              number: 202,
              title: "Worker update",
              url: null,
              head_sha: "1234567",
              status: "queued",
              evidence_refs: ["pr:#202"],
            },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.ok(
      statusRow.includes(
        "#201 (validated, Renderer \\| cleanup &#64;team &lt;script&gt; &#96;quoted&#96;, head abcdef12)",
      ),
    );
    assert.ok(statusRow.includes("#202 (queued, Worker update, head 1234567)"));
    assert.doesNotMatch(statusRow, /@team/);
    assert.doesNotMatch(statusRow, /<script>/);
    assert.doesNotMatch(statusRow, /`quoted`/);
  });

  test("trims cached queue constituent title and head SHA hints before rendering", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            {
              number: 201,
              title: "   ",
              url: null,
              head_sha: "   ",
              status: "validated",
              evidence_refs: ["pr:#201"],
            },
            {
              number: 202,
              title: "  Worker update  ",
              url: null,
              head_sha: "  1234567890abcdef  ",
              status: "queued",
              evidence_refs: ["pr:#202"],
            },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(validated\); #202 \(queued, Worker update, head 12345678\)/);
    assert.doesNotMatch(statusRow, /head\s{2,}/);
    assert.doesNotMatch(statusRow, /validated,\s+\)/);
  });

  test("renders cached queue constituent head and evidence ref aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            {
              number: 201,
              title: "API update",
              url: null,
              headSha: " abcdef123456 ",
              status: "validated",
              evidenceRefs: [" pr:#201 ", "validation:201"],
            },
            {
              number: 202,
              title: "UI update",
              url: null,
              head_oid: " 1234567890abcdef ",
              status: "queued",
              evidence_refs: ["pr:#202"],
            },
            {
              number: 203,
              title: "Worker update",
              url: null,
              headOid: " fedcba987654 ",
              status: "queued",
              evidenceRefs: ["pr:#203"],
            },
            {
              number: 204,
              name: "Provider update",
              url: null,
              head: { oid: " 9876543210fedcba " },
              state: "success",
              evidenceRefs: ["pr:#204"],
            },
            {
              prNumber: "205",
              title: "String number update",
              status: "queued",
            },
            {
              iid: "206",
              subject: "GitLab MR update",
              web_url: "https://gitlab.example.test/org/repo/-/merge_requests/206",
              state: "success",
            },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(validated, API update, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI update, head 12345678\)/);
    assert.match(statusRow, /#203 \(queued, Worker update, head fedcba98\)/);
    assert.match(statusRow, /#204 \(validated, Provider update, head 98765432\)/);
    assert.match(statusRow, /#205 \(queued, String number update\)/);
    assert.match(statusRow, /#206 \(validated, GitLab MR update\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /validation:201/);
    assert.match(refsRow, /pr:#202/);
    assert.match(refsRow, /pr:#203/);
    assert.match(refsRow, /pr:#204/);
    assert.match(refsRow, /pr:#205/);
    assert.match(refsRow, /https:\/\/gitlab\.example\.test\/org\/repo\/-\/merge_requests\/206/);
  });

  test("renders cached camelCase queue context arrays", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue evidence failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          isQueue: "true",
          strategy: "mergeCommits",
          constituentPrs: [
            { prNumber: 201, status: "validated", title: "API update", headSha: "abcdef123456", evidenceRefs: ["pr:#201"] },
            { pullNumber: 202, status: "queued", title: "UI update", evidenceRefs: ["pr:#202"] },
          ],
          mergeCommits: [
            { oid: " oid201 ", prNumber: 201, conflictFiles: ["packages/api/src/app.ts"], evidenceRefs: ["commit:explicit"] },
            { id: " id202 ", pullNumber: 202, evidenceRefs: ["commit:id202"] },
          ],
          validationEvidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed" },
          ],
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
        },
      }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Strategy: merge_commits/);
    assert.match(rendered, /Constituent PRs \| 2 \| #201, #202/);
    assert.match(rendered, /Constituent status \| 2 \| #201 \(validated, API update, head abcdef12\); #202 \(queued, UI update\)/);
    assert.match(rendered, /Merge commits \| 2 \| oid201 \(#201\), id202 \(#202\)/);
    assert.match(rendered, /Conflict files \| 1 \| packages\/api\/src\/app\.ts/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#201\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #201 has 1 failed validation evidence item\./);
    assert.match(rendered, /Evidence refs \| 7 \| validation:failed, queue:blocker, commit:explicit, commit:oid201, commit:id202, pr:#201, pr:#202/);
  });

  test("renders cached queue context aliases after blank canonical queue rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue alias evidence failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          isQueue: "true",
          strategy: "mergeCommits",
          constituent_prs: [{ number: "", title: " ", status: "" }],
          constituentPrs: [
            { prNumber: 201, status: "validated", title: "API update", evidenceRefs: ["pr:#201"] },
          ],
          merge_commits: [{ oid: "", message: " " }],
          mergeCommits: [
            { oid: " oid201 ", prNumber: 201, evidenceRefs: ["commit:explicit"] },
          ],
          validation_evidence: [{ command: " ", status: "", scope: "" }],
          validationEvidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed" },
          ],
          unresolved_blockers: [{ kind: "", status: " ", summary: "" }],
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
        },
      }),
    );

    assert.match(rendered, /Constituent PRs \| 1 \| #201/);
    assert.match(rendered, /Constituent status \| 1 \| #201 \(validated, API update\)/);
    assert.match(rendered, /Merge commits \| 1 \| oid201 \(#201\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#201\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #201 has 1 failed validation evidence item\./);
    assert.match(rendered, /Evidence refs \| 5 \| validation:failed, queue:blocker, commit:explicit, commit:oid201, pr:#201/);
  });

  test("renders cached queue context connection collections", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue connection evidence failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          isQueue: true,
          strategy: "mergeCommits",
          constituentPrs: {
            nodes: [
              { prNumber: 201, status: "validated", title: "API node", headSha: "abcdef123456", evidenceRefs: ["pr:#201"] },
              { pullNumber: 202, status: "queued", title: "UI node", evidenceRefs: ["pr:#202"] },
              null,
            ],
          },
          mergeCommits: {
            edges: [
              { node: { oid: " oid201 ", prNumber: 201, conflictFiles: ["packages/api/src/node.ts"], evidenceRefs: ["commit:explicit"] } },
              { node: { id: " id202 ", pullNumber: 202, evidenceRefs: ["commit:id202"] } },
              { node: null },
            ],
          },
          validationEvidence: {
            edges: [
              { node: { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed" } },
            ],
          },
          unresolvedBlockers: {
            nodes: [
              {
                kind: "ci_failed",
                status: "blocked",
                summary: "Queue constituent PR #201 has 1 failed validation evidence item.",
                evidenceRefs: ["queue:blocker"],
              },
            ],
          },
        },
      }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Strategy: merge_commits/);
    assert.match(rendered, /Constituent PRs \| 2 \| #201, #202/);
    assert.match(rendered, /Constituent status \| 2 \| #201 \(validated, API node, head abcdef12\); #202 \(queued, UI node\)/);
    assert.match(rendered, /Merge commits \| 2 \| oid201 \(#201\), id202 \(#202\)/);
    assert.match(rendered, /Conflict files \| 1 \| packages\/api\/src\/node\.ts/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#201\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #201 has 1 failed validation evidence item\./);
    assert.match(rendered, /Evidence refs \| 7 \| validation:failed, queue:blocker, commit:explicit, commit:oid201, commit:id202, pr:#201, pr:#202/);
  });

  test("renders cached queue context node and edge alias collections", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached queue alias edge evidence failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          isQueue: true,
          strategy: "mergeCommits",
          constituentEdges: [
            { node: { prNumber: 201, status: "validated", title: "API edge", evidenceRefs: ["pr:#201"] } },
          ],
          mergeCommitEdges: {
            edges: [
              { node: { oid: "merge201", prNumber: 201, evidenceRefs: ["commit:explicit"] } },
            ],
          },
          validationEdges: [
            { node: { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed" } },
          ],
          unresolvedBlockerEdges: [
            {
              node: {
                kind: "ci_failed",
                status: "blocked",
                summary: "Queue validation failed.",
                evidenceRefs: ["queue:blocker"],
              },
            },
          ],
        },
      }),
    );

    assert.match(rendered, /Constituent PRs \| 1 \| #201/);
    assert.match(rendered, /Constituent status \| 1 \| #201 \(validated, API edge\)/);
    assert.match(rendered, /Merge commits \| 1 \| merge201 \(#201\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#201\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue validation failed\./);
    assert.match(rendered, /Evidence refs \| 5 \| validation:failed, queue:blocker, commit:explicit, commit:merge201, pr:#201/);
  });

  test("renders cached queue context MR number aliases as queue lineage", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached MR alias evidence failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          isQueue: true,
          strategy: "mergeCommits",
          constituentPrs: [
            { mrNumber: "206", status: "validated", title: "GitLab MR", evidenceRefs: ["merge-request:!206"] },
          ],
          mergeCommits: [
            { oid: "merge206", mr_iid: "206", evidenceRefs: ["commit:explicit206"] },
          ],
          validationEvidence: [
            { command: "npm test", status: "failed", mrNumber: "206", evidence_ref: "validation:206" },
          ],
        },
      }),
    );

    assert.match(rendered, /Constituent PRs \| 1 \| #206/);
    assert.match(rendered, /Constituent status \| 1 \| #206 \(validated, GitLab MR\)/);
    assert.match(rendered, /Merge commits \| 1 \| merge206 \(#206\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#206\]: npm test/);
    assert.match(rendered, /Evidence refs \| 4 \| validation:206, commit:explicit206, commit:merge206, merge-request:!206/);
  });

  test("renders explicit refs from edge-shaped blocker and nested lineage records", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "edge-shaped refs failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            cursor: "pending",
            node: {
              kind: "ci_pending",
              status: "pending",
              summary: "CI is pending.",
              evidenceRefs: ["blocker:pending"],
            },
          },
          {
            cursor: "blocked",
            node: {
              kind: "review_required",
              status: "blocked",
              summary: "Review is required.",
              evidenceRefs: ["blocker:blocked"],
            },
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "mergeCommits",
          constituent_prs: [
            {
              cursor: "constituent-223",
              node: {
                prNumber: 223,
                status: "queued",
                evidenceRefs: ["pr:#223"],
              },
            },
          ],
          merge_commits: [
            {
              node: {
                oid: "edge223",
                commit: {
                  cursor: "nested-commit",
                  node: {
                    evidenceRefs: ["commit:nested-explicit"],
                    messageHeadline: "Merge PR #223",
                  },
                },
              },
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| review_required \| blocked \| Review is required\. \|/);
    assert.match(rendered, /\| ci_pending \| pending \| CI is pending\. \|/);
    assert.match(rendered, /\| Merge commits \| 1 \| edge223 \(#223\) \|/);
    assert.match(
      rendered,
      /\| Evidence refs \| 5 \| blocker:blocked, blocker:pending, commit:nested-explicit, commit:edge223, pr:#223 \|/,
    );
  });

  test("renders malformed queue constituent numbers as unknown", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            {
              title: "Missing PR number",
              head_sha: "abc1234",
              status: "queued",
              evidence_refs: ["comment:missing-number"],
            },
            {
              number: "not-a-number",
              title: "Bad PR number",
              head_sha: null,
              status: "unknown",
              evidence_refs: ["comment:bad-number"],
            },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const numbersRow = rendered.split("\n").find((line) => line.startsWith("| Constituent PRs |"));
    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(numbersRow);
    assert.match(numbersRow, /\| Constituent PRs \| 2 \| unknown, unknown \|/);
    assert.doesNotMatch(numbersRow, /#0/);
    assert.ok(statusRow);
    assert.match(statusRow, /unknown \(unknown, Bad PR number\); unknown \(queued, Missing PR number, head abc1234\)/);
    assert.doesNotMatch(statusRow, /#0/);
    assert.ok(refsRow);
    assert.match(refsRow, /comment:missing-number/);
    assert.match(refsRow, /comment:bad-number/);
  });

  test("normalizes cached queue constituent status aliases before rendering", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context has mixed statuses" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            {
              number: 201,
              title: "API update",
              url: null,
              head_sha: null,
              status: "SUCCESS",
              evidence_refs: ["comment:success"],
            },
            {
              number: 202,
              title: "UI update",
              url: null,
              head_sha: null,
              status: "surprise",
              evidence_refs: ["comment:surprise"],
            },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#202 \(unknown, UI update\); #201 \(validated, API update\)/);
    assert.doesNotMatch(statusRow, /SUCCESS/);
    assert.doesNotMatch(statusRow, /surprise/);
  });

  test("renders missing or malformed queue strategy as unknown", () => {
    for (const strategy of [undefined, "", "   ", 123, "surprise"]) {
      const rendered = renderReviewGateStatusComment(
        [{ rule: "modeled-blockers", status: "unknown", explanation: "stored queue context is partial" }],
        "2026-07-01T00:00:00.000Z",
        evidenceSummaryFromPrContext({
          queue_context: {
            is_queue: true,
            strategy,
            constituent_prs: [],
            merge_commits: [],
            validation_evidence: [],
            unresolved_blockers: [],
          },
        }),
      );

      assert.match(rendered, /Strategy: unknown/);
      assert.doesNotMatch(rendered, /Strategy:\s*\n\n\| Area/);
    }
  });

  test("renders cached queue strategy aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
          queueContext: {
            isQueue: true,
            strategy: "   ",
            strategyLabel: "commit history",
            constituentPrs: [],
            mergeCommits: [],
            validationEvidence: [],
          unresolvedBlockers: [],
        },
      }),
    );

    assert.match(rendered, /Strategy: merge_commits/);
    assert.doesNotMatch(rendered, /Strategy: unknown/);
  });

  test("renders cached queue context when queue flag is omitted but queue data is present", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled from cached data" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queueContext: {
          strategyLabel: "commit history",
          constituentPrs: [{ number: 201, status: "mergedIntoQueue", title: "API update" }],
          mergeCommits: [{ oid: " oid201 ", prNumber: 201 }],
          validationEvidence: [{ command: "npm test", status: "passed", scope: "#201" }],
          unresolvedBlockers: [],
        },
      }),
    );

    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Strategy: merge_commits/);
    assert.match(rendered, /Constituent PRs \| 1 \| #201/);
    assert.match(rendered, /Constituent status \| 1 \| #201 \(merged_into_queue, API update\)/);
    assert.match(rendered, /Validation evidence \| 1 \| passed \[#201\]: npm test/);
  });

  test("does not render cached queue evidence when queue flag is explicitly false", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "cached queue data was disabled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queueContext: {
          isQueue: false,
          strategyLabel: "commit history",
          constituentPrs: [{ number: 201, status: "mergedIntoQueue", title: "API update" }],
          mergeCommits: [{ oid: " oid201 ", prNumber: 201 }],
          validationEvidence: [{ command: "npm test", status: "passed", scope: "#201" }],
          unresolvedBlockers: [],
        },
      }),
    );

    assert.doesNotMatch(rendered, /## Merge queue evidence/);
    assert.doesNotMatch(rendered, /Strategy: merge_commits/);
    assert.doesNotMatch(rendered, /pr:#201/);
    assert.doesNotMatch(rendered, /commit:oid201/);
  });

  test("renders model-extracted constituent head SHAs without title leakage", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API update, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI update, head 12345678\)/);
    assert.match(statusRow, /#203 \(queued, Worker update, head fedcba98\)/);
    assert.doesNotMatch(statusRow, /head: abcdef1234567890/);
    assert.doesNotMatch(statusRow, /sha=1234567890abcdef/);
    assert.doesNotMatch(statusRow, /\(head &#96;fedcba9876543210&#96;\)/);
  });

  test("renders symbol-marked constituent hints without mistaking them for validation", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "- #201 ✅ API update",
          "- #202 ❌ UI update",
          "- #203 ⏳ Worker update",
          "- #204 Docs update ✅",
          "- #205 Release update ❌",
          "- #206 (✅) Mobile update",
          "- #207 Release train - ✅",
          "- #208 ✅: Config update",
        ].join("\n"),
      },
      { commits: [], comments: [] },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API update\)/);
    assert.match(statusRow, /#202 \(queued, UI update\)/);
    assert.match(statusRow, /#203 \(queued, Worker update\)/);
    assert.match(statusRow, /#204 \(queued, Docs update\)/);
    assert.match(statusRow, /#205 \(queued, Release update\)/);
    assert.match(statusRow, /#206 \(queued, Mobile update\)/);
    assert.match(statusRow, /#207 \(queued, Release train\)/);
    assert.match(statusRow, /#208 \(queued, Config update\)/);
    assert.doesNotMatch(statusRow, /✅|❌|⏳| -\)/u);
  });

  test("renders model-extracted constituent table hints with safe title escaping", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API update, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI \\\| worker, head 12345678\)/);
    assert.match(statusRow, /#203 \(queued, Worker update, head fedcba98\)/);
    assert.doesNotMatch(statusRow, /head &#96;1234567890abcdef&#96;/);
  });

  test("renders descriptive markdown constituent link labels", () => {
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API bridge\)/);
    assert.match(statusRow, /#202 \(queued, Worker explicit title, head abcdef12\)/);
    assert.match(statusRow, /#203 \(queued, Only table label, head 12345678\)/);
    assert.match(statusRow, /#204 \(queued, Comment label\)/);
    assert.doesNotMatch(statusRow, /Worker label/);
  });

  test("does not render incidental prose PR links as constituents", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "See https://example.test/pull/700 for prior discussion.",
          "Related context: [prior work](https://example.test/pull/701).",
          "- https://example.test/pull/702 Real constituent",
          "MR: [Prefixed constituent](https://gitlab.example.test/org/repo/-/merge_requests/703)",
          "Constituent: [Named constituent](https://example.test/pull/705)",
          "Source PR: https://example.test/pull/706 Source branch",
          "Constituents: [API item](https://example.test/pull/707), [UI item](https://example.test/pull/708), and [Worker item](https://example.test/pull/709)",
          "Sources: <https://example.test/pull/710>, and <https://gitlab.example.test/org/repo/-/merge_requests/711>",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/704#issuecomment-related-link",
            body: "For context see https://example.test/pull/704 before landing.",
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#702 \(queued, Real constituent\)/);
    assert.match(statusRow, /#703 \(queued, Prefixed constituent\)/);
    assert.match(statusRow, /#705 \(queued, Named constituent\)/);
    assert.match(statusRow, /#706 \(queued, Source branch\)/);
    assert.match(statusRow, /#707 \(queued, API item\)/);
    assert.match(statusRow, /#708 \(queued, UI item\)/);
    assert.match(statusRow, /#709 \(queued, Worker item\)/);
    assert.match(statusRow, /#710 \(queued\)/);
    assert.match(statusRow, /1 more/);
    assert.doesNotMatch(statusRow, /#700/);
    assert.doesNotMatch(statusRow, /#701/);
    assert.doesNotMatch(statusRow, /#704/);
    assert.doesNotMatch(statusRow, /\]\(https:\/\/example.test\/pull\/708\)/);
  });

  test("renders review-comment constituent table hints and refs", () => {
    const reviewCommentUrl = "https://example.test/pull/203#discussion_r_constituents";
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API review lane, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI review lane, head fedcba98\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 3 \|/);
    assert.match(refsRow, /https:\/\/example.test\/pull\/203#discussion_r_constituents/);
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /pr:#202/);
  });

  test("renders comment connection constituent hints and validation refs", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/44";
    const reviewCommentUrl = "https://example.test/pull/203#discussion_r_connection_validation";
    const queueContext = inferMergeQueueContext(
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
          ],
        },
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "comment connection validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(blocked, API node, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI node, head 12345678\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#201\]: npm test/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #201 has 1 failed or blocked validation evidence item\(s\)\./);
    assert.ok(refsRow);
    assert.match(refsRow, new RegExp(issueCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refsRow, new RegExp(reviewCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /pr:#202/);
  });

  test("renders fallback refs for constituent comments without URL aliases", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Merge queue integration branch" },
      {
        commits: [],
        comments: [
          {
            body: "- #201 API node head abcdef1234567890",
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "constituent comment has no URL" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API node, head abcdef12\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 2 \| github:pr-comment, pr:#201 \|/);
  });

  test("renders cached comment body and URL aliases as queue evidence", () => {
    const issueCommentUrl = "https://example.test/pull/203#issuecomment-bodytext";
    const reviewCommentUrl = "https://example.test/pull/203#discussion_r_text";
    const queueContext = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        issueComments: {
          nodes: [
            {
              htmlUrl: issueCommentUrl,
              bodyText: [
                "- #201 API alias head abcdef1234567890",
                "- #202 UI alias head 1234567890abcdef",
              ].join("\n"),
            },
          ],
        },
        reviewComments: {
          edges: [
            {
              node: {
                webUrl: reviewCommentUrl,
                text: "- #201 `npm test` -> failed",
              },
            },
          ],
        },
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached comment alias validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(blocked, API alias, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI alias, head 12345678\)/);
    assert.match(rendered, /Validation evidence \| 1 \| failed \[#201\]: npm test/);
    assert.ok(refsRow);
    assert.match(refsRow, new RegExp(issueCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refsRow, new RegExp(reviewCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("renders useful comment aliases when canonical connection nodes are empty", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/45";
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "comment alias evidence rendered" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API alias, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI alias, head 12345678\)/);
    assert.ok(refsRow);
    assert.match(refsRow, new RegExp(issueCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /pr:#202/);
  });

  test("renders useful comment aliases when canonical direct arrays are placeholders", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/46";
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "direct placeholder aliases rendered" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API direct, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI direct, head 12345678\)/);
    assert.ok(refsRow);
    assert.match(refsRow, new RegExp(issueCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /pr:#202/);
  });

  test("renders useful comment aliases when canonical direct rows are blank", () => {
    const issueCommentUrl = "https://api.example.test/repos/org/repo/issues/comments/47";
    const queueContext = inferMergeQueueContext(
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

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "direct blank aliases rendered" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const statusRow = rendered.split("\n").find((line) => line.startsWith("| Constituent status |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(statusRow);
    assert.match(statusRow, /#201 \(queued, API blank-row, head abcdef12\)/);
    assert.match(statusRow, /#202 \(queued, UI blank-row, head 12345678\)/);
    assert.ok(refsRow);
    assert.match(refsRow, new RegExp(issueCommentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /pr:#202/);
  });

  test("prioritizes comment-sourced constituent table refs over synthetic PR refs", () => {
    const queueContext = inferMergeQueueContext(
      { title: "Stack validation lane" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/220#issuecomment-constituent-table",
            body: [
              "| PR | Title |",
              "| --- | --- |",
              ...Array.from(
                { length: 12 },
                (_, index) => `| #${String(index + 201)} | Constituent ${String(index + 201)} |`,
              ),
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue modeled" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 13 \|/);
    assert.match(refsRow, /https:\/\/example.test\/pull\/220#issuecomment-constituent-table/);
    assert.match(refsRow, /pr:#201/);
    assert.match(refsRow, /3 more/);
    assert.doesNotMatch(refsRow, /pr:#210/);
  });

  test("renders explicit queue-wide validation without fabricating constituent refs", () => {
    const queueContext = inferMergeQueueContext(
      { number: 203, title: "Manual merge queue" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-queue-wide",
            body: "- scope: queue npm run aggregate-smoke -> failed",
          },
        ],
      },
    );

    assert.ok(queueContext !== null);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "queue-wide validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: queueContext,
      }),
    );

    assert.match(rendered, /Constituent PRs \| 0 \| unknown/);
    assert.match(rendered, /Constituent status \| 0 \| unknown/);
    assert.match(rendered, /Validation evidence \| 1 \| failed: npm run aggregate-smoke/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue-wide validation has 1 failed or blocked validation evidence item\(s\)\./);
    assert.match(rendered, /Evidence refs \| 1 \| https:\/\/example.test\/pull\/203#issuecomment-queue-wide/);
    assert.doesNotMatch(rendered, /pr:#/);
  });

  test("prioritizes decisive evidence refs when the ref list is capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked queue validation" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "Top-level CI blocker.",
            evidence_refs: ["zzz:top-level-blocker"],
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: Array.from({ length: 12 }, (_, index) => ({
            number: index + 1,
            title: null,
            url: null,
            head_sha: null,
            status: "queued",
            evidence_refs: [`aaa:constituent-${String(index + 1).padStart(2, "0")}`],
          })),
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm run test -- api",
              status: "failed",
              scope: "packages/api",
              evidence_ref: "yyy:failed-validation",
            },
            {
              command: "npm run test -- ui",
              status: "passed",
              scope: "packages/ui",
              evidence_ref: "bbb:passing-validation",
            },
          ],
          unresolved_blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation scope packages/api has 1 failed validation evidence item.",
              evidence_refs: ["xxx:queue-blocker"],
            },
          ],
        },
      }),
    );

    const evidenceRefsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(evidenceRefsRow);
    assert.match(evidenceRefsRow, /\| Evidence refs \| 16 \|/);
    assert.match(evidenceRefsRow, /zzz:top-level-blocker/);
    assert.match(evidenceRefsRow, /xxx:queue-blocker/);
    assert.match(evidenceRefsRow, /yyy:failed-validation/);
    assert.match(evidenceRefsRow, /bbb:passing-validation/);
    assert.match(evidenceRefsRow, /6 more/);
    assert.doesNotMatch(evidenceRefsRow, /aaa:constituent-07/);
  });

  test("keeps merge-forward constituent proof visible in compact evidence refs", () => {
    const mergeForwardRef = "https://github.example.test/org/repo/pull/183#issuecomment-215622762";
    const olderMergedRef = "https://github.example.test/org/repo/pull/183#issuecomment-215544269";
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked queue validation" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release hold is active.",
            evidence_refs: [
              "https://github.example.test/org/repo/pull/183#issuecomment-216023507",
            ],
          },
          {
            kind: "ci_missing",
            status: "unknown",
            summary: "Status rollup is unavailable.",
            evidence_refs: ["github:statusCheckRollup"],
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "title_pr_list",
          validation_evidence: [
            {
              command: "RC1 Safari validation",
              status: "passed",
              scope: null,
              evidence_ref: "https://github.example.test/org/repo/pull/183#issuecomment-216013816",
            },
            {
              command: "RC1 workflow validation",
              status: "passed",
              scope: null,
              evidence_ref: "https://github.example.test/org/repo/pull/183#issuecomment-216030756",
            },
          ],
          constituent_prs: [
            { number: 185, status: "merged_into_queue", evidence_refs: [olderMergedRef, "pr:#185"] },
            { number: 189, status: "merged_into_queue", evidence_refs: [olderMergedRef, mergeForwardRef, "pr:#189"] },
            { number: 194, status: "merged_into_queue", evidence_refs: [mergeForwardRef, "pr:#194"] },
            { number: 197, status: "queued", evidence_refs: ["pr:#197"] },
          ],
          merge_commits: [
            { sha: "c56e49c5", pr_number: 185 },
            { sha: "eafba5d0", pr_number: 189 },
          ],
        },
      }),
    );

    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /issuecomment-215622762/);
    assert.match(refsRow, /issuecomment-215544269/);
    assert.ok(
      refsRow.indexOf("issuecomment-215622762") < refsRow.indexOf("issuecomment-215544269"),
    );
    assert.match(refsRow, /more \|$/);
  });

  test("renders one ref per top-level blocker before active passing validation refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "merge_state_blocked",
            status: "blocked",
            summary: "Merge state is blocked.",
            evidence_refs: ["blocker:merge-state", "blocker:merge-state-detail"],
          },
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release hold is active.",
            evidence_refs: ["blocker:manual-hold"],
          },
        ],
        queue_context: {
          is_queue: true,
          validation_evidence: [
            {
              command: "Full RC1 deterministic suite",
              status: "passed",
              scope: null,
              evidence_ref: "validation:full-suite",
            },
          ],
          merge_commits: [{ evidence_refs: ["commit:lineage"] }],
        },
      }),
    );

    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));
    assert.ok(refsRow);
    assert.match(
      refsRow,
      /\| Evidence refs \| 5 \| blocker:merge-state, blocker:manual-hold, validation:full-suite, blocker:merge-state-detail, commit:lineage \|/,
    );
  });

  test("prioritizes active conflict refs when the ref list is capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "merge-conflicts", status: "blocked", explanation: "blocked by active conflicts" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        conflicts: {
          has_conflicts: true,
          conflict_count: 2,
          conflicting_files: ["packages/api/src/routes.ts", "apps/web/src/App.tsx"],
          evidence_refs: ["conflict:merge-tree", "conflict:local-output"],
        },
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
            evidence_refs: ["top:review"],
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: Array.from({ length: 12 }, (_, index) => ({
            number: index + 1,
            title: null,
            url: null,
            head_sha: null,
            status: "queued",
            evidence_refs: [`constituent:${String(index + 1).padStart(2, "0")}`],
          })),
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm run test -- api",
              status: "failed",
              scope: "packages/api",
              evidence_ref: "validation:api",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 16 \|/);
    assert.match(refsRow, /top:review/);
    assert.match(refsRow, /conflict:merge-tree/);
    assert.match(refsRow, /conflict:local-output/);
    assert.match(refsRow, /validation:api/);
    assert.match(refsRow, /6 more/);
    assert.doesNotMatch(refsRow, /constituent:07/);
  });

  test("prioritizes severe unresolved blockers when queue blocker summaries are capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked queue validation" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [
            ...Array.from({ length: 8 }, (_, index) => ({
              kind: "merge_state_blocked",
              status: "pending",
              summary: `Pending queue blocker ${index + 1}.`,
              evidence_refs: [`pending:${index + 1}`],
            })),
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation scope packages/api has 1 failed validation evidence item.",
              evidence_refs: ["blocked:api"],
            },
          ],
        },
      }),
    );

    const unresolvedRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Unresolved blockers |"));

    assert.ok(unresolvedRow);
    assert.match(unresolvedRow, /\| Unresolved blockers \| 9 \|/);
    assert.match(unresolvedRow, /ci_failed \(blocked\): Queue validation scope packages\/api has 1 failed validation evidence item\./);
    assert.match(unresolvedRow, /1 omitted/);
    assert.doesNotMatch(unresolvedRow, /Pending queue blocker 8/);
  });

  test("shows active validation evidence before superseded stale results", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm run test -- api", status: "failed", scope: "#201", evidence_ref: "comment:1" },
            { command: "npm run lint -- api", status: "unknown", scope: "packages/api", evidence_ref: "comment:2" },
            { command: "npm run test -- api", status: "passed", scope: "#201", evidence_ref: "comment:3" },
            { command: "npm run lint -- api", status: "passed", scope: "packages/api", evidence_ref: "comment:4" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 2 active \/ 4 total \|/);
    assert.match(validationRow, /2 superseded/);
    assert.match(validationRow, /passed \[#201\]: npm run test -- api/);
    assert.match(validationRow, /passed \[packages\/api\]: npm run lint -- api/);
    assert.doesNotMatch(validationRow, /failed \[#201\]/);
    assert.doesNotMatch(validationRow, /unknown \[packages\/api\]/);
  });

  test("collapses validation evidence with whitespace-only command differences", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm   run   test -- api", status: "failed", scope: "#201", evidence_ref: "comment:old" },
            { command: "npm run test -- api", status: "passed", scope: "#201", evidence_ref: "comment:new" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 1 active \/ 2 total \|/);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /passed \[#201\]: npm run test -- api/);
    assert.doesNotMatch(validationRow, /failed \[#201\]/);
  });

  test("collapses validation evidence with PR-prefixed numeric scope differences", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "PR #001", evidence_ref: "comment:old" },
            { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 1 active \/ 2 total \|/);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /passed \[#1\]: npm test/);
    assert.doesNotMatch(validationRow, /failed \[PR #001\]/);
  });

  test("collapses validation evidence with queue-wide scope aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "queue", evidence_ref: "comment:old" },
            { command: "npm   test", status: "passed", scope: null, evidence_ref: "comment:new" },
            { command: "npm lint", status: "blocked", scope: "scope: queue-wide", evidence_ref: "comment:lint-old" },
            { command: "npm lint", status: "passed", scope: "global", evidence_ref: "comment:lint-new" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 2 active \/ 4 total \|/);
    assert.match(validationRow, /2 superseded/);
    assert.match(validationRow, /passed: npm test/);
    assert.match(validationRow, /passed: npm lint/);
    assert.doesNotMatch(validationRow, /failed \[queue\]/);
    assert.doesNotMatch(validationRow, /blocked \[scope: queue-wide\]/);
    assert.doesNotMatch(validationRow, /\[global\]/);
  });

  test("collapses cached multi-PR validation scopes as queue-wide evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "PR #201 and PR #202", evidence_ref: "comment:old" },
            { command: "npm   test", status: "passed", scope: null, evidence_ref: "comment:new" },
            { command: "PRs #203-#204 npm range", status: "failed", scope: null, evidence_ref: "comment:range-old" },
            { command: "npm table-range", status: "failed", scope: "PRs 205-206", evidence_ref: "comment:table-range" },
            { command: "npm gitlab-range", status: "blocked", scope: "!205-206", evidence_ref: "comment:gitlab-range" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 4 active \/ 5 total \|/);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /passed: npm test/);
    assert.match(validationRow, /failed: npm range/);
    assert.match(validationRow, /failed: npm table-range/);
    assert.match(validationRow, /blocked: npm gitlab-range/);
    assert.doesNotMatch(validationRow, /#201/);
    assert.doesNotMatch(validationRow, /#202/);
    assert.doesNotMatch(validationRow, /#203/);
    assert.doesNotMatch(validationRow, /#204/);
    assert.doesNotMatch(validationRow, /#205/);
    assert.doesNotMatch(validationRow, /#206/);
  });

  test("renders cached validation commands without stale scope prefixes", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "scope: [#201](https://github.example.test/org/repo/pull/201) npm test",
              status: "failed",
              scope: "#201",
              evidence_ref: "comment:old-shape",
            },
            {
              command: "PR #202: [x] pnpm test --filter ui",
              status: "passed",
              scope: "#202",
              evidence_ref: "comment:task-shape",
            },
            {
              command: "source PR #203 npm run source-smoke ✅",
              status: "passed",
              scope: "#203",
              evidence_ref: "comment:source-prefix",
            },
            {
              command: "PR #204 pnpm lint (failed)",
              status: "failed",
              scope: "#204",
              evidence_ref: "comment:trailing-status",
            },
            {
              command: "PR #205 npm run dash-fail — failed",
              status: "failed",
              scope: "#205",
              evidence_ref: "comment:dash-status",
            },
            {
              command: "MR: !206; Command: npm run inline-field; Result: passed",
              status: "passed",
              scope: "#206",
              evidence_ref: "comment:inline-field",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#201\]: npm test/);
    assert.match(validationRow, /passed \[#202\]: pnpm test --filter ui/);
    assert.match(validationRow, /passed \[#203\]: npm run source-smoke/);
    assert.match(validationRow, /failed \[#204\]: pnpm lint/);
    assert.match(validationRow, /failed \[#205\]: npm run dash-fail/);
    assert.match(validationRow, /passed \[#206\]: npm run inline-field/);
    assert.doesNotMatch(validationRow, /scope:/);
    assert.doesNotMatch(validationRow, /github\.example\.test/);
    assert.doesNotMatch(validationRow, /\[x\]/i);
    assert.doesNotMatch(validationRow, /✅/u);
    assert.doesNotMatch(validationRow, /\(failed\)/);
    assert.doesNotMatch(validationRow, /dash-fail — failed/);
    assert.doesNotMatch(validationRow, /Command: npm run inline-field/);
    assert.doesNotMatch(validationRow, /source PR #203/);
  });

  test("renders cached pipe-separated field commands without labels", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "Pull Request: #207 | Command: npm run pipe-field | Result: failed",
              status: "failed",
              scope: "#207",
              evidence_ref: "comment:pipe-field",
            },
            {
              command: "| Command: npm run legacy-pipe | Result",
              status: "blocked",
              scope: "#208",
              evidence_ref: "comment:legacy-pipe",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#207\]: npm run pipe-field/);
    assert.match(validationRow, /blocked \[#208\]: npm run legacy-pipe/);
    assert.doesNotMatch(validationRow, /Command: npm run pipe-field/);
    assert.doesNotMatch(validationRow, /Command: npm run legacy-pipe/);
    assert.doesNotMatch(validationRow, /\| Result/);
  });

  test("recovers cached field-summary status and scope for evidence comments", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "Pull Request: #301 | Command: npm run pipe-field | Result: blocked",
              status: "",
              scope: "",
              evidence_ref: "comment:pipe-field",
            },
            {
              command: "Scope: packages/api; Command: npm run lint; Result: action_required",
              status: "surprise",
              scope: "",
              evidence_ref: "comment:field-scope",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /blocked \[#301\]: npm run pipe-field/);
    assert.match(validationRow, /unknown \[packages\/api\]: npm run lint/);
    assert.doesNotMatch(validationRow, /Result: blocked/);
    assert.doesNotMatch(validationRow, /Command: npm run pipe-field/);
  });

  test("recovers cached descriptive-link status and scope for evidence comments", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached descriptive-link validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "[API validation](https://github.example.test/org/repo/pull/226) npm run descriptive-link -> failed",
              status: "",
              scope: "",
              evidence_ref: "comment:descriptive-link",
            },
            {
              command: "scope: [Worker validation](https://api.github.example.test/repos/org/repo/pulls/227) npm run descriptive-scope => passed",
              status: "",
              scope: "",
              evidence_ref: "comment:descriptive-scope",
            },
            {
              command: "npm run has-failed-word -- --grep failed",
              status: "",
              scope: "",
              evidence_ref: "comment:ordinary-command",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#226\]: npm run descriptive-link/);
    assert.match(validationRow, /passed \[#227\]: npm run descriptive-scope/);
    assert.match(validationRow, /unknown: npm run has-failed-word -- --grep failed/);
    assert.doesNotMatch(validationRow, /API validation/);
    assert.doesNotMatch(validationRow, /Worker validation/);
    assert.doesNotMatch(validationRow, /-> failed/);
    assert.doesNotMatch(validationRow, /=> passed/);
  });

  test("renders mismatched cached descriptive-link validation as queue-wide evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached mismatched validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            { number: 230, status: "queued", evidence_refs: ["pr:#230"] },
            { number: 231, status: "queued", evidence_refs: ["pr:#231"] },
          ],
          merge_commits: [],
          validation_evidence: [
            {
              command: "[#230](https://github.example.test/org/repo/pull/231) npm run swapped -> failed",
              status: "",
              scope: "",
              evidence_ref: "comment:mismatched-link",
            },
          ],
          unresolved_blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue-wide validation has 1 failed validation evidence item.",
              evidence_refs: ["comment:mismatched-link"],
            },
          ],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));
    const unresolvedRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Unresolved blockers |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed: npm run swapped/);
    assert.doesNotMatch(validationRow, /\[#230\]/);
    assert.doesNotMatch(validationRow, /\[#231\]/);
    assert.doesNotMatch(validationRow, /github\.example\.test/);
    assert.ok(unresolvedRow);
    assert.match(unresolvedRow, /Queue-wide validation has 1 failed validation evidence item\./);
  });

  test("recovers cached status-first descriptive-link rows for evidence comments", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached status-first validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "failed: [API validation](https://github.example.test/org/repo/pull/226) npm run status-link",
              status: "",
              scope: "",
              evidence_ref: "comment:status-link",
            },
            {
              command: "passed - scope: [Worker validation](https://api.github.example.test/repos/org/repo/pulls/227) npm run status-scope",
              status: "",
              scope: "",
              evidence_ref: "comment:status-scope",
            },
            {
              command: "blocked: https://gitlab.example.test/org/repo/-/merge_requests/228 npm run status-mr",
              status: "",
              scope: "",
              evidence_ref: "comment:status-mr",
            },
            {
              command: "npm run has-failed-word -- --grep failed",
              status: "",
              scope: "",
              evidence_ref: "comment:ordinary-command",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#226\]: npm run status-link/);
    assert.match(validationRow, /blocked \[#228\]: npm run status-mr/);
    assert.match(validationRow, /passed \[#227\]: npm run status-scope/);
    assert.match(validationRow, /unknown: npm run has-failed-word -- --grep failed/);
    assert.doesNotMatch(validationRow, /API validation/);
    assert.doesNotMatch(validationRow, /Worker validation/);
    assert.doesNotMatch(validationRow, /failed:/);
    assert.doesNotMatch(validationRow, /passed - scope/);
  });

  test("recovers cached status-target rows for evidence comments", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached status-target validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "passed for PR #201: npm run cached-pr",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-pr",
            },
            {
              command: "failed for pull request #202 - pnpm test --filter cached-pull",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-pull",
            },
            {
              command: "blocked for MR !203: npm run cached-mr",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-mr",
            },
            {
              command: "failed for [API validation](https://github.example.test/org/repo/pull/204): npm run cached-markdown",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-markdown",
            },
            {
              command: "failed for PR #205 and PR #206: npm run cached-shared",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-shared",
            },
            {
              command: "failed for packages/api: npm run cached-path",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-path",
            },
            {
              command: "passed for queue: npm run cached-queue",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-queue",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#202\]: pnpm test --filter cached-pull/);
    assert.match(validationRow, /blocked \[#203\]: npm run cached-mr/);
    assert.match(validationRow, /failed \[#204\]: npm run cached-markdown/);
    assert.match(validationRow, /failed: npm run cached-shared/);
    assert.match(validationRow, /failed \[packages\/api\]: npm run cached-path/);
    assert.match(validationRow, /passed \[#201\]: npm run cached-pr/);
    assert.match(validationRow, /1 mo/);
    assert.doesNotMatch(validationRow, /#205/);
    assert.doesNotMatch(validationRow, /#206/);
    assert.doesNotMatch(validationRow, /passed for PR/);
    assert.doesNotMatch(validationRow, /failed for pull request/);
  });

  test("recovers cached repo-qualified shorthand validation rows for evidence comments", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached repo-qualified validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "meridian/web#217 failed: npm run metro",
              status: "",
              scope: "",
              evidence_ref: "comment:repo-target",
            },
            {
              command: "passed for group/subgroup/repo!218: npm run gitlab",
              status: "",
              scope: "",
              evidence_ref: "comment:repo-status",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#217\]: npm run metro/);
    assert.match(validationRow, /passed \[#218\]: npm run gitlab/);
    assert.doesNotMatch(validationRow, /meridian\/web/);
    assert.doesNotMatch(validationRow, /group\/subgroup\/repo/);
  });

  test("recovers cached target-status rows for evidence comments", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached target-status validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "PR #217 passed: npm run target-pr",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-pr",
            },
            {
              command: "pull request #218 failed - pnpm target-pull",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-pull",
            },
            {
              command: "MR !219 blocked: npm run target-mr",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-mr",
            },
            {
              command: "[API validation](https://github.example.test/org/repo/pull/220) failed: npm run target-md",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-markdown",
            },
            {
              command: "PR #221 and PR #222 failed: npm run target-shared",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-shared",
            },
            {
              command: "packages/api failed: npm run target-path",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-path",
            },
            {
              command: "queue passed: npm run target-queue",
              status: "",
              scope: "",
              evidence_ref: "comment:cached-target-queue",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#218\]: pnpm target-pull/);
    assert.match(validationRow, /blocked \[#219\]: npm run target-mr/);
    assert.match(validationRow, /failed \[#220\]: npm run target-md/);
    assert.match(validationRow, /failed: npm run target-shared/);
    assert.match(validationRow, /failed \[packages\/api\]: npm run target-path/);
    assert.match(validationRow, /passed \[#217\]: npm run target-pr/);
    assert.match(validationRow, /1 mo/);
    assert.doesNotMatch(validationRow, /#221/);
    assert.doesNotMatch(validationRow, /#222/);
    assert.doesNotMatch(validationRow, /PR #217 passed/);
    assert.doesNotMatch(validationRow, /pull request #218 failed/);
  });

  test("renders cached validation commands without HTML code tags", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "<code>npm test</code>", status: "failed", scope: "#201", evidence_ref: "comment:old" },
            { command: "npm   test", status: "passed", scope: "#201", evidence_ref: "comment:new" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 1 active \/ 2 total \|/);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /passed \[#201\]: npm test/);
    assert.doesNotMatch(validationRow, /<code>/);
    assert.doesNotMatch(validationRow, /failed \[#201\]/);
  });

  test("renders malformed cached validation commands as unknown", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "cached validation is partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "", status: "failed", scope: "#201", evidence_ref: "comment:blank" },
            { command: 123, status: "blocked", scope: "#201", evidence_ref: "comment:number" },
            { command: "   ", status: "passed", scope: "#202", evidence_ref: "comment:space" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 2 active \/ 3 total \|/);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /blocked \[#201\]: unknown/);
    assert.match(validationRow, /passed \[#202\]: unknown/);
    assert.doesNotMatch(validationRow, /failed \[#201\]/);
    assert.doesNotMatch(validationRow, /:\s*;/);
    assert.doesNotMatch(validationRow, /:\s*\|/);
    assert.ok(refsRow);
    assert.match(refsRow, /comment:number/);
    assert.match(refsRow, /comment:space/);
  });

  test("renders non-positive cached PR validation scopes as queue-wide evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "queue validation normalized" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm run smoke", status: "failed", scope: "#0", evidence_ref: "comment:invalid-pr" },
            { command: "npm run smoke", status: "passed", scope: null, evidence_ref: "comment:queue" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /passed: npm run smoke/);
    assert.doesNotMatch(validationRow, /\[#0\]/);
    assert.doesNotMatch(validationRow, /failed \[#0\]/);
  });

  test("renders scoped package validation evidence without mention-safe name loss", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "pnpm test --filter @merge-god/ui",
              status: "failed",
              scope: "packages/@merge-god/ui",
              evidence_ref: "comment:scoped-package",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[packages\/&#64;merge-god\/ui\]: pnpm test --filter &#64;merge-god\/ui/);
    assert.doesNotMatch(validationRow, /\(at\)merge-god/);
    assert.doesNotMatch(validationRow, /@merge-god/);
  });

  test("caps validation evidence rows after escaping table-sensitive text", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: `npm test ${"&".repeat(120)} | @team <script> \`quoted\``,
              status: "failed",
              scope: "packages/api",
              evidence_ref: "comment:long-escaped",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.ok(validationRow.length <= QUEUE_VALIDATION_EVIDENCE_DETAIL_LIMIT + 64, validationRow);
    assert.match(validationRow, /\.\.\./);
    assert.match(validationRow, /&amp;/);
    assert.doesNotMatch(validationRow, /@team/);
    assert.doesNotMatch(validationRow, /<script>/);
    assert.doesNotMatch(validationRow, /`quoted`/);
  });

  test("renders cached validation status aliases as normalized evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm test",
              status: "SUCCESS",
              scope: "#201",
              evidence_ref: "comment:passed",
            },
            {
              command: "npm lint",
              status: "TIMED_OUT",
              scope: "#202",
              evidence_ref: "comment:timeout",
            },
            {
              command: "npm smoke",
              status: "ACTION_REQUIRED",
              scope: "#203",
              evidence_ref: "comment:action",
            },
            {
              command: "npm e2e",
              status: "ERROR",
              scope: "#204",
              evidence_ref: "comment:error",
            },
            {
              command: "npm perf",
              status: "EXPIRED",
              scope: "#205",
              evidence_ref: "comment:expired",
            },
            {
              validation: "npm gitlab",
              result: "failed",
              merge_request_iid: 206,
              evidence_ref: "comment:gitlab",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed \[#202\]: npm lint/);
    assert.match(validationRow, /failed \[#204\]: npm e2e/);
    assert.match(validationRow, /failed \[#206\]: npm gitlab/);
    assert.match(validationRow, /unknown \[#203\]: npm smoke/);
    assert.match(validationRow, /unknown \[#205\]: npm perf/);
    assert.match(validationRow, /passed \[#201\]: npm test/);
    assert.doesNotMatch(validationRow, /TIMED_OUT/);
    assert.doesNotMatch(validationRow, /ACTION_REQUIRED/);
    assert.doesNotMatch(validationRow, /SUCCESS/);
    assert.doesNotMatch(validationRow, /ERROR/);
    assert.doesNotMatch(validationRow, /EXPIRED/);
  });

  test("renders malformed PR validation scope aliases as queue-wide evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "validation scope alias malformed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm malformed-pr",
              status: "failed",
              pullRequest: "not-a-number",
              evidence_ref: "comment:malformed-pr",
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /failed: npm malformed-pr/);
    assert.doesNotMatch(validationRow, /\[not-a-number\]/);
  });

  test("reports omitted active validation rows while preserving non-passing evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm run test -- api", status: "passed", scope: "#201", evidence_ref: "validation:api" },
            { command: "npm run test -- ui", status: "failed", scope: "#202", evidence_ref: "validation:ui" },
            { command: "npm run lint -- api", status: "blocked", scope: "packages/api", evidence_ref: "validation:lint" },
            { command: "npm run smoke -- web", status: "unknown", scope: "apps/web", evidence_ref: "validation:web" },
            ...Array.from({ length: 5 }, (_, index) => ({
              command: `npm run pass-${index + 1}`,
              status: "passed",
              scope: `packages/pass-${index + 1}`,
              evidence_ref: `validation:pass-${index + 1}`,
            })),
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /\| Validation evidence \| 9 \|/);
    assert.match(validationRow, /failed \[#202\]: npm run test -- ui/);
    assert.match(validationRow, /blocked \[packages\/api\]: npm run lint -- api/);
    assert.match(validationRow, /unknown \[apps\/web\]: npm run smoke -- web/);
    assert.match(validationRow, /3 more active/);
    assert.doesNotMatch(validationRow, /npm run pass-5/);
  });

  test("places omitted active validation marker after first passing row when stale rows exist", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "active validation failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm run pass-1", status: "failed", scope: "#201", evidence_ref: "validation:stale" },
            { command: "npm run fail", status: "failed", scope: "#202", evidence_ref: "validation:fail" },
            { command: "npm run unknown", status: "unknown", scope: "#205", evidence_ref: "validation:unknown" },
            { command: "npm run pass-1", status: "passed", scope: "#201", evidence_ref: "validation:pass-1" },
            { command: "npm run pass-2", status: "passed", scope: "#203", evidence_ref: "validation:pass-2" },
            { command: "npm run pass-3", status: "passed", scope: "#204", evidence_ref: "validation:pass-3" },
            { command: "npm run pass-4", status: "passed", scope: "#206", evidence_ref: "validation:pass-4" },
            { command: "npm run pass-5", status: "passed", scope: "#207", evidence_ref: "validation:pass-5" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const validationRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Validation evidence |"));

    assert.ok(validationRow);
    assert.match(validationRow, /1 superseded/);
    assert.match(validationRow, /1 more active/);
    assert.ok(validationRow.indexOf("passed [#201]: npm run pass-1") < validationRow.indexOf("1 more active"));
    assert.ok(validationRow.indexOf("1 more active") < validationRow.indexOf("passed [#203]: npm run pass-2"));
    assert.doesNotMatch(validationRow, /failed \[#201\]: npm run pass-1/);
  });

  test("prioritizes active validation refs over superseded stale refs when capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: Array.from({ length: 12 }, (_, index) => ({
            number: index + 1,
            title: null,
            url: null,
            head_sha: null,
            status: "queued",
            evidence_refs: [`constituent:${String(index + 1).padStart(2, "0")}`],
          })),
          merge_commits: [],
          validation_evidence: [
            { command: "npm run test -- api", status: "failed", scope: "#201", evidence_ref: "validation:old-failed" },
            { command: "npm run test -- api", status: "passed", scope: "#201", evidence_ref: "validation:new-passed" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 14 \|/);
    assert.match(refsRow, /validation:new-passed/);
    assert.doesNotMatch(refsRow, /validation:old-failed/);
  });

  test("renders all explicit refs from active validation evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "no active blockers" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm run test -- api",
              status: "passed",
              scope: "#201",
              evidenceRefs: {
                nodes: ["validation:active", { ref: "ci:validation-run" }],
              },
            },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 2 \| validation:active, ci:validation-run \|/);
  });

  test("does not repeat top-level blockers in the queue unresolved blocker summary", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [],
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
              summary: "Queue constituent PR #12 has 1 failed validation evidence item.",
              evidence_refs: ["comment:queue-validation"],
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| review_required \| blocked \| GitHub requires review before this PR can merge\./);

    const unresolvedRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Unresolved blockers |"));

    assert.ok(unresolvedRow);
    assert.match(unresolvedRow, /\| Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #12 has 1 failed validation evidence item\./);
    assert.doesNotMatch(unresolvedRow, /review_required/);
  });

  test("renders malformed blockers with explicit unknown defaults", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "unknown", explanation: "stored blockers are partial" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [
            {
              evidence_refs: ["blocker:queue-copy"],
            },
          ],
        },
      }),
    );

    const topLevelBlockerRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| unknown | unknown | No summary."));
    const unresolvedRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Unresolved blockers |"));
    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(topLevelBlockerRow);
    assert.match(topLevelBlockerRow, /\| unknown \| unknown \| No summary\. \|/);
    assert.ok(unresolvedRow);
    assert.match(unresolvedRow, /\| Unresolved blockers \| 0 \| none \|/);
    assert.ok(refsRow);
    assert.match(refsRow, /blocker:top/);
    assert.doesNotMatch(refsRow, /blocker:queue-copy/);
    assert.doesNotMatch(rendered, /\|\s+\|\s+\|\s+\|/);
  });

  test("renders useful flat blockers after blank canonical blocker rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "flat blocker wins" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
            evidence_ref: "blocker:flat",
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Flat gate blocked\. \|/);
    assert.doesNotMatch(rendered, /\| unknown \| unknown \| No summary\. \|/);
    assert.match(rendered, /\| Evidence refs \| 1 \| blocker:flat \|/);
  });

  test("does not render blank flat blockers when queue aliases provide blockers", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "queue alias blocker wins" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        isQueue: true,
        queueStrategy: "manual",
        blockers: [
          {
            kind: "",
            status: " ",
            summary: "",
          },
        ],
        queueBlockers: [
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "Queue validation failed.",
            evidence_ref: "queue:blocker",
          },
        ],
      }),
    );

    const unresolvedRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Unresolved blockers |"));

    assert.ok(unresolvedRow);
    assert.match(unresolvedRow, /\| Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue validation failed\. \|/);
    assert.doesNotMatch(unresolvedRow, /unknown/);
    assert.match(rendered, /\| Evidence refs \| 1 \| queue:blocker \|/);
  });

  test("normalizes cached merge blocker status aliases before rendering", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "external gates are not clean" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "ci_failed",
            status: "ACTION REQUIRED",
            summary: "Release approval is required.",
          },
          {
            kind: "merge_state_blocked",
            status: "in-progress",
            summary: "Mergeability is still being computed.",
          },
        ],
      }),
    );

    assert.match(rendered, /\| ci_failed \| blocked \| Release approval is required\. \|/);
    assert.match(rendered, /\| merge_state_blocked \| pending \| Mergeability is still being computed\. \|/);
    assert.doesNotMatch(rendered, /ACTION REQUIRED/);
    assert.doesNotMatch(rendered, /in-progress/);
  });

  test("normalizes cached merge blocker kind aliases before rendering", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "external gates are not clean" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "External Gate",
            status: "blocked",
            summary: "Release approval is required.",
          },
          {
            kind: "review-required",
            status: "blocked",
            summary: "Review is required.",
          },
        ],
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Release approval is required\. \|/);
    assert.match(rendered, /\| review_required \| blocked \| Review is required\. \|/);
    assert.doesNotMatch(rendered, /External Gate/);
    assert.doesNotMatch(rendered, /review-required/);
  });

  test("renders modeled release decision hold blockers from comments", () => {
    const mergeBlockers = analyzeMergeBlockers(
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
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "release decision is hold" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: mergeBlockers,
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Manual merge gate is blocked: Blocking items are the Safari fresh &#96;\/chat&#96; catastrophic panel and incomplete Safari ISOF route evidence\. \|/);
    assert.match(rendered, /\| Evidence refs \| 1 \| https:\/\/example.test\/pull\/183#issuecomment-rc1-hold \|/);
  });

  test("abbreviates long modeled manual gate rows without truncating stored blockers", () => {
    const reason = [
      "Blocking items are the Safari fresh `/chat` catastrophic panel",
      "incomplete Safari ISOF route evidence",
      "previously recorded live `workflow-exec-route.spec.ts` failures clustered around screenshot drift",
      "HIL parameter collection",
      "delayed fabric takeover rendering after the route migration fix set",
      "and final release owner signoff.",
    ].join(", ");
    const mergeBlockers = analyzeMergeBlockers(
      {},
      {
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-rc1-long-hold",
            body: `Remaining RC1 decision: HOLD, not approve. ${reason}`,
          },
        ],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
      },
    );
    const blocker = mergeBlockers.find((item) => item.kind === "external_gate");
    assert.ok(blocker);
    assert.equal(blocker.summary, `Manual merge gate is blocked: ${reason}`);
    assert.match(blocker.summary, /final release owner signoff/);

    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "release decision is hold" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: mergeBlockers,
      }),
    );
    const externalGateRow = rendered.split("\n").find((line) => line.startsWith("| external_gate | blocked |"));
    assert.ok(externalGateRow);
    assert.match(externalGateRow, /\.\.\. \|$/);
    assert.doesNotMatch(externalGateRow, /final release owner signoff/);
    assert.match(rendered, /\| Evidence refs \| 1 \| https:\/\/example.test\/pull\/183#issuecomment-rc1-long-hold \|/);
  });

  test("does not render release decision hold evidence after a later pass decision", () => {
    const mergeBlockers = analyzeMergeBlockers(
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
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "pass", explanation: "release decision cleared" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: mergeBlockers,
      }),
    );

    assert.doesNotMatch(rendered, /\| external_gate \|/);
    assert.doesNotMatch(rendered, /rc1-hold/);
  });

  test("renders cached blocker field aliases and singular validation evidence refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "external gates are not clean" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            type: "external_gate",
            state: "ACTION REQUIRED",
            message: "Release manager approval is required.",
            sourceUrl: "blocker:release",
          },
        ],
        queueContext: {
          isQueue: true,
          strategy: "manual",
          constituentPrs: [],
          mergeCommits: [],
          validationEvidence: [
            {
              cmd: "npm run queue-smoke",
              result: "failed",
              pullRequest: "#201",
              html_url: "validation:queue-smoke",
            },
          ],
          unresolvedBlockers: [
            {
              category: "queue_validation",
              outcome: "failed",
              description: "Queue smoke validation failed.",
              evidenceUrl: "blocker:queue-smoke",
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| Release manager approval is required\. \|/);
    assert.match(rendered, /\| Validation evidence \| 1 \| failed \[#201\]: npm run queue-smoke \|/);
    assert.match(rendered, /\| Unresolved blockers \| 1 \| queue_validation \(blocked\): Queue smoke validation failed\. \|/);
    assert.match(rendered, /\| Evidence refs \| 3 \| blocker:release, validation:queue-smoke, blocker:queue-smoke \|/);
  });

  test("renders target and details URL aliases from cached blocker and validation evidence", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "adapter evidence URLs are preserved" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External deploy gate is blocked.",
            target_url: "blocker:target",
          },
        ],
        queueContext: {
          isQueue: true,
          strategy: "manual",
          validationEvidence: [
            {
              command: "npm run queue-smoke",
              status: "failed",
              scope: "#201",
              detailsUrl: "validation:details",
            },
          ],
          unresolvedBlockers: [
            {
              kind: "queue_validation",
              status: "blocked",
              summary: "Queue smoke validation failed.",
              targetUrl: "queue:target",
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| external_gate \| blocked \| External deploy gate is blocked\. \|/);
    assert.match(rendered, /\| Validation evidence \| 1 \| failed \[#201\]: npm run queue-smoke \|/);
    assert.match(rendered, /\| Unresolved blockers \| 1 \| queue_validation \(blocked\): Queue smoke validation failed\. \|/);
    assert.match(rendered, /\| Evidence refs \| 3 \| blocker:target, validation:details, queue:target \|/);
  });

  test("renders connection-shaped blocker evidence refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release approval required.",
            evidenceRefs: {
              nodes: [
                " blocker:node ",
                { ref: "pr:#209" },
              ],
            },
          },
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "Queue validation failed.",
            evidence_refs: {
              edges: [
                { node: "validation:edge" },
                { node: { value: "commit:abc123" } },
              ],
            },
          },
        ],
      }),
    );

    const refsRow = rendered.split("\n").find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /validation:edge/);
    assert.match(refsRow, /commit:abc123/);
    assert.match(refsRow, /blocker:node/);
    assert.match(refsRow, /pr:#209/);
  });

  test("renders generic URL fallback evidence refs from cached blocker and queue rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached URL refs" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External gate blocked.",
            webUrl: "blocker:web",
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            { number: 201, status: "queued", uri: "pr:uri-201" },
          ],
          merge_commits: [
            { oid: "merge201", pr_number: 201, permalink: "commit:permalink" },
          ],
          validation_evidence: [
            { command: "npm release", status: "failed", scope: "#201", web_url: "validation:web" },
          ],
          unresolved_blockers: [
            {
              kind: "queue_release",
              status: "blocked",
              summary: "Queue release failed.",
              permalink: "queue:permalink",
            },
          ],
        },
      }),
    );

    assert.match(
      rendered,
      /\| Evidence refs \| 6 \| blocker:web, validation:web, queue:permalink, commit:permalink, commit:merge201, pr:uri-201 \|/,
    );
  });

  test("renders link-map URL fallback evidence refs from cached blocker and queue rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "cached link-map refs" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External gate blocked.",
            links: [{ href: "blocker:links-html" }],
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [
            {
              number: 216,
              status: "queued",
              _links: { pull_requests: [{ url: "https://github.example.test/org/repo/pull/216" }] },
            },
          ],
          merge_commits: [
            {
              sha: "merge215",
              links: { html: [{ href: "https://github.example.test/org/repo/pull/215" }] },
            },
          ],
          validation_evidence: [
            {
              command: "npm smoke",
              status: "failed",
              scope: "#216",
              links: [{ href: "validation:links-html" }],
            },
          ],
          unresolved_blockers: [
            {
              kind: "queue_validation",
              status: "blocked",
              summary: "Queue validation failed.",
              _links: { web: [{ href: "queue:links-web" }] },
            },
          ],
        },
      }),
    );

    assert.match(
      rendered,
      /\| Evidence refs \| 6 \| blocker:links-html, validation:links-html, queue:links-web, https:\/\/github\.example\.test\/org\/repo\/pull\/215, commit:merge215, https:\/\/github\.example\.test\/org\/repo\/pull\/216 \|/,
    );
  });

  test("renders singular evidence refs from blocker and lineage records", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "external gates are not clean" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release manager approval is required.",
            evidenceRef: "blocker:release",
          },
        ],
        queueContext: {
          isQueue: true,
          strategy: "manual",
          constituentPrs: [{ number: 201, evidence_ref: "pr:#201" }],
          mergeCommits: [{ oid: " oid201 ", evidenceRef: "commit:explicit" }],
          validationEvidence: [],
          unresolvedBlockers: [
            {
              kind: "queue_validation",
              status: "failed",
              summary: "Queue validation failed.",
              evidence_ref: "blocker:queue",
            },
          ],
        },
      }),
    );

    assert.match(rendered, /\| Evidence refs \| 5 \| blocker:release, blocker:queue, commit:explicit, commit:oid201, pr:#201 \|/);
  });

  test("renders comment and source ref aliases from cached evidence rows", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "comment and source refs" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release manager approval is required.",
            commentRef: "blocker:comment",
          },
        ],
        queueContext: {
          isQueue: true,
          strategy: "manual",
          constituentPrs: [{ number: 201, comment_ref: "pr:comment" }],
          mergeCommits: [{ oid: " oid201 ", sourceRef: "commit:source" }],
          validationEvidence: [
            { command: "npm test", status: "failed", scope: "#201", source_refs: ["validation:source"] },
          ],
          unresolvedBlockers: [
            {
              kind: "queue_validation",
              status: "failed",
              summary: "Queue validation failed.",
              comment_refs: ["queue:comment"],
            },
          ],
        },
      }),
    );

    assert.match(
      rendered,
      /\| Evidence refs \| 6 \| blocker:comment, validation:source, queue:comment, commit:source, commit:oid201, pr:comment \|/,
    );
  });

  test("prioritizes severe top-level blockers when blocker rows are capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          ...Array.from({ length: 12 }, (_, index) => ({
            kind: "merge_state_blocked",
            status: "pending",
            summary: `Pending blocker ${index + 1}.`,
            evidence_refs: [`pending:${index + 1}`],
          })),
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "A required queue validation command failed.",
            evidence_refs: ["blocked:ci"],
          },
        ],
      }),
    );

    assert.match(rendered, /\| ci_failed \| blocked \| A required queue validation command failed\. \|/);
    assert.match(rendered, /\| merge-blockers \| unknown \| 1 additional blocker\(s\) omitted from comment cache\. \|/);
    assert.doesNotMatch(rendered, /\| merge_state_blocked \| pending \| Pending blocker 12\. \|/);
  });

  test("prioritizes severe top-level blocker refs when evidence refs are capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          ...Array.from({ length: 12 }, (_, index) => ({
            kind: "merge_state_blocked",
            status: "pending",
            summary: `Pending blocker ${index + 1}.`,
            evidence_refs: [`pending:${String(index + 1).padStart(2, "0")}`],
          })),
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "A required queue validation command failed.",
            evidence_refs: ["blocked:ci"],
          },
        ],
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 13 \|/);
    assert.match(refsRow, /blocked:ci/);
    assert.match(refsRow, /3 more/);
    assert.doesNotMatch(refsRow, /pending:10/);
  });

  test("does not let hidden duplicate queue blocker refs crowd out active validation refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
            evidence_refs: ["top:review"],
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm run test -- api",
              status: "failed",
              scope: "packages/api",
              evidence_ref: "validation:api",
            },
          ],
          unresolved_blockers: [
            {
              kind: "review_required",
              status: "blocked",
              summary: "GitHub requires review before this PR can merge.",
              evidence_refs: Array.from({ length: 12 }, (_, index) => `duplicate:${String(index + 1).padStart(2, "0")}`),
            },
          ],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 2 \|/);
    assert.match(refsRow, /top:review/);
    assert.match(refsRow, /validation:api/);
    assert.doesNotMatch(refsRow, /duplicate:01/);
  });

  test("uses hidden duplicate queue blocker refs when the top-level blocker has none", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        merge_blockers: [
          {
            kind: "Review Required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
          },
        ],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm run test -- api",
              status: "failed",
              scope: "packages/api",
              evidence_ref: "validation:api",
            },
          ],
          unresolved_blockers: [
            {
              kind: "review-required",
              status: "blocked",
              summary: "GitHub requires review\nbefore this PR can merge.",
              evidence_refs: ["queue:review-required"],
            },
          ],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));
    const unresolvedRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Unresolved blockers |"));

    assert.ok(refsRow);
    assert.ok(unresolvedRow);
    assert.match(refsRow, /\| Evidence refs \| 2 \| queue:review-required, validation:api \|/);
    assert.match(unresolvedRow, /\| Unresolved blockers \| 0 \| none \|/);
  });

  test("keeps active validation visible ahead of many queue blocker refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked queue validation" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            {
              command: "npm run queue-smoke",
              status: "failed",
              scope: "#201",
              evidence_ref: "validation:active",
            },
          ],
          unresolved_blockers: Array.from({ length: 12 }, (_, index) => ({
            kind: "queue_validation",
            status: "blocked",
            summary: `Queue blocker ${index + 1}.`,
            evidence_refs: [`queue:blocker-${String(index + 1).padStart(2, "0")}`],
          })),
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 13 \|/);
    assert.match(refsRow, /validation:active/);
    assert.match(refsRow, /queue:blocker-01/);
    assert.match(refsRow, /3 more/);
    assert.doesNotMatch(refsRow, /queue:blocker-10/);
  });

  test("renders malformed cached CI check details without blank suffixes", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "blocked", explanation: "CI is not clean" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 3,
          passed: 0,
          failed: 1,
          pending: 1,
          unknown: 1,
          skipped: 0,
          failed_checks: [
            { name: "   ", conclusion: " FAILURE ", details_url: "  failed:url  " },
          ],
          pending_checks: [
            { name: null, status: " IN_PROGRESS ", details_url: "   " },
          ],
          unknown_checks: [
            { name: "mystery", state: " MYSTERY ", details_url: " unknown:url " },
          ],
        },
      }),
    );

    const ciRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| CI checks |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(ciRow);
    assert.match(ciRow, /Failed: unknown \(FAILURE, failed:url\)/);
    assert.match(ciRow, /Pending: unknown \(IN_PROGRESS\)/);
    assert.match(ciRow, /Unknown: mystery \(MYSTERY, unknown:url\)/);
    assert.doesNotMatch(ciRow, /\(\s*,/);
    assert.doesNotMatch(ciRow, /,\s+\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 3 \| failed:url, github:statusCheckRollup, unknown:url \|/);
  });

  test("renders and collects forge-style cached CI detail URL aliases", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "blocked", explanation: "CI is not clean" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 3,
          passed: 0,
          failed: 1,
          pending: 1,
          unknown: 1,
          skipped: 0,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", detailsUrl: " ci:api " },
          ],
          pending_checks: [
            { name: "deploy", status: "IN_PROGRESS", targetUrl: " ci:deploy " },
          ],
          unknown_checks: [
            { name: "manual", state: "WAITING", url: " ci:manual " },
          ],
        },
      }),
    );

    const ciRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| CI checks |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(ciRow);
    assert.match(ciRow, /Failed: api \(FAILURE, ci:api\)/);
    assert.match(ciRow, /Pending: deploy \(IN_PROGRESS, ci:deploy\)/);
    assert.match(ciRow, /Unknown: manual \(WAITING, ci:manual\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 3 \| ci:api, ci:deploy, ci:manual \|/);
  });

  test("renders malformed negative cached CI counts as zero counts", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "unknown", explanation: "CI cache is malformed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: -1,
          passed: -2,
          failed: -3,
          pending: -4,
          unknown: -5,
          skipped: -6,
          failed_checks: [],
          pending_checks: [],
          unknown_checks: [],
        },
      }),
    );

    const ciRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| CI checks |"));

    assert.ok(ciRow);
    assert.match(ciRow, /\| CI checks \| unknown \| 0 failed, 0 pending, 0 unknown, 0 passed, 0 skipped out of 0 check\(s\)\. \|/);
    assert.doesNotMatch(ciRow, /-\d/);
  });

  test("does not let zero cached CI counts hide failed check details", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "blocked", explanation: "CI failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 0,
          passed: 0,
          failed: 0,
          pending: 0,
          unknown: 0,
          skipped: 0,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          ],
          pending_checks: [],
          unknown_checks: [],
        },
      }),
    );

    const ciRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| CI checks |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(ciRow);
    assert.match(ciRow, /\| CI checks \| blocked \| 1 failed, 0 pending, 0 unknown, 0 passed, 0 skipped out of 1 check\(s\)\./);
    assert.match(ciRow, /Failed: api \(FAILURE, ci:api\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 1 \| ci:api \|/);
  });

  test("renders cached CI count aliases without detail arrays", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "blocked", explanation: "CI failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
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
      }),
    );

    const ciRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| CI checks |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(ciRow);
    assert.match(ciRow, /\| CI checks \| blocked \| 1 failed, 1 pending, 1 unknown, 1 passed, 0 skipped out of 4 check\(s\)\. \|/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 1 \| github:statusCheckRollup \|/);
  });

  test("renders CI rollup evidence when count summaries exceed detail arrays", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "blocked", explanation: "CI failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 4,
          passed: 1,
          failed: 2,
          pending: 1,
          unknown: 0,
          skipped: 0,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          ],
          pending_checks: [],
          unknown_checks: [],
        },
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 2 \| ci:api, github:statusCheckRollup \|/);
  });

  test("renders raw status-check detail refs for partial nonzero CI summaries", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "blocked", explanation: "CI failed" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 4,
          passed: 1,
          failed: 2,
          pending: 1,
          unknown: 0,
          skipped: 0,
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
    );

    const ciRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| CI checks |"));
    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(ciRow);
    assert.match(ciRow, /Failed: api \(FAILURE, ci:api\); worker \(FAILURE, ci:worker\)/);
    assert.match(ciRow, /Pending: deploy \(IN_PROGRESS, ci:deploy\)/);
    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 3 \| ci:api, ci:deploy, ci:worker \|/);
  });

  test("does not let pending CI refs crowd out blocked modeled blocker refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 12,
          passed: 0,
          failed: 0,
          pending: 12,
          unknown: 0,
          skipped: 0,
          failed_checks: [],
          pending_checks: Array.from({ length: 12 }, (_, index) => ({
            name: `pending ${index + 1}`,
            status: "IN_PROGRESS",
            details_url: `pending:${String(index + 1).padStart(2, "0")}`,
          })),
          unknown_checks: [],
        },
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
            evidence_refs: ["github:reviewDecision"],
          },
        ],
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 13 \|/);
    assert.match(refsRow, /github:reviewDecision/);
    assert.match(refsRow, /3 more/);
    assert.doesNotMatch(refsRow, /pending:10/);
  });

  test("does not let failed CI refs crowd out blocked modeled blocker refs", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "modeled-blockers", status: "blocked", explanation: "blocked" }],
      "2026-07-01T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 12,
          passed: 0,
          failed: 12,
          pending: 0,
          unknown: 0,
          skipped: 0,
          failed_checks: Array.from({ length: 12 }, (_, index) => ({
            name: `failed ${index + 1}`,
            conclusion: "FAILURE",
            details_url: `failed:${String(index + 1).padStart(2, "0")}`,
          })),
          pending_checks: [],
          unknown_checks: [],
        },
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
            evidence_refs: ["github:reviewDecision"],
          },
        ],
      }),
    );

    const refsRow = rendered
      .split("\n")
      .find((line) => line.startsWith("| Evidence refs |"));

    assert.ok(refsRow);
    assert.match(refsRow, /\| Evidence refs \| 13 \|/);
    assert.match(refsRow, /github:reviewDecision/);
    assert.match(refsRow, /3 more/);
    assert.doesNotMatch(refsRow, /failed:10/);
  });
});
