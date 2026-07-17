import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GitClient, GitClientError } from "@merge-god/github-sync";
import { ExecutionPolicy } from "./execution_policy";

export interface GitOpsCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface GitOpsEvent {
  event: string;
  cwd: string;
  command?: string;
  args?: string[];
  status?: number;
  duration_ms?: number;
  path?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface GitOpsMetric {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

export interface GitOpsObserver {
  onEvent?(event: GitOpsEvent): void;
  onMetric?(metric: GitOpsMetric): void;
}

export interface AgentWorktree {
  path: string;
  cleanup(): void;
}

export class GitOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitOpsError";
  }
}

export class GitOps {
  readonly repoPath: string;
  readonly client: GitClient;
  private readonly observer: GitOpsObserver | null;
  private readonly executionPolicy: ExecutionPolicy;

  constructor(
    repoPath: string,
    observer: GitOpsObserver | null = null,
    executionPolicy = new ExecutionPolicy(),
  ) {
    this.repoPath = path.resolve(repoPath);
    this.client = new GitClient(this.repoPath);
    this.observer = observer;
    this.executionPolicy = executionPolicy;
  }

  runGit(args: string[], opts: { timeout?: number; check?: boolean } = {}): GitOpsCommandResult {
    return this.run("git", args, opts);
  }

  runGh(args: string[], opts: { timeout?: number; check?: boolean } = {}): GitOpsCommandResult {
    return this.run("gh", args, opts);
  }

  root(): string {
    return this.runGit(["rev-parse", "--show-toplevel"]).stdout.trim();
  }

  ensureInsideWorkTree(): void {
    this.runGit(["rev-parse", "--is-inside-work-tree"]);
  }

  checkoutBranch(branch: string, opts: { reset?: boolean } = {}): void {
    this.runGit(opts.reset ? ["checkout", "-B", branch] : ["checkout", branch]);
  }

  addAll(): void {
    this.runGit(["add", "-A"]);
  }

  stagedFiles(): string[] {
    const stdout = this.runGit(["diff", "--cached", "--name-only"]).stdout.trim();
    return stdout ? stdout.split("\n").filter(Boolean) : [];
  }

  commit(message: string): void {
    this.runGit(["commit", "-m", message]);
  }

  headSha(): string {
    return this.runGit(["rev-parse", "HEAD"]).stdout.trim();
  }

  pushSetUpstream(branch: string, remote = "origin"): void {
    this.runGit(["push", "-u", remote, branch]);
  }

  createDetachedWorktree(ref = "HEAD"): AgentWorktree {
    const root = this.root();
    const rootOps = new GitOps(root, this.observer, this.executionPolicy);
    const tempDir = mkdtempSync(path.join(tmpdir(), "merge-god-pi-"));
    const worktreePath = path.join(tempDir, "worktree");
    rootOps.runGit(["worktree", "add", "--detach", worktreePath, ref]);
    this.emitEvent({ event: "git.worktree.created", cwd: root, path: worktreePath });
    this.emitMetric({ name: "git.worktree.created", value: 1 });
    return {
      path: worktreePath,
      cleanup: () => {
        try {
          rootOps.runGit(["worktree", "remove", "--force", worktreePath], { timeout: 60 });
          this.emitEvent({ event: "git.worktree.removed", cwd: root, path: worktreePath });
          this.emitMetric({ name: "git.worktree.removed", value: 1 });
        } catch (e) {
          this.emitEvent({
            event: "git.worktree.remove_failed",
            cwd: root,
            path: worktreePath,
            error: e instanceof Error ? e.message : String(e),
          });
          this.emitMetric({ name: "git.worktree.remove_failed", value: 1 });
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
    };
  }

  private run(
    command: string,
    args: string[],
    opts: { timeout?: number; check?: boolean } = {},
  ): GitOpsCommandResult {
    const { timeout = 300, check = true } = opts;
    const start = Date.now();
    this.emitEvent({ event: "git.command.start", cwd: this.repoPath, command, args });
    this.emitMetric({ name: "git.command.started", value: 1, tags: { command } });
    const result = this.executionPolicy.runCommandSync(command, args, {
      cwd: this.repoPath,
      timeoutMs: timeout * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const duration = Date.now() - start;

    const status = result.status;
    const output = {
      status,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: duration,
    };

    this.emitEvent({
      event: status === 0 ? "git.command.success" : "git.command.failure",
      cwd: this.repoPath,
      command,
      args,
      status,
      duration_ms: duration,
    });
    this.emitMetric({ name: "git.command.duration_ms", value: duration, tags: { command } });
    this.emitMetric({ name: "git.command.completed", value: 1, tags: { command, status: String(status) } });

    if (check && status !== 0) {
      this.emitMetric({ name: "git.command.failures", value: 1, tags: { command } });
      throw new GitOpsError(
        `Command failed: ${command} ${args.join(" ")}\n` +
          `Exit code: ${status}\n` +
          `Stderr: ${output.stderr}`,
      );
    }

    return output;
  }

  private emitEvent(event: GitOpsEvent): void {
    this.observer?.onEvent?.(event);
  }

  private emitMetric(metric: GitOpsMetric): void {
    this.observer?.onMetric?.(metric);
  }
}

export { GitClient, GitClientError };
