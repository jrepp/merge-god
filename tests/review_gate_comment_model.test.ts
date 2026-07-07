import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  findOwnedReviewGateCacheCommentId,
  isReviewGateCacheComment,
  planReviewGateCommentCommand,
  reviewGateCommentAuthorLogin,
  reviewGateCommentId,
} from "../review_gate_comment_model";
import { REVIEW_GATE_CACHE_MARKER } from "../review_gate_cache";

describe("review gate comment model", () => {
  test("normalizes cache comment ids and author login aliases", () => {
    assert.equal(reviewGateCommentId({ id: 42 }), 42);
    assert.equal(reviewGateCommentId({ databaseId: "43" }), 43);
    assert.equal(reviewGateCommentId({ comment_id: " 44 " }), 44);
    assert.equal(reviewGateCommentId({ id: 0, database_id: -1, commentId: "not-a-number" }), null);

    assert.equal(reviewGateCommentAuthorLogin({ user: { login: "merge-god[bot]" } }), "merge-god[bot]");
    assert.equal(reviewGateCommentAuthorLogin({ authorLogin: "agent-metro" }), "agent-metro");
    assert.equal(reviewGateCommentAuthorLogin({ actor: { username: "queue-bot" } }), "queue-bot");
  });

  test("detects marker and legacy heading cache comments across record shapes", () => {
    assert.equal(isReviewGateCacheComment({ body: `${REVIEW_GATE_CACHE_MARKER}\ncache` }), true);
    assert.equal(isReviewGateCacheComment({ bodyText: "### merge-god review gate status\ncache" }), true);
    assert.equal(
      isReviewGateCacheComment({
        cursor: "comment-edge",
        node: { content: `${REVIEW_GATE_CACHE_MARKER}\nedge cache` },
      }),
      true,
    );
    assert.equal(isReviewGateCacheComment({ body: "ordinary review discussion" }), false);
  });

  test("selects the first owned cache comment with a usable id", () => {
    const comments = [
      { id: 11, body: `${REVIEW_GATE_CACHE_MARKER}\nwrong bot`, user: { login: "other-bot" } },
      { id: "not-usable", body: `${REVIEW_GATE_CACHE_MARKER}\nmissing id`, user: { login: "merge-god[bot]" } },
      { databaseId: "12", bodyText: "## merge-god review gate status\nlegacy", authorLogin: "merge-god[bot]" },
      { id: 13, body: `${REVIEW_GATE_CACHE_MARKER}\nsecond owned`, user: { login: "merge-god[bot]" } },
    ];

    assert.equal(findOwnedReviewGateCacheCommentId(comments, "merge-god[bot]"), 12);
  });

  test("falls back to any cache comment when current owner is unknown", () => {
    assert.equal(
      findOwnedReviewGateCacheCommentId([
        { id: 31, body: `${REVIEW_GATE_CACHE_MARKER}\nfirst cache`, user: { login: "old-bot" } },
        { id: 32, body: `${REVIEW_GATE_CACHE_MARKER}\nsecond cache`, user: { login: "merge-god[bot]" } },
      ]),
      31,
    );
  });

  test("builds create and edit gh api command plans", () => {
    assert.deepEqual(planReviewGateCommentCommand(203, "cache body", null), {
      mode: "create",
      existing_comment_id: null,
      args: ["gh", "api", "repos/{owner}/{repo}/issues/203/comments", "-f", "body=cache body"],
    });

    assert.deepEqual(planReviewGateCommentCommand(203, "updated body", 901), {
      mode: "edit",
      existing_comment_id: 901,
      args: [
        "gh",
        "api",
        "-X",
        "PATCH",
        "repos/{owner}/{repo}/issues/comments/901",
        "-f",
        "body=updated body",
      ],
    });
  });
});
