---
title: Advanced PR Salvage and Embark Planning
status: Draft
author: Engineering Team
created: 2026-06-28T00:00:00Z
tags: [design, merge-god, planning, rfc]
id: rfc-005
project_id: merge-god
doc_uuid: 7bbd37dc-947c-4b4f-9f24-c2fd9d25193e
---

# Summary

Parent spec: [RFC-004: PR Triage And Merge Planning Workflow](./rfc-004-pr-triage-and-merge-planning-workflow.md)

This RFC extends the merge-planning workflow with two advanced execution modes
for stale or mechanically overlapping pull requests:

- single-PR salvage, where Merge God preserves retained scope without trying to
  preserve stale branch history
- multi-PR embark planning, where Merge God stages a cohort of related PRs in a
  temporary integration branch or sibling worktree to reduce repeated conflict,
  lockfile, and CI work

The goal is to fit these modes into the newer planning architecture rather than
reintroduce an unconstrained "just rebase or merge harder" agent loop.

# Motivation

RFC-004 already establishes that Merge God should classify PRs, compute
retained scope, choose a remediation disposition, and validate work in isolated
worktrees before mutating repository state. That planning model exposes a gap:
some PRs are neither straightforward bounded remediations nor immediate redesign
stops.

Two cases need a more explicit design:

1. Very old PRs accumulate branch drift, obsolete merge conflicts, and commits
   whose original shape no longer matters even though some retained scope still
   should land.
2. Cohorts of similar PRs, especially Renovate-style dependency waves, repeat
   the same lockfile refreshes, validation failures, and compatibility fixes.

Without explicit support, Merge God either:

- spends too much time rebasing and resolving equivalent conflicts one PR at a
  time
- escalates too many stale PRs directly to `needs-redesign`
- or lets agent prompts improvise risky batch behavior without workflow-level
  constraints

Expected outcomes:

- Better recovery of retained scope from stale PRs.
- Lower validation and CI cost for related PR cohorts.
- Stronger workflow-level control over when advanced remediation is allowed.
- Clear evidence for when a PR was replayed, partially landed, superseded, or
  embarked with other PRs.

# Detailed Design

This RFC does not replace RFC-004. It refines the execution choices available
after planning has already established retained scope, queue state, and the
requested `disposition_setting`.

## Goals

- Preserve retained scope without requiring preservation of stale commit shape.
- Let Merge God batch related PRs when the batch is cheaper to validate than the
  PRs are to remediate independently.
- Keep advanced remediation inside workflow, queue-state, and merge-gate policy.
- Produce durable artifacts showing why salvage or embark work was attempted.

## Non-Goals

- Fully autonomous grouping of unrelated feature PRs.
- Bypassing the merge gate or `disposition_setting` limits from RFC-004.
- Treating WorkflowIR node status as the durable queue-state store.
- Solving cross-repo embark planning in the first version.

## Relationship To RFC-004

RFC-004 defines:

- survey pass and classification
- retained scope preflight
- queue-state persistence
- remediation disposition scale
- isolated worktrees
- final merge gate

This RFC adds advanced execution choices inside that framework.

- A stale PR is not automatically a redesign candidate.
- A `bounded` or `maintainer-approved` PR may use salvage techniques when they
  preserve retained scope better than a direct rebase.
- Multiple PRs may be represented in one embark plan when the planning pass
  shows that combined validation is cheaper and safer than isolated work.

## Strategy Families

### 1. Standard Isolated PR Remediation

Use the RFC-004 merge gate path unchanged for fresh PRs or low-drift PRs where
isolated validation and bounded remediation are sufficient.

### 2. Single-PR Salvage

For stale PRs with clear retained scope, Merge God may select a salvage
execution plan instead of direct branch-sync remediation.

Allowed salvage patterns:

- `reset_and_replay`: reset the branch to the current base and reapply useful
  changes inside the isolated worktree.
- `patch_dedupe_and_replay`: detect equivalent changes already present on the
  base branch and replay only unique deltas.
- `semantic_chunking`: split the retained scope into coherent units and salvage
  only the units that still belong in the requested PR.
- `file_transplant`: rebuild touched files one by one, using base-branch state
  as the scaffold.
- `test_first_extraction`: salvage tests or executable expectations first, then
  restore behavior on top of the current base branch.
- `interface_preserving_rewrite`: reimplement retained scope against the current
  architecture when replaying stale internals would be riskier.
