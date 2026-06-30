---
title: WorkflowIR Change Ledger
description: Local ledger for vendored WorkflowIR changes that need upstream or backport handling.
group: Metro References
order: 26
---

# WorkflowIR Change Ledger

This ledger records local edits to the vendored WorkflowIR reference copy when
Merge God needs a schema/spec capability before the upstream Metro copy is
refreshed. Each entry should be reviewed during the next Metro backport.

## 2026-06-28 - Add `prompt-runtime` Profile

**Status:** local vendored reference change, pending upstream/backport review.

**Files changed:**

- `WORKFLOW-IR-SPEC.md`
- `WORKFLOW-IR-GUIDE.md`
- `workflow-ir-registry.yaml`
- `workflow-ir.schema.json`

**Reason:** Existing WorkflowIR role documents already require
`prompt-runtime` for prompt-driven agentic review nodes, but the v1 JSON Schema
profile enum and profile descriptions did not include it. This made otherwise
valid review-role extractions fail schema validation.

**Compatibility:** additive. The new profile only affects workflows that opt in
through `capabilities.required_profiles[]` or
`capabilities.optional_profiles[]`.

**Backport note:** Add `prompt-runtime` to the upstream WorkflowIR v1 standard
profile list, registry entry, JSON Schema enum, and implementer guide. Preserve
the distinction from `agentic`: `agentic` describes autonomous execution
semantics; `prompt-runtime` describes prompt contract preservation.
