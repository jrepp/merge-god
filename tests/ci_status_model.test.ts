import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeCiStatus,
  CI_STATUS_CHECK_SUMMARY_LIMIT,
  CI_STATUS_ROLLUP_REF,
  ciCheckEvidenceRefs,
  ciCheckName,
  ciCheckStatusLabel,
  ciFailedChecks,
  ciPendingChecks,
  ciStatusCheckSummary,
  ciStatusCountsSentence,
  ciStatusEvidenceDetails,
  ciStatusEvidenceStatus,
  ciStatusReviewGateExplanation,
  ciStatusReviewGateStatus,
  ciStatusState,
  ciUnknownChecks,
  enrichCiStatusWithStatusChecks,
  normalizeCiCheckDetailsUrl,
  normalizeCiStatusCounts,
} from "../ci_status_model";

describe("analyzeCiStatus", () => {
  test("exports the default CI check summary limit", () => {
    assert.equal(CI_STATUS_CHECK_SUMMARY_LIMIT, 8);
  });

  test("adds status-rollup evidence when check details are incomplete", () => {
    assert.deepEqual(
      ciCheckEvidenceRefs(
        [
          { details_url: " ci:api " },
          { detailsUrl: "ci:api" },
          { details_url: " " },
        ],
        2,
      ),
      ["ci:api", CI_STATUS_ROLLUP_REF],
    );
    assert.deepEqual(ciCheckEvidenceRefs([], 1), [CI_STATUS_ROLLUP_REF]);
    assert.deepEqual(ciCheckEvidenceRefs([], 0), []);
  });

  test("preserves failed, pending, skipped, unknown, and status-context details", () => {
    const status = analyzeCiStatus([
      {
        name: "unit tests",
        state: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/checks/unit",
      },
      {
        name: "integration",
        state: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/checks/integration",
      },
      {
        name: "deploy preview",
        state: "IN_PROGRESS",
        conclusion: null,
        detailsUrl: "https://example.test/checks/deploy",
      },
      {
        name: "static analysis",
        state: "QUEUED",
        conclusion: null,
        detailsUrl: "https://example.test/checks/static",
      },
      {
        name: "optional docs",
        state: "COMPLETED",
        conclusion: "NEUTRAL",
        detailsUrl: "https://example.test/checks/docs",
      },
      {
        name: "legacy success context",
        state: "SUCCESS",
        targetUrl: "https://example.test/status/success",
      },
      {
        name: "legacy failure context",
        state: "FAILURE",
        targetUrl: "https://example.test/status/failure",
      },
      {
        name: "legacy expected context",
        state: "EXPECTED",
        targetUrl: "https://example.test/status/expected",
      },
      {
        name: "manual approval",
        state: "ACTION_REQUIRED",
        targetUrl: "https://example.test/status/action-required",
      },
      {
        name: "cancelled e2e",
        state: "COMPLETED",
        conclusion: "CANCELLED",
        detailsUrl: "https://example.test/checks/cancelled",
      },
      {
        name: "stale required check",
        state: "COMPLETED",
        conclusion: "STALE",
        detailsUrl: "https://example.test/checks/stale",
      },
      {
        name: "manual check run",
        state: "COMPLETED",
        conclusion: "ACTION_REQUIRED",
        detailsUrl: "https://example.test/checks/action-required",
      },
    ]);

    assert.equal(status["total_checks"], 12);
    assert.equal(status["passed"], 2);
    assert.equal(status["failed"], 5);
    assert.equal(status["pending"], 4);
    assert.equal(status["skipped"], 1);
    assert.equal(status["unknown"], 0);
    assert.deepEqual(status["failed_checks"], [
      {
        name: "integration",
        conclusion: "FAILURE",
        details_url: "https://example.test/checks/integration",
      },
      {
        name: "legacy failure context",
        conclusion: "FAILURE",
        details_url: "https://example.test/status/failure",
      },
      {
        name: "cancelled e2e",
        conclusion: "CANCELLED",
        details_url: "https://example.test/checks/cancelled",
      },
      {
        name: "stale required check",
        conclusion: "STALE",
        details_url: "https://example.test/checks/stale",
      },
      {
        name: "manual check run",
        conclusion: "ACTION_REQUIRED",
        details_url: "https://example.test/checks/action-required",
      },
    ]);
    assert.deepEqual(status["pending_checks"], [
      {
        name: "deploy preview",
        status: "IN_PROGRESS",
        details_url: "https://example.test/checks/deploy",
      },
      {
        name: "static analysis",
        status: "QUEUED",
        details_url: "https://example.test/checks/static",
      },
      {
        name: "legacy expected context",
        status: "EXPECTED",
        details_url: "https://example.test/status/expected",
      },
      {
        name: "manual approval",
        status: "ACTION_REQUIRED",
        details_url: "https://example.test/status/action-required",
      },
    ]);
    assert.deepEqual(status["unknown_checks"], []);
  });

  test("returns an explicit empty summary when checks are absent", () => {
    assert.deepEqual(analyzeCiStatus(null), {
      total_checks: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      failed_checks: [],
      pending_checks: [],
      unknown_checks: [],
    });
  });

  test("trims malformed CI check names, states, conclusions, and URLs", () => {
    const status = analyzeCiStatus([
      {
        name: "   ",
        state: " completed ",
        conclusion: " failure ",
        detailsUrl: "  https://example.test/checks/failure  ",
      },
      {
        name: null,
        status: " in_progress ",
        targetUrl: "  ",
        url: " https://example.test/status/pending ",
      },
      {
        name: "mystery",
        state: " mystery ",
        conclusion: "   ",
        detailsUrl: "   ",
      },
    ]);

    assert.equal(status["failed"], 1);
    assert.equal(status["pending"], 1);
    assert.equal(status["unknown"], 1);
    assert.deepEqual(status["failed_checks"], [
      {
        name: "unknown",
        conclusion: "FAILURE",
        details_url: "https://example.test/checks/failure",
      },
    ]);
    assert.deepEqual(status["pending_checks"], [
      {
        name: "unknown",
        status: "IN_PROGRESS",
        details_url: "https://example.test/status/pending",
      },
    ]);
    assert.deepEqual(status["unknown_checks"], [
      {
        name: "mystery",
        state: "MYSTERY",
        status: "",
        conclusion: "",
        details_url: "",
      },
    ]);
  });

  test("does not let success signals hide contradictory failed or pending states", () => {
    const status = analyzeCiStatus([
      {
        name: "contradictory failure",
        state: "FAILURE",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/checks/contradictory-failure",
      },
      {
        name: "contradictory pending",
        state: "IN_PROGRESS",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/checks/contradictory-pending",
      },
      {
        name: "plain success",
        state: "SUCCESS",
      },
    ]);

    assert.equal(status["passed"], 1);
    assert.equal(status["failed"], 1);
    assert.equal(status["pending"], 1);
    assert.deepEqual(status["failed_checks"], [
      {
        name: "contradictory failure",
        conclusion: "FAILURE",
        details_url: "https://example.test/checks/contradictory-failure",
      },
    ]);
    assert.deepEqual(status["pending_checks"], [
      {
        name: "contradictory pending",
        status: "IN_PROGRESS",
        details_url: "https://example.test/checks/contradictory-pending",
      },
    ]);
  });

  test("normalizes cached counts using detail arrays as minimum evidence", () => {
    assert.deepEqual(
      normalizeCiStatusCounts({
        total_checks: 0,
        passed: 1,
        skipped: 1,
        failed: 0,
        pending: -1,
        unknown: 0,
        failed_checks: [{ name: "api" }],
        pending_checks: [{ name: "deploy" }],
        unknown_checks: [{ name: "coverage" }],
      }),
      {
        failed: 1,
        pending: 1,
        unknown: 1,
        passed: 1,
        skipped: 1,
        total: 5,
      },
    );
  });

  test("normalizes cached camelCase count and detail-array aliases", () => {
    const ciStatus = {
      totalChecks: 0,
      passed: 1,
      skipped: 1,
      failed: 0,
      pending: 0,
      unknown: 0,
      failedChecks: [{ name: "api" }],
      pendingChecks: [{ name: "deploy" }],
      unknownChecks: [{ name: "coverage" }],
    };

    assert.deepEqual(ciFailedChecks(ciStatus), [{ name: "api" }]);
    assert.deepEqual(ciPendingChecks(ciStatus), [{ name: "deploy" }]);
    assert.deepEqual(ciUnknownChecks(ciStatus), [{ name: "coverage" }]);
    assert.deepEqual(normalizeCiStatusCounts(ciStatus), {
      failed: 1,
      pending: 1,
      unknown: 1,
      passed: 1,
      skipped: 1,
      total: 5,
    });
  });

  test("normalizes cached edge-shaped CI detail collections", () => {
    const ciStatus = {
      totalChecks: 0,
      failedChecks: {
        edges: [
          {
            cursor: "failed-api",
            node: { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          },
          { node: {} },
        ],
      },
      pending_checks: {
        nodes: [
          { name: "deploy", status: "IN_PROGRESS", targetUrl: "ci:deploy" },
          null,
        ],
      },
      unknown_checks: [
        {
          __typename: "StatusContextEdge",
          cursor: "manual",
          node: { name: "manual", state: "WAITING", url: "ci:manual" },
        },
      ],
    };

    assert.deepEqual(ciFailedChecks(ciStatus), [
      { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
    ]);
    assert.deepEqual(ciPendingChecks(ciStatus), [
      { name: "deploy", status: "IN_PROGRESS", targetUrl: "ci:deploy" },
    ]);
    assert.deepEqual(ciUnknownChecks(ciStatus), [
      { name: "manual", state: "WAITING", url: "ci:manual" },
    ]);
    assert.deepEqual(normalizeCiStatusCounts(ciStatus), {
      failed: 1,
      pending: 1,
      unknown: 1,
      passed: 0,
      skipped: 0,
      total: 3,
    });
    assert.equal(
      ciStatusEvidenceDetails(normalizeCiStatusCounts(ciStatus), {
        failed: ciFailedChecks(ciStatus),
        pending: ciPendingChecks(ciStatus),
        unknown: ciUnknownChecks(ciStatus),
      }),
      "1 failed, 1 pending, 1 unknown, 0 passed, 0 skipped out of 3 check(s). " +
        "Failed: api (FAILURE, ci:api) " +
        "Pending: deploy (IN_PROGRESS, ci:deploy) " +
        "Unknown: manual (WAITING, ci:manual)",
    );
  });

  test("enriches nonzero cached CI summaries with raw rollup detail refs", () => {
    assert.deepEqual(
      enrichCiStatusWithStatusChecks(
        {
          total_checks: 4,
          failed: 2,
          pending: 1,
          unknown: 0,
          passed: 1,
          failedChecks: [{ name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" }],
        },
        [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "worker", conclusion: "FAILURE", detailsUrl: "ci:worker" },
          { name: "deploy", status: "IN_PROGRESS", detailsUrl: "ci:deploy" },
          { name: "lint", conclusion: "SUCCESS", detailsUrl: "ci:lint" },
        ],
      ),
      {
        total_checks: 4,
        failed: 2,
        pending: 1,
        unknown: 0,
        passed: 1,
        failed_checks: [
          { name: "api", conclusion: "FAILURE", detailsUrl: "ci:api" },
          { name: "worker", conclusion: "FAILURE", details_url: "ci:worker" },
        ],
        pending_checks: [
          { name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" },
        ],
        unknown_checks: [],
      },
    );
  });

  test("normalizes cached CI count aliases without detail arrays", () => {
    assert.deepEqual(
      normalizeCiStatusCounts({
        total_checks: 0,
        totalCount: 7,
        failed: 0,
        failedCount: 1,
        pending: 0,
        pending_count: 2,
        unknown: 0,
        unknownCount: 1,
        passed: 0,
        passed_count: 2,
        skipped: 0,
        skippedCount: 1,
      }),
      {
        failed: 1,
        pending: 2,
        unknown: 1,
        passed: 2,
        skipped: 1,
        total: 7,
      },
    );
  });

  test("projects normalized CI counts into shared domain states and statuses", () => {
    const failed = { failed: 1, pending: 9, unknown: 9, passed: 0, skipped: 0, total: 19 };
    const pending = { failed: 0, pending: 1, unknown: 9, passed: 0, skipped: 0, total: 10 };
    const unknown = { failed: 0, pending: 0, unknown: 1, passed: 0, skipped: 0, total: 1 };
    const passed = { failed: 0, pending: 0, unknown: 0, passed: 1, skipped: 1, total: 2 };
    const missing = { failed: 0, pending: 0, unknown: 0, passed: 0, skipped: 0, total: 0 };

    assert.equal(ciStatusState(failed), "failed");
    assert.equal(ciStatusState(pending), "pending");
    assert.equal(ciStatusState(unknown), "unknown");
    assert.equal(ciStatusState(passed), "passed");
    assert.equal(ciStatusState(missing), "missing");

    assert.equal(ciStatusReviewGateStatus(failed), "fail");
    assert.equal(ciStatusReviewGateStatus(pending), "pending");
    assert.equal(ciStatusReviewGateStatus(unknown), "unknown");
    assert.equal(ciStatusReviewGateStatus(passed), "pass");
    assert.equal(ciStatusReviewGateStatus(missing), "unknown");

    assert.equal(ciStatusEvidenceStatus(failed), "blocked");
    assert.equal(ciStatusEvidenceStatus(pending), "pending");
    assert.equal(ciStatusEvidenceStatus(unknown), "unknown");
    assert.equal(ciStatusEvidenceStatus(passed), "pass");
    assert.equal(ciStatusEvidenceStatus(missing), "unknown");
  });

  test("formats shared CI count summaries for gates and evidence comments", () => {
    const counts = { failed: 1, pending: 2, unknown: 3, passed: 4, skipped: 5, total: 15 };

    assert.equal(
      ciStatusCountsSentence(counts),
      "1 failed, 2 pending, 3 unknown, 4 passed out of 15 check(s).",
    );
    assert.equal(
      ciStatusCountsSentence(counts, { includeSkipped: true }),
      "1 failed, 2 pending, 3 unknown, 4 passed, 5 skipped out of 15 check(s).",
    );
    assert.equal(
      ciStatusReviewGateExplanation(counts),
      "1 failed, 2 pending, 3 unknown, 4 passed out of 15 check(s).",
    );
    assert.equal(
      ciStatusReviewGateExplanation({ failed: 0, pending: 0, unknown: 0, passed: 0, skipped: 0, total: 0 }),
      "No CI status checks were reported.",
    );
  });

  test("formats CI evidence details with check names, statuses, detail URLs, and caps", () => {
    const counts = {
      failed: 2,
      pending: 1,
      unknown: 1,
      passed: 3,
      skipped: 1,
      total: 8,
    };

    assert.equal(
      ciStatusEvidenceDetails(counts, {
        failed: [
          { name: "api", conclusion: "FAILURE", detailsUrl: " ci:api " },
          { name: "   ", conclusion: "ERROR", details_url: " " },
        ],
        pending: [
          { name: null, status: "IN_PROGRESS", targetUrl: "ci:deploy" },
        ],
        unknown: [
          { name: "manual", state: "WAITING", url: "ci:manual" },
        ],
      }),
      "2 failed, 1 pending, 1 unknown, 3 passed, 1 skipped out of 8 check(s). " +
        "Failed: api (FAILURE, ci:api); unknown (ERROR) " +
        "Pending: unknown (IN_PROGRESS, ci:deploy) " +
        "Unknown: manual (WAITING, ci:manual)",
    );

    assert.equal(
      ciStatusCheckSummary(Array.from({ length: 10 }, (_, index) => ({
        name: `check-${index + 1}`,
      })), 3),
      "check-1; check-2; check-3; 7 more",
    );
    assert.equal(
      ciStatusCheckSummary(Array.from({ length: CI_STATUS_CHECK_SUMMARY_LIMIT + 1 }, (_, index) => ({
        name: `default-check-${index + 1}`,
      }))),
      "default-check-1; default-check-2; default-check-3; default-check-4; default-check-5; " +
        "default-check-6; default-check-7; default-check-8; 1 more",
    );
  });

  test("normalizes CI check display labels", () => {
    assert.equal(ciCheckName({ name: " api " }), "api");
    assert.equal(ciCheckName({ name: "   " }), "unknown");
    assert.equal(ciCheckName({ node: { name: "edge api" } }), "edge api");
    assert.equal(ciCheckStatusLabel({ conclusion: " FAILURE ", status: "ignored" }), "FAILURE");
    assert.equal(ciCheckStatusLabel({ status: " IN_PROGRESS " }), "IN_PROGRESS");
    assert.equal(ciCheckStatusLabel({ state: " WAITING " }), "WAITING");
    assert.equal(ciCheckStatusLabel({ node: { status: "QUEUED" } }), "QUEUED");
    assert.equal(ciCheckStatusLabel({}, "unknown"), "unknown");
  });

  test("normalizes CI check detail URL aliases", () => {
    assert.equal(
      normalizeCiCheckDetailsUrl({
        details_url: "  https://example.test/normalized  ",
        detailsUrl: "https://example.test/camel",
      }),
      "https://example.test/normalized",
    );
    assert.equal(
      normalizeCiCheckDetailsUrl({
        target_url: "  ",
        targetUrl: " https://example.test/target ",
      }),
      "https://example.test/target",
    );
    assert.equal(
      normalizeCiCheckDetailsUrl({
        html_url: " https://example.test/html ",
        url: "https://example.test/url",
      }),
      "https://example.test/html",
    );
  });

  test("analyzes direct edge-shaped status rollup records", () => {
    assert.deepEqual(
      analyzeCiStatus([
        {
          __typename: "CheckRunEdge",
          cursor: "failed-api",
          node: {
            name: "api",
            state: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "ci:api",
          },
        },
        {
          __typename: "StatusContextEdge",
          cursor: "pending-deploy",
          node: {
            name: "deploy",
            status: "IN_PROGRESS",
            targetUrl: "ci:deploy",
          },
        },
      ]),
      {
        total_checks: 2,
        passed: 0,
        failed: 1,
        pending: 1,
        skipped: 0,
        unknown: 0,
        failed_checks: [
          { name: "api", conclusion: "FAILURE", details_url: "ci:api" },
        ],
        pending_checks: [
          { name: "deploy", status: "IN_PROGRESS", details_url: "ci:deploy" },
        ],
        unknown_checks: [],
      },
    );
  });
});
