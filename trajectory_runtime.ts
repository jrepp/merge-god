/**
 * Runtime workflows built on top of the durable trajectory domain.
 *
 * AppStore owns persistence. This module owns product-level workflow structure:
 * named workflow definitions and the operations that start, complete, and
 * inspect a workflow run.
 */

import type { AppStore } from "./app_store";
import type {
  CompatibilityTrajectoryIds,
  CompatibilityTrajectoryInput,
  JsonObject,
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

export interface RuntimeStartResult {
  workflow: RuntimeWorkflowDefinition;
  ids: CompatibilityTrajectoryIds;
  state: TrajectoryState;
}

export interface RuntimeCompletion {
  success: boolean;
  summary?: string | null;
  error_message?: string | null;
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
}
