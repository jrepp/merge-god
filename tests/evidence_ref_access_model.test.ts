import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  evidenceRefCommitIdentifier,
  evidenceRefPrNumber,
  recordEvidenceUrlRefs,
  recordEvidenceRefs,
} from "../evidence_ref_access_model";

describe("evidence ref access model", () => {
  test("preserves explicit evidence refs before URL aliases", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        evidence_ref: " ref:primary ",
        evidenceRefs: ["ref:secondary", "ref:primary", "   "],
        html_url: "ref:html",
        links: { html: { href: "ref:link" } },
      }),
      ["ref:primary", "ref:secondary"],
    );
  });

  test("preserves explicit comment and source ref aliases before URL aliases", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        commentRef: " comment:primary ",
        source_ref: "source:primary",
        comment_refs: ["comment:secondary", "comment:primary"],
        sourceRefs: {
          nodes: [
            { ref: "source:secondary" },
            { value: "source:primary" },
          ],
        },
        html_url: "ref:html",
      }),
      ["comment:primary", "source:primary", "comment:secondary", "source:secondary"],
    );
  });

  test("falls back through URL aliases and forge link maps", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        sourceUrl: " ref:source ",
        target_url: "ref:target",
        detailsUrl: "ref:details",
        web_url: "ref:web",
        pullRequestUrl: "ref:pull",
        url: "ref:url",
        links: {
          html: [{ href: "ref:link-html" }],
          pull_requests: [{ url: "ref:pull-link" }],
        },
        _links: {
          web: { href: "ref:web-link" },
        },
      }),
      [
        "ref:source",
        "ref:target",
        "ref:details",
        "ref:web",
        "ref:pull",
        "ref:url",
        "ref:link-html",
        "ref:pull-link",
        "ref:web-link",
      ],
    );
  });

  test("reads URL aliases independently from explicit refs", () => {
    assert.deepEqual(
      recordEvidenceUrlRefs({
        evidence_refs: ["pr:#201"],
        commentUrl: " https://github.example.test/org/repo/pull/183#issuecomment-42 ",
        discussion_url: "https://github.example.test/org/repo/pull/183#discussion_r43",
        noteUrl: "https://gitlab.example.test/org/repo/-/merge_requests/202#note_44",
        links: {
          api: { href: "https://api.github.example.test/repos/org/repo/issues/comments/45" },
        },
      }),
      [
        "https://github.example.test/org/repo/pull/183#issuecomment-42",
        "https://github.example.test/org/repo/pull/183#discussion_r43",
        "https://gitlab.example.test/org/repo/-/merge_requests/202#note_44",
        "https://api.github.example.test/repos/org/repo/issues/comments/45",
      ],
    );
  });

  test("unwraps direct edge-shaped records before reading refs", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        __typename: "ValidationEvidenceEdge",
        cursor: "validation-201",
        node: {
          evidenceRefs: [" validation:edge ", "pr:#201"],
          html_url: "validation:html",
        },
      }),
      ["validation:edge", "pr:#201"],
    );
  });

  test("normalizes connection-shaped explicit evidence refs", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        evidenceRefs: {
          nodes: [" validation:node ", { ref: "pr:#201" }, { href: "https://example.test/ref" }],
        },
        evidence_refs: {
          edges: [
            { node: "validation:edge" },
            { node: { value: "commit:abc123" } },
            { node: { url: "https://example.test/url" } },
          ],
        },
        html_url: "validation:fallback",
      }),
      [
        "validation:edge",
        "commit:abc123",
        "https://example.test/url",
        "validation:node",
        "pr:#201",
        "https://example.test/ref",
      ],
    );
  });

  test("normalizes nested edge-shaped explicit evidence ref connections", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        evidenceRefs: {
          nodes: [
            { cursor: "validation", node: " validation:nested-node " },
            { __typename: "EvidenceRefEdge", cursor: "pr", node: { ref: "pr:#202" } },
          ],
        },
        evidence_refs: {
          edges: [
            { node: { cursor: "commit", node: { value: "commit:abc123" } } },
            { node: { cursor: "blank", node: {} } },
          ],
        },
      }),
      ["commit:abc123", "validation:nested-node", "pr:#202"],
    );
  });

  test("falls back to URL aliases when explicit evidence ref collections are blank", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        evidenceRefs: { nodes: [" ", { ref: "" }] },
        evidence_refs: { edges: [{ node: null }] },
        html_url: "validation:fallback",
      }),
      ["validation:fallback"],
    );
  });

  test("returns no refs for blank or malformed values", () => {
    assert.deepEqual(
      recordEvidenceRefs({
        evidence_refs: [" ", null],
        html_url: "",
        links: { html: { href: " " } },
      }),
      [],
    );
  });

  test("extracts PR numbers and commit identifiers from normalized refs", () => {
    assert.equal(evidenceRefPrNumber("pr:#201"), 201);
    assert.equal(evidenceRefPrNumber("merge-request:!202"), 202);
    assert.equal(evidenceRefPrNumber("https://github.example.test/org/repo/pulls/203"), 203);
    assert.equal(evidenceRefPrNumber("https://gitlab.example.test/org/repo/-/merge_requests/204"), 204);
    assert.equal(evidenceRefPrNumber("validation:201"), null);
    assert.equal(evidenceRefCommitIdentifier("commit:abc123"), "abc123");
    assert.equal(evidenceRefCommitIdentifier(" commit:abc123 "), "abc123");
    assert.equal(evidenceRefCommitIdentifier("pr:#201"), "");
  });
});
