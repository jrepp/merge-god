/**
 * Pure PR queue display projection.
 *
 * The processing loop and dashboard exchange small PR queue summaries. This
 * module keeps alias handling and CI display defaults out of those side-effect
 * heavy entrypoints.
 */

import { recordCollectionItems, recordShapeItem } from "./collection_access_model";
import { CIStatus, getPRCiStatus, type PullRequest } from "./models";
import {
  prDetailsBaseBranch,
  prDetailsHeadBranch,
  prDetailsNumber,
  prDetailsTitle,
} from "./pr_details_access_model";

export interface PrQueueDisplayInfo {
  number: number;
  title: string;
  head_branch: string;
  base_branch: string;
  ci_status: string;
  ci_failing: boolean;
}

export interface PrQueueDisplayOptions {
  titleMaxLength?: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedToken(value: unknown): string {
  return toStr(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
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

function truncateTitle(title: string, options: PrQueueDisplayOptions): string {
  const max = options.titleMaxLength;
  return typeof max === "number" && Number.isInteger(max) && max >= 0 ? title.slice(0, max) : title;
}

function statusFromToken(value: unknown): string {
  const token = normalizedToken(value);
  if (["failure", "failed", "error", "timed_out", "cancelled", "action_required"].includes(token)) {
    return CIStatus.FAILURE;
  }
  if (["pending", "queued", "in_progress", "waiting", "requested", "expected"].includes(token)) {
    return CIStatus.PENDING;
  }
  if (["success", "successful", "passed", "pass", "green"].includes(token)) {
    return CIStatus.SUCCESS;
  }
  if (["none", "missing", "unknown", "neutral", "skipped", ""].includes(token)) {
    return CIStatus.NONE;
  }
  return token;
}

function ciSummaryStatus(summary: Record<string, unknown>): string {
  const failure = toNonNegativeInteger(summary["failure"] ?? summary["failed"]);
  const pending = toNonNegativeInteger(summary["pending"]);
  const success = toNonNegativeInteger(summary["success"] ?? summary["passed"]);
  const total = Math.max(
    toNonNegativeInteger(summary["total"]),
    failure + pending + success + toNonNegativeInteger(summary["none"] ?? summary["unknown"]),
  );
  if (failure > 0) return CIStatus.FAILURE;
  if (pending > 0) return CIStatus.PENDING;
  if (success > 0 || total > 0) return CIStatus.SUCCESS;
  return CIStatus.NONE;
}

function ciChecksStatus(checks: unknown[]): string {
  const statuses = checks.map((checkRaw) => {
    const check = recordValue(checkRaw);
    return statusFromToken(firstNonEmptyText(check, ["status", "state", "conclusion"]));
  });
  if (statuses.includes(CIStatus.FAILURE)) return CIStatus.FAILURE;
  if (statuses.includes(CIStatus.PENDING)) return CIStatus.PENDING;
  if (statuses.length > 0 && statuses.every((status) => status === CIStatus.SUCCESS)) return CIStatus.SUCCESS;
  return CIStatus.NONE;
}

function ciStatusFromRecord(record: Record<string, unknown>): string {
  const direct = firstNonEmptyText(record, ["ci_status", "ciStatus", "status", "conclusion"]);
  if (direct) return statusFromToken(direct);

  const ciStatus = recordValue(firstPresent(record, ["ci_status", "ciStatus"]));
  if (Object.keys(ciStatus).length > 0) return ciSummaryStatus(ciStatus);

  const ciSummary = recordValue(firstPresent(record, ["ci_summary", "ciSummary"]));
  if (Object.keys(ciSummary).length > 0) return ciSummaryStatus(ciSummary);

  const ciChecks = recordCollectionItems(firstPresent(record, ["ci_checks", "ciChecks", "statusCheckRollup"]));
  if (ciChecks.length > 0) return ciChecksStatus(ciChecks);

  return CIStatus.NONE;
}

function ciFailingFromRecord(record: Record<string, unknown>, ciStatus: string): boolean {
  const direct = firstPresent(record, ["ci_failing", "ciFailing"]);
  if (typeof direct === "boolean") return direct;
  return statusFromToken(ciStatus) === CIStatus.FAILURE;
}

export function prQueueInfoFromRecord(value: unknown, options: PrQueueDisplayOptions = {}): PrQueueDisplayInfo {
  const record = recordValue(value);
  const ciStatus = ciStatusFromRecord(record);
  return {
    number: prDetailsNumber(record) ?? 0,
    title: truncateTitle(prDetailsTitle(record), options),
    head_branch: prDetailsHeadBranch(record),
    base_branch: prDetailsBaseBranch(record, ""),
    ci_status: ciStatus,
    ci_failing: ciFailingFromRecord(record, ciStatus),
  };
}

export function prQueueInfoFromPullRequest(pr: PullRequest, options: PrQueueDisplayOptions = {}): PrQueueDisplayInfo {
  const ciStatus = getPRCiStatus(pr);
  return {
    number: pr.number,
    title: truncateTitle(pr.title, options),
    head_branch: pr.head_branch,
    base_branch: pr.base_branch,
    ci_status: ciStatus,
    ci_failing: ciStatus === CIStatus.FAILURE,
  };
}
