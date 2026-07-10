#!/usr/bin/env node
/**
 * PR Merge Loop — Automatically processes and merges PRs using the pi agent
 * (via the merge-god pi extension and coordination API).
 *
 * Ported from pr-loop.py. Continuously loops over open PRs, syncing the repo,
 * fixing conflicts, responding to reviews, and fixing CI.
 *
 * Usage: ./pr-loop.ts <repo_path> [--watch-issues] [--interactive]
 *
 * Label contract:
 *   - PRs labeled `for-review` get comprehensive review + improvements.
 *   - PRs labeled `for-landing` get basic processing toward a merge.
 *   - Issues labeled `for-impl` get implemented (when --watch-issues is set).
 *   - No label = the PR is skipped.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as readline from "node:readline";
import YAML from "yaml";
import { runPiAgent, type AgentObservation, type WorkItem } from "./coordination";
import {
  evidenceSummaryFromPrDetailsAndContext,
  renderReviewGateStatusComment,
  type ReviewGateEvidenceSummary,
  type ReviewGateStatus,
} from "./evidence_comment";
import type { GitOpsObserver } from "./git_ops";
import { SyncStore } from "@merge-god/github-sync";
import type { DiffAvailability } from "./merge_pr_model";
import { createSpawnCommandRunner } from "./command_runner";
import { validateGitRef } from "./git_ref";
import { analyzeCiStatus, gatherPrContextFromSource } from "./pr_context_gatherer";
import { GhCliPullRequestContextSource } from "./pr_context_source";
import {
  findOwnedReviewGateCacheCommentId,
  planReviewGateCommentCommand,
} from "./review_gate_comment_model";
import {
  categorizeOpenPrs,
  planStackedPrMergeOrder,
  type CategorizedPRs,
} from "./pr_loop_model";
import {
  PR_STATE_LABELS,
  prStateLabel,
  stalePrStateLabelNames,
  type PrProcessingState,
} from "./pr_state";
import { prDetailsNumber } from "./pr_details_access_model";
import { prQueueInfoFromRecord } from "./pr_queue_display_model";
import {
  buildPrAgentCompletionPlan,
  buildPrAgentExceptionPlan,
  buildPrAgentWorkItemPlan,
  buildPrContextGatherFailurePlan,
  buildPrProcessingStartNotification,
  classifyPrAgentResult,
  classifyPrFailureState,
  normalizePrProcessingInput,
} from "./pr_processor_model";
import { buildIssuePrompt, buildPrPrompt } from "./pr_prompt";
import { reviewGateStatusesFromContext } from "./review_gate_status";
import {
  addTelemetryEvent,
  initializeTelemetry,
  recordPromptRendered,
  shutdownTelemetry,
  sanitizeSpanAttributes,
  withTelemetrySpan,
} from "./telemetry";

export { renderReviewGateStatusComment } from "./evidence_comment";
export { validateGitRef } from "./git_ref";
export { classifyPrFailureState, piAgentFailureReason } from "./pr_processor_model";
export { buildIssuePrompt, buildPrPrompt, buildReviewPrompt } from "./pr_prompt";
export type { PrProcessingState } from "./pr_state";

// SyncStore persists PR context for offline agent runs.
const DB_AVAILABLE: boolean = true;
const MERGE_GOD_PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

// --- Small unexported coercion helpers --------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toNum(v: unknown, dflt = 0): number {
  return typeof v === "number" ? v : dflt;
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function hasGuidanceValue(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object" && v !== null) return Object.keys(v).length > 0;
  return v !== undefined && v !== null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Logging ----------------------------------------------------------------

/** Emit structured JSON logs with timestamp. */
export function logJson(eventType: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString().replace("+00:00", "Z"),
    event: eventType,
    data,
  };
  addTelemetryEvent(`log.${eventType}`, logTelemetryAttributes(eventType, data));
  console.log(JSON.stringify(entry));
}

function logTelemetryAttributes(eventType: string, data: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = { "merge_god.event_type": eventType };
  for (const key of [
    "action",
    "pr_number",
    "issue_number",
    "mode",
    "phase",
    "phase_name",
    "success",
    "returncode",
    "duration",
    "error",
  ]) {
    if (data[key] !== undefined) attrs[`merge_god.${key}`] = data[key];
  }
  return attrs;
}

function createGitOpsObserver(): GitOpsObserver {
  return {
    onEvent(event) {
      logJson("git_ops", event as unknown as Record<string, unknown>);
    },
    onMetric(metric) {
      logJson("metric", {
        name: metric.name,
        value: metric.value,
        tags: metric.tags ?? {},
      });
    },
  };
}

function createAgentObservationObserver(): (observation: AgentObservation) => void {
  return (observation) => {
    logJson("agent_observation", observation as unknown as Record<string, unknown>);
  };
}

/**
 * Request user confirmation for an action (interactive mode only).
 *
 * Polls stdin for a JSON response line of the form `{"approved": true|false}`.
 * Returns true if approved, false if declined, errored, or timed out.
 */
export async function requestConfirmation(
  actionType: string,
  description: string,
  prNumber: string | null = null,
  details: Record<string, unknown> | null = null,
  timeout = 300,
): Promise<boolean> {
  logJson("request_confirmation", {
    action_type: actionType,
    description,
    pr_number: prNumber,
    details: details ?? {},
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (val: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      clearTimeout(timeoutHandle);
      resolve(val);
    };

    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    const timeoutHandle = setTimeout(() => {
      logJson("confirmation_timeout", { action_type: actionType, timeout_seconds: timeout });
      finish(false);
    }, timeout * 1000);

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const response = JSON.parse(trimmed) as { approved?: boolean };
        const approved = !!response.approved;
        logJson("confirmation_received", { action_type: actionType, approved });
        finish(approved);
      } catch (e) {
        logJson("confirmation_error", {
          action_type: actionType,
          error: `JSON decode error: ${errMsg(e)}`,
          line: trimmed.slice(0, 100),
        });
        finish(false);
      }
    });

    rl.on("error", (e) => {
      logJson("confirmation_error", { action_type: actionType, error: errMsg(e) });
      finish(false);
    });
  });
}

/**
 * Send a notification to the ntfy.sh topic.
 *
 * Returns true if sent successfully, false otherwise.
 */
export async function sendNotification(
  message: string,
  title: string | null = null,
  priority = "default",
  tags: string[] | null = null,
): Promise<boolean> {
  const topicUrl = "https://ntfy.sh/merge-god-sez";
  try {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (title) headers["Title"] = title;
    if (priority) headers["Priority"] = priority;
    if (tags) headers["Tags"] = tags.join(",");

    const response = await fetch(topicUrl, {
      method: "POST",
      headers,
      body: message,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 200) {
      logJson("notification", {
        action: "sent",
        title,
        message_length: message.length,
      });
      return true;
    }
    logJson("notification", {
      action: "failed",
      status: response.status,
      title,
    });
    return false;
  } catch (e) {
    logJson("notification", {
      action: "error",
      error: errMsg(e),
      title,
    });
    return false;
  }
}

// --- Command execution ------------------------------------------------------

/**
 * Run a command and return [returncode, stdout, stderr].
 *
 * Mirrors Python run_command: truncates oversized output and converts timeout /
 * not-found conditions into returncode -1 with a descriptive stderr string.
 */
export function runCommand(
  cmd: string[],
  cwd?: string,
  timeout = 300,
  maxOutputSize = 50 * 1024 * 1024,
): [number, string, string] {
  try {
    const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: timeout * 1000,
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [-1, "", `Command not found: ${cmd[0] ?? "unknown"}`];
      }
      return [-1, "", `Command failed: ${errMsg(result.error)}`];
    }

    let stdout = result.stdout ?? "";
    let stderr = result.stderr ?? "";

    if (result.signal === "SIGTERM") {
      return [-1, stdout, stderr || `Command timed out after ${timeout} seconds`];
    }

    const stdoutSize = Buffer.byteLength(stdout, "utf8");
    const stderrSize = Buffer.byteLength(stderr, "utf8");

    if (stdoutSize > maxOutputSize) {
      logJson("command_warning", {
        warning: "stdout truncated",
        size: stdoutSize,
        max_size: maxOutputSize,
        command: cmd[0] ?? "unknown",
      });
      stdout = stdout.slice(0, Math.floor(maxOutputSize / 2)) + "\n... [truncated] ...";
    }

    if (stderrSize > maxOutputSize) {
      logJson("command_warning", {
        warning: "stderr truncated",
        size: stderrSize,
        max_size: maxOutputSize,
        command: cmd[0] ?? "unknown",
      });
      stderr = stderr.slice(0, Math.floor(maxOutputSize / 2)) + "\n... [truncated] ...";
    }

    return [result.status ?? -1, stdout, stderr];
  } catch (e) {
    return [-1, "", `Command failed: ${errMsg(e)}`];
  }
}

