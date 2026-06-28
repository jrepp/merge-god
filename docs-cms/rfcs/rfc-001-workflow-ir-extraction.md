---
title: Merge God WorkflowIR Extraction
status: Draft
author: Engineering Team
created: 2026-06-28T06:48:37Z
tags: [design, merge-god, rfc, workflow-ir]
id: rfc-001
project_id: merge-god
doc_uuid: cbc9081d-d90b-4879-9d27-15eec6b8f115
---

# Summary

This document captures the Merge God rich PR-processing design as portable WorkflowIR. It is expressed as orchestration intent rather than TypeScript implementation details, so the same flow can be reimplemented in another harness.

Source project: `merge-god-main`

Target runtime: WorkflowIR-compatible orchestrators

Source material:

- `pr-loop.ts`
- `agents/claude_agent.ts`
- `sync_pr_context.ts`
- `run_agent_from_db.ts`
- `merge_god/sync.ts`
- `merge_god/run_agent.ts`
- `packages/github-sync/src/`

Related documents:

- [RFC-002: Workflow Helper Tool Surface](./rfc-002-workflow-helper-tool-surface.md): external helper/tool surface required by the workflow.
- [RFC-003: Prompt Fragment Contracts](./rfc-003-prompt-fragment-contracts.md): prompt contracts and context fragments used by agentic nodes.

# Detailed Design

## Design-Level Semantics

The extracted workflow has three reusable layers:

| Layer | WorkflowIR role | Merge God behavior |
|---|---|---|
| Repository monitor loop | long-running cyclic workflow | Validate repo, initialize state, sync default branch, process eligible issues, process eligible PRs, wait five minutes, repeat |
| PR processing subworkflow | per-PR workflow | Validate PR metadata, optionally ask for human approval, gather rich context, optionally persist context, initialize agent, run decomposed agent tasks |
| PR merge gate subworkflow | per-PR merge workflow | Validate retained scope in an isolated worktree, enforce remediation disposition, compare against base branch, publish evidence, and approve or merge only after gates pass |
| Agent task loop | agentic subworkflow | Build task-specific prompt, expose task-specific tools, stream LLM response, execute tool calls, feed tool results back, stop when no tools are requested or iteration limit is reached |

The full design is not a `basic-dag` workflow because it contains intentional
cycles, collection iteration, timers, conditional branches, and agentic tool
loops. A projection MUST preserve the required profiles below or reject the
workflow.

## Repository Monitor WorkflowIR

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.repository-monitor
  version: v1
  title: Merge God repository monitor
  description: Continuously process labeled GitHub issues and pull requests for one local repository.
  tags: [merge-god, github, pull-request, agentic, rich-prompt]
  profile: agentic-workflow
  safety:
    tier: T2
    notes:
      - Mutates local git worktree and may push commits or create pull requests through delegated agent/tool execution.

capabilities:
  required_profiles: [gateways, events-timers, subworkflows, error-handling, typed-dataflow, agentic]
  required_extensions:
    - name: metro/collection-iteration
      version: v1
      reason: The workflow iterates over dynamic issue and PR collections discovered at runtime.
      schema_ref: schema://metro/extensions/collection-iteration/v1

inputs:
  - name: repo_path
    description: Local git repository path to monitor.
    required: true
    value_type:
      kind: string
  - name: watch_issues
    description: Whether to process open issues labeled for implementation before processing PRs.
    default: false
    value_type:
      kind: boolean
  - name: interactive
    description: Whether to request human confirmation before mutating issue or PR work.
    default: false
    value_type:
      kind: boolean
  - name: poll_interval
    description: Delay between full monitor cycles.
    default: 300s
    value_type:
      kind: duration
  - name: sync_failure_delay
    description: Delay after repository sync failure before retrying the monitor loop.
    default: 60s
    value_type:
      kind: duration

resources:
  systems:
    - id: github-cli
      kind: cli
      description: GitHub CLI used to list issues/PRs and fetch PR context.
    - id: git-cli
      kind: cli
      description: Git CLI used for repository sync and branch operations.
    - id: sqlite-state
      kind: database
      description: Optional SQLite state store for context snapshots and agent telemetry.
    - id: llm-provider
      kind: llm
      description: Claude/Bedrock-compatible model endpoint for PR task execution.
    - id: notifier
      kind: notification
      description: Optional notification sink for processing start, success, and failure events.
  secret_requirements:
    - id: github-auth
      kind: credential
      scope: github-cli
      required_by: [validate_repository, discover_issues, discover_prs, gather_pr_context]
      injection: runtime_broker
    - id: llm-auth
      kind: api-token
      scope: llm-provider
      required_by: [process_pr]
      injection: env
  locks:
    - id: repo-worktree-lock
      scope: input.repo_path
      required_by: [sync_repository, process_issue, process_pr]
      mode: exclusive

