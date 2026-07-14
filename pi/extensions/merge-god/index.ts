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

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentInteractionExecutor,
  createFetchCoordinationClient,
  type CoordinationClient,
} from "../../agent_interactions.ts";
import { PI_ACTIVITY_ACTIONS, PI_CONTEXT_VIEWS, PI_TOOL_NAMES } from "../../tool_contract.ts";

export interface MergeGodExtensionDependencies {
  client: CoordinationClient;
  randomId: () => string;
  now: () => Date;
  traceContext: () => Record<string, unknown>;
  traceparent: () => string | null;
}

function apiUrlFromEnvironment(): string {
  const url = process.env.MERGE_GOD_API;
  if (!url) {
    throw new Error(
      "MERGE_GOD_API is not set. merge-god sets it when launching pi with this extension.",
    );
  }
  return url.replace(/\/+$/, "");
}

interface RegisteredToolDefinition {
  name: string;
  label?: string;
  description?: string;
  promptGuidelines?: string[];
  parameters?: Record<string, unknown>;
  execute: (...args: any[]) => Promise<any>;
  [key: string]: unknown;
}

export function registerMergeGodPiExtension(
  pi: ExtensionAPI,
  dependencies: MergeGodExtensionDependencies,
): void {
  const { client, randomId, now, traceContext, traceparent } = dependencies;
  const executeInteraction = createAgentInteractionExecutor(client);
  const toolSurface: Array<Record<string, unknown>> = [];
  let surfaceRegistration: Promise<boolean> | null = null;
  const runtimePi = pi as unknown as {
    on?: (event: string, handler: (event: any) => Promise<void>) => void;
    getAllTools?: () => Array<Record<string, unknown>>;
    getActiveTools?: () => string[];
  };
  const supportsRuntimeTooling = typeof runtimePi.on === "function" &&
    typeof runtimePi.getAllTools === "function" && typeof runtimePi.getActiveTools === "function";
  const runtimeCallStarts = new Map<string, { started_at: string; started_ms: number }>();
  let currentTurnId: string | null = null;

  const publishToolSurface = (
    tools: Array<Record<string, unknown>>,
    scope: "extension" | "all-configured",
  ): Promise<boolean> => client.request({
    path: "/tool-surface",
    method: "POST",
    body: { tools, scope },
  }).then((response) => response.ok).catch(() => false);

  const ensureToolSurface = (): Promise<boolean> => {
    surfaceRegistration ??= publishToolSurface(toolSurface, "extension");
    return surfaceRegistration;
  };

  const reportToolCall = async (payload: Record<string, unknown>): Promise<boolean> => {
    await ensureToolSurface();
    return client.request({
      path: "/tool-call",
      method: "POST",
      body: payload,
    }).then((response) => response.ok).catch(() => false);
  };

  const reportAgentTurn = (payload: Record<string, unknown>): Promise<boolean> => client.request({
    path: "/agent-turn",
    method: "POST",
    body: payload,
  }).then((response) => response.ok).catch(() => false);

  if (supportsRuntimeTooling) {
    runtimePi.on!("session_start", async () => {
      const activeTools = new Set(runtimePi.getActiveTools!());
      const configuredTools = runtimePi.getAllTools!().map((tool) => ({
        name: tool["name"],
        label: tool["name"],
        description: tool["description"] ?? "",
        parameter_schema: tool["parameters"] ?? {},
        prompt_guideline_count: 0,
        active: activeTools.has(String(tool["name"] ?? "")),
        source_info: typeof tool["sourceInfo"] === "object" && tool["sourceInfo"] !== null
          ? tool["sourceInfo"]
          : {},
      }));
      surfaceRegistration = publishToolSurface(configuredTools, "all-configured");
      await surfaceRegistration;
    });
    runtimePi.on!("turn_start", async (event) => {
      const context = traceContext();
      currentTurnId = `${String(context["activity_session_id"] ?? "agent")}:turn:${event.turnIndex}`;
      await reportAgentTurn({
        phase: "started",
        turn_id: currentTurnId,
        turn_index: event.turnIndex,
        started_at: new Date(event.timestamp).toISOString(),
      });
    });
    runtimePi.on!("turn_end", async (event) => {
      const turnId = currentTurnId ?? `agent:turn:${event.turnIndex}`;
      await reportAgentTurn({
        phase: "completed",
        turn_id: turnId,
        turn_index: event.turnIndex,
      });
      currentTurnId = null;
    });
    runtimePi.on!("tool_execution_start", async (event) => {
      const startedAt = now().toISOString();
      runtimeCallStarts.set(event.toolCallId, { started_at: startedAt, started_ms: now().getTime() });
      await reportToolCall({
        phase: "started",
        call_id: event.toolCallId,
        tool_name: event.toolName,
        started_at: startedAt,
        input_keys: typeof event.args === "object" && event.args !== null ? Object.keys(event.args) : [],
        turn_id: currentTurnId,
      });
    });
    runtimePi.on!("tool_execution_end", async (event) => {
      const started = runtimeCallStarts.get(event.toolCallId);
      runtimeCallStarts.delete(event.toolCallId);
      const details = typeof event.result?.details === "object" && event.result.details !== null
        ? event.result.details as Record<string, unknown>
        : {};
      const failed = event.isError === true || details["ok"] === false;
      await reportToolCall({
        phase: "completed",
        call_id: event.toolCallId,
        tool_name: event.toolName,
        started_at: started?.started_at ?? now().toISOString(),
        duration_ms: started ? now().getTime() - started.started_ms : 0,
        success: !failed,
        error: failed
          ? String(details["error"] ?? details["status"] ?? "Pi reported a tool execution error")
          : null,
        turn_id: currentTurnId,
      });
    });
  }

  const registerTool = (definition: RegisteredToolDefinition): void => {
    toolSurface.push({
      name: definition.name,
      label: definition.label ?? definition.name,
      description: definition.description ?? "",
      parameter_schema: definition.parameters ?? {},
      prompt_guideline_count: definition.promptGuidelines?.length ?? 0,
    });
    const execute = definition.execute;
    pi.registerTool({
      ...definition,
      async execute(...args: any[]) {
        const [toolCallId, params] = args;
        const callId = typeof toolCallId === "string" && toolCallId.trim() ? toolCallId : randomId();
        const startedAt = now().toISOString();
        const startedMs = now().getTime();
        const inputKeys = typeof params === "object" && params !== null ? Object.keys(params) : [];
        const startReported = supportsRuntimeTooling ? true : await reportToolCall({
          phase: "started",
          call_id: callId,
          tool_name: definition.name,
          started_at: startedAt,
          input_keys: inputKeys,
        });
        try {
          const output = await execute(...args);
          const success = output?.details?.ok !== false;
          const completionReported = supportsRuntimeTooling ? true : await reportToolCall({
            phase: "completed",
            call_id: callId,
            tool_name: definition.name,
            started_at: startedAt,
            duration_ms: now().getTime() - startedMs,
            success,
            error: success ? null : String(output?.details?.error ?? output?.details?.status ?? "tool returned failure"),
          });
          return {
            ...output,
            details: {
              ...(typeof output?.details === "object" && output.details !== null ? output.details : {}),
              tool_call: {
                call_id: callId,
                traceparent: traceparent(),
                start_reported: startReported,
                completion_reported: completionReported,
                instrumentation_source: supportsRuntimeTooling ? "pi-runtime-events" : "extension-wrapper",
              },
            },
          };
        } catch (error) {
          if (!supportsRuntimeTooling) {
            await reportToolCall({
              phase: "completed",
              call_id: callId,
              tool_name: definition.name,
              started_at: startedAt,
              duration_ms: now().getTime() - startedMs,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
    } as any);
  };

  registerTool({
    name: PI_TOOL_NAMES.context,
    label: "merge-god context",
    description: "Read merge-god state. Use view=work first; trajectory, tooling, and health are compact diagnostics.",
    promptSnippet: "Read assigned work or current coordination state.",
    promptGuidelines: [
      `Start with ${PI_TOOL_NAMES.context} view=work; request other views only when needed.`,
    ],
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: [...PI_CONTEXT_VIEWS],
          description: "State to read. Defaults to work.",
        },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      return executeInteraction(PI_TOOL_NAMES.context, params);
    },
  } as any);

  registerTool({
    name: PI_TOOL_NAMES.activity,
    label: "merge-god activity",
    description: "Record observations and mutate durable trajectory state with an explicit action.",
    promptSnippet: "Record or change durable activity state.",
    promptGuidelines: [
      `Use ${PI_TOOL_NAMES.activity} only for durable checkpoints, meaningful observations, or lifecycle changes.`,
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...PI_ACTIVITY_ACTIONS],
          description: "Lifecycle mutation to perform.",
        },
        event_type: { type: "string", description: "Required for action=event." },
        actor: { type: "string" },
        payload: { type: "object", additionalProperties: true },
        refs: { type: "object", additionalProperties: true },
        phase: { type: "string", description: "Optional heartbeat phase." },
        next_action: { type: "string", description: "Required for action=propose." },
        rationale: { type: "string", description: "Required for action=propose." },
        blockers: { type: "array", items: { type: "object", additionalProperties: true } },
        evidence_refs: { type: "array", items: { type: "string" } },
        activity_type: { type: "string", description: "Required for action=create_child." },
        summary: { type: "string", description: "Required for child creation and closeout." },
        model_tier: { type: "string", enum: ["fast", "standard", "high"] },
        model_reason: { type: "string" },
        prompt_runtime_ref: { type: ["string", "null"] },
        context_pack_refs: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
        activity_id: { type: "string", description: "Required for action=close_activity." },
        success: { type: "boolean", description: "Required for action=close_activity." },
        error_message: { type: "string" },
        level: { type: "string", enum: ["debug", "info", "warning", "error"] },
        category: { type: "string", description: "Optional category for action=observe." },
        detail: { type: "string", description: "Optional detail for action=observe." },
        needs: { type: "array", items: { type: "string" } },
        signal_refs: { type: "array", items: { type: "string" } },
        grounding_refs: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        suggested_next: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      return executeInteraction(PI_TOOL_NAMES.activity, params);
    },
  } as any);

  registerTool({
    name: PI_TOOL_NAMES.follow_up,
    label: "merge-god follow-up PR",
    description:
      "Open an autonomous remediation pull request from the current isolated worktree. Requires concrete signal refs and project-doc grounding refs before merge-god will create the PR.",
    promptSnippet: "Open a merge-god follow-up remediation PR.",
    promptGuidelines: [
      "Use only for a separate scoped remediation with concrete signal_refs and grounding_refs.",
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
      return executeInteraction(PI_TOOL_NAMES.follow_up, params);
    },
  } as any);

  registerTool({
    name: PI_TOOL_NAMES.complete,
    label: "merge-god complete",
    description:
      "Report completion back to the merge-god coordination API. Call this once you have finished the work (or given up), with a status and a concise summary.",
    promptSnippet: "Report completion to merge-god.",
    promptGuidelines: [
      "Call exactly once with concise evidence-backed status; include only exact telemetry when available.",
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
                  "needs-ci",
                  "needs-rebase",
                  "needs-conflict-resolution",
                  "needs-review",
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
      return executeInteraction(PI_TOOL_NAMES.complete, params);
    },
  } as any);


  if (!supportsRuntimeTooling) void ensureToolSurface();
}

export function createMergeGodPiExtension(dependencies: MergeGodExtensionDependencies) {
  return (pi: ExtensionAPI): void => registerMergeGodPiExtension(pi, dependencies);
}

function traceContextFromEnvironment(): Record<string, unknown> {
  try {
    return process.env.MERGE_GOD_TRACE_CONTEXT
      ? JSON.parse(process.env.MERGE_GOD_TRACE_CONTEXT) as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function productionDependencies(): MergeGodExtensionDependencies {
  return {
    client: createFetchCoordinationClient({
      fetch: globalThis.fetch.bind(globalThis),
      baseUrl: apiUrlFromEnvironment,
    }),
    randomId: randomUUID,
    now: () => new Date(),
    traceContext: traceContextFromEnvironment,
    traceparent: () => process.env.MERGE_GOD_TRACEPARENT ?? null,
  };
}

export default function mergeGodPiExtension(pi: ExtensionAPI): void {
  registerMergeGodPiExtension(pi, productionDependencies());
}
