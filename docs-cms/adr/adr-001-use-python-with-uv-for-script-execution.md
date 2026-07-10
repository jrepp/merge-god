---
title: Superseded Python uv Script Execution
status: Superseded
created: 2025-11-20T00:00:00Z
updated: 2026-07-09T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god, superseded]
id: adr-001
project_id: merge-god
doc_uuid: b8f46e9c-8a8f-4ef1-a483-d9efe329e1e0
---

# Superseded Python uv Script Execution

> Superseded: merge-god is now a TypeScript / Node.js ESM application. Runtime
> scripts are `.ts` files executed with Node and `tsx`; package management and
> CI use npm. This ADR remains as historical context for the pre-port design.

# Context

Need a reliable, modern way to manage dependencies and execute scripts without manual virtual environment setup.

# Decision

Use Python 3.12+ with uv (PEP 723 inline script metadata) for all scripts.

# Rationale

- **No venv needed**: uv manages dependencies automatically
- **Fast execution**: Cached environments start quickly
- **Reproducible**: Dependencies pinned in script headers
- **Modern standard**: Uses latest Python packaging standards (PEP 723)
- **Self-contained**: Scripts declare their own dependencies

# Consequences

## Positive

- Simplified deployment (just install uv)
- No requirements.txt to manage
- Scripts are self-documenting
- Fast cold starts

## Negative

- Requires uv to be installed
- Less familiar than traditional venv approach
- Limited IDE support for inline metadata

# Implementation

```python
#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
```

# References

- Migrated from legacy `ADR.md` (ADR-001)
- Superseded by the TypeScript port documented in `docs/development.md`,
  `docs/uv-guide.md`, and root `package.json`.
