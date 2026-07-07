/**
 * Pure PR-context access helpers.
 *
 * Gathered context is canonical snake_case, while cached adapter payloads may
 * retain forge-style camelCase names. Keep that boundary normalization here so
 * domain models do not each grow their own ad hoc alias lists.
 */

import {
  firstPresentRecordCollection,
  firstPresentRecordCollectionBy,
  recordShapeItem,
} from "./collection_access_model";
import {
  analyzeCiStatus,
  ciCheckName,
  ciCheckStatusLabel,
  enrichCiStatusWithStatusChecks,
  normalizeCiCheckDetailsUrl,
} from "./ci_status_model";
import { changedFilePath } from "./changed_file_model";
import {
  commentBody,
  commentEvidenceRef,
  commentLine,
  commentPath,
} from "./comment_access_model";
import { commitIdentifier, commitMessage } from "./commit_access_model";
import { recordConflictFiles } from "./conflict_file_access_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import { mergeConflictActivityStatus } from "./conflict_model";
import { diffAvailabilityStatus } from "./diff_availability_model";
import {
  firstNormalizedQueueBoolean,
  QUEUE_CONTEXT_KEYS,
  QUEUE_FLAG_KEYS,
  QUEUE_STRATEGY_KEYS,
  recognizedQueueStrategy,
  queueContextConstituentPrs,
  queueContextMergeCommits,
  queueContextQueueBlockers,
  queueContextStrategy,
  queueContextValidationEvidence,
} from "./queue_context_access_model";

function recordValue(v: unknown): Record<string, unknown> {
  return recordShapeItem(v) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function firstNonEmptyText(record: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const text = toStr(record[key]).trim();
    if (text.length > 0) return text;
  }
  return fallback;
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function hasRecordValue(value: unknown): boolean {
  return recordShapeItem(value) !== null;
}

function firstPresentRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = recordShapeItem(record[key]);
    if (value !== null) return value;
  }
  return {};
}

function firstPresentRecordBy(
  record: Record<string, unknown>,
  keys: string[],
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  let fallback: Record<string, unknown> | null = null;
  for (const key of keys) {
    const value = recordShapeItem(record[key]);
    if (value === null) continue;
    fallback ??= value;
    if (predicate(value)) return value;
  }
  return fallback ?? {};
}

export const PR_CONTEXT_URL_KEYS = ["url", "html_url", "htmlUrl", "web_url", "webUrl", "permalink"];
export const PR_CONTEXT_DIFF_TEXT_KEYS = [
  "diff",
  "diff_text",
  "diffText",
  "raw_diff",
  "rawDiff",
  "unified_diff",
  "unifiedDiff",
  "patch",
];
export const PR_CONTEXT_CI_STATUS_KEYS = ["ci_status", "ciStatus", "ci_summary", "ciSummary"];
export const PR_CONTEXT_STATUS_CHECK_KEYS = [
  "status_check_rollup",
  "statusCheckRollup",
  "status_checks",
  "statusChecks",
];
export const PR_CONTEXT_DIFF_AVAILABILITY_KEYS = ["diff_availability", "diffAvailability"];
export const PR_CONTEXT_CONFLICT_KEYS = ["conflicts", "merge_conflicts", "mergeConflicts"];
export const PR_CONTEXT_MERGE_BLOCKER_KEYS = ["merge_blockers", "mergeBlockers"];
export const PR_CONTEXT_COMMENT_KEYS = ["comments", "issue_comments", "issueComments"];
export const PR_CONTEXT_REVIEW_COMMENT_KEYS = ["review_comments", "reviewComments"];
export const PR_CONTEXT_COMMIT_KEYS = ["commits", "commitNodes", "commit_nodes", "commit_edges", "commitEdges"];
export const PR_CONTEXT_FILE_KEYS = [
  "files",
  "changed_files",
  "changedFiles",
  "fileNodes",
  "file_nodes",
  "fileEdges",
  "file_edges",
];

export function prContextUrl(value: unknown, fallback = ""): string {
  const context = recordValue(value);
  return firstNonEmptyText(
    context,
    PR_CONTEXT_URL_KEYS,
    fallback,
  );
}

