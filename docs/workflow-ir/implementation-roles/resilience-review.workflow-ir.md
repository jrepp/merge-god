---
title: Resilience Review WorkflowIR
description: WorkflowIR reference for resilience review.
group: WorkflowIR References
order: 70
---

# Resilience Review WorkflowIR

**Canonical source**: `internal/agents/adversarial-reviews/resilience_review.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.resilience-review
  version: v1
  title: Resilience review
  description: Perform adversarial performance, resilience, and denial-of-service analysis over proposed file operations.
  tags: [merge-god, role, resilience, performance, dos]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Resilience review inspects proposed operations only; it does not execute or mutate code.
      - Denial-of-service vectors are always critical findings.

capabilities:
  required_profiles: [agentic, typed-dataflow, prompt-runtime]

inputs:
  - name: operations
    required: true
    value_type:
      kind: array
      items:
        kind: object
        schema_ref: schema://merge-god/git.file-operation/v1

graph:
  nodes:
    - id: serialize_operations
      kind: action
      label: Marshal proposed file operations to JSON
      action:
        ref: merge-god.resilience-review.serialize-operations
        mode: deterministic
        source_ref: internal/agents/adversarial-reviews/resilience_review.go#Attack

    - id: attack_resilience
      kind: action
      label: Attack code changes for performance flaws, resource exhaustion, and DoS vectors
      action:
        ref: merge-god.resilience-review.attack
        mode: agentic
        agent:
          role: Resilience Review
          source_ref: internal/agents/adversarial-reviews/resilience_review.go#resilience_reviewSystem
          prompt_ref: prompt://merge-god.resilience-review.resilience-attack@1.0.0
          output_contract_ref: schema://merge-god/resilience-review.report/v1
      metadata:
        categories:
          algorithmic_complexity:
            - quadratic_or_worse_user_input_loops
            - recursion_without_memoization_or_depth_limits
            - missing_hash_lookup
            - repeated_reparse_or_recompute
            - combinatorial_explosion
          dos_vectors:
            - unbounded_input_processing
            - redos
            - xml_bomb
            - zip_or_decompression_bomb
            - hash_collision_attack
            - slowloris_missing_deadlines
            - unbounded_fanout
          resource_exhaustion:
            - unbounded_goroutines_or_threads
            - missing_io_timeouts
            - unbounded_memory_allocation
            - missing_connection_pool_limits
            - file_descriptor_leak
            - temp_file_accumulation
            - retry_without_backoff_or_limits
          concurrency_under_stress:
            - global_lock_contention
            - blocking_io_while_holding_locks
            - missing_backpressure
            - thundering_herd
            - blocking_channel_operations
          memory_pressure:
            - hot_path_large_allocations
            - unbounded_caches
            - string_concat_in_loops
            - unnecessary_large_copies
            - full_file_or_response_loading
          cascading_failure:
            - missing_circuit_breakers
            - no_graceful_degradation
            - retry_storms
            - missing_deadline_propagation
            - missing_health_or_readiness_checks
        verdict_rules:
          - any critical or high issue requires overall_resilience_verdict fail
          - dos vectors are always critical

  edges:
    - id: edge.serialize_operations.attack_resilience
      from: serialize_operations
      to: attack_resilience
      kind: control

dataflow:
  captures:
    - id: capture.issues
      from_node: attack_resilience
      name: issues
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/resilience-review.performance-issue/v1
    - id: capture.resilience_report
      from_node: attack_resilience
      name: report
      value_type:
        kind: object
        schema_ref: schema://merge-god/resilience-review.report/v1
```
