import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppStore } from "../app_store";
import { main } from "../pr_workflow_cli";

function temporaryCheckout(): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), "mg-pr-cli-"));
  execFileSync("git", ["init", "--quiet", repoPath]);
  execFileSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  return repoPath;
}

describe("one-PR workflow CLI", () => {
  test("plans one-PR processing from the current checkout", () => {
    const repoPath = temporaryCheckout();
    try {
      assert.equal(main(["pr", "32", "--repo", "test-repo", "--dry-run"], repoPath), 0);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("finds resumable work without a run ID", () => {
    const repoPath = temporaryCheckout();
    const dbPath = path.join(repoPath, "state.db");
    const store = new AppStore(dbPath);
    try {
      store.createCompatibilityTrajectoryForPr({
        repo_name: "test-repo",
        repo_path: repoPath,
        pr_number: 14,
        mode: "for-landing",
        labels: ["for-landing"],
      });
      store.close();
      assert.equal(main([
        "resume",
        "--repo", "test-repo",
        "--db", dbPath,
        "--dry-run",
      ], repoPath), 0);
    } finally {
      try {
        store.close();
      } catch {
        // Already closed after arranging the resumable trajectory.
      }
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("fails clearly when there is nothing to resume", () => {
    const repoPath = temporaryCheckout();
    try {
      assert.equal(main(["resume", "--repo", "test-repo", "--dry-run"], repoPath), 1);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
