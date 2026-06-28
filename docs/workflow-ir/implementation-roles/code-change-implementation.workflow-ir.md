---
title: Code Change Implementation WorkflowIR
description: WorkflowIR reference for code change implementation.
group: WorkflowIR References
order: 30
---

# Code Change Implementation WorkflowIR

**Canonical sources**:

- `internal/agents/implementations/code_change_implementation_agentic.go`
- `internal/agents/implementations/code_change_implementation_prompts.go`
- `internal/agents/implementations/tool_validator.go`
- `internal/agents/implementations/tools_edit.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.code-change-implementation
  version: v1
  title: Code change implementation
  description: Explore the repository, make targeted source edits, validate code changes, and emit file operations compatible with the source system generation results.
  tags: [merge-god, role, implementation, code-generation, repair]
  profile: agentic-workflow
  safety:
    tier: T2
    notes:
      - Code Change Implementation is the primary mutating role.
      - All tool calls must pass deterministic validation before execution.
      - Runtime commands execute in the repository clone with sanitized environment.

capabilities:
  required_profiles: [agentic, typed-dataflow, error-handling, events-timers]
  required_extensions:
    - name: merge-god/two-phase-agentic-loop
      version: v1
      reason: Code Change Implementation runs exploration before editing.
    - name: merge-god/tool-safety-validator
      version: v1
      reason: Tool calls are validated by ValidateToolCall before execution.

inputs:
  - name: issue
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/scm.issue-context/v1
  - name: analysis
    required: true
    value_type:
      kind: object
      schema_ref: schema://merge-god/requirements-architecture.analysis-result/v1
  - name: clone_dir
    required: true
    value_type:
      kind: string
  - name: repo_guidance
    value_type:
      kind: string
  - name: review_feedback
    value_type:
      kind: string
  - name: adversarial-review_feedback
    value_type:
      kind: string
  - name: max_explore_turns
    default: 10
    value_type:
      kind: integer
  - name: max_edit_turns
    default: 15
    value_type:
      kind: integer

resources:
  systems:
    - id: repository-clone
      kind: filesystem
      description: Persistent clone used for reading, editing, and validation.
    - id: llm-provider
      kind: llm
      description: Agentic LLM for planning, exploration, and editing.
  locks:
    - id: clone-write-lock
      scope: input.clone_dir
      mode: exclusive
      required_by: [edit_phase]

graph:
  nodes:
    - id: validate_agentic_request
      kind: action
      label: Require configured agentic LLM and clone_dir
      action:
        ref: merge-god.code-change-implementation.validate-agentic-request
        mode: deterministic
        source_ref: internal/agents/implementations/code_change_implementation_agentic.go#GenerateAgentic

    - id: optional_feedback_plan
      kind: action
      label: Synthesize adversarial review feedback into fix plan when present
      action:
        ref: merge-god.code-change-implementation.run-planning-turn
        mode: agentic
        agent:
          role: Code Change Implementation
          source_ref: internal/agents/implementations/code_change_implementation_agentic.go#runPlanningTurn
          prompt_ref: prompt://merge-god.code-change-implementation.feedback-plan@1.0.0
      on_error:
        strategy: continue
      metadata:
        only_when: inputs.adversarial-review_feedback != ''

    - id: explore_phase
      kind: action
      label: Explore relevant code without modifying files
      action:
        ref: merge-god.code-change-implementation.explore
        mode: agentic
        agent:
          role: Code Change Implementation
          source_ref: internal/agents/implementations/code_change_implementation_prompts.go#buildExploreSystemPrompt
          prompt_ref: prompt://merge-god.code-change-implementation.explore@1.0.0
          autonomy: bounded-read-only-tool-use
          max_iterations_ref: input.max_explore_turns
          allowed_tools:
            - read_file
            - grep
            - glob
            - list_dir
      metadata:
        hard_rules:
          - no file changes during exploration
          - verify APIs exist before planning to use them
          - inspect tests for expected behavior
          - stop when enough context exists to edit

    - id: edit_phase
      kind: action
      label: Apply targeted source edits and validation commands
      action:
        ref: merge-god.code-change-implementation.edit
        mode: agentic
        agent:
          role: Code Change Implementation
          source_ref: internal/agents/implementations/code_change_implementation_prompts.go#buildEditSystemPrompt
          prompt_ref: prompt://merge-god.code-change-implementation.edit@1.0.0
          autonomy: bounded-mutation-tool-use
          max_iterations_ref: input.max_edit_turns
          allowed_tools:
            - edit_file
            - create_file
            - delete_file
            - run_command
      metadata:
        hard_rules:
          - prefer edit_file for existing source changes
          - never create shell scripts, helper scripts, or files in temporary directories
          - make minimal focused changes
          - read exact old_text before editing
          - never invent functions, methods, fields, constants, or APIs
          - do not weaken existing tests to fit broken code
          - never introduce injection, XSS, or hardcoded secrets
          - validate source-code edits with run_command before finishing

    - id: validate_tool_calls
      kind: action
      label: Validate requested tool calls before execution
      action:
        ref: merge-god.code-change-implementation.validate-tool-call
        mode: deterministic
        source_ref: internal/agents/implementations/tool_validator.go#ValidateToolCall
      metadata:
        blocked_categories:
          - network_tool
          - privilege_escalation
          - filesystem_wipe
          - fork_bomb
          - secret_read
          - reverse_shell
          - recursive_delete
          - secret_inspection
          - external_install
          - grep_file_flag
          - git_internals_write
          - path_escape
        warned_categories:
          - secret_path_grep
          - env_file_write

    - id: run_validation_command
      kind: action
      label: Execute validation command with sanitized environment
      action:
        ref: merge-god.code-change-implementation.run-command
        mode: external
        source_ref: internal/agents/implementations/tools_edit.go#run_command
      timeout:
        duration: 30s
        on_timeout: route
        target_node: summarize_generation
      metadata:
        env_policy: sanitizedEnv
        output_limit: 10000

    - id: summarize_generation
      kind: action
      label: Extract commit message, PR title, PR body, and file operations
      action:
        ref: merge-god.code-change-implementation.summarize-generation
        mode: deterministic
        source_ref: internal/agents/implementations/code_change_implementation_agentic.go#GenerateAgentic

  edges:
    - id: edge.validate_agentic_request.optional_feedback_plan
      from: validate_agentic_request
      to: optional_feedback_plan
      kind: control
    - id: edge.optional_feedback_plan.explore_phase
      from: optional_feedback_plan
      to: explore_phase
      kind: control
      on_status: [succeeded, failed]
    - id: edge.explore_phase.edit_phase
      from: explore_phase
      to: edit_phase
      kind: control
    - id: edge.edit_phase.validate_tool_calls
      from: edit_phase
      to: validate_tool_calls
      kind: control
      metadata:
        loop: per_tool_call
    - id: edge.validate_tool_calls.run_validation_command
      from: validate_tool_calls
      to: run_validation_command
      kind: guard
      when:
        language: workflow-ir.expr/v1
        expr: captures.tool_validation.security_verdict != 'blocked'
    - id: edge.run_validation_command.summarize_generation
      from: run_validation_command
      to: summarize_generation
      kind: control
    - id: edge.edit_phase.summarize_generation
      from: edit_phase
      to: summarize_generation
      kind: control
      when:
        language: workflow-ir.expr/v1
        expr: captures.source_files_edited == false

dataflow:
  captures:
    - id: capture.fix_plan
      from_node: optional_feedback_plan
      name: fix_plan
      value_type:
        kind: string
    - id: capture.exploration_summary
      from_node: explore_phase
      name: exploration_summary
      value_type:
        kind: string
    - id: capture.tool_validation
      from_node: validate_tool_calls
      name: tool_validation
      value_type:
        kind: object
        schema_ref: schema://merge-god/security.tool-validation/v1
    - id: capture.generation_result
      from_node: summarize_generation
      name: generation_result
      value_type:
        kind: object
        schema_ref: schema://merge-god/generation-result/v1
```
