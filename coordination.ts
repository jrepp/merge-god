/**
 * merge-god coordination API and pi agent runner.
 *
 * Ported from coordination.py. Bridges merge-god (the orchestrator) with the pi
 * coding agent via the merge-god pi extension (pi/extensions/merge-god).
 *
 * merge-god pushes a *work item* — the gathered prompt/context for a PR or
 * issue — to a tiny local HTTP server. The pi extension's tools
 * (`merge_god_context`, `merge_god_complete`) pull that work item and report
 * results back over the same HTTP API. This replaces the former
 * `bob --json <prompt>` subprocess contract.
 */

import { spawn } from "node:child_process";
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
import {
  recordAgentRun,
  recordPromptRendered,
  sanitizeSpanAttributes,
  withTelemetrySpan,
} from "./telemetry";

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
  }

  getResult(): JsonResult {
    return this._result;
  }

  setTrajectoryBridge(trajectory: CoordinationTrajectoryBridge | null): void {
    this._trajectory = trajectory;
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
      if (url === "/debug") {
        this._send(res, 200, {
          ok: true,
          work: this.getWork(),
          observations: this.getObservations(),
          capabilities: {
            tools: [
              "merge_god_context",
              "merge_god_observe",
              "merge_god_trajectory_state",
              "merge_god_trajectory_event",
              "merge_god_open_follow_up_pr",
              "merge_god_complete",
            ],
            worktree_path: this._repoPath,
          },
        });
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
            const eventType = typeof body["event_type"] === "string" ? body["event_type"] : "";
            if (!eventType) {
              this._send(res, 400, { ok: false, error: "event_type is required" });
              return;
            }
            const refs = typeof body["refs"] === "object" && body["refs"] !== null
              ? (body["refs"] as Record<string, unknown>)
              : {};
            const payload = typeof body["payload"] === "object" && body["payload"] !== null
              ? (body["payload"] as Record<string, unknown>)
              : {};
            return Promise.resolve(
              this._trajectory!.appendEvent({
                event_type: eventType,
                actor: typeof body["actor"] === "string" ? body["actor"] : "pi-agent",
                payload,
                refs,
              }),
            ).then((event) => this._send(res, 200, { ok: true, event }));
          })
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
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
            const nextAction = typeof body["next_action"] === "string" ? body["next_action"] : "";
            const rationale = typeof body["rationale"] === "string" ? body["rationale"] : "";
            if (!nextAction || !rationale) {
              this._send(res, 400, { ok: false, error: "next_action and rationale are required" });
              return;
            }
            const blockers = Array.isArray(body["blockers"])
              ? body["blockers"].filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
              : [];
            const evidenceRefs = Array.isArray(body["evidence_refs"])
              ? body["evidence_refs"].filter((item): item is string => typeof item === "string")
              : [];
            return Promise.resolve(
              this._trajectory!.proposeNext!({
                next_action: nextAction,
                rationale,
                blockers,
                evidence_refs: evidenceRefs,
              }),
            ).then((proposal) => this._send(res, 200, { ok: true, proposal }));
          })
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
        return;
      }
      if (url === "/trajectory/child-activity") {
        if (!this._trajectory?.createChildActivity) {
          this._send(res, 404, { ok: false, error: "no trajectory child-activity bridge" });
          return;
        }
        this._readBody(req)
          .then((body) => {
            const type = typeof body["type"] === "string" ? body["type"] : "";
            const summary = typeof body["summary"] === "string" ? body["summary"] : "";
            const modelTier = typeof body["model_tier"] === "string" ? body["model_tier"] : "";
            const modelReason = typeof body["model_reason"] === "string" ? body["model_reason"] : "";
            if (!type || !summary || !modelTier || !modelReason) {
              this._send(res, 400, {
                ok: false,
                error: "type, summary, model_tier, and model_reason are required",
              });
              return;
            }
            const contextPackRefs = Array.isArray(body["context_pack_refs"])
              ? body["context_pack_refs"].filter((item): item is string => typeof item === "string")
              : [];
            const evidenceRefs = Array.isArray(body["evidence_refs"])
              ? body["evidence_refs"].filter((item): item is string => typeof item === "string")
              : [];
            const metadata = typeof body["metadata"] === "object" && body["metadata"] !== null
              ? (body["metadata"] as Record<string, unknown>)
              : {};
            return Promise.resolve(
              this._trajectory!.createChildActivity!({
                type,
                summary,
                model_tier: modelTier,
                model_reason: modelReason,
                prompt_runtime_ref: typeof body["prompt_runtime_ref"] === "string" ? body["prompt_runtime_ref"] : null,
                context_pack_refs: contextPackRefs,
                evidence_refs: evidenceRefs,
                metadata,
              }),
            ).then((activity) => this._send(res, 200, { ok: true, activity }));
          })
          .catch((err: unknown) => this._send(res, 500, { ok: false, error: String(err) }));
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

export const DEFAULT_INSTRUCTION =
  "You are operating as the merge-god PR agent.\n" +
  "1) Call the `merge_god_context` tool to load your work item from the " +
  "merge-god coordination API.\n" +
  "2) When a trajectory is available, use `merge_god_trajectory_state` to " +
  "inspect the current run/work/activity state, and use " +
  "`merge_god_trajectory_event` for meaningful checkpoints, decisions, " +
  "blockers, and evidence references.\n" +
  "When creating child trajectory activities, include `model_tier` " +
  "(`fast`, `standard`, or `high`) and `model_reason`; merge-god rejects " +
  "child activities that do not propose the needed model quality.\n" +
  "3) Use `merge_god_observe` at major checkpoints so merge-god can render live " +
  "TUI signal: whether you have enough context, what evidence you found, what " +
  "you need, and what you plan next. Use `merge_god_debug_snapshot` if you are " +
  "unsure what coordination state or tools are available.\n" +
  "4) Carry out the work described there in this repository using your file " +
  "and shell tools. You are running inside an isolated git worktree created " +
  "for this invocation. For general repository validation, unset ambient " +
  "`ZAI_API_KEY` unless the validation explicitly checks pi runtime secret " +
  "loading. When merging a PR, use a GitHub remote merge commit path that does " +
  "not require checking out the base branch in this local worktree.\n" +
  "5) If you discover a separate issue that should be fixed in its own branch, " +
  "open a remediation PR only when you have concrete underlying signal " +
  "(for example failing tests, CI logs, review comments, issue text, runtime " +
  "errors, or reproducible command output) and project-doc grounding " +
  "(AGENTS.md, docs/, merge-rules.yaml, or referenced Workflow-IR). Use " +
  "`merge_god_open_follow_up_pr` with signal_refs and grounding_refs to commit " +
  "the current worktree changes, push a branch, open a pull request, and notify " +
  "the coordinator.\n" +
  "6) Call the `merge_god_complete` tool with status and a concise summary of " +
  "what you did. Include obvious semantic PR annotations when supported by the " +
  "evidence (large, too-large, unaligned, needs-split, needs-design, high-risk, " +
  "low-risk, docs-only, test-only, embark-candidate, underlying-needed). " +
  "Include a `telemetry` object with the exact model identifier and exact " +
  "provider token usage when available; do not estimate token usage. Then stop.";

export interface PiAgentResult {
  returncode: number;
  stdout: string;
  stderr: string;
  result: JsonResult;
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
 * reported via the `merge_god_complete` tool (if any).
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
  const gitOps = new GitOps(repoPath, gitObserver ?? null);
  const worktree = gitOps.createDetachedWorktree();
  linkNodeModulesIntoWorktree(repoPath, worktree.path);
  const server = new CoordinationServer(
    "127.0.0.1",
    0,
    trajectory ?? null,
    worktree.path,
    gitObserver ?? null,
    agentObserver ?? null,
  );
  await server.start();
  const dotenvEnv = loadPiDotEnv(repoPath);
  const env: NodeJS.ProcessEnv = { ...process.env, ...dotenvEnv, MERGE_GOD_API: server.baseUrl };
  if (extraEnv) Object.assign(env, extraEnv);
  const startedAt = Date.now();
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
    });
    const args = [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--extension",
      ext,
      instruction,
    ];
    const proc = spawn("pi", args, {
      cwd: worktree.path,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    }, timeout * 1000);

    const exit = await new Promise<{ code: number; error?: unknown }>((resolve) => {
      let settled = false;
      const settle = (result: { code: number; error?: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };
      proc.on("error", (error) => settle({ code: -1, error }));
      proc.on("close", (code) => settle({ code: code ?? -1 }));
    });
    if (timedOut) {
      stderr += stderr.endsWith("\n") || stderr.length === 0 ? "pi process timed out\n" : "\npi process timed out\n";
    }
    if (exit.error) {
      stderr += stderr.endsWith("\n") || stderr.length === 0 ? String(exit.error) : `\n${String(exit.error)}`;
    }
    const result = {
      returncode: exit.code,
      stdout,
      stderr,
      result: server.getResult(),
    };
    const resultStatus = typeof result.result?.["status"] === "string" ? result.result["status"] : null;
    const success = result.returncode === 0 && resultStatus === "success";
    const duration = (Date.now() - startedAt) / 1000;
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
    }));
    recordAgentRun("pi", success, duration, {
      "merge_god.work_item_kind": workItem.kind ?? "unknown",
      "merge_god.pr_number": workItem.pr_number,
      "merge_god.issue_number": workItem.issue_number,
      "merge_god.mode": workItem.mode,
      "merge_god.returncode": result.returncode,
    });
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
