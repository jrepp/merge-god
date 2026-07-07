import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  commentAuthorLogin,
  commentBody,
  commentEvidenceRef,
  commentLine,
  commentPath,
} from "../comment_access_model";

describe("comment access model", () => {
  test("normalizes cached comment body aliases", () => {
    assert.equal(commentBody({ body: "comment body" }), "comment body");
    assert.equal(commentBody({ body: "   ", bodyText: "cached body" }), "cached body");
    assert.equal(commentBody({ body_text: "snake body" }), "snake body");
    assert.equal(commentBody({ text: "plain text" }), "plain text");
    assert.equal(commentBody({ content: "content body" }), "content body");
    assert.equal(commentBody({ description: "description body" }), "description body");
    assert.equal(commentBody({ message: "message body" }), "message body");
    assert.equal(commentBody({}, "fallback body"), "fallback body");
  });

  test("normalizes direct edge-shaped comments", () => {
    const comment = {
      cursor: "comment-1",
      node: {
        author: { node: { username: "edge-author" } },
        bodyText: "edge body",
        filePath: "src/edge.ts",
        originalLine: 42,
        htmlUrl: "https://example.test/pull/300#issuecomment-edge",
      },
    };

    assert.equal(commentAuthorLogin(comment), "edge-author");
    assert.equal(commentBody(comment), "edge body");
    assert.equal(commentPath(comment), "src/edge.ts");
    assert.equal(commentLine(comment), "42");
    assert.equal(commentEvidenceRef(comment), "https://example.test/pull/300#issuecomment-edge");
  });

  test("normalizes cached comment metadata aliases", () => {
    assert.equal(commentAuthorLogin({ authorLogin: "reviewer" }), "reviewer");
    assert.equal(commentAuthorLogin({ user: { node: { login: "node-reviewer" } } }), "node-reviewer");
    assert.equal(commentAuthorLogin({ author: { login: "author-reviewer" } }), "author-reviewer");
    assert.equal(commentAuthorLogin({}, "fallback-reviewer"), "fallback-reviewer");

    assert.equal(commentPath({ filePath: "src/file.ts" }), "src/file.ts");
    assert.equal(commentPath({ newPath: "src/new.ts", oldPath: "src/old.ts" }), "src/new.ts");
    assert.equal(commentPath({ path: "   ", old_path: "src/old.ts" }), "src/old.ts");

    assert.equal(commentLine({ line: 12 }), "12");
    assert.equal(commentLine({ line: " 13 " }), "13");
    assert.equal(commentLine({ line: 0, originalLine: "14" }), "14");
    assert.equal(commentLine({ line: -1, original_line: "not-a-line" }, "unknown"), "unknown");
  });

  test("normalizes cached comment evidence ref aliases", () => {
    assert.equal(
      commentEvidenceRef({
        evidence_ref: " comment:explicit ",
        html_url: "html:comment",
      }),
      "comment:explicit",
    );
    assert.equal(
      commentEvidenceRef({
        evidence_refs: [" ", "comment:plural", "comment:secondary"],
        url: "comment:url",
      }),
      "comment:plural",
    );
    assert.equal(commentEvidenceRef({ html_url: " html:comment " }), "html:comment");
    assert.equal(commentEvidenceRef({ html_url: "   ", htmlUrl: "html:camel" }), "html:camel");
    assert.equal(commentEvidenceRef({ web_url: "web:snake" }), "web:snake");
    assert.equal(commentEvidenceRef({ webUrl: "web:camel" }), "web:camel");
    assert.equal(commentEvidenceRef({ permalink: "comment:permalink" }), "comment:permalink");
    assert.equal(commentEvidenceRef({ uri: "comment:uri" }), "comment:uri");
    assert.equal(commentEvidenceRef({ url: "comment:url" }), "comment:url");
    assert.equal(commentEvidenceRef({ links: { html: { href: "comment:links-html" } } }), "comment:links-html");
    assert.equal(commentEvidenceRef({ _links: { web: "comment:links-web" } }), "comment:links-web");
    assert.equal(commentEvidenceRef({}, "comment:fallback"), "comment:fallback");
    assert.equal(commentEvidenceRef({}), null);
  });

  test("normalizes cached comment and source ref aliases before URL aliases", () => {
    assert.equal(
      commentEvidenceRef({
        commentRef: " comment:explicit ",
        sourceRef: "source:ignored",
        html_url: "html:ignored",
      }),
      "comment:explicit",
    );
    assert.equal(
      commentEvidenceRef({
        comment_refs: [" ", "comment:plural"],
        source_refs: ["source:plural"],
        url: "url:ignored",
      }),
      "comment:plural",
    );
    assert.equal(
      commentEvidenceRef({
        source_ref: " source:explicit ",
        html_url: "html:ignored",
      }),
      "source:explicit",
    );
  });
});
