import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  firstNormalizedQueueBoolean,
  queueContextConstituentPrs,
  queueContextIsQueue,
  queueContextMergeCommits,
  queueContextStrategy,
  queueContextUnresolvedBlockers,
  queueContextValidationEvidence,
  recognizedQueueStrategy,
} from "../queue_context_access_model";

describe("queue context access model", () => {
  test("normalizes queue context collection aliases", () => {
    assert.equal(queueContextIsQueue({ isQueue: true }), true);
    assert.deepEqual(queueContextConstituentPrs({ constituentPrs: [{ number: 1 }] }), [{ number: 1 }]);
    assert.deepEqual(
      queueContextConstituentPrs({ constituentPrs: [{ evidenceRefs: ["pr:cached"] }] }),
      [{ evidenceRefs: ["pr:cached"] }],
    );
    assert.deepEqual(queueContextMergeCommits({ mergeCommits: [{ oid: "abc" }] }), [{ oid: "abc" }]);
    assert.deepEqual(
      queueContextMergeCommits({ mergeCommits: [{ evidenceRefs: ["commit:cached"] }] }),
      [{ evidenceRefs: ["commit:cached"] }],
    );
    assert.deepEqual(queueContextValidationEvidence({ validationEvidence: [{ command: "npm test" }] }), [{ command: "npm test" }]);
    assert.deepEqual(
      queueContextValidationEvidence({ validationEvidence: [{ evidenceRefs: ["validation:cached"] }] }),
      [{ evidenceRefs: ["validation:cached"] }],
    );
    assert.deepEqual(queueContextUnresolvedBlockers({ unresolvedBlockers: [{ kind: "ci_failed" }] }), [{ kind: "ci_failed" }]);
  });

  test("normalizes queue context integration vocabulary aliases", () => {
    assert.equal(queueContextIsQueue({ prs: [{ number: 201 }] }), true);
    assert.deepEqual(queueContextConstituentPrs({ pullRequests: [{ number: 201 }] }), [{ number: 201 }]);
    assert.deepEqual(queueContextConstituentPrs({ merge_requests: [{ iid: 202 }] }), [{ iid: 202 }]);
    assert.deepEqual(queueContextConstituentPrs({ mergeRequests: [{ mrNumber: 203 }] }), [{ mrNumber: 203 }]);
    assert.deepEqual(queueContextMergeCommits({ commits: [{ oid: "abc" }] }), [{ oid: "abc" }]);
    assert.deepEqual(queueContextMergeCommits({ queueCommits: [{ oid: "def" }] }), [{ oid: "def" }]);
    assert.deepEqual(queueContextMergeCommits({ mergeCommits: [{ mr_iid: "204" }] }), [{ mr_iid: "204" }]);
    assert.deepEqual(queueContextValidationEvidence({ validationResults: [{ command: "npm test" }] }), [{ command: "npm test" }]);
    assert.deepEqual(queueContextValidationEvidence({ check_results: [{ command: "npm lint" }] }), [{ command: "npm lint" }]);
    assert.deepEqual(queueContextValidationEvidence({ validationEvidence: [{ mrNumber: "205" }] }), [{ mrNumber: "205" }]);
    assert.deepEqual(queueContextUnresolvedBlockers({ blockers: [{ kind: "ci_failed" }] }), [{ kind: "ci_failed" }]);
    assert.deepEqual(queueContextUnresolvedBlockers({ queueBlockers: [{ kind: "external_gate" }] }), [{ kind: "external_gate" }]);
  });

  test("normalizes queue context node and edge alias collections", () => {
    assert.deepEqual(
      queueContextConstituentPrs({
        constituentEdges: [
          { node: { prNumber: 201, status: "queued" } },
        ],
      }),
      [{ prNumber: 201, status: "queued" }],
    );
    assert.deepEqual(
      queueContextConstituentPrs({
        pull_request_nodes: {
          nodes: [
            { pullNumber: 202, status: "validated" },
          ],
        },
      }),
      [{ pullNumber: 202, status: "validated" }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        mergeCommitEdges: {
          edges: [
            { node: { oid: "merge201", prNumber: 201 } },
          ],
        },
      }),
      [{ oid: "merge201", prNumber: 201 }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        queue_commit_nodes: [
          { node: { oid: "merge202", pullNumber: 202 } },
        ],
      }),
      [{ oid: "merge202", pullNumber: 202 }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validationEdges: [
          { node: { command: "npm test", status: "failed", scope: "#201" } },
        ],
      }),
      [{ command: "npm test", status: "failed", scope: "#201" }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        check_result_nodes: {
          nodes: [
            { command: "npm lint", status: "passed", scope: "#202" },
          ],
        },
      }),
      [{ command: "npm lint", status: "passed", scope: "#202" }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        unresolvedBlockerEdges: [
          { node: { kind: "ci_failed", status: "blocked" } },
        ],
      }),
      [{ kind: "ci_failed", status: "blocked" }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        queue_blocker_nodes: {
          nodes: [
            { kind: "external_gate", status: "pending" },
          ],
        },
      }),
      [{ kind: "external_gate", status: "pending" }],
    );
  });

  test("normalizes cached queue boolean aliases", () => {
    assert.equal(queueContextIsQueue({ isQueue: "true" }), true);
    assert.equal(queueContextIsQueue({ is_queue: " yes " }), true);
    assert.equal(queueContextIsQueue({ is_queue: "surprise", isQueue: "queue" }), true);
    assert.equal(queueContextIsQueue({ is_queue: "false", isQueue: true }), false);
    assert.equal(queueContextIsQueue({ isQueue: "not-a-queue" }), false);
    assert.equal(queueContextIsQueue({ isQueue: "surprise" }), false);
    assert.equal(firstNormalizedQueueBoolean({ is_queue: "surprise", isQueue: "queue" }), true);
    assert.equal(firstNormalizedQueueBoolean({ is_queue: "false", isQueue: true }), false);
    assert.equal(firstNormalizedQueueBoolean({ isQueue: "surprise" }), null);
  });

  test("infers cached queue context from strategy or populated collections", () => {
    assert.equal(queueContextIsQueue({ strategy: "manual" }), true);
    assert.equal(queueContextIsQueue({ mergeStrategy: "commit history" }), true);
    assert.equal(recognizedQueueStrategy("manual"), true);
    assert.equal(recognizedQueueStrategy("commit history"), true);
    assert.equal(recognizedQueueStrategy("squash"), false);
    assert.equal(queueContextIsQueue({ strategy: "surprise", constituentPrs: [{ number: 201 }] }), true);
    assert.equal(queueContextIsQueue({ mergeCommits: [{ oid: "abc" }] }), true);
    assert.equal(queueContextIsQueue({ constituentPrs: [{ evidenceRef: "pr:cached" }] }), true);
    assert.equal(queueContextIsQueue({ mergeCommits: [{ evidenceRef: "commit:cached" }] }), true);
    assert.equal(queueContextIsQueue({ mergeCommits: [{ sourceRef: "commit:source" }] }), true);
    assert.equal(queueContextIsQueue({ validationEvidence: [{ command: "npm test" }] }), true);
    assert.equal(queueContextIsQueue({ validationEvidence: [{ evidenceRef: "validation:cached" }] }), true);
    assert.equal(queueContextIsQueue({ validationEvidence: [{ commentRef: "validation:comment" }] }), true);
    assert.equal(queueContextIsQueue({ unresolvedBlockers: [{ kind: "ci_failed" }] }), true);
    assert.equal(queueContextIsQueue({ strategy: "surprise", constituentPrs: [] }), false);
    assert.equal(queueContextIsQueue({ is_queue: "false", constituentPrs: [{ number: 201 }] }), false);
  });

  test("retains comment and source ref only queue rows as meaningful", () => {
    assert.deepEqual(
      queueContextConstituentPrs({
        constituentPrs: [{ comment_ref: "pr:comment" }],
      }),
      [{ comment_ref: "pr:comment" }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        mergeCommits: [{ commit: { source_refs: ["commit:nested-source"] } }],
      }),
      [{ commit: { source_refs: ["commit:nested-source"] } }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validationEvidence: [{ sourceRef: "validation:source" }],
      }),
      [{ sourceRef: "validation:source" }],
    );
  });

  test("normalizes queue context connection collections", () => {
    assert.deepEqual(
      queueContextConstituentPrs({
        constituentPrs: {
          nodes: [
            { number: 201 },
            null,
          ],
        },
      }),
      [{ number: 201 }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        mergeCommits: {
          edges: [
            { node: { oid: "abc" } },
            { node: null },
          ],
        },
      }),
      [{ oid: "abc" }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validationEvidence: {
          edges: [
            { node: { command: "npm test" } },
            { node: {} },
          ],
        },
      }),
      [{ command: "npm test" }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        unresolvedBlockers: {
          nodes: [{ kind: "ci_failed" }],
        },
      }),
      [{ kind: "ci_failed" }],
    );
  });

  test("normalizes direct edge-shaped queue context records", () => {
    const queueContext = {
      __typename: "QueueContextEdge",
      cursor: "queue",
      node: {
        isQueue: true,
        queueStrategy: "manual",
        constituentPrs: [{ number: 201 }],
        mergeCommits: [{ oid: "abc" }],
        validationEvidence: [{ command: "npm test" }],
        unresolvedBlockers: [{ kind: "ci_failed" }],
      },
    };

    assert.equal(queueContextIsQueue(queueContext), true);
    assert.equal(queueContextStrategy(queueContext), "manual");
    assert.deepEqual(queueContextConstituentPrs(queueContext), [{ number: 201 }]);
    assert.deepEqual(queueContextMergeCommits(queueContext), [{ oid: "abc" }]);
    assert.deepEqual(queueContextValidationEvidence(queueContext), [{ command: "npm test" }]);
    assert.deepEqual(queueContextUnresolvedBlockers(queueContext), [{ kind: "ci_failed" }]);
    assert.equal(queueContextIsQueue({ node: {} }), false);
  });

  test("normalizes direct edge-array collections", () => {
    assert.deepEqual(
      queueContextConstituentPrs({
        constituentPrs: [
          { __typename: "ConstituentEdge", cursor: "a", node: { number: 201 } },
          { cursor: "empty", node: {} },
        ],
      }),
      [{ number: 201 }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        mergeCommits: [
          { node: { oid: "abc" } },
        ],
      }),
      [{ oid: "abc" }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        mergeCommits: [
          { node: { conflictFiles: { nodes: [{ path: "packages/api/src/app.ts" }] } } },
        ],
      }),
      [{ conflictFiles: { nodes: [{ path: "packages/api/src/app.ts" }] } }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validationEvidence: [
          { node: { command: "npm test", status: "passed" } },
        ],
      }),
      [{ command: "npm test", status: "passed" }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        unresolvedBlockers: [
          { node: { kind: "ci_failed" } },
        ],
      }),
      [{ kind: "ci_failed" }],
    );
  });

  test("falls back past placeholder direct collections to useful aliases", () => {
    assert.deepEqual(
      queueContextConstituentPrs({
        constituent_prs: [
          null,
          {},
          "placeholder",
        ],
        constituentPrs: [{ number: 201 }],
      }),
      [{ number: 201 }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        merge_commits: [
          null,
          {},
          { conflictFiles: { nodes: [] } },
          "placeholder",
        ],
        mergeCommits: [{ conflictFiles: { edges: [{ node: { filename: "packages/api/src/app.ts" } }] } }],
      }),
      [{ conflictFiles: { edges: [{ node: { filename: "packages/api/src/app.ts" } }] } }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validation_evidence: [
          null,
          {},
          "placeholder",
        ],
        validationEvidence: [{ command: "npm test" }],
      }),
      [{ command: "npm test" }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        unresolved_blockers: [
          null,
          {},
          "placeholder",
        ],
        unresolvedBlockers: [{ kind: "ci_failed" }],
      }),
      [{ kind: "ci_failed" }],
    );
  });

  test("falls back past blank canonical queue collection rows to useful aliases", () => {
    assert.deepEqual(
      queueContextConstituentPrs({
        constituent_prs: [{ number: "", title: " ", status: "" }],
        constituentPrs: [{ prNumber: 201, title: "API update" }],
      }),
      [{ prNumber: 201, title: "API update" }],
    );
    assert.deepEqual(
      queueContextConstituentPrs({
        constituent_prs: [{ evidenceRefs: ["pr:canonical"] }],
        constituentPrs: [{ prNumber: 201, title: "API update", evidenceRef: "pr:alias" }],
      }),
      [{ evidenceRefs: ["pr:canonical"] }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        merge_commits: [{ oid: "", sha: " ", message: " ", commit: { messageHeadline: "" } }],
        mergeCommits: [{ oid: "abc", message: "Merge PR #201" }],
      }),
      [{ oid: "abc", message: "Merge PR #201" }],
    );
    assert.deepEqual(
      queueContextMergeCommits({
        merge_commits: [{ commit: { evidenceRefs: ["commit:nested-canonical"] } }],
        mergeCommits: [{ oid: "abc", message: "Merge PR #201", evidenceRef: "commit:alias" }],
      }),
      [{ commit: { evidenceRefs: ["commit:nested-canonical"] } }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validation_evidence: [{ command: " ", status: "", scope: "" }],
        validationEvidence: [{ command: "npm test", status: "failed", scope: "#201" }],
      }),
      [{ command: "npm test", status: "failed", scope: "#201" }],
    );
    assert.deepEqual(
      queueContextValidationEvidence({
        validation_evidence: [{ evidenceRefs: ["validation:canonical"] }],
        validationEvidence: [{ command: "npm test", status: "failed", scope: "#201", evidenceRef: "validation:alias" }],
      }),
      [{ evidenceRefs: ["validation:canonical"] }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        unresolved_blockers: [{ kind: "", status: " ", summary: "" }],
        unresolvedBlockers: [{ kind: "ci_failed", status: "blocked" }],
      }),
      [{ kind: "ci_failed", status: "blocked" }],
    );
    assert.deepEqual(
      queueContextUnresolvedBlockers({
        unresolved_blockers: [{ status: "unknown" }],
        unresolvedBlockers: [{ kind: "ci_failed", status: "blocked" }],
      }),
      [{ status: "unknown" }],
    );
  });

  test("normalizes queue strategy aliases without letting blank canonical values mask aliases", () => {
    assert.equal(queueContextStrategy({ strategy: "manual" }), "manual");
    assert.equal(queueContextStrategy({ strategy: "   ", mergeStrategy: "mergeCommits" }), "mergeCommits");
    assert.equal(queueContextStrategy({ queueStrategy: "titlePrList" }), "titlePrList");
    assert.equal(queueContextStrategy({ strategyLabel: "manual" }), "manual");
    assert.equal(queueContextStrategy({ strategy: 123, mergeStrategy: "mergeCommits" }), "mergeCommits");
    assert.equal(queueContextStrategy({ strategy: 123 }), 123);
  });
});
