# Testing Quick Reference

Quick commands for the merge-god testing workflow.

## Quick Start

```bash
# 1. Initialize database (first time only)
uv run python init_database.py
uv run python update_db_from_config.py

# 2. Cache PR context
uv run python -m merge_god.cli scan --repo "prism merge" --pr 134

# 3. Run agent test
uv run python -m merge_god.cli agent \
    --repo "prism merge" \
    --pr 134 \
    --mode for-landing \
    --repo-path /Users/jrepp/dev/data-access-2

# 4. Evaluate results
uv run python evaluate_agent_results.py --repo "prism merge" --pr 134 --latest
```

## Common Commands

### Database Operations

```bash
# Initialize new database
uv run python init_database.py

# Update from config
uv run python update_db_from_config.py

# Check database stats
sqlite3 merge-god-state.db "
SELECT COUNT(*) as repos FROM repositories;
SELECT COUNT(*) as prs FROM pr_context;
SELECT COUNT(*) as sessions FROM agent_sessions;
"
```

### Sync PR Context

```bash
# Sync specific PR
uv run python -m merge_god.cli scan --repo "REPO" --pr NUMBER

# Sync all PRs with labels
uv run python -m merge_god.cli scan --repo "REPO"

# Sync all repos from config
uv run python -m merge_god.cli scan
```

### Run Agent

```bash
# Landing mode (basic)
uv run python -m merge_god.cli agent \
    --repo "REPO" --pr NUMBER \
    --mode for-landing \
    --repo-path /path/to/repo

# Review mode (comprehensive)
uv run python -m merge_god.cli agent \
    --repo "REPO" --pr NUMBER \
    --mode for-review \
    --repo-path /path/to/repo
```

### Evaluate Results

```bash
# Latest session
uv run python evaluate_agent_results.py --repo "REPO" --pr NUMBER --latest

# Specific session
uv run python evaluate_agent_results.py \
    --repo "REPO" --pr NUMBER \
    --session SESSION_ID

# Compare multiple sessions
uv run python evaluate_agent_results.py --repo "REPO" --pr NUMBER --compare
```

## Database Queries

### Check PR Context

```sql
-- See cached PRs
SELECT
    repo_name, pr_number, title,
    LENGTH(diff) as diff_bytes,
    json_array_length(files) as file_count,
    datetime(captured_at) as cached_at
FROM pr_context
ORDER BY captured_at DESC
LIMIT 10;
```

### Check Agent Sessions

```sql
-- Recent sessions
SELECT
    repo_name, pr_number, mode, status,
    tasks_completed || '/' || tasks_total as tasks,
    ROUND(duration_seconds, 1) as duration_sec,
    ROUND(estimated_cost, 4) as cost_usd,
    datetime(started_at) as started
FROM agent_sessions
ORDER BY started_at DESC
LIMIT 10;
```

### Success Rate

```sql
-- Success rate by mode
SELECT
    mode,
    COUNT(*) as total,
    SUM(success) as successful,
    ROUND(100.0 * SUM(success) / COUNT(*), 1) as success_rate_pct
FROM agent_sessions
GROUP BY mode;
```

### Session Details

```sql
-- Full session details
SELECT * FROM agent_sessions WHERE session_id = 'SESSION_ID';

-- Actions taken
SELECT action_number, action_type, target, status, success
FROM agent_actions
WHERE session_id = 'SESSION_ID'
ORDER BY action_number;

-- Errors
SELECT error_type, error_message, occurred_at
FROM agent_errors
WHERE session_id = 'SESSION_ID';

-- File operations
SELECT operation_type, file_path, lines_added, lines_removed
FROM agent_file_operations
WHERE session_id = 'SESSION_ID';
```

## Test Scenarios

### Test Merge Conflicts

```bash
# Create conflict PR in test repo
cd /path/to/test-repo
git checkout -b test/conflict
echo "change A" >> file.txt
git commit -am "Create conflict"
git push origin test/conflict

# Create conflicting change on main
git checkout main
echo "change B" >> file.txt
git commit -am "Conflicting change"
git push

# Test agent resolution
uv run python -m merge_god.cli scan --repo test-repo --pr NUMBER
uv run python -m merge_god.cli agent --repo test-repo --pr NUMBER
```

### Test CI Failures

