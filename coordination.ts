/**
 * merge-god coordination API and pi agent runner.
 *
 * Ported from coordination.py. Bridges merge-god (the orchestrator) with the pi
 * coding agent via the merge-god pi extension (pi/extensions/merge-god).
 *
 * merge-god pushes a *work item* — the gathered prompt/context for a PR or
 * issue — to a tiny local HTTP server. The pi extension's tools
 * (`mg_context`, `mg_complete`) pull that work item and report
 * results back over the same HTTP API. This replaces the former
 * `bob --json <prompt>` subprocess contract.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFollowUpPrBody,
  defaultFollowUpBranch,
  followUpBaseBranch,
  linkedPrNumber,
  normalizeFollowUpPrInput,
  stringArray,
} from "./follow_up_pr_model";
import { GitOps, type GitOpsObserver } from "./git_ops";
import { PI_AGENT_INSTRUCTION, PI_TOOL_SURFACE } from "./pi/tool_contract";
import {
  recordAgentRun,
  recordPiToolCall,
  recordPromptRendered,
  sanitizeSpanAttributes,
  withTelemetrySpan,
} from "./telemetry";
import {
  childActivityBodySchema,
  closeActivityBodySchema,
  CoordinationBodyError,
  parseCoordinationBody,
  trajectoryEventBodySchema,
  trajectoryProposalBodySchema,
} from "./schemas/coordination";

export interface WorkItem {
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

export type JsonResult = Record<string, unknown> | null;

export interface TrajectoryEventInput {
  event_type: string;
  actor?: string;
  payload?: Record<string, unknown>;
  refs?: Record<string, unknown>;
}

export interface CoordinationTrajectoryBridge {
  getState(): unknown | Promise<unknown>;
  appendEvent(input: TrajectoryEventInput): unknown | Promise<unknown>;
  heartbeat?(input: Record<string, unknown>): unknown | Promise<unknown>;
  proposeNext?(input: {
    next_action: string;
    rationale: string;
    blockers?: Record<string, unknown>[];
    evidence_refs?: string[];
  }): unknown | Promise<unknown>;
  createChildActivity?(input: {
    type: string;
    summary: string;
    model_tier?: string;
    model_reason?: string;
    prompt_runtime_ref?: string | null;
    context_pack_refs?: string[];
    evidence_refs?: string[];
    metadata?: Record<string, unknown>;
  }): unknown | Promise<unknown>;
  closeActivity?(input: {
    activity_id: string;
    success: boolean;
    summary: string;
    error_message?: string | null;
  }): unknown | Promise<unknown>;
}

export type { FollowUpPrInput } from "./follow_up_pr_model";

export interface FollowUpPrResult {
  title: string;
  branch: string;
  base: string;
  url: string;
  commit: string | null;
  linked_pr_number: number | null;
  signal_refs: string[];
  grounding_refs: string[];
  validation_refs: string[];
}

export interface AgentObservationInput {
  level?: "debug" | "info" | "warning" | "error";
  category?: string;
  summary: string;
  detail?: string;
  needs?: string[];
  signal_refs?: string[];
  grounding_refs?: string[];
  confidence?: number;
  suggested_next?: string;
}

export interface AgentObservation extends AgentObservationInput {
  level: "debug" | "info" | "warning" | "error";
  category: string;
  timestamp: string;
}

export interface PiToolSurfaceEntry {
  name: string;
  label: string;
  description: string;
  parameter_schema: Record<string, unknown>;
  prompt_guideline_count: number;
  active: boolean;
  source_info: Record<string, unknown>;
}

export interface PiToolCallMeasurement {
  call_id: string;
  tool_name: string;
  status: "started" | "succeeded" | "failed" | "incomplete";
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  input_keys: string[];
  error: string | null;
  turn_id: string | null;
  lifecycle_anomalies: string[];
}

export interface PiAgentTurnMeasurement {
  turn_id: string;
  turn_index: number;
  status: "started" | "completed" | "interrupted";
  started_at: string;
  completed_at: string | null;
  tool_call_ids: string[];
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost?: number | null;
  usage_source?: string | null;
  cost_source?: string | null;
}

export interface PiAgentProgress {
  action: "agent_started" | "tool_started" | "tool_completed";
  tool?: string;
  success?: boolean;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normalize exact provider telemetry reported through mg_complete. */
export function piAgentCompletionTelemetry(
  result: JsonResult,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  tooling: PiToolingSnapshot,
): Record<string, unknown> {
  const resultRecord = recordValue(result);
  const telemetry = recordValue(resultRecord["telemetry"]);
  const telemetryUsage = recordValue(telemetry["usage"]);
  const legacyUsage = recordValue(resultRecord["usage"]);
  const usage = Object.keys(telemetryUsage).length > 0
    ? telemetryUsage
    : Object.keys(legacyUsage).length > 0 ? legacyUsage : resultRecord;
  const inputTokens = nonNegativeNumber(usage["input_tokens"]);
  const outputTokens = nonNegativeNumber(usage["output_tokens"]);
  const explicitTotal = nonNegativeNumber(usage["total_tokens"]);
  const totalTokens = explicitTotal ?? (inputTokens !== null || outputTokens !== null
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : null);
  const estimatedCost = nonNegativeNumber(usage["cost_usd"])
    ?? nonNegativeNumber(usage["estimated_cost"])
    ?? nonNegativeNumber(telemetry["cost_usd"])
    ?? nonNegativeNumber(telemetry["estimated_cost"]);
  const model = [usage["model"], telemetry["model"], resultRecord["model"]]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    status: typeof resultRecord["status"] === "string" ? resultRecord["status"] : "unknown",
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, durationMs),
    model: model?.trim() ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: nonNegativeNumber(usage["cache_creation_input_tokens"]),
    cache_read_input_tokens: nonNegativeNumber(usage["cache_read_input_tokens"]),
    total_tokens: totalTokens,
    estimated_cost: estimatedCost,
    usage_source: typeof usage["source"] === "string" ? usage["source"] : null,
    cost_source: estimatedCost === null
      ? null
      : typeof usage["cost_source"] === "string" ? usage["cost_source"] : "provider-reported",
    turn_count: tooling.turns.length,
    tool_call_count: tooling.reliability.started,
    tool_call_failure_count: tooling.reliability.failed,
    tool_call_incomplete_count: tooling.reliability.incomplete,
    tool_call_protocol_error_count: tooling.reliability.protocol_errors,
    tool_call_completion_ratio: tooling.reliability.completion_ratio,
  };
}

