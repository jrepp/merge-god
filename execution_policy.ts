/** Central execution policy for live and dry-run operation. */

import { execa, execaSync } from "execa";

export const DRY_RUN_ENV = "MERGE_GOD_DRY_RUN";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export type OperationEffect = "read" | "mutation";
export type OperationOutcome = "executed" | "would_execute";

export interface OperationSpec {
  kind: "command" | "agent" | "notification" | "confirmation" | "delay" | "filesystem";
  name: string;
  metric_name?: string;
  effect: OperationEffect;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface OperationTrace extends OperationSpec {
  action: "start" | "complete" | "would_execute" | "error";
  outcome?: OperationOutcome;
  dry_run: boolean;
  duration_ms?: number;
  status?: number;
  error?: string;
}

export interface CommandExecutionResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  notFound?: boolean;
}

export interface CommandExecutionOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  input?: string;
  stdio?: "pipe" | "inherit" | "ignore";
}

export interface ProcessExecutor {
  run(command: string, args: string[], options: CommandExecutionOptions): Promise<CommandExecutionResult>;
  runSync(command: string, args: string[], options: CommandExecutionOptions): CommandExecutionResult;
}

export interface EffectExecutionResult<T> {
  outcome: OperationOutcome;
  value?: T;
}

export interface ExecutionPolicyOptions {
  dryRun?: boolean;
  traceLive?: boolean;
  observer?: (trace: OperationTrace) => void;
  processExecutor?: ProcessExecutor;
}

export function dryRunFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUE_VALUES.has((env[DRY_RUN_ENV] ?? "").trim().toLowerCase());
}

export function enableDryRun(env: NodeJS.ProcessEnv = process.env): void {
  env[DRY_RUN_ENV] = "1";
}

function gitEffect(args: string[]): OperationEffect {
  const mutations = new Set([
    "add", "am", "branch", "checkout", "cherry-pick", "clean", "commit", "fetch",
    "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm",
    "stash", "switch", "tag", "worktree",
  ]);
  const reads = new Set([
    "blame", "cat-file", "check-ref-format", "describe", "diff", "diff-tree", "for-each-ref",
    "log", "ls-files", "ls-remote", "merge-base", "merge-tree", "name-rev", "patch-id",
    "remote", "rev-list", "rev-parse", "show", "show-ref", "status", "symbolic-ref",
  ]);
  const command = args.find((arg) => mutations.has(arg) || reads.has(arg)) ?? "";
  return mutations.has(command) ? "mutation" : "read";
}

function ghApiEffect(args: string[]): OperationEffect {
  const methodIndex = args.findIndex((arg) => arg === "--method" || arg === "-X");
  const inlineMethod = args.find((arg) => arg.startsWith("--method=") || arg.startsWith("-X"));
  const method = methodIndex >= 0
    ? args[methodIndex + 1]
    : inlineMethod?.replace(/^(?:--method=|-X)/, "");
  if (method && method.toUpperCase() !== "GET") return "mutation";
  return args.includes("--input") || args.some((arg) => arg.startsWith("--input=")) ? "mutation" : "read";
}

function ghEffect(args: string[]): OperationEffect {
  const group = args[0] ?? "";
  const action = args[1] ?? "";
  if (group === "api") return ghApiEffect(args.slice(1));
  const readActions = new Set([
    "checks", "diff", "list", "status", "view",
  ]);
  if (["auth", "repo", "run", "workflow"].includes(group)) {
    return readActions.has(action) || action === "token" ? "read" : "mutation";
  }
  if (["pr", "issue", "label", "release"].includes(group)) {
    return readActions.has(action) ? "read" : "mutation";
  }
  return "read";
}

export function commandEffect(command: string, args: string[]): OperationEffect {
  if (command === "git") return gitEffect(args);
  if (command === "gh") return ghEffect(args);
  return "read";
}

const REDACTED_COMMAND_OPTIONS = new Set([
  "--body", "--field", "--header", "--raw-field", "-F", "-H", "-f",
]);

function traceArgs(args: string[]): string[] {
  const traced: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const option = [...REDACTED_COMMAND_OPTIONS].find((candidate) => arg.startsWith(`${candidate}=`));
    if (option) {
      traced.push(`${option}=<redacted:${arg.length - option.length - 1} chars>`);
      continue;
    }
    traced.push(arg);
    if (REDACTED_COMMAND_OPTIONS.has(arg) && index + 1 < args.length) {
      const value = args[++index]!;
      traced.push(`<redacted:${value.length} chars>`);
    }
  }
  return traced;
}

