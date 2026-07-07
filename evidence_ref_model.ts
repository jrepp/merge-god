/**
 * Pure evidence-reference selection for review-gate cache comments.
 *
 * The renderer caps evidence refs, so selection order is domain policy: decisive
 * blockers need to survive the cap before lineage or superseded evidence.
 */

import {
  ciCheckEvidenceRefs,
  ciFailedChecks,
  ciPendingChecks,
  ciUnknownChecks,
  normalizeCiStatusCounts,
} from "./ci_status_model";
import { recordShapeItem } from "./collection_access_model";
import { hasActiveMergeConflicts, normalizeMergeConflictEvidence } from "./conflict_model";
import { diffAvailabilityEvidenceRefs } from "./diff_availability_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import {
  constituentStatusProvenanceRefs,
  isStatusProvenanceRef,
} from "./status_provenance_model";
import {
  dedupeMergeBlockers,
  excludeRepeatedMergeBlockers,
  mergeBlockerDisplayIdentity,
  prioritizedMergeBlockers,
} from "./merge_blocker_model";
import {
  normalizeQueueValidationEvidenceItems,
  partitionQueueValidationEvidence,
  prioritizedQueueValidationEvidence,
} from "./queue_validation_model";
import {
  QUEUE_CONTEXT_SUMMARY_ROW_LIMIT,
  prioritizedQueueConstituentPrs,
  queueConstituentPrEvidenceRef,
  queueMergeCommitEvidenceRef,
  queueMergeCommitPrEvidenceRef,
} from "./queue_context_summary_model";
import {
  queueContextConstituentPrs,
  queueContextIsQueue,
  queueContextMergeCommits,
  queueContextUnresolvedBlockers,
  queueContextValidationEvidence,
} from "./queue_context_access_model";
import {
  prContextCiStatus,
  prContextConflicts,
  prContextDiffAvailability,
  prContextMergeBlockers,
  prContextQueueContext,
} from "./pr_context_access_model";
import type { QueueValidationEvidence } from "@merge-god/github-sync";

export { isStatusProvenanceRef } from "./status_provenance_model";

export interface ReviewGateEvidenceSummary {
  ci_status?: unknown;
  diff_availability?: unknown;
  conflicts?: unknown;
  merge_blockers?: unknown;
  queue_context?: unknown;
}

export const EVIDENCE_REF_PRIORITY_SEED_LIMIT = 1;

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function activeConflictEvidenceRefs(conflicts: Record<string, unknown>): string[] {
  return normalizeMergeConflictEvidence(conflicts).evidence_refs;
}

function validationEvidenceRefs(
  validation: QueueValidationEvidence,
  rawValidation: unknown,
): string[] {
  const rawRefs = recordEvidenceRefs(recordValue(rawValidation));
  return rawRefs.length > 0 ? rawRefs : [validation.evidence_ref ?? ""];
}

function duplicateQueueBlockerBackfillRefs(blocker: unknown, queueBlockers: unknown[]): string[] {
  const identity = mergeBlockerDisplayIdentity(blocker);
  return queueBlockers
    .filter((queueBlocker) => mergeBlockerDisplayIdentity(queueBlocker) === identity)
    .flatMap((queueBlocker) => recordEvidenceRefs(recordValue(queueBlocker)));
}

