---
title: Configuration
description: The complete reference for config.yaml, the runtime config created from config.example.yaml.
group: Guides
order: 10
---

merge-god reads `config.yaml` by default. The repository ships
`config.example.yaml` as the commented template; copy it or run `init` to create
your local `config.yaml`.

Point the dashboard at any other YAML file with
`npx tsx dashboard.ts path/to/config.yaml` or
`npx merge-god@latest --config path/to/config.yaml dashboard`.

You can also bootstrap one interactively: run `npx tsx dashboard.ts` with no
config present and it will walk you through adding repos with live validation.

```bash
# from the published package
npx merge-god@latest init --repo /Users/you/dev/my-project

# from a source checkout
cp config.example.yaml config.yaml
npx tsx dashboard.ts --dry-run
```

## Repositories

The heart of the config is the `repos` list. Each entry is a repository to
monitor.

```yaml
repos:
  - path: /Users/you/dev/my-project
    name: "My Project"
    enabled: true
    watch_issues: false
    interactive: true
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | — **required** | Absolute path to a local git repo with a GitHub remote. |
| `name` | string | dir name | Display name in the dashboard. |
| `enabled` | bool | `true` | Set `false` to skip this repo. |
| `watch_issues` | bool | `false` | Monitor `for-impl` issues and implement them as PRs. See [Usage](./usage/#issue-watching). |
| `interactive` | bool | `true` | In TUI mode, prompt for confirmation before acting. Ignored (always off) in non-TUI mode. |

```yaml
repos:
  - path: /Users/you/dev/disabled-repo
    name: "Disabled Project"
    enabled: false   # skipped entirely
```

## Label-based processing

Labels live on GitHub, not in the config — but they're how you steer merge-god.

| Label | Applied to | Effect |
| --- | --- | --- |
| `for-landing` | PR | Process to land: conflicts → reviews → CI → merge. |
| `for-review` | PR | `for-landing` **plus** a second quality-review pass. |
| `for-impl` | Issue | Implement the issue as a PR (requires `watch_issues: true`). |

A PR with **no label is skipped**. Drafts and WIP/work-in-process PRs are always
excluded.

## Doormat (AWS credentials)

If you use `doormat` for short-lived AWS credentials, merge-god refreshes them
before launching each repo monitor. It's auto-detected — but you can pin a
custom command:

```yaml
doormat:
  command: ["doormat", "aws", "login"]   # exact invocation
  timeout: 30                            # seconds (default: 30)
```

Credential refresh is **non-fatal**: if it fails, processing continues and the
attempt is logged.

## Telemetry and Opik

merge-god can emit OpenTelemetry traces and metrics for debugging PR and issue
agent runs. Telemetry is disabled by default. Enable it with Opik environment
variables or a generic OTLP HTTP endpoint.

For Opik Cloud:

```bash
export OPIK_API_KEY="your-opik-api-key"
export OPIK_WORKSPACE_NAME="default"
export OPIK_PROJECT_NAME="merge-god"
```

For any OTLP HTTP collector:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20token"
```

