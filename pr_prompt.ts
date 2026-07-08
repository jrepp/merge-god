/**
 * Pure prompt rendering for PR and issue agent work.
 *
 * The long-running loop gathers data and runs agents; this module turns plain
 * records into deterministic prompts with no I/O.
 */

import { recordShapeItem } from "./collection_access_model";
import {
  changedFileAdditions,
  changedFileDeletions,
  changedFilePath,
  changedFileStatus,
} from "./changed_file_model";
import {
  commentAuthorLogin,
  commentBody,
  commentLine,
  commentPath,
} from "./comment_access_model";
import {
  ciCheckName,
  ciCheckStatusLabel,
  ciFailedChecks,
  normalizeCiCheckDetailsUrl,
  normalizeCiStatusCounts,
} from "./ci_status_model";
import {
  commitIdentifier,
  commitMessageHeadline,
} from "./commit_access_model";
import {
  hasActiveMergeConflicts,
  normalizeMergeConflictEvidence,
} from "./conflict_model";
import {
  diffAvailabilitySourceLabel,
  diffAvailabilityStatus,
  diffUnavailableReason,
} from "./diff_availability_model";
import {
  dedupeMergeBlockers,
  excludeRepeatedMergeBlockers,
  mergeBlockerKindLabel,
  mergeBlockerStatusLabel,
  mergeBlockerSummaryLabel,
} from "./merge_blocker_model";
import {
  prContextCiStatus,
  prContextComments,
  prContextCommits,
  prContextConflicts,
  prContextDiffAvailability,
  prContextFiles,
  prContextMergeBlockers,
  prContextReviewComments,
  prContextUrl,
} from "./pr_context_access_model";
import { topLevelPrMergeBlockersForGate } from "./pr_merge_blocker_model";
import {
  prDetailsAdditions,
  prDetailsAuthorLogin,
  prDetailsBaseBranch,
  prDetailsBody,
  prDetailsChangedFiles,
  prDetailsDeletions,
  prDetailsHeadBranch,
  prDetailsNumber,
  prDetailsReviewDecision,
  prDetailsTitle,
  prDetailsUrl,
} from "./pr_details_access_model";
import { mergeQueueContextFromPrDetailsAndContext } from "./merge_pr_model";
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
import { isReviewGateCacheBody } from "./review_gate_cache";
import { normalizeReviewDecision } from "./review_decision_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function fileStatusEmoji(status: string): string {
  return status === "added"
    ? "✨"
    : status === "removed"
      ? "🗑️"
      : status === "modified"
        ? "📝"
        : status === "renamed"
          ? "🔄"
          : "📝";
}

