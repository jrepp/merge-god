/**
 * Pure CI status normalization.
 *
 * Converts mixed forge status/check rollup entries into the normalized shape
 * merge-god uses for blockers, gate projection, and evidence comments.
 */

import { recordCollectionItems, recordShapeItem } from "./collection_access_model";

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toNonNegativeInt(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : dflt;
}

function nonEmptyText(value: unknown, fallback: string): string {
  const text = toStr(value).trim();
  return text.length > 0 ? text : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function checkItems(value: unknown): unknown[] {
  const collectionRecords = recordCollectionItems(value);
  if (collectionRecords.length > 0) return collectionRecords;
  if (!Array.isArray(value)) return [];

  return asArray(value).flatMap((item) => {
    const record = recordShapeItem(item);
    if (record !== null) return [record];
    if (typeof item === "object" && item !== null) return [];
    return item === undefined || item === null ? [] : [item];
  });
}

function maxNonNegativeInt(record: Record<string, unknown>, keys: string[]): number {
  let max = 0;
  for (const key of keys) {
    max = Math.max(max, toNonNegativeInt(record[key]));
  }
  return max;
}

export function normalizeCiCheckDetailsUrl(check: Record<string, unknown>): string {
  const record = recordValue(check);
  return nonEmptyText(record["details_url"], "") ||
    nonEmptyText(record["detailsUrl"], "") ||
    nonEmptyText(record["target_url"], "") ||
    nonEmptyText(record["targetUrl"], "") ||
    nonEmptyText(record["html_url"], "") ||
    nonEmptyText(record["url"], "");
}

function isFailedConclusion(value: string): boolean {
  return value === "FAILURE" ||
    value === "TIMED_OUT" ||
    value === "STARTUP_FAILURE" ||
    value === "CANCELLED" ||
    value === "STALE" ||
    value === "ACTION_REQUIRED";
}

function isPendingState(value: string): boolean {
  return value === "PENDING" ||
    value === "EXPECTED" ||
    value === "IN_PROGRESS" ||
    value === "QUEUED" ||
    value === "WAITING" ||
    value === "REQUESTED" ||
    value === "ACTION_REQUIRED";
}

export interface NormalizedCiStatusCounts {
  failed: number;
  pending: number;
  unknown: number;
  passed: number;
  skipped: number;
  total: number;
}

export type NormalizedCiStatusState = "failed" | "pending" | "unknown" | "passed" | "missing";

export const CI_STATUS_ROLLUP_REF = "github:statusCheckRollup";

export function ciCheckName(value: unknown, fallback = "unknown"): string {
  const check = recordValue(value);
  return nonEmptyText(check["name"], fallback);
}

export function ciCheckStatusLabel(value: unknown, fallback = ""): string {
  const check = recordValue(value);
  return nonEmptyText(check["conclusion"], "") ||
    nonEmptyText(check["status"], "") ||
    nonEmptyText(check["state"], "") ||
    fallback;
}

export function ciFailedChecks(ciStatus: Record<string, unknown>): unknown[] {
  return [
    ...checkItems(ciStatus["failed_checks"]),
    ...checkItems(ciStatus["failedChecks"]),
  ];
}

export function ciPendingChecks(ciStatus: Record<string, unknown>): unknown[] {
  return [
    ...checkItems(ciStatus["pending_checks"]),
    ...checkItems(ciStatus["pendingChecks"]),
  ];
}

export function ciUnknownChecks(ciStatus: Record<string, unknown>): unknown[] {
  return [
    ...checkItems(ciStatus["unknown_checks"]),
    ...checkItems(ciStatus["unknownChecks"]),
  ];
}

export function normalizeCiStatusCounts(ciStatus: Record<string, unknown>): NormalizedCiStatusCounts {
  const failed = Math.max(maxNonNegativeInt(ciStatus, ["failed", "failed_count", "failedCount"]), ciFailedChecks(ciStatus).length);
  const pending = Math.max(maxNonNegativeInt(ciStatus, ["pending", "pending_count", "pendingCount"]), ciPendingChecks(ciStatus).length);
  const unknown = Math.max(maxNonNegativeInt(ciStatus, ["unknown", "unknown_count", "unknownCount"]), ciUnknownChecks(ciStatus).length);
  const passed = maxNonNegativeInt(ciStatus, ["passed", "passed_count", "passedCount"]);
  const skipped = maxNonNegativeInt(ciStatus, ["skipped", "skipped_count", "skippedCount"]);
  const total = Math.max(
    maxNonNegativeInt(ciStatus, ["total_checks", "totalChecks", "total_count", "totalCount"]),
    failed + pending + unknown + passed + skipped,
  );
  return { failed, pending, unknown, passed, skipped, total };
}

export function ciCheckEvidenceRefs(checks: unknown[], expectedCount: number): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const checkRaw of checks) {
    const ref = normalizeCiCheckDetailsUrl(recordValue(checkRaw)).trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }

  if (expectedCount > 0 && refs.length < expectedCount && !seen.has(CI_STATUS_ROLLUP_REF)) {
    refs.push(CI_STATUS_ROLLUP_REF);
  }
  return refs;
}

