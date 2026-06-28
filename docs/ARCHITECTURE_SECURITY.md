# Architecture And Security Scanning

This document captures architecture and security specifics using the Go implementation as the
canonical example. It is a companion to the Metro WorkflowIR references in
`docs/metro-spec/`.

## Canonical Code Paths

| Concern | Code path |
| --- | --- |
| Monolith wiring | `cmd/source-system/monolith.go` |
| Webhook event model | `source/webhook-event.go` |
| Webhook parsing and dispatch | `source/webhook-handler.go` |
| Issue-to-PR pipeline | `source/feature-request-processor.go` |
| Agent pipeline and formatting | `source/pipeline.go` |
| Security advisory issue creation | `source/security-advisory-intake.go` |
| Security attacker | `source/security-review.go` |
| Logic attacker | `source/logic-review.go` |
| Resilience attacker | `source/resilience-review.go` |
| Attack coordinator | `source/adversarial-review-coordination.go` |
| Agent tool safety validator | `source/tool-safety-validator.go` |
| Tool execution environment | `source/code-edit-tools.go` |
| Security event ledger | `source/run-ledger.go` |

## Runtime Architecture

the source system is service-grade automation, not just a local PR assistant. The
canonical runtime flow is implemented around SCM webhooks, a dispatcher, and a
multi-agent implementation pipeline.

The primary pipeline is:

1. `Webhook Handler` receives GitHub/Gitea events and validates signatures.
2. `feature request triage` evaluates feasibility and orchestrates lifecycle behavior.
3. `requirements architecture` turns the request into requirements and relevant file context.
4. `code-change implementation` generates file operations and later repairs CI/review failures.
5. `adversarial review coordination` runs adversarial review concurrently.
6. `security review`, `logic review`, and `resilience review` attack the generated operations.
7. Failures feed structured feedback back to code-change implementation for retries.
8. Passing or exhausted work becomes a PR with a combat report.
9. Post-PR loops handle CI repair, review feedback, readiness, and merge gates.

The same agent set can run in-process as the `source-system` monolith or as separate
agent services. The command layout includes `optimus-prime`, `bumblebee`,
`ratchet`, `megatron`, `starscream`, `soundwave`, and `shockwave` binaries.

## Webhook And Scanner Model

The webhook handler normalizes SCM events into `internal/webhook.Event` values.
Security advisory support is implemented directly in
`source/webhook-handler.go`:

- `SecurityAdvisoryPayload` parses the GitHub `security_advisory` payload.
- `handleSecurityAdvisory` extracts owner, repo, GHSA, severity, summary, CVE,
  advisory URL, action, and received time.
- Malformed or incomplete advisory payloads are ignored with HTTP 200.
- Accepted advisory events dispatch asynchronously and return HTTP 202.

In the monolith, advisory events route to
`workflow.HandleSecurityAdvisory`. That function creates a remediation issue
and intentionally gates implementation behind the `security-fix` label.

Important distinction: the source system does not implement a general vulnerability
scanner in this path. It reacts to provider advisory events, turns them into
auditable remediation work, and then uses its existing implementation and
adversarial review machinery when a human/operator routes the issue forward.

## Security Advisory Intake

The code-grounded advisory behavior is intentionally conservative:

1. Require repository owner, repository name, and GHSA ID.
2. Normalize severity, defaulting missing severity to `unknown`.
3. Render issue title as `[security][<severity>] Remediate <GHSA>`.
4. Include GHSA, CVE, severity, URL, summary, action, repository, and timestamp
   in the issue body.
5. Apply the `security-fix` label only.
6. Tell operators that implementation is intentionally gated behind that label.

This captures the security boundary in the code: advisory intake creates a
traceable work item; it does not silently mutate code or auto-merge a fix.

## Adversarial Security Scanning

the source system's security scanning is implemented as an LLM-based adversarial review
over proposed `git.FileOperation` values, not as a static scanner binary. The
code serializes generated operations to JSON and sends them to independent
attacker agents with strict JSON output contracts.

`adversarial review coordination.Attack` runs the three attackers concurrently with a `sync.WaitGroup`:

- `security review.Attack` receives `security reviewRequest{Operations: ...}`.
- `logic review.Attack` receives `logic reviewRequest{Operations: ...}`.
- `resilience review.Attack` receives `resilience reviewRequest{Operations: ...}`.