graph:
  nodes:
    - id: validate_repository
      kind: action
      label: Validate local repository and GitHub CLI authentication
      action:
        ref: merge-god.repo.validate
        mode: deterministic
        tool_ref: tool://merge-god/repo.validate@v1
      timeout:
        duration: 60s
        on_timeout: fail

    - id: initialize_state
      kind: action
      label: Initialize optional SQLite state and repository identity
      action:
        ref: merge-god.state.initialize
        mode: deterministic
        tool_ref: tool://merge-god/state.initialize@v1
      on_error:
        strategy: continue
        error_types: [state_unavailable]

    - id: detect_default_branch
      kind: action
      label: Detect default branch
      action:
        ref: merge-god.git.detect-default-branch
        mode: deterministic
        tool_ref: tool://merge-god/git.detect-default-branch@v1

    - id: load_repository_guidance
      kind: action
      label: Load contribution guidelines or commit examples
      action:
        ref: merge-god.repo.load-guidance
        mode: deterministic
        tool_ref: tool://merge-god/repo.load-guidance@v1

    - id: iteration_start
      kind: action
      label: Start monitor iteration
      action:
        ref: merge-god.telemetry.iteration-start
        mode: deterministic

    - id: sync_repository
      kind: action
      label: Fetch remotes, checkout default branch, and pull latest
      action:
        ref: merge-god.git.sync-repository
        mode: deterministic
        tool_ref: tool://merge-god/git.sync-repository@v1
      timeout:
        duration: 5m
        on_timeout: route
        target_node: wait_after_sync_failure
      on_error:
        strategy: route
        target_node: wait_after_sync_failure

    - id: maybe_process_issues
      kind: gateway
      label: Should issues be processed before PRs?
      gateway:
        kind: exclusive
      default_edge: edge.maybe_process_issues.discover_prs

    - id: discover_issues
      kind: action
      label: List open issues labeled for implementation
      action:
        ref: merge-god.github.list-issues
        mode: deterministic
        tool_ref: tool://merge-god/github.list-issues@v1
      metadata:
        label_filter: for-impl
        limit: 100

    - id: iterate_issues
      kind: subworkflow
      label: Process each eligible implementation issue
      workflow_ref:
        id: wf.merge-god.process-issue
        version: v1
      invocation: sync
      error_propagation: isolate
      input_mapping:
        - input: issue
          from: capture.open_issues[*]
        - input: default_branch
          from: capture.default_branch
        - input: guidelines
          from: capture.repository_guidance
        - input: commit_examples
          from: capture.commit_examples
        - input: interactive
          from: input.interactive
      metadata:
        extension: metro/collection-iteration
        foreach: capture.open_issues
        duplicate_key: issue.number
        inter_item_delay: 10s

    - id: discover_prs
      kind: action
      label: List and categorize open PRs by processing labels
      action:
        ref: merge-god.github.list-prs-by-mode
        mode: deterministic
        tool_ref: tool://merge-god/github.list-prs-by-mode@v1
      metadata:
        labels:
          for_review: for-review
          for_landing: for-landing
          skipped_wip_contains: [wip, work-in-process, work in process]
          skipped_draft: true
        limit: 100

    - id: has_processable_prs
      kind: gateway
      label: Are there labeled PRs to process?
      gateway:
        kind: exclusive
      default_edge: edge.has_processable_prs.wait_no_work

    - id: process_for_review_prs
      kind: subworkflow
      label: Process for-review PRs first
      workflow_ref:
        id: wf.merge-god.process-pr
        version: v1
      invocation: sync
      error_propagation: isolate
      input_mapping:
        - input: pr
          from: capture.for_review_prs[*]
        - input: mode
          from: literal:for-review
        - input: default_branch
          from: capture.default_branch
        - input: guidelines
          from: capture.repository_guidance
        - input: commit_examples
          from: capture.commit_examples
        - input: interactive
          from: input.interactive
        - input: repo_name
          from: capture.repo_name
      metadata:
        extension: metro/collection-iteration
        foreach: capture.for_review_prs
        duplicate_key: pr.number
        inter_item_delay: 10s

    - id: process_for_landing_prs
      kind: subworkflow
      label: Process for-landing PRs after review PRs
      workflow_ref:
        id: wf.merge-god.process-pr
        version: v1
      invocation: sync
      error_propagation: isolate
      input_mapping:
        - input: pr
          from: capture.for_landing_prs[*]
        - input: mode
          from: literal:for-landing
        - input: default_branch
          from: capture.default_branch
        - input: guidelines
          from: capture.repository_guidance
        - input: commit_examples
          from: capture.commit_examples
        - input: interactive
          from: input.interactive
        - input: repo_name
          from: capture.repo_name
      metadata:
        extension: metro/collection-iteration
        foreach: capture.for_landing_prs
        duplicate_key: pr.number
        inter_item_delay: 10s

    - id: iteration_complete
      kind: action
      label: Emit iteration summary
      action:
        ref: merge-god.telemetry.iteration-complete
        mode: deterministic

    - id: wait_cycle
      kind: wait
      label: Wait before next monitor cycle
      wait:
        kind: duration
        duration: input.poll_interval

    - id: wait_no_work
      kind: wait
      label: Wait when no labeled PRs are processable
      wait:
        kind: duration
        duration: input.poll_interval

    - id: wait_after_sync_failure
      kind: wait
      label: Wait briefly after sync failure
      wait:
        kind: duration
        duration: input.sync_failure_delay

  edges:
    - id: edge.validate_repository.initialize_state
      from: validate_repository
      to: initialize_state
      kind: control
    - id: edge.initialize_state.detect_default_branch
      from: initialize_state
      to: detect_default_branch
      kind: control
      on_status: [succeeded, failed]
    - id: edge.detect_default_branch.load_repository_guidance
      from: detect_default_branch
      to: load_repository_guidance
      kind: control
    - id: edge.load_repository_guidance.iteration_start
      from: load_repository_guidance
      to: iteration_start
      kind: control
    - id: edge.iteration_start.sync_repository
      from: iteration_start
      to: sync_repository
      kind: control
    - id: edge.sync_repository.maybe_process_issues
      from: sync_repository
      to: maybe_process_issues
      kind: control
    - id: edge.maybe_process_issues.discover_issues
      from: maybe_process_issues
      to: discover_issues
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.watch_issues == true
    - id: edge.maybe_process_issues.discover_prs
      from: maybe_process_issues
      to: discover_prs
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.watch_issues == false
    - id: edge.discover_issues.iterate_issues
      from: discover_issues
      to: iterate_issues
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.open_issue_count > 0
    - id: edge.discover_issues.discover_prs
      from: discover_issues
      to: discover_prs
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.open_issue_count == 0
    - id: edge.iterate_issues.discover_prs
      from: iterate_issues
      to: discover_prs
      kind: control
      on_status: [succeeded, failed]
    - id: edge.discover_prs.has_processable_prs
      from: discover_prs
      to: has_processable_prs
      kind: control
    - id: edge.has_processable_prs.process_for_review_prs
      from: has_processable_prs
      to: process_for_review_prs
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.for_review_count > 0
    - id: edge.process_for_review_prs.process_for_landing_prs
      from: process_for_review_prs
      to: process_for_landing_prs
      kind: control
      on_status: [succeeded, failed]
    - id: edge.has_processable_prs.process_for_landing_prs
      from: has_processable_prs
      to: process_for_landing_prs
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.for_review_count == 0 and captures.for_landing_count > 0
    - id: edge.has_processable_prs.wait_no_work
      from: has_processable_prs
      to: wait_no_work
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.for_review_count == 0 and captures.for_landing_count == 0
    - id: edge.process_for_landing_prs.iteration_complete
      from: process_for_landing_prs
      to: iteration_complete
      kind: control
      on_status: [succeeded, failed]
    - id: edge.iteration_complete.wait_cycle
      from: iteration_complete
      to: wait_cycle
      kind: control
    - id: edge.wait_cycle.iteration_start
      from: wait_cycle
      to: iteration_start
      kind: control
      metadata:
        loop: monitor_cycle
    - id: edge.wait_no_work.iteration_start
      from: wait_no_work
      to: iteration_start
      kind: control
      metadata:
        loop: monitor_cycle
    - id: edge.wait_after_sync_failure.iteration_start
      from: wait_after_sync_failure
      to: iteration_start
      kind: control
      metadata:
        loop: sync_retry

