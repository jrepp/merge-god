import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  constituentStatusProvenanceRefs,
  isStatusProvenanceRef,
  recordStatusProvenanceRefs,
} from "../status_provenance_model";

describe("status provenance model", () => {
  test("recognizes concrete browser and API status provenance URLs", () => {
    assert.equal(isStatusProvenanceRef("https://github.example.test/org/repo/pull/183#issuecomment-215622762"), true);
    assert.equal(isStatusProvenanceRef("https://github.example.test/org/repo/pull/183#discussion_r123456"), true);
    assert.equal(isStatusProvenanceRef("https://gitlab.example.test/org/repo/-/merge_requests/201#note_987654"), true);
    assert.equal(isStatusProvenanceRef("https://api.github.example.test/repos/org/repo/issues/comments/42"), true);
    assert.equal(isStatusProvenanceRef("https://api.github.example.test/repos/org/repo/pulls/comments/43"), true);
    assert.equal(isStatusProvenanceRef("https://gitlab.example.test/api/v4/projects/5/merge_requests/201/notes/987"), true);
    assert.equal(isStatusProvenanceRef("comment:merge-table#issuecomment-215622762"), false);
    assert.equal(isStatusProvenanceRef("https://github.example.test/org/repo/pull/183#issuecomment-merge-forward"), false);
    assert.equal(isStatusProvenanceRef("https://api.github.example.test/repos/org/repo/issues/42"), false);
  });

  test("collects status provenance from URL aliases even when explicit refs exist", () => {
    assert.deepEqual(
      recordStatusProvenanceRefs({
        evidence_refs: ["pr:#201"],
        sourceUrl: "https://github.example.test/org/repo/pull/183#issuecomment-215622762",
        links: {
          api: { href: "https://api.github.example.test/repos/org/repo/issues/comments/42" },
        },
      }),
      [
        "https://github.example.test/org/repo/pull/183#issuecomment-215622762",
        "https://api.github.example.test/repos/org/repo/issues/comments/42",
      ],
    );
  });

  test("orders constituent status provenance by status severity and merged PR recency", () => {
    assert.deepEqual(
      constituentStatusProvenanceRefs([
        {
          number: 185,
          status: "merged_into_queue",
          evidence_refs: ["https://github.example.test/org/repo/pull/183#issuecomment-215544269", "pr:#185"],
        },
        {
          number: 194,
          status: "merged_into_queue",
          evidence_refs: ["https://github.example.test/org/repo/pull/183#issuecomment-215622762", "pr:#194"],
        },
        {
          number: 201,
          status: "validated",
          evidence_refs: ["https://github.example.test/org/repo/pull/183#discussion_r201"],
        },
        {
          number: 202,
          status: "unknown",
          evidence_refs: ["https://gitlab.example.test/org/repo/-/merge_requests/202#note_202"],
        },
        {
          number: 203,
          status: "blocked",
          sourceUrl: "https://api.github.example.test/repos/org/repo/issues/comments/203",
          evidence_refs: ["pr:#203"],
        },
      ]),
      [
        "https://api.github.example.test/repos/org/repo/issues/comments/203",
        "https://gitlab.example.test/org/repo/-/merge_requests/202#note_202",
        "https://github.example.test/org/repo/pull/183#discussion_r201",
        "https://github.example.test/org/repo/pull/183#issuecomment-215622762",
        "https://github.example.test/org/repo/pull/183#issuecomment-215544269",
      ],
    );
  });

  test("deduplicates repeated provenance using the most severe constituent", () => {
    assert.deepEqual(
      constituentStatusProvenanceRefs([
        {
          number: 201,
          status: "merged_into_queue",
          evidence_refs: ["https://github.example.test/org/repo/pull/183#issuecomment-42"],
        },
        {
          number: 202,
          status: "blocked",
          evidence_refs: ["https://github.example.test/org/repo/pull/183#issuecomment-42"],
        },
      ]),
      ["https://github.example.test/org/repo/pull/183#issuecomment-42"],
    );
  });
});
