import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_VALIDATION_SUMMARY_COMMAND_LIMIT,
  QUEUE_VALIDATION_SUMMARY_ROW_LIMIT,
  queueValidationEvidenceCountLabel,
  queueValidationEvidenceSummary,
} from "../queue_validation_summary_model";

describe("queue validation summary model", () => {
  test("exports the default row limit used by validation summaries", () => {
    assert.equal(QUEUE_VALIDATION_SUMMARY_ROW_LIMIT, 6);
    assert.equal(QUEUE_VALIDATION_SUMMARY_COMMAND_LIMIT, 96);
  });

  test("labels validation counts by active rows when stale evidence exists", () => {
    assert.equal(
      queueValidationEvidenceCountLabel([
        { command: "npm run test -- api", status: "failed", scope: "#201" },
        { command: "npm run lint -- api", status: "unknown", scope: "packages/api" },
        { command: "npm run test -- api", status: "passed", scope: "#201" },
        { command: "npm run lint -- api", status: "passed", scope: "packages/api" },
      ]),
      "2 active / 4 total",
    );
    assert.equal(
      queueValidationEvidenceCountLabel([
        { command: "npm run api", status: "passed", scope: "#201" },
        { command: "npm run ui", status: "failed", scope: "#202" },
      ]),
      "2",
    );
  });

  test("summarizes active validation before superseded stale evidence", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        { command: "npm run test -- api", status: "failed", scope: "#201" },
        { command: "npm run lint -- api", status: "unknown", scope: "packages/api" },
        { command: "npm run test -- api", status: "passed", scope: "#201" },
        { command: "npm run lint -- api", status: "passed", scope: "packages/api" },
      ]),
      "2 superseded; passed [#201]: npm run test -- api; passed [packages/api]: npm run lint -- api",
    );
  });

  test("abbreviates long commands per row before joining validation summaries", () => {
    const longCommand = `npm run test:unit-jsdom -- ${"packages/design-system/src/workflow/WorkflowExecutionView.test.tsx ".repeat(3)}`.trim();

    const summary = queueValidationEvidenceSummary([
      { command: "Full RC1 deterministic suite", status: "passed", scope: null },
      { command: longCommand, status: "passed", scope: null },
      { command: "npm run lint:strict", status: "passed", scope: null },
    ]);

    assert.match(summary, /^passed: Full RC1 deterministic suite; passed: npm run test:unit-jsdom -- packages\/design-system\/src\/workflow\/WorkflowExecutionView\.test\.tsx\.\.\.; passed: npm run lint:strict$/);
    assert.doesNotMatch(summary, /WorkflowExecutionView\.test\.tsx packages\/design-system/);
  });

  test("normalizes cached command, scope, and status aliases", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        { command: "scope: [#201](https://github.example.test/org/repo/pull/201) npm test", status: "ERROR", scope: "PR #001" },
        { command: "PR #202: [x] pnpm test --filter ui", status: "SUCCESS", scope: "#202" },
        { command: "Scope: queue-wide; Command: npm run inline-field; Result: action_required", status: "ACTION_REQUIRED", scope: "global" },
      ]),
      "failed [#1]: npm test; unknown: npm run inline-field; passed [#202]: pnpm test --filter ui",
    );
  });

  test("normalizes cached structured validation field aliases", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          cmd: "npm run alias-cmd",
          result: "failed",
          path: "packages/web",
        },
        {
          check: "pnpm test --filter api",
          conclusion: "success",
          pullRequest: "PR #004",
        },
        {
          validation: "npm run gitlab-mr",
          result: "failed",
          merge_request_iid: 206,
        },
        {
          test: "npm run pr-id",
          outcome: "success",
          pullRequestIid: "207",
        },
        {
          command: "npm run malformed-pr-alias",
          status: "failed",
          pullRequest: "not-a-number",
        },
      ]),
      "failed [packages/web]: npm run alias-cmd; failed [#206]: npm run gitlab-mr; failed: npm run malformed-pr-alias; passed [#4]: pnpm test --filter api; passed [#207]: npm run pr-id",
    );
  });

  test("normalizes cached pipe-separated field summary commands", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "Pull Request: #301 | Command: npm run pipe-field | Result: failed",
          status: "failed",
          scope: "#301",
        },
        {
          command: "| Command: npm run legacy-pipe | Result",
          status: "blocked",
          scope: "#302",
        },
        {
          command: "Scope: packages/api | Command: npm run lint | Result: failed",
          status: "failed",
          scope: "packages/api",
        },
      ]),
      "failed [#301]: npm run pipe-field; blocked [#302]: npm run legacy-pipe; failed [packages/api]: npm run lint",
    );
  });

  test("recovers cached field-summary status and scope when fields are missing", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "Pull Request: #301 | Command: npm run pipe-field | Result: blocked",
          status: "",
          scope: "",
        },
        {
          command: "Scope: packages/api; Command: npm run lint; Result: action_required",
          status: "surprise",
          scope: "",
        },
        {
          command: "npm run has-failed-word -- --grep failed",
          status: "",
          scope: "",
        },
      ]),
      "blocked [#301]: npm run pipe-field; unknown [packages/api]: npm run lint; unknown: npm run has-failed-word -- --grep failed",
    );
  });

  test("recovers cached descriptive-link status and scope when fields are missing", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "[API validation](https://github.example.test/org/repo/pull/226) npm run descriptive-link -> failed",
          status: "",
          scope: "",
        },
        {
          command: "scope: [Worker validation](https://api.github.example.test/repos/org/repo/pulls/227) npm run descriptive-scope => passed",
          status: "",
          scope: "",
        },
        {
          command: "npm run has-failed-word -- --grep failed",
          status: "",
          scope: "",
        },
      ]),
      "failed [#226]: npm run descriptive-link; unknown: npm run has-failed-word -- --grep failed; passed [#227]: npm run descriptive-scope",
    );
  });

  test("recovers mismatched cached descriptive-link rows as queue-wide evidence", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "[#230](https://github.example.test/org/repo/pull/231) npm run swapped -> failed",
          status: "",
          scope: "",
        },
        {
          command: "scope: [MR !232](https://gitlab.example.test/org/repo/-/merge_requests/233) npm run swapped-mr => blocked",
          status: "",
          scope: "",
        },
      ]),
      "failed: npm run swapped; blocked: npm run swapped-mr",
    );
  });

  test("recovers cached status-first descriptive-link rows when fields are missing", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "failed: [API validation](https://github.example.test/org/repo/pull/226) npm run status-link",
          status: "",
          scope: "",
        },
        {
          command: "passed - scope: [Worker validation](https://api.github.example.test/repos/org/repo/pulls/227) npm run status-scope",
          status: "",
          scope: "",
        },
        {
          command: "blocked: https://gitlab.example.test/org/repo/-/merge_requests/228 npm run status-mr",
          status: "",
          scope: "",
        },
        {
          command: "npm run has-failed-word -- --grep failed",
          status: "",
          scope: "",
        },
      ]),
      "failed [#226]: npm run status-link; blocked [#228]: npm run status-mr; unknown: npm run has-failed-word -- --grep failed; passed [#227]: npm run status-scope",
    );
  });

  test("recovers cached status-target rows when fields are missing", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "passed for PR #201: npm run cached-pr",
          status: "",
          scope: "",
        },
        {
          command: "failed for pull request #202 - pnpm test --filter cached-pull",
          status: "",
          scope: "",
        },
        {
          command: "blocked for MR !203: npm run cached-mr",
          status: "",
          scope: "",
        },
        {
          command: "failed for [API validation](https://github.example.test/org/repo/pull/204): npm run cached-markdown",
          status: "",
          scope: "",
        },
        {
          command: "failed for PR #205 and PR #206: npm run cached-shared",
          status: "",
          scope: "",
        },
        {
          command: "failed for packages/api: npm run cached-path",
          status: "",
          scope: "",
        },
        {
          command: "passed for queue: npm run cached-queue",
          status: "",
          scope: "",
        },
      ], 10),
      "failed [#202]: pnpm test --filter cached-pull; blocked [#203]: npm run cached-mr; failed [#204]: npm run cached-markdown; failed: npm run cached-shared; failed [packages/api]: npm run cached-path; passed [#201]: npm run cached-pr; passed: npm run cached-queue",
    );
  });

  test("recovers cached target-status rows when fields are missing", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        {
          command: "PR #217 passed: npm run cached-target-pr",
          status: "",
          scope: "",
        },
        {
          command: "pull request #218 failed - pnpm test --filter cached-target-pull",
          status: "",
          scope: "",
        },
        {
          command: "MR !219 blocked: npm run cached-target-mr",
          status: "",
          scope: "",
        },
        {
          command: "[API validation](https://github.example.test/org/repo/pull/220) failed: npm run cached-target-markdown",
          status: "",
          scope: "",
        },
        {
          command: "PR #221 and PR #222 failed: npm run cached-target-shared",
          status: "",
          scope: "",
        },
        {
          command: "packages/api failed: npm run cached-target-path",
          status: "",
          scope: "",
        },
        {
          command: "queue passed: npm run cached-target-queue",
          status: "",
          scope: "",
        },
      ], 10),
      "failed [#218]: pnpm test --filter cached-target-pull; blocked [#219]: npm run cached-target-mr; failed [#220]: npm run cached-target-markdown; failed: npm run cached-target-shared; failed [packages/api]: npm run cached-target-path; passed [#217]: npm run cached-target-pr; passed: npm run cached-target-queue",
    );
  });

  test("prioritizes non-passing active evidence when capped", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        { command: "npm run pass-1", status: "passed", scope: "packages/pass-1" },
        { command: "npm run test -- ui", status: "failed", scope: "#202" },
        { command: "npm run lint -- api", status: "blocked", scope: "packages/api" },
        { command: "npm run smoke -- web", status: "unknown", scope: "apps/web" },
        { command: "npm run pass-2", status: "passed", scope: "packages/pass-2" },
        { command: "npm run pass-3", status: "passed", scope: "packages/pass-3" },
        { command: "npm run pass-4", status: "passed", scope: "packages/pass-4" },
      ]),
      "failed [#202]: npm run test -- ui; blocked [packages/api]: npm run lint -- api; unknown [apps/web]: npm run smoke -- web; passed [packages/pass-1]: npm run pass-1; 1 more active; passed [packages/pass-2]: npm run pass-2; passed [packages/pass-3]: npm run pass-3",
    );
  });

  test("surfaces comprehensive queue-wide passes before stale ordinary passing evidence", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        { command: "npm ci", status: "passed", scope: null },
        { command: "npm run lint", status: "passed", scope: null },
        { command: "npm run build", status: "passed", scope: null },
        { command: "npm run docs", status: "passed", scope: null },
        { command: "npm run smoke", status: "passed", scope: null },
        { command: "Full RC1 deterministic suite", status: "passed", scope: null },
        { command: "npm run post-check", status: "passed", scope: null },
      ]),
      "5 superseded; passed: Full RC1 deterministic suite; passed: npm run post-check",
    );
  });

  test("places omitted active marker after the first passing row when stale evidence exists", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        { command: "npm run pass-1", status: "failed", scope: "#201" },
        { command: "npm run fail", status: "failed", scope: "#202" },
        { command: "npm run pass-1", status: "passed", scope: "#201" },
        { command: "npm run pass-2", status: "passed", scope: "#203" },
        { command: "npm run pass-3", status: "passed", scope: "#204" },
      ], 3),
      "1 superseded; failed [#202]: npm run fail; passed [#201]: npm run pass-1; 1 more active; passed [#203]: npm run pass-2",
    );
  });

  test("uses explicit fallbacks for malformed cached rows", () => {
    assert.equal(
      queueValidationEvidenceSummary([
        { command: "", status: "failed", scope: "#201" },
        { command: 123, status: "blocked", scope: "#201" },
        { command: "   ", status: "passed", scope: "#202" },
      ]),
      "1 superseded; blocked [#201]: unknown; passed [#202]: unknown",
    );
    assert.equal(queueValidationEvidenceSummary([]), "none");
  });
});