For a self-hosted Opik instance started with `./opik.sh`:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:5173/api/v1/private/otel"
export OTEL_EXPORTER_OTLP_HEADERS="Comet-Workspace=default,projectName=merge-god-local"
```

For local debugging without a collector:

```bash
export MERGE_GOD_TELEMETRY_EXPORTER="console"
```

Set `MERGE_GOD_TELEMETRY_ENABLED=false` to force telemetry off even when Opik or
OTLP variables are present.

Each PR processing attempt is traced as `merge_god.process_pr`, with child spans
for context gathering and pi agent execution. Issue implementation runs are
traced as `merge_god.process_issue`. PR runs also carry the durable trajectory
identifiers (`run_id`, workset, work item, activity, and activity session) into
the pi work item.

Durable trajectory reads include a normalized hierarchy from run through
workset, work item, activity, activity session, agent turn, and tool call. Each
level exposes an external `open`, `closed`, `blocked`, `failed`, or `canceled`
state plus the underlying raw status. A resume cursor identifies unfinished
activities, sessions, turns, and tool calls. On restart, an unfinished PR agent
trajectory is reused with a replacement session after abandoned leaves are
marked interrupted.

A successful trajectory cannot close while a child remediation activity is
still open. Failed trajectories explicitly cancel unfinished descendants and
emit a final closeout report for every lifecycle level.

Key metrics:

| Metric | Meaning |
| --- | --- |
| `merge_god.prompt.rendered` | Count of rendered or submitted prompts, tagged by prompt kind. |
| `merge_god.prompt.size` | Prompt size histogram in characters. |
| `merge_god.agent.run` | Agent run count tagged by agent kind and result status. |
| `merge_god.agent.duration` | Agent run duration histogram in seconds. |

## Merge rules

Each repository can define root-level merge policy in `commandments.yaml`. Keep
this file small: use it for plain-language rules, a human-readable remediation
mode, and portable Workflow-IR references. Put detailed gate graphs, evidence
requirements, check selection, retries, and remediation routing in Workflow-IR.

```yaml
version: 1
title: Merge God local merge rules

rules:
  - Run as many applicable gates as possible before making a final merge decision.
  - A failed gate should trigger remediation when the fix remains within the configured mode.
  - Final decisions must include evidence for skipped, failed, remediated, and passing gates.
  - Underlying bug-fix PRs must link back to the PR that exposed the problem and cite signal, grounding, and validation evidence.

remediation:
  mode: bounded-fixes

workflow_ir:
  - docs/workflow-ir/review-workflows/underlying-remediation-pr.workflow-ir.md
  - git+https://github.com/acme/workflow-policies.git@3f4b1f7e2d6c9a8b0e1d2c3a4f5b6c7d8e9f0123//review/pre-landing.workflow-ir.md#wf.acme.pre-landing
```

`rules` are natural-language policy for prompt-driven judgment.
`remediation.mode` names how much fixing merge-god may do before it should stop
or escalate. `workflow_ir` points at executable gate definitions. Plain refs are
repo-relative, so they migrate cleanly only when the referenced files move with
the policy. Remote Git refs are supported when they are pinned to an immutable
commit hash. If a referenced Workflow-IR file is missing, unpinned, or
unsupported in the new repo, merge-god should report that ref as skipped
evidence rather than treating it as a passing gate.

For compatibility, `remediation.threshold` is still accepted as an alias for
`remediation.mode`; existing values such as `bounded` continue to work. Hidden
file names are also still accepted as aliases, but `commandments.yaml` is the
documented name. File precedence is `commandments.yaml`, `commandments.yml`,
`merge-rules.yaml`, `merge-rules.yml`, `.commandments.yaml`,
`.commandments.yml`, `.merge-rules.yaml`, `.merge-rules.yml`.

Supported fields:

| Field | Type | Description |
| --- | --- | --- |
| `version` | number | Schema version. Use `1`. |
| `title` | string | Human-readable name for the rule set. |
| `rules` | string[] | Natural-language merge requirements. |
| `remediation.mode` | string | Human-readable fixing level before stopping or escalating. |
| `remediation.threshold` | string | Compatibility alias for `remediation.mode`. |
| `workflow_ir` | string[] | Repo-relative or pinned remote Git Workflow-IR refs that define executable gates. |

Workflow-IR ref examples:

| Ref type | Example | Portability |
| --- | --- | --- |
| Repo-relative file | `docs/workflow-ir/review-workflows/underlying-remediation-pr.workflow-ir.md` | Requires that file to exist in each target repo. |
| Repo-relative file plus workflow id | `docs/workflow-ir/review-workflows/pre-landing-review.workflow-ir.md#wf.merge-god.pre-landing-review` | Requires that file and workflow id to exist in each target repo. |
| Pinned Git repository ref | `git+https://github.com/acme/workflow-policies.git@3f4b1f7e2d6c9a8b0e1d2c3a4f5b6c7d8e9f0123//review/pre-landing.workflow-ir.md#wf.acme.pre-landing` | Portable across repos because the policy source is external and immutable. |
| GitHub blob permalink | `https://github.com/acme/workflow-policies/blob/3f4b1f7e2d6c9a8b0e1d2c3a4f5b6c7d8e9f0123/review/pre-landing.workflow-ir.md#wf.acme.pre-landing` | Portable when the URL uses a commit SHA, not a branch or tag. |

