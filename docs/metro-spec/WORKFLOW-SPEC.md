# Workflow Specification v1

**Date**: 2026-03-09
**Status**: Draft — extracted from 30 workflow definitions + engine implementation
**Source**: `agent/docs/workflows/*.md`, `agent/pkg/scripted/`
**Plan**: `memo-019-plan-metro-z-plan.md` (upstream Metro memo, not vendored here)
**Prompt object spec**: [PROMPT-SPEC.md](PROMPT-SPEC.md)
**Parsed JSON schema**: `schemas/workflow.json` (upstream Metro schema, not vendored here)
**Workflow docs hub**: [workflow-README.md](workflow-README.md)
**WorkflowIR**: [WORKFLOW-IR-SPEC.md](WORKFLOW-IR-SPEC.md)

---

## Overview

A workflow is a Markdown document containing embedded YAML blocks that define a structured, executable automation sequence. The Markdown provides human-readable narrative (the "why"); the YAML `scripted` blocks provide machine-executable steps (the "what").

Workflows are parsed by the scripted engine, validated against the action catalog and entity state machines, and executed either in-process or durably via go-workflows.

This spec owns the **authoring format**. WorkflowIR owns the durable graph
contract used for backend projection. See [workflow-README.md](workflow-README.md)
for the workflow documentation map and [WORKFLOW-IR-SPEC.md](WORKFLOW-IR-SPEC.md)
for the intermediate representation.

---

## Document Structure

A workflow file is standard Markdown with the following required structure:

```
# Workflow: <name>

**Outcome**: <one-sentence description of what the workflow achieves>

[optional prose sections: Background, Prerequisites, Grounding]

```scripted              ← metadata block (first scripted block)
profile: <profile>
params: [...]
[tags: [...]]
[tier: <safety-tier>]
[category: <category>]
```

## Step Title

[narrative prose explaining the step]

```scripted              ← step block (one per step)
id: <step_id>
action: <namespace.action_name>
...
```

[repeat for each step]

```

### Parsing Rules

1. **Workflow name**: Extracted from the first `# ` heading. If the heading starts with `Workflow: `, that prefix is stripped.
2. **Description**: Taken from the first `**Outcome**:` line, or the first non-empty paragraph after the heading.
3. **Code blocks**: Only ` ```scripted ` fenced blocks are processed. Each block is parsed as YAML.
4. **Block type detection** (based on top-level YAML keys):
   - `params:` key present → parameter definitions
   - `parallel:` key present → parallel step group (requires >= 2 steps)
   - `id:` + `action:` present → sequential step
5. **Narrative capture**: Prose text between code blocks is collected and attached to the next step's `context` field.

---

## Metadata Block

The first `scripted` block in the document defines workflow metadata and parameters. It does not have an `id` or `action`.

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `profile` | **Yes** | string | Execution profile (see Profiles) |
| `params` | **Yes** | array | Parameter definitions (may be empty `[]`) |
| `tags` | No | string[] | Freeform tags for filtering/search |
| `tier` | No | string | Safety tier classification (see Safety Tiers) |
| `category` | No | string | Workflow category (see Categories) |

### Profiles

Profiles determine runtime behavior — what the engine manages automatically and what actions are permitted.

| Profile | Slug | Semantics |
|---------|------|-----------|
| API | `api-workflow` | API operations; engine auto-manages authentication (D30). Credential params and explicit `api.authenticate`/`api.logout` steps are **forbidden**. |
| IOCP | `iocp-workflow` | IOCP compiler operations. |
| Remediation | `remediation` | Hardware remediation. Engine auto-manages auth. |
| z/OSMF | `zosmf-workflow` | z/OSMF API operations. |
| Standalone | `standalone` | No external dependencies. Used for tests, audits, sub-workflows. |

**Profile constraints** (enforced by validator):

| ID | Profile | Rule |
|----|---------|------|
| A | API | Forbidden params: `api_host`, `api_port`, `api_user`, `api_password` |
| B | API | Forbidden step action: `api.authenticate` |
| C | API | Forbidden step action: `api.logout` |
| D | All | Variable lifecycle: unresolved references, shadowed variables, late defaults flagged; unconsumed outputs are trace metadata |
| E | All | Step IDs must be `snake_case` |
| F | All | Entity lifecycle coherence: no mutating unfetched entities, no consecutive mutations without fetch |

### Safety Tiers

| Tier | Description | Actions Permitted |
|------|-------------|-------------------|
| `T0` | Read-only / observational | List, get, query, discover, report |
| `T2` | Mutating / state-changing | Activate, deactivate, start, stop, create, update, delete, load |

Tier escalation (e.g., `T0→T2`) indicates the workflow starts read-only but may escalate to mutating operations based on findings.

### Categories

| Category | Description |
|----------|-------------|
| `migration` | CPC/LPAR technology refresh and profile migration |
| `provisioning` | Partition/LPAR creation and boot sequences |
| `remediation` | Automated recovery from hardware errors or service failures |
| `discovery` | API probing, topology enumeration, feature assessment |
| `performance` | Channel optimization, WLM analysis, metrics collection |
| `security` | Security posture validation, audit log analysis |
| `operations` | Profile management, IODF activation, hardware troubleshooting |
| `compliance` | SBOM generation, supply chain audit |
| `test` | Engine test workflows (not production) |
| `research` | General and deep research workflows |
| `eval` | Evaluation harness workflows |
| `sim-scenarios` | Metadata-only simulation scenario descriptors |

### Parameter Definition

Each entry in the `params` array:

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | **Yes** | string | `snake_case` identifier |
| `description` | **Yes** | string | Human-readable description (quoted) |
| `required` | No | boolean | Whether the parameter must be provided. Default: `false` |
| `default` | No | string | Default value if not provided (quoted) |

Example:

```yaml
params:
  - name: source_cpc_name
    description: "Name of the source CPC"
    required: true
  - name: target_cpc_name
    description: "Name of the target CPC"
    required: true
  - name: skip_cache_validation
    description: "Skip cache structure validation for speed"
    default: "false"
