import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { piAgentProgressFromRuntimeEvent } from "../coordination";

describe("pi agent progress", () => {
  test("keeps lifecycle and tool names without leaking arguments or output", () => {
    assert.deepEqual(piAgentProgressFromRuntimeEvent({ type: "agent_start" }), {
      action: "agent_started",
    });
    assert.deepEqual(
      piAgentProgressFromRuntimeEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "secret" } }),
      { action: "tool_started", tool: "bash" },
    );
    assert.deepEqual(
      piAgentProgressFromRuntimeEvent({ type: "tool_execution_end", toolName: "bash", result: { isError: true, content: "secret" } }),
      { action: "tool_completed", tool: "bash", success: false },
    );
    assert.equal(piAgentProgressFromRuntimeEvent({ type: "message_update", encrypted: "secret" }), null);
  });
});