dataflow:
  captures:
    - id: capture.default_branch
      from_node: detect_default_branch
      name: default_branch
      value_type:
        kind: string
    - id: capture.repository_guidance
      from_node: load_repository_guidance
      name: guidelines
      value_type:
        kind: string
    - id: capture.commit_examples
      from_node: load_repository_guidance
      name: commit_examples
      value_type:
        kind: string
    - id: capture.open_issues
      from_node: discover_issues
      name: issues
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/github.issue-summary/v1
    - id: capture.open_issue_count
      from_node: discover_issues
      name: issue_count
      value_type:
        kind: integer
    - id: capture.for_review_prs
      from_node: discover_prs
      name: for_review
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/github.pr-summary/v1
    - id: capture.for_review_count
      from_node: discover_prs
      name: for_review_count
      value_type:
        kind: integer
    - id: capture.for_landing_prs
      from_node: discover_prs
      name: for_landing
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/github.pr-summary/v1
    - id: capture.for_landing_count
      from_node: discover_prs
      name: for_landing_count
      value_type:
        kind: integer
    - id: capture.repo_name
      from_node: initialize_state
      name: repo_name
      value_type:
        kind: string

artifacts:
  outputs:
    - id: iteration-log
      kind: log
      producer_node: iteration_complete
      audience: operator
    - id: sqlite-state-db
      kind: database
      producer_node: initialize_state
      path_hint: merge-god-state.db
      audience: evaluator
