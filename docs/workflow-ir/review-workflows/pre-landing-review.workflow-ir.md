---
title: Pre-Landing Review WorkflowIR
description: WorkflowIR extraction for the /review workflow.
group: WorkflowIR References
order: 81
---

# Pre-Landing Review WorkflowIR

**Canonical source**: `review/SKILL.md.tmpl`

Supporting sources:

- `review/checklist.md`
- `review/greptile-triage.md`
- `review/specialists/*.md`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.review.pre-landing
  version: v1
  title: pre-landing review
  description: Review the current branch against the base branch, classify findings, run scoped specialist reviews, apply mechanical fixes, and gate ambiguous fixes.
  tags: [review-system, review, pre-landing, code-review]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Required checklist loading fails closed.
      - Greptile and slop-scan integrations are advisory and fail open.
      - Code mutation is limited to fix-first approved or mechanical findings.

capabilities:
  required_profiles:
    - agentic
    - prompt-runtime
    - typed-dataflow
    - human-gates
    - gateways
    - subworkflows
    - error-handling
  required_extensions:
    - name: review-system/fix-first
      version: v1
      reason: AUTO-FIX and ASK classification changes whether the workflow mutates code or waits for user approval.
    - name: review-system/greptile-triage
      version: v1
      reason: Greptile comment classification and reply templates are part of the review contract when comments are present.
    - name: review-system/review-scope
      version: v1
      reason: Specialist subworkflow selection depends on source-scope predicates.

inputs:
  - name: repository_root
    required: true
    value_type:
      kind: string
  - name: base_branch
    required: true
    value_type:
      kind: string
  - name: branch_name
    value_type:
      kind: string
  - name: allow_autofix
    default: true
    value_type:
      kind: boolean
  - name: greptile_enabled
    default: true
    value_type:
      kind: boolean

