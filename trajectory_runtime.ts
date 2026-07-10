/**
 * Runtime workflows built on top of the durable trajectory domain.
 *
 * AppStore owns persistence. This module owns product-level workflow structure:
 * named workflow definitions and the operations that start, complete, and
 * inspect a workflow run.
 */

import { randomUUID } from "node:crypto";
import { remediationPolicyDecisionFromValue } from "./remediation_policy_model";
import type { AppStore } from "./app_store";
import { runPiAgent, type AgentObservation, type CoordinationTrajectoryBridge, type PiAgentResult, type WorkItem } from "./coordination";
import type { GitOpsObserver } from "./git_ops";
import { recordPromptRendered } from "./telemetry";
import type {
  ActivityClaim,
  ActivityType,
  ChildActivityInput,
  CompatibilityTrajectoryIds,
  CompatibilityTrajectoryInput,
  EmbarkCohortTrajectoryIds,
  EmbarkCohortTrajectoryInput,
  JsonObject,
  ModelTier,
  PrQueueTrajectoryIds,
  PrQueueTrajectoryInput,
  ProposedNextActionInput,
  TrajectoryState,
} from "./trajectory";

export interface RuntimeWorkflowDefinition {
  id: string;
  version: string;
  kind: string;
  description: string;
  initial_phase: string;
  activity_type: string;
}

export const ONE_SHOT_PR_AGENT_WORKFLOW: RuntimeWorkflowDefinition = {
  id: "workflow://merge-god/one-shot-pr-agent",
  version: "v1",
  kind: "pr_agent_compatibility",
  description: "Compatibility workflow for the current single-PR agent invocation path.",
  initial_phase: "agent_processing",
  activity_type: "review_or_merge_gate",
};

export const PR_QUEUE_WORKFLOW: RuntimeWorkflowDefinition = {
  id: "workflow://merge-god/pr-queue",
  version: "v1",
  kind: "pr_queue",
  description: "Durable multi-PR queue workflow with deterministic activity claiming.",
  initial_phase: "queue_ready",
  activity_type: "queued_pr_activity",
};

export const EMBARK_COHORT_WORKFLOW: RuntimeWorkflowDefinition = {
  id: "workflow://merge-god/embark-cohort",
  version: "v1",
  kind: "embark_cohort",
  description: "Durable multi-PR embark cohort for grouped merge-commit validation.",
  initial_phase: "embark_cohort_ready",
  activity_type: "cohort_merge_gate",
};

export interface RuntimeStartResult {
  workflow: RuntimeWorkflowDefinition;
  ids: CompatibilityTrajectoryIds;
  state: TrajectoryState;
}

export interface QueueStartResult {
  workflow: RuntimeWorkflowDefinition;
  ids: PrQueueTrajectoryIds;
  state: TrajectoryState;
}

export interface EmbarkStartResult {
  workflow: RuntimeWorkflowDefinition;
  ids: EmbarkCohortTrajectoryIds;
  state: TrajectoryState;
}

export interface RuntimeCompletion {
  success: boolean;
  summary?: string | null;
  error_message?: string | null;
}

export interface GuardrailResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    summary: string;
  }>;
}

export interface RunNextActivityOptions {
  repo_path: string;
  timeout?: number;
  model?: string | null;
  git_observer?: GitOpsObserver;
  agent_observer?: (observation: AgentObservation) => void;
  build_prompt?: (claim: ActivityClaim, state: TrajectoryState) => string;
}

export interface RunNextActivityResult {
  claim: ActivityClaim | null;
  guardrails: GuardrailResult | null;
  pi_result: PiAgentResult | null;
  completed: boolean;
}

export interface ModelControlResult {
  accepted: boolean;
  reason?: string;
  event_id?: string;
  child_activity_id?: string;
}

interface ModelChildActivityInput {
  type: string;
  summary: string;
  model_tier?: string;
  model_reason?: string;
  prompt_runtime_ref?: string | null;
  context_pack_refs?: string[];
  evidence_refs?: string[];
  metadata?: JsonObject;
}

export class TrajectoryRuntime {
  private readonly store: AppStore;

  constructor(store: AppStore) {
    this.store = store;
  }

