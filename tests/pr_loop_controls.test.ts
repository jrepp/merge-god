import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseCliArgs } from "../pr-loop";

describe("PR loop controls", () => {
  test("parses bounded dry-run controls", () => {
    assert.deepEqual(
      parseCliArgs([
        "/repo",
        "--once",
        "--dry-run",
        "--watch-issues",
        "--idle-sleep-seconds",
        "5",
        "--sync-failure-sleep-seconds",
        "2",
        "--between-items-sleep-seconds",
        "1",
      ]),
      {
        repoPath: "/repo",
        watchIssues: true,
        interactive: false,
        once: true,
        dryRun: true,
        maxIterations: 1,
        idleSleepSeconds: 5,
        syncFailureSleepSeconds: 2,
        betweenItemsSleepSeconds: 1,
      },
    );
  });

  test("parses explicit max iterations without once", () => {
    assert.deepEqual(
      parseCliArgs(["/repo", "--max-iterations", "3"]),
      {
        repoPath: "/repo",
        watchIssues: false,
        interactive: false,
        once: false,
        dryRun: false,
        maxIterations: 3,
        idleSleepSeconds: 300,
        syncFailureSleepSeconds: 60,
        betweenItemsSleepSeconds: 10,
      },
    );
  });

  test("rejects missing repo path and invalid integer controls", () => {
    assert.throws(() => parseCliArgs([]), /repo_path is required/);
    assert.throws(() => parseCliArgs(["/repo", "--max-iterations", "0"]), /positive integer/);
  });
});