export function prContextDiffText(value: unknown, fallback = ""): string {
  const context = recordValue(value);
  for (const key of PR_CONTEXT_DIFF_TEXT_KEYS) {
    const text = toStr(context[key]);
    if (text.trim().length > 0) return text;
  }
  return fallback;
}

export function prContextHasDiffTextField(value: unknown): boolean {
  const context = recordValue(value);
  return PR_CONTEXT_DIFF_TEXT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(context, key));
}

export function prContextCiStatus(value: unknown): Record<string, unknown> {
  const context = recordValue(value);
  const ciStatus = firstPresentRecord(context, PR_CONTEXT_CI_STATUS_KEYS);
  const statusChecks = firstPresentRecordCollectionBy(
    context,
    PR_CONTEXT_STATUS_CHECK_KEYS,
    (items) => items.some(hasMeaningfulStatusCheckValue),
  );
  if (Object.keys(ciStatus).length > 0) {
    return enrichCiStatusWithStatusChecks(ciStatus, statusChecks);
  }

  return statusChecks.length > 0 ? analyzeCiStatus(statusChecks) : {};
}

export function prContextDiffAvailability(value: unknown): Record<string, unknown> {
  const context = recordValue(value);
  return firstPresentRecordBy(
    context,
    PR_CONTEXT_DIFF_AVAILABILITY_KEYS,
    (record) => diffAvailabilityStatus(record) !== "unknown",
  );
}

export function prContextConflicts(value: unknown): Record<string, unknown> {
  const context = recordValue(value);
  return firstPresentRecordBy(
    context,
    PR_CONTEXT_CONFLICT_KEYS,
    (record) => mergeConflictActivityStatus(record) !== "unknown",
  );
}

export function prContextMergeBlockers(value: unknown): unknown[] {
  const context = recordValue(value);
  const explicitBlockers = firstPresentRecordCollectionBy(
    context,
    PR_CONTEXT_MERGE_BLOCKER_KEYS,
    (items) => items.some(hasMeaningfulRecordValue),
  );
  const genericBlockers = flatBlockersAreQueueScoped(context) ? [] : genericMergeBlockers(context);
  if (explicitBlockers.some(hasMeaningfulRecordValue)) return explicitBlockers;
  if (genericBlockers.some(hasMeaningfulRecordValue)) return genericBlockers;
  if (explicitBlockers.length > 0) return explicitBlockers;
  return genericBlockers;
}

export function prContextQueueContext(value: unknown): Record<string, unknown> {
  const context = recordValue(value);
  const nestedQueueContext = firstPresentRecordBy(
    context,
    QUEUE_CONTEXT_KEYS,
    hasQueueContextRecordSignal,
  );
  if (Object.keys(nestedQueueContext).length > 0) return nestedQueueContext;

  const isQueue = firstPresent(context, QUEUE_FLAG_KEYS);
  const normalizedIsQueue = firstNormalizedQueueBoolean(context);
  const strategy = firstPresent(context, QUEUE_STRATEGY_KEYS);
  const constituentPrs = queueContextConstituentPrs(context);
  const mergeCommits = queueContextMergeCommits(context);
  const validationEvidence = queueContextValidationEvidence(context);
  const queueBlockers = queueContextQueueBlockers(context);
  if (!hasFlatQueueContextSignal(context)) return {};

  const synthesized: Record<string, unknown> = {};
  if (isQueue !== undefined) synthesized["is_queue"] = normalizedIsQueue ?? isQueue;
  if (strategy !== undefined) synthesized["strategy"] = strategy;
  if (constituentPrs.length > 0) synthesized["constituent_prs"] = constituentPrs;
  if (mergeCommits.length > 0) synthesized["merge_commits"] = mergeCommits;
  if (validationEvidence.length > 0) synthesized["validation_evidence"] = validationEvidence;
  const genericBlockers = genericMergeBlockers(context);
  const scopedGenericBlockers = queueBlockers.length > 0 && !genericBlockers.some(hasMeaningfulRecordValue)
    ? []
    : genericBlockers;
  const unresolvedBlockers = [...queueBlockers, ...scopedGenericBlockers];
  if (unresolvedBlockers.length > 0) synthesized["unresolved_blockers"] = unresolvedBlockers;
  return synthesized;
}

function genericMergeBlockers(context: Record<string, unknown>): Record<string, unknown>[] {
  return firstPresentRecordCollection(context, ["blockers"]);
}

