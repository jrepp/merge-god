import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  prDetailsAdditions,
  prDetailsAuthorLogin,
  prDetailsBody,
  prDetailsChangedFiles,
  prDetailsCommitCount,
  prDetailsCreatedAt,
  prDetailsDeletions,
  prDetailsHeadBranch,
  prDetailsHeadSha,
  prDetailsCommits,
  prDetailsHasMetadata,
  prDetailsIsDraft,
  prDetailsLabels,
  prDetailsMergeable,
  prDetailsMergeStateStatus,
  prDetailsMergedAt,
  prDetailsNumber,
  prDetailsReviewDecision,
  prDetailsStateText,
  prDetailsTitle,
  prDetailsUpdatedAt,
  prDetailsUrl,
} from "../pr_details_access_model";

describe("PR details access model", () => {
  test("normalizes PR number aliases", () => {
    assert.equal(prDetailsNumber({ number: 203 }), 203);
    assert.equal(prDetailsNumber({ number: " 204 " }), 204);
    assert.equal(prDetailsNumber({ pr_number: "205" }), 205);
    assert.equal(prDetailsNumber({ pullNumber: "206" }), 206);
    assert.equal(prDetailsNumber({ mergeRequestNumber: "207" }), 207);
    assert.equal(prDetailsNumber({ iid: "208" }), 208);
    assert.equal(prDetailsNumber({ number: "0", prNumber: "209" }), 209);
    assert.equal(prDetailsNumber({ mrNumber: "210" }), 210);
    assert.equal(prDetailsNumber({ mr_iid: "211" }), 211);
    assert.equal(prDetailsNumber({ number: "20x" }), null);
  });

  test("normalizes PR title and body aliases", () => {
    assert.equal(prDetailsTitle({ title: "   ", name: "Batch queue" }), "Batch queue");
    assert.equal(prDetailsTitle({ subject: "Stack landing" }), "Stack landing");
    assert.equal(prDetailsTitle({}, "Unknown"), "Unknown");

    assert.equal(prDetailsBody({ body: "   ", description: "- #201 API" }), "- #201 API");
    assert.equal(prDetailsBody({ bodyText: "Queued body" }), "Queued body");
    assert.equal(prDetailsBody({}, "No description"), "No description");
  });

  test("falls back past unknown review-decision placeholders to decisive aliases", () => {
    assert.equal(
      prDetailsReviewDecision({
        reviewDecision: "UNKNOWN",
        review_decision: "changes requested",
      }),
      "changes requested",
    );
    assert.equal(
      prDetailsReviewDecision({
        reviewDecision: "STALE",
        review_decision: "review required",
      }),
      "review required",
    );
    assert.equal(
      prDetailsReviewDecision({
        reviewDecision: "APPROVED",
        review_decision: "changes requested",
      }),
      "APPROVED",
    );
    assert.equal(prDetailsReviewDecision({ reviewDecision: "UNKNOWN" }), "UNKNOWN");
  });

  test("normalizes PR statistic aliases", () => {
    assert.equal(prDetailsAdditions({ additions: 12 }), 12);
    assert.equal(prDetailsAdditions({ additions_count: "13" }), 13);
    assert.equal(prDetailsAdditions({ linesAdded: "14" }), 14);
    assert.equal(prDetailsAdditions({ additions: -1, addedLines: "15" }), 15);

    assert.equal(prDetailsDeletions({ deletions: 2 }), 2);
    assert.equal(prDetailsDeletions({ deletionsCount: "3" }), 3);
    assert.equal(prDetailsDeletions({ lines_deleted: "4" }), 4);
    assert.equal(prDetailsDeletions({ removedLines: "not-a-count" }), 0);

    assert.equal(prDetailsChangedFiles({ changedFiles: 5 }), 5);
    assert.equal(prDetailsChangedFiles({ changed_files: "6" }), 6);
    assert.equal(prDetailsChangedFiles({ filesChanged: "7" }), 7);
    assert.equal(prDetailsChangedFiles({ file_count: "8" }), 8);
  });

  test("normalizes PR detail commit collection aliases", () => {
    assert.deepEqual(
      prDetailsCommits({
        commits: [{ oid: "detail201", message: "Merge PR #201" }],
      }),
      [{ oid: "detail201", message: "Merge PR #201" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [null, {}],
        commitNodes: [{ oid: "detail202", message: "Merge PR #202" }],
      }),
      [{ oid: "detail202", message: "Merge PR #202" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [{ oid: "", sha: " ", message: " ", commit: { messageHeadline: "" } }],
        commitNodes: [{ oid: "detail202", message: "Merge PR #202" }],
      }),
      [{ oid: "detail202", message: "Merge PR #202" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [{ oid: "detail-authoritative" }],
        commitNodes: [{ oid: "detail202", message: "Merge PR #202" }],
      }),
      [{ oid: "detail-authoritative" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [{ conflictFiles: { nodes: [{ path: "packages/api/src/app.ts" }] } }],
        commitNodes: [{ oid: "detail202", message: "Merge PR #202" }],
      }),
      [{ conflictFiles: { nodes: [{ path: "packages/api/src/app.ts" }] } }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [{ conflictFiles: { nodes: [] }, commit: { conflictFiles: { edges: [] } } }],
        commitNodes: [{ commit: { conflictFiles: { edges: [{ node: { filename: "packages/ui/src/view.ts" } }] } } }],
      }),
      [{ commit: { conflictFiles: { edges: [{ node: { filename: "packages/ui/src/view.ts" } }] } } }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [
          { evidenceRefs: ["commit:canonical", "pr:#201"] },
          { commit: { source_ref: "commit:nested-source" } },
        ],
        commitNodes: [{ oid: "detail202", message: "Merge PR #202" }],
      }),
      [
        { evidenceRefs: ["commit:canonical", "pr:#201"] },
        { commit: { source_ref: "commit:nested-source" } },
      ],
    );
    assert.deepEqual(
      prDetailsCommits({
        commit_nodes: {
          edges: [
            { node: { oid: "detail203", message: "Merge PR #203" } },
            { node: null },
          ],
        },
      }),
      [{ oid: "detail203", message: "Merge PR #203" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commitNodes: [
          { __typename: "CommitEdge", cursor: "detail204", node: { oid: "detail204", message: "Merge PR #204" } },
          { cursor: "empty", node: {} },
        ],
      }),
      [{ oid: "detail204", message: "Merge PR #204" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commits: [null, {}],
        commitEdges: [
          { cursor: "detail205", node: { oid: "detail205", message: "Merge PR #205" } },
        ],
      }),
      [{ oid: "detail205", message: "Merge PR #205" }],
    );
    assert.deepEqual(
      prDetailsCommits({
        commit_edges: {
          edges: [
            { node: { oid: "detail206", message: "Merge PR #206" } },
          ],
        },
      }),
      [{ oid: "detail206", message: "Merge PR #206" }],
    );
    assert.equal(prDetailsCommitCount({ commits: { totalCount: 4 } }), 4);
    assert.equal(prDetailsCommitCount({ commits: { total_count: "5" } }), 5);
    assert.equal(prDetailsCommitCount({ commits: { count: "6" } }), 6);
    assert.equal(
      prDetailsCommitCount({
        commitNodes: [{ oid: "detail205" }, { oid: "detail206" }],
      }),
      2,
    );
  });

  test("normalizes PR state and timestamp aliases", () => {
    assert.equal(prDetailsStateText({ state: " open " }), "open");
    assert.equal(prDetailsStateText({ status: " merged " }), "merged");
    assert.equal(prDetailsStateText({ mergeState: "dirty" }), "dirty");
    assert.equal(prDetailsStateText({}, "unknown"), "unknown");

    assert.equal(prDetailsCreatedAt({ createdAt: "2026-07-01T10:00:00Z" }), "2026-07-01T10:00:00Z");
    assert.equal(prDetailsCreatedAt({ created_at: "2026-07-01T10:01:00Z" }), "2026-07-01T10:01:00Z");
    assert.equal(prDetailsUpdatedAt({ updatedAt: "2026-07-01T10:02:00Z" }), "2026-07-01T10:02:00Z");
    assert.equal(prDetailsUpdatedAt({ updatedDate: "2026-07-01T10:03:00Z" }), "2026-07-01T10:03:00Z");
    assert.equal(prDetailsMergedAt({ mergedAt: "2026-07-01T10:04:00Z" }), "2026-07-01T10:04:00Z");
    assert.equal(prDetailsMergedAt({ merged_at: "2026-07-01T10:05:00Z" }), "2026-07-01T10:05:00Z");
  });

  test("normalizes direct edge-shaped PR detail records", () => {
    const details = {
      __typename: "PullRequestEdge",
      cursor: "pr-209",
      node: {
        number: "209",
        title: "Merge queue PRs #201 and #202",
        bodyText: "- #201 API",
        baseRefName: "main",
        headRefName: "queue/landing",
        htmlUrl: "https://example.test/pull/209",
        additionsCount: "21",
        deletionsCount: "3",
        changed_files: "4",
        author: { cursor: "author", node: { login: "octocat" } },
        head: { cursor: "head", node: { oid: "abcdef123456" } },
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "DIRTY",
        state: "merged",
        mergedAt: "2026-07-01T12:00:00Z",
        createdAt: "2026-07-01T10:00:00Z",
        updatedAt: "2026-07-01T11:00:00Z",
        isDraft: "true",
        labels: { nodes: [{ name: "for-landing" }] },
        commits: {
          nodes: [{ oid: "detail209", message: "Merge pull request #201 from org/api" }],
        },
      },
    };

    assert.equal(prDetailsNumber(details), 209);
    assert.equal(prDetailsTitle(details), "Merge queue PRs #201 and #202");
    assert.equal(prDetailsBody(details), "- #201 API");
    assert.equal(prDetailsHeadBranch(details), "queue/landing");
    assert.equal(prDetailsUrl(details), "https://example.test/pull/209");
    assert.equal(prDetailsAdditions(details), 21);
    assert.equal(prDetailsDeletions(details), 3);
    assert.equal(prDetailsChangedFiles(details), 4);
    assert.equal(prDetailsAuthorLogin(details), "octocat");
    assert.equal(prDetailsHeadSha(details), "abcdef123456");
    assert.deepEqual(prDetailsLabels(details), ["for-landing"]);
    assert.deepEqual(prDetailsCommits(details), [{ oid: "detail209", message: "Merge pull request #201 from org/api" }]);
    assert.equal(prDetailsCommitCount(details), 1);
    assert.equal(prDetailsReviewDecision(details), "CHANGES_REQUESTED");
    assert.equal(prDetailsMergeStateStatus(details), "DIRTY");
    assert.equal(prDetailsStateText(details), "merged");
    assert.equal(prDetailsCreatedAt(details), "2026-07-01T10:00:00Z");
    assert.equal(prDetailsUpdatedAt(details), "2026-07-01T11:00:00Z");
    assert.equal(prDetailsMergedAt(details), "2026-07-01T12:00:00Z");
    assert.equal(prDetailsIsDraft(details), true);
    assert.equal(prDetailsHasMetadata(details), true);
    assert.equal(prDetailsHasMetadata({ node: {} }), false);
  });

  test("normalizes PR label aliases and collection shapes", () => {
    assert.deepEqual(
      prDetailsLabels({ labels: [" for-landing ", "blocked", "", "blocked"] }),
      ["for-landing", "blocked"],
    );
    assert.deepEqual(
      prDetailsLabels({
        labels: {
          nodes: [
            { name: "do-not-merge" },
            { label: "needs approval" },
            { title: "manual gate" },
          ],
        },
      }),
      ["do-not-merge", "needs approval", "manual gate"],
    );
    assert.deepEqual(
      prDetailsLabels({
        labelNames: [
          { node: { name: "blocked-by-dependency" } },
          { cursor: "empty", node: {} },
        ],
      }),
      ["blocked-by-dependency"],
    );
    assert.deepEqual(prDetailsLabels({ labels: { nodes: [] } }), []);
    assert.deepEqual(prDetailsLabels({ label_names: { edges: [] } }), []);
  });

  test("normalizes trajectory detail aliases", () => {
    assert.equal(prDetailsHeadBranch({ headRefName: "feature/live" }), "feature/live");
    assert.equal(prDetailsHeadBranch({ head_branch: "queue/replay" }), "queue/replay");
    assert.equal(prDetailsHeadBranch({}, "fallback/head"), "fallback/head");

    assert.equal(prDetailsUrl({ htmlUrl: "https://example.test/pull/201" }), "https://example.test/pull/201");
    assert.equal(prDetailsUrl({ web_url: "https://gitlab.test/merge_requests/201" }), "https://gitlab.test/merge_requests/201");
    assert.equal(prDetailsUrl({}, "https://fallback.test/pull/201"), "https://fallback.test/pull/201");

    assert.equal(prDetailsAuthorLogin({ authorLogin: "alice" }), "alice");
    assert.equal(prDetailsAuthorLogin({ author: { username: "octocat" } }), "octocat");
    assert.equal(prDetailsAuthorLogin({ user: { login: "hubot" } }), "hubot");
    assert.equal(prDetailsAuthorLogin({}, "unknown-user"), "unknown-user");

    assert.equal(prDetailsHeadSha({ currentSha: "sha-current" }), "sha-current");
    assert.equal(prDetailsHeadSha({ head_oid: "oid-head" }), "oid-head");
    assert.equal(prDetailsHeadSha({ head: { oid: "nested-head" } }), "nested-head");
    assert.equal(prDetailsHeadSha({ headCommit: { id: "commit-id" } }), "commit-id");
    assert.equal(prDetailsHeadSha({}, "fallback-sha"), "fallback-sha");
  });

  test("normalizes serialized draft booleans", () => {
    assert.equal(prDetailsIsDraft({ isDraft: "true" }), true);
    assert.equal(prDetailsIsDraft({ is_draft: " yes " }), true);
    assert.equal(prDetailsIsDraft({ draft: "draft" }), true);
    assert.equal(prDetailsIsDraft({ isDraft: "false", state: "draft" }), false);
    assert.equal(prDetailsIsDraft({ draft: "not-draft" }), false);
    assert.equal(prDetailsIsDraft({ state: "draft" }), true);
    assert.equal(prDetailsIsDraft({ isDraft: "surprise" }), false);
    assert.equal(prDetailsIsDraft({ isDraft: "surprise", is_draft: "true" }), true);
    assert.equal(prDetailsIsDraft({ isDraft: "false", is_draft: "true", state: "draft" }), false);
  });

  test("normalizes serialized mergeable booleans", () => {
    assert.equal(prDetailsMergeable({ mergeable: true }), true);
    assert.equal(prDetailsMergeable({ mergeable: "true" }), true);
    assert.equal(prDetailsMergeable({ isMergeable: "yes" }), true);
    assert.equal(prDetailsMergeable({ mergeable: false }), false);
    assert.equal(prDetailsMergeable({ mergeable: "false" }), false);
    assert.equal(prDetailsMergeable({ is_mergeable: "not-mergeable" }), false);
    assert.equal(prDetailsMergeable({ mergeable: "surprise" }), null);
    assert.equal(prDetailsMergeable({ mergeable: "surprise", is_mergeable: "unmergeable" }), false);
    assert.equal(prDetailsMergeable({ mergeable: "true", is_mergeable: "unmergeable" }), true);
  });
});
