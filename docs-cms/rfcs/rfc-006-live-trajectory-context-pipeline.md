---
title: Live Trajectory Context Pipeline
status: Draft
author: Engineering Team
created: 2026-06-28T00:00:00Z
tags: [context, design, merge-god, orchestration, rfc]
id: rfc-006
project_id: merge-god
doc_uuid: 163e964e-b774-42b0-8b5d-a3396b4dfadc
---

# Summary

Merge God currently has enough data to process one PR at a time, but it does
not yet have a durable model of the live orchestration trajectory. The current
implementation stores normalized PR snapshots in `@merge-god/github-sync`,
agent telemetry in `AppStore`, and transient work in the local coordination
server. This RFC proposes a durable trajectory layer that lets a model inspect
and organize the whole work set, create scoped review and remediation
activities, reuse prepared context packs, and resume a live session without
reconstructing state from chat history.

This layer does not replace WorkflowIR. WorkflowIR remains the declarative
workflow shape and prompt runtime contract. The trajectory layer stores runtime
state, evidence, model assignments, guardrail results, and periodically captured
context.

# Motivation

The next generation of Merge God needs to operate on a queue, not just a single
selected PR. RFC-004 defines the merge-planning workflow, and RFC-005 extends
that workflow with salvage and embark strategies. Both assume the system can
remember why work was selected, which evidence supported a gate decision, what
context a model saw, and how a later process can resume the operation.

Today those facts are spread across forge snapshots, application telemetry, the
local coordination server, and the model transcript. That is enough for
debugging one run after the fact, but it is not enough for durable
orchestration, replay, model evaluation, or a dashboard that explains live
progress.

This RFC proposes the missing runtime layer: a durable trajectory record that
organizes source snapshots, worksets, activities, context packs, guardrails,
evidence, and model-facing tools into one inspectable system.

# Goals

- Give a model typed access to the current run, work set, PR queue, context
  packs, guardrail decisions, and activity history.
- Keep orchestration state durable across process restarts and model sessions.
- Split complex workflow activities into sub-contexts that can be summarized
  back into the parent trajectory.
- Capture replayable snapshots of state, decisions, events, and evidence for
  complex orchestrated operations.
- Precompute deterministic facts, risk signals, and policy checks so model
  context is spent on planning, orchestration, semantic review, and complex
  merge work.
- Preserve the current repository structure: `@merge-god/github-sync` owns
  forge-normalized source state, and Merge God application storage owns
  orchestration state.

# Non-Goals

- Replace the existing label contract for `for-review`, `for-landing`, and
  `for-impl`.
- Store WorkflowIR node status as the queue state. Runtime state should remain
  a separate evidence record.
- Expose raw SQLite writes to a model.
- Require every implementation host to use the same physical storage layout.

# Review Slice

The first reviewable implementation slice should make this RFC visible and
discussable before any queue execution behavior changes.

The slice is reviewable when:

- RFC-006 renders from the website under the design/RFC section.
- The design page exposes status, creation metadata, tags, and a GitHub edit
  link back to `docs-cms/rfcs`.
- Reviewers can read the domain model, replay requirement, implementation plan,
  risks, alternatives, and open questions without leaving the web UI.
- The rendered route is generated from the canonical `docs-cms` markdown rather
  than a copied site document.

The next implementation slice after review should be storage-only: add domain
types and append-only persistence for runs, worksets, work items, activities,
events, context-pack metadata, guardrail results, and evidence references. It
should not change PR selection or merge behavior until compatibility tests prove
the current one-shot path can create and complete a minimal trajectory.

# Current Model

## Source Snapshots

The workspace package `@merge-god/github-sync` owns the forge-neutral source
model. Its `SyncStore` persists repositories, pull requests, branch states,
sync history, project metadata, and PR context snapshots.

Important existing concepts:

