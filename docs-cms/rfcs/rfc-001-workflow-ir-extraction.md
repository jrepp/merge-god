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

This document captures the Merge God rich PR-processing design as portable WorkflowIR. It is expressed as orchestration intent rather than Python implementation details, so the same flow can be reimplemented in another harness.

Source project: `merge-god-main`

Target runtime: WorkflowIR-compatible orchestrators

Source material:

- `merge_god/pr_loop.py`
- `merge_god/agents/claude_agent.py`
- `merge_god/sync.py`
- `merge_god/run_agent.py`

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

    - id: summarize_result
      kind: action
      label: Summarize task completion and action counts
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
    - id: edge.execute_agent_tasks.summarize_result
      from: execute_agent_tasks
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
