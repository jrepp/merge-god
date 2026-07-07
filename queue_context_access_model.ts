/**
 * Pure accessors for modeled queue context with cached field aliases.
 *
 * Canonical queue context uses snake_case field names. Review-gate cache rows
 * and adapter-shaped records may carry camelCase aliases; normalize that at the
 * boundary so renderers and gate projection do not grow ad hoc key checks.
 */

import {
  firstPresentRecordCollectionBy,
  recordShapeItem,
} from "./collection_access_model";
import { commitMessage } from "./commit_access_model";
import { recordConflictFiles } from "./conflict_file_access_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import {
  queueConstituentPrNumber,
  queueMergeCommitIdentifier,
} from "./queue_context_summary_model";

function queueContextRecord(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

export const QUEUE_CONTEXT_KEYS = ["queue_context", "queueContext", "merge_queue_context", "mergeQueueContext"];
export const QUEUE_FLAG_KEYS = ["is_queue", "isQueue"];
export const QUEUE_STRATEGY_KEYS = [
  "strategy",
  "queue_strategy",
  "queueStrategy",
  "merge_strategy",
  "mergeStrategy",
  "strategy_label",
  "strategyLabel",
];
export const QUEUE_CONSTITUENT_KEYS = [
  "constituent_prs",
  "constituentPrs",
  "constituent_nodes",
  "constituentNodes",
  "constituent_edges",
  "constituentEdges",
  "pull_requests",
  "pullRequests",
  "pull_request_nodes",
  "pullRequestNodes",
  "pull_request_edges",
  "pullRequestEdges",
  "prs",
  "merge_requests",
  "mergeRequests",
  "merge_request_nodes",
  "mergeRequestNodes",
  "merge_request_edges",
  "mergeRequestEdges",
];
export const QUEUE_MERGE_COMMIT_KEYS = [
  "merge_commits",
  "mergeCommits",
  "merge_commit_nodes",
  "mergeCommitNodes",
  "merge_commit_edges",
  "mergeCommitEdges",
  "queue_commits",
  "queueCommits",
  "queue_commit_nodes",
  "queueCommitNodes",
  "queue_commit_edges",
  "queueCommitEdges",
];
export const QUEUE_VALIDATION_KEYS = [
  "validation_evidence",
  "validationEvidence",
  "validation_nodes",
  "validationNodes",
  "validation_edges",
  "validationEdges",
  "validation_results",
  "validationResults",
  "validation_result_nodes",
  "validationResultNodes",
  "validation_result_edges",
  "validationResultEdges",
  "validations",
  "check_results",
  "checkResults",
  "check_result_nodes",
  "checkResultNodes",
  "check_result_edges",
  "checkResultEdges",
];
export const QUEUE_BLOCKER_KEYS = [
  "unresolved_blockers",
  "unresolvedBlockers",
  "unresolved_blocker_nodes",
  "unresolvedBlockerNodes",
  "unresolved_blocker_edges",
  "unresolvedBlockerEdges",
  "queue_blockers",
  "queueBlockers",
  "queue_blocker_nodes",
  "queueBlockerNodes",
  "queue_blocker_edges",
  "queueBlockerEdges",
];
export const QUEUE_BLOCKER_WITH_GENERIC_KEYS = [...QUEUE_BLOCKER_KEYS, "blockers"];

export function normalizeQueueBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const text = toStr(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(?:true|yes|y|1|queue|queued|is_queue)$/.test(text)) return true;
  if (/^(?:false|no|n|0|none|not_queue|not_a_queue)$/.test(text)) return false;
  return null;
}

export function firstNormalizedQueueBoolean(record: Record<string, unknown>): boolean | null {
  for (const key of QUEUE_FLAG_KEYS) {
    const normalized = normalizeQueueBoolean(record[key]);
    if (normalized !== null) return normalized;
  }
  return null;
}

