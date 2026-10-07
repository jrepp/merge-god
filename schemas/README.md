# merge-god Label Schema

A portable, tool-agnostic extraction of the labeling schema that drives merge-god.
It exists so other tools can create, read, and validate the same labels without
importing merge-god code.

## Files

| File | Purpose |
| --- | --- |
| `labels.json` | Flat catalog in [github-label-sync](https://github.com/Finb/github-label-sync) format (bare array of `{name, color, description}`). Feed it directly to a label-sync tool to provision a repo. |
| `labels.schema.json` | JSON Schema (draft 2020-12). Validates the catalog and individual label occurrences; carries the semantic model in `x-merge-god`. |

`x-` extension keywords are spec-legal annotations, but ajv's strict-mode
linter rejects them — pass `--strict=false` (or set `strict: false` in code):

```sh
npx ajv-cli validate --spec draft2020 --strict=false -s schemas/labels.schema.json -d schemas/labels.json
```

Provision labels on a repo with github-label-sync:

```sh
npx github-label-sync --labels schemas/labels.json --allow-added-labels <owner>/<repo>
```

Consume the semantic model programmatically: parse `labels.schema.json`, read
`x-merge-god.families` — each family lists its labels, direction, cardinality,
and behavioral rules as plain JSON.

## Schema at a glance

Five families, two directions. **Operator-intent labels are input** (humans and
external tools write them; automation respects but never rewrites them).
**State labels are output** (automation writes them; operators clear them to
retry). Annotation labels are an add-only semantic layer, and gate labels are
pattern-matched holds from anyone.

| Family | Labels | Written by | Applies to | Cardinality |
| --- | --- | --- | --- | --- |
| Intent (`for-*`, `duplicate`) | 4 | operators / external tools | PRs (issues for `for-impl`) | ≤ 1 mode per PR; `for-review` wins |
| State (`merge:*`) | 6 | merge-god | PRs | exactly 1 at all times |
| Remediation (`remediation:*`) | 5 | operators; created by automation | PRs | ≤ 1; conflicts fail closed |
| Annotation | 15 | the coding agent | PRs | 0+; allowlisted, add-only |
| Gate (pattern-matched) | — | anyone | PRs | 0+; each match = merge blocker |

### Intent labels (input)

| Label | Target | Meaning |
| --- | --- | --- |
| `for-landing` | PR | Basic processing toward merge: conflicts, review feedback, CI. |
| `for-review` | PR | `for-landing` plus a second quality/security/performance pass; processed first. |
| `for-impl` | Issue | Implement the issue and open a linked PR (requires `watch_issues`). |
| `duplicate` | PR | Hold, not a verdict: pending patch-equivalence and base-containment analysis. |

No intent label = the item is skipped. Labels matching the substrings
`wip`, `work-in-process`, or `work in process` are also skipped.

### State labels (output)

Exactly one `merge:*` label per PR at all times:

```text
merge:ready ──▶ merge:processing ──▶ merge:complete   (success + verified merge)
                     │      ▲
                     │      └── merge:ready (failure without human-blocker signal)
                     ├──▶ merge:blocked  (needs human input / external state)
                     └──▶ merge:failed   (other failures)
merge:ready ──▶ merge:embarked ──▶ (cohort outcome: complete/failed/blocked)
```

`processing`, `embarked`, `blocked`, `failed`, and `complete` are **active**
states: discovery skips a PR carrying one (re-entry lock). `merge:ready` is not
active, so it never blocks. To retry a PR, clear its terminal state label.

### Remediation labels (autonomy caps)

Autonomy increases in this order (a label may only *lower* the effective mode):

```text
observe-only < validate-only < mechanical-fixes < bounded-fixes < maintainer-approved
```

- Two different `remediation:*` labels on one PR: blocked, forced `observe-only`.
- `remediation:maintainer-approved` requires verified maintainer provenance;
  otherwise blocked and capped at `bounded-fixes`.
- Missing/invalid repository default falls back to `bounded-fixes`.
- `observe-only` and `validate-only` are read-only: the mutating agent is blocked.

### Annotation labels (agent output)

Fifteen allowlisted labels (`needs-ci`, `needs-rebase`, `needs-split`,
`needs-conflict-resolution`, `needs-review`, `needs-design`, `high-risk`,
`low-risk`, `large`, `too-large`, `unaligned`, `docs-only`, `test-only`,
`embark-candidate`, `underlying-needed`). Declared by the agent, extracted from
results, or inferred from failure text; filtered to the allowlist; never removed
by automation.

### Gate labels (external holds)

Any label matching the gate patterns (see `x-merge-god.families[id=gate].patterns`)
becomes an `external_gate` merge blocker — e.g. `do-not-merge`, `on-hold`,
`awaiting-security`. `for-*` and `merge:*` labels are explicitly ignored by the
gate matcher.

## Implementer rules

1. **Preserve direction.** Tools must not rewrite `for-*` labels
   programmatically, and must not write `merge:*` labels unless they implement
   the state machine (exactly one, stale labels removed).
2. **Normalize before comparing.** Trim, lowercase, fold whitespace/underscores
   to dashes. Canonical spellings are lowercase in `labels.json`.
3. **Enforce cardinality per family** as listed in the table above.
4. **Treat colors as contract for `merge:*` and `remediation:*`** (they come
   from `pr_state.ts` / `remediation_policy_model.ts`). Colors for the four
   intent labels are suggestions only — source code does not pin them.
5. **Unknown labels are not errors.** The gate family is intentionally
   open-ended; treat unrecognized labels as inert unless they match a gate
   pattern.
6. **`x-merge-god` is the semantic contract.** Validators ignore it; consumers
   should not.

## Source of truth

| Schema concept | Canonical source |
| --- | --- |
| State labels and transitions | `pr_state.ts` |
| Remediation labels, order, budgets | `remediation_policy_model.ts` |
| Annotation allowlist (15) | `pr-loop.ts` (`AGENT_ANNOTATION_LABELS`), mirrored in `pi/extensions/merge-god/index.ts` |
| Gate patterns | `label_gate_model.ts` |
| Intent semantics | `pr_loop_model.ts`, `pr-loop.ts`, README |

If the code and this schema disagree, the code wins — file an issue and update
the schema.
