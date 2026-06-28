---
title: Ironhide Comparison
author: Engineering Team
created: 2026-06-28T06:48:37Z
tags: [comparison, ironhide, memo, merge-god]
id: memo-001
project_id: merge-god
doc_uuid: a94234ef-ecbe-4b7a-bd31-2949e8799925
---

# Overview

This memo compares `merge-god-main` with `ironhide` as observed from local repository snapshots. It is intended to identify architecture, workflow, and documentation practices that Merge God may want to borrow or avoid.

# Details

## High-Level Summary

| Factor | Ironhide | merge-god-main | Comparative Takeaway |
|---|---|---|---|
| Primary mission | Turn labeled GitHub/Gitea issues/security advisories into PRs, then manage CI/review/merge lifecycle | Process existing PRs, resolve conflicts/reviews/CI, optionally implement labeled issues | Ironhide is issue-to-PR lifecycle automation; merge-god is PR-ops/landing automation |
| Runtime model | Backend service, webhook-driven, queue/worker model, monolith or microservices | Local/CLI/dashboard polling model with SQLite state | Ironhide is deployable automation infrastructure; merge-god is operator-facing local automation |
| Main language | Go 1.24 | Python 3.12+ | Ironhide favors static service architecture; merge-god favors rapid scripting/tooling |
| Size signal | 253 Go files, 112 Go test files, 48 docs-cms markdown docs, 8 command entrypoints | 85 Python files, 29 test files, 29 docs-cms markdown docs, packaged CLI/dashboard/MCP components | Ironhide is larger and more service-oriented; merge-god is smaller but has richer local UX surfaces |
| SCM support | GitHub and Gitea behind `internal/scm.Client` | GitHub-oriented, largely `gh`/PyGithub/local repo based | Ironhide has stronger provider abstraction |
| AI integration | Internal Bedrock/Copilot abstractions, named agents, adversarial pipeline | External `bob`/Claude Agent SDK style, Anthropic/Bedrock support | Ironhide owns more of the agent pipeline; merge-god delegates more execution to agent tooling |
| State model | Mostly in-memory runtime state, persistent PR clone dirs, run ledger present | SQLite persistence for dashboard, PR snapshots, contexts, metrics, workflows | merge-god has stronger durable local observability/history |
| UX | Webhooks, logs, SCM comments, local task mode | Rich TUI dashboard, bootstrap wizard, notifications, MCP server | merge-god is much stronger for human operators |
| Deployment | Docker Compose, microservices compose, Kubernetes YAML, Helm chart | Local Python package/CLI, uv/just, no deploy stack found | Ironhide is production-deployment ready; merge-god is workstation/operator oriented |

## Architecture Comparison

| Factor | Ironhide | merge-god-main | Gap |
|---|---|---|---|
| Pipeline shape | Fixed multi-agent pipeline: Optimus, Bumblebee, Ratchet, Megatron, Starscream, Soundwave, Shockwave | PR loop/dashboard invokes agent processing around gathered PR context | merge-god lacks Ironhide's explicit adversarial multi-agent QA; Ironhide lacks merge-god's simpler operator-directed processing modes |
| Trigger model | Webhook events plus periodic scanner | Polling local repos/GitHub via dashboard/loop | Ironhide has stronger event integration; merge-god is easier to run without webhooks |
| Service boundaries | 8 binaries under `cmd/`, monolith or microservice mode | Python package CLI plus dashboard and `github_sync` library/MCP server | Ironhide has production service boundaries; merge-god has richer embeddable tooling |
| Execution model | Internal workflow orchestration with agentic Ratchet, tools, preflight, review/CI repair | Agent wrapper gets comprehensive PR prompt/context and acts in local repo | Ironhide has stronger controlled orchestration; merge-god may be more flexible for arbitrary repo maintenance |
| Review model | Triage review comments, direct suggestions, Ratchet fixes, thread replies/resolution | Gather review comments and instruct agent to address them | Ironhide has deeper review-comment lifecycle handling |
| Conflict handling | Configurable branch update/conflict resolution, AI-powered optional resolution | Explicit conflict detection and agent instructions | Both cover conflicts; Ironhide has more lifecycle integration |
| Auto-merge | Label-gated merge with CI/conversation prerequisites | PRD has merge automation; README describes automated merge loop, but docs-cms has merge automation as separate PRD | Ironhide's merge gate appears more formally integrated |
| Branch stacking | Config option exists | Not evident in sampled docs/code | Ironhide advantage |
| Security advisory flow | PRD exists for GitHub `security_advisory` remediation | Not evident | Ironhide advantage |

