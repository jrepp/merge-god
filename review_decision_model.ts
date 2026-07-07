/**
 * Pure GitHub review-decision normalization.
 *
 * Review decisions affect both modeled merge blockers and review-gate rows. The
 * status and explanation rules live here so those projections cannot drift.
 */

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

export type ReviewDecisionGateStatus = "pass" | "blocked" | "unknown" | "pending";
export type ReviewDecisionSignalStatus = "decisive" | "unknown" | "unrecognized";

export interface ReviewDecisionMergeBlocker {
  kind: "review_required" | "changes_requested" | "unknown";
  status: "blocked" | "unknown";
  summary: string;
  evidence_refs: string[];
}

export function normalizeReviewDecision(value: unknown, fallback = ""): string {
  const text = toStr(value, fallback).trim();
  return text.length > 0 ? text.toUpperCase().replace(/[\s-]+/g, "_") : fallback;
}

export function reviewDecisionGateStatus(reviewDecision: string): ReviewDecisionGateStatus {
  if (reviewDecision === "APPROVED") return "pass";
  if (reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED") return "blocked";
  if (reviewDecision === "UNKNOWN" || reviewDecision === "") return "unknown";
  return "pending";
}

export function reviewDecisionSignalStatus(reviewDecision: string): ReviewDecisionSignalStatus {
  const status = reviewDecisionGateStatus(reviewDecision);
  if (status === "pass" || status === "blocked") return "decisive";
  if (status === "unknown") return "unknown";
  return "unrecognized";
}

export function reviewDecisionSummary(reviewDecision: string): string {
  if (reviewDecision === "APPROVED") return "GitHub review decision is approved.";
  if (reviewDecision === "CHANGES_REQUESTED") return "GitHub review decision has requested changes.";
  if (reviewDecision === "REVIEW_REQUIRED") return "GitHub requires review before this PR can merge.";
  return `GitHub review decision is ${reviewDecision || "unknown"}.`;
}

export function reviewDecisionMergeBlocker(reviewDecision: string): ReviewDecisionMergeBlocker | null {
  if (reviewDecision === "REVIEW_REQUIRED") {
    return {
      kind: "review_required",
      status: "blocked",
      summary: reviewDecisionSummary(reviewDecision),
      evidence_refs: ["github:reviewDecision"],
    };
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return {
      kind: "changes_requested",
      status: "blocked",
      summary: reviewDecisionSummary(reviewDecision),
      evidence_refs: ["github:reviewDecision"],
    };
  }
  if (reviewDecision && reviewDecision !== "APPROVED") {
    return {
      kind: "unknown",
      status: "unknown",
      summary: reviewDecisionSummary(reviewDecision),
      evidence_refs: ["github:reviewDecision"],
    };
  }
  return null;
}
