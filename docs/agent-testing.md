---
title: Agent testing
description: Test and evaluate agent behavior in the merge-god pipeline using cached PR context.
group: Project
order: 32
---

Detailed guide for testing and evaluating pi-agent behavior in the merge-god pipeline.

## Understanding the Agent

### Agent Architecture

The merge-god PR-processing path uses the **pi agent** through the merge-god
coordination API:

- **Task decomposition**: Breaks PRs into discrete tasks
- **Coordination tools**: Pulls work from `mg_context` and reports via `mg_complete`
- **Isolated worktrees**: Runs every pi invocation inside a temporary git worktree
- **Tool calling**: File editing, git operations, test execution, and linked remediation PR creation
- **Error recovery**: Automatic retry with exponential backoff
- **Session tracking**: Complete audit trail in database

### Agent Modes

#### `for-landing` (Basic Mode)

Purpose: Get PR ready to merge

Tasks:

1. Checkout PR branch
2. Resolve merge conflicts with base branch
3. Address code review comments
4. Fix failing CI/CD checks
5. Push changes back to PR
6. Verify all checks pass

Use when:

- Routine PRs ready for merge
- Simple bug fixes
- Documentation updates
- Minor feature additions

#### `for-review` (Comprehensive Mode)

Purpose: Deep code quality improvements

Tasks (in addition to for-landing):
7. Fetch updated diff after initial fixes
8. Systematic code review of all changes
9. Identify bugs, security issues, performance problems
10. Apply best practices (SOLID, DRY, type safety)
11. Make targeted improvements with focused commits
12. Ensure proper error handling and edge cases

Use when:

- High-stakes PRs requiring thorough review
- PRs from junior developers or external contributors
- Security-sensitive changes
- Performance-critical code
- Complex refactorings

## Testing Workflow

### Deterministic Pi Failure Scenarios

Agent coordination behavior has a functional core in
`pi/agent_interactions.ts`. Request planning and response interpretation are
pure functions; execution receives a `CoordinationClient` value. Run these fast
tests without Pi, HTTP, git, or subprocess setup:

```bash
npm run test:pi-interactions
```

The Pi extension is a thin adapter created with an explicit client, clock, ID
source, trace-context reader, and traceparent reader. Only its default
production adapter reads process environment or global fetch state.

The Pi integration has a scenario-driven harness that launches the real
merge-god extension against the real localhost coordination API without calling
an external model provider. Run the fault matrix with:

```bash
npm run test:pi-faults

# Run one failure in isolation
MERGE_GOD_TEST_SCENARIO=tool_timeout npm run test:pi-faults
```

The shared runner covers agent failures before and during turns, explicit agent
failure results, agent and tool timeouts, thrown tools, coordination disconnects,
missing or invalid tool lifecycle events, HTTP failures, and malformed
responses. Every case records the normal tool
surface, turn/tool hierarchy, reliability measurements, worktree lifecycle, and
resume state when those stages are reached.

Duplicate completions are de-duplicated, completion-before-start is recorded as
a failed call, and both appear in `reliability.protocol_errors` and trajectory
`pi.tool_call.protocol_error` events.

The framework lives in `tests/helpers/pi_agent_harness.ts`; deterministic Pi
behavior lives in `tests/fixtures/fake_pi_agent.mjs`. Add a scenario to the
runner and its expected external outcome to `tests/pi_agent_harness.test.ts`.
The successful end-to-end Pi test uses the same harness, so success and failure
coverage exercise the same extension injection and coordination path.

### Promptfoo Prompt Evaluation

merge-god includes a Promptfoo harness for prompt regression checks and
optimization experiments:

```bash
# Deterministic render-contract checks for PR, issue, and review prompts
npm run prompt:eval

# Open the local Promptfoo UI for stored eval runs
npm run prompt:view

# Optimize the prompt overlay against a real upstream provider
MERGE_GOD_PROMPTFOO_PROVIDER=openai:gpt-5-mini npm run prompt:optimize
```

Promptfoo state is stored under `.promptfoo/` so runs do not depend on a
user-level Promptfoo database. The render-contract config is
`evals/promptfoo/promptfooconfig.yaml` and runs without model API keys. The
optimization config is `evals/promptfoo/pr-agent-optimization.yaml`; it composes
the current merge-god PR prompt with `evals/promptfoo/prompts/pr-agent-overlay.md`
and sends that composed prompt to the configured upstream provider.

