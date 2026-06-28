---
title: Workflow Documentation Hub
description: Overview of Metro workflow authoring and WorkflowIR reference layers.
group: Metro References
order: 5
---

# Workflow Documentation Hub

This directory is the entry point for Metro/Meridian workflow documentation.
It supplements the top-level authoring spec with quick references and complete
example workflow files.

Workflow docs are intentionally split into two layers:

| Layer | Purpose | Use when |
| --- | --- | --- |
| Authoring format | Markdown plus embedded `scripted` YAML for simple, non-looping, human/model-friendly workflows. | Writing, reviewing, validating, indexing, or searching Metro workflow source files. |
| WorkflowIR | Durable graph contract for projection into Meridian/Gantry, DAG, BPM, durable workflow, and agentic backends. | Building compilers, adapters, cross-backend validation, or projection diagnostics. |

## Canonical Documents

| Document | Role |
| --- | --- |
| [`WORKFLOW-SPEC.md`](WORKFLOW-SPEC.md) | Normative authoring format for Markdown + `scripted` workflow files. |
| [`PROMPT-SPEC.md`](PROMPT-SPEC.md) | Normative prompt authoring reference for prompt-driven workflow steps. |
| [`workflow-QUICK-REF.md`](workflow-QUICK-REF.md) | Condensed authoring field reference and validation rule index. |
| `schemas/workflow.json` | Upstream parsed workflow document schema. Not vendored in this reference copy. |
| [`WORKFLOW-IR-SPEC.md`](WORKFLOW-IR-SPEC.md) | Normative WorkflowIR graph contract for backend projection. |
| [`WORKFLOW-IR-GUIDE.md`](WORKFLOW-IR-GUIDE.md) | Plain-language WorkflowIR implementer guide with examples. |
| [`workflow-ir-registry.yaml`](workflow-ir-registry.yaml) | Shared schema registry entry for WorkflowIR. |
| [`workflow-ir.schema.json`](workflow-ir.schema.json) | Machine-readable WorkflowIR v1 JSON Schema. |
| [`prompt-runtime-registry.yaml`](prompt-runtime-registry.yaml) | Shared schema registry entry for prompt runtime records. |

## Worked Examples

| Example | Demonstrates |
| --- | --- |
| `examples/01-basic-standalone.md` | Minimal standalone workflow with params, outputs, validation. Not vendored in this reference copy. |
| `examples/02-parallel-steps.md` | Parallel execution group with merged outputs. Not vendored in this reference copy. |
| `examples/03-typed-handoff.md` | Structured capture, typed inputs, and consume. Not vendored in this reference copy. |
| `examples/04-operator-decision.md` | Operator decision point with custom fields. Not vendored in this reference copy. |
| `examples/05-sub-workflow.md` | Sub-workflow composition with parameter passing. Not vendored in this reference copy. |
| `examples/06-conditional-error.md` | Conditional steps, error policies, and retry. Not vendored in this reference copy. |

## Authoring vs IR Boundary

Keep authored Metro workflows simple. The authoring format should remain easy
for people and models to write, review, validate, search, and package.

Use WorkflowIR when a workflow needs a durable projection target with richer
semantics such as:

- explicit graph edges
- gates and guards
- typed dataflow
- gateways and joins
- wait/event/timer semantics
- subworkflow invocation
- retry, timeout, cancellation, and compensation policies
- backend capability negotiation

Do not expand the authoring format just to mirror every BPM or durable workflow
runtime feature. Add projection semantics to WorkflowIR instead.

## Justfile Recipes

```bash
# Diagnose a workflow: dump structure, variables, scripted sections, stats
just workflow-diagnose metro-packages/workflows-z/workflows/migration/z15-to-z17-migration.md

# Dry-run invoke with verbose diagnostics
just workflow-invoke metro-packages/workflows-z/workflows/migration/z15-to-z17-migration.md
```

## Metro CLI

```bash
# Parse and dump a workflow's structure with verbose diagnostics
metro workflow-diagnose --workflows-dir metro-packages/workflows-z/workflows <slug-or-file>

# Trace variable flow (full, inputs, outputs, or validation mode)
metro workflow-trace --mode full --check-refs <slug>
```