```

### PR Processing SubworkflowIR

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.process-pr
  version: v1
  title: Merge God process PR
  description: Gather rich PR context, decompose work into agent tasks, and execute task-specific agentic loops.
  tags: [merge-god, pull-request, rich-prompt, agentic]
  safety:
    tier: T2

capabilities:
  required_profiles: [gateways, human-gates, subworkflows, error-handling, typed-dataflow, agentic]
  required_extensions:
    - name: metro/collection-iteration
      version: v1
      reason: The agent task list is dynamic and depends on PR state.
      schema_ref: schema://metro/extensions/collection-iteration/v1

inputs:
  - name: pr
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/github.pr-summary/v1
  - name: mode
    required: true
    value_type:
      kind: string
      constraints:
        enum: [for-review, for-landing]
  - name: default_branch
    required: true
    value_type:
      kind: string
  - name: guidelines
    value_type:
      kind: string
  - name: commit_examples
    value_type:
      kind: string
  - name: interactive
    default: false
    value_type:
      kind: boolean
  - name: repo_name
    value_type:
      kind: string
  - name: disposition_setting
    description: Maximum remediation autonomy allowed for this PR.
    default: bounded
    value_type:
      kind: string
      constraints:
        enum: [observe, validate, mechanical, bounded, maintainer-approved]

gates:
  definitions:
    - id: gate.merge-god.confirm-pr-processing
      decision_type: human-confirmation
      label: Confirm PR processing
      options:
        - id: approve
          label: Process PR
        - id: decline
          label: Skip PR
      default_option: decline
      timeout:
        duration: 5m
      on_timeout: decline

graph:
  nodes:
    - id: validate_pr_input
      kind: action
      label: Validate PR number, URL, and safe branch refs
      action:
        ref: merge-god.pr.validate-input
        mode: deterministic
        tool_ref: tool://merge-god/pr.validate-input@v1

    - id: maybe_confirm_pr
      kind: gateway
      label: Is interactive approval required?
      gateway:
        kind: exclusive
      default_edge: edge.maybe_confirm_pr.gather_pr_context

    - id: confirm_pr_processing
      kind: gate
      label: Request operator approval before processing PR
      gate_ref: gate.merge-god.confirm-pr-processing

    - id: notify_pr_started
      kind: action
      label: Notify PR processing started
      action:
        ref: merge-god.notify.pr-started
        mode: external
        tool_ref: tool://merge-god/notify@v1
      on_error:
        strategy: continue

    - id: gather_pr_context
      kind: action
      label: Gather full PR metadata, comments, commits, files, conflicts, CI state, and diff
      action:
        ref: merge-god.github.gather-pr-context
        mode: deterministic
        tool_ref: tool://merge-god/github.gather-pr-context@v1
      timeout:
        duration: 5m
        on_timeout: fail

    - id: save_context_optional
      kind: action
      label: Persist PR context snapshot when SQLite state is available
      action:
        ref: merge-god.state.save-pr-context
        mode: deterministic
        tool_ref: tool://merge-god/state.save-pr-context@v1
      on_error:
        strategy: continue
        error_types: [state_unavailable, state_write_failed]

    - id: build_pr_context
      kind: action
      label: Convert gathered dictionaries into structured PRContext
      action:
        ref: merge-god.context.build-pr-context
        mode: deterministic
        tool_ref: tool://merge-god/context.build-pr-context@v1

    - id: initialize_agent
      kind: action
      label: Initialize LLM client and model
      action:
        ref: merge-god.agent.initialize
        mode: deterministic
        tool_ref: tool://merge-god/agent.initialize@v1

    - id: decompose_pr_tasks
      kind: action
      label: Build ordered task list from PR context and processing mode
      action:
        ref: merge-god.agent.decompose-pr-tasks
        mode: deterministic
        tool_ref: tool://merge-god/agent.decompose-pr-tasks@v1
      metadata:
        task_rules:
          - id: analyze
            when: always
          - id: resolve_conflicts
            when: pr_context.has_conflicts
          - id: address_reviews
            when: pr_context.review_comment_count > 0
          - id: fix_ci
            when: pr_context.has_failing_ci
          - id: code_review
            when: inputs.mode == 'for-review'
          - id: validate
            when: always

    - id: execute_agent_tasks
      kind: subworkflow
      label: Execute each decomposed PR task using the agent task loop
      workflow_ref:
        id: wf.merge-god.agent-task-loop
        version: v1
      invocation: sync
      error_propagation: isolate
      input_mapping:
        - input: task
          from: capture.agent_tasks[*]
        - input: pr_context
          from: capture.pr_context
        - input: agent_session
          from: capture.agent_session
      metadata:
        extension: metro/collection-iteration
        foreach: capture.agent_tasks
        iteration_order: declared
        stop_on_callback_abort: true

    - id: maybe_run_merge_gate
      kind: gateway
      label: Should this PR run the merge gate?
      gateway:
        kind: exclusive
      default_edge: edge.maybe_run_merge_gate.summarize_result

    - id: run_pr_merge_gate
      kind: subworkflow
      label: Run isolated PR merge gate before landing
      workflow_ref:
        id: wf.merge-god.pr-merge-gate
        version: v1
      invocation: sync
      error_propagation: isolate
      input_mapping:
        - input: pr
          from: input.pr
        - input: pr_context
          from: capture.pr_context
        - input: default_branch
          from: input.default_branch
        - input: repo_name
          from: input.repo_name
        - input: disposition_setting
          from: input.disposition_setting
        - input: guidelines
          from: input.guidelines

    - id: summarize_result
      kind: action
      label: Summarize task completion, gate result, and action counts
      action:
        ref: merge-god.agent.summarize-result
        mode: deterministic

    - id: notify_pr_complete
      kind: action
      label: Notify success or failure
      action:
        ref: merge-god.notify.pr-complete
        mode: external
        tool_ref: tool://merge-god/notify@v1
      on_error:
        strategy: continue

  edges:
    - id: edge.validate_pr_input.maybe_confirm_pr
      from: validate_pr_input
      to: maybe_confirm_pr
      kind: control
    - id: edge.maybe_confirm_pr.confirm_pr_processing
      from: maybe_confirm_pr
      to: confirm_pr_processing
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.interactive == true
    - id: edge.confirm_pr_processing.notify_pr_started
      from: confirm_pr_processing
      to: notify_pr_started
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.pr_processing_decision == 'approve'
    - id: edge.maybe_confirm_pr.gather_pr_context
      from: maybe_confirm_pr
      to: gather_pr_context
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.interactive == false
    - id: edge.notify_pr_started.gather_pr_context
      from: notify_pr_started
      to: gather_pr_context
      kind: control
      on_status: [succeeded, failed]
    - id: edge.gather_pr_context.save_context_optional
      from: gather_pr_context
      to: save_context_optional
      kind: control
    - id: edge.save_context_optional.build_pr_context
      from: save_context_optional
      to: build_pr_context
      kind: control
      on_status: [succeeded, failed]
    - id: edge.build_pr_context.initialize_agent
      from: build_pr_context
      to: initialize_agent
      kind: control
    - id: edge.initialize_agent.decompose_pr_tasks
      from: initialize_agent
      to: decompose_pr_tasks
      kind: control
    - id: edge.decompose_pr_tasks.execute_agent_tasks
      from: decompose_pr_tasks
      to: execute_agent_tasks
      kind: control
    - id: edge.execute_agent_tasks.maybe_run_merge_gate
      from: execute_agent_tasks
      to: maybe_run_merge_gate
      kind: control
      on_status: [succeeded, failed]
    - id: edge.maybe_run_merge_gate.run_pr_merge_gate
      from: maybe_run_merge_gate
      to: run_pr_merge_gate
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: inputs.mode == 'for-landing' and inputs.disposition_setting != 'observe'
    - id: edge.maybe_run_merge_gate.summarize_result
      from: maybe_run_merge_gate
      to: summarize_result
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.mode != 'for-landing' or inputs.disposition_setting == 'observe'
    - id: edge.run_pr_merge_gate.summarize_result
      from: run_pr_merge_gate
      to: summarize_result
      kind: control
      on_status: [succeeded, failed]
    - id: edge.summarize_result.notify_pr_complete
      from: summarize_result
      to: notify_pr_complete
      kind: control

dataflow:
  captures:
    - id: capture.pr_details
      from_node: gather_pr_context
      name: pr_details
      value_type:
        kind: object
        schema_ref: schema://merge-god/github.pr-details/v1
    - id: capture.pr_processing_decision
      from_node: confirm_pr_processing
      name: decision
      value_type:
        kind: string
    - id: capture.pr_context_raw
      from_node: gather_pr_context
      name: pr_context_raw
      value_type:
        kind: object
        schema_ref: schema://merge-god/github.pr-context-raw/v1
    - id: capture.pr_context
      from_node: build_pr_context
      name: pr_context
      value_type:
        kind: object
        schema_ref: schema://merge-god/agent.pr-context/v1
    - id: capture.agent_session
      from_node: initialize_agent
      name: agent_session
      value_type:
        kind: object
        schema_ref: schema://merge-god/agent.session/v1
    - id: capture.agent_tasks
      from_node: decompose_pr_tasks
      name: tasks
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/agent.task/v1
    - id: capture.pr_merge_gate_result
      from_node: run_pr_merge_gate
      name: gate_result
      value_type:
        kind: object
        schema_ref: schema://merge-god/pr-merge.gate-result/v1
```

