# WorkflowIR Implementer Guide

**Status**: Draft companion guide
**Normative spec**: `metro/spec/WORKFLOW-IR-SPEC.md`
**Schema**: `metro/schema-registry/workflow-ir/workflow-ir.schema.json`
**Workflow docs hub**: `metro/spec/workflow/README.md`

This guide explains WorkflowIR concepts in plain language. The normative rules live in `WORKFLOW-IR-SPEC.md`; this document is for authors, adapter implementers, reviewers, and backend owners who need grounded examples.

For authored Metro/Meridian workflow files, use `WORKFLOW-SPEC.md` and
`workflow/QUICK-REF.md`. Use this guide when translating those authored
workflows into WorkflowIR or projecting WorkflowIR into an execution backend.

---

## How To Read WorkflowIR

WorkflowIR describes the intended workflow plan. It does not describe one live run.

Think of a WorkflowIR document as answering these questions:

1. What workflow is this?
2. What inputs does it need?
3. What work happens?
4. What order or routing rules govern that work?
5. What data moves between nodes?
6. What human or policy decisions are required?
7. What systems, secrets, locks, and quotas are needed?
8. What durable outputs should exist?
9. What backend features are required to preserve behavior?

Simple backends can consume the `basic-dag` subset. Complex backends can use additional profiles for gateways, timers, compensation, subworkflows, and agentic execution.

---

## `ir_version`

`ir_version` says which WorkflowIR schema and semantics this document uses.

Use it to let parsers and adapters choose the correct validator and projection behavior.

Example:

```yaml
ir_version: workflow-ir/v1
```

Do not use `ir_version` as the business version of the workflow. That belongs in `workflow.version`.

Practical rule: `ir_version` is for tooling compatibility; `workflow.version` is for workflow contract compatibility.

---

## `workflow`

`workflow` identifies the logical workflow definition.

Use it for stable metadata that should be true across all runtime instances.

Example:

```yaml
workflow:
  id: wf.z.migration-assessment
  version: v1
  title: Migration assessment
  description: Assess source and target readiness before migration.
  tags: [migration, assessment]
  safety:
    tier: T0
```

Do not put runtime instance IDs here. A runtime instance should reference this IR; it should not replace `workflow.id`.

Practical rule: if the value changes from run to run, it probably does not belong in `workflow`.

---

## `workflow.version` vs `workflow.revision`

`workflow.version` is the business or contract version.

`workflow.revision` is a specific source/build/content revision.

Example:

```yaml
workflow:
  id: wf.z.migration-assessment
  version: v1
  revision: git:4f2c1b7
  title: Migration assessment
```

Use `version` when consumers care about compatibility. Use `revision` when auditors or debuggers need to trace the exact source.

Practical rule: many revisions can exist under one workflow version.

---

## `capabilities`

`capabilities` declares what backend features are required or optional.

Use it to prevent silent loss of semantics when projecting to a backend.

Example:

```yaml
capabilities:
  required_profiles: [basic-dag, human-gates]
  optional_profiles: [typed-dataflow]
```

Meaning: a backend must support basic DAG execution and human gates. Typed dataflow is useful, but the workflow may still be projected if that feature becomes metadata.

Practical rule: if dropping a feature changes correctness, put it in `required_profiles`.

---

## `basic-dag`

`basic-dag` is the smallest portable subset.

Use it for workflows that can run on simple schedulers with nodes and dependencies.

Example:

```yaml
capabilities:
  required_profiles: [basic-dag]

graph:
  nodes:
    - id: collect_inventory
      kind: action
    - id: write_report
      kind: action
  edges:
    - from: collect_inventory
      to: write_report
      kind: control
```

This maps cleanly to Airflow-style dependencies, Argo DAG tasks, Gantry task links, or a simple in-house scheduler.

Practical rule: if a workflow needs only actions, gates, and acyclic dependencies, keep it in `basic-dag`.

---

## `inputs`

`inputs` are invocation-time parameters.

Use them for values the caller must provide before the workflow can start.

Example:

```yaml
inputs:
  - name: source_cpc_name
    description: Name of the source CPC to assess.
    required: true
    value_type:
      kind: string
```

Do not use inputs for values produced by workflow nodes. Produced values belong in `dataflow.captures` or `dataflow.outputs`.

Practical rule: if the caller provides it, it is an input. If a node produces it, it is a capture or output.

---

## `value_type`

`value_type` describes the shape of a value.

Use primitive kinds for simple values and `schema_ref` for durable object contracts.

