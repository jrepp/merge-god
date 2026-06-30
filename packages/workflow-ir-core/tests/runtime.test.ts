import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AdapterRegistry,
  JsonFileWorkflowStore,
  MemoryTracer,
  MemoryWorkflowStore,
  WorkflowRuntime,
  createMergeGodFinalGateAdapter,
  createMergeGodValidationLaneAdapter,
  createStaticGateAdapter,
  replayEvents,
  validateWorkflow,
  type ActionAdapter,
  type AdapterContext,
  type AdapterResult,
  type JsonObject,
  type WorkflowIR,
} from "../src/index";

function baseWorkflow(opts: {
  nodes: WorkflowIR["graph"]["nodes"];
  edges?: WorkflowIR["graph"]["edges"];
  gates?: WorkflowIR["gates"];
}): WorkflowIR {
  return {
    ir_version: "workflow-ir/v1",
    workflow: {
      id: "wf.test",
      version: "v1",
      title: "test workflow",
    },
    graph: {
      nodes: opts.nodes,
      edges: opts.edges ?? [],
    },
    ...(opts.gates ? { gates: opts.gates } : {}),
  };
}

function actionNode(id: string, ref = "test.action", extra: Partial<WorkflowIR["graph"]["nodes"][number]> = {}) {
  return {
    id,
    kind: "action" as const,
    action: { ref },
    ...extra,
  };
}

function gateNode(id: string, gateRef = "gate.test") {
  return {
    id,
    kind: "gate" as const,
    gate_ref: gateRef,
  };
}

function actionAdapter(
  ref: string,
  execute: (ctx: AdapterContext, signal: AbortSignal) => Promise<AdapterResult> | AdapterResult,
): ActionAdapter {
  return {
    manifest: { ref, kind: "action", interruptible: true, idempotent: true, timeoutMs: 50 },
    async execute(ctx, signal) {
      return execute(ctx, signal);
    },
  };
}

