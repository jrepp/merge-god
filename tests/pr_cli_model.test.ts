import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parsePositivePrNumber, selectCliRepository } from "../pr_cli_model";

describe("one-PR CLI repository selection", () => {
  test("prefers an explicit checkout", () => {
    assert.deepEqual(selectCliRepository({
      cwd: "/work",
      git_root: "/work/current",
      explicit_path: "../target",
      configured_repos: [{ path: "/target", name: "configured" }],
    }), {
      path: "/target",
      name: "configured",
      expected_repo: null,
      source: "explicit",
    });
  });

  test("uses the current checkout before an unrelated sole config repo", () => {
    assert.deepEqual(selectCliRepository({
      cwd: "/work/merge-god",
      git_root: "/work/merge-god",
      configured_repos: [{ path: "/work/devtools", name: "devtools", repo: "example/devtools" }],
    }), {
      path: "/work/merge-god",
      name: "merge-god",
      expected_repo: null,
      source: "cwd",
    });
  });

  test("falls back to the sole enabled config repo outside a checkout", () => {
    assert.deepEqual(selectCliRepository({
      cwd: "/work",
      git_root: null,
      configured_repos: [
        { path: "/work/disabled", enabled: false },
        { path: "/work/repo", name: "friendly", repo: "github.example/owner/repo" },
      ],
    }), {
      path: "/work/repo",
      name: "friendly",
      expected_repo: "github.example/owner/repo",
      source: "config",
    });
  });

  test("requires explicit selection when config is ambiguous", () => {
    assert.throws(() => selectCliRepository({
      cwd: "/work",
      git_root: null,
      configured_repos: [{ path: "/a" }, { path: "/b" }],
    }), /pass --repo-path/);
  });

  test("validates PR numbers", () => {
    assert.equal(parsePositivePrNumber("32"), 32);
    assert.throws(() => parsePositivePrNumber("0"), /positive integer/);
    assert.throws(() => parsePositivePrNumber("abc"), /positive integer/);
  });
});