function fetchPaginatedGhArray(endpoint: string, eventType: string, prNumber: number): Record<string, unknown>[] {
  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "api",
    endpoint,
    "--paginate",
    "--jq",
    ".[]",
  ]);

  if (returncode !== 0) {
    logJson(eventType, { action: "error", pr_number: prNumber, stderr });
    return [];
  }

  let payload: unknown;
  try {
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      payload = JSON.parse(trimmed);
    } else {
      return trimmed
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  } catch (e) {
    logJson(eventType, { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return [];
  }

  return Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [];
}

function createDefaultPrContextSource(): GhCliPullRequestContextSource {
  return new GhCliPullRequestContextSource(createSpawnCommandRunner(logJson), logJson);
}

// --- PR state labels ---------------------------------------------------------

const ensuredPrStateLabels = new Set<string>();

function isAlreadyExistsError(stderr: string): boolean {
  return /already exists|name already exists/i.test(stderr);
}

function ensurePrStateLabels(): boolean {
  let ok = true;
  for (const state of Object.keys(PR_STATE_LABELS) as PrProcessingState[]) {
    ok = ensurePrStateLabel(state) && ok;
  }
  return ok;
}

function ensurePrStateLabel(state: PrProcessingState): boolean {
  const label = prStateLabel(state);
  if (ensuredPrStateLabels.has(label.name)) return true;

  const [returncode, _stdout, stderr] = runCommand(
    [
      "gh",
      "label",
      "create",
      label.name,
      "--color",
      label.color,
      "--description",
      label.description,
    ],
    undefined,
    30,
  );

  if (returncode !== 0 && !isAlreadyExistsError(stderr)) {
    logJson("pr_state_label", {
      action: "ensure_failed",
      label: label.name,
      state,
      stderr,
    });
    return false;
  }

  ensuredPrStateLabels.add(label.name);
  return true;
}

export function setPrStateLabel(prNumber: number, state: PrProcessingState, reason = ""): boolean {
  if (!ensurePrStateLabels()) return false;

  const targetLabel = prStateLabel(state).name;
  const [returncode, _stdout, stderr] = runCommand(
    [
      "gh",
      "issue",
      "edit",
      String(prNumber),
      "--add-label",
      targetLabel,
    ],
    undefined,
    30,
  );

  if (returncode !== 0) {
    logJson("pr_state_label", {
      action: "update_failed",
      pr_number: prNumber,
      state,
      label: targetLabel,
      stderr,
    });
    return false;
  }

  const staleLabels = stalePrStateLabelNames(state);
  for (const staleLabel of staleLabels) {
    const [removeCode, _removeStdout, removeStderr] = runCommand(
      ["gh", "issue", "edit", String(prNumber), "--remove-label", staleLabel],
      undefined,
      30,
    );
    if (removeCode !== 0 && !/not found|does not exist|missing/i.test(removeStderr)) {
      logJson("pr_state_label", {
        action: "remove_stale_failed",
        pr_number: prNumber,
        state,
        label: staleLabel,
        stderr: removeStderr,
      });
    }
  }

  logJson("pr_state_label", {
    action: "updated",
    pr_number: prNumber,
    state,
    label: targetLabel,
    reason: reason ? reason.slice(0, 240) : undefined,
  });
  return true;
}

function ensureAgentAnnotationLabel(name: string): boolean {
  const spec = AGENT_ANNOTATION_LABELS[name];
  if (!spec) return false;
  const [viewCode] = runCommand(["gh", "label", "view", name], undefined, 30);
  if (viewCode === 0) return true;
  const [createCode, _stdout, stderr] = runCommand(
    [
      "gh",
      "label",
      "create",
      name,
      "--color",
      spec.color,
      "--description",
      spec.description,
    ],
    undefined,
    30,
  );
  if (createCode !== 0 && !isAlreadyExistsError(stderr)) {
    logJson("agent_annotation_label", {
      action: "ensure_failed",
      label: name,
      stderr,
    });
    return false;
  }
  return true;
}

export function applyAgentAnnotationLabels(prNumber: number, labels: string[]): boolean {
  const allowedLabels = [...new Set(labels)].filter((label) => label in AGENT_ANNOTATION_LABELS);
  if (allowedLabels.length === 0) return true;
  const ensuredLabels = allowedLabels.filter((label) => ensureAgentAnnotationLabel(label));
  if (ensuredLabels.length === 0) return false;
  const [returncode, _stdout, stderr] = runCommand(
    ["gh", "pr", "edit", String(prNumber), "--add-label", ensuredLabels.join(",")],
    undefined,
    30,
  );
  if (returncode !== 0) {
    logJson("agent_annotation_label", {
      action: "apply_failed",
      pr_number: prNumber,
      labels: ensuredLabels,
      stderr,
    });
    return false;
  }
  logJson("agent_annotation_label", {
    action: "applied",
    pr_number: prNumber,
    labels: ensuredLabels,
  });
  return true;
}

// --- Review gate status comment cache ----------------------------------------

export interface AgentTokenUsage {
  model?: string;
  merge_god_commit?: string;
  merge_god_release?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
  source?: string;
}

export const AGENT_ANNOTATION_LABELS: Record<string, { description: string; color: string }> = {
  large: {
    description: "Agent annotation: broad PR with many files or substantial review surface",
    color: "d4c5f9",
  },
  "too-large": {
    description: "Agent annotation: PR is too large to safely process as one landing unit",
    color: "b60205",
  },
  unaligned: {
    description: "Agent annotation: implementation appears unaligned with design, requirements, or merge rules",
    color: "fbca04",
  },
  "needs-split": {
    description: "Agent annotation: PR should be split into smaller or underlying PRs",
    color: "d93f0b",
  },
  "needs-ci": {
    description: "Agent annotation: CI or validation failures need remediation",
    color: "d93f0b",
  },
  "needs-rebase": {
    description: "Agent annotation: PR needs to be updated from its base branch",
    color: "fbca04",
  },
  "needs-conflict-resolution": {
    description: "Agent annotation: PR needs merge conflict resolution",
    color: "d93f0b",
  },
  "needs-review": {
    description: "Agent annotation: PR needs review feedback addressed or approval",
    color: "fbca04",
  },
  "needs-design": {
    description: "Agent annotation: design or requirements clarification is needed before landing",
    color: "fbca04",
  },
  "high-risk": {
    description: "Agent annotation: higher merge risk due to scope, architecture, or validation uncertainty",
    color: "b60205",
  },
  "low-risk": {
    description: "Agent annotation: low-risk change with narrow scope",
    color: "0e8a16",
  },
  "docs-only": {
    description: "Agent annotation: documentation-only change",
    color: "0075ca",
  },
  "test-only": {
    description: "Agent annotation: test-only change",
    color: "1d76db",
  },
  "embark-candidate": {
    description: "Agent annotation: candidate for grouped embark validation",
    color: "5319e7",
  },
  "underlying-needed": {
    description: "Agent annotation: needs an underlying remediation PR or set before landing",
    color: "d93f0b",
  },
};

export function agentAnnotationLabelsFromResult(result: unknown): string[] {
  const resultObj = asRecord(result);
  const annotations = asRecord(resultObj["annotations"]);
  const candidates = [
    ...asArray(resultObj["annotation_labels"]),
    ...asArray(annotations["labels"]),
  ];
  const labels = new Set<string>();
  for (const candidate of candidates) {
    const label = toStr(candidate).trim().toLowerCase().replace(/\s+/g, "-");
    if (label in AGENT_ANNOTATION_LABELS) labels.add(label);
  }
  return [...labels];
}

function agentFailureText(result: unknown, failureReason: string | null = null): string {
  const resultObj = asRecord(result);
  const annotations = asRecord(resultObj["annotations"]);
  return [
    failureReason,
    resultObj["status"],
    resultObj["state"],
    resultObj["outcome"],
    resultObj["conclusion"],
    resultObj["error"],
    resultObj["error_message"],
    resultObj["errorMessage"],
    resultObj["failure_reason"],
    resultObj["failureReason"],
    resultObj["summary"],
    resultObj["message"],
    resultObj["detail"],
    resultObj["details"],
    resultObj["required_action"],
    resultObj["requiredAction"],
    resultObj["next_action"],
    resultObj["nextAction"],
    ...asArray(resultObj["needs"]),
    ...asArray(resultObj["requirements"]),
    ...asArray(annotations["labels"]),
  ]
    .map((value) => toStr(value).trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function agentResultHasFailureSignal(result: unknown, failureReason: string | null = null): boolean {
  if (failureReason && failureReason.trim()) return true;

  const resultObj = asRecord(result);
  const statusText = [
    resultObj["status"],
    resultObj["state"],
    resultObj["outcome"],
    resultObj["conclusion"],
  ]
    .map((value) => toStr(value).trim().toLowerCase())
    .filter(Boolean);

  if (statusText.some((value) => /^(?:blocked|error|failed|failure|timed[-\s]?out|timeout|cancelled)$/i.test(value))) {
    return true;
  }

  return [
    resultObj["error"],
    resultObj["error_message"],
    resultObj["errorMessage"],
    resultObj["failure_reason"],
    resultObj["failureReason"],
    resultObj["required_action"],
    resultObj["requiredAction"],
    resultObj["next_action"],
    resultObj["nextAction"],
    ...asArray(resultObj["needs"]),
    ...asArray(resultObj["requirements"]),
  ].some((value) => Boolean(toStr(value).trim()));
}

export function inferredAgentAnnotationLabelsFromFailure(
  result: unknown,
  failureReason: string | null = null,
): string[] {
  const text = agentFailureText(result, failureReason);
  if (!text) return [];
  const labels = new Set<string>();
  if (/\b(?:too\s+large|oversized|large\s+diff|split|smaller\s+prs?|separate\s+prs?)\b/.test(text)) {
    labels.add("needs-split");
  }
  if (/\b(?:ci|check|checks|status|workflow|action|actions|build|test|tests|lint|typecheck|validation)\b/.test(text)) {
    labels.add("needs-ci");
  }
  if (/\b(?:rebase|behind|out[-\s]+of[-\s]+date|update(?:d)?\s+from\s+(?:base|main|master)|base\s+branch)\b/.test(text)) {
    labels.add("needs-rebase");
  }
  if (/\b(?:conflict|conflicts|merge\s+conflict|dirty|not\s+mergeable)\b/.test(text)) {
    labels.add("needs-conflict-resolution");
  }
  if (/\b(?:review|changes?\s+requested|approval|approve|approved|required\s+review)\b/.test(text)) {
    labels.add("needs-review");
  }
  if (/\b(?:design|requirements?|spec|architecture|clarification|unclear|unaligned)\b/.test(text)) {
    labels.add("needs-design");
  }
  if (/\b(?:underlying|dependency|dependencies|parent\s+pr|base\s+pr|stack\s+parent|remediation\s+pr)\b/.test(text)) {
    labels.add("underlying-needed");
  }
  return [...labels].filter((label) => label in AGENT_ANNOTATION_LABELS);
}

export function agentAnnotationLabelsForCompletion(
  result: unknown,
  failureReason: string | null = null,
): string[] {
  const inferredLabels = agentResultHasFailureSignal(result, failureReason)
    ? inferredAgentAnnotationLabelsFromFailure(result, failureReason)
    : [];
  return [
    ...new Set([
      ...agentAnnotationLabelsFromResult(result),
      ...inferredLabels,
    ]),
  ];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

export function agentTokenUsageFromResult(result: unknown): AgentTokenUsage | null {
  const resultObj = asRecord(result);
  const telemetryObj = asRecord(resultObj["telemetry"]);
  const usageObj = asRecord(telemetryObj["usage"]);
  const legacyUsageObj = asRecord(resultObj["usage"]);
  const usage = Object.keys(usageObj).length > 0
    ? usageObj
    : Object.keys(legacyUsageObj).length > 0
      ? legacyUsageObj
      : resultObj;
  const inputTokens = nonNegativeInteger(usage["input_tokens"]);
  const outputTokens = nonNegativeInteger(usage["output_tokens"]);
  const cacheCreationInputTokens = nonNegativeInteger(usage["cache_creation_input_tokens"]);
  const cacheReadInputTokens = nonNegativeInteger(usage["cache_read_input_tokens"]);
  const explicitTotal = nonNegativeInteger(usage["total_tokens"]);
  const summedTotal =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  const totalTokens = explicitTotal ?? summedTotal;

  if (
    modelValue(resultObj, telemetryObj, usage) === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  return {
    model: modelValue(resultObj, telemetryObj, usage),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    total_tokens: totalTokens,
    source:
      typeof usage["source"] === "string" && usage["source"].trim()
        ? usage["source"].trim()
        : "merge_god_complete",
  };
}

function modelValue(
  resultObj: Record<string, unknown>,
  telemetry: Record<string, unknown>,
  usage: Record<string, unknown>,
): string | undefined {
  if (typeof usage["model"] === "string" && usage["model"].trim()) return usage["model"].trim();
  if (typeof telemetry["model"] === "string" && telemetry["model"].trim()) return telemetry["model"].trim();
  if (typeof resultObj["model"] === "string" && resultObj["model"].trim()) return resultObj["model"].trim();
  return undefined;
}

function packageVersionRelease(): string {
  try {
    const raw = readFileSync(resolve(MERGE_GOD_PACKAGE_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const version = typeof pkg["version"] === "string" ? pkg["version"].trim() : "";
    return version ? `v${version}` : "unknown";
  } catch {
    return "unknown";
  }
}

export function mergeGodRuntimeTelemetry(): Pick<AgentTokenUsage, "merge_god_commit" | "merge_god_release"> {
  const [commitCode, commitStdout] = runCommand(
    ["git", "rev-parse", "--short=12", "HEAD"],
    MERGE_GOD_PACKAGE_ROOT,
    10,
  );
  const [tagCode, tagStdout] = runCommand(
    ["git", "describe", "--tags", "--exact-match", "HEAD"],
    MERGE_GOD_PACKAGE_ROOT,
    10,
  );
  return {
    merge_god_commit: commitCode === 0 && commitStdout.trim() ? commitStdout.trim() : "unknown",
    merge_god_release: tagCode === 0 && tagStdout.trim() ? tagStdout.trim() : packageVersionRelease(),
  };
}

let currentGhLogin: string | null | undefined;

function currentGitHubLogin(): string | null {
  if (currentGhLogin !== undefined) return currentGhLogin;
  const [returncode, stdout] = runCommand(["gh", "api", "user", "--jq", ".login"], undefined, 30);
  currentGhLogin = returncode === 0 ? stdout.trim() || null : null;
  return currentGhLogin;
}

async function currentGitHubLoginAsync(): Promise<string | null> {
  if (currentGhLogin !== undefined) return currentGhLogin;
  const [returncode, stdout] = await createSpawnCommandRunner(logJson).run(
    ["gh", "api", "user", "--jq", ".login"],
    undefined,
    30,
  );
  currentGhLogin = returncode === 0 ? stdout.trim() || null : null;
  return currentGhLogin;
}

function findOwnedReviewGateCacheComment(prNumber: number): number | null {
  const comments = getPrComments(prNumber);
  return findOwnedReviewGateCacheCommentId(comments, currentGitHubLogin());
}

async function findOwnedReviewGateCacheCommentAsync(prNumber: number): Promise<number | null> {
  const [comments, login] = await Promise.all([
    getPrCommentsAsync(prNumber),
    currentGitHubLoginAsync(),
  ]);
  return findOwnedReviewGateCacheCommentId(comments, login);
}

export function updateReviewGateStatusComment(
  prNumber: number,
  gates: ReviewGateStatus[],
  opts: { updatedAt?: string; evidence?: ReviewGateEvidenceSummary | null } = {},
): boolean {
  const body = renderReviewGateStatusComment(gates, opts.updatedAt, opts.evidence ?? null);
  const existingCommentId = findOwnedReviewGateCacheComment(prNumber);
  const plan = planReviewGateCommentCommand(prNumber, body, existingCommentId);
  const [returncode, _stdout, stderr] = runCommand(plan.args, undefined, 30, 1024 * 1024);
  if (returncode !== 0) {
    logJson("review_gate_comment", {
      action: "update_failed",
      pr_number: prNumber,
      mode: plan.mode,
      stderr,
    });
    return false;
  }
  logJson("review_gate_comment", {
    action: "updated",
    pr_number: prNumber,
    mode: plan.mode,
    gate_count: gates.length,
  });
  return true;
}

export async function updateReviewGateStatusCommentAsync(
  prNumber: number,
  gates: ReviewGateStatus[],
  opts: { updatedAt?: string; evidence?: ReviewGateEvidenceSummary | null } = {},
): Promise<boolean> {
  const body = renderReviewGateStatusComment(gates, opts.updatedAt, opts.evidence ?? null);
  const existingCommentId = await findOwnedReviewGateCacheCommentAsync(prNumber);
  const plan = planReviewGateCommentCommand(prNumber, body, existingCommentId);
  const [returncode, _stdout, stderr] = await createSpawnCommandRunner(logJson).run(
    plan.args,
    undefined,
    30,
    1024 * 1024,
  );
  if (returncode !== 0) {
    logJson("review_gate_comment", {
      action: "update_failed",
      pr_number: prNumber,
      mode: plan.mode,
      stderr,
    });
    return false;
  }
  logJson("review_gate_comment", {
    action: "updated",
    pr_number: prNumber,
    mode: plan.mode,
    gate_count: gates.length,
  });
  return true;
}

// --- PR / issue discovery ---------------------------------------------------

/**
 * Fetch open PRs and categorize them by processing-mode labels.
 *
 * Returns PRs grouped into "for-review", "for-landing", and "untagged" buckets.
 * Drafts and WIP PRs are filtered out (and logged).
 */
export function getOpenPrs(): CategorizedPRs {
  logJson("fetch_prs", { action: "start" });

  const [returncode, stdout, stderr] = runCommand(
    [
      "gh",
      "pr",
      "list",
      "--json",
      "number,title,headRefName,baseRefName,isDraft,labels,url,author,createdAt,updatedAt",
      "--limit",
      "100",
    ],
    undefined,
    60,
  );

  if (returncode !== 0) {
    logJson("fetch_prs", { action: "error", stderr });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  if (!stdout || !stdout.trim()) {
    logJson("fetch_prs", { action: "empty_response" });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  let allPrs: unknown;
  try {
    allPrs = JSON.parse(stdout);
  } catch (e) {
    logJson("fetch_prs", { action: "parse_error", error: errMsg(e), stdout: stdout.slice(0, 200) });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  if (!Array.isArray(allPrs)) {
    logJson("fetch_prs", { action: "invalid_type", type: typeof allPrs });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  const result = categorizeOpenPrs(allPrs);
  for (const event of result.events) {
    logJson("fetch_prs", event);
  }
  logJson("fetch_prs", result.summary);
  return result.categorized;
}

/** Fetch open issues labeled "for-impl" that should be implemented. */
export function getOpenIssues(): Record<string, unknown>[] {
  logJson("fetch_issues", { action: "start" });

  const [returncode, stdout, stderr] = runCommand(
    [
      "gh",
      "issue",
      "list",
      "--json",
      "number,title,body,labels,url,author,createdAt,updatedAt,state",
      "--label",
      "for-impl",
      "--state",
      "open",
      "--limit",
      "100",
    ],
    undefined,
    60,
  );

  if (returncode !== 0) {
    logJson("fetch_issues", { action: "error", stderr });
    return [];
  }

  if (!stdout || !stdout.trim()) {
    logJson("fetch_issues", { action: "empty_response" });
    return [];
  }

  let allIssues: unknown;
  try {
    allIssues = JSON.parse(stdout);
  } catch (e) {
    logJson("fetch_issues", { action: "parse_error", error: errMsg(e), stdout: stdout.slice(0, 200) });
    return [];
  }

  if (!Array.isArray(allIssues)) {
    logJson("fetch_issues", { action: "invalid_type", type: typeof allIssues });
    return [];
  }

  const validIssues: Record<string, unknown>[] = [];
  for (const issueRaw of allIssues) {
    if (typeof issueRaw !== "object" || issueRaw === null) continue;
    const issue = issueRaw as Record<string, unknown>;

    if (issue["number"] === undefined || issue["title"] === undefined || issue["url"] === undefined) {
      logJson("fetch_issues", { action: "invalid_issue", issue });
      continue;
    }

    const labels: string[] = [];
    for (const labelRaw of asArray(issue["labels"])) {
      const label = asRecord(labelRaw);
      if (label["name"] !== undefined) labels.push(toStr(label["name"]).toLowerCase());
    }

    if (labels.includes("for-impl")) {
      validIssues.push(issue);
    }
  }

  logJson("fetch_issues", {
    action: "complete",
    total: allIssues.length,
    for_impl: validIssues.length,
  });

  return validIssues;
}

// --- Git helpers ------------------------------------------------------------

/** Detect the default branch of the repository. */
export function detectDefaultBranch(): string {
  let [returncode, stdout, _stderr] = runCommand(
    ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
    undefined,
    10,
  );

  if (returncode === 0 && stdout) {
    const parts = stdout.trim().split("/");
    const branch = parts[parts.length - 1];
    if (branch) return branch;
  }

  for (const branch of ["main", "master", "develop"]) {
    const [rc] = runCommand(["git", "rev-parse", "--verify", `origin/${branch}`], undefined, 10);
    if (rc === 0) return branch;
  }

  logJson("branch_detection", { warning: "Could not detect default branch, using 'main'" });
  return "main";
}

/** Fetch comprehensive PR details from `gh pr view`. */
export const PR_VIEW_JSON_FIELDS = [
  "number",
  "url",
  "title",
  "body",
  "state",
  "headRefName",
  "baseRefName",
  "isDraft",
  "mergeable",
  "author",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "labels",
  "assignees",
  "reviewRequests",
  "latestReviews",
  "additions",
  "deletions",
  "changedFiles",
  "commits",
  "reviews",
  "reviewDecision",
  "statusCheckRollup",
] as const;

export function getPrDetails(prNumber: number): Record<string, unknown> {
  logJson("get_pr_details", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--json",
    PR_VIEW_JSON_FIELDS.join(","),
  ]);

  if (returncode !== 0) {
    logJson("get_pr_details", { action: "error", pr_number: prNumber, stderr });
    return {};
  }

  let details: Record<string, unknown>;
  try {
    details = JSON.parse(stdout) as Record<string, unknown>;
  } catch (e) {
    logJson("get_pr_details", { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return {};
  }

  logJson("get_pr_details", { action: "complete", pr_number: prNumber });
  return details;
}

export async function getPrDetailsAsync(prNumber: number): Promise<Record<string, unknown>> {
  return createDefaultPrContextSource().getDetails(prNumber);
}

/** Fetch all PR discussion/issue comments. */
export function getPrComments(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_comments", { action: "start", pr_number: prNumber });

  const list = fetchPaginatedGhArray(`repos/{owner}/{repo}/issues/${prNumber}/comments`, "get_pr_comments", prNumber);
  logJson("get_pr_comments", {
    action: "complete",
    pr_number: prNumber,
    comment_count: list.length,
  });
  return list;
}

export async function getPrCommentsAsync(prNumber: number): Promise<Record<string, unknown>[]> {
  return createDefaultPrContextSource().getComments(prNumber);
}

/** Fetch all inline PR review comments. */
export function getPrReviewComments(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_review_comments", { action: "start", pr_number: prNumber });

  const list = fetchPaginatedGhArray(`repos/{owner}/{repo}/pulls/${prNumber}/comments`, "get_pr_review_comments", prNumber);
  logJson("get_pr_review_comments", {
    action: "complete",
    pr_number: prNumber,
    review_comment_count: list.length,
  });
  return list;
}

export async function getPrReviewCommentsAsync(prNumber: number): Promise<Record<string, unknown>[]> {
  return createDefaultPrContextSource().getReviewComments(prNumber);
}

/** Get the PR diff. */
export function getPrDiff(prNumber: number): string {
  return getPrDiffWithAvailability(prNumber).diff;
}

export function getPrDiffWithAvailability(prNumber: number): { diff: string; availability: DiffAvailability } {
  logJson("get_pr_diff", { action: "start", pr_number: prNumber });
  const [returncode, stdout, stderr] = runCommand(["gh", "pr", "diff", String(prNumber)]);

  if (returncode !== 0) {
    logJson("get_pr_diff", { action: "error", pr_number: prNumber, stderr });
    return {
      diff: "",
      availability: {
        available: false,
        source: "gh-pr-diff",
        size: 0,
        truncated: /too_large|maximum number of lines|exceeded/i.test(stderr),
        error: stderr || `gh pr diff exited ${returncode}`,
      },
    };
  }

  logJson("get_pr_diff", {
    action: "complete",
    pr_number: prNumber,
    diff_size: stdout.length,
  });
  return {
    diff: stdout,
    availability: {
      available: stdout.length > 0,
      source: "gh-pr-diff",
      size: stdout.length,
      truncated: false,
      error: null,
    },
  };
}

export async function getPrDiffWithAvailabilityAsync(
  prNumber: number,
  headBranch?: string,
  baseBranch?: string,
): Promise<{ diff: string; availability: DiffAvailability }> {
  return createDefaultPrContextSource().getDiff(prNumber, {
    head_branch: headBranch ?? "",
    base_branch: baseBranch ?? "",
  });
}

/** Check if a PR has merge conflicts with its base branch. */
export function checkMergeConflicts(
  prNumber: number,
  headBranch: string,
  baseBranch: string,
): Record<string, unknown> {
  logJson("check_merge_conflicts", {
    action: "start",
    pr_number: prNumber,
    head_branch: headBranch,
    base_branch: baseBranch,
  });

  if (!validateGitRef(headBranch)) {
    logJson("check_merge_conflicts", {
      action: "invalid_branch",
      pr_number: prNumber,
      branch: "head",
      value: headBranch,
    });
    return {
      has_conflicts: false,
      conflicting_files: [],
      conflict_count: 0,
      error: "Invalid head branch name",
    };
  }

  if (!validateGitRef(baseBranch)) {
    logJson("check_merge_conflicts", {
      action: "invalid_branch",
      pr_number: prNumber,
      branch: "base",
      value: baseBranch,
    });
    return {
      has_conflicts: false,
      conflicting_files: [],
      conflict_count: 0,
      error: "Invalid base branch name",
    };
  }

  let [returncode, stdout, stderr] = runCommand(
    ["git", "fetch", "origin", headBranch, baseBranch],
    undefined,
    120,
  );

  if (returncode !== 0) {
    logJson("check_merge_conflicts", {
      action: "fetch_error",
      pr_number: prNumber,
      stderr,
    });
    return {
      has_conflicts: false,
      conflicting_files: [],
      conflict_count: 0,
      error: "Failed to fetch branches",
    };
  }

  [returncode, stdout, stderr] = runCommand(
    ["git", "merge-tree", `origin/${baseBranch}`, `origin/${headBranch}`],
    undefined,
    120,
  );

  let hasConflicts = false;
  if (returncode === 0 && stdout) {
    const lines = stdout.split("\n");
    let conflictMarkerCount = 0;
    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) conflictMarkerCount++;
    }
    hasConflicts = conflictMarkerCount > 0;
  }

  const conflictingFiles: string[] = [];
  if (hasConflicts) {
    const lines = stdout.split("\n");
    let currentFile: string | null = null;
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---")) {
        const parts = line.split(" ");
        if (parts.length > 1 && parts[1] !== "/dev/null") {
          const filePath = (parts[1] ?? "").replace(/^[ab/]+/, "");
          if (filePath && !conflictingFiles.includes(filePath)) {
            currentFile = filePath;
          }
        }
      } else if (line.startsWith("<<<<<<<") && currentFile) {
        if (!conflictingFiles.includes(currentFile)) {
          conflictingFiles.push(currentFile);
        }
      }
    }
  }

  const result: Record<string, unknown> = {
    has_conflicts: hasConflicts,
    conflicting_files: conflictingFiles,
    conflict_count: conflictingFiles.length,
  };

  logJson("check_merge_conflicts", {
    action: "complete",
    pr_number: prNumber,
    ...result,
  });

  return result;
}

/** Get all commits in the PR. */
export function getPrCommits(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_commits", { action: "start", pr_number: prNumber });

  const list = fetchPaginatedGhArray(`repos/{owner}/{repo}/pulls/${prNumber}/commits`, "get_pr_commits", prNumber);
  logJson("get_pr_commits", {
    action: "complete",
    pr_number: prNumber,
    commit_count: list.length,
  });
  return list;
}

export async function getPrCommitsAsync(prNumber: number): Promise<Record<string, unknown>[]> {
  return createDefaultPrContextSource().getCommits(prNumber);
}

/** Get list of changed files in the PR. */
export function getPrFiles(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_files", { action: "start", pr_number: prNumber });

  const list = fetchPaginatedGhArray(`repos/{owner}/{repo}/pulls/${prNumber}/files`, "get_pr_files", prNumber);
  logJson("get_pr_files", {
    action: "complete",
    pr_number: prNumber,
    file_count: list.length,
  });
  return list;
}

export async function getPrFilesAsync(prNumber: number): Promise<Record<string, unknown>[]> {
  return createDefaultPrContextSource().getFiles(prNumber);
}

/** Sync the repository with origin. Returns true on success. */
export function syncRepo(defaultBranch = "main"): boolean {
  logJson("sync_repo", { action: "start", branch: defaultBranch });

  if (!validateGitRef(defaultBranch)) {
    logJson("sync_repo", {
      action: "error",
      step: "validation",
      error: `Invalid branch name: ${defaultBranch}`,
    });
    return false;
  }

  let [returncode, _stdout, stderr] = runCommand(["git", "fetch", "--all", "--prune"], undefined, 180);
  if (returncode !== 0) {
    logJson("sync_repo", { action: "error", step: "fetch", stderr });
    return false;
  }

  [returncode, _stdout, stderr] = runCommand(["git", "checkout", defaultBranch], undefined, 30);
  if (returncode !== 0) {
    logJson("sync_repo", { action: "error", step: "checkout", branch: defaultBranch, stderr });
    return false;
  }

  [returncode, _stdout, stderr] = runCommand(["git", "pull", "origin", defaultBranch], undefined, 120);
  if (returncode !== 0) {
    logJson("sync_repo", { action: "error", step: "pull", branch: defaultBranch, stderr });
    return false;
  }

  logJson("sync_repo", { action: "complete" });
  return true;
}

/** Check for PR guidelines in common locations. */
export function getPrGuidelines(): string {
  const guidelineFiles = [
    "CONTRIBUTING.md",
    ".github/CONTRIBUTING.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/CONTRIBUTING.md",
    "PULL_REQUEST_TEMPLATE.md",
  ];

  for (const filename of guidelineFiles) {
    const filepath = resolve(process.cwd(), filename);
    if (existsSync(filepath)) {
      try {
        return readFileSync(filepath, "utf8");
      } catch {
        continue;
      }
    }
  }

  return "";
}

/** Get recent commit messages from the default branch as style examples. */
export function getCommitHistoryExamples(defaultBranch = "main"): string {
  if (!validateGitRef(defaultBranch)) {
    logJson("commit_history", { warning: `Invalid branch name: ${defaultBranch}` });
    return "";
  }

  const [returncode, stdout, _stderr] = runCommand(
    ["git", "log", "--pretty=format:%s", "-n", "20", `origin/${defaultBranch}`],
    undefined,
    30,
  );

  if (returncode === 0 && stdout) {
    return stdout;
  }

  return "";
}

const MERGE_RULE_FILES = [
  ".merge-rules.yaml",
  ".merge-rules.yml",
  ".commandments.yaml",
  ".commandments.yml",
];

/** Load repo-local merge rules, if the repository defines them. */
export function getMergeRules(repoPath = process.cwd()): string {
  for (const filename of MERGE_RULE_FILES) {
    const filepath = resolve(repoPath, filename);
    if (!existsSync(filepath)) continue;

    try {
      const raw = readFileSync(filepath, "utf8").trim();
      if (!raw) return "";

      try {
        const parsed = YAML.parse(raw);
        if (!hasGuidanceValue(parsed)) {
          logJson("merge_rules", { action: "empty", file: filename });
          return "";
        }
      } catch (e) {
        logJson("merge_rules", {
          action: "parse_warning",
          file: filename,
          error: errMsg(e),
        });
      }

      logJson("merge_rules", { action: "loaded", file: filename, size: raw.length });
      return [
        `Source: \`${filename}\``,
        "",
        "This repo-local merge rule specification is authoritative for this repository.",
        "Gate definitions describe the evidence required before merge, push, or approval.",
        "Collect all feasible gate evidence before producing a final gate decision.",
        "Failed gates may trigger bounded remediation when the configured thresholds allow it.",
        "Workflow-IR references define preferred executable gate workflows; run supported refs and report unsupported refs as skipped evidence.",
        "",
        "```yaml",
        raw,
        "```",
      ].join("\n");
    } catch (e) {
      logJson("merge_rules", { action: "read_error", file: filename, error: errMsg(e) });
      return "";
    }
  }

  return "";
}

// --- PR context gathering ---------------------------------------------------

/**
 * Gather comprehensive context about a PR before processing.
 *
 * Returns a tuple `[prDetails, prContext]`. Both elements are plain
 * `Record<string, unknown>` dictionaries. Other modules (e.g. sync_pr_context)
 * import this via the `gather_pr_context` snake_case alias.
 */
export async function gatherPrContext(
  prNumber: number,
  headBranch: string,
  baseBranch: string,
  url: string,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  return withTelemetrySpan(
    "merge_god.gather_pr_context",
    {
      "merge_god.pr_number": prNumber,
      "merge_god.head_branch": headBranch,
      "merge_god.base_branch": baseBranch,
      "merge_god.url": url,
    },
    async (span) => {
      const result = await gatherPrContextFromSource(
        createDefaultPrContextSource(),
        prNumber,
        headBranch,
        baseBranch,
        url,
        logJson,
      );
      const contextSummary = asRecord(result[1]["context_summary"]);
      span.setAttributes(sanitizeSpanAttributes({
        "merge_god.context.comments": contextSummary["comments"],
        "merge_god.context.review_comments": contextSummary["review_comments"],
        "merge_god.context.files": contextSummary["files"],
        "merge_god.context.has_conflicts": contextSummary["has_conflicts"],
        "merge_god.context.ci_failed": contextSummary["ci_failed"],
        "merge_god.context.merge_blockers": contextSummary["merge_blockers"],
        "merge_god.context.is_queue": contextSummary["is_queue"],
      }));
      return result;
    },
  );
}

// snake_case alias for cross-module compatibility (sync_pr_context imports this).
export { gatherPrContext as gather_pr_context };

// --- PR / issue processing --------------------------------------------------

/**
 * Process a single PR using the pi agent through the coordination API.
 */
export async function processPr(
  pr: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
  defaultBranch = "main",
  mode = "for-landing",
  interactive = false,
  db: SyncStore | null = null,
  repoName: string | null = null,
  mergeRules = "",
): Promise<boolean> {
  const inputResult = normalizePrProcessingInput(pr, defaultBranch, mode);

  if (!inputResult.ok) {
    const error = inputResult.error;
    logJson("process_pr", {
      action: "validation_error",
      pr_number: error.pr_number ?? undefined,
      error: error.reason,
      field: error.field,
      pr: error.pr_number === null ? pr : undefined,
    });
    if (error.pr_number !== null && error.state !== null) {
      setPrStateLabel(error.pr_number, error.state, error.reason);
    }
    return false;
  }

  const {
    pr_number: prNumber,
    head_branch: headBranch,
    base_branch: baseBranch,
    url,
    title,
  } = inputResult.value;

  return withTelemetrySpan(
    "merge_god.process_pr",
    {
      "merge_god.operation": "process_pr",
      "merge_god.target": `pr:${prNumber}`,
      "merge_god.run_label": `${repoName ?? basename(process.cwd())} PR #${prNumber} ${mode}`,
      "merge_god.pr_number": prNumber,
      "merge_god.title": title,
      "merge_god.head_branch": headBranch,
      "merge_god.base_branch": baseBranch,
      "merge_god.mode": mode,
      "merge_god.repo_name": repoName ?? "",
      "merge_god.url": url,
    },
    async (span) => {
  if (interactive) {
    const approved = await requestConfirmation("process_pr", `Process PR #${prNumber}: ${title}`, String(prNumber), {
      title,
      mode,
      head_branch: headBranch,
      base_branch: baseBranch,
      url,
    });

    if (!approved) {
      logJson("process_pr", { action: "declined_by_user", pr_number: prNumber });
      setPrStateLabel(prNumber, "blocked", "Declined by user");
      return false;
    }
  }

  logJson("process_pr", {
    action: "start",
    pr_number: prNumber,
    title,
    head_branch: headBranch,
    base_branch: baseBranch,
    mode,
  });
  setPrStateLabel(prNumber, "processing", `Started ${mode}`);

  const startNotification = buildPrProcessingStartNotification(inputResult.value);
  await sendNotification(
    startNotification.message,
    startNotification.title,
    startNotification.priority,
    startNotification.tags,
  );

  logJson("process_pr", {
    action: "gathering_context",
    pr_number: prNumber,
    phase: "1/4",
    phase_name: "Context Gathering",
  });

  let prDetails: Record<string, unknown>;
  let prContextDict: Record<string, unknown>;
  let reviewGateStatuses: ReviewGateStatus[] = [];
  try {
    [prDetails, prContextDict] = await gatherPrContext(prNumber, headBranch, baseBranch, url);
    logJson("process_pr", {
      action: "context_gathered",
      pr_number: prNumber,
      phase: "1/4",
      phase_name: "Context Gathering Complete",
    });
  } catch (e) {
    const reason = errMsg(e);
    const failurePlan = buildPrContextGatherFailurePlan(inputResult.value, reason);
    logJson("process_pr", { action: "context_gather_error", pr_number: prNumber, error: reason });
    setPrStateLabel(prNumber, failurePlan.state, reason);
    await updateReviewGateStatusCommentAsync(prNumber, [failurePlan.gate]);
    await sendNotification(
      failurePlan.notification.message,
      failurePlan.notification.title,
      failurePlan.notification.priority,
      failurePlan.notification.tags,
    );
    return false;
  }

  if (Object.keys(prDetails).length === 0) {
    logJson("process_pr", {
      action: "empty_details",
      pr_number: prNumber,
      error: "Failed to fetch PR details",
    });
    setPrStateLabel(prNumber, "blocked", "Failed to fetch PR details");
    await updateReviewGateStatusCommentAsync(prNumber, [
      {
        rule: "context-gathered",
        status: "blocked",
        explanation: "Failed to fetch PR details.",
      },
    ]);
    return false;
  }

  reviewGateStatuses = reviewGateStatusesFromContext(prDetails, prContextDict, mergeRules);
  const reviewGateEvidence = evidenceSummaryFromPrDetailsAndContext(prDetails, prContextDict);
  await updateReviewGateStatusCommentAsync(prNumber, reviewGateStatuses, { evidence: reviewGateEvidence });

  prContextDict["guidelines"] = guidelines;
  prContextDict["commit_examples"] = commitExamples;
  prContextDict["merge_rules"] = mergeRules;

  if (db && repoName) {
    try {
      await db.savePrContext(repoName, prNumber, prDetails, prContextDict);
      logJson("process_pr", { action: "context_saved_to_db", pr_number: prNumber, db_enabled: true });
    } catch (e) {
      logJson("process_pr", {
        action: "context_save_warning",
        pr_number: prNumber,
        error: errMsg(e),
        hint: "PR processing will continue, but context won't be cached for replay",
      });
    }
  }

  const prompt = buildPrPrompt(prDetails, prContextDict, guidelines, commitExamples, mergeRules);
  recordPromptRendered("pr_landing", prompt, {
    "merge_god.pr_number": prNumber,
    "merge_god.mode": mode,
    "merge_god.repo_name": repoName ?? "",
  });

  logJson("process_pr", {
    action: "prompt_generated",
    pr_number: prNumber,
    prompt_size: prompt.length,
  });
  span.setAttribute("merge_god.prompt_size", prompt.length);

  logJson("process_pr", {
    action: "agent_processing",
    pr_number: prNumber,
    phase: "3/3",
    phase_name: "Pi Agent Processing PR",
    mode,
  });

  const workItem: WorkItem = buildPrAgentWorkItemPlan(inputResult.value, prompt, process.cwd(), repoName);

  try {
    const startedAt = Date.now();
    const piResult = await runPiAgent(workItem, process.cwd(), {
      timeout: 3600,
      gitObserver: createGitOpsObserver(),
      agentObserver: createAgentObservationObserver(),
    });
    const duration = (Date.now() - startedAt) / 1000;
    const agentUsage = {
      ...(agentTokenUsageFromResult(piResult.result) ?? {}),
      ...mergeGodRuntimeTelemetry(),
    };
    const agentDecision = classifyPrAgentResult(piResult);
    const annotationLabels = agentAnnotationLabelsForCompletion(piResult.result, agentDecision.failure_reason);
    const completionPlan = buildPrAgentCompletionPlan(inputResult.value, agentDecision, piResult.returncode, duration);
    span.setAttributes(sanitizeSpanAttributes({
      "merge_god.success": agentDecision.success,
      "merge_god.duration_seconds": duration,
      "merge_god.returncode": piResult.returncode,
      "merge_god.failure_reason": agentDecision.failure_reason,
      "merge_god.final_state": completionPlan.state,
      "merge_god.result_status": agentDecision.success ? "success" : "failure",
      "merge_god.result_summary": completionPlan.success
        ? "Pi agent completed successfully"
        : agentDecision.failure_reason ?? "Pi agent failed",
    }));
    addTelemetryEvent("merge_god.run_result", {
      operation: "process_pr",
      target: `pr:${prNumber}`,
      mode,
      result_status: agentDecision.success ? "success" : "failure",
      result_summary: completionPlan.success
        ? "Pi agent completed successfully"
        : agentDecision.failure_reason ?? "Pi agent failed",
      duration_seconds: duration,
      returncode: piResult.returncode,
      final_state: completionPlan.state,
    });
    await updateReviewGateStatusCommentAsync(
      prNumber,
      [
        ...reviewGateStatuses,
        completionPlan.gate,
      ],
      { evidence: reviewGateEvidence },
    );
    const annotationLabelsApplied = applyAgentAnnotationLabels(prNumber, annotationLabels);

    logJson("process_pr", {
      action: "complete",
      pr_number: prNumber,
      phase: "3/3",
      success: agentDecision.success,
      duration,
      reason: agentDecision.failure_reason,
      returncode: piResult.returncode,
      stdout: piResult.stdout,
      stderr: piResult.stderr,
      result: piResult.result,
      token_usage: agentUsage,
      annotation_labels: annotationLabels,
      annotation_labels_applied: annotationLabelsApplied,
      mode,
    });

    setPrStateLabel(
      prNumber,
      completionPlan.state,
      completionPlan.success ? "Pi agent completed successfully" : agentDecision.failure_reason ?? "",
    );
    await sendNotification(
      completionPlan.notification.message,
      completionPlan.notification.title,
      completionPlan.notification.priority,
      completionPlan.notification.tags,
    );

    return agentDecision.success;
  } catch (e) {
    const reason = errMsg(e);
    const exceptionPlan = buildPrAgentExceptionPlan(inputResult.value, reason);
    logJson("process_pr", {
      action: "exception",
      pr_number: prNumber,
      error: reason,
      error_type: e instanceof Error ? e.name : typeof e,
    });
    setPrStateLabel(prNumber, exceptionPlan.state, reason);
    await updateReviewGateStatusCommentAsync(
      prNumber,
      [
        ...reviewGateStatuses,
        exceptionPlan.gate,
      ],
      { evidence: reviewGateEvidence },
    );

    await sendNotification(
      exceptionPlan.notification.message,
      exceptionPlan.notification.title,
      exceptionPlan.notification.priority,
      exceptionPlan.notification.tags,
    );

    return false;
  }
    },
  );
}

/**
 * Process a GitHub issue labeled "for-impl".
 *
 * Creates a branch, implements the feature/fix via the pi agent (through the
 * merge-god coordination API), and lets the agent create a linked PR. Returns
 * true on success.
 */
export async function processIssue(
  issue: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
  defaultBranch = "main",
  interactive = false,
  mergeRules = "",
): Promise<boolean> {
  const issueNumber = issue["number"] as number | undefined;
  const title = (issue["title"] as string | undefined) ?? "Unknown";
  const body = (issue["body"] as string | undefined) ?? "";
  const url = issue["url"] as string | undefined;

  if (!issueNumber) {
    logJson("process_issue", { action: "validation_error", error: "Missing issue number", issue });
    return false;
  }

  if (!url) {
    logJson("process_issue", {
      action: "validation_error",
      issue_number: issueNumber,
      error: "Missing issue URL",
    });
    return false;
  }

  return withTelemetrySpan(
    "merge_god.process_issue",
    {
      "merge_god.operation": "process_issue",
      "merge_god.target": `issue:${issueNumber}`,
      "merge_god.run_label": `Issue #${issueNumber} for-impl`,
      "merge_god.issue_number": issueNumber,
      "merge_god.title": title,
      "merge_god.url": url,
    },
    async (span) => {
  if (interactive) {
    const approved = await requestConfirmation(
      "implement_issue",
      `Implement issue #${issueNumber}: ${title}`,
      null,
      { issue_number: issueNumber, title, url },
    );

    if (!approved) {
      logJson("process_issue", { action: "declined_by_user", issue_number: issueNumber });
      return false;
    }
  }

  logJson("process_issue", { action: "start", issue_number: issueNumber, title });

  await sendNotification(
    `Implementing issue #${issueNumber}: ${title}`,
    `Issue #${issueNumber} - Implementation Started`,
    "default",
    ["construction", "bulb"],
  );

  let sanitizedTitle = title.toLowerCase().replace(/ /g, "-").slice(0, 50);
  sanitizedTitle = Array.from(sanitizedTitle)
    .filter((c) => /[a-z0-9-]/.test(c))
    .join("");
  const branchName = `issue-${issueNumber}-${sanitizedTitle}`;

  if (!validateGitRef(branchName)) {
    logJson("process_issue", {
      action: "validation_error",
      issue_number: issueNumber,
      error: `Invalid branch name: ${branchName}`,
    });
    return false;
  }

  logJson("process_issue", { action: "sync_branch", branch: defaultBranch });

  let [returncode, _stdout, stderr] = runCommand(["git", "checkout", defaultBranch]);
  if (returncode !== 0) {
    logJson("process_issue", { action: "checkout_error", issue_number: issueNumber, error: stderr });
    return false;
  }

  [returncode, _stdout, stderr] = runCommand(["git", "pull", "origin", defaultBranch]);
  if (returncode !== 0) {
    logJson("process_issue", { action: "pull_error", issue_number: issueNumber, error: stderr });
    return false;
  }

  logJson("process_issue", {
    action: "create_branch",
    issue_number: issueNumber,
    branch: branchName,
  });

  [returncode, _stdout, stderr] = runCommand(["git", "checkout", "-b", branchName]);
  if (returncode !== 0) {
    [returncode, _stdout, stderr] = runCommand(["git", "checkout", branchName]);
    if (returncode !== 0) {
      logJson("process_issue", { action: "branch_error", issue_number: issueNumber, error: stderr });
      return false;
    }
  }

  const prompt = buildIssuePrompt({
    issueNumber,
    title,
    url,
    body,
    branchName,
    defaultBranch,
    guidelines,
    commitExamples,
    mergeRules,
  });
  recordPromptRendered("issue_impl", prompt, {
    "merge_god.issue_number": issueNumber,
  });

  logJson("process_issue", {
    action: "prompt_generated",
    issue_number: issueNumber,
    prompt_size: prompt.length,
  });
  span.setAttribute("merge_god.prompt_size", prompt.length);

  logJson("process_issue", { action: "running_pi", issue_number: issueNumber });

  const workItem: WorkItem = {
    kind: "issue",
    issue_number: issueNumber,
    title,
    url,
    prompt,
    repo_path: process.cwd(),
  };

  const piResult = await runPiAgent(workItem, process.cwd(), {
    timeout: 3600,
    gitObserver: createGitOpsObserver(),
    agentObserver: createAgentObservationObserver(),
  });
  const { returncode: rc, stdout, stderr: piStderr, result: piResultObj } = piResult;

  logJson("process_issue", {
    action: "pi_complete",
    issue_number: issueNumber,
    returncode: rc,
    stdout,
    stderr: piStderr,
    result: piResultObj,
  });

  const success = rc === 0;
  span.setAttributes(sanitizeSpanAttributes({
    "merge_god.success": success,
    "merge_god.returncode": rc,
    "merge_god.result_status": success ? "success" : "failure",
    "merge_god.result_summary": success ? "Issue implementation completed" : "Issue implementation failed",
  }));
  addTelemetryEvent("merge_god.run_result", {
    operation: "process_issue",
    target: `issue:${issueNumber}`,
    result_status: success ? "success" : "failure",
    result_summary: success ? "Issue implementation completed" : "Issue implementation failed",
    returncode: rc,
  });

  if (success) {
    await sendNotification(
      `Issue #${issueNumber} implementation completed: ${title}\nCheck the created PR for details`,
      `Issue #${issueNumber} - Complete`,
      "default",
      ["white_check_mark", "bulb"],
    );
  } else {
    await sendNotification(
      `Issue #${issueNumber} implementation failed: ${title}\nCheck logs for details`,
      `Issue #${issueNumber} - Failed`,
      "high",
      ["x", "warning"],
    );
  }

  logJson("process_issue", { action: "complete", issue_number: issueNumber, success });

  return success;
    },
  );
}

// --- Repository validation --------------------------------------------------

/** Validate that the path is a valid git repository with GitHub auth available. */
export function validateRepository(repoPath: string): boolean {
  if (!existsSync(repoPath)) {
    logJson("validation_error", { error: "Repository path does not exist", path: repoPath });
    return false;
  }

  let isDir = false;
  try {
    isDir = statSync(repoPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    logJson("validation_error", { error: "Repository path is not a directory", path: repoPath });
    return false;
  }

  const gitDir = resolve(repoPath, ".git");
  if (!existsSync(gitDir)) {
    logJson("validation_error", {
      error: "Not a git repository (no .git directory)",
      path: repoPath,
    });
    return false;
  }

  const [returncode, _stdout, stderr] = runCommand(["git", "status"], repoPath);
  if (returncode !== 0) {
    logJson("validation_error", { error: "Git command failed", path: repoPath, stderr });
    return false;
  }

  const hasTokenEnv = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const [ghRc, ghStdout, ghStderr] = runCommand(["gh", "auth", "token"]);
  if (!hasTokenEnv && (ghRc !== 0 || ghStdout.trim().length === 0)) {
    logJson("validation_error", {
      error: "GitHub API auth unavailable. Set GITHUB_TOKEN/GH_TOKEN or run 'gh auth login'.",
      stderr: ghStderr,
    });
    return false;
  }

  logJson("validation", { success: true, path: repoPath });
  return true;
}

// --- CLI --------------------------------------------------------------------

interface CliArgs {
  repoPath: string;
  watchIssues: boolean;
  interactive: boolean;
  once: boolean;
  dryRun: boolean;
  maxIterations: number | null;
  idleSleepSeconds: number;
  syncFailureSleepSeconds: number;
  betweenItemsSleepSeconds: number;
}

function positiveIntegerOption(value: unknown, optionName: string): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return number;
}

/** Parse command line arguments. */
export function parseCliArgs(argv = process.argv.slice(2)): CliArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      "watch-issues": { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "max-iterations": { type: "string" },
      "idle-sleep-seconds": { type: "string" },
      "sync-failure-sleep-seconds": { type: "string" },
      "between-items-sleep-seconds": { type: "string" },
    },
    allowPositionals: true,
  });

  const repoPath = parsed.positionals[0];
  if (!repoPath) {
    throw new Error("repo_path is required");
  }

  const explicitMaxIterations = positiveIntegerOption(parsed.values["max-iterations"], "--max-iterations");
  const once = !!parsed.values.once;
  return {
    repoPath,
    watchIssues: !!parsed.values["watch-issues"],
    interactive: !!parsed.values.interactive,
    once,
    dryRun: !!parsed.values["dry-run"],
    maxIterations: once ? 1 : explicitMaxIterations,
    idleSleepSeconds: positiveIntegerOption(parsed.values["idle-sleep-seconds"], "--idle-sleep-seconds") ?? 300,
    syncFailureSleepSeconds: positiveIntegerOption(parsed.values["sync-failure-sleep-seconds"], "--sync-failure-sleep-seconds") ?? 60,
    betweenItemsSleepSeconds: positiveIntegerOption(parsed.values["between-items-sleep-seconds"], "--between-items-sleep-seconds") ?? 10,
  };
}

function shouldStopLoop(iteration: number, args: CliArgs): boolean {
  return args.maxIterations !== null && iteration >= args.maxIterations;
}

/** Main loop — process PRs (and optionally issues) forever. */
export async function main(): Promise<void> {
  process.on("SIGINT", () => {
    logJson("shutdown", { reason: "keyboard_interrupt" });
    void shutdownTelemetry().finally(() => process.exit(0));
  });

  initializeTelemetry(undefined, logJson);
  let args: CliArgs;
  try {
    args = parseCliArgs();
  } catch (e) {
    console.error(`Error: ${errMsg(e)}`);
    console.error(
      "Usage: pr-loop <repo_path> [--watch-issues] [--interactive] [--once|--max-iterations N] [--dry-run]",
    );
    process.exit(2);
  }
  const repoPath = resolve(args.repoPath);

  if (!validateRepository(repoPath)) {
    process.exit(1);
  }

  process.chdir(repoPath);

  logJson("startup", {
    repo_path: repoPath,
    cwd: process.cwd(),
    node_version: process.version,
    once: args.once,
    dry_run: args.dryRun,
    max_iterations: args.maxIterations,
    idle_sleep_seconds: args.idleSleepSeconds,
    sync_failure_sleep_seconds: args.syncFailureSleepSeconds,
    between_items_sleep_seconds: args.betweenItemsSleepSeconds,
  });

  let db: SyncStore | null = null;
  let repoName: string | null = null;
  if (DB_AVAILABLE) {
    try {
      const dbPath = resolve("merge-god-state.db");
      db = new SyncStore(dbPath);
      await db.initialize();
      repoName = basename(repoPath);
      logJson("startup", { database_enabled: true, db_path: dbPath, repo_name: repoName });
    } catch (e) {
      logJson("startup", {
        database_error: errMsg(e),
        warning: "Continuing without database persistence",
      });
      db = null;
    }
  } else {
    logJson("startup", {
      database_enabled: false,
      warning: "Database operations module not available",
    });
  }

  const defaultBranch = detectDefaultBranch();
  logJson("startup", { default_branch: defaultBranch });

  const guidelines = getPrGuidelines();
  const mergeRules = getMergeRules();
  const commitExamples = !guidelines ? getCommitHistoryExamples(defaultBranch) : "";

  logJson("startup", {
    has_guidelines: !!guidelines,
    has_merge_rules: !!mergeRules,
    has_commit_examples: !!commitExamples,
  });

  let iteration = 0;
  const processingPrs = new Set<number>();
  const processingIssues = new Set<number>();

  for (;;) {
    iteration++;
    logJson("iteration", { number: iteration, action: "start" });

    if (!syncRepo(defaultBranch)) {
      logJson("iteration", { number: iteration, action: "sync_failed", sleep_seconds: args.syncFailureSleepSeconds });
      if (shouldStopLoop(iteration, args)) {
        logJson("iteration", { number: iteration, action: "stop", reason: "max_iterations_reached" });
        break;
      }
      await sleep(args.syncFailureSleepSeconds * 1000);
      continue;
    }

    let issuesProcessed = 0;
    if (args.watchIssues) {
      const openIssues = getOpenIssues();

      if (openIssues.length > 0) {
        logJson("iteration", {
          number: iteration,
          action: "issues_found",
          count: openIssues.length,
        });

        for (const issue of openIssues) {
          const issueNumber = issue["number"] as number | undefined;

          if (issueNumber && processingIssues.has(issueNumber)) {
            logJson("process_issue", { action: "skip_duplicate", issue_number: issueNumber });
            continue;
          }

          if (issueNumber) processingIssues.add(issueNumber);

          try {
            const success = await processIssue(
              issue,
              guidelines,
              commitExamples,
              defaultBranch,
              args.interactive,
              mergeRules,
            );
            if (success && issueNumber) processingIssues.delete(issueNumber);
            issuesProcessed++;
          } catch (e) {
            logJson("process_issue", {
              action: "exception",
              issue_number: issueNumber,
              error: errMsg(e),
            });
            if (issueNumber) processingIssues.delete(issueNumber);
          }

          await sleep(args.betweenItemsSleepSeconds * 1000);
        }
      } else {
        logJson("iteration", { number: iteration, action: "no_issues_found" });
      }
    }
    processingIssues.clear();

    const categorizedPrs = getOpenPrs();

    const totalProcessable = categorizedPrs["for-review"].length + categorizedPrs["for-landing"].length;

    if (totalProcessable === 0) {
      logJson("iteration", {
        number: iteration,
        action: "no_processable_prs",
        untagged_count: categorizedPrs["untagged"].length,
        sleep_seconds: args.idleSleepSeconds,
      });
      processingPrs.clear();
      if (shouldStopLoop(iteration, args)) {
        logJson("iteration", { number: iteration, action: "stop", reason: "max_iterations_reached" });
        break;
      }
      await sleep(args.idleSleepSeconds * 1000);
      continue;
    }

    const stackMergeOrderPlan = planStackedPrMergeOrder(categorizedPrs);
    const prDetails = {
      for_review: categorizedPrs["for-review"].map((pr) => prQueueInfoFromRecord(pr, { titleMaxLength: 50 })),
      for_landing: categorizedPrs["for-landing"].map((pr) => prQueueInfoFromRecord(pr, { titleMaxLength: 50 })),
      untagged: categorizedPrs["untagged"].map((pr) => prQueueInfoFromRecord(pr, { titleMaxLength: 50 })),
      processing_order: stackMergeOrderPlan.ordered.map((item) => ({
        ...prQueueInfoFromRecord(item.pr, { titleMaxLength: 50 }),
        mode: item.mode,
        stack_dependencies: item.stack_dependency_numbers,
        stack_dependents: item.stack_dependent_numbers,
      })),
    };

    logJson("iteration", {
      number: iteration,
      action: "prs_categorized",
      for_review: categorizedPrs["for-review"].length,
      for_landing: categorizedPrs["for-landing"].length,
      untagged: categorizedPrs["untagged"].length,
      pr_details: prDetails,
      stack_merge_order: {
        strategy: "branch-ref-topological-order",
        stacks: stackMergeOrderPlan.stacks,
        blocked: stackMergeOrderPlan.blocked,
      },
    });

    let totalProcessed = 0;
    if (args.dryRun) {
      logJson("iteration", {
        number: iteration,
        action: "dry_run",
        planned_prs: stackMergeOrderPlan.ordered.map((item) => ({
          pr_number: prDetailsNumber(item.pr),
          mode: item.mode,
          stack_dependencies: item.stack_dependency_numbers,
          stack_dependents: item.stack_dependent_numbers,
        })),
      });
    } else {
      for (const planned of stackMergeOrderPlan.ordered) {
        const pr = planned.pr;
        const mode = planned.mode;
        const prNumber = prDetailsNumber(pr) ?? undefined;

        if (prNumber && processingPrs.has(prNumber)) {
          logJson("process_pr", { action: "skip_duplicate", pr_number: prNumber, mode });
          continue;
        }

        if (prNumber) processingPrs.add(prNumber);

        try {
          const success = await processPr(
            pr,
            guidelines,
            commitExamples,
            defaultBranch,
            mode,
            args.interactive,
            db,
            repoName,
            mergeRules,
          );
          if (success && prNumber) processingPrs.delete(prNumber);
          totalProcessed++;
        } catch (e) {
          const reason = errMsg(e);
          logJson("process_pr", {
            action: "exception",
            pr_number: prNumber,
            mode,
            error: reason,
          });
          if (prNumber) setPrStateLabel(prNumber, classifyPrFailureState(reason), reason);
          if (prNumber) processingPrs.delete(prNumber);
        }
        await sleep(args.betweenItemsSleepSeconds * 1000);
      }
    }
    processingPrs.clear();

    logJson("iteration", {
      number: iteration,
      action: "complete",
      issues_processed: issuesProcessed,
      prs_processed: totalProcessed,
      sleep_seconds: args.idleSleepSeconds,
    });

    if (shouldStopLoop(iteration, args)) {
      logJson("iteration", { number: iteration, action: "stop", reason: "max_iterations_reached" });
      break;
    }

    await sleep(args.idleSleepSeconds * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((e) => {
    logJson("fatal_error", { error: errMsg(e) });
    void shutdownTelemetry().finally(() => process.exit(1));
  });
}