Example:

```yaml
value_type:
  kind: object
  schema_ref: schema://ibm-z/hmc.cpc/v1
```

For arrays:

```yaml
value_type:
  kind: array
  items:
    kind: string
```

Practical rule: use primitives for local workflow values; use `schema_ref` for product/domain objects shared across systems.

---

## Secrets

Secrets are values that must not be logged or embedded directly in the IR.

Use `secret: true` or `value_type.kind: secret` for secret inputs. Use `resources.secret_requirements` for credentials that the runtime must provide.

Example:

```yaml
inputs:
  - name: hmc_token
    secret: true
    value_type:
      kind: secret
```

Better for most runtime credentials:

```yaml
resources:
  secret_requirements:
    - id: hmc-api-token
      kind: api-token
      scope: hmc
      required_by: [discover_source]
      injection: runtime_broker
```

Practical rule: WorkflowIR may describe the need for a secret, but it must not contain the secret value.

---

## `graph`

`graph` is the workflow structure: nodes and edges.

Use nodes for units of intent. Use edges for relationships between those units.

Example:

```yaml
graph:
  nodes:
    - id: discover_source
      kind: action
    - id: approve_plan
      kind: gate
      gate_ref: gate.approve-plan
  edges:
    - from: discover_source
      to: approve_plan
      kind: control
```

Practical rule: nodes are things; edges are relationships between things.

---

## Node IDs

Node IDs are stable names for graph nodes.

Use descriptive IDs that survive projection across backends.

Good:

```yaml
- id: discover_source
  kind: action
```

Avoid:

```yaml
- id: step_1
  kind: action
```

`step_1` is legal, but it is harder to debug, audit, and map across systems.

Practical rule: IDs should explain intent, not just position.

---

## `action` Nodes

An `action` node performs work.

Use it for API calls, scripts, tools, human-assigned work items, service tasks, or agent tasks.

Example:

```yaml
- id: discover_source
  kind: action
  action:
    ref: api.hmc.get_cpc
    mode: deterministic
```

This can map to a BPMN service task, a Temporal activity, an Argo task, a Gantry task, or a tool call.

Practical rule: if something actively does work, it is usually an `action`.

---

## Deterministic Actions

A deterministic action has bounded, predictable behavior.

Use it for fixed operations such as API calls, validation scripts, or generated checks.

Example:

```yaml
- id: validate_target_capacity
  kind: action
  action:
    ref: api.capacity.validate
    mode: deterministic
    idempotency: required
```

Practical rule: use deterministic actions when the backend should run a known operation, not ask an agent to decide what to do.

---

## Agentic Actions

An agentic action delegates bounded work to an agent.

Use it when the task requires planning, synthesis, investigation, or tool selection within explicit limits.

Example:

```yaml
- id: investigate_risk
  kind: action
  action:
    mode: agentic
    tool_ref: tool-catalog://z/read-only-assessment/v1
    agent:
      autonomy: bounded
      instructions: Identify migration risks using read-only tools.
      evidence_required: true
      escalation_gate: gate.review-risk
```

Do not hide required approvals or safety rules inside free-text agent instructions. Model them as gates, resources, and capabilities.

Practical rule: agentic instructions guide behavior; gates and resources constrain behavior.

---

## Human Actions vs Gates

A human action is work assigned to a person.

A gate is a decision that permits, denies, or routes later work.

Human action example:

```yaml
- id: collect_business_context
  kind: action
  action:
    mode: human
```

Gate example:

```yaml
- id: approve_plan
  kind: gate
  gate_ref: gate.approve-plan
```

Practical rule: if a person must do work, use a human action. If a person must decide whether work may proceed, use a gate.

---

## `gate` Nodes

A `gate` node waits for a human, policy, or delegated decision.

Use it for approvals, safety checks, manual go/no-go decisions, or policy checkpoints.

Example:

```yaml
graph:
  nodes:
    - id: approve_plan
      kind: gate
      gate_ref: gate.approve-plan

gates:
  definitions:
    - id: gate.approve-plan
      decision_type: plan-approval
      required_role: reviewer
      options:
        - id: approve
          label: Approve
        - id: reject
          label: Reject
```

The IR defines the gate. Runtime records capture who approved, when, and with what evidence.

Practical rule: gates are part of the plan; gate outcomes are runtime state.

---

## `gateway` Nodes

A `gateway` node routes execution.

Use it when the workflow must choose, split, or race paths based on conditions or events.

Exclusive gateway example:

```yaml
nodes:
  - id: choose_path
    kind: gateway
    gateway:
      kind: exclusive
      default_edge: edge.choose.manual_review
edges:
  - id: edge.choose.auto_fix
    from: choose_path
    to: auto_fix
    kind: control
    when:
      language: workflow-ir.expr/v1
      expr: captures.risk_level == "low"
  - id: edge.choose.manual_review
    from: choose_path
    to: manual_review
    kind: control
```

This maps to BPMN exclusive gateways, Step Functions choices, or conditional branches in durable workflow code.

Practical rule: use a gateway when routing is itself meaningful and should be preserved across backends.

---

## `join` Nodes

A `join` node merges or synchronizes inbound paths.

Use it when multiple branches need explicit merge semantics.

Example:

```yaml
- id: merge_assessments
  kind: join
  join:
    kind: all
```

Meaning: all required inbound branches must succeed before the workflow continues.

Quorum example:

```yaml
- id: wait_for_two_reviews
  kind: join
  join:
    kind: quorum
    quorum: 2
```

Meaning: continue after two inbound review paths succeed.

Practical rule: use `join` when plain “all dependencies must succeed” is not expressive enough or when the merge point should be explicit.

---

## `wait` Nodes

A `wait` node pauses the workflow for a planned reason.

Use it for timers, messages, signals, external events, or polling conditions.

Timer example:

```yaml
- id: wait_for_replication
  kind: wait
  wait:
    kind: duration
    duration: 15m
```

Signal example:

```yaml
- id: wait_for_change_window
  kind: wait
  wait:
    kind: signal
    signal_ref: change-window-opened
```

Runtime wakeup details belong in runtime state, not the IR.

Practical rule: if waiting is part of the intended process, model it as `wait`.

---

## `subworkflow` Nodes

A `subworkflow` node calls another WorkflowIR contract.

Use it for reusable workflows, child workflows, call activities, or sub-DAGs.

Example:

```yaml
- id: run_storage_assessment
  kind: subworkflow
  workflow_ref:
    id: wf.z.storage-assessment
    version: v1
  invocation: sync
  error_propagation: propagate
  cancellation_propagation: propagate
  input_mapping:
    - input: cpc_name
      from: input.source_cpc_name
```

Practical rule: use `subworkflow` when the called unit has its own workflow identity and version.

---

## `control` Edges

`control` means execution ordering.

Use it when one node cannot start until another node reaches an acceptable state.

Example:

```yaml
- from: discover_source
  to: assess_readiness
  kind: control
```

Meaning: `assess_readiness` cannot start until `discover_source` succeeds, unless `on_status` says otherwise.

This maps cleanly to DAG `depends_on`, BPMN sequence flow, Gantry task links, Temporal workflow ordering, and Step Functions transitions.

Practical rule: `control` answers “when can this start?”

---

## `data` Edges

`data` means one node supplies data to another.

Use it when a produced value matters to a downstream node.

Example:

```yaml
- from: discover_source
  to: assess_readiness
  kind: data
```

Usually pair this with a binding:

```yaml
dataflow:
  bindings:
    - to_node: assess_readiness
      input: source_cpc
      from: capture.source_cpc
      required: true
```

A `data` edge alone does not always imply execution ordering. Add a `control` edge if the target must wait.

Practical rule: `data` answers “where did this value come from?”

---

## `guard` Edges

`guard` means authorization or gating.

Use it when one node permits, denies, or conditions another node.

Example:

```yaml
- from: approve_plan
  to: execute_migration
  kind: guard
```

Meaning: `approve_plan` guards `execute_migration`. The migration is not valid to run unless the approval gate passes.

In many simple engines this also needs a `control` edge:

```yaml
- from: approve_plan
  to: execute_migration
  kind: control
- from: approve_plan
  to: execute_migration
  kind: guard
```

Grounded distinction: `control` says when work can start. `guard` says what authorizes the work.

Practical rule: gates often need both `control` and `guard` when projecting to simple schedulers.

---

## `event` Edges

`event` means an event relationship connects two nodes.

Use it when a node emits, waits for, or is correlated with an event that affects another node.

Example:

```yaml
- from: wait_for_change_window
  to: execute_change
  kind: event
```

If the event also controls start order, add `control`:

```yaml
- from: wait_for_change_window
  to: execute_change
  kind: control
```

Practical rule: `event` preserves event semantics; `control` preserves scheduling semantics.

---

## `compensation` Edges

`compensation` means planned undo, rollback, remediation, or cleanup.

