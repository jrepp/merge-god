import { PI_TOOL_NAMES } from "../../pi/tool_contract.ts";
import { createFetchCoordinationClient } from "../../pi/agent_interactions.ts";

const scenario = process.env.MERGE_GOD_FAULT_SCENARIO ?? "success";
const extensionIndex = process.argv.indexOf("--extension");
if (extensionIndex === -1 || !process.argv[extensionIndex + 1]) {
  console.error("missing --extension argument");
  process.exit(2);
}

if (scenario === "agent_crash_before_session") {
  console.error("fault: agent crashed before session startup");
  process.exit(41);
}

const nativeFetch = globalThis.fetch;
const faultFetch = async (input, init) => {
  const url = String(input);
  if (scenario === "coordination_disconnect" && url.endsWith("/result")) {
    throw new TypeError("fault: coordination connection dropped");
  }
  if (scenario === "coordination_http_500" && url.endsWith("/result")) {
    return new Response(JSON.stringify({ ok: false, error: "fault: coordination unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (scenario === "coordination_malformed_response" && url.endsWith("/work")) {
    return new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return nativeFetch(input, init);
};

const extensionModule = await import(process.argv[extensionIndex + 1]);
const tools = new Map();
const handlers = new Map();
let callSequence = 0;

if (scenario === "tool_throw" || scenario === "tool_timeout") {
  tools.set("fault_injected_tool", {
    name: "fault_injected_tool",
    description: "A deterministic test-only fault source.",
    parameters: { type: "object", properties: {} },
    async execute() {
      if (scenario === "tool_throw") throw new Error("fault: tool execution threw");
      setInterval(() => {}, 1000);
      return await new Promise(() => {});
    },
  });
}

process.on("SIGTERM", () => process.exit(143));
console.log(JSON.stringify({ scenario, zaiApiKeyLoaded: process.env.ZAI_API_KEY === "fake-zai-key" }));

const extension = extensionModule.createMergeGodPiExtension({
  client: createFetchCoordinationClient({
    fetch: faultFetch,
    baseUrl: () => process.env.MERGE_GOD_API,
  }),
  randomId: () => `injected-${++callSequence}`,
  now: () => new Date(),
  traceContext: () => JSON.parse(process.env.MERGE_GOD_TRACE_CONTEXT ?? "{}"),
  traceparent: () => process.env.MERGE_GOD_TRACEPARENT ?? null,
});

extension({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  on(event, handler) {
    const current = handlers.get(event) ?? [];
    current.push(handler);
    handlers.set(event, current);
  },
  getAllTools() {
    return [
      {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object" },
        sourceInfo: { kind: "builtin" },
      },
      ...[...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: {
          kind: tool.name === "fault_injected_tool" ? "test" : "extension",
          path: process.argv[extensionIndex + 1],
        },
      })),
    ];
  },
  getActiveTools() {
    return ["bash", ...tools.keys()];
  },
});

async function emit(event, payload) {
  for (const handler of handlers.get(event) ?? []) await handler(payload);
}

async function callTool(name, params = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  const callId = `${name}-${++callSequence}`;
  await emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: name,
    args: params,
  });
  try {
    const result = await tool.execute(callId, params);
    await emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: name,
      result,
      isError: false,
    });
    console.log(JSON.stringify({ tool: name, details: result?.details ?? null }));
    return result;
  } catch (error) {
    await emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: name,
      result: { details: { ok: false, error: String(error) } },
      isError: true,
    });
    throw error;
  }
}

async function startTurn() {
  await emit("agent_start", { type: "agent_start" });
  await emit("session_start", { type: "session_start", reason: "startup" });
  await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  await emit("message_end", {
    type: "message_end",
    message: assistantMessage,
  });
}

const assistantMessage = {
  role: "assistant",
  model: "fake-pi-model",
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 15,
    cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
  },
};

async function endTurn() {
  await emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage, toolResults: [] });
  await emit("agent_end", { type: "agent_end", messages: [] });
}

async function waitForOrchestratorShutdown() {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

async function startToolWithoutCompletion(name, params = {}) {
  const callId = `${name}-${++callSequence}`;
  await emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: name,
    args: params,
  });
  return callId;
}

async function completeToolWithoutStart(name) {
  const callId = `${name}-${++callSequence}`;
  await emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: name,
    result: { details: { ok: true } },
    isError: false,
  });
  return callId;
}