Use the deterministic config to catch missing prompt sections or broken fixture
normalization. Use the optimization config when changing the overlay instructions
or comparing model behavior across recorded PR scenarios.

### Phase 1: Database Preparation

Cache PR context to database for offline testing:

```bash
# Initialize database (first time only)
npx tsx init_database.ts
npx tsx update_db_from_config.ts

# Sync specific PR
npx tsx merge-god.ts scan \
    --repo "prism merge" \
    --pr 134 \
    --db merge-god-state.db

# Verify cached data
sqlite3 merge-god-state.db "
SELECT
    pr_number, title,
    LENGTH(diff) as diff_bytes,
    json_array_length(comments) as comment_count,
    json_array_length(review_comments) as review_count,
    json_array_length(files) as file_count
FROM pr_context
WHERE repo_name = 'prism merge' AND pr_number = 134;
"
```

### Phase 2: Agent Invocation

Run agent from cached database (no API calls to GitHub):

```bash
# Basic mode test
npx tsx merge-god.ts agent \
    --repo "prism merge" \
    --pr 134 \
    --mode for-landing \
    --db merge-god-state.db \
    --repo-path /path/to/repository

# Comprehensive mode test
npx tsx merge-god.ts agent \
    --repo "prism merge" \
    --pr 134 \
    --mode for-review \
    --db merge-god-state.db \
    --repo-path /path/to/repository
```

**What happens:**

1. Loads PR context from database
2. Creates PRContext object with all details
3. Builds the merge-god work item and prompt
4. Starts a local coordination API and launches pi with the merge-god extension
5. Agent processes tasks in an isolated worktree
6. All actions logged to database
7. Returns success/failure status

### Phase 3: Result Capture

Agent automatically captures detailed metrics:

**Session-level metrics:**

- Start/end timestamps
- Overall status (running, completed, failed, aborted)
- Task counts (total, completed, failed)
- Token usage (input, output, total)
- Estimated cost (based on Sonnet 4.5 pricing)
- Duration in seconds
- API call count

**Action-level tracking:**

- Action number and type
- Target (file path, command, etc.)
- Status and success flag
- Error messages if failed
- Duration in milliseconds
- Full details and results

**Turn-level tracking:**

- Turn number (conversation position)
- Role (user or assistant)
- Content type (text, tool_use, tool_result)
- Tool use count
- Token usage per turn

**File operation tracking:**

- Operation type (read, write, edit)
- File path
- Lines added/removed
- Success/failure
- Associated action

### Phase 4: Result Evaluation

Comprehensive evaluation of agent performance:

```bash
# Evaluate latest session
npx tsx evaluate_agent_results.ts \
    --repo "prism merge" \
    --pr 134 \
    --latest

# Evaluate specific session
npx tsx evaluate_agent_results.ts \
    --repo "prism merge" \
    --pr 134 \
    --session abc123-def456-789

# Compare multiple sessions
npx tsx evaluate_agent_results.ts \
    --repo "prism merge" \
    --pr 134 \
    --compare
```

## Evaluation Criteria

### 1. Success Metrics

**Primary indicators:**

- ✅ Session completed successfully
- ✅ All tasks completed (tasks_failed = 0)
- ✅ No critical errors
- ✅ Changes pushed to PR branch

**Query:**

```sql
SELECT
    session_id, mode, status, success,
    tasks_total, tasks_completed, tasks_failed,
    ROUND(100.0 * tasks_completed / tasks_total, 1) as completion_rate
FROM agent_sessions
WHERE repo_name = ? AND pr_number = ?
ORDER BY started_at DESC;
```

### 2. Quality Metrics

**Code quality indicators:**

- Lines of code changed (measure of impact)
- Number of files modified
- Commits created
- Tests passing after changes
- No new linting errors

**Query:**

```sql
SELECT
    operation_type,
    COUNT(*) as operations,
    SUM(lines_added) as total_added,
    SUM(lines_removed) as total_removed
FROM agent_file_operations
WHERE session_id = ?
GROUP BY operation_type;
```

### 3. Performance Metrics

**Efficiency indicators:**

