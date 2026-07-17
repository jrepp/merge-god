#!/usr/bin/env node
/**
 * Test script to generate and display the prompt for a specific PR without running pi.
 *
 * Ported from test-prompt.py. Usage: ./test-prompt.ts <repo_path> <pr_number>
 */

import { chdir } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeCiStatusCounts } from "./ci_status_model";
import { hasActiveMergeConflicts } from "./conflict_model";
import { prContextCiStatus, prContextCommits, prContextConflicts } from "./pr_context_access_model";
import { prContextTelemetrySummary } from "./pr_context_log_model";
import { prDetailsBaseBranch, prDetailsHeadBranch, prDetailsTitle, prDetailsUrl } from "./pr_details_access_model";
import {
  validateRepository,
  getPrGuidelines,
  getCommitHistoryExamples,
  gatherPrContext,
  buildPrPrompt,
} from "./pr-loop";
import { initializeTelemetry, recordPromptRendered, shutdownTelemetry } from "./telemetry";
import { ExecutionPolicy } from "./execution_policy";

function runCommand(
  cmd: string[],
): { returncode: number; stdout: string; stderr: string } {
  const result = new ExecutionPolicy().runCommandSync(cmd[0] ?? "", cmd.slice(1), {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { returncode: result.status, stdout: result.stdout, stderr: result.stderr };
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

  const title = prDetailsTitle(prInfo);
  const headBranch = prDetailsHeadBranch(prInfo);
  const baseBranch = prDetailsBaseBranch(prInfo);
  const url = prDetailsUrl(prInfo);

  const guidelines = getPrGuidelines();
  const commitExamples = guidelines ? "" : getCommitHistoryExamples(baseBranch);

  const [prDetails, prContext] = await gatherPrContext(prNumber, headBranch, baseBranch, url);

  const prompt = buildPrPrompt(prDetails, prContext, guidelines, commitExamples);
  recordPromptRendered("test_prompt.pr", prompt, {
    "merge_god.pr_number": prNumber,
  });

  const contextSummary = prContextTelemetrySummary(prContext);
  const commits = prContextCommits(prContext);
  const hasConflicts = hasActiveMergeConflicts(prContextConflicts(prContext));
  const ciCounts = normalizeCiStatusCounts(prContextCiStatus(prContext));

  const sep = "=".repeat(80);
  console.error("\n" + sep);
  console.error("PROMPT GENERATION SUMMARY");
  console.error(sep);
  console.error(`PR: #${prNumber} - ${title}`);
  console.error(`Branch: ${headBranch} → ${baseBranch}`);
  console.error(`Prompt size: ${prompt.length} characters`);
  console.error(`Comments: ${contextSummary.comment_count}`);
  console.error(`Review comments: ${contextSummary.review_comment_count}`);
  console.error(`Commits: ${commits.length}`);
  console.error(`Files changed: ${contextSummary.file_count}`);
  console.error(`Has conflicts: ${hasConflicts}`);
  console.error(`CI checks: ${ciCounts.total}`);
  console.error(`Failed checks: ${ciCounts.failed}`);
  console.error(sep);
  console.error("\nGenerated prompt (stdout):\n");

  console.log(prompt);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  initializeTelemetry();
  main()
    .then(() => {
      void shutdownTelemetry().finally(() => process.exit(0));
    })
    .catch((e) => {
      console.error(e);
      void shutdownTelemetry().finally(() => process.exit(1));
    });
}
