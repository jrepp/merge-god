---
title: Underlying Remediation PR WorkflowIR
description: WorkflowIR for signal-gated, docs-grounded underlying bug-fix PRs opened by merge-god.
group: WorkflowIR References
order: 83
---

# Underlying Remediation PR WorkflowIR

This workflow governs the optional path where the pi agent finds an underlying
repository problem while processing a PR, such as a CI failure caused by a
repo bug rather than the PR under review.

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.underlying-remediation-pr
  version: v1
  title: underlying remediation pull request
  description: Open a linked remediation PR only when concrete signal exists, the change is grounded in project docs, and validation evidence has been collected.
  tags: [merge-god, remediation, pull-request, workflow-ir]
  profile: agentic-workflow

inputs:
  - name: repository_root
    required: true
    value_type:
      kind: string
  - name: worktree_root
    required: true
    value_type:
      kind: string
  - name: linked_pr_number
    value_type:
      kind: number
  - name: base_branch
    value_type:
      kind: string

graph:
  nodes:
    - id: collect_underlying_signal
      kind: action
      label: Collect concrete underlying problem signal
      action:
        ref: merge-god.remediation.collect-signal
        mode: agentic
      metadata:
        accepted_signal_refs:
          - ci-check-url
          - failing-command-output
          - review-comment
          - issue-url
          - stack-trace
          - reproduction-artifact
      on_error:
        strategy: fail_workflow

    - id: ground_in_project_docs
      kind: action
      label: Ground remediation scope in project docs and merge rules
      action:
        ref: merge-god.remediation.ground-in-docs
        mode: agentic
      metadata:
        accepted_grounding_refs:
          - AGENTS.md
          - docs/
          - .merge-rules.yaml
          - docs/workflow-ir/
      on_error:
        strategy: fail_workflow

    - id: signal_and_grounding_gate
      kind: gate
      label: Require signal and grounding before mutation
      gate_ref: gate.merge-god.remediation-signal-grounding

    - id: apply_bounded_remediation
      kind: action
      label: Apply bounded fix in isolated worktree
      action:
        ref: merge-god.remediation.apply-bounded-fix
        mode: agentic
      metadata:
        worktree_required: true
        scope_limit: underlying-bug-fix
      on_error:
        strategy: fail_workflow

    - id: validate_remediation
      kind: action
      label: Run affected validation lanes
      action:
        ref: merge-god.remediation.validate
        mode: deterministic
      on_error:
        strategy: fail_workflow

    - id: open_linked_pr
      kind: action
      label: Open linked underlying remediation PR
      action:
        ref: merge-god.remediation.open-linked-pr
        mode: deterministic
      metadata:
        required_fields:
          - linked_pr_number
          - signal_refs
          - grounding_refs
          - validation_refs

  edges:
    - id: edge.collect_signal.ground_docs
      from: collect_underlying_signal
      to: ground_in_project_docs
      kind: control
    - id: edge.ground_docs.gate
      from: ground_in_project_docs
      to: signal_and_grounding_gate
      kind: control
    - id: edge.gate.apply
      from: signal_and_grounding_gate
      to: apply_bounded_remediation
      kind: guard
    - id: edge.apply.validate
      from: apply_bounded_remediation
      to: validate_remediation
      kind: control
    - id: edge.validate.open_pr
      from: validate_remediation
      to: open_linked_pr
      kind: control

gates:
  definitions:
    - id: gate.merge-god.remediation-signal-grounding
      decision_type: merge-god.remediation.signal-grounding
      label: Underlying remediation signal and docs-grounding gate
      evidence_requirements:
        - At least one concrete signal ref that demonstrates the underlying problem.
        - At least one project-doc, merge-rule, or Workflow-IR grounding ref that justifies the remediation scope.
        - The remediation must be bounded and safe to perform in the isolated worktree.
```