- Duration (should be < 10 minutes for landing, < 20 for review)
- Token usage (input + output)
- API calls (fewer is better)
- Cost per PR (track budget)

**Query:**

```sql
SELECT
    mode,
    AVG(duration_seconds) as avg_duration_sec,
    AVG(input_tokens) as avg_input_tokens,
    AVG(output_tokens) as avg_output_tokens,
    AVG(estimated_cost) as avg_cost_usd,
    AVG(api_calls) as avg_api_calls
FROM agent_sessions
WHERE success = 1
GROUP BY mode;
```

### 4. Error Analysis

**Error patterns:**

- Transient vs permanent errors
- Error types and frequency
- Retry success rate
- Common failure points

**Query:**

```sql
SELECT
    error_type,
    COUNT(*) as occurrences,
    SUM(is_transient) as transient_count,
    AVG(retry_count) as avg_retries
FROM agent_errors
WHERE session_id = ?
GROUP BY error_type
ORDER BY occurrences DESC;
```

## Test Scenarios

### Scenario 1: Merge Conflict Resolution

**Setup:**

```bash
# Create PR with conflicts
cd /path/to/test-repo
git checkout -b test/merge-conflict
echo "conflicting change" >> file.txt
git commit -am "Create conflict"
git push origin test/merge-conflict
gh pr create --title "Test: Merge conflict" --body "Testing conflict resolution"

# Update main to create conflict
git checkout main
echo "different change" >> file.txt
git commit -am "Conflicting change on main"
git push origin main
```

**Test:**

```bash
# Cache PR context
npx tsx merge-god.ts scan --repo test-repo --pr <PR_NUMBER>

# Run agent
npx tsx merge-god.ts agent \
    --repo test-repo \
    --pr <PR_NUMBER> \
    --mode for-landing
```

**Expected outcome:**

- Agent detects conflict
- Agent resolves conflict appropriately
- Agent commits resolution
- Agent pushes to PR branch
- CI checks pass

**Validation:**

```bash
# Check for conflict resolution commits
git log --oneline origin/test/merge-conflict | grep -i "conflict\|merge"

# Verify no conflict markers remain
git grep -E '<<<<<<|>>>>>>|======' || echo "No conflicts found"
```

### Scenario 2: CI Failure Fix

**Setup:**

```bash
# Create PR with failing test
cd /path/to/test-repo
git checkout -b test/failing-ci
echo "export function brokenFunction() { return 1 / 0; }" >> src/app.ts
git commit -am "Add broken function"
git push origin test/failing-ci
gh pr create --title "Test: CI failure" --body "Testing CI fix"
```

**Test:**

```bash
npx tsx merge-god.ts scan --repo test-repo --pr <PR_NUMBER>
npx tsx merge-god.ts agent --repo test-repo --pr <PR_NUMBER>
```

**Expected outcome:**

- Agent identifies failing check
- Agent reads test output
- Agent fixes the issue
- Agent runs tests locally
- Agent pushes fix
- CI passes

### Scenario 3: Code Review Response

**Setup:**

```bash
# Create PR and add review comments
gh pr create --title "Test: Review response" --body "Testing review handling"
gh pr review <PR_NUMBER> --comment --body "Please add type hints"
gh pr review <PR_NUMBER> --request-changes --body "Missing error handling"
```

**Test:**

```bash
npx tsx merge-god.ts scan --repo test-repo --pr <PR_NUMBER>
npx tsx merge-god.ts agent --repo test-repo --pr <PR_NUMBER>
```

**Expected outcome:**

- Agent reads all review comments
- Agent addresses each comment
- Agent makes appropriate changes
- Agent commits with descriptive messages

### Scenario 4: Comprehensive Review

**Setup:**

```bash
# Create PR with code quality issues
git checkout -b test/code-review
cat > src/messy.ts << 'EOF'
export function process(data: number[]): number[] {
  const result = [];
  for (const item of data) {
    if (item > 0) {
      result.push(item * 2);
    }
  }
  return result;
}
EOF
git add src/messy.ts
git commit -m "Add messy code"
git push origin test/code-review
gh pr create --title "Test: Code review" --label for-review
```

**Test:**

```bash
npx tsx merge-god.ts agent \
    --repo test-repo \
    --pr <PR_NUMBER> \
    --mode for-review
```

