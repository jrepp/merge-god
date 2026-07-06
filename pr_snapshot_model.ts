/**
 * Pure projection from gathered PR details/context into a SyncStore PR snapshot.
 *
 * Sync scripts persist both the full PR context and a compact active-PR row.
 * Keep that compact projection here so replay/database state uses the same
 * normalization rules as merge blockers, prompts, and evidence comments.
 */

import {
  createPullRequest,
  PRState,
  type PullRequest,
} from "@merge-god/github-sync";

import { normalizeCiStatusCounts } from "./ci_status_model";
import { recordShapeItem } from "./collection_access_model";
import { hasActiveMergeConflicts, normalizeMergeConflictEvidence } from "./conflict_model";
import { prContextCiStatus, prContextConflicts, prContextUrl } from "./pr_context_access_model";
import {
  prDetailsAdditions,
  prDetailsAuthorLogin,
  prDetailsBaseBranch,
  prDetailsBody,
  prDetailsChangedFiles,
  prDetailsCommitCount,
  prDetailsCreatedAt,
  prDetailsDeletions,
  prDetailsHeadBranch,
  prDetailsIsDraft,
  prDetailsLabels,
  prDetailsMergedAt,
  prDetailsMergeable,
  prDetailsNumber,
  prDetailsReviewDecision,
  prDetailsStateText,
  prDetailsTitle,
  prDetailsUpdatedAt,
  prDetailsUrl,
} from "./pr_details_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseDate(value: unknown, fallback: Date): Date {
  const text = toStr(value).trim();
  if (!text) return fallback;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : fallback;
}

function prDetailsState(value: unknown): PRState {
  if (prDetailsIsDraft(value)) return PRState.DRAFT;
  const state = prDetailsStateText(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (state === "merged" || toStr(prDetailsMergedAt(value)).trim()) return PRState.MERGED;
  if (state === "closed") return PRState.CLOSED;
  return PRState.OPEN;
}

export function pullRequestSnapshotFromDetails(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  opts: { url?: string; now?: Date } = {},
): PullRequest {
  const details = recordValue(prDetails);
  const context = recordValue(prContext);
  const now = opts.now ?? new Date();
  const conflicts = prContextConflicts(context);
  const conflictEvidence = normalizeMergeConflictEvidence(conflicts);
  const ciCounts = normalizeCiStatusCounts(prContextCiStatus(context));
  return createPullRequest({
    number: prDetailsNumber(prDetails) ?? 0,
    title: prDetailsTitle(prDetails),
    state: prDetailsState(prDetails),
    head_branch: prDetailsHeadBranch(prDetails),
    base_branch: prDetailsBaseBranch(prDetails),
    author: prDetailsAuthorLogin(prDetails),
    url: prDetailsUrl(prDetails, opts.url ?? prContextUrl(context)),
    created_at: parseDate(prDetailsCreatedAt(details), now),
    updated_at: parseDate(prDetailsUpdatedAt(details), now),
    body: prDetailsBody(prDetails) || null,
    draft: prDetailsIsDraft(prDetails),
    mergeable: prDetailsMergeable(prDetails) ?? true,
    labels: prDetailsLabels(prDetails),
    ci_summary: {
      total: ciCounts.total,
      success: ciCounts.passed,
      failure: ciCounts.failed,
      pending: ciCounts.pending,
      none: ciCounts.unknown + ciCounts.skipped,
    },
    review_decision: toStr(prDetailsReviewDecision(prDetails)).trim() || null,
    additions: prDetailsAdditions(prDetails),
    deletions: prDetailsDeletions(prDetails),
    changed_files: prDetailsChangedFiles(prDetails),
    commits: prDetailsCommitCount(prDetails),
    has_conflicts: hasActiveMergeConflicts(conflicts),
    conflicting_files: conflictEvidence.listed_files,
  });
}
