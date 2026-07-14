/**
 * Pure renderers for merge-god PR evidence comments.
 *
 * These functions convert durable gate/context state into a human-readable
 * GitHub comment body. They do not read GitHub state or update comments.
 */

import { REVIEW_GATE_CACHE_MARKER } from "./review_gate_cache";
import { collectEvidenceRefs, type ReviewGateEvidenceSummary } from "./evidence_ref_model";
import {
  normalizeReviewGateStatusRow,
  type ReviewGateStatus,
} from "./review_gate_model";
import { sanitizeMarkdownTableCell } from "./markdown_table_model";
import { renderEvidenceSummaryRows } from "./review_gate_evidence_comment_model";
import {
  redactReviewerText,
  reviewerAccessibleEvidenceRefs,
} from "./reviewer_privacy_model";
import { mergeQueueContextFromPrDetailsAndContext } from "./merge_pr_model";
import { practitionerGateCallToAction } from "./practitioner_language_model";
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
  const normalizedRows = rows.map((gate) => normalizeReviewGateStatusRow(gate));
  const requiredAction = practitionerGateCallToAction(normalizedRows);
  const evidenceRows = renderEvidenceSummaryRows(evidence);
  return [
    REVIEW_GATE_CACHE_MARKER,
    "## Merge God status",
    "",
    `**Required action:** ${requiredAction}`,
    "",
    `Updated: ${sanitizeMarkdownTableCell(updatedAt, 40)}`,
    "",
    "| Check | Result | Details |",
    "| --- | --- | --- |",
    ...normalizedRows.map((normalized) => {
      return `| ${sanitizeMarkdownTableCell(normalized.rule, 80)} | ${normalized.status} | ${sanitizeMarkdownTableCell(normalized.explanation, 240)} |`;
    }),
    "",
    "_This comment is a reviewer summary. Merge God keeps the run record and test evidence separately._",
    ...(evidenceRows.length > 0
      ? ["", "<details>", "<summary>Technical details</summary>", ...evidenceRows, "", "</details>"]
      : []),
  ].join("\n");
}

/** Render a PR comment without machine-local or opaque evidence references. */
export function renderPublishedReviewGateStatusComment(
  gates: ReviewGateStatus[],
  updatedAt = new Date().toISOString(),
  evidence: ReviewGateEvidenceSummary | null = null,
): string {
  const rendered = renderReviewGateStatusComment(gates, updatedAt, evidence);
  const lines = rendered
    .split("\n")
    .filter((line) => !line.startsWith("| Evidence refs |"));
  const accessibleRefs = evidence
    ? reviewerAccessibleEvidenceRefs(collectEvidenceRefs(evidence))
    : [];
  if (accessibleRefs.length > 0) {
    const closingDetails = lines.lastIndexOf("</details>");
    const evidenceRow = `| Reviewer evidence | ${accessibleRefs.length} | ${sanitizeMarkdownTableCell(accessibleRefs.join(", "), 520)} |`;
    if (closingDetails >= 0) lines.splice(closingDetails, 0, evidenceRow, "");
  }
  return redactReviewerText(lines.join("\n"));
}