function ciCheckDetailIdentity(value: unknown): string {
  const check = recordValue(value);
  return [
    normalizeCiCheckDetailsUrl(check),
    ciCheckName(check, ""),
    ciCheckStatusLabel(check),
  ].join("\u0000");
}

function uniqueCiCheckDetails(items: unknown[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const item of items) {
    const record = recordValue(item);
    const identity = ciCheckDetailIdentity(record);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(record);
  }
  return unique;
}

function mergeCiCheckDetails(
  existing: unknown[],
  analyzed: unknown[],
  expectedCount: number,
): Record<string, unknown>[] {
  if (expectedCount <= 0) return uniqueCiCheckDetails(existing);
  const eligibleAnalyzed = analyzed.length <= expectedCount ? analyzed : [];
  return uniqueCiCheckDetails([...existing, ...eligibleAnalyzed]);
}

export function enrichCiStatusWithStatusChecks(
  ciStatus: Record<string, unknown>,
  statusChecks: Record<string, unknown>[],
): Record<string, unknown> {
  if (statusChecks.length === 0) return ciStatus;
  const analyzed = analyzeCiStatus(statusChecks);
  const counts = normalizeCiStatusCounts(ciStatus);
  if (counts.total === 0) return analyzed;

  const rest = { ...ciStatus };
  delete rest["failed_checks"];
  delete rest["failedChecks"];
  delete rest["pending_checks"];
  delete rest["pendingChecks"];
  delete rest["unknown_checks"];
  delete rest["unknownChecks"];

  return {
    ...rest,
    failed_checks: mergeCiCheckDetails(
      ciFailedChecks(ciStatus),
      ciFailedChecks(analyzed),
      counts.failed,
    ),
    pending_checks: mergeCiCheckDetails(
      ciPendingChecks(ciStatus),
      ciPendingChecks(analyzed),
      counts.pending,
    ),
    unknown_checks: mergeCiCheckDetails(
      ciUnknownChecks(ciStatus),
      ciUnknownChecks(analyzed),
      counts.unknown,
    ),
  };
}

export function ciStatusState(counts: NormalizedCiStatusCounts): NormalizedCiStatusState {
  if (counts.failed > 0) return "failed";
  if (counts.pending > 0) return "pending";
  if (counts.unknown > 0) return "unknown";
  if (counts.total > 0) return "passed";
  return "missing";
}

export function ciStatusReviewGateStatus(counts: NormalizedCiStatusCounts): "fail" | "pending" | "unknown" | "pass" {
  const state = ciStatusState(counts);
  if (state === "failed") return "fail";
  if (state === "pending") return "pending";
  if (state === "unknown" || state === "missing") return "unknown";
  return "pass";
}

export function ciStatusEvidenceStatus(counts: NormalizedCiStatusCounts): "blocked" | "pending" | "unknown" | "pass" {
  const state = ciStatusState(counts);
  if (state === "failed") return "blocked";
  if (state === "pending") return "pending";
  if (state === "unknown" || state === "missing") return "unknown";
  return "pass";
}

export function ciStatusCountsSentence(
  counts: NormalizedCiStatusCounts,
  options: { includeSkipped?: boolean } = {},
): string {
  const skipped = options.includeSkipped ? `, ${counts.skipped} skipped` : "";
  return `${counts.failed} failed, ${counts.pending} pending, ${counts.unknown} unknown, ` +
    `${counts.passed} passed${skipped} out of ${counts.total} check(s).`;
}