Use it when a node performs work that may need explicit recovery if later work fails or the workflow is cancelled.

Example:

```yaml
nodes:
  - id: allocate_target_capacity
    kind: action
  - id: release_target_capacity
    kind: action
edges:
  - from: allocate_target_capacity
    to: release_target_capacity
    kind: compensation
```

Meaning: if `allocate_target_capacity` succeeded but the workflow later fails or is cancelled, `release_target_capacity` is the planned compensation handler.

This maps to BPMN compensation handlers, saga rollback steps, Temporal compensation activities, and cleanup/finalizer tasks.

Practical rule: compensation is plan semantics. Runtime records say whether compensation actually ran.

---

## `correlation` Edges

`correlation` means semantic relationship without execution ordering.

Use it for traceability, grouping, audit, reporting, or projection hints when neither node blocks the other.

Example:

```yaml
- from: collect_source_inventory
  to: produce_assessment_report
  kind: correlation
```

Meaning: the report is related to the inventory collection, but this edge alone does not make the report wait for inventory.

Grounded uses:

- Link an observation task to the report section it informs.
- Link a task to an external ticket, incident, or workstream.
- Link parallel tasks that share a business concern.
- Preserve hierarchy or traceability when a backend has no native model.

Practical rule: if behavior depends on the relationship, do not use `correlation` alone.

---

## `when`

`when` is a condition on an edge.

Use it to decide whether a path is selected.

Example:

```yaml
- from: choose_path
  to: manual_review
  kind: control
  when:
    language: workflow-ir.expr/v1
    expr: captures.risk_level != "low"
```

This maps to BPMN conditional sequence flow, Step Functions choices, and conditional branches in workflow code.

Practical rule: use `when` for path selection. Use node `conditions` for node-level preconditions.

---

## Node `conditions`

Node `conditions` are preconditions on a node.

Use them when the node itself should only run under certain circumstances.

Example:

```yaml
- id: run_expensive_scan
  kind: action
  conditions:
    - language: workflow-ir.expr/v1
      expr: inputs.scan_depth == "full"
```

Practical rule: edge `when` chooses a path; node `conditions` decide whether a node is eligible.

---

## `start_when`

`start_when` controls how inbound control edges are interpreted.

Use it when the default “all inbound dependencies succeeded” behavior is not right.

Example:

```yaml
- id: notify_operator
  kind: action
  start_when: any_success
```

Meaning: `notify_operator` may start after any one inbound control dependency succeeds.

Practical rule: simple DAG workflows should usually omit `start_when` and use the default `all_success`.

---

## Lifecycle Statuses

Lifecycle statuses are the portable status vocabulary adapters use for diagnostics.

They are not stored as live state in the IR.

Statuses:

- `pending`
- `ready`
- `running`
- `waiting`
- `succeeded`
- `failed`
- `skipped`
- `cancelled`

Example edge that accepts a skipped upstream node:

```yaml
- from: optional_scan
  to: summarize
  kind: control
  on_status: [succeeded, skipped]
```

Practical rule: use lifecycle statuses in plan rules and diagnostics, not as live execution records.

---

## `retry`

`retry` describes planned retry behavior.

Use it when failed attempts should be retried by the backend.

Example:

```yaml
- id: call_hmc
  kind: action
  retry:
    max_attempts: 3
    backoff: exponential
    initial_delay: 5s
    max_delay: 1m
    retry_on: [transient-error, timeout]
```

Do not record actual attempts here. Actual attempts belong to runtime state.

Practical rule: `retry` is the policy, not the history.

---

## `timeout`

`timeout` describes planned timeout behavior.

Use it when a node or gate should not wait forever.

Example:

```yaml
- id: approve_plan
  kind: gate
  gate_ref: gate.approve-plan
  timeout:
    duration: 24h
    on_timeout: route
    target_node: escalate_approval
```

Practical rule: always state what should happen on timeout when timeout behavior affects correctness.

---

## `on_error`

`on_error` describes planned error routing.

Use it when failure should do something other than fail the workflow immediately.

Example:

```yaml
- id: validate_target
  kind: action
  on_error:
    strategy: route
    target_node: collect_manual_evidence
    error_types: [missing-data]
```

Practical rule: if an error changes the path, model it explicitly.

---

## `cancellation`

`cancellation` describes planned cancellation propagation.

Use it when cancellation of a node should cancel child work, pending downstream work, or subworkflows in a defined way.

Example:

```yaml
- id: run_cutover
  kind: subworkflow
  workflow_ref:
    id: wf.z.cutover
    version: v1
  cancellation_propagation: propagate
```