Do not use branch names such as `main`, moving tags, or unpinned raw URLs for
merge policy. Unpinned remote refs are mutable and should be reported as skipped
evidence.

Rule examples:

| Rule type | Example |
| --- | --- |
| Evidence breadth | `Run as many applicable gates as possible before making a final merge decision.` |
| Failed-gate remediation | `A failed gate should trigger remediation when the fix remains within the configured mode.` |
| Scope control | `Remediation must preserve the PR's retained scope and stop before unrelated redesign.` |
| Final evidence | `Final decisions must include evidence for skipped, failed, remediated, and passing gates.` |
| Human escalation | `Escalate when remediation would exceed the configured mode or require product judgment.` |

Remediation mode examples:

| Mode | Compatibility value | Meaning |
| --- | --- |
| `observe-only` | `observe` | Gather evidence only; do not mutate the branch. |
| `validate-only` | `validate` | Run gates and report findings; do not apply fixes. |
| `mechanical-fixes` | `mechanical` | Apply generated or mechanical fixes, then rerun affected gates. |
| `bounded-fixes` | `bounded` | Fix conflicts or CI failures when retained scope stays unchanged. |
| `maintainer-approved` | `maintainer-approved` | Allow broader remediation only when a human-approved gate says so. |

### PR remediation labels

A pull request may lower its remediation autonomy with one visible label. The
label is a cap, not a request that the model may exceed. The repository mode,
risk policy, and global operations budget remain ceilings.
Merge God ensures these labels exist when a non-dry-run PR loop starts.

| Label | Effect |
| --- | --- |
| `remediation:observe-only` | Gather evidence only. Do not launch a mutating PR agent. |
| `remediation:validate-only` | Run validation and report findings without branch changes. |
| `remediation:mechanical-fixes` | Permit generated, formatting, and other mechanical fixes within the mechanical budget. |
| `remediation:bounded-fixes` | Permit scoped conflict, review, and CI fixes that preserve retained PR scope. |
| `remediation:maintainer-approved` | Request broader remediation. The label event must be attributed to an authorized maintainer. |

The effective mode is the least permissive of the PR label, repository mode,
risk ceiling, and global ceiling. With no threshold label, the repository mode
is used. Merge God never lets a model increase its own threshold.

Multiple remediation labels are ambiguous and fail closed to `observe-only`.
An unverified `remediation:maintainer-approved` label also fails closed. The
review-gate status comment records the requested mode, source, effective mode,
downgrade reasons, and budget so operators can inspect the decision on the PR.

| Effective mode | Fix attempts | Files | Changed lines | Duration | Input tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `observe-only` | 0 | 0 | 0 | 10 minutes | 8,000 |
| `validate-only` | 0 | 0 | 0 | 20 minutes | 16,000 |
| `mechanical-fixes` | 2 | 10 | 500 | 30 minutes | 32,000 |
| `bounded-fixes` | 3 | 25 | 1,500 | 60 minutes | 64,000 |
| `maintainer-approved` | 5 | 50 | 5,000 | 120 minutes | 128,000 |

Budgets are deterministic guardrail inputs. A model prompt may describe them,
but mutation permission is enforced by the trajectory tool policy before a
mutating pi activity starts. The current one-shot PR agent is mutation-oriented,
so `observe-only` and `validate-only` stop after context and gate collection
until a dedicated read-only activity is selected.

## Validating your config

Always dry-run after editing:

```bash
npx tsx dashboard.ts --dry-run
```

It verifies that every `path` exists and is a valid git repo, that
`pr-loop.ts` is present, and summarizes what would launch — then exits
without starting anything.

Need a starting shape? See [Scenarios](./scenarios/) for complete example
configs.
