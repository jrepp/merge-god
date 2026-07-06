import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { categorizeOpenPrs, categorizedPrNumbers } from "../pr_loop_model";

describe("PR loop model", () => {
  test("categorizes processable PRs by labels", () => {
    const result = categorizeOpenPrs([
      {
        number: 183,
        title: "Review queue",
        headRefName: "queue/review",
        url: "https://example.test/pr/183",
        labels: [{ name: "for-review" }],
      },
      {
        number: 184,
        title: "Landing queue",
        headRefName: "queue/landing",
        url: "https://example.test/pr/184",
        labels: [{ name: "FOR-LANDING" }],
      },
      {
        number: 185,
        title: "Unlabeled",
        headRefName: "feature/unlabeled",
        url: "https://example.test/pr/185",
        labels: [],
      },
    ]);

    assert.deepEqual(result.categorized["for-review"].map((pr) => pr["number"]), [183]);
    assert.deepEqual(result.categorized["for-landing"].map((pr) => pr["number"]), [184]);
    assert.deepEqual(result.categorized.untagged.map((pr) => pr["number"]), [185]);
    assert.deepEqual(result.summary, {
      action: "complete",
      total: 3,
      for_review: 1,
      for_landing: 1,
      untagged: 1,
      filtered_draft: 0,
      filtered_wip: 0,
      filtered_invalid: 0,
      filtered_state: 0,
      filtered_prs: {
        draft: [],
        wip: [],
        invalid: [],
        state: [],
      },
    });
  });

  test("categorizes PRs with cached detail aliases and label connections", () => {
    const result = categorizeOpenPrs([
      {
        prNumber: "190",
        name: "Cached review",
        sourceBranch: "queue/cached-review",
        htmlUrl: "https://example.test/pr/190",
        labels: { nodes: [{ name: "for-review" }] },
      },
      {
        pullNumber: "191",
        subject: "Cached landing",
        head_branch: "queue/cached-landing",
        webUrl: "https://example.test/pr/191",
        labelNames: [{ node: { name: "FOR-LANDING" } }],
      },
    ]);

    assert.deepEqual(result.categorized["for-review"].map((pr) => pr["prNumber"]), ["190"]);
    assert.deepEqual(result.categorized["for-landing"].map((pr) => pr["pullNumber"]), ["191"]);
    assert.equal(result.summary["for_review"], 1);
    assert.equal(result.summary["for_landing"], 1);
  });

  test("extracts sorted unique PR numbers from categorized alias records", () => {
    assert.deepEqual(
      categorizedPrNumbers({
        "for-review": [
          { prNumber: "190", title: "Review" },
          { pullNumber: "191", title: "Also review" },
        ],
        "for-landing": [
          { number: 191, title: "Duplicate landing" },
          { iid: "192", title: "GitLab landing" },
          { prNumber: "not-a-number", title: "Malformed" },
        ],
        untagged: [{ number: 999, title: "Skipped" }],
      }),
      [190, 191, 192],
    );
  });

  test("filters draft aliases before categorization", () => {
    const result = categorizeOpenPrs([
      {
        number: 192,
        title: "Serialized draft",
        headRefName: "feature/draft",
        url: "https://example.test/pr/192",
        draft: "true",
        labels: [{ name: "for-landing" }],
      },
    ]);

    assert.deepEqual(result.categorized["for-landing"], []);
    assert.deepEqual(result.filtered_prs.draft, [
      { number: 192, title: "Serialized draft" },
    ]);
  });

  test("filters invalid, draft, WIP, and already active state PRs", () => {
    const result = categorizeOpenPrs([
      null,
      {
        number: 186,
        title: "Missing URL",
        headRefName: "feature/missing-url",
        labels: [{ name: "for-landing" }],
      },
      {
        number: 187,
        title: "Draft PR",
        headRefName: "feature/draft",
        url: "https://example.test/pr/187",
        isDraft: true,
        labels: [{ name: "for-landing" }],
      },
      {
        number: 188,
        title: "WIP PR",
        headRefName: "feature/wip",
        url: "https://example.test/pr/188",
        labels: [{ name: "work-in-process" }, { name: "for-review" }],
      },
      {
        number: 189,
        title: "Already blocked",
        headRefName: "feature/blocked",
        url: "https://example.test/pr/189",
        labels: [{ name: "merge:blocked" }, { name: "for-landing" }],
      },
    ]);

    assert.deepEqual(result.categorized, {
      "for-review": [],
      "for-landing": [],
      untagged: [],
    });
    assert.deepEqual(result.filtered_prs.invalid, [
      { number: 186, title: "Missing URL", reason: "missing_fields" },
    ]);
    assert.deepEqual(result.filtered_prs.draft, [
      { number: 187, title: "Draft PR" },
    ]);
    assert.deepEqual(result.filtered_prs.wip, [
      { number: 188, title: "WIP PR", label: "work-in-process" },
    ]);
    assert.deepEqual(result.filtered_prs.state, [
      { number: 189, title: "Already blocked", label: "merge:blocked" },
    ]);
    assert.deepEqual(result.events.map((event) => event["action"]), [
      "invalid_pr",
      "skip_draft",
      "skip_wip",
      "skip_state",
    ]);
    assert.equal(result.summary["total"], 5);
    assert.equal(result.summary["filtered_invalid"], 1);
  });
});
