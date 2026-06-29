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

  test("trajectory bridge exposes state and records events", async () => {
    const events: unknown[] = [];
      const s = new CoordinationServer("127.0.0.1", 0, {
      getState() {
        return { run: { run_id: "run-1", status: "executing" }, events };
      },
      appendEvent(input) {
        events.push(input);
        return { event_id: `event-${events.length}` };
      },
      heartbeat(input) {
        return { ok: true, phase: input["phase"] ?? null };
      },
      proposeNext(input) {
        return { accepted: input.next_action === "continue", next_action: input.next_action };
      },
      createChildActivity(input) {
        return { accepted: input.type === "ci_fix", child_activity_id: "child-1" };
      },
    });
    await s.start();
    try {
      const stateRes = await fetch(`${s.baseUrl}/trajectory`);
      const stateBody = (await stateRes.json()) as {
        ok: boolean;
        trajectory: { run: { run_id: string }; events: unknown[] };
      };
      assert.equal(stateRes.status, 200);
      assert.equal(stateBody.ok, true);
      assert.equal(stateBody.trajectory.run.run_id, "run-1");

      const eventRes = await fetch(`${s.baseUrl}/trajectory/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_type: "decision.made",
          actor: "test",
          payload: { summary: "chose next activity" },
        }),
      });
      const eventBody = (await eventRes.json()) as { ok: boolean; event: { event_id: string } };
      assert.equal(eventRes.status, 200);
      assert.equal(eventBody.ok, true);
      assert.equal(eventBody.event.event_id, "event-1");
      assert.equal(events.length, 1);

      const heartbeatRes = await fetch(`${s.baseUrl}/trajectory/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "validation" }),
      });
      const heartbeatBody = (await heartbeatRes.json()) as {
        ok: boolean;
        heartbeat: { phase: string };
      };
      assert.equal(heartbeatRes.status, 200);
      assert.equal(heartbeatBody.heartbeat.phase, "validation");

      const proposeRes = await fetch(`${s.baseUrl}/trajectory/propose-next`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ next_action: "continue", rationale: "test" }),
      });
      const proposeBody = (await proposeRes.json()) as {
        ok: boolean;
        proposal: { accepted: boolean };
      };
      assert.equal(proposeRes.status, 200);
      assert.equal(proposeBody.proposal.accepted, true);

      const childRes = await fetch(`${s.baseUrl}/trajectory/child-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "ci_fix", summary: "fix failing check" }),
      });
      const childBody = (await childRes.json()) as {
        ok: boolean;
        activity: { accepted: boolean; child_activity_id: string };
      };
      assert.equal(childRes.status, 200);
      assert.equal(childBody.activity.accepted, true);
      assert.equal(childBody.activity.child_activity_id, "child-1");
    } finally {
      await s.stop();
    }
  });

  test("trajectory endpoint can expose work item trajectory snapshot without a bridge", async () => {
    const s = new CoordinationServer("127.0.0.1", 0);
    await s.start();
    try {
      s.setWork({
        prompt: "work",
        trajectory: { run: { run_id: "snapshot-run" } },
      });
      const res = await fetch(`${s.baseUrl}/trajectory`);
      const body = (await res.json()) as { ok: boolean; trajectory: { run: { run_id: string } } };
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.trajectory.run.run_id, "snapshot-run");
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
