import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { QueueConstituentPR, QueueValidationEvidence } from "@merge-god/github-sync";
import {
  queueConstituentStatus,
  queueConstituentValidationBlockers,
  queueScopedValidationBlockers,
  queueStrategy,
} from "../queue_blocker_model";

describe("queue blocker model", () => {
  test("projects constituent status from active validation before merge lineage", () => {
    const merged = new Set([201, 202, 203, 204]);
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [201, [{ command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:201" }]],
      [202, [{ command: "npm test", status: "unknown", scope: "#202", evidence_ref: "validation:202" }]],
      [203, [{ command: "npm test", status: "passed", scope: "#203", evidence_ref: "validation:203" }]],
    ]);

    assert.equal(queueConstituentStatus(201, merged, validationByPr), "blocked");
    assert.equal(queueConstituentStatus(202, merged, validationByPr), "unknown");
    assert.equal(queueConstituentStatus(203, merged, validationByPr), "validated");
    assert.equal(queueConstituentStatus(204, merged, validationByPr), "merged_into_queue");
    assert.equal(queueConstituentStatus(205, merged, validationByPr), "queued");
  });

  test("promotes failed and inconclusive PR-scoped validation into constituent blockers", () => {
    const constituents: QueueConstituentPR[] = [
      { number: 201, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#201"] },
      { number: 202, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#202"] },
      { number: 203, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#203"] },
    ];
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          { command: "npm test", status: "failed", scope: "#201", evidence_ref: " validation:201 " },
          { command: "npm lint", status: "blocked", scope: "#201", evidence_ref: "validation:201" },
        ],
      ],
      [202, [{ command: "npm test", status: "unknown", scope: "#202", evidence_ref: "validation:202" }]],
      [203, [{ command: "npm test", status: "passed", scope: "#203", evidence_ref: "validation:203" }]],
    ]);

    assert.deepEqual(queueConstituentValidationBlockers(constituents, validationByPr), [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 2 failed or blocked validation evidence item(s).",
        evidence_refs: ["validation:201"],
      },
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue constituent PR #202 has 1 inconclusive validation evidence item(s).",
        evidence_refs: ["validation:202"],
      },
    ]);
  });

  test("preserves cached validation evidence ref aliases on constituent blockers", () => {
    const constituents: QueueConstituentPR[] = [
      { number: 201, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#201"] },
      { number: 202, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#202"] },
    ];
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm test",
            status: "failed",
            scope: "#201",
            evidenceRef: " validation:camel ",
            html_url: "validation:ignored-url",
          } as unknown as QueueValidationEvidence,
          {
            command: "npm lint",
            status: "blocked",
            scope: "#201",
            evidence_refs: [" ", "validation:plural", "validation:camel"],
          } as unknown as QueueValidationEvidence,
        ],
      ],
      [
        202,
        [
          {
            command: "npm smoke",
            status: "unknown",
            scope: "#202",
            sourceUrl: "validation:source-url",
          } as unknown as QueueValidationEvidence,
          {
            command: "npm docs",
            status: "unknown",
            scope: "#202",
            comment_ref: "validation:comment-ref",
            html_url: "validation:ignored-html",
          } as unknown as QueueValidationEvidence,
        ],
      ],
    ]);

    assert.deepEqual(queueConstituentValidationBlockers(constituents, validationByPr), [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 2 failed or blocked validation evidence item(s).",
        evidence_refs: ["validation:camel", "validation:plural"],
      },
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue constituent PR #202 has 2 inconclusive validation evidence item(s).",
        evidence_refs: ["validation:source-url", "validation:comment-ref"],
      },
    ]);
  });

  test("normalizes cached validation status aliases once while preserving raw refs", () => {
    const constituents: QueueConstituentPR[] = [
      { number: 201, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#201"] },
      { number: 202, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#202"] },
    ];
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm deploy",
            result: "ERROR",
            pullRequest: "PR #201",
            evidence_refs: ["validation:error", "validation:secondary"],
          } as unknown as QueueValidationEvidence,
        ],
      ],
      [
        202,
        [
          {
            command: "npm smoke",
            conclusion: "SUCCESS",
            merge_request_iid: 202,
            evidenceRef: "validation:success",
          } as unknown as QueueValidationEvidence,
        ],
      ],
    ]);

    assert.equal(queueConstituentStatus(201, new Set(), validationByPr), "blocked");
    assert.equal(queueConstituentStatus(202, new Set(), validationByPr), "validated");
    assert.deepEqual(queueConstituentValidationBlockers(constituents, validationByPr), [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["validation:error", "validation:secondary"],
      },
    ]);
  });

  test("preserves edge-shaped validation evidence refs on constituent blockers", () => {
    const constituents: QueueConstituentPR[] = [
      { number: 201, title: null, url: null, head_sha: null, status: "queued", evidence_refs: ["pr:#201"] },
    ];
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            cursor: "validation-edge",
            node: {
              command: "npm test",
              status: "failed",
              scope: "#201",
              evidenceRef: " validation:edge ",
            },
          } as unknown as QueueValidationEvidence,
        ],
      ],
    ]);

    assert.deepEqual(queueConstituentValidationBlockers(constituents, validationByPr), [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #201 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["validation:edge"],
      },
    ]);
  });

  test("promotes non-PR scoped validation blockers and ignores PR-scoped rows", () => {
    assert.deepEqual(
      queueScopedValidationBlockers([
        { command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:pr" },
        { command: "npm lint", status: "failed", scope: "packages/api", evidence_ref: "validation:api" },
        { command: "npm smoke", status: "unknown", scope: null, evidence_ref: "validation:queue" },
        { command: "npm docs", status: "passed", scope: "docs", evidence_ref: "validation:docs" },
      ]),
      [
        {
          kind: "ci_failed",
          status: "blocked",
          summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
          evidence_refs: ["validation:api"],
        },
        {
          kind: "unknown",
          status: "unknown",
          summary: "Queue-wide validation has 1 inconclusive validation evidence item(s).",
          evidence_refs: ["validation:queue"],
        },
      ],
    );
  });

  test("preserves cached validation evidence ref aliases on queue-scoped blockers", () => {
    assert.deepEqual(
      queueScopedValidationBlockers([
        {
          command: "npm lint",
          status: "failed",
          scope: "packages/api",
          evidenceRef: " validation:api ",
          url: "validation:ignored-url",
        } as unknown as QueueValidationEvidence,
        {
          command: "npm smoke",
          status: "blocked",
          scope: "packages/api",
          evidence_refs: ["validation:api-secondary", "validation:api"],
        } as unknown as QueueValidationEvidence,
        {
          command: "npm queue",
          status: "unknown",
          scope: null,
          html_url: "validation:queue-url",
        } as unknown as QueueValidationEvidence,
        {
          command: "npm docs",
          status: "unknown",
          scope: null,
          source_ref: "validation:queue-source-ref",
          url: "validation:ignored-url",
        } as unknown as QueueValidationEvidence,
      ]),
      [
        {
          kind: "ci_failed",
          status: "blocked",
          summary: "Queue validation scope packages/api has 2 failed or blocked validation evidence item(s).",
          evidence_refs: ["validation:api", "validation:api-secondary"],
        },
        {
          kind: "unknown",
          status: "unknown",
          summary: "Queue-wide validation has 2 inconclusive validation evidence item(s).",
          evidence_refs: ["validation:queue-url", "validation:queue-source-ref"],
        },
      ],
    );
  });

  test("ignores cached PR and MR scope aliases when projecting queue-scoped blockers", () => {
    assert.deepEqual(
      queueScopedValidationBlockers([
        { command: "npm github", status: "failed", scope: "PR #201", evidence_ref: "validation:github" },
        { command: "npm gitlab", status: "blocked", scope: "MR !202", evidence_ref: "validation:gitlab" },
        {
          command: "npm linked",
          status: "failed",
          scope: "[#203](https://github.example.test/org/repo/pull/203)",
          evidence_ref: "validation:linked",
        },
        {
          command: "npm url",
          status: "failed",
          scope: "https://gitlab.example.test/org/repo/-/merge_requests/204",
          evidence_ref: "validation:url",
        },
        { command: "npm path", status: "failed", scope: "packages/api", evidence_ref: "validation:path" },
        { command: "npm queue", status: "blocked", scope: "queue-wide", evidence_ref: "validation:queue" },
      ]),
      [
        {
          kind: "ci_failed",
          status: "blocked",
          summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
          evidence_refs: ["validation:path"],
        },
        {
          kind: "ci_failed",
          status: "blocked",
          summary: "Queue-wide validation has 1 failed or blocked validation evidence item(s).",
          evidence_refs: ["validation:queue"],
        },
      ],
    );
  });

  test("chooses queue strategy from strongest available lineage signal", () => {
    const mergeCommits = [
      { sha: "abc1234", pr_number: 201, subject: "Merge pull request #201", conflict_files: [], evidence_refs: [] },
    ];

    assert.equal(queueStrategy([201], mergeCommits, [202]), "title_pr_list");
    assert.equal(queueStrategy([], mergeCommits, [202]), "merge_commits");
    assert.equal(queueStrategy([], [], [202]), "manual");
    assert.equal(queueStrategy([], [], []), "unknown");
  });
});