| Concept | Current Location | Role |
|---|---|---|
| `PullRequest` | `packages/github-sync/src/models.ts` | Canonical forge-neutral PR metadata. |
| `PRContext` | `packages/github-sync/src/models.ts` | Normalized PR state, labels, CI, branch, conflict, and review context. |
| `RepositoryState` | `packages/github-sync/src/models.ts` | In-memory repo state used for branch and PR correlation. |
| `pr_context.pr_data` | `packages/github-sync/src/store.ts` | JSON context snapshot gathered for agent replay and offline testing. |

This model is appropriate for source-of-truth snapshots. It is not enough to
represent a multi-PR plan, a long-running merge trajectory, or scoped
sub-activities with model-specific context.

## Application Runtime State

`AppStore` records Merge God runtime telemetry:

| Table | Role |
|---|---|
| `processing_history` | Per-PR processing outcomes. |
| `dashboard_state` | Dashboard-visible repository status. |
| `agent_sessions` | Agent session metadata. |
| `agent_actions` | Tool and action records. |
| `agent_turns` | Model turns and token/cost telemetry. |
| `agent_errors` | Runtime errors. |
| `agent_file_operations` | File-level mutation telemetry. |

This store is close to the right ownership boundary for the trajectory layer,
but it is currently session-centric rather than run-centric. It records what an
agent did after selection, not how the whole work set was selected, organized,
and advanced.

## Coordination Runtime

`coordination.ts` exposes a local HTTP server with one in-memory `WorkItem` and
one result slot. `runPiAgent` starts that server, launches `pi` with the Merge
God extension, waits for the result, and stops the server.

This works for one-shot task execution. It does not provide:

- durable run identity,
- work set inspection,
- append-only trajectory events,
- context pack lookup,
- model assignment policy,
- activity-level evidence,
- resume semantics after restart.

# Proposed Domain Model

## Entities

The following entities should be added to Merge God application state. They may
be represented as SQLite tables, JSONL artifacts, or both. SQLite should be the
queryable source of truth; file artifacts should carry larger evidence payloads.

| Entity | Purpose |
|---|---|
| `orchestration_runs` | One durable top-level loop trajectory for a repo or configured repo set. |
| `worksets` | A selected batch such as a PR queue, review batch, issue batch, or embark cohort. |
| `work_items` | Individual PRs or issues inside a workset with status, disposition, priority, and next action. |
| `activities` | Scoped workflow units such as planning, merge gate, review workflow, CI fix, conflict resolution, or summary. |
| `activity_sessions` | Concrete model or tool executions inside an activity. |
| `trajectory_events` | Append-only event log for deterministic, model, agent, and human events. |
| `context_captures` | Periodic source-state captures with freshness, source refs, and digests. |
| `context_packs` | Model-facing prepared context bundles with token estimates and artifact refs. |
| `guardrail_checks` | Deterministic policy and safety checks that gate model or tool action. |
| `evidence_artifacts` | Validation outputs, diffs, summaries, logs, comments, and final gate records. |
| `tool_invocations` | Structured tool calls and results exposed through the model-facing API. |

## Orchestration Run

An orchestration run is the durable top-level object that replaces implicit
state in process memory and chat history.

Required fields:

| Field | Description |
|---|---|
| `run_id` | Stable UUID. |
| `repo_name` | Configured repository name, or a repo-set identifier for multi-repo runs. |
| `repo_path` | Local repository path when applicable. |
| `base_branch` | Default or target base branch. |
| `strategy_version` | Version of the selection, planning, and merge strategy. |
| `workflow_ir_refs` | WorkflowIR definitions active for this run. |
| `status` | `created`, `surveying`, `planning`, `executing`, `waiting`, `completed`, `blocked`, or `failed`. |
| `current_phase` | Human-readable phase for dashboard and model planning. |
| `started_at` | Run start timestamp. |
| `heartbeat_at` | Last live process or model heartbeat. |
| `completed_at` | Completion timestamp when terminal. |
| `objective` | Operator-level objective for the run. |
| `operator_policy` | Disposition defaults, approval rules, and merge permissions. |
| `model_policy` | Allowed model tiers, tool scopes, cost limits, and context limits. |
| `metadata` | Extensible JSON for host-specific details. |

