/**
 * Pure PR processor planning helpers.
 *
 * The long-running PR loop owns side effects; this module owns the small,
 * deterministic decisions needed before those effects start.
 */

import { validateGitRef } from "./git_ref";
import {
  prDetailsBaseBranch,
  prDetailsHeadBranch,
  prDetailsMergedAt,
  prDetailsNumber,
  prDetailsStateText,
  prDetailsTitle,
  prDetailsUrl,
} from "./pr_details_access_model";
import { prStateFromAgentDecision, type PrProcessingState } from "./pr_state";
import { PI_TOOL_NAMES } from "./pi/tool_contract";
import type { ReviewGateStatus } from "./review_gate_model";
import type { RemediationPolicyDecision } from "./remediation_policy_model";

export type PrProcessingMode = "for-review" | "for-landing" | string;
export type PrProcessingFailureState = "blocked" | "failed";

export interface NormalizedPrProcessingInput {
  pr_number: number;
  head_branch: string;
  base_branch: string;
  url: string;
  title: string;
  mode: PrProcessingMode;
}

export interface PrProcessingValidationError {
  pr_number: number | null;
  field: "number" | "head_branch" | "base_branch" | "url";
  reason: string;
  state: PrProcessingFailureState | null;
}

export type PrProcessingInputResult =
  | { ok: true; value: NormalizedPrProcessingInput }
  | { ok: false; error: PrProcessingValidationError };

export interface PrAgentWorkItemPlan extends Record<string, unknown> {
  kind: "pr";
  repo?: string;
  repo_path: string;
  pr_number: number;
  mode: PrProcessingMode;
  title: string;
  url: string;
  head_branch: string;
  base_branch: string;
  prompt: string;
}

export interface PrProcessingNotificationPlan {
  message: string;
  title: string;
  priority: string;
  tags: string[];
}

export interface PrContextGatherFailurePlan {
  state: PrProcessingFailureState;
  gate: ReviewGateStatus;
  notification: PrProcessingNotificationPlan;
}

export interface PrAgentCompletionPlan {
  success: boolean;
  state: PrProcessingState;
  gate: ReviewGateStatus;
  notification: PrProcessingNotificationPlan;
}