Practical rule: cancellation rules are especially important for subworkflows and long-running external work.

---

## `compensation` Field

The `compensation` field is another way to declare planned undo behavior directly on a node.

Use it when one handler node clearly compensates one action node.

Example:

```yaml
- id: allocate_capacity
  kind: action
  compensation:
    handler_node: release_capacity
    trigger: on_failure
```

This is equivalent in intent to a compensation edge, but local to the compensated node.

Practical rule: use the field for simple one-to-one compensation; use edges for more complex compensation graphs.

---

## `dataflow.captures`

Captures name values produced by nodes.

Use them when later nodes need part or all of a node result.

Example:

```yaml
dataflow:
  captures:
    - id: capture.source_cpc
      from_node: discover_source
      name: source_cpc
      path: $.cpc
      value_type:
        kind: object
        schema_ref: schema://ibm-z/hmc.cpc/v1
```

Practical rule: captures make produced values addressable.

---

## `dataflow.bindings`

Bindings connect values to node inputs.

Use them when a node consumes a workflow input, capture, resource, literal, or expression.

Example:

```yaml
dataflow:
  bindings:
    - to_node: assess_readiness
      input: source_cpc
      from: capture.source_cpc
      required: true
      value_type:
        kind: object
        schema_ref: schema://ibm-z/hmc.cpc/v1
```

Practical rule: captures name produced values; bindings pass values into consumers.

---

## `dataflow.outputs`

Workflow outputs are named values published by the workflow contract.

Use them when callers or subworkflow parents need structured results.

Example:

```yaml
dataflow:
  outputs:
    - name: readiness_result
      from: capture.readiness_result
      value_type:
        kind: object
        schema_ref: schema://z/readiness-result/v1
```

Practical rule: outputs are for structured values; artifacts are for durable deliverables.

---

## `gates.definitions`

Gate definitions describe decision shape and policy.

Use them to make gate nodes reusable and auditable.

Example:

```yaml
gates:
  definitions:
    - id: gate.review-risk
      decision_type: risk-review
      required_role: reviewer
      evidence_requirements:
        - risk-summary
        - source-inventory
      options:
        - id: approve
          label: Approve
        - id: reject
          label: Reject
```

Practical rule: the gate definition says what decision is needed. Runtime state says what decision was made.

---

## `resources.systems`

Systems are external domains the workflow expects to use.

Use them for APIs, databases, knowledge bases, notebooks, vaults, or external platforms.

Example:

```yaml
resources:
  systems:
    - id: hmc
      kind: external-api
      description: Hardware Management Console API.
```

Practical rule: systems declare dependencies; bindings and action refs say how nodes use them.

---

## `resources.locks`

Locks describe mutual exclusion requirements.

Use them when two workflow instances or nodes must not mutate the same target concurrently.

Example:

```yaml
resources:
  locks:
    - id: lock.target-cpc
      scope: input.target_cpc_name
      mode: exclusive
      required_by: [execute_change]
```

Practical rule: use locks for correctness-critical concurrency constraints, not as scheduler hints.

---

## `resources.quotas`

Quotas describe rate or concurrency limits.

Use them when a system or workflow class has bounded capacity.

Example:

```yaml
resources:
  quotas:
    - id: hmc-api-rate
      system: hmc
      limit: 10
      interval: 1m
```

Practical rule: quotas protect shared systems; priorities only influence scheduling preference.

---

## `artifacts.outputs`

Artifacts are durable deliverables or publication intents.

Use them for reports, generated files, bundles, notebooks, logs intended for review, or published packages.

Example:

```yaml
artifacts:
  outputs:
    - id: assessment-report
      kind: report
      producer_node: write_report
      publish: true
      audience: [operator, auditor]
```

Do not put concrete artifact URIs or digests from one run in canonical IR. Those belong to runtime artifact lineage.

Practical rule: artifact declarations say what should exist; runtime lineage says what was produced.

---

## `execution_hints`

Execution hints are advisory preferences.

Use them for scheduling or runtime preferences that do not affect correctness.

Example:

```yaml
execution_hints:
  preferred_harness: gantry
  priority: high
  concurrency_group: migration-assessments
```

Do not put required behavior in hints. Required behavior belongs in graph, dataflow, resources, gates, or capabilities.

Practical rule: a backend may ignore hints and still be correct.

---

## `provenance`

Provenance records where the IR came from.

Use it for traceability, reproducibility, and audit.

