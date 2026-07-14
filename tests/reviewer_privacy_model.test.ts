import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  redactReviewerText,
  reviewerAccessibleEvidenceRefs,
} from "../reviewer_privacy_model";

describe("reviewer privacy model", () => {
  test("redacts local paths, local URLs, credentials, and email addresses", () => {
    const redacted = redactReviewerText(
      "See /Users/example/dev/repo/log.txt, http://localhost:3000/run, https://user:secret@example.test/check, and person@example.test.",
    );

    assert.doesNotMatch(redacted, /\/Users\/|localhost|user:secret|person@example/);
    assert.match(redacted, /\[local path redacted\]/);
    assert.match(redacted, /https:\/\/example\.test\/check/);
    assert.match(redacted, /\[email redacted\]/);
  });

  test("publishes only reviewer-accessible HTTPS evidence without query secrets", () => {
    assert.deepEqual(
      reviewerAccessibleEvidenceRefs([
        "git:merge-tree",
        "/tmp/check.log",
        "https://example.test/check/42?token=secret#result",
        "https://example.test/check/42?token=other#result",
        "https://localhost/check/42",
      ]),
      ["https://example.test/check/42#result"],
    );
  });
});
