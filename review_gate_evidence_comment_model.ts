/**
 * Pure review-gate evidence section rendering.
 *
 * This module renders durable PR context evidence into Markdown rows for the
 * non-authoritative review-gate cache comment. It does not render the gate
 * header/table and does not update GitHub comments.
 */

import { recordShapeItem } from "./collection_access_model";
import {
  ciFailedChecks,
  ciPendingChecks,
  ciStatusEvidenceDetails,
  ciStatusEvidenceStatus,
  ciUnknownChecks,
  normalizeCiStatusCounts,
} from "./ci_status_model";
import { activeMergeConflictSummary, hasActiveMergeConflicts } from "./conflict_model";
import {
  diffAvailabilityEvidenceDetail,
  diffAvailabilityStatus,
} from "./diff_availability_model";
import {
  dedupeMergeBlockers,
  excludeRepeatedMergeBlockers,
  mergeBlockerKindLabel,
  mergeBlockerStatusLabel,
  mergeBlockerSummary,
  mergeBlockerSummaryLabel,
  prioritizedMergeBlockers,
} from "./merge_blocker_model";
import {
  queueConflictFileSummary,
  queueConstituentPrNumberSummary,
  queueConstituentPrSummary,
  queueMergeCommitSummary,
  queueStrategyLabel,
} from "./queue_context_summary_model";
import {
  queueContextConstituentPrs,
  queueContextIsQueue,
  queueContextMergeCommits,
  queueContextStrategy,
  queueContextUnresolvedBlockers,
  queueContextValidationEvidence,
} from "./queue_context_access_model";
import {
  queueValidationEvidenceCountLabel,
  queueValidationEvidenceSummary,
} from "./queue_validation_summary_model";
import {
  collectEvidenceRefs,
  type ReviewGateEvidenceSummary,
} from "./evidence_ref_model";
import { sanitizeMarkdownTableCell } from "./markdown_table_model";
import {
  prContextCiStatus,
  prContextConflicts,
  prContextDiffAvailability,
  prContextMergeBlockers,
  prContextQueueContext,
} from "./pr_context_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function appendEvidenceSummaryHeader(rows: string[]): void {
  if (rows.length > 0) return;
  rows.push("", "## Evidence summary", "", "| Evidence | Status | Detail |", "| --- | --- | --- |");
}

export const EVIDENCE_REF_RENDER_LIMIT = 10;
export const EVIDENCE_REF_DETAIL_LIMIT = 360;
export const EVIDENCE_REF_ITEM_DETAIL_LIMIT = 72;
export const MERGE_BLOCKER_RENDER_LIMIT = 12;
export const QUEUE_VALIDATION_EVIDENCE_DETAIL_LIMIT = 520;

function abbreviateEvidenceRef(ref: string, limit = EVIDENCE_REF_ITEM_DETAIL_LIMIT): string {
  const clean = ref.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  if (limit <= 3) return "...".slice(0, limit);
  const sideLimit = Math.floor((limit - 3) / 2);
  const head = clean.slice(0, sideLimit);
  const tail = clean.slice(clean.length - (limit - 3 - sideLimit));
  return `${head}...${tail}`;
}

function evidenceRefsDetail(refs: string[]): string {
  const renderedRefs = refs.slice(0, EVIDENCE_REF_RENDER_LIMIT).map((ref) => abbreviateEvidenceRef(ref));
  if (refs.length <= renderedRefs.length) return renderedRefs.join(", ");

  let detail = [...renderedRefs, `${refs.length - renderedRefs.length} more`].join(", ");
  while (detail.length > EVIDENCE_REF_DETAIL_LIMIT && renderedRefs.length > 1) {
    renderedRefs.pop();
    detail = [...renderedRefs, `${refs.length - renderedRefs.length} more`].join(", ");
  }
  return detail;
}

function appendEvidenceRefRows(rows: string[], evidence: ReviewGateEvidenceSummary): void {
  const refs = collectEvidenceRefs(evidence);
  if (refs.length === 0) return;
  appendEvidenceSummaryHeader(rows);
  rows.push(`| Evidence refs | ${refs.length} | ${sanitizeMarkdownTableCell(evidenceRefsDetail(refs), EVIDENCE_REF_DETAIL_LIMIT)} |`);
}