```

---

## Step Block

Each step is a `scripted` block with an `id` and `action`. Steps execute sequentially unless wrapped in a `parallel` group.

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | **Yes** | string | Unique `snake_case` identifier within the workflow |
| `action` | **Yes** | string | Dotted `namespace.action_name` (e.g., `api.list_resources`) |
| `label` | Effectively yes | string | Human-readable label. Supports `{{var}}` interpolation. |
| `with` | Contextual | map | Key-value input parameters for the action. Supports `{{var}}` templates. |
| `outputs` | No | map | `variable_name: "$.jsonpath"` — extract values from step result |
| `validate` | No | array | Post-step assertions: `[{expr: "...", message: "..."}]` |
| `on_error` | No | string | Error handling policy. Default: `fail` |
| `register` | No | string | Variable name to store the full raw result |
| `register_type` | No | string | Typed identity for the registered full result object; should match the action catalog `command_output_type` when present |
| `consume` | No | string | Name of a previously `register`ed variable to consume as a typed handoff; the consumer action must accept that type |
| `capture` | No | object | Structured typed result capture; richer form of `register` / `register_type` |
| `inputs` | No | map | Structured typed bindings from prior captured variables into named action parameters |
| `if` | No | string | Conditional expression; step is skipped if false |
| `timeout` | No | string | Duration: `30s`, `120s`, `2m` |
| `prompt_ref` | No | string | Metro prompt catalog reference for prompt-driven steps (recommended for `builtin.llm_ask`) |
| `prompt_version` | No | string | Optional pinned or requested prompt semantic version used with `prompt_ref` |
| `parallel` | No | array | Replaces all other fields; array of step definitions for concurrent execution |

### Example Step

```yaml
id: list_cpcs
action: api.list_resources
label: "Enumerate available CPCs"
register: cpc_inventory
register_type: tool.api.list_resources.result
outputs:
  cpcs: "$.cpcs"
  cpc_count: "$.total"
validate:
  - expr: "len(cpcs) > 0"
    message: "No resources found"
on_error: retry(3)
```

### Typed Handoff With `consume`

`consume` is the smallest structured handoff form on top of `register`/`register_type`.

```yaml
id: assess_version
action: tfe.app_version.assess
consume: version_payload
with:
  version: "{{version_payload}}"