function execaResult(result: {
  exitCode?: number;
  failed?: boolean;
  stdout?: unknown;
  stderr?: unknown;
  shortMessage?: string;
  timedOut?: boolean;
  code?: string;
}): CommandExecutionResult {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" && result.stderr
    ? result.stderr
    : result.failed ? result.shortMessage ?? "Command failed" : "";
  return {
    status: result.exitCode ?? (result.failed ? -1 : 0),
    stdout,
    stderr,
    timedOut: result.timedOut === true,
    notFound: result.code === "ENOENT",
  };
}

const execaProcessExecutor: ProcessExecutor = {
  async run(command, args, options) {
    const result = await execa(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      input: options.input,
      stdio: options.stdio ?? "pipe",
      reject: false,
      stripFinalNewline: false,
    });
    return execaResult(result);
  },
  runSync(command, args, options) {
    const result = execaSync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      input: options.input,
      stdio: options.stdio ?? "pipe",
      reject: false,
      stripFinalNewline: false,
    });
    return execaResult(result);
  },
};

export class ExecutionPolicy {
  readonly dryRun: boolean;
  private readonly traceLive: boolean;
  private readonly observer: (trace: OperationTrace) => void;
  private readonly processExecutor: ProcessExecutor;

  constructor(options: ExecutionPolicyOptions = {}) {
    this.dryRun = options.dryRun ?? dryRunFromEnv();
    this.traceLive = options.traceLive ?? false;
    this.observer = options.observer ?? (() => undefined);
    this.processExecutor = options.processExecutor ?? execaProcessExecutor;
  }

  runCommandSync(
    command: string,
    args: string[],
    options: CommandExecutionOptions = {},
  ): CommandExecutionResult {
    const spec = this.commandSpec(command, args, options.cwd);
    const startedAt = Date.now();
    this.emit({ ...spec, action: "start", dry_run: this.dryRun });
    if (this.dryRun && spec.effect === "mutation") {
      this.emit({
        ...spec,
        action: "would_execute",
        outcome: "would_execute",
        dry_run: true,
        duration_ms: Date.now() - startedAt,
        status: 0,
      });
      return { status: 0, stdout: "", stderr: "" };
    }
    let result: CommandExecutionResult;
    try {
      result = this.processExecutor.runSync(command, args, options);
    } catch (error) {
      this.emit({
        ...spec,
        action: "error",
        outcome: "executed",
        dry_run: this.dryRun,
        duration_ms: Date.now() - startedAt,
        status: -1,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.emit({
      ...spec,
      action: "complete",
      outcome: "executed",
      dry_run: this.dryRun,
      duration_ms: Date.now() - startedAt,
      status: result.status,
    });
    return result;
  }

  async runCommand(
    command: string,
    args: string[],
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    const spec = this.commandSpec(command, args, options.cwd);
    return this.perform(spec, () => this.processExecutor.run(command, args, options), { status: 0, stdout: "", stderr: "" })
      .then((result) => result.value ?? { status: 0, stdout: "", stderr: "" });
  }

  async perform<T>(spec: OperationSpec, execute: () => Promise<T>, simulatedValue?: T): Promise<EffectExecutionResult<T>> {
    const startedAt = Date.now();
    this.emit({ ...spec, action: "start", dry_run: this.dryRun });
    if (this.dryRun && spec.effect === "mutation") {
      this.emit({
        ...spec,
        action: "would_execute",
        outcome: "would_execute",
        dry_run: true,
        duration_ms: Date.now() - startedAt,
      });
      return { outcome: "would_execute", value: simulatedValue };
    }
    let value: T;
    try {
      value = await execute();
    } catch (error) {
      this.emit({
        ...spec,
        action: "error",
        outcome: "executed",
        dry_run: this.dryRun,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.emit({
      ...spec,
      action: "complete",
      outcome: "executed",
      dry_run: this.dryRun,
      duration_ms: Date.now() - startedAt,
    });
    return { outcome: "executed", value };
  }

  private commandSpec(command: string, args: string[], cwd: string | undefined): OperationSpec {
    const tracedArgs = traceArgs(args);
    const metricParts = command === "gh"
      ? [command, args[0], args[1]]
      : [command, args.find((arg) => !arg.startsWith("-"))];
    return {
      kind: "command",
      name: `${command} ${tracedArgs.join(" ")}`.trim().slice(0, 1000),
      metric_name: metricParts.filter(Boolean).join("."),
      effect: commandEffect(command, args),
      target: command,
      metadata: { command, args: tracedArgs, cwd: cwd ?? process.cwd() },
    };
  }

  private emit(trace: OperationTrace): void {
    if (this.dryRun || this.traceLive) this.observer(trace);
  }
}
