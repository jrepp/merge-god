/**
 * Local git client for @merge-god/github-sync.
 *
 * Thin async wrapper around synchronous `git` subprocess calls. Ports the
 * branch-analysis logic from the root `git_ops.ts` (merge-god) onto the shared
 * `Branch` / `BranchStatus` models in `./models`. All filesystem/git access is
 * synchronous via `spawnSync`; methods are `async` only to satisfy the
 * forge/store async library API.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BranchStatus, createBranch, type Branch } from "./models";

/** Error raised by {@link GitClient}. */
export class GitClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitClientError";
  }
}

interface CommandResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  cwd: string,
  cmd: string[],
  opts: { timeout?: number; check?: boolean } = {},
): CommandResult {
  const { timeout = 30, check = true } = opts;
  try {
    const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: timeout * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      if (result.signal === "SIGTERM") {
        throw new GitClientError(`Command timed out: ${cmd.join(" ")}`);
      }
      throw new GitClientError(`Command error: ${result.error.message}`);
    }

    const returncode = result.status ?? -1;
    if (check && returncode !== 0) {
      throw new GitClientError(
        `Command failed: ${cmd.join(" ")}\n` +
          `Exit code: ${returncode}\n` +
          `Stderr: ${result.stderr ?? ""}`,
      );
    }

    return {
      returncode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (e) {
    if (e instanceof GitClientError) throw e;
    throw new GitClientError(`Command error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const normalized = s.replaceAll(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Local-git client. Wraps `git` subprocess invocations for a single checkout.
 */
export class GitClient {
  readonly repoPath: string;

  /** @param repoPath - Path to the git working tree. */
  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    this.validateRepo();
  }

  private validateRepo(): void {
    if (!existsSync(this.repoPath)) {
      throw new GitClientError(`Repository path does not exist: ${this.repoPath}`);
    }
    const gitDir = path.join(this.repoPath, ".git");
    if (!existsSync(gitDir)) {
      throw new GitClientError(`Not a git repository: ${this.repoPath}`);
    }
  }

  private runCommand(
    cmd: string[],
    opts: { timeout?: number; check?: boolean } = {},
  ): CommandResult {
    return runCommand(this.repoPath, cmd, opts);
  }

  /** Fetch all remotes (with prune). */
  fetch(remote = "origin"): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.runCommand(["git", "fetch", remote, "--prune"], { timeout: 30 });
        resolve();
      } catch (e) {
        reject(e instanceof Error ? e : new GitClientError(String(e)));
      }
    });
  }

  /** List local branches (refs/heads). */
  getLocalBranches(): Promise<Branch[]> {
    return new Promise((resolve, reject) => {
      try {
        const cmd = [
          "git",
          "for-each-ref",
          "--format=%(refname:short)|%(objectname)|%(upstream:short)|%(committerdate:iso8601)|%(authorname)|%(subject)",
          "refs/heads/",
        ];
        const { stdout } = this.runCommand(cmd);

        const branches: Branch[] = [];
        for (const line of stdout.trim().split("\n")) {
          if (!line) continue;

          const parts = line.split("|");
          if (parts.length < 6) continue;

          const name = parts[0]!;
          const sha = parts[1]!;
          const upstream = parts[2]!;
          const dateStr = parts[3]!;
          const author = parts[4]!;
          const message = parts.slice(5).join("|");

          const commitDate = parseDate(dateStr);

          branches.push(
            createBranch({
              name,
              sha,
              is_local: true,
              is_remote: false,
              upstream: upstream || null,
              last_commit_date: commitDate,
              last_commit_author: author,
              last_commit_message: message,
            }),
          );
        }

        resolve(branches);
      } catch (e) {
        reject(e instanceof Error ? e : new GitClientError(String(e)));
      }
    });
  }

  /** List remote branches under `refs/remotes/<remote>/`. */
  getRemoteBranches(remote = "origin"): Promise<Branch[]> {
    return new Promise((resolve, reject) => {
      try {
        const cmd = [
          "git",
          "for-each-ref",
          "--format=%(refname:short)|%(objectname)|%(committerdate:iso8601)|%(authorname)|%(subject)",
          `refs/remotes/${remote}/`,
        ];
        const { stdout } = this.runCommand(cmd);

        const branches: Branch[] = [];
        for (const line of stdout.trim().split("\n")) {
          if (!line) continue;

          const parts = line.split("|");
          if (parts.length < 5) continue;

          const fullName = parts[0]!;
          const sha = parts[1]!;
          const dateStr = parts[2]!;
          const author = parts[3]!;
          const message = parts.slice(4).join("|");

          const name = fullName.replaceAll(`${remote}/`, "");
          if (name === "HEAD") continue;

          const commitDate = parseDate(dateStr);

          branches.push(
            createBranch({
              name,
              sha,
              is_local: false,
              is_remote: true,
              last_commit_date: commitDate,
              last_commit_author: author,
              last_commit_message: message,
            }),
          );
        }

        resolve(branches);
      } catch (e) {
        reject(e instanceof Error ? e : new GitClientError(String(e)));
      }
    });
  }

  /**
   * Compute the ahead/behind relationship between a local branch and its
   * remote counterpart.
   *
   * @returns `[status, ahead_by, behind_by]`.
   */
  computeBranchStatus(
    localBranch: Branch,
    remoteBranch: Branch | null,
    remoteName = "origin",
  ): [BranchStatus, number, number] {
    if (remoteBranch === null) {
      return [BranchStatus.LOCAL_ONLY, 0, 0];
    }

    if (localBranch.sha === remoteBranch.sha) {
      return [BranchStatus.UP_TO_DATE, 0, 0];
    }

    try {
      const cmd = [
        "git",
        "rev-list",
        "--left-right",
        "--count",
        `${localBranch.name}...${remoteName}/${remoteBranch.name}`,
      ];
      const { returncode, stdout } = this.runCommand(cmd, { check: false });

      if (returncode !== 0) {
        return [BranchStatus.UNKNOWN, 0, 0];
      }

      const parts = stdout.trim().split(/\s+/);
      if (parts.length !== 2) {
        return [BranchStatus.UNKNOWN, 0, 0];
      }

      const ahead = Number(parts[0]);
      const behind = Number(parts[1]);
      if (Number.isNaN(ahead) || Number.isNaN(behind)) {
        return [BranchStatus.UNKNOWN, 0, 0];
      }

      if (ahead > 0 && behind > 0) return [BranchStatus.DIVERGED, ahead, behind];
      if (ahead > 0) return [BranchStatus.AHEAD, ahead, behind];
      if (behind > 0) return [BranchStatus.BEHIND, ahead, behind];
      return [BranchStatus.UP_TO_DATE, ahead, behind];
    } catch {
      return [BranchStatus.UNKNOWN, 0, 0];
    }
  }

  /**
   * Get local + remote branches with ahead/behind status computed on every
   * local branch that has a remote counterpart.
   *
   * @returns `[localBranches, remoteBranches]`.
   */
  getAllBranchesWithStatus(remote = "origin"): Promise<[Branch[], Branch[]]> {
    return new Promise((resolve, reject) => {
      Promise.all([this.getLocalBranches(), this.getRemoteBranches(remote)])
        .then(([localBranches, remoteBranches]) => {
          const remoteLookup = new Map<string, Branch>();
          for (const branch of remoteBranches) remoteLookup.set(branch.name, branch);

          for (const localBranch of localBranches) {
            const remoteBranch = remoteLookup.get(localBranch.name) ?? null;

            if (remoteBranch) {
              const [status, ahead, behind] = this.computeBranchStatus(
                localBranch,
                remoteBranch,
                remote,
              );
              localBranch.status = status;
              localBranch.ahead_by = ahead;
              localBranch.behind_by = behind;
            } else {
              localBranch.status = BranchStatus.LOCAL_ONLY;
            }
          }

          resolve([localBranches, remoteBranches]);
        })
        .catch((e) => reject(e instanceof Error ? e : new GitClientError(String(e))));
    });
  }

  /** Resolve the repository's default branch (origin/HEAD with fallbacks). */
  getDefaultBranch(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const cmd = ["git", "symbolic-ref", "refs/remotes/origin/HEAD"];
        const { returncode, stdout } = this.runCommand(cmd, { check: false });

        if (returncode === 0 && stdout) {
          const parts = stdout.trim().split("/");
          const branch = parts[parts.length - 1];
          if (branch) {
            resolve(branch);
            return;
          }
        }

        for (const branch of ["main", "master", "develop"]) {
          const { returncode: rc } = this.runCommand(
            ["git", "rev-parse", "--verify", `origin/${branch}`],
            { check: false },
          );
          if (rc === 0) {
            resolve(branch);
            return;
          }
        }

        resolve("main");
      } catch (e) {
        reject(e instanceof Error ? e : new GitClientError(String(e)));
      }
    });
  }

  /** Current checked-out branch name, or null if detached. */
  getCurrentBranch(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      try {
        const cmd = ["git", "rev-parse", "--abbrev-ref", "HEAD"];
        const { returncode, stdout } = this.runCommand(cmd, { check: false });

        if (returncode === 0 && stdout) {
          const branch = stdout.trim();
          if (branch !== "HEAD") {
            resolve(branch);
            return;
          }
        }

        resolve(null);
      } catch (e) {
        reject(e instanceof Error ? e : new GitClientError(String(e)));
      }
    });
  }

  /** Basic repo metadata: path, default/current branch, remote URL. */
  getRepositoryInfo(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      try {
        const info: Record<string, unknown> = {
          path: this.repoPath,
        };

        const defaultCmd = ["git", "symbolic-ref", "refs/remotes/origin/HEAD"];
        const def = this.runCommand(defaultCmd, { check: false });
        if (def.returncode === 0 && def.stdout) {
          const parts = def.stdout.trim().split("/");
          const branch = parts[parts.length - 1];
          if (branch) info.default_branch = branch;
        }

        const curCmd = ["git", "rev-parse", "--abbrev-ref", "HEAD"];
        const cur = this.runCommand(curCmd, { check: false });
        if (cur.returncode === 0 && cur.stdout) {
          const branch = cur.stdout.trim();
          if (branch !== "HEAD") info.current_branch = branch;
        }

        const urlCmd = ["git", "remote", "get-url", "origin"];
        const url = this.runCommand(urlCmd, { check: false });
        if (url.returncode === 0) {
          info.remote_url = url.stdout.trim();
        }

        resolve(info);
      } catch (e) {
        reject(e instanceof Error ? e : new GitClientError(String(e)));
      }
    });
  }
}
