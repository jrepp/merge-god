import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  changedFileAdditions,
  changedFileDeletions,
  changedFilePath,
  changedFileStatus,
} from "../changed_file_model";

describe("changed file model", () => {
  test("normalizes changed-file path, status, and count aliases", () => {
    assert.equal(changedFilePath({ path: "src/app.ts" }), "src/app.ts");
    assert.equal(changedFilePath({ newPath: "src/new.ts", oldPath: "src/old.ts" }), "src/new.ts");
    assert.equal(changedFilePath({ newPath: "   ", old_path: "src/old.ts" }), "src/old.ts");

    assert.equal(changedFileStatus({ changeType: "ADD" }), "added");
    assert.equal(changedFileStatus({ state: "deleted" }), "removed");
    assert.equal(changedFileStatus({ type: "rename" }), "renamed");
    assert.equal(changedFileStatus({ status: "UPDATED" }), "modified");

    assert.equal(changedFileAdditions({ additionsCount: "12" }), 12);
    assert.equal(changedFileAdditions({ linesAdded: 3 }), 3);
    assert.equal(changedFileDeletions({ deletions_count: "4" }), 4);
    assert.equal(changedFileDeletions({ removedLines: 2 }), 2);
  });

  test("normalizes edge-shaped changed-file records and malformed counts", () => {
    const file = {
      cursor: "file-edge",
      node: {
        filePath: "src/edge.ts",
        change_type: "moved",
        added_lines: "not-a-count",
        lines_deleted: "5",
      },
    };

    assert.equal(changedFilePath(file), "src/edge.ts");
    assert.equal(changedFileStatus(file), "renamed");
    assert.equal(changedFileAdditions(file), 0);
    assert.equal(changedFileDeletions(file), 5);
  });
});