### PR Merge Gate SubworkflowIR

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.pr-merge-gate
  version: v1
  title: Merge God PR merge gate
  description: Validate a PR in an isolated worktree, enforce remediation disposition, compare failures against base, publish evidence, and approve or merge only after policy gates pass.
  tags: [merge-god, pull-request, merge-gate, validation, worktree]
  safety:
    tier: T2
    notes:
      - Mutates only an isolated PR worktree unless the final merge or push policy permits upstream changes.
      - The requested disposition setting caps remediation autonomy.

capabilities:
  required_profiles: [gateways, human-gates, subworkflows, error-handling, typed-dataflow]

inputs:
  - name: pr
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/github.pr-summary/v1
  - name: pr_context
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/agent.pr-context/v1
  - name: default_branch
    required: true
    value_type:
      kind: string
  - name: repo_name
    value_type:
      kind: string
  - name: disposition_setting
    required: true
    value_type:
      kind: string
      constraints:
        enum: [observe, validate, mechanical, bounded, maintainer-approved]
  - name: guidelines
    value_type:
      kind: string

gates:
  definitions:
    - id: gate.merge-god.pr-merge-conflict
      decision_type: pr-merge-conflict
      label: Resolve conflict or excessive drift decision
      options:
        - id: skip
          label: Skip PR
        - id: wait_for_author
          label: Wait for author rebase
        - id: proceed_for_evidence
          label: Proceed for evidence collection
        - id: maintainer_remediation
          label: Allow maintainer-approved remediation
      default_option: skip

resources:
  systems:
    - id: git-cli
      kind: cli
      description: Git CLI used to create, sync, and clean isolated worktrees.
    - id: github-cli
      kind: cli
      description: SCM CLI used to read PR state, publish comments, and merge or approve according to policy.
    - id: validation-runner
      kind: cli
      description: Repository-documented build, test, and lint commands.
  locks:
    - id: pr-worktree-lock
      scope: input.pr.number
      mode: exclusive
      required_by: [create_isolated_worktree, remediate_within_disposition, merge_or_approve, cleanup_worktree]
    - id: base-branch-validation-lock
      scope: input.default_branch
      mode: shared
      required_by: [compare_against_base]

