# Product Requirements (PRD) Tracker

This document tracks product requirements and features for the merge-god PR automation system.

---

## PRD-001: Automated PR Processing Loop
**Status**: ✅ Implemented
**Date**: 2025-11-20
**Priority**: P0 (Critical)

### Requirements
- [x] Continuous loop that processes open PRs
- [x] Exclude draft PRs from processing
- [x] Exclude WIP-labeled PRs
- [x] Sync repository before processing
- [x] Use `bob` (Claude Code wrapper) for PR fixes
- [x] Structured JSON logging for all operations
- [x] Modern Python 3.12+ with uv shebang support

### Success Criteria
- Script runs indefinitely without crashing
- All operations logged as structured JSON
- PRs processed in order with proper filtering

---

## PRD-002: Comprehensive PR Context Gathering
**Status**: ✅ Implemented
**Date**: 2025-11-20
**Priority**: P0 (Critical)

### Requirements
- [x] Fetch full PR details (title, description, author, dates)
- [x] Gather all discussion comments
- [x] Gather all inline code review comments
- [x] Get complete commit history
- [x] List all changed files with statistics
- [x] Detect merge conflicts proactively
- [x] Analyze CI/CD status with failure details
- [x] Retrieve full PR diff

### Success Criteria
- Agent receives complete context before processing
- All relevant PR information included in prompt
- No manual context gathering needed

---

## PRD-003: Security and Resilience
**Status**: ✅ Implemented
**Date**: 2025-11-20
**Priority**: P0 (Critical)

### Requirements
- [x] Input validation (branch names, ref validation)
- [x] Type safety (validate JSON structures)
- [x] Resource limits (50MB output cap)
- [x] Configurable timeouts per operation
- [x] Safe dictionary access throughout
- [x] Dynamic default branch detection
- [x] PR deduplication tracking

### Success Criteria
- No command injection vulnerabilities
- Graceful handling of malformed data
- Memory-safe operation on large PRs
- Works with main/master/develop branches

---

## PRD-004: Label-Based Processing Control
**Status**: ✅ Implemented
**Date**: 2025-11-21
**Priority**: P0 (Critical)

### Requirements
- [x] `for-landing` label: Basic PR processing
  - Resolve merge conflicts
  - Address code review comments
  - Fix failing CI checks
- [x] `for-review` label: Comprehensive review
  - All `for-landing` processing
  - Second pass code review
  - Quality/security/performance improvements
- [x] No label: Skip PR entirely
- [x] Categorize PRs by label at fetch time

### Success Criteria
- PRs processed according to their labels
- Two-pass system works for `for-review` PRs
- Unlabeled PRs are skipped
- Clear logging of categorization

---

## PRD-005: Real-Time Notifications
**Status**: ✅ Implemented
**Date**: 2025-11-21
**Priority**: P1 (High)

### Requirements
- [x] Send notifications to ntfy.sh topic
- [x] Notify on processing start
- [x] Notify on processing complete
- [x] Notify on processing failure (high priority)
- [x] Notify on review pass results
- [x] Include emoji tags for visual identification
- [x] No external dependencies (use urllib)

### Success Criteria
- Notifications delivered within seconds of events
- Different priorities for success vs failure
- Mobile/desktop/web notification support
- Topic: merge-god-sez

---

## PRD-006: Testing and Documentation
**Status**: ✅ Implemented
**Date**: 2025-11-20
**Priority**: P1 (High)

### Requirements
- [x] Unit tests for validation functions
- [x] Test prompt generation utility
- [x] Comprehensive README documentation
- [x] UV support documentation
- [x] Example prompt documentation
- [x] Usage examples and troubleshooting

### Success Criteria
- All tests pass
- Documentation covers all features
- New users can set up and run system
- Clear examples provided

---

## Future PRD Ideas (Not Prioritized)

### PRD-XXX: Merge Automation
**Status**: 💡 Idea
**Priority**: TBD

Auto-merge PRs after successful processing if:
- All CI checks pass
- Reviews approved
- No conflicts
- Label: `auto-merge`

### PRD-XXX: Metrics and Analytics
**Status**: 💡 Idea
**Priority**: TBD

Track metrics:
- PRs processed per day
- Success/failure rates
- Average processing time
- Most common failure reasons

### PRD-XXX: Multi-Repo Support
**Status**: 💡 Idea
**Priority**: TBD

Process PRs across multiple repositories:
- Config file with repo list
- Priority ordering
- Per-repo settings

### PRD-XXX: Web Dashboard
**Status**: 💡 Idea
**Priority**: TBD

Simple web UI to:
- View processing status
- See recent activity
- Manually trigger processing
- View logs in real-time

---

## Template for New PRDs

```markdown
## PRD-XXX: [Feature Name]
**Status**: 💡 Idea | 🚧 In Progress | ✅ Implemented | ❌ Rejected
**Date**: YYYY-MM-DD
**Priority**: P0 (Critical) | P1 (High) | P2 (Medium) | P3 (Low)

### Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

### Success Criteria
- How do we know this is done?
- What metrics define success?

### Notes
Any additional context, constraints, or considerations.
```
