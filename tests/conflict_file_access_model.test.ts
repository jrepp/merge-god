import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  conflictFileName,
  recordConflictFiles,
} from "../conflict_file_access_model";

describe("conflict file access model", () => {
  test("normalizes scalar and record conflict file names", () => {
    assert.equal(conflictFileName(" packages/api/src/app.ts "), "packages/api/src/app.ts");
    assert.equal(conflictFileName({ path: "packages/api/src/path.ts" }), "packages/api/src/path.ts");
    assert.equal(conflictFileName({ filename: "packages/api/src/file.ts" }), "packages/api/src/file.ts");
    assert.equal(conflictFileName({ new_path: "packages/api/src/new.ts" }), "packages/api/src/new.ts");
    assert.equal(conflictFileName({ oldPath: "packages/api/src/old.ts" }), "packages/api/src/old.ts");
    assert.equal(conflictFileName({ path: " " }), "");
  });

  test("normalizes direct, singular, and collection-shaped conflict file aliases", () => {
    assert.deepEqual(
      recordConflictFiles({
        conflictFiles: {
          nodes: [" packages/api/src/app.ts ", { path: "apps/web/src/App.tsx" }],
        },
        conflicting_files: {
          edges: [
            { node: { filename: "packages/workers/src/job.ts" } },
            { node: null },
          ],
        },
        conflict_file: "packages/ui/src/button.ts",
        conflictingFile: { newPath: "packages/config/src/nested.ts" },
      }),
      [
        "packages/api/src/app.ts",
        "apps/web/src/App.tsx",
        "packages/workers/src/job.ts",
        "packages/config/src/nested.ts",
        "packages/ui/src/button.ts",
      ],
    );
  });
});
