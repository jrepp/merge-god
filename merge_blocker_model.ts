/**
 * Pure merge-blocker normalization and prioritization helpers.
 *
 * Blocker producers, gate projection, and comment rendering all need the same
 * answer for severity ordering and duplicate identity. Keeping those rules here
 * prevents display code from becoming a second source of domain truth.
 */

import { recordShapeItem } from "./collection_access_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? asRecord(value);
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function firstNonEmptyText(fallback: string, ...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return fallback;
}

function normalizeMergeBlockerKind(value: unknown): string {
  const normalized = toStr(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : "unknown";
}

export type MergeBlockerAggregateStatus = "blocked" | "pending" | "unknown" | "pass";

function normalizeMergeBlockerStatus(value: unknown): MergeBlockerAggregateStatus {
  const normalized = toStr(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "blocked" ||
    normalized === "blocking" ||
    normalized === "fail" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "error" ||
    normalized === "errored" ||
    normalized === "startup_failure" ||
    normalized === "timed_out" ||
    normalized === "timeout" ||
    normalized === "action_required" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  ) {
    return "blocked";
  }
  if (
    normalized === "pending" ||
    normalized === "waiting" ||
    normalized === "running" ||
    normalized === "in_progress" ||
    normalized === "queued"
  ) {
    return "pending";
  }
  if (
    normalized === "pass" ||
    normalized === "passed" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "ok"
  ) {
    return "pass";
  }
  return "unknown";
}

export function mergeBlockerKindLabel(blockerRaw: unknown): string {
  const blocker = recordValue(blockerRaw);
  return normalizeMergeBlockerKind(firstNonEmptyText(
    "unknown",
    blocker["kind"],
    blocker["type"],
    blocker["category"],
    blocker["rule"],
    blocker["name"],
  ));
}

export function mergeBlockerStatusLabel(blockerRaw: unknown): string {
  const blocker = recordValue(blockerRaw);
  return normalizeMergeBlockerStatus(firstNonEmptyText(
    "",
    blocker["status"],
    blocker["state"],
    blocker["result"],
    blocker["outcome"],
    blocker["conclusion"],
  ));
}

export function mergeBlockerSummaryLabel(blockerRaw: unknown): string {
  const blocker = recordValue(blockerRaw);
  return firstNonEmptyText(
    "No summary.",
    blocker["summary"],
    blocker["message"],
    blocker["description"],
    blocker["detail"],
    blocker["reason"],
  );
}

export function mergeBlockerStatusRank(status: unknown): number {
  const normalized = normalizeMergeBlockerStatus(status);
  if (normalized === "blocked") return 0;
  if (normalized === "pending") return 1;
  if (normalized === "unknown") return 2;
  return 3;
}

export function mergeBlockerSeverityRank(blockerRaw: unknown): number {
  return mergeBlockerStatusRank(mergeBlockerStatusLabel(blockerRaw));
}

function mergeBlockerKindIdentity(blockerRaw: unknown): string {
  return mergeBlockerKindLabel(blockerRaw);
}

function mergeBlockerSummaryIdentity(blockerRaw: unknown): string {
  return mergeBlockerSummaryLabel(blockerRaw).replace(/\s+/g, " ").trim();
}

export function mergeBlockerDisplayIdentity(blockerRaw: unknown): string {
  return [
    mergeBlockerKindIdentity(blockerRaw),
    mergeBlockerStatusLabel(blockerRaw),
    mergeBlockerSummaryIdentity(blockerRaw),
  ].join("\u0000");
}

function mergeEvidenceRefs<T>(base: T, duplicate: T): T {
  const baseRefs = recordEvidenceRefs(recordValue(base));
  const refs = [
    ...baseRefs,
    ...recordEvidenceRefs(recordValue(duplicate)),
  ];
  const mergedRefs = [...new Set(refs)];
  if (mergedRefs.length === 0 || mergedRefs.length === baseRefs.length) {
    return base;
  }

  const baseRecord = asRecord(base);
  const nestedNode = recordShapeItem(baseRecord["node"]);
  if (nestedNode !== null) {
    return {
      ...baseRecord,
      node: {
        ...nestedNode,
        evidence_refs: mergedRefs,
      },
    } as T;
  }

  return {
    ...baseRecord,
    evidence_refs: mergedRefs,
  } as T;
}

export function prioritizedMergeBlockers<T>(
  items: T[],
): Array<{ item: T; index: number }> {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => mergeBlockerSeverityRank(a.item) - mergeBlockerSeverityRank(b.item) || a.index - b.index);
}

export function dedupeMergeBlockers<T>(blockers: T[]): T[] {
  const seen = new Set<string>();
  const seenIndex = new Map<string, number>();
  const unique: T[] = [];
  for (const blocker of blockers) {
    const identity = mergeBlockerDisplayIdentity(blocker);
    const duplicateIndex = seenIndex.get(identity);
    if (duplicateIndex !== undefined) {
      const existing = unique[duplicateIndex];
      if (existing !== undefined) {
        unique[duplicateIndex] = mergeEvidenceRefs(existing, blocker);
      }
      continue;
    }
    seen.add(identity);
    seenIndex.set(identity, unique.length);
    unique.push(blocker);
  }
  return unique;
}

export function excludeRepeatedMergeBlockers<T>(items: T[], alreadyRendered: unknown[]): T[] {
  const repeated = new Set(alreadyRendered.map((item) => mergeBlockerDisplayIdentity(item)));
  return items.filter((item) => !repeated.has(mergeBlockerDisplayIdentity(item)));
}

export function aggregateMergeBlockerStatus(blockers: unknown[]): MergeBlockerAggregateStatus {
  const first = prioritizedMergeBlockers(blockers)[0]?.item;
  if (!first) return "pass";
  const rank = mergeBlockerSeverityRank(first);
  if (rank === 0) return "blocked";
  if (rank === 1) return "pending";
  if (rank === 2) return "unknown";
  return "pass";
}

export const MERGE_BLOCKER_EXPLANATION_LIMIT = 5;
export const MERGE_BLOCKER_SUMMARY_LIMIT = 8;

export function mergeBlockerExplanation(blockers: unknown[], limit = MERGE_BLOCKER_EXPLANATION_LIMIT): string {
  if (blockers.length === 0) return "No modeled merge blockers were detected.";
  return prioritizedMergeBlockers(blockers)
    .slice(0, limit)
    .map(({ item }) => `${mergeBlockerKindLabel(item)}: ${mergeBlockerSummaryLabel(item)}`)
    .join("; ");
}

export function mergeBlockerSummary(blockers: unknown[], limit = MERGE_BLOCKER_SUMMARY_LIMIT): string {
  const rendered = prioritizedMergeBlockers(blockers)
    .slice(0, limit)
    .map(({ item }) => {
      const kind = mergeBlockerKindLabel(item);
      const status = mergeBlockerStatusLabel(item);
      const summary = mergeBlockerSummaryLabel(item);
      return `${kind} (${status}): ${summary}`;
    });
  if (blockers.length > limit) rendered.unshift(`${blockers.length - limit} omitted`);
  return rendered.join("; ") || "none";
}
