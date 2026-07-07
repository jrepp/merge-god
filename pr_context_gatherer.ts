/**
 * Application service for assembling PR context from a source port.
 */

import { analyzeCiStatus, normalizeCiStatusCounts } from "./ci_status_model";
import { firstPresentRecordCollection } from "./collection_access_model";
import { hasActiveMergeConflicts } from "./conflict_model";
import { analyzeMergeBlockers, inferMergeQueueContext, type MergeBlocker } from "./merge_pr_model";
import {
  prContextCiStatus,
  prContextCommits,
  prContextConflicts,
  prContextDiffAvailability,
  prContextMergeBlockers,
  prContextQueueContext,
} from "./pr_context_access_model";
import { prContextTelemetrySummary } from "./pr_context_log_model";
import type { PullRequestContextSource } from "./pr_context_source";
import { queueContextIsQueue } from "./queue_context_access_model";

export { analyzeCiStatus } from "./ci_status_model";

export interface GatherPrContextLogger {
  (eventType: string, data: Record<string, unknown>): void;
}

export async function gatherPrContextFromSource(
  source: PullRequestContextSource,
  prNumber: number,
  headBranch: string,
  baseBranch: string,
  url: string,
  log: GatherPrContextLogger = () => undefined,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  log("gather_pr_context", { action: "start", pr_number: prNumber });
  const details = await source.getDetails(prNumber);
  const context: Record<string, unknown> = {
    url,
    comments: [],
    review_comments: [],
    commits: [],
    files: [],
    conflicts: {},
    ci_status: analyzeCiStatus(firstPresentRecordCollection(
      details,
      ["statusCheckRollup", "status_check_rollup", "statusChecks", "status_checks"],
    )),
    diff: "",
    diff_availability: {
      available: false,
      source: null,
      size: 0,
      truncated: false,
      error: null,
    },
    merge_blockers: [] as MergeBlocker[],
    queue_context: null,
  };

  const refs = { head_branch: headBranch, base_branch: baseBranch };
  const [comments, reviewComments, commits, files, conflicts, diffResult] = await Promise.all([
    source.getComments(prNumber),
    source.getReviewComments(prNumber),
    source.getCommits(prNumber),
    source.getFiles(prNumber),
    source.checkMergeConflicts(prNumber, refs),
    source.getDiff(prNumber, refs),
  ]);

  context["comments"] = comments;
  context["review_comments"] = reviewComments;
  context["commits"] = commits;
  context["files"] = files;
  context["conflicts"] = conflicts;
  context["diff"] = diffResult.diff;
  context["diff_availability"] = diffResult.availability;
  context["merge_blockers"] = analyzeMergeBlockers(details, context);
  context["queue_context"] = inferMergeQueueContext(details, context, context["merge_blockers"] as MergeBlocker[]);

  const telemetry = prContextTelemetrySummary(context);
  const ciCounts = normalizeCiStatusCounts(prContextCiStatus(context));
  const diffAvailability = prContextDiffAvailability(context);
  log("gather_pr_context", {
    action: "complete",
    pr_number: prNumber,
    context_summary: {
      comments: telemetry.comment_count,
      review_comments: telemetry.review_comment_count,
      commits: prContextCommits(context).length,
      files: telemetry.file_count,
      has_conflicts: hasActiveMergeConflicts(prContextConflicts(context)),
      ci_checks: ciCounts.total,
      ci_failed: ciCounts.failed,
      diff_size: telemetry.diff_size,
      diff_available: diffAvailability["available"] === true,
      merge_blockers: prContextMergeBlockers(context).length,
      is_queue: queueContextIsQueue(prContextQueueContext(context)),
    },
  });

  return [details, context];
}
