---
title: Real-Time Notifications via ntfy.sh
status: Accepted
created: 2025-11-21T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-006
project_id: merge-god
doc_uuid: 70e75519-d3a5-4587-8784-657a72d9df87
---

# Real-Time Notifications via ntfy.sh

# Context

Need real-time visibility into PR processing events without monitoring logs constantly.

# Decision

Use ntfy.sh for push notifications to mobile/desktop/web.

# Rationale

- **No setup**: Public topic, no registration needed
- **Multi-platform**: iOS, Android, desktop, web
- **No dependencies**: Use urllib (Python stdlib)
- **Free**: Public topics are free
- **Simple API**: Just HTTP POST
- **Priorities**: Support urgent/high/default/low

# Consequences

## Positive

- Instant visibility into processing status
- Works on phone, desktop, browser
- No infrastructure to manage
- Simple implementation

## Negative

- Public topic (anyone can subscribe)
- No authentication on public topics
- Dependent on ntfy.sh availability
- Limited message history

# Implementation

- Topic: `merge-god-sez`
- Notifications: Start, Complete, Failure, Review status
- Emoji tags for visual identification
- High priority for failures

# References

- Migrated from legacy `ADR.md` (ADR-006)
