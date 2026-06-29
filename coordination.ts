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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    prompt_runtime_ref?: string | null;
    context_pack_refs?: string[];
    evidence_refs?: string[];
    metadata?: Record<string, unknown>;
  }): unknown | Promise<unknown>;
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
  private _server: http.Server;
  private _trajectory: CoordinationTrajectoryBridge | null;
  host: string;
  port: number;

  constructor(host = "127.0.0.1", port = 0, trajectory: CoordinationTrajectoryBridge | null = null) {
    this._server = http.createServer((req, res) => this._handleRequest(req, res));
    // Synchronously grab a port by listening; we use the returned address below.
    // Note: listen() is async, but server.address() is populated by the time the
    // 'listening' event fires. We block on that using a synchronous spawn is not
    // possible; instead callers should `await server.start()`.
    this.host = host;
    this.port = port;
    this._trajectory = trajectory;
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
            if (!type || !summary) {
              this._send(res, 400, { ok: false, error: "type and summary are required" });
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
      this._send(res, 404, { ok: false, error: "not found" });
      return;
    }
    this._send(res, 405, { ok: false, error: "method not allowed" });
  }
}

export const DEFAULT_INSTRUCTION =
  "You are operating as the merge-god PR agent.\n" +
  "1) Call the `merge_god_context` tool to load your work item from the " +
  "merge-god coordination API.\n" +
  "2) When a trajectory is available, use `merge_god_trajectory_state` to " +
  "inspect the current run/work/activity state, and use " +
  "`merge_god_trajectory_event` for meaningful checkpoints, decisions, " +
  "blockers, and evidence references.\n" +
  "3) Carry out the work described there in this repository using your file " +
  "and shell tools.\n" +
  "4) Call the `merge_god_complete` tool with status and a concise summary of " +
  "what you did, then stop.";

export interface PiAgentResult {
  returncode: number;
  stdout: string;
  stderr: string;
  result: JsonResult;
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
  } = {},
): Promise<PiAgentResult> {
  const {
    timeout = 3600,
    instruction = DEFAULT_INSTRUCTION,
    extensionPath,
    extraEnv,
    trajectory,
  } = opts;

  const ext = extensionPath ?? findExtension();
  const server = new CoordinationServer("127.0.0.1", 0, trajectory ?? null);
  await server.start();
  const env: NodeJS.ProcessEnv = { ...process.env, MERGE_GOD_API: server.baseUrl };
  if (extraEnv) Object.assign(env, extraEnv);

  try {
    server.setWork(workItem);
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
      cwd: repoPath,
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
    return {
      returncode: exit.code,
      stdout,
      stderr,
      result: server.getResult(),
    };
  } finally {
    await server.stop();
  }
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
