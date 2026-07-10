---
title: Profile-Guided Operations Acceleration
status: Draft
author: Engineering Team
created: 2026-07-10T00:00:00Z
tags: [context, orchestration, performance, rfc, scale, tokens]
id: rfc-007
project_id: merge-god
doc_uuid: 1eafc0ce-34bd-4d55-b9b0-2fef713fed42
---

# Summary

Merge God must support hundreds of repositories and repositories with thousands
of open or stale pull requests. The system should not gather complete context or
invoke a model for every discovered item. It should build deterministic indexes
from cheap metadata, select a bounded cohort, deepen only changed or selected
items, and provide compact evidence packs to models.

This RFC defines a profile-guided optimization program. Every optimization must
improve a captured workload and preserve replayable selection results. The first
workload is the Merge God repository. Larger public and internal captures can be
added without putting private PR content in the repository.

# Problem

The current paths are suitable for tens of active pull requests, but several
choices become expensive at larger scales:

- `pr-loop.ts` asks `gh pr list` for at most 100 open pull requests.
- The GitHub forge adapter stops list and label queries after 500 results.
- Context gathering starts several remote calls, a branch fetch, conflict
  analysis, and diff capture for every selected pull request.
- Context snapshots store large JSON blobs and use correlated latest-row
  queries that become more expensive as history grows.
- Prompt rendering includes repeated prose and broad slices of comments,
  commits, and changed files before the model asks for them.
- Repository loops run independently and do not share global rate, concurrency,
  memory, or token budgets.

Raising limits alone would make these costs worse. The system needs a bounded
pipeline where each layer proves that the next layer is necessary.

# Goals

- Survey at least 100 repositories and 10,000 open pull requests predictably.
- Keep inventory and policy evaluation deterministic and model-free.
- Avoid deep context calls for unchanged, unlabeled, or deferred pull requests.
- Bound model context by activity and evidence need, not repository size.
- Make wall time, remote calls, database growth, and tokens measurable per layer.
- Replay captured workloads to compare strategy versions before rollout.
- Preserve the label contract and current merge safety behavior.

# Non-Goals

- Automatically close or mutate stale pull requests.
- Remove full context when a selected activity requires it.
- Replace forge APIs with model-based discovery.
- Put private repository captures or raw pull request text in source control.
- Change merge behavior in the first implementation slice.

# Layered Pipeline

## Layer 0: Repository Inventory

The repository index stores identity, forge, default branch, last successful
survey, rate-limit state, open pull request count, and a change cursor. A global
scheduler assigns bounded survey work. No local checkout or model is required.

## Layer 1: Shallow Pull Request Index

The shallow index stores fields available from list APIs: number, state, labels,
draft state, refs, author, timestamps, URL, and small change statistics. It also
stores a stable source fingerprint. This layer performs label gates, age bands,
stack edge discovery, and deterministic priority calculation.

The initial `profile` command measures this layer without changing processing.
It accepts a live GitHub inventory or a captured JSON array and reports age,
selection, index size, estimated tokens, and avoided deep-context calls.

## Layer 2: Change and Policy Indexes

Only shallow records whose source fingerprint changed need policy recomputation.
Materialized indexes should cover:

- processing labels and state labels,
- stale age bands,
- base and head branch relationships,
- known stack dependencies,
- review and CI summary states,
- previous disposition and retry eligibility,
- freshness and invalidation reasons.

This layer produces a bounded candidate set and an explanation for every item
that was selected, deferred, or excluded.

## Layer 3: Selective Enrichment

The scheduler enriches only the bounded candidate set. Enrichment is split by
need instead of one complete context operation:

| Pack | Data | Typical Consumer |
|---|---|---|
| gate | mergeability, CI summary, review decision | deterministic merge gate |
| discussion | unresolved reviews and recent human comments | review response |
| topology | commits, refs, stack edges, conflicts | queue and conflict planner |
| change | file manifest, diff statistics, selected patches | code review |
| validation | failed checks and compact logs | CI repair |

Each pack has a source fingerprint, capture time, byte count, token estimate,
and invalidation rule. Independent packs prevent a new comment from forcing a
new full diff capture.

## Layer 4: Deterministic Actions

Policy code resolves no-op, defer, retry, label-state cleanup, cached gate
evaluation, and safe merge eligibility. Models are not used for facts that can
be derived from structured forge, git, or validation data.

## Layer 5: Model Activities

A model receives an activity envelope, compact summaries, evidence references,
and explicit tools to request deeper packs. It does not receive the entire
repository inventory or complete raw context by default. Model tiers are chosen
from activity risk and uncertainty, with token and tool budgets recorded before
execution.

## Layer 6: Mutation and Verification

Mutations remain guarded by current labels and review gates. Verification writes
structured evidence and updates source fingerprints so later surveys can avoid
repeating completed work.

# Acceleration Structures

## Current-State Tables

Snapshot history remains useful for audit, but operational queries should read
one current row per repository and pull request. The target layout separates:

- `repository_current` and append-only `repository_events`,
- `pr_current` and append-only `pr_events`,
- `pr_pack_current` and immutable pack artifacts,
- `candidate_queue` keyed by strategy and source fingerprint.