async function runSuccessScenario() {
  const context = await callTool(PI_TOOL_NAMES.context, { view: "work" });
  const state = await callTool(PI_TOOL_NAMES.context, { view: "trajectory" });
  const runId = state.details?.data?.trajectory?.run?.run_id ?? null;
  await callTool(PI_TOOL_NAMES.activity, {
    action: "event",
    event_type: "decision.made",
    payload: {
      summary: "fake pi inspected coordination trajectory state",
      run_id: runId,
      context_ok: context.details?.ok === true,
    },
  });
  await callTool(PI_TOOL_NAMES.activity, {
    action: "observe",
    level: "info",
    category: "context",
    summary: "fake pi has enough context to continue",
    signal_refs: ["evidence://fake-pi/context"],
    grounding_refs: ["AGENTS.md"],
    confidence: 0.9,
    suggested_next: "create child activity",
  });
  await callTool(PI_TOOL_NAMES.context, { view: "tooling" });
  await callTool(PI_TOOL_NAMES.activity, {
    action: "propose",
    next_action: "create_child_activity",
    rationale: "fake pi verified trajectory state and needs scoped CI diagnosis",
    evidence_refs: ["evidence://fake-pi/state-read"],
  });
  const child = await callTool(PI_TOOL_NAMES.activity, {
    action: "create_child",
    activity_type: "ci_diagnosis",
    summary: "fake pi requested a scoped CI diagnosis child activity",
    model_tier: "standard",
    model_reason: "CI diagnosis needs moderate reasoning over trajectory and check state.",
    evidence_refs: ["evidence://fake-pi/state-read"],
  });
  await callTool(PI_TOOL_NAMES.activity, {
    action: "close_activity",
    activity_id: child.details?.data?.activity?.child_activity_id,
    success: true,
    summary: "fake pi completed scoped CI diagnosis",
  });
  await callTool(PI_TOOL_NAMES.complete, {
    status: "success",
    summary: "fake pi used merge-god coordination trajectory state",
    annotations: { labels: ["large", "embark-candidate"] },
  });
  await endTurn();
  await waitForOrchestratorShutdown();
}

if (scenario === "agent_stall_before_session") {
  await waitForOrchestratorShutdown();
}

await startTurn();

if (scenario === "success") {
  await runSuccessScenario();
} else if (scenario === "agent_reported_failure") {
  await callTool(PI_TOOL_NAMES.complete, {
    status: "failure",
    summary: "fault: agent reported failure",
    error: "deterministic agent failure",
  });
  await endTurn();
  await waitForOrchestratorShutdown();
} else if (scenario === "agent_crash_mid_turn") {
  await callTool(PI_TOOL_NAMES.context, { view: "work" });
  console.error("fault: agent crashed during an open turn");
  process.exit(42);
} else if (scenario === "agent_timeout") {
  await waitForOrchestratorShutdown();
} else if (scenario === "tool_throw") {
  try {
    await callTool("fault_injected_tool");
  } catch (error) {
    console.error(String(error));
    process.exit(43);
  }
} else if (scenario === "tool_timeout") {
  await callTool("fault_injected_tool");
} else if (scenario === "tool_missing_end") {
  await startToolWithoutCompletion(PI_TOOL_NAMES.context, { view: "work" });
  console.error("fault: tool completion event omitted");
  process.exit(48);
} else if (scenario === "tool_duplicate_completion") {
  await callTool(PI_TOOL_NAMES.context, { view: "work" });
  await emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: `${PI_TOOL_NAMES.context}-1`,
    toolName: PI_TOOL_NAMES.context,
    result: { details: { ok: true } },
    isError: false,
  });
  await endTurn();
  process.exit(49);
} else if (scenario === "tool_completion_before_start") {
  await completeToolWithoutStart(PI_TOOL_NAMES.context);
  await endTurn();
  process.exit(50);
} else if (scenario === "coordination_disconnect" || scenario === "coordination_http_500") {
  await callTool(PI_TOOL_NAMES.complete, {
    status: "success",
    summary: "this completion must not be recorded",
  });
  await endTurn();
  process.exit(scenario === "coordination_disconnect" ? 45 : 46);
} else if (scenario === "coordination_malformed_response") {
  await callTool(PI_TOOL_NAMES.context, { view: "work" });
  await endTurn();
  process.exit(47);
} else {
  console.error(`unknown fault scenario: ${scenario}`);
  process.exit(64);
}
