---
title: 5-Minute Processing Loop
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-009
project_id: merge-god
doc_uuid: 88d5a460-3854-4f6c-bcf8-3c67fa415067
---

# 5-Minute Processing Loop

# Context

Need to balance responsiveness with resource usage and API rate limits.

# Decision

Poll for PRs every 5 minutes (300 seconds).

# Rationale

- **Rate limit friendly**: Avoids hammering GitHub API
- **Reasonable latency**: PRs processed within 5 minutes
- **Resource efficient**: CPU mostly idle
- **Configurable**: Easy to adjust if needed

# Consequences

## Positive

- Gentle on GitHub API
- Low CPU/memory usage when idle
- Unlikely to hit rate limits
- Reasonable response time

## Negative

- Not real-time (up to 5 minute delay)
- May be too slow for urgent PRs
- Multiple PRs processed sequentially

# Configuration

Currently hardcoded. Could be made configurable via environment variable if needed.

# References

- Migrated from legacy `ADR.md` (ADR-009)
