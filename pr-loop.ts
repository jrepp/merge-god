#!/usr/bin/env node
/**
 * PR Merge Loop — Automatically processes and merges PRs using the pi agent
 * (via the merge-god pi extension and coordination API).
 *
 * Ported from pr-loop.py. Continuously loops over open PRs, syncing the repo,
 * fixing conflicts, responding to reviews, and fixing CI.
 *
 * Usage: ./pr-loop.ts <repo_path> [--watch-issues] [--interactive]
 *
 * Label contract:
 *   - PRs labeled `for-review` get comprehensive review + improvements.
 *   - PRs labeled `for-landing` get basic processing toward a merge.
 *   - Issues labeled `for-impl` get implemented (when --watch-issues is set).
 *   - No label = the PR is skipped.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import * as readline from "node:readline";
import { runPiAgent, type WorkItem } from "./coordination";
import { SyncStore } from "@merge-god/github-sync";
import {
  PRAgent,
  type PRContext,
  createClaudeClient,
  getModelName,
  createPRContextFromDict,
  getFailedTasks,
  PRProcessingCallbacks,
} from "./agents/__init__";
import type Anthropic from "@anthropic-ai/sdk";

// SyncStore persists PR context for offline agent runs.
const DB_AVAILABLE: boolean = true;

// --- Small unexported coercion helpers --------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toNum(v: unknown, dflt = 0): number {
  return typeof v === "number" ? v : dflt;
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Logging ----------------------------------------------------------------

/** Emit structured JSON logs with timestamp. */
export function logJson(eventType: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString().replace("+00:00", "Z"),
    event: eventType,
    data,
  };
  console.log(JSON.stringify(entry));
}

/**
 * Request user confirmation for an action (interactive mode only).
 *
 * Polls stdin for a JSON response line of the form `{"approved": true|false}`.
 * Returns true if approved, false if declined, errored, or timed out.
 */
export async function requestConfirmation(
  actionType: string,
  description: string,
  prNumber: string | null = null,
  details: Record<string, unknown> | null = null,
  timeout = 300,
): Promise<boolean> {
  logJson("request_confirmation", {
    action_type: actionType,
    description,
    pr_number: prNumber,
    details: details ?? {},
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (val: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      clearTimeout(timeoutHandle);
      resolve(val);
    };

    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    const timeoutHandle = setTimeout(() => {
      logJson("confirmation_timeout", { action_type: actionType, timeout_seconds: timeout });
      finish(false);
    }, timeout * 1000);

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const response = JSON.parse(trimmed) as { approved?: boolean };
        const approved = !!response.approved;
        logJson("confirmation_received", { action_type: actionType, approved });
        finish(approved);
      } catch (e) {
        logJson("confirmation_error", {
          action_type: actionType,
          error: `JSON decode error: ${errMsg(e)}`,
          line: trimmed.slice(0, 100),
        });
        finish(false);
      }
    });

    rl.on("error", (e) => {
      logJson("confirmation_error", { action_type: actionType, error: errMsg(e) });
      finish(false);
    });
  });
}

/**
 * Send a notification to the ntfy.sh topic.
 *
 * Returns true if sent successfully, false otherwise.
 */
export async function sendNotification(
  message: string,
  title: string | null = null,
  priority = "default",
  tags: string[] | null = null,
): Promise<boolean> {
  const topicUrl = "https://ntfy.sh/merge-god-sez";
  try {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (title) headers["Title"] = title;
    if (priority) headers["Priority"] = priority;
    if (tags) headers["Tags"] = tags.join(",");

    const response = await fetch(topicUrl, {
      method: "POST",
      headers,
      body: message,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 200) {
      logJson("notification", {
        action: "sent",
        title,
        message_length: message.length,
      });
      return true;
    }
    logJson("notification", {
      action: "failed",
      status: response.status,
      title,
    });
    return false;
  } catch (e) {
    logJson("notification", {
      action: "error",
      error: errMsg(e),
      title,
    });
    return false;
  }
}

// --- Command execution ------------------------------------------------------

/**
 * Run a command and return [returncode, stdout, stderr].
 *
 * Mirrors Python run_command: truncates oversized output and converts timeout /
 * not-found conditions into returncode -1 with a descriptive stderr string.
 */
export function runCommand(
  cmd: string[],
  cwd?: string,
  timeout = 300,
  maxOutputSize = 50 * 1024 * 1024,
): [number, string, string] {
  try {
    const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: timeout * 1000,
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [-1, "", `Command not found: ${cmd[0] ?? "unknown"}`];
      }
      return [-1, "", `Command failed: ${errMsg(result.error)}`];
    }

    let stdout = result.stdout ?? "";
    let stderr = result.stderr ?? "";

    if (result.signal === "SIGTERM") {
      return [-1, stdout, stderr || `Command timed out after ${timeout} seconds`];
    }

    const stdoutSize = Buffer.byteLength(stdout, "utf8");
    const stderrSize = Buffer.byteLength(stderr, "utf8");

    if (stdoutSize > maxOutputSize) {
      logJson("command_warning", {
        warning: "stdout truncated",
        size: stdoutSize,
        max_size: maxOutputSize,
        command: cmd[0] ?? "unknown",
      });
      stdout = stdout.slice(0, Math.floor(maxOutputSize / 2)) + "\n... [truncated] ...";
    }

    if (stderrSize > maxOutputSize) {
      logJson("command_warning", {
        warning: "stderr truncated",
        size: stderrSize,
        max_size: maxOutputSize,
        command: cmd[0] ?? "unknown",
      });
      stderr = stderr.slice(0, Math.floor(maxOutputSize / 2)) + "\n... [truncated] ...";
    }

    return [result.status ?? -1, stdout, stderr];
  } catch (e) {
    return [-1, "", `Command failed: ${errMsg(e)}`];
  }
}

// --- PR / issue discovery ---------------------------------------------------

interface CategorizedPRs {
  "for-review": Record<string, unknown>[];
  "for-landing": Record<string, unknown>[];
  "untagged": Record<string, unknown>[];
}

/**
 * Fetch open PRs and categorize them by processing-mode labels.
 *
 * Returns PRs grouped into "for-review", "for-landing", and "untagged" buckets.
 * Drafts and WIP PRs are filtered out (and logged).
 */
