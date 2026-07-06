/**
 * Pure queue validation blocker helpers.
 *
 * These functions project already-extracted queue validation evidence into
 * constituent statuses, unresolved blockers, and strategy labels. They do not
 * parse comments, inspect git state, or mutate PR context.
 */

import type {
  MergeBlocker,
  MergeQueueContext,
  QueueConstituentPR,
  QueueMergeCommit,
  QueueValidationEvidence,
} from "@merge-god/github-sync";

import {
  isBlockingQueueValidationStatus,
  isInconclusiveQueueValidationStatus,
  isNonPassingQueueValidationStatus,
  normalizeQueueValidationEvidenceItems,
  normalizeQueueValidationEvidenceScope,
} from "./queue_validation_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import { recordShapeItem } from "./collection_access_model";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function validationEvidenceRefs(items: QueueValidationEvidence[]): string[] {
  return uniqueStrings(items.flatMap((item) => recordEvidenceRefs(recordShapeItem(item) ?? {})));
}

interface QueueValidationBlockerEvidence {
  raw: QueueValidationEvidence;
  normalized: QueueValidationEvidence;
}

function normalizedValidationEvidence(item: QueueValidationEvidence): QueueValidationEvidence {
  return normalizeQueueValidationEvidenceItems([item])[0] ?? {
    command: "",
    status: "unknown",
    scope: null,
    evidence_ref: null,
  };
}

function blockerEvidenceRows(items: QueueValidationEvidence[]): QueueValidationBlockerEvidence[] {
  return items.map((item) => ({
    raw: item,
    normalized: normalizedValidationEvidence(item),
  }));
}

function blockerEvidenceRefs(items: QueueValidationBlockerEvidence[]): string[] {
  return validationEvidenceRefs(items.map((item) => item.raw));
}

export function queueConstituentStatus(
  number: number,
  mergedSet: ReadonlySet<number>,
  validationByPr: ReadonlyMap<number, QueueValidationEvidence[]>,
): QueueConstituentPR["status"] {
  const evidence = blockerEvidenceRows(validationByPr.get(number) ?? []);
  if (evidence.some((item) => isBlockingQueueValidationStatus(item.normalized.status))) return "blocked";
  if (evidence.some((item) => isInconclusiveQueueValidationStatus(item.normalized.status))) return "unknown";
  if (evidence.some((item) => item.normalized.status === "passed")) return "validated";
  return mergedSet.has(number) ? "merged_into_queue" : "queued";
}

function isPrValidationScope(scope: string | null): boolean {
  return /^#\d+$/.test(normalizeQueueValidationEvidenceScope(scope) ?? "");
}

function queueValidationScopeLabel(scope: string | null): string {
  const normalizedScope = normalizeQueueValidationEvidenceScope(scope);
  return normalizedScope ? `Queue validation scope ${normalizedScope}` : "Queue-wide validation";
}

export function queueConstituentValidationBlockers(
  constituentPrs: QueueConstituentPR[],
  validationByPr: ReadonlyMap<number, QueueValidationEvidence[]>,
): MergeBlocker[] {
  const blockers: MergeBlocker[] = [];
  for (const pr of constituentPrs) {
    const evidence = blockerEvidenceRows(validationByPr.get(pr.number) ?? []);
    const failedEvidence = evidence.filter((item) => isBlockingQueueValidationStatus(item.normalized.status));
    if (failedEvidence.length > 0) {
      blockers.push({
        kind: "ci_failed",
        status: "blocked",
        summary: `Queue constituent PR #${pr.number} has ${failedEvidence.length} failed or blocked validation evidence item(s).`,
        evidence_refs: blockerEvidenceRefs(failedEvidence),
      });
      continue;
    }

    const unknownEvidence = evidence.filter((item) => isInconclusiveQueueValidationStatus(item.normalized.status));
    if (unknownEvidence.length > 0) {
      blockers.push({
        kind: "unknown",
        status: "unknown",
        summary: `Queue constituent PR #${pr.number} has ${unknownEvidence.length} inconclusive validation evidence item(s).`,
        evidence_refs: blockerEvidenceRefs(unknownEvidence),
      });
    }
  }
  return blockers;
}

export function queueScopedValidationBlockers(validationEvidence: QueueValidationEvidence[]): MergeBlocker[] {
  const blockers: MergeBlocker[] = [];
  const grouped = new Map<string, QueueValidationBlockerEvidence[]>();
  const labels = new Map<string, string>();
  for (const evidence of blockerEvidenceRows(validationEvidence)) {
    const normalizedScope = normalizeQueueValidationEvidenceScope(evidence.normalized.scope);
    if (isPrValidationScope(normalizedScope)) continue;
    if (!isNonPassingQueueValidationStatus(evidence.normalized.status)) continue;
    const key = normalizedScope ?? "__queue__";
    grouped.set(key, [...(grouped.get(key) ?? []), evidence]);
    labels.set(key, queueValidationScopeLabel(normalizedScope));
  }

  for (const [key, evidence] of grouped) {
    const label = labels.get(key) ?? "Queue-wide validation";
    const failedEvidence = evidence.filter((item) => isBlockingQueueValidationStatus(item.normalized.status));
    if (failedEvidence.length > 0) {
      blockers.push({
        kind: "ci_failed",
        status: "blocked",
        summary: `${label} has ${failedEvidence.length} failed or blocked validation evidence item(s).`,
        evidence_refs: blockerEvidenceRefs(failedEvidence),
      });
      continue;
    }

    const unknownEvidence = evidence.filter((item) => isInconclusiveQueueValidationStatus(item.normalized.status));
    if (unknownEvidence.length > 0) {
      blockers.push({
        kind: "unknown",
        status: "unknown",
        summary: `${label} has ${unknownEvidence.length} inconclusive validation evidence item(s).`,
        evidence_refs: blockerEvidenceRefs(unknownEvidence),
      });
    }
  }

  return blockers;
}

export function queueStrategy(
  titleNumbers: number[],
  mergeCommits: QueueMergeCommit[],
  hintNumbers: number[],
): MergeQueueContext["strategy"] {
  if (titleNumbers.length > 0) return "title_pr_list";
  if (mergeCommits.length > 0) return "merge_commits";
  if (hintNumbers.length > 0) return "manual";
  return "unknown";
}