export function collectEvidenceRefs(evidence: ReviewGateEvidenceSummary): string[] {
  const summary = recordValue(evidence);
  const buckets = {
    failedCi: [] as string[],
    topLevelBlockerSeeds: [] as string[],
    topLevelBlockerExtras: [] as string[],
    queueBlockerSeeds: [] as string[],
    queueBlockerExtras: [] as string[],
    diffAvailability: [] as string[],
    activeConflicts: [] as string[],
    activeValidation: [] as string[],
    pendingCi: [] as string[],
    unknownCi: [] as string[],
    mergeCommits: [] as string[],
    constituentProvenance: [] as string[],
    constituentSynthetic: [] as string[],
    supersededValidation: [] as string[],
  };
  const seen = new Set<string>();
  const addRef = (bucket: string[], value: unknown): boolean => {
    const ref = toStr(value).trim();
    if (!ref || seen.has(ref)) return false;
    seen.add(ref);
    bucket.push(ref);
    return true;
  };
  const addRefs = (bucket: string[], values: unknown[]): number => {
    let added = 0;
    for (const value of values) {
      if (addRef(bucket, value)) added++;
    }
    return added;
  };
  const addGroupedRefs = (seedBucket: string[], extraBucket: string[], values: unknown[]): void => {
    let seeded = false;
    for (const value of values) {
      const bucket = seeded ? extraBucket : seedBucket;
      if (addRef(bucket, value)) seeded = true;
    }
  };
  const addConstituentLineageRefs = (bucket: string[], constituent: Record<string, unknown>): void => {
    const syntheticRef = queueConstituentPrEvidenceRef(constituent);
    let added = 0;
    for (const ref of recordEvidenceRefs(constituent)) {
      if (isStatusProvenanceRef(ref)) continue;
      if (addRef(bucket, ref)) {
        added++;
      }
    }
    if (added === 0) {
      addRef(bucket, syntheticRef);
    }
  };

  const ciStatus = prContextCiStatus(summary);
  const ciCounts = normalizeCiStatusCounts(ciStatus);
  const failedChecks = ciFailedChecks(ciStatus);
  const pendingChecks = ciPendingChecks(ciStatus);
  const unknownChecks = ciUnknownChecks(ciStatus);
  addRefs(buckets.failedCi, ciCheckEvidenceRefs(failedChecks, ciCounts.failed));

  const topLevelBlockers = dedupeMergeBlockers(prContextMergeBlockers(summary));
  const queueContext = prContextQueueContext(summary);
  const shouldReadQueueContext = queueContextIsQueue(queueContext);
  const rawQueueBlockers = shouldReadQueueContext ? queueContextUnresolvedBlockers(queueContext) : [];
  for (const { item: blockerRaw } of prioritizedMergeBlockers(topLevelBlockers)) {
    const blockerRefs = recordEvidenceRefs(recordValue(blockerRaw));
    addGroupedRefs(
      buckets.topLevelBlockerSeeds,
      buckets.topLevelBlockerExtras,
      blockerRefs.length > 0 ? blockerRefs : duplicateQueueBlockerBackfillRefs(blockerRaw, rawQueueBlockers),
    );
  }

  if (shouldReadQueueContext) {
    const queueBlockers = dedupeMergeBlockers(excludeRepeatedMergeBlockers(rawQueueBlockers, topLevelBlockers));
    for (const { item: blockerRaw } of prioritizedMergeBlockers(queueBlockers)) {
      addGroupedRefs(
        buckets.queueBlockerSeeds,
        buckets.queueBlockerExtras,
        recordEvidenceRefs(recordValue(blockerRaw)),
      );
    }
  }

  const diffAvailability = prContextDiffAvailability(summary);
  if (Object.keys(diffAvailability).length > 0) {
    addRefs(buckets.diffAvailability, diffAvailabilityEvidenceRefs(diffAvailability));
  }

  const conflicts = prContextConflicts(summary);
  if (hasActiveMergeConflicts(conflicts)) {
    addRefs(buckets.activeConflicts, activeConflictEvidenceRefs(conflicts));
  }

  if (shouldReadQueueContext) {
    const validationEvidence = queueContextValidationEvidence(queueContext);
    const { active: activeValidation } = partitionQueueValidationEvidence(
      normalizeQueueValidationEvidenceItems(validationEvidence),
    );
    const prioritizedActiveValidation = prioritizedQueueValidationEvidence(activeValidation);
    for (const { evidence: validation, index } of prioritizedActiveValidation) {
      addRefs(buckets.activeValidation, validationEvidenceRefs(validation, validationEvidence[index]));
    }

  }

  addRefs(buckets.pendingCi, ciCheckEvidenceRefs(pendingChecks, ciCounts.pending));
  addRefs(buckets.unknownCi, ciCheckEvidenceRefs(unknownChecks, ciCounts.unknown));

  if (shouldReadQueueContext) {
    const constituentPrs = queueContextConstituentPrs(queueContext);
    addRefs(buckets.constituentProvenance, constituentStatusProvenanceRefs(constituentPrs));

    const shouldSynthesizeMergeCommitPrRefs = constituentPrs.length === 0;
    for (const [index, commitRaw] of queueContextMergeCommits(queueContext).entries()) {
      const commit = recordValue(commitRaw);
      const nestedCommit = recordValue(commit["commit"]);
      addRefs(buckets.mergeCommits, recordEvidenceRefs(commit));
      addRefs(buckets.mergeCommits, recordEvidenceRefs(nestedCommit));
      if (index < QUEUE_CONTEXT_SUMMARY_ROW_LIMIT) {
        addRef(buckets.mergeCommits, queueMergeCommitEvidenceRef(commit));
        if (shouldSynthesizeMergeCommitPrRefs) {
          addRef(buckets.mergeCommits, queueMergeCommitPrEvidenceRef(commit));
        }
      }
    }
    for (const constituentRaw of prioritizedQueueConstituentPrs(constituentPrs)) {
      const constituent = recordValue(constituentRaw);
      addConstituentLineageRefs(buckets.constituentSynthetic, constituent);
    }

    const { superseded: supersededValidation } = partitionQueueValidationEvidence(
      normalizeQueueValidationEvidenceItems(queueContextValidationEvidence(queueContext)),
    );
    for (const { evidence: validation, index } of supersededValidation) {
      addRefs(
        buckets.supersededValidation,
        validationEvidenceRefs(validation, queueContextValidationEvidence(queueContext)[index]),
      );
    }
  }

  const highPriorityRemainderBuckets = [
    buckets.failedCi,
    buckets.diffAvailability,
    buckets.activeConflicts,
    buckets.activeValidation,
    buckets.pendingCi,
    buckets.unknownCi,
  ];
  const allBuckets = [
    ...highPriorityRemainderBuckets,
    buckets.constituentProvenance,
    buckets.topLevelBlockerExtras,
    buckets.queueBlockerExtras,
    buckets.mergeCommits,
    buckets.constituentSynthetic,
    buckets.supersededValidation,
  ];
  return [
    buckets.failedCi[0] ?? "",
    ...buckets.topLevelBlockerSeeds,
    buckets.diffAvailability[0] ?? "",
    buckets.activeConflicts[0] ?? "",
    buckets.activeValidation[0] ?? "",
    ...buckets.queueBlockerSeeds,
    buckets.pendingCi[0] ?? "",
    buckets.unknownCi[0] ?? "",
    ...allBuckets.flatMap((bucket) => bucket.slice(highPriorityRemainderBuckets.includes(bucket) ? EVIDENCE_REF_PRIORITY_SEED_LIMIT : 0)),
  ].filter((ref) => ref.length > 0);
}
