import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrAgentCompletionPlan,
  buildPrAgentExceptionPlan,
  buildPrAgentWorkItemPlan,
  buildPrContextGatherFailurePlan,
  buildPrProcessingStartNotification,
  classifyPrAgentResult,
  classifyPrFailureState,
  normalizePrProcessingInput,
  prAgentResultFailureDetail,
  prAgentResultStatus,
  piAgentFailureReason,
} from "../pr_processor_model";

describe("PR processor model", () => {
  test("normalizes valid PR inputs and defaults the base branch", () => {
    const result = normalizePrProcessingInput(
      {
        number: 183,
        title: "Merge queue for account settings",
        headRefName: "queue/account-settings",
        url: "https://github.example.test/org/repo/pull/183",
      },
      "main",
      "for-review",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      pr_number: 183,
      title: "Merge queue for account settings",
      head_branch: "queue/account-settings",
      base_branch: "main",
      url: "https://github.example.test/org/repo/pull/183",
      mode: "for-review",
    });
  });

  test("normalizes cached PR detail aliases before processing", () => {
    const result = normalizePrProcessingInput(
      {
        prNumber: "204",
        name: "Alias queue",
        sourceBranch: "queue/alias",
        target_branch: "develop",
        htmlUrl: "https://example.test/pr/204",
      },
      "main",
      "for-landing",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      pr_number: 204,
      title: "Alias queue",
      head_branch: "queue/alias",
      base_branch: "develop",
      url: "https://example.test/pr/204",
      mode: "for-landing",
    });
  });

  test("returns structured validation errors before side effects", () => {
    assert.deepEqual(normalizePrProcessingInput({}, "main"), {
      ok: false,
      error: {
        pr_number: null,
        field: "number",
        reason: "Missing PR number",
        state: null,
      },
    });

    assert.deepEqual(normalizePrProcessingInput({ number: 184, url: "https://example.test/pr/184" }, "main"), {
      ok: false,
      error: {
        pr_number: 184,
        field: "head_branch",
        reason: "Missing head branch",
        state: "blocked",
      },
    });

    assert.deepEqual(
      normalizePrProcessingInput(
        {
          number: 185,
          headRefName: "bad branch",
          baseRefName: "main",
          url: "https://example.test/pr/185",
        },
        "main",
      ),
      {
        ok: false,
        error: {
          pr_number: 185,
          field: "head_branch",
          reason: "Invalid head branch name: bad branch",
          state: "failed",
        },
      },
    );
  });

  test("builds the agent work item plan from normalized input", () => {
    const result = normalizePrProcessingInput(
      {
        number: 186,
        title: "Queue validation pass",
        headRefName: "queue/validation-pass",
        baseRefName: "develop",
        url: "https://example.test/pr/186",
      },
      "main",
      "for-landing",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(buildPrAgentWorkItemPlan(result.value, "prompt text", "/repo", "repo"), {
      kind: "pr",
      repo: "repo",
      repo_path: "/repo",
      pr_number: 186,
      mode: "for-landing",
      title: "Queue validation pass",
      url: "https://example.test/pr/186",
      head_branch: "queue/validation-pass",
      base_branch: "develop",
      prompt: "prompt text",
    });
  });

  test("builds pure notification and gate plans for PR processing lifecycle events", () => {
    const input = {
      pr_number: 187,
      title: "Queue lifecycle",
      head_branch: "queue/lifecycle",
      base_branch: "main",
      url: "https://example.test/pr/187",
      mode: "for-landing",
    };

    assert.deepEqual(buildPrProcessingStartNotification(input), {
      message: "Processing PR #187: Queue lifecycle\nMode: for-landing",
      title: "PR #187 - Processing Started",
      priority: "default",
      tags: ["robot", "arrows_clockwise"],
    });

    assert.deepEqual(buildPrContextGatherFailurePlan(input, "needs credential"), {
      state: "blocked",
      gate: {
        rule: "context-gathered",
        status: "blocked",
        explanation: "needs credential",
      },
      notification: {
        message: "PR #187 failed: Queue lifecycle\nError gathering context: needs credential",
        title: "PR #187 - Error",
        priority: "high",
        tags: ["x", "warning"],
      },
    });
  });

  test("builds pure completion plans for pi agent outcomes", () => {
    const input = {
      pr_number: 188,
      title: "Agent outcome",
      head_branch: "queue/outcome",
      base_branch: "main",
      url: "https://example.test/pr/188",
      mode: "for-review",
    };

    assert.deepEqual(
      buildPrAgentCompletionPlan(
        input,
        {
          success: true,
          failure_reason: null,
          failure_state: null,
          gate_status: "pass",
          gate_explanation: "Pi agent completed successfully.",
        },
        0,
        12.34,
      ),
      {
        success: true,
        state: "complete",
        gate: {
          rule: "pi-agent",
          status: "pass",
          explanation: "Pi agent completed successfully.",
        },
        notification: {
          message: "PR #188 completed: Agent outcome\nMode: for-review\nDuration: 12.3s",
          title: "PR #188 - Complete",
          priority: "default",
          tags: ["white_check_mark", "rocket"],
        },
      },
    );

    assert.deepEqual(
      buildPrAgentCompletionPlan(
        input,
        {
          success: false,
          failure_reason: "unit tests failed",
          failure_state: "failed",
          gate_status: "failed",
          gate_explanation: "unit tests failed",
        },
        2,
        1.25,
      ),
      {
        success: false,
        state: "ready",
        gate: {
          rule: "pi-agent",
          status: "failed",
          explanation: "unit tests failed",
        },
        notification: {
          message: "PR #188 failed: Agent outcome\nReturn code: 2\nDuration: 1.3s",
          title: "PR #188 - Failed",
          priority: "high",
          tags: ["x", "warning"],
        },
      },
    );
  });

  test("builds pure exception plans for pi agent throws", () => {
    const input = {
      pr_number: 189,
      title: "Agent exception",
      head_branch: "queue/exception",
      base_branch: "main",
      url: "https://example.test/pr/189",
      mode: "for-landing",
    };

    assert.deepEqual(buildPrAgentExceptionPlan(input, "manual approval required"), {
      state: "blocked",
      gate: {
        rule: "pi-agent",
        status: "blocked",
        explanation: "manual approval required",
      },
      notification: {
        message: "PR #189 exception: manual approval required",
        title: "PR #189 - Error",
        priority: "urgent",
        tags: ["x", "warning"],
      },
    });
  });

  test("formats pi agent failure reasons from result, stderr, stdout, and exit code", () => {
    assert.equal(
      piAgentFailureReason(
        1,
        { error: "manual approval required\ncannot continue" },
        "stderr fallback",
        "stdout fallback",
      ),
      "pi exited 1: manual approval required cannot continue",
    );
    assert.equal(
      piAgentFailureReason(1, null, "fatal: missing credential\nretry failed", ""),
      "pi exited 1: fatal: missing credential retry failed",
    );
    assert.equal(piAgentFailureReason(1, null, "", ""), "pi exited 1");
    assert.equal(
      piAgentFailureReason(0, null, "", ""),
      "pi agent exited without reporting merge_god_complete result",
    );
    assert.equal(
      piAgentFailureReason(0, { summary: "done" }, "", ""),
      "pi agent reported completion without successful status: done",
    );
    assert.equal(piAgentFailureReason(0, { status: "failure" }, "", ""), "pi agent reported failure");
    assert.equal(
      piAgentFailureReason(0, { status: "failure", errorMessage: "merge conflict remained" }, "", ""),
      "merge conflict remained",
    );
    assert.equal(
      piAgentFailureReason(0, { status: "failure", failureReason: "CI is still red" }, "", ""),
      "CI is still red",
    );
  });

  test("normalizes pi agent result status and failure-detail aliases", () => {
    assert.equal(prAgentResultStatus({ status: "success" }), "success");
    assert.equal(prAgentResultStatus({ state: "completed" }), "success");
    assert.equal(prAgentResultStatus({ outcome: "landed" }), "success");
    assert.equal(prAgentResultStatus({ conclusion: "blocked" }), "failure");
    assert.equal(prAgentResultStatus({ resultStatus: "TIMED OUT" }), "failure");
    assert.equal(prAgentResultStatus({ status: "surprise" }), "unknown");

    assert.equal(prAgentResultFailureDetail({ errorMessage: "error alias" }), "error alias");
    assert.equal(prAgentResultFailureDetail({ failure_reason: "failure alias" }), "failure alias");
    assert.equal(prAgentResultFailureDetail({ message: "message alias" }), "message alias");
  });

  test("classifies PR failures as blocked only when human or external action is needed", () => {
    assert.equal(classifyPrFailureState("needs credentials before continuing"), "blocked");
    assert.equal(classifyPrFailureState("test suite failed"), "failed");
    assert.equal(classifyPrFailureState("", { error: "manual approval required" }), "blocked");
    assert.equal(classifyPrFailureState("", { needs: ["rate limit reset"] }), "blocked");
    assert.equal(classifyPrFailureState("", { status: "blocked" }), "blocked");
    assert.equal(classifyPrFailureState("", { requirements: ["human review"] }), "blocked");
    assert.equal(classifyPrFailureState("", { requiredAction: "approval from release owner" }), "blocked");
  });

  test("projects pi agent results into a single PR state and review-gate decision", () => {
    assert.deepEqual(
      classifyPrAgentResult({ returncode: 0, result: { status: "success" }, stderr: "", stdout: "" }),
      {
        success: true,
        failure_reason: null,
        failure_state: null,
        gate_status: "pass",
        gate_explanation: "Pi agent completed successfully.",
      },
    );

    assert.deepEqual(
      classifyPrAgentResult({ returncode: 0, result: null, stderr: "", stdout: "" }),
      {
        success: false,
        failure_reason: "pi agent exited without reporting merge_god_complete result",
        failure_state: "failed",
        gate_status: "failed",
        gate_explanation: "pi agent exited without reporting merge_god_complete result",
      },
    );

    assert.deepEqual(
      classifyPrAgentResult({
        returncode: 0,
        result: { summary: "done" },
        stderr: "",
        stdout: "",
      }),
      {
        success: false,
        failure_reason: "pi agent reported completion without successful status: done",
        failure_state: "failed",
        gate_status: "failed",
        gate_explanation: "pi agent reported completion without successful status: done",
      },
    );

    assert.deepEqual(
      classifyPrAgentResult({
        returncode: 0,
        result: { resultStatus: "blocked", failureReason: "needs human approval" },
        stderr: "",
        stdout: "",
      }),
      {
        success: false,
        failure_reason: "needs human approval",
        failure_state: "blocked",
        gate_status: "blocked",
        gate_explanation: "needs human approval",
      },
    );

    assert.deepEqual(
      classifyPrAgentResult({
        returncode: 0,
        result: { conclusion: "blocked" },
        stderr: "",
        stdout: "",
      }),
      {
        success: false,
        failure_reason: "pi agent reported failure",
        failure_state: "blocked",
        gate_status: "blocked",
        gate_explanation: "pi agent reported failure",
      },
    );

    assert.deepEqual(
      classifyPrAgentResult({
        returncode: 2,
        result: { summary: "unit tests failed" },
        stderr: "stderr fallback",
        stdout: "",
      }),
      {
        success: false,
        failure_reason: "pi exited 2: unit tests failed",
        failure_state: "failed",
        gate_status: "failed",
        gate_explanation: "pi exited 2: unit tests failed",
      },
    );
  });
});
