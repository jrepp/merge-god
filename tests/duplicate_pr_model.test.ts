import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  planDuplicateResolutions,
  renderDuplicateCloseComment,
  type DuplicatePrEvidence,
} from "../duplicate_pr_model";

function evidence(
  number: number,
  overrides: Partial<DuplicatePrEvidence> = {},
): DuplicatePrEvidence {
  return {
    number,
    title: `PR ${number}`,
    url: `https://example.test/pull/${number}`,
    created_at: `2026-07-${String(number).padStart(2, "0")}T00:00:00Z`,
    labels: ["duplicate"],
    is_draft: false,
    head_oid: `head-${number}`,
    base_ref: "main",
    patch_id: `patch-${number}`,
    changed_files: [`src/pr-${number}.ts`],
    base_matches: [],
    error: null,
    ...overrides,
  };
}

describe("duplicate PR planning", () => {
  test("only marks base-contained exact patches safe to close", () => {
    const [resolution] = planDuplicateResolutions([
      evidence(38, {
        patch_id: "213513d4",
        base_matches: [{
          commit: "fd79a475",
          pr_number: 47,
          pr_url: "https://example.test/pull/47",
        }],
      }),
    ]);

    assert.deepEqual(resolution, {
      pr_number: 38,
      disposition: "already_landed",
      canonical_pr_number: 47,
      canonical_pr_url: "https://example.test/pull/47",
      equivalent_open_pr_numbers: [38],
      embark_pr_numbers: [],
      patch_id: "213513d4",
      safe_to_close: true,
      reason: "Every retained patch is already present on main via PR #47.",
    });
    assert.match(renderDuplicateCloseComment(resolution!), /stable patch ID `213513d4`/);
  });

  test("prefers a non-duplicate processable PR as the open canonical", () => {
    const resolutions = planDuplicateResolutions([
      evidence(10, { patch_id: "same", labels: ["duplicate"] }),
      evidence(11, { patch_id: "same", labels: ["for-landing"] }),
    ]);

    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0]!.disposition, "exact_open_duplicate");
    assert.equal(resolutions[0]!.canonical_pr_number, 11);
    assert.equal(resolutions[0]!.safe_to_close, false);
  });

  test("does not claim one canonical PR when base containment came from several PRs", () => {
    const [resolution] = planDuplicateResolutions([
      evidence(12, {
        base_matches: [
          { commit: "base-a", pr_number: 40, pr_url: "https://example.test/pull/40" },
          { commit: "base-b", pr_number: 41, pr_url: "https://example.test/pull/41" },
        ],
      }),
    ]);

    assert.equal(resolution!.disposition, "already_landed");
    assert.equal(resolution!.canonical_pr_number, null);
    assert.match(resolution!.reason, /already present on main at base-a/);
  });

  test("chooses the oldest duplicate as an open cluster representative", () => {
    const resolutions = planDuplicateResolutions([
      evidence(20, { patch_id: "same", created_at: "2026-07-02T00:00:00Z" }),
      evidence(21, { patch_id: "same", created_at: "2026-07-01T00:00:00Z" }),
    ]);

    assert.deepEqual(resolutions.map((item) => [item.pr_number, item.disposition, item.canonical_pr_number]), [
      [20, "exact_open_duplicate", 21],
      [21, "canonical_open", 21],
    ]);
    assert.ok(resolutions.every((item) => !item.safe_to_close));
  });

  test("does not trust a duplicate label without equivalence evidence", () => {
    const [resolution] = planDuplicateResolutions([evidence(30)]);
    assert.equal(resolution!.disposition, "unverified_duplicate");
    assert.equal(resolution!.safe_to_close, false);
  });

  test("routes overlapping different patches to an embark comparison", () => {
    const resolutions = planDuplicateResolutions([
      evidence(32, { patch_id: "patch-a", changed_files: ["src/shared.ts", "src/a.ts"] }),
      evidence(33, {
        patch_id: "patch-b",
        changed_files: ["src/shared.ts", "src/b.ts"],
        labels: ["for-landing"],
      }),
    ]);

    assert.equal(resolutions[0]!.disposition, "embark_candidate");
    assert.deepEqual(resolutions[0]!.embark_pr_numbers, [32, 33]);
    assert.match(resolutions[0]!.reason, /merge-commit cohort in both orders/);
    assert.equal(resolutions[0]!.safe_to_close, false);
  });

  test("surfaces collection failures without recommending mutation", () => {
    const [resolution] = planDuplicateResolutions([
      evidence(31, { patch_id: null, error: "head ref unavailable" }),
    ]);
    assert.equal(resolution!.disposition, "analysis_failed");
    assert.equal(resolution!.reason, "head ref unavailable");
    assert.throws(() => renderDuplicateCloseComment(resolution!), /not proven safe/);
  });
});
