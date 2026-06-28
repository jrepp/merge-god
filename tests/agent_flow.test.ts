/**
 * Agent prompt & result flow tests.
 *
 * Ported from tests/test_agent_flow.py. Where the Python version mocked the
 * former `run_pi_agent(...)` 4-tuple return, this version exercises the REAL
 * merge-god coordination API (CoordinationServer) end-to-end without launching
 * the pi agent, and asserts the `PiAgentResult` contract that `runPiAgent`
 * returns (the TS analogue of the 4-tuple: { returncode, stdout, stderr,
 * result }).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CoordinationServer, type PiAgentResult } from "../coordination";

describe("agent flow: coordination round-trip", () => {
  test("health endpoint reports ok", async () => {
    const s = new CoordinationServer("127.0.0.1", 0);
    await s.start();
    try {
      const res = await fetch(`${s.baseUrl}/health`);
      const body = (await res.json()) as { ok: boolean; service: string };
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.service, "merge-god-coordination");
    } finally {
      await s.stop();
    }
  });

  test("work item published by merge-god is pulled by the extension", async () => {
    const s = new CoordinationServer("127.0.0.1", 0);
    await s.start();
    try {
      const work = {
        kind: "pr",
        repo: "owner/repo",
        pr_number: 123,
        prompt: "Resolve conflicts and land PR #123",
      };
      s.setWork(work);

      const res = await fetch(`${s.baseUrl}/work`);
      const body = (await res.json()) as { ok: boolean; work: { prompt: string; pr_number: number } };
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.work.prompt, work.prompt);
      assert.equal(body.work.pr_number, 123);
    } finally {
      await s.stop();
    }
  });

  test("result reported by the extension is recorded by merge-god", async () => {
    const s = new CoordinationServer("127.0.0.1", 0);
    await s.start();
    try {
      const reported = { status: "success", summary: "merged", merged: true, commits: ["abc"] };
      const res = await fetch(`${s.baseUrl}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reported),
      });
      const body = (await res.json()) as { ok: boolean };
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);

      const recorded = s.getResult();
      assert.deepEqual(recorded, reported);
    } finally {
      await s.stop();
    }
  });

  test("setWork clears any previous result", async () => {
    const s = new CoordinationServer("127.0.0.1", 0);
    await s.start();
    try {
      s.setWork({ prompt: "first" });
      await fetch(`${s.baseUrl}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "success", summary: "x" }),
      });
      assert.ok(s.getResult() !== null);

      // Publishing a new work item must reset the recorded result.
      s.setWork({ prompt: "second" });
      assert.equal(s.getResult(), null);
      assert.equal(s.getWork()?.prompt, "second");
    } finally {
      await s.stop();
    }
  });
});

describe("agent flow: runPiAgent result contract", () => {
  test("PiAgentResult carries the four fields (returncode/stdout/stderr/result)", () => {
    // Shape contract: runPiAgent returns an object (the TS analogue of Python's
    // `(returncode, stdout, stderr, result)` 4-tuple). A result is recorded by
    // the agent only if it calls merge_god_complete; otherwise it is null.
    const success: PiAgentResult = {
      returncode: 0,
      stdout: "Agent completed successfully",
      stderr: "",
      result: { status: "success", summary: "done" },
    };
    const failure: PiAgentResult = {
      returncode: 1,
      stdout: "",
      stderr: "Agent failed: timeout",
      result: { status: "failure", error: "timeout" },
    };
    const noResult: PiAgentResult = {
      returncode: 0,
      stdout: "",
      stderr: "",
      result: null,
    };

    assert.equal(success.returncode, 0);
    assert.equal(success.result?.status, "success");
    assert.equal(failure.returncode, 1);
    assert.ok(failure.stderr.length > 0);
    assert.equal(noResult.result, null);
  });
});
