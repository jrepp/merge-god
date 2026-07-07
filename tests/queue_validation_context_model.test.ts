import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { QueueValidationEvidence } from "@merge-god/github-sync";
import {
  normalizeQueuePrSelfValidationEvidence,
  normalizeQueuePrSelfValidationScope,
  queueValidationCommentTimestampMs,
  sortQueueValidationCommentsChronologically,
} from "../queue_validation_context_model";

describe("queue validation context model", () => {
  test("uses edited, submitted, then created timestamps for validation source ordering", () => {
    assert.equal(
      queueValidationCommentTimestampMs({
        created_at: "2026-01-01T00:00:00Z",
        submitted_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
      }),
      Date.parse("2026-01-03T00:00:00Z"),
    );

    assert.equal(
      queueValidationCommentTimestampMs({
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        editedAt: "2026-01-03T00:00:00Z",
      }),
      Date.parse("2026-01-03T00:00:00Z"),
    );

    assert.equal(
      queueValidationCommentTimestampMs({
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        lastEditedAt: "2026-01-03T00:00:00Z",
      }),
      Date.parse("2026-01-03T00:00:00Z"),
    );

    assert.equal(
      queueValidationCommentTimestampMs({
        createdAt: "2026-01-01T00:00:00Z",
        submittedAt: "2026-01-02T00:00:00Z",
      }),
      Date.parse("2026-01-02T00:00:00Z"),
    );

    assert.equal(
      queueValidationCommentTimestampMs({
        createdAt: "2026-01-01T00:00:00Z",
        publishedAt: "2026-01-02T00:00:00Z",
      }),
      Date.parse("2026-01-02T00:00:00Z"),
    );

    assert.equal(queueValidationCommentTimestampMs({ updated_at: "not a date" }), null);
    assert.equal(queueValidationCommentTimestampMs(null), null);
  });

  test("normalizes direct edge-shaped timestamps for validation source ordering", () => {
    assert.equal(
      queueValidationCommentTimestampMs({
        cursor: "comment-edge",
        node: {
          createdAt: "2026-01-01T00:00:00Z",
          submittedAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
        },
      }),
      Date.parse("2026-01-03T00:00:00Z"),
    );
  });

  test("sorts untimestamped comments first and preserves source order for timestamp ties", () => {
    const comments = [
      { id: "late", created_at: "2026-01-04T00:00:00Z" },
      { id: "untimestamped" },
      { id: "tie-a", created_at: "2026-01-02T00:00:00Z" },
      { id: "early", created_at: "2026-01-01T00:00:00Z" },
      { id: "tie-b", created_at: "2026-01-02T00:00:00Z" },
    ];

    assert.deepEqual(
      sortQueueValidationCommentsChronologically(comments).map((comment) => (comment as { id: string }).id),
      ["untimestamped", "early", "tie-a", "tie-b", "late"],
    );
  });

  test("normalizes validation scoped to the aggregate queue PR as queue-wide evidence", () => {
    const evidence: QueueValidationEvidence = {
      command: "npm test",
      status: "failed",
      scope: "#300",
      evidence_ref: "comment:queue-self",
    };

    assert.deepEqual(normalizeQueuePrSelfValidationScope(evidence, 300), {
      ...evidence,
      scope: null,
    });
    assert.deepEqual(normalizeQueuePrSelfValidationScope(evidence, 301), evidence);
    assert.deepEqual(normalizeQueuePrSelfValidationScope(evidence, null), evidence);
  });

  test("normalizes aggregate queue PR scope aliases before self-scope comparison", () => {
    const aliases: QueueValidationEvidence[] = [
      { command: "npm github", status: "failed", scope: "PR #300", evidence_ref: "comment:github" },
      { command: "npm gitlab", status: "blocked", scope: "MR !300", evidence_ref: "comment:gitlab" },
      {
        command: "npm linked",
        status: "failed",
        scope: "[#300](https://github.example.test/org/repo/pull/300)",
        evidence_ref: "comment:linked",
      },
      {
        command: "npm url",
        status: "unknown",
        scope: "https://gitlab.example.test/org/repo/-/merge_requests/300",
        evidence_ref: "comment:url",
      },
      { command: "npm path", status: "failed", scope: "packages/api", evidence_ref: "comment:path" },
    ];

    assert.deepEqual(normalizeQueuePrSelfValidationEvidence(aliases, 300), [
      { command: "npm github", status: "failed", scope: null, evidence_ref: "comment:github" },
      { command: "npm gitlab", status: "blocked", scope: null, evidence_ref: "comment:gitlab" },
      { command: "npm linked", status: "failed", scope: null, evidence_ref: "comment:linked" },
      { command: "npm url", status: "unknown", scope: null, evidence_ref: "comment:url" },
      { command: "npm path", status: "failed", scope: "packages/api", evidence_ref: "comment:path" },
    ]);
  });

  test("normalizes only queue self-scoped entries in validation evidence arrays", () => {
    const evidence: QueueValidationEvidence[] = [
      { command: "npm test", status: "failed", scope: "#300", evidence_ref: "comment:queue" },
      { command: "npm lint", status: "passed", scope: "#301", evidence_ref: "comment:constituent" },
      { command: "npm smoke", status: "unknown", scope: "packages/api", evidence_ref: "comment:path" },
    ];

    assert.deepEqual(normalizeQueuePrSelfValidationEvidence(evidence, 300), [
      { command: "npm test", status: "failed", scope: null, evidence_ref: "comment:queue" },
      { command: "npm lint", status: "passed", scope: "#301", evidence_ref: "comment:constituent" },
      { command: "npm smoke", status: "unknown", scope: "packages/api", evidence_ref: "comment:path" },
    ]);
  });
});
