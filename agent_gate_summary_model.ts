/**
 * Pure agent prompt rendering for modeled merge gates.
 *
 * The runtime agent class owns API calls and tool execution. This module keeps
 * merge-blocker and queue-context prompt projection deterministic and testable.
 */

import {
  dedupeMergeBlockers,
  excludeRepeatedMergeBlockers,
  mergeBlockerKindLabel,
  mergeBlockerStatusLabel,
  mergeBlockerSummaryLabel,
} from "./merge_blocker_model";
import {
  queueContextConstituentPrs,
  queueContextIsQueue,
  queueContextMergeCommits,
  queueContextStrategy,
  queueContextUnresolvedBlockers,
  queueContextValidationEvidence,
} from "./queue_context_access_model";
import {
  queueConstituentPrNumberSummary,
  queueStrategyLabel,
} from "./queue_context_summary_model";
import { topLevelModeledMergeBlockers } from "./pr_merge_blocker_model";

export interface AgentGateSummaryInput {
  merge_blockers: unknown[];
  queue_context: unknown | null;
}

function blockerLine(blocker: unknown): string {
  return `- **${mergeBlockerKindLabel(blocker)}** (${mergeBlockerStatusLabel(blocker)}): ${mergeBlockerSummaryLabel(blocker)}`;
}

export function agentGateSummarySection(context: AgentGateSummaryInput): string {
  const mergeBlockers = dedupeMergeBlockers(topLevelModeledMergeBlockers(context.merge_blockers));
  const queueContext = context.queue_context;
  const isQueue = queueContextIsQueue(queueContext);
  if (mergeBlockers.length === 0 && !isQueue) return "";

  const parts: string[] = ["", "## Merge Gate Context", ""];

  if (mergeBlockers.length > 0) {
    parts.push(`- **Merge blockers**: ${mergeBlockers.length}`, "");
    for (const blocker of mergeBlockers) {
      parts.push(blockerLine(blocker));
    }
    parts.push("");
  }

  if (isQueue) {
    const constituentPrs = queueContextConstituentPrs(queueContext);
    const mergeCommits = queueContextMergeCommits(queueContext);
    const validationEvidence = queueContextValidationEvidence(queueContext);
    const unresolvedBlockers = dedupeMergeBlockers(
      excludeRepeatedMergeBlockers(queueContextUnresolvedBlockers(queueContext), mergeBlockers),
    );

    parts.push(
      "- **Queue context**: active aggregate branch",
      `- **Strategy**: ${queueStrategyLabel(queueContextStrategy(queueContext))}`,
      `- **Constituent PRs**: ${queueConstituentPrNumberSummary(constituentPrs)}`,
      `- **Merge commits found**: ${mergeCommits.length}`,
      `- **Validation evidence entries**: ${validationEvidence.length}`,
      `- **Unresolved queue blockers**: ${unresolvedBlockers.length}`,
      "",
    );

    for (const blocker of unresolvedBlockers) {
      parts.push(blockerLine(blocker));
    }
    if (unresolvedBlockers.length > 0) parts.push("");
  }

  return `${parts.join("\n")}\n`;
}
