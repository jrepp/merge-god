import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildOperationsProfile } from "../operations_profile_model";

function makePr(number: number, options: {
  label?: string;
  updatedAt?: string;
  draft?: boolean;
} = {}): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    headRefName: `branch-${number}`,
    baseRefName: "main",
    isDraft: options.draft ?? false,
    labels: options.label ? [{ name: options.label }] : [],
    url: `https://example.test/pull/${number}`,
    updatedAt: options.updatedAt,
  };
}

describe("operations profile model", () => {
  test("builds deterministic age, selection, and acceleration layers", () => {
    const profile = buildOperationsProfile([
      makePr(1, { label: "for-landing", updatedAt: "2026-07-09T00:00:00Z" }),
      makePr(2, { label: "for-review", updatedAt: "2026-05-01T00:00:00Z" }),
      makePr(3, { updatedAt: "2025-01-01T00:00:00Z" }),
      makePr(4, { label: "for-landing", updatedAt: "2026-01-01T00:00:00Z", draft: true }),
      { title: "invalid" },
    ], {
      now: new Date("2026-07-10T00:00:00Z"),
      deepening_limit: 1,
      sample_limit: 10,
    });

    assert.deepEqual(profile.inventory.age_buckets, {
      active_0_30_days: 1,
      cooling_31_90_days: 1,
      stale_91_365_days: 1,
      archival_over_365_days: 1,
    });
    assert.equal(profile.inventory.total, 5);
    assert.equal(profile.inventory.valid, 4);
    assert.equal(profile.selection.processable, 2);
    assert.equal(profile.selection.untagged, 1);
    assert.equal(profile.selection.filtered_draft, 1);
    assert.equal(profile.selection.selected_for_deepening, 1);
    assert.equal(profile.acceleration.current_eager_full_context_calls, 14);
    assert.equal(profile.acceleration.layered_full_context_calls, 7);
    assert.equal(profile.acceleration.avoided_full_context_percent, 50);
    assert.equal(profile.candidates[0]!.pr_number, 2);
  });

  test("profiles thousands of stale PRs without deepening the whole inventory", () => {
    const prs = Array.from({ length: 5_000 }, (_, index) => makePr(index + 1, {
      label: index % 10 === 0 ? "for-review" : undefined,
      updatedAt: "2020-01-01T00:00:00Z",
    }));
    const profile = buildOperationsProfile(prs, {
      now: new Date("2026-07-10T00:00:00Z"),
      deepening_limit: 25,
      sample_limit: 5,
    });

    assert.equal(profile.inventory.total, 5_000);
    assert.equal(profile.inventory.age_buckets.archival_over_365_days, 5_000);
    assert.equal(profile.selection.processable, 500);
    assert.equal(profile.selection.selected_for_deepening, 25);
    assert.equal(profile.selection.deferred_processable, 475);
    assert.equal(profile.acceleration.discovery_pages, 50);
    assert.equal(profile.acceleration.current_eager_full_context_calls, 3_500);
    assert.equal(profile.acceleration.layered_full_context_calls, 175);
    assert.equal(profile.acceleration.avoided_full_context_percent, 95);
    assert.equal(profile.candidates.length, 5);
  });

  test("rejects an invalid profiling clock", () => {
    assert.throws(
      () => buildOperationsProfile([], { now: new Date("invalid") }),
      /now must be a valid date/,
    );
  });
});
