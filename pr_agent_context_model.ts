/**
 * Pure projection from cached PR details/context into the agent PRContext.
 *
 * The agent runtime owns Anthropic calls and tool execution. This module owns
 * only the replay/live context shape conversion, so cached adapter aliases are
 * handled before the agent starts planning work.
 */

import { ciFailedChecks, normalizeCiStatusCounts } from "./ci_status_model";
import { recordShapeItem } from "./collection_access_model";
import { hasActiveMergeConflicts, normalizeMergeConflictEvidence } from "./conflict_model";
import {
  prContextCiStatus,
  prContextComments,
  prContextCommits,
  prContextConflicts,
  prContextDiffText,
  prContextFiles,
  prContextMergeBlockers,
  prContextReviewComments,
  prContextUrl,
} from "./pr_context_access_model";
import { queueContextIsQueue } from "./queue_context_access_model";
import { mergeQueueContextFromPrDetailsAndContext } from "./merge_pr_model";
import {
  prDetailsAuthorLogin,
  prDetailsBaseBranch,
  prDetailsBody,
  prDetailsHeadBranch,
  prDetailsLabels,
  prDetailsNumber,
  prDetailsReviewDecision,
  prDetailsTitle,
  prDetailsUrl,
} from "./pr_details_access_model";
import { topLevelPrMergeBlockersForGate } from "./pr_merge_blocker_model";
import type { PRContext } from "./agents/claude_agent";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const text = toStr(value).trim();
  return text.length > 0 ? text : null;
}

function recordArray(items: unknown[]): Record<string, unknown>[] {
  return items
    .map(recordShapeItem)
    .filter((item): item is Record<string, unknown> => item !== null);
}

export function prAgentContextFromDict(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): PRContext {
  const details = recordValue(prDetails);
  const context = recordValue(prContext);
  const conflicts = prContextConflicts(context);
  const ciStatus = prContextCiStatus(context);
  const ciCounts = normalizeCiStatusCounts(ciStatus);
  const conflictEvidence = normalizeMergeConflictEvidence(conflicts);
  const mergeBlockers = topLevelPrMergeBlockersForGate(details, context, prContextMergeBlockers(context));
  const queueContext = mergeQueueContextFromPrDetailsAndContext(details, context, mergeBlockers);
  const queueContextRecord = recordShapeItem(queueContext);

  return {
    pr_number: prDetailsNumber(details) ?? 0,
    title: prDetailsTitle(details),
    body: nullableText(prDetailsBody(details)),
    head_branch: prDetailsHeadBranch(details),
    base_branch: prDetailsBaseBranch(details),
    author: prDetailsAuthorLogin(details),
    url: prContextUrl(context, prDetailsUrl(details)),
    has_conflicts: hasActiveMergeConflicts(conflicts),
    conflicting_files: conflictEvidence.listed_files,
    has_failing_ci: ciCounts.failed > 0,
    failing_checks: recordArray(ciFailedChecks(ciStatus)),
    review_comments: recordArray(prContextReviewComments(context)),
    general_comments: recordArray(prContextComments(context)),
    merge_blockers: recordArray(mergeBlockers),
    queue_context: queueContextIsQueue(queueContext) && queueContextRecord !== null ? queueContextRecord : null,
    changed_files: recordArray(prContextFiles(context)),
    diff: prContextDiffText(context),
    commits: recordArray(prContextCommits(context)),
    guidelines: toStr(context["guidelines"]),
    commit_examples: toStr(context["commit_examples"]),
    merge_rules: toStr(context["merge_rules"]),
    labels: prDetailsLabels(details),
    ci_checks: ciStatus,
    review_decision: nullableText(prDetailsReviewDecision(details)),
  };
}
