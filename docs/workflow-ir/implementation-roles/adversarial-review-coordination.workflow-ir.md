# Adversarial Review Coordination WorkflowIR

**Canonical source**: `internal/agents/adversarial-reviews/adversarial_review_coordination.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.adversarial-review-coordination
  version: v1
  title: Adversarial review coordination
  description: Coordinate concurrent adversarial review attacks and synthesize pass/fail verdicts with structured feedback for code-change implementation.
  tags: [merge-god, role, adversarial-review, coordination, verdict]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Adversarial Review Coordination coordinates review over proposed operations; it does not mutate files.
      - Any failed sub-verdict or critical/high finding causes an overall fail verdict.

capabilities:
  required_profiles: [parallel, typed-dataflow, subworkflows]
  required_extensions:
    - name: merge-god/adversarial-review-verdict
      version: v1
      reason: Verdict synthesis follows SynthesizeVerdict in Go.

inputs:
  - name: operations
    required: true
    value_type:
      kind: array
      items:
        kind: object
        schema_ref: schema://merge-god/git.file-operation/v1
  - name: log_dir
    value_type:
      kind: string

graph:
  nodes:
    - id: prepare_attack_request
      kind: action
      label: Prepare operations for concurrent adversarial review
      action:
        ref: merge-god.adversarial-review-coordination.prepare-attack-request
        mode: deterministic
        source_ref: internal/agents/adversarial-reviews/adversarial_review_coordination.go#AttackRequest

    - id: run_security_review
      kind: subworkflow
      label: Run security attack
      workflow_ref:
        id: wf.merge-god.role.security-review
        version: v1
      invocation: async
      input_mapping:
        - input: operations
          from: input.operations

    - id: run_logic_review
      kind: subworkflow
      label: Run logic attack
      workflow_ref:
        id: wf.merge-god.role.logic-review
        version: v1
      invocation: async
      input_mapping:
        - input: operations
          from: input.operations

    - id: run_resilience_review
      kind: subworkflow
      label: Run resilience attack
      workflow_ref:
        id: wf.merge-god.role.resilience-review
        version: v1
      invocation: async
      input_mapping:
        - input: operations
          from: input.operations

    - id: wait_for_attack_reports
      kind: join
      label: Wait for all three attack reports
      join:
        kind: all

    - id: synthesize_verdict
      kind: action
      label: Synthesize final verdict and code-change implementation feedback
      action:
        ref: merge-god.adversarial-review-coordination.synthesize-verdict
        mode: deterministic
        source_ref: internal/agents/adversarial-reviews/adversarial_review_coordination.go#SynthesizeVerdict
      metadata:
        fail_when:
          - security_review overall_security_verdict is fail
          - logic_review overall_logic_verdict is fail
          - resilience_review overall_resilience_verdict is fail
          - any critical or high security vulnerability exists
          - any critical or high logic bug exists
          - any critical or high resilience issue exists
        feedback_prefix: Fix the following critical issues before the code can be merged
        summary_order: [Security Review, Logic Review, Resilience Review]

  edges:
    - id: edge.prepare_attack_request.run_security_review
      from: prepare_attack_request
      to: run_security_review
      kind: control
    - id: edge.prepare_attack_request.run_logic_review
      from: prepare_attack_request
      to: run_logic_review
      kind: control
    - id: edge.prepare_attack_request.run_resilience_review
      from: prepare_attack_request
      to: run_resilience_review
      kind: control
    - id: edge.run_security_review.wait_for_attack_reports
      from: run_security_review
      to: wait_for_attack_reports
      kind: control
    - id: edge.run_logic_review.wait_for_attack_reports
      from: run_logic_review
      to: wait_for_attack_reports
      kind: control
    - id: edge.run_resilience_review.wait_for_attack_reports
      from: run_resilience_review
      to: wait_for_attack_reports
      kind: control
    - id: edge.wait_for_attack_reports.synthesize_verdict
      from: wait_for_attack_reports
      to: synthesize_verdict
      kind: control

dataflow:
  captures:
    - id: capture.security_review_report
      from_node: run_security_review
      name: security_review_report
      value_type:
        kind: object
        schema_ref: schema://merge-god/security-review.report/v1
    - id: capture.logic_review_report
      from_node: run_logic_review
      name: logic_review_report
      value_type:
        kind: object
        schema_ref: schema://merge-god/logic-review.report/v1
    - id: capture.resilience_review_report
      from_node: run_resilience_review
      name: resilience_review_report
      value_type:
        kind: object
        schema_ref: schema://merge-god/resilience-review.report/v1
    - id: capture.verdict
      from_node: synthesize_verdict
      name: verdict
      value_type:
        kind: object
        schema_ref: schema://merge-god/adversarial-review.verdict/v1
```
