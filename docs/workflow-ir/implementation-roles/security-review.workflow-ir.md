# Security Review WorkflowIR

**Canonical source**: `internal/agents/adversarial-reviews/security_review.go`

```yaml
ir_version: workflow-ir/v1
workflow:
  id: wf.merge-god.role.security-review
  version: v1
  title: Security review
  description: Perform adversarial security analysis over proposed file operations.
  tags: [merge-god, role, security, owasp, secrets]
  profile: agentic-workflow
  safety:
    tier: T1
    notes:
      - Security review inspects proposed operations only; it does not execute or mutate code.
      - Hardcoded secrets and malicious code patterns are always critical findings.

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
        ref: merge-god.security-review.serialize-operations
        mode: deterministic
        source_ref: internal/agents/adversarial-reviews/security_review.go#Attack

    - id: attack_security
      kind: action
      label: Attack code changes for security vulnerabilities
      action:
        ref: merge-god.security-review.attack
        mode: agentic
        agent:
          role: Security Review
          source_ref: internal/agents/adversarial-reviews/security_review.go#security_reviewSystem
          prompt_ref: prompt://merge-god.security-review.security-attack@1.0.0
          output_contract_ref: schema://merge-god/security-review.report/v1
      metadata:
        categories:
          owasp_top_10:
            - injection
            - broken_authentication
            - sensitive_data_exposure
            - xxe
            - broken_access_control
            - security_misconfiguration
            - xss
            - insecure_deserialization
            - known_vulnerable_components
            - insufficient_logging_monitoring
          hardcoded_secrets:
            - api_keys
            - tokens
            - passwords
            - private_keys
            - credentialed_connection_strings
            - cloud_credentials
            - webhook_hmac_jwt_secrets
            - oauth_secrets
            - encoded_secrets
            - env_file_contents
          malicious_code:
            - backdoors
            - data_exfiltration
            - reverse_shells
            - arbitrary_command_execution
            - obfuscated_runtime_execution
            - trojanized_dependencies
            - hidden_functionality
            - privilege_escalation
            - cryptomining
        verdict_rules:
          - any critical or high vulnerability requires overall_security_verdict fail
          - hardcoded secrets are always critical
          - malicious code patterns are always critical

  edges:
    - id: edge.serialize_operations.attack_security
      from: serialize_operations
      to: attack_security
      kind: control

dataflow:
  captures:
    - id: capture.vulnerabilities
      from_node: attack_security
      name: vulnerabilities
      value_type:
        kind: array
        items:
          kind: object
          schema_ref: schema://merge-god/security-review.vulnerability/v1
    - id: capture.security_report
      from_node: attack_security
      name: report
      value_type:
        kind: object
        schema_ref: schema://merge-god/security-review.report/v1
```