  startPrAgentWorkflow(input: CompatibilityTrajectoryInput): RuntimeStartResult {
    const ids = this.store.createCompatibilityTrajectoryForPr(input);
    this.store.appendTrajectoryEvent(
      ids.run_id,
      "runtime.workflow.started",
      "merge-god-runtime",
      {
        workflow_id: ONE_SHOT_PR_AGENT_WORKFLOW.id,
        workflow_version: ONE_SHOT_PR_AGENT_WORKFLOW.version,
      },
      {
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: ids.activity_session_id,
      },
    );

    const state = this.store.getTrajectoryState(ids.run_id);
    if (!state) {
      throw new Error(`Trajectory state was not persisted for run ${ids.run_id}`);
    }
    return { workflow: ONE_SHOT_PR_AGENT_WORKFLOW, ids, state };
  }

  startPrQueueWorkflow(input: PrQueueTrajectoryInput): QueueStartResult {
    const ids = this.store.createPrQueueTrajectory(input);
    this.store.appendTrajectoryEvent(
      ids.run_id,
      "runtime.workflow.started",
      "merge-god-runtime",
      {
        workflow_id: PR_QUEUE_WORKFLOW.id,
        workflow_version: PR_QUEUE_WORKFLOW.version,
        item_count: ids.work_item_ids.length,
      },
      {
        workset_id: ids.workset_id,
      },
    );

    const state = this.store.getTrajectoryState(ids.run_id);
    if (!state) {
      throw new Error(`Trajectory state was not persisted for run ${ids.run_id}`);
    }
    return { workflow: PR_QUEUE_WORKFLOW, ids, state };
  }

  startEmbarkCohortWorkflow(input: EmbarkCohortTrajectoryInput): EmbarkStartResult {
    const ids = this.store.createEmbarkCohortTrajectory(input);
    this.store.appendTrajectoryEvent(
      ids.run_id,
      "runtime.workflow.started",
      "merge-god-runtime",
      {
        workflow_id: EMBARK_COHORT_WORKFLOW.id,
        workflow_version: EMBARK_COHORT_WORKFLOW.version,
        item_count: ids.work_item_ids.length,
        group_activity_id: ids.group_activity_id,
      },
      {
        workset_id: ids.workset_id,
        activity_id: ids.group_activity_id,
      },
    );

    const state = this.store.getTrajectoryState(ids.run_id);
    if (!state) {
      throw new Error(`Trajectory state was not persisted for run ${ids.run_id}`);
    }
    return { workflow: EMBARK_COHORT_WORKFLOW, ids, state };
  }

  claimNextActivity(runId: string): ActivityClaim | null {
    const claim = this.store.claimNextActivity(runId);
    if (claim) {
      this.store.appendTrajectoryEvent(
        claim.ids.run_id,
        "runtime.activity.claimed",
        "merge-god-runtime",
        {
          workflow_id: PR_QUEUE_WORKFLOW.id,
          activity_type: claim.activity.type,
          pr_number: claim.work_item?.number ?? null,
        },
        {
          workset_id: claim.ids.workset_id,
          work_item_id: claim.ids.work_item_id,
          activity_id: claim.ids.activity_id,
        },
      );
    }
    return claim;
  }

  evaluateActivityGuardrails(claim: ActivityClaim): GuardrailResult {
    const labels = new Set(claim.work_item?.labels ?? []);
    const mode = claim.work_item?.mode ?? null;
    const isChildActivity = claim.activity.parent_activity_id !== null;
    const remediationPolicy = remediationPolicyDecisionFromValue(
      claim.work_item?.risk_signals["remediation_policy"],
    );
    const checks = [
      {
        name: "label_contract",
        passed: labels.has("for-review") || labels.has("for-landing"),
        summary: "Work item must carry for-review or for-landing.",
      },
      {
        name: "activity_claimed",
        passed: claim.activity.status === "claimed",
        summary: "Activity must be claimed before a pi agent owns it.",
      },
      {
        name: "mode_activity_match",
        passed:
          isChildActivity ||
          (mode === "for-review" && claim.activity.type === "review_workflow") ||
          (mode === "for-landing" && claim.activity.type === "merge_gate"),
        summary: "Top-level activity type must match the work item's requested mode.",
      },
      {
        name: "remediation_policy",
        passed: remediationPolicy !== null && !remediationPolicy.blocked,
        summary: remediationPolicy === null
          ? "Work item must have a resolved remediation policy."
          : remediationPolicy.reasons.join(" "),
      },
      {
        name: "disposition_cap",
        passed: remediationPolicy?.budget.mutating_allowed === true,
        summary: remediationPolicy?.budget.mutating_allowed === true
          ? `${remediationPolicy.effective_mode} permits bounded mutation.`
          : `${remediationPolicy?.effective_mode ?? "unknown"} cannot be handed to a mutating pi activity.`,
      },
    ];
    const result = { passed: checks.every((check) => check.passed), checks };
    this.store.appendTrajectoryEvent(
      claim.ids.run_id,
      "guardrail.evaluated",
      "merge-god-runtime",
      result,
      {
        workset_id: claim.ids.workset_id,
        work_item_id: claim.ids.work_item_id,
        activity_id: claim.ids.activity_id,
      },
    );
    return result;
  }

