/**
 * Verifies that every core module imports cleanly and exposes its expected
 * public symbols. Each module is imported dynamically inside its own test so
 * that a failure is reported per-module rather than failing the whole file.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("module imports", () => {
  test("models (re-exported from the library) imports successfully", async () => {
    const mod = await import("../models");
    assert.ok(mod.createBranch, "expected createBranch export");
    assert.ok(mod.BranchStatus, "expected BranchStatus export");
    assert.ok(mod.PRState, "expected PRState export");
    assert.ok(mod.CIStatus, "expected CIStatus export");
  });

  test("@merge-god/github-sync imports successfully", async () => {
    const mod = await import("@merge-god/github-sync");
    assert.ok(mod.SyncStore, "expected SyncStore export");
    assert.ok(mod.SyncEngine, "expected SyncEngine export");
    assert.ok(mod.createForge, "expected createForge export");
    assert.ok(mod.GitClient, "expected GitClient export");
    assert.ok(mod.GitHubForge, "expected GitHubForge export");
  });

  test("@merge-god/workflow-ir-core imports successfully", async () => {
    const mod = await import("@merge-god/workflow-ir-core");
    assert.ok(mod.WorkflowRuntime, "expected WorkflowRuntime export");
    assert.ok(mod.AdapterRegistry, "expected AdapterRegistry export");
    assert.ok(mod.MemoryWorkflowStore, "expected MemoryWorkflowStore export");
    assert.ok(mod.createMergeGodValidationLaneAdapter, "expected merge-god validation adapter export");
    assert.ok(mod.createMergeGodFinalGateAdapter, "expected merge-god final-gate adapter export");
  });

  test("app_store imports successfully", async () => {
    const mod = await import("../app_store");
    assert.ok(mod.AppStore, "expected AppStore export");
    assert.ok(mod.DatabaseError, "expected DatabaseError export");
  });

  test("trajectory runtime imports successfully", async () => {
    const mod = await import("../trajectory_runtime");
    assert.ok(mod.TrajectoryRuntime, "expected TrajectoryRuntime export");
    assert.ok(mod.ONE_SHOT_PR_AGENT_WORKFLOW, "expected workflow definition export");
  });

  test("git ops imports successfully", async () => {
    const mod = await import("../git_ops");
    assert.equal(typeof mod.GitOps, "function");
    assert.equal(typeof mod.GitOpsError, "function");
  });

  test("follow-up PR model imports successfully", async () => {
    const mod = await import("../follow_up_pr_model");
    assert.equal(typeof mod.normalizeFollowUpPrInput, "function");
    assert.equal(typeof mod.buildFollowUpPrBody, "function");
  });

  test("PR queue display model imports successfully", async () => {
    const mod = await import("../pr_queue_display_model");
    assert.equal(typeof mod.prQueueInfoFromRecord, "function");
    assert.equal(typeof mod.prQueueInfoFromPullRequest, "function");
  });

  test("dashboard event model imports successfully", async () => {
    const mod = await import("../dashboard_event_model");
    assert.equal(typeof mod.dashboardContextSummaryFromEvent, "function");
  });

  test("git ref imports successfully", async () => {
    const mod = await import("../git_ref");
    assert.equal(typeof mod.validateGitRef, "function");
  });

  test("command runner imports successfully", async () => {
    const mod = await import("../command_runner");
    assert.equal(typeof mod.createSpawnCommandRunner, "function");
  });

  test("collection access model imports successfully", async () => {
    const mod = await import("../collection_access_model");
    assert.equal(typeof mod.collectionItems, "function");
    assert.equal(typeof mod.recordCollectionItems, "function");
    assert.equal(typeof mod.firstPresentRecordCollection, "function");
  });

  test("conflict file access model imports successfully", async () => {
    const mod = await import("../conflict_file_access_model");
    assert.equal(typeof mod.conflictFileName, "function");
    assert.equal(typeof mod.recordConflictFiles, "function");
  });

  test("changed file model imports successfully", async () => {
    const mod = await import("../changed_file_model");
    assert.equal(typeof mod.changedFilePath, "function");
    assert.equal(typeof mod.changedFileStatus, "function");
  });

  test("commit access model imports successfully", async () => {
    const mod = await import("../commit_access_model");
    assert.equal(typeof mod.commitIdentifier, "function");
    assert.equal(typeof mod.commitMessageHeadline, "function");
  });

  test("link URL model imports successfully", async () => {
    const mod = await import("../link_url_model");
    assert.equal(typeof mod.recordLinkUrlCandidates, "function");
  });

  test("evidence ref access model imports successfully", async () => {
    const mod = await import("../evidence_ref_access_model");
    assert.equal(typeof mod.recordEvidenceRefs, "function");
  });

  test("CI status model imports successfully", async () => {
    const mod = await import("../ci_status_model");
    assert.equal(typeof mod.CI_STATUS_CHECK_SUMMARY_LIMIT, "number");
    assert.equal(typeof mod.analyzeCiStatus, "function");
    assert.equal(typeof mod.ciCheckName, "function");
    assert.equal(typeof mod.ciCheckStatusLabel, "function");
    assert.equal(typeof mod.ciStatusEvidenceDetails, "function");
  });

  test("conflict model imports successfully", async () => {
    const mod = await import("../conflict_model");
    assert.equal(typeof mod.ACTIVE_MERGE_CONFLICT_SUMMARY_FILE_LIMIT, "number");
    assert.equal(typeof mod.normalizeMergeConflictEvidence, "function");
    assert.equal(typeof mod.activeMergeConflictSummary, "function");
  });

  test("diff availability model imports successfully", async () => {
    const mod = await import("../diff_availability_model");
    assert.equal(typeof mod.diffAvailabilitySourceLabel, "function");
    assert.equal(typeof mod.diffAvailabilityStatus, "function");
    assert.equal(typeof mod.diffUnavailableReason, "function");
    assert.equal(typeof mod.diffAvailabilityEvidenceRefs, "function");
  });

  test("review decision model imports successfully", async () => {
    const mod = await import("../review_decision_model");
    assert.equal(typeof mod.normalizeReviewDecision, "function");
    assert.equal(typeof mod.reviewDecisionMergeBlocker, "function");
    assert.equal(typeof mod.reviewDecisionSignalStatus, "function");
  });

  test("review gate model imports successfully", async () => {
    const mod = await import("../review_gate_model");
    assert.equal(typeof mod.normalizeReviewGateStatus, "function");
  });

  test("merge state model imports successfully", async () => {
    const mod = await import("../merge_state_model");
    assert.equal(typeof mod.mergeStateBlockerFromDetails, "function");
    assert.equal(typeof mod.normalizeMergeStateStatus, "function");
    assert.equal(typeof mod.mergeStateStatusSignal, "function");
  });

  test("comment visibility model imports successfully", async () => {
    const mod = await import("../comment_visibility_model");
    assert.equal(typeof mod.commentVisibilityEvents, "function");
    assert.equal(typeof mod.visibleCommentLines, "function");
  });

  test("comment access model imports successfully", async () => {
    const mod = await import("../comment_access_model");
    assert.equal(typeof mod.commentAuthorLogin, "function");
    assert.equal(typeof mod.commentBody, "function");
    assert.equal(typeof mod.commentEvidenceRef, "function");
    assert.equal(typeof mod.commentLine, "function");
  });

  test("markdown table model imports successfully", async () => {
    const mod = await import("../markdown_table_model");
    assert.equal(typeof mod.sanitizeMarkdownTableCell, "function");
  });

  test("review gate evidence comment model imports successfully", async () => {
    const mod = await import("../review_gate_evidence_comment_model");
    assert.equal(typeof mod.EVIDENCE_REF_RENDER_LIMIT, "number");
    assert.equal(typeof mod.MERGE_BLOCKER_RENDER_LIMIT, "number");
    assert.equal(typeof mod.renderEvidenceSummaryRows, "function");
  });

  test("review gate comment model imports successfully", async () => {
    const mod = await import("../review_gate_comment_model");
    assert.equal(typeof mod.findOwnedReviewGateCacheCommentId, "function");
    assert.equal(typeof mod.planReviewGateCommentCommand, "function");
  });

  test("queue validation model imports successfully", async () => {
    const mod = await import("../queue_validation_model");
    assert.equal(typeof mod.extractQueueValidationEvidence, "function");
    assert.equal(typeof mod.prioritizedQueueValidationEvidence, "function");
    assert.equal(typeof mod.validationEvidenceByPrNumber, "function");
  });

  test("queue validation context model imports successfully", async () => {
    const mod = await import("../queue_validation_context_model");
    assert.equal(typeof mod.normalizeQueuePrSelfValidationEvidence, "function");
    assert.equal(typeof mod.sortQueueValidationCommentsChronologically, "function");
  });

  test("queue context summary model imports successfully", async () => {
    const mod = await import("../queue_context_summary_model");
    assert.equal(typeof mod.QUEUE_CONTEXT_SUMMARY_ROW_LIMIT, "number");
    assert.equal(typeof mod.queueConstituentPrSummary, "function");
    assert.equal(typeof mod.queueMergeCommitSummary, "function");
  });

  test("queue context access model imports successfully", async () => {
    const mod = await import("../queue_context_access_model");
    assert.equal(typeof mod.firstNormalizedQueueBoolean, "function");
    assert.equal(typeof mod.normalizeQueueBoolean, "function");
    assert.equal(typeof mod.queueContextConstituentPrs, "function");
    assert.equal(typeof mod.queueContextUnresolvedBlockers, "function");
    assert.equal(typeof mod.recognizedQueueStrategy, "function");
    assert.deepEqual(mod.QUEUE_CONTEXT_KEYS, ["queue_context", "queueContext", "merge_queue_context", "mergeQueueContext"]);
  });

  test("PR context access model imports successfully", async () => {
    const mod = await import("../pr_context_access_model");
    assert.equal(typeof mod.prContextCiStatus, "function");
    assert.equal(typeof mod.prContextConflicts, "function");
    assert.equal(typeof mod.prContextReviewComments, "function");
    assert.equal(typeof mod.prContextCommits, "function");
    assert.equal(typeof mod.prContextFiles, "function");
    assert.equal(typeof mod.prContextDiffText, "function");
    assert.equal(typeof mod.prContextHasDiffTextField, "function");
    assert.equal(typeof mod.evidenceSummaryFromContext, "function");
    assert.deepEqual(mod.PR_CONTEXT_COMMIT_KEYS, ["commits", "commitNodes", "commit_nodes", "commit_edges", "commitEdges"]);
    assert.deepEqual(mod.PR_CONTEXT_STATUS_CHECK_KEYS, [
      "status_check_rollup",
      "statusCheckRollup",
      "status_checks",
      "statusChecks",
    ]);
  });

  test("PR details access model imports successfully", async () => {
    const mod = await import("../pr_details_access_model");
    assert.equal(typeof mod.prDetailsAdditions, "function");
    assert.equal(typeof mod.prDetailsBaseBranch, "function");
    assert.equal(typeof mod.prDetailsChangedFiles, "function");
    assert.equal(typeof mod.prDetailsCommitCount, "function");
    assert.equal(typeof mod.prDetailsCreatedAt, "function");
    assert.equal(typeof mod.prDetailsDeletions, "function");
    assert.equal(typeof mod.prDetailsMergedAt, "function");
    assert.equal(typeof mod.prDetailsReviewDecision, "function");
    assert.equal(typeof mod.prDetailsIsDraft, "function");
    assert.equal(typeof mod.prDetailsStateText, "function");
    assert.equal(typeof mod.prDetailsUpdatedAt, "function");
  });

  test("queue blocker model imports successfully", async () => {
    const mod = await import("../queue_blocker_model");
    assert.equal(typeof mod.queueConstituentStatus, "function");
    assert.equal(typeof mod.queueScopedValidationBlockers, "function");
  });

  test("queue membership model imports successfully", async () => {
    const mod = await import("../queue_membership_model");
    assert.equal(typeof mod.extractConstituentHints, "function");
    assert.equal(typeof mod.parsePrNumbersFromQueueTitle, "function");
  });

  test("queue membership resolution model imports successfully", async () => {
    const mod = await import("../queue_membership_resolution_model");
    assert.equal(typeof mod.resolveQueueMembership, "function");
    assert.equal(typeof mod.buildQueueConstituentPrs, "function");
  });

  test("queue merge commit model imports successfully", async () => {
    const mod = await import("../queue_merge_commit_model");
    assert.equal(typeof mod.mergeCommitConflictFilesFromRecord, "function");
    assert.equal(typeof mod.modelQueueMergeCommits, "function");
    assert.equal(typeof mod.queueMergeCommitCandidates, "function");
  });

  test("queue validation summary model imports successfully", async () => {
    const mod = await import("../queue_validation_summary_model");
    assert.equal(typeof mod.QUEUE_VALIDATION_SUMMARY_ROW_LIMIT, "number");
    assert.equal(typeof mod.queueValidationEvidenceSummary, "function");
  });

  test("evidence ref model imports successfully", async () => {
    const mod = await import("../evidence_ref_model");
    assert.equal(typeof mod.collectEvidenceRefs, "function");
    assert.equal(typeof mod.EVIDENCE_REF_PRIORITY_SEED_LIMIT, "number");
  });

  test("PR context source imports successfully", async () => {
    const mod = await import("../pr_context_source");
    assert.equal(typeof mod.GhCliPullRequestContextSource, "function");
  });

  test("PR context gatherer imports successfully", async () => {
    const mod = await import("../pr_context_gatherer");
    assert.equal(typeof mod.analyzeCiStatus, "function");
    assert.equal(typeof mod.gatherPrContextFromSource, "function");
  });

  test("merge blocker model imports successfully", async () => {
    const mod = await import("../merge_blocker_model");
    assert.equal(typeof mod.aggregateMergeBlockerStatus, "function");
    assert.equal(typeof mod.MERGE_BLOCKER_EXPLANATION_LIMIT, "number");
    assert.equal(typeof mod.MERGE_BLOCKER_SUMMARY_LIMIT, "number");
    assert.equal(typeof mod.prioritizedMergeBlockers, "function");
    assert.equal(typeof mod.mergeBlockerSummary, "function");
  });

  test("manual gate model imports successfully", async () => {
    const mod = await import("../manual_gate_model");
    assert.equal(typeof mod.extractManualMergeGateBlockers, "function");
  });

  test("label gate model imports successfully", async () => {
    const mod = await import("../label_gate_model");
    assert.equal(typeof mod.extractLabelMergeGateBlockers, "function");
  });

  test("PR processor model imports successfully", async () => {
    const mod = await import("../pr_processor_model");
    assert.equal(typeof mod.buildPrAgentWorkItemPlan, "function");
    assert.equal(typeof mod.classifyPrAgentResult, "function");
    assert.equal(typeof mod.normalizePrProcessingInput, "function");
    assert.equal(typeof mod.prAgentResultFailureDetail, "function");
    assert.equal(typeof mod.prAgentResultStatus, "function");
  });

  test("PR prompt model imports successfully", async () => {
    const mod = await import("../pr_prompt");
    assert.equal(typeof mod.buildIssuePrompt, "function");
    assert.equal(typeof mod.buildPrPrompt, "function");
    assert.equal(typeof mod.buildReviewPrompt, "function");
  });

  test("PR snapshot model imports successfully", async () => {
    const mod = await import("../pr_snapshot_model");
    assert.equal(typeof mod.pullRequestSnapshotFromDetails, "function");
  });

  test("PR replay model imports successfully", async () => {
    const mod = await import("../pr_replay_model");
    assert.equal(typeof mod.replayPrContextSummary, "function");
    assert.equal(typeof mod.replayTrajectoryWorkItemFromContext, "function");
  });

  test("PR agent context model imports successfully", async () => {
    const mod = await import("../pr_agent_context_model");
    assert.equal(typeof mod.prAgentContextFromDict, "function");
  });

  test("agent gate summary model imports successfully", async () => {
    const mod = await import("../agent_gate_summary_model");
    assert.equal(typeof mod.agentGateSummarySection, "function");
  });

  test("PR context log model imports successfully", async () => {
    const mod = await import("../pr_context_log_model");
    assert.equal(typeof mod.prContextTelemetrySummary, "function");
  });

  test("PR context validation model imports successfully", async () => {
    const mod = await import("../pr_context_validation_model");
    assert.equal(typeof mod.validateAgentReplayContext, "function");
  });

  test("PR state model imports successfully", async () => {
    const mod = await import("../pr_state");
    assert.equal(typeof mod.activePrStateLabel, "function");
    assert.equal(typeof mod.prStateFromAgentDecision, "function");
    assert.equal(typeof mod.prStateLabel, "function");
    assert.equal(typeof mod.stalePrStateLabelNames, "function");
  });

  test("PR loop model imports successfully", async () => {
    const mod = await import("../pr_loop_model");
    assert.equal(typeof mod.categorizeOpenPrs, "function");
    assert.equal(typeof mod.categorizedPrNumbers, "function");
    assert.ok(mod.PR_STATE_LABELS, "expected PR state labels export");
  });

  test("merge PR model imports successfully", async () => {
    const mod = await import("../merge_pr_model");
    assert.equal(typeof mod.analyzeMergeBlockers, "function");
    assert.equal(typeof mod.inferMergeQueueContext, "function");
    assert.equal(typeof mod.mergeQueueContextFromPrDetailsAndContext, "function");
  });

  test("PR merge blocker model imports successfully", async () => {
    const mod = await import("../pr_merge_blocker_model");
    assert.equal(typeof mod.analyzePrMergeBlockers, "function");
    assert.equal(typeof mod.topLevelModeledMergeBlockers, "function");
    assert.equal(typeof mod.topLevelPrMergeBlockersForGate, "function");
  });

  test("evidence comment renderer imports successfully", async () => {
    const mod = await import("../evidence_comment");
    assert.equal(typeof mod.evidenceSummaryFromPrDetailsAndContext, "function");
    assert.equal(typeof mod.evidenceSummaryFromPrContext, "function");
    assert.equal(typeof mod.renderReviewGateStatusComment, "function");
  });

  test("review gate status projection imports successfully", async () => {
    const mod = await import("../review_gate_status");
    assert.equal(typeof mod.reviewGateStatusesFromContext, "function");
  });

  test("pr-loop imports successfully", async () => {
    const mod = await import("../pr-loop");
    assert.equal(typeof mod.validateGitRef, "function");
    assert.equal(typeof mod.updateReviewGateStatusCommentAsync, "function");
  });
});