## Workset

A workset is the model-readable batch that lets Merge God organize the work
before individual agent sessions begin.

Recommended `kind` values:

- `pr_queue`
- `review_batch`
- `issue_batch`
- `embark_cohort`
- `salvage_candidate_set`

Required fields:

| Field | Description |
|---|---|
| `workset_id` | Stable UUID. |
| `run_id` | Owning orchestration run. |
| `kind` | Workset category. |
| `selection_reason` | Why these items belong together. |
| `status` | `draft`, `ready`, `active`, `paused`, `completed`, or `blocked`. |
| `approval_state` | `not_required`, `pending`, `approved`, or `rejected`. |
| `strategy` | Queue, salvage, embark, or review strategy name. |
| `created_at` | Creation timestamp. |
| `updated_at` | Last update timestamp. |

## Work Item

A work item stores the durable PR or issue state needed by RFC-004 and RFC-005.

Required fields:

| Field | Description |
|---|---|
| `work_item_id` | Stable UUID. |
| `workset_id` | Owning workset. |
| `source_kind` | `pull_request` or `issue`. |
| `repo_name` | Repository name. |
| `number` | PR or issue number. |
| `title` | Current title. |
| `url` | Source URL. |
| `mode` | `for-review`, `for-landing`, or `for-impl`. |
| `labels` | Current labels. |
| `base_ref` | Base branch or SHA. |
| `head_ref` | Head branch or SHA. |
| `start_sha` | SHA at first queue capture. |
| `current_sha` | Latest known SHA. |
| `status` | Queue status such as `queued`, `syncing`, `conflicted`, `validated`, `pushed`, `merged`, `closed`, `skipped`, or `blocked`. |
| `disposition_setting` | Requested remediation cap from RFC-004. |
| `computed_disposition` | Current gate result such as `candidate`, `safe-to-push`, `safe-to-merge`, `stale`, `superseded`, `no-op`, `needs-redesign`, or `blocked`. |
| `priority` | Deterministic or model-assigned priority. |
| `model_tier` | Suggested model level for the next activity. |
| `next_action` | Next actionable step. |
| `blockers` | Structured blockers. |
| `risk_signals` | Precomputed RFC-004 and RFC-005 signals. |
| `context_pack_refs` | Current context packs for the item. |

## Activity

Activities are sub-contexts. Each activity gets its own scoped context, prompt
runtime, model policy, tool allowance, and evidence trail.

Recommended activity types:

- `survey`
- `triage`
- `planning`
- `review_workflow`
- `merge_gate`
- `conflict_resolution`
- `ci_diagnosis`
- `ci_fix`
- `salvage_planning`
- `embark_planning`
- `semantic_summary`
- `operator_handoff`

Required fields:

| Field | Description |
|---|---|
| `activity_id` | Stable UUID. |
| `run_id` | Owning run. |
| `workset_id` | Optional workset. |
| `work_item_id` | Optional work item. |
| `parent_activity_id` | Optional parent activity. |
| `type` | Activity type. |
| `status` | `created`, `ready`, `claimed`, `running`, `succeeded`, `failed`, `blocked`, or `canceled`. |
| `model_profile` | Model tier and runtime profile. |
| `tool_policy` | Allowed tools and mutation scope. |
| `prompt_runtime_ref` | Prompt runtime contract or WorkflowIR prompt ref. |
| `context_pack_refs` | Inputs available to this activity. |
| `output_summary_ref` | Summarized output artifact. |
| `evidence_refs` | Evidence artifacts created by the activity. |

# Context Pipeline