- `partial_landing`: land only the validated retained subset and explicitly mark
  the rest deferred, superseded, or redesign-needed.

### 3. Multi-PR Embark

For related PRs where isolated processing would repeat the same work, Merge God
may create an embark plan. An embark plan stages a cohort of PRs in a temporary
integration branch or dedicated sibling worktree rooted at the latest base
branch.

Primary embark patterns:

- `renovate_cohort`: batch many dependency updates that touch the same
  manifests, lockfiles, or compatibility surface.
- `speculative_integration`: stage multiple risky but related PRs together to
  determine whether a combined result is cheaper to validate.
- `minimal_passing_subset`: test a cohort and derive the smallest validated set
  of PRs when the full batch fails.
- `superset_resolution`: produce one integrated result that may supersede
  overlapping source PRs after operator review.

## Decision Flow

Advanced strategy selection should occur after retained-scope preflight and
before mutating remediation begins.

1. Run retained-scope preflight for each PR.
2. Assign or confirm requested `disposition_setting`.
3. Detect stale-but-salvageable PRs and overlapping PR cohorts.
4. Produce a recommended execution mode:
   - standard isolated remediation
   - single-PR salvage
   - multi-PR embark
   - stop as `no-op`, `superseded`, `needs-redesign`, or `blocked`
5. Require the merge-planning approval point from RFC-004 before mutating work.
6. Persist the strategy decision in queue state and evidence artifacts.

Recommended ladder:

1. standard isolated remediation
2. selective replay inside isolated worktree
3. patch dedupe plus replay
4. reset and replay with semantic chunking
5. test-first extraction or interface-preserving rewrite
6. multi-PR embark plan
7. partial landing or supersession report
8. stop with redesign or blocker evidence

## Gathered Signals

RFC-004 already calls for retained-scope analysis. This RFC adds strategy
selection signals that should be gathered or derived during planning.

Suggested new signals:

- PR age
- divergence count from base branch
- count of commits unique to PR and unique to base branch
- concentration of conflicts by file and directory
- touched files deleted or renamed on base
- patch-id overlap with base history
- similarity to other open PRs in the same queue
- lockfile and manifest overlap
- CI failure similarity across PRs
- whether changed tests still map to current code paths
- generated-artifact ratio
- dependency-update fingerprint, such as bot author or commit message style

Additional planning-only signals:

- whether the PR already fits a `no-op`, `superseded`, or `needs-redesign`
  disposition
- whether the requested `disposition_setting` allows the needed remediation
- whether the repository's documented validation lanes make embark batching
  materially cheaper

These signals should be recorded in queue state and exposed to planning and
merge-gate artifacts. They should not live only in ad hoc prompt prose.

## Embark Tree Lifecycle

An embark run is a temporary cohort validation workspace created for one group
of related PRs. The default implementation should prefer isolated sibling
worktrees. A dedicated temporary integration branch is allowed when branch-based
validation or push testing is required.

Lifecycle:

1. Select a cohort of compatible PRs.
2. Record the cohort membership, run id, and source PR heads in durable queue
   state.
3. Create the embark workspace from the current base branch.
4. Apply PRs into the workspace using a documented replay order.
5. Run repository-documented validation lanes once for the cohort, then rerun
   targeted lanes as needed.
6. If successful, choose one of the following outcomes:
   - split the validated result back into source PR remediations,
   - push a replacement integration branch or PR,
   - mark specific PRs as superseded by the cohort result.
7. If partially successful, derive a passing subset or split the cohort into
   smaller embark plans.
8. If unsuccessful, archive the evidence, retain enough diagnostics for
   operator review, and return affected PRs to a more conservative disposition.

An embark workspace is a cost-saving integration tactic, not a permanent public
branch model.

## Disposition And Approval Rules

Advanced strategies must respect the disposition scale from RFC-004.

- `observe`: strategy planning only; no isolated worktree mutation.
- `validate`: allowed to model salvage or embark plans and run validation, but
  not to edit, commit, push, approve, or merge.
- `mechanical`: may use embark mode for documented non-behavioral updates such
  as lockfile refreshes or generated artifacts.
- `bounded`: may use single-PR salvage or limited embark remediation only when
  retained scope remains unchanged.
- `maintainer-approved`: required for broader rewrite, supersession, or cohort
  integration that changes how work is packaged for landing.

