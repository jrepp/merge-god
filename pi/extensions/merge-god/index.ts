/**
 * merge-god pi extension.
 *
 * Connects the pi coding agent to the merge-god coordination API
 * (merge_god/coordination.py). merge-god publishes a work item — the gathered
 * prompt/context for a PR or issue — and these tools let the agent pull that
 * context and report results back, replacing the former `bob --json <prompt>`
 * subprocess contract.
 *
 * The coordination API URL is provided by merge-god via the MERGE_GOD_API
 * environment variable when it launches pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface WorkItem {
  kind?: string;
  repo?: string;
  repo_path?: string;
  pr_number?: number;
  issue_number?: number;
  mode?: string;
  title?: string;
  prompt: string;
  [key: string]: unknown;
}

interface CompleteInput {
  status?: string;
  summary?: string;
  model?: string;
  merged?: boolean;
  commits?: string[];
  error?: string;
  annotations?: {
    labels?: string[];
  };
  telemetry?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      total_tokens?: number;
      source?: string;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    total_tokens?: number;
    source?: string;
  };
}

interface TrajectoryEventInput {
  event_type?: string;
  actor?: string;
  payload?: Record<string, unknown>;
  refs?: Record<string, unknown>;
}

interface ProposedNextInput {
  next_action?: string;
  rationale?: string;
  blockers?: Record<string, unknown>[];
  evidence_refs?: string[];
}

interface ChildActivityInput {
  type?: string;
  summary?: string;
  prompt_runtime_ref?: string | null;
  context_pack_refs?: string[];
  evidence_refs?: string[];
  metadata?: Record<string, unknown>;
}

interface FollowUpPrInput {
  title?: string;
  body?: string;
  branch?: string;
  base?: string;
  linked_pr_number?: number;
  commit_message?: string;
  draft?: boolean;
  labels?: string[];
  signal_refs?: string[];
  grounding_refs?: string[];
  validation_refs?: string[];
}

interface ObservationInput {
  level?: "debug" | "info" | "warning" | "error";
  category?: string;
  summary?: string;
  detail?: string;
  needs?: string[];
  signal_refs?: string[];
  grounding_refs?: string[];
  confidence?: number;
  suggested_next?: string;
}

interface ApiResponse {
  ok: boolean;
  status: number;
  data: any;
}

function apiUrl(): string {
  const url = process.env.MERGE_GOD_API;
  if (!url) {
    throw new Error(
      "MERGE_GOD_API is not set. merge-god sets it when launching pi with this extension.",
    );
  }
  return url.replace(/\/+$/, "");
}

async function callApi(path: string, init?: RequestInit): Promise<ApiResponse> {
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function formatWorkItem(item: WorkItem): string {
  const lines: string[] = ["# merge-god work item", ""];
  const meta: string[] = [];
  if (item.repo) meta.push(`- **Repository:** ${item.repo}`);
  if (item.repo_path) meta.push(`- **Repo path:** ${item.repo_path}`);
  if (item.pr_number) meta.push(`- **PR:** #${item.pr_number}`);
  if (item.issue_number) meta.push(`- **Issue:** #${item.issue_number}`);
  if (item.mode) meta.push(`- **Mode:** ${item.mode}`);
  if (item.title) meta.push(`- **Title:** ${item.title}`);
  if (meta.length) {
    lines.push(...meta, "");
  }
  lines.push("## Prompt", "", item.prompt.trim() || "_(no prompt body)_");
  return lines.join("\n");
}

export default function mergeGodPiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "merge_god_context",
    label: "merge-god context",
    description:
      "Fetch the current merge-god work item (the PR/issue prompt and gathered context) from the merge-god coordination API. Call this first, before doing any work.",
    promptSnippet: "Load the current merge-god work item.",
    promptGuidelines: [
      "Call merge_god_context first to load the prompt/context for the work merge-god has assigned.",
      "Do the work in the isolated worktree named by repo_path with your file and shell tools, then report back with merge_god_complete.",
      "Only open autonomous remediation PRs when you have concrete signal refs and project-doc grounding refs.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      try {
        const { ok, status, data } = await callApi("/work");
        if (!ok || !data?.work) {
          return {
            content: [
              {
                type: "text",
                text: `No merge-god work item is currently available (HTTP ${status}).`,
              },
            ],
            details: { ok: false, status },
          };
        }
        const item = data.work as WorkItem;
        return {
          content: [{ type: "text", text: formatWorkItem(item) }],
          details: { ok: true, work_item: item },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_trajectory_state",
    label: "merge-god trajectory state",
    description:
      "Fetch the current durable merge-god trajectory state: run, worksets, work items, activities, activity sessions, and ordered events.",
    promptSnippet: "Inspect the current merge-god trajectory state.",
    promptGuidelines: [
      "Use this after merge_god_context when trajectory metadata is available.",
      "Use the returned run/work/activity state to plan the next bounded action and avoid relying only on chat history.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      try {
        const { ok, status, data } = await callApi("/trajectory");
        const text = ok
          ? JSON.stringify(data.trajectory, null, 2)
          : `No merge-god trajectory state is currently available (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god trajectory API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_trajectory_event",
    label: "merge-god trajectory event",
    description:
      "Append a structured event to the current merge-god trajectory for checkpoints, decisions, blockers, and evidence references.",
    promptSnippet: "Append a merge-god trajectory event.",
    promptGuidelines: [
      "Use concise event_type values such as decision.made, evidence.observed, blocker.found, or checkpoint.created.",
      "Payloads must be structured JSON with short summaries and artifact references, not long raw logs.",
      "Do not use this for every minor thought; reserve it for durable state that should survive the chat session.",
    ],
    parameters: {
      type: "object",
      properties: {
        event_type: {
          type: "string",
          description: "Structured event type, for example decision.made or evidence.observed.",
        },
        actor: {
          type: "string",
          description: "Event actor. Defaults to pi-agent.",
        },
        payload: {
          type: "object",
          description: "Structured event payload.",
          additionalProperties: true,
        },
        refs: {
          type: "object",
          description: "Optional run/work/activity refs when targeting a specific entity.",
          additionalProperties: true,
        },
      },
      required: ["event_type", "payload"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as TrajectoryEventInput;
      try {
        const { ok, status, data } = await callApi("/trajectory/event", {
          method: "POST",
          body: JSON.stringify({
            event_type: input.event_type,
            actor: input.actor ?? "pi-agent",
            payload: input.payload ?? {},
            refs: input.refs ?? {},
          }),
        });
        const text = ok
          ? `Trajectory event recorded: ${input.event_type}`
          : `Failed to record trajectory event (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god trajectory API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_heartbeat",
    label: "merge-god heartbeat",
    description:
      "Refresh the live trajectory heartbeat while a long-running pi activity owns the current work.",
    promptSnippet: "Send a merge-god trajectory heartbeat.",
    promptGuidelines: [
      "Use this during long-running work before expensive commands or after long pauses.",
      "Prefer merge_god_trajectory_event for durable decisions and evidence; heartbeat is only liveness.",
    ],
    parameters: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          description: "Current phase or activity label.",
        },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      try {
        const { ok, status, data } = await callApi("/trajectory/heartbeat", {
          method: "POST",
          body: JSON.stringify(params ?? {}),
        });
        const text = ok
          ? "merge-god trajectory heartbeat recorded."
          : `Failed to record heartbeat (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god trajectory API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_propose_next",
    label: "merge-god propose next",
    description:
      "Propose the next trajectory action for the current work item/activity. merge-god validates and records accepted or rejected proposals.",
    promptSnippet: "Propose the next merge-god trajectory action.",
    promptGuidelines: [
      "Use this when new information should change the trajectory, such as requesting a context refresh, creating a child activity, marking blocked, handing off, or completing.",
      "Always include a concise rationale grounded in observed state or evidence.",
      "This proposes a state transition; merge-god may reject it if policy or state does not allow it.",
    ],
    parameters: {
      type: "object",
      properties: {
        next_action: {
          type: "string",
          enum: [
            "continue",
            "request_context_refresh",
            "create_child_activity",
            "mark_blocked",
            "operator_handoff",
            "complete",
          ],
          description: "Requested next trajectory action.",
        },
        rationale: {
          type: "string",
          description: "Why this next action should be taken.",
        },
        blockers: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Structured blockers if any.",
        },
        evidence_refs: {
          type: "array",
          items: { type: "string" },
          description: "Evidence artifact refs supporting this proposal.",
        },
      },
      required: ["next_action", "rationale"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as ProposedNextInput;
      try {
        const { ok, status, data } = await callApi("/trajectory/propose-next", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const accepted = data?.proposal?.accepted;
        const text = ok
          ? `Next action proposal ${accepted ? "accepted" : "rejected"}: ${input.next_action}`
          : `Failed to propose next trajectory action (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god trajectory API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_create_child_activity",
    label: "merge-god child activity",
    description:
      "Create a bounded child activity under the current trajectory activity, such as CI diagnosis, CI fix, conflict resolution, merge gate, summary, or operator handoff.",
    promptSnippet: "Create a child trajectory activity.",
    promptGuidelines: [
      "Use this only when the current activity needs a scoped sub-context to proceed.",
      "Choose the narrowest valid activity type and include a concise summary of why it is needed.",
      "merge-god validates whether the child activity type is allowed under the current parent activity.",
    ],
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "ci_diagnosis",
            "ci_fix",
            "conflict_resolution",
            "merge_gate",
            "review_workflow",
            "salvage_planning",
            "embark_planning",
            "semantic_summary",
            "operator_handoff",
          ],
          description: "Child activity type.",
        },
        summary: {
          type: "string",
          description: "Why this child activity is needed and what it should accomplish.",
        },
        prompt_runtime_ref: {
          type: "string",
          description: "Optional prompt runtime reference for the child activity.",
        },
        context_pack_refs: {
          type: "array",
          items: { type: "string" },
          description: "Context packs the child activity should use.",
        },
        evidence_refs: {
          type: "array",
          items: { type: "string" },
          description: "Evidence refs that justify or seed the child activity.",
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Additional structured metadata.",
        },
      },
      required: ["type", "summary"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as ChildActivityInput;
      try {
        const { ok, status, data } = await callApi("/trajectory/child-activity", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const accepted = data?.activity?.accepted;
        const text = ok
          ? `Child activity ${accepted ? "created" : "rejected"}: ${input.type}`
          : `Failed to create child activity (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god trajectory API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_observe",
    label: "merge-god observe",
    description:
      "Send a structured live observation back to merge-god so the coordinator and TUI can show what pi knows, what signal it has, what it needs, and what it plans next.",
    promptSnippet: "Send a merge-god live observation.",
    promptGuidelines: [
      "Use this at major checkpoints: after loading context, before/after risky commands, when blocked, when signal is weak, or before opening a remediation PR.",
      "Keep summary short enough for a dashboard row.",
      "Use signal_refs for concrete evidence and grounding_refs for docs/rules/workflow refs.",
      "Use needs to name missing context, credentials, logs, or user decisions.",
    ],
    parameters: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["debug", "info", "warning", "error"],
          description: "Observation severity.",
        },
        category: {
          type: "string",
          description: "Short category such as context, signal, validation, remediation, blocked, or next.",
        },
        summary: {
          type: "string",
          description: "Short dashboard-safe summary.",
        },
        detail: {
          type: "string",
          description: "Optional longer detail.",
        },
        needs: {
          type: "array",
          items: { type: "string" },
          description: "Missing information or action needed from merge-god/user.",
        },
        signal_refs: {
          type: "array",
          items: { type: "string" },
          description: "Evidence refs observed so far.",
        },
        grounding_refs: {
          type: "array",
          items: { type: "string" },
          description: "Project docs/rules/workflow refs used for grounding.",
        },
        confidence: {
          type: "number",
          description: "Optional confidence from 0 to 1.",
        },
        suggested_next: {
          type: "string",
          description: "Suggested next action.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as ObservationInput;
      try {
        const { ok, status, data } = await callApi("/observation", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const text = ok
          ? `Observation recorded: ${input.summary}`
          : `Failed to record observation (HTTP ${status}): ${data?.error ?? "unknown error"}`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_debug_snapshot",
    label: "merge-god debug snapshot",
    description:
      "Fetch the current coordination debug snapshot: work item, observations already sent, available merge-god tools, and worktree path.",
    promptSnippet: "Fetch merge-god coordination debug snapshot.",
    promptGuidelines: [
      "Use this when unsure whether you have enough context or when diagnosing why merge-god coordination tools are not behaving as expected.",
      "Do not use this as a substitute for merge_god_context; use it for diagnostics.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      try {
        const { ok, status, data } = await callApi("/debug");
        const text = ok
          ? JSON.stringify(data, null, 2)
          : `No merge-god debug snapshot available (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_open_follow_up_pr",
    label: "merge-god follow-up PR",
    description:
      "Open an autonomous remediation pull request from the current isolated worktree. Requires concrete signal refs and project-doc grounding refs before merge-god will create the PR.",
    promptSnippet: "Open a merge-god follow-up remediation PR.",
    promptGuidelines: [
      "Use this only for a separate bug fix or remediation discovered while doing assigned merge-god work.",
      "Provide signal_refs such as failing command output, CI check URLs, review comments, issue URLs, stack traces, or repro artifacts.",
      "Provide grounding_refs from project docs, AGENTS.md, .merge-rules.yaml, or Workflow-IR docs that justify the remediation scope.",
      "Keep the change narrowly scoped and include validation_refs when you ran checks.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Pull request title.",
        },
        body: {
          type: "string",
          description: "Pull request body. Include a short signal/grounding/validation summary.",
        },
        branch: {
          type: "string",
          description: "Optional branch name. Defaults to a merge-god generated branch.",
        },
        base: {
          type: "string",
          description: "Optional base branch. Defaults to the current work item base branch or main.",
        },
        linked_pr_number: {
          type: "number",
          description: "Optional PR number this underlying remediation PR should link back to. Defaults to the current work item PR.",
        },
        commit_message: {
          type: "string",
          description: "Optional commit message. Defaults to the PR title.",
        },
        draft: {
          type: "boolean",
          description: "Create the PR as a draft.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional labels to apply.",
        },
        signal_refs: {
          type: "array",
          items: { type: "string" },
          description: "Required concrete signals that justify remediation.",
        },
        grounding_refs: {
          type: "array",
          items: { type: "string" },
          description: "Required project docs/rules/workflow refs grounding the remediation.",
        },
        validation_refs: {
          type: "array",
          items: { type: "string" },
          description: "Validation command refs or artifact refs.",
        },
      },
      required: ["title", "signal_refs", "grounding_refs"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as FollowUpPrInput;
      try {
        const { ok, status, data } = await callApi("/follow-up-pr", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const url = data?.follow_up_pr?.url;
        const text = ok
          ? `Follow-up remediation PR opened: ${url || input.title}`
          : `Failed to open follow-up remediation PR (HTTP ${status}): ${data?.error ?? "unknown error"}`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_complete",
    label: "merge-god complete",
    description:
      "Report completion back to the merge-god coordination API. Call this once you have finished the work (or given up), with a status and a concise summary.",
    promptSnippet: "Report completion to merge-god.",
    promptGuidelines: [
      "Call merge_god_complete exactly once when done, with status 'success' or 'failure' and a concise summary.",
      "Include commit SHAs and whether the PR was merged when known.",
      "When useful, include annotations.labels with semantic PR labels from the allowed set: large, too-large, unaligned, needs-split, needs-design, high-risk, low-risk, docs-only, test-only, embark-candidate, underlying-needed.",
      "Use annotation labels sparingly and only when the observed PR context makes the label obvious.",
      "Include a telemetry object with the exact model identifier and provider usage when available.",
      "When provider usage is available, include exact token counts in telemetry.usage: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens, and source.",
      "Do not estimate token usage; omit telemetry.usage when exact counts are unavailable.",
    ],
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["success", "failure"],
          description: "Whether the work succeeded.",
        },
        summary: {
          type: "string",
          description: "A concise summary of what was done.",
        },
        model: {
          type: "string",
          description: "Exact model identifier used for this run, when known.",
        },
        merged: {
          type: "boolean",
          description: "Whether the PR was merged (if applicable).",
        },
        commits: {
          type: "array",
          items: { type: "string" },
          description: "Commit SHAs produced, if any.",
        },
        error: {
          type: "string",
          description: "Error details, when status is 'failure'.",
        },
        annotations: {
          type: "object",
          description: "Optional semantic PR annotations requested by the agent.",
          properties: {
            labels: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "large",
                  "too-large",
                  "unaligned",
                  "needs-split",
                  "needs-design",
                  "high-risk",
                  "low-risk",
                  "docs-only",
                  "test-only",
                  "embark-candidate",
                  "underlying-needed",
                ],
              },
              description: "Allowlisted semantic labels to add to the PR when clearly supported by the context.",
            },
          },
          additionalProperties: false,
        },
        telemetry: {
          type: "object",
          description: "Exact completion telemetry for this merge-god run.",
          properties: {
            model: {
              type: "string",
              description: "Exact model identifier used for this run, when known.",
            },
            usage: {
              type: "object",
              description: "Exact provider token usage for this merge-god run. Omit when unavailable; do not estimate.",
              properties: {
                input_tokens: {
                  type: "number",
                  description: "Exact input tokens consumed.",
                },
                output_tokens: {
                  type: "number",
                  description: "Exact output tokens consumed.",
                },
                cache_creation_input_tokens: {
                  type: "number",
                  description: "Exact cache creation input tokens, when reported by the provider.",
                },
                cache_read_input_tokens: {
                  type: "number",
                  description: "Exact cache read input tokens, when reported by the provider.",
                },
                total_tokens: {
                  type: "number",
                  description: "Exact total tokens consumed, when reported by the provider.",
                },
                source: {
                  type: "string",
                  description: "Usage source, for example pi usage metadata or provider response usage.",
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        usage: {
          type: "object",
          description: "Deprecated compatibility alias for telemetry.usage.",
          properties: {
            input_tokens: {
              type: "number",
              description: "Exact input tokens consumed.",
            },
            output_tokens: {
              type: "number",
              description: "Exact output tokens consumed.",
            },
            cache_creation_input_tokens: {
              type: "number",
              description: "Exact cache creation input tokens, when reported by the provider.",
            },
            cache_read_input_tokens: {
              type: "number",
              description: "Exact cache read input tokens, when reported by the provider.",
            },
            total_tokens: {
              type: "number",
              description: "Exact total tokens consumed, when reported by the provider.",
            },
            source: {
              type: "string",
              description: "Usage source, for example pi usage metadata or provider response usage.",
            },
          },
          additionalProperties: false,
        },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as CompleteInput;
      try {
        const { ok, status, data } = await callApi("/result", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const text = ok
          ? `Result recorded by merge-god (${input.status}): ${input.summary}`
          : `Failed to record result with merge-god (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_health",
    label: "merge-god health",
    description: "Check that the merge-god coordination API is reachable. Useful for debugging connectivity.",
    promptSnippet: "Check merge-god coordination API health.",
    promptGuidelines: [
      "Use merge_god_health only to diagnose connectivity, not as part of normal PR processing.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      try {
        const { ok, status, data } = await callApi("/health");
        return {
          content: [
            { type: "text", text: ok ? `merge-god coordination API is healthy (HTTP ${status}).` : `Unhealthy (HTTP ${status}).` },
          ],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Cannot reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);
}
