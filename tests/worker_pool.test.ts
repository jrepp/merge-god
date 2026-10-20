import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { buildPoolPlan, slugFromRemote, stripeRepos } from "../worker_pool";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-god-worker-pool-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("slugFromRemote parses https, ssh, scp-like and bare owner/repo remotes", () => {
  assert.equal(slugFromRemote("https://github.com/jrepp/iroh-tunnel"), "jrepp/iroh-tunnel");
  assert.equal(slugFromRemote("https://github.com/jrepp/llama-finance.git"), "jrepp/llama-finance");
  assert.equal(slugFromRemote("git@github.com:turbo-ogre/sdk.git"), "turbo-ogre/sdk");
  assert.equal(slugFromRemote("git@github.com:jrepp/ipe.git"), "jrepp/ipe");
  assert.equal(slugFromRemote("jrepp/hosting"), "jrepp/hosting");
  assert.equal(slugFromRemote("not-a-remote"), null);
});

test("stripeRepos round-robins items and tolerates uneven and empty splits", () => {
  const items = Array.from({ length: 14 }, (_, i) => `repo${i}`);
  const stripes = stripeRepos(items, 3);
  assert.equal(stripes.length, 3);
  assert.deepEqual(stripes.map((s) => s.length), [5, 5, 4]);
  assert.equal(stripes[0]![0], "repo0");
  assert.equal(stripes[1]![0], "repo1");
  assert.equal(stripes[2]![0], "repo2");
  assert.equal(stripes[0]![1], "repo3");

  const two = stripeRepos(["a", "b"], 5);
  assert.deepEqual(two.map((s) => s.length), [1, 1, 0, 0, 0]);
  assert.deepEqual(stripeRepos(["a"], 1), [["a"]]);
});

test("buildPoolPlan assigns enabled repos, ports, and honors --only", () => {
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `
repos:
  - path: /tmp/r/hosting
    name: hosting
    enabled: true
  - path: /tmp/r/taxes
    name: taxes
    enabled: true
    repo: jrepp/llama-finance
  - path: /tmp/r/sdk
    name: sdk
    enabled: true
    repo: turbo-ogre/sdk
  - path: /tmp/r/old
    name: old
    enabled: false
`);
  const plan = buildPoolPlan({
    configPath,
    workers: 2,
    metricsBasePort: 9200,
    resolveRemote: (repoPath) => ({ "/tmp/r/hosting": "git@github.com:jrepp/hosting.git" })[repoPath] ?? null,
  });
  assert.equal(plan.workers.length, 2);
  assert.equal(plan.workers[0]!.metricsPort, 9200);
  assert.equal(plan.workers[1]!.metricsPort, 9201);
  const names = plan.workers.flatMap((w) => w.repos.map((r) => r.name)).sort();
  assert.deepEqual(names, ["hosting", "sdk", "taxes"]);
  const taxes = plan.workers.flatMap((w) => w.repos).find((r) => r.name === "taxes");
  assert.equal(taxes?.slug, "jrepp/llama-finance");

  const onlyPlan = buildPoolPlan({ configPath, workers: 2, metricsBasePort: 9200, only: ["sdk"] });
  assert.deepEqual(onlyPlan.workers.flatMap((w) => w.repos.map((r) => r.name)), ["sdk"]);
  assert.ok(onlyPlan.skipped.some((s) => s.startsWith("hosting: excluded by --only")));
});
