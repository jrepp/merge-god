/**
 * Pure PR-details access helpers.
 *
 * Live GitHub context uses GraphQL-style camelCase fields, while cached and
 * forge-neutral records may use snake_case names. Merge policy should not
 * depend on which adapter produced the record.
 */

import {
  firstPresentRecordCollection,
  firstPresentRecordCollectionBy,
  recordShapeItem,
} from "./collection_access_model";
import { commitIdentifier, commitMessage } from "./commit_access_model";
import { recordConflictFiles } from "./conflict_file_access_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import {
  normalizeReviewDecision,
  reviewDecisionSignalStatus,
} from "./review_decision_model";

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function directRecordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function nestedRecordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const text = toStr(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(?:true|yes|y|1|draft|mergeable)$/.test(text)) return true;
  if (/^(?:false|no|n|0|not_draft|not_mergeable|unmergeable)$/.test(text)) return false;
  return null;
}

function firstNonEmptyText(record: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const text = toStr(record[key]).trim();
    if (text.length > 0) return text;
  }
  return fallback;
}

function firstNonEmptyTextBy(
  record: Record<string, unknown>,
  keys: string[],
  predicate: (text: string) => boolean,
  fallback = "",
): string {
  let fallbackText = "";
  for (const key of keys) {
    const text = toStr(record[key]).trim();
    if (text.length === 0) continue;
    if (fallbackText.length === 0) fallbackText = text;
    if (predicate(text)) return text;
  }
  return fallbackText || fallback;
}

function firstNormalizedBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const normalized = normalizedBoolean(record[key]);
    if (normalized !== null) return normalized;
  }
  return null;
}