```bash
# Create failing test PR
cd /path/to/test-repo
git checkout -b test/failing-ci
echo "def broken(): return 1/0" >> src/app.py
git commit -am "Break tests"
git push origin test/failing-ci

# Test agent fix
uv run python -m merge_god.cli scan --repo test-repo --pr NUMBER
uv run python -m merge_god.cli agent --repo test-repo --pr NUMBER
```

### Compare Modes

```bash
# Test both modes on same PR
REPO="test-repo"
PR=123

for MODE in for-landing for-review; do
    echo "Testing $MODE mode..."
    uv run python -m merge_god.cli agent \
        --repo "$REPO" --pr $PR --mode $MODE \
        2>&1 | tee "test_${MODE}.log"
done

# Compare results
sqlite3 merge-god-state.db "
SELECT mode, success, tasks_completed, duration_seconds, estimated_cost
FROM agent_sessions
WHERE repo_name = '$REPO' AND pr_number = $PR
ORDER BY started_at DESC
LIMIT 2;
"
```

## Debugging

### Enable Verbose Logging

```bash
export ANTHROPIC_LOG=debug
export DEBUG=1
uv run python -m merge_god.cli agent --repo "REPO" --pr NUMBER 2>&1 | tee debug.log
```

### Check Last Session

```bash
# Get session ID
sqlite3 merge-god-state.db "
SELECT session_id, status, error_message
FROM agent_sessions
ORDER BY started_at DESC
LIMIT 1;
"

# Check errors
sqlite3 merge-god-state.db "
SELECT error_type, error_message
FROM agent_errors
WHERE session_id = 'SESSION_ID';
"
```

### Validate Setup

```bash
# Check database schema
sqlite3 merge-god-state.db ".schema"

# Check config
cat config.yaml

# Check cached data
sqlite3 merge-god-state.db "
SELECT repo_name, COUNT(*) as cached_prs
FROM pr_context
GROUP BY repo_name;
"
```

## Performance Analysis

### Token Usage

```bash
sqlite3 merge-god-state.db "
SELECT
    mode,
    AVG(input_tokens) as avg_input,
    AVG(output_tokens) as avg_output,
    AVG(estimated_cost) as avg_cost
FROM agent_sessions
WHERE success = 1
GROUP BY mode;
"
```

### Duration Stats

```bash
sqlite3 merge-god-state.db "
SELECT
    mode,
    AVG(duration_seconds) as avg_seconds,
    MIN(duration_seconds) as min_seconds,
    MAX(duration_seconds) as max_seconds
FROM agent_sessions
WHERE success = 1
GROUP BY mode;
"
```

### Cost Tracking

```bash
sqlite3 merge-god-state.db "
SELECT
    SUM(estimated_cost) as total_cost,
    COUNT(*) as session_count,
    AVG(estimated_cost) as avg_cost_per_session
FROM agent_sessions
WHERE success = 1;
"
```

## Aliases (Add to ~/.bashrc or ~/.zshrc)

```bash
# merge-god testing aliases
alias mg-init="uv run python init_database.py && uv run python update_db_from_config.py"
alias mg-scan="uv run python -m merge_god.cli scan"
alias mg-agent="uv run python -m merge_god.cli agent"
alias mg-eval="uv run python evaluate_agent_results.py"
alias mg-db="sqlite3 merge-god-state.db"

# Quick test workflow
function mg-test() {
    local REPO=$1
    local PR=$2
    echo "Testing $REPO PR#$PR"
    mg-scan --repo "$REPO" --pr $PR && \
    mg-agent --repo "$REPO" --pr $PR --mode for-landing && \
    mg-eval --repo "$REPO" --pr $PR --latest
}
```

## Environment Variables

```bash
# Claude API configuration
export ANTHROPIC_API_KEY="your-key-here"
export ANTHROPIC_MODEL="claude-sonnet-4-5-20250929"

# Or use AWS Bedrock
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION="us-west-2"
export ANTHROPIC_MODEL="global.anthropic.claude-sonnet-4-5-20250929-v1:0"

# Debugging
export ANTHROPIC_LOG=debug
export DEBUG=1
```

## Related Documentation

- **[TESTING.md](TESTING.md)** - Complete testing workflow guide
- **[AGENT_TESTING.md](AGENT_TESTING.md)** - Agent-specific testing details
- **[README.md](README.md)** - Main documentation
- **[DEVELOPMENT.md](DEVELOPMENT.md)** - Development setup
