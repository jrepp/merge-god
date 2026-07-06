/**
 * Pure PR merge-blocker synthesis.
 *
 * This module projects gathered PR details and context into durable merge
 * blockers. It is intentionally separate from queue inference so gate
 * projection, prompts, and persistence can share the same blocker semantics
 * without importing the larger merge-PR model.
 */

import type { MergeBlocker } from "@merge-god/github-sync";

import {
  CI_STATUS_ROLLUP_REF,
  ciCheckEvidenceRefs,
  ciFailedChecks,
  ciPendingChecks,
  ciStatusState,
  ciUnknownChecks,
  normalizeCiStatusCounts,
} from "./ci_status_model";
import { recordShapeItem } from "./collection_access_model";
import { hasActiveMergeConflicts, mergeConflictSummary, normalizeMergeConflictEvidence } from "./conflict_model";
import { diffAvailabilityMergeBlocker } from "./diff_availability_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import { extractLabelMergeGateBlockers } from "./label_gate_model";
import { extractManualMergeGateBlockers } from "./manual_gate_model";
import {
  dedupeMergeBlockers,
  mergeBlockerKindLabel,
  mergeBlockerSummaryLabel,
} from "./merge_blocker_model";
import { mergeStateBlockerFromDetails } from "./merge_state_model";
import {
  normalizeReviewDecision,
  reviewDecisionMergeBlocker,
} from "./review_decision_model";
import {
  prContextCiStatus,
  prContextComments,
  prContextConflicts,
  prContextDiffAvailability,
  prContextMergeBlockers,
  prContextReviewComments,
} from "./pr_context_access_model";
import {
  prDetailsIsDraft,
  prDetailsLabels,
  prDetailsReviewDecision,
} from "./pr_details_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

export function analyzePrMergeBlockers(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): MergeBlocker[] {
  const blockers: MergeBlocker[] = [];
  const reviewDecision = normalizeReviewDecision(prDetailsReviewDecision(prDetails));
  const conflicts = prContextConflicts(prContext);
  const ciStatus = prContextCiStatus(prContext);
  const diffAvailability = prContextDiffAvailability(prContext);
  const comments = prContextComments(prContext);
  const reviewComments = prContextReviewComments(prContext);
  const labels = prDetailsLabels(prDetails);

  if (prDetailsIsDraft(prDetails)) {
    blockers.push({
      kind: "draft",
      status: "blocked",
      summary: "GitHub reports this PR is still marked as draft.",
      evidence_refs: ["github:isDraft"],
    });
  }

  const reviewBlocker = reviewDecisionMergeBlocker(reviewDecision);
  if (reviewBlocker) blockers.push(reviewBlocker);

  const mergeState = mergeStateBlockerFromDetails(prDetails);
  if (mergeState) blockers.push(mergeState);

  blockers.push(...extractLabelMergeGateBlockers(labels));
  blockers.push(...extractManualMergeGateBlockers([...comments, ...reviewComments]));

  if (hasActiveMergeConflicts(conflicts)) {
    blockers.push({
      kind: "merge_conflicts",
      status: "blocked",
      summary: mergeConflictSummary(conflicts),
      evidence_refs: normalizeMergeConflictEvidence(conflicts).evidence_refs,
    });
  }

  const ciCounts = normalizeCiStatusCounts(ciStatus);
  const ciState = ciStatusState(ciCounts);

  if (ciState === "failed") {
    blockers.push({
      kind: "ci_failed",
      status: "blocked",
      summary: `${ciCounts.failed} CI check(s) failed.`,
      evidence_refs: ciCheckEvidenceRefs(ciFailedChecks(ciStatus), ciCounts.failed),
    });
  } else if (ciState === "pending") {
    blockers.push({
      kind: "ci_pending",
      status: "pending",
      summary: `${ciCounts.pending} CI check(s) are pending.`,
      evidence_refs: ciCheckEvidenceRefs(ciPendingChecks(ciStatus), ciCounts.pending),
    });
  } else if (ciState === "unknown") {
    blockers.push({
      kind: "unknown",
      status: "unknown",
      summary: `${ciCounts.unknown} CI check(s) could not be classified.`,
      evidence_refs: ciCheckEvidenceRefs(ciUnknownChecks(ciStatus), ciCounts.unknown),
    });
  } else if (ciState === "missing") {
    blockers.push({
      kind: "ci_missing",
      status: "unknown",
      summary: "No status checks were reported for this PR.",
      evidence_refs: [CI_STATUS_ROLLUP_REF],
    });
  }

  const diffBlocker = diffAvailabilityMergeBlocker(diffAvailability);
  if (diffBlocker) blockers.push(diffBlocker);

  return blockers;
}

function hasEvidenceRef(blocker: unknown, ref: string): boolean {
  return recordEvidenceRefs(recordValue(blocker)).some((value) => value === ref);
}

function normalizedDedicatedKind(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isUnknownCiSummary(summary: string): boolean {
  const normalized = summary.toLowerCase().replace(/\(s\)/g, "s");
  return /\b(?:ci|status)\s+checks?\s+could not be\s+(?:classified|normalized)\b/.test(normalized);
}

export function isDedicatedReviewGateBlocker(blocker: unknown): boolean {
  const kind = normalizedDedicatedKind(mergeBlockerKindLabel(blocker));
  const summary = mergeBlockerSummaryLabel(blocker);
  if (
    kind === "merge_conflicts" ||
    kind === "ci_failed" ||
    kind === "ci_pending" ||
    kind === "ci_missing" ||
    kind === "ci_unknown" ||
    kind === "review_required" ||
    kind === "changes_requested"
  ) {
    return true;
  }

  if (kind === "unknown") {
    return hasEvidenceRef(blocker, "github:reviewDecision") ||
      hasEvidenceRef(blocker, CI_STATUS_ROLLUP_REF) ||
      isUnknownCiSummary(summary);
  }

  return false;
}

export function topLevelModeledMergeBlockers(blockers: unknown[]): unknown[] {
  return blockers.filter((blocker) => !isDedicatedReviewGateBlocker(blocker));
}

export function topLevelPrMergeBlockersForGate(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  cachedBlockers: unknown[] = prContextMergeBlockers(prContext),
): unknown[] {
  return dedupeMergeBlockers([
    ...topLevelModeledMergeBlockers(cachedBlockers),
    ...supplementalPrMergeBlockersForGate(prDetails, prContext),
  ]);
}

export function supplementalPrMergeBlockersForGate(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): MergeBlocker[] {
  return analyzePrMergeBlockers(prDetails, prContext)
    .filter((blocker) => !isDedicatedReviewGateBlocker(blocker));
}
