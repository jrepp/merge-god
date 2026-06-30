---
title: Specialist Review WorkflowIR
description: WorkflowIR extraction for reusable review specialist roles.
group: WorkflowIR References
order: 82
---

# Specialist Review WorkflowIR

**Canonical sources**: `review/specialists/*.md`

This WorkflowIR document preserves the existing specialist review structure by
modeling the specialist checklist as an input-selected prompt contract. The
source specialist files remain the canonical category lists and output schema.

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.review.specialist
  version: v1
  title: specialist review
  description: Run one scoped review specialist over a branch diff and return structured JSON-line findings.
  tags: [review-system, review, specialist, code-review]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Specialist reviews inspect the diff and repository context; they do not mutate files.
      - Each finding must cite file and line evidence when available.
      - The source specialist checklist determines scope and output schema.

capabilities:
  required_profiles:
    - agentic
    - prompt-runtime
    - typed-dataflow
  optional_profiles:
    - error-handling
  required_extensions:
    - name: review-system/review-scope
      version: v1
      reason: Specialist applicability is determined by review scope predicates.

inputs:
  - name: specialist_id
    required: true
    description: One of testing, maintainability, security, performance, data-migration, api-contract, or red-team.
    value_type:
      kind: string
      constraints:
        enum:
          - testing
          - maintainability
          - security
          - performance
          - data-migration
          - api-contract
          - red-team
  - name: diff
    required: true
    value_type:
      kind: object
      schema_ref: schema://review/git.diff/v1
  - name: repository_context
    value_type:
      kind: object
      schema_ref: schema://review/repository.context/v1
  - name: prior_specialist_findings
    description: Findings from earlier specialists; used by red-team review.
    value_type:
      kind: array
      items:
        kind: object
        schema_ref: schema://review/review.finding/v1

graph:
  nodes:
    - id: resolve_specialist_source
      kind: action
      label: Resolve specialist checklist source
      action:
        ref: review.specialist.resolve-source
        mode: deterministic
      metadata:
        source_map:
          testing: review/specialists/testing.md
          maintainability: review/specialists/maintainability.md
          security: review/specialists/security.md
          performance: review/specialists/performance.md
          data-migration: review/specialists/data-migration.md
          api-contract: review/specialists/api-contract.md
          red-team: review/specialists/red-team.md

    - id: assemble_specialist_prompt
      kind: action
      label: Assemble specialist prompt and checklist context
      action:
        ref: review.specialist.assemble-prompt
        mode: deterministic
        tool_ref: tool://filesystem.read
      metadata:
        prompt_runtime:
          prompt_ref_pattern: prompt://review.specialist.{specialist_id}@1.0.0
          checklist_source: capture.specialist_source
          output_contract_ref: schema://review/review.specialist-jsonl-findings/v1

    - id: run_specialist_review
      kind: action
      label: Run scoped specialist review
      action:
        ref: review.specialist.run
        mode: agentic
        agent:
          role: Review Specialist
          prompt_ref: prompt://review.specialist@1.0.0
          output_contract_ref: schema://review/review.specialist-jsonl-findings/v1
          tool_constraints:
            allowed_read_scope: repository
            mutation_allowed: false
      metadata:
        output_when_empty: NO FINDINGS
        finding_schema:
          required_fields:
            - severity
            - confidence
            - path
            - category
            - summary
            - fix
            - fingerprint
            - specialist
          optional_fields:
            - line
            - evidence
            - test_stub

    - id: validate_specialist_output
      kind: action
      label: Validate specialist JSON-line findings
      action:
        ref: review.specialist.validate-output
        mode: deterministic
      on_error:
        strategy: fail_workflow

  edges:
    - id: edge.resolve_specialist_source.assemble_specialist_prompt
      from: resolve_specialist_source
      to: assemble_specialist_prompt
      kind: control
    - id: edge.assemble_specialist_prompt.run_specialist_review
      from: assemble_specialist_prompt
      to: run_specialist_review
      kind: control
    - id: edge.run_specialist_review.validate_specialist_output
      from: run_specialist_review
      to: validate_specialist_output
      kind: control

dataflow:
  captures:
    - id: capture.specialist_source
      from_node: resolve_specialist_source
      name: specialist_source
      value_type:
        kind: string
    - id: capture.specialist_findings
      from_node: run_specialist_review
      name: specialist_findings
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://review/review.finding/v1

artifacts:
  outputs:
    - id: specialist-findings
      kind: findings
      producer_node: validate_specialist_output
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://review/review.finding/v1
      audience: [parent-workflow]

extensions:
  review-system/review-scope:
    specialist_scopes:
      testing:
        source: review/specialists/testing.md
        applicability: always-on
        categories:
          - missing-negative-path-tests
          - missing-edge-case-coverage
          - test-isolation-violations
          - flaky-test-patterns
          - security-enforcement-tests-missing
          - coverage-gaps
      maintainability:
        source: review/specialists/maintainability.md
        applicability: always-on
        categories:
          - dead-code-unused-imports
          - magic-numbers-string-coupling
          - stale-comments-docstrings
          - dry-violations
          - conditional-side-effects
          - module-boundary-violations
      security:
        source: review/specialists/security.md
        applicability: SCOPE_AUTH or large backend diff
        categories:
          - input-validation-trust-boundaries
          - auth-authorization-bypass
          - injection-vectors
          - cryptographic-misuse
          - secrets-exposure
          - xss-escape-hatches
          - deserialization
      performance:
        source: review/specialists/performance.md
        applicability: SCOPE_BACKEND or SCOPE_FRONTEND
        categories:
          - n-plus-one-queries
          - missing-database-indexes
          - algorithmic-complexity
          - bundle-size-impact
          - rendering-performance
          - missing-pagination
          - blocking-in-async-contexts
      data-migration:
        source: review/specialists/data-migration.md
        applicability: SCOPE_MIGRATIONS
        categories:
          - reversibility
          - data-loss-risk
          - lock-duration
          - backfill-strategy
          - index-creation
          - multi-phase-safety
      api-contract:
        source: review/specialists/api-contract.md
        applicability: SCOPE_API
        categories:
          - breaking-changes
          - versioning-strategy
          - error-response-consistency
          - rate-limiting-pagination
          - documentation-drift
          - backwards-compatibility
      red-team:
        source: review/specialists/red-team.md
        applicability: diff_over_200_lines or critical_security_findings
        categories:
          - happy-path-attacks
          - silent-failures
          - trust-assumption-exploits
          - edge-case-breakage
          - cross-specialist-gaps
```