export function renderEvidenceSummaryRows(evidence: ReviewGateEvidenceSummary | null): string[] {
  if (!evidence) return [];
  const summary = recordValue(evidence);
  const rows: string[] = [];
  const ciStatus = prContextCiStatus(summary);
  if (Object.keys(ciStatus).length > 0) {
    const failedChecks = ciFailedChecks(ciStatus);
    const pendingChecks = ciPendingChecks(ciStatus);
    const unknownChecks = ciUnknownChecks(ciStatus);
    const counts = normalizeCiStatusCounts(ciStatus);
    const status = ciStatusEvidenceStatus(counts);
    const details = ciStatusEvidenceDetails(
      counts,
      { failed: failedChecks, pending: pendingChecks, unknown: unknownChecks },
    );
    appendEvidenceSummaryHeader(rows);
    rows.push(`| CI checks | ${status} | ${sanitizeMarkdownTableCell(details, 520)} |`);
  }

  const diffAvailability = prContextDiffAvailability(summary);
  if (Object.keys(diffAvailability).length > 0) {
    appendEvidenceSummaryHeader(rows);
    rows.push(
      `| Diff availability | ${diffAvailabilityStatus(diffAvailability)} | ${sanitizeMarkdownTableCell(
        diffAvailabilityEvidenceDetail(diffAvailability),
        240,
      )} |`,
    );
  }

  const conflicts = prContextConflicts(summary);
  if (hasActiveMergeConflicts(conflicts)) {
    const activeConflictSummary = activeMergeConflictSummary(conflicts);
    appendEvidenceSummaryHeader(rows);
    rows.push(
      `| Merge conflicts | blocked | ${sanitizeMarkdownTableCell(activeConflictSummary.detail, 360)} |`,
    );
  }

  const blockers = dedupeMergeBlockers(prContextMergeBlockers(summary));
  if (blockers.length > 0) {
    appendEvidenceSummaryHeader(rows);
    for (const { item: blockerRaw } of prioritizedMergeBlockers(blockers).slice(0, MERGE_BLOCKER_RENDER_LIMIT)) {
      rows.push(
        `| ${sanitizeMarkdownTableCell(mergeBlockerKindLabel(blockerRaw), 80)} | ` +
          `${sanitizeMarkdownTableCell(mergeBlockerStatusLabel(blockerRaw), 30)} | ` +
          `${sanitizeMarkdownTableCell(mergeBlockerSummaryLabel(blockerRaw), 240)} |`,
      );
    }
    if (blockers.length > MERGE_BLOCKER_RENDER_LIMIT) {
      rows.push(
        `| merge-blockers | unknown | ${blockers.length - MERGE_BLOCKER_RENDER_LIMIT} additional blocker(s) omitted from comment cache. |`,
      );
    }
  }

  appendEvidenceRefRows(rows, summary);

  const queueContext = prContextQueueContext(summary);
  if (queueContextIsQueue(queueContext)) {
    const constituentPrs = queueContextConstituentPrs(queueContext);
    const mergeCommits = queueContextMergeCommits(queueContext);
    const validationEvidence = queueContextValidationEvidence(queueContext);
    const unresolvedBlockers = dedupeMergeBlockers(
      excludeRepeatedMergeBlockers(queueContextUnresolvedBlockers(queueContext), blockers),
    );
    const conflictFiles = queueConflictFileSummary(mergeCommits);
    rows.push(
      "",
      "## Merge queue evidence",
      "",
      `Strategy: ${sanitizeMarkdownTableCell(queueStrategyLabel(queueContextStrategy(queueContext)), 80)}`,
      "",
      "| Area | Count | Detail |",
      "| --- | ---: | --- |",
      `| Constituent PRs | ${constituentPrs.length} | ${sanitizeMarkdownTableCell(
        queueConstituentPrNumberSummary(constituentPrs),
        240,
      )} |`,
      `| Constituent status | ${constituentPrs.length} | ${sanitizeMarkdownTableCell(queueConstituentPrSummary(constituentPrs), 360)} |`,
      `| Merge commits | ${mergeCommits.length} | ${sanitizeMarkdownTableCell(
        queueMergeCommitSummary(mergeCommits),
        240,
      )} |`,
      `| Conflict files | ${conflictFiles.count} | ${sanitizeMarkdownTableCell(conflictFiles.detail, 360)} |`,
      `| Validation evidence | ${sanitizeMarkdownTableCell(queueValidationEvidenceCountLabel(validationEvidence), 40)} | ${sanitizeMarkdownTableCell(
        queueValidationEvidenceSummary(validationEvidence),
        QUEUE_VALIDATION_EVIDENCE_DETAIL_LIMIT,
      )} |`,
      `| Unresolved blockers | ${unresolvedBlockers.length} | ${sanitizeMarkdownTableCell(
        mergeBlockerSummary(unresolvedBlockers),
        360,
      )} |`,
    );
  }
  return rows;
}
