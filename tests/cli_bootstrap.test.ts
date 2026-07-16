import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

test("merge-god init writes config with explicit repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-god-cli-"));
  try {
    const config = join(dir, "config.yaml");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "merge_god/cli.ts", "init", "--config", config, "--repo", "."],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const written = readFileSync(config, "utf8");
    assert.match(written, /repos:/);
    assert.match(written, /merge-god/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge-god doctor reports missing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-god-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "merge_god/cli.ts", "doctor", "--config", join(dir, "missing.yaml")],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Config missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root dispatcher exposes doctor command", () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-god-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "merge-god.ts", "doctor", "--config", join(dir, "missing.yaml")],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Config missing/);
    assert.doesNotMatch(result.stderr, /Unknown command: doctor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaged compatibility entrypoint uses the canonical CLI surface", () => {
  const runHelp = (script: string) => spawnSync(
    process.execPath,
    ["--import", "tsx", script, "help"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const root = runHelp("merge-god.ts");
  const compatibility = runHelp("merge_god/cli.ts");

  assert.equal(root.status, 0, root.stderr);
  assert.equal(compatibility.status, 0, compatibility.stderr);
  assert.equal(compatibility.stdout, root.stdout);
  assert.match(root.stdout, /PRIMARY COMMANDS:/);
  assert.match(root.stdout, /merge-god pr 14/);
  assert.match(root.stdout, /merge-god new-pr feat\/my-change/);
  assert.doesNotMatch(root.stdout, /^\s+(?:test|validate)\s/m);
});

test("new-pr dry-run plans a labeled worktree without changing checkout", () => {
  const branchBefore = spawnSync("git", ["branch", "--show-current"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).stdout.trim();
  const worktree = join(tmpdir(), `merge-god-new-pr-${process.pid}`);
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "merge-god.ts", "new-pr", "test/new-pr-dry-run",
      "--worktree", worktree, "--label", "cli", "--dry-run",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(plan.workflow, "new-pr");
  assert.equal(plan.branch, "test/new-pr-dry-run");
  assert.equal(plan.mode, "for-review");
  assert.deepEqual(plan.labels, ["for-review", "cli"]);
  assert.equal(plan.draft, true);
  assert.equal(plan.worktree_path, worktree);
  assert.equal(existsSync(worktree), false);
  const branchAfter = spawnSync("git", ["branch", "--show-current"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(branchAfter, branchBefore);
});

test("new-pr rejects conflicting processing labels", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "merge-god.ts", "new-pr", "test/conflicting-label",
      "--mode", "for-review", "--label", "for-landing", "--dry-run",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicts with --mode for-review/);
});

test("new-pr prepares an optional worktree from the remote base", () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-god-new-pr-"));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const checkout = join(dir, "checkout");
  const worktree = join(dir, "feature-worktree");
  const cli = join(process.cwd(), "merge-god.ts");
  const git = (args: string[], cwd = dir) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  try {
    git(["init", "--bare", remote]);
    git(["init", "--initial-branch", "main", seed]);
    writeFileSync(join(seed, "README.md"), "# Fixture\n");
    git(["add", "README.md"], seed);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "chore: seed"], seed);
    git(["remote", "add", "origin", remote], seed);
    git(["push", "--set-upstream", "origin", "main"], seed);
    git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["clone", remote, checkout]);

    const result = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, cli, "new-pr", "feat/worktree-flow", "--worktree", worktree],
      { cwd: checkout, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Prepared feat\/worktree-flow/);
    assert.equal(git(["branch", "--show-current"], worktree), "feat/worktree-flow");
    assert.equal(git(["rev-parse", "HEAD"], worktree), git(["rev-parse", "origin/main"], checkout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard dry-run does not require executable pr-loop script", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "dashboard.ts", "config.merge-god-self-test.example.yaml", "--dry-run"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Found pr-loop\.ts/);
  assert.doesNotMatch(result.stdout + result.stderr, /chmod \+x pr-loop\.ts/);
});