function firstPositiveInteger(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = toPositiveInteger(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstNonNegativeInteger(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const parsed = toNonNegativeInteger(record[key]);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function firstPresentValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function hasMeaningfulCommitValue(record: Record<string, unknown>): boolean {
  return commitMessage(record).length > 0 ||
    commitIdentifier(record).length > 0 ||
    recordConflictFiles(record).length > 0 ||
    recordConflictFiles(directRecordValue(record["commit"])).length > 0 ||
    recordEvidenceRefs(record).length > 0 ||
    recordEvidenceRefs(directRecordValue(record["commit"])).length > 0;
}

export function prDetailsNumber(value: unknown): number | null {
  const details = directRecordValue(value);
  return firstPositiveInteger(details, [
    "number",
    "pr_number",
    "prNumber",
    "pull_number",
    "pullNumber",
    "merge_request_number",
    "mergeRequestNumber",
    "mr_number",
    "mrNumber",
    "merge_request_iid",
    "mergeRequestIid",
    "mr_iid",
    "mrIid",
    "iid",
  ]);
}

export function prDetailsHasMetadata(value: unknown): boolean {
  return recordShapeItem(value) !== null;
}

export function prDetailsTitle(value: unknown, fallback = ""): string {
  const details = directRecordValue(value);
  return firstNonEmptyText(details, ["title", "name", "subject", "summary"], fallback);
}

export function prDetailsBody(value: unknown, fallback = ""): string {
  const details = directRecordValue(value);
  return firstNonEmptyText(details, ["body", "body_text", "bodyText", "description"], fallback);
}

export function prDetailsStateText(value: unknown, fallback = ""): string {
  const details = directRecordValue(value);
  return firstNonEmptyText(details, ["state", "status", "merge_state", "mergeState"], fallback);
}

export function prDetailsCreatedAt(value: unknown): unknown {
  const details = directRecordValue(value);
  return firstPresentValue(details, ["createdAt", "created_at", "created", "createdDate"]);
}

export function prDetailsUpdatedAt(value: unknown): unknown {
  const details = directRecordValue(value);
  return firstPresentValue(details, ["updatedAt", "updated_at", "updated", "updatedDate", "lastUpdatedAt"]);
}

export function prDetailsMergedAt(value: unknown): unknown {
  const details = directRecordValue(value);
  return firstPresentValue(details, ["mergedAt", "merged_at", "merged", "mergedDate"]);
}

export function prDetailsAdditions(value: unknown): number {
  const details = directRecordValue(value);
  return firstNonNegativeInteger(details, [
    "additions",
    "additions_count",
    "additionsCount",
    "lines_added",
    "linesAdded",
    "added_lines",
    "addedLines",
  ]);
}

export function prDetailsDeletions(value: unknown): number {
  const details = directRecordValue(value);
  return firstNonNegativeInteger(details, [
    "deletions",
    "deletions_count",
    "deletionsCount",
    "lines_deleted",
    "linesDeleted",
    "removed_lines",
    "removedLines",
  ]);
}

export function prDetailsChangedFiles(value: unknown): number {
  const details = directRecordValue(value);
  return firstNonNegativeInteger(details, [
    "changedFiles",
    "changed_files",
    "changedFilesCount",
    "changed_files_count",
    "files_changed",
    "filesChanged",
    "file_count",
    "fileCount",
  ]);
}

export function prDetailsCommits(value: unknown): unknown[] {
  const details = directRecordValue(value);
  return firstPresentRecordCollectionBy(
    details,
    ["commits", "commitNodes", "commit_nodes", "commitEdges", "commit_edges"],
    (items) => items.some(hasMeaningfulCommitValue),
  );
}

export function prDetailsCommitCount(value: unknown): number {
  const details = directRecordValue(value);
  const commitItems = prDetailsCommits(details);
  if (commitItems.length > 0) return commitItems.length;
  const commits = asRecord(details["commits"]);
  return firstNonNegativeInteger(commits, ["totalCount", "total_count", "count"]);
}

export function prDetailsLabels(value: unknown): string[] {
  const details = directRecordValue(value);
  for (const key of ["labels", "labelNames", "label_names"]) {
    const raw = details[key];
    const stringLabels = Array.isArray(raw)
      ? raw.map((item) => toStr(item).trim()).filter((item) => item.length > 0)
      : [];
    if (stringLabels.length > 0) return [...new Set(stringLabels)];

    const recordLabels = firstPresentRecordCollection(details, [key])
      .map((label) => firstNonEmptyText(label, ["name", "label", "title"]))
      .filter((item) => item.length > 0);
    if (recordLabels.length > 0) return [...new Set(recordLabels)];
  }
  return [];
}

export function prDetailsBaseBranch(value: unknown, fallback = "main"): string {
  const details = directRecordValue(value);
  return firstNonEmptyText(
    details,
    ["baseRefName", "base_ref_name", "baseBranch", "base_branch", "targetBranch", "target_branch"],
    fallback,
  );
}

export function prDetailsHeadBranch(value: unknown, fallback = ""): string {
  const details = directRecordValue(value);
  return firstNonEmptyText(
    details,
    ["headRefName", "head_ref_name", "headBranch", "head_branch", "sourceBranch", "source_branch"],
    fallback,
  );
}

export function prDetailsUrl(value: unknown, fallback = ""): string {
  const details = directRecordValue(value);
  return firstNonEmptyText(
    details,
    ["url", "html_url", "htmlUrl", "web_url", "webUrl", "permalink"],
    fallback,
  );
}

export function prDetailsAuthorLogin(value: unknown, fallback = "unknown"): string {
  const details = directRecordValue(value);
  const direct = firstNonEmptyText(
    details,
    ["author_login", "authorLogin", "user_login", "userLogin", "created_by", "createdBy"],
  );
  if (direct.length > 0) return direct;

  for (const key of ["author", "user", "creator"]) {
    const nested = nestedRecordValue(details[key]);
    const login = firstNonEmptyText(nested, ["login", "username", "name"]);
    if (login.length > 0) return login;
  }
  return fallback;
}

export function prDetailsHeadSha(value: unknown, fallback = ""): string {
  const details = directRecordValue(value);
  const direct = firstNonEmptyText(details, [
    "current_sha",
    "currentSha",
    "head_sha",
    "headSha",
    "head_oid",
    "headOid",
  ]);
  if (direct.length > 0) return direct;

  for (const key of ["head", "head_commit", "headCommit"]) {
    const nested = nestedRecordValue(details[key]);
    const sha = firstNonEmptyText(nested, ["sha", "oid", "id"]);
    if (sha.length > 0) return sha;
  }
  return fallback;
}

export function prDetailsReviewDecision(value: unknown, fallback = ""): unknown {
  const details = directRecordValue(value);
  return firstNonEmptyTextBy(
    details,
    ["reviewDecision", "review_decision"],
    (text) => reviewDecisionSignalStatus(normalizeReviewDecision(text)) === "decisive",
    fallback,
  );
}

export function prDetailsMergeStateStatus(value: unknown): unknown {
  const details = directRecordValue(value);
  return firstNonEmptyText(details, ["mergeStateStatus", "merge_state_status"]);
}

export function prDetailsMergeable(value: unknown): boolean | null {
  const details = directRecordValue(value);
  return firstNormalizedBoolean(details, ["mergeable", "is_mergeable", "isMergeable"]);
}

export function prDetailsIsDraft(value: unknown): boolean {
  const details = directRecordValue(value);
  const normalizedDraft = firstNormalizedBoolean(details, ["isDraft", "is_draft", "draft"]);
  if (normalizedDraft !== null) return normalizedDraft;
  return prDetailsStateText(details).trim().toLowerCase() === "draft";
}