## Implementation Surface

| Area | Ironhide | merge-god-main | Comparative Note |
|---|---|---|---|
| SCM abstraction | `internal/scm.Client` with GitHub/Gitea implementations and rate limiting | `merge_god/github_ops.py`, `github_sync/github_client.py`, `gh` usage | Ironhide is cleaner for provider portability |
| Git abstraction | `internal/git/` path guards, file ops, diffs, conflict types | `merge_god/git_ops.py`, MCP git tools, local subprocess patterns | Ironhide centralizes safety; merge-god exposes broader user-facing git tools |
| Agent tools | Ratchet exploration/edit tools in Go; RFCs for unified task engine | MCP server exposes git/file/workflow/PR sync tools | merge-god's MCP tool surface is a major reusable asset |
| Persistence | `internal/runledger`, PR tracker/check sets mostly runtime | `StateDatabase`, `github_sync.SyncStore`, migrations, snapshots, workflow stats | merge-god significantly stronger |
| Config | Large env-based `.env.example` with many operational knobs | YAML multi-repo config plus env for Claude/Bedrock | merge-god config is friendlier for multi-repo operators; Ironhide config is richer for services |
| Documentation model | Extensive docs-cms with PRDs/RFCs/ADRs/memos | docs-cms plus root PRD/ADR/testing/install docs | Ironhide has deeper architecture governance; merge-god has more user-operational docs |
| Local mode | `ironhide --task-file --worktree ...` | Native local repo dashboard/loop | merge-god is more naturally local-first |

## Quality And Tooling

| Factor | Ironhide | merge-god-main | Gap |
|---|---|---|---|
| Tests | 112 Go test files | 29 Python test files | Both tested; Ironhide has broader unit coverage by count |
| CI | `.github/workflows/ci.yml` with build/test/vet/fmt/tidy | No `.github/workflows` found | merge-god lacks checked-in GitHub Actions CI |
| Local quality commands | `make test`, `make vet`, `make fmt`, `make tidy` | `just ci`, ruff, black, isort, mypy, bandit, markdownlint, pytest | merge-god has stronger local lint/type/security quality suite |
| Security tooling | Adversarial security agent, webhook validation, SCM rate limiting | Bandit/pip-audit configured; security/resilience PRD | Different strengths: Ironhide runtime security review; merge-god static Python security tooling |
| Dependency management | Go modules | uv, pyproject, requirements, lockfiles | Both solid |
| Formatting enforcement | Go fmt in CI | ruff/black/isort via just/pre-commit | merge-god broader style tooling |
| Docs validation | docuchango expected by project instructions | docs-cms present | Ironhide has stricter internal docs workflow expectations |

## Operator Experience

| Factor | Ironhide | merge-god-main | Gap |
|---|---|---|---|
| Dashboard | None by product scope; explicitly out of scope in PRD | Rich TUI dashboard, multi-repo status, live logs | Ironhide lacks operator dashboard |
| Bootstrap | `.env.example`, make demo, Gitea setup | Interactive config bootstrap wizard | merge-god easier first-run UX |
| Notifications | SCM comments/logs; no ntfy-style user notifications evident | ntfy.sh notifications | Ironhide lacks lightweight external notifications |
| Multi-repo operations | Scanner repos env list; each pipeline single issue/repo | YAML multi-repo dashboard | merge-god stronger for supervising many local repos |
| Human approval | Mostly label/trust gates; autonomous after trigger | Interactive confirmation support in TUI mode | merge-god stronger for guarded local automation |
| Observability | Structured logs, token tracking, combat reports | Dashboard logs, SQLite history, processing metrics | merge-god stronger local observability; Ironhide stronger PR-facing reports |

## Deployment And Runtime