  startClaimedActivity(
    claim: ActivityClaim,
    sessionId: string | null = randomUUID(),
    model: string | null = null,
  ): ActivityClaim {
    const ids = this.store.startClaimedActivity(claim.ids, sessionId, model);
    const state = this.store.getTrajectoryState(ids.run_id);
    const activity = state?.activities.find((item) => item.activity_id === ids.activity_id);
    const workItem = state?.work_items.find((item) => item.work_item_id === ids.work_item_id) ?? null;
    if (!activity) throw new Error(`Activity disappeared after start: ${ids.activity_id}`);
    return { ids, activity, work_item: workItem };
  }

  completeActivity(claim: ActivityClaim, completion: RuntimeCompletion): void {
    this.store.appendTrajectoryEvent(
      claim.ids.run_id,
      "runtime.activity.completing",
      "merge-god-runtime",
      {
        workflow_id: PR_QUEUE_WORKFLOW.id,
        success: completion.success,
      },
      {
        workset_id: claim.ids.workset_id,
        work_item_id: claim.ids.work_item_id,
        activity_id: claim.ids.activity_id,
        activity_session_id: claim.ids.activity_session_id,
      },
    );
    this.store.completeActivity(
      claim.ids,
      completion.success,
      completion.summary ?? null,
      completion.error_message ?? null,
    );
  }

  proposeNextAction(ids: CompatibilityTrajectoryIds, input: ProposedNextActionInput): ModelControlResult {
    const allowed = new Set([
      "continue",
      "request_context_refresh",
      "create_child_activity",
      "mark_blocked",
      "operator_handoff",
      "complete",
    ]);
    if (!allowed.has(input.next_action)) {
      return this.rejectModelControl(ids, "next_action.rejected", `Unsupported next_action: ${input.next_action}`);
    }
    if (!input.rationale.trim()) {
      return this.rejectModelControl(ids, "next_action.rejected", "rationale is required");
    }

    this.store.proposeNextAction(ids, input);
    return { accepted: true };
  }

  createChildActivity(ids: CompatibilityTrajectoryIds, input: ModelChildActivityInput): ModelControlResult {
    const state = this.getRunState(ids.run_id);
    const parent = state?.activities.find((activity) => activity.activity_id === ids.activity_id);
    if (!parent) {
      return this.rejectModelControl(ids, "activity.child_rejected", "parent activity was not found");
    }
    if (!["claimed", "running"].includes(parent.status)) {
      return this.rejectModelControl(
        ids,
        "activity.child_rejected",
        `parent activity must be claimed or running, got ${parent.status}`,
      );
    }

    if (!this.isActivityType(input.type)) {
      return this.rejectModelControl(ids, "activity.child_rejected", `unsupported activity type: ${input.type}`);
    }

    const allowedChildren = this.allowedChildActivityTypes(parent.type);
    if (!allowedChildren.has(input.type)) {
      return this.rejectModelControl(
        ids,
        "activity.child_rejected",
        `activity type ${input.type} is not allowed under ${parent.type}`,
      );
    }
    if (!input.summary.trim()) {
      return this.rejectModelControl(ids, "activity.child_rejected", "summary is required");
    }
    if (!this.isModelTier(input.model_tier)) {
      return this.rejectModelControl(
        ids,
        "activity.child_rejected",
        "model_tier is required and must be one of: fast, standard, high",
      );
    }
    if (!input.model_reason?.trim()) {
      return this.rejectModelControl(ids, "activity.child_rejected", "model_reason is required");
    }

    const childInput: ChildActivityInput = {
      ...input,
      type: input.type,
      model_tier: input.model_tier,
      model_reason: input.model_reason,
    };
    const childActivityId = this.store.createChildActivity(ids, childInput);
    return { accepted: true, child_activity_id: childActivityId };
  }