function normalizedToken(value: unknown): string {
  return toStr(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function recognizedQueueStrategy(value: unknown): boolean {
  const strategy = normalizedToken(value);
  return strategy === "title_pr_list" ||
    strategy === "merge_commits" ||
    strategy === "manual" ||
    /^(?:title_prs|title_pr_numbers|title_list|title|merge_commit|commits|commit_history)$/.test(strategy);
}

function firstNonEmptyTextOrPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstNonEmptyText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = toStr(record[key]).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function hasMeaningfulRecordValue(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => {
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null;
  });
}

function hasMeaningfulConstituentValue(record: Record<string, unknown>): boolean {
  return queueConstituentPrNumber(record) !== null ||
    firstNonEmptyText(record, [
      "title",
      "name",
      "summary",
      "subject",
      "label",
      "status",
      "state",
      "queue_status",
      "queueStatus",
      "validation_status",
      "validationStatus",
      "mr_number",
      "mrNumber",
      "mr_iid",
      "mrIid",
      "conclusion",
      "head_sha",
      "headSha",
      "head_oid",
      "headOid",
    ]).length > 0 ||
    hasMeaningfulRecordValue(queueContextRecord(record["head"])) ||
    hasMeaningfulRecordValue(queueContextRecord(record["head_commit"] ?? record["headCommit"])) ||
    recordEvidenceRefs(record).length > 0;
}

function hasMeaningfulMergeCommitValue(record: Record<string, unknown>): boolean {
  const nested = queueContextRecord(record["commit"]);
  return queueMergeCommitIdentifier(record).length > 0 ||
    commitMessage(record).length > 0 ||
    firstNonEmptyText(record, [
      "pr_number",
      "prNumber",
      "pull_number",
      "pullNumber",
      "mr_number",
      "mrNumber",
      "merge_request_iid",
      "mergeRequestIid",
      "mr_iid",
      "mrIid",
      "conflict_file",
      "conflictFile",
    ]).length > 0 ||
    recordConflictFiles(record).length > 0 ||
    recordConflictFiles(nested).length > 0 ||
    recordEvidenceRefs(record).length > 0 ||
    recordEvidenceRefs(nested).length > 0 ||
    hasMeaningfulRecordValue(nested);
}

function hasMeaningfulValidationEvidenceValue(record: Record<string, unknown>): boolean {
  return firstNonEmptyText(record, [
    "command",
    "cmd",
    "check",
    "name",
    "status",
    "state",
    "result",
    "outcome",
    "conclusion",
    "scope",
    "area",
    "package",
    "path",
    "pr",
    "pull_request",
    "pullRequest",
    "mr",
    "mr_number",
    "mrNumber",
    "mr_iid",
    "mrIid",
    "merge_request",
    "mergeRequest",
    "merge_request_number",
    "mergeRequestNumber",
    "merge_request_iid",
    "mergeRequestIid",
  ]).length > 0 ||
    recordEvidenceRefs(record).length > 0;
}

export function queueContextIsQueue(value: unknown): boolean {
  const queueContext = queueContextRecord(value);
  const normalized = firstNormalizedQueueBoolean(queueContext);
  if (normalized !== null) return normalized;
  if (recognizedQueueStrategy(queueContextStrategy(queueContext))) return true;
  return queueContextConstituentPrs(queueContext).length > 0 ||
    queueContextMergeCommits(queueContext).length > 0 ||
    queueContextValidationEvidence(queueContext).length > 0 ||
    queueContextUnresolvedBlockers(queueContext).length > 0;
}

export function queueContextStrategy(value: unknown): unknown {
  return firstNonEmptyTextOrPresent(queueContextRecord(value), QUEUE_STRATEGY_KEYS);
}

export function queueContextConstituentPrs(value: unknown): unknown[] {
  return firstPresentRecordCollectionBy(
    queueContextRecord(value),
    QUEUE_CONSTITUENT_KEYS,
    (items) => items.some(hasMeaningfulConstituentValue),
  );
}

export function queueContextMergeCommits(value: unknown): unknown[] {
  return firstPresentRecordCollectionBy(
    queueContextRecord(value),
    [...QUEUE_MERGE_COMMIT_KEYS, "commits"],
    (items) => items.some(hasMeaningfulMergeCommitValue),
  );
}

export function queueContextValidationEvidence(value: unknown): unknown[] {
  return firstPresentRecordCollectionBy(
    queueContextRecord(value),
    QUEUE_VALIDATION_KEYS,
    (items) => items.some(hasMeaningfulValidationEvidenceValue),
  );
}

export function queueContextQueueBlockers(value: unknown): unknown[] {
  return firstPresentRecordCollectionBy(
    queueContextRecord(value),
    QUEUE_BLOCKER_KEYS,
    (items) => items.some(hasMeaningfulRecordValue),
  );
}

export function queueContextUnresolvedBlockers(value: unknown): unknown[] {
  return firstPresentRecordCollectionBy(
    queueContextRecord(value),
    QUEUE_BLOCKER_WITH_GENERIC_KEYS,
    (items) => items.some(hasMeaningfulRecordValue),
  );
}
