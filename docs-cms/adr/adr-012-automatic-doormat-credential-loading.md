---
title: Automatic Doormat Credential Loading
status: Accepted
created: 2025-11-21T00:00:00Z
deciders: System Designer
tags: [architecture, merge-god]
id: adr-012
project_id: merge-god
doc_uuid: 4501ba00-2ab5-4eb5-ada4-5c95f0c3d710
---

# Automatic Doormat Credential Loading

# Context

Long-running dashboard sessions may have expired AWS credentials. Need automatic credential refresh without manual intervention.

# Decision

Automatically detect and use `doormat` (if available) to refresh AWS credentials before launching each repository monitor.

# Rationale

- **Automatic**: No manual intervention needed
- **Optional**: Works with or without doormat
- **Non-blocking**: Doesn't fail if doormat unavailable
- **Per-repo**: Credentials refreshed for each repo launch
- **Transparent**: Logs attempts in dashboard

# Consequences

## Positive

- AWS credentials always fresh for long sessions
- No manual `doormat refresh` needed
- Graceful degradation if doormat not installed
- Works in tmux sessions without user interaction

## Negative

- Adds 1-2 second delay at startup per repo
- Assumes doormat command name and arguments
- No configuration for doormat command/args

# Implementation

```python
# In RepoMonitor.start()
self.load_doormat_credentials()  # Non-fatal
subprocess.Popen([pr-loop.py, repo_path])
```

Doormat check:

1. Check if `doormat` command exists
2. Run `doormat refresh` with 30s timeout
3. Log success/failure
4. Continue regardless of outcome (non-fatal)

##

# References

- Migrated from legacy `ADR.md` (ADR-012)