/** Reduce pi's verbose JSON event stream to safe, operator-facing progress. */
export function piAgentProgressFromRuntimeEvent(value: unknown): PiAgentProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (event["type"] === "agent_start") return { action: "agent_started" };
  if (event["type"] === "tool_execution_start" && typeof event["toolName"] === "string") {
    return { action: "tool_started", tool: event["toolName"] };
  }
  if (event["type"] === "tool_execution_end" && typeof event["toolName"] === "string") {
    const result = typeof event["result"] === "object" && event["result"] !== null
      ? event["result"] as Record<string, unknown>
      : {};
    return {
      action: "tool_completed",
      tool: event["toolName"],
      success: result["isError"] !== true,
    };
  }
  return null;
}

export interface PiToolingSnapshot {
  injection: {
    method: "pi-cli-extension";
    extension_path: string | null;
    surface_scope: "extension" | "all-configured";
  };
  surface: PiToolSurfaceEntry[];
  turns: PiAgentTurnMeasurement[];
  calls: PiToolCallMeasurement[];
  reliability: {
    started: number;
    completed: number;
    succeeded: number;
    failed: number;
    incomplete: number;
    protocol_errors: number;
    completion_ratio: number;
  };
}

export interface AgentTraceContext {
  trace_id: string;
  parent_span_id: string;
  traceparent: string;
  run_id?: string;
  workset_id?: string;
  work_item_id?: string;
  activity_id?: string;
  activity_session_id?: string | null;
}

/** Locate the merge-god pi extension entry, walking up from this file. */
export function findExtension(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const startCwd = process.cwd();
  const candidates = [
    here,
    ...parents(here),
    startCwd,
    ...parents(startCwd),
  ];
  for (const base of candidates) {
    const candidate = path.join(base, "pi", "extensions", "merge-god", "index.ts");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find the merge-god pi extension at pi/extensions/merge-god/index.ts. " +
      "Run from the merge-god repository or set MERGE_GOD_EXTENSION.",
  );
}

export interface PiExtensionInjectionPlan {
  method: "pi-cli-extension";
  extension_path: string;
  expected_tools: string[];
  cli_args: string[];
  environment: Record<string, string>;
}

export function buildPiExtensionInjection(input: {
  extension_path: string;
  api_url: string;
  trace_context: AgentTraceContext;
  instruction: string;
}): PiExtensionInjectionPlan {
  return {
    method: "pi-cli-extension",
    extension_path: input.extension_path,
    expected_tools: [...PI_TOOL_SURFACE],
    cli_args: [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--extension",
      input.extension_path,
      input.instruction,
    ],
    environment: {
      MERGE_GOD_API: input.api_url,
      MERGE_GOD_TRACEPARENT: input.trace_context.traceparent,
      MERGE_GOD_TRACE_CONTEXT: JSON.stringify(input.trace_context),
    },
  };
}

function* parents(dir: string): Generator<string> {
  let current = dir;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    yield parent;
    current = parent;
  }
}

/**
 * A tiny in-memory coordination API served over localhost HTTP.
 *
 * Holds a single current work item and the result reported by the agent. Node
 * is single-threaded, so no lock is required (unlike the Python version).
 * Intended to run for the duration of one agent invocation.
 */
export class CoordinationServer {
  private _work: WorkItem | null = null;
  private _result: JsonResult = null;
  private _observations: AgentObservation[] = [];
  private _server: http.Server;
  private _trajectory: CoordinationTrajectoryBridge | null;
  private _repoPath: string | null;
  private _gitObserver: GitOpsObserver | null;
  private _agentObserver: ((observation: AgentObservation) => void) | null;
  private _resultListeners = new Set<(result: Record<string, unknown>) => void>();
  private _toolSurface: PiToolSurfaceEntry[] = [];
  private _toolCalls = new Map<string, PiToolCallMeasurement>();
  private _agentTurns = new Map<string, PiAgentTurnMeasurement>();
  private _extensionPath: string | null = null;
  private _toolSurfaceScope: "extension" | "all-configured" = "extension";
  private _traceContext: AgentTraceContext | null = null;
  host: string;
  port: number;

