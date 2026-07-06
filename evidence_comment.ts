/**
 * Pure renderers for merge-god PR evidence comments.
 *
 * These functions convert durable gate/context state into a human-readable
 * GitHub comment body. They do not read GitHub state or update comments.
 */

import { REVIEW_GATE_CACHE_MARKER } from "./review_gate_cache";
import type { ReviewGateEvidenceSummary } from "./evidence_ref_model";
import {
  normalizeReviewGateStatusRow,
  type ReviewGateStatus,
} from "./review_gate_model";
import { sanitizeMarkdownTableCell } from "./markdown_table_model";
import { renderEvidenceSummaryRows } from "./review_gate_evidence_comment_model";
import { mergeQueueContextFromPrDetailsAndContext } from "./merge_pr_model";
import { evidenceSummaryFromContext, prContextMergeBlockers } from "./pr_context_access_model";
import {
  topLevelPrMergeBlockersForGate,
} from "./pr_merge_blocker_model";

export { REVIEW_GATE_CACHE_MARKER } from "./review_gate_cache";
export type { ReviewGateStatus, ReviewGateStatusValue } from "./review_gate_model";
export type { ReviewGateEvidenceSummary } from "./evidence_ref_model";

export function evidenceSummaryFromPrContext(prContext: Record<string, unknown>): ReviewGateEvidenceSummary {
  return evidenceSummaryFromContext(prContext);
}

export function evidenceSummaryFromPrDetailsAndContext(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): ReviewGateEvidenceSummary {
  const summary = evidenceSummaryFromContext(prContext);
  const blockers = topLevelPrMergeBlockersForGate(prDetails, prContext, prContextMergeBlockers(summary));
  const queueContext = mergeQueueContextFromPrDetailsAndContext(prDetails, {
    ...prContext,
    queue_context: summary.queue_context,
  }, blockers);

  return {
    ...summary,
    merge_blockers: blockers,
    queue_context: queueContext ?? undefined,
  };
}

export function renderReviewGateStatusComment(
  gates: ReviewGateStatus[],
  updatedAt = new Date().toISOString(),
  evidence: ReviewGateEvidenceSummary | null = null,
): string {
  const rows = gates.length > 0
    ? gates
    : [{ rule: "review-gates", status: "unknown", explanation: "No gate status was provided." }];
  return [
    REVIEW_GATE_CACHE_MARKER,
    "## merge-god review gate status",
    "",
    "_Non-authoritative cache. Durable source of truth is merge-god trajectory/database state and validation evidence; this comment may be stale or missing._",
    "",
    `Updated: ${sanitizeMarkdownTableCell(updatedAt, 40)}`,
    "",
    "| Rule | Status | Explanation |",
    "| --- | --- | --- |",
    ...rows.map((gate) => {
      const normalized = normalizeReviewGateStatusRow(gate);
      return `| ${sanitizeMarkdownTableCell(normalized.rule, 80)} | ${normalized.status} | ${sanitizeMarkdownTableCell(normalized.explanation, 240)} |`;
    }),
    ...renderEvidenceSummaryRows(evidence),
  ].join("\n");
}
