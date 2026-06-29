#!/usr/bin/env node
/**
 * TUI Dashboard for merge-god PR automation.
 *
 * Ported from dashboard.py. Monitors multiple repositories and displays real-time
 * PR processing status. Runs pr-loop.ts as subprocesses for each configured repo.
 *
 * Rendering strategy: an immediate-mode ANSI renderer that mirrors rich.Live. Each
 * refresh clears the screen, rebuilds a frame (ASCII panels/tables colored via
 * chalk), and writes it to stdout. The refresh loop runs on a setInterval.
 *
 * Usage:
 *   tsx dashboard.ts [config_file] [--log-file PATH] [--db-path PATH]
 *   tsx dashboard.ts --dry-run
 *   tsx dashboard.ts | cat
 *
 * Default config file: config.yaml
 * Default log file: merge-god-dashboard.log
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import YAML from "yaml";

import { AppStore, DatabaseError as AppDatabaseError } from "./app_store";
import { SyncStore, DatabaseError as SyncDatabaseError } from "@merge-god/github-sync";

/** Combined DB-store holder: SyncStore (async, PR/repo) + AppStore (sync, processing/dashboard). */
interface DbStores {
  syncStore: SyncStore;
  appStore: AppStore;
}

/** True if the thrown value is a DatabaseError from either store. */
function isDbError(e: unknown): boolean {
  return e instanceof AppDatabaseError || e instanceof SyncDatabaseError;
}
import {
  CIStatus,
  PRState,
  getBranchesNeedingSync,
  getBranchesWithPRs,
  getFailingCI,
  getPRCiStatus,
  getProcessingMode,
  repositoryStateSummary,
} from "./models";
import { StateTracker, StateTrackerError } from "./state_tracker";

// --- Constants --------------------------------------------------------------

const WIP_LABELS = new Set(["wip", "work-in-process", "work in process"]);
const ERROR_TRUNCATE_LENGTH = 100;
const DEFAULT_DB_PATH = "merge-god-state.db";
const REFRESH_INTERVAL_MS = 250;
const NON_TUI_POLL_MS = 500;
const STATUS_SUMMARY_INTERVAL_S = 300;

// --- Small helpers ----------------------------------------------------------

/** Extract a string message from an unknown caught value. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toNum(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format a Date as HH:MM:SS (UTC, mirroring Python strftime on UTC datetimes). */
function formatTime(date: Date): string {
  return date.toISOString().slice(11, 19);
}

/** Format an elapsed duration (ms) as H:MM:SS like Python's str(timedelta). */
function uptimeString(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Parse a value that may be an ISO timestamp string or a Date into a Date. */
function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

/** Toggle raw mode on a stdin stream; returns true if the stream supports it. */
function setStdinRawMode(stream: NodeJS.ReadStream, mode: boolean): boolean {
  const fn = (stream as { setRawMode?: (m: boolean) => void }).setRawMode;
  if (typeof fn === "function") {
    fn.call(stream, mode);
    return true;
  }
  return false;
}

// --- ANSI / rendering helpers ----------------------------------------------

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Visible length of a string (ignoring ANSI escape codes). */
function visibleLen(s: string): number {
  return s.replace(ANSI_REGEX, "").length;
}

/** Apply a rich-like style string (e.g. "bold cyan", "red dim") to text. */
function applyStyle(text: string, style: string): string {
  if (!style) return text;
  type Chain = ((s: string) => string) & Record<string, unknown>;
  let chain = chalk as unknown as Chain;
  for (const part of style.split(/\s+/)) {
    const next = chain[part];
    if (typeof next === "function") {
      chain = next as Chain;
    }
  }
  return chain(text);
}

/** Truncate a (plain) string to a maximum length. */
function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len);
}

/** Terminal width in columns (default 80 when unavailable). */
function termWidth(): number {
  const cols = process.stdout.columns;
  return typeof cols === "number" && cols > 0 ? cols : 80;
}

/**
 * Builder for multi-styled, multi-line text. Mirrors rich.Text.append by
 * accumulating styled segments; embedded newlines start new lines.
 */
class Lines {
  private readonly lines: Array<Array<{ text: string; style: string }>> = [[]];

  append(text: string, style = ""): this {
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) this.lines.push([]);
      const current = this.lines[this.lines.length - 1]!;
      if (segments[i] !== "") current.push({ text: segments[i]!, style });
    }
    return this;
  }

  get isEmpty(): boolean {
    return this.lines.every((line) => line.length === 0);
  }

  render(): string[] {
    return this.lines.map((line) =>
      line.map((s) => applyStyle(s.text, s.style)).join(""),
    );
  }
}

/** A status-grid row: a label cell (right-justified) and a value cell. */
interface GridRow {
  label: string;
  labelStyle: string;
  value: Array<{ text: string; style: string }>;
}

/** Render a 2-column status grid (label | value) with a gap between columns. */
function renderGrid(rows: GridRow[], gap = 2): string[] {
  if (rows.length === 0) return [];
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => {
    const lbl = applyStyle(r.label.padStart(labelWidth), r.labelStyle);
    const val = r.value.map((s) => applyStyle(s.text, s.style)).join("");
    return lbl + " ".repeat(gap) + val;
  });
}

/** Wrap body lines in an ASCII box with a rich-style titled top border. */
function renderPanel(title: string, bodyLines: string[], borderColor: string): string[] {
  const maxBody = bodyLines.reduce((m, l) => Math.max(m, visibleLen(l)), 0);
  const titleVisible = title ? visibleLen(title) + 2 : 0;
  const inner = Math.max(maxBody, titleVisible, 2);
  const maxWidth = Math.max(2, termWidth() - 2);
  const innerWidth = Math.min(inner, maxWidth);
  const out: string[] = [];
  const border = (s: string): string => applyStyle(s, borderColor);
  const pad = (l: string): string => {
    const v = visibleLen(l);
    return v >= innerWidth ? l : l + " ".repeat(innerWidth - v);
  };
  if (title) {
    const titleStr = ` ${title} `;
    const fill = "─".repeat(Math.max(0, innerWidth - visibleLen(titleStr)));
    out.push(border("┌" + titleStr + fill + "┐"));
  } else {
    out.push(border("┌" + "─".repeat(innerWidth) + "┐"));
  }
  for (const line of bodyLines) {
    out.push(border("│") + pad(line) + border("│"));
  }
  out.push(border("└" + "─".repeat(innerWidth) + "┘"));
  return out;
}

/** Render a plain text table with headers and rows (used for dry-run output). */
function renderTextTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const cell = (text: string, i: number): string =>
    " " + (text ?? "").padEnd(widths[i]!) + " ";
  const out: string[] = [];
  out.push("┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
  out.push("│" + headers.map((h, i) => applyStyle(cell(h, i), "bold magenta")).join("│") + "│");
  out.push("├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤");
  for (const row of rows) {
    out.push("│" + row.map((c, i) => cell(c, i)).join("│") + "│");
  }
  out.push("└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");
  return out;
}

// --- Bounded deque ----------------------------------------------------------

/** A bounded array (push + shift when over capacity) mirroring collections.deque. */
class BoundedArray<T> {
  private readonly items: T[] = [];
  readonly maxlen: number;

  constructor(maxlen: number) {
    this.maxlen = maxlen;
  }

  append(item: T): void {
    this.items.push(item);
    while (this.items.length > this.maxlen) this.items.shift();
  }

  clear(): void {
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length;
  }

  toArray(): T[] {
    return [...this.items];
  }

  /** Last N items (oldest-to-newest). */
  sliceLast(n: number): T[] {
    return this.items.slice(Math.max(0, this.items.length - n));
  }
}

// --- Data models ------------------------------------------------------------

/** Represents a single pi agent invocation with full context. */
class AgentInvocation {
  pr_number: number | null;
  mode: string;
  prompt: string;
  prompt_size: number;
  timestamp: Date;
  result: Record<string, unknown>;
  duration: number | null;
  success: boolean | null;

  constructor(opts: {
    pr_number: number | null;
    mode: string;
    prompt: string;
    prompt_size: number;
    timestamp: Date;
    result?: Record<string, unknown>;
    duration?: number | null;
    success?: boolean | null;
  }) {
    this.pr_number = opts.pr_number;
    this.mode = opts.mode;
    this.prompt = opts.prompt;
    this.prompt_size = opts.prompt_size;
    this.timestamp = opts.timestamp;
    this.result = opts.result ?? {};
    this.duration = opts.duration ?? null;
    this.success = opts.success ?? null;
  }

  /** Convert to a dictionary for serialization. */
  toDict(): Record<string, unknown> {
    const result = asRecord(this.result);
    return {
      pr_number: this.pr_number,
      mode: this.mode,
      prompt: this.prompt.slice(0, 500),
      prompt_size: this.prompt_size,
      timestamp: this.timestamp.toISOString(),
      result: {
        returncode: result["returncode"] ?? null,
        stdout: toStr(result["stdout"]).slice(0, 200),
        stderr: toStr(result["stderr"]).slice(0, 200),
      },
      duration: this.duration,
      success: this.success,
    };
  }
}

// --- LogWriter --------------------------------------------------------------

/** Handles logging to both file and console. */
class LogWriter {
  readonly logFilePath: string | null;
  private fd: number | null = null;

  constructor(logFilePath: string | null = null) {
    this.logFilePath = logFilePath;
    if (logFilePath) {
      try {
        this.fd = openSync(logFilePath, "a");
        this.writeSeparator();
        this.log(`=== Dashboard started at ${nowIso()} ===`);
      } catch (e) {
        console.error(`Warning: Could not open log file ${logFilePath}: ${errMsg(e)}`);
      }
    }
  }

  private writeSeparator(): void {
    if (this.fd !== null) writeSync(this.fd, "\n" + "=".repeat(80) + "\n");
  }

  /** Write a message to the log file. */
  log(message: string): void {
    if (this.fd !== null) writeSync(this.fd, `[${nowIso()}] ${message}\n`);
  }

  /** Write a JSON event to the log file. */
  logJson(event: Record<string, unknown>): void {
    if (this.fd !== null) writeSync(this.fd, JSON.stringify(event) + "\n");
  }

