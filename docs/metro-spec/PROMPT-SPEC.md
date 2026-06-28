---
title: Metro Prompt Specification v1
description: Reference copy of the Metro prompt authoring specification.
group: Metro References
order: 10
---

# Metro Prompt Specification v1

**Date**: 2026-04-03
**Status**: Draft, aligned to frozen v1 schema registry
**Source of truth**: [`prompt-runtime-registry.yaml`](prompt-runtime-registry.yaml)

---

## Overview

Metro prompt definitions are first-class catalog objects used by:

- framework-owned prompt-driven stages in `agent`
- workflow-authored prompt references such as `builtin.llm_ask`
- prompt tracing, KB provenance, step outcomes, and STM candidate recording

This document describes the authored prompt object shape and how workflow specs
should reference prompts. The canonical field-level contract lives in the schema
registry under `prompt-runtime`.

---

## Canonical Grounding

Prompt definitions and prompt trace records must align to:

- `prompt.definition`
- `prompt.invocation`
- `prompt.retrieval-provenance`
- `prompt.step-outcome`
- `prompt.stm-candidate`

from:

- [`prompt-runtime-registry.yaml`](prompt-runtime-registry.yaml)

If this spec and the schema registry disagree, the schema registry wins.

---

## Prompt Reference Format

Prompt references use a canonical ref form:

```text
prompt://<prompt-id>@<semantic-version>
```

Examples:

- `prompt://framework.intent.extract@1.0.0`
- `prompt://framework.plan.create@1.0.0`
- `prompt://workflow.capacity.assessment@1.0.0`

Workflow authors should prefer prompt refs over raw inline prompt text.

---

## Prompt Definition Fields

The authored prompt object should provide at least:

| Field | Required | Description |
| --- | --- | --- |
| `prompt_id` | yes | Stable prompt identifier |
| `semantic_version` | yes | Semver for intended compatibility |
| `stage_id` | yes | Logical stage, e.g. `plan.create` |
| `owner_type` | yes | `framework` or `workflow` |
| `description` | yes | Human-readable description |
| `base_instructions` | yes | Canonical semantic core of the prompt |
| `output_contract_ref` | yes | Contract expected from output |
| `status` | yes | `draft`, `active`, `deprecated` |
| `context_contract_ref` | no | Structured context contract |
| `policy_ref` | no | Execution / parsing policy |
| `provider_overrides` | no | Provider-specific adjustments |
| `model_overrides` | no | Model-specific adjustments |
| `tags` | no | Search / grouping metadata |

---

## Invariants

Prompt definitions should follow these rules:

1. `prompt_id` is stable across patch/minor revisions.
2. `semantic_version` communicates intended compatibility.
3. `base_instructions` are the invariant semantic core.
4. Provider/model overrides may tune style and formatting, but should not weaken:
   - output contract requirements
   - safety constraints
   - required semantic obligations

---

## Workflow Usage

Workflow specs may reference prompts directly on prompt-driven steps.

Example:

```yaml
id: assess_source_capacity
action: builtin.llm_ask
prompt_ref: prompt://workflow.capacity.assessment@1.0.0
prompt_version: 1.0.0
with:
  question: "Assess whether the source CPC is overcommitted."
```

### Migration Note

Legacy `with.system` text is still allowed during migration, but it is a
fallback path. Production/published workflows should move to prompt refs.

---

## Tracing Linkage

Every prompt-driven execution should be traceable back to:

- prompt ref
- semver
- resolved prompt hash
- workflow ref/version
- KB section provenance
- step outcome
- STM candidate, if any

That linkage is governed by the prompt-runtime schema family rather than this
spec alone.

---

## Relationship To Workflow Spec

[`WORKFLOW-SPEC.md`](WORKFLOW-SPEC.md) defines how workflows reference prompts.
This document defines what the prompt object itself means.

Use both together:

- [`WORKFLOW-SPEC.md`](WORKFLOW-SPEC.md) for workflow authoring
- [`PROMPT-SPEC.md`](PROMPT-SPEC.md) for prompt authoring
- [`prompt-runtime-registry.yaml`](prompt-runtime-registry.yaml) for canonical
  shared contracts
