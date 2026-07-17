#!/usr/bin/env node
/** Inspect and optionally close exact, already-landed duplicate pull requests. */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  planDuplicateResolutions,
  renderDuplicateCloseComment,
  type DuplicateBaseMatch,
  type DuplicatePrEvidence,
  type DuplicateResolution,
} from "./duplicate_pr_model";
import { PR_STATE_LABELS, prStateLabelNames } from "./pr_state";
import {
  parseRepositoryIdentity,
  repositoryIdentityMatches,
  type RepositoryIdentity,
} from "./repository_identity_model";
import { ExecutionPolicy } from "./execution_policy";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface OpenPrRecord {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: { name?: string }[];
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
}

interface AnalyzerArgs {
  repo_path: string;
  expected_repo: string | null;
  close_landed: boolean;
  json: boolean;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  opts: { input?: string; timeoutSeconds?: number; maxBuffer?: number } = {},
): CommandResult {
  return new ExecutionPolicy().runCommandSync(command, args, {
    cwd,
    input: opts.input,
    timeoutMs: (opts.timeoutSeconds ?? 120) * 1000,
    maxBuffer: opts.maxBuffer ?? 100 * 1024 * 1024,
  });
}

function parseArgsForAnalyzer(argv: string[]): AnalyzerArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      "close-landed": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const repoPath = parsed.positionals[0];
  if (!repoPath) throw new Error("repo_path is required");
  return {
    repo_path: resolve(repoPath),
    expected_repo: parsed.values.repo ?? null,
    close_landed: !!parsed.values["close-landed"],
    json: !!parsed.values.json,
  };
}

function inspectRepository(repoPath: string, expectedRepo: string | null): RepositoryIdentity {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${repoPath}`);
  }
  const remote = run("git", ["remote", "get-url", "origin"], repoPath, { timeoutSeconds: 10 });
  if (remote.status !== 0) throw new Error(`Could not read origin: ${remote.stderr.trim()}`);
  const actual = parseRepositoryIdentity(remote.stdout.trim());
  if (!actual) throw new Error(`Could not parse origin repository identity: ${remote.stdout.trim()}`);
  if (expectedRepo) {
    const expected = parseRepositoryIdentity(expectedRepo);
    if (!expected) throw new Error(`Invalid expected repository identity: ${expectedRepo}`);
    if (!repositoryIdentityMatches(actual, expected)) {
      throw new Error(
        `Checkout ${actual.host}/${actual.name_with_owner} does not match ${expectedRepo}`,
      );
    }
  }
  if (actual.host) process.env.GH_HOST = actual.host;
  return actual;
}

function listOpenPrs(repoPath: string): OpenPrRecord[] {
  const fields = "number,title,url,createdAt,labels,isDraft,headRefOid,baseRefName";
  const result = run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", fields], repoPath);
  if (result.status !== 0) throw new Error(`Could not list open PRs: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("GitHub returned a non-array PR list");
  return parsed as OpenPrRecord[];
}

function ensureHeadObjects(repoPath: string, prs: OpenPrRecord[]): void {
  const missing = prs.filter((pr) =>
    run("git", ["cat-file", "-e", `${pr.headRefOid}^{commit}`], repoPath, { timeoutSeconds: 10 }).status !== 0
  );
  if (missing.length === 0) return;
  const refs = missing.map((pr) => `refs/pull/${pr.number}/head`);
  const fetched = run("git", ["fetch", "--no-tags", "origin", ...refs], repoPath, { timeoutSeconds: 180 });
  if (fetched.status !== 0) {
    // A deleted or inaccessible head must not prevent other duplicate evidence
    // from being gathered. Individual records surface any remaining failures.
    for (const pr of missing) {
      run("git", ["fetch", "--no-tags", "origin", `refs/pull/${pr.number}/head`], repoPath, {
        timeoutSeconds: 60,
      });
    }
  }
}

export function parsePatchIdLines(output: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [patchId, commit] = line.trim().split(/\s+/, 2);
    if (patchId && commit) parsed.set(patchId, commit);
  }
  return parsed;
}

