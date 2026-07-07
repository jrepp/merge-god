/**
 * Port of tests/test_fixes.py.
 *
 * Exercises `validateGitRef` (the git-ref safety check added to pr-loop.py).
 * The Python test shipped an inline copy of the function; here we import the
 * real implementation from pr-loop.ts so the test guards the actual code path.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PR_VIEW_JSON_FIELDS, validateGitRef } from "../pr-loop";

describe("validateGitRef", () => {
  test("accepts valid refs", () => {
    assert.equal(validateGitRef("main"), true);
    assert.equal(validateGitRef("master"), true);
    assert.equal(validateGitRef("feature/test"), true);
    assert.equal(validateGitRef("feature-branch"), true);
    assert.equal(validateGitRef("release_1.0"), true);
  });

  test("rejects refs with unsafe characters or patterns", () => {
    assert.equal(validateGitRef("bad..branch"), false, "'..' should be invalid");
    assert.equal(validateGitRef("bad branch"), false, "space should be invalid");
    assert.equal(validateGitRef("bad~branch"), false, "'~' should be invalid");
    assert.equal(validateGitRef("bad^branch"), false, "'^' should be invalid");
    assert.equal(validateGitRef("bad:branch"), false, "':' should be invalid");
    assert.equal(validateGitRef(".hidden"), false, "leading '.' should be invalid");
    assert.equal(validateGitRef("/absolute"), false, "leading '/' should be invalid");
    assert.equal(validateGitRef("trailing/"), false, "trailing '/' should be invalid");
    assert.equal(validateGitRef("ends.lock"), false, "trailing '.lock' should be invalid");
    assert.equal(validateGitRef(""), false, "empty string should be invalid");
    assert.equal(validateGitRef("a".repeat(201)), false, "over 200 chars should be invalid");
  });

  test("rejects non-string inputs", () => {
    // The Python version tolerated type errors from None/int/list; the TS
    // signature is `(ref: string)` so call with casts to exercise the runtime
    // type guard (`!ref || typeof ref !== "string"`).
    assert.equal(validateGitRef(null as unknown as string), false, "null should be invalid");
    assert.equal(validateGitRef(undefined as unknown as string), false, "undefined should be invalid");
    assert.equal(validateGitRef(123 as unknown as string), false, "number should be invalid");
    assert.equal(validateGitRef(["list"] as unknown as string), false, "array should be invalid");
  });
});

describe("GitHub CLI field compatibility", () => {
  test("PR detail fields avoid removed reviewers field", () => {
    assert.equal(PR_VIEW_JSON_FIELDS.includes("reviewers" as never), false);
    assert.equal(PR_VIEW_JSON_FIELDS.includes("reviewRequests"), true);
    assert.equal(PR_VIEW_JSON_FIELDS.includes("latestReviews"), true);
  });
});