**Expected outcome:**

- Agent performs basic processing first
- Agent fetches updated diff
- Agent reviews code systematically
- Agent suggests improvements:
  - Type hints
  - Better naming
  - Error handling
  - Documentation
  - Tests if missing
- Agent makes targeted improvements

## Advanced Testing

### Parallel Mode Testing

Test both modes on the same PR to compare:

```bash
# Test script: test_both_modes.sh
#!/bin/bash
REPO="test-repo"
PR=123

# Sync once
npx tsx merge-god.ts scan --repo "$REPO" --pr $PR

# Test landing mode
echo "Testing for-landing mode..."
npx tsx merge-god.ts agent \
    --repo "$REPO" --pr $PR --mode for-landing \
    2>&1 | tee landing_run.log

LANDING_SESSION=$(sqlite3 merge-god-state.db \
    "SELECT session_id FROM agent_sessions \
     WHERE repo_name='$REPO' AND pr_number=$PR \
     ORDER BY started_at DESC LIMIT 1")

# Test review mode
echo "Testing for-review mode..."
npx tsx merge-god.ts agent \
    --repo "$REPO" --pr $PR --mode for-review \
    2>&1 | tee review_run.log

REVIEW_SESSION=$(sqlite3 merge-god-state.db \
    "SELECT session_id FROM agent_sessions \
     WHERE repo_name='$REPO' AND pr_number=$PR \
     ORDER BY started_at DESC LIMIT 1")

# Compare results
echo "Comparison:"
sqlite3 merge-god-state.db "
SELECT
    mode,
    tasks_completed, tasks_failed,
    input_tokens, output_tokens,
    duration_seconds, estimated_cost
FROM agent_sessions
WHERE session_id IN ('$LANDING_SESSION', '$REVIEW_SESSION');
"
```

### Stress Testing

Test with large/complex PRs:

```bash
# Find large PRs in database
sqlite3 merge-god-state.db "
SELECT
    repo_name, pr_number,
    LENGTH(diff) / 1024.0 as diff_kb,
    json_array_length(files) as file_count
FROM pr_context
WHERE LENGTH(diff) > 100000
ORDER BY LENGTH(diff) DESC
LIMIT 10;
"

# Test each one
for PR in $(sqlite3 merge-god-state.db "SELECT pr_number FROM pr_context WHERE repo_name='test-repo' AND LENGTH(diff) > 100000"); do
    echo "Testing large PR #$PR"
    npx tsx merge-god.ts agent --repo test-repo --pr $PR
done
```

### Regression Testing

Track agent behavior over time:

```bash
# Capture baseline
npx tsx merge-god.ts agent --repo test-repo --pr 100
BASELINE_SESSION=$(sqlite3 merge-god-state.db \
    "SELECT session_id FROM agent_sessions \
     ORDER BY started_at DESC LIMIT 1")

# After changes, re-run
npx tsx merge-god.ts agent --repo test-repo --pr 100
NEW_SESSION=$(sqlite3 merge-god-state.db \
    "SELECT session_id FROM agent_sessions \
     ORDER BY started_at DESC LIMIT 1")

# Compare
sqlite3 merge-god-state.db "
SELECT
    'Baseline' as version,
    tasks_completed, input_tokens, duration_seconds
FROM agent_sessions WHERE session_id = '$BASELINE_SESSION'
UNION ALL
SELECT
    'New' as version,
    tasks_completed, input_tokens, duration_seconds
FROM agent_sessions WHERE session_id = '$NEW_SESSION';
"
```

## Debugging Agent Behavior

### Enable Verbose Logging

```bash
# Set debug environment
export ANTHROPIC_LOG=debug
export DEBUG=1
export VERBOSE=1

# Run with full logging
npx tsx merge-god.ts agent \
    --repo test-repo \
    --pr 123 \
    2>&1 | tee agent_debug.log
```

### Inspect Prompt and Response

