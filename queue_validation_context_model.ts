/**
 * Pure queue validation context helpers.
 *
 * These helpers prepare raw PR discussion/review comments and already-parsed
 * validation evidence before queue modeling consumes it. They do not parse
 * validation lines or infer queue membership.
 */

import type { QueueValidationEvidence } from "@merge-god/github-sync";
import { recordShapeItem } from "./collection_access_model";
import { normalizeQueueValidationEvidenceScope } from "./queue_validation_model";

function recordValue(v: unknown): Record<string, unknown> {
  return recordShapeItem(v) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

export function queueValidationCommentTimestampMs(commentRaw: unknown): number | null {
  const comment = recordValue(commentRaw);
  for (const value of [
    comment["edited_at"],
    comment["editedAt"],
    comment["last_edited_at"],
    comment["lastEditedAt"],
    comment["updated_at"],
    comment["updatedAt"],
    comment["submitted_at"],
    comment["submittedAt"],
    comment["published_at"],
    comment["publishedAt"],
    comment["created_at"],
    comment["createdAt"],
  ]) {
    const raw = toStr(value).trim();
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function sortQueueValidationCommentsChronologically(comments: unknown[]): unknown[] {
  return comments
    .map((comment, index) => ({
      comment,
      index,
      timestamp: queueValidationCommentTimestampMs(comment),
    }))
    .sort((a, b) => {
      if (a.timestamp === null && b.timestamp !== null) return -1;
      if (a.timestamp !== null && b.timestamp === null) return 1;
      if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.comment);
}

function prNumberFromNormalizedValidationScope(scope: string | null): number | null {
  const normalizedScope = normalizeQueueValidationEvidenceScope(scope);
  const match = normalizedScope?.match(/^#(\d+)$/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeQueuePrSelfValidationScope(
  evidence: QueueValidationEvidence,
  queuePrNumber: number | null,
): QueueValidationEvidence {
  if (queuePrNumber === null) return evidence;
  return prNumberFromNormalizedValidationScope(evidence.scope) === queuePrNumber
    ? { ...evidence, scope: null }
    : evidence;
}

export function normalizeQueuePrSelfValidationEvidence(
  evidence: QueueValidationEvidence[],
  queuePrNumber: number | null,
): QueueValidationEvidence[] {
  return evidence.map((item) => normalizeQueuePrSelfValidationScope(item, queuePrNumber));
}