function runtimeWith(registry: AdapterRegistry, store = new MemoryWorkflowStore(), tracer = new MemoryTracer()) {
  const runtime = new WorkflowRuntime({
    store,
    registry,
    tracer,
    policy: {
      defaultNodeTimeoutMs: 50,
      maxTransitions: 100,
      maxNodeAttempts: 2,
      maxWallClockMs: 60_000,
      maxConcurrency: 2,
      retry: { initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
      pause: { mode: "checkpoint" },
    },
  });
  return { runtime, store, tracer };
}

describe("WorkflowIR validation and adapter registry", () => {
  test("validates basic-dag shape and rejects missing adapters", () => {
    const registry = new AdapterRegistry();
    const wf = baseWorkflow({
      nodes: [actionNode("a", "missing.action")],
      edges: [{ id: "bad", from: "a", to: "missing" }],
    });

    assert.deepEqual(validateWorkflow(wf), ["Edge bad references unknown to node missing"]);
    assert.match(registry.validateWorkflow(wf).join("\n"), /No action adapter registered/);
  });
});

describe("WorkflowRuntime execution", () => {
  test("executes a DAG, persists events, replays state, and exports a debug bundle", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.action", (ctx) => ({ outputs: { node: ctx.node.id } })));
    const { runtime, tracer } = runtimeWith(registry);
    const wf = baseWorkflow({
      nodes: [actionNode("a"), actionNode("b")],
      edges: [{ id: "edge.a.b", from: "a", to: "b" }],
    });

    const started = await runtime.start(wf, { input: "value" });
    const final = await runtime.run(started.run_id);
    const events = await runtime.events(started.run_id);
    const replayed = replayEvents(events);
    const inspected = await runtime.inspect(started.run_id);
    const bundle = await runtime.exportBundle(started.run_id);
    const explanation = await runtime.explain(started.run_id, "b");

    assert.equal(final.status, "completed");
    assert.equal(inspected.status, "completed");
    assert.equal(final.node_states["a"]?.status, "succeeded");
    assert.equal(final.node_states["b"]?.outputs?.["node"], "b");
    assert.equal(replayed.status, final.status);
    assert.equal(replayed.node_states["b"]?.status, "succeeded");
    assert.equal(bundle.workflow.workflow.id, "wf.test");
    assert.deepEqual(explanation.dependencies, ["a"]);
    assert.ok(tracer.records.some((record) => record.kind === "span.start" && record.name === "workflow.node.action"));
  });

  test("retries retryable action failures up to the policy limit", async () => {
    const registry = new AdapterRegistry();
    let attempts = 0;
    registry.registerAction(
      actionAdapter("test.flaky", () => {
        attempts++;
        if (attempts === 1) {
          return { status: "failed", error: { code: "flaky", message: "try again" } };
        }
        return { outputs: { attempts } };
      }),
    );
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({ nodes: [actionNode("flaky", "test.flaky")] });

    const started = await runtime.start(wf);
    const final = await runtime.run(started.run_id);

    assert.equal(final.status, "completed");
    assert.equal(final.node_states["flaky"]?.attempts, 2);
    assert.equal(final.node_states["flaky"]?.outputs?.["attempts"], 2);
  });

  test("fails the run when a required node exhausts attempts", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.fail", () => ({ status: "failed", error: { code: "boom", message: "no" } })));
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({
      nodes: [actionNode("fail", "test.fail"), actionNode("after")],
      edges: [{ id: "edge.fail.after", from: "fail", to: "after" }],
    });
    registry.registerAction(actionAdapter("test.action", () => ({ outputs: { ok: true } })));

    const started = await runtime.start(wf);
    const final = await runtime.run(started.run_id);

    assert.equal(final.status, "failed");
    assert.equal(final.node_states["fail"]?.attempts, 2);
    assert.equal(final.node_states["after"]?.status, "pending");
  });

  test("continues past failed nodes when on_error.strategy is continue", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.fail", () => ({ status: "failed", error: { code: "advisory", message: "warn" } })));
    registry.registerAction(actionAdapter("test.action", () => ({ outputs: { after: true } })));
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({
      nodes: [
        actionNode("advisory", "test.fail", { on_error: { strategy: "continue" } }),
        actionNode("after"),
      ],
      edges: [{ id: "edge.advisory.after", from: "advisory", to: "after" }],
    });

    const started = await runtime.start(wf);
    const final = await runtime.run(started.run_id);

    assert.equal(final.status, "completed");
    assert.equal(final.node_states["advisory"]?.status, "failed");
    assert.equal(final.node_states["after"]?.status, "succeeded");
  });

  test("runs gate adapters and blocks failed gates", async () => {
    const registry = new AdapterRegistry();
    registry.registerGate(
      createStaticGateAdapter("merge-policy", () => ({
        option: "reject",
        passed: false,
        reason: "missing evidence",
      })),
    );
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({
      nodes: [gateNode("gate")],
      gates: {
        definitions: [{ id: "gate.test", decision_type: "merge-policy" }],
      },
    });

    const started = await runtime.start(wf);
    const final = await runtime.run(started.run_id);
    const events = await runtime.events(started.run_id);

    assert.equal(final.status, "failed");
    assert.equal(final.node_states["gate"]?.status, "blocked");
    assert.ok(events.some((event) => event.type === "gate.requested"));
    assert.ok(events.some((event) => event.type === "gate.decided"));
  });

  test("pauses at a checkpoint and resumes to completion", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.action", () => ({ outputs: { ok: true } })));
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({ nodes: [actionNode("a")] });

    const started = await runtime.start(wf);
    await runtime.pause(started.run_id);
    const paused = await runtime.run(started.run_id);
    assert.equal(paused.status, "paused");

    await runtime.resume(started.run_id);
    const final = await runtime.run(started.run_id);
    assert.equal(final.status, "completed");
  });

  test("cancels a run before more work is scheduled", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.action", () => ({ outputs: { ok: true } })));
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({ nodes: [actionNode("a")] });

    const started = await runtime.start(wf);
    await runtime.cancel(started.run_id);
    const cancelled = await runtime.run(started.run_id);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.node_states["a"]?.status, "pending");
  });

  test("times out interruptible adapters", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(
      actionAdapter(
        "test.slow",
        (_ctx, signal) =>
          new Promise<AdapterResult>((resolve, reject) => {
            const timer = setTimeout(() => resolve({ outputs: { late: true } }), 1_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({ nodes: [actionNode("slow", "test.slow")] });

    const started = await runtime.start(wf);
    const final = await runtime.run(started.run_id);

    assert.equal(final.status, "failed");
    assert.equal(final.node_states["slow"]?.status, "timed_out");
    assert.equal(final.node_states["slow"]?.error?.code, "node_timeout");
  });

  test("enforces max transition limits", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.action", () => ({ outputs: { ok: true } })));
    const runtime = new WorkflowRuntime({
      store: new MemoryWorkflowStore(),
      registry,
      policy: { maxTransitions: 0 },
    });
    const wf = baseWorkflow({ nodes: [actionNode("a")] });

    const started = await runtime.start(wf);
    const final = await runtime.run(started.run_id);

    assert.equal(final.status, "failed");
    assert.equal(final.node_states["a"]?.status, "pending");
  });

  test("persists snapshots and events in the JSON file store", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(actionAdapter("test.action", () => ({ outputs: { persisted: true } })));
    const filePath = join(mkdtempSync(join(tmpdir(), "workflow-ir-core-")), "store.json");
    const store = new JsonFileWorkflowStore(filePath);
    const runtime = new WorkflowRuntime({ store, registry });
    const wf = baseWorkflow({ nodes: [actionNode("a")] });

    const started = await runtime.start(wf);
    await runtime.run(started.run_id);

    const secondStore = new JsonFileWorkflowStore(filePath);
    const snapshot = await secondStore.loadSnapshot(started.run_id);
    const events = await secondStore.listEvents(started.run_id);

    assert.equal(snapshot?.status, "completed");
    assert.ok(events.length >= 4);
  });
});

