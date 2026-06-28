# Logic Review WorkflowIR

**Canonical source**: `internal/agents/adversarial-reviews/logic_review.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.logic-review
  version: v1
  title: Logic review
  description: Perform adversarial logic and correctness analysis over proposed file operations.
  tags: [merge-god, role, logic, correctness]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Logic review inspects proposed operations only; it does not execute or mutate code.
      - Malicious logic paths are always critical findings.

capabilities:
  required_profiles: [agentic, typed-dataflow, prompt-runtime]

inputs:
  - name: operations
    required: true
    value_type:
      kind: array
      items:
        kind: object
        schema_ref: schema://merge-god/git.file-operation/v1

graph:
  nodes:
    - id: serialize_operations
      kind: action
      label: Marshal proposed file operations to JSON
      action:
        ref: merge-god.logic-review.serialize-operations
        mode: deterministic
        source_ref: internal/agents/adversarial-reviews/logic_review.go#Attack

    - id: attack_logic
      kind: action
      label: Attack code changes for logic bugs and malicious code paths
      action:
        ref: merge-god.logic-review.attack
        mode: agentic
        agent:
          role: Logic Review
          source_ref: internal/agents/adversarial-reviews/logic_review.go#logic_reviewSystem
          prompt_ref: prompt://merge-god.logic-review.logic-attack@1.0.0
          output_contract_ref: schema://merge-god/logic-review.report/v1
      metadata:
        categories:
          logic_bugs:
            - nil_pointer_dereference
            - off_by_one
            - boundary_conditions
            - integer_overflow_or_truncation
            - incorrect_algorithm
            - type_conversion_error
            - unhandled_edge_case
            - race_condition
            - resource_leak
            - swallowed_error
            - incorrect_error_propagation
          malicious_logic:
            - time_bombs
            - kill_switches
            - auth_or_authorization_bypass
            - hidden_control_flow
            - intentional_infinite_loop
            - resource_exhaustion_by_input
            - sensitive_data_leakage
            - silent_data_mutation
            - undocumented_side_effects
        verdict_rules:
          - any critical or high bug requires overall_logic_verdict fail
          - malicious code paths are always critical

  edges:
    - id: edge.serialize_operations.attack_logic
      from: serialize_operations
      to: attack_logic
      kind: control

dataflow:
  captures:
    - id: capture.bugs
      from_node: attack_logic
      name: bugs
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/logic-review.bug/v1
    - id: capture.logic_report
      from_node: attack_logic
      name: report
      value_type:
        kind: object
        schema_ref: schema://merge-god/logic-review.report/v1
```