  async runNextActivityWithPi(
    runId: string,
    options: RunNextActivityOptions,
  ): Promise<RunNextActivityResult> {
    const claimed = this.claimNextActivity(runId);
    if (!claimed) {
      return { claim: null, guardrails: null, pi_result: null, completed: false };
    }

    const guardrails = this.evaluateActivityGuardrails(claimed);
    if (!guardrails.passed) {
      this.completeActivity(claimed, {
        success: false,
        summary: "Guardrail evaluation failed before pi launch",
        error_message: JSON.stringify(guardrails.checks.filter((check) => !check.passed)),
      });
      return { claim: claimed, guardrails, pi_result: null, completed: true };
    }

    const started = this.startClaimedActivity(claimed, randomUUID(), options.model ?? null);
    const state = this.getRunState(runId);
    if (!state) throw new Error(`Missing trajectory state for run ${runId}`);

    const prompt = options.build_prompt
      ? options.build_prompt(started, state)
      : this.defaultActivityPrompt(started, state);
    recordPromptRendered("trajectory_activity", prompt, {
      "merge_god.run_id": runId,
      "merge_god.activity_id": started.ids.activity_id,
      "merge_god.activity_type": started.activity.type,
      "merge_god.pr_number": started.work_item?.number,
    });
    const modelTier = this.activityModelProfileValue(started.activity, "model_tier");
    const modelReason = this.activityModelProfileValue(started.activity, "model_reason");
    const workItem: WorkItem = {
      kind: "trajectory_activity",
      repo: state.run.repo_name,
      repo_path: options.repo_path,
      pr_number: started.work_item?.number,
      mode: started.work_item?.mode ?? undefined,
      title: started.work_item?.title,
      prompt,
      model_tier: modelTier ?? undefined,
      model_reason: modelReason ?? undefined,
      trajectory_refs: started.ids,
    };

    const piResult = await runPiAgent(workItem, options.repo_path, {
      timeout: options.timeout,
      trajectory: this.bridgeForPiAgent(started.ids),
      gitObserver: options.git_observer,
      agentObserver: options.agent_observer,
    });
    const resultStatus = typeof piResult.result?.["status"] === "string" ? piResult.result["status"] : null;
    const success = piResult.returncode === 0 && resultStatus === "success";
    const summary = typeof piResult.result?.["summary"] === "string"
      ? piResult.result["summary"]
      : `pi exited with code ${piResult.returncode}`;
    const errorMessage = success
      ? null
      : (typeof piResult.result?.["error"] === "string" ? piResult.result["error"] : piResult.stderr);
    this.completeActivity(started, { success, summary, error_message: errorMessage });

    return { claim: started, guardrails, pi_result: piResult, completed: true };
  }

  completePrAgentWorkflow(ids: CompatibilityTrajectoryIds, completion: RuntimeCompletion): void {
    this.store.appendTrajectoryEvent(
      ids.run_id,
      "runtime.workflow.completing",
      "merge-god-runtime",
      {
        workflow_id: ONE_SHOT_PR_AGENT_WORKFLOW.id,
        success: completion.success,
      },
      {
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: ids.activity_session_id,
      },
    );
    this.store.completeCompatibilityTrajectory(
      ids,
      completion.success,
      completion.summary ?? null,
      completion.error_message ?? null,
    );
  }

  appendWorkflowEvent(
    ids: CompatibilityTrajectoryIds,
    eventType: string,
    payload: JsonObject = {},
    actor = "merge-god-runtime",
  ): string {
    return this.store.appendTrajectoryEvent(ids.run_id, eventType, actor, payload, {
      workset_id: ids.workset_id,
      work_item_id: ids.work_item_id,
      activity_id: ids.activity_id,
      activity_session_id: ids.activity_session_id,
    });
  }

