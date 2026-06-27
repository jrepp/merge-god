---
title: Structured JSON Logging
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-003
project_id: merge-god
doc_uuid: 593e4733-2c42-4a73-ac7e-3b3e06fa54d5
---

# Structured JSON Logging

# Context

Need observable, parseable logs for automated PR processing that runs unattended.

# Decision

Emit all logs as structured JSON with timestamp, event type, and data payload.

# Rationale

- **Machine readable**: Easy to parse with jq, logstash, etc.
- **Structured**: Consistent format across all events
- **Queryable**: Can filter/search by event type or fields
- **Time-ordered**: ISO8601 timestamps for sorting
- **Integration ready**: Works with log aggregators

# Consequences

## Positive

- Easy to analyze logs programmatically
- Works with modern logging infrastructure
- Consistent format reduces parsing errors
- Can pipe to jq for pretty printing

## Negative

- Less human-readable in raw form
- More verbose than plain text
- Requires jq for nice viewing

# Format

```json
{
  "timestamp": "2025-11-21T12:00:00Z",
  "event": "event_type",
  "data": {...}
}
```

# References

- Migrated from legacy `ADR.md` (ADR-003)
