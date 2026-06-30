---
title: WorkflowIR Specification v1
description: Normative reference for the WorkflowIR graph contract.
group: Metro References
order: 25
---

# WorkflowIR Specification v1

**Date**: 2026-06-04
**Status**: Draft
**Purpose**: Define a durable, engine-neutral workflow intermediate representation shared across Metro authoring, Gantry coordination, BPM/workflow engines, DAG schedulers, and agentic orchestration backends.
**Grounding**:

- `metro/spec/WORKFLOW-SPEC.md`
- `metro/spec/workflow/README.md`
- `metro/spec/schemas/workflow.json`
- `metro/spec/WORKFLOW-IR-GUIDE.md`
- `metro/schema-registry/workflow-ir/registry.yaml`
- `metro/schema-registry/workflow-ir/workflow-ir.schema.json`
- `gantry/coordination/types.go`
- `gantry/docs-cms/plans/plan-002-task-link-workflow-model.md`
- `metro/schema-registry/gantry/workflow-envelope.yaml`

---

## Overview

`WorkflowIR` is the canonical workflow contract between human-authored workflow documents, coordination runtimes, workflow engines, BPM systems, DAG schedulers, and agentic orchestration backends.

It is not a markdown authoring format and not a runtime status object. It is a stable graph contract describing workflow intent, data contracts, control-flow behavior, human or policy gates, resource requirements, artifact expectations, and projection constraints.

For the authoring format and examples, start with
[`workflow-README.md`](workflow-README.md) and [`WORKFLOW-SPEC.md`](WORKFLOW-SPEC.md).
This document owns the IR projection contract.

The v1 design intentionally has two layers:

1. **Basic portable subset**: a small DAG-compatible model that simple backends can consume with little machinery.
2. **Extended semantic profiles**: optional features that map to BPM/workflow engines and agentic orchestrators without hiding core behavior in opaque metadata.

---

## Normative Language

The keywords `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are normative and are to be interpreted as described in RFC 2119.

Fields described as optional MAY be omitted. If present, their semantics are normative.

---

## Design Principles

1. **Simple backends first**
   A backend that only supports static DAGs MUST be able to consume the `basic-dag` profile without understanding BPM-specific nodes.

2. **Expressive semantics without vendor lock-in**
   Gateways, joins, waits, events, compensation, subworkflows, and agentic behavior MUST be represented as canonical intent rather than buried in vendor extensions.

3. **Canonical plan separate from runtime state**
   Runtime status, task claims, live retries, evidence attachments, sessions, produced artifact URIs, and decision outcomes MUST NOT be stored in canonical IR payloads.

4. **Graph-first**
   The canonical model is nodes and typed edges. A simple DAG is one valid subset.

5. **Typed dataflow**
   Inputs, captures, bindings, outputs, artifacts, and resources SHOULD carry primitive types or schema references.

6. **Projection honesty**
   A projection MUST reject or explicitly report lossy behavior when the target backend cannot preserve required IR semantics.

7. **Additive evolution**
   New optional fields, node kinds, edge kinds, and conformance profiles MAY be added when their semantics are documented.

---

## Non-Goals

`WorkflowIR v1` does not attempt to be:

- a replacement for Metro markdown authoring files
- a replacement for Gantry runtime state, event envelopes, or task records
- a full live execution log or audit history
- a universal policy engine
- a UI document model
- a direct clone of BPMN, Temporal, Argo, Airflow, Step Functions, or any other runtime model

---

## Top-Level Contract

A `WorkflowIR v1` document MUST be an object with these top-level fields:

- `ir_version`: required IR schema version. For this specification the value MUST be `workflow-ir/v1`.
- `workflow`: required workflow identity and descriptive metadata.
- `graph`: required canonical graph.

These top-level fields are optional but canonical when present:

- `inputs`: invocation parameters.
- `dataflow`: captures, bindings, and workflow outputs.
- `gates`: reusable human or policy decision definitions.
- `resources`: external systems, resource types, locks, quotas, and secrets.
- `artifacts`: declared durable outputs and publication intents.
- `capabilities`: required profiles, optional profiles, and required extensions.
- `execution_hints`: advisory scheduling and runtime preferences.
- `provenance`: source, compiler, digest, and projection lineage.
- `extensions`: namespaced additive data.

Consumers MUST ignore unknown optional fields only when they are not declared as required extensions or required profiles.

### Minimal Basic-DAG Example

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.example.z16-migration
  version: v1
  title: Z16 migration assessment
  description: Assess source and target readiness for migration.
  tags: [migration, assessment]
  profile: api-workflow
  safety:
    tier: T0

capabilities:
  required_profiles: [basic-dag]

inputs:
  - name: source_cpc_name
    value_type:
      kind: string
    required: true

graph:
  nodes:
    - id: discover_source
      kind: action
      action:
        ref: api.get_cpc
    - id: approval_gate
      kind: gate
      gate_ref: gate.operator.approve-plan
  edges:
    - id: edge.discover_source.approval_gate
      from: discover_source
      to: approval_gate
      kind: control

dataflow:
  captures:
    - id: capture.source_cpc
      from_node: discover_source
      name: source_cpc
      value_type:
        kind: object
        schema_ref: schema://ibm-z/hmc.cpc/v1

gates:
  definitions:
    - id: gate.operator.approve-plan
      decision_type: plan-approval
      required_role: reviewer

artifacts:
  outputs:
    - id: assessment-report
      kind: report
      producer_node: discover_source
```