```

Validation rules:

- `consume` must reference a variable produced by a prior step `register`
- the producer step must declare `register_type`
- the consumer action must advertise that same type in `command_input_types` or `pipe_input_types`
- `consume` is validator-only metadata in this first slice; it does not change executor wiring semantics

### Structured Capture

`capture` is the richer structured form of `register` / `register_type`.

```yaml
id: capture_version
action: tfe.app_version.get
capture:
  var: version_payload
  type: tool.tfe.get_app_version.result
with:
  hostname: "{{tfe_hostname}}"
```

Validation rules:

- `capture.var` is required
- `capture.type` is optional if the action catalog already advertises `command_output_type`
- if both `capture.type` and the action catalog `command_output_type` are present, they must match

### Structured Typed Inputs

`inputs` binds prior typed captures directly into named action parameters.

```yaml
id: assess_version
action: tfe.app_version.assess
inputs:
  version:
    from: version_payload
    type: tool.tfe.get_app_version.result
```

Validation rules:

- each `inputs.<param>` key names the target action parameter
- `from` is required
- `type` is optional if inferable from the source capture
- the consumer action must advertise that type in `command_input_types` or `pipe_input_types`

### Migration Notes For Typed Handoff

- `register` + `register_type` remain valid shorthand for `capture`
- `consume` remains valid shorthand for the minimal typed handoff form
- structured forms are preferred when authors want explicit typed capture/input bindings
- conflicting shorthand and structured declarations on the same step are invalid

### Prompt-backed `builtin.llm_ask`

Prompt-driven workflow steps should prefer Metro prompt catalog references over inline system prompt text.

```yaml
id: assess_source_capacity
action: builtin.llm_ask
label: "Assess source CPC capacity risk"
prompt_ref: prompt://workflow.capacity.assessment@1.0.0
prompt_version: 1.0.0
with:
  question: "Assess whether the source CPC is overcommitted."
```

Notes:

- `prompt_ref` points at the canonical Metro prompt definition.
- `prompt_version` is optional during migration, but published workflows should resolve deterministically to a versioned prompt.
- raw inline `with.system` text is legacy-compatible but should be treated as migration fallback, not the steady-state authoring pattern.

### Workflow Link References

Workflows may reference other workflow documents or specific sections using standard catalog-path links.

**Canonical form**:

```text
workflows/<category>/<slug>#<section-anchor>
```

Examples:

- `workflows/shared/steps/proxy-query#channel-path-map`
- `workflows/performance/channel-optimization#error-handling`

Use this same form in:

- markdown narrative links between workflows
- action parameter values when a tool intentionally accepts workflow-backed references (for example `api.query.with.query_type`)

#### Path formation

- `<category>` is the workflow catalog directory under `metro-packages/workflows/workflows/` such as `discovery`, `performance`, `operations`, or `shared/steps`
- `<slug>` is the markdown filename without the `.md` suffix
- the path must be rooted at `workflows/` rather than a repo-relative filesystem path

#### Section anchor formation

Section anchors are derived from the target markdown heading text:

- lowercase the heading text
- remove punctuation that is not part of a word
- replace spaces, underscores, slashes, and repeated separators with single hyphens

Examples:

- `### Channel Path Map` → `#channel-path-map`
- `### IO Config` → `#io-config`
- `## Error Handling` → `#error-handling`

#### Validation

Metro workflow validation checks workflow catalog links in markdown narrative:

- `WF16` — target workflow catalog path must exist
- `WF17` — target section anchor must exist in that workflow

When a tool parameter carries a workflow link, authors should use the same canonical form so runtime resolution and preview rendering stay consistent.

---

## Template Interpolation

**Syntax**: `{{variable_name}}`

Templates are resolved against the variable store before step execution.

**Variable sources** (in resolution order):

1. `params` defined in the metadata block (provided at invocation or defaults)
2. `outputs` extracted from prior steps via JSONPath
3. `register` captures from prior steps (full raw result)
4. Runtime-injected variables (e.g., `session` for managed auth profiles)

### JSONPath in `outputs`

