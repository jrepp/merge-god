---
title: PR Loop Functional Core And Ports
status: Proposed
created: 2026-07-01T00:00:00Z
deciders: Engineering Team
tags: [architecture, async, domains, merge-god, pr-loop]
id: adr-014
project_id: merge-god
doc_uuid: 0a735b24-3254-4b19-8eab-e946596f6e49
---

# PR Loop Functional Core And Ports

# Context

`pr-loop.ts` has become the place where many separate concerns meet: CLI
parsing, repository validation, GitHub reads, git commands, prompt rendering,
review-gate comment updates, state labels, agent execution, notifications,
database writes, and the long-running polling loop.

That shape was useful while the workflow was small, but it is now the main
maintenance risk. New queue behavior, evidence comments, final merge actions,
and multi-forge support will keep adding policy and side effects. If those
features are added directly to `pr-loop.ts`, the file becomes harder to test,
harder to change safely, and easier to couple to GitHub CLI details.

The practical merge queue observed in real use also shows why this matters:
merge queue PRs need lineage detection, per-constituent evidence, degraded diff
handling, gate summaries, conflict analysis, and final merge decisions. Those
are domain behaviors, not CLI-loop details.

# Decision

Decompose the PR processing path with a functional-core, imperative-shell
architecture. Migrate it incrementally with a strangler pattern: introduce a
cohesive pure module or async port, move one caller, cover it with tests, and
only then delete the old inline branch.

`pr-loop.ts` remains the entrypoint and outer shell. It may own process setup,
CLI parsing, the polling loop, and composition of services. It should not own
new domain rules, prompt rendering, GitHub data retrieval internals, command
execution details, or merge-decision policy.

Use small modules with explicit ports:

- Domain model modules define queue context, blockers, validation evidence, and
  state transitions as plain data.
- Pure policy modules transform model data into decisions, plans, prompts, and
  comments.
- Ports define effectful capabilities such as PR context reads, comments,
  labels, git operations, notifications, database persistence, and agent runs.
- Adapters implement ports for `gh`, local git, SQLite, pi, and future forge
  APIs.
- Orchestrators compose ports and pure policy. They should be async end to end
  and avoid sync subprocesses in new code.
- Application services should stay workflow-sized. Prefer `PrContextGatherer`,
  `PrProcessor`, `IssueProcessor`, `ReviewGateCommenter`, and `MergeExecutor`
  style slices over a single class that owns every PR-loop capability.

The preferred dependency direction is:

```text
entrypoint -> orchestrator -> ports -> adapters
                       \-> pure domain/policy/rendering
```

Pure modules must not import adapters. Adapters must not contain merge policy.
Orchestrators may call both, but should stay thin and readable.

# Boundary Map

Current and planned boundaries:

- `git_ref.ts`: pure git ref validation.
- `ci_status_model.ts`: pure CI rollup normalization.
- `queue_validation_model.ts`: pure scoped queue validation evidence parsing.
- `command_runner.ts`: async subprocess port and spawn adapter.
- `merge_pr_model.ts`: pure merge queue and blocker inference.
- `evidence_comment.ts`: pure review-gate comment rendering.
- `pr_context_source.ts`: PR context source port and `gh`/git adapter.
- `pr_context_gatherer.ts`: async orchestration for gathering context and
  applying pure inference.
- `pr_prompt.ts`: pure PR, review, and issue prompt rendering.
- `pr_processor_model.ts`: pure PR-processing input normalization and agent
  work-item planning.
- `pr_loop_model.ts`: pure PR discovery categorization, processing-state label
  definitions, skip reasons, and loggable summary payloads.
- `pr_queue_display_model.ts`: pure projection for queue rows emitted by the
  loop and rendered by the dashboard.
- `dashboard_event_model.ts`: pure projection for dashboard event summaries
  before TUI rendering.
- `pr_state.ts`: pure PR processing-state label vocabulary, active-state
  filtering, and stale-label planning.
- Future `pr_processor.ts`: one-PR orchestration that composes ports.
- Future `merge_executor.ts`: final merge/queue execution port and adapter.
- Future `issue_processor.ts`: issue implementation orchestration.

# Async Rules

New effectful code should use promise-based APIs and `Promise.all` where calls
are independent. Use sync subprocesses only for legacy wrappers or startup paths
where blocking is intentional and isolated.

Adapters should return typed results rather than throwing for expected
operational failures such as unavailable diffs, blocked merges, invalid refs, or
missing comments. Throwing remains appropriate for programmer errors or
unexpected infrastructure failures.

Long-running operations should accept explicit timeouts at the adapter boundary.
Timeout behavior should be observable through structured logs and returned
result data.

# Consequences

## Positive

- Queue-specific behavior can grow in domain modules without bloating the loop.
- Pure functions are cheap to unit test and safe to reuse in dashboards or sync
  jobs.
- Side effects are isolated behind ports, making fake adapters practical in
  tests.
- Async orchestration becomes explicit instead of hidden behind blocking helper
  calls.
- Future forge support can use the same domain and policy layers.

## Negative

- More files exist, so names and boundaries must stay disciplined.
- Some compatibility exports may remain in `pr-loop.ts` during migration.
- Moving too aggressively could create churn in tests and CLI users.

## Neutral

- The first migration step may leave duplicated legacy sync helpers until their
  callers are moved to async ports.
- The entrypoint will still import many modules because it composes the process.
  That is acceptable if the imported modules own cohesive concerns.

# Alternatives Considered

## Split By File Size Only

Moving arbitrary chunks into helper files would reduce line count but preserve
coupling. That does not solve the design problem.

## One PR Processor Class

A large class with many injected services would make dependencies visible, but
it would likely become another god module. It also makes pure logic harder to
test independently.

## Event Bus

An event bus could decouple producers and consumers, but the workflow is still
mostly a deterministic pipeline. An event bus would add debugging and ordering
burden before the domain needs it.

# References

- [ADR-004: Label-Based Processing Control](./adr-004-label-based-processing-control.md)
- [ADR-013: GitHub PR State Label Schema](./adr-013-github-pr-state-label-schema.md)
- [RFC-004: PR Triage And Merge Planning Workflow](../rfcs/rfc-004-pr-triage-and-merge-planning-workflow.md)