/** Build a comprehensive prompt for pi to process the PR with full context. */
export function buildPrPrompt(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
  mergeRules = "",
): string {
  const prNumber = prDetailsNumber(prDetails) ?? "unknown";
  const title = prDetailsTitle(prDetails);
  const body = prDetailsBody(prDetails);
  const headBranch = prDetailsHeadBranch(prDetails);
  const baseBranch = prDetailsBaseBranch(prDetails);
  const url = prContextUrl(prContext, prDetailsUrl(prDetails));
  const prAuthor = prDetailsAuthorLogin(prDetails);

  const parts: string[] = [
    `# PR #${prNumber}: ${title}`,
    "",
    `**Author**: ${prAuthor}`,
    `**Branch**: ${headBranch} → ${baseBranch}`,
    `**URL**: ${url}`,
    "",
  ];

  if (body) {
    parts.push("## PR Description", "", body, "");
  }

  const additions = prDetailsAdditions(prDetails);
  const deletions = prDetailsDeletions(prDetails);
  const changedFiles = prDetailsChangedFiles(prDetails);

  parts.push(
    "## PR Statistics",
    "",
    `- **Files changed**: ${changedFiles}`,
    `- **Additions**: +${additions}`,
    `- **Deletions**: -${deletions}`,
    "",
  );

  const diffAvailability = prContextDiffAvailability(prContext);
  if (diffAvailabilityStatus(diffAvailability) === "blocked") {
    parts.push(
      "## Diff Availability",
      "",
      "- **Status**: unavailable during context gathering",
      `- **Source**: ${diffAvailabilitySourceLabel(diffAvailability)}`,
      `- **Reason**: ${diffUnavailableReason(diffAvailability, "unknown")}`,
      "",
      "Use local git history, paginated changed-file metadata, and targeted file inspection instead of assuming the full diff is present.",
      "",
    );
  }

  const mergeBlockers = topLevelPrMergeBlockersForGate(prDetails, prContext, prContextMergeBlockers(prContext));
  if (mergeBlockers.length > 0) {
    parts.push("## Merge Blockers", "");
    for (const blockerRaw of mergeBlockers) {
      parts.push(
        `- **${mergeBlockerKindLabel(blockerRaw)}** (${mergeBlockerStatusLabel(blockerRaw)}): ${mergeBlockerSummaryLabel(blockerRaw)}`,
      );
    }
    parts.push("");
  }

  const queueContext = mergeQueueContextFromPrDetailsAndContext(prDetails, prContext, mergeBlockers);
  if (queueContextIsQueue(queueContext)) {
    const constituentPrs = queueContextConstituentPrs(queueContext);
    const mergeCommits = queueContextMergeCommits(queueContext);
    const validationEvidence = queueContextValidationEvidence(queueContext);
    const unresolvedBlockers = dedupeMergeBlockers(
      excludeRepeatedMergeBlockers(queueContextUnresolvedBlockers(queueContext), mergeBlockers),
    );
    parts.push(
      "## Merge Queue Context",
      "",
      `- **Strategy**: ${queueStrategyLabel(queueContextStrategy(queueContext))}`,
      `- **Constituent PRs**: ${queueConstituentPrNumberSummary(constituentPrs)}`,
      `- **Merge commits found**: ${mergeCommits.length}`,
      `- **Validation evidence entries**: ${validationEvidence.length}`,
      `- **Unresolved queue blockers**: ${unresolvedBlockers.length}`,
      "",
      "Treat this PR as an aggregate integration branch. Preserve per-PR lineage, document conflict-resolution decisions, and validate the queue head plus affected constituent areas.",
      "",
    );
    if (unresolvedBlockers.length > 0) {
      parts.push("### Queue Blockers", "");
      for (const blockerRaw of unresolvedBlockers) {
        parts.push(
          `- **${mergeBlockerKindLabel(blockerRaw)}** (${mergeBlockerStatusLabel(blockerRaw)}): ${mergeBlockerSummaryLabel(blockerRaw)}`,
        );
      }
      parts.push("");
    }
  }

  const conflictInfo = prContextConflicts(prContext);
  if (hasActiveMergeConflicts(conflictInfo)) {
    const conflictingFiles = normalizeMergeConflictEvidence(conflictInfo).listed_files;
    parts.push(
      "## ⚠️ Merge Conflicts Detected",
      "",
      `This PR has merge conflicts with ${baseBranch}. You MUST resolve these conflicts:`,
      "",
    );
    for (const file of conflictingFiles) {
      parts.push(`- \`${file}\``);
    }
    parts.push("");
  }

  const ciStatus = prContextCiStatus(prContext);
  const ciCounts = normalizeCiStatusCounts(ciStatus);
  if (ciCounts.total > 0) {
    parts.push(
      "## CI/CD Status",
      "",
      `- **Total checks**: ${ciCounts.total}`,
      `- **Passed**: ✅ ${ciCounts.passed}`,
      `- **Failed**: ❌ ${ciCounts.failed}`,
      `- **Pending**: ⏳ ${ciCounts.pending}`,
      `- **Skipped**: ⏭️ ${ciCounts.skipped}`,
      "",
    );

    const failedChecks = ciFailedChecks(ciStatus);
    if (failedChecks.length > 0) {
      parts.push("### Failed Checks (MUST FIX)", "");
      for (const checkRaw of failedChecks) {
        const check = recordValue(checkRaw);
        parts.push(`- **${ciCheckName(checkRaw)}**: ${ciCheckStatusLabel(checkRaw)}`);
        const detailsUrl = normalizeCiCheckDetailsUrl(check);
        if (detailsUrl) {
          parts.push(`  - Details: ${detailsUrl}`);
        }
      }
      parts.push("");
    }
  }

  const reviewDecision = normalizeReviewDecision(prDetailsReviewDecision(prDetails));
  if (reviewDecision) {
    const emoji =
      reviewDecision === "APPROVED"
        ? "✅"
        : reviewDecision === "CHANGES_REQUESTED"
          ? "⚠️"
          : "⏳";
    parts.push("## Review Status", "", `${emoji} **${reviewDecision}**`, "");
  }

  const reviewComments = prContextReviewComments(prContext);
  if (reviewComments.length > 0) {
    parts.push(
      "## Code Review Comments (MUST ADDRESS)",
      "",
      "These are inline code review comments that require your attention:",
      "",
    );
    let i = 1;
    for (const commentRaw of reviewComments.slice(0, 20)) {
      const commentAuthor = commentAuthorLogin(commentRaw);
      const body = commentBody(commentRaw);
      const path = commentPath(commentRaw);
      const line = commentLine(commentRaw);
      parts.push(
        `### Review Comment ${i}`,
        `**File**: \`${path}\` (line ${line})`,
        `**Author**: ${commentAuthor}`,
        "",
        body,
        "",
      );
      i++;
    }
  }

  const comments = prContextComments(prContext)
    .filter((commentRaw) => !isReviewGateCacheBody(commentBody(commentRaw)));
  if (comments.length > 0) {
    parts.push("## Discussion Comments", "");
    let i = 1;
    for (const commentRaw of comments.slice(-10)) {
      const commentAuthor = commentAuthorLogin(commentRaw);
      const body = commentBody(commentRaw);
      parts.push(`### Comment ${i}`, `**Author**: ${commentAuthor}`, "", body, "");
      i++;
    }
  }

  const changedFilesList = prContextFiles(prContext);
  if (changedFilesList.length > 0) {
    parts.push("## Changed Files", "");
    for (const fileRaw of changedFilesList.slice(0, 50)) {
      const filename = changedFilePath(fileRaw);
      const status = changedFileStatus(fileRaw);
      const fileAdditions = changedFileAdditions(fileRaw);
      const fileDeletions = changedFileDeletions(fileRaw);
      parts.push(`- ${fileStatusEmoji(status)} \`${filename}\` (+${fileAdditions}/-${fileDeletions})`);
    }
    parts.push("");
  }

  const commits = prContextCommits(prContext);
  if (commits.length > 0) {
    parts.push("## Commit History", "");
    for (const commitRaw of commits.slice(-10)) {
      const message = commitMessageHeadline(commitRaw);
      const sha = commitIdentifier(commitRaw);
      const shortSha = sha.length >= 7 ? sha.slice(0, 7) : sha ? sha : "unknown";
      parts.push(`- \`${shortSha}\` ${message}`);
    }
    parts.push("");
  }

  parts.push("---", "", "## Your Mission", "", `**Working on**: ${title}`, "");

  if (body) {
    const descriptionLines = body.trim().split("\n");
    const summary = descriptionLines[0] ?? body.slice(0, 500);
    parts.push(`**Purpose**: ${summary}`, "");
  }

  parts.push("Get this PR merged successfully by completing ALL of the following:", "");

  const tasks: string[] = [];
  if (hasActiveMergeConflicts(conflictInfo)) {
    tasks.push("1. **RESOLVE MERGE CONFLICTS** - This is CRITICAL and must be done first");
  }

  let taskNum = tasks.length + 1;
  tasks.push(`${taskNum}. Checkout the PR branch: \`${headBranch}\``);
  tasks.push(`${taskNum + 1}. Sync with \`${baseBranch}\` using a merge commit; do not rebase unless repository rules explicitly require it`);
  taskNum += 2;

  if (reviewComments.length > 0) {
    tasks.push(
      `${taskNum}. Address ALL ${reviewComments.length} code review comments with appropriate changes`,
    );
    taskNum++;
  }

  if (ciCounts.failed > 0) {
    tasks.push(`${taskNum}. Fix ALL ${ciCounts.failed} failing CI checks`);
    taskNum++;
  }

  tasks.push(`${taskNum}. Run tests and checks locally to verify everything passes`);
  tasks.push(`${taskNum + 1}. Push changes back to \`${headBranch}\``);
  tasks.push(`${taskNum + 2}. Verify CI passes on GitHub after pushing`);

  parts.push(...tasks);
  parts.push("");

  if (guidelines) {
    parts.push(
      "## Project Guidelines",
      "",
      "Follow these PR and contribution guidelines:",
      "",
      "```",
      guidelines,
      "```",
      "",
    );
  } else if (commitExamples) {
    parts.push(
      "## Commit Style Examples",
      "",
      "No explicit guidelines found. Follow the style of recent commits:",
      "",
      "```",
      commitExamples,
      "```",
      "",
    );
  }

  if (mergeRules) {
    parts.push("## Merge Rules", "", mergeRules, "");
  }

  parts.push(
    "## Critical Rules",
    "",
    "- ❌ **NO assistant branding** in commits, comments, or code",
    "- ✅ Write clear, professional commit messages matching project style",
    "- ✅ Make focused, minimal changes addressing specific issues only",
    "- ✅ Prefer merge commits over rebasing so original commit hashes and stack ordering are preserved",
    "- ✅ Test thoroughly before pushing",
    "- ✅ Respond to review comments on GitHub when appropriate",
    "- ✅ If blocked, clearly document the issue and what's needed",
    "- ✅ Open a separate remediation PR only when there is concrete signal and project-doc grounding",
    "- ✅ For remediation PRs, cite signal refs such as CI logs, failing command output, review comments, issue text, stack traces, or repro artifacts",
    "- ✅ For remediation PRs, cite grounding refs from AGENTS.md, docs/, .merge-rules.yaml, or referenced Workflow-IR",
    "",
    "## Execution",
    "",
    "Work autonomously through all tasks. Report progress and any blockers.",
    "",
  );

  return parts.join("\n");
}