| Pattern | Meaning |
|---------|---------|
| `"$.field_name"` | Top-level field |
| `"$.object.field"` | Nested field |
| `"$.array[0]"` | First element |
| `"$.array[-1]"` | Last element |
| `"$.results[?name=='value']"` | Filter by field value |
| `"$.array.length()"` | Array length (returns integer) |
| `"$.field_name?"` | Optional (nullable) — trailing `?` suppresses missing-field errors |

---

## Validation Expressions

Post-step assertions that fail fast on broken invariants.

```yaml
validate:
  - expr: "len(cpcs) > 0"
    message: "No resources found"
  - expr: "lpar.status == 'operating'"
    message: "LPAR is not in operating state"
```

| Field | Type | Description |
|-------|------|-------------|
| `expr` | string | Boolean expression. Supports `len()`, comparisons (`==`, `!=`, `>`, `<`, `>=`, `<=`), logical operators (`&&`, `||`,`!`), field access. |
| `message` | string | Human-readable error shown on validation failure. |

---

## Error Handling

### `on_error` Policies

| Policy | Behavior |
|--------|----------|
| `fail` | Abort workflow immediately. **Default.** |
| `skip` | Log warning, set all step outputs to `nil`, continue to next step. |
| `retry(N)` | Retry step up to N times (1-10) with exponential backoff. First delay: 1s; max delay: 30s; coefficient: 2.0. |
| `ask` | Emit a recovery cell with options (retry/skip/rollback/abort), pause workflow until operator responds. In sub-workflows, falls back to `fail` with a warning. |

**Resolution**: Step-level `on_error` overrides workflow-level `on_error`, which defaults to `fail`.

### Error Classification

The engine auto-classifies errors into 6 categories:

| Category | Retryable | Example Patterns |
|----------|-----------|------------------|
| `transient` | Yes | timeout, connection refused, rate limit, service unavailable |
| `permanent` | No | not found, permission denied, invalid transition, already exists |
| `user-input` | No | missing required, invalid variable, template error, assertion failed |
| `config` | No | no handler, unknown action, not registered |
| `upstream` | No | API/HTTP/LLM errors |
| `internal` | No | Unrecognized errors (treated as bugs) |

---

## Parallel Execution

A `parallel` block replaces the normal step fields and contains an array of step definitions that execute concurrently.

```yaml
parallel:
  - id: check_source_profiles
    action: api.list_profiles
    label: "List source profiles"
    with:
      cpc_uri: "{{source_cpc_uri}}"
    outputs:
      source_profiles: "$.profiles"
  - id: check_target_profiles
    action: api.list_profiles
    label: "List target profiles"
    with:
      cpc_uri: "{{target_cpc_uri}}"
    outputs:
      target_profiles: "$.profiles"
```

**Rules**:

- Must contain >= 2 steps.
- Each step gets a **cloned** variable store for isolation.
- Output variables are **merged** after all steps complete. Conflicts (same key written by multiple steps) cause an error.
- Parallel steps cannot contain nested `parallel` blocks.

---

## Sub-Workflow Composition

Workflows can invoke other workflows using the `workflow.run` action.

```yaml
id: run_profile_migration
action: workflow.run
label: "Run profile migration sub-workflow"
with:
  workflow: "cpc-profile-migration"
  params:
    source_cpc_name: "{{source_cpc_name}}"
    target_cpc_name: "{{target_cpc_name}}"
```

### Composition Rules

| Rule | Description |
|------|-------------|
| **Maximum nesting depth** | 3 levels |
| **No circular references** | DFS cycle detection at validation time |
| **Profile compatibility** | Child profile must match parent profile |
| **Parameter completeness** | All required child params must be provided |
| **Entity store sharing** | Child shares parent's entity store (mutations visible to parent) |
| **Variable isolation** | Child gets its own variable store (seeded with defaults + provided params) |

---

## Operator Decision Points

The `builtin.operator_decision` action pauses the workflow for human input.

### Decision Types

| Type | Description |
|------|-------------|
| `ask-compute` | Computing resource decision (processor count, weight, etc.) |
| `ask-storage` | Storage configuration decision |
| `ask-network` | Network configuration decision |
| `approve-activation` | Binary approve/reject for an activation or mutation |