  constructor(
    host = "127.0.0.1",
    port = 0,
    trajectory: CoordinationTrajectoryBridge | null = null,
    repoPath: string | null = null,
    gitObserver: GitOpsObserver | null = null,
    agentObserver: ((observation: AgentObservation) => void) | null = null,
  ) {
    this._server = http.createServer((req, res) => this._handleRequest(req, res));
    // Synchronously grab a port by listening; we use the returned address below.
    // Note: listen() is async, but server.address() is populated by the time the
    // 'listening' event fires. We block on that using a synchronous spawn is not
    // possible; instead callers should `await server.start()`.
    this.host = host;
    this.port = port;
    this._trajectory = trajectory;
    this._repoPath = repoPath;
    this._gitObserver = gitObserver;
    this._agentObserver = agentObserver;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this._server.listen(this.port, this.host, () => {
        const addr = this._server.address() as AddressInfo;
        this.host = addr.address;
        this.port = addr.port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  setWork(item: WorkItem): void {
    this._work = item;
    this._result = null;
  }

  getWork(): WorkItem | null {
    return this._work;
  }

  setResult(result: Record<string, unknown>): void {
    this._result = result;
    for (const listener of this._resultListeners) listener(result);
  }

  getResult(): JsonResult {
    return this._result;
  }

  onResult(listener: (result: Record<string, unknown>) => void): () => void {
    this._resultListeners.add(listener);
    if (this._result !== null) queueMicrotask(() => listener(this._result!));
    return () => this._resultListeners.delete(listener);
  }

  setTrajectoryBridge(trajectory: CoordinationTrajectoryBridge | null): void {
    this._trajectory = trajectory;
  }

  setAgentTraceContext(traceContext: AgentTraceContext, extensionPath: string): void {
    this._traceContext = traceContext;
    this._extensionPath = extensionPath;
  }

  getToolingSnapshot(): PiToolingSnapshot {
    const calls = [...this._toolCalls.values()];
    const succeeded = calls.filter((call) => call.status === "succeeded").length;
    const failed = calls.filter((call) => call.status === "failed").length;
    const completed = succeeded + failed;
    const incomplete = calls.filter((call) => call.status === "started" || call.status === "incomplete").length;
    const protocolErrors = calls.reduce((count, call) => count + call.lifecycle_anomalies.length, 0);
    return {
      injection: {
        method: "pi-cli-extension",
        extension_path: this._extensionPath,
        surface_scope: this._toolSurfaceScope,
      },
      surface: [...this._toolSurface],
      turns: [...this._agentTurns.values()],
      calls,
      reliability: {
        started: calls.length,
        completed,
        succeeded,
        failed,
        incomplete,
        protocol_errors: protocolErrors,
        completion_ratio: calls.length === 0 ? 1 : completed / calls.length,
      },
    };
  }

  async finalizeToolCalls(): Promise<void> {
    for (const call of this._toolCalls.values()) {
      if (call.status !== "started") continue;
      call.status = "incomplete";
      const durationMs = Math.max(0, Date.now() - Date.parse(call.started_at));
      call.duration_ms = durationMs;
      call.completed_at = new Date().toISOString();
      call.error = "Pi process exited before the extension reported tool completion";
      recordPiToolCall(call.tool_name, false, durationMs, {
        "merge_god.tool_call_id": call.call_id,
        "merge_god.tool_call_incomplete": true,
        "merge_god.run_id": this._traceContext?.run_id,
        "merge_god.activity_id": this._traceContext?.activity_id,
      }, this._traceContext?.traceparent, Date.parse(call.started_at));
      if (this._trajectory) {
        await Promise.resolve(this._trajectory.appendEvent({
          event_type: "pi.tool_call.incomplete",
          actor: "merge-god",
          payload: { ...call, trace_context: this._traceContext },
        }));
      }
    }
    for (const turn of this._agentTurns.values()) {
      if (turn.status !== "started") continue;
      turn.status = "interrupted";
      turn.completed_at = new Date().toISOString();
      if (this._trajectory) {
        await Promise.resolve(this._trajectory.appendEvent({
          event_type: "pi.agent_turn.interrupted",
          actor: "merge-god",
          payload: { ...turn, trace_context: this._traceContext },
        }));
      }
    }
  }

  setRepoPath(repoPath: string | null): void {
    this._repoPath = repoPath;
  }

  getObservations(): AgentObservation[] {
    return [...this._observations];
  }

  private _send(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  private async _readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    try {
      const data = JSON.parse(raw);
      return typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : { data };
    } catch {
      return { raw };
    }
  }

  private _handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "GET") {
      if (url === "/health") {
        this._send(res, 200, { ok: true, service: "merge-god-coordination" });
        return;
      }
      if (url === "/work") {
        const work = this.getWork();
        if (work === null) {
          this._send(res, 404, { ok: false, error: "no work item" });
        } else {
          this._send(res, 200, { ok: true, work });
        }
        return;
      }
      if (url === "/trajectory") {
        const fallback = this.getWork()?.["trajectory"] ?? null;
        if (!this._trajectory && fallback === null) {
          this._send(res, 404, { ok: false, error: "no trajectory state" });
          return;
        }
        Promise.resolve(this._trajectory ? this._trajectory.getState() : fallback)
          .then((trajectory) => this._send(res, 200, { ok: true, trajectory }))
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/trajectory/summary") {
        const fallback = this.getWork()?.["trajectory"] ?? null;
        if (!this._trajectory && fallback === null) {
          this._send(res, 404, { ok: false, error: "no trajectory state" });
          return;
        }
        Promise.resolve(this._trajectory ? this._trajectory.getState() : fallback)
          .then((trajectory) => this._send(res, 200, { ok: true, trajectory: compactTrajectoryState(trajectory) }))
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/debug") {
        this._send(res, 200, {
          ok: true,
          work: this.getWork(),
          observations: this.getObservations(),
          trace_context: this._traceContext,
          tooling: this.getToolingSnapshot(),
          capabilities: { tools: this._toolSurface.map((tool) => tool.name), worktree_path: this._repoPath },
        });
        return;
      }
      if (url === "/tooling") {
        this._send(res, 200, { ok: true, trace_context: this._traceContext, tooling: this.getToolingSnapshot() });
        return;
      }
      this._send(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (req.method === "POST") {
      if (url === "/result") {
        this._readBody(req)
          .then((body) => {
            this.setResult(body);
            this._send(res, 200, { ok: true });
          })
          .catch(() => this._send(res, 400, { ok: false, error: "bad request" }));
        return;
      }
      if (url === "/observation") {
        this._readBody(req)
          .then((body) => this._recordObservation(body))
          .then((observation) => this._send(res, 200, { ok: true, observation }))
          .catch((err: unknown) => this._send(res, 400, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/trajectory/event") {
        if (!this._trajectory) {
          this._send(res, 404, { ok: false, error: "no trajectory bridge" });
          return;
        }
        this._readBody(req)
          .then((body) => {
            const input = parseCoordinationBody(trajectoryEventBodySchema, body);
            return Promise.resolve(
              this._trajectory!.appendEvent({
                event_type: input.event_type,
                actor: input.actor,
                payload: input.payload,
                refs: input.refs,
              }),
            ).then((event) => this._send(res, 200, { ok: true, event }));
          })
          .catch((err: unknown) => this._send(
            res,
            err instanceof CoordinationBodyError ? 400 : 500,
            { ok: false, error: String(err) },
          ));
        return;
      }
      if (url === "/trajectory/heartbeat") {
        if (!this._trajectory?.heartbeat) {
          this._send(res, 404, { ok: false, error: "no trajectory heartbeat bridge" });
          return;
        }
        this._readBody(req)
          .then((body) => Promise.resolve(this._trajectory!.heartbeat!(body)))
          .then((heartbeat) => this._send(res, 200, { ok: true, heartbeat }))
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/trajectory/propose-next") {
        if (!this._trajectory?.proposeNext) {
          this._send(res, 404, { ok: false, error: "no trajectory propose-next bridge" });
          return;
        }
        this._readBody(req)
          .then((body) => {
            const input = parseCoordinationBody(trajectoryProposalBodySchema, body);
            return Promise.resolve(
              this._trajectory!.proposeNext!(input),
            ).then((proposal) => this._send(res, 200, { ok: true, proposal }));
          })
          .catch((err: unknown) => this._send(
            res,
            err instanceof CoordinationBodyError ? 400 : 500,
            { ok: false, error: String(err) },
          ));
        return;
      }
      if (url === "/trajectory/child-activity") {
        if (!this._trajectory?.createChildActivity) {
          this._send(res, 404, { ok: false, error: "no trajectory child-activity bridge" });
          return;
        }
        this._readBody(req)
          .then((body) => {
            const input = parseCoordinationBody(childActivityBodySchema, body);
            return Promise.resolve(
              this._trajectory!.createChildActivity!(input),
            ).then((activity) => this._send(res, 200, { ok: true, activity }));
          })
          .catch((err: unknown) => this._send(
            res,
            err instanceof CoordinationBodyError ? 400 : 500,
            { ok: false, error: String(err) },
          ));
        return;
      }
      if (url === "/trajectory/close-activity") {
        if (!this._trajectory?.closeActivity) {
          this._send(res, 404, { ok: false, error: "no trajectory close-activity bridge" });
          return;
        }
        this._readBody(req)
          .then((body) => {
            const input = parseCoordinationBody(closeActivityBodySchema, body);
            return Promise.resolve(this._trajectory!.closeActivity!(input))
              .then((activity) => this._send(res, 200, { ok: true, activity }));
          })
          .catch((err: unknown) => this._send(
            res,
            err instanceof CoordinationBodyError ? 400 : 500,
            { ok: false, error: String(err) },
          ));
        return;
      }
      if (url === "/tool-surface") {
        this._readBody(req)
          .then((body) => this._recordToolSurface(body))
          .then((tooling) => this._send(res, 200, { ok: true, tooling }))
          .catch((err: unknown) => this._send(res, 400, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/tool-call") {
        this._readBody(req)
          .then((body) => this._recordToolCall(body))
          .then((measurement) => this._send(res, 200, { ok: true, measurement }))
          .catch((err: unknown) => this._send(res, 400, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/agent-turn") {
        this._readBody(req)
          .then((body) => this._recordAgentTurn(body))
          .then((turn) => this._send(res, 200, { ok: true, turn }))
          .catch((err: unknown) => this._send(res, 400, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/follow-up-pr") {
        if (!this._repoPath) {
          this._send(res, 404, { ok: false, error: "no agent worktree configured" });
          return;
        }
        this._readBody(req)
          .then((body) => this._openFollowUpPr(body))
          .then((follow_up_pr) => this._send(res, 200, { ok: true, follow_up_pr }))
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
        return;
      }
      this._send(res, 404, { ok: false, error: "not found" });
      return;
    }
    this._send(res, 405, { ok: false, error: "method not allowed" });
  }

  private async _recordObservation(body: Record<string, unknown>): Promise<AgentObservation> {
    const observation = normalizeAgentObservation(body);
    this._observations.push(observation);
    this._observations = this._observations.slice(-50);
    this._agentObserver?.(observation);
    if (this._trajectory) {
      await Promise.resolve(
        this._trajectory.appendEvent({
          event_type: "agent.observation",
          actor: "pi-agent",
          payload: observation as unknown as Record<string, unknown>,
          refs: {},
        }),
      );
    }
    return observation;
  }

  private async _recordToolSurface(body: Record<string, unknown>): Promise<PiToolingSnapshot> {
    const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
    this._toolSurfaceScope = body["scope"] === "all-configured" ? "all-configured" : "extension";
    this._toolSurface = tools.flatMap((value): PiToolSurfaceEntry[] => {
      if (typeof value !== "object" || value === null) return [];
      const tool = value as Record<string, unknown>;
      const name = typeof tool["name"] === "string" ? tool["name"].trim() : "";
      if (!name) return [];
      return [{
        name,
        label: typeof tool["label"] === "string" ? tool["label"] : name,
        description: typeof tool["description"] === "string" ? tool["description"] : "",
        parameter_schema: typeof tool["parameter_schema"] === "object" && tool["parameter_schema"] !== null
          ? tool["parameter_schema"] as Record<string, unknown>
          : {},
        prompt_guideline_count: typeof tool["prompt_guideline_count"] === "number"
          ? tool["prompt_guideline_count"]
          : 0,
        active: tool["active"] !== false,
        source_info: typeof tool["source_info"] === "object" && tool["source_info"] !== null
          ? tool["source_info"] as Record<string, unknown>
          : {},
      }];
    });
    if (this._trajectory) {
      await Promise.resolve(this._trajectory.appendEvent({
        event_type: "pi.tool_surface.registered",
        actor: "pi-extension",
        payload: {
          injection_method: "pi-cli-extension",
          surface_scope: this._toolSurfaceScope,
          extension_path: this._extensionPath,
          tool_count: this._toolSurface.length,
          tool_names: this._toolSurface.map((tool) => tool.name),
          trace_context: this._traceContext,
        },
      }));
    }
    return this.getToolingSnapshot();
  }

  private async _recordToolCall(body: Record<string, unknown>): Promise<PiToolCallMeasurement> {
    const callId = typeof body["call_id"] === "string" ? body["call_id"].trim() : "";
    const toolName = typeof body["tool_name"] === "string" ? body["tool_name"].trim() : "";
    const phase = body["phase"] === "completed" ? "completed" : body["phase"] === "started" ? "started" : "";
    if (!callId || !toolName || !phase) throw new Error("call_id, tool_name, and a valid phase are required");
    const now = new Date().toISOString();
    const existing = this._toolCalls.get(callId);
    if (phase === "started") {
      if (existing) {
        const anomaly = existing.status === "started" ? "duplicate_start" : "start_after_completion";
        if (!existing.lifecycle_anomalies.includes(anomaly)) existing.lifecycle_anomalies.push(anomaly);
        if (this._trajectory) {
          await Promise.resolve(this._trajectory.appendEvent({
            event_type: "pi.tool_call.protocol_error",
            actor: "merge-god",
            payload: { ...existing, anomaly, trace_context: this._traceContext },
          }));
        }
        return existing;
      }
      const measurement: PiToolCallMeasurement = {
        call_id: callId,
        tool_name: toolName,
        status: "started",
        started_at: typeof body["started_at"] === "string" ? body["started_at"] : now,
        completed_at: null,
        duration_ms: null,
        input_keys: Array.isArray(body["input_keys"])
          ? body["input_keys"].filter((key): key is string => typeof key === "string")
          : [],
        error: null,
        turn_id: typeof body["turn_id"] === "string" ? body["turn_id"] : null,
        lifecycle_anomalies: [],
      };
      this._toolCalls.set(callId, measurement);
      if (measurement.turn_id) {
        const turn = this._agentTurns.get(measurement.turn_id);
        if (turn && !turn.tool_call_ids.includes(callId)) turn.tool_call_ids.push(callId);
      }
      if (this._trajectory) {
        await Promise.resolve(this._trajectory.appendEvent({
          event_type: "pi.tool_call.started",
          actor: "pi-extension",
          payload: { ...measurement, trace_context: this._traceContext },
        }));
      }
      return measurement;
    }

    if (existing && existing.status !== "started") {
      const anomaly = "duplicate_completion";
      if (!existing.lifecycle_anomalies.includes(anomaly)) existing.lifecycle_anomalies.push(anomaly);
      if (this._trajectory) {
        await Promise.resolve(this._trajectory.appendEvent({
          event_type: "pi.tool_call.protocol_error",
          actor: "merge-god",
          payload: { ...existing, anomaly, trace_context: this._traceContext },
        }));
      }
      return existing;
    }

    const completionWithoutStart = existing === undefined;
    const success = body["success"] === true && !completionWithoutStart;
    const durationMs = typeof body["duration_ms"] === "number" ? Math.max(0, body["duration_ms"]) : 0;
    const measurement: PiToolCallMeasurement = {
      call_id: callId,
      tool_name: toolName,
      status: success ? "succeeded" : "failed",
      started_at: existing?.started_at ?? (typeof body["started_at"] === "string" ? body["started_at"] : now),
      completed_at: now,
      duration_ms: durationMs,
      input_keys: existing?.input_keys ?? [],
      error: completionWithoutStart
        ? "Tool completion was reported without a matching start"
        : typeof body["error"] === "string" ? body["error"] : null,
      turn_id: existing?.turn_id ?? (typeof body["turn_id"] === "string" ? body["turn_id"] : null),
      lifecycle_anomalies: completionWithoutStart
        ? ["completion_without_start"]
        : existing?.lifecycle_anomalies ?? [],
    };
    this._toolCalls.set(callId, measurement);
    if (measurement.turn_id) {
      const turn = this._agentTurns.get(measurement.turn_id);
      if (turn && !turn.tool_call_ids.includes(callId)) turn.tool_call_ids.push(callId);
    }
    if (completionWithoutStart && this._trajectory) {
      await Promise.resolve(this._trajectory.appendEvent({
        event_type: "pi.tool_call.protocol_error",
        actor: "merge-god",
        payload: {
          ...measurement,
          anomaly: "completion_without_start",
          trace_context: this._traceContext,
        },
      }));
    }
    recordPiToolCall(toolName, success, durationMs, {
      "merge_god.tool_call_id": callId,
      "merge_god.run_id": this._traceContext?.run_id,
      "merge_god.activity_id": this._traceContext?.activity_id,
      "merge_god.activity_session_id": this._traceContext?.activity_session_id,
    }, this._traceContext?.traceparent, Date.parse(measurement.started_at));
    if (this._trajectory) {
      await Promise.resolve(this._trajectory.appendEvent({
        event_type: "pi.tool_call.completed",
        actor: "pi-extension",
        payload: { ...measurement, trace_context: this._traceContext },
      }));
    }
    return measurement;
  }

  private async _recordAgentTurn(body: Record<string, unknown>): Promise<PiAgentTurnMeasurement> {
    const turnId = typeof body["turn_id"] === "string" ? body["turn_id"].trim() : "";
    const turnIndex = typeof body["turn_index"] === "number" ? body["turn_index"] : -1;
    const phase = body["phase"] === "completed" ? "completed" : body["phase"] === "started" ? "started" : "";
    if (!turnId || turnIndex < 0 || !phase) throw new Error("turn_id, turn_index, and a valid phase are required");
    const existing = this._agentTurns.get(turnId);
    const turn: PiAgentTurnMeasurement = {
      turn_id: turnId,
      turn_index: turnIndex,
      status: phase,
      started_at: existing?.started_at ?? (typeof body["started_at"] === "string" ? body["started_at"] : new Date().toISOString()),
      completed_at: phase === "completed" ? new Date().toISOString() : null,
      tool_call_ids: existing?.tool_call_ids ?? [],
      ...(phase === "completed" ? {
        model: typeof body["model"] === "string" ? body["model"] : null,
        input_tokens: nonNegativeNumber(body["input_tokens"]),
        output_tokens: nonNegativeNumber(body["output_tokens"]),
        cache_creation_input_tokens: nonNegativeNumber(body["cache_creation_input_tokens"]),
        cache_read_input_tokens: nonNegativeNumber(body["cache_read_input_tokens"]),
        total_tokens: nonNegativeNumber(body["total_tokens"]),
        estimated_cost: nonNegativeNumber(body["estimated_cost"]) ?? nonNegativeNumber(body["cost_usd"]),
        usage_source: typeof body["usage_source"] === "string" ? body["usage_source"] : null,
        cost_source: typeof body["cost_source"] === "string" ? body["cost_source"] : null,
      } : {}),
    };
    this._agentTurns.set(turnId, turn);
    if (this._trajectory) {
      await Promise.resolve(this._trajectory.appendEvent({
        event_type: `pi.agent_turn.${phase}`,
        actor: "pi-extension",
        payload: { ...turn, trace_context: this._traceContext },
      }));
    }
    return turn;
  }

  private async _openFollowUpPr(body: Record<string, unknown>): Promise<FollowUpPrResult> {
    const input = normalizeFollowUpPrInput(body);
    const work = this.getWork();
    const repoPath = this._repoPath;
    if (!repoPath) throw new Error("no agent worktree configured");

    const base = followUpBaseBranch(input, work);
    const branch = input.branch ?? defaultFollowUpBranch(input.title, work);
    const gitOps = new GitOps(repoPath, this._gitObserver);

    gitOps.ensureInsideWorkTree();
    gitOps.checkoutBranch(branch, { reset: true });
    gitOps.addAll();

    const staged = gitOps.stagedFiles();
    if (staged.length === 0) throw new Error("no changes staged for follow-up PR");

    gitOps.commit(input.commit_message ?? input.title);
    const commit = gitOps.headSha() || null;
    gitOps.pushSetUpstream(branch);

    const prArgs = [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      buildFollowUpPrBody(input, work),
      "--head",
      branch,
      "--base",
      base,
    ];
    if (input.draft) prArgs.push("--draft");
    for (const label of input.labels ?? []) prArgs.push("--label", label);
    const url = gitOps.runGh(prArgs).stdout.trim();
    const result: FollowUpPrResult = {
      title: input.title,
      branch,
      base,
      url,
      commit,
      linked_pr_number: input.linked_pr_number ?? linkedPrNumber(work),
      signal_refs: input.signal_refs,
      grounding_refs: input.grounding_refs,
      validation_refs: input.validation_refs ?? [],
    };

    if (this._trajectory) {
      await Promise.resolve(
        this._trajectory.appendEvent({
          event_type: "follow_up_pr.opened",
          actor: "pi-agent",
          payload: result as unknown as Record<string, unknown>,
          refs: {},
        }),
      );
    }
    return result;
  }
}

function compactTrajectoryState(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const state = value as Record<string, unknown>;
  const events = Array.isArray(state["events"]) ? state["events"] : [];
  return {
    run: state["run"] ?? null,
    resume: state["resume"] ?? null,
    hierarchy: state["hierarchy"] ?? [],
    work_items: state["work_items"] ?? [],
    activities: state["activities"] ?? [],
    activity_sessions: state["activity_sessions"] ?? [],
    recent_events: events.slice(-12).map((event) => {
      if (typeof event !== "object" || event === null) return event;
      const row = event as Record<string, unknown>;
      const payload = typeof row["payload"] === "object" && row["payload"] !== null
        ? row["payload"] as Record<string, unknown>
        : {};
      return {
        event_id: row["event_id"],
        event_type: row["event_type"],
        actor: row["actor"],
        activity_id: row["activity_id"],
        activity_session_id: row["activity_session_id"],
        created_at: row["created_at"],
        summary: payload["summary"] ?? null,
        status: payload["status"] ?? null,
        next_action: payload["next_action"] ?? null,
      };
    }),
  };
}

function normalizeAgentObservation(body: Record<string, unknown>): AgentObservation {
  const summary = typeof body["summary"] === "string" ? body["summary"].trim() : "";
  if (!summary) throw new Error("summary is required");
  const rawLevel = typeof body["level"] === "string" ? body["level"] : "info";
  const level = ["debug", "info", "warning", "error"].includes(rawLevel)
    ? (rawLevel as AgentObservation["level"])
    : "info";
  const confidence = typeof body["confidence"] === "number" ? body["confidence"] : undefined;
  return {
    timestamp: new Date().toISOString(),
    level,
    category:
      typeof body["category"] === "string" && body["category"].trim()
        ? body["category"].trim()
        : "status",
    summary,
    detail: typeof body["detail"] === "string" ? body["detail"] : undefined,
    needs: stringArray(body["needs"]),
    signal_refs: stringArray(body["signal_refs"]),
    grounding_refs: stringArray(body["grounding_refs"]),
    confidence,
    suggested_next: typeof body["suggested_next"] === "string" ? body["suggested_next"] : undefined,
  };
}

export const DEFAULT_INSTRUCTION = PI_AGENT_INSTRUCTION;

export interface PiAgentResult {
  returncode: number;
  stdout: string;
  stderr: string;
  result: JsonResult;
  tooling?: PiToolingSnapshot;
}

const PI_DOTENV_KEYS = new Set(["ZAI_API_KEY"]);

export function linkNodeModulesIntoWorktree(sourceRepoPath: string, worktreePath: string): boolean {
  const sourceNodeModules = path.join(sourceRepoPath, "node_modules");
  const targetNodeModules = path.join(worktreePath, "node_modules");
  if (!existsSync(sourceNodeModules) || existsSync(targetNodeModules)) return false;
  symlinkSync(sourceNodeModules, targetNodeModules, "dir");
  return true;
}

function parseDotEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex <= 0) return null;

  const key = withoutExport.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = withoutExport.slice(equalsIndex + 1).trim();
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
  } else {
    const commentIndex = value.search(/\s#/);
    if (commentIndex !== -1) value = value.slice(0, commentIndex).trimEnd();
  }
  return [key, value];
}

export function loadPiDotEnv(repoPath: string): Record<string, string> {
  const envPath = path.join(repoPath, ".env");
  if (!existsSync(envPath)) return {};

  const parsed: Record<string, string> = {};
  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseDotEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    if (PI_DOTENV_KEYS.has(key)) parsed[key] = value;
  }
  return parsed;
}

/**
 * Run the pi agent with the merge-god extension against a work item.
 *
 * Starts a coordination server, publishes `workItem`, launches
 * `pi --print --mode json` with the merge-god extension, and returns
 * `{ returncode, stdout, stderr, result }` where `result` is whatever the agent
 * reported via the `mg_complete` tool (if any).
 */
export async function runPiAgent(
  workItem: WorkItem,
  repoPath: string,
  opts: {
    timeout?: number;
    instruction?: string;
    extensionPath?: string;
    extraEnv?: Record<string, string>;
    trajectory?: CoordinationTrajectoryBridge;
    gitObserver?: GitOpsObserver;
    agentObserver?: (observation: AgentObservation) => void;
    progressObserver?: (progress: PiAgentProgress) => void;
    completionGraceMs?: number;
  } = {},
): Promise<PiAgentResult> {
  const {
    timeout = 3600,
    instruction = DEFAULT_INSTRUCTION,
    extensionPath,
    extraEnv,
    trajectory,
    gitObserver,
    agentObserver,
    progressObserver,
    completionGraceMs = 1000,
  } = opts;

  return withTelemetrySpan(
    "merge_god.run_pi_agent",
    {
      "merge_god.operation": "run_pi_agent",
      "merge_god.work_item_kind": workItem.kind ?? "unknown",
      "merge_god.pr_number": workItem.pr_number,
      "merge_god.issue_number": workItem.issue_number,
      "merge_god.mode": workItem.mode,
      "merge_god.repo": workItem.repo,
      "merge_god.prompt_size": workItem.prompt.length,
    },
    async (span) => {
  const ext = extensionPath ?? findExtension();
  const spanContext = span.spanContext();
  const traceId = /^0+$/.test(spanContext.traceId) ? randomBytes(16).toString("hex") : spanContext.traceId;
  const parentSpanId = /^0+$/.test(spanContext.spanId) ? randomBytes(8).toString("hex") : spanContext.spanId;
  const trajectoryRefs = typeof workItem["trajectory_refs"] === "object" && workItem["trajectory_refs"] !== null
    ? workItem["trajectory_refs"] as Record<string, unknown>
    : {};
  const traceContext: AgentTraceContext = {
    trace_id: traceId,
    parent_span_id: parentSpanId,
    traceparent: `00-${traceId}-${parentSpanId}-${spanContext.traceFlags === 0 ? "00" : "01"}`,
    ...(typeof trajectoryRefs["run_id"] === "string" ? { run_id: trajectoryRefs["run_id"] } : {}),
    ...(typeof trajectoryRefs["workset_id"] === "string" ? { workset_id: trajectoryRefs["workset_id"] } : {}),
    ...(typeof trajectoryRefs["work_item_id"] === "string" ? { work_item_id: trajectoryRefs["work_item_id"] } : {}),
    ...(typeof trajectoryRefs["activity_id"] === "string" ? { activity_id: trajectoryRefs["activity_id"] } : {}),
    ...(typeof trajectoryRefs["activity_session_id"] === "string" || trajectoryRefs["activity_session_id"] === null
      ? { activity_session_id: trajectoryRefs["activity_session_id"] as string | null }
      : {}),
  };
  span.setAttributes(sanitizeSpanAttributes({
    "merge_god.trace_id": traceContext.trace_id,
    "merge_god.run_id": traceContext.run_id,
    "merge_god.workset_id": traceContext.workset_id,
    "merge_god.work_item_id": traceContext.work_item_id,
    "merge_god.activity_id": traceContext.activity_id,
    "merge_god.activity_session_id": traceContext.activity_session_id,
    "merge_god.pi_extension_path": ext,
    "merge_god.pi_extension_injection": "pi-cli-extension",
  }));
  const gitOps = new GitOps(repoPath, gitObserver ?? null);
  let worktreeRef = "HEAD";
  if (workItem.kind === "pr" && Number.isInteger(workItem.pr_number) && (workItem.pr_number ?? 0) > 0) {
    worktreeRef = `refs/merge-god/pr-${workItem.pr_number}-agent-head`;
    gitOps.runGit([
      "fetch",
      "origin",
      `+refs/pull/${workItem.pr_number}/head:${worktreeRef}`,
    ], { timeout: 120 });
  }
  const worktree = gitOps.createDetachedWorktree(worktreeRef);
  linkNodeModulesIntoWorktree(repoPath, worktree.path);
  const server = new CoordinationServer(
    "127.0.0.1",
    0,
    trajectory ?? null,
    worktree.path,
    gitObserver ?? null,
    agentObserver ?? null,
  );
  server.setAgentTraceContext(traceContext, ext);
  await server.start();
  const injection = buildPiExtensionInjection({
    extension_path: ext,
    api_url: server.baseUrl,
    trace_context: traceContext,
    instruction,
  });
  const dotenvEnv = loadPiDotEnv(repoPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...dotenvEnv,
    ...injection.environment,
  };
  if (extraEnv) Object.assign(env, extraEnv);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  recordPromptRendered("pi_work_item", workItem.prompt, {
    "merge_god.work_item_kind": workItem.kind ?? "unknown",
    "merge_god.pr_number": workItem.pr_number,
    "merge_god.issue_number": workItem.issue_number,
    "merge_god.mode": workItem.mode,
  });

  try {
    server.setWork({
      ...workItem,
      repo_path: worktree.path,
      source_repo_path: workItem.repo_path ?? repoPath,
      trace_context: traceContext,
    });
    if (trajectory) {
      await Promise.resolve(trajectory.appendEvent({
        event_type: "pi.extension.injected",
        actor: "merge-god",
        payload: {
          injection_method: injection.method,
          extension_path: injection.extension_path,
          expected_tools: injection.expected_tools,
          trace_context: traceContext,
        },
      }));
    }
    const proc = spawn("pi", injection.cli_args, {
      cwd: worktree.path,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutLineBuffer += chunk;
      for (;;) {
        const newline = stdoutLineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutLineBuffer.slice(0, newline).trim();
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        if (!line || !progressObserver) continue;
        try {
          const progress = piAgentProgressFromRuntimeEvent(JSON.parse(line));
          if (progress) progressObserver(progress);
        } catch {
          // Pi can emit non-JSON diagnostic lines; they are retained in stdout.
        }
      }
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    let terminationRequestedAfterCompletion = false;
    let processClosed = false;
    let completionTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const unsubscribeResult = server.onResult(() => {
      if (completionTimer !== null || processClosed) return;
      clearTimeout(timer);
      completionTimer = setTimeout(() => {
        if (processClosed) return;
        terminationRequestedAfterCompletion = true;
        proc.kill("SIGTERM");
        forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      }, Math.max(0, completionGraceMs));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    }, timeout * 1000);

    const exit = await new Promise<{ code: number; error?: unknown }>((resolve) => {
      let settled = false;
      const settle = (result: { code: number; error?: unknown }) => {
        if (settled) return;
        settled = true;
        processClosed = true;
        clearTimeout(timer);
        if (completionTimer) clearTimeout(completionTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        unsubscribeResult();
        resolve(result);
      };
      proc.on("error", (error) => settle({ code: -1, error }));
      proc.on("close", (code) => settle({
        code: terminationRequestedAfterCompletion ? 0 : (code ?? -1),
      }));
    });
    if (timedOut) {
      stderr += stderr.endsWith("\n") || stderr.length === 0 ? "pi process timed out\n" : "\npi process timed out\n";
    }
    if (exit.error) {
      stderr += stderr.endsWith("\n") || stderr.length === 0 ? String(exit.error) : `\n${String(exit.error)}`;
    }
    await server.finalizeToolCalls();
    const tooling = server.getToolingSnapshot();
    const result: PiAgentResult = {
      returncode: exit.code,
      stdout,
      stderr,
      result: server.getResult(),
      tooling,
    };
    const resultStatus = typeof result.result?.["status"] === "string" ? result.result["status"] : null;
    const success = result.returncode === 0 && resultStatus === "success";
    const completedAt = new Date();
    const duration = (completedAt.getTime() - startedAt) / 1000;
    const resultSummary =
      typeof result.result?.["summary"] === "string"
        ? result.result["summary"]
        : typeof result.result?.["error"] === "string"
          ? result.result["error"]
          : "";
    span.setAttributes(sanitizeSpanAttributes({
      "merge_god.returncode": result.returncode,
      "merge_god.success": success,
      "merge_god.result_status": success ? "success" : "failure",
      "merge_god.result_summary": resultSummary,
      "merge_god.completion_reported": result.result !== null,
      "merge_god.duration_seconds": duration,
      "merge_god.observation_count": server.getObservations().length,
      "merge_god.tool_surface_count": tooling.surface.length,
      "merge_god.tool_call_count": tooling.reliability.started,
      "merge_god.tool_call_failure_count": tooling.reliability.failed,
      "merge_god.tool_call_incomplete_count": tooling.reliability.incomplete,
      "merge_god.tool_call_protocol_error_count": tooling.reliability.protocol_errors,
      "merge_god.tool_call_completion_ratio": tooling.reliability.completion_ratio,
    }));
    recordAgentRun("pi", success, duration, {
      "merge_god.work_item_kind": workItem.kind ?? "unknown",
      "merge_god.pr_number": workItem.pr_number,
      "merge_god.issue_number": workItem.issue_number,
      "merge_god.mode": workItem.mode,
      "merge_god.returncode": result.returncode,
    });
    if (trajectory) {
      await Promise.resolve(trajectory.appendEvent({
        event_type: "pi.agent.completed",
        actor: "merge-god",
        payload: piAgentCompletionTelemetry(
          result.result,
          startedAtIso,
          completedAt.toISOString(),
          completedAt.getTime() - startedAt,
          tooling,
        ),
      }));
    }
    return result;
  } finally {
    await server.stop();
    worktree.cleanup();
  }
    },
  );
}

// --- CLI demo mode (mirrors `python coordination.py --demo`) ---
async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    const server = new CoordinationServer("127.0.0.1", 7780);
    await server.start();
    server.setWork({
      kind: "demo",
      prompt: "This is a merge-god coordination demo work item.",
    });
    console.log(`coordination API ready at ${server.baseUrl} (Ctrl-C to stop)`);
    process.on("SIGINT", () => {
      void server.stop().then(() => process.exit(0));
    });
    await new Promise<void>(() => {
      /* run forever */
    });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
