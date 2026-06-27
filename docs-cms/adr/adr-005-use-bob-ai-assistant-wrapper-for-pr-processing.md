---
title: Use bob (AI Assistant Wrapper) for PR Processing
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-005
project_id: merge-god
doc_uuid: f6a0ad09-d47d-4bd7-9309-00590fd5a2ff
---

# Use bob (AI Assistant Wrapper) for PR Processing

# Context

Need an AI agent to actually perform PR fixes (resolve conflicts, address reviews, fix CI).

# Decision

Use `bob` (AI assistant wrapper) as the agent interface.

# Rationale

- **JSON mode**: Supports --json for structured interaction
- **Comprehensive**: Can handle git, tests, code edits, commits
- **Context aware**: LLM can understand full PR context
- **Autonomous**: Can work through multiple steps independently

# Consequences

## Positive

- Powerful agent capabilities
- Can handle complex multi-step tasks
- Natural language prompts
- Good at following guidelines

## Negative

- Requires bob to be installed and configured
- API costs for LLM usage
- Non-deterministic outcomes
- May need prompt tuning

# References

- Migrated from legacy `ADR.md` (ADR-005)
