# Testing Workflow

Complete guide to testing merge-god's PR automation pipeline.

## Overview

The merge-god testing workflow is designed around **process isolation** and **database caching**, allowing you to test agent behavior without hitting GitHub API rate limits or requiring live PR data.

## Multi-Part Testing Workflow

### 1. Update Database (Cache PR Context)

First, sync PR context from GitHub to the local SQLite database:

```bash
# Initialize database (first time only)
uv run python init_database.py

# Update database with repositories from config
uv run python update_db_from_config.py

# Sync specific PR context to database
uv run python -m merge_god.cli scan --repo "prism merge" --pr 123

# Or sync all PRs with for-landing/for-review labels
uv run python -m merge_god.cli scan --repo "prism merge"

# Or sync all repos from config
uv run python -m merge_god.cli scan
```

**What gets cached:**

- PR metadata (title, author, branches, labels)
- Complete diff of all changes
- All comments and review comments
- Commit history
- Changed files list
- Merge conflict detection
- CI/CD check status
- Repository guidelines

### 2. Run Agent in Test Harness

Run the agent using cached database data (no GitHub API calls):

```bash
# Run agent from database (Process 3 isolation)
uv run python -m merge_god.cli agent \
    --repo "prism merge" \
    --pr 123 \
    --mode for-landing \
    --db merge-god-state.db \
    --repo-path /Users/jrepp/dev/data-access-2

# For comprehensive review mode
uv run python -m merge_god.cli agent \
    --repo "prism merge" \
    --pr 123 \
    --mode for-review
```

**Agent modes:**

- `for-landing`: Basic processing (conflicts, reviews, CI fixes)
- `for-review`: Comprehensive code review + improvements

**Test harness features:**

- Runs entirely from database (no API calls)
- Real Claude API invocation with streaming
- Full git operations (checkout, merge, commit, push)
- Structured logging to database
- Session tracking with metrics

### 3. Capture Results

The agent automatically captures detailed execution data:

**Database tables populated:**

- `agent_sessions`: Session metadata, status, timing, tokens
- `agent_actions`: Individual actions taken (file edits, git commands)
- `agent_turns`: Conversation turns with token counts
- `agent_errors`: Errors encountered during execution
- `agent_file_operations`: File read/write/edit operations
- `processing_history`: Overall processing success/failure

**Query results:**

```bash
# Get latest session for a PR
sqlite3 merge-god-state.db "
SELECT
    session_id, mode, status, success,
    tasks_total, tasks_completed, tasks_failed,
    input_tokens, output_tokens, estimated_cost,
    duration_seconds
FROM agent_sessions
WHERE repo_name = 'prism merge' AND pr_number = 123
ORDER BY started_at DESC
LIMIT 1;
"

# Get all actions for a session
sqlite3 merge-god-state.db "
SELECT action_number, action_type, target, status, success
FROM agent_actions
WHERE session_id = '<session-id>'
ORDER BY action_number;
"

# Get file operations
sqlite3 merge-god-state.db "
SELECT operation_type, file_path, lines_added, lines_removed
FROM agent_file_operations
WHERE session_id = '<session-id>'
ORDER BY occurred_at;
"
```

### 4. Evaluate Results

Evaluate agent performance and output quality:

```bash
# Run evaluation script
uv run python evaluate_agent_results.py \
    --repo "prism merge" \
    --pr 123 \
    --session <session-id>

# Or evaluate the latest session
uv run python evaluate_agent_results.py \
    --repo "prism merge" \
    --pr 123 \
    --latest
```

**Evaluation criteria:**

- ✅ **Success rate**: Did the agent complete successfully?
- 📊 **Task completion**: How many tasks completed vs failed?
- 💰 **Cost analysis**: Token usage and estimated cost
- ⏱️ **Performance**: Duration and API call count
- 📝 **Code quality**: File changes, additions, deletions
- ❌ **Error analysis**: Types and frequency of errors
- 🎯 **Goal achievement**: Did it resolve conflicts, fix CI, address reviews?

## Complete Testing Example

```bash
# Step 1: Initialize database (first time only)
uv run python init_database.py
uv run python update_db_from_config.py

# Step 2: Cache PR context
uv run python -m merge_god.cli scan --repo "prism merge" --pr 134

# Step 3: Run agent in test harness
uv run python -m merge_god.cli agent \
    --repo "prism merge" \
    --pr 134 \
    --mode for-landing \
    --repo-path /Users/jrepp/dev/data-access-2

# Step 4: Capture session ID from output
# Look for: "session_id": "abc123..."

# Step 5: Evaluate results
uv run python evaluate_agent_results.py \
    --repo "prism merge" \
    --pr 134 \
    --latest

# Or query database directly
sqlite3 merge-god-state.db "
SELECT
    mode, status, success,
    tasks_completed, tasks_failed,
    input_tokens, output_tokens, estimated_cost,
    ROUND(duration_seconds, 2) as duration_sec
FROM agent_sessions
WHERE repo_name = 'prism merge' AND pr_number = 134
ORDER BY started_at DESC
LIMIT 1;
"
```

## Workflow Advantages

### Process Isolation

Each part runs independently:

- **Process 1**: GitHub scanning → Database
- **Process 2**: PR context gathering → Database
- **Process 3**: Agent invocation (from Database)

This allows:

