import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { type CategorizedPRs, planStackedPrMergeOrder } from "../pr-loop";

function pr(number: number, headRefName: string, baseRefName = "main", title = `PR ${number}`): Record<string, unknown> {
  return {
    number,
    title,
    headRefName,
    baseRefName,
    url: `https://example.test/pull/${number}`,
  };
}

function emptyCategorized(): CategorizedPRs {
  return { "for-review": [], "for-landing": [], "untagged": [] };
}

describe("planStackedPrMergeOrder", () => {
  test("orders parent PR before stacked child across processing modes", () => {
    const categorized = emptyCategorized();
    categorized["for-review"].push(pr(2, "feature/child", "feature/base"));
    categorized["for-landing"].push(pr(1, "feature/base"));

    const plan = planStackedPrMergeOrder(categorized);

    assert.deepEqual(
      plan.ordered.map((item) => [item.pr["number"], item.mode, item.stack_dependency_numbers]),
      [
        [1, "for-landing", []],
        [2, "for-review", [1]],
      ],
    );
    assert.deepEqual(plan.stacks.map((item) => item["pr_number"]), [1, 2]);
    assert.deepEqual(plan.blocked, []);
  });

  test("reports processable PRs whose stack parent is untagged", () => {
    const categorized = emptyCategorized();
    categorized["for-landing"].push(pr(3, "feature/child", "feature/base"));
    categorized["untagged"].push(pr(2, "feature/base"));

    const plan = planStackedPrMergeOrder(categorized);

    assert.deepEqual(plan.ordered.map((item) => item.pr["number"]), [3]);
    assert.deepEqual(plan.blocked, [
      {
        pr_number: 3,
        depends_on_pr_number: 2,
        depends_on_head_ref: "feature/base",
        reason: "stack_parent_without_processing_label",
      },
    ]);
  });

  test("uses stable mode order when no branch-ref dependencies exist", () => {
    const categorized = emptyCategorized();
    categorized["for-review"].push(pr(5, "feature/review"));
    categorized["for-landing"].push(pr(4, "feature/landing"));

    const plan = planStackedPrMergeOrder(categorized);

    assert.deepEqual(
      plan.ordered.map((item) => [item.pr["number"], item.mode]),
      [
        [5, "for-review"],
        [4, "for-landing"],
      ],
    );
  });

  test("reports branch-ref dependency cycles without dropping PRs", () => {
    const categorized = emptyCategorized();
    categorized["for-landing"].push(pr(7, "feature/a", "feature/b"));
    categorized["for-landing"].push(pr(8, "feature/b", "feature/a"));

    const plan = planStackedPrMergeOrder(categorized);

    assert.deepEqual(plan.ordered.map((item) => item.pr["number"]), [7, 8]);
    assert.deepEqual(plan.blocked, [
      {
        pr_number: 7,
        reason: "stack_dependency_cycle",
        cycle_pr_numbers: [7, 8],
      },
    ]);
  });
});
