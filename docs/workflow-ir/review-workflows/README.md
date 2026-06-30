---
title: Review WorkflowIR Index
description: Index of review-focused WorkflowIR documents extracted from review skills.
group: WorkflowIR References
order: 80
---

# Review WorkflowIR Index

This directory encodes review-focused skills as WorkflowIR reference
documents while preserving the source structure:

- `/review` remains the composite pre-landing review coordinator.
- `review/checklist.md` remains the main checklist source.
- `review/greptile-triage.md` remains the Greptile triage source.
- `review/specialists/*.md` remain specialist role sources selected by scope.

## Workflow Files

| Workflow | WorkflowIR file | Source |
| --- | --- | --- |
| Pre-Landing Review | `pre-landing-review.workflow-ir.md` | `review/SKILL.md.tmpl` |
| Specialist Review Role | `specialist-review.workflow-ir.md` | `review/specialists/*.md` |

## Capability Descriptions

The review extraction uses these WorkflowIR profiles:

- `agentic`: review and synthesis steps are performed by an agent with bounded
  tool use and evidence requirements.
- `prompt-runtime`: review action nodes preserve prompt/checklist references,
  role instructions, model/tool envelopes, and structured output contracts.
- `typed-dataflow`: findings, Greptile classifications, fix decisions, and
  final review summaries are captured as typed data.
- `human-gates`: Fix-first questions and ambiguous review decisions are modeled
  as gates rather than hidden prose.
- `gateways`: scope detection and optional integrations select which review
  branches run.
- `subworkflows`: specialist reviews remain reusable child workflows.
- `error-handling`: optional integrations such as Greptile and advisory scans can
  fail open, while required checklist loading fails closed.

Review-system-specific semantics that are not standard WorkflowIR profiles remain
namespaced extensions:

- `review-system/fix-first`: AUTO-FIX versus ASK classification and approved-fix flow.
- `review-system/greptile-triage`: comment fetch, suppression, classification, and
  reply-template behavior.
- `review-system/review-scope`: source-file scope predicates for specialist selection.
- `review-system/review-result-persistence`: persisted review result metadata.
