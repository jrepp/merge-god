import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  diffAvailabilityEvidenceRefs,
  diffAvailabilityEvidenceDetail,
  diffAvailabilityMergeBlocker,
  diffAvailabilitySourceLabel,
  diffAvailabilityStatus,
  diffUnavailableReason,
  diffUnavailableBlockerSummary,
} from "../diff_availability_model";

describe("diff availability model", () => {
  test("renders captured diff details with explicit defaults", () => {
    assert.equal(diffAvailabilityStatus({ available: true }), "pass");
    assert.equal(diffAvailabilityStatus({ available: "available" }), "pass");
    assert.equal(diffAvailabilityStatus({ isAvailable: "captured" }), "pass");
    assert.equal(
      diffAvailabilityEvidenceDetail({ available: true, source: "  ", size: null }),
      "Captured from unknown (size unavailable).",
    );
    assert.equal(
      diffAvailabilityEvidenceDetail({ available: "true", source: " gh-pr-diff ", size: 0 }),
      "Captured from gh-pr-diff (0 bytes).",
    );
    assert.equal(
      diffAvailabilityEvidenceDetail({ is_available: true, provider: " gh-api ", byteSize: 128 }),
      "Captured from gh-api (128 bytes).",
    );
  });

  test("renders unavailable diff details separately from blocker summaries", () => {
    const diffAvailability = { available: "too large", error: "   " };

    assert.equal(diffAvailabilityStatus(diffAvailability), "blocked");
    assert.equal(diffAvailabilityEvidenceDetail(diffAvailability), "Diff unavailable.");
    assert.equal(
      diffUnavailableBlockerSummary(diffAvailability),
      "PR diff was unavailable during context gathering.",
    );
  });

  test("normalizes cached diff availability field aliases", () => {
    const diffAvailability = {
      diffAvailable: "timeout",
      errorMessage: "GitHub diff timed out.",
    };

    assert.equal(diffAvailabilityStatus(diffAvailability), "blocked");
    assert.equal(diffAvailabilityEvidenceDetail(diffAvailability), "GitHub diff timed out.");
    assert.equal(diffAvailabilitySourceLabel({ provider: " cached " }), "cached");
    assert.equal(diffUnavailableReason(diffAvailability, "fallback reason"), "GitHub diff timed out.");
    assert.equal(diffUnavailableBlockerSummary(diffAvailability), "GitHub diff timed out.");
  });

  test("normalizes direct edge-shaped diff availability records", () => {
    const unavailable = {
      cursor: "diff-edge",
      node: {
        isAvailable: "timeout",
        errorMessage: "GitHub diff timed out.",
        evidenceRef: "diff:edge",
      },
    };
    const available = {
      cursor: "diff-available-edge",
      node: {
        captured: "true",
        provider: "gh-pr-diff",
        byteSize: 2048,
      },
    };

    assert.equal(diffAvailabilityStatus(unavailable), "blocked");
    assert.equal(diffAvailabilityEvidenceDetail(unavailable), "GitHub diff timed out.");
    assert.equal(diffUnavailableBlockerSummary(unavailable), "GitHub diff timed out.");
    assert.deepEqual(diffAvailabilityEvidenceRefs(unavailable), ["diff:edge"]);
    assert.equal(diffAvailabilityStatus(available), "pass");
    assert.equal(diffAvailabilityEvidenceDetail(available), "Captured from gh-pr-diff (2048 bytes).");
  });

  test("normalizes diff availability evidence refs with fallback", () => {
    assert.deepEqual(
      diffAvailabilityEvidenceRefs({
        available: false,
        evidence_ref: " diff:explicit ",
        evidence_refs: ["diff:ignored"],
        url: "diff:url",
      }),
      ["diff:explicit", "diff:ignored"],
    );
    assert.deepEqual(
      diffAvailabilityEvidenceRefs({
        available: false,
        sourceUrl: " diff:source ",
        links: { html: { href: "diff:link" } },
      }),
      ["diff:source", "diff:link"],
    );
    assert.deepEqual(
      diffAvailabilityEvidenceRefs({
        available: false,
        commentRef: "diff:comment",
        source_refs: ["diff:source-list"],
        html_url: "diff:ignored",
      }),
      ["diff:comment", "diff:source-list"],
    );
    assert.deepEqual(diffAvailabilityEvidenceRefs({ available: false }), ["gh:pr-diff"]);
    assert.deepEqual(diffAvailabilityEvidenceRefs({ available: true, source: "gh-pr-diff" }), []);
  });

  test("projects unavailable diff evidence into a merge blocker", () => {
    assert.deepEqual(
      diffAvailabilityMergeBlocker({
        available: false,
        error: "GitHub diff timed out.",
        evidenceRef: "diff:timeout",
      }),
      {
        kind: "diff_unavailable",
        status: "blocked",
        summary: "GitHub diff timed out.",
        evidence_refs: ["diff:timeout"],
      },
    );
    assert.deepEqual(
      diffAvailabilityMergeBlocker({ available: false }),
      {
        kind: "diff_unavailable",
        status: "blocked",
        summary: "PR diff was unavailable during context gathering.",
        evidence_refs: ["gh:pr-diff"],
      },
    );
    assert.equal(diffAvailabilityMergeBlocker({ available: true }), null);
    assert.equal(diffAvailabilityMergeBlocker({ source: "gh-pr-diff" }), null);
  });

  test("falls back past blank or malformed availability values to useful aliases", () => {
    const unavailable = {
      available: "   ",
      isAvailable: "timeout",
      error: "   ",
      errorMessage: "GitHub diff timed out.",
    };
    const available = {
      available: "surprise",
      captured: "true",
      source: "gh-pr-diff",
      size: 0,
      byteSize: 4096,
    };

    assert.equal(diffAvailabilityStatus(unavailable), "blocked");
    assert.equal(diffAvailabilityEvidenceDetail(unavailable), "GitHub diff timed out.");
    assert.equal(diffUnavailableBlockerSummary(unavailable), "GitHub diff timed out.");
    assert.equal(diffAvailabilityStatus(available), "pass");
    assert.equal(diffAvailabilityEvidenceDetail(available), "Captured from gh-pr-diff (4096 bytes).");
  });

  test("treats partial malformed records as unknown evidence, not blocker evidence", () => {
    const diffAvailability = { source: "gh-pr-diff" };

    assert.equal(diffAvailabilityStatus(diffAvailability), "unknown");
    assert.equal(diffAvailabilityEvidenceDetail(diffAvailability), "Diff availability is unknown.");
    assert.equal(diffAvailabilityStatus({ available: "surprise" }), "unknown");
  });
});
