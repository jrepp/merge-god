#!/usr/bin/env node
/**
 * Test script to generate and display the prompt for a specific PR without running pi.
 *
 * Ported from test-prompt.py. Usage: ./test-prompt.ts <repo_path> <pr_number>
 */

import { chdir } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  validateRepository,
  getPrGuidelines,
  getCommitHistoryExamples,
  gatherPrContext,
  buildPrPrompt,
} from "./pr-loop";

function runCommand(
  cmd: string[],
): { returncode: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd[0] ?? "", cmd.slice(1), { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return { returncode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function main(): Promise<void> {
  const repoPathArg = process.argv[2];
  const prArg = process.argv[3];

  if (repoPathArg === undefined || prArg === undefined) {
    console.error("Usage: ./test-prompt.ts <repo_path> <pr_number>");
    console.error("\nExamples:");
    console.error("  ./test-prompt.ts /path/to/repo 123");
    console.error("  ./test-prompt.ts . 456");
    process.exit(1);
  }

  const repoPath = resolve(repoPathArg);

  if (!validateRepository(repoPath)) {
    process.exit(1);
  }

  chdir(repoPath);

  if (!/^[+-]?\d+$/.test(prArg.trim())) {
    console.error(`Error: '${prArg}' is not a valid PR number`);
    process.exit(1);
  }
  const prNumber = Number.parseInt(prArg, 10);

  console.error(`Gathering context for PR #${prNumber}...\n`);

  const { returncode, stdout, stderr } = runCommand([
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,headRefName,baseRefName,url",
  ]);

  if (returncode !== 0) {
    console.error(`Error fetching PR #${prNumber}: ${stderr}`);
    process.exit(1);
  }

  const prInfo = JSON.parse(stdout) as Record<string, unknown>;

  const title = prInfo["title"] as string;
  const headBranch = prInfo["headRefName"] as string;
  const baseBranch = (prInfo["baseRefName"] as string | undefined) ?? "main";
  const url = prInfo["url"] as string;

  const guidelines = getPrGuidelines();
  const commitExamples = guidelines ? "" : getCommitHistoryExamples(baseBranch);

  const [prDetails, prContext] = await gatherPrContext(prNumber, headBranch, baseBranch, url);

  const prompt = buildPrPrompt(prDetails, prContext, guidelines, commitExamples);

  const comments = (prContext["comments"] as unknown[] | undefined) ?? [];
  const reviewComments = (prContext["review_comments"] as unknown[] | undefined) ?? [];
  const commits = (prContext["commits"] as unknown[] | undefined) ?? [];
  const files = (prContext["files"] as unknown[] | undefined) ?? [];
  const conflicts = (prContext["conflicts"] as Record<string, unknown> | undefined) ?? {};
  const ciStatus = (prContext["ci_status"] as Record<string, unknown> | undefined) ?? {};

  const sep = "=".repeat(80);
  console.error("\n" + sep);
  console.error("PROMPT GENERATION SUMMARY");
  console.error(sep);
  console.error(`PR: #${prNumber} - ${title}`);
  console.error(`Branch: ${headBranch} → ${baseBranch}`);
  console.error(`Prompt size: ${prompt.length} characters`);
  console.error(`Comments: ${comments.length}`);
  console.error(`Review comments: ${reviewComments.length}`);
  console.error(`Commits: ${commits.length}`);
  console.error(`Files changed: ${files.length}`);
  console.error(`Has conflicts: ${conflicts["has_conflicts"] ?? false}`);
  console.error(`CI checks: ${ciStatus["total_checks"] ?? 0}`);
  console.error(`Failed checks: ${ciStatus["failed"] ?? 0}`);
  console.error(sep);
  console.error("\nGenerated prompt (stdout):\n");

  console.log(prompt);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