- Testing agent without API rate limits
- Replaying failed runs with same data
- Debugging with consistent state
- Parallel testing of multiple scenarios

### Database as Contract

The SQLite database acts as the contract between processes:

- Clearly defined schema
- Versioned data snapshots
- Audit trail of all operations
- Easy inspection and debugging

### Reproducibility

Cache PR context once, test agent many times:

- No API calls during testing
- Same input data for consistency
- Different modes/parameters
- Compare results across runs

## Test Harness Scripts

### Quick Test

```bash
# test_agent_quick.sh
#!/bin/bash
REPO="prism merge"
PR=134
MODE="for-landing"

echo "1. Syncing PR context..."
uv run python -m merge_god.cli scan --repo "$REPO" --pr $PR

echo "2. Running agent..."
uv run python -m merge_god.cli agent \
    --repo "$REPO" \
    --pr $PR \
    --mode $MODE \
    --repo-path /Users/jrepp/dev/data-access-2 \
    2>&1 | tee agent_run.log

echo "3. Evaluating results..."
uv run python evaluate_agent_results.py --repo "$REPO" --pr $PR --latest
```

### Comprehensive Test

```bash
# test_agent_comprehensive.sh
#!/bin/bash
REPO="prism merge"
PR=134

# Test both modes
for MODE in for-landing for-review; do
    echo "Testing mode: $MODE"

    # Sync fresh data
    uv run python -m merge_god.cli scan --repo "$REPO" --pr $PR

    # Run agent
    uv run python -m merge_god.cli agent \
        --repo "$REPO" \
        --pr $PR \
        --mode $MODE \
        --repo-path /Users/jrepp/dev/data-access-2 \
        2>&1 | tee "agent_run_${MODE}.log"

    # Evaluate
    uv run python evaluate_agent_results.py \
        --repo "$REPO" \
        --pr $PR \
        --latest \
        > "evaluation_${MODE}.txt"
done

# Compare results
echo "Comparison:"
echo "Landing mode:"
grep "Success:" evaluation_for-landing.txt
echo "Review mode:"
grep "Success:" evaluation_for-review.txt
```

## Validation Script

Use the validation script to check process isolation:

```bash
# Validate that all processes are properly isolated
uv run python -m merge_god.cli validate --repo "prism merge" --pr 134
```

This checks:

- Database schema is correct
- PR context is complete
- Agent can load from database only
- No GitHub API calls in Process 3

## Debugging Tips

### Enable Verbose Logging

```bash
# Set environment variables for detailed logging
export ANTHROPIC_LOG=debug
export DEBUG=1

uv run python -m merge_god.cli agent --repo "prism merge" --pr 134
```

### Inspect Database State

```bash
# Check what's cached
sqlite3 merge-god-state.db "
SELECT repo_name, pr_number,
       LENGTH(diff) as diff_size,
       LENGTH(comments) as comments_size
FROM pr_context
ORDER BY captured_at DESC
LIMIT 5;
"

# Check agent sessions
sqlite3 merge-god-state.db "
SELECT repo_name, pr_number, mode, status,
       started_at, completed_at, success
FROM agent_sessions
ORDER BY started_at DESC
LIMIT 10;
"
```

### Replay Failed Sessions

```bash
# Get session details
SESSION_ID="abc123..."

sqlite3 merge-god-state.db "
SELECT * FROM agent_sessions WHERE session_id = '$SESSION_ID';
"

# Check errors
sqlite3 merge-god-state.db "
SELECT error_type, error_message, occurred_at
FROM agent_errors
WHERE session_id = '$SESSION_ID'
ORDER BY occurred_at;
"

# Re-run with same cached data
uv run python -m merge_god.cli agent \
    --repo "prism merge" \
    --pr 134 \
    --mode for-landing
```

## Performance Testing

### Token Usage Analysis

```bash
sqlite3 merge-god-state.db "
SELECT
    mode,
    AVG(input_tokens) as avg_input,
    AVG(output_tokens) as avg_output,
    AVG(total_tokens) as avg_total,
    AVG(estimated_cost) as avg_cost
FROM agent_sessions
WHERE success = 1
GROUP BY mode;
"
```

### Success Rate by Mode

```bash
sqlite3 merge-god-state.db "
SELECT
    mode,
    COUNT(*) as total,
    SUM(success) as successful,
    ROUND(100.0 * SUM(success) / COUNT(*), 2) as success_rate
FROM agent_sessions
GROUP BY mode;
"
```

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Test Agent

on:
  pull_request:
    branches: [ main ]

jobs:
  test-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install uv
        run: curl -LsSf https://astral.sh/uv/install.sh | sh

      - name: Initialize database
        run: |
          uv run python init_database.py
          uv run python update_db_from_config.py

      - name: Test agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Use test PR data
          uv run python -m merge_god.cli scan --repo test-repo --pr 1
          uv run python -m merge_god.cli agent --repo test-repo --pr 1

      - name: Evaluate results
        run: |
          uv run python evaluate_agent_results.py --repo test-repo --pr 1 --latest

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: agent-test-results
          path: |
            merge-god-state.db
            agent_run.log
```

## Related Documentation

- [AGENT_TESTING.md](AGENT_TESTING.md) - Agent-specific testing guide
- [PRD.md](PRD.md) - Product requirements and features
- [ADR.md](ADR.md) - Architecture decision records
- [DEVELOPMENT.md](DEVELOPMENT.md) - Development setup
