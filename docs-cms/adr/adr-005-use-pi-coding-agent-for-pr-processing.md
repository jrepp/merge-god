---
title: Use pi (with the merge-god extension) for PR Processing
status: Accepted
created: 2025-11-20T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-005
project_id: merge-god
doc_uuid: f6a0ad09-d47d-4bd7-9309-00590fd5a2ff
---

# Use pi (with the merge-god extension) for PR Processing

# Context

Need an AI agent to actually perform PR fixes (resolve conflicts, address reviews, fix CI).

# Decision

Drive the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent
through a coordination API (`merge_god/coordination.py`) plus a custom pi
extension (`pi/extensions/merge-god`). merge-god publishes a work item (the
gathered prompt/context); the extension's `merge_god_*` tools pull it and report
results back over HTTP. This supersedes the earlier `bob --json <prompt>`
subprocess contract.

# Rationale

- **Tool-based**: the agent interacts via named tools instead of a one-shot prompt argument
- **Coordination API**: clean HTTP boundary (work item + result) between orchestrator and agent
- **Comprehensive**: pi has read/bash/edit/write tools for git, tests, edits, commits
- **JSON mode**: pi `--print --mode json` for structured, non-interactive output

# Consequences

## Positive

- Powerful, tool-mediated agent capabilities
- Can handle complex multi-step tasks
- Clean, extensible boundary between merge-god and the agent

## Negative

- Requires `pi` to be installed and the merge-god extension available
- API costs for LLM usage
- Non-deterministic outcomes
- May need prompt/tool tuning

# References

- Migrated from legacy `ADR.md` (ADR-005)