export interface PrAgentExceptionPlan {
  state: PrProcessingFailureState;
  gate: ReviewGateStatus;
  notification: PrProcessingNotificationPlan;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function conciseFailureText(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().replace(/\s+/g, " ");
}

function firstConciseText(...values: unknown[]): string {
  return values.map(conciseFailureText).find(Boolean) ?? "";
}

function normalizedToken(value: unknown): string {
  return conciseFailureText(value).toLowerCase().replace(/[\s-]+/g, "_");
}

export interface PrAgentResultLike {
  returncode: number;
  result: unknown;
  stderr: string;
  stdout: string;
}

export interface PrAgentResultDecision {
  success: boolean;
  failure_reason: string | null;
  failure_state: PrProcessingFailureState | null;
  gate_status: "pass" | PrProcessingFailureState;
  gate_explanation: string;
}

export interface PrMergeVerification {
  available: boolean;
  merged: boolean;
  state: string;
  failure_reason: string | null;
}

export type PrAgentResultStatus = "success" | "failure" | "unknown";

function prAgentResultStatusText(result: unknown): string {
  const resultObj = asRecord(result);
  return firstConciseText(
    resultObj["status"],
    resultObj["state"],
    resultObj["outcome"],
    resultObj["conclusion"],
    resultObj["result_status"],
    resultObj["resultStatus"],
  );
}

export function prAgentResultStatus(result: unknown): PrAgentResultStatus {
  const status = prAgentResultStatusText(result);
  const token = normalizedToken(status);
  if (/^(?:success|succeeded|completed|complete|pass|passed|ok|merged|landed)$/.test(token)) return "success";
  if (/^(?:failure|failed|fail|error|errored|blocked|cancelled|canceled|timeout|timed_out)$/.test(token)) return "failure";
  return "unknown";
}

export function prAgentResultFailureDetail(result: unknown): string {
  const resultObj = asRecord(result);
  return firstConciseText(
    resultObj["error"],
    resultObj["error_message"],
    resultObj["errorMessage"],
    resultObj["failure_reason"],
    resultObj["failureReason"],
    resultObj["summary"],
    resultObj["message"],
    resultObj["detail"],
    resultObj["details"],
  );
}

export function verifyPrMergeCompletion(prDetails: unknown): PrMergeVerification {
  const details = asRecord(prDetails);
  const state = normalizedToken(prDetailsStateText(details)).toUpperCase();
  const mergedAt = prDetailsMergedAt(details);
  const merged = state === "MERGED" || mergedAt === true ||
    (typeof mergedAt === "string" && mergedAt.trim().length > 0);

  if (merged) {
    return { available: true, merged: true, state: state || "MERGED", failure_reason: null };
  }
  if (Object.keys(details).length === 0 || !state) {
    return {
      available: false,
      merged: false,
      state,
      failure_reason: "pi reported success, but merge-god could not verify the PR merge state on GitHub",
    };
  }
  return {
    available: true,
    merged: false,
    state,
    failure_reason: state === "CLOSED"
      ? "pi reported success, but GitHub reports the PR is CLOSED without a merge"
      : `pi reported success, but GitHub reports the PR is ${state} and unmerged`,
  };
}

function prAgentResultNeeds(result: unknown): string[] {
  const resultObj = asRecord(result);
  return [
    ...asArray(resultObj["needs"]),
    ...asArray(resultObj["requirements"]),
    resultObj["next_action"],
    resultObj["nextAction"],
    resultObj["required_action"],
    resultObj["requiredAction"],
  ]
    .map(conciseFailureText)
    .filter((item) => item.length > 0);
}

export function piAgentFailureReason(
  returncode: number,
  result: unknown,
  stderr: string,
  stdout: string,
): string {
  const status = prAgentResultStatus(result);
  const candidates = [
    prAgentResultFailureDetail(result),
    stderr,
    stdout,
  ];
  const detail = candidates.map(conciseFailureText).find(Boolean);
  if (returncode !== 0 && detail) return `pi exited ${returncode}: ${detail}`;
  if (returncode !== 0) return `pi exited ${returncode}`;
  if (result === null || result === undefined) return `pi agent exited without reporting ${PI_TOOL_NAMES.complete} result`;
  if (status === "unknown") {
    return detail
      ? `pi agent reported completion without successful status: ${detail}`
      : "pi agent reported completion without successful status";
  }
  return detail || "pi agent reported failure";
}

export function classifyPrFailureState(
  reason: string,
  result: unknown = null,
): PrProcessingFailureState {
  const text = [
    reason,
    prAgentResultStatusText(result),
    prAgentResultFailureDetail(result),
    ...prAgentResultNeeds(result),
  ]
    .map(conciseFailureText)
    .join(" ")
    .toLowerCase();

  if (
    /\b(blocked|need|needs|needed|requires?|manual|human|approval|permission|permissions|credential|credentials|auth|authentication|authorization|rate limit)\b/.test(
      text,
    )
  ) {
    return "blocked";
  }

  return "failed";
}

export function classifyPrAgentResult(
  result: PrAgentResultLike,
  prDetailsAfterCompletion?: unknown,
): PrAgentResultDecision {
  const status = prAgentResultStatus(result.result);
  const agentSucceeded = result.returncode === 0 && status === "success";
  const mergeVerification = prDetailsAfterCompletion === undefined
    ? null
    : verifyPrMergeCompletion(prDetailsAfterCompletion);
  const success = agentSucceeded && (mergeVerification?.merged ?? true);
  if (success) {
    return {
      success: true,
      failure_reason: null,
      failure_state: null,
      gate_status: "pass",
      gate_explanation: "Pi agent completed successfully.",
    };
  }

  const failureReason = agentSucceeded && mergeVerification?.failure_reason
    ? mergeVerification.failure_reason
    : piAgentFailureReason(result.returncode, result.result, result.stderr, result.stdout);
  const failureState = classifyPrFailureState(failureReason, result.result);
  return {
    success: false,
    failure_reason: failureReason,
    failure_state: failureState,
    gate_status: failureState,
    gate_explanation: failureReason,
  };
}

export function buildPrProcessingStartNotification(
  input: NormalizedPrProcessingInput,
): PrProcessingNotificationPlan {
  return {
    message: `Processing PR #${input.pr_number}: ${input.title}\nMode: ${input.mode}`,
    title: `PR #${input.pr_number} - Processing Started`,
    priority: "default",
    tags: ["robot", "arrows_clockwise"],
  };
}

export function buildPrContextGatherFailurePlan(
  input: NormalizedPrProcessingInput,
  reason: string,
): PrContextGatherFailurePlan {
  return {
    state: classifyPrFailureState(reason),
    gate: {
      rule: "context-gathered",
      status: "blocked",
      explanation: reason,
    },
    notification: {
      message: `PR #${input.pr_number} failed: ${input.title}\nError gathering context: ${reason.slice(0, 100)}`,
      title: `PR #${input.pr_number} - Error`,
      priority: "high",
      tags: ["x", "warning"],
    },
  };
}

export function buildPrAgentCompletionPlan(
  input: NormalizedPrProcessingInput,
  decision: PrAgentResultDecision,
  returncode: number,
  durationSeconds: number,
): PrAgentCompletionPlan {
  const state = prStateFromAgentDecision(decision);
  return {
    success: decision.success,
    state,
    gate: {
      rule: "pi-agent",
      status: decision.gate_status,
      explanation: decision.gate_explanation,
    },
    notification: decision.success
      ? {
          message: `PR #${input.pr_number} completed: ${input.title}\n` +
            `Mode: ${input.mode}\n` +
            `Duration: ${durationSeconds.toFixed(1)}s`,
          title: `PR #${input.pr_number} - Complete`,
          priority: "default",
          tags: ["white_check_mark", "rocket"],
        }
      : {
          message: `PR #${input.pr_number} failed: ${input.title}\n` +
            `Return code: ${returncode}\n` +
            `Duration: ${durationSeconds.toFixed(1)}s`,
          title: `PR #${input.pr_number} - Failed`,
          priority: "high",
          tags: ["x", "warning"],
        },
  };
}

export function buildPrAgentExceptionPlan(
  input: NormalizedPrProcessingInput,
  reason: string,
): PrAgentExceptionPlan {
  const state = classifyPrFailureState(reason);
  return {
    state,
    gate: {
      rule: "pi-agent",
      status: state,
      explanation: reason,
    },
    notification: {
      message: `PR #${input.pr_number} exception: ${reason.slice(0, 100)}`,
      title: `PR #${input.pr_number} - Error`,
      priority: "urgent",
      tags: ["x", "warning"],
    },
  };
}

export function normalizePrProcessingInput(
  pr: Record<string, unknown>,
  defaultBranch = "main",
  mode: PrProcessingMode = "for-landing",
): PrProcessingInputResult {
  const prNumber = prDetailsNumber(pr);
  const headBranch = prDetailsHeadBranch(pr);
  const baseBranch = prDetailsBaseBranch(pr, defaultBranch);
  const url = prDetailsUrl(pr);
  const title = prDetailsTitle(pr, "Unknown");

  if (prNumber === null) {
    return {
      ok: false,
      error: {
        pr_number: null,
        field: "number",
        reason: "Missing PR number",
        state: null,
      },
    };
  }

  if (!headBranch) {
    return {
      ok: false,
      error: {
        pr_number: prNumber,
        field: "head_branch",
        reason: "Missing head branch",
        state: "blocked",
      },
    };
  }

  if (!url) {
    return {
      ok: false,
      error: {
        pr_number: prNumber,
        field: "url",
        reason: "Missing PR URL",
        state: "blocked",
      },
    };
  }

  if (!validateGitRef(headBranch)) {
    return {
      ok: false,
      error: {
        pr_number: prNumber,
        field: "head_branch",
        reason: `Invalid head branch name: ${headBranch}`,
        state: "failed",
      },
    };
  }

  if (!validateGitRef(baseBranch)) {
    return {
      ok: false,
      error: {
        pr_number: prNumber,
        field: "base_branch",
        reason: `Invalid base branch name: ${baseBranch}`,
        state: "failed",
      },
    };
  }

  return {
    ok: true,
    value: {
      pr_number: prNumber,
      head_branch: headBranch,
      base_branch: baseBranch,
      url,
      title,
      mode,
    },
  };
}

export function buildPrAgentWorkItemPlan(
  input: NormalizedPrProcessingInput,
  prompt: string,
  repoPath: string,
  repoName: string | null = null,
  remediationPolicy: RemediationPolicyDecision | null = null,
): PrAgentWorkItemPlan {
  return {
    kind: "pr",
    repo: repoName ?? undefined,
    repo_path: repoPath,
    pr_number: input.pr_number,
    mode: input.mode,
    title: input.title,
    url: input.url,
    head_branch: input.head_branch,
    base_branch: input.base_branch,
    prompt,
    ...(remediationPolicy
      ? {
          disposition_setting: remediationPolicy.effective_mode,
          remediation_policy: remediationPolicy,
        }
      : {}),
  };
}
