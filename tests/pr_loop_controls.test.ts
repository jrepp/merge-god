import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configuredPrLoopChildArgs, prLoopChildArgs } from "../merge-god";
import { parseCliArgs, runCommand } from "../pr-loop";

describe("PR loop controls", () => {
  test("parses bounded dry-run controls", () => {
    assert.deepEqual(
      parseCliArgs([
        "/repo",
        "--repo",
        "github.ibm.com/meridian/devtools",
        "--db",
        "/state/merge-god.db",
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
        repo: "github.ibm.com/meridian/devtools",
        dbPath: "/state/merge-god.db",
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

  test("wraps pr-loop args with repo path first when options precede it", () => {
    assert.deepEqual(
      prLoopChildArgs(["--idle-sleep-seconds", "5", "--once", "/repo", "--dry-run"]),
      ["/repo", "--idle-sleep-seconds", "5", "--once", "--dry-run"],
    );
    assert.deepEqual(
      prLoopChildArgs(["--max-iterations=3", "--between-items-sleep-seconds", "1", "/repo"]),
      ["/repo", "--max-iterations=3", "--between-items-sleep-seconds", "1"],
    );
    assert.equal(prLoopChildArgs(["--once"]), null);
  });

  test("uses the sole enabled configured repo when the path is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-god-config-"));
    const config = join(dir, "config.yaml");
    writeFileSync(config, [
      "repos:",
      "  - path: /repo/devtools",
      "    repo: https://github.ibm.com/meridian/devtools",
      "    enabled: true",
    ].join("\n"));
    assert.deepEqual(configuredPrLoopChildArgs(["--once"], config), [
      "/repo/devtools",
      "--once",
      "--repo",
      "https://github.ibm.com/meridian/devtools",
    ]);
  });

  test("runCommand allows output above Node's default sync buffer", () => {
    const size = 1200 * 1024;
    const [returncode, stdout, stderr] = runCommand(
      [process.execPath, "-e", `process.stdout.write("x".repeat(${size}))`],
      undefined,
      10,
      2 * 1024 * 1024,
    );

    assert.equal(returncode, 0);
    assert.equal(stderr, "");
    assert.equal(stdout.length, size);
  });
});
