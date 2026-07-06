/**
 * Pull request context source ports and the gh-cli implementation.
 */

import type { CommandLogger, CommandRunner } from "./command_runner";
import { validateGitRef } from "./git_ref";
import type { DiffAvailability } from "./merge_pr_model";

export interface BranchRefs {
  head_branch: string;
  base_branch: string;
}

export interface DiffResult {
  diff: string;
  availability: DiffAvailability;
}

export interface PullRequestContextSource {
  getDetails(prNumber: number): Promise<Record<string, unknown>>;
  getComments(prNumber: number): Promise<Record<string, unknown>[]>;
  getReviewComments(prNumber: number): Promise<Record<string, unknown>[]>;
  getCommits(prNumber: number): Promise<Record<string, unknown>[]>;
  getFiles(prNumber: number): Promise<Record<string, unknown>[]>;
  getDiff(prNumber: number, refs: BranchRefs): Promise<DiffResult>;
  checkMergeConflicts(prNumber: number, refs: BranchRefs): Promise<Record<string, unknown>>;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = raw ? JSON.parse(raw) as unknown : {};
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray(raw: string): Record<string, unknown>[] {
  const parsed = raw ? JSON.parse(raw) as unknown : [];
  return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
}

function parseJsonObjectLines(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) return parseJsonArray(trimmed);

  return trimmed
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJsonObject(line));
}

function diffUnavailable(
  source: DiffAvailability["source"],
  error: string,
  truncated = false,
): DiffResult {
  return {
    diff: "",
    availability: {
      available: false,
      source,
      size: 0,
      truncated,
      error,
    },
  };
}

export class GhCliPullRequestContextSource implements PullRequestContextSource {
  constructor(
    private readonly commands: CommandRunner,
    private readonly log: CommandLogger = () => undefined,
  ) {}

  async getDetails(prNumber: number): Promise<Record<string, unknown>> {
    this.log("get_pr_details", { action: "start", pr_number: prNumber });
    const [returncode, stdout, stderr] = await this.commands.run([
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,title,body,state,headRefName,baseRefName,isDraft,mergeable,mergeStateStatus," +
        "author,createdAt,updatedAt,closedAt,mergedAt,labels,assignees," +
        "additions,deletions,changedFiles,commits,reviews,reviewDecision,statusCheckRollup",
    ]);
    if (returncode !== 0) {
      this.log("get_pr_details", { action: "error", pr_number: prNumber, stderr });
      return {};
    }
    try {
      const details = parseJsonObject(stdout);
      this.log("get_pr_details", { action: "complete", pr_number: prNumber });
      return details;
    } catch (e) {
      this.log("get_pr_details", { action: "parse_error", pr_number: prNumber, error: e instanceof Error ? e.message : String(e) });
      return {};
    }
  }

  async getComments(prNumber: number): Promise<Record<string, unknown>[]> {
    return this.fetchPaginatedArray(`repos/{owner}/{repo}/issues/${prNumber}/comments`, "get_pr_comments", prNumber, "comment_count");
  }

  async getReviewComments(prNumber: number): Promise<Record<string, unknown>[]> {
    return this.fetchPaginatedArray(`repos/{owner}/{repo}/pulls/${prNumber}/comments`, "get_pr_review_comments", prNumber, "review_comment_count");
  }

  async getCommits(prNumber: number): Promise<Record<string, unknown>[]> {
    return this.fetchPaginatedArray(`repos/{owner}/{repo}/pulls/${prNumber}/commits`, "get_pr_commits", prNumber, "commit_count");
  }

  async getFiles(prNumber: number): Promise<Record<string, unknown>[]> {
    return this.fetchPaginatedArray(`repos/{owner}/{repo}/pulls/${prNumber}/files`, "get_pr_files", prNumber, "file_count");
  }

  async getDiff(prNumber: number, refs: BranchRefs): Promise<DiffResult> {
    this.log("get_pr_diff", { action: "start", pr_number: prNumber });
    const [returncode, stdout, stderr] = await this.commands.run(["gh", "pr", "diff", String(prNumber)]);
    if (returncode !== 0) {
      this.log("get_pr_diff", { action: "error", pr_number: prNumber, stderr });
      const fallback = await this.getLocalGitDiff(refs);
      this.log("get_pr_diff", {
        action: fallback.availability.available ? "fallback_complete" : "fallback_error",
        pr_number: prNumber,
        source: fallback.availability.source,
        diff_size: fallback.diff.length,
        error: fallback.availability.error,
      });
      if (fallback.availability.available) return fallback;
      return diffUnavailable(
        "gh-pr-diff",
        stderr || `gh pr diff exited ${returncode}`,
        /too_large|maximum number of lines|exceeded/i.test(stderr),
      );
    }

    this.log("get_pr_diff", { action: "complete", pr_number: prNumber, diff_size: stdout.length });
    return {
      diff: stdout,
      availability: {
        available: stdout.length > 0,
        source: "gh-pr-diff",
        size: stdout.length,
        truncated: false,
        error: null,
      },
    };
  }