describe("merge-god adapters", () => {
  test("runs validation lanes and final gate with successful evidence", async () => {
    const registry = new AdapterRegistry();
    const commands: string[] = [];
    registry.registerAction(
      createMergeGodValidationLaneAdapter({
        runCommand(command) {
          commands.push(command);
          return { code: 0, stdout: "ok", stderr: "" };
        },
      }),
    );
    registry.registerAction(createMergeGodFinalGateAdapter());
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({
      nodes: [
        actionNode("validate", "merge-god.validation.run-lane", { metadata: { lane: "test" } }),
        actionNode("final", "merge-god.pr.final-gate"),
      ],
      edges: [{ id: "edge.validate.final", from: "validate", to: "final" }],
    });

    const started = await runtime.start(wf, {
      validation_lanes: { test: "npm test" },
      disposition_setting: "bounded",
    } as JsonObject);
    const final = await runtime.run(started.run_id);

    assert.deepEqual(commands, ["npm test"]);
    assert.equal(final.status, "completed");
    assert.equal(final.node_states["final"]?.outputs?.["merge_allowed"], true);
  });

  test("continues to final gate after advisory validation failure", async () => {
    const registry = new AdapterRegistry();
    registry.registerAction(
      createMergeGodValidationLaneAdapter({
        runCommand() {
          return { code: 1, stdout: "", stderr: "failed" };
        },
      }),
    );
    registry.registerAction(createMergeGodFinalGateAdapter());
    const { runtime } = runtimeWith(registry);
    const wf = baseWorkflow({
      nodes: [
        actionNode("validate", "merge-god.validation.run-lane", {
          metadata: { lane: "test" },
          on_error: { strategy: "continue" },
        }),
        actionNode("final", "merge-god.pr.final-gate"),
      ],
      edges: [{ id: "edge.validate.final", from: "validate", to: "final" }],
    });

    const started = await runtime.start(wf, { validation_lanes: { test: "npm test" } } as JsonObject);
    const final = await runtime.run(started.run_id);

    assert.equal(final.status, "completed");
    assert.equal(final.node_states["validate"]?.status, "failed");
    assert.equal(final.node_states["final"]?.outputs?.["merge_allowed"], false);
  });
});
