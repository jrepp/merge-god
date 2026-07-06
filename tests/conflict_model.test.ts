import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_MERGE_CONFLICT_SUMMARY_FILE_LIMIT,
  activeMergeConflictSummary,
  hasActiveMergeConflicts,
  mergeConflictActivityStatus,
  mergeConflictSummary,
  normalizeMergeConflictEvidence,
} from "../conflict_model";

describe("merge conflict evidence normalization", () => {
  test("exports the default active conflict file summary limit", () => {
    assert.equal(ACTIVE_MERGE_CONFLICT_SUMMARY_FILE_LIMIT, 8);
  });

  test("uses the larger of explicit count and unique listed files", () => {
    assert.deepEqual(
      normalizeMergeConflictEvidence({
        conflict_count: 1,
        conflicting_files: [
          "packages/api/src/routes.ts",
          " packages/api/src/routes.ts ",
          "",
          null,
          "apps/web/src/App.tsx",
        ],
      }),
      {
        count: 2,
        listed_files: ["apps/web/src/App.tsx", "packages/api/src/routes.ts"],
        listed_count: 2,
        evidence_refs: ["git:merge-tree"],
      },
    );
  });

  test("preserves explicit evidence refs after trimming and deduping", () => {
    assert.deepEqual(
      normalizeMergeConflictEvidence({
        conflict_count: 3,
        conflicting_files: ["packages/api/src/routes.ts"],
        evidence_refs: [" conflict:merge-tree ", "", "conflict:merge-tree", "conflict:rerere"],
      }),
      {
        count: 3,
        listed_files: ["packages/api/src/routes.ts"],
        listed_count: 1,
        evidence_refs: ["conflict:merge-tree", "conflict:rerere"],
      },
    );
  });

  test("normalizes cached camelCase conflict fields", () => {
    const conflicts = {
      hasConflicts: true,
      conflictCount: 1,
      conflictingFiles: [
        "packages/api/src/app.ts",
        " packages/api/src/app.ts ",
        "packages/ui/src/view.ts",
      ],
      evidenceRefs: [" conflict:cached ", "conflict:cached"],
    };

    assert.equal(hasActiveMergeConflicts(conflicts), true);
    assert.deepEqual(normalizeMergeConflictEvidence(conflicts), {
      count: 2,
      listed_files: ["packages/api/src/app.ts", "packages/ui/src/view.ts"],
      listed_count: 2,
      evidence_refs: ["conflict:cached"],
    });
    assert.equal(
      activeMergeConflictSummary(conflicts).detail,
      "2 active conflict file(s): packages/api/src/app.ts, packages/ui/src/view.ts",
    );
  });

  test("normalizes collection-shaped conflict file aliases", () => {
    const conflicts = {
      hasConflicts: true,
      conflictCount: 1,
      conflictFiles: {
        edges: [
          { node: { path: "packages/api/src/app.ts" } },
          { node: " packages/ui/src/view.ts " },
        ],
      },
      conflict_files: {
        nodes: [
          { filename: "packages/jobs/src/worker.ts" },
          { newPath: "packages/api/src/app.ts" },
        ],
      },
      evidenceRefs: { nodes: ["conflict:cached", { ref: "git:merge-tree --name-only" }] },
    };

    assert.deepEqual(normalizeMergeConflictEvidence(conflicts), {
      count: 3,
      listed_files: [
        "packages/api/src/app.ts",
        "packages/jobs/src/worker.ts",
        "packages/ui/src/view.ts",
      ],
      listed_count: 3,
      evidence_refs: ["conflict:cached", "git:merge-tree --name-only"],
    });
    assert.equal(
      activeMergeConflictSummary(conflicts).detail,
      "3 active conflict file(s): packages/api/src/app.ts, packages/jobs/src/worker.ts, packages/ui/src/view.ts",
    );
  });

  test("normalizes direct edge-shaped conflict records", () => {
    const conflicts = {
      cursor: "conflicts-edge",
      node: {
        hasConflicts: "yes",
        conflictCount: 1,
        conflictingFiles: [
          "packages/api/src/edge.ts",
          " packages/api/src/edge.ts ",
          "packages/web/src/app.ts",
        ],
        evidenceRef: " conflict:edge ",
      },
    };

    assert.equal(hasActiveMergeConflicts(conflicts), true);
    assert.deepEqual(normalizeMergeConflictEvidence(conflicts), {
      count: 2,
      listed_files: ["packages/api/src/edge.ts", "packages/web/src/app.ts"],
      listed_count: 2,
      evidence_refs: ["conflict:edge"],
    });
    assert.equal(
      mergeConflictSummary(conflicts),
      "Merge conflicts detected in 2 file(s).",
    );
    assert.equal(
      activeMergeConflictSummary(conflicts).detail,
      "2 active conflict file(s): packages/api/src/edge.ts, packages/web/src/app.ts",
    );
  });

  test("normalizes serialized active conflict booleans", () => {
    assert.equal(hasActiveMergeConflicts({ hasConflicts: "true" }), true);
    assert.equal(hasActiveMergeConflicts({ has_conflicts: " yes " }), true);
    assert.equal(hasActiveMergeConflicts({ has_merge_conflicts: "conflicted" }), true);
    assert.equal(hasActiveMergeConflicts({ has_conflicts: "false", hasConflicts: true }), false);
    assert.equal(hasActiveMergeConflicts({ hasConflicts: "clean" }), false);
    assert.equal(hasActiveMergeConflicts({ hasConflicts: "surprise" }), false);
    assert.equal(mergeConflictActivityStatus({ hasConflicts: "true" }), "active");
    assert.equal(mergeConflictActivityStatus({ hasConflicts: "clean" }), "clean");
    assert.equal(mergeConflictActivityStatus({ hasConflicts: "surprise" }), "unknown");
    assert.equal(mergeConflictActivityStatus({ conflictCount: 2 }), "unknown");
  });

  test("does not let zero canonical conflict counts hide count and singular file aliases", () => {
    const conflicts = {
      has_conflicts: true,
      conflict_count: 0,
      conflictCount: 3,
      conflict_file: "packages/api/src/app.ts",
      conflictingFile: "packages/ui/src/view.ts",
      evidenceRefs: [" conflict:cached "],
    };

    assert.deepEqual(normalizeMergeConflictEvidence(conflicts), {
      count: 3,
      listed_files: ["packages/api/src/app.ts", "packages/ui/src/view.ts"],
      listed_count: 2,
      evidence_refs: ["conflict:cached"],
    });
    assert.equal(
      activeMergeConflictSummary(conflicts).detail,
      "3 active conflict file(s): packages/api/src/app.ts, packages/ui/src/view.ts (2 listed)",
    );
  });

  test("summarizes unavailable conflict counts without saying zero files", () => {
    assert.equal(
      mergeConflictSummary({ conflict_count: -1, conflicting_files: [] }),
      "Merge conflicts detected, but the conflicting file count was unavailable.",
    );
  });

  test("summarizes active conflict evidence with listed-file caps and unavailable counts", () => {
    assert.deepEqual(
      activeMergeConflictSummary({
        conflict_count: 3,
        conflicting_files: [
          "packages/api/src/routes.ts",
          "apps/web/src/App.tsx",
        ],
      }),
      {
        count: 3,
        detail: "3 active conflict file(s): apps/web/src/App.tsx, packages/api/src/routes.ts (2 listed)",
      },
    );
    assert.deepEqual(
      activeMergeConflictSummary({
        conflicting_files: Array.from({ length: 10 }, (_, index) => `pkg/file-${index + 1}.ts`),
      }, 3),
      {
        count: 10,
        detail: "10 active conflict file(s): pkg/file-1.ts, pkg/file-10.ts, pkg/file-2.ts, 7 more",
      },
    );
    assert.deepEqual(
      activeMergeConflictSummary({ conflicting_files: [] }),
      {
        count: 0,
        detail: "Active merge conflicts detected; file count and file list unavailable.",
      },
    );
    assert.deepEqual(
      activeMergeConflictSummary({ conflict_count: 2, conflicting_files: [] }),
      {
        count: 2,
        detail: "2 active conflict file(s); file list unavailable.",
      },
    );
    assert.deepEqual(
      activeMergeConflictSummary({
        conflicting_files: Array.from({ length: ACTIVE_MERGE_CONFLICT_SUMMARY_FILE_LIMIT + 1 }, (_, index) => `pkg/default-${index + 1}.ts`),
      }),
      {
        count: 9,
        detail: "9 active conflict file(s): pkg/default-1.ts, pkg/default-2.ts, pkg/default-3.ts, pkg/default-4.ts, pkg/default-5.ts, pkg/default-6.ts, pkg/default-7.ts, pkg/default-8.ts, 1 more",
      },
    );
  });
});
