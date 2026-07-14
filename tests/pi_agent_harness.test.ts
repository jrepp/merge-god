import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  PiAgentHarness,
  type PiAgentScenario,
  type PiHarnessRun,
} from "./helpers/pi_agent_harness";

interface FaultExpectation {
  scenario: PiAgentScenario;
  returncode: number;
  result_status: string | null;
  turn_status: "completed" | "interrupted" | null;
  succeeded: number;
  failed: number;
  incomplete: number;
  protocol_errors?: number;
  stderr?: RegExp;
}

const FAULT_CASES: FaultExpectation[] = [
  {
    scenario: "agent_crash_before_session",
    returncode: 41,
    result_status: null,
    turn_status: null,
    succeeded: 0,
    failed: 0,
    incomplete: 0,
    stderr: /crashed before session startup/,
  },
  {
    scenario: "agent_stall_before_session",
    returncode: 143,
    result_status: null,
    turn_status: null,
    succeeded: 0,
    failed: 0,
    incomplete: 0,
    stderr: /pi process timed out/,
  },
  {
    scenario: "agent_reported_failure",
    returncode: 0,
    result_status: "failure",
    turn_status: "completed",
    succeeded: 1,
    failed: 0,
    incomplete: 0,
  },
  {
    scenario: "agent_crash_mid_turn",
    returncode: 42,
    result_status: null,
    turn_status: "interrupted",
    succeeded: 1,
    failed: 0,
    incomplete: 0,
    stderr: /crashed during an open turn/,
  },
  {
    scenario: "agent_timeout",
    returncode: 143,
    result_status: null,
    turn_status: "interrupted",
    succeeded: 0,
    failed: 0,
    incomplete: 0,
    stderr: /pi process timed out/,
  },
  {
    scenario: "tool_throw",
    returncode: 43,
    result_status: null,
    turn_status: "interrupted",
    succeeded: 0,
    failed: 1,
    incomplete: 0,
    stderr: /tool execution threw/,
  },
  {
    scenario: "tool_timeout",
    returncode: 143,
    result_status: null,
    turn_status: "interrupted",
    succeeded: 0,
    failed: 0,
    incomplete: 1,
    stderr: /pi process timed out/,
  },
  {
    scenario: "tool_missing_end",
    returncode: 48,
    result_status: null,
    turn_status: "interrupted",
    succeeded: 0,
    failed: 0,
    incomplete: 1,
    stderr: /tool completion event omitted/,
  },
  {
    scenario: "tool_duplicate_completion",
    returncode: 49,
    result_status: null,
    turn_status: "completed",
    succeeded: 1,
    failed: 0,
    incomplete: 0,
    protocol_errors: 1,
  },
  {
    scenario: "tool_completion_before_start",
    returncode: 50,
    result_status: null,
    turn_status: "completed",
    succeeded: 0,
    failed: 1,
    incomplete: 0,
    protocol_errors: 1,
  },
  {
    scenario: "coordination_disconnect",
    returncode: 45,
    result_status: null,
    turn_status: "completed",
    succeeded: 0,
    failed: 1,
    incomplete: 0,
  },
  {
    scenario: "coordination_http_500",
    returncode: 46,
    result_status: null,
    turn_status: "completed",
    succeeded: 0,
    failed: 1,
    incomplete: 0,
  },
  {
    scenario: "coordination_malformed_response",
    returncode: 47,
    result_status: null,
    turn_status: "completed",
    succeeded: 0,
    failed: 1,
    incomplete: 0,
  },
];

function assertFaultOutcome(run: PiHarnessRun, expected: FaultExpectation): void {
  assert.equal(run.result.returncode, expected.returncode, run.result.stderr || run.result.stdout);
  assert.equal(run.result.result?.["status"] ?? null, expected.result_status);
  assert.equal(run.result.tooling?.reliability.succeeded, expected.succeeded);
  assert.equal(run.result.tooling?.reliability.failed, expected.failed);
  assert.equal(run.result.tooling?.reliability.incomplete, expected.incomplete);
  assert.equal(run.result.tooling?.reliability.protocol_errors, expected.protocol_errors ?? 0);
  assert.equal(run.state.resume.resumable, true);
  assert.equal(run.state.resume.next_action, "resume_activity");
  if (expected.stderr) assert.match(run.result.stderr, expected.stderr);

  const turns = run.result.tooling?.turns ?? [];
  if (expected.turn_status === null) {
    assert.equal(turns.length, 0);
  } else {
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.status, expected.turn_status);
    assert.ok(run.state.hierarchy.some((record) =>
      record.level === "agent_turn" && record.state === (expected.turn_status === "completed" ? "closed" : "failed")
    ));
  }

  assert.ok(run.git_events.includes("git.worktree.created"));
  assert.ok(run.git_events.includes("git.worktree.removed"));
  assert.ok(run.git_metrics.includes("git.command.duration_ms"));
  assert.equal(
    run.state.events.filter((event) => event.event_type === "pi.tool_call.protocol_error").length,
    expected.protocol_errors ?? 0,
  );
  if (expected.scenario === "tool_duplicate_completion") {
    assert.equal(run.state.events.filter((event) => event.event_type === "pi.tool_call.completed").length, 1);
    assert.deepEqual(run.result.tooling?.calls[0]?.lifecycle_anomalies, ["duplicate_completion"]);
  }
  if (expected.scenario === "tool_completion_before_start") {
    assert.deepEqual(run.result.tooling?.calls[0]?.lifecycle_anomalies, ["completion_without_start"]);
    assert.match(run.result.tooling?.calls[0]?.error ?? "", /without a matching start/);
  }
}

describe("Pi agent fault harness", () => {
  test("runs agent, tool, and coordination failures through one scenario framework", async (t) => {
    const harness = new PiAgentHarness();
    try {
      const requested = process.env.MERGE_GOD_TEST_SCENARIO?.trim();
      const cases = requested ? FAULT_CASES.filter((item) => item.scenario === requested) : FAULT_CASES;
      if (requested && cases.length === 0) {
        throw new Error(`Unknown MERGE_GOD_TEST_SCENARIO=${requested}. Expected one of: ${FAULT_CASES.map((item) => item.scenario).join(", ")}`);
      }
      for (const expected of cases) {
        await t.test(expected.scenario, async () => {
          const run = await harness.run(expected.scenario);
          assertFaultOutcome(run, expected);
        });
      }
    } finally {
      harness.close();
    }
  });
});