The synthesized verdict fails if any sub-agent reports critical or high-severity
findings. Agent summaries are rebuilt in canonical order:

1. security review: Security
2. logic review: Logic
3. resilience review: Resilience

### security review Security Scope

`source/security-review.go` is the security scan source of
truth. It looks for:

- OWASP-style issues: injection, broken authentication, sensitive data exposure,
  XXE, broken access control, insecure defaults, XSS, insecure deserialization,
  known vulnerable components, and insufficient logging/monitoring.
- Hardcoded secrets: API keys, tokens, passwords, private keys, connection
  strings, cloud credentials, webhook/HMAC/JWT secrets, OAuth secrets, encoded
  secrets, and `.env` contents.
- Malicious code: backdoors, hidden admin routes, bypass credentials, data
  exfiltration, reverse shells, arbitrary command execution, obfuscated runtime
  execution, trojanized dependencies, time bombs, privilege escalation, and
  cryptomining/resource hijacking.

Hardcoded secrets and malicious code are always critical. Any critical or high
severity vulnerability requires `overall_security_verdict: fail`.

### logic review Logic Scope

`source/logic-review.go` checks correctness and malicious
logic paths:

- nil/null dereferences
- off-by-one and boundary mistakes
- overflow, truncation, and type conversion bugs
- race conditions and resource leaks
- swallowed errors and bad error propagation
- hidden control flow, auth bypass, time bombs, infinite loops, data leakage,
  and silent data mutation

Critical or high findings require `overall_logic_verdict: fail`.

### resilience review Resilience Scope

`source/resilience-review.go` checks performance and DoS risk:

- algorithmic complexity attacks
- ReDoS, XML bombs, zip bombs, hash collision attacks, slowloris-style failures
- unbounded fan-out, unbounded goroutines, missing timeouts, missing pool limits
- retry storms, missing circuit breakers, missing backpressure, and memory
  pressure from unbounded caches or hot-path allocation

DoS vectors are always critical. Critical or high findings require
`overall_resilience_verdict: fail`.

## Tool Safety And Secret Controls

the source system also has deterministic guardrails around agent tool use. These are
separate from the LLM adversarial review and should be preserved in any
WorkflowIR translation.

`ValidateToolCall` blocks or warns before tool execution:

- Blocks network tools: `curl`, `wget`, `nc`, `ncat`, `netcat`, `socat`.
- Blocks privilege escalation: `sudo`, `su`.
- Blocks filesystem wipe tools: `mkfs`, `dd`, `shred`, `wipefs`, `mkfs.*`.
- Blocks fork bombs and reverse-shell patterns.
- Blocks subshell reads of sensitive paths such as `~/.ssh`, `/etc/passwd`,
  `/etc/shadow`, `~/.aws`, and `~/.config`.
- Blocks bare `env`, `printenv`, `export`, and `set` because they expose secrets.
- Blocks external package installs that pull untrusted code into the sandbox.
- Blocks grep `-f`/`--file` pattern sources and warns on secret-path greps.
- Blocks writes into `.git/`, path escapes outside the clone, and warns on
  `.env` writes.

`run_command` executes in the repository clone with a 30-second timeout and a
sanitized environment. The environment allows build-related variables but strips
secret-like process state such as SCM and cloud provider credentials.

`source/run-ledger.go` records security-relevant tool calls as
`SecurityEvent` entries with verdict, category, reason, and tool name. These
events are propagated to run summaries so blocked/warned/allowed security
events remain auditable.

## WorkflowIR Capture Requirements

Any WorkflowIR or Merge God translation of the source system should model these as
first-class behavior:

- Event intake and dispatch are explicit, not hidden inside a prompt.
- Security advisory intake is issue-first and label-gated.
- security review, logic review, and resilience review are parallel adversarial subagents.
- Findings have structured severity/category/file/description outputs.
- Critical/high findings fail the combat verdict and feed code-change implementation retry context.
- Tool execution has deterministic preflight validation before LLM-requested
  mutations run.
- Secret handling is both prompt-level and runtime-level: prompts forbid secrets,
  validators block secret reads, command execution sanitizes environment, and
  run ledger captures security events.