Embark execution should require a human approval point even when the requested
disposition is already permissive.

## Strategy-Specific Prompting

Prompting should align with RFC-003 and the prompt catalog direction. The
workflow should not embed large ad hoc instructions that imply merge or rebase
is always the first move.

Prompt changes should include:

- explicit strategy recommendation from planning
- retained-scope summary and disposition constraints
- explicit permission boundaries for reset, replay, batch, rewrite, or stop
- clear success criteria tied to validated retained scope, not branch-history
  purity
- requirement to produce salvage, supersession, or embark summaries as runtime
  evidence

Example instruction style:

> Do not default to merge or rebase for stale PRs. Work from the retained scope
> and the current disposition limits. You may reset to the current base branch,
> replay only still-valid changes, or prepare an embark recommendation for a
> related cohort when that is lower risk than preserving the original branch
> history. Stop rather than exceed the approved disposition.

## Data Model Changes

Potential additions to persisted context and run records:

- `strategy_family`: standard_remediation, single_pr_salvage, multi_pr_embark
- `strategy_name`: concrete chosen strategy
- `strategy_reasoning`: concise machine-readable reason summary
- `pr_drift_metrics`: age, divergence, conflict concentration, overlap metrics
- `retained_scope_summary`: persisted summary from preflight
- `cohort_id`: identifier for grouped processing attempts
- `cohort_members`: PR numbers and branch refs included in an embark run
- `embark_workspace`: sibling worktree root or temporary branch identifier
- `source_pr_outcomes`: replayed, validated, superseded, deferred, redesign
- `salvage_report`: what value was preserved, dropped, or rewritten
- `approval_checkpoint`: approval decision and actor for advanced execution

This metadata should be visible in logs, queue state, and evidence artifacts.

## API Changes

Likely work-item and result contract additions:

- planning output includes strategy recommendation and optional cohort metadata
- queue-state schema includes cohort and salvage fields
- prompt context includes retained scope, disposition setting, and strategy mode
- result payload includes actual strategy used and whether policy limits were hit
- result payload includes source-to-output mapping for embark runs
- result payload includes salvage summary, supersession decisions, and required
  follow-up actions

This likely affects:

- planning workflow outputs
- merge-gate subworkflow contracts
- queue-state persistence
- prompt generation and prompt refs
- dashboard display and `mg:*` state transitions
- evaluation tooling for agent sessions

## Operational Guardrails

Advanced strategies raise risk. Guardrails should be explicit.

- Never batch unrelated feature PRs without strong evidence.
- Always create safety refs before destructive local operations such as reset.
- Keep embark workspaces and temporary branches clearly namespaced and scoped to
  one run id.
- Preserve source PR traceability in queue state, comments, and summaries.
- Require a stronger confidence threshold for automatic supersession.
- Require `maintainer-approved` for replacement branches, broader rewrites, or
  direct multi-PR supersession.
- Allow repository-level opt-in or opt-out for embark mode.
- Prefer dry-run planning or a no-push mode for early rollout.
- If the agent rewrites instead of replaying, require a more detailed summary of
  preserved versus discarded retained scope.
- Reconcile `mg:*` state labels with advanced execution so operators can see
  whether PRs are validating, embarked, blocked, or waiting for review.

## Rollout Plan

Roll out in phases.

### Phase 1: Better Detection and Prompting

- Extend retained-scope preflight with salvage and overlap signals.
- Add a recommended strategy field to planning output.
- Teach prompts that merge or rebase is not mandatory for stale PRs.
- Record the selected strategy in queue state and evidence artifacts.

### Phase 2: Single-PR Salvage

- Support reset-and-replay and selective replay in isolated worktrees.
- Add salvage reports, safety refs, and policy enforcement.
- Add targeted tests around retained-scope preservation and result capture.

### Phase 3: Embark Planning

- Add cohort detection for Renovate-like PRs.
- Let planning produce embark recommendations without pushing branches.
- Evaluate savings, failure modes, and disposition-policy fit.

### Phase 4: Embark Execution

- Create temporary embark workspaces and optional integration branches.
- Run grouped validation and minimal passing subset analysis.
- Support replacement-branch generation only under stronger approval rules.

### Phase 5: Policy and Automation

- Add configuration for cohorting, embark permissions, and approval thresholds.
- Add heuristics for minimal passing subset derivation.
- Add dashboard, label-state, and evaluation tooling support.

