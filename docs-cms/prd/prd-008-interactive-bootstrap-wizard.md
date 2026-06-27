---
title: Interactive Bootstrap Wizard
status: Completed
author: Jacob Repp
created: 2025-11-21T00:00:00Z
target_release: Released
tags: [feature, merge-god]
id: prd-008
project_id: merge-god
doc_uuid: 79015a32-c08c-45bb-99b2-4acbfc76794d
---

# Interactive Bootstrap Wizard

## Executive Summary

Interactive Bootstrap Wizard for the merge-god PR automation system.

**Priority:** P1 (High)

# Requirements

- [x] Detect missing config file
- [x] Offer interactive setup
- [x] Prompt for repository paths
- [x] Validate paths in real-time
- [x] Support tilde (~) and relative path expansion
- [x] Suggest display names from directory names
- [x] Allow enabling/disabling repositories
- [x] Support adding multiple repositories
- [x] Show summary before saving
- [x] Generate formatted YAML with comments
- [x] Optional dry-run validation after creation

# Success Criteria

- New users can run `./dashboard.py` without any config file
- Wizard validates inputs as they're entered
- Generated config file is properly formatted
- User can opt out and create config manually
- Works with any config file name (not just config.yaml)

# User Flow

1. User runs dashboard without config file
2. Dashboard detects missing config and prompts
3. User confirms they want to create config
4. For each repository:
   - Enter path (validated in real-time)
   - Enter display name (default: directory name)
   - Enable/disable
   - Add another? (yes/no)
5. Show summary table
6. Confirm save
7. Optional: run dry-run validation

##

# References

- Migrated from legacy `PRD.md`
