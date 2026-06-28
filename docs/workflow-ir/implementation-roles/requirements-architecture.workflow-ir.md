---
title: Requirements Architecture WorkflowIR
description: WorkflowIR reference for requirements architecture.
group: WorkflowIR References
order: 20
---

# Requirements Architecture WorkflowIR

**Canonical source**: `internal/agents/implementations/requirements_architecture.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.requirements-architecture
  version: v1
  title: Requirements architecture
  description: Analyze feature requests, identify relevant files, create implementation contracts, and validate generated operations against requirements.
  tags: [merge-god, role, requirements, architecture, validation]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Requirements architecture is a requirements and validation role; it produces contracts and verdicts, not file mutations.
      - Its analysis is prepended with the source system's canonical code quality preamble.

capabilities:
  required_profiles: [agentic, typed-dataflow, prompt-runtime]
  required_extensions:
    - name: merge-god/code-quality-preamble
      version: v1
      reason: Requirements Architecture prompt assembly prepends prompts.CodeQualityPreamble().

inputs:
  - name: issue
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/scm.issue-context/v1
  - name: file_tree
    required: true
    value_type:
      kind: array
      items:
        kind: string
  - name: generated_operations
    value_type:
      kind: array
      items:
        kind: object
        schema_ref: schema://merge-god/git.file-operation/v1
  - name: evidence
    value_type:
      kind: array
      items:
        kind: object
        schema_ref: schema://merge-god/validation-evidence/v1

graph:
  nodes:
    - id: analyze_feature_request
      kind: action
      label: Extract requirements, relevant files, and implementation notes
      action:
        ref: merge-god.requirements-architecture.analyze
        mode: agentic
        agent:
          role: Requirements Architecture
          source_ref: internal/agents/implementations/requirements_architecture.go#Analyze
          prompt_ref: prompt://merge-god.requirements-architecture.analyze@1.0.0
          output_contract_ref: schema://merge-god/requirements-architecture.analysis-result/v1
      metadata:
        must_identify:
          - discrete actionable requirements
          - relevant existing files from file tree
          - implementation strategy and technical notes
        implementation_notes_must_include:
          - relevant code quality standards
          - existing patterns to follow

    - id: create_plan_contract
      kind: action
      label: Convert analysis into strict implementation contract
      action:
        ref: merge-god.requirements-architecture.plan
        mode: agentic
        agent:
          role: Requirements Architecture
          source_ref: internal/agents/implementations/requirements_architecture.go#Plan
          prompt_ref: prompt://merge-god.requirements-architecture.plan@1.0.0
          output_contract_ref: schema://merge-god/requirements-architecture.plan-contract/v1
      metadata:
        ids:
          requirements: R1..Rn
          acceptance_checks: A1..An
        rules:
          - approved_auto should be true
          - requirements must be assigned to execution phases
          - must_touch_paths should map to implementation-critical areas
          - non_goals must be concise and enforceable

    - id: validate_operations_against_analysis
      kind: action
      label: Validate generated operations satisfy analyzed requirements
      action:
        ref: merge-god.requirements-architecture.validate-implementation
        mode: agentic
        agent:
          role: Requirements Architecture
          source_ref: internal/agents/implementations/requirements_architecture.go#ValidateImplementation
          prompt_ref: prompt://merge-god.requirements-architecture.validate-implementation@1.0.0
          output_contract_ref: schema://merge-god/requirements-architecture.validate-implementation-result/v1
      metadata:
        strict_rules:
          - housekeeping-only operations are insufficient
          - key requirements must be present in operations
          - execution evidence is authoritative for runtime outcomes
          - implementation must be present, not inferred

    - id: validate_operations_against_plan
      kind: action
      label: Validate generated operations satisfy plan contract
      action:
        ref: merge-god.requirements-architecture.validate-plan
        mode: agentic
        agent:
          role: Requirements Architecture
          source_ref: internal/agents/implementations/requirements_architecture.go#ValidateAgainstPlan
          prompt_ref: prompt://merge-god.requirements-architecture.validate-plan@1.0.0
          output_contract_ref: schema://merge-god/requirements-architecture.plan-validation-result/v1
      metadata:
        invalid_when:
          - any must requirement is missing
          - must_touch_paths are not touched
          - operations are empty or non-substantive

    - id: evaluate_command_quality
      kind: action
      label: Classify command output quality in a language-agnostic way
      action:
        ref: merge-god.requirements-architecture.evaluate-command-quality
        mode: agentic
        agent:
          role: Requirements Architecture
          source_ref: internal/agents/implementations/requirements_architecture.go#EvaluateCommandQuality
          prompt_ref: prompt://merge-god.requirements-architecture.command-quality@1.0.0
          output_contract_ref: schema://merge-god/requirements-architecture.command-quality-result/v1

  edges:
    - id: edge.analyze_feature_request.create_plan_contract
      from: analyze_feature_request
      to: create_plan_contract
      kind: control
    - id: edge.create_plan_contract.validate_operations_against_analysis
      from: create_plan_contract
      to: validate_operations_against_analysis
      kind: control
      metadata:
        after_code_change_implementation_generation: true
    - id: edge.validate_operations_against_analysis.validate_operations_against_plan
      from: validate_operations_against_analysis
      to: validate_operations_against_plan
      kind: control
      metadata:
        after_code_change_implementation_generation: true
    - id: edge.validate_operations_against_plan.evaluate_command_quality
      from: validate_operations_against_plan
      to: evaluate_command_quality
      kind: control
      metadata:
        optional: true

dataflow:
  captures:
    - id: capture.analysis
      from_node: analyze_feature_request
      name: analysis
      value_type:
        kind: object
        schema_ref: schema://merge-god/requirements-architecture.analysis-result/v1
    - id: capture.plan_contract
      from_node: create_plan_contract
      name: plan
      value_type:
        kind: object
        schema_ref: schema://merge-god/requirements-architecture.plan-contract/v1
    - id: capture.analysis_validation
      from_node: validate_operations_against_analysis
      name: validation
      value_type:
        kind: object
        schema_ref: schema://merge-god/requirements-architecture.validate-implementation-result/v1
    - id: capture.plan_validation
      from_node: validate_operations_against_plan
      name: plan_validation
      value_type:
        kind: object
        schema_ref: schema://merge-god/requirements-architecture.plan-validation-result/v1
```