export function getOpenPrs(): CategorizedPRs {
  logJson("fetch_prs", { action: "start" });

  const [returncode, stdout, stderr] = runCommand(
    [
      "gh",
      "pr",
      "list",
      "--json",
      "number,title,headRefName,baseRefName,isDraft,labels,url,author,createdAt,updatedAt",
      "--limit",
      "100",
    ],
    undefined,
    60,
  );

  if (returncode !== 0) {
    logJson("fetch_prs", { action: "error", stderr });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  if (!stdout || !stdout.trim()) {
    logJson("fetch_prs", { action: "empty_response" });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  let allPrs: unknown;
  try {
    allPrs = JSON.parse(stdout);
  } catch (e) {
    logJson("fetch_prs", { action: "parse_error", error: errMsg(e), stdout: stdout.slice(0, 200) });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  if (!Array.isArray(allPrs)) {
    logJson("fetch_prs", { action: "invalid_type", type: typeof allPrs });
    return { "for-review": [], "for-landing": [], "untagged": [] };
  }

  const categorized: CategorizedPRs = {
    "for-review": [],
    "for-landing": [],
    "untagged": [],
  };

  const filteredPrs: { draft: unknown[]; wip: unknown[]; invalid: unknown[] } = {
    draft: [],
    wip: [],
    invalid: [],
  };

  for (const prRaw of allPrs) {
    if (typeof prRaw !== "object" || prRaw === null) continue;
    const pr = prRaw as Record<string, unknown>;

    const prNumber = pr["number"];
    const prTitle = toStr(pr["title"], "Unknown");

    if (pr["number"] === undefined || pr["headRefName"] === undefined || pr["url"] === undefined) {
      logJson("fetch_prs", { action: "invalid_pr", pr });
      filteredPrs["invalid"].push({ number: prNumber, title: prTitle, reason: "missing_fields" });
      continue;
    }

    if (pr["isDraft"] === true) {
      filteredPrs["draft"].push({ number: prNumber, title: prTitle });
      logJson("fetch_prs", { action: "skip_draft", pr_number: prNumber, title: prTitle });
      continue;
    }

    const labels: string[] = [];
    for (const labelRaw of asArray(pr["labels"])) {
      const label = asRecord(labelRaw);
      if (label["name"] !== undefined) labels.push(toStr(label["name"]).toLowerCase());
    }

    let wipLabelFound: string | null = null;
    for (const label of labels) {
      for (const wip of ["wip", "work-in-process", "work in process"]) {
        if (label.includes(wip)) {
          wipLabelFound = label;
          break;
        }
      }
      if (wipLabelFound) break;
    }

    if (wipLabelFound) {
      filteredPrs["wip"].push({ number: prNumber, title: prTitle, label: wipLabelFound });
      logJson("fetch_prs", {
        action: "skip_wip",
        pr_number: prNumber,
        title: prTitle,
        wip_label: wipLabelFound,
      });
      continue;
    }

    if (labels.includes("for-review")) {
      categorized["for-review"].push(pr);
      logJson("fetch_prs", {
        action: "categorized",
        pr_number: prNumber,
        title: prTitle,
        category: "for-review",
        labels,
      });
    } else if (labels.includes("for-landing")) {
      categorized["for-landing"].push(pr);
      logJson("fetch_prs", {
        action: "categorized",
        pr_number: prNumber,
        title: prTitle,
        category: "for-landing",
        labels,
      });
    } else {
      categorized["untagged"].push(pr);
      logJson("fetch_prs", {
        action: "categorized",
        pr_number: prNumber,
        title: prTitle,
        category: "untagged",
        labels,
      });
    }
  }

  logJson("fetch_prs", {
    action: "complete",
    total: allPrs.length,
    for_review: categorized["for-review"].length,
    for_landing: categorized["for-landing"].length,
    untagged: categorized["untagged"].length,
    filtered_draft: filteredPrs["draft"].length,
    filtered_wip: filteredPrs["wip"].length,
    filtered_invalid: filteredPrs["invalid"].length,
    filtered_prs: filteredPrs,
  });

  return categorized;
}

/** Fetch open issues labeled "for-impl" that should be implemented. */
export function getOpenIssues(): Record<string, unknown>[] {
  logJson("fetch_issues", { action: "start" });

  const [returncode, stdout, stderr] = runCommand(
    [
      "gh",
      "issue",
      "list",
      "--json",
      "number,title,body,labels,url,author,createdAt,updatedAt,state",
      "--label",
      "for-impl",
      "--state",
      "open",
      "--limit",
      "100",
    ],
    undefined,
    60,
  );

  if (returncode !== 0) {
    logJson("fetch_issues", { action: "error", stderr });
    return [];
  }

  if (!stdout || !stdout.trim()) {
    logJson("fetch_issues", { action: "empty_response" });
    return [];
  }

  let allIssues: unknown;
  try {
    allIssues = JSON.parse(stdout);
  } catch (e) {
    logJson("fetch_issues", { action: "parse_error", error: errMsg(e), stdout: stdout.slice(0, 200) });
    return [];
  }

  if (!Array.isArray(allIssues)) {
    logJson("fetch_issues", { action: "invalid_type", type: typeof allIssues });
    return [];
  }

  const validIssues: Record<string, unknown>[] = [];
  for (const issueRaw of allIssues) {
    if (typeof issueRaw !== "object" || issueRaw === null) continue;
    const issue = issueRaw as Record<string, unknown>;

    if (issue["number"] === undefined || issue["title"] === undefined || issue["url"] === undefined) {
      logJson("fetch_issues", { action: "invalid_issue", issue });
      continue;
    }

    const labels: string[] = [];
    for (const labelRaw of asArray(issue["labels"])) {
      const label = asRecord(labelRaw);
      if (label["name"] !== undefined) labels.push(toStr(label["name"]).toLowerCase());
    }

    if (labels.includes("for-impl")) {
      validIssues.push(issue);
    }
  }

  logJson("fetch_issues", {
    action: "complete",
    total: allIssues.length,
    for_impl: validIssues.length,
  });

  return validIssues;
}

// --- Git helpers ------------------------------------------------------------

/** Validate that a string is a safe git reference name (prevents injection). */
export function validateGitRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;

  const unsafeChars = ["\0", "\n", "\r", " ", "~", "^", ":", "?", "*", "[", "\\", "..", "@{", "//"];
  for (const c of unsafeChars) {
    if (ref.includes(c)) return false;
  }

  if (ref.startsWith(".") || ref.startsWith("/") || ref.endsWith(".") || ref.endsWith("/") || ref.endsWith(".lock")) {
    return false;
  }

  return !(ref.length > 200);
}

/** Detect the default branch of the repository. */
export function detectDefaultBranch(): string {
  let [returncode, stdout, _stderr] = runCommand(
    ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
    undefined,
    10,
  );

  if (returncode === 0 && stdout) {
    const parts = stdout.trim().split("/");
    const branch = parts[parts.length - 1];
    if (branch) return branch;
  }

  for (const branch of ["main", "master", "develop"]) {
    const [rc] = runCommand(["git", "rev-parse", "--verify", `origin/${branch}`], undefined, 10);
    if (rc === 0) return branch;
  }

  logJson("branch_detection", { warning: "Could not detect default branch, using 'main'" });
  return "main";
}

/** Fetch comprehensive PR details from `gh pr view`. */
export function getPrDetails(prNumber: number): Record<string, unknown> {
  logJson("get_pr_details", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,body,state,headRefName,baseRefName,isDraft,mergeable," +
      "author,createdAt,updatedAt,closedAt,mergedAt,labels,assignees,reviewers," +
      "additions,deletions,changedFiles,commits,reviews,reviewDecision,statusCheckRollup",
  ]);

  if (returncode !== 0) {
    logJson("get_pr_details", { action: "error", pr_number: prNumber, stderr });
    return {};
  }

  let details: Record<string, unknown>;
  try {
    details = JSON.parse(stdout) as Record<string, unknown>;
  } catch (e) {
    logJson("get_pr_details", { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return {};
  }

  logJson("get_pr_details", { action: "complete", pr_number: prNumber });
  return details;
}

/** Fetch all PR discussion/issue comments. */
export function getPrComments(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_comments", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "api",
    `repos/{owner}/{repo}/issues/${prNumber}/comments`,
    "--jq",
    ".",
  ]);

  if (returncode !== 0) {
    logJson("get_pr_comments", { action: "error", pr_number: prNumber, stderr });
    return [];
  }

  let comments: unknown;
  try {
    comments = stdout ? JSON.parse(stdout) : [];
  } catch (e) {
    logJson("get_pr_comments", { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return [];
  }

  const list = Array.isArray(comments) ? (comments as Record<string, unknown>[]) : [];
  logJson("get_pr_comments", {
    action: "complete",
    pr_number: prNumber,
    comment_count: list.length,
  });
  return list;
}

/** Fetch all inline PR review comments. */
export function getPrReviewComments(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_review_comments", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
    "--jq",
    ".",
  ]);

  if (returncode !== 0) {
    logJson("get_pr_review_comments", { action: "error", pr_number: prNumber, stderr });
    return [];
  }

  let comments: unknown;
  try {
    comments = stdout ? JSON.parse(stdout) : [];
  } catch (e) {
    logJson("get_pr_review_comments", { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return [];
  }

  const list = Array.isArray(comments) ? (comments as Record<string, unknown>[]) : [];
  logJson("get_pr_review_comments", {
    action: "complete",
    pr_number: prNumber,
    review_comment_count: list.length,
  });
  return list;
}

/** Get the PR diff. */
export function getPrDiff(prNumber: number): string {
  logJson("get_pr_diff", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand(["gh", "pr", "diff", String(prNumber)]);

  if (returncode !== 0) {
    logJson("get_pr_diff", { action: "error", pr_number: prNumber, stderr });
    return "";
  }

  logJson("get_pr_diff", {
    action: "complete",
    pr_number: prNumber,
    diff_size: stdout.length,
  });
  return stdout;
}

/** Check if a PR has merge conflicts with its base branch. */
export function checkMergeConflicts(
  prNumber: number,
  headBranch: string,
  baseBranch: string,
): Record<string, unknown> {
  logJson("check_merge_conflicts", {
    action: "start",
    pr_number: prNumber,
    head_branch: headBranch,
    base_branch: baseBranch,
  });

  if (!validateGitRef(headBranch)) {
    logJson("check_merge_conflicts", {
      action: "invalid_branch",
      pr_number: prNumber,
      branch: "head",
      value: headBranch,
    });
    return {
      has_conflicts: false,
      conflicting_files: [],
      conflict_count: 0,
      error: "Invalid head branch name",
    };
  }

  if (!validateGitRef(baseBranch)) {
    logJson("check_merge_conflicts", {
      action: "invalid_branch",
      pr_number: prNumber,
      branch: "base",
      value: baseBranch,
    });
    return {
      has_conflicts: false,
      conflicting_files: [],
      conflict_count: 0,
      error: "Invalid base branch name",
    };
  }

  let [returncode, stdout, stderr] = runCommand(
    ["git", "fetch", "origin", headBranch, baseBranch],
    undefined,
    120,
  );

  if (returncode !== 0) {
    logJson("check_merge_conflicts", {
      action: "fetch_error",
      pr_number: prNumber,
      stderr,
    });
    return {
      has_conflicts: false,
      conflicting_files: [],
      conflict_count: 0,
      error: "Failed to fetch branches",
    };
  }

  [returncode, stdout, stderr] = runCommand(
    ["git", "merge-tree", `origin/${baseBranch}`, `origin/${headBranch}`],
    undefined,
    120,
  );

  let hasConflicts = false;
  if (returncode === 0 && stdout) {
    const lines = stdout.split("\n");
    let conflictMarkerCount = 0;
    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) conflictMarkerCount++;
    }
    hasConflicts = conflictMarkerCount > 0;
  }

  const conflictingFiles: string[] = [];
  if (hasConflicts) {
    const lines = stdout.split("\n");
    let currentFile: string | null = null;
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---")) {
        const parts = line.split(" ");
        if (parts.length > 1 && parts[1] !== "/dev/null") {
          const filePath = (parts[1] ?? "").replace(/^[ab/]+/, "");
          if (filePath && !conflictingFiles.includes(filePath)) {
            currentFile = filePath;
          }
        }
      } else if (line.startsWith("<<<<<<<") && currentFile) {
        if (!conflictingFiles.includes(currentFile)) {
          conflictingFiles.push(currentFile);
        }
      }
    }
  }

  const result: Record<string, unknown> = {
    has_conflicts: hasConflicts,
    conflicting_files: conflictingFiles,
    conflict_count: conflictingFiles.length,
  };

  logJson("check_merge_conflicts", {
    action: "complete",
    pr_number: prNumber,
    ...result,
  });

  return result;
}