| Factor | Ironhide | merge-god-main | Gap |
|---|---|---|---|
| Containers | Dockerfile/Compose implied by Makefile and deploy dir | No container/deploy stack found in sampled files | merge-god gap |
| Kubernetes | `deploy/k8s`, Helm chart | None found | merge-god gap |
| Webhooks | First-class GitHub/Gitea webhook handler | Not primary | merge-god gap for hosted automation |
| Background workers | Worker concurrency/queue/deadline config | Dashboard monitors/repos, loop-based polling | Ironhide more production-service oriented |
| Auth | GitHub PAT, GitHub App, Gitea PAT, OAuth CLI login | GitHub CLI/PyGithub, Anthropic/Bedrock env, doormat credential refresh | Ironhide stronger SCM auth breadth; merge-god stronger operator credential refresh |
| API rate handling | Internal SCM rate limiter | Poll interval and local command discipline | Ironhide stronger API protection |

## Major Gaps In Ironhide Relative To merge-god-main

| Gap | Why It Matters | Candidate Borrow/Adapt From merge-god-main |
|---|---|---|
| No TUI/operator dashboard | Harder to supervise multi-repo automation, failures, and live state | `merge_god/dashboard.py`, `config.example.yaml` patterns |
| Limited durable history | In-memory state loses operational context after restart | SQLite state model from `merge_god/db_operations.py` or `github_sync.SyncStore` concepts |
| Less local multi-repo UX | `SCANNER_REPOS` env is less ergonomic than YAML dashboard config | YAML repo config and bootstrap wizard |
| No MCP server surface | External LLM tools cannot easily inspect PR sync/workflow state through standardized tools | `github_sync/mcp_server.py` git/file/workflow/PR tools |
| Less visible process metrics | Token tracking exists, but operator-facing processing history is less prominent | Dashboard metrics and workflow stats |
| No ntfy-style notifications | Operators may miss async lifecycle events outside SCM | `send_notification` / ntfy configuration pattern |
| Local quality suite narrower | Go CI is good, but local `make` does not include broader security/doc lint style gates | merge-god `just ci` style aggregate quality gate idea |

## Major Gaps In merge-god-main Relative To Ironhide

| Gap | Why It Matters | Candidate Borrow/Adapt From Ironhide |
|---|---|---|
| No provider-neutral SCM abstraction comparable to `internal/scm.Client` | Limits portability beyond GitHub and makes API/rate behavior harder to centralize | Ironhide `internal/scm` interface pattern |
| No production webhook service model | Polling/local workflows are weaker for always-on automation | Ironhide webhook dispatcher/worker model |
| No Gitea support evident | Less useful for self-hosted SCM users | Ironhide Gitea client |
| No adversarial multi-agent QA pipeline | Agent output lacks independent security/logic/performance challenge loop | Ironhide Decepticon model |
| No checked-in GitHub Actions workflow found | Quality gates may rely on local discipline | Ironhide CI workflow shape |
| No Docker/Kubernetes/Helm deploy stack | Harder to run as shared team infrastructure | Ironhide `deploy/` structure |
| Less formal rate-limit handling | Polling can still accumulate API load across repos | Ironhide SCM rate limiter |
| Weaker security advisory automation | Dependabot/security advisory remediation is not a first-class flow | Ironhide security advisory PRD/pipeline concept |
| Less explicit architectural governance | Has ADR/PRD docs, but Ironhide has deeper RFC/ADR-first workflow | Ironhide docs-cms governance model |

## Strategic Fit

| Use Case | Better Fit | Reason |
|---|---|---|
| Hosted service that turns issues into PRs | Ironhide | Webhooks, SCM abstraction, service deployment, pipeline orchestration |
| Local operator supervising many PRs | merge-god-main | TUI, YAML multi-repo config, local repo polling |
| GitHub and Gitea support | Ironhide | Provider abstraction and implementations |
| Rich PR context cache/history | merge-god-main | SQLite sync/store/dashboard state |
| Formal adversarial code review | Ironhide | Dedicated security/logic/performance attacker agents |
| Fast adoption by one developer | merge-god-main | uv/CLI/dashboard, local setup |
| Production team deployment | Ironhide | Docker/K8s/Helm/microservices |
| LLM tool interoperability | merge-god-main | MCP server exposes git/file/workflow/PR tools |

## Bottom Line

Ironhide is the stronger production automation platform: event-driven, deployable, provider-abstracted, and built around a formal multi-agent QA lifecycle.

merge-god-main is the stronger operator workstation and observability tool: TUI, persistent SQLite state, multi-repo local config, MCP tools, and a broader local quality/dev workflow.

The biggest cross-pollination opportunity is to combine Ironhide's service-grade lifecycle with merge-god's durable state, dashboard, YAML multi-repo UX, and MCP/workflow tooling.