function patchIdsForRange(repoPath: string, range: string): Map<string, string> {
  const log = run("git", ["log", "--no-merges", "-p", range], repoPath, {
    timeoutSeconds: 120,
    maxBuffer: 200 * 1024 * 1024,
  });
  if (log.status !== 0) throw new Error(log.stderr.trim() || `git log failed for ${range}`);
  const patchIds = run("git", ["patch-id", "--stable"], repoPath, {
    input: log.stdout,
    timeoutSeconds: 120,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (patchIds.status !== 0) throw new Error(patchIds.stderr.trim() || "git patch-id failed");
  return parsePatchIdLines(patchIds.stdout);
}

function aggregatePatchId(repoPath: string, mergeBase: string, headOid: string): string {
  const diff = run("git", ["diff", "--binary", mergeBase, headOid], repoPath, {
    timeoutSeconds: 120,
    maxBuffer: 200 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error(diff.stderr.trim() || "git diff failed");
  if (!diff.stdout.trim()) return "empty";
  const patch = run("git", ["patch-id", "--stable"], repoPath, { input: diff.stdout });
  if (patch.status !== 0) throw new Error(patch.stderr.trim() || "git patch-id failed");
  const [patchId] = patch.stdout.trim().split(/\s+/, 1);
  if (!patchId) throw new Error("No stable aggregate patch ID was produced");
  return patchId;
}

function associatedMergedPr(
  repoPath: string,
  identity: RepositoryIdentity,
  commit: string,
  cache: Map<string, DuplicateBaseMatch>,
): DuplicateBaseMatch {
  const cached = cache.get(commit);
  if (cached) return cached;
  const result = run(
    "gh",
    ["api", `repos/${identity.name_with_owner}/commits/${commit}/pulls`],
    repoPath,
    { timeoutSeconds: 30 },
  );
  if (result.status === 0) {
    try {
      const prs = JSON.parse(result.stdout) as { number?: number; html_url?: string; merged_at?: string | null }[];
      const merged = prs.find((pr) => pr.merged_at && typeof pr.number === "number");
      if (merged) {
        const match = { commit, pr_number: merged.number!, pr_url: merged.html_url ?? null };
        cache.set(commit, match);
        return match;
      }
    } catch {
      // Commit containment remains valid even when provenance lookup is absent.
    }
  }
  const match = { commit, pr_number: null, pr_url: null };
  cache.set(commit, match);
  return match;
}

function collectEvidence(
  repoPath: string,
  identity: RepositoryIdentity,
  prs: OpenPrRecord[],
): DuplicatePrEvidence[] {
  ensureHeadObjects(repoPath, prs);
  const basePatchCache = new Map<string, Map<string, string>>();
  const associatedPrCache = new Map<string, DuplicateBaseMatch>();

  return prs.map((pr) => {
    const labels = (pr.labels ?? [])
      .map((label) => label.name?.trim() ?? "")
      .filter(Boolean);
    const common = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      created_at: pr.createdAt,
      labels,
      is_draft: pr.isDraft,
      head_oid: pr.headRefOid,
      base_ref: pr.baseRefName,
    };
    try {
      const object = run("git", ["cat-file", "-e", `${pr.headRefOid}^{commit}`], repoPath, { timeoutSeconds: 10 });
      if (object.status !== 0) throw new Error("PR head commit is unavailable after fetch");
      const baseRef = `origin/${pr.baseRefName}`;
      const mergeBaseResult = run("git", ["merge-base", baseRef, pr.headRefOid], repoPath, { timeoutSeconds: 30 });
      if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
        throw new Error(`Could not find a merge base with ${baseRef}`);
      }
      const mergeBase = mergeBaseResult.stdout.trim();
      const patchId = aggregatePatchId(repoPath, mergeBase, pr.headRefOid);
      const changedFilesResult = run(
        "git",
        ["diff", "--name-only", "--diff-filter=ACDMRTUXB", mergeBase, pr.headRefOid],
        repoPath,
        { timeoutSeconds: 60 },
      );
      if (changedFilesResult.status !== 0) {
        throw new Error(changedFilesResult.stderr.trim() || "Could not collect changed files");
      }
      const changedFiles = changedFilesResult.stdout.split("\n").map((file) => file.trim()).filter(Boolean);
      const prPatches = patchIdsForRange(repoPath, `${mergeBase}..${pr.headRefOid}`);
      const cacheKey = `${mergeBase}..${baseRef}`;
      let basePatches = basePatchCache.get(cacheKey);
      if (!basePatches) {
        basePatches = patchIdsForRange(repoPath, cacheKey);
        basePatchCache.set(cacheKey, basePatches);
      }
      const matchedCommits = [...prPatches.keys()]
        .map((id) => basePatches!.get(id) ?? null)
        .filter((commit): commit is string => commit !== null);
      const fullyContained = prPatches.size === 0
        ? patchId === "empty"
        : matchedCommits.length === prPatches.size;
      const baseMatches = fullyContained
        ? matchedCommits.length > 0
          ? matchedCommits.map((commit) => associatedMergedPr(repoPath, identity, commit, associatedPrCache))
          : [{
              commit: run("git", ["rev-parse", baseRef], repoPath).stdout.trim(),
              pr_number: null,
              pr_url: null,
            }]
        : [];
      return { ...common, patch_id: patchId, changed_files: changedFiles, base_matches: baseMatches, error: null };
    } catch (error) {
      return {
        ...common,
        patch_id: null,
        changed_files: [],
        base_matches: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function ensureCompleteLabel(repoPath: string): void {
  const definition = PR_STATE_LABELS.complete;
  const create = run(
    "gh",
    ["label", "create", definition.name, "--color", definition.color, "--description", definition.description],
    repoPath,
    { timeoutSeconds: 30 },
  );
  if (create.status !== 0 && !/already exists|name already exists/i.test(create.stderr)) {
    throw new Error(`Could not ensure ${definition.name}: ${create.stderr.trim()}`);
  }
}

function markComplete(repoPath: string, prNumber: number): void {
  const stale = prStateLabelNames().filter((label) => label !== PR_STATE_LABELS.complete.name);
  for (const label of stale) {
    run("gh", ["pr", "edit", String(prNumber), "--remove-label", label], repoPath, { timeoutSeconds: 30 });
  }
  const add = run(
    "gh",
    ["pr", "edit", String(prNumber), "--add-label", PR_STATE_LABELS.complete.name],
    repoPath,
    { timeoutSeconds: 30 },
  );
  if (add.status !== 0) throw new Error(`Could not label PR #${prNumber} complete: ${add.stderr.trim()}`);
}

function removeComplete(repoPath: string, prNumber: number): void {
  run(
    "gh",
    ["pr", "edit", String(prNumber), "--remove-label", PR_STATE_LABELS.complete.name],
    repoPath,
    { timeoutSeconds: 30 },
  );
}

function closeLandedDuplicates(repoPath: string, resolutions: DuplicateResolution[]): number[] {
  const closed: number[] = [];
  const failures: string[] = [];
  const closable = resolutions.filter((item) => item.safe_to_close);
  if (closable.length > 0) ensureCompleteLabel(repoPath);
  for (const resolution of closable) {
    try {
      markComplete(repoPath, resolution.pr_number);
      const close = run(
        "gh",
        ["pr", "close", String(resolution.pr_number), "--comment", renderDuplicateCloseComment(resolution)],
        repoPath,
        { timeoutSeconds: 60 },
      );
      if (close.status !== 0) {
        removeComplete(repoPath, resolution.pr_number);
        throw new Error(close.stderr.trim() || "GitHub did not close the PR");
      }
      closed.push(resolution.pr_number);
    } catch (error) {
      failures.push(`PR #${resolution.pr_number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Duplicate closure failed:\n${failures.join("\n")}`);
  }
  return closed;
}

function printHuman(
  identity: RepositoryIdentity,
  resolutions: DuplicateResolution[],
  closed: number[],
): void {
  console.log(`Duplicate analysis for ${identity.host}/${identity.name_with_owner}`);
  if (resolutions.length === 0) {
    console.log("No open PRs carry the duplicate label.");
    return;
  }
  for (const resolution of resolutions) {
    const canonical = resolution.canonical_pr_number === null ? "none" : `#${resolution.canonical_pr_number}`;
    const action = resolution.safe_to_close ? "safe to close" : "keep open";
    console.log(
      `#${resolution.pr_number}  ${resolution.disposition}  canonical=${canonical}  ${action}\n` +
      `  ${resolution.reason}`,
    );
  }
  if (closed.length > 0) console.log(`Closed: ${closed.map((number) => `#${number}`).join(", ")}`);
  else if (resolutions.some((item) => item.safe_to_close)) {
    console.log("No changes made. Re-run with --close-landed to close only proven already-landed duplicates.");
  } else {
    console.log("No PR met the automatic-close evidence threshold.");
  }
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const args = parseArgsForAnalyzer(argv);
    const identity = inspectRepository(args.repo_path, args.expected_repo);
    const refresh = run("git", ["fetch", "--no-tags", "origin"], args.repo_path, { timeoutSeconds: 180 });
    if (refresh.status !== 0) throw new Error(`Could not refresh origin: ${refresh.stderr.trim()}`);
    const prs = listOpenPrs(args.repo_path);
    const evidence = collectEvidence(args.repo_path, identity, prs);
    const resolutions = planDuplicateResolutions(evidence);
    const closed = args.close_landed ? closeLandedDuplicates(args.repo_path, resolutions) : [];
    if (args.json) {
      console.log(JSON.stringify({ repository: `${identity.host}/${identity.name_with_owner}`, resolutions, closed }, null, 2));
    } else {
      printHuman(identity, resolutions, closed);
    }
    return resolutions.some((resolution) => resolution.disposition === "analysis_failed") ? 1 : 0;
  } catch (error) {
    console.error(`Duplicate analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
