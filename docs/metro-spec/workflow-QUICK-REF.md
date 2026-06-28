---
title: Workflow Quick Reference
description: Condensed reference for Metro workflow authoring fields and validation rules.
group: Metro References
order: 20
---

# Workflow Quick Reference

Supplements [WORKFLOW-SPEC.md](WORKFLOW-SPEC.md). Start with
[README.md](README.md) for the workflow documentation map and see `examples/`
for complete workflow files.

This quick reference covers the Metro/Meridian authoring format. Use
[WORKFLOW-IR-SPEC.md](WORKFLOW-IR-SPEC.md) and
[WORKFLOW-IR-GUIDE.md](WORKFLOW-IR-GUIDE.md) for the backend projection IR.

## Document Structure

```markdown
# Workflow: <name>
**Outcome**: <description>
[prose sections]

`scripted` metadata block (first)
## Step Title
[prose]
`scripted` step block (per step)
```

## Metadata Block Fields

| Field | Required | Description |
| ------- | ---------- | ------------- |
| `profile` | Yes | `standalone`, `hmc-workflow`, `iocp-workflow`, `remediation`, `zosmf-workflow` |
| `params` | Yes | Array of param defs (may be `[]`) |
| `tags` | No | Freeform string array |
| `tier` | No | `T0` (read-only), `T2` (mutating), `T0→T2` (escalating) |
| `category` | No | `migration`, `provisioning`, `remediation`, `discovery`, `performance`, `security`, `operations`, `compliance`, `test` |

## Param Definition Fields

| Field | Required | Description |
| ------- | ---------- | ------------- |
| `name` | Yes | `snake_case` identifier |
| `description` | Yes | Human-readable (quoted) |
| `required` | No | Default: `false` |
| `default` | No | Default value (quoted) |
| `type` | No | `string`, `int`, `bool`, `float`, `list`, `object` |

## Step Block Fields

| Field | Required | Description |
| ------- | ---------- | ------------- |
| `id` | Yes | Unique `snake_case` step identifier |
| `action` | Yes | `namespace.action_name` |
| `label` | Recommended | Human-readable, supports `{{var}}` |
| `with` | Contextual | Key-value inputs, supports `{{var}}` |
| `outputs` | No | `var: "$.jsonpath"` extractions |
| `validate` | No | `[{expr: "...", message: "..."}]` |
| `on_error` | No | `fail`, `skip`, `ask`, `retry(N)` |
| `register` | No | Variable for full raw result |
| `register_type` | No | Type identity for registered result |
| `consume` | No | Prior registered variable to consume |
| `capture` | No | `{var: "...", type: "..."}` |
| `inputs` | No | `<param>: {from: "...", type: "..."}` |
| `if` | No | Conditional expression |
| `timeout` | No | Duration: `30s`, `2m` |
| `depends_on` | No | Step IDs this step depends on |
| `idempotent` | No | Boolean, safe to retry |
| `parallel` | No | Array of step defs (replaces all other fields) |

## Validation Checks (WF1–WF20)

| # | Rule | Description |
| --- | ------ | ------------- |
| WF1 | H1 heading | First line must be `# Workflow: <name>` |
| WF2 | Metadata block | First `scripted` block has `profile` + `params` |
| WF3 | Step blocks | At least one step `scripted` block exists |
| WF4 | Step fields | Steps have `id` + `action` |
| WF5 | Step ID format | `snake_case`, unique within workflow |
| WF6 | depends_on | References valid step IDs |
| WF7 | Action format | `namespace.action_name` pattern |
| WF8 | Step count | Total <= 50 |
| WF9–WF20 | Catalog refs, typed handoff, cycle detection | See WORKFLOW-SPEC.md |

## Error Policies

| Policy | Behavior |
| -------- | ---------- |
| `fail` | Abort immediately (default) |
| `skip` | Log warning, nil outputs, continue |
| `retry(N)` | Retry N times (1–10), exponential backoff |
| `ask` | Pause for operator response |

## Template Variables

Sources in resolution order: `params` > `outputs` (JSONPath) > `register` > runtime-injected.

Syntax: `{{variable_name}}`

## JSONPath Quick Reference

| Pattern | Meaning |
| --------- | --------- |
| `$.field` | Top-level field |
| `$.obj.field` | Nested |
| `$.arr[0]` | First element |
| `$.arr[-1]` | Last element |
| `$.arr.length()` | Array length |
| `$.field?` | Optional (nullable) |