The context pipeline should turn source snapshots and deterministic checks into
small, typed, model-facing context packs.

## Capture

Context capture reads from `SyncStore`, GitHub, git, validation commands, and
existing application telemetry. Every capture records:

- source refs and command versions,
- source timestamps and freshness,
- content digest,
- artifact location,
- capture reason,
- run and work item ownership.

Captures should happen at run start, after PR head/base drift, after validation,
after model mutation, after CI status changes, and before final gate decisions.

## Replay Snapshots

Snapshots should make complex orchestrated operations replayable. A replay
snapshot is a consistent point-in-time bundle of source state, trajectory state,
model-facing context, decisions, and evidence.

Replay snapshots should include:

- run, workset, work item, activity, and session state,
- ordered trajectory event range,
- decision records with inputs, selected option, rejected options, and rationale,
- context pack IDs and content digests presented to the model,
- guardrail check results and policy versions,
- tool invocation inputs, structured outputs, errors, and artifact refs,
- source refs such as base SHA, head SHA, PR metadata timestamp, and CI status
  timestamp,
- model runtime metadata such as model profile, prompt runtime ref, prompt hash,
  token usage, and output digest.

Replay does not have to re-execute mutating tools by default. The first target
should be deterministic playback: reconstruct the state visible to the
orchestrator and model at each decision point, then compare the recorded
decision and outcome. Later replay modes can support sandboxed re-execution for
validation or regression testing.

Recommended replay modes:

| Mode | Purpose |
|---|---|
| `inspect` | Rebuild timeline and evidence for human audit. |
| `model-eval` | Present historical context packs to a candidate model and compare decisions. |
| `deterministic-check` | Re-run non-mutating guardrails and compare classifications. |
| `sandbox-rerun` | Re-execute selected activities in an isolated worktree with mutation disabled or contained. |

## Prepare

Preparation performs deterministic work before the model sees the task:

- label classification,
- PR and issue selection,
- branch and SHA drift checks,
- merge conflict detection,
- retained scope preflight,
- patch-id and duplicate/superseded analysis,
- changed-file and ownership summaries,
- generated-artifact and lockfile detection,
- CI failure grouping,
- validation lane selection,
- risk signal computation,
- token estimates and truncation choices,
- disposition cap enforcement.

The model should receive the results and the evidence references, not be asked
to repeat the collection work.

## Pack

Recommended context pack kinds:

| Pack Kind | Contents |
|---|---|
| `run_overview` | Current objective, phase, worksets, active blockers, model policy, and recent trajectory summary. |
| `queue_overview` | Prioritized work items, statuses, dispositions, dependencies, and suggested next activities. |
| `work_item_brief` | One PR or issue summary with labels, CI, reviews, conflicts, risk signals, and next action. |
| `review_workflow_context` | Diff summary, review comments, files, tests, policies, and allowed prompt runtime. |
| `merge_gate_evidence` | Validation results, retained scope, quality findings, disposition, and gate status. |
| `salvage_or_embark_brief` | Cross-PR overlap, strategy candidates, dependency clusters, and approval requirements. |
| `model_assignment_context` | Activity complexity, risk, cost budget, token estimate, and recommended model level. |
| `handoff_summary` | Compact resumption state for a live or restarted session. |

Each pack should store `kind`, `version`, `schema_ref`, `content_digest`,
`token_estimate`, `freshness`, `artifact_ref`, and the source entity refs.

# Model-Facing Tool Surface

Models should access trajectory state through typed tools, not direct database
access. The following tool contracts extend RFC-002.