function hasFlatQueueContextSignal(context: Record<string, unknown>): boolean {
  return firstPresent(context, QUEUE_FLAG_KEYS) !== undefined || hasFlatQueueContextPayload(context);
}

function flatBlockersAreQueueScoped(context: Record<string, unknown>): boolean {
  return firstNormalizedQueueBoolean(context) === true || hasFlatQueueContextPayload(context);
}

function hasFlatQueueContextPayload(context: Record<string, unknown>): boolean {
  return recognizedQueueStrategy(queueContextStrategy(context)) ||
    queueContextConstituentPrs(context).length > 0 ||
    queueContextMergeCommits(context).length > 0 ||
    queueContextValidationEvidence(context).length > 0 ||
    queueContextQueueBlockers(context).length > 0;
}

function hasQueueContextRecordSignal(context: Record<string, unknown>): boolean {
  return firstNormalizedQueueBoolean(context) !== null || hasFlatQueueContextPayload(context);
}

function hasMeaningfulRecordValue(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => {
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null;
  });
}

function hasMeaningfulCommentValue(record: Record<string, unknown>): boolean {
  return commentBody(record).length > 0 ||
    commentEvidenceRef(record) !== null ||
    recordEvidenceRefs(record).length > 0 ||
    commentPath(record).length > 0 ||
    commentLine(record).length > 0;
}

function hasMeaningfulCommitValue(record: Record<string, unknown>): boolean {
  return commitMessage(record).length > 0 ||
    commitIdentifier(record).length > 0 ||
    recordConflictFiles(record).length > 0 ||
    recordConflictFiles(recordValue(record["commit"])).length > 0 ||
    recordEvidenceRefs(record).length > 0 ||
    recordEvidenceRefs(recordValue(record["commit"])).length > 0;
}

function hasMeaningfulFileValue(record: Record<string, unknown>): boolean {
  return changedFilePath(record).length > 0;
}

function hasMeaningfulStatusCheckValue(record: Record<string, unknown>): boolean {
  return ciCheckName(record, "").length > 0 ||
    ciCheckStatusLabel(record).length > 0 ||
    normalizeCiCheckDetailsUrl(record).length > 0;
}

export function prContextComments(value: unknown): unknown[] {
  const context = recordValue(value);
  return firstPresentRecordCollectionBy(
    context,
    PR_CONTEXT_COMMENT_KEYS,
    (items) => items.some(hasMeaningfulCommentValue),
  );
}

export function prContextReviewComments(value: unknown): unknown[] {
  const context = recordValue(value);
  return firstPresentRecordCollectionBy(
    context,
    PR_CONTEXT_REVIEW_COMMENT_KEYS,
    (items) => items.some(hasMeaningfulCommentValue),
  );
}

export function prContextCommits(value: unknown): unknown[] {
  const context = recordValue(value);
  return firstPresentRecordCollectionBy(
    context,
    PR_CONTEXT_COMMIT_KEYS,
    (items) => items.some(hasMeaningfulCommitValue),
  );
}

export function prContextFiles(value: unknown): unknown[] {
  const context = recordValue(value);
  return firstPresentRecordCollectionBy(
    context,
    PR_CONTEXT_FILE_KEYS,
    (items) => items.some(hasMeaningfulFileValue),
  );
}

export function evidenceSummaryFromContext(value: unknown): {
  ci_status?: unknown;
  diff_availability?: unknown;
  conflicts?: unknown;
  merge_blockers?: unknown;
  queue_context?: unknown;
} {
  const context = recordValue(value);
  const ciStatus = prContextCiStatus(context);
  const diffAvailability = prContextDiffAvailability(context);
  const conflicts = prContextConflicts(context);
  const mergeBlockers = prContextMergeBlockers(context);
  const queueContext = prContextQueueContext(context);
  return {
    ci_status: hasRecordValue(ciStatus) ? ciStatus : undefined,
    diff_availability: hasRecordValue(diffAvailability) ? diffAvailability : undefined,
    conflicts: hasRecordValue(conflicts) ? conflicts : undefined,
    merge_blockers: mergeBlockers.length > 0 ? mergeBlockers : undefined,
    queue_context: hasRecordValue(queueContext) ? queueContext : undefined,
  };
}