graph:
  nodes:
    - id: detect_branch_diff
      kind: action
      label: Check branch and diff availability
      action:
        ref: review.detect-branch-diff
        mode: deterministic
        source_ref: review/SKILL.md.tmpl#Step-1
      on_error:
        strategy: fail_workflow

    - id: load_review_checklist
      kind: action
      label: Load required pre-landing checklist
      action:
        ref: review.load-checklist
        mode: deterministic
        source_ref: review/checklist.md
      on_error:
        strategy: fail_workflow

    - id: fetch_greptile_comments
      kind: action
      label: Fetch and classify Greptile comments
      conditions:
        - language: workflow-ir.expr/v1
          expr: inputs.greptile_enabled == true
      action:
        ref: review.greptile-triage
        mode: deterministic
        source_ref: review/greptile-triage.md
      on_error:
        strategy: continue

    - id: capture_diff
      kind: action
      label: Capture current branch diff from merge base
      action:
        ref: review.capture-diff
        mode: deterministic
        source_ref: review/SKILL.md.tmpl#Step-3

    - id: run_advisory_scans
      kind: action
      label: Run advisory queue and slop scans
      action:
        ref: review.advisory-scans
        mode: deterministic
        source_ref: review/SKILL.md.tmpl#Step-3.4
      on_error:
        strategy: continue

    - id: main_critical_pass
      kind: action
      label: Run main critical and informational review pass
      action:
        ref: review.main-critical-pass
        mode: agentic
        agent:
          role: Pre-Landing Reviewer
          prompt_ref: prompt://review.main-critical-pass@1.0.0
          source_ref: review/SKILL.md.tmpl#Step-4
          output_contract_ref: schema://review/review.findings/v1
      metadata:
        checklist_ref: review/checklist.md
        required_categories:
          - sql-data-safety
          - race-conditions-concurrency
          - llm-output-trust-boundary
          - shell-injection
          - enum-value-completeness

    - id: detect_review_scope
      kind: action
      label: Detect source scopes for specialist review selection
      action:
        ref: review.detect-scope
        mode: deterministic
      metadata:
        scope_flags:
          - SCOPE_API
          - SCOPE_AUTH
          - SCOPE_BACKEND
          - SCOPE_FRONTEND
          - SCOPE_MIGRATIONS

    - id: select_specialists
      kind: gateway
      label: Select applicable specialist reviews
      gateway:
        kind: inclusive

    - id: run_testing_specialist
      kind: subworkflow
      label: Run testing specialist review
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:testing
        - input: diff
          from: capture.diff

    - id: run_maintainability_specialist
      kind: subworkflow
      label: Run maintainability specialist review
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:maintainability
        - input: diff
          from: capture.diff

    - id: run_security_specialist
      kind: subworkflow
      label: Run security specialist review when auth/backend scope warrants it
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:security
        - input: diff
          from: capture.diff

    - id: run_performance_specialist
      kind: subworkflow
      label: Run performance specialist review when backend or frontend scope warrants it
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:performance
        - input: diff
          from: capture.diff

    - id: run_data_migration_specialist
      kind: subworkflow
      label: Run data migration specialist review when migration scope is present
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:data-migration
        - input: diff
          from: capture.diff

    - id: run_api_contract_specialist
      kind: subworkflow
      label: Run API contract specialist review when API scope is present
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:api-contract
        - input: diff
          from: capture.diff

    - id: run_red_team_specialist
      kind: subworkflow
      label: Run red team specialist after large diffs or critical security findings
      workflow_ref:
        id: wf.review.specialist
        version: v1
      input_mapping:
        - input: specialist_id
          from: literal:red-team
        - input: diff
          from: capture.diff

    - id: join_specialists
      kind: join
      label: Join selected specialist reviews
      join:
        kind: all

    - id: deduplicate_findings
      kind: action
      label: Deduplicate main and specialist findings
      action:
        ref: review.deduplicate-findings
        mode: deterministic

    - id: classify_fix_first
      kind: action
      label: Classify findings as AUTO-FIX or ASK
      action:
        ref: review.fix-first-classify
        mode: agentic
        agent:
          role: Fix-First Classifier
          prompt_ref: prompt://review.fix-first-classify@1.0.0
          output_contract_ref: schema://review/review.fix-first-plan/v1
      metadata:
        heuristic_ref: review/checklist.md#Fix-First-Heuristic

    - id: apply_auto_fixes
      kind: action
      label: Apply mechanical AUTO-FIX findings
      conditions:
        - language: workflow-ir.expr/v1
          expr: inputs.allow_autofix == true
      action:
        ref: review.apply-auto-fixes
        mode: agentic
        agent:
          role: Review Fixer
          prompt_ref: prompt://review.apply-auto-fixes@1.0.0
          output_contract_ref: schema://review/review.applied-fixes/v1

    - id: ask_for_ambiguous_fixes
      kind: gate
      label: Ask user about ASK findings
      gate_ref: gate.review.fix-first-approval

    - id: apply_approved_fixes
      kind: action
      label: Apply user-approved ASK fixes
      action:
        ref: review.apply-approved-fixes
        mode: agentic
        agent:
          role: Review Fixer
          prompt_ref: prompt://review.apply-approved-fixes@1.0.0
          output_contract_ref: schema://review/review.applied-fixes/v1

    - id: cross_reference_todos_and_docs
      kind: action
      label: Cross-reference TODOs and documentation staleness
      action:
        ref: review.todos-docs-cross-reference
        mode: agentic
        agent:
          role: Review Context Auditor
          prompt_ref: prompt://review.todos-docs-cross-reference@1.0.0
          output_contract_ref: schema://review/review.context-findings/v1

    - id: persist_review_result
      kind: action
      label: Persist engineering review result
      action:
        ref: review.persist-result
        mode: deterministic
        source_ref: review/SKILL.md.tmpl#Step-5.8

    - id: produce_review_report
      kind: action
      label: Produce final pre-landing review report
      action:
        ref: review.produce-report
        mode: agentic
        agent:
          role: Pre-Landing Reviewer
          prompt_ref: prompt://review.produce-report@1.0.0
          output_contract_ref: schema://review/review.report/v1

  edges:
    - {id: edge.detect_branch_diff.load_review_checklist, from: detect_branch_diff, to: load_review_checklist, kind: control}
    - {id: edge.load_review_checklist.fetch_greptile_comments, from: load_review_checklist, to: fetch_greptile_comments, kind: control}
    - {id: edge.load_review_checklist.capture_diff, from: load_review_checklist, to: capture_diff, kind: control}
    - {id: edge.capture_diff.run_advisory_scans, from: capture_diff, to: run_advisory_scans, kind: control}
    - {id: edge.capture_diff.main_critical_pass, from: capture_diff, to: main_critical_pass, kind: control}
    - {id: edge.capture_diff.detect_review_scope, from: capture_diff, to: detect_review_scope, kind: control}
    - {id: edge.detect_review_scope.select_specialists, from: detect_review_scope, to: select_specialists, kind: control}
    - {id: edge.select_specialists.testing, from: select_specialists, to: run_testing_specialist, kind: control}
    - {id: edge.select_specialists.maintainability, from: select_specialists, to: run_maintainability_specialist, kind: control}
    - id: edge.select_specialists.security
      from: select_specialists
      to: run_security_specialist
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.scope.SCOPE_AUTH == true or captures.scope.SCOPE_BACKEND == true
    - id: edge.select_specialists.performance
      from: select_specialists
      to: run_performance_specialist
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.scope.SCOPE_BACKEND == true or captures.scope.SCOPE_FRONTEND == true
    - id: edge.select_specialists.data_migration
      from: select_specialists
      to: run_data_migration_specialist
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.scope.SCOPE_MIGRATIONS == true
    - id: edge.select_specialists.api_contract
      from: select_specialists
      to: run_api_contract_specialist
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.scope.SCOPE_API == true
    - id: edge.select_specialists.red_team
      from: select_specialists
      to: run_red_team_specialist
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.diff.line_count > 200 or captures.specialist_findings.has_critical_security == true
    - {id: edge.testing.join_specialists, from: run_testing_specialist, to: join_specialists, kind: control}
    - {id: edge.maintainability.join_specialists, from: run_maintainability_specialist, to: join_specialists, kind: control}
    - {id: edge.security.join_specialists, from: run_security_specialist, to: join_specialists, kind: control}
    - {id: edge.performance.join_specialists, from: run_performance_specialist, to: join_specialists, kind: control}
    - {id: edge.data_migration.join_specialists, from: run_data_migration_specialist, to: join_specialists, kind: control}
    - {id: edge.api_contract.join_specialists, from: run_api_contract_specialist, to: join_specialists, kind: control}
    - {id: edge.red_team.join_specialists, from: run_red_team_specialist, to: join_specialists, kind: control}
    - {id: edge.main_critical_pass.deduplicate_findings, from: main_critical_pass, to: deduplicate_findings, kind: control}
    - {id: edge.join_specialists.deduplicate_findings, from: join_specialists, to: deduplicate_findings, kind: control}
    - {id: edge.deduplicate_findings.classify_fix_first, from: deduplicate_findings, to: classify_fix_first, kind: control}
    - {id: edge.classify_fix_first.apply_auto_fixes, from: classify_fix_first, to: apply_auto_fixes, kind: control}
    - {id: edge.classify_fix_first.ask_for_ambiguous_fixes, from: classify_fix_first, to: ask_for_ambiguous_fixes, kind: control}
    - {id: edge.ask_for_ambiguous_fixes.apply_approved_fixes, from: ask_for_ambiguous_fixes, to: apply_approved_fixes, kind: guard}
    - {id: edge.apply_auto_fixes.cross_reference_todos_and_docs, from: apply_auto_fixes, to: cross_reference_todos_and_docs, kind: control}
    - {id: edge.apply_approved_fixes.cross_reference_todos_and_docs, from: apply_approved_fixes, to: cross_reference_todos_and_docs, kind: control}
    - {id: edge.cross_reference_todos_and_docs.persist_review_result, from: cross_reference_todos_and_docs, to: persist_review_result, kind: control}
    - {id: edge.persist_review_result.produce_review_report, from: persist_review_result, to: produce_review_report, kind: control}

