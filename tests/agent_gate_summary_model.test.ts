import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { agentGateSummarySection } from "../agent_gate_summary_model";

describe("agent gate summary model", () => {
  test("omits empty gate context", () => {
    assert.equal(agentGateSummarySection({ merge_blockers: [], queue_context: null }), "");
  });

  test("renders merge blockers and deduped queue blockers for agent prompts", () => {
    const repeatedBlocker = {
      kind: "external_gate",
      status: "blocked",
      summary: "Release approval is required.",
    };
    const summary = agentGateSummarySection({
      merge_blockers: [repeatedBlocker],
      queue_context: {
        isQueue: true,
        strategy: "manual",
        constituentPrs: [{ prNumber: 301 }],
        mergeCommits: [{ sha: "abc123", subject: "Merge PR #301" }],
        validationEvidence: [{ command: "npm run ci", status: "failed" }],
        unresolvedBlockers: [
          repeatedBlocker,
          {
            type: "ci_failed",
            outcome: "failed",
            description: "Queue validation failed.",
          },
        ],
      },
    });

    assert.match(summary, /## Merge Gate Context/);
    assert.match(summary, /\*\*Merge blockers\*\*: 1/);
    assert.match(summary, /\*\*external_gate\*\* \(blocked\): Release approval is required\./);
    assert.match(summary, /\*\*Queue context\*\*: active aggregate branch/);
    assert.match(summary, /\*\*Strategy\*\*: manual/);
    assert.match(summary, /\*\*Constituent PRs\*\*: #301/);
    assert.match(summary, /\*\*Merge commits found\*\*: 1/);
    assert.match(summary, /\*\*Validation evidence entries\*\*: 1/);
    assert.match(summary, /\*\*Unresolved queue blockers\*\*: 1/);
    assert.match(summary, /\*\*ci_failed\*\* \(blocked\): Queue validation failed\./);
    assert.equal(
      summary.match(/\*\*external_gate\*\* \(blocked\): Release approval is required\./g)?.length,
      1,
    );
  });

  test("keeps dedicated top-level blockers out of agent gate summaries", () => {
    const summary = agentGateSummarySection({
      merge_blockers: [
        {
          kind: "review_required",
          status: "blocked",
          summary: "GitHub requires review before this PR can merge.",
        },
        {
          kind: "ci_failed",
          status: "blocked",
          summary: "1 CI check(s) failed.",
        },
        {
          kind: "merge_conflicts",
          status: "blocked",
          summary: "Merge conflicts detected in 1 file(s).",
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
        },
      ],
      queue_context: null,
    });

    assert.match(summary, /\*\*Merge blockers\*\*: 1/);
    assert.match(summary, /\*\*external_gate\*\* \(blocked\): Release approval is required\./);
    assert.doesNotMatch(summary, /review_required/);
    assert.doesNotMatch(summary, /ci_failed/);
    assert.doesNotMatch(summary, /merge_conflicts/);
  });

  test("deduplicates repeated top-level blockers in agent gate summaries", () => {
    const summary = agentGateSummarySection({
      merge_blockers: [
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
          evidence_refs: ["label:release-hold"],
        },
        {
          kind: "external_gate",
          status: "blocked",
          summary: "Release approval is required.",
          evidence_refs: ["comment:approval-thread"],
        },
      ],
      queue_context: null,
    });

    assert.match(summary, /\*\*Merge blockers\*\*: 1/);
    assert.equal(
      summary.match(/\*\*external_gate\*\* \(blocked\): Release approval is required\./g)?.length,
      1,
    );
  });

  test("deduplicates queue-only blockers in agent gate summaries", () => {
    const summary = agentGateSummarySection({
      merge_blockers: [],
      queue_context: {
        isQueue: true,
        unresolvedBlockers: [
          {
            kind: "queue_validation_failed",
            status: "blocked",
            summary: "Queue validation failed.",
          },
          {
            type: "queue-validation-failed",
            outcome: "failure",
            description: "Queue validation failed.",
          },
        ],
      },
    });

    assert.match(summary, /\*\*Unresolved queue blockers\*\*: 1/);
    assert.equal(
      summary.match(/\*\*queue_validation_failed\*\* \(blocked\): Queue validation failed\./g)?.length,
      1,
    );
  });
});