| Tool Ref | Purpose |
|---|---|
| `tool://merge-god/run.get-state@v1` | Return run state, current phase, worksets, active activities, blockers, and latest checkpoint. |
| `tool://merge-god/run.append-event@v1` | Append a structured trajectory event. |
| `tool://merge-god/run.heartbeat@v1` | Keep a live run lease fresh. |
| `tool://merge-god/workset.list@v1` | List worksets for a run. |
| `tool://merge-god/workset.get@v1` | Return one workset with ordered work items and strategy metadata. |
| `tool://merge-god/work-item.get@v1` | Return one work item with status, risk signals, context packs, guardrails, and evidence. |
| `tool://merge-god/activity.claim-next@v1` | Claim the next ready activity according to priority, model policy, and disposition limits. |
| `tool://merge-god/activity.start@v1` | Mark an activity running and bind it to a session. |
| `tool://merge-god/activity.complete@v1` | Store result summary, evidence refs, next-action recommendations, and status. |
| `tool://merge-god/context-pack.get@v1` | Return a prepared context pack by ID or by entity/kind. |
| `tool://merge-god/context-pack.refresh@v1` | Request deterministic recapture and repacking. |
| `tool://merge-god/guardrail.list@v1` | Return guardrail checks for a run, workset, work item, or activity. |
| `tool://merge-god/evidence.publish@v1` | Store a summary, validation result, diff report, or handoff artifact. |

Mutating state transitions should be validated by deterministic policy:

- Only ready activities can be claimed.
- A model cannot raise its own disposition cap.
- Tool policy must match the activity type.
- Work item SHA drift invalidates stale context packs.
- Merge or push actions require current gate evidence.
- Failed validation requires a blocker, inherited-failure classification, or a
  bounded remediation activity.

# Live Session Semantics

The live session should be resumable without relying on the model chat log.

1. A run starts or resumes by loading `orchestration_runs`, the latest
   `handoff_summary`, active worksets, and active activities.
2. The coordinator writes a heartbeat while a model or tool process owns the
   run.
3. Periodic capture refreshes context packs after source drift, model mutation,
   validation output, or time-based freshness expiry.
4. Sub-context activity outputs are summarized into evidence artifacts and a
   parent trajectory event.
5. A checkpoint updates the run-level `handoff_summary` so another process or
   model can continue.

The coordination API can remain local HTTP or become MCP-backed, but the
storage contract should be durable and append-only for events. The current
one-shot `WorkItem` can be treated as a compatibility path that creates one
run, one workset, one work item, and one activity.

# Deterministic Guardrails

The deterministic layer should own repetitive collection and policy work:

| Guardrail | Deterministic Responsibility |
|---|---|
| Path and repo boundary | Validate worktree and file paths before tools run. |
| Label contract | Classify and skip PRs according to configured labels. |
| Drift detection | Compare start SHA, current SHA, base SHA, and context pack digests. |
| Retained scope | Detect no-op, superseded, stale, conflict-heavy, and redesign-needed states. |
| Disposition enforcement | Reject edits, commits, pushes, approvals, or merges outside policy. |
| Validation evidence | Require command results and base comparison before final gate. |
| Model tiering | Suggest model level from risk signals, complexity, and token budget. |
| Context freshness | Invalidate packs after source or evidence changes. |
| Mutation audit | Record file operations, commits, pushed refs, and PR comments. |

Models should decide strategy, semantic prioritization, complex review findings,
salvage approach, cross-PR grouping, and concise summaries. They should not
spend context reconstructing facts that the runtime can compute exactly.

# Storage Shape

The application database should remain the queryable source of truth. Large
payloads can be stored beside it as artifacts:

```text
.merge-god/runs/<run-id>/
  trajectory.jsonl
  state.json
  context-packs/
    <context-pack-id>.json
  worksets/
    <workset-id>.json
  artifacts/
    <artifact-id>/
```

`trajectory.jsonl` should mirror `trajectory_events` for easy inspection and
export. `state.json` should be a checkpoint, not the authoritative event log.

# WorkflowIR Integration

WorkflowIR should describe the workflow and prompt-runtime contracts. The
trajectory layer should bind runtime execution to those definitions:

