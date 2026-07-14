import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { findExtension, runPiAgent } from "../coordination";
import { GitOps } from "../git_ops";
import { agentAnnotationLabelsForCompletion } from "../pr-loop";

function git(repoPath: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initializeRepo(repoPath: string): void {
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.email", "merge-god@example.test"]);
  git(repoPath, ["config", "user.name", "merge-god test"]);
  writeFileSync(path.join(repoPath, "state.txt"), "base\n");
  git(repoPath, ["add", "state.txt"]);
  git(repoPath, ["commit", "-m", "base"]);
}

describe("orchestration completion regressions", () => {
  test("normalizes the agent exit after reported completion", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-completion-"));
    const repoPath = path.join(tempDir, "repo");
    const binPath = path.join(tempDir, "bin");
    const runnerPath = path.join(tempDir, "fake-pi.mjs");
    mkdirSync(repoPath);
    mkdirSync(binPath);

    try {
      initializeRepo(repoPath);
      writeFileSync(runnerPath, `
await fetch(process.env.MERGE_GOD_API + "/result", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "success", summary: "done" }),
});
process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`);
      const piPath = path.join(binPath, "pi");
      writeFileSync(piPath, `#!/bin/sh\nexec node ${JSON.stringify(runnerPath)} "$@"\n`);
      chmodSync(piPath, 0o755);

      const startedAt = Date.now();
      const result = await runPiAgent(
        { kind: "trajectory_activity", repo_path: repoPath, prompt: "finish" },
        repoPath,
        {
          completionGraceMs: 0,
          extensionPath: findExtension(),
          extraEnv: { PATH: `${binPath}${path.delimiter}${process.env.PATH ?? ""}` },
          timeout: 10,
        },
      );

      assert.equal(result.returncode, 0, result.stderr || result.stdout);
      assert.equal(result.result?.["status"], "success");
      assert.ok(Date.now() - startedAt < 3_000, "completed agent should stop promptly");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates detached agent worktrees from an explicit ref", () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), "mg-agent-ref-"));
    let worktree: ReturnType<GitOps["createDetachedWorktree"]> | null = null;

    try {
      initializeRepo(repoPath);
      git(repoPath, ["branch", "pr-head"]);
      git(repoPath, ["checkout", "pr-head"]);
      writeFileSync(path.join(repoPath, "state.txt"), "pull request\n");
      git(repoPath, ["commit", "-am", "pr head"]);
      git(repoPath, ["checkout", "-"]);

      worktree = new GitOps(repoPath).createDetachedWorktree("pr-head");
      assert.equal(readFileSync(path.join(worktree.path, "state.txt"), "utf8"), "pull request\n");
    } finally {
      worktree?.cleanup();
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("does not infer failure labels from a successful narrative", () => {
    assert.deepEqual(
      agentAnnotationLabelsForCompletion({
        status: "success",
        summary: "Local validation passed, but completion was not verified.",
        annotation_labels: ["low-risk"],
      }),
      ["low-risk"],
    );
  });
});
