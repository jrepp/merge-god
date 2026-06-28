---
title: Feature Request Triage WorkflowIR
description: WorkflowIR reference for feature request triage.
group: WorkflowIR References
order: 10
---

# Feature Request Triage WorkflowIR

**Canonical source**: `internal/agents/implementations/feature_request_triage_prime.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.feature-request-triage
  version: v1
  title: Feature request triage
  description: Assess feature request feasibility and scope compliance, then produce leadership-level PR narrative artifacts.
  tags: [merge-god, role, triage, feasibility, orchestration]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Feature request triage is a decision and orchestration role; it does not directly mutate repository files.
      - Security reports and vulnerability disclosures are rejected from ordinary feature implementation and routed to security-specific intake.

capabilities:
  required_profiles: [agentic, gates, typed-dataflow, prompt-runtime]
  required_extensions:
    - name: merge-god/source-code-grounding
      version: v1
      reason: Role semantics are grounded in the source implementation, not only prose docs.

inputs:
  - name: issue
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/scm.issue-context/v1
  - name: comments
    value_type:
      kind: array
      items:
        kind: string
  - name: scope_documents
    value_type:
      kind: map
      items:
        kind: string
  - name: generation_result
    value_type:
      kind: object
      schema_ref: schema://merge-god/generation-result/v1
  - name: combat_verdict
    value_type:
      kind: object
      schema_ref: schema://merge-god/adversarial-review.verdict/v1

resources:
  systems:
    - id: llm-provider
      kind: llm
      description: Converser used by Optimus feasibility and scope checks.
  secret_requirements:
    - id: llm-auth
      kind: api-token
      scope: llm-provider
      injection: runtime_broker

graph:
  nodes:
    - id: assemble_issue_context
      kind: action
      label: Assemble issue title, body, and comments
      action:
        ref: merge-god.feature-request-triage.assemble-issue-context
        mode: deterministic

    - id: assess_feasibility
      kind: action
      label: Determine whether issue is an automated feature request
      action:
        ref: merge-god.feature-request-triage.assess-feasibility
        mode: agentic
        agent:
          role: Feature Request Triage
          source_ref: internal/agents/implementations/feature_request_triage_prime.go#AssessFeasibility
          prompt_ref: prompt://merge-god.feature-request-triage.feasibility@1.0.0
          output_contract_ref: schema://merge-god/feature-request-triage.feasibility-result/v1
      metadata:
        feasible_when:
          - clear specific feature request
          - source-code implementation possible
          - no external credentials or manual configuration required
          - bounded scope
        reject_categories:
          - bug_report
          - question
          - too_vague
          - too_large
          - infrastructure
          - needs_discussion
          - security

    - id: feasibility_gate
      kind: gateway
      label: Is the request feasible?
      gateway:
        kind: exclusive
      default_edge: edge.feasibility_gate.reject

    - id: assess_scope
      kind: action
      label: Check product scope documents
      action:
        ref: merge-god.feature-request-triage.assess-scope-compliance
        mode: agentic
        agent:
          role: Feature Request Triage
          source_ref: internal/agents/implementations/feature_request_triage_prime.go#AssessScopeCompliance
          prompt_ref: prompt://merge-god.feature-request-triage.scope-compliance@1.0.0
          output_contract_ref: schema://merge-god/feature-request-triage.scope-result/v1
      metadata:
        out_of_scope_categories:
          - unrelated
          - future_scope
          - conflicting
          - architectural
        architectural_when:
          - introduces new subsystems or pipelines
          - requires new webhook event types or API integrations
          - changes core agent pipeline structure
          - touches more than five to ten files across packages
          - requires RFC or design document before implementation

    - id: scope_gate
      kind: gateway
      label: Is the request in scope?
      gateway:
        kind: exclusive
      default_edge: edge.scope_gate.reject

    - id: approve_pipeline_entry
      kind: action
      label: Approve downstream Requirements Architecture analysis
      action:
        ref: merge-god.feature-request-triage.approve-pipeline-entry
        mode: deterministic

    - id: build_pr_body
      kind: action
      label: Build PR body with requirements, changes, test coverage, and combat report
      action:
        ref: merge-god.feature-request-triage.build-pr-body
        mode: deterministic
        source_ref: internal/agents/implementations/feature_request_triage_prime.go#BuildPRBody

    - id: reject_request
      kind: action
      label: Explain rejection reason and category
      action:
        ref: merge-god.feature-request-triage.reject-request
        mode: deterministic

  edges:
    - id: edge.assemble_issue_context.assess_feasibility
      from: assemble_issue_context
      to: assess_feasibility
      kind: control
    - id: edge.assess_feasibility.feasibility_gate
      from: assess_feasibility
      to: feasibility_gate
      kind: control
    - id: edge.feasibility_gate.assess_scope
      from: feasibility_gate
      to: assess_scope
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.feasibility.feasible == true
    - id: edge.feasibility_gate.reject
      from: feasibility_gate
      to: reject_request
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.feasibility.feasible == false
    - id: edge.assess_scope.scope_gate
      from: assess_scope
      to: scope_gate
      kind: control
    - id: edge.scope_gate.approve_pipeline_entry
      from: scope_gate
      to: approve_pipeline_entry
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.scope.in_scope == true
    - id: edge.scope_gate.reject
      from: scope_gate
      to: reject_request
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.scope.in_scope == false
    - id: edge.approve_pipeline_entry.build_pr_body
      from: approve_pipeline_entry
      to: build_pr_body
      kind: control
      metadata:
        optional: true

dataflow:
  captures:
    - id: capture.feasibility
      from_node: assess_feasibility
      name: feasibility
      value_type:
        kind: object
        schema_ref: schema://merge-god/feature-request-triage.feasibility-result/v1
    - id: capture.scope
      from_node: assess_scope
      name: scope
      value_type:
        kind: object
        schema_ref: schema://merge-god/feature-request-triage.scope-result/v1
    - id: capture.pr_body
      from_node: build_pr_body
      name: pr_body
      value_type:
        kind: string
```
