#!/usr/bin/env node
/** Prepare a branch (optionally in a worktree) and open a correctly labeled PR. */

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { dryRunFromEnv, ExecutionPolicy, type CommandExecutionResult } from "./execution_policy";

type CommandResult = CommandExecutionResult;

interface ExistingPr {
  url: string;
  isDraft: boolean;
  labels: { name: string }[];
}

function run(command: string, args: string[], cwd: string, inherit = false): CommandResult {
  return new ExecutionPolicy().runCommandSync(command, args, {
    cwd,
    stdio: inherit ? "inherit" : "pipe",
  });
}

function requireSuccess(result: CommandResult, description: string): string {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${description}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function git(args: string[], cwd: string): string {
  return requireSuccess(run("git", args, cwd), `git ${args[0] ?? "command"} failed`);
}

function gitRoot(cwd: string): string {
  return resolve(git(["rev-parse", "--show-toplevel"], cwd));
}

function currentBranch(cwd: string): string {
  return git(["branch", "--show-current"], cwd);
}

function hasLocalBranch(repoPath: string, branch: string): boolean {
  return run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath).status === 0;
}

function defaultBase(repoPath: string): string {
  const symbolic = run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoPath);
  if (symbolic.status === 0 && symbolic.stdout.trim().startsWith("origin/")) {
    return symbolic.stdout.trim().slice("origin/".length);
  }
  const github = run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], repoPath);
  if (github.status === 0 && github.stdout.trim()) return github.stdout.trim();
  return "main";
}

function validateBranch(branch: string, repoPath: string): void {
  if (!branch.trim()) throw new Error("Branch name is required: merge-god new-pr <branch>");
  requireSuccess(run("git", ["check-ref-format", "--branch", branch], repoPath), `Invalid branch name: ${branch}`);
}

function uncommittedChanges(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd).length > 0;
}

function existingPr(cwd: string, branch: string): ExistingPr | null {
  const result = run("gh", ["pr", "view", branch, "--json", "url,isDraft,labels"], cwd);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Partial<ExistingPr>;
    if (typeof parsed.url !== "string") return null;
    return {
      url: parsed.url,
      isDraft: parsed.isDraft === true,
      labels: Array.isArray(parsed.labels) ? parsed.labels.filter(
        (label): label is { name: string } => typeof label?.name === "string",
      ) : [],
    };
  } catch {
    return null;
  }
}

function defaultBody(title: string): string {
  return `## Summary\n\n- ${title}\n\n## Validation\n\n- TODO before marking ready\n`;
}

function logPrepared(branch: string, cwd: string, base: string): void {
  console.error(`Prepared ${branch} at ${cwd}.`);
  console.error(`Commit the change, then rerun: merge-god new-pr ${branch} --base ${base}`);
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        base: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        label: { type: "string", multiple: true },
        mode: { type: "string", default: "for-review" },
        worktree: { type: "string" },
        ready: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 1) {
      throw new Error("usage: merge-god new-pr <branch> [--worktree PATH] [--title TITLE] [--ready]");
    }

    const branch = parsed.positionals[0]!;
    const repoPath = gitRoot(cwd);
    validateBranch(branch, repoPath);
    const base = parsed.values.base ?? defaultBase(repoPath);
    validateBranch(base, repoPath);
    const mode = parsed.values.mode ?? "for-review";
    if (mode !== "for-review" && mode !== "for-landing") throw new Error(`Invalid mode: ${mode}`);
    const extraLabels = parsed.values.label ?? [];
    const conflictingMode = extraLabels.find(
      (label) => (label === "for-review" || label === "for-landing") && label !== mode,
    );
    if (conflictingMode) throw new Error(`Label ${conflictingMode} conflicts with --mode ${mode}`);
    const labels = [...new Set([mode, ...extraLabels])];
    const worktreePath = parsed.values.worktree ? resolve(cwd, parsed.values.worktree) : null;
    const localBranch = hasLocalBranch(repoPath, branch);
    const plan = {
      workflow: "new-pr",
      repository: basename(repoPath),
      repo_path: repoPath,
      branch,
      base,
      mode,
      labels,
      draft: !parsed.values.ready,
      worktree_path: worktreePath,
      branch_exists: localBranch,
      actions: [
        `fetch origin ${base}`,
        worktreePath
          ? `prepare branch in worktree ${worktreePath}`
          : `prepare branch in current checkout ${repoPath}`,
        "push branch without rewriting history once it has commits",
        `open or update PR with ${mode}`,
      ],
    };
    if (parsed.values["dry-run"] || dryRunFromEnv()) {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }

    git(["fetch", "origin", base], repoPath);
    let branchPath = repoPath;
    if (worktreePath) {
      if (existsSync(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`);
      if (localBranch && currentBranch(repoPath) === branch) {
        throw new Error(`Branch ${branch} is already checked out; switch away before adding its worktree`);
      }
      const args = localBranch
        ? ["worktree", "add", worktreePath, branch]
        : ["worktree", "add", "-b", branch, worktreePath, `origin/${base}`];
      git(args, repoPath);
      branchPath = worktreePath;
    } else if (currentBranch(repoPath) !== branch) {
      if (uncommittedChanges(repoPath)) {
        throw new Error("Current checkout has uncommitted changes; commit or stash them before switching branches");
      }
      git(localBranch ? ["switch", branch] : ["switch", "-c", branch, `origin/${base}`], repoPath);
    }

    const commitCountText = git(["rev-list", "--count", `origin/${base}..HEAD`], branchPath);
    const commitCount = Number(commitCountText);
    if (!Number.isInteger(commitCount) || commitCount <= 0) {
      logPrepared(branch, branchPath, base);
      return 0;
    }
    if (uncommittedChanges(branchPath)) {
      console.error("Warning: uncommitted changes are not included in the PR.");
    }

    git(["push", "--set-upstream", "origin", branch], branchPath);
    const found = existingPr(branchPath, branch);
    if (found) {
      const currentLabels = new Set(found.labels.map((label) => label.name));
      const otherMode = mode === "for-review" ? "for-landing" : "for-review";
      const editArgs = ["pr", "edit", found.url];
      for (const label of labels) {
        if (!currentLabels.has(label)) editArgs.push("--add-label", label);
      }
      if (currentLabels.has(otherMode)) editArgs.push("--remove-label", otherMode);
      if (editArgs.length > 3) requireSuccess(run("gh", editArgs, branchPath), "Could not update PR labels");
      if (parsed.values.ready && found.isDraft) {
        requireSuccess(run("gh", ["pr", "ready", found.url], branchPath), "Could not mark PR ready");
      }
      console.log(found.url);
      return 0;
    }

    const title = parsed.values.title || git(["log", "-1", "--format=%s", `origin/${base}..HEAD`], branchPath);
    const createArgs = [
      "pr", "create",
      "--head", branch,
      "--base", base,
      "--title", title,
      "--body", parsed.values.body ?? defaultBody(title),
    ];
    if (!parsed.values.ready) createArgs.push("--draft");
    for (const label of labels) createArgs.push("--label", label);
    const url = requireSuccess(run("gh", createArgs, branchPath), "Could not create PR");
    console.log(url);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