/** Build a code review prompt for targeted improvements (second agent pass). */
export function buildReviewPrompt(
  prNumber: number,
  title: string,
  headBranch: string,
  url: string,
  diff: string,
  changedFiles: Record<string, unknown>[],
  mergeRules = "",
): string {
  const parts: string[] = [
    `# Code Review: PR #${prNumber} - ${title}`,
    "",
    `**Branch**: ${headBranch}`,
    `**URL**: ${url}`,
    "",
    "## Your Mission: Code Review and Targeted Improvements",
    "",
    "You are conducting a thorough code review of this PR. Your goal is to:",
    "",
    "1. **Review all code changes** for quality, correctness, and best practices",
    "2. **Identify issues** such as:",
    "   - Bugs or logical errors",
    "   - Security vulnerabilities",
    "   - Performance issues",
    "   - Code duplication",
    "   - Poor error handling",
    "   - Missing edge case handling",
    "   - Inconsistent coding style",
    "   - Missing or inadequate tests",
    "   - Unclear or missing documentation",
    "3. **Make targeted improvements** to fix identified issues",
    "4. **Commit your improvements** with clear, descriptive messages",
    "",
    "## Changed Files",
    "",
  ];

  for (const file of changedFiles.slice(0, 50)) {
    const filename = changedFilePath(file);
    const additions = changedFileAdditions(file);
    const deletions = changedFileDeletions(file);
    const status = changedFileStatus(file);
    parts.push(`- ${fileStatusEmoji(status)} \`${filename}\` (+${additions}/-${deletions})`);
  }

  const truncatedDiff = diff.length > 100000 ? diff.slice(0, 100000) : diff;

  parts.push(
    "",
    "## Full Diff",
    "",
    "Below is the complete diff of all changes in this PR. Review each change carefully:",
    "",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "## Review Guidelines",
    "",
    "### Code Quality Checks",
    "- ✅ **Correctness**: Does the code do what it's supposed to do?",
    "- ✅ **Error Handling**: Are errors handled gracefully?",
    "- ✅ **Edge Cases**: Are boundary conditions and edge cases handled?",
    "- ✅ **Resource Management**: Are resources (files, connections, etc.) properly managed?",
    "- ✅ **Type Safety**: Are types used correctly? Any type errors?",
    "",
    "### Security Checks",
    "- 🔒 **Input Validation**: Is user input properly validated?",
    "- 🔒 **SQL Injection**: Are queries parameterized?",
    "- 🔒 **XSS**: Is output properly escaped?",
    "- 🔒 **Authentication/Authorization**: Are permissions checked?",
    "- 🔒 **Secrets**: Are there any hardcoded secrets or credentials?",
    "",
    "### Performance Checks",
    "- ⚡ **Algorithmic Efficiency**: Are algorithms efficient?",
    "- ⚡ **Database Queries**: Are queries optimized? N+1 queries?",
    "- ⚡ **Memory Usage**: Any memory leaks or excessive allocations?",
    "- ⚡ **Caching**: Should results be cached?",
    "",
    "### Best Practices",
    "- 📚 **DRY**: Is code duplicated? Can it be refactored?",
    "- 📚 **SOLID**: Does code follow SOLID principles?",
    "- 📚 **Naming**: Are variables and functions clearly named?",
    "- 📚 **Comments**: Are complex sections documented?",
    "- 📚 **Tests**: Are tests adequate? Missing test cases?",
    "",
    "## Making Improvements",
    "",
    "For each issue you identify:",
    "",
    "1. **Fix it directly** - Make the code changes",
    "2. **Write clear commits** - Explain what you fixed and why",
    "3. **Run tests** - Ensure your changes don't break anything",
    "4. **Be surgical** - Make focused, minimal changes",
    "",
    "### Commit Message Format",
    "",
    "Use clear, descriptive commit messages:",
    "",
    "```",
    "Fix: [brief description]",
    "",
    "[Detailed explanation of what was wrong and how you fixed it]",
    "```",
    "",
    "Examples:",
    "- `Fix: Add input validation to prevent SQL injection in user search`",
    "- `Refactor: Extract duplicate error handling into helper function`",
    "- `Performance: Add caching to reduce redundant API calls`",
    "- `Security: Remove hardcoded API key, use environment variable`",
    "",
    "## Critical Rules",
    "",
    "- ❌ **NO assistant branding** in commits or comments",
    "- ✅ **Be thorough** but don't over-engineer",
    "- ✅ **Preserve intent** - don't change functionality unless it's wrong",
    "- ✅ **Test your changes** before committing",
    "- ✅ **If unsure**, skip that change and document why",
    "",
    "## Execution",
    "",
    "Review the diff systematically. For each file:",
    "1. Understand what the code does",
    "2. Look for issues based on guidelines above",
    "3. Make improvements where needed",
    "4. Commit with clear messages",
    "",
    "Focus on high-impact improvements. Don't waste time on trivial style issues.",
    "",
  );

  if (mergeRules) {
    parts.push("## Merge Rules", "", mergeRules, "");
  }

  return parts.join("\n");
}