---

## Versioning and Identity

`ir_version` and `workflow.version` are different fields with different meanings.

- `ir_version` identifies the schema and semantics of the IR document. It MUST be `workflow-ir/v1` for this version.
- `workflow.id` is the stable logical workflow identifier. It MUST NOT be a runtime instance ID.
- `workflow.version` is the business or contract version of the workflow definition.
- `workflow.revision` MAY identify a source revision, content digest, build number, or generated revision.

IDs used by `workflow.id`, `graph.nodes[].id`, `graph.edges[].id`, gate IDs, capture IDs, and artifact IDs SHOULD be stable, ASCII, and match this grammar unless an embedding schema imposes a stricter rule:

```text
^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$
```

IDs MUST be unique within their declared scope. `graph.nodes[].id` MUST be unique across the graph. `graph.edges[].id` MUST be unique across the graph when provided.

---

## Workflow Metadata

`workflow` MUST contain:

- `id`
- `version`
- `title`

`workflow` MAY contain:

- `description`
- `tags[]`
- `profile`
- `category`
- `safety.tier`
- `safety.notes[]`
- `owners[]`
- `revision`
- `source_refs[]`

Runtime instances MUST reference the canonical IR through provenance or metadata. They MUST NOT overwrite `workflow.id` with a runtime instance ID.

---

## Inputs and Type System

`inputs[]` declares invocation-time parameters. Each input MUST contain:

- `name`
- `value_type`

Each input MAY contain:

- `description`
- `required`
- `default`
- `secret`
- `constraints`

`value_type` MUST use this shape:

```yaml
value_type:
  kind: object
  schema_ref: schema://example/domain.type/v1
  nullable: false
```

Supported primitive `kind` values are:

- `string`
- `integer`
- `number`
- `boolean`
- `object`
- `array`
- `null`
- `bytes`
- `duration`
- `timestamp`
- `secret`

`schema_ref` SHOULD be a URI or registry reference when `kind` is `object` or `array`. `array` values SHOULD declare `items` with another `value_type`. `object` values MAY declare `properties` for small inline shapes, but durable product payloads SHOULD use `schema_ref`.

Secrets MUST be marked with either `value_type.kind: secret` or `secret: true`. Consumers MUST NOT log secret values in projection diagnostics.

---

## Graph Model

`graph` MUST contain:

- `nodes[]`
- `edges[]`

`graph.nodes[]` MUST NOT be empty.

Every edge `from` and `to` value MUST reference an existing node ID.

### Node Kinds

Each node MUST contain:

- `id`
- `kind`

Supported v1 node kinds are:

- `action`: execute a tool, operation, task, script, API call, human-assigned unit, or engine action.
- `gate`: wait for a human, policy, or delegated decision.
- `gateway`: route execution across outgoing edges.
- `join`: synchronize or merge inbound paths.
- `wait`: wait for a duration, timestamp, condition, signal, message, or external event.
- `subworkflow`: invoke another workflow contract.

Artifact publication is not a node kind in v1. If materialization requires executable work, model it as an `action` node that produces an artifact declaration in `artifacts.outputs[]`.

Common node fields are:

- `label`
- `description`
- `conditions[]`
- `start_when`
- `timeout`
- `retry`
- `on_error`
- `cancellation`
- `compensation`
- `bindings`
- `metadata`

### Action Nodes

An `action` node SHOULD contain an `action` object.

`action` MAY contain:

- `ref`: stable operation, tool, task, or API reference.
- `mode`: `deterministic`, `agentic`, `human`, or `external`.
- `tool_ref`: tool contract reference.
- `operation_ref`: OpenAPI/RPC/service operation reference.
- `agent`: agentic execution requirements.
- `idempotency`: idempotency expectation.

Agentic action nodes SHOULD use `action.mode: agentic` and SHOULD declare autonomy, model/tool constraints, memory/context inputs, evidence expectations, and escalation behavior in `action.agent`.

### Gate Nodes

A `gate` node MUST contain `gate_ref`, and `gate_ref` MUST reference `gates.definitions[].id`.

Gate decisions are canonical intent. Decision outcomes, reviewers, timestamps, comments, and attached evidence are runtime projection records.

### Gateway Nodes

A `gateway` node MUST contain `gateway.kind`.

Supported `gateway.kind` values are:

- `exclusive`: exactly one outgoing path SHOULD be selected.
- `inclusive`: one or more outgoing paths MAY be selected.
- `parallel`: all outgoing paths SHOULD be selected.
- `event_based`: exactly one outgoing event path SHOULD be selected by the first matching event.

Conditional outgoing control edges from `exclusive`, `inclusive`, and `event_based` gateways SHOULD use `edge.when`. A gateway MAY declare `default_edge` for fallback behavior.

### Join Nodes

A `join` node MUST contain `join.kind`.

Supported `join.kind` values are:

- `all`: wait for all required inbound control paths.
- `any`: continue after any one inbound control path succeeds.
- `quorum`: continue after `join.quorum` inbound paths succeed.
- `discriminator`: continue after the first successful inbound path and ignore later successful arrivals for this join instance.

Simple DAG backends that do not implement `join` MUST reject workflows requiring non-default join behavior.

### Wait Nodes

A `wait` node MUST contain `wait.kind`.

Supported `wait.kind` values are:

- `duration`
- `timestamp`
- `condition`
- `message`
- `signal`
- `event`

Wait nodes model planned waiting behavior. Runtime wakeups and received event payloads belong to runtime projection records.

### Subworkflow Nodes

A `subworkflow` node MUST contain:

- `workflow_ref.id`
- `workflow_ref.version`

A `subworkflow` node SHOULD contain:

- `input_mapping[]`
- `output_mapping[]`
- `invocation`: `sync`, `async`, or `fire_and_forget`
- `error_propagation`: `propagate`, `isolate`, or `map_to_output`
- `cancellation_propagation`: `propagate` or `isolate`

---

## Edge Model

Each edge MUST contain:

- `from`
- `to`
- `kind`

Each edge SHOULD contain `id`.

Supported v1 edge kinds are:

- `control`: `to` cannot become ready until the edge requirement is satisfied.
- `data`: `from` supplies data consumed by `to`.
- `guard`: `from` is a gate, policy, or gateway that authorizes `to`.
- `event`: `from` emits or receives an event relevant to `to`.
- `compensation`: `to` is compensation logic for `from`.
- `correlation`: semantic relationship without start-order implications.

`control` is the only edge kind that imposes ordering by default. Other edge kinds MUST NOT imply ordering unless paired with a `control` edge or declared in backend-specific projection rules.

Edges MAY contain:

- `when`: conditional expression.
- `required`: whether the edge is required for readiness.
- `on_status`: source statuses that satisfy the edge.
- `metadata`

Default semantics:

- A node with no inbound `control` edges is initially eligible to start, subject to inputs, resources, and conditions.
- A node with multiple inbound `control` edges uses `start_when: all_success` unless it declares a different `start_when` or is a `join` node.
- A `control` edge is satisfied when the source node reaches `succeeded`, unless `on_status` declares another allowed terminal state.
- If an inbound required control edge reaches an unsatisfied terminal state, the target MUST NOT start unless the target has an `on_error`, `join`, or conditional rule that explicitly handles that state.
- Cycles are allowed only when every cycle is mediated by a node or edge with explicit loop semantics. `basic-dag` workflows MUST be acyclic.

---

## Execution Semantics

WorkflowIR is not runtime state, but it defines the lifecycle semantics that projections MUST preserve.

Portable node lifecycle states are:

- `pending`
- `ready`
- `running`
- `waiting`
- `succeeded`
- `failed`
- `skipped`
- `cancelled`

Backends MAY use richer internal states, but projections MUST map them to this portable lifecycle for conformance diagnostics.

### Conditions and Expressions

Conditions MUST use this object shape:

```yaml
language: workflow-ir.expr/v1
expr: inputs.approved == true
```

The portable expression language `workflow-ir.expr/v1` supports:

- literals: strings, numbers, booleans, null
- variable references rooted at `inputs`, `captures`, `outputs`, `resources`, or `events`
- comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`
- boolean operators: `and`, `or`, `not`
- membership: `in`
- parentheses

Other expression languages MAY be used by setting `language` to a URI or registered dialect name. If a required condition uses an unsupported language, projection MUST reject the workflow or report a lossy projection.

### Retry, Timeout, and Error Policy

Retry and timeout policies are canonical plan semantics, not runtime history.

`retry` MAY contain:

- `max_attempts`
- `backoff`: `none`, `fixed`, `linear`, or `exponential`
- `initial_delay`
- `max_delay`
- `retry_on[]`

`timeout` MAY contain:

- `duration`
- `on_timeout`: `fail`, `skip`, `cancel`, `route`, or `compensate`
- `target_node`

`on_error` MAY contain:

- `strategy`: `fail_workflow`, `continue`, `skip`, `route`, `compensate`, or `raise_event`
- `target_node`
- `error_types[]`

If a backend cannot preserve a declared retry, timeout, or error policy, projection MUST reject the workflow unless the feature is not required by `capabilities.required_profiles`.

### Cancellation and Compensation

`cancellation` MAY define cancellation propagation from a node to child work, subworkflows, or pending downstream nodes.

`compensation` MAY declare planned undo or remediation behavior. Compensation MAY be represented either by `node.compensation.handler_node` or by `compensation` edges. The referenced compensation handler MUST be a valid node.

Compensation execution records belong to runtime state.

---

## Dataflow

`dataflow` MAY contain:

- `captures[]`: named values produced by nodes.
- `bindings[]`: values consumed by nodes.
- `outputs[]`: workflow-level outputs.

Each capture SHOULD contain:

- `id`
- `from_node`
- `name`
- `value_type`
- `path`

Each binding SHOULD contain:

- `to_node`
- `input`
- `from`
- `required`
- `value_type`

`from` SHOULD reference an input, capture, resource, literal, or expression using a stable reference form such as:

- `input.source_cpc_name`
- `capture.source_cpc`
- `resource.hmc`
- `literal:{...}`
- `expr:captures.source_cpc.name`

Data dependencies that affect readiness SHOULD be represented both as `dataflow.bindings[]` and as `data` edges. If missing data should block execution, the node MUST also have a `control` edge or a binding with `required: true` that the target backend understands.

---

## Gates

`gates.definitions[]` defines reusable decision points.

Each gate definition MUST contain:

- `id`
- `decision_type`

Each gate definition MAY contain:

- `label`
- `description`
- `required_role`
- `options[]`
- `default_option`
- `timeout`
- `evidence_requirements[]`
- `policy_ref`
- `on_timeout`

Gate options SHOULD use stable IDs, not display labels, for projection and audit.

---

## Resources and Secrets

`resources` declares external systems, resource types, locks, quotas, and secret requirements.

`resources.systems[]` SHOULD contain external systems such as `hmc`, `metro`, `vault`, or `notebook`.

`resources.secret_requirements[]` SHOULD declare credential classes or references needed at runtime. Secret requirements SHOULD identify:

- `id`
- `kind`
- `scope`
- `required_by[]`
- `injection`: `env`, `file`, `reference`, or `runtime_broker`

`resources.locks[]` MAY declare mutual exclusion requirements. `resources.quotas[]` MAY declare concurrency or rate constraints.

Concrete credential values MUST NOT appear in WorkflowIR.

---

## Artifacts

`artifacts.outputs[]` declares durable outputs and publication intents.

Each artifact output SHOULD contain:

- `id`
- `kind`
- `producer_node`
- `value_type`
- `publish`
- `path_hint`
- `audience`

Concrete artifact URIs, digests, and publication timestamps belong to runtime artifact lineage records, not to canonical IR.

---

## Capabilities, Profiles, and Extensions

`capabilities.required_profiles[]` declares semantic profiles that a projection MUST preserve.

`capabilities.optional_profiles[]` declares features that MAY improve projection quality but are not required for correctness.

Standard v1 profiles are:

- `basic-dag`: action and gate nodes, acyclic control edges, all-success inbound behavior, primitive inputs, artifacts, and advisory hints.
- `typed-dataflow`: captures, bindings, workflow outputs, schema refs, and data edges.
- `human-gates`: gate definitions, gate nodes, required roles, options, evidence requirements, and gate timeouts.
- `gateways`: gateway and join nodes with conditional routing and non-default merge behavior.
- `events-timers`: wait nodes, event edges, message/signal/timer semantics.
- `subworkflows`: subworkflow nodes with input/output mapping and propagation rules.
- `error-handling`: retry, timeout, on-error routing, cancellation, and compensation.
- `agentic`: agentic action mode, tool contracts, autonomy boundaries, evidence requirements, and escalation behavior.
- `prompt-runtime`: prompt contract references, runtime prompt inputs, expected model/tool envelopes, and structured output contracts for prompt-driven action nodes.

A backend MAY advertise supported profiles. A projection MUST reject a workflow when any `required_profiles` entry is unsupported.

`extensions` is a map of namespaced keys to additive data. Extension keys MUST be namespaced, for example `gantry/task-link`, `metro/authoring`, or `ibm-z/topology`.

If an extension is required to preserve semantics, it MUST be listed in `capabilities.required_extensions[]` with:

- `name`
- `version`
- `reason`
- `schema_ref`

Consumers MAY ignore unrequired extensions. Consumers MUST NOT ignore required extensions they do not understand.

---

## Execution Hints

`execution_hints` is advisory. A backend MAY ignore hints if they are not required by a profile or extension.

Common hints include:

- `preferred_harness`
- `allowed_harnesses[]`
- `preferred_role`
- `workstream_id`
- `priority`
- `concurrency_group`
- `scheduler`

Hints MUST NOT carry correctness-critical semantics. If a value affects correctness, model it in graph, dataflow, resources, gates, or capabilities instead.

---

## Provenance

`provenance` SHOULD preserve traceability from source to compiled IR and projections.

Recommended fields are:

- `source_refs[]`: authoring documents or generators.
- `compiled_from`: source format, path, commit, and digest.
- `compiler`: compiler name and version.
- `content_digest`: digest of the canonical IR payload.
- `projection_targets[]`: intended consumers.

Digest fields SHOULD declare algorithm and encoded value, for example `sha256:<hex>`.

---

## Runtime State Is Out of Scope

The following MUST NOT be stored in canonical IR:

- workflow instance status
- task claim ownership
- session membership
- live node status
- retries actually performed
- evidence attachments produced during a run
- commit SHAs observed during one run
- concrete artifact URIs produced during one run
- operator responses captured during one run
- runtime event history

Those belong in Gantry `WorkflowState`, `TaskState`, event envelopes, artifact lineage, or equivalent backend runtime records.

---

## Projection Requirements

Every projection SHOULD produce diagnostics with:

- source IR identifier and version
- target backend and backend version
- supported profiles
- required profiles
- accepted features
- rejected features
- lossy mappings
- warnings

A projection MUST reject the workflow when required semantics cannot be preserved. A projection MAY emit warnings for optional semantics that are dropped.

### Metro Authoring Projection

Metro markdown compiles into WorkflowIR. Authoring prose, examples, and narrative remain source material; only canonical operational intent compiles into IR fields.

| Metro source | WorkflowIR target | Notes |
| --- | --- | --- |
| heading / slug | `workflow.id`, `workflow.title` | Stable contract ID may be derived from path and slug policy. |
| metadata `profile`, `category`, `tags`, `tier` | `workflow.profile`, `workflow.category`, `workflow.tags`, `workflow.safety.tier` | Direct or nearly direct mapping. |
| `params[]` | `inputs[]` | Types default to primitive/string when unknown. |
| step `id` + `action` | `graph.nodes[] kind: action` | Sequential order compiles into control edges. |
| `parallel` group | gateway/join pair or parallel-compatible control edges | Basic DAG projection may omit explicit gateway if semantics are all-success. |
| `if` | `edge.when` or `node.conditions[]` | Portable expression profile preferred. |
| `timeout` | node `timeout` | Canonical plan behavior. |
| `on_error` / retry | node `retry`, `timeout`, `on_error` | Runtime attempts remain out of IR. |
| `capture`, `register`, `outputs`, `inputs`, `consume` | `dataflow.captures[]`, `dataflow.bindings[]`, `dataflow.outputs[]` | Canonical typed dataflow surface. |
| operator decision step patterns | `graph.nodes[] kind: gate` plus `gates.definitions[]` | Gates are first-class. |
| `emit` directives | `artifacts.outputs[]` | Publication remains declarative. |

### Gantry Coordination Projection

| WorkflowIR | Gantry projection | Notes |
| --- | --- | --- |
| `workflow.id` | workflow metadata / provenance | Not runtime `WorkflowState.WorkflowID`. |
| `workflow.title`, `description`, `tags` | workflow title, description, tags | Direct runtime projection. |
| `graph.nodes[] kind: action` | one or more task records | Projection may split or hand off work. |
| `graph.nodes[] kind: gate` | decision-bearing task and decision event records | Outcome is runtime state. |
| `graph.edges[] kind: control` | task links and compatibility `BlockedBy` projection | Direction is `from` blocks `to`. |
| `dataflow.bindings[]` | task input refs and requirements | Concrete values bind at runtime. |
| `artifacts.outputs[]` | artifact publish expectations | Concrete URIs appear after publication. |
| `resources.*` | linked resources, locks, secret requirements | Binding depends on runtime environment. |

Gantry `WorkflowState.DAG`, `WorkflowStep`, and step APIs are projection surfaces. They MUST NOT define the canonical IR shape.

### BPM and Workflow Engine Projection

WorkflowIR is intended to map to BPMN-like and durable workflow engines as follows:

| WorkflowIR | BPM/workflow concept |
| --- | --- |
| `action` | service task, user task, activity, workflow task |
| `gate` | user task, approval task, policy decision activity |
| `gateway` | exclusive, inclusive, parallel, or event-based gateway |
| `join` | merge gateway or synchronization point |
| `wait` | timer event, message catch, signal catch, external event wait |
| `subworkflow` | call activity, child workflow, sub-DAG, reusable pipeline |
| `retry`, `timeout`, `on_error` | activity retry, boundary timer/error, catch/finally path |
| `compensation` | compensation handler or saga undo action |

If the target backend supports these concepts natively, projection SHOULD use native constructs rather than encoding them as generic tasks.

### Simple DAG Projection

A simple DAG backend should consume `basic-dag` by applying these rules:

- Accept only `action` and `gate` nodes unless more profiles are supported.
- Accept only acyclic `control` and optional `data` edges.
- Treat multiple inbound control edges as `all_success`.
- Reject gateways, joins with non-default behavior, wait nodes, compensation, cycles, and unsupported expression languages.
- Preserve artifacts and dataflow as metadata when the backend lacks native equivalents.

### Agentic Orchestration Projection

Agentic backends SHOULD map:

- `action.mode: agentic` to an agent-run task.
- `action.agent.autonomy` to permitted planning and tool-use scope.
- `action.tool_ref` and `resources.systems[]` to available tool contracts.
- `gates` and `evidence_requirements[]` to human escalation and approval requirements.
- `dataflow.bindings[]` to context assembly.
- `artifacts.outputs[]` to required deliverables.
- `on_error`, `timeout`, and `cancellation` to orchestration guardrails.

Agentic projections MUST NOT treat advisory prompts or persona hints as substitutes for required gates, resource constraints, or safety policies.

---

## Compatibility Rules

WorkflowIR v1 follows additive-preferred evolution:

- New optional fields MAY be added.
- New optional profiles MAY be added with documented semantics.
- New node kinds and edge kinds MAY be added only with documented semantics and profile impact.
- Existing canonical field meanings MUST NOT change incompatibly.
- Runtime-only state MUST NOT move into canonical plan sections.
- Required top-level fields MUST NOT change within v1.
- Unknown unrequired extensions MUST remain safely ignorable.

Major-version triggers include:

- incompatible changes to node or edge semantics
- incompatible changes to required top-level fields
- changing lifecycle semantics
- merging runtime-state concepts into canonical plan sections
- changing extension or profile negotiation rules incompatibly

---

## Review Passes Before Freezing v1

WorkflowIR v1 SHOULD pass these reviews before being marked frozen.

1. **Contract pass**
   Verify normative language, JSON Schema coverage, ID/reference integrity, required vs optional fields, and separation of IR version from workflow version.

2. **Basic-backend pass**
   Compile representative workflows to `basic-dag` and confirm a static DAG scheduler can consume them without implementing gateways, timers, compensation, subworkflows, or agent-specific behavior.

3. **Complex-backend pass**
   Map representative workflows to at least one BPM-style engine and one durable workflow engine. Verify gateways, joins, waits, retries, timeouts, cancellation, compensation, subworkflow calls, and event waits preserve behavior.

4. **Agentic-backend pass**
   Map agentic actions to an orchestration backend. Verify tool contracts, autonomy boundaries, memory/context bindings, evidence expectations, human escalation, and safety gates are explicit and not hidden in prose or hints.

5. **Projection-diagnostics pass**
   Confirm each adapter reports supported profiles, required profiles, dropped optional features, lossy mappings, and hard rejection reasons in a machine-readable way.

6. **Durability pass**
   Review whether each field is likely to remain stable across Metro, Gantry, BPM/workflow systems, DAG schedulers, and agent runtimes. Remove vendor-specific concepts from canonical fields or move them into namespaced extensions.

---

## Canonical Landing Zone

The canonical contract lives in two places:

1. Human-readable spec: `metro/spec/WORKFLOW-IR-SPEC.md`
2. Shared schema family: `metro/schema-registry/workflow-ir/registry.yaml`

The machine-readable JSON Schema for v1 lives at:

- `metro/schema-registry/workflow-ir/workflow-ir.schema.json`

The implementer-facing helper guide lives at:

- `metro/spec/WORKFLOW-IR-GUIDE.md`

---

## Initial Adoption Path

Recommended sequence:

1. Validate this spec and schema through the review passes above.
2. Compile Metro workflow markdown into `WorkflowIR` using only supported profiles.
3. Build `WorkflowIR -> Gantry` projection code for workflow/task/link/gate/artifact creation.
4. Add simple DAG projection tests for `basic-dag` workflows.
5. Add at least one complex backend mapping test for gateways, waits, subworkflows, and error handling.
6. Keep Gantry runtime state as a projection, not the source contract.
7. Add additional engine projections only when they can report conformance diagnostics.

---

## Summary

`WorkflowIR v1` is the shared publishable workflow contract between Metro, Gantry, simple DAG schedulers, BPM/workflow systems, and agentic orchestration backends.

It is intentionally small at the `basic-dag` layer and explicitly extensible through conformance profiles for complex engines. Runtime state stays separate, graph semantics are canonical, and projections must be honest when they cannot preserve required behavior.
