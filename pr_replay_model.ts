/**
 * Pure projections for replaying cached PR context through the agent runner.
 *
 * The runner should only orchestrate side effects: load from the DB, create a
 * trajectory record, and call the agent. Cached forge payloads can use either
 * gathered snake_case fields or adapter camelCase fields, so normalize those
 * aliases here before logging or trajectory creation.
 */

import { recordShapeItem } from "./collection_access_model";
import { normalizeCiStatusCounts } from "./ci_status_model";
import { hasActiveMergeConflicts } from "./conflict_model";
import {
  diffAvailabilityStatus,
  diffUnavailableReason,
  type DiffAvailabilityStatus,
} from "./diff_availability_model";
import {
  prContextCiStatus,
  prContextComments,
  prContextConflicts,
  prContextDiffAvailability,
  prContextDiffText,
  prContextReviewComments,
  prContextUrl,
} from "./pr_context_access_model";
import {
  prDetailsBaseBranch,
  prDetailsHeadBranch,
  prDetailsHeadSha,
  prDetailsLabels,
  prDetailsTitle,
  prDetailsUrl,
} from "./pr_details_access_model";

export interface ReplayPrContextSummary {
  has_diff: boolean;
  diff_status: DiffAvailabilityStatus | "missing";
  diff_unavailable_reason: string | null;
  has_comments: boolean;
  has_review_comments: boolean;
  has_conflicts: boolean;
  has_failing_ci: boolean;
}

export interface ReplayTrajectoryWorkItemProjection {
  title: string | null;
  url: string | null;
  labels: string[];
  base_ref: string | null;
  head_ref: string | null;
  current_sha: string | null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function hasPayload(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return recordShapeItem(value) !== null;
  return Boolean(value);
}

export function replayPrContextSummary(prContext: Record<string, unknown>): ReplayPrContextSummary {
  const ciCounts = normalizeCiStatusCounts(prContextCiStatus(prContext));
  const diffText = prContextDiffText(prContext);
  const hasDiff = hasPayload(diffText);
  const diffAvailability = prContextDiffAvailability(prContext);
  const hasDiffAvailability = Object.keys(diffAvailability).length > 0;
  const diffStatus = hasDiffAvailability ? diffAvailabilityStatus(diffAvailability) : hasDiff ? "pass" : "missing";
  return {
    has_diff: hasDiff,
    diff_status: diffStatus,
    diff_unavailable_reason: diffStatus === "blocked"
      ? diffUnavailableReason(diffAvailability, "Diff unavailable.")
      : null,
    has_comments: prContextComments(prContext).length > 0,
    has_review_comments: prContextReviewComments(prContext).length > 0,
    has_conflicts: hasActiveMergeConflicts(prContextConflicts(prContext)),
    has_failing_ci: ciCounts.failed > 0,
  };
}

export function replayTrajectoryWorkItemFromContext(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): ReplayTrajectoryWorkItemProjection {
  const context = recordValue(prContext);
  return {
    title: nullableText(prDetailsTitle(prDetails)),
    url: nullableText(prContextUrl(context, prDetailsUrl(prDetails))),
    labels: prDetailsLabels(prDetails),
    base_ref: nullableText(prDetailsBaseBranch(prDetails, "")),
    head_ref: nullableText(prDetailsHeadBranch(prDetails)),
    current_sha: nullableText(prDetailsHeadSha(prDetails)),
  };
}
