import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  commitIdentifier,
  commitMessage,
  commitMessageHeadline,
} from "../commit_access_model";

describe("commit access model", () => {
  test("normalizes commit message and identifier aliases", () => {
    assert.equal(commitIdentifier({ sha: "abc1234" }), "abc1234");
    assert.equal(commitIdentifier({ oid: "def5678" }), "def5678");
    assert.equal(commitIdentifier({ id: "ghi9012" }), "ghi9012");

    assert.equal(commitMessage({ message: "subject\n\nbody" }), "subject\n\nbody");
    assert.equal(commitMessageHeadline({ message: "subject\n\nbody" }), "subject");
    assert.equal(commitMessage({ messageHeadline: "headline", messageBody: "body" }), "headline\n\nbody");
    assert.equal(commitMessageHeadline({ subject: "subject alias" }), "subject alias");
  });

  test("normalizes nested and edge-shaped commit records", () => {
    const commit = {
      cursor: "commit-edge",
      node: {
        commit: {
          cursor: "nested-commit",
          node: {
            oid: "edgecommit123",
            messageHeadline: "Merge PR #301",
            messageBody: "Queue body",
          },
        },
      },
    };

    assert.equal(commitIdentifier(commit), "edgecommit123");
    assert.equal(commitMessage(commit), "Merge PR #301\n\nQueue body");
    assert.equal(commitMessageHeadline(commit), "Merge PR #301");
  });
});