graph:
  nodes:
    - id: initialize_queue_state
      kind: action
      label: Initialize PR queue state and evidence artifact paths
      action:
        ref: merge-god.pr-merge.initialize-queue-state
        mode: deterministic
        tool_ref: tool://merge-god/pr-merge.initialize-queue-state@v1

    - id: retained_scope_preflight
      kind: action
      label: Determine retained scope and classify no-op, superseded, or redesign work
      action:
        ref: merge-god.pr.retained-scope-preflight
        mode: deterministic
        tool_ref: tool://merge-god/pr.retained-scope-preflight@v1

    - id: terminal_preflight_gateway
      kind: gateway
      label: Did preflight find a terminal disposition?
      gateway:
        kind: exclusive
      default_edge: edge.terminal_preflight_gateway.create_isolated_worktree

    - id: create_isolated_worktree
      kind: action
      label: Create isolated PR worktree under run-scoped root
      action:
        ref: merge-god.git.create-isolated-worktree
        mode: deterministic
        tool_ref: tool://merge-god/git.create-isolated-worktree@v1

    - id: sync_with_base
      kind: action
      label: Fetch latest head and base, then reconcile drift
      action:
        ref: merge-god.git.sync-pr-worktree
        mode: deterministic
        tool_ref: tool://merge-god/git.sync-pr-worktree@v1
      on_error:
        strategy: route
        target_node: conflict_or_drift_gate

    - id: conflict_or_drift_gate
      kind: gate
      label: Request operator decision for conflicts or excessive drift
      gate_ref: gate.merge-god.pr-merge-conflict

    - id: run_build
      kind: action
      label: Run repository-documented build lane
      action:
        ref: merge-god.validation.run-lane
        mode: external
        tool_ref: tool://merge-god/validation.run-lane@v1
      metadata:
        lane: build

    - id: run_tests
      kind: action
      label: Run repository-documented test lane
      action:
        ref: merge-god.validation.run-lane
        mode: external
        tool_ref: tool://merge-god/validation.run-lane@v1
      metadata:
        lane: test

    - id: run_lint
      kind: action
      label: Run repository-documented lint or static-analysis lane
      action:
        ref: merge-god.validation.run-lane
        mode: external
        tool_ref: tool://merge-god/validation.run-lane@v1
      metadata:
        lane: lint

    - id: compare_against_base
      kind: action
      label: Compare validation failures against current base branch
      action:
        ref: merge-god.validation.compare-with-base
        mode: deterministic
        tool_ref: tool://merge-god/validation.compare-with-base@v1

    - id: review_diff
      kind: action
      label: Review diff for correctness, security, compatibility, tests, and cleanup
      action:
        ref: merge-god.pr.review-diff
        mode: deterministic
        tool_ref: tool://merge-god/pr.review-diff@v1

    - id: remediation_policy_gateway
      kind: gateway
      label: Does the disposition setting allow remediation?
      gateway:
        kind: exclusive
      default_edge: edge.remediation_policy_gateway.final_gate

    - id: remediate_within_disposition
      kind: action
      label: Apply remediation allowed by disposition setting
      action:
        ref: merge-god.pr.remediate-within-disposition
        mode: agentic
        tool_ref: tool://merge-god/pr.remediate-within-disposition@v1
      metadata:
        remediation_policy:
          observe: no mutation
          validate: no mutation
          mechanical: non-behavioral generated artifacts, formatting, lockfiles, metadata
          bounded: conflicts, review comments, and CI fixes that preserve retained scope
          maintainer-approved: scoped redesign only after human approval

    - id: rerun_affected_checks
      kind: action
      label: Re-run checks affected by remediation
      action:
        ref: merge-god.validation.rerun-affected
        mode: external
        tool_ref: tool://merge-god/validation.rerun-affected@v1

    - id: evaluate_pr_quality
      kind: action
      label: Evaluate PR title, body, labels, branch metadata, and merge policy
      action:
        ref: merge-god.pr.evaluate-quality
        mode: deterministic
        tool_ref: tool://merge-god/pr.evaluate-quality@v1

    - id: final_gate
      kind: action
      label: Produce final pass, blocked, failed, no-op, superseded, or needs-redesign decision
      action:
        ref: merge-god.pr.final-gate
        mode: deterministic
        tool_ref: tool://merge-god/pr.final-gate@v1

    - id: merge_decision_gateway
      kind: gateway
      label: Is the PR safe to merge or approve?
      gateway:
        kind: exclusive
      default_edge: edge.merge_decision_gateway.publish_pr_comment

    - id: merge_or_approve
      kind: action
      label: Merge or approve according to repository policy
      action:
        ref: merge-god.pr.merge-or-approve
        mode: external
        tool_ref: tool://merge-god/pr.merge-or-approve@v1

    - id: publish_pr_comment
      kind: action
      label: Publish PR workflow outcome comment with action log and evidence
      action:
        ref: merge-god.pr.publish-workflow-comment
        mode: external
        tool_ref: tool://merge-god/pr.publish-workflow-comment@v1
      on_error:
        strategy: continue

    - id: cleanup_worktree
      kind: action
      label: Clean up isolated worktree unless retained for diagnosis
      action:
        ref: merge-god.git.cleanup-worktree
        mode: deterministic
        tool_ref: tool://merge-god/git.cleanup-worktree@v1
      on_error:
        strategy: continue

  edges:
    - id: edge.initialize_queue_state.retained_scope_preflight
      from: initialize_queue_state
      to: retained_scope_preflight
      kind: control
    - id: edge.retained_scope_preflight.terminal_preflight_gateway
      from: retained_scope_preflight
      to: terminal_preflight_gateway
      kind: control
    - id: edge.terminal_preflight_gateway.final_gate
      from: terminal_preflight_gateway
      to: final_gate
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.preflight_disposition in ['no-op', 'superseded', 'needs-redesign', 'blocked']
    - id: edge.terminal_preflight_gateway.create_isolated_worktree
      from: terminal_preflight_gateway
      to: create_isolated_worktree
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.preflight_disposition == 'candidate'
    - id: edge.create_isolated_worktree.sync_with_base
      from: create_isolated_worktree
      to: sync_with_base
      kind: control
    - id: edge.sync_with_base.run_build
      from: sync_with_base
      to: run_build
      kind: control
    - id: edge.conflict_or_drift_gate.run_build
      from: conflict_or_drift_gate
      to: run_build
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.conflict_decision in ['proceed_for_evidence', 'maintainer_remediation']
    - id: edge.run_build.run_tests
      from: run_build
      to: run_tests
      kind: control
      on_status: [succeeded, failed]
    - id: edge.run_tests.run_lint
      from: run_tests
      to: run_lint
      kind: control
      on_status: [succeeded, failed]
    - id: edge.run_lint.compare_against_base
      from: run_lint
      to: compare_against_base
      kind: control
      on_status: [succeeded, failed]
    - id: edge.compare_against_base.review_diff
      from: compare_against_base
      to: review_diff
      kind: control
      on_status: [succeeded, failed]
    - id: edge.review_diff.remediation_policy_gateway
      from: review_diff
      to: remediation_policy_gateway
      kind: control
    - id: edge.remediation_policy_gateway.remediate_within_disposition
      from: remediation_policy_gateway
      to: remediate_within_disposition
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.remediation_needed == true and inputs.disposition_setting in ['mechanical', 'bounded', 'maintainer-approved']
    - id: edge.remediate_within_disposition.rerun_affected_checks
      from: remediate_within_disposition
      to: rerun_affected_checks
      kind: control
      on_status: [succeeded, failed]
    - id: edge.rerun_affected_checks.evaluate_pr_quality
      from: rerun_affected_checks
      to: evaluate_pr_quality
      kind: control
      on_status: [succeeded, failed]
    - id: edge.remediation_policy_gateway.evaluate_pr_quality
      from: remediation_policy_gateway
      to: evaluate_pr_quality
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.remediation_needed == false or inputs.disposition_setting in ['observe', 'validate']
    - id: edge.evaluate_pr_quality.final_gate
      from: evaluate_pr_quality
      to: final_gate
      kind: control
    - id: edge.final_gate.merge_decision_gateway
      from: final_gate
      to: merge_decision_gateway
      kind: control
    - id: edge.merge_decision_gateway.merge_or_approve
      from: merge_decision_gateway
      to: merge_or_approve
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.gate_disposition in ['safe-to-merge', 'safe-to-push']
    - id: edge.merge_or_approve.publish_pr_comment
      from: merge_or_approve
      to: publish_pr_comment
      kind: control
      on_status: [succeeded, failed]
    - id: edge.merge_decision_gateway.publish_pr_comment
      from: merge_decision_gateway
      to: publish_pr_comment
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.gate_disposition not in ['safe-to-merge', 'safe-to-push']
    - id: edge.publish_pr_comment.cleanup_worktree
      from: publish_pr_comment
      to: cleanup_worktree
      kind: control
      on_status: [succeeded, failed]

