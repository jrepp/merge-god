import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { QueueValidationEvidence } from "@merge-god/github-sync";
import type { ConstituentHint } from "../queue_membership_model";
import {
  buildQueueConstituentPrs,
  resolveQueueMembership,
} from "../queue_membership_resolution_model";

describe("queue membership resolution model", () => {
  test("resolves declared and evidence-backed validation membership", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#201",
            evidence_ref: "https://example.test/org/repo/pull/201#issuecomment-1",
          },
        ],
      ],
      [
        203,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#203",
            evidence_ref: "https://example.test/org/repo/pulls/203#issuecomment-3",
          },
        ],
      ],
      [
        204,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#204",
            evidence_ref: "https://gitlab.example.test/org/repo/-/merge_requests/204#note_4",
          },
        ],
      ],
      [
        999,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#999",
            evidence_ref: "https://example.test/org/repo/pull/202#issuecomment-2",
          },
        ],
      ],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [202],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: false,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [202],
        validation_numbers: [201, 203, 204],
        all_pr_numbers: [201, 202, 203, 204],
        is_queue: true,
      },
    );
  });

  test("resolves declared and synthetic-ref-backed validation membership", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#201",
            evidence_ref: "pr:#201",
          },
        ],
      ],
      [
        203,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#203",
            evidence_ref: "pull_request:203",
          },
        ],
      ],
      [
        204,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#204",
            evidence_ref: "merge_request:!204",
          },
        ],
      ],
      [
        999,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#999",
            evidence_ref: "pr:#202",
          },
        ],
      ],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [202],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: false,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [202],
        validation_numbers: [201, 203, 204],
        all_pr_numbers: [201, 202, 203, 204],
        is_queue: true,
      },
    );
  });

  test("resolves declared membership from cached validation evidence ref aliases", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#201",
            evidenceRef: " pr:#201 ",
          } as unknown as QueueValidationEvidence,
        ],
      ],
      [
        203,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#203",
            comment_refs: ["validation:ignore", "pull_request:203"],
          } as unknown as QueueValidationEvidence,
        ],
      ],
      [
        204,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#204",
            source_ref: "https://gitlab.example.test/org/repo/-/merge_requests/204#note_4",
          } as unknown as QueueValidationEvidence,
        ],
      ],
      [
        999,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#999",
            evidenceRefs: ["merge_request:!202"],
          } as unknown as QueueValidationEvidence,
        ],
      ],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [202],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: false,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [202],
        validation_numbers: [201, 203, 204],
        all_pr_numbers: [201, 202, 203, 204],
        is_queue: true,
      },
    );
  });

  test("lets explicit queue validation seed membership when no declared signals exist", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [201, [{ command: "npm test", status: "passed", scope: "#201", evidence_ref: "validation:201" }]],
      [202, [{ command: "npm test", status: "passed", scope: "#202", evidence_ref: "validation:202" }]],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: true,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [],
        validation_numbers: [201, 202],
        all_pr_numbers: [201, 202],
        is_queue: true,
      },
    );
  });

  test("lets explicit queue validation seed one-constituent membership", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [201, [{ command: "npm test", status: "passed", scope: "#201", evidence_ref: "validation:201" }]],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: true,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [],
        validation_numbers: [201],
        all_pr_numbers: [201],
        is_queue: true,
      },
    );
  });

  test("lets merge-commit context seed validation membership when commit subjects have no PR numbers", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [201, [{ command: "npm test", status: "passed", scope: "#201", evidence_ref: "validation:201" }]],
      [202, [{ command: "npm test", status: "failed", scope: "#202", evidence_ref: "validation:202" }]],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: false,
        mergeCommitCount: 1,
      }),
      {
        declared_numbers: [],
        validation_numbers: [201, 202],
        all_pr_numbers: [201, 202],
        is_queue: true,
      },
    );
  });

  test("does not let declared hint membership absorb unrelated validation rows", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [201, [{ command: "npm test", status: "passed", scope: "#201", evidence_ref: "pr:#201" }]],
      [999, [{ command: "npm test", status: "failed", scope: "#999", evidence_ref: "validation:999" }]],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [],
        mergedPrNumbers: [],
        hintNumbers: [201, 202],
        validationByPr,
        explicitTitleIsQueue: false,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [201, 202],
        validation_numbers: [201],
        all_pr_numbers: [201, 202],
        is_queue: true,
      },
    );
  });

  test("does not infer a queue from one incidental self-referenced validation row", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm test",
            status: "passed",
            scope: "#201",
            evidence_ref: "https://example.test/org/repo/pull/201#issuecomment-1",
          },
        ],
      ],
    ]);

    assert.deepEqual(
      resolveQueueMembership({
        titleNumbers: [],
        mergedPrNumbers: [],
        hintNumbers: [],
        validationByPr,
        explicitTitleIsQueue: false,
        mergeCommitCount: 0,
      }),
      {
        declared_numbers: [],
        validation_numbers: [201],
        all_pr_numbers: [201],
        is_queue: false,
      },
    );
  });

  test("builds constituent evidence refs from cached validation evidence aliases", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            command: "npm test",
            status: "failed",
            scope: "#201",
            evidenceRef: " validation:camel ",
          } as unknown as QueueValidationEvidence,
          {
            command: "npm lint",
            status: "blocked",
            scope: "#201",
            evidence_refs: [" ", "validation:plural", "validation:camel"],
          } as unknown as QueueValidationEvidence,
          {
            command: "npm smoke",
            status: "passed",
            scope: "#201",
            sourceUrl: "validation:source-url",
          } as unknown as QueueValidationEvidence,
          {
            command: "npm docs",
            status: "passed",
            scope: "#201",
            comment_ref: "validation:comment-ref",
            html_url: "validation:ignored-html",
          } as unknown as QueueValidationEvidence,
          {
            command: "npm release",
            status: "passed",
            scope: "#201",
            source_refs: ["validation:source-list"],
          } as unknown as QueueValidationEvidence,
        ],
      ],
    ]);

    assert.deepEqual(
      buildQueueConstituentPrs({
        allPrNumbers: [201],
        constituentHints: new Map(),
        validationByPr,
        mergedPrNumbers: [],
      }),
      [
        {
          number: 201,
          title: null,
          url: null,
          head_sha: null,
          status: "blocked",
          evidence_refs: [
            "validation:camel",
            "validation:plural",
            "validation:source-url",
            "validation:comment-ref",
            "validation:source-list",
            "pr:#201",
          ],
        },
      ],
    );
  });

  test("builds constituent evidence refs from edge-shaped validation evidence", () => {
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [
        201,
        [
          {
            cursor: "validation-edge",
            node: {
              command: "npm test",
              status: "passed",
              scope: "#201",
              evidenceRef: " validation:edge ",
            },
          } as unknown as QueueValidationEvidence,
        ],
      ],
    ]);

    assert.deepEqual(
      buildQueueConstituentPrs({
        allPrNumbers: [201],
        constituentHints: new Map(),
        validationByPr,
        mergedPrNumbers: [],
      }),
      [
        {
          number: 201,
          title: null,
          url: null,
          head_sha: null,
          status: "validated",
          evidence_refs: ["validation:edge", "pr:#201"],
        },
      ],
    );
  });

  test("builds constituents with hint refs, validation refs, and status", () => {
    const hints = new Map<number, ConstituentHint>([
      [
        201,
        {
          number: 201,
          title: "API work",
          url: "https://example.test/org/repo/pull/201",
          head_sha: "abcdef1",
          evidence_refs: ["pr:#201", "github:pr-body"],
        },
      ],
    ]);
    const validationByPr = new Map<number, QueueValidationEvidence[]>([
      [201, [{ command: "npm test", status: "failed", scope: "#201", evidence_ref: "validation:201" }]],
      [202, [{ command: "npm test", status: "unknown", scope: "#202", evidence_ref: "validation:202" }]],
      [203, [{ command: "npm test", status: "passed", scope: "#203", evidence_ref: "validation:203" }]],
    ]);

    assert.deepEqual(
      buildQueueConstituentPrs({
        allPrNumbers: [201, 202, 203, 204, 205],
        constituentHints: hints,
        validationByPr,
        mergedPrNumbers: [204],
      }),
      [
        {
          number: 201,
          title: "API work",
          url: "https://example.test/org/repo/pull/201",
          head_sha: "abcdef1",
          status: "blocked",
          evidence_refs: ["github:pr-body", "validation:201", "pr:#201"],
        },
        {
          number: 202,
          title: null,
          url: null,
          head_sha: null,
          status: "unknown",
          evidence_refs: ["validation:202", "pr:#202"],
        },
        {
          number: 203,
          title: null,
          url: null,
          head_sha: null,
          status: "validated",
          evidence_refs: ["validation:203", "pr:#203"],
        },
        {
          number: 204,
          title: null,
          url: null,
          head_sha: null,
          status: "merged_into_queue",
          evidence_refs: ["pr:#204"],
        },
        {
          number: 205,
          title: null,
          url: null,
          head_sha: null,
          status: "queued",
          evidence_refs: ["pr:#205"],
        },
      ],
    );
  });
});
