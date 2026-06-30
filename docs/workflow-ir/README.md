---
title: WorkflowIR Reference Index
description: Index of WorkflowIR extraction reference documents.
group: WorkflowIR References
order: 0
---

# WorkflowIR Reference Index

This directory contains standalone WorkflowIR documents extracted from agentic
implementation and review workflows.

## Reference Sets

| Set | Directory | Purpose |
| --- | --- | --- |
| Implementation roles | `implementation-roles/` | Merge God implementation and adversarial review roles. |
| Review workflows | `review-workflows/` | review-oriented workflows and reusable review role patterns. |

Key review workflows:

- [`underlying-remediation-pr.workflow-ir.md`](review-workflows/underlying-remediation-pr.workflow-ir.md)
  defines the signal-gated, project-doc-grounded path for opening linked
  underlying bug-fix PRs during automated remediation.

Each document keeps runtime state out of canonical IR. Runtime evidence,
comments, task claims, commit SHAs, concrete artifact paths, and operator
answers belong to the projection/runtime layer.