## Testing Strategy

This proposal needs more than unit tests.

- Planning tests for stale classification, retained-scope detection, and cohort
  detection.
- Prompt generation tests for each strategy family and disposition boundary.
- Queue-state validation tests for new salvage and embark fields.
- Replay and salvage simulation fixtures with synthetic stale PRs.
- Cohort planning fixtures for Renovate-like update swarms.
- Evaluation tooling that measures repeated-work savings, success rates, and
  policy-limit violations.

# Drawbacks

- More complexity in planning, queue state, and merge-gate policy.
- More non-determinism because Merge God has more legal execution modes.
- Harder audit story when a PR is salvaged or superseded rather than merged as
  authored.
- Embark workspaces add cleanup and traceability burdens.
- More opportunity for policy mistakes if cohorting is too aggressive.

# Alternatives

## Alternative 1

Keep Merge God focused on isolated PR remediation only.

Pros:

- Simpler implementation
- Easier audit trail
- Lower operational surface area

Cons:

- Leaves retained value on the floor for stale PRs
- Repeats expensive work for dependency-update swarms
- Treats stale branch shape as more important than validated retained scope

## Alternative 2

Add only single-PR salvage and defer embark planning.

Pros:

- Lower complexity than full batching
- Immediate improvement for old PRs

Cons:

- Misses the largest savings for Renovate-style queues
- Repeats the same fixes across similar PRs

## Alternative 3

Use separate human-authored integration branches for batch work instead of Merge
God-managed embark runs.

Pros:

- More explicit human control
- Familiar workflow for release managers

Cons:

- Loses the automation and continuous-processing value of Merge God
- Pushes the repeated toil back to humans

# Adoption Strategy

Adoption should be incremental and explicit.

- Start with strategy recommendation only.
- Add repository-level configuration flags before enabling embark execution.
- Target Renovate-like cohorts first because they have the clearest cost-saving
  profile and often fit `mechanical` or tightly bounded remediation.
- Document operator expectations for supersession, partial landing, and salvage
  summaries.
- Extend dashboard, queue-state views, and `mg:*` labels so operators can see
  why Merge God chose salvage or embark work.

Documentation updates will be needed in:

- `docs/how-it-works.md`
- `docs/prompt-example.md`
- `docs/usage.md`
- `docs/configuration.md`
- `docs/agent-testing.md`
- `docs/metro-spec/README.md`
- `docs/workflow-ir/implementation-roles/README.md`

# Unresolved Questions

- What is the minimum signal set needed to recommend salvage versus embark?
- Should embark mode require explicit labels, repository configuration, or only
  planning heuristics?
- When an embark result supersedes multiple PRs, what should the GitHub-facing
  workflow be?
- Should replacement branches preserve original authorship metadata, and how?
- What confidence threshold is required before Merge God may partially land a PR
  without an additional human checkpoint?
- How should the system score cost savings versus risk of batching?
- What cleanup policy should govern temporary embark workspaces, branches, and
  safety refs?

# Future Possibilities

- Cross-repo embark trees for coordinated dependency or API migrations.
- Learned strategy selection from prior successful agent runs.
- Automatic derivation of minimal passing subsets across large cohorts.
- Graph-based planning for dependency-update waves.
- A dedicated salvage review UI in the dashboard showing retained scope,
  discarded changes, and supersession links.

# ADRs To Consider

This RFC likely needs follow-on ADRs if accepted. The most likely decisions are:

1. `ADR: Merge God optimizes for retained-scope salvage over branch-history preservation`
   Defines the core product and architecture stance for stale PR handling.
2. `ADR: Embark trees are a first-class integration primitive`
   Decides whether temporary cohort workspaces or branches are part of the
   supported model.
3. `ADR: Strategy selection may group multiple PRs into one work item`
   Clarifies whether the orchestration boundary remains one PR at a time.
4. `ADR: Supersession and partial landing are allowed outcomes`
   Defines whether merge-god may replace, shrink, or retire source PRs.
5. `ADR: Repository-level policy controls advanced merge behaviors`
   Captures opt-in, labels, configuration, and safety thresholds.
6. `ADR: New observability contract for salvage and embark execution`
   Commits to the metadata, logs, and dashboard semantics needed to operate this
   safely.

These ADRs should be written only once the RFC direction is accepted, because
they are implementation-shaping commitments rather than exploratory design notes.
