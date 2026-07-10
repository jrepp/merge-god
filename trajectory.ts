/**
 * Durable orchestration trajectory domain types.
 *
 * These types implement the first RFC-006 slice: storage-facing records for a
 * run, workset, work item, activity, activity session, and append-only events.
 * Forge/source snapshots still belong to @merge-god/github-sync.
 */

export type JsonObject = Record<string, unknown>;

export type OrchestrationRunStatus =
  | "created"
  | "surveying"
  | "planning"
  | "executing"
  | "waiting"
  | "completed"
  | "blocked"
  | "failed";

export type WorksetStatus = "draft" | "ready" | "active" | "paused" | "completed" | "blocked";

export type WorksetApprovalState = "not_required" | "pending" | "approved" | "rejected";

export type WorksetKind =
  | "pr_queue"
  | "review_batch"
  | "issue_batch"
  | "embark_cohort"
  | "salvage_candidate_set";

export type SourceKind = "pull_request" | "issue";

export type WorkItemStatus =
  | "queued"
  | "ready"
  | "syncing"
  | "conflicted"
  | "validating"
  | "validated"
  | "embarked"
  | "running"
  | "pushed"
  | "merged"
  | "closed"
  | "skipped"
  | "blocked"
  | "failed";

export type ActivityStatus =
  | "created"
  | "ready"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled";

export type ActivityType =
  | "survey"
  | "triage"
  | "planning"
  | "review_workflow"
  | "merge_gate"
  | "conflict_resolution"
  | "ci_diagnosis"
  | "ci_fix"
  | "salvage_planning"
  | "embark_planning"
  | "semantic_summary"
  | "operator_handoff";

export type ModelTier = "fast" | "standard" | "high";

export interface OrchestrationRunRecord {
  run_id: string;
  repo_name: string;
  repo_path: string | null;
  base_branch: string | null;
  strategy_version: string;
  workflow_ir_refs: string[];
  status: OrchestrationRunStatus;
  current_phase: string;
  started_at: string;
  heartbeat_at: string | null;
  completed_at: string | null;
  objective: string | null;
  operator_policy: JsonObject;
  model_policy: JsonObject;
  metadata: JsonObject;
}

export interface WorksetRecord {
  workset_id: string;
  run_id: string;
  kind: WorksetKind;
  selection_reason: string | null;
  status: WorksetStatus;
  approval_state: WorksetApprovalState;
  strategy: string | null;
  created_at: string;
  updated_at: string;
  metadata: JsonObject;
}

export interface WorkItemRecord {
  work_item_id: string;
  workset_id: string;
  source_kind: SourceKind;
  repo_name: string;
  number: number;
  title: string;
  url: string | null;
  mode: string | null;
  labels: string[];
  base_ref: string | null;
  head_ref: string | null;
  start_sha: string | null;
  current_sha: string | null;
  status: WorkItemStatus;
  disposition_setting: string | null;
  computed_disposition: string | null;
  priority: number | null;
  model_tier: string | null;
  next_action: string | null;
  blockers: JsonObject[];
  risk_signals: JsonObject;
  context_pack_refs: string[];
  created_at: string;
  updated_at: string;
  metadata: JsonObject;
}

export interface ActivityRecord {
  activity_id: string;
  run_id: string;
  workset_id: string | null;
  work_item_id: string | null;
  parent_activity_id: string | null;
  type: ActivityType;
  status: ActivityStatus;
  model_profile: JsonObject;
  tool_policy: JsonObject;
  prompt_runtime_ref: string | null;
  context_pack_refs: string[];
  output_summary_ref: string | null;
  evidence_refs: string[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata: JsonObject;
}

export interface ActivitySessionRecord {
  activity_session_id: string;
  activity_id: string;
  session_id: string | null;
  model: string | null;
  prompt_runtime_ref: string | null;
  prompt_hash: string | null;
  tool_set: string[];
  status: string;
  started_at: string;
  completed_at: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  output_digest: string | null;
  metadata: JsonObject;
}

export interface TrajectoryEventRecord {
  id: number;
  event_id: string;
  run_id: string;
  workset_id: string | null;
  work_item_id: string | null;
  activity_id: string | null;
  activity_session_id: string | null;
  event_type: string;
  actor: string;
  payload: JsonObject;
  created_at: string;
}

export interface CompatibilityTrajectoryInput {
  repo_name: string;
  pr_number: number;
  mode: string;
  repo_path?: string | null;
  title?: string | null;
  url?: string | null;
  labels?: string[];
  base_ref?: string | null;
  head_ref?: string | null;
  current_sha?: string | null;
  session_id?: string | null;
  model?: string | null;
  disposition_setting?: string | null;
  repository_remediation_mode?: string | null;
  risk_remediation_ceiling?: string | null;
  global_remediation_ceiling?: string | null;
  maintainer_approval_verified?: boolean;
}

export interface CompatibilityTrajectoryIds {
  run_id: string;
  workset_id: string;
  work_item_id: string;
  activity_id: string;
  activity_session_id: string | null;
}

export interface TrajectoryWorkItemInput {
  repo_name: string;
  number: number;
  title: string;
  url?: string | null;
  mode?: string | null;
  labels?: string[];
  base_ref?: string | null;
  head_ref?: string | null;
  current_sha?: string | null;
  priority?: number | null;
  model_tier?: string | null;
  disposition_setting?: string | null;
  risk_remediation_ceiling?: string | null;
  maintainer_approval_verified?: boolean;
}

export interface PrQueueTrajectoryInput {
  repo_name: string;
  repo_path?: string | null;
  base_branch?: string | null;
  objective?: string | null;
  strategy?: string | null;
  repository_remediation_mode?: string | null;
  global_remediation_ceiling?: string | null;
  items: TrajectoryWorkItemInput[];
}

export interface PrQueueTrajectoryIds {
  run_id: string;
  workset_id: string;
  work_item_ids: string[];
  activity_ids: string[];
}

export interface EmbarkCohortTrajectoryInput {
  repo_name: string;
  repo_path?: string | null;
  base_branch?: string | null;
  objective?: string | null;
  cohort_id?: string | null;
  integration_branch?: string | null;
  output_pr_number?: number | null;
  output_pr_url?: string | null;
  validation_commands?: string[];
  items: TrajectoryWorkItemInput[];
}

export interface EmbarkCohortTrajectoryIds {
  run_id: string;
  workset_id: string;
  work_item_ids: string[];
  group_activity_id: string;
}

export interface ActivityClaim {
  ids: CompatibilityTrajectoryIds;
  activity: ActivityRecord;
  work_item: WorkItemRecord | null;
}

export interface ProposedNextActionInput {
  next_action: string;
  rationale: string;
  blockers?: JsonObject[];
  evidence_refs?: string[];
}

export interface ChildActivityInput {
  type: ActivityType;
  summary: string;
  model_tier: ModelTier;
  model_reason: string;
  prompt_runtime_ref?: string | null;
  context_pack_refs?: string[];
  evidence_refs?: string[];
  metadata?: JsonObject;
}

export interface TrajectoryState {
  run: OrchestrationRunRecord;
  worksets: WorksetRecord[];
  work_items: WorkItemRecord[];
  activities: ActivityRecord[];
  activity_sessions: ActivitySessionRecord[];
  events: TrajectoryEventRecord[];
}