```bash
# Get session conversation
sqlite3 merge-god-state.db "
SELECT turn_number, role, content_type, tool_uses, input_tokens, output_tokens
FROM agent_turns
WHERE session_id = '<session-id>'
ORDER BY turn_number;
"

# For detailed inspection, use tsx (read a script from stdin)
npx tsx - <<'EOF'
import { AppStore } from "./app_store.ts";
const db = new AppStore("merge-god-state.db");
const session = db.getSessionDetails("<session-id>");

// Print turns
const turns = (session?.turns ?? []) as Array<Record<string, number | string>>;
for (const turn of turns) {
  console.log(`\nTurn ${turn.turn_number} (${turn.role}):`);
  console.log(`  Type: ${turn.content_type}`);
  console.log(`  Tools: ${turn.tool_uses}`);
  console.log(`  Tokens: ${turn.input_tokens} in, ${turn.output_tokens} out`);
}
EOF
```

### Analyze Action Patterns

```bash
# See what actions the agent takes
sqlite3 merge-god-state.db "
SELECT
    action_type,
    COUNT(*) as count,
    SUM(success) as successful,
    AVG(duration_ms) as avg_duration_ms
FROM agent_actions
WHERE session_id = '<session-id>'
GROUP BY action_type
ORDER BY count DESC;
"
```

## Performance Optimization

### Token Optimization

Monitor token usage to optimize costs:

```bash
# Analyze token usage by mode
sqlite3 merge-god-state.db "
SELECT
    mode,
    AVG(input_tokens) as avg_input,
    AVG(output_tokens) as avg_output,
    AVG(total_tokens) as avg_total,
    ROUND(AVG(estimated_cost), 4) as avg_cost_usd
FROM agent_sessions
WHERE success = 1
GROUP BY mode;
"

# Identify high-token sessions
sqlite3 merge-god-state.db "
SELECT
    repo_name, pr_number, mode,
    total_tokens, estimated_cost,
    datetime(started_at) as started
FROM agent_sessions
WHERE total_tokens > 50000
ORDER BY total_tokens DESC
LIMIT 10;
"
```

### Duration Optimization

Track processing time:

```bash
# Identify slow sessions
sqlite3 merge-god-state.db "
SELECT
    repo_name, pr_number, mode,
    ROUND(duration_seconds / 60.0, 2) as duration_min,
    tasks_total, tasks_completed
FROM agent_sessions
WHERE duration_seconds > 300
ORDER BY duration_seconds DESC
LIMIT 10;
"
```

## Best Practices

1. **Always cache first**: Run scan before agent to ensure fresh data
2. **Use database paths**: Specify `--db` explicitly for clarity
3. **Test both modes**: Compare landing vs review for same PR
4. **Check session status**: Always verify success before merging
5. **Monitor costs**: Track token usage and estimated costs
6. **Review actions**: Inspect what the agent actually did
7. **Validate output**: Check git history and CI status
8. **Capture logs**: Save output for debugging
9. **Use dry-run when available**: Test without pushing changes
10. **Compare sessions**: Track improvements over time

## Troubleshooting

### Agent Fails to Load PR Context

```bash
# Check if PR is cached
sqlite3 merge-god-state.db "
SELECT * FROM pr_context
WHERE repo_name = 'test-repo' AND pr_number = 123;
"

# Re-sync if missing
npx tsx merge-god.ts scan --repo test-repo --pr 123
```

### Agent Makes No Progress

```bash
# Check session status
sqlite3 merge-god-state.db "
SELECT session_id, status, started_at, completed_at
FROM agent_sessions
WHERE repo_name = 'test-repo' AND pr_number = 123
ORDER BY started_at DESC LIMIT 1;
"

# Check for errors
sqlite3 merge-god-state.db "
SELECT error_type, error_message, occurred_at
FROM agent_errors
WHERE session_id = '<session-id>'
ORDER BY occurred_at;
"
```

### High Token Usage

```bash
# Identify what's using tokens
sqlite3 merge-god-state.db "
SELECT turn_number, role, content_type, input_tokens, output_tokens
FROM agent_turns
WHERE session_id = '<session-id>'
ORDER BY (input_tokens + output_tokens) DESC
LIMIT 10;
"

# Consider:
# - Reducing diff size (focus on changed files)
# - Limiting comment history
# - Using for-landing instead of for-review
```

## Related Documentation

- [testing.md](./testing.md) - The node:test suite and unit/integration testing
- [README.md](../README.md) - Project overview
- [PRD.md](../PRD.md) - Product requirements
- [development.md](./development.md) - Development setup
