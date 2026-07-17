import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  commandEffect,
  dryRunFromEnv,
  ExecutionPolicy,
  type OperationTrace,
  type ProcessExecutor,
} from "../execution_policy";

function fakeExecutor(onRun: () => void): ProcessExecutor {
  return {
    run: async () => {
      onRun();
      return { status: 0, stdout: "clean", stderr: "" };
    },
    runSync: () => {
      onRun();
      return { status: 0, stdout: "clean", stderr: "" };
    },
  };
}

describe("execution policy", () => {
  test("classifies common git and GitHub reads and mutations", () => {
    assert.equal(commandEffect("git", ["status", "--short"]), "read");
    assert.equal(commandEffect("git", ["fetch", "--all"]), "mutation");
    assert.equal(commandEffect("git", ["push", "origin", "main"]), "mutation");
    assert.equal(commandEffect("gh", ["pr", "view", "12"]), "read");
    assert.equal(commandEffect("gh", ["pr", "comment", "12", "--body", "ok"]), "mutation");
    assert.equal(commandEffect("gh", ["api", "repos/o/r/pulls/12"]), "read");
    assert.equal(commandEffect("gh", ["api", "repos/o/r/pulls/12", "--method", "PATCH"]), "mutation");
  });

  test("executes reads and projects mutations in dry-run", () => {
    const traces: OperationTrace[] = [];
    let calls = 0;
    const policy = new ExecutionPolicy({
      dryRun: true,
      observer: (trace) => traces.push(trace),
      processExecutor: fakeExecutor(() => calls++),
    });

    const read = policy.runCommandSync("git", ["status", "--short"], { cwd: "/repo" });
    const mutation = policy.runCommandSync("git", ["push", "origin", "main"], { cwd: "/repo" });

    assert.equal(calls, 1);
    assert.equal(read.stdout, "clean");
    assert.deepEqual(mutation, { status: 0, stdout: "", stderr: "" });
    assert.equal(traces.some((trace) => trace.outcome === "executed" && trace.effect === "read"), true);
    assert.equal(traces.some((trace) => trace.outcome === "would_execute" && trace.effect === "mutation"), true);

    policy.runCommandSync("gh", ["pr", "comment", "12", "--body", "private detail"], { cwd: "/repo" });
    const commentTrace = traces.find((trace) => trace.name.startsWith("gh pr comment"));
    assert.match(commentTrace?.name ?? "", /<redacted:14 chars>/);
    assert.doesNotMatch(JSON.stringify(commentTrace), /private detail/);
  });

  test("does not add operation log noise in live mode by default", () => {
    const traces: OperationTrace[] = [];
    const policy = new ExecutionPolicy({
      dryRun: false,
      observer: (trace) => traces.push(trace),
      processExecutor: fakeExecutor(() => undefined),
    });
    policy.runCommandSync("git", ["status"], { cwd: "/repo" });
    assert.deepEqual(traces, []);
  });

  test("reads the process-wide dry-run environment", () => {
    assert.equal(dryRunFromEnv({ MERGE_GOD_DRY_RUN: "yes" }), true);
    assert.equal(dryRunFromEnv({ MERGE_GOD_DRY_RUN: "0" }), false);
  });
});
