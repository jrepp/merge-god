/**
 * Pure diff-availability normalization.
 *
 * The gatherer records whether the full PR diff was captured. Downstream
 * blocker modeling and evidence comments share the status/detail rules here.
 */

import { recordEvidenceRefs } from "./evidence_ref_access_model";
import { recordShapeItem } from "./collection_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function firstNonEmptyText(fallback: string, ...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return fallback;
}

function normalizedAvailability(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const text = toStr(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(?:true|yes|available|captured|present|ok|success)$/.test(text)) return true;
  if (/^(?:false|no|unavailable|missing|failed|error|timed_out|timeout|too_large)$/.test(text)) return false;
  return null;
}

function availabilityValue(diffAvailability: Record<string, unknown>): boolean | null {
  const record = recordValue(diffAvailability);
  for (const value of [
    record["available"],
    record["is_available"],
    record["isAvailable"],
    record["diff_available"],
    record["diffAvailable"],
    record["captured"],
    record["has_diff"],
    record["hasDiff"],
  ]) {
    const normalized = normalizedAvailability(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

export function diffAvailabilitySourceLabel(diffAvailability: Record<string, unknown>): string {
  const record = recordValue(diffAvailability);
  return firstNonEmptyText(
    "unknown",
    record["source"],
    record["provider"],
    record["origin"],
    record["method"],
  );
}

function toNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sizeValue(diffAvailability: Record<string, unknown>): number | null {
  const record = recordValue(diffAvailability);
  const values = [
    record["size"],
    record["byte_size"],
    record["byteSize"],
    record["bytes"],
    record["diff_size"],
    record["diffSize"],
  ].map((value) => toNonNegativeFiniteNumber(value)).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

export function diffUnavailableReason(diffAvailability: Record<string, unknown>, fallback: string): string {
  const record = recordValue(diffAvailability);
  return firstNonEmptyText(
    fallback,
    record["error"],
    record["error_message"],
    record["errorMessage"],
    record["message"],
    record["reason"],
    record["details"],
    record["detail"],
  );
}

export type DiffAvailabilityStatus = "pass" | "blocked" | "unknown";
export const DIFF_UNAVAILABLE_FALLBACK_REF = "gh:pr-diff";

export interface DiffAvailabilityMergeBlocker {
  kind: "diff_unavailable";
  status: "blocked";
  summary: string;
  evidence_refs: string[];
}

export function diffAvailabilityStatus(diffAvailability: Record<string, unknown>): DiffAvailabilityStatus {
  const availability = availabilityValue(diffAvailability);
  if (availability === true) return "pass";
  if (availability === false) return "blocked";
  return "unknown";
}

export function diffAvailabilityEvidenceDetail(diffAvailability: Record<string, unknown>): string {
  const availability = availabilityValue(diffAvailability);
  if (availability === true) {
    const source = diffAvailabilitySourceLabel(diffAvailability);
    const size = sizeValue(diffAvailability);
    return size !== null
      ? `Captured from ${source} (${size} bytes).`
      : `Captured from ${source} (size unavailable).`;
  }

  if (availability === false) {
    return diffUnavailableReason(diffAvailability, "Diff unavailable.");
  }

  return "Diff availability is unknown.";
}

export function diffUnavailableBlockerSummary(diffAvailability: Record<string, unknown>): string {
  return diffUnavailableReason(diffAvailability, "PR diff was unavailable during context gathering.");
}

export function diffAvailabilityEvidenceRefs(diffAvailability: Record<string, unknown>): string[] {
  const record = recordValue(diffAvailability);
  const refs = recordEvidenceRefs(record);
  if (refs.length > 0) return refs;

  return diffAvailabilityStatus(record) === "blocked"
    ? [DIFF_UNAVAILABLE_FALLBACK_REF]
    : [];
}

export function diffAvailabilityMergeBlocker(
  diffAvailability: Record<string, unknown>,
): DiffAvailabilityMergeBlocker | null {
  if (diffAvailabilityStatus(diffAvailability) !== "blocked") return null;
  return {
    kind: "diff_unavailable",
    status: "blocked",
    summary: diffUnavailableBlockerSummary(diffAvailability),
    evidence_refs: diffAvailabilityEvidenceRefs(diffAvailability),
  };
}