  getRunState(runId: string): TrajectoryState | null {
    return this.store.getTrajectoryState(runId);
  }

  private defaultActivityPrompt(claim: ActivityClaim, state: TrajectoryState): string {
    const item = claim.work_item;
    return [
      "# Merge God Trajectory Activity",
      "",
      `Run: ${state.run.run_id}`,
      `Activity: ${claim.activity.activity_id} (${claim.activity.type})`,
      item ? `PR: #${item.number} ${item.title}` : "PR: unknown",
      item?.mode ? `Mode: ${item.mode}` : null,
      this.activityModelProfileValue(claim.activity, "model_tier")
        ? `Model tier: ${this.activityModelProfileValue(claim.activity, "model_tier")}`
        : null,
      this.activityModelProfileValue(claim.activity, "model_reason")
        ? `Model reason: ${this.activityModelProfileValue(claim.activity, "model_reason")}`
        : null,
      "",
      "Use merge_god_trajectory_state to inspect durable state.",
      "Use merge_god_trajectory_event for checkpoints, decisions, blockers, and evidence.",
      "Complete only the scoped activity assigned here.",
    ].filter((line): line is string => line !== null).join("\n");
  }

  bridgeForPiAgent(ids: CompatibilityTrajectoryIds): CoordinationTrajectoryBridge {
    return {
      getState: () => this.getRunState(ids.run_id),
      appendEvent: (input) => {
        const payload = input.payload ?? {};
        return {
          event_id: this.appendWorkflowEvent(
            ids,
            input.event_type,
            {
              ...payload,
              refs: input.refs ?? {},
            },
            input.actor ?? "pi-agent",
          ),
        };
      },
      heartbeat: (input) => {
        const eventId = this.appendWorkflowEvent(
          ids,
          "runtime.workflow.heartbeat",
          {
            phase: input["phase"] ?? null,
          },
          "pi-agent",
        );
        return { event_id: eventId };
      },
      proposeNext: (input) => this.proposeNextAction(ids, {
        next_action: input.next_action,
        rationale: input.rationale,
        blockers: input.blockers,
        evidence_refs: input.evidence_refs,
      }),
      createChildActivity: (input) => this.createChildActivity(ids, input),
    };
  }

  private allowedChildActivityTypes(parentType: ActivityType): Set<ActivityType> {
    const common: ActivityType[] = ["semantic_summary", "operator_handoff"];
    const byParent: Partial<Record<ActivityType, ActivityType[]>> = {
      review_workflow: ["ci_diagnosis", "ci_fix", "conflict_resolution", "merge_gate", ...common],
      merge_gate: ["ci_diagnosis", "ci_fix", "semantic_summary", "operator_handoff"],
      ci_diagnosis: ["ci_fix", "semantic_summary", "operator_handoff"],
      conflict_resolution: ["ci_diagnosis", "merge_gate", "semantic_summary", "operator_handoff"],
      planning: ["review_workflow", "merge_gate", "salvage_planning", "embark_planning", ...common],
    };
    return new Set(byParent[parentType] ?? common);
  }

  private isActivityType(type: string): type is ActivityType {
    return [
      "survey",
      "triage",
      "planning",
      "review_workflow",
      "merge_gate",
      "conflict_resolution",
      "ci_diagnosis",
      "ci_fix",
      "salvage_planning",
      "embark_planning",
      "semantic_summary",
      "operator_handoff",
    ].includes(type);
  }

  private isModelTier(tier: unknown): tier is ModelTier {
    return tier === "fast" || tier === "standard" || tier === "high";
  }

  private activityModelProfileValue(activity: ActivityClaim["activity"], key: string): string | null {
    const value = activity.model_profile[key];
    return typeof value === "string" && value.trim() ? value : null;
  }

  private rejectModelControl(
    ids: CompatibilityTrajectoryIds,
    eventType: string,
    reason: string,
  ): ModelControlResult {
    const eventId = this.appendWorkflowEvent(
      ids,
      eventType,
      { accepted: false, reason },
      "merge-god-runtime",
    );
    return { accepted: false, reason, event_id: eventId };
  }
}