- `orchestration_runs.workflow_ir_refs` names active workflow definitions.
- `activities.prompt_runtime_ref` binds an activity to a prompt-runtime
  contract.
- `context_packs.schema_ref` names the data schema the prompt expects.
- `activity_sessions` record model, prompt ref, prompt hash, tool set, token
  usage, cost, and output digest.
- `trajectory_events` record state transitions and evidence refs.

Review workflows extracted into WorkflowIR become activity definitions. Their
executions become `activities`, `activity_sessions`, `context_packs`, and
`evidence_artifacts`.

# Implementation Plan

1. Add TypeScript domain types for runs, worksets, work items, activities,
   context packs, guardrails, evidence artifacts, and trajectory events.
2. Extend `AppStore` with schema migrations for the trajectory tables while
   leaving `SyncStore` as the source snapshot store.
3. Add deterministic survey and context-pack builders that consume
   `SyncStore`, existing PR context gatherers, git checks, and validation
   results.
4. Add coordination API v2 tools for run state, worksets, activities, context
   packs, guardrails, and evidence.
5. Adapt the current one-shot PR path to create a compatibility run, workset,
   work item, and activity.
6. Update `pr-loop` to create or resume a run, persist queue planning state,
   claim activities, and checkpoint handoff summaries.
7. Add dashboard views for run phase, active worksets, blockers, context
   freshness, and activity sessions.
8. Add tests for schema migration, state transitions, context pack invalidation,
   disposition enforcement, and compatibility with cached PR replay.

# Adoption Strategy

Adoption should be incremental and compatibility-first.

1. Add the schema and TypeScript domain types behind internal APIs.
2. Teach the current one-shot `runPiAgent` path to create a minimal compatibility
   trajectory while preserving its existing external behavior.
3. Add read-only inspection tools and dashboard panels for runs, work items,
   activities, context freshness, and evidence.
4. Move deterministic capture and guardrail results into the trajectory layer.
5. Enable multi-item planning and activity claiming only after the compatibility
   path has stable tests and useful inspection output.

Existing operators should not need new labels or configuration for the first
slice. New model-tier, retention, and artifact-location settings can be added
later with conservative defaults.

# Drawbacks And Risks

- The model adds another persistence layer that must stay aligned with
  `SyncStore`, `AppStore`, and WorkflowIR references.
- Append-only events plus artifact files can grow quickly without a retention
  policy.
- Durable context packs can accidentally preserve sensitive source details
  longer than the source host would otherwise expose them.
- A broad tool surface can make state transitions hard to reason about unless
  mutating tools enforce deterministic policy.
- Replay snapshots can create false confidence if they reconstruct prompt input
  but omit runtime metadata, tool failures, or evidence artifacts.

# Alternatives

## Extend `agent_sessions` Only

The narrowest option is to add fields to the existing session tables. That would
help with telemetry, but it would keep workset selection, activity planning,
guardrails, and replay state implicit. The system would still lack a durable
queue-level object.

## Store WorkflowIR Node Status As Runtime State

WorkflowIR could be treated as both workflow definition and runtime database.
This would collapse concepts, but it would mix declarative process shape with
mutable source state, evidence, and model runtime metadata. The RFC keeps those
concerns separate.

## Reconstruct From GitHub, Git, And Chat Logs

The system could continue rebuilding state on demand from source hosts,
worktrees, logs, and transcripts. That avoids schema work but prevents reliable
resume, replay, model evaluation, and dashboard inspection of live operations.

# Open Questions

- Should artifact files live under `.merge-god/runs/` by default, or should the
  database store all payloads until size pressure requires artifact offloading?
- Should the model-facing tool surface be implemented first through the current
  Pi extension, a local MCP server, or both?
- What is the initial model tier taxonomy: simple labels, provider/model names,
  or capability profiles?
- How long should completed run artifacts be retained by default?
- Which context packs should be mandatory for final merge evidence versus only
  useful for planning?