/** Get all commits in the PR. */
export function getPrCommits(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_commits", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}/commits`,
    "--jq",
    ".",
  ]);

  if (returncode !== 0) {
    logJson("get_pr_commits", { action: "error", pr_number: prNumber, stderr });
    return [];
  }

  let commits: unknown;
  try {
    commits = stdout ? JSON.parse(stdout) : [];
  } catch (e) {
    logJson("get_pr_commits", { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return [];
  }

  const list = Array.isArray(commits) ? (commits as Record<string, unknown>[]) : [];
  logJson("get_pr_commits", {
    action: "complete",
    pr_number: prNumber,
    commit_count: list.length,
  });
  return list;
}

/** Get list of changed files in the PR. */
export function getPrFiles(prNumber: number): Record<string, unknown>[] {
  logJson("get_pr_files", { action: "start", pr_number: prNumber });

  const [returncode, stdout, stderr] = runCommand([
    "gh",
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}/files`,
    "--jq",
    ".",
  ]);

  if (returncode !== 0) {
    logJson("get_pr_files", { action: "error", pr_number: prNumber, stderr });
    return [];
  }

  let files: unknown;
  try {
    files = stdout ? JSON.parse(stdout) : [];
  } catch (e) {
    logJson("get_pr_files", { action: "parse_error", pr_number: prNumber, error: errMsg(e) });
    return [];
  }

  const list = Array.isArray(files) ? (files as Record<string, unknown>[]) : [];
  logJson("get_pr_files", {
    action: "complete",
    pr_number: prNumber,
    file_count: list.length,
  });
  return list;
}

/** Analyze CI/CD status from a statusCheckRollup list. */
export function analyzeCiStatus(statusChecks: Record<string, unknown>[] | null): Record<string, unknown> {
  if (!statusChecks || statusChecks.length === 0) {
    return {
      total_checks: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      failed_checks: [],
    };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;
  const failedChecks: Record<string, unknown>[] = [];

  for (const check of statusChecks) {
    const status = toStr(check["state"]).toUpperCase();
    const conclusion = toStr(check["conclusion"]).toUpperCase();

    if (conclusion === "SUCCESS") {
      passed++;
    } else if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "STARTUP_FAILURE") {
      failed++;
      failedChecks.push({
        name: toStr(check["name"], "unknown"),
        conclusion,
        details_url: toStr(check["detailsUrl"]),
      });
    } else if (status === "PENDING" || status === "IN_PROGRESS") {
      pending++;
    } else if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") {
      skipped++;
    }
  }

  return {
    total_checks: statusChecks.length,
    passed,
    failed,
    pending,
    skipped,
    failed_checks: failedChecks,
  };
}

/** Sync the repository with origin. Returns true on success. */
export function syncRepo(defaultBranch = "main"): boolean {
  logJson("sync_repo", { action: "start", branch: defaultBranch });

  if (!validateGitRef(defaultBranch)) {
    logJson("sync_repo", {
      action: "error",
      step: "validation",
      error: `Invalid branch name: ${defaultBranch}`,
    });
    return false;
  }

  let [returncode, _stdout, stderr] = runCommand(["git", "fetch", "--all", "--prune"], undefined, 180);
  if (returncode !== 0) {
    logJson("sync_repo", { action: "error", step: "fetch", stderr });
    return false;
  }

  [returncode, _stdout, stderr] = runCommand(["git", "checkout", defaultBranch], undefined, 30);
  if (returncode !== 0) {
    logJson("sync_repo", { action: "error", step: "checkout", branch: defaultBranch, stderr });
    return false;
  }

  [returncode, _stdout, stderr] = runCommand(["git", "pull", "origin", defaultBranch], undefined, 120);
  if (returncode !== 0) {
    logJson("sync_repo", { action: "error", step: "pull", branch: defaultBranch, stderr });
    return false;
  }

  logJson("sync_repo", { action: "complete" });
  return true;
}

/** Check for PR guidelines in common locations. */
export function getPrGuidelines(): string {
  const guidelineFiles = [
    "CONTRIBUTING.md",
    ".github/CONTRIBUTING.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/CONTRIBUTING.md",
    "PULL_REQUEST_TEMPLATE.md",
  ];

  for (const filename of guidelineFiles) {
    const filepath = resolve(process.cwd(), filename);
    if (existsSync(filepath)) {
      try {
        return readFileSync(filepath, "utf8");
      } catch {
        continue;
      }
    }
  }

  return "";
}

/** Get recent commit messages from the default branch as style examples. */
export function getCommitHistoryExamples(defaultBranch = "main"): string {
  if (!validateGitRef(defaultBranch)) {
    logJson("commit_history", { warning: `Invalid branch name: ${defaultBranch}` });
    return "";
  }

  const [returncode, stdout, _stderr] = runCommand(
    ["git", "log", "--pretty=format:%s", "-n", "20", `origin/${defaultBranch}`],
    undefined,
    30,
  );

  if (returncode === 0 && stdout) {
    return stdout;
  }

  return "";
}

// --- Prompt building --------------------------------------------------------

/** Build a comprehensive prompt for pi to process the PR with full context. */
export function buildPrPrompt(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
): string {
  const prNumber = prDetails["number"] ?? "unknown";
  const title = toStr(prDetails["title"]);
  const body = toStr(prDetails["body"]);
  const headBranch = toStr(prDetails["headRefName"]);
  const baseBranch = toStr(prDetails["baseRefName"], "main");
  const url = toStr(prContext["url"]);
  const prAuthor = toStr(asRecord(prDetails["author"])["login"], "unknown");

  const parts: string[] = [
    `# PR #${prNumber}: ${title}`,
    "",
    `**Author**: ${prAuthor}`,
    `**Branch**: ${headBranch} → ${baseBranch}`,
    `**URL**: ${url}`,
    "",
  ];

  if (body) {
    parts.push("## PR Description", "", body, "");
  }

  const additions = toNum(prDetails["additions"]);
  const deletions = toNum(prDetails["deletions"]);
  const changedFiles = toNum(prDetails["changedFiles"]);

  parts.push(
    "## PR Statistics",
    "",
    `- **Files changed**: ${changedFiles}`,
    `- **Additions**: +${additions}`,
    `- **Deletions**: -${deletions}`,
    "",
  );

  const conflictInfo = asRecord(prContext["conflicts"]);
  if (conflictInfo["has_conflicts"] === true) {
    const conflictingFiles = asArray(conflictInfo["conflicting_files"]).map((f) => toStr(f));
    parts.push(
      "## ⚠️ Merge Conflicts Detected",
      "",
      `This PR has merge conflicts with ${baseBranch}. You MUST resolve these conflicts:`,
      "",
    );
    for (const file of conflictingFiles) {
      parts.push(`- \`${file}\``);
    }
    parts.push("");
  }

  const ciStatus = asRecord(prContext["ci_status"]);
  if (toNum(ciStatus["total_checks"]) > 0) {
    parts.push(
      "## CI/CD Status",
      "",
      `- **Total checks**: ${ciStatus["total_checks"]}`,
      `- **Passed**: ✅ ${ciStatus["passed"]}`,
      `- **Failed**: ❌ ${ciStatus["failed"]}`,
      `- **Pending**: ⏳ ${ciStatus["pending"]}`,
      `- **Skipped**: ⏭️ ${ciStatus["skipped"]}`,
      "",
    );

    const failedChecks = asArray(ciStatus["failed_checks"]);
    if (failedChecks.length > 0) {
      parts.push("### Failed Checks (MUST FIX)", "");
      for (const checkRaw of failedChecks) {
        const check = asRecord(checkRaw);
        parts.push(`- **${check["name"]}**: ${check["conclusion"]}`);
        if (check["details_url"]) {
          parts.push(`  - Details: ${check["details_url"]}`);
        }
      }
      parts.push("");
    }
  }

  const reviewDecision = toStr(prDetails["reviewDecision"]);
  if (reviewDecision) {
    const emoji =
      reviewDecision === "APPROVED"
        ? "✅"
        : reviewDecision === "CHANGES_REQUESTED"
          ? "⚠️"
          : "⏳";
    parts.push("## Review Status", "", `${emoji} **${reviewDecision}**`, "");
  }

  const reviewComments = asArray(prContext["review_comments"]);
  if (reviewComments.length > 0) {
    parts.push(
      "## Code Review Comments (MUST ADDRESS)",
      "",
      "These are inline code review comments that require your attention:",
      "",
    );
    let i = 1;
    for (const commentRaw of reviewComments.slice(0, 20)) {
      const comment = asRecord(commentRaw);
      const commentAuthor = toStr(asRecord(comment["user"])["login"], "unknown");
      const commentBody = toStr(comment["body"]);
      const path = toStr(comment["path"]);
      const line = toStr(comment["line"]) || toStr(comment["original_line"]);
      parts.push(
        `### Review Comment ${i}`,
        `**File**: \`${path}\` (line ${line})`,
        `**Author**: ${commentAuthor}`,
        "",
        commentBody,
        "",
      );
      i++;
    }
  }

  const comments = asArray(prContext["comments"]);
  if (comments.length > 0) {
    parts.push("## Discussion Comments", "");
    let i = 1;
    for (const commentRaw of comments.slice(-10)) {
      const comment = asRecord(commentRaw);
      const commentAuthor = toStr(asRecord(comment["user"])["login"], "unknown");
      const commentBody = toStr(comment["body"]);
      parts.push(`### Comment ${i}`, `**Author**: ${commentAuthor}`, "", commentBody, "");
      i++;
    }
  }

  const changedFilesList = asArray(prContext["files"]);
  if (changedFilesList.length > 0) {
    parts.push("## Changed Files", "");
    for (const fileRaw of changedFilesList.slice(0, 50)) {
      const file = asRecord(fileRaw);
      const filename = toStr(file["filename"]);
      const status = toStr(file["status"], "modified");
      const fileAdditions = toNum(file["additions"]);
      const fileDeletions = toNum(file["deletions"]);
      const statusEmoji =
        status === "added"
          ? "✨"
          : status === "removed"
            ? "🗑️"
            : status === "modified"
              ? "📝"
              : status === "renamed"
                ? "🔄"
                : "📝";
      parts.push(`- ${statusEmoji} \`${filename}\` (+${fileAdditions}/-${fileDeletions})`);
    }
    parts.push("");
  }

  const commits = asArray(prContext["commits"]);
  if (commits.length > 0) {
    parts.push("## Commit History", "");
    for (const commitRaw of commits.slice(-10)) {
      const commit = asRecord(commitRaw);
      const message = toStr(asRecord(commit["commit"])["message"]).split("\n")[0];
      const sha = toStr(commit["sha"]);
      const shortSha = sha.length >= 7 ? sha.slice(0, 7) : sha ? sha : "unknown";
      parts.push(`- \`${shortSha}\` ${message}`);
    }
    parts.push("");
  }

  parts.push("---", "", "## Your Mission", "", `**Working on**: ${title}`, "");

  if (body) {
    const descriptionLines = body.trim().split("\n");
    const summary = descriptionLines[0] ?? body.slice(0, 500);
    parts.push(`**Purpose**: ${summary}`, "");
  }

  parts.push("Get this PR merged successfully by completing ALL of the following:", "");

  const tasks: string[] = [];
  if (conflictInfo["has_conflicts"] === true) {
    tasks.push("1. **RESOLVE MERGE CONFLICTS** - This is CRITICAL and must be done first");
  }

  let taskNum = tasks.length + 1;
  tasks.push(`${taskNum}. Checkout the PR branch: \`${headBranch}\``);
  tasks.push(`${taskNum + 1}. Sync with \`${baseBranch}\` (fetch and merge/rebase)`);
  taskNum += 2;

  if (reviewComments.length > 0) {
    tasks.push(
      `${taskNum}. Address ALL ${reviewComments.length} code review comments with appropriate changes`,
    );
    taskNum++;
  }

  if (toNum(ciStatus["failed"]) > 0) {
    tasks.push(`${taskNum}. Fix ALL ${ciStatus["failed"]} failing CI checks`);
    taskNum++;
  }

  tasks.push(`${taskNum}. Run tests and checks locally to verify everything passes`);
  tasks.push(`${taskNum + 1}. Push changes back to \`${headBranch}\``);
  tasks.push(`${taskNum + 2}. Verify CI passes on GitHub after pushing`);

  parts.push(...tasks);
  parts.push("");

  if (guidelines) {
    parts.push(
      "## Project Guidelines",
      "",
      "Follow these PR and contribution guidelines:",
      "",
      "```",
      guidelines,
      "```",
      "",
    );
  } else if (commitExamples) {
    parts.push(
      "## Commit Style Examples",
      "",
      "No explicit guidelines found. Follow the style of recent commits:",
      "",
      "```",
      commitExamples,
      "```",
      "",
    );
  }

  parts.push(
    "## Critical Rules",
    "",
    "- ❌ **NO assistant branding** in commits, comments, or code",
    "- ✅ Write clear, professional commit messages matching project style",
    "- ✅ Make focused, minimal changes addressing specific issues only",
    "- ✅ Test thoroughly before pushing",
    "- ✅ Respond to review comments on GitHub when appropriate",
    "- ✅ If blocked, clearly document the issue and what's needed",
    "",
    "## Execution",
    "",
    "Work autonomously through all tasks. Report progress and any blockers.",
    "",
  );

  return parts.join("\n");
}

/** Build a code review prompt for targeted improvements (second agent pass). */
export function buildReviewPrompt(
  prNumber: number,
  title: string,
  headBranch: string,
  url: string,
  diff: string,
  changedFiles: Record<string, unknown>[],
): string {
  const parts: string[] = [
    `# Code Review: PR #${prNumber} - ${title}`,
    "",
    `**Branch**: ${headBranch}`,
    `**URL**: ${url}`,
    "",
    "## Your Mission: Code Review and Targeted Improvements",
    "",
    "You are conducting a thorough code review of this PR. Your goal is to:",
    "",
    "1. **Review all code changes** for quality, correctness, and best practices",
    "2. **Identify issues** such as:",
    "   - Bugs or logical errors",
    "   - Security vulnerabilities",
    "   - Performance issues",
    "   - Code duplication",
    "   - Poor error handling",
    "   - Missing edge case handling",
    "   - Inconsistent coding style",
    "   - Missing or inadequate tests",
    "   - Unclear or missing documentation",
    "3. **Make targeted improvements** to fix identified issues",
    "4. **Commit your improvements** with clear, descriptive messages",
    "",
    "## Changed Files",
    "",
  ];

  for (const file of changedFiles.slice(0, 50)) {
    const filename = toStr(file["filename"]);
    const additions = toNum(file["additions"]);
    const deletions = toNum(file["deletions"]);
    const status = toStr(file["status"], "modified");
    const statusEmoji =
      status === "added"
        ? "✨"
        : status === "removed"
          ? "🗑️"
          : status === "modified"
            ? "📝"
            : status === "renamed"
              ? "🔄"
              : "📝";
    parts.push(`- ${statusEmoji} \`${filename}\` (+${additions}/-${deletions})`);
  }

  const truncatedDiff = diff.length > 100000 ? diff.slice(0, 100000) : diff;

  parts.push(
    "",
    "## Full Diff",
    "",
    "Below is the complete diff of all changes in this PR. Review each change carefully:",
    "",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "## Review Guidelines",
    "",
    "### Code Quality Checks",
    "- ✅ **Correctness**: Does the code do what it's supposed to do?",
    "- ✅ **Error Handling**: Are errors handled gracefully?",
    "- ✅ **Edge Cases**: Are boundary conditions and edge cases handled?",
    "- ✅ **Resource Management**: Are resources (files, connections, etc.) properly managed?",
    "- ✅ **Type Safety**: Are types used correctly? Any type errors?",
    "",
    "### Security Checks",
    "- 🔒 **Input Validation**: Is user input properly validated?",
    "- 🔒 **SQL Injection**: Are queries parameterized?",
    "- 🔒 **XSS**: Is output properly escaped?",
    "- 🔒 **Authentication/Authorization**: Are permissions checked?",
    "- 🔒 **Secrets**: Are there any hardcoded secrets or credentials?",
    "",
    "### Performance Checks",
    "- ⚡ **Algorithmic Efficiency**: Are algorithms efficient?",
    "- ⚡ **Database Queries**: Are queries optimized? N+1 queries?",
    "- ⚡ **Memory Usage**: Any memory leaks or excessive allocations?",
    "- ⚡ **Caching**: Should results be cached?",
    "",
    "### Best Practices",
    "- 📚 **DRY**: Is code duplicated? Can it be refactored?",
    "- 📚 **SOLID**: Does code follow SOLID principles?",
    "- 📚 **Naming**: Are variables and functions clearly named?",
    "- 📚 **Comments**: Are complex sections documented?",
    "- 📚 **Tests**: Are tests adequate? Missing test cases?",
    "",
    "## Making Improvements",
    "",
    "For each issue you identify:",
    "",
    "1. **Fix it directly** - Make the code changes",
    "2. **Write clear commits** - Explain what you fixed and why",
    "3. **Run tests** - Ensure your changes don't break anything",
    "4. **Be surgical** - Make focused, minimal changes",
    "",
    "### Commit Message Format",
    "",
    "Use clear, descriptive commit messages:",
    "",
    "```",
    "Fix: [brief description]",
    "",
    "[Detailed explanation of what was wrong and how you fixed it]",
    "```",
    "",
    "Examples:",
    "- `Fix: Add input validation to prevent SQL injection in user search`",
    "- `Refactor: Extract duplicate error handling into helper function`",
    "- `Performance: Add caching to reduce redundant API calls`",
    "- `Security: Remove hardcoded API key, use environment variable`",
    "",
    "## Critical Rules",
    "",
    "- ❌ **NO assistant branding** in commits or comments",
    "- ✅ **Be thorough** but don't over-engineer",
    "- ✅ **Preserve intent** - don't change functionality unless it's wrong",
    "- ✅ **Test your changes** before committing",
    "- ✅ **If unsure**, skip that change and document why",
    "",
    "## Execution",
    "",
    "Review the diff systematically. For each file:",
    "1. Understand what the code does",
    "2. Look for issues based on guidelines above",
    "3. Make improvements where needed",
    "4. Commit with clear messages",
    "",
    "Focus on high-impact improvements. Don't waste time on trivial style issues.",
    "",
  );

  return parts.join("\n");
}

// --- PR context gathering ---------------------------------------------------

/**
 * Gather comprehensive context about a PR before processing.
 *
 * Returns a tuple `[prDetails, prContext]`. Both elements are plain
 * `Record<string, unknown>` dictionaries. Other modules (e.g. sync_pr_context)
 * import this via the `gather_pr_context` snake_case alias.
 */
export async function gatherPrContext(
  prNumber: number,
  headBranch: string,
  baseBranch: string,
  url: string,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  logJson("gather_pr_context", { action: "start", pr_number: prNumber });

  const context: Record<string, unknown> = {
    url,
    comments: [] as unknown[],
    review_comments: [] as unknown[],
    commits: [] as unknown[],
    files: [] as unknown[],
    conflicts: {} as Record<string, unknown>,
    ci_status: {} as Record<string, unknown>,
    diff: "",
  };

  const details = getPrDetails(prNumber);

  const statusChecks = asArray(details["statusCheckRollup"]) as Record<string, unknown>[];
  context["ci_status"] = analyzeCiStatus(statusChecks);

  context["comments"] = getPrComments(prNumber);
  context["review_comments"] = getPrReviewComments(prNumber);
  context["commits"] = getPrCommits(prNumber);
  context["files"] = getPrFiles(prNumber);
  context["conflicts"] = checkMergeConflicts(prNumber, headBranch, baseBranch);
  context["diff"] = getPrDiff(prNumber);

  const conflicts = asRecord(context["conflicts"]);
  const ciStatus = asRecord(context["ci_status"]);
  const diff = toStr(context["diff"]);

  logJson("gather_pr_context", {
    action: "complete",
    pr_number: prNumber,
    context_summary: {
      comments: asArray(context["comments"]).length,
      review_comments: asArray(context["review_comments"]).length,
      commits: asArray(context["commits"]).length,
      files: asArray(context["files"]).length,
      has_conflicts: conflicts["has_conflicts"] === true,
      ci_checks: toNum(ciStatus["total_checks"]),
      ci_failed: toNum(ciStatus["failed"]),
      diff_size: diff.length,
    },
  });

  return [details, context];
}

// snake_case alias for cross-module compatibility (sync_pr_context imports this).
export { gatherPrContext as gather_pr_context };

// --- Agent client -----------------------------------------------------------

let _agentClient: unknown = null;
let _agentModel: string | null = null;

/** Get or create the global agent client (throws if the SDK is unavailable). */
export function getAgentClient(): [Anthropic, string] {
  if (_agentClient === null) {
    _agentClient = createClaudeClient();
    _agentModel = getModelName();
  }
  return [_agentClient as Anthropic, _agentModel as string];
}

// --- PR / issue processing --------------------------------------------------

/**
 * Process a single PR using structured tasks and streaming (Agent SDK path).
 *
 * Returns true if processing succeeded, false otherwise. Currently disabled at
 * runtime because the Claude Agent SDK layer (agents/claude_agent) is not yet
 * ported; processPr() short-circuits to false when AGENT_SDK_AVAILABLE is false.
 */
export async function processPrAsync(
  pr: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
  defaultBranch = "main",
  mode = "for-landing",
  interactive = false,
  db: SyncStore | null = null,
  repoName: string | null = null,
): Promise<boolean> {
  const prNumber = pr["number"] as number | undefined;
  const headBranch = pr["headRefName"] as string | undefined;
  const baseBranch = (pr["baseRefName"] as string | undefined) ?? defaultBranch;
  const url = pr["url"] as string | undefined;
  const title = (pr["title"] as string | undefined) ?? "Unknown";

  if (!prNumber) {
    logJson("process_pr", { action: "validation_error", error: "Missing PR number", pr });
    return false;
  }

  if (!headBranch) {
    logJson("process_pr", { action: "validation_error", pr_number: prNumber, error: "Missing head branch" });
    return false;
  }

  if (!url) {
    logJson("process_pr", { action: "validation_error", pr_number: prNumber, error: "Missing PR URL" });
    return false;
  }

  if (!validateGitRef(headBranch)) {
    logJson("process_pr", {
      action: "validation_error",
      pr_number: prNumber,
      error: `Invalid head branch name: ${headBranch}`,
    });
    return false;
  }

  if (!validateGitRef(baseBranch)) {
    logJson("process_pr", {
      action: "validation_error",
      pr_number: prNumber,
      error: `Invalid base branch name: ${baseBranch}`,
    });
    return false;
  }

  if (interactive) {
    const approved = await requestConfirmation("process_pr", `Process PR #${prNumber}: ${title}`, String(prNumber), {
      title,
      mode,
      head_branch: headBranch,
      base_branch: baseBranch,
      url,
    });

    if (!approved) {
      logJson("process_pr", { action: "declined_by_user", pr_number: prNumber });
      return false;
    }
  }

  logJson("process_pr", {
    action: "start",
    pr_number: prNumber,
    title,
    head_branch: headBranch,
    base_branch: baseBranch,
    mode,
  });

  await sendNotification(
    `Processing PR #${prNumber}: ${title}\nMode: ${mode}`,
    `PR #${prNumber} - Processing Started`,
    "default",
    ["robot", "arrows_clockwise"],
  );

  logJson("process_pr", {
    action: "gathering_context",
    pr_number: prNumber,
    phase: "1/4",
    phase_name: "Context Gathering",
  });

  let prDetails: Record<string, unknown>;
  let prContextDict: Record<string, unknown>;
  try {
    [prDetails, prContextDict] = await gatherPrContext(prNumber, headBranch, baseBranch, url);
    logJson("process_pr", {
      action: "context_gathered",
      pr_number: prNumber,
      phase: "1/4",
      phase_name: "Context Gathering Complete",
    });
  } catch (e) {
    logJson("process_pr", { action: "context_gather_error", pr_number: prNumber, error: errMsg(e) });
    await sendNotification(
      `PR #${prNumber} failed: ${title}\nError gathering context: ${errMsg(e).slice(0, 100)}`,
      `PR #${prNumber} - Error`,
      "high",
      ["x", "warning"],
    );
    return false;
  }

  if (Object.keys(prDetails).length === 0) {
    logJson("process_pr", {
      action: "empty_details",
      pr_number: prNumber,
      error: "Failed to fetch PR details",
    });
    return false;
  }

  prContextDict["guidelines"] = guidelines;
  prContextDict["commit_examples"] = commitExamples;

  if (db && repoName) {
    try {
      await db.savePrContext(repoName, prNumber, prDetails, prContextDict);
      logJson("process_pr", { action: "context_saved_to_db", pr_number: prNumber, db_enabled: true });
    } catch (e) {
      logJson("process_pr", {
        action: "context_save_warning",
        pr_number: prNumber,
        error: errMsg(e),
        hint: "PR processing will continue, but context won't be cached for replay",
      });
    }
  }

  logJson("process_pr", {
    action: "building_context",
    pr_number: prNumber,
    phase: "2/4",
    phase_name: "Building PR Context",
  });

  let prContext: PRContext;
  try {
    prContext = createPRContextFromDict(prDetails, prContextDict);
    logJson("process_pr", {
      action: "context_built",
      pr_number: prNumber,
      phase: "2/4",
      phase_name: "PR Context Ready",
    });
  } catch (e) {
    logJson("process_pr", { action: "context_conversion_error", pr_number: prNumber, error: errMsg(e) });
    return false;
  }

  logJson("process_pr", {
    action: "initializing_agent",
    pr_number: prNumber,
    phase: "3/4",
    phase_name: "Initializing Agent",
  });

  let client: Anthropic;
  let model: string;
  try {
    [client, model] = getAgentClient();
    logJson("process_pr", {
      action: "agent_initialized",
      pr_number: prNumber,
      phase: "3/4",
      model,
    });
  } catch (e) {
    logJson("process_pr", { action: "agent_client_error", pr_number: prNumber, error: errMsg(e) });
    return false;
  }

  const agent = new PRAgent(client, { model, repo_path: process.cwd() });
  const callbacks = new PRProcessingCallbacks(prNumber, logJson, null);

  logJson("process_pr", {
    action: "agent_processing",
    pr_number: prNumber,
    phase: "4/4",
    phase_name: "Agent Processing PR",
    mode,
  });

  try {
    const result = await agent.processPrStreaming(prContext, mode, callbacks);

    logJson("process_pr", {
      action: "complete",
      pr_number: prNumber,
      phase: "4/4",
      success: result.success,
      duration: result.duration,
      tasks_total: result.tasks.length,
      tasks_completed: result.tasks.filter((t) => t.status === "completed").length,
      tasks_failed: result.tasks.filter((t) => t.status === "failed").length,
      actions_taken: result.actions.length,
      mode,
    });

    if (result.success) {
      await sendNotification(
        `PR #${prNumber} completed: ${title}\n` +
          `Mode: ${mode}\n` +
          `Tasks: ${result.tasks.length}, Actions: ${result.actions.length}\n` +
          `Duration: ${result.duration.toFixed(1)}s`,
        `PR #${prNumber} - Complete`,
        "default",
        ["white_check_mark", "rocket"],
      );
    } else {
      const failedTasks = getFailedTasks(result);
      await sendNotification(
        `PR #${prNumber} failed: ${title}\n` +
          `Failed tasks: ${failedTasks.map((t) => t.id).join(", ")}\n` +
          `Duration: ${result.duration.toFixed(1)}s`,
        `PR #${prNumber} - Failed`,
        "high",
        ["x", "warning"],
      );
    }

    return result.success;
  } catch (e) {
    logJson("process_pr", {
      action: "exception",
      pr_number: prNumber,
      error: errMsg(e),
      error_type: e instanceof Error ? e.name : typeof e,
    });

    await sendNotification(
      `PR #${prNumber} exception: ${errMsg(e).slice(0, 100)}`,
      `PR #${prNumber} - Error`,
      "urgent",
      ["x", "warning"],
    );

    return false;
  }
}

/**
 * Process a single PR using the Claude Agent SDK (bridged to processPrAsync).
 *
 * Returns false immediately when the Agent SDK is unavailable.
 */
export async function processPr(
  pr: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
  defaultBranch = "main",
  mode = "for-landing",
  interactive = false,
  db: SyncStore | null = null,
  repoName: string | null = null,
): Promise<boolean> {
  return processPrAsync(pr, guidelines, commitExamples, defaultBranch, mode, interactive, db, repoName);
}

/**
 * Process a GitHub issue labeled "for-impl".
 *
 * Creates a branch, implements the feature/fix via the pi agent (through the
 * merge-god coordination API), and lets the agent create a linked PR. Returns
 * true on success.
 */
export async function processIssue(
  issue: Record<string, unknown>,
  guidelines: string,
  commitExamples: string,
  defaultBranch = "main",
  interactive = false,
): Promise<boolean> {
  const issueNumber = issue["number"] as number | undefined;
  const title = (issue["title"] as string | undefined) ?? "Unknown";
  const body = (issue["body"] as string | undefined) ?? "";
  const url = issue["url"] as string | undefined;

  if (!issueNumber) {
    logJson("process_issue", { action: "validation_error", error: "Missing issue number", issue });
    return false;
  }

  if (!url) {
    logJson("process_issue", {
      action: "validation_error",
      issue_number: issueNumber,
      error: "Missing issue URL",
    });
    return false;
  }

  if (interactive) {
    const approved = await requestConfirmation(
      "implement_issue",
      `Implement issue #${issueNumber}: ${title}`,
      null,
      { issue_number: issueNumber, title, url },
    );

    if (!approved) {
      logJson("process_issue", { action: "declined_by_user", issue_number: issueNumber });
      return false;
    }
  }

  logJson("process_issue", { action: "start", issue_number: issueNumber, title });

  await sendNotification(
    `Implementing issue #${issueNumber}: ${title}`,
    `Issue #${issueNumber} - Implementation Started`,
    "default",
    ["construction", "bulb"],
  );

  let sanitizedTitle = title.toLowerCase().replace(/ /g, "-").slice(0, 50);
  sanitizedTitle = Array.from(sanitizedTitle)
    .filter((c) => /[a-z0-9-]/.test(c))
    .join("");
  const branchName = `issue-${issueNumber}-${sanitizedTitle}`;

  if (!validateGitRef(branchName)) {
    logJson("process_issue", {
      action: "validation_error",
      issue_number: issueNumber,
      error: `Invalid branch name: ${branchName}`,
    });
    return false;
  }

  logJson("process_issue", { action: "sync_branch", branch: defaultBranch });

  let [returncode, _stdout, stderr] = runCommand(["git", "checkout", defaultBranch]);
  if (returncode !== 0) {
    logJson("process_issue", { action: "checkout_error", issue_number: issueNumber, error: stderr });
    return false;
  }

  [returncode, _stdout, stderr] = runCommand(["git", "pull", "origin", defaultBranch]);
  if (returncode !== 0) {
    logJson("process_issue", { action: "pull_error", issue_number: issueNumber, error: stderr });
    return false;
  }

  logJson("process_issue", {
    action: "create_branch",
    issue_number: issueNumber,
    branch: branchName,
  });

  [returncode, _stdout, stderr] = runCommand(["git", "checkout", "-b", branchName]);
  if (returncode !== 0) {
    [returncode, _stdout, stderr] = runCommand(["git", "checkout", branchName]);
    if (returncode !== 0) {
      logJson("process_issue", { action: "branch_error", issue_number: issueNumber, error: stderr });
      return false;
    }
  }

  const description = body ? body : "No description provided";
  const guidelinesText = guidelines ? guidelines : "No specific guidelines available";
  const examplesText = commitExamples ? commitExamples : "No examples available";

  const prompt = [
    "# Issue Implementation Task",
    "",
    "You are tasked with implementing a GitHub issue in this repository.",
    "",
    "## Issue Details",
    "",
    `**Issue Number:** #${issueNumber}`,
    `**Title:** ${title}`,
    `**URL:** ${url}`,
    "",
    "**Description:**",
    description,
    "",
    "## Your Task",
    "",
    "1. **Implement the feature or fix described in the issue**",
    "   - Read and understand the issue requirements carefully",
    "   - Implement the solution following best practices",
    "   - Ensure code quality, security, and performance",
    "",
    "2. **Write tests for your implementation**",
    "   - Add appropriate unit tests",
    "   - Ensure existing tests still pass",
    "",
    "3. **Commit your changes**",
    "   - Make focused, logical commits",
    "   - Write clear commit messages following project conventions",
    `   - Reference the issue in commits (e.g., "Fixes #${issueNumber}")`,
    "",
    "4. **Create a pull request**",
    `   - Use: \`gh pr create --fill --head ${branchName} --base ${defaultBranch}\``,
    `   - Link to the issue in PR description (use "Closes #${issueNumber}")`,
    "   - Request any necessary reviews",
    "",
    "## Project Guidelines",
    "",
    guidelinesText,
    "",
    "## Commit Message Examples",
    "",
    examplesText,
    "",
    "## Important Notes",
    "",
    `- You are currently on branch: \`${branchName}\``,
    `- Base branch: \`${defaultBranch}\``,
    `- This implementation should close issue #${issueNumber}`,
    "- Focus on completing the requirements in the issue",
    "- Ask questions if requirements are unclear",
    "- Test thoroughly before creating the PR",
    "",
    "Begin implementing the issue now.",
    "",
  ].join("\n");

  logJson("process_issue", {
    action: "prompt_generated",
    issue_number: issueNumber,
    prompt_size: prompt.length,
  });

  logJson("process_issue", { action: "running_pi", issue_number: issueNumber });

  const workItem: WorkItem = {
    kind: "issue",
    issue_number: issueNumber,
    title,
    url,
    prompt,
    repo_path: process.cwd(),
  };

  const piResult = await runPiAgent(workItem, process.cwd(), { timeout: 3600 });
  const { returncode: rc, stdout, stderr: piStderr, result: piResultObj } = piResult;

  logJson("process_issue", {
    action: "pi_complete",
    issue_number: issueNumber,
    returncode: rc,
    stdout,
    stderr: piStderr,
    result: piResultObj,
  });

  const success = rc === 0;

  if (success) {
    await sendNotification(
      `Issue #${issueNumber} implementation completed: ${title}\nCheck the created PR for details`,
      `Issue #${issueNumber} - Complete`,
      "default",
      ["white_check_mark", "bulb"],
    );
  } else {
    await sendNotification(
      `Issue #${issueNumber} implementation failed: ${title}\nCheck logs for details`,
      `Issue #${issueNumber} - Failed`,
      "high",
      ["x", "warning"],
    );
  }

  logJson("process_issue", { action: "complete", issue_number: issueNumber, success });

  return success;
}

// --- Repository validation --------------------------------------------------

/** Validate that the path is a valid git repository with GitHub auth available. */
export function validateRepository(repoPath: string): boolean {
  if (!existsSync(repoPath)) {
    logJson("validation_error", { error: "Repository path does not exist", path: repoPath });
    return false;
  }

  let isDir = false;
  try {
    isDir = statSync(repoPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    logJson("validation_error", { error: "Repository path is not a directory", path: repoPath });
    return false;
  }

  const gitDir = resolve(repoPath, ".git");
  if (!existsSync(gitDir)) {
    logJson("validation_error", {
      error: "Not a git repository (no .git directory)",
      path: repoPath,
    });
    return false;
  }

  const [returncode, _stdout, stderr] = runCommand(["git", "status"], repoPath);
  if (returncode !== 0) {
    logJson("validation_error", { error: "Git command failed", path: repoPath, stderr });
    return false;
  }

  const hasTokenEnv = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const [ghRc, ghStdout, ghStderr] = runCommand(["gh", "auth", "token"]);
  if (!hasTokenEnv && (ghRc !== 0 || ghStdout.trim().length === 0)) {
    logJson("validation_error", {
      error: "GitHub API auth unavailable. Set GITHUB_TOKEN/GH_TOKEN or run 'gh auth login'.",
      stderr: ghStderr,
    });
    return false;
  }

  logJson("validation", { success: true, path: repoPath });
  return true;
}

// --- CLI --------------------------------------------------------------------

interface CliArgs {
  repoPath: string;
  watchIssues: boolean;
  interactive: boolean;
}

/** Parse command line arguments. */
export function parseCliArgs(): CliArgs {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      "watch-issues": { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const repoPath = parsed.positionals[0];
  if (!repoPath) {
    console.error("Error: repo_path is required");
    console.error("Usage: pr-loop <repo_path> [--watch-issues] [--interactive]");
    process.exit(2);
  }

  return {
    repoPath,
    watchIssues: !!parsed.values["watch-issues"],
    interactive: !!parsed.values.interactive,
  };
}

/** Main loop — process PRs (and optionally issues) forever. */
export async function main(): Promise<void> {
  process.on("SIGINT", () => {
    logJson("shutdown", { reason: "keyboard_interrupt" });
    process.exit(0);
  });

  const args = parseCliArgs();
  const repoPath = resolve(args.repoPath);

  if (!validateRepository(repoPath)) {
    process.exit(1);
  }

  process.chdir(repoPath);

  logJson("startup", {
    repo_path: repoPath,
    cwd: process.cwd(),
    node_version: process.version,
  });

  let db: SyncStore | null = null;
  let repoName: string | null = null;
  if (DB_AVAILABLE) {
    try {
      const dbPath = resolve("merge-god-state.db");
      db = new SyncStore(dbPath);
      await db.initialize();
      repoName = basename(repoPath);
      logJson("startup", { database_enabled: true, db_path: dbPath, repo_name: repoName });
    } catch (e) {
      logJson("startup", {
        database_error: errMsg(e),
        warning: "Continuing without database persistence",
      });
      db = null;
    }
  } else {
    logJson("startup", {
      database_enabled: false,
      warning: "Database operations module not available",
    });
  }

  const defaultBranch = detectDefaultBranch();
  logJson("startup", { default_branch: defaultBranch });

  const guidelines = getPrGuidelines();
  const commitExamples = !guidelines ? getCommitHistoryExamples(defaultBranch) : "";

  logJson("startup", {
    has_guidelines: !!guidelines,
    has_commit_examples: !!commitExamples,
  });

  let iteration = 0;
  const processingPrs = new Set<number>();
  const processingIssues = new Set<number>();

  for (;;) {
    iteration++;
    logJson("iteration", { number: iteration, action: "start" });

    if (!syncRepo(defaultBranch)) {
      logJson("iteration", { number: iteration, action: "sync_failed", sleep_seconds: 60 });
      await sleep(60_000);
      continue;
    }

    let issuesProcessed = 0;
    if (args.watchIssues) {
      const openIssues = getOpenIssues();

      if (openIssues.length > 0) {
        logJson("iteration", {
          number: iteration,
          action: "issues_found",
          count: openIssues.length,
        });

        for (const issue of openIssues) {
          const issueNumber = issue["number"] as number | undefined;

          if (issueNumber && processingIssues.has(issueNumber)) {
            logJson("process_issue", { action: "skip_duplicate", issue_number: issueNumber });
            continue;
          }

          if (issueNumber) processingIssues.add(issueNumber);

          try {
            const success = await processIssue(issue, guidelines, commitExamples, defaultBranch, args.interactive);
            if (success && issueNumber) processingIssues.delete(issueNumber);
            issuesProcessed++;
          } catch (e) {
            logJson("process_issue", {
              action: "exception",
              issue_number: issueNumber,
              error: errMsg(e),
            });
            if (issueNumber) processingIssues.delete(issueNumber);
          }

          await sleep(10_000);
        }
      } else {
        logJson("iteration", { number: iteration, action: "no_issues_found" });
      }
    }

    const categorizedPrs = getOpenPrs();

    const totalProcessable = categorizedPrs["for-review"].length + categorizedPrs["for-landing"].length;

    if (totalProcessable === 0) {
      logJson("iteration", {
        number: iteration,
        action: "no_processable_prs",
        untagged_count: categorizedPrs["untagged"].length,
        sleep_seconds: 300,
      });
      processingPrs.clear();
      await sleep(300_000);
      continue;
    }

    const prDetails = {
      for_review: categorizedPrs["for-review"].map((pr) => ({
        number: pr["number"],
        title: toStr(pr["title"]).slice(0, 50),
      })),
      for_landing: categorizedPrs["for-landing"].map((pr) => ({
        number: pr["number"],
        title: toStr(pr["title"]).slice(0, 50),
      })),
      untagged: categorizedPrs["untagged"].map((pr) => ({
        number: pr["number"],
        title: toStr(pr["title"]).slice(0, 50),
      })),
    };

    logJson("iteration", {
      number: iteration,
      action: "prs_categorized",
      for_review: categorizedPrs["for-review"].length,
      for_landing: categorizedPrs["for-landing"].length,
      untagged: categorizedPrs["untagged"].length,
      pr_details: prDetails,
    });

    let totalProcessed = 0;
    for (const mode of ["for-review", "for-landing"] as const) {
      for (const pr of categorizedPrs[mode]) {
        const prNumber = pr["number"] as number | undefined;

        if (prNumber && processingPrs.has(prNumber)) {
          logJson("process_pr", { action: "skip_duplicate", pr_number: prNumber, mode });
          continue;
        }

        if (prNumber) processingPrs.add(prNumber);

        try {
          const success = await processPr(
            pr,
            guidelines,
            commitExamples,
            defaultBranch,
            mode,
            args.interactive,
            db,
            repoName,
          );
          if (success && prNumber) processingPrs.delete(prNumber);
          totalProcessed++;
        } catch (e) {
          logJson("process_pr", {
            action: "exception",
            pr_number: prNumber,
            mode,
            error: errMsg(e),
          });
          if (prNumber) processingPrs.delete(prNumber);
        }

        await sleep(10_000);
      }
    }

    logJson("iteration", {
      number: iteration,
      action: "complete",
      issues_processed: issuesProcessed,
      prs_processed: totalProcessed,
      sleep_seconds: 300,
    });

    await sleep(300_000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((e) => {
    logJson("fatal_error", { error: errMsg(e) });
    process.exit(1);
  });
}