export function ciStatusReviewGateExplanation(counts: NormalizedCiStatusCounts): string {
  return counts.total > 0
    ? ciStatusCountsSentence(counts)
    : "No CI status checks were reported.";
}

export interface CiStatusCheckGroups {
  failed: unknown[];
  pending: unknown[];
  unknown: unknown[];
}

export const CI_STATUS_CHECK_SUMMARY_LIMIT = 8;

export function ciStatusCheckSummary(items: unknown[], limit = CI_STATUS_CHECK_SUMMARY_LIMIT): string {
  const rendered = items.slice(0, limit).map((item) => {
    const name = ciCheckName(item);
    const conclusion = ciCheckStatusLabel(item);
    const check = recordValue(item);
    const detailsUrl = normalizeCiCheckDetailsUrl(check);
    const suffixes = [conclusion, detailsUrl].filter((value) => value.length > 0);
    return suffixes.length > 0 ? `${name} (${suffixes.join(", ")})` : name;
  });
  if (items.length > limit) rendered.push(`${items.length - limit} more`);
  return rendered.join("; ") || "none";
}

export function ciStatusEvidenceDetails(
  counts: NormalizedCiStatusCounts,
  checks: CiStatusCheckGroups,
): string {
  const parts = [
    ciStatusCountsSentence(counts, { includeSkipped: true }),
  ];
  if (checks.failed.length > 0) parts.push(`Failed: ${ciStatusCheckSummary(checks.failed)}`);
  if (checks.pending.length > 0) parts.push(`Pending: ${ciStatusCheckSummary(checks.pending)}`);
  if (checks.unknown.length > 0) parts.push(`Unknown: ${ciStatusCheckSummary(checks.unknown)}`);
  return parts.join(" ");
}

/** Analyze CI/CD status from a statusCheckRollup list. */
export function analyzeCiStatus(statusChecks: Record<string, unknown>[] | null): Record<string, unknown> {
  if (!statusChecks || statusChecks.length === 0) {
    return {
      total_checks: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      failed_checks: [],
      pending_checks: [],
      unknown_checks: [],
    };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;
  let unknown = 0;
  const failedChecks: Record<string, unknown>[] = [];
  const pendingChecks: Record<string, unknown>[] = [];
  const unknownChecks: Record<string, unknown>[] = [];

  for (const check of statusChecks) {
    const normalizedCheck = recordValue(check);
    const state = toStr(normalizedCheck["state"]).trim().toUpperCase();
    const status = toStr(normalizedCheck["status"]).trim().toUpperCase();
    const conclusion = toStr(normalizedCheck["conclusion"]).trim().toUpperCase();
    const detailsUrl = normalizeCiCheckDetailsUrl(normalizedCheck);

    if (isFailedConclusion(conclusion) || state === "FAILURE" || state === "ERROR" || state === "FAILED") {
      failed++;
      failedChecks.push({
        name: nonEmptyText(normalizedCheck["name"], "unknown"),
        conclusion: isFailedConclusion(conclusion) ? conclusion : state,
        details_url: detailsUrl,
      });
    } else if (isPendingState(state) || isPendingState(status)) {
      pending++;
      pendingChecks.push({
        name: nonEmptyText(normalizedCheck["name"], "unknown"),
        status: status || state,
        details_url: detailsUrl,
      });
    } else if (conclusion === "SUCCESS" || state === "SUCCESS") {
      passed++;
    } else if (conclusion === "SKIPPED" || conclusion === "NEUTRAL" || state === "SKIPPED") {
      skipped++;
    } else {
      unknown++;
      unknownChecks.push({
        name: nonEmptyText(normalizedCheck["name"], "unknown"),
        state,
        status,
        conclusion,
        details_url: detailsUrl,
      });
    }
  }

  return {
    total_checks: statusChecks.length,
    passed,
    failed,
    pending,
    skipped,
    unknown,
    failed_checks: failedChecks,
    pending_checks: pendingChecks,
    unknown_checks: unknownChecks,
  };
}
