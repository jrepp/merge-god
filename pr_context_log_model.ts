/**
 * Pure summary helpers for PR-context telemetry.
 */

import {
  prContextComments,
  prContextDiffText,
  prContextFiles,
  prContextReviewComments,
} from "./pr_context_access_model";
import { recordShapeItem } from "./collection_access_model";

export interface PrContextTelemetrySummary {
  diff_size: number;
  comment_count: number;
  review_comment_count: number;
  file_count: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

export function prContextTelemetrySummary(value: unknown): PrContextTelemetrySummary {
  const context = asRecord(value);
  return {
    diff_size: prContextDiffText(context).length,
    comment_count: prContextComments(context).length,
    review_comment_count: prContextReviewComments(context).length,
    file_count: prContextFiles(context).length,
  };
}