  async checkMergeConflicts(
    prNumber: number,
    refs: BranchRefs,
  ): Promise<Record<string, unknown>> {
    this.log("check_merge_conflicts", {
      action: "start",
      pr_number: prNumber,
      head_branch: refs.head_branch,
      base_branch: refs.base_branch,
    });

    if (!validateGitRef(refs.head_branch)) {
      return { has_conflicts: false, conflicting_files: [], conflict_count: 0, error: "Invalid head branch name" };
    }
    if (!validateGitRef(refs.base_branch)) {
      return { has_conflicts: false, conflicting_files: [], conflict_count: 0, error: "Invalid base branch name" };
    }

    const [fetchCode, _stdout, fetchStderr] = await this.commands.run(
      ["git", "fetch", "origin", refs.head_branch, refs.base_branch],
      undefined,
      120,
    );
    if (fetchCode !== 0) {
      return { has_conflicts: false, conflicting_files: [], conflict_count: 0, error: fetchStderr || "Failed to fetch branches" };
    }

    const [mergeTreeCode, mergeTreeStdout] = await this.commands.run(
      ["git", "merge-tree", `origin/${refs.base_branch}`, `origin/${refs.head_branch}`],
      undefined,
      120,
    );
    let hasConflicts = false;
    if (mergeTreeCode === 0 && mergeTreeStdout) {
      hasConflicts = mergeTreeStdout.split("\n").some((line) => line.startsWith("<<<<<<<"));
    }

    const conflictingFiles: string[] = [];
    if (hasConflicts) {
      let currentFile: string | null = null;
      for (const line of mergeTreeStdout.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) {
          const parts = line.split(" ");
          if (parts.length > 1 && parts[1] !== "/dev/null") {
            const filePath = (parts[1] ?? "").replace(/^[ab/]+/, "");
            if (filePath && !conflictingFiles.includes(filePath)) currentFile = filePath;
          }
        } else if (line.startsWith("<<<<<<<") && currentFile && !conflictingFiles.includes(currentFile)) {
          conflictingFiles.push(currentFile);
        }
      }
    }

    const result = {
      has_conflicts: hasConflicts,
      conflicting_files: conflictingFiles,
      conflict_count: conflictingFiles.length,
    };
    this.log("check_merge_conflicts", { action: "complete", pr_number: prNumber, ...result });
    return result;
  }

  private async fetchPaginatedArray(
    endpoint: string,
    eventType: string,
    prNumber: number,
    countField: string,
  ): Promise<Record<string, unknown>[]> {
    this.log(eventType, { action: "start", pr_number: prNumber });
    const [returncode, stdout, stderr] = await this.commands.run([
      "gh",
      "api",
      endpoint,
      "--paginate",
      "--jq",
      ".[]",
    ]);
    if (returncode !== 0) {
      this.log(eventType, { action: "error", pr_number: prNumber, stderr });
      return [];
    }
    try {
      const list = parseJsonObjectLines(stdout);
      this.log(eventType, { action: "complete", pr_number: prNumber, [countField]: list.length });
      return list;
    } catch (e) {
      this.log(eventType, { action: "parse_error", pr_number: prNumber, error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  private async getLocalGitDiff(refs: BranchRefs): Promise<DiffResult> {
    if (!validateGitRef(refs.head_branch) || !validateGitRef(refs.base_branch)) {
      return diffUnavailable("local-git-diff", "Invalid branch name for local git diff fallback");
    }

    const [fetchCode, _fetchStdout, fetchStderr] = await this.commands.run(
      ["git", "fetch", "origin", refs.head_branch, refs.base_branch],
      undefined,
      120,
    );
    if (fetchCode !== 0) {
      return diffUnavailable("local-git-diff", fetchStderr || `git fetch exited ${fetchCode}`);
    }

    const [diffCode, diffStdout, diffStderr] = await this.commands.run(
      ["git", "diff", "--no-ext-diff", "--no-color", `origin/${refs.base_branch}...origin/${refs.head_branch}`],
      undefined,
      300,
    );
    if (diffCode !== 0) {
      return diffUnavailable("local-git-diff", diffStderr || `git diff exited ${diffCode}`);
    }

    const truncated = diffStdout.includes("... [truncated] ...");
    return {
      diff: diffStdout,
      availability: {
        available: diffStdout.length > 0,
        source: "local-git-diff",
        size: diffStdout.length,
        truncated,
        error: truncated ? "Local git diff output was truncated by merge-god output limits." : null,
      },
    };
  }
}