### Decision Structure

```yaml
id: choose_processor_config
action: builtin.operator_decision
label: "Select processor configuration for {{target_lpar}}"
with:
  decision_id: "proc-config-01"
  decision_type: "ask-compute"
  label: "Processor Configuration"
  summary: "Choose processor allocation for the target LPAR"
  default_option: "match-source"
  timeout_sec: 300
  options:
    - id: match-source
      label: "Match Source"
      description: "Use same processor count as source"
      recommended: true
    - id: scale-up
      label: "Scale Up"
      description: "Increase processor count by 50%"
      impact: "Higher cost, better performance"
      custom_fields:
        - id: processor_count
          label: "Processor Count"
          type: integer
          default: 4
          min: 1
          max: 64
    - id: cancel
      label: "Cancel Migration"
      destructive: true
      terminal: true
  context:
    source_cpc: "{{source_cpc_name}}"
    target_cpc: "{{target_cpc_name}}"
    risk_level: "medium"
```

### Option Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique option identifier |
| `label` | string | Display text |
| `description` | string | Longer explanation |
| `impact` | string | Impact description |
| `recommended` | boolean | Highlight as recommended choice |
| `destructive` | boolean | Red/warning styling in UI |
| `terminal` | boolean | Selecting this ends the workflow |
| `custom_fields` | array | Additional form fields (see below) |

### Custom Field Types

Each custom field in an option has these base fields:

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | **Yes** | string | Unique field identifier |
| `label` | **Yes** | string | Display label |
| `type` | **Yes** | string | One of: `integer`, `string`, `boolean`, `enum` |
| `default` | No | varies | Default value |
| `required` | No | boolean | Whether the field must be filled |

Type-specific extra fields:

| Type | Extra Fields | Description |
|------|-------------|-------------|
| `integer` | `min`, `max` | Numeric input with range constraints |
| `string` | — | Free-text input |
| `boolean` | — | Toggle |
| `enum` | `options` (string[]) | Dropdown selection |

---

## Cell Output Types

Steps emit structured output cells for rendering in the UI:

| Cell Type | Description |
|-----------|-------------|
| `text` | Prose text (markdown) |
| `table` | Tabular data with headers |
| `diff` | Before/after comparison |
| `entity-tree` | Hierarchical entity view (CPC → LPAR → ...) |
| `capacity-chart` | Capacity comparison visualization |
| `status-badge` | Status indicator (operating, stopped, etc.) |
| `question` | Free-text or structured question to operator |
| `approval` | Binary approve/reject |
| `recovery` | Error recovery menu (retry/skip/rollback/abort) |
| `decision` | Multi-option decision with custom fields |

---

## Action Catalog

Actions are organized into namespaces. Each action defines its parameters, return type, timeout bounds, and mutation flag.

### Namespaces

| Namespace | Count | Description |
|-----------|-------|-------------|
| `builtin` | 19 | Utility actions: set, filter, format, log, LLM calls, analysis, decisions |
| `api` | 51 | API operations: resource listing, configuration, metrics, console, auth |
| `iocp` | 20 | IOCP compiler: compile, topology, CSS analysis, fabric management |
| `workflow` | 1 | Sub-workflow invocation (`workflow.run`) |
| `zosmf` | 3 | z/OSMF discovery: info, systems, system detail |
| `sim` | 3 | SE simulator: session management, task dispatch |

### Action Definition Schema

Each action in the catalog has:

```
ActionDef {
  Name           string          // e.g., "list_cpcs"
  Category       ActionCategory  // builtin | api | iocp | llm | sim | terraform | workflow | zosmf
  ParamSpecs     []ParamSpec     // input parameters
  Returns        []ReturnSpec    // output fields
  OutputPaths    map[string]string // known JSONPath outputs
  RequiresAuth   bool            // needs authenticated session
  Mutating       bool            // modifies state
  AsyncFollowUp  string          // follow-up action for async jobs
  TargetKind     string          // entity kind this action targets (cpc, lpar, partition)
  TargetParam    string          // param name that identifies the target
  FetchesKind    string          // entity kind this action fetches
  Timeout        TimeoutBounds   // min/max/default timeout
}
```