  /** Close the log file. */
  close(): void {
    if (this.fd !== null) {
      this.log(`=== Dashboard stopped at ${nowIso()} ===`);
      this.writeSeparator();
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

// --- PR queue / processing info ---------------------------------------------

interface PRQueueInfo {
  number: number;
  title: string;
  head_branch: string;
  base_branch: string;
  ci_status: string;
  ci_failing: boolean;
}

interface PRQueue {
  for_review: PRQueueInfo[];
  for_landing: PRQueueInfo[];
  untagged: PRQueueInfo[];
}

interface ProcessingPR {
  number: number | string;
  title: string;
  mode: string;
  head_branch: string;
  base_branch: string;
  started_at: Date;
}

interface RepoStats {
  prs_processed: number;
  successes: number;
  failures: number;
  iteration: number;
}

/** Convert a raw pr_details record into a PRQueueInfo. */
function toQueueInfo(pr: Record<string, unknown>): PRQueueInfo {
  return {
    number: toNum(pr["number"]),
    title: toStr(pr["title"]),
    head_branch: toStr(pr["head_branch"]),
    base_branch: toStr(pr["base_branch"]),
    ci_status: toStr(pr["ci_status"]),
    ci_failing: Boolean(pr["ci_failing"]),
  };
}

/** Return true if the two sets share any element. */
function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

// --- RepoMonitor ------------------------------------------------------------

/**
 * Monitors a single repository's PR processing.
 *
 * Spawns pr-loop.ts as a child process, reads its JSON event stream, and tracks
 * status, logs, PR queue, and agent invocation history.
 */
class RepoMonitor {
  readonly config: Record<string, unknown>;
  readonly scriptPath: string;
  readonly doormatConfig: Record<string, unknown>;
  readonly logWriter: LogWriter | null;
  readonly hasTty: boolean;
  readonly db: DbStores | null;
  readonly name: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly watchIssues: boolean;
  readonly interactive: boolean;

  process: ChildProcess | null = null;
  status = "idle";
  current_pr: string | null = null;
  current_action: string | null = null;
  last_update: Date | null = null;
  logs = new BoundedArray<string>(50);
  pending_confirmation: Record<string, unknown> | null = null;
  stats: RepoStats = { prs_processed: 0, successes: 0, failures: 0, iteration: 0 };

  stateTracker: StateTracker | null = null;
  repoState: import("./models").RepositoryState | null = null;
  stateLoadError: string | null = null;
  stateLoading = false;
  stateLoaded = false;

  prQueue: PRQueue = { for_review: [], for_landing: [], untagged: [] };

  processingPR: ProcessingPR | null = null;
  currentProcessingId: number | null = null;

  agentHistory = new BoundedArray<AgentInvocation>(50);
  currentAgentInvocation: AgentInvocation | null = null;
  agentRunning = false;

  private pendingLines: string[] = [];
  private lineBuffer = "";
  private exited = false;
  private exitCode: number | null = null;
  private signalCode: NodeJS.Signals | null = null;

  constructor(opts: {
    repoConfig: Record<string, unknown>;
    scriptPath: string;
    doormatConfig?: Record<string, unknown>;
    logWriter?: LogWriter | null;
    hasTty?: boolean;
    db?: DbStores | null;
  }) {
    this.config = opts.repoConfig;
    this.scriptPath = opts.scriptPath;
    this.doormatConfig = opts.doormatConfig ?? {};
    this.logWriter = opts.logWriter ?? null;
    this.hasTty = opts.hasTty ?? false;
    this.db = opts.db ?? null;
    this.name = toStr(opts.repoConfig["name"], "Unknown");
    this.path = toStr(opts.repoConfig["path"], "");
    this.enabled = opts.repoConfig["enabled"] !== false;
    this.watchIssues = Boolean(opts.repoConfig["watch_issues"]);
    this.interactive = opts.repoConfig["interactive"] !== false;

    if (this.db) this.recoverStateFromDb();
  }

  /** Recover previous dashboard state from database. */
  private recoverStateFromDb(): void {
    if (!this.db) return;
    try {
      void this.db.syncStore.saveRepository(this.name, this.path).catch((e) => {
        if (isDbError(e)) {
          this.logs.append(`⚠ Failed to save repository: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
        }
      });
      const prevState = this.db.appStore.getDashboardState(this.name);
      if (prevState) {
        this.stats.prs_processed = toNum(prevState["prs_processed"]);
        this.stats.successes = toNum(prevState["successes"]);
        this.stats.failures = toNum(prevState["failures"]);
        this.stats.iteration = toNum(prevState["iteration"]);
        this.logs.append(`↻ Recovered state: ${this.stats.prs_processed} PRs processed`);
        const history = this.db.appStore.getProcessingHistory(this.name, null, 3);
        if (history.length > 0) this.logs.append(`  Recent history: ${history.length} records`);
      }
    } catch (e) {
      if (isDbError(e)) {
        this.logs.append(`⚠ Failed to recover state: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
      }
    }
  }

  /** Load agent invocation history from database. */
  loadAgentHistoryFromDb(): boolean {
    if (!this.db) return false;
    try {
      const history = this.db.appStore.getProcessingHistory(this.name, null, 50);
      this.agentHistory.clear();
      for (const record of history.slice().reverse()) {
        if (record["completed_at"]) {
          const metadata = asRecord(record["metadata"]);
          const prNumber = toNum(record["pr_number"]);
          const invocation = new AgentInvocation({
            pr_number: prNumber,
            mode: toStr(record["action_type"]),
            prompt: toStr(metadata["title"], `PR #${prNumber}`),
            prompt_size: 0,
            timestamp: toDate(record["started_at"]),
          });
          invocation.success = Boolean(record["success"]);
          invocation.duration = (record["duration_seconds"] as number | null) ?? null;
          invocation.result = {
            returncode: invocation.success ? 0 : 1,
            stdout: invocation.success ? "" : toStr(record["error_message"]),
            stderr: !invocation.success ? toStr(record["error_message"]) : "",
          };
          this.agentHistory.append(invocation);
        }
      }
      if (this.agentHistory.length > 0) {
        this.logs.append(`↻ Loaded ${this.agentHistory.length} agent invocations from database`);
      }
      return true;
    } catch (e) {
      if (isDbError(e)) {
        this.logs.append(
          `⚠ Failed to load agent history: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`,
        );
      }
      return false;
    }
  }

  /** Refresh data needed for a specific view ("pr_dashboard" | "agent_dashboard"). */
  refreshDataForView(viewName: string): void {
    if (viewName === "agent_dashboard") {
      if (this.agentHistory.length === 0 && this.db) this.loadAgentHistoryFromDb();
      if (!this.stateLoaded && !this.stateLoading) {
        this.logs.append("⏳ Loading repository state for agent view...");
        if (!this.stateTracker) void this.initializeStateTracker();
      }
    } else if (viewName === "pr_dashboard") {
      if (this.repoState && !this.processingPR) {
        const total =
          this.prQueue.for_review.length +
          this.prQueue.for_landing.length +
          this.prQueue.untagged.length;
        if (total === 0) this.populatePrQueueFromState(false);
      }
    }
  }

  /** Persist current state to database. */
  private persistState(): void {
    if (!this.db) return;
    try {
      this.db.appStore.saveDashboardState(
        this.name,
        this.status,
        this.stats as unknown as Record<string, unknown>,
        this.processingPR
          ? typeof this.processingPR.number === "number"
            ? this.processingPR.number
            : null
          : null,
        {
          pr_queue_sizes: {
            for_review: this.prQueue.for_review.length,
            for_landing: this.prQueue.for_landing.length,
            untagged: this.prQueue.untagged.length,
          },
        },
      );
      if (this.repoState) {
        void this.db.syncStore.saveRepositoryState(this.name, this.repoState).catch((e) => {
          if (isDbError(e)) {
            this.logs.append(`⚠ Failed to save repository state: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
          }
        });
      }
    } catch (e) {
      if (isDbError(e)) {
        this.logs.append(`⚠ Failed to persist state: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
      }
    }
  }

  /** Load doormat credentials if doormat is available (non-fatal on failure). */
  loadDoormatCredentials(): boolean {
    try {
      const check = spawnSync("which", ["doormat"], { encoding: "utf8", timeout: 5000 });
      if (check.status !== 0) return true;

      const timeout = toNum(this.doormatConfig["timeout"], 30);
      let doormatCommands: string[][];
      if (this.doormatConfig["command"] !== undefined) {
        doormatCommands = [[toStr(this.doormatConfig["command"])]];
      } else {
        doormatCommands = [
          ["doormat"],
          ["doormat", "login"],
          ["doormat", "aws", "login"],
          ["doormat", "exec"],
        ];
      }

      this.logs.append("Loading doormat credentials...");
      let success = false;
      let lastError: string | null = null;
      for (const cmd of doormatCommands) {
        try {
          const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
            encoding: "utf8",
            timeout: timeout * 1000,
          });
          if (result.status === 0) {
            this.logs.append(`✓ Doormat credentials loaded (${cmd.join(" ")})`);
            success = true;
            break;
          }
          lastError = result.stderr || `exit ${result.status}`;
        } catch (e) {
          lastError = e instanceof Error && /timeout/i.test(e.message) ? "timeout" : errMsg(e);
        }
      }

      if (!success) {
        this.logs.append("⚠ Could not load doormat credentials (tried multiple commands)");
        if (lastError && doormatCommands.length === 1) {
          const msg =
            lastError === "timeout" ? "operation timed out" : lastError.slice(0, ERROR_TRUNCATE_LENGTH);
          this.logs.append(`  Error: ${msg}`);
        }
        this.logs.append("  Continuing without credential refresh...");
      }
      return true;
    } catch (e) {
      this.logs.append(`⚠ Doormat error: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
      return true;
    }
  }

  /**
   * Populate PR queue from repository state for immediate dashboard display.
   *
   * @param force If true, overwrite existing queue. If false, only populate if empty.
   */
  populatePrQueueFromState(force: boolean): void {
    if (!this.repoState) return;

    const existingCount =
      this.prQueue.for_review.length +
      this.prQueue.for_landing.length +
      this.prQueue.untagged.length;
    if (!force && existingCount > 0) return;

    const branchesWithPRs = getBranchesWithPRs(this.repoState);
    const forReview: PRQueueInfo[] = [];
    const forLanding: PRQueueInfo[] = [];
    const untagged: PRQueueInfo[] = [];

    for (const branchState of branchesWithPRs) {
      const pr = branchState.pr;
      if (!pr) continue;
      if (pr.state !== PRState.OPEN || pr.draft) continue;
      const labelsLower = new Set(pr.labels.map((l) => l.toLowerCase()));
      if (setsIntersect(labelsLower, WIP_LABELS)) continue;

      const ciStatus = getPRCiStatus(pr);
      const prInfo: PRQueueInfo = {
        number: pr.number,
        title: pr.title,
        head_branch: pr.head_branch,
        base_branch: pr.base_branch,
        ci_status: ciStatus,
        ci_failing: ciStatus === CIStatus.FAILURE,
      };

      const mode = getProcessingMode(pr);
      if (mode === "for-review") forReview.push(prInfo);
      else if (mode === "for-landing") forLanding.push(prInfo);
      else untagged.push(prInfo);
    }

    const sortKey = (pr: PRQueueInfo): [boolean, number] => [!pr.ci_failing, pr.number];
    const cmp = (a: PRQueueInfo, b: PRQueueInfo): number => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka[0] !== kb[0] ? (ka[0] ? 1 : -1) : ka[1] - kb[1];
    };
    forReview.sort(cmp);
    forLanding.sort(cmp);
    untagged.sort((a, b) => a.number - b.number);

    this.prQueue = { for_review: forReview, for_landing: forLanding, untagged };

    const total = forReview.length + forLanding.length + untagged.length;
    if (total > 0) {
      const failingCount = forReview.concat(forLanding).filter((p) => p.ci_failing).length;
      const failingNote = failingCount > 0 ? `, ${failingCount} failing CI` : "";
      this.logs.append(
        `✓ Found ${total} PRs (review:${forReview.length}, landing:${forLanding.length}, skip:${untagged.length}${failingNote})`,
      );
    }
  }

  /** Initialize state tracker and load initial repository state. */
  async initializeStateTracker(): Promise<boolean> {
    if (!this.enabled) return false;
    this.stateLoading = true;
    const startTime = Date.now();
    try {
      this.logs.append("⏳ [1/3] Initializing state tracker...");
      let phaseStart = Date.now();
      this.stateTracker = new StateTracker(this.path);
      this.logs.append(
        `✓ [1/3] State tracker initialized (${((Date.now() - phaseStart) / 1000).toFixed(1)}s)`,
      );

      this.logs.append("⏳ [2/3] Loading branches and PRs from local cache...");
      phaseStart = Date.now();
      this.repoState = await this.stateTracker.buildRepositoryState({
        fetchFirst: false,
        includeClosedPRs: false,
      });
      const summary = repositoryStateSummary(this.repoState);
      this.logs.append(
        `✓ [2/3] Loaded in ${((Date.now() - phaseStart) / 1000).toFixed(1)}s: ${summary["total_branches"]} branches, ${summary["branches_with_prs"]} with PRs`,
      );
      if (toNum(summary["failing_ci"]) > 0) {
        this.logs.append(`  ⚠ ${summary["failing_ci"]} PRs with failing CI`);
      }

      this.logs.append("⏳ [3/3] Building PR processing queue...");
      phaseStart = Date.now();
      this.populatePrQueueFromState(false);
      this.logs.append(`✓ [3/3] Queue built (${((Date.now() - phaseStart) / 1000).toFixed(1)}s)`);

      const elapsed = (Date.now() - startTime) / 1000;
      this.logs.append(`✓ State initialization complete in ${elapsed.toFixed(1)}s`);

      if (this.logWriter) {
        this.logWriter.logJson({
          event: "repo_state_initialized",
          repo: this.name,
          data: summary,
          elapsed_seconds: elapsed,
        });
      }

      this.stateLoaded = true;
      this.stateLoading = false;
      return true;
    } catch (e) {
      const elapsed = (Date.now() - startTime) / 1000;
      const errorMsg = `Failed to initialize state tracker: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`;
      this.logs.append(`⚠ ${errorMsg} (after ${elapsed.toFixed(1)}s)`);
      this.stateLoadError = errorMsg;
      this.stateLoading = false;
      this.stateLoaded = false;
      if (this.logWriter) {
        this.logWriter.logJson({
          event: "repo_state_error",
          repo: this.name,
          error: errMsg(e),
          elapsed_seconds: elapsed,
        });
      }
      return false;
    }
  }

  /** Refresh the repository state and PR queue. */
  async refreshRepositoryState(fetchFirst = false): Promise<boolean> {
    if (!this.stateTracker) return false;
    try {
      this.repoState = await this.stateTracker.buildRepositoryState({
        fetchFirst,
        includeClosedPRs: false,
      });
      this.populatePrQueueFromState(true);
      return true;
    } catch (e) {
      if (e instanceof StateTrackerError) {
        this.logs.append(`⚠ State refresh failed: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
      }
      return false;
    }
  }

  /** Start the pr-loop.ts subprocess for this repo. */
  start(): boolean {
    if (!this.enabled) {
      this.status = "disabled";
      return false;
    }
    if (this.process && !this.exited) return true;

    this.logs.append("⏳ Loading branch/PR state in background...");
    void this.initializeStateTracker();
    this.loadDoormatCredentials();

    try {
      const args = ["--import", "tsx", this.scriptPath, this.path];
      if (this.watchIssues) args.push("--watch-issues");
      if (this.hasTty && this.interactive) args.push("--interactive");

      const child = spawn(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (data: string) => this.onChildData(data));
      child.stderr?.on("data", (data: string) => this.onChildData(data));
      child.on("exit", (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.signalCode = signal;
      });

      this.status = "starting";
      const modeStr = this.hasTty && this.interactive ? " (interactive)" : " (automated)";
      this.logs.append(`▶ Starting pr-loop.ts for ${this.name}${modeStr}`);
      return true;
    } catch (e) {
      const errorMsg = errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH);
      this.status = `error: ${errorMsg}`;
      this.logs.append(`✗ CRITICAL: Failed to start: ${errorMsg}`);
      return false;
    }
  }

  private onChildData(data: string): void {
    this.lineBuffer += data;
    let idx: number;
    while ((idx = this.lineBuffer.indexOf("\n")) >= 0) {
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      this.pendingLines.push(line);
    }
  }

  /** Send confirmation response to pr-loop.ts via stdin. */
  sendConfirmationResponse(approved: boolean): boolean {
    if (!this.process || !this.process.stdin) return false;
    try {
      this.process.stdin.write(JSON.stringify({ approved }) + "\n");
      this.pending_confirmation = null;
      return true;
    } catch (e) {
      this.logs.append(`⚠ Error sending confirmation: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
      return false;
    }
  }

  /** Stop the subprocess. */
  stop(): void {
    if (this.process && !this.exited) {
      const proc = this.process;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5000);
    }
    this.status = "stopped";
  }

  /** Read and parse JSON logs from the subprocess. */
  readOutput(): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = [];
    while (this.pendingLines.length > 0) {
      const line = this.pendingLines.shift()!;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        events.push(event);
        this.processEvent(event);
      } catch {
        this.logs.append(trimmed);
      }
    }
    if (this.exited && this.status !== "crashed") {
      this.status = "crashed";
      this.logs.append(`✗ CRITICAL: Process crashed (exit code: ${this.exitCode ?? "?"})`);
    }
    return events;
  }

  /** Process a JSON log event and update state. */
  processEvent(event: Record<string, unknown>): void {
    this.last_update = new Date();
    const eventType = toStr(event["event"]);
    const data = asRecord(event["data"]);

    if (this.logWriter) {
      this.logWriter.logJson({ ...event, repo: this.name });
    }

    if (eventType === "startup") {
      this.status = "running";
      this.logs.append(`✓ Started monitoring ${this.name}`);
    } else if (eventType === "iteration") {
      this.handleIteration(data);
    } else if (eventType === "fetch_prs") {
      this.handleFetchPrs(data);
    } else if (eventType === "process_pr") {
      this.handleProcessPr(data);
    } else if (eventType === "agent_action") {
      this.handleAgentAction(data);
    } else if (eventType === "agent_progress") {
      const current = toNum(data["current"]);
      const total = toNum(data["total"]);
      const percentage = toNum(data["percentage"]);
      this.current_action = `Progress: ${current}/${total} (${Math.round(percentage)}%)`;
    } else if (eventType === "agent_error") {
      this.handleAgentError(data);
    } else if (eventType === "agent_retry") {
      const retryAttempt = toNum(data["retry_attempt"]);
      const maxRetries = toNum(data["max_retries"], 3);
      const backoffSeconds = toNum(data["backoff_seconds"]);
      this.logs.append(`  🔄 Retry ${retryAttempt}/${maxRetries} (waiting ${backoffSeconds}s)`);
      this.current_action = `Retrying (${retryAttempt}/${maxRetries})...`;
    } else if (eventType === "notification") {
      if (toStr(data["action"]) === "sent") {
        this.logs.append(`📱 Notification: ${toStr(data["title"])}`);
      }
    } else if (eventType === "sync_repo") {
      if (toStr(data["action"]) === "start") this.current_action = "Syncing repository";
      else if (toStr(data["action"]) === "complete") this.current_action = null;
    } else if (eventType === "gather_pr_context") {
      this.handleGatherPrContext(data);
    } else if (eventType === "request_confirmation") {
      this.pending_confirmation = event;
      const actionType = toStr(data["action_type"], "unknown");
      const description = toStr(data["description"], "Perform action");
      this.current_action = `⚠ Awaiting confirmation: ${description}`;
      this.logs.append(`⚠ Confirmation needed: ${actionType}`);
    }
  }

  private handleIteration(data: Record<string, unknown>): void {
    const action = toStr(data["action"]);
    this.stats.iteration = toNum(data["number"]);
    if (action === "start") {
      this.status = "scanning";
      this.current_action = "Scanning for PRs";
    } else if (action === "prs_categorized") {
      const forReview = toNum(data["for_review"]);
      const forLanding = toNum(data["for_landing"]);
      const untagged = toNum(data["untagged"]);
      this.logs.append(
        `Found ${forReview + forLanding} PRs (review:${forReview}, landing:${forLanding}, skip:${untagged})`,
      );
      const prDetails = asRecord(data["pr_details"]);
      if (Object.keys(prDetails).length > 0) {
        const reviewPrs = asArray(prDetails["for_review"]).map(asRecord);
        const landingPrs = asArray(prDetails["for_landing"]).map(asRecord);
        const untaggedPrs = asArray(prDetails["untagged"]).map(asRecord);
        this.prQueue = {
          for_review: reviewPrs.map(toQueueInfo),
          for_landing: landingPrs.map(toQueueInfo),
          untagged: untaggedPrs.map(toQueueInfo),
        };
        for (const pr of reviewPrs) {
          this.logs.append(`  ✓ for-review: PR #${pr["number"]} - ${toStr(pr["title"])}`);
        }
        for (const pr of landingPrs) {
          this.logs.append(`  ✓ for-landing: PR #${pr["number"]} - ${toStr(pr["title"])}`);
        }
        for (const pr of untaggedPrs.slice(0, 5)) {
          this.logs.append(`  ⊗ untagged: PR #${pr["number"]} - ${toStr(pr["title"])}`);
        }
        if (untaggedPrs.length > 5) {
          this.logs.append(`  ⊗ ... and ${untaggedPrs.length - 5} more untagged`);
        }
      }
    } else if (action === "complete") {
      this.status = "idle";
      this.current_pr = null;
      this.current_action = "Waiting for next cycle";
    }
  }

  private handleFetchPrs(data: Record<string, unknown>): void {
    const action = toStr(data["action"]);
    if (action === "skip_draft") {
      const prNumber = data["pr_number"] ?? "?";
      const title = truncate(toStr(data["title"]), 40);
      this.logs.append(`  ⊗ Skipped draft: PR #${prNumber} - ${title}`);
    } else if (action === "skip_wip") {
      const prNumber = data["pr_number"] ?? "?";
      const title = truncate(toStr(data["title"]), 40);
      const wipLabel = toStr(data["wip_label"], "wip");
      this.logs.append(`  ⊗ Skipped WIP: PR #${prNumber} - ${title} (label: ${wipLabel})`);
    }
  }

  private handleProcessPr(data: Record<string, unknown>): void {
    const action = toStr(data["action"]);
    const prNumberRaw = data["pr_number"];
    const prNumber: number | string =
      typeof prNumberRaw === "number" ? prNumberRaw : toStr(prNumberRaw, "?");

    if (action === "start") {
      this.current_pr = `PR #${prNumber}`;
      this.status = "processing";
      const title = toStr(data["title"]);
      const mode = toStr(data["mode"], toStr(data["head_branch"]));
      const headBranch = toStr(data["head_branch"]);
      const baseBranch = toStr(data["base_branch"]);
      this.processingPR = {
        number: prNumber,
        title,
        mode,
        head_branch: headBranch,
        base_branch: baseBranch,
        started_at: new Date(),
      };
      this.current_action = `Processing ${truncate(title, 50)}... (mode: ${mode})`;
      const modeEmoji = mode === "for-review" ? "🔍" : "🚀";
      this.logs.append(`${modeEmoji} PR #${prNumber} started: ${truncate(title, 50)}`);
      this.logs.append(`  Mode: ${mode} | Branch: ${headBranch} → ${baseBranch}`);
      if (this.db) {
        try {
          this.currentProcessingId = this.db.appStore.recordProcessingStart(
            this.name,
            toNum(prNumber),
            mode,
            { title, head_branch: headBranch, base_branch: baseBranch },
          );
        } catch (e) {
          if (isDbError(e)) {
            this.logs.append(`⚠ DB error: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
          }
        }
      }
    } else if (
      action === "gathering_context" ||
      action === "building_context" ||
      action === "initializing_agent"
    ) {
      const phase = toStr(data["phase"]);
      const phaseName = toStr(data["phase_name"]);
      this.current_action = `[${phase}] ${phaseName}...`;
      this.logs.append(`  [${phase}] ${phaseName}...`);
    } else if (action === "context_gathered") {
      this.logs.append(`  ✓ [${toStr(data["phase"])}] Context gathered`);
    } else if (action === "context_built") {
      this.logs.append(`  ✓ [${toStr(data["phase"])}] Context ready`);
    } else if (action === "agent_initialized") {
      this.logs.append(
        `  ✓ [${toStr(data["phase"])}] Agent ready (model: ${toStr(data["model"], "unknown")})`,
      );
    } else if (action === "agent_processing") {
      const phase = toStr(data["phase"]);
      const phaseName = toStr(data["phase_name"], "Processing");
      this.current_action = `[${phase}] ${phaseName}...`;
      this.logs.append(`  🤖 [${phase}] ${phaseName}...`);
      this.agentRunning = true;
      if (this.processingPR) {
        const prNum = this.processingPR.number;
        this.currentAgentInvocation = new AgentInvocation({
          pr_number: typeof prNum === "number" ? prNum : null,
          mode: this.processingPR.mode,
          prompt: `Processing PR #${prNum}`,
          prompt_size: 0,
          timestamp: new Date(),
        });
      }
    } else if (action === "prompt_generated") {
      const promptSize = toNum(data["prompt_size"]);
      this.current_action = `Prompt generated (${promptSize} chars), starting agent...`;
    } else if (action === "running_bob") {
      this.current_action = "Running agent to process PR...";
      this.agentRunning = true;
    } else if (action === "bob_complete") {
      const returncode = toNum(data["returncode"], -1);
      const stdout = toStr(data["stdout"]);
      const stderr = toStr(data["stderr"]);
      this.current_action =
        returncode === 0
          ? "Agent completed successfully"
          : `Agent completed with errors (code: ${returncode})`;
      this.agentRunning = false;
      if (this.currentAgentInvocation) {
        this.currentAgentInvocation.result = { returncode, stdout, stderr };
        this.currentAgentInvocation.success = returncode === 0;
        this.currentAgentInvocation.duration =
          (Date.now() - this.currentAgentInvocation.timestamp.getTime()) / 1000;
        this.agentHistory.append(this.currentAgentInvocation);
        this.currentAgentInvocation = null;
      }
    } else if (action === "review_pass_start") {
      this.current_action = "Starting second pass for code review...";
    } else if (action === "complete") {
      const success = Boolean(data["success"]);
      const duration = toNum(data["duration"]);
      const tasksTotal = toNum(data["tasks_total"]);
      const tasksCompleted = toNum(data["tasks_completed"]);
      const actionsTaken = toNum(data["actions_taken"]);
      if (success) {
        this.stats.successes += 1;
        this.logs.append(
          `✓ Completed PR #${prNumber} in ${duration.toFixed(1)}s (${tasksCompleted}/${tasksTotal} tasks, ${actionsTaken} actions)`,
        );
      } else {
        this.stats.failures += 1;
        const reason = toStr(data["reason"], "unknown");
        this.logs.append(`✗ Failed PR #${prNumber}: ${reason} (after ${duration.toFixed(1)}s)`);
      }
      this.stats.prs_processed += 1;
      if (this.db && this.currentProcessingId !== null) {
        try {
          this.db.appStore.recordProcessingComplete(
            this.currentProcessingId,
            success,
            success ? null : toStr(data["reason"]) || null,
          );
        } catch (e) {
          if (isDbError(e)) {
            this.logs.append(`⚠ DB error: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
          }
        }
      }
      this.persistState();
      this.processingPR = null;
      this.current_action = null;
      this.currentProcessingId = null;
    }
  }

  private handleAgentAction(data: Record<string, unknown>): void {
    const actionType = toStr(data["action_type"], "unknown");
    const target = toStr(data["target"]);
    const status = toStr(data["status"]);
    const actionNumber = toNum(data["action_number"]);
    const emojis: Record<string, string> = {
      git_commit: "💾",
      gh_comment: "💬",
      merge_pr: "🔀",
      file_edit: "✏️",
      run_tests: "🧪",
      read_file: "📖",
    };
    const emoji = emojis[actionType] ?? "⚙️";
    if (status === "completed") {
      this.logs.append(`  ${emoji} Action #${actionNumber}: ${actionType} - ${truncate(target, 40)}`);
      this.current_action = `Completed: ${actionType} - ${truncate(target, 40)}`;
    } else if (status === "failed") {
      this.logs.append(`  ✗ Action #${actionNumber} failed: ${actionType} - ${truncate(target, 40)}`);
    }
  }

  private handleAgentError(data: Record<string, unknown>): void {
    const error = toStr(data["error"], "Unknown error");
    const errorType = toStr(data["error_type"]);
    const willRetry = Boolean(data["will_retry"]);
    if (willRetry) {
      const retryCount = toNum(data["retry_count"]);
      this.logs.append(`  ⚠ ${errorType}: ${truncate(error, 60)}... (retrying ${retryCount})`);
    } else {
      this.logs.append(`  ✗ ${errorType}: ${truncate(error, 60)}`);
    }
  }

  private handleGatherPrContext(data: Record<string, unknown>): void {
    const action = toStr(data["action"]);
    const prNumber = data["pr_number"] ?? "?";
    if (action === "start") {
      this.current_action = `Gathering context for PR #${prNumber}...`;
      this.logs.append("  📋 Gathering PR context...");
    } else if (action === "complete") {
      const summary = asRecord(data["context_summary"]);
      const comments = toNum(summary["comments"]);
      const reviewComments = toNum(summary["review_comments"]);
      const commits = toNum(summary["commits"]);
      const files = toNum(summary["files"]);
      const hasConflicts = Boolean(summary["has_conflicts"]);
      const ciFailed = toNum(summary["ci_failed"]);
      this.logs.append(
        `  ✓ Context: ${comments} comments, ${reviewComments} reviews, ${commits} commits, ${files} files`,
      );
      if (hasConflicts) this.logs.append("  ⚠ Merge conflicts detected");
      if (ciFailed > 0) this.logs.append(`  ✗ ${ciFailed} CI checks failing`);
    }
  }
}

// --- Dashboard --------------------------------------------------------------
/** Repo config entry shape loaded from YAML. */
interface RepoConfigEntry {
  path?: string;
  name?: string;
  enabled?: boolean;
  watch_issues?: boolean;
  interactive?: boolean;
}

/** Main dashboard that manages multiple repository monitors. */
class Dashboard {
  readonly configPath: string;
  readonly scriptPath: string;
  readonly dryRun: boolean;
  readonly logWriter: LogWriter | null;
  monitors: RepoMonitor[] = [];
  readonly startTime = new Date();
  readonly hasTty: boolean;

  currentScreen: "pr_dashboard" | "agent_dashboard" = "pr_dashboard";
  readonly screens = ["pr_dashboard", "agent_dashboard"] as const;

  db: DbStores | null = null;
  private dbPath: string | null = null;

  private running = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private prompting = false;
  private keyBuffer: string[] = [];
  private rawMode = false;
  private lastStatusTime = Date.now();
  private lastLogPositions = new Map<string, number>();

  private readonly keyHandler = (data: Buffer | string): void => {
    if (this.prompting) return;
    const str = typeof data === "string" ? data : data.toString("utf8");
    for (const ch of str) this.keyBuffer.push(ch);
  };

  constructor(opts: {
    configPath: string;
    scriptPath: string;
    dryRun?: boolean;
    logWriter?: LogWriter | null;
    dbPath?: string | null;
  }) {
    this.configPath = opts.configPath;
    this.scriptPath = opts.scriptPath;
    this.dryRun = opts.dryRun ?? false;
    this.logWriter = opts.logWriter ?? null;
    this.hasTty = Boolean(process.stdout.isTTY);

    if (!this.dryRun && opts.dbPath) {
      try {
        const syncStore = new SyncStore(opts.dbPath);
        const appStore = new AppStore(opts.dbPath);
        this.db = { syncStore, appStore };
        this.dbPath = opts.dbPath;
        this.logWriter?.log(`Database initialized: ${opts.dbPath}`);
      } catch (e) {
        if (isDbError(e)) {
          this.logWriter?.log(`Warning: Failed to initialize database: ${errMsg(e)}`);
        }
      }
    }
    this.logWriter?.log(
      `Dashboard initialized (TTY: ${this.hasTty}, dry_run: ${this.dryRun})`,
    );
  }

  /** Initialize the SyncStore schema (async). Call after construction. */
  async initDb(): Promise<void> {
    if (this.db) {
      try {
        await this.db.syncStore.initialize();
      } catch (e) {
        if (isDbError(e)) {
          this.logWriter?.log(`Warning: Failed to initialize sync store: ${errMsg(e)}`);
        }
      }
    }
  }

  /** Load configuration from YAML file. */
  loadConfig(): boolean {
    let config: unknown;
    try {
      config = YAML.parse(readFileSync(this.configPath, "utf8"));
    } catch (e) {
      if (e instanceof Error && /ENOENT/.test(errMsg(e))) {
        this.consolePrint(chalk.red(`Error: Config file not found: ${this.configPath}`));
      } else {
        this.consolePrint(chalk.red(`Error parsing YAML: ${errMsg(e)}`));
      }
      return false;
    }

    const cfg = asRecord(config);
    if (!cfg["repos"]) {
      this.consolePrint(chalk.red(`Error: No 'repos' section in ${this.configPath}`));
      return false;
    }
    const repos = asArray(cfg["repos"]);
    if (repos.length === 0) {
      this.consolePrint(chalk.red("Error: 'repos' must be a non-empty list"));
      return false;
    }

    const doormatConfig = asRecord(cfg["doormat"]);

    for (const repoRaw of repos) {
      const repoConfig = asRecord(repoRaw);
      if (typeof repoConfig["path"] !== "string") {
        this.consolePrint(chalk.yellow("Warning: Skipping repo without 'path'"));
        continue;
      }
      if (typeof repoConfig["name"] !== "string") {
        repoConfig["name"] = basename(repoConfig["path"]);
      }
      if (repoConfig["enabled"] === undefined) repoConfig["enabled"] = true;

      const monitor = new RepoMonitor({
        repoConfig,
        scriptPath: this.scriptPath,
        doormatConfig,
        logWriter: this.logWriter,
        hasTty: this.hasTty,
        db: this.db,
      });
      this.monitors.push(monitor);
    }

    if (this.monitors.length === 0) {
      this.consolePrint(chalk.red("Error: No valid repositories found in config"));
      return false;
    }
    return true;
  }

  /** Start all enabled repository monitors. */
  startAll(): void {
    for (const monitor of this.monitors) if (monitor.enabled) monitor.start();
  }

  /** Stop all repository monitors. */
  stopAll(): void {
    for (const monitor of this.monitors) monitor.stop();
  }

  /** Update all monitors by reading their output. */
  update(): void {
    for (const monitor of this.monitors) {
      if (monitor.enabled && monitor.status !== "disabled") monitor.readOutput();
    }
  }

  /** Write a single line to stdout (rich Console replacement). */
  private consolePrint(s: string): void {
    process.stdout.write(s + "\n");
  }

  // --- Rendering (TUI mode) -------------------------------------------------

  /** Render the full frame (header + body + footer) as an array of lines. */
  private renderFrame(): string[] {
    const frame: string[] = [];
    frame.push(...this.renderHeader());
    frame.push(...this.renderBody());
    frame.push(...this.renderFooter());
    return frame;
  }

  private renderHeader(): string[] {
    const uptimeStr = uptimeString(Date.now() - this.startTime.getTime());
    const enabledCount = this.monitors.filter((m) => m.enabled).length;
    const screenName =
      this.currentScreen === "pr_dashboard" ? "PR Dashboard" : "Agent Dashboard";
    const text = new Lines()
      .append("merge-god ", "bold cyan")
      .append("Dashboard", "bold")
      .append(` | Uptime: ${uptimeStr}`, "dim")
      .append(` | Repos: ${enabledCount}`, "dim")
      .append(` | Screen: ${screenName}`, "bold yellow")
      .render();
    return renderPanel("", text, "cyan");
  }

  private renderFooter(): string[] {
    const text = new Lines()
      .append("Press ", "dim")
      .append("1", "bold")
      .append(" for PR Dashboard | ", "dim")
      .append("2", "bold")
      .append(" for Agent Dashboard | ", "dim")
      .append("R", "bold")
      .append(" to Refresh | ", "dim")
      .append("Q", "bold")
      .append(" to quit", "dim")
      .render();
    return renderPanel("", text, "cyan");
  }

  private renderBody(): string[] {
    const enabled = this.monitors.filter((m) => m.enabled);
    if (enabled.length === 0) {
      return renderPanel("", [chalk.yellow("No enabled repositories")], "white");
    }
    const out: string[] = [];
    for (const monitor of enabled) {
      const panel =
        this.currentScreen === "pr_dashboard"
          ? this.renderRepoPanel(monitor)
          : this.renderAgentScreen(monitor);
      out.push(...panel);
      out.push("");
    }
    return out;
  }

  /** Generate panel for a single repository (PR dashboard view). */
  private renderRepoPanel(monitor: RepoMonitor): string[] {
    const statusKey = monitor.status.split(":")[0] ?? monitor.status;
    const statusStyleMap: Record<string, string> = {
      running: "green",
      processing: "yellow",
      scanning: "blue",
      idle: "dim",
      starting: "cyan",
      disabled: "dim",
      stopped: "red",
      crashed: "bold red",
    };
    const statusStyleVal = statusStyleMap[statusKey] ?? "white";

    const rows: GridRow[] = [];
    rows.push({
      label: "Status:",
      labelStyle: "bold",
      value: [{ text: monitor.status, style: statusStyleVal }],
    });
    rows.push({ label: "Path:", labelStyle: "bold", value: [{ text: monitor.path, style: "dim" }] });
    if (monitor.current_pr) {
      rows.push({
        label: "Current:",
        labelStyle: "bold",
        value: [{ text: monitor.current_pr, style: "cyan" }],
      });
    }
    if (monitor.current_action) {
      rows.push({
        label: "Action:",
        labelStyle: "bold",
        value: [{ text: monitor.current_action, style: "yellow" }],
      });
    }
    rows.push({
      label: "Processed:",
      labelStyle: "bold",
      value: [
        { text: `${monitor.stats.prs_processed} `, style: "white" },
        { text: `(✓ ${monitor.stats.successes} `, style: "green" },
        { text: `✗ ${monitor.stats.failures})`, style: "red" },
      ],
    });
    rows.push({
      label: "Iteration:",
      labelStyle: "bold",
      value: [{ text: String(monitor.stats.iteration), style: "white" }],
    });
    if (monitor.last_update) {
      const ago = (Date.now() - monitor.last_update.getTime()) / 1000;
      rows.push({
        label: "Last update:",
        labelStyle: "bold",
        value: [{ text: `${Math.floor(ago)}s ago`, style: "dim" }],
      });
    }
    const statusLines = renderGrid(rows);

    const stateLines = this.renderStateSection(monitor);
    const prQueueLines = this.renderPrQueueSection(monitor);
    const trajectoryLines = this.renderTrajectorySection(monitor);

    const logsLines = new Lines();
    for (const log of monitor.logs.sliceLast(8)) logsLines.append(log + "\n", "dim");
    const logsRendered = logsLines.render();

    const body: string[] = [];
    body.push(...statusLines);
    if (stateLines) body.push(...stateLines);
    if (prQueueLines) body.push(...prQueueLines);
    if (trajectoryLines) body.push(...trajectoryLines);
    body.push("");
    body.push(...logsRendered);

    const borderStyleMap: Record<string, string> = {
      running: "green",
      processing: "yellow",
      scanning: "blue",
      idle: "dim",
      disabled: "dim",
      crashed: "red",
    };
    const border = borderStyleMap[statusKey] ?? "white";
    return renderPanel(monitor.name, body, border);
  }

  private renderTrajectorySection(monitor: RepoMonitor): string[] | null {
    if (!this.db) return null;
    try {
      const run = this.db.appStore
        .getOrchestrationRuns(10)
        .find((item) => item.repo_name === monitor.name || item.repo_path === monitor.path);
      if (!run) return null;
      const state = this.db.appStore.getTrajectoryState(run.run_id);
      if (!state) return null;
      const activeActivities = state.activities.filter((activity) =>
        ["ready", "claimed", "running"].includes(activity.status),
      );
      const blockers = state.work_items.reduce((count, item) => count + item.blockers.length, 0);
      const text = new Lines();
      text.append("\nTrajectory:\n", "bold cyan");
      text.append(`  Run: ${run.status}`, run.status === "completed" ? "green" : "yellow");
      text.append(` | Phase: ${run.current_phase}`, "dim");
      text.append(` | Work items: ${state.work_items.length}`, "white");
      text.append(` | Active: ${activeActivities.length}`, activeActivities.length > 0 ? "yellow" : "dim");
      text.append(` | Events: ${state.events.length}\n`, "dim");
      if (blockers > 0) text.append(`  Blockers: ${blockers}\n`, "red");
      return text.render();
    } catch (e) {
      const text = new Lines();
      text.append("\nTrajectory: ", "bold cyan");
      text.append(`unavailable (${truncate(errMsg(e), 80)})\n`, "red dim");
      return text.render();
    }
  }

  private renderStateSection(monitor: RepoMonitor): string[] | null {
    const text = new Lines();
    if (monitor.stateLoading) {
      text.append("\n", "dim");
      text.append("⏳ Loading branch/PR state...\n", "cyan");
    } else if (monitor.repoState) {
      text.append("\n", "dim");
      text.append("Branch/PR Sync Status:\n", "bold cyan");
      const summary = repositoryStateSummary(monitor.repoState);
      const totalBranches = toNum(summary["total_branches"]);
      const branchesWithPRs = toNum(summary["branches_with_prs"]);
      const needingSync = toNum(summary["branches_needing_sync"]);
      const failingCi = toNum(summary["failing_ci"]);
      text.append(`  Branches: ${totalBranches}`, "white");
      text.append(` (${branchesWithPRs} with PRs)\n`, "dim");
      if (needingSync === 0 && totalBranches > 0) {
        text.append("  ✓ All branches synced\n", "green");
      }
      if (needingSync > 0) text.append(`  ⚠ Needs sync: ${needingSync}\n`, "yellow");
      if (failingCi > 0) text.append(`  ✗ Failing CI: ${failingCi}\n`, "red");
      else if (branchesWithPRs > 0) text.append("  ✓ All CI passing\n", "green");

      const failing = getFailingCI(monitor.repoState);
      if (failing.length > 0) {
        text.append("  Failing CI: ", "red");
        const names = failing.slice(0, 3).map((s) => s.branch_name);
        text.append(names.join(", "), "red dim");
        if (failing.length > 3) text.append(` +${failing.length - 3} more`, "dim");
        text.append("\n");
      }
      const needingSyncStates = getBranchesNeedingSync(monitor.repoState);
      if (needingSyncStates.length > 0) {
        text.append("  Out of sync: ", "yellow");
        const syncNames = needingSyncStates.slice(0, 3).map((s) => {
          const up = s.needs_push ? "↑" : "";
          const down = s.needs_pull ? "↓" : "";
          return `${s.branch_name} (${up}${down})`;
        });
        text.append(syncNames.join(", "), "yellow dim");
        if (needingSyncStates.length > 3) {
          text.append(` +${needingSyncStates.length - 3} more`, "dim");
        }
        text.append("\n");
      }
    } else if (monitor.stateLoadError) {
      text.append("\n", "dim");
      text.append("State Load Error: ", "red bold");
      text.append(truncate(monitor.stateLoadError, ERROR_TRUNCATE_LENGTH), "red dim");
      text.append("\n");
    }

    if (text.isEmpty) return null;
    return text.render();
  }

  private renderPrQueueSection(monitor: RepoMonitor): string[] | null {
    const text = new Lines();

    if (monitor.processingPR) {
      const pr = monitor.processingPR;
      text.append("\n", "dim");
      text.append("⚙  Currently Processing:\n", "bold yellow");
      text.append(`    PR #${pr.number}: `, "bold white");
      text.append(`${pr.title}\n`, "white");
      text.append("    Branch: ", "dim");
      text.append(pr.head_branch, "cyan");
      text.append(" → ", "dim");
      text.append(`${pr.base_branch}\n`, "cyan");
      const modeStyle = pr.mode === "for-review" ? "green" : "cyan";
      text.append("    Mode: ", "dim");
      text.append(`${pr.mode}\n`, modeStyle);
      const elapsed = (Date.now() - pr.started_at.getTime()) / 1000;
      const elapsedMins = Math.floor(elapsed / 60);
      const elapsedSecs = Math.floor(elapsed % 60);
      text.append("    Elapsed: ", "dim");
      text.append(`${elapsedMins}m ${elapsedSecs}s\n`, "yellow");
      if (monitor.current_action) {
        text.append("    Action: ", "dim");
        text.append(`${monitor.current_action}\n`, "yellow dim");
      }
    }

    const processingNumber = monitor.processingPR ? monitor.processingPR.number : null;
    const queuedForReview = monitor.prQueue.for_review.filter(
      (p) => p.number !== processingNumber,
    );
    const queuedForLanding = monitor.prQueue.for_landing.filter(
      (p) => p.number !== processingNumber,
    );
    const queuedUntagged = monitor.prQueue.untagged;
    const totalQueued =
      queuedForReview.length + queuedForLanding.length + queuedUntagged.length;

    if (totalQueued > 0) {
      text.append("\n", "dim");
      text.append("PR Processing Queue:\n", "bold cyan");
      if (queuedForReview.length > 0) {
        text.append(`  for-review (${queuedForReview.length}):\n`, "green bold");
        for (const pr of queuedForReview.slice(0, 3)) {
          text.append(`    • PR #${pr.number}: ${truncate(pr.title, 40)}\n`, "green dim");
        }
        if (queuedForReview.length > 3) {
          text.append(`    • ... +${queuedForReview.length - 3} more\n`, "green dim");
        }
      }
      if (queuedForLanding.length > 0) {
        text.append(`  for-landing (${queuedForLanding.length}):\n`, "cyan bold");
        for (const pr of queuedForLanding.slice(0, 3)) {
          text.append(`    • PR #${pr.number}: ${truncate(pr.title, 40)}\n`, "cyan dim");
        }
        if (queuedForLanding.length > 3) {
          text.append(`    • ... +${queuedForLanding.length - 3} more\n`, "cyan dim");
        }
      }
      if (queuedUntagged.length > 0) {
        text.append(`  untagged/skipped (${queuedUntagged.length}):\n`, "yellow bold");
        for (const pr of queuedUntagged.slice(0, 3)) {
          text.append(`    ⊗ PR #${pr.number}: ${truncate(pr.title, 40)}\n`, "yellow dim");
        }
        if (queuedUntagged.length > 3) {
          text.append(`    ⊗ ... +${queuedUntagged.length - 3} more\n`, "yellow dim");
        }
      }
    }

    if (text.isEmpty) return null;
    return text.render();
  }

  /** Generate panel showing agent invocation history. */
  private renderAgentScreen(monitor: RepoMonitor): string[] {
    const content = new Lines();
    content.append("Agent Invocation History", "bold cyan");
    if (monitor.agentRunning) content.append(" ⚙ RUNNING", "bold yellow");
    content.append("\n", "");

    if (monitor.currentAgentInvocation) {
      const inv = monitor.currentAgentInvocation;
      const elapsed = (Date.now() - inv.timestamp.getTime()) / 1000;
      content.append("🤖 Currently Running:\n", "bold yellow");
      content.append(`   PR #${inv.pr_number ?? "N/A"} | Mode: ${inv.mode}\n`, "white");
      content.append(`   Prompt size: ${inv.prompt_size} chars\n`, "dim");
      content.append(`   Started: ${formatTime(inv.timestamp)}\n`, "dim");
      content.append(`   Elapsed: ${Math.floor(elapsed)}s\n`, "yellow");
      content.append("\n", "");
    }

    if (monitor.agentHistory.length > 0) {
      content.append(`Recent Invocations (${monitor.agentHistory.length}):`, "bold cyan");
      content.append("\n", "");
      const recent = monitor.agentHistory.sliceLast(10).reverse();
      for (const inv of recent) {
        let statusIcon: string;
        let statusStyle: string;
        if (inv.success === true) {
          statusIcon = "✅";
          statusStyle = "green";
        } else if (inv.success === false) {
          statusIcon = "❌";
          statusStyle = "red";
        } else {
          statusIcon = "❓";
          statusStyle = "yellow";
        }
        content.append(`${statusIcon} `, statusStyle);
        content.append(`PR #${inv.pr_number ?? "N/A"} `, "bold white");
        content.append(`(${inv.mode})`, "cyan");
        content.append(` - ${formatTime(inv.timestamp)}`, "dim");
        if (inv.duration !== null) content.append(` [${Math.floor(inv.duration)}s]`, "yellow dim");
        content.append("\n", "");

        const resultObj = asRecord(inv.result);
        if (Object.keys(resultObj).length > 0) {
          const returncode = resultObj["returncode"];
          if (returncode === 0) content.append("   ✓ Success", "green dim");
          else content.append(`   ✗ Failed (code: ${returncode ?? "?"})`, "red dim");
          const stdout = toStr(resultObj["stdout"]);
          const stderr = toStr(resultObj["stderr"]);
          if (stdout) {
            content.append(` | Output: ${truncate(stdout.replace(/\n/g, " "), 80)}...`, "dim");
          }
          if (stderr) {
            content.append(` | Error: ${truncate(stderr.replace(/\n/g, " "), 80)}...`, "red dim");
          }
          content.append("\n", "");
        }
        content.append("\n", "");
      }
    } else {
      content.append("No agent invocations yet\n", "dim italic");
    }

    content.append("\n", "");
    content.append("Statistics:\n", "bold");
    const total = monitor.agentHistory.length;
    const successful = monitor.agentHistory.toArray().filter((i) => i.success === true).length;
    const failed = monitor.agentHistory.toArray().filter((i) => i.success === false).length;
    if (total > 0) {
      const rate = (successful / total) * 100;
      content.append(`  Total invocations: ${total}\n`, "white");
      content.append(`  Successful: ${successful} `, "green");
      content.append(`| Failed: ${failed}\n`, "red");
      content.append(`  Success rate: ${rate.toFixed(1)}%\n`, "cyan");
      const durations = monitor.agentHistory
        .toArray()
        .map((i) => i.duration)
        .filter((d): d is number => d !== null);
      if (durations.length > 0) {
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        content.append(`  Average duration: ${Math.floor(avg)}s`, "yellow");
      }
    } else {
      content.append("  No statistics available yet", "dim");
    }

    return renderPanel(`${monitor.name} - Agent History`, content.render(), "magenta");
  }

  // --- Validation / dry run -------------------------------------------------

  /** Result of validating a repository configuration. */
  private validateRepo(monitor: RepoMonitor): {
    name: string;
    path: string;
    enabled: boolean;
    valid: boolean;
    warnings: string[];
    errors: string[];
  } {
    const result = {
      name: monitor.name,
      path: monitor.path,
      enabled: monitor.enabled,
      valid: true,
      warnings: [] as string[],
      errors: [] as string[],
    };
    if (!monitor.enabled) {
      result.warnings.push("Repository is disabled");
      return result;
    }
    if (!existsSync(monitor.path)) {
      result.valid = false;
      result.errors.push(`Path does not exist: ${monitor.path}`);
      return result;
    }
    let stat: Stats;
    try {
      stat = statSync(monitor.path);
    } catch {
      result.valid = false;
      result.errors.push(`Path is not a directory: ${monitor.path}`);
      return result;
    }
    if (!stat.isDirectory()) {
      result.valid = false;
      result.errors.push(`Path is not a directory: ${monitor.path}`);
      return result;
    }
    if (!existsSync(resolve(monitor.path, ".git"))) {
      result.valid = false;
      result.errors.push("Not a git repository (no .git directory)");
      return result;
    }
    try {
      spawnSync("gh", ["auth", "status"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {
      result.warnings.push("GitHub CLI (gh) may not be authenticated");
    }
    return result;
  }

  /** Validate configuration and display what would be launched. */
  performDryRun(): boolean {
    this.consolePrint("\n" + chalk.bold.cyan("Dry Run Mode"));
    this.consolePrint(`Config file: ${chalk.cyan(this.configPath)}\n`);

    if (this.monitors.length === 0) {
      this.consolePrint(chalk.red("✗ No repositories configured"));
      return false;
    }
    if (!existsSync(this.scriptPath)) {
      this.consolePrint(chalk.red(`✗ pr-loop.ts not found at ${this.scriptPath}`));
      return false;
    }
    let scriptStat: Stats;
    try {
      scriptStat = statSync(this.scriptPath);
    } catch {
      this.consolePrint(chalk.red(`✗ ${this.scriptPath} is not a file`));
      return false;
    }
    if (!scriptStat.isFile()) {
      this.consolePrint(chalk.red(`✗ ${this.scriptPath} is not a file`));
      return false;
    }
    try {
      accessSync(this.scriptPath, fsConstants.X_OK);
    } catch {
      this.consolePrint(
        chalk.yellow(`⚠ ${this.scriptPath} is not executable (run: chmod +x pr-loop.ts)`),
      );
    }
    this.consolePrint(chalk.green(`✓ Found pr-loop.ts at ${this.scriptPath}\n`));

    const headers = ["#", "Name", "Path", "Enabled", "Status"];
    const rows: string[][] = [];
    let enabledCount = 0;
    let disabledCount = 0;
    let errorCount = 0;
    let hasIssues = false;

    this.monitors.forEach((monitor, i) => {
      const validation = this.validateRepo(monitor);
      let status: string;
      if (!monitor.enabled) {
        status = chalk.dim("⊘ Disabled");
        disabledCount += 1;
      } else if (!validation.valid) {
        status = chalk.red("✗ Invalid");
        errorCount += 1;
      } else if (validation.warnings.length > 0) {
        status = chalk.yellow("⚠ Warning");
        enabledCount += 1;
      } else {
        status = chalk.green("✓ Valid");
        enabledCount += 1;
      }
      rows.push([
        String(i + 1),
        monitor.name,
        monitor.path,
        monitor.enabled ? chalk.green("Yes") : chalk.dim("No"),
        status,
      ]);
    });

    for (const line of renderTextTable(headers, rows)) this.consolePrint(line);
    this.consolePrint("");

    this.monitors.forEach((monitor, i) => {
      const validation = this.validateRepo(monitor);
      if (validation.errors.length > 0 || validation.warnings.length > 0) {
        hasIssues = true;
        this.consolePrint(chalk.bold(`${i + 1}. ${monitor.name}`));
        for (const err of validation.errors) this.consolePrint(`  ${chalk.red("✗ " + err)}`);
        for (const warn of validation.warnings) this.consolePrint(`  ${chalk.yellow("⚠ " + warn)}`);
        this.consolePrint("");
      }
    });

    const summaryLines = [
      chalk.bold("Summary"),
      "",
      `Total repositories: ${this.monitors.length}`,
      `Enabled: ${chalk.green(String(enabledCount))}`,
      `Disabled: ${chalk.dim(String(disabledCount))}`,
      `Errors: ${chalk.red(String(errorCount))}`,
      "",
      hasIssues
        ? chalk.yellow("⚠ Issues detected - review above")
        : chalk.green("✓ All enabled repos valid"),
      "",
      chalk.dim(`To run: tsx dashboard.ts ${this.configPath}`),
    ];
    for (const line of renderPanel("", summaryLines, "cyan")) this.consolePrint(line);

    return errorCount === 0;
  }

  // --- Non-TUI mode ---------------------------------------------------------

  /** Run dashboard in non-TUI mode (for no TTY environments). */
  async runNonTui(): Promise<void> {
    const enabled = this.monitors.filter((m) => m.enabled);
    this.consolePrint("\n=== merge-god Dashboard (Non-TUI Mode) ===");
    this.consolePrint(`Config: ${this.configPath}`);
    this.consolePrint(`Repositories: ${enabled.length} enabled`);
    this.consolePrint(`Started: ${this.startTime.toISOString()}`);
    if (this.logWriter && this.logWriter.logFilePath) {
      this.consolePrint(`Log file: ${this.logWriter.logFilePath}`);
    }

    const hasIssueWatching = enabled.some((m) => m.watchIssues);
    showTagCriteria(false, hasIssueWatching);

    this.consolePrint("Monitoring repositories (Ctrl+C to stop):\n");
    for (const monitor of enabled) {
      const status = monitor.enabled ? "✓ enabled" : "○ disabled";
      this.consolePrint(`  ${status} ${monitor.name} (${monitor.path})`);
      if (monitor.repoState) {
        const summary = repositoryStateSummary(monitor.repoState);
        this.consolePrint(
          `    State: ${summary["total_branches"]} branches, ${summary["branches_with_prs"]} with PRs, ${summary["branches_needing_sync"]} need sync, ${summary["failing_ci"]} failing CI`,
        );
      }
    }
    this.consolePrint("\n" + "=".repeat(60) + "\n");

    for (const monitor of enabled) this.lastLogPositions.set(monitor.name, 0);
    this.lastStatusTime = Date.now();

    this.running = true;
    try {
      while (this.running) {
        this.update();

        for (const monitor of enabled) {
          const lastPos = this.lastLogPositions.get(monitor.name) ?? 0;
          const currentLogs = monitor.logs.toArray();
          if (currentLogs.length > lastPos) {
            const newLogs = currentLogs.slice(lastPos);
            for (const logLine of newLogs) {
              const timestamp = formatTime(new Date());
              this.consolePrint(`[${timestamp}] [${monitor.name}] ${logLine}`);
            }
            this.lastLogPositions.set(monitor.name, currentLogs.length);
          }
        }

        const currentTime = Date.now();
        if ((currentTime - this.lastStatusTime) / 1000 >= STATUS_SUMMARY_INTERVAL_S) {
          const uptimeStr = uptimeString(Date.now() - this.startTime.getTime());
          this.consolePrint(`\n${"=".repeat(60)}`);
          this.consolePrint(`[${nowIso()}] STATUS SUMMARY (uptime: ${uptimeStr})`);
          this.consolePrint("=".repeat(60));
          for (const monitor of enabled) {
            const prInfo = monitor.current_pr ? ` | Current: ${monitor.current_pr}` : "";
            this.consolePrint(`  ${monitor.name}: ${monitor.status}${prInfo}`);
            this.consolePrint(
              `    Stats: ${monitor.stats.prs_processed} processed (✓ ${monitor.stats.successes} ✗ ${monitor.stats.failures}) | Iteration: ${monitor.stats.iteration}`,
            );
          }
          this.consolePrint("=".repeat(60) + "\n");
          this.lastStatusTime = currentTime;
        }

        await sleep(NON_TUI_POLL_MS);
      }
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__interrupt__") throw e;
    }
    this.consolePrint("\n\nShutting down...");
    this.stopAll();
    this.consolePrint("✓ Dashboard stopped\n");
  }

  // --- Keyboard input -------------------------------------------------------

  /** Set up raw-mode stdin listener for screen-switching keys. */
  private setupKeyboard(): void {
    this.rawMode = setStdinRawMode(process.stdin, true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", this.keyHandler);
  }

  /** Restore stdin to its default (cooked) mode. */
  private restoreKeyboard(): void {
    process.stdin.removeListener("data", this.keyHandler);
    if (this.rawMode) setStdinRawMode(process.stdin, false);
    this.rawMode = false;
  }

  /** Drain the key buffer and handle screen-switching / quit keys. */
  private checkKeyboardInput(): boolean {
    if (this.keyBuffer.length === 0) return false;
    const keys = this.keyBuffer.splice(0, this.keyBuffer.length);
    let handled = false;
    for (const key of keys) {
      if (key === "1") {
        const oldScreen = this.currentScreen;
        this.currentScreen = "pr_dashboard";
        if (oldScreen !== this.currentScreen) {
          for (const m of this.monitors) if (m.enabled) m.refreshDataForView(this.currentScreen);
        }
        handled = true;
      } else if (key === "2") {
        const oldScreen = this.currentScreen;
        this.currentScreen = "agent_dashboard";
        if (oldScreen !== this.currentScreen) {
          for (const m of this.monitors) if (m.enabled) m.refreshDataForView(this.currentScreen);
        }
        handled = true;
      } else if (key === "r" || key === "R") {
        for (const m of this.monitors) if (m.enabled) this.triggerManualRefresh(m);
        handled = true;
      } else if (key === "q" || key === "Q" || key === "\x03") {
        void this.shutdown();
        handled = true;
      }
    }
    return handled;
  }

  /** Trigger a manual refresh of repository state (async, fire-and-forget). */
  private triggerManualRefresh(monitor: RepoMonitor): void {
    monitor.logs.append("⟳ Manual refresh triggered...");
    void (async (): Promise<void> => {
      try {
        if (monitor.stateTracker) {
          const success = await monitor.refreshRepositoryState(true);
          if (success) monitor.logs.append("✓ Manual refresh complete");
          else monitor.logs.append("⚠ Manual refresh failed");
        } else {
          monitor.logs.append("⏳ Initializing state tracker...");
          const success = await monitor.initializeStateTracker();
          if (success) monitor.logs.append("✓ State tracker initialized");
          else monitor.logs.append("⚠ State tracker initialization failed");
        }
      } catch (e) {
        monitor.logs.append(`⚠ Refresh error: ${errMsg(e).slice(0, ERROR_TRUNCATE_LENGTH)}`);
      }
    })();
  }

  /** True if any monitor has a pending confirmation request. */
  private hasPendingConfirmation(): boolean {
    return this.monitors.some((m) => m.pending_confirmation !== null);
  }

  /** Prompt the user for any pending confirmation requests. */
  private async checkPendingConfirmations(): Promise<boolean> {
    for (const monitor of this.monitors) {
      if (!monitor.pending_confirmation) continue;
      this.prompting = true;
      if (this.rawMode) setStdinRawMode(process.stdin, false);

      const data = asRecord(monitor.pending_confirmation["data"]);
      const actionType = toStr(data["action_type"], "unknown");
      const description = toStr(data["description"], "Perform action");
      const prNumber = data["pr_number"];
      const details = asRecord(data["details"]);

      process.stdout.write("\x1b[2J\x1b[H");
      const panelLines = [
        chalk.bold.yellow("Confirmation Required"),
        "",
        `${chalk.bold("Repository:")} ${monitor.name}`,
        `${chalk.bold("Action:")} ${actionType}`,
        `${chalk.bold("Description:")} ${description}`,
      ];
      if (prNumber !== undefined && prNumber !== "") {
        panelLines.push(`${chalk.bold("PR:")} #${prNumber}`);
      }
      for (const [k, v] of Object.entries(details)) {
        panelLines.push(`${chalk.dim(k + ":")} ${String(v)}`);
      }
      for (const line of renderPanel("⚠ User Action Required", panelLines, "yellow")) {
        process.stdout.write(line + "\n");
      }

      const approved = await confirmAsk("Proceed with this action?", false);
      monitor.sendConfirmationResponse(approved);
      if (approved) this.consolePrint(chalk.green("✓ Action approved"));
      else this.consolePrint(chalk.yellow("✗ Action declined"));
      this.consolePrint("");

      if (this.rawMode) {
        setStdinRawMode(process.stdin, true);
        process.stdin.resume();
      }
      this.prompting = false;
      return true;
    }
    return false;
  }

  /** Write a frame to stdout (clear screen + cursor home + frame lines). */
  private writeFrame(frame: string[]): void {
    process.stdout.write("\x1b[2J\x1b[H" + frame.join("\n") + "\n");
  }

  /** Single refresh tick: update, handle keys/confirmations, render. */
  private tick(): void {
    if (!this.running) return;
    if (this.prompting) return;
    this.update();
    if (this.checkKeyboardInput()) {
      // redraw happens below
    }
    if (this.hasPendingConfirmation()) {
      void this.checkPendingConfirmations();
      return;
    }
    this.writeFrame(this.renderFrame());
  }

  /** Shut the dashboard down cleanly. */
  private async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    this.stopAll();
    this.restoreKeyboard();
    process.stdout.write("\x1b[2J\x1b[H");
    this.consolePrint(chalk.yellow("Shutting down..."));
    this.consolePrint(chalk.green("✓ Dashboard stopped"));
    if (this.logWriter) this.logWriter.close();
    process.exit(0);
  }

  /** Run the dashboard (TUI or non-TUI depending on TTY availability). */
  async run(): Promise<boolean> {
    if (this.dryRun) return this.performDryRun();

    if (!this.hasTty) {
      this.logWriter?.log("Running in non-TUI mode (no TTY detected)");
      await this.runNonTui();
      return true;
    }

    this.logWriter?.log("Running in TUI mode");
    this.setupKeyboard();
    process.on("SIGINT", () => {
      void this.shutdown();
    });

    this.running = true;
    this.writeFrame(this.renderFrame());
    this.intervalHandle = setInterval(() => this.tick(), REFRESH_INTERVAL_MS);
    return true;
  }
}

// --- Prompt helpers ---------------------------------------------------------

/** Ask a yes/no question via readline; returns the boolean answer. */
async function confirmAsk(question: string, defaultValue: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = await rl.question(`${question} ${hint} `);
    const a = answer.trim().toLowerCase();
    if (a === "") return defaultValue;
    return a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

/** Ask a free-form question via readline; returns the (trimmed) answer. */
async function promptAsk(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue !== undefined ? ` (default: ${defaultValue}) ` : " ";
    const answer = await rl.question(question + suffix);
    const trimmed = answer.trim();
    return trimmed || (defaultValue ?? "");
  } finally {
    rl.close();
  }
}

// --- Selection criteria display --------------------------------------------

/**
 * Display PR and issue selection criteria.
 *
 * @param useTty When true, use rich-like styled output; otherwise plain text.
 * @param hasIssueWatching Whether any repo has issue watching enabled.
 */
function showTagCriteria(useTty: boolean, hasIssueWatching: boolean): void {
  if (useTty) {
    console.log("\n" + chalk.bold.cyan("Selection Criteria"));
    console.log(chalk.dim("─".repeat(60)));
    if (hasIssueWatching) {
      console.log("\n" + chalk.bold.magenta("⚡ PRIMARY: Issues (processed first)"));
      console.log(`  ${chalk.magenta("•")} ${chalk.bold("for-impl")} - Feature/fix implementation requests`);
      console.log(chalk.dim("  → Creates branch, implements, creates PR, links to issue"));
    }
    console.log("\n" + chalk.bold.green("✓ PRs will be processed if labeled:"));
    console.log(`  ${chalk.green("•")} ${chalk.bold("for-review")} - Comprehensive review with code improvements`);
    console.log(`  ${chalk.green("•")} ${chalk.bold("for-landing")} - Basic processing to merge (conflicts, reviews, CI)`);
    console.log("\n" + chalk.bold.red("✗ PRs will be skipped if:"));
    console.log(`  ${chalk.red("•")} Draft PRs (${chalk.dim("isDraft: true")})`);
    console.log(`  ${chalk.red("•")} WIP labels (${chalk.dim("wip, work-in-process, work in process")})`);
    console.log(`  ${chalk.red("•")} No processing label (${chalk.dim("missing for-review or for-landing")})`);
    console.log("\n" + chalk.dim("─".repeat(60)) + "\n");
  } else {
    console.log("\n" + "=".repeat(60));
    console.log("Selection Criteria");
    console.log("=".repeat(60));
    if (hasIssueWatching) {
      console.log("\n⚡ PRIMARY: Issues (processed first)");
      console.log("  • for-impl - Feature/fix implementation requests");
      console.log("    → Creates branch, implements, creates PR, links to issue");
    }
    console.log("\n✓ PRs will be processed if labeled:");
    console.log("  • for-review - Comprehensive review with code improvements");
    console.log("  • for-landing - Basic processing to merge (conflicts, reviews, CI)");
    console.log("\n✗ PRs will be skipped if:");
    console.log("  • Draft PRs (isDraft: true)");
    console.log("  • WIP labels (wip, work-in-process, work in process)");
    console.log("  • No processing label (missing for-review or for-landing)");
    console.log("\n" + "=".repeat(60) + "\n");
  }
}

// --- Bootstrap config wizard ------------------------------------------------

/** Interactive wizard to create an initial config.yaml. Returns true to run dry-run. */
async function bootstrapConfig(configPath: string): Promise<boolean> {
  console.log("\n" + chalk.bold.cyan("Config File Not Found"));
  console.log(`No configuration file found at: ${chalk.yellow(configPath)}\n`);

  if (!(await confirmAsk("Would you like to create a configuration file now?", true))) {
    console.log("\n" + chalk.yellow("Configuration creation cancelled."));
    console.log(
      `You can create ${configPath} manually or use config.example.yaml as a template.\n`,
    );
    return false;
  }

  console.log("\n" + chalk.bold.cyan("Interactive Configuration Setup"));
  console.log("Let's configure repositories for PR automation.\n");

  const repos: RepoConfigEntry[] = [];

  while (true) {
    console.log(`\n${chalk.bold(`Repository #${repos.length + 1}`)}`);

    let repoPath = "";
    while (true) {
      repoPath = await promptAsk("  Repository path (absolute path)", "");
      if (!repoPath) {
        console.log("  " + chalk.red("✗ Path cannot be empty"));
        continue;
      }
      const resolved = resolve(repoPath);
      repoPath = resolved;
      if (!existsSync(repoPath)) {
        console.log(`  ${chalk.yellow(`⚠ Path does not exist: ${repoPath}`)}`);
        if (!(await confirmAsk("  Use this path anyway?", false))) continue;
      } else {
        let st: Stats;
        try {
          st = statSync(repoPath);
        } catch {
          console.log(`  ${chalk.red(`✗ Path is not a directory: ${repoPath}`)}`);
          continue;
        }
        if (!st.isDirectory()) {
          console.log(`  ${chalk.red(`✗ Path is not a directory: ${repoPath}`)}`);
          continue;
        } else if (!existsSync(resolve(repoPath, ".git"))) {
          console.log("  " + chalk.yellow("⚠ Not a git repository (no .git directory)"));
          if (!(await confirmAsk("  Use this path anyway?", false))) continue;
        } else {
          console.log("  " + chalk.green("✓ Valid git repository"));
        }
      }
      break;
    }

    const defaultName = basename(repoPath);
    const repoName = await promptAsk("  Repository name (display name)", defaultName);
    const enabled = await confirmAsk("  Enable this repository?", true);

    repos.push({ path: repoPath, name: repoName, enabled });
    console.log(`\n${chalk.green(`✓ Added: ${repoName}`)}`);

    if (!(await confirmAsk("\nAdd another repository?", false))) break;
  }

  console.log("\n" + chalk.bold.cyan("Configuration Summary\n"));
  const headers = ["#", "Name", "Path", "Enabled"];
  const rows = repos.map((r, i) => [
    String(i + 1),
    r.name ?? "",
    r.path ?? "",
    r.enabled ? chalk.green("Yes") : chalk.dim("No"),
  ]);
  for (const line of renderTextTable(headers, rows)) console.log(line);
  console.log("");

  if (!(await confirmAsk(`Save configuration to ${configPath}?`, true))) {
    console.log("\n" + chalk.yellow("Configuration creation cancelled.\n"));
    return false;
  }

  const config = { repos };
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname: dirnameFn } = await import("node:path");
    mkdirSync(dirnameFn(configPath), { recursive: true });
    const header =
      "# merge-god Configuration File\n# Generated by interactive setup\n" +
      `# Created: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC\n\n`;
    writeFileSync(configPath, header + YAML.stringify(config));
    console.log(`\n${chalk.green(`✓ Configuration saved to ${configPath}`)}\n`);

    if (await confirmAsk("Validate configuration now (dry-run)?", true)) {
      console.log();
      return true;
    }
    console.log("\n" + chalk.cyan("Configuration complete! Run the dashboard:"));
    console.log("  " + chalk.bold("tsx dashboard.ts") + "\n");
    return false;
  } catch (e) {
    console.log(`\n${chalk.red(`✗ Error saving configuration: ${errMsg(e)}`)}\n`);
    return false;
  }
}

// --- Argument parsing -------------------------------------------------------

interface CliArgs {
  config: string;
  dryRun: boolean;
  logFile: string;
  dbPath: string;
}

/** Parse command line arguments (mirrors the Python argparse interface). */
function parseCliArgs(): CliArgs {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      "log-file": { type: "string" },
      "db-path": { type: "string" },
    },
    allowPositionals: true,
  });
  return {
    config: positionals[0] ?? "config.yaml",
    dryRun: values["dry-run"] ?? false,
    logFile: values["log-file"] ?? "merge-god-dashboard.log",
    dbPath: values["db-path"] ?? DEFAULT_DB_PATH,
  };
}

// --- Main -------------------------------------------------------------------

/** Main entry point. */
async function main(): Promise<void> {
  const args = parseCliArgs();

  let logWriter: LogWriter | null = null;
  if (!args.dryRun) {
    logWriter = new LogWriter(args.logFile);
    console.log(`\n${chalk.dim(`Log file: ${resolve(args.logFile)}`)}\n`);
  }

  if (!existsSync(args.config)) {
    const runDryRun = await bootstrapConfig(args.config);
    if (!existsSync(args.config)) process.exit(1);
    if (runDryRun) args.dryRun = true;
  }

  const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "pr-loop.ts",
  );
  if (!existsSync(scriptPath)) {
    console.error(`Error: pr-loop.ts not found at ${scriptPath}`);
    process.exit(1);
  }

  const dashboard = new Dashboard({
    configPath: args.config,
    scriptPath,
    dryRun: args.dryRun,
    logWriter,
    dbPath: args.dbPath,
  });

  await dashboard.initDb();

  if (!dashboard.loadConfig()) {
    if (logWriter) logWriter.close();
    process.exit(1);
  }

  if (args.dryRun) {
    const success = await dashboard.run();
    process.exit(success ? 0 : 1);
  }

  console.log(
    chalk.green(`✓ Loaded ${dashboard.monitors.length} repositories from ${args.config}`),
  );

  const hasIssueWatching = dashboard.monitors
    .filter((m) => m.enabled)
    .some((m) => m.watchIssues);
  showTagCriteria(Boolean(process.stdout.isTTY), hasIssueWatching);

  console.log(chalk.cyan("\nStarting dashboard..."));
  await sleep(1000);

  try {
    dashboard.startAll();
    await dashboard.run();
  } finally {
    if (logWriter) logWriter.close();
  }
}

/** Resolve the directory of a path (helper kept local to avoid extra import). */
function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(0, idx) : ".";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