dataflow:
  captures:
    - id: capture.queue_state
      from_node: initialize_queue_state
      name: queue_state
      value_type:
        kind: object
        schema_ref: schema://merge-god/pr-merge.queue-state/v1
    - id: capture.preflight_disposition
      from_node: retained_scope_preflight
      name: disposition
      value_type:
        kind: string
    - id: capture.validation_results
      from_node: compare_against_base
      name: validation_results
      value_type:
        kind: object
        schema_ref: schema://merge-god/pr-merge.validation-results/v1
    - id: capture.gate_disposition
      from_node: final_gate
      name: disposition
      value_type:
        kind: string
    - id: capture.gate_result
      from_node: final_gate
      name: gate_result
      value_type:
        kind: object
        schema_ref: schema://merge-god/pr-merge.gate-result/v1

artifacts:
  outputs:
    - id: pr-queue-state
      kind: json
      producer_node: initialize_queue_state
      publish: true
      audience: [operator, auditor]
    - id: pr-merge-report
      kind: report
      producer_node: final_gate
      publish: true
      audience: [operator, reviewer, auditor]
    - id: validation-logs
      kind: log-bundle
      producer_node: compare_against_base
      publish: true
      audience: [operator, reviewer]
```

### Agent Task Loop WorkflowIR

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.agent-task-loop
  version: v1
  title: Merge God agent task loop
  description: Execute one task-specific prompt with LLM streaming and iterative tool-use feedback.
  tags: [merge-god, llm, tool-loop]
  safety:
    tier: T2

capabilities:
  required_profiles: [agentic, gateways, events-timers, error-handling, typed-dataflow]
  required_extensions:
    - name: metro/bounded-agent-loop
      version: v1
      reason: The LLM/tool loop repeats until no tool calls are produced or max iterations is reached.
      schema_ref: schema://metro/extensions/bounded-agent-loop/v1

inputs:
  - name: task
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/agent.task/v1
  - name: pr_context
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/agent.pr-context/v1
  - name: agent_session
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/agent.session/v1
  - name: max_iterations
    default: 25
    value_type:
      kind: integer

graph:
  nodes:
    - id: build_task_prompt
      kind: action
      label: Build task-specific prompt from task id and PR context
      action:
        ref: merge-god.prompt.build-task-prompt
        mode: deterministic
        tool_ref: tool://merge-god/prompt.build-task-prompt@v1
      metadata:
        prompt_refs:
          analyze: prompt://merge-god.pr-task.analyze@1.0.0
          resolve_conflicts: prompt://merge-god.pr-task.resolve-conflicts@1.0.0
          address_reviews: prompt://merge-god.pr-task.address-reviews@1.0.0
          fix_ci: prompt://merge-god.pr-task.fix-ci@1.0.0
          code_review: prompt://merge-god.pr-task.code-review@1.0.0
          validate: prompt://merge-god.pr-task.validate@1.0.0

    - id: select_task_tools
      kind: action
      label: Select common and task-specific tools
      action:
        ref: merge-god.agent.select-task-tools
        mode: deterministic
        tool_ref: tool://merge-god/agent.select-task-tools@v1

    - id: llm_turn
      kind: action
      label: Stream one LLM turn with conversation history and available tools
      action:
        ref: merge-god.agent.llm-turn
        mode: agentic
        tool_ref: tool://merge-god/agent.llm-turn@v1
        agent:
          autonomy: bounded-tool-use
          max_iterations_ref: input.max_iterations
          allowed_tools_from: capture.available_tools
          evidence_expectations:
            - streamed_text
            - tool_uses
            - final_message

    - id: tool_use_gateway
      kind: gateway
      label: Did the LLM request tools?
      gateway:
        kind: exclusive
      default_edge: edge.tool_use_gateway.complete_task

    - id: execute_tool_calls
      kind: action
      label: Execute requested tool calls and record action telemetry
      action:
        ref: merge-god.agent.execute-tool-calls
        mode: external
        tool_ref: tool://merge-god/agent.execute-tool-calls@v1
      metadata:
        available_tools:
          common: [read_file, list_files]
          mutating_tasks: [edit_file, run_tests, git_commit]
          mutating_task_ids: [resolve_conflicts, address_reviews, fix_ci, code_review]

    - id: append_tool_results
      kind: action
      label: Append tool results to conversation history
      action:
        ref: merge-god.agent.append-tool-results
        mode: deterministic

    - id: iteration_limit_gateway
      kind: gateway
      label: Has the max tool-loop iteration count been reached?
      gateway:
        kind: exclusive
      default_edge: edge.iteration_limit_gateway.llm_turn

    - id: fail_iteration_limit
      kind: action
      label: Fail task because max iterations were exceeded
      action:
        ref: merge-god.agent.fail-iteration-limit
        mode: deterministic
      on_error:
        strategy: fail_workflow

    - id: complete_task
      kind: action
      label: Mark task complete when no more tools are requested
      action:
        ref: merge-god.agent.complete-task
        mode: deterministic

  edges:
    - id: edge.build_task_prompt.select_task_tools
      from: build_task_prompt
      to: select_task_tools
      kind: control
    - id: edge.select_task_tools.llm_turn
      from: select_task_tools
      to: llm_turn
      kind: control
    - id: edge.llm_turn.tool_use_gateway
      from: llm_turn
      to: tool_use_gateway
      kind: control
    - id: edge.tool_use_gateway.execute_tool_calls
      from: tool_use_gateway
      to: execute_tool_calls
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.tool_use_count > 0
    - id: edge.tool_use_gateway.complete_task
      from: tool_use_gateway
      to: complete_task
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.tool_use_count == 0
    - id: edge.execute_tool_calls.append_tool_results
      from: execute_tool_calls
      to: append_tool_results
      kind: control
      on_status: [succeeded, failed]
    - id: edge.append_tool_results.iteration_limit_gateway
      from: append_tool_results
      to: iteration_limit_gateway
      kind: control
    - id: edge.iteration_limit_gateway.fail_iteration_limit
      from: iteration_limit_gateway
      to: fail_iteration_limit
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.iteration_count >= inputs.max_iterations
    - id: edge.iteration_limit_gateway.llm_turn
      from: iteration_limit_gateway
      to: llm_turn
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.iteration_count < inputs.max_iterations
      metadata:
        loop: llm_tool_feedback

dataflow:
  captures:
    - id: capture.task_prompt
      from_node: build_task_prompt
      name: prompt
      value_type:
        kind: string
    - id: capture.available_tools
      from_node: select_task_tools
      name: tools
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/agent.tool-definition/v1
    - id: capture.tool_uses
      from_node: llm_turn
      name: tool_uses
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/agent.tool-use/v1
    - id: capture.tool_use_count
      from_node: llm_turn
      name: tool_use_count
      value_type:
        kind: integer
    - id: capture.tool_results
      from_node: execute_tool_calls
      name: tool_results
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/agent.tool-result/v1
    - id: capture.iteration_count
      from_node: append_tool_results
      name: iteration_count
      value_type:
        kind: integer
```

