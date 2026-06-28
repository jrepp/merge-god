# merge-god pi extension

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that connects
the pi coding agent to the **merge-god coordination API**.

merge-god no longer shells out to an external agent command. Instead it publishes
a *work item* (the gathered prompt/context for a PR or issue) to a tiny local
coordination server (`merge_god/coordination.py`), and launches pi with this
extension. The extension exposes tools that let pi pull that context and report
results back.

## Tools

| Tool | Description |
| --- | --- |
| `merge_god_context` | Fetch the current work item (prompt/context) from the coordination API. Call first. |
| `merge_god_complete` | Report completion (`success`/`failure`, summary, commits, merged) back to merge-god. |
| `merge_god_health` | Diagnose connectivity to the coordination API. |

## How it connects

```text
merge-god (pr-loop)                       pi + this extension
─────────────────────                     ────────────────────
 gather PR/issue context
 run coordination server  ──── /work ───▶ merge_god_context   (pulls prompt)
 (MERGE_GOD_API env)       ◀── /result ── merge_god_complete  (reports back)
```

The coordination API URL is passed to pi via the `MERGE_GOD_API` environment
variable; the extension reads it at runtime.

## Run it

merge-god wires this up automatically — see `merge_god/coordination.py`
(`run_pi_agent`). To use the extension manually in pi:

```bash
# from the merge-god repo root
export MERGE_GOD_API=http://127.0.0.1:7780
python coordination.py --demo        # publishes a demo work item on :7780
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