### Complete Action List

**`builtin.*`** (19): `set`, `filter`, `format`, `wait`, `log`, `assert`, `llm_ask`, `checkpoint`, `analyze_weights`, `analyze_wlm_policy`, `check_http`, `operator_decision`, `analyze_gaps`, `assess_exposure`, `confirm_plan`, `compare_capacity`, `adjust_profiles`, `compare_profiles`, `generate_report`

**`api.*`** (51, example domain): `authenticate`, `logout`, `get_version`, `get_console`, `list_cpcs`, `get_cpc`, `get_cpc_details`, `deactivate_cpc`, `activate_cpc`, `list_hardware_messages`, `request_service`, `create_cpc`, `delete_cpc`, `load_scenario`, `list_lpars`, `get_lpar`, `update_lpar`, `send_os_command`, `list_os_messages`, `activate_lpar`, `load_lpar`, `scsi_load_lpar`, `deactivate_lpar`, `reset_clear`, `reset_normal`, `list_partitions`, `get_partition`, `start_partition`, `stop_partition`, `pause_partition`, `resume_partition`, `list_image_profiles`, `get_image_profile`, `create_image_profile`, `update_image_profile`, `delete_image_profile`, `get_load_profile`, `create_load_profile`, `delete_load_profile`, `export_profiles`, `import_profiles`, `import_dpm_config`, `list_users`, `get_audit_log`, `get_security_log`, `get_job`, `create_metrics_context`, `get_metrics`, `zos_query`, `zos_discovery`, `query_metadata`

**`iocp.*`** (20): `compile`, `check`, `get_iocds`, `load_iocds`, `get_machine_type`, `set_machine_type`, `get_topology`, `set_topology`, `get_policy`, `set_policy`, `get_layout`, `set_layout`, `get_fabrics`, `set_fabrics`, `resolve`, `resolve_preview`, `get_limits`, `analyze_css_placement`, `query_css_paths`, `query_functions`

**`workflow.*`** (1): `run`

**`zosmf.*`** (3): `get_info`, `list_systems`, `get_system`

**`sim.*`** (3): `open_se_session`, `dispatch_se_task`, `close_se_session`

---

## State Machine Validation

