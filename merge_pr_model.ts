/**
 * Pure merge-PR domain helpers.
 *
 * This module has no process, filesystem, network, or GitHub side effects. It
 * translates already-gathered PR details/context into merge blockers and queue
 * lineage that orchestration code can persist, prompt with, or project into
 * comments.
 */

import type {
  MergeBlocker,
  MergeQueueContext,
  QueueMergeCommit,
  QueueValidationEvidence,
} from "@merge-god/github-sync";

import {
  activeQueueValidationEvidence,
  extractQueueValidationEvidence,
  validationEvidenceByPrNumber,
} from "./queue_validation_model";
import {
  normalizeQueuePrSelfValidationEvidence,
  sortQueueValidationCommentsChronologically,
} from "./queue_validation_context_model";
import {
  extractConstituentHints,
  extractMergedConstituentNumbers,
  hasQueueVocabulary,
  isExplicitQueueLikeTitle,
  parsePrNumbersFromQueueTitle,
} from "./queue_membership_model";
import {
  queueConstituentValidationBlockers,
  queueScopedValidationBlockers,
  queueStrategy,
} from "./queue_blocker_model";
import {
  modelQueueMergeCommits,
  queueMergeCommitCandidates,
} from "./queue_merge_commit_model";
import {
  buildQueueConstituentPrs,
  resolveQueueMembership,
} from "./queue_membership_resolution_model";
import { analyzePrMergeBlockers } from "./pr_merge_blocker_model";
import {
  prDetailsBaseBranch,
  prDetailsNumber,
  prDetailsTitle,
} from "./pr_details_access_model";
import {
  prContextComments,
  prContextMergeBlockers,
  prContextQueueContext,
  prContextReviewComments,
} from "./pr_context_access_model";
import { recordShapeItem } from "./collection_access_model";

export type {
  DiffAvailability,
  MergeBlocker,
  MergeBlockerKind,
  MergeQueueContext,
  QueueConstituentPR,
  QueueMergeCommit,
  QueueValidationEvidence,
} from "@merge-god/github-sync";

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function nonEmptyText(value: unknown, fallback: string): string {
  const text = toStr(value).trim();
  return text.length > 0 ? text : fallback;
}

function uniqueSortedNumbers(values: Iterable<number>): number[] {
  return [...new Set([...values].filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function mergeBlockersForQueueInference(blockers: unknown[]): MergeBlocker[] {
  return blockers.flatMap((blocker) => {
    const record = recordShapeItem(blocker);
    return record === null ? [] : [record as unknown as MergeBlocker];
  });
}

export function inferMergeQueueContext(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  unresolvedBlockers: MergeBlocker[] = [],
): MergeQueueContext | null {
  const title = prDetailsTitle(prDetails);
  const explicitTitleIsQueue = isExplicitQueueLikeTitle(title);
  const titleHasQueueVocabulary = hasQueueVocabulary(title);
  const titleNumbers = parsePrNumbersFromQueueTitle(title);
  const baseBranch = prDetailsBaseBranch(prDetails);
  const commits = queueMergeCommitCandidates(prDetails, prContext);
  const comments = prContextComments(prContext);
  const reviewComments = prContextReviewComments(prContext);
  const constituentHints = extractConstituentHints(prDetails, comments, reviewComments);
  const mergedConstituentEvidenceByPr = extractMergedConstituentNumbers(prDetails, comments, reviewComments);
  const queuePrNumber = prDetailsNumber(prDetails);
  const extractedValidationEvidence = extractQueueValidationEvidence(
    sortQueueValidationCommentsChronologically([...comments, ...reviewComments]),
  );
  const validation_evidence = normalizeQueuePrSelfValidationEvidence(extractedValidationEvidence, queuePrNumber);
  const activeValidationEvidence = activeQueueValidationEvidence(validation_evidence);
  const validationByPr = validationEvidenceByPrNumber(activeValidationEvidence);
  const modeledCommits = modelQueueMergeCommits(commits, {
    baseBranch,
    allowSquashSubjects: explicitTitleIsQueue || titleHasQueueVocabulary,
  });
  const mergeCommits: QueueMergeCommit[] = modeledCommits.merge_commits;
  const mergedPrNumbers = uniqueSortedNumbers([
    ...modeledCommits.merged_pr_numbers,
    ...mergedConstituentEvidenceByPr.keys(),
  ]);

  const hintNumbers = titleHasQueueVocabulary || explicitTitleIsQueue || mergeCommits.length > 0
    ? [...constituentHints.keys()]
    : [];
  const membership = resolveQueueMembership({
    titleNumbers,
    mergedPrNumbers,
    hintNumbers,
    validationByPr,
    explicitTitleIsQueue,
    mergeCommitCount: mergeCommits.length,
  });
  if (!membership.is_queue) return null;

  const constituent_prs = buildQueueConstituentPrs({
    allPrNumbers: membership.all_pr_numbers,
    constituentHints,
    validationByPr,
    mergedPrNumbers,
    mergedEvidenceByPr: mergedConstituentEvidenceByPr,
  });

  const queueBlockers = [
    ...queueConstituentValidationBlockers(constituent_prs, validationByPr),
    ...queueScopedValidationBlockers(activeValidationEvidence),
  ];

  return {
    is_queue: true,
    strategy: queueStrategy(titleNumbers, mergeCommits, hintNumbers),
    constituent_prs,
    merge_commits: mergeCommits,
    validation_evidence,
    unresolved_blockers: [...unresolvedBlockers, ...queueBlockers],
  };
}

export function mergeQueueContextFromPrDetailsAndContext(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  blockers: unknown[] = prContextMergeBlockers(prContext),
): unknown {
  const existingQueueContext = prContextQueueContext(prContext);
  if (recordShapeItem(existingQueueContext) !== null) return existingQueueContext;
  return inferMergeQueueContext(
    prDetails,
    { ...prContext, merge_blockers: blockers },
    mergeBlockersForQueueInference(blockers),
  );
}

export function analyzeMergeBlockers(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): MergeBlocker[] {
  return analyzePrMergeBlockers(prDetails, prContext);
}
