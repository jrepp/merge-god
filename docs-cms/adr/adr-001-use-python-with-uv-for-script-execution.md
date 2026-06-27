---
title: Use Python with uv for Script Execution
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-001
project_id: merge-god
doc_uuid: b8f46e9c-8a8f-4ef1-a483-d9efe329e1e0
---

# Use Python with uv for Script Execution

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