The engine validates step sequences against entity state machines. This prevents invalid operations (e.g., loading an LPAR that isn't activated).

### CPC States

```
no-power → not-operating → operating
                ↑               ↓
                ← ← ← ← ← ← ← ←
              (also: service-required, degraded, exceptions)
```

Transitions: `activate_cpc` (not-operating → operating), `deactivate_cpc` (operating → not-operating)

### LPAR States (Classic Mode)

```
not-activated → not-operating → operating
       ↑                            ↓
       ← ← ← ← ← ← ← ← ← ← ← ← ←
                       (also: exceptions)
```

Transitions: `activate_lpar` (not-activated → not-operating), `load_lpar`/`scsi_load_lpar` (not-operating → operating), `deactivate_lpar` (operating → not-activated), `reset_clear`/`reset_normal` (operating → not-operating)

### Partition States (DPM Mode)

```
stopped → active → paused
   ↑        ↓        ↓
   ← ← ← ← ←   ← ← ←
```

Transitions: `start_partition` (stopped → active), `stop_partition` (active → stopped), `pause_partition` (active → paused), `resume_partition` (paused → active)

---

## Validation Checks

The validator runs 20 checks at parse time:

| # | Check | Description |
|---|-------|-------------|
| 1 | Action resolution | Action exists in catalog or dispatcher |
| 2 | Template variables | All `{{var}}` references resolve to params, outputs, or registers |
| 3 | Duplicate step IDs | No two steps share the same `id` |
| 4 | Error policy validity | `on_error` is one of: `fail`, `skip`, `ask`, `retry(N)` where N=1-10 |
| 5 | Step count limit | Total steps <= 50 |
| 6 | Output selector format | JSONPath selectors are syntactically valid |
| 7 | Param name non-empty | All params have a `name` |
| 8 | Metadata name | `Metadata.Name` is non-empty |
| 9 | Required params | All required params are marked and present |
| 10 | Unknown params / auth ordering | Param names are known; auth ordering is correct |
| 11 | Async follow-up | Async actions have a corresponding follow-up action |
| 12 | Job capture | Async actions capture job result for follow-up |
| 13 | Timeout bounds | Step timeout is within catalog-defined min/max |
| 14 | Output paths | Output selectors match known catalog `OutputPaths` |
| 15 | State machine pre-conditions | Action sequences are valid per entity state machines |
| 16 | Child workflow exists | `workflow.run` references a registered workflow |
| 17 | No circular references | DFS cycle detection in workflow composition graph |
| 18 | Profile compatibility | Child workflow profile matches parent profile |
| 19 | Parameter completeness | All required child workflow params are provided |
| 20 | Nesting depth | Composition depth <= 3 |

---

## Execution Model

### Sequential Execution

Steps execute in document order. Each step's outputs are available to subsequent steps via the variable store.

### Durable Execution (go-workflows)

The `ScriptedWorkflow` function is the durable entry point. It:

1. Iterates `ExecutionNode` entries (steps + parallel groups).
2. Sequential steps are dispatched as go-workflows activities.
3. Parallel groups launch concurrent activities with a `WaitGroup` barrier.
4. `on_error=ask` pauses via a go-workflows signal channel (`SignalAskResponse`).

### Session Management

| Limit | Value |
|-------|-------|
| Concurrent workflows | 10 |
| Max retained sessions | 50 |
| Stream TTL | 1 hour |
| Entity store TTL | 4 hours |

### Live Reload

The engine watches `agent/docs/workflows/` via `fsnotify`. Changes are debounced (500ms) and atomically swapped into the registry. A zero-workflow safety guard prevents catalog wipe from accidental directory deletion.

---

## Appendix A: Coverage Audit

Spec field coverage across the 30 existing workflow files:

| Field | Present In | Coverage |
|-------|-----------|----------|
| `profile` | 30/30 | 100% |
| `params` | 30/30 | 100% |
| `id` (per step) | 30/30 | 100% |
| `action` (per step) | 30/30 | 100% |
| `label` | ~28/30 | ~93% |
| `with` | ~27/30 | ~90% |
| `outputs` | ~25/30 | ~83% |
| `validate` | ~20/30 | ~67% |
| `on_error` | ~18/30 | ~60% |
| `register` | ~10/30 | ~33% |
| `if` | ~8/30 | ~27% |
| `tags` | 7/30 | 23% |
| `timeout` | ~5/30 | ~17% |
| `parallel` | 1/30 | 3% |
| `tier` | 1/30 | 3% |
| `category` | 1/30 | 3% |

### Known Gaps

1. **`tier` and `category`** are in only 1/30 workflows. These should be required metadata for catalog indexing and safety enforcement.
2. **`tags`** are in only 7/30 workflows. Should be encouraged for discoverability.
3. **Safety tier is not enforced in the engine** — it is a documentation-only classification today.

---

## Appendix B: Workflow Inventory

Step counts are approximate except where verified by validation. A `~` prefix indicates the count was estimated from the workflow catalog, not from direct parsing. Category and safety tier values are from the workflow catalog design; only `zosmf-discovery.md` declares these in its metadata block today. The following table shows example workflows from a domain-specific deployment.

| # | Workflow | File | Profile | Category | Safety | Steps |
|---|----------|------|---------|----------|--------|-------|
| 1 | z15→z17 Migration | `z15-to-z17-migration.md` | api-workflow | migration | T2 | 12 |
| 2 | CPC Profile Migration | `cpc-profile-migration.md` | api-workflow | migration | T2 | ~15 |
| 3 | LPAR Profile Export/Import | `lpar-profile-export-import.md` | api-workflow | migration | T2 | ~12 |
| 4 | Boot Linux Classic LPAR | `boot-linux-classic-lpar.md` | api-workflow | provisioning | T2 | ~13 |
| 5 | Create Linux Partition | `create-linux-partition.md` | api-workflow | provisioning | T2 | ~14 |
| 6 | Activate IODF HMC-Wide | `activate-iodf-hmc-wide.md` | api-workflow | operations | T2 | ~10 |
| 7 | FICON Channel Optimization | `ficon-channel-optimization.md` | api-workflow | performance | T0 | ~17 |
| 8 | OSA Report | `osa-report.md` | api-workflow | performance | T0 | ~10 |
| 9 | HMC API Probing | `hmc-api-probing.md` | api-workflow | discovery | T0 | ~8 |
| 10 | HMC Security Health Check | `hmc-security-health-check.md` | api-workflow | security | T0 | ~10 |
| 11 | z/OS Console I/O Discovery | `zos-console-io-discovery.md` | api-workflow | discovery | T0 | ~8 |
| 12 | z/OS Proxy I/O Discovery | `zos-proxy-io-discovery.md` | api-workflow | discovery | T0 | ~8 |
| 13 | z/OSMF Discovery | `zosmf-discovery.md` | zosmf-workflow | operations | T0 | 4 |
| 14 | Software Manifest Audit | `software-manifest-audit.md` | standalone | compliance | T0 | ~10 |
| 15 | Hardware Troubleshooting | `hardware-troubleshooting.md` | api-workflow | operations | T0→T2 | ~12 |
| 16 | CPC Recovery | `remediation-cpc-recovery.md` | remediation | remediation | T2 | ~5 |
| 17 | Investigate Hardware | `remediation-investigate-hardware.md` | remediation | remediation | T0 | ~4 |
| 18 | LPAR Restart | `remediation-lpar-restart.md` | remediation | remediation | T2 | ~5 |
| 19 | Partition Restart | `remediation-partition-restart.md` | remediation | remediation | T2 | ~4 |
| 20 | Service Restart | `remediation-service-restart.md` | remediation | remediation | T0 | ~3 |
| 21 | WLM Weight Health Check | `wlm-weight-health-check.md` | api-workflow | performance | T0 | ~8 |
| 22 | WLM Goal Validation | `wlm-goal-validation.md` | api-workflow | performance | T0 | ~10 |
| 23 | Spyre Card Validation | `spyre-card-validation.md` | api-workflow | operations | T0 | ~8 |
| 24 | z/VM LPAR Migration | `zvm-lpar-migration-classic.md` | api-workflow | migration | T2 | ~35 |
| 25 | Test Decision All | `test-decision-all.md` | standalone | test | — | ~8 |
| 26 | Test Decision Approval | `test-decision-approval.md` | standalone | test | — | ~4 |
| 27 | Test Decision Compute | `test-decision-compute.md` | standalone | test | — | ~3 |
| 28 | Test Decision Network | `test-decision-network.md` | standalone | test | — | ~3 |
| 29 | Test Decision Storage | `test-decision-storage.md` | standalone | test | — | ~3 |
| 30 | Test Sub-Workflow | `test-sub-workflow.md` | standalone | test | — | 2 |

---

## Appendix C: Skills+ Extension Points

The following areas are specified in `SKILLS-PLUS-SPEC.md` in upstream Metro. That file is not vendored here.

1. **Mandatory metadata**: `tier`, `category`, and `version` are required in the metadata block.
2. **Event bindings**: Workflows declare what events they react to (gantry reactor integration).
3. **SLM dispatch**: Steps declare which language model tier they require (`large`, `small`, `any`).
4. **DAG execution**: Explicit step dependencies (`depends_on`), conditional branches (`if` + `depends_on`), OR-semantics (`depends_on_any`), and sub-workflow composition in DAGs (artifact propagation, binding/hook suppression).
5. **Artifact outputs**: Workflows declare what artifacts they produce, with encoding rules (`format`, `indent`, `frontmatter`), rendering templates, JSON Schema validation, and conditional emission.
6. **Lifecycle hooks**: Pre/post/on_failure hooks (approval, notify, create_task, artifact_publish, cleanup) and mid-workflow confirmation gates using `builtin.operator_decision` as DAG barriers.
7. **Idempotency annotations**: Mark steps as idempotent for safe retry without side effects.
8. **Cost/duration estimates**: Attach estimated execution time and resource cost to workflows and steps.