Upserts update current rows in one transaction. Append-only events retain
change history. This avoids correlated maximum-timestamp queries on every read.

## Fingerprints

Fingerprints should be composed, not monolithic. Suggested components are:

- `inventory_fingerprint`: state, labels, refs, draft flag, update timestamp,
- `gate_fingerprint`: merge state, review decision, CI rollup,
- `discussion_fingerprint`: latest issue and review comment identifiers,
- `change_fingerprint`: base SHA, head SHA, changed-file metadata,
- `policy_fingerprint`: strategy, configuration, and policy versions.

The scheduler recomputes only products whose inputs changed.

## Scheduler

The multi-repository scheduler uses bounded queues for survey, enrichment,
deterministic work, model work, and mutation. Limits are global and per forge.
Fair scheduling prevents one repository with thousands of stale pull requests
from starving active repositories.

# Token Strategy

Token optimization is an output of better information architecture rather than
prompt truncation alone.

- Keep the global inventory as structured rows outside model context.
- Send aggregate counts and a bounded candidate sample to planning activities.
- Render only the packs required by the current activity.
- Replace repeated instructions with versioned prompt fragments or runtime refs.
- Summarize discussions by unresolved thread and retain links to raw evidence.
- Represent changed files as a manifest before loading patches.
- Record estimated and actual input, cache, and output tokens per pack and task.
- Promote to a larger model or context only when uncertainty or risk requires it.

# Profile Workloads

Each workload is a manifest plus a redacted or synthetic capture. A profile run
records:

- repository and pull request counts,
- age and label distributions,
- collection and analysis wall time,
- remote requests and rate-limit waits,
- database reads, writes, bytes, and query time,
- candidate and enrichment counts,
- context-pack and prompt bytes,
- estimated and actual model tokens,
- final dispositions and correctness checks.

The starting workload is a live, read-only Merge God inventory. Follow-up
workloads should include synthetic 10,000-item distributions and private
captures stored outside the repository. Captures need stable IDs and expected
aggregate results so strategy changes are replayable.

## Initial Merge God Baseline

A read-only run on July 10, 2026 found seven open pull requests. All seven had
the `for-review` label and were active within 30 days. GitHub collection took
657.21 ms, while shallow analysis took 1.29 ms and produced a 727-byte index
with an estimated 182 tokens. A 25-item deepening limit avoided no calls because
the complete processable set was smaller than the cohort budget.

This small workload shows that remote discovery dominates shallow computation.
It is a correctness baseline, not a scale baseline. The synthetic 5,000-item
test completes the same deterministic analysis without deep context gathering;
larger live captures are still required to measure pagination and rate limits.

# Optimization Process

1. Capture the workload and expected deterministic outputs.
2. Run the baseline and retain the profile artifact.
3. Identify the dominant layer by wall time, calls, bytes, or tokens.
4. Change one layer while preserving selection and safety invariants.
5. Replay the same workload and compare the profile artifact.
6. Roll out behind configuration and observe live telemetry.
7. Promote the strategy version only after correctness and budget checks pass.

# Initial Budgets

The initial budgets are targets to validate with real captures:

| Measure | Initial Target |
|---|---|
| shallow analysis | under 100 ms for 10,000 pull requests |
| default deepening cohort | at most 25 items per repository cycle |
| unchanged item enrichment | zero remote calls |
| model inventory input | aggregate plus at most 25 candidate summaries |
| scheduler memory | bounded by configured active repositories and cohorts |
| selection replay | identical output for identical capture and strategy |

# Implementation Plan

## Slice 1: Profiling Foundation

- Add a pure shallow inventory profiler.
- Add a read-only `merge-god profile` command for live and captured inputs.
- Add synthetic tests with thousands of stale pull requests.
- Record the Merge God baseline.

## Slice 2: Unbounded Paged Discovery

- Replace fixed list caps with streaming pages and explicit budgets.
- Persist cursors, truncation status, request counts, and rate-limit waits.
- Query processing labels directly when a full inventory is not needed.

## Slice 3: Current-State Store

- Add current-state tables and source fingerprints.
- Benchmark current-row queries against snapshot-correlated queries.
- Add retention and compaction policies for historical snapshots.

## Slice 4: Selective Packs

- Split full context gathering into independently cached packs.
- Add freshness and invalidation policy for each pack.
- Build activity prompts from pack summaries and evidence references.

## Slice 5: Global Scheduler

- Add fair queues and global resource budgets across configured repositories.
- Separate survey, enrichment, deterministic, model, and mutation workers.
- Expose queue depth, age, throughput, and budget pressure in the dashboard.

# Safety and Correctness

- Labels remain the authority for processing eligibility.
- Profiles and shallow surveys are read-only.
- A truncated inventory must be explicit and must not imply complete absence.
- Cached gate decisions must include source and policy fingerprints.
- Mutations require fresh gate evidence and current head SHA verification.
- Optimization comparisons must include selection and disposition correctness,
  not only speed or token reduction.

# Open Questions

- Which forge cursors and webhook events can reliably drive incremental survey?
- Should current-state and event history share the existing sync database?
- What fairness policy best balances active small repositories and large stale
  repositories?
- Which context packs provide enough evidence for deterministic auto-merge?
- What redaction format allows useful internal captures without leaking content?