### Issue Implementation Subworkflow

The issue path is simpler than PR processing and can be represented as a
prompt-driven implementation workflow:

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.process-issue
  version: v1
  title: Merge God process implementation issue

capabilities:
  required_profiles: [gateways, human-gates, error-handling, agentic]

inputs:
  - name: issue
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/github.issue-summary/v1
  - name: default_branch
    required: true
    value_type:
      kind: string
  - name: guidelines
    value_type:
      kind: string
  - name: commit_examples
    value_type:
      kind: string
  - name: interactive
    default: false
    value_type:
      kind: boolean

gates:
  definitions:
    - id: gate.merge-god.confirm-issue-processing
      decision_type: human-confirmation
      label: Confirm issue implementation
      options:
        - id: approve
          label: Implement issue
        - id: decline
          label: Skip issue
      default_option: decline
      timeout:
        duration: 5m
      on_timeout: decline

graph:
  nodes:
    - id: validate_issue
      kind: action
      action:
        ref: merge-god.issue.validate-input
    - id: maybe_confirm_issue
      kind: gateway
      gateway:
        kind: exclusive
    - id: confirm_issue_processing
      kind: gate
      gate_ref: gate.merge-god.confirm-issue-processing
    - id: sync_default_branch
      kind: action
      action:
        ref: merge-god.git.sync-default-branch
    - id: create_or_checkout_issue_branch
      kind: action
      action:
        ref: merge-god.git.create-or-checkout-issue-branch
    - id: run_issue_agent
      kind: action
      action:
        ref: merge-god.agent.run-issue-implementation
        mode: agentic
        tool_ref: tool://merge-god/agent.run-issue-implementation@v1
        agent:
          prompt_ref: prompt://merge-god.issue.implement@1.0.0
          autonomy: repository-mutation-and-pr-creation
          timeout: 1h
    - id: notify_issue_result
      kind: action
      action:
        ref: merge-god.notify.issue-result

  edges:
    - id: edge.validate_issue.maybe_confirm_issue
      from: validate_issue
      to: maybe_confirm_issue
      kind: control
    - id: edge.maybe_confirm_issue.confirm_issue_processing
      from: maybe_confirm_issue
      to: confirm_issue_processing
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.interactive == true
    - id: edge.maybe_confirm_issue.sync_default_branch
      from: maybe_confirm_issue
      to: sync_default_branch
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: inputs.interactive == false
    - id: edge.confirm_issue_processing.sync_default_branch
      from: confirm_issue_processing
      to: sync_default_branch
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.issue_processing_decision == 'approve'
    - id: edge.sync_default_branch.create_or_checkout_issue_branch
      from: sync_default_branch
      to: create_or_checkout_issue_branch
      kind: control
    - id: edge.create_or_checkout_issue_branch.run_issue_agent
      from: create_or_checkout_issue_branch
      to: run_issue_agent
      kind: control
    - id: edge.run_issue_agent.notify_issue_result
      from: run_issue_agent
      to: notify_issue_result
      kind: control
      on_status: [succeeded, failed]

dataflow:
  captures:
    - id: capture.issue_processing_decision
      from_node: confirm_issue_processing
      name: decision
      value_type:
        kind: string
    - id: capture.issue_branch
      from_node: create_or_checkout_issue_branch
      name: branch_name
      value_type:
        kind: string
```

### Projection Notes

- A simple DAG backend MUST reject the repository monitor and agent task loop because both contain cycles.
- A BPM or durable workflow backend SHOULD model `wait_cycle`, `wait_no_work`, and `wait_after_sync_failure` as timer waits rather than sleep calls.
- A durable workflow backend SHOULD model collection iteration as child workflow invocations with isolated failure handling.
- An agentic backend SHOULD map `llm_turn` and `execute_tool_calls` to a controlled tool-use loop and SHOULD persist conversation, tool calls, tool results, actions, and file operations as runtime evidence.
- A harness that cannot safely expose mutating tools MUST reject tasks whose selected tools include `edit_file`, `run_tests`, or `git_commit` when those operations are required for correctness.

---