export function buildIssuePrompt(input: {
  issueNumber: number;
  title: string;
  url: string;
  body: string;
  branchName: string;
  defaultBranch: string;
  guidelines: string;
  commitExamples: string;
  mergeRules: string;
}): string {
  const description = input.body ? input.body : "No description provided";
  const guidelinesText = input.guidelines ? input.guidelines : "No specific guidelines available";
  const examplesText = input.commitExamples ? input.commitExamples : "No examples available";
  const mergeRulesText = input.mergeRules ? input.mergeRules : "No repo-local merge rules found";

  return [
    "# Issue Implementation Task",
    "",
    "You are tasked with implementing a GitHub issue in this repository.",
    "",
    "## Issue Details",
    "",
    `**Issue Number:** #${input.issueNumber}`,
    `**Title:** ${input.title}`,
    `**URL:** ${input.url}`,
    "",
    "**Description:**",
    description,
    "",
    "## Your Task",
    "",
    "1. **Implement the feature or fix described in the issue**",
    "   - Read and understand the issue requirements carefully",
    "   - Implement the solution following best practices",
    "   - Ensure code quality, security, and performance",
    "",
    "2. **Write tests for your implementation**",
    "   - Add appropriate unit tests",
    "   - Ensure existing tests still pass",
    "",
    "3. **Commit your changes**",
    "   - Make focused, logical commits",
    "   - Write clear commit messages following project conventions",
    `   - Reference the issue in commits (e.g., "Fixes #${input.issueNumber}")`,
    "",
    "4. **Create a pull request**",
    `   - Use: \`gh pr create --fill --head ${input.branchName} --base ${input.defaultBranch}\``,
    `   - Link to the issue in PR description (use "Closes #${input.issueNumber}")`,
    "   - Request any necessary reviews",
    "",
    "## Project Guidelines",
    "",
    guidelinesText,
    "",
    "## Merge Rules",
    "",
    mergeRulesText,
    "",
    "## Commit Message Examples",
    "",
    examplesText,
    "",
    "## Important Notes",
    "",
    `- You are currently on branch: \`${input.branchName}\``,
    `- Base branch: \`${input.defaultBranch}\``,
    `- This implementation should close issue #${input.issueNumber}`,
    "- Focus on completing the requirements in the issue",
    "- Open a separate remediation PR only when there is concrete signal and project-doc grounding",
    "- For remediation PRs, cite signal refs such as CI logs, failing command output, review comments, issue text, stack traces, or repro artifacts",
    "- For remediation PRs, cite grounding refs from AGENTS.md, docs/, .merge-rules.yaml, or referenced Workflow-IR",
    "- Ask questions if requirements are unclear",
    "- Test thoroughly before creating the PR",
    "",
    "Begin implementing the issue now.",
    "",
  ].join("\n");
}
