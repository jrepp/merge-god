# Implementation Role WorkflowIR Index

This directory encodes each implementation role as a standalone WorkflowIR
document. The source implementation is the grounding material for role semantics,
inputs, outputs, and safety boundaries.

## Role Files

| Role | WorkflowIR file | Source implementation |
| --- | --- | --- |
| Feature Request Triage | `feature-request-triage.workflow-ir.md` | `source/feature-request-triage.go` |
| Requirements Architecture | `requirements-architecture.workflow-ir.md` | `source/requirements-architecture.go` |
| Code Change Implementation | `code-change-implementation.workflow-ir.md` | `source/code-change-implementation.go`, `source/code-change-prompts.go` |
| Adversarial Review Coordination | `adversarial-review-coordination.workflow-ir.md` | `source/adversarial-review-coordination.go` |
| Security Review | `security-review.workflow-ir.md` | `source/security-review.go` |
| Logic Review | `logic-review.workflow-ir.md` | `source/logic-review.go` |
| Resilience Review | `resilience-review.workflow-ir.md` | `source/resilience-review.go` |

## Shared WorkflowIR Grounding

These files use the imported Metro references in `docs/metro-spec/`:

- `WORKFLOW-IR-SPEC.md`
- `WORKFLOW-IR-GUIDE.md`
- `PROMPT-SPEC.md`
- `workflow-ir.schema.json`
- `prompt-runtime-registry.yaml`
