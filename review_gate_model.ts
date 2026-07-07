/**
 * Pure review-gate status types and normalization.
 */

import { recordShapeItem } from "./collection_access_model";

export type ReviewGateStatusValue = "pass" | "fail" | "blocked" | "skipped" | "pending" | "unknown";

export interface ReviewGateStatus {
  rule: string;
  status: ReviewGateStatusValue | string;
  explanation: string;
}

const REVIEW_GATE_ALLOWED_STATUSES = new Set<ReviewGateStatusValue>([
  "pass",
  "fail",
  "blocked",
  "skipped",
  "pending",
  "unknown",
]);

export function normalizeReviewGateStatus(status: unknown): ReviewGateStatusValue {
  const raw = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (raw === "passed" || raw === "success" || raw === "ok") return "pass";
  if (raw === "failed" || raw === "failure" || raw === "error") return "fail";
  if (REVIEW_GATE_ALLOWED_STATUSES.has(raw as ReviewGateStatusValue)) {
    return raw as ReviewGateStatusValue;
  }
  return "unknown";
}

function recordValue(v: unknown): Record<string, unknown> {
  return recordShapeItem(v) ?? {};
}

function nonEmptyText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : fallback;
}

export function normalizeReviewGateStatusRow(gateRaw: unknown): ReviewGateStatus {
  const gate = recordValue(gateRaw);
  return {
    rule: nonEmptyText(gate["rule"], "review-gates"),
    status: normalizeReviewGateStatus(gate["status"]),
    explanation: nonEmptyText(gate["explanation"], "No gate explanation was provided."),
  };
}
