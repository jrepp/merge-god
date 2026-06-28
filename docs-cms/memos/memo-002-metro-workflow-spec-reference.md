---
title: Metro Workflow Spec Reference
author: Engineering Team
created: 2026-06-28T06:48:37Z
tags: [memo, metro, reference, workflow-ir]
id: memo-002
project_id: merge-god
doc_uuid: 6d21f887-71a8-4406-8786-ab7bbd9c0ae7
---

# Overview

Merge God keeps a vendored copy of selected Metro workflow and WorkflowIR specification files under [`docs/metro-spec`](../../docs/metro-spec/README.md). These files ground WorkflowIR extraction work without making Metro itself part of the Merge God documentation source of truth.

# Context

The canonical Metro sources live in the Metro repository under `spec/` and `schema-registry/workflow-ir/`. The local copy is intentionally limited to the files needed for Merge God workflow extraction discussions.

# Details

The vendored reference currently includes:

- `WORKFLOW-SPEC.md`
- `PROMPT-SPEC.md`
- `WORKFLOW-IR-SPEC.md`
- `WORKFLOW-IR-GUIDE.md`
- `workflow-README.md`
- `workflow-QUICK-REF.md`
- `workflow-ir-registry.yaml`
- `workflow-ir.schema.json`
- `prompt-runtime-registry.yaml`

Do not edit the Metro reference files as if they are Merge God-owned specifications. If they need substantive changes, refresh them from upstream Metro or document a Merge God-specific adaptation in `docs-cms/rfcs/`.

# Recommendations

- Keep Merge God decisions and proposals in `docs-cms`.
- Keep imported Metro files under `docs/metro-spec`.
- Avoid linking from publishable docs to upstream-only Metro files unless the link is stable or explicitly marked as not vendored.
- Re-run documentation link checks after refreshing the vendored copy.

# References

- [Metro Workflow Spec References](../../docs/metro-spec/README.md)
- [RFC-001: Merge God WorkflowIR Extraction](../rfcs/rfc-001-workflow-ir-extraction.md)
