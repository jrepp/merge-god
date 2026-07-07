import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  collectEvidenceRefs,
  EVIDENCE_REF_PRIORITY_SEED_LIMIT,
  isStatusProvenanceRef,
} from "../evidence_ref_model";
import { EVIDENCE_REF_RENDER_LIMIT } from "../review_gate_evidence_comment_model";

describe("evidence ref model", () => {
  test("exports the high-priority seed limit used before lineage refs", () => {
    assert.equal(EVIDENCE_REF_PRIORITY_SEED_LIMIT, 1);
  });

  test("recognizes concrete status-provenance comment and discussion URLs", () => {
    assert.equal(isStatusProvenanceRef("https://github.example.test/org/repo/pull/183#issuecomment-215622762"), true);
    assert.equal(isStatusProvenanceRef("https://github.example.test/org/repo/pull/183#discussion_r123456"), true);
    assert.equal(isStatusProvenanceRef("https://gitlab.example.test/org/repo/-/merge_requests/201#note_987654"), true);
    assert.equal(isStatusProvenanceRef("https://api.github.example.test/repos/org/repo/issues/comments/42"), true);
    assert.equal(isStatusProvenanceRef("https://api.github.example.test/repos/org/repo/pulls/comments/43"), true);
    assert.equal(isStatusProvenanceRef("https://gitlab.example.test/api/v4/projects/5/merge_requests/201/notes/987"), true);
    assert.equal(isStatusProvenanceRef("comment:merge-table#issuecomment-215622762"), false);
    assert.equal(isStatusProvenanceRef("https://github.example.test/org/repo/pull/183#issuecomment-merge-forward"), false);
    assert.equal(isStatusProvenanceRef("https://api.github.example.test/repos/org/repo/issues/42"), false);
    assert.equal(isStatusProvenanceRef("not a url"), false);
  });

  test("surfaces one decisive ref from each high-priority bucket before lineage refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        ci_status: {
          failed_checks: [{ details_url: "ci:failed-1" }, { details_url: "ci:failed-2" }],
          pending_checks: [{ details_url: "ci:pending-1" }],
          unknown_checks: [{ details_url: "ci:unknown-1" }],
        },
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "review required",
            evidence_refs: ["blocker:review-1", "blocker:review-2"],
          },
        ],
        conflicts: {
          has_conflicts: true,
          conflict_count: 1,
          evidence_refs: ["conflict:merge-tree"],
        },
        queue_context: {
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed-1" },
            { command: "npm lint", status: "passed", scope: "#202", evidence_ref: "validation:passed-1" },
          ],
          unresolved_blockers: [
            {
              kind: "queue_validation_failed",
              status: "blocked",
              summary: "queue validation failed",
              evidence_refs: ["queue:blocker-1", "queue:blocker-2"],
            },
          ],
          merge_commits: [{ evidence_refs: ["commit:lineage-1"] }],
          constituent_prs: [{ evidence_refs: ["pr:#201"] }],
        },
      }).slice(0, EVIDENCE_REF_RENDER_LIMIT),
      [
        "ci:failed-1",
        "blocker:review-1",
        "conflict:merge-tree",
        "validation:failed-1",
        "queue:blocker-1",
        "ci:pending-1",
        "ci:unknown-1",
        "ci:failed-2",
        "validation:passed-1",
        "blocker:review-2",
      ],
    );
  });

  test("deduplicates refs globally and excludes queue blockers already represented at the top level", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "review required",
            evidence_refs: ["top:review"],
          },
        ],
        queue_context: {
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "packages/api", evidence_ref: "validation:api" },
          ],
          unresolved_blockers: [
            {
              kind: "review_required",
              status: "blocked",
              summary: "review required",
              evidence_refs: ["hidden:duplicate"],
            },
            {
              kind: "queue_validation_failed",
              status: "blocked",
              summary: "queue validation failed",
              evidence_refs: ["top:review", "queue:validation"],
            },
          ],
        },
      }),
      ["top:review", "validation:api", "queue:validation"],
    );
  });

  test("deduplicates queue-only blocker refs without dropping duplicate provenance", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
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
      }),
      ["queue:first", "queue:second"],
    );
  });

  test("backfills top-level blocker refs from hidden duplicate queue blockers only when missing", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        merge_blockers: [
          {
            kind: "Review Required",
            status: "blocked",
            summary: "review required",
          },
          {
            kind: "external_gate",
            status: "blocked",
            summary: "release hold",
            evidence_refs: ["top:release"],
          },
        ],
        queue_context: {
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "packages/api", evidence_ref: "validation:api" },
          ],
          unresolved_blockers: [
            {
              kind: "review-required",
              status: "blocked",
              summary: "review\n  required",
              evidence_refs: ["queue:review"],
            },
            {
              kind: "external_gate",
              status: "blocked",
              summary: "release hold",
              evidence_refs: ["queue:release"],
            },
          ],
        },
      }),
      ["queue:review", "top:release", "validation:api"],
    );
  });

  test("surfaces one ref per top-level blocker before active passing validation refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
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
      [
        "blocker:merge-state",
        "blocker:manual-hold",
        "validation:full-suite",
        "blocker:merge-state-detail",
        "commit:lineage",
      ],
    );
  });

  test("orders active validation by blocking severity before lineage and superseded refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:old-failed" },
            { command: "npm test", status: "passed", scope: "#201", evidence_ref: "validation:new-passed" },
            { command: "npm lint", status: "unknown", scope: "#202", evidence_ref: "validation:unknown" },
            { command: "npm smoke", status: "blocked", scope: "#203", evidence_ref: "validation:blocked" },
          ],
          merge_commits: [{ evidence_refs: ["commit:lineage"] }],
          constituent_prs: [{ evidence_refs: ["pr:#201"] }],
        },
      }),
      [
        "validation:blocked",
        "validation:unknown",
        "validation:new-passed",
        "commit:lineage",
        "pr:#201",
        "validation:old-failed",
      ],
    );
  });

  test("prioritizes decisive constituent refs when long queue lineage is capped", () => {
    const refs = collectEvidenceRefs({
      queue_context: {
        is_queue: true,
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
    });

    assert.deepEqual(refs.slice(0, EVIDENCE_REF_RENDER_LIMIT), [
      "validation:509",
      "validation:510",
      "pr:#501",
      "pr:#502",
      "pr:#503",
      "pr:#504",
      "pr:#505",
      "pr:#506",
      "pr:#507",
      "pr:#508",
    ]);
  });

  test("keeps all explicit refs from active validation evidence rows", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          validation_evidence: [
            {
              command: "npm test",
              status: "failed",
              scope: "#201",
              evidenceRefs: ["validation:old", "ticket:old"],
            },
            {
              command: "npm test",
              status: "passed",
              scope: "#201",
              evidenceRefs: {
                nodes: ["validation:new", { ref: "ci:new" }],
              },
            },
          ],
          merge_commits: [{ evidence_refs: ["commit:lineage"] }],
        },
      }),
      ["validation:new", "ci:new", "commit:lineage", "validation:old", "ticket:old"],
    );
  });

  test("keeps evidence-ref-only canonical validation rows instead of falling through to aliases", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
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
          merge_commits: [{ evidence_refs: ["commit:lineage"] }],
        },
      }),
      ["validation:canonical", "ticket:canonical", "commit:lineage"],
    );
  });

  test("keeps evidence-ref-only canonical constituent and merge-commit rows", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          constituent_prs: [{ evidenceRefs: ["pr:canonical"] }],
          constituentPrs: [{ prNumber: 201, evidenceRef: "pr:alias" }],
          merge_commits: [{ commit: { evidenceRefs: ["commit:nested-canonical"] } }],
          mergeCommits: [{ oid: "abc", evidenceRef: "commit:alias" }],
        },
      }),
      ["commit:nested-canonical", "pr:canonical"],
    );
  });

  test("prioritizes constituent status comment provenance over merge commits and superseded validation", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release hold is active.",
            evidence_refs: ["blocker:seed", "blocker:extra"],
          },
        ],
        queue_context: {
          validation_evidence: [
            { command: "npm run full", status: "failed", scope: null, evidence_ref: "comment:queue-status" },
            { command: "npm run full", status: "passed", scope: null, evidence_ref: "validation:latest" },
          ],
          merge_commits: [
            { sha: "abc123456789", pr_number: 185, evidence_refs: ["comment:merge-table", "commit:abc12345"] },
          ],
          constituent_prs: [
            {
              number: 185,
              status: "merged_into_queue",
              evidence_refs: [
                "https://example.test/org/repo/pull/183#issuecomment-215544269",
                "comment:merge-table",
                "pr:#185",
              ],
            },
            {
              number: 194,
              status: "merged_into_queue",
              evidence_refs: [
                "https://example.test/org/repo/pull/183#issuecomment-215622762",
                "pr:#194",
              ],
            },
          ],
        },
      }),
      [
        "blocker:seed",
        "validation:latest",
        "https://example.test/org/repo/pull/183#issuecomment-215622762",
        "https://example.test/org/repo/pull/183#issuecomment-215544269",
        "blocker:extra",
        "comment:merge-table",
        "commit:abc12345",
        "commit:abc123456789",
        "pr:#185",
        "pr:#194",
        "comment:queue-status",
      ],
    );
  });

  test("prioritizes review discussion and forge note provenance before lineage refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            { sha: "abc123456789", pr_number: 201 },
          ],
          constituent_prs: [
            {
              number: 201,
              status: "merged_into_queue",
              evidence_refs: [
                "https://github.example.test/org/repo/pull/183#discussion_r123456",
                "pr:#201",
              ],
            },
            {
              number: 202,
              status: "blocked",
              evidence_refs: [
                "https://gitlab.example.test/org/repo/-/merge_requests/202#note_987654",
                "pr:#202",
              ],
            },
          ],
        },
      }),
      [
        "https://gitlab.example.test/org/repo/-/merge_requests/202#note_987654",
        "https://github.example.test/org/repo/pull/183#discussion_r123456",
        "commit:abc123456789",
        "pr:#202",
        "pr:#201",
      ],
    );
  });

  test("prioritizes decisive constituent refs even when queue lineage is not capped", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          is_queue: true,
          constituent_prs: [
            { number: 501, status: "queued", evidence_refs: ["pr:#501"] },
            { number: 502, status: "blocked", evidence_refs: ["validation:502"] },
            { number: 503, status: "unknown", evidence_refs: ["validation:503"] },
          ],
          merge_commits: [],
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
      ["validation:502", "validation:503", "pr:#501"],
    );
  });

  test("prioritizes cached API comment provenance before lineage refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            { sha: "abc123456789", pr_number: 201 },
          ],
          constituent_prs: [
            {
              number: 201,
              status: "blocked",
              evidence_refs: [
                "https://api.github.example.test/repos/org/repo/issues/comments/42",
                "pr:#201",
              ],
            },
            {
              number: 202,
              status: "merged_into_queue",
              evidence_refs: [
                "https://gitlab.example.test/api/v4/projects/5/merge_requests/202/notes/987",
                "pr:#202",
              ],
            },
          ],
        },
      }),
      [
        "https://api.github.example.test/repos/org/repo/issues/comments/42",
        "https://gitlab.example.test/api/v4/projects/5/merge_requests/202/notes/987",
        "commit:abc123456789",
        "pr:#201",
        "pr:#202",
      ],
    );
  });

  test("prioritizes URL alias status provenance before explicit lineage refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            { sha: "abc123456789", pr_number: 201 },
          ],
          constituent_prs: [
            {
              number: 201,
              status: "merged_into_queue",
              evidence_refs: ["pr:#201"],
              sourceUrl: "https://github.example.test/org/repo/pull/183#issuecomment-215622762",
            },
          ],
        },
      }),
      [
        "https://github.example.test/org/repo/pull/183#issuecomment-215622762",
        "commit:abc123456789",
        "pr:#201",
      ],
    );
  });

  test("normalizes CI detail URL aliases and ignores blank refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        ci_status: {
          failed_checks: [{ detailsUrl: " ci:failed " }, { details_url: " " }],
          pending_checks: [{ targetUrl: " ci:pending " }],
          unknown_checks: [{ url: " ci:unknown " }],
        },
        queue_context: {
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "   " },
          ],
          merge_commits: [{ evidence_refs: [" ", "commit:sha"] }],
        },
      }),
      ["ci:failed", "ci:pending", "ci:unknown", "github:statusCheckRollup", "commit:sha"],
    );
  });

  test("includes CI rollup refs when status counts exceed concrete detail refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        ci_status: {
          total_checks: 5,
          failed: 2,
          pending: 1,
          unknown: 1,
          passed: 1,
          failed_checks: [
            { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
          ],
          pending_checks: [],
          unknown_checks: [
            { name: "manual", state: "WAITING", details_url: "ci:manual" },
          ],
        },
      }),
      ["ci:api", "ci:manual", "github:statusCheckRollup"],
    );
  });

  test("collects refs from direct edge-shaped evidence summary records", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        cursor: "summary-edge",
        node: {
          ciStatus: {
            node: {
              totalChecks: 1,
              failedChecks: [{ node: { detailsUrl: "ci:edge" } }],
            },
          },
          mergeConflicts: {
            node: {
              hasConflicts: true,
              evidenceRefs: ["conflict:edge"],
            },
          },
          queueContext: {
            node: {
              isQueue: true,
              validationEvidence: [{ node: { command: "npm test", status: "failed", scope: "#201", evidenceRef: "validation:edge" } }],
              constituentPrs: [{ node: { prNumber: 201, evidenceRefs: ["pr:#201"] } }],
            },
          },
        },
      } as unknown as Parameters<typeof collectEvidenceRefs>[0]),
      ["ci:edge", "conflict:edge", "validation:edge", "pr:#201"],
    );
  });

  test("collects refs from raw adapter top-level evidence aliases", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        statusCheckRollup: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
        ],
        mergeQueueContext: {
          isQueue: true,
          validationResults: [
            { command: "npm test", status: "failed", scope: "#207", evidenceRef: "validation:raw-207" },
          ],
          pullRequests: [{ prNumber: 207, evidenceRefs: ["pr:#207"] }],
          blockers: [{ kind: "ci_failed", status: "blocked", evidenceRefs: ["queue:blocker-raw"] }],
        },
      } as unknown as Parameters<typeof collectEvidenceRefs>[0]),
      ["ci:api", "validation:raw-207", "queue:blocker-raw", "ci:deploy", "pr:#207"],
    );
  });

  test("collects diff availability evidence refs and blocked fallback refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        diff_availability: {
          available: false,
          evidence_ref: " diff:explicit ",
          links: {
            html: { href: "diff:link" },
          },
        },
      }),
      ["diff:explicit"],
    );

    assert.deepEqual(
      collectEvidenceRefs({
        diff_availability: {
          available: false,
          links: {
            html: { href: "diff:link" },
          },
        },
      }),
      ["diff:link"],
    );

    assert.deepEqual(
      collectEvidenceRefs({
        diff_availability: {
          available: false,
          error: "GitHub diff timed out.",
        },
      }),
      ["gh:pr-diff"],
    );

    assert.deepEqual(
      collectEvidenceRefs({
        diff_availability: {
          available: true,
          source: "gh-pr-diff",
        },
      }),
      [],
    );
  });

  test("deduplicates diff availability refs already present on blockers", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        merge_blockers: [
          {
            kind: "diff_unavailable",
            status: "blocked",
            summary: "PR diff was unavailable.",
            evidence_refs: ["gh:pr-diff"],
          },
        ],
        diff_availability: {
          available: false,
          error: "PR diff was unavailable.",
        },
      }),
      ["gh:pr-diff"],
    );
  });

  test("falls back to cached merge commit identifier aliases for lineage refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            { sha: " sha201 ", evidence_refs: ["commit:explicit"] },
            { oid: " oid202 ", evidence_refs: [" "] },
            { id: " id203 " },
            { commit: { oid: " nested204 " } },
            { sha: "   " },
          ],
        },
      }),
      [
        "commit:explicit",
        "commit:sha201",
        "commit:oid202",
        "commit:id203",
        "commit:nested204",
      ],
    );
  });

  test("synthesizes PR refs from cached merge commit subjects and URLs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            { sha: "abc201", subject: "Merge pull request #201 from org/api" },
            { sha: "def202", message: "Merge merge request !202 from group/ui" },
            { sha: "ghi203", commit: { messageHeadline: "Merge PR #203 from org/worker" } },
            { sha: "jkl204", web_url: "https://gitlab.example.test/org/repo/-/merge_requests/204" },
            {
              sha: "mno205",
              message: [
                "Merge branch 'feature/api' into 'queue/main'",
                "",
                "See merge request org/repo!205",
              ].join("\n"),
            },
            { sha: "pqr206", commit: { pr_number: "206" } },
            { sha: "vwx208", commit: { pullRequestUrl: "https://github.example.test/org/repo/pull/208" } },
            { sha: "yz209", commit: { merge_request_url: "https://gitlab.example.test/org/repo/-/merge_requests/209" } },
          ],
          constituent_prs: [],
        },
      }),
      [
        "commit:abc201",
        "pr:#201",
        "commit:def202",
        "pr:#202",
        "commit:ghi203",
        "pr:#203",
        "https://gitlab.example.test/org/repo/-/merge_requests/204",
        "commit:jkl204",
        "pr:#204",
        "commit:mno205",
        "pr:#205",
        "commit:pqr206",
        "pr:#206",
        "https://github.example.test/org/repo/pull/208",
        "commit:vwx208",
        "pr:#208",
        "https://gitlab.example.test/org/repo/-/merge_requests/209",
        "commit:yz209",
        "pr:#209",
      ],
    );
  });

  test("synthesizes PR refs from cached merged PR and MR subjects", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            { sha: "ado210", subject: "Merged PR 210: API update" },
            { sha: "ado211", subject: "Merged MR !211: GitLab update" },
            { sha: "ordinary212", subject: "Merged feature branch for release 212" },
          ],
          constituent_prs: [],
        },
      }),
      [
        "commit:ado210",
        "pr:#210",
        "commit:ado211",
        "pr:#211",
        "commit:ordinary212",
      ],
    );
  });

  test("synthesizes PR refs from cached GitLab trailers split across headline and body aliases", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            {
              sha: "top210",
              subject: "Merge branch 'feature/api' into 'queue/main'",
              body: "See merge request org/repo!210",
            },
            {
              sha: "nested211",
              commit: {
                messageHeadline: "Merge branch 'feature/ui' into 'queue/main'",
                messageBody: "See merge request org/repo!211",
              },
            },
            {
              sha: "ordinary212",
              subject: "Document release",
              body: "See merge request org/repo!212",
            },
          ],
          constituent_prs: [],
        },
      }),
      [
        "commit:top210",
        "pr:#210",
        "commit:nested211",
        "pr:#211",
        "commit:ordinary212",
      ],
    );
  });

  test("caps synthesized merge commit lineage refs to displayed queue rows", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: Array.from({ length: 10 }, (_, index) => ({
            sha: `sha-${index + 1}`,
            evidence_refs: [],
          })),
        },
      }),
      [
        "commit:sha-1",
        "commit:sha-2",
        "commit:sha-3",
        "commit:sha-4",
        "commit:sha-5",
        "commit:sha-6",
        "commit:sha-7",
        "commit:sha-8",
      ],
    );
  });

  test("collects cached camelCase constituent evidence refs", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          constituent_prs: [
            { evidenceRefs: [" pr:#201 ", "validation:201"] },
            { evidence_refs: ["pr:#202"], evidenceRefs: ["ignored:duplicate-order"] },
            { prNumber: "203" },
            { iid: 204 },
            { evidenceRefs: ["", "   "] },
          ],
        },
      }),
      ["pr:#201", "validation:201", "pr:#202", "ignored:duplicate-order", "pr:#203", "pr:#204"],
    );
  });

  test("collects refs from direct queue-context edge arrays", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          mergeCommits: [
            { node: { oid: "edge-commit" } },
          ],
          constituentPrs: [
            { cursor: "constituent", node: { prNumber: "205" } },
          ],
          validationEvidence: [
            {
              node: {
                command: "npm test",
                status: "failed",
                scope: "#205",
                evidenceRef: "validation:edge",
              },
            },
          ],
        },
      }),
      ["validation:edge", "commit:edge-commit", "pr:#205"],
    );
  });

  test("collects refs from edge-shaped blockers and nested lineage records", () => {
    assert.deepEqual(
      collectEvidenceRefs({
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
          mergeCommits: [
            {
              node: {
                oid: "edge223",
                commit: {
                  cursor: "nested-commit",
                  node: {
                    evidenceRefs: ["commit:nested-explicit"],
                    mergeRequestUrl: "https://gitlab.example.test/org/repo/-/merge_requests/223",
                  },
                },
              },
            },
          ],
          constituentPrs: [
            {
              cursor: "constituent-223",
              node: {
                prNumber: 223,
                evidenceRefs: ["pr:#223"],
              },
            },
          ],
        },
      }),
      [
        "blocker:blocked",
        "blocker:pending",
        "commit:nested-explicit",
        "commit:edge223",
        "pr:#223",
      ],
    );
  });

  test("collects singular evidence refs from blocker and lineage records", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External gate blocked.",
            evidenceRef: " blocker:external ",
          },
          {
            kind: "deployment_gate",
            status: "blocked",
            summary: "Deployment gate blocked.",
            sourceUrl: " blocker:deployment ",
          },
          {
            kind: "release_gate",
            status: "blocked",
            summary: "Release gate blocked.",
            webUrl: " blocker:release ",
          },
        ],
        queue_context: {
          unresolved_blockers: [
            {
              kind: "queue_validation",
              status: "failed",
              summary: "Queue validation failed.",
              evidence_ref: "queue:blocker",
            },
            {
              kind: "queue_smoke",
              status: "failed",
              summary: "Queue smoke failed.",
              html_url: "queue:smoke",
            },
            {
              kind: "queue_release",
              status: "failed",
              summary: "Queue release failed.",
              permalink: "queue:release",
            },
          ],
          merge_commits: [
            { oid: " oid201 ", evidenceRef: "commit:explicit" },
            { oid: " oid202 ", source_url: "commit:url" },
            { oid: " oid203 ", web_url: "commit:web" },
          ],
          constituent_prs: [
            { number: 201, evidence_ref: "pr:#201" },
            { number: 202, url: "pr:url-202" },
            { number: 203, uri: "pr:uri-203" },
          ],
        },
      }),
      [
        "blocker:external",
        "blocker:deployment",
        "blocker:release",
        "queue:blocker",
        "queue:smoke",
        "queue:release",
        "commit:explicit",
        "commit:oid201",
        "commit:url",
        "commit:oid202",
        "commit:web",
        "commit:oid203",
        "pr:#201",
        "pr:url-202",
        "pr:uri-203",
      ],
    );
  });

  test("collects link-map URL fallback refs from cached queue rows", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          merge_commits: [
            {
              sha: "merge215",
              links: { html: [{ href: "https://github.example.test/org/repo/pull/215" }] },
            },
          ],
          constituent_prs: [
            {
              number: 216,
              _links: { pull_requests: [{ url: "https://github.example.test/org/repo/pull/216" }] },
            },
          ],
          validation_evidence: [
            {
              command: "npm run smoke",
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
              _links: { web: [{ href: "blocker:links-web" }] },
            },
          ],
        },
      }),
      [
        "validation:links-html",
        "blocker:links-web",
        "https://github.example.test/org/repo/pull/215",
        "commit:merge215",
        "https://github.example.test/org/repo/pull/216",
      ],
    );
  });

  test("collects refs from cached camelCase queue context arrays", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          validationEvidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed" },
          ],
          unresolvedBlockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation failed.",
              evidenceRefs: ["queue:blocker"],
            },
          ],
          mergeCommits: [{ oid: " oid201 ", evidenceRefs: ["commit:explicit"] }],
          constituentPrs: [{ evidenceRefs: ["pr:#201"] }],
        },
      }),
      [
        "validation:failed",
        "queue:blocker",
        "commit:explicit",
        "commit:oid201",
        "pr:#201",
      ],
    );
  });

  test("does not collect queue refs when cached queue context is explicitly disabled", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        ci_status: {
          pending_checks: [{ details_url: "ci:pending" }],
        },
        conflicts: {
          has_conflicts: true,
          evidence_refs: ["conflict:merge-tree"],
        },
        queue_context: {
          isQueue: false,
          validationEvidence: [
            { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:failed" },
          ],
          unresolvedBlockers: [
            { kind: "ci_failed", status: "blocked", evidenceRefs: ["queue:blocker"] },
          ],
          mergeCommits: [{ oid: " oid201 ", evidenceRefs: ["commit:explicit"] }],
          constituentPrs: [{ evidenceRefs: ["pr:#201"] }],
        },
      }),
      [
        "conflict:merge-tree",
        "ci:pending",
      ],
    );
  });

  test("collects singular camelCase refs from cached validation evidence rows", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        queue_context: {
          validation_evidence: [
            { cmd: "npm test", result: "failed", pullRequest: "#201", evidenceRef: " validation:failed " },
            { command: "npm lint", status: "passed", scope: "#202", evidenceRef: "validation:passed" },
            { command: "npm smoke", status: "blocked", scope: "#203", sourceUrl: "validation:smoke" },
            { command: "npm docs", status: "passed", scope: "#204", html_url: "validation:docs" },
            { command: "npm release", status: "blocked", scope: "#205", webUrl: "validation:release" },
          ],
        },
      }),
      ["validation:failed", "validation:smoke", "validation:release", "validation:passed", "validation:docs"],
    );
  });

  test("collects comment and source ref aliases from cached evidence rows", () => {
    assert.deepEqual(
      collectEvidenceRefs({
        merge_blockers: [
          {
            kind: "external_gate",
            status: "blocked",
            summary: "External gate blocked.",
            commentRef: "blocker:comment",
          },
        ],
        queue_context: {
          validation_evidence: [
            { command: "npm test", status: "failed", scope: "#201", sourceRef: "validation:source" },
            { command: "npm lint", status: "passed", scope: "#202", source_refs: ["validation:source-list"] },
          ],
          unresolved_blockers: [
            { kind: "ci_failed", status: "blocked", summary: "Queue blocked.", comment_refs: ["queue:comment"] },
          ],
          merge_commits: [{ oid: " oid201 ", sourceRef: "commit:source" }],
          constituent_prs: [{ number: 201, comment_ref: "pr:comment" }],
        },
      }),
      [
        "blocker:comment",
        "validation:source",
        "queue:comment",
        "validation:source-list",
        "commit:source",
        "commit:oid201",
        "pr:comment",
      ],
    );
  });
});