dataflow:
  captures:
    - id: capture.diff
      from_node: capture_diff
      name: diff
      value_type:
        kind: object
        schema_ref: schema://review/git.diff/v1
    - id: capture.greptile_classifications
      from_node: fetch_greptile_comments
      name: greptile_classifications
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://review/greptile.classification/v1
    - id: capture.main_findings
      from_node: main_critical_pass
      name: main_findings
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://review/review.finding/v1
    - id: capture.scope
      from_node: detect_review_scope
      name: scope
      value_type:
        kind: object
        schema_ref: schema://review/review.scope/v1
    - id: capture.fix_first_plan
      from_node: classify_fix_first
      name: fix_first_plan
      value_type:
        kind: object
        schema_ref: schema://review/review.fix-first-plan/v1
    - id: capture.review_report
      from_node: produce_review_report
      name: review_report
      value_type:
        kind: object
        schema_ref: schema://review/review.report/v1

gates:
  definitions:
    - id: gate.review.fix-first-approval
      decision_type: review-fix-approval
      required_role: operator
      options:
        - id: fix
          label: Fix as recommended
        - id: skip
          label: Skip
      evidence_requirements:
        - Finding list with severity, file, line, problem, and recommended fix.

artifacts:
  outputs:
    - id: pre-landing-review-report
      kind: report
      producer_node: produce_review_report
      value_type:
        kind: object
        schema_ref: schema://review/review.report/v1
      audience: [operator, pull-request]
    - id: persisted-review-result
      kind: state-record
      producer_node: persist_review_result
      value_type:
        kind: object
        schema_ref: schema://review/review.persisted-result/v1
      audience: [review-system]
```
