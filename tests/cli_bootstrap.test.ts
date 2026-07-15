import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
  assert.doesNotMatch(root.stdout, /^\s+(?:test|validate)\s/m);
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
