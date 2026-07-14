# merge-god pi extension

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that connects
the pi coding agent to the **merge-god coordination API**.

merge-god no longer shells out to an external agent command. Instead it publishes
a *work item* (the gathered prompt/context for a PR or issue) to a tiny local
coordination server (`coordination.ts`), and launches pi with this
extension. The extension exposes tools that let pi pull that context and report
results back.

## Tools

| Tool | Description |
| --- | --- |
| `mg_context` | Read `work`, compact `trajectory`, full `trajectory_full`, `tooling`, or `health` state. Call `view=work` first. |
| `mg_activity` | Observe progress, record lifecycle events, or create and close child activities. |
| `mg_follow_up` | Open a grounded, evidence-backed remediation PR. |
| `mg_complete` | Report completion (`success`/`failure`, summary, commits, merged) back to merge-god. |

## How it connects

```text
merge-god (pr-loop)                       pi + this extension
─────────────────────                     ────────────────────
 gather PR/issue context
 run coordination server  ──── /work ───▶ mg_context   (pulls prompt)
 compact/full state       ─ /trajectory/* ▶ mg_context
 lifecycle mutations     ◀─ /trajectory/* ─ mg_activity
 turn + tool hierarchy   ◀─ /agent-turn + /tool-call
tool manifest + calls    ◀─ /tool-surface + /tool-call
 (MERGE_GOD_API env)       ◀── /result ── mg_complete  (reports back)
```

The coordination API URL is passed to pi via the `MERGE_GOD_API` environment
variable; the extension reads it at runtime. `MERGE_GOD_TRACEPARENT` and
`MERGE_GOD_TRACE_CONTEXT` connect tool-call measurements to the parent agent
span and durable trajectory identifiers.

`pi/tool_contract.ts` is the single source for tool names, views, activity
actions, and the compact startup instruction. `buildPiExtensionInjection` in
`coordination.ts` creates the CLI arguments, environment, expected tool list,
and trace context as one injection plan. `pi/agent_interactions.ts` implements
the functional `plan → execute(client) → interpret` core. The extension itself
is created from an explicit client, clock, ID source, and trace readers; only
the production adapter reads environment or global fetch state.

On current Pi versions, the extension reads the complete configured and active
tool registries at session start, including built-in file and shell tools and
extension-provided tools. Pi's tool-execution lifecycle events produce paired
start/completion records with duration and outcome. A measured registration
wrapper provides the same coverage for older or forked Pi runtimes without
those APIs. Parameter names are recorded for surface analysis, but parameter
values are not. The live `/tooling` endpoint exposes source metadata, active
state, call counts, failures, incomplete calls, and a completion ratio; the
same call events are appended to the durable trajectory when one is active.

Trajectory reads project internal statuses into an external hierarchy:
run → workset → work item → activity → session → agent turn → tool call. Each
node has an `open`, `closed`, `blocked`, `failed`, or `canceled` state. The
compact trajectory view also returns a resume cursor. A restarted PR agent
reuses an unfinished trajectory, reconciles abandoned turn/tool leaves, and
opens a replacement activity session instead of creating an unrelated run.

## Run it

merge-god wires this up automatically — see `coordination.ts`
(`run_pi_agent`). To use the extension manually in pi:

```bash
# from the merge-god repo root
export MERGE_GOD_API=http://127.0.0.1:7780
npx tsx coordination.ts --demo       # publishes a demo work item on :7780
pi --extension ./pi/extensions/merge-god/index.ts "process the merge-god work item"
```

Or install it as a pi package:

```bash
pi install ./pi          # project-local
pi list                  # verify
```

## Layout

```text
pi/
├── package.json                          # pi package manifest (declares the extension)
└── extensions/merge-god/index.ts         # default-exports the extension (registers tools)
```

The extension is TypeScript; pi resolves the `@earendil-works/pi-coding-agent`
peer dependency at runtime.
