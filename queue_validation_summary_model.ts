/**
 * Pure queue-validation evidence summaries for review-gate cache comments.
 *
 * Converts cached validation evidence into a bounded display summary without
 * reading comments, mutating queue context, or escaping markdown table cells.
 */

import {
  normalizeQueueValidationEvidenceItems,
  partitionQueueValidationEvidence,
  prioritizedQueueValidationEvidence,
} from "./queue_validation_model";

export const QUEUE_VALIDATION_SUMMARY_ROW_LIMIT = 6;
export const QUEUE_VALIDATION_SUMMARY_COMMAND_LIMIT = 96;

function queueValidationSummaryText(value: string, limit = QUEUE_VALIDATION_SUMMARY_COMMAND_LIMIT): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  if (limit <= 3) return "...".slice(0, limit);
  return `${clean.slice(0, limit - 3).trimEnd()}...`;
}

export function queueValidationEvidenceCountLabel(items: unknown[]): string {
  const { active, superseded } = partitionQueueValidationEvidence(normalizeQueueValidationEvidenceItems(items));
  if (superseded.length === 0) return String(active.length);
  return `${active.length} active / ${active.length + superseded.length} total`;
}

export function queueValidationEvidenceSummary(items: unknown[], limit = QUEUE_VALIDATION_SUMMARY_ROW_LIMIT): string {
  const { active, superseded } = partitionQueueValidationEvidence(normalizeQueueValidationEvidenceItems(items));
  const prioritized = prioritizedQueueValidationEvidence(active);
  const rendered = prioritized.slice(0, limit).map(({ evidence }) => {
    const scope = evidence.scope;
    const command = queueValidationSummaryText(evidence.command);
    const status = evidence.status;
    return `${status}${scope ? ` [${scope}]` : ""}: ${command}`;
  });
  if (active.length > limit) {
    const passingIndex = prioritized
      .slice(0, limit)
      .findIndex(({ evidence }) => evidence.status === "passed");
    rendered.splice(passingIndex < 0 ? rendered.length : passingIndex + 1, 0, `${active.length - limit} more active`);
  }
  if (superseded.length > 0) rendered.unshift(`${superseded.length} superseded`);
  return rendered.join("; ") || "none";
}