Example:

```yaml
provenance:
  source_refs:
    - metro-packages/workflows/workflows/z/migration-assessment.md
  compiled_from:
    format: metro-workflow-markdown
    path: metro-packages/workflows/workflows/z/migration-assessment.md
    commit: git:4f2c1b7
  compiler:
    name: metro-workflow-compiler
    version: v0.3.0
  content_digest: sha256:0123456789abcdef
```

Practical rule: provenance explains origin. It does not replace workflow identity.

---

## `extensions`

Extensions carry namespaced additive data.

Use them for project-specific details that should not become canonical WorkflowIR semantics.

Example:

```yaml
extensions:
  gantry/task-link:
    lane: operator-review
  ibm-z/topology:
    topology_scope: cpc
```

If an extension is required for correctness, declare it in `capabilities.required_extensions`.

Example:

```yaml
capabilities:
  required_extensions:
    - name: ibm-z/topology
      version: v1
      reason: Required to bind CPC topology constraints.
      schema_ref: schema://ibm-z/topology-extension/v1
```

Practical rule: optional extensions may be ignored. Required extensions may not be ignored.

---

## Projection Diagnostics

Projection diagnostics explain what an adapter did.

Use them whenever compiling WorkflowIR into a backend-specific model.

Example:

```yaml
target_backend: simple-dag
supported_profiles: [basic-dag, typed-dataflow]
required_profiles: [basic-dag, human-gates]
accepted_features: [action, gate, control-edge]
rejected_features:
  - human-gates
lossy_mappings: []
warnings: []
result: rejected
```

Meaning: the backend cannot preserve a required profile, so it must reject the projection.

Practical rule: never silently drop required behavior.

---

## Runtime State Boundary

WorkflowIR describes the plan. Runtime state describes one execution of the plan.

Do not put these in canonical IR:

- live node status
- actual retry attempts
- runtime owner or claim
- operator response
- produced artifact URI
- produced artifact digest
- event history
- session membership

Runtime example, not IR:

```yaml
node_id: approve_plan
status: succeeded
approved_by: alice
approved_at: 2026-06-04T12:00:00Z
```

Practical rule: if it answers “what happened in this run?”, it belongs outside WorkflowIR.

---

## Choosing The Right Relationship

Use this quick decision table when choosing edge kinds.

| Question | Edge kind |
| --- | --- |
| Must B wait for A? | `control` |
| Does A provide data to B? | `data` |
| Does A authorize B? | `guard` |
| Does A emit or wait for an event relevant to B? | `event` |
| Is B planned undo/remediation for A? | `compensation` |
| Are A and B related only for traceability? | `correlation` |

When in doubt, use `control` for scheduling behavior and another edge kind for semantic intent.

---

## Minimal Complete Example

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.z.assessment
  version: v1
  title: Z readiness assessment

capabilities:
  required_profiles: [basic-dag, human-gates]
  optional_profiles: [typed-dataflow]

inputs:
  - name: source_cpc_name
    required: true
    value_type:
      kind: string

graph:
  nodes:
    - id: discover_source
      kind: action
      action:
        ref: api.hmc.get_cpc
        mode: deterministic
    - id: assess_readiness
      kind: action
      action:
        ref: tool.assess_readiness
        mode: deterministic
    - id: approve_plan
      kind: gate
      gate_ref: gate.approve-plan
    - id: write_report
      kind: action
      action:
        ref: tool.write_report
        mode: deterministic
  edges:
    - from: discover_source
      to: assess_readiness
      kind: control
    - from: discover_source
      to: assess_readiness
      kind: data
    - from: assess_readiness
      to: approve_plan
      kind: control
    - from: approve_plan
      to: write_report
      kind: control
    - from: approve_plan
      to: write_report
      kind: guard

dataflow:
  captures:
    - id: capture.source_cpc
      from_node: discover_source
      name: source_cpc
      value_type:
        kind: object
        schema_ref: schema://ibm-z/hmc.cpc/v1
  bindings:
    - to_node: assess_readiness
      input: source_cpc
      from: capture.source_cpc
      required: true

gates:
  definitions:
    - id: gate.approve-plan
      decision_type: plan-approval
      required_role: reviewer
      options:
        - id: approve
          label: Approve
        - id: reject
          label: Reject

artifacts:
  outputs:
    - id: assessment-report
      kind: report
      producer_node: write_report
      publish: true
```

This workflow is simple enough for a DAG backend but still preserves gate intent, typed dataflow metadata, and artifact expectations.
