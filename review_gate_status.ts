/**
 * Pure review-gate status projection from gathered PR context.
 */

import type { ReviewGateStatus, ReviewGateStatusValue } from "./review_gate_model";
import {
  ciStatusReviewGateExplanation,
  ciStatusReviewGateStatus,
  normalizeCiStatusCounts,
} from "./ci_status_model";
import { hasActiveMergeConflicts, mergeConflictSummary } from "./conflict_model";
import {
  aggregateMergeBlockerStatus,
  dedupeMergeBlockers,
  mergeBlockerExplanation,
} from "./merge_blocker_model";
import {
  topLevelPrMergeBlockersForGate,
} from "./pr_merge_blocker_model";
import { mergeQueueContextFromPrDetailsAndContext } from "./merge_pr_model";
import {
  normalizeReviewDecision,
  reviewDecisionGateStatus,
  reviewDecisionSummary,
} from "./review_decision_model";
import {
  queueContextIsQueue,
  queueContextUnresolvedBlockers,
} from "./queue_context_access_model";
import {
  prContextCiStatus,
  prContextConflicts,
  prContextMergeBlockers,
} from "./pr_context_access_model";
import { prDetailsHasMetadata, prDetailsReviewDecision } from "./pr_details_access_model";

function modeledBlockerStatus(blockers: unknown[]): ReviewGateStatusValue {
  return aggregateMergeBlockerStatus(blockers);
}

function hasRepoMergeRules(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function reviewGateStatusesFromContext(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  mergeRules: string,
): ReviewGateStatus[] {
  const conflicts = prContextConflicts(prContext);
  const ciStatus = prContextCiStatus(prContext);
  const topLevelBlockers = topLevelPrMergeBlockersForGate(prDetails, prContext, prContextMergeBlockers(prContext));
  const queueContext = mergeQueueContextFromPrDetailsAndContext(prDetails, prContext, topLevelBlockers);
  const queueBlockers = queueContextIsQueue(queueContext)
    ? queueContextUnresolvedBlockers(queueContext)
    : [];
  const blockers = [
    ...topLevelBlockers,
    ...queueBlockers,
  ];
  const uniqueBlockers = dedupeMergeBlockers(blockers);
  const reviewDecision = normalizeReviewDecision(prDetailsReviewDecision(prDetails, "UNKNOWN"), "UNKNOWN");
  const ciCounts = normalizeCiStatusCounts(ciStatus);
  const hasConflicts = hasActiveMergeConflicts(conflicts);
  const mergeRulesLoaded = hasRepoMergeRules(mergeRules);
  const detailsLoaded = prDetailsHasMetadata(prDetails);
  return [
    {
      rule: "context-gathered",
      status: detailsLoaded ? "pass" : "blocked",
      explanation: detailsLoaded
        ? "PR metadata, comments, commits, files, diff, conflicts, and CI state were gathered."
        : "PR details could not be loaded.",
    },
    {
      rule: "modeled-blockers",
      status: modeledBlockerStatus(uniqueBlockers),
      explanation: mergeBlockerExplanation(uniqueBlockers),
    },
    {
      rule: "merge-conflicts",
      status: hasConflicts ? "blocked" : "pass",
      explanation: hasConflicts
        ? mergeConflictSummary(conflicts)
        : "No merge conflicts were detected against the base branch.",
    },
    {
      rule: "ci-status",
      status: ciStatusReviewGateStatus(ciCounts),
      explanation: ciStatusReviewGateExplanation(ciCounts),
    },
    {
      rule: "review-decision",
      status: reviewDecisionGateStatus(reviewDecision),
      explanation: reviewDecisionSummary(reviewDecision),
    },
    {
      rule: "repo-merge-rules",
      status: mergeRulesLoaded ? "pending" : "skipped",
      explanation: mergeRulesLoaded
        ? "Repository merge rules were loaded and still require final gate evaluation."
        : "No repository merge rules were loaded.",
    },
  ];
}
