import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface WorkflowIR {
  ir_version: "workflow-ir/v1";
  workflow: {
    id: string;
    version: string;
    title: string;
    [key: string]: unknown;
  };
  graph: {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    [key: string]: unknown;
  };
  gates?: {
    definitions?: GateDefinition[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  kind: "action" | "gate";
  label?: string;
  action?: {
    ref: string;
    mode?: string;
    tool_ref?: string;
    [key: string]: unknown;
  };
  gate_ref?: string;
  metadata?: JsonObject;
  on_error?: {
    strategy?: "fail_workflow" | "continue" | "route";
    target_node?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  kind?: "control" | "guard";
  [key: string]: unknown;
}

export interface GateDefinition {
  id: string;
  decision_type: string;
  label?: string;
  [key: string]: unknown;
}

export type RunStatus =
  | "created"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "timed_out";

export interface NodeRunState {
  node_id: string;
  status: NodeStatus;
  attempts: number;
  outputs: JsonObject | null;
  error: WorkflowError | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowRunState {
  run_id: string;
  workflow: WorkflowIR;
  status: RunStatus;
  inputs: JsonObject;
  node_states: Record<string, NodeRunState>;
  transition_count: number;
  pause_requested: boolean;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkflowError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
}

export type WorkflowEvent =
  | { type: "run.started"; run_id: string; at: string; workflow_id: string; workflow: WorkflowIR; inputs: JsonObject }
  | { type: "run.pause_requested"; run_id: string; at: string }
  | { type: "run.paused"; run_id: string; at: string }
  | { type: "run.resumed"; run_id: string; at: string }
  | { type: "run.cancel_requested"; run_id: string; at: string }
  | { type: "run.cancelled"; run_id: string; at: string }
  | { type: "run.completed"; run_id: string; at: string }
  | { type: "run.failed"; run_id: string; at: string; error: WorkflowError }
  | { type: "run.timed_out"; run_id: string; at: string; error: WorkflowError }
  | { type: "node.ready"; run_id: string; at: string; node_id: string }
  | { type: "node.started"; run_id: string; at: string; node_id: string; attempt: number }
  | { type: "node.succeeded"; run_id: string; at: string; node_id: string; outputs: JsonObject }
  | { type: "node.failed"; run_id: string; at: string; node_id: string; error: WorkflowError }
  | { type: "node.skipped"; run_id: string; at: string; node_id: string; reason: string }
  | { type: "node.blocked"; run_id: string; at: string; node_id: string; error: WorkflowError }
  | { type: "node.timed_out"; run_id: string; at: string; node_id: string; error: WorkflowError }
  | { type: "gate.requested"; run_id: string; at: string; node_id: string; gate_ref: string }
  | { type: "gate.decided"; run_id: string; at: string; node_id: string; decision: GateDecision };

export interface WorkflowStore {
  appendEvent(event: WorkflowEvent): Promise<void>;
  listEvents(runId: string): Promise<WorkflowEvent[]>;
  saveSnapshot(state: WorkflowRunState): Promise<void>;
  loadSnapshot(runId: string): Promise<WorkflowRunState | null>;
}

export class MemoryWorkflowStore implements WorkflowStore {
  private readonly eventsByRun = new Map<string, WorkflowEvent[]>();
  private readonly snapshots = new Map<string, WorkflowRunState>();

  async appendEvent(event: WorkflowEvent): Promise<void> {
    const current = this.eventsByRun.get(event.run_id) ?? [];
    current.push(clone(event));
    this.eventsByRun.set(event.run_id, current);
  }

  async listEvents(runId: string): Promise<WorkflowEvent[]> {
    return clone(this.eventsByRun.get(runId) ?? []);
  }

  async saveSnapshot(state: WorkflowRunState): Promise<void> {
    this.snapshots.set(state.run_id, clone(state));
  }

  async loadSnapshot(runId: string): Promise<WorkflowRunState | null> {
    const state = this.snapshots.get(runId);
    return state ? clone(state) : null;
  }
}

export class JsonFileWorkflowStore implements WorkflowStore {
  constructor(private readonly filePath: string) {}

  async appendEvent(event: WorkflowEvent): Promise<void> {
    const data = await this.readData();
    const events = data.events[event.run_id] ?? [];
    events.push(event);
    data.events[event.run_id] = events;
    await this.writeData(data);
  }

  async listEvents(runId: string): Promise<WorkflowEvent[]> {
    const data = await this.readData();
    return clone(data.events[runId] ?? []);
  }

  async saveSnapshot(state: WorkflowRunState): Promise<void> {
    const data = await this.readData();
    data.snapshots[state.run_id] = state;
    await this.writeData(data);
  }

  async loadSnapshot(runId: string): Promise<WorkflowRunState | null> {
    const data = await this.readData();
    return data.snapshots[runId] ? clone(data.snapshots[runId]) : null;
  }

  private async readData(): Promise<WorkflowStoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as WorkflowStoreFile;
      return {
        events: parsed.events ?? {},
        snapshots: parsed.snapshots ?? {},
      };
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") {
        return { events: {}, snapshots: {} };
      }
      throw e;
    }
  }

  private async writeData(data: WorkflowStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n");
  }
}

interface WorkflowStoreFile {
  events: Record<string, WorkflowEvent[]>;
  snapshots: Record<string, WorkflowRunState>;
}

export interface AdapterManifest {
  ref: string;
  kind: "action" | "gate";
  interruptible: boolean;
  idempotent: boolean;
  timeoutMs?: number;
  requiredSecrets?: string[];
}

export interface AdapterContext {
  run_id: string;
  workflow: WorkflowIR;
  node: WorkflowNode;
  inputs: JsonObject;
  state: WorkflowRunState;
  attempt: number;
  idempotency_key: string;
}

export interface AdapterResult {
  status?: "succeeded" | "failed" | "skipped" | "blocked";
  outputs?: JsonObject;
  error?: WorkflowError;
}

export interface GateDecision {
  option: string;
  passed: boolean;
  reason?: string;
  evidence?: JsonObject;
}

export interface ActionAdapter {
  manifest: AdapterManifest & { kind: "action" };
  execute(ctx: AdapterContext, signal: AbortSignal): Promise<AdapterResult>;
}

export interface GateAdapter {
  manifest: AdapterManifest & { kind: "gate" };
  decide(ctx: AdapterContext, gate: GateDefinition, signal: AbortSignal): Promise<GateDecision>;
}

export class AdapterRegistry {
  private readonly actions = new Map<string, ActionAdapter>();
  private readonly gates = new Map<string, GateAdapter>();

  registerAction(adapter: ActionAdapter): void {
    this.actions.set(adapter.manifest.ref, adapter);
  }

  registerGate(adapter: GateAdapter): void {
    this.gates.set(adapter.manifest.ref, adapter);
  }

  getAction(ref: string): ActionAdapter | null {
    return this.actions.get(ref) ?? null;
  }

  getGate(ref: string): GateAdapter | null {
    return this.gates.get(ref) ?? null;
  }

  validateWorkflow(workflow: WorkflowIR): string[] {
    const errors = validateWorkflow(workflow);
    for (const node of workflow.graph.nodes) {
      if (node.kind === "action") {
        const ref = node.action?.ref;
        if (!ref) errors.push(`Action node ${node.id} is missing action.ref`);
        else if (!this.actions.has(ref)) errors.push(`No action adapter registered for ${ref}`);
      }
      if (node.kind === "gate") {
        const gate = findGateDefinition(workflow, node.gate_ref ?? "");
        if (!gate) errors.push(`Gate node ${node.id} references unknown gate ${node.gate_ref ?? ""}`);
        else if (!this.gates.has(gate.decision_type) && !this.gates.has(gate.id)) {
          errors.push(`No gate adapter registered for ${gate.decision_type} or ${gate.id}`);
        }
      }
    }
    return errors;
  }
}

export interface RuntimePolicy {
  maxTransitions: number;
  maxNodeAttempts: number;
  maxWallClockMs: number;
  maxConcurrency: number;
  defaultNodeTimeoutMs: number;
  retry: {
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
  };
  pause: {
    mode: "checkpoint" | "interruptible";
  };
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  maxTransitions: 500,
  maxNodeAttempts: 3,
  maxWallClockMs: 30 * 60_000,
  maxConcurrency: 4,
  defaultNodeTimeoutMs: 5 * 60_000,
  retry: {
    initialDelayMs: 10,
    maxDelayMs: 1_000,
    backoffMultiplier: 2,
  },
  pause: {
    mode: "checkpoint",
  },
};

export interface WorkflowTracer {
  event(name: string, attrs: JsonObject): void;
  span<T>(name: string, attrs: JsonObject, fn: () => Promise<T>): Promise<T>;
}

export interface TraceRecord {
  kind: "event" | "span.start" | "span.end" | "span.error";
  name: string;
  attrs: JsonObject;
  at: string;
}

export class MemoryTracer implements WorkflowTracer {
  readonly records: TraceRecord[] = [];

  event(name: string, attrs: JsonObject): void {
    this.records.push({ kind: "event", name, attrs, at: now() });
  }

  async span<T>(name: string, attrs: JsonObject, fn: () => Promise<T>): Promise<T> {
    this.records.push({ kind: "span.start", name, attrs, at: now() });
    try {
      const result = await fn();
      this.records.push({ kind: "span.end", name, attrs, at: now() });
      return result;
    } catch (e) {
      this.records.push({
        kind: "span.error",
        name,
        attrs: { ...attrs, error: errorMessage(e) },
        at: now(),
      });
      throw e;
    }
  }
}

class NullTracer implements WorkflowTracer {
  event(_name: string, _attrs: JsonObject): void {}
  async span<T>(_name: string, _attrs: JsonObject, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export class WorkflowRuntime {
  private readonly store: WorkflowStore;
  private readonly registry: AdapterRegistry;
  private readonly tracer: WorkflowTracer;
  private readonly policy: RuntimePolicy;

  constructor(opts: {
    store: WorkflowStore;
    registry: AdapterRegistry;
    tracer?: WorkflowTracer;
    policy?: Partial<RuntimePolicy>;
  }) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.tracer = opts.tracer ?? new NullTracer();
    this.policy = mergePolicy(opts.policy);
  }

  async start(workflow: WorkflowIR, inputs: JsonObject = {}, runId = randomUUID()): Promise<WorkflowRunState> {
    const workflowErrors = this.registry.validateWorkflow(workflow);
    if (workflowErrors.length > 0) {
      throw new Error(`Workflow is not executable: ${workflowErrors.join("; ")}`);
    }
    const at = now();
    const state: WorkflowRunState = {
      run_id: runId,
      workflow: clone(workflow),
      status: "running",
      inputs: clone(inputs),
      node_states: {},
      transition_count: 0,
      pause_requested: false,
      cancel_requested: false,
      created_at: at,
      updated_at: at,
      completed_at: null,
    };
    for (const node of workflow.graph.nodes) {
      state.node_states[node.id] = {
        node_id: node.id,
        status: "pending",
        attempts: 0,
        outputs: null,
        error: null,
        started_at: null,
        completed_at: null,
      };
    }
    await this.store.saveSnapshot(state);
    await this.emit(state, {
      type: "run.started",
      run_id: runId,
      at,
      workflow_id: workflow.workflow.id,
      workflow: clone(workflow),
      inputs,
    });
    return this.requireState(runId);
  }

  async run(runId: string): Promise<WorkflowRunState> {
    let state = await this.requireState(runId);
    while (state.status === "running") {
      if (state.cancel_requested) {
        await this.emit(state, { type: "run.cancelled", run_id: runId, at: now() });
        return this.requireState(runId);
      }
      if (state.pause_requested) {
        await this.emit(state, { type: "run.paused", run_id: runId, at: now() });
        return this.requireState(runId);
      }
      const wallClock = Date.now() - Date.parse(state.created_at);
      if (wallClock > this.policy.maxWallClockMs) {
        await this.emit(state, {
          type: "run.timed_out",
          run_id: runId,
          at: now(),
          error: { code: "run_timeout", message: "Workflow exceeded maxWallClockMs" },
        });
        return this.requireState(runId);
      }
      if (state.transition_count >= this.policy.maxTransitions) {
        await this.emit(state, {
          type: "run.failed",
          run_id: runId,
          at: now(),
          error: { code: "max_transitions", message: "Workflow exceeded maxTransitions" },
        });
        return this.requireState(runId);
      }

      const ready = this.readyNodes(state).slice(0, Math.max(1, this.policy.maxConcurrency));
      if (ready.length === 0) {
        if (this.isComplete(state)) {
          await this.emit(state, { type: "run.completed", run_id: runId, at: now() });
          return this.requireState(runId);
        }
        if (this.hasTerminalFailure(state)) {
          await this.emit(state, {
            type: "run.failed",
            run_id: runId,
            at: now(),
            error: { code: "node_failure", message: "A required workflow node failed" },
          });
          return this.requireState(runId);
        }
        await this.emit(state, {
          type: "run.failed",
          run_id: runId,
          at: now(),
          error: { code: "deadlock", message: "No runnable nodes remain" },
        });
        return this.requireState(runId);
      }

      for (const node of ready) {
        state = await this.requireState(runId);
        const nodeState = this.requireNodeState(state, node.id);
        if (nodeState.status === "pending") {
          await this.emit(state, { type: "node.ready", run_id: runId, at: now(), node_id: node.id });
          state = await this.requireState(runId);
        }
        await this.executeNode(state, node);
      }
      state = await this.requireState(runId);
    }
    return state;
  }

  async pause(runId: string): Promise<WorkflowRunState> {
    const state = await this.requireState(runId);
    if (state.status !== "running") return state;
    await this.emit(state, { type: "run.pause_requested", run_id: runId, at: now() });
    return this.requireState(runId);
  }

  async resume(runId: string): Promise<WorkflowRunState> {
    const state = await this.requireState(runId);
    if (state.status !== "paused") return state;
    await this.emit(state, { type: "run.resumed", run_id: runId, at: now() });
    return this.requireState(runId);
  }

  async cancel(runId: string): Promise<WorkflowRunState> {
    const state = await this.requireState(runId);
    if (isRunTerminal(state.status)) return state;
    await this.emit(state, { type: "run.cancel_requested", run_id: runId, at: now() });
    if (state.status !== "running") {
      const updated = await this.requireState(runId);
      await this.emit(updated, { type: "run.cancelled", run_id: runId, at: now() });
    }
    return this.requireState(runId);
  }

  async inspect(runId: string): Promise<WorkflowRunState> {
    return this.requireState(runId);
  }

  async events(runId: string): Promise<WorkflowEvent[]> {
    return this.store.listEvents(runId);
  }

  async replay(runId: string): Promise<WorkflowRunState> {
    const events = await this.store.listEvents(runId);
    if (events.length === 0) throw new Error(`No events for run ${runId}`);
    return replayEvents(events);
  }

  async explain(runId: string, nodeId: string): Promise<{
    state: NodeRunState;
    events: WorkflowEvent[];
    dependencies: string[];
  }> {
    const state = await this.requireState(runId);
    const nodeState = this.requireNodeState(state, nodeId);
    const events = (await this.store.listEvents(runId)).filter((event) => "node_id" in event && event.node_id === nodeId);
    const dependencies = state.workflow.graph.edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
    return { state: clone(nodeState), events, dependencies };
  }

  async exportBundle(runId: string): Promise<{
    workflow: WorkflowIR;
    inputs: JsonObject;
    state: WorkflowRunState;
    events: WorkflowEvent[];
  }> {
    const state = await this.requireState(runId);
    return {
      workflow: clone(state.workflow),
      inputs: clone(state.inputs),
      state,
      events: await this.store.listEvents(runId),
    };
  }

  private async executeNode(state: WorkflowRunState, node: WorkflowNode): Promise<void> {
    const current = this.requireNodeState(state, node.id);
    const attempt = current.attempts + 1;
    await this.emit(state, { type: "node.started", run_id: state.run_id, at: now(), node_id: node.id, attempt });
    const started = await this.requireState(state.run_id);
    const timeoutMs = this.timeoutFor(node);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.tracer.span(
        `workflow.node.${node.kind}`,
        { run_id: state.run_id, node_id: node.id, attempt },
        async () => {
          if (node.kind === "action") return this.executeAction(started, node, attempt, controller.signal);
          return this.executeGate(started, node, attempt, controller.signal);
        },
      );
      clearTimeout(timeout);
      await this.recordAdapterResult(started, node, result);
    } catch (e) {
      clearTimeout(timeout);
      const error =
        controller.signal.aborted
          ? { code: "node_timeout", message: `Node exceeded timeout ${timeoutMs}ms` }
          : { code: "adapter_error", message: errorMessage(e) };
      await this.recordNodeFailure(started, node, error);
    }
  }

  private async executeAction(
    state: WorkflowRunState,
    node: WorkflowNode,
    attempt: number,
    signal: AbortSignal,
  ): Promise<AdapterResult> {
    const ref = node.action?.ref;
    if (!ref) return { status: "failed", error: { code: "missing_action_ref", message: "Action node is missing action.ref" } };
    const adapter = this.registry.getAction(ref);
    if (!adapter) return { status: "failed", error: { code: "missing_adapter", message: `No action adapter for ${ref}` } };
    return adapter.execute(this.adapterContext(state, node, attempt), signal);
  }

  private async executeGate(
    state: WorkflowRunState,
    node: WorkflowNode,
    attempt: number,
    signal: AbortSignal,
  ): Promise<AdapterResult> {
    const gate = findGateDefinition(state.workflow, node.gate_ref ?? "");
    if (!gate) {
      return { status: "failed", error: { code: "missing_gate", message: `Unknown gate ${node.gate_ref ?? ""}` } };
    }
    await this.emit(state, {
      type: "gate.requested",
      run_id: state.run_id,
      at: now(),
      node_id: node.id,
      gate_ref: gate.id,
    });
    const updated = await this.requireState(state.run_id);
    const adapter = this.registry.getGate(gate.decision_type) ?? this.registry.getGate(gate.id);
    if (!adapter) {
      return { status: "failed", error: { code: "missing_gate_adapter", message: `No gate adapter for ${gate.decision_type}` } };
    }
    const decision = await adapter.decide(this.adapterContext(updated, node, attempt), gate, signal);
    await this.emit(updated, { type: "gate.decided", run_id: state.run_id, at: now(), node_id: node.id, decision });
    return {
      status: decision.passed ? "succeeded" : "blocked",
      outputs: { decision: decision as unknown as JsonValue },
      error: decision.passed ? undefined : { code: "gate_blocked", message: decision.reason ?? "Gate did not pass" },
    };
  }

  private async recordAdapterResult(state: WorkflowRunState, node: WorkflowNode, result: AdapterResult): Promise<void> {
    const status = result.status ?? "succeeded";
    if (status === "succeeded") {
      await this.emit(state, {
        type: "node.succeeded",
        run_id: state.run_id,
        at: now(),
        node_id: node.id,
        outputs: result.outputs ?? {},
      });
    } else if (status === "skipped") {
      await this.emit(state, {
        type: "node.skipped",
        run_id: state.run_id,
        at: now(),
        node_id: node.id,
        reason: result.error?.message ?? "Adapter skipped node",
      });
    } else if (status === "blocked") {
      await this.recordNodeFailure(state, node, result.error ?? { code: "node_blocked", message: "Node blocked" }, "blocked");
    } else {
      await this.recordNodeFailure(state, node, result.error ?? { code: "node_failed", message: "Node failed" });
    }
  }

  private async recordNodeFailure(
    state: WorkflowRunState,
    node: WorkflowNode,
    error: WorkflowError,
    terminalStatus: "failed" | "blocked" | "timed_out" = error.code === "node_timeout" ? "timed_out" : "failed",
  ): Promise<void> {
    const nodeState = this.requireNodeState(state, node.id);
    if (nodeState.attempts < this.policy.maxNodeAttempts) {
      await this.emit(state, {
        type: "node.failed",
        run_id: state.run_id,
        at: now(),
        node_id: node.id,
        error: { ...error, retryable: true },
      });
      const retryState = await this.requireState(state.run_id);
      const retryNode = this.requireNodeState(retryState, node.id);
      retryNode.status = "pending";
      retryState.updated_at = now();
      await this.store.saveSnapshot(retryState);
      await delay(this.retryDelay(nodeState.attempts));
      return;
    }
    const eventType =
      terminalStatus === "blocked" ? "node.blocked" : terminalStatus === "timed_out" ? "node.timed_out" : "node.failed";
    await this.emit(state, {
      type: eventType,
      run_id: state.run_id,
      at: now(),
      node_id: node.id,
      error: { ...error, retryable: false },
    } as WorkflowEvent);
  }

  private adapterContext(state: WorkflowRunState, node: WorkflowNode, attempt: number): AdapterContext {
    return {
      run_id: state.run_id,
      workflow: state.workflow,
      node,
      inputs: state.inputs,
      state,
      attempt,
      idempotency_key: `${state.run_id}:${node.id}:${attempt}`,
    };
  }

  private readyNodes(state: WorkflowRunState): WorkflowNode[] {
    return state.workflow.graph.nodes.filter((node) => {
      const nodeState = this.requireNodeState(state, node.id);
      if (nodeState.status !== "pending" && nodeState.status !== "ready") return false;
      const deps = state.workflow.graph.edges.filter((edge) => edge.to === node.id);
      return deps.every((edge) => this.dependencySatisfied(state, edge.from));
    });
  }

  private dependencySatisfied(state: WorkflowRunState, nodeId: string): boolean {
    const nodeState = this.requireNodeState(state, nodeId);
    if (nodeState.status === "succeeded" || nodeState.status === "skipped") return true;
    const node = this.requireNode(state.workflow, nodeId);
    const canContinue = node.on_error?.strategy === "continue";
    return canContinue && (nodeState.status === "failed" || nodeState.status === "timed_out" || nodeState.status === "blocked");
  }

  private hasTerminalFailure(state: WorkflowRunState): boolean {
    for (const node of state.workflow.graph.nodes) {
      const nodeState = this.requireNodeState(state, node.id);
      if ((nodeState.status === "failed" || nodeState.status === "blocked" || nodeState.status === "timed_out") && node.on_error?.strategy !== "continue") {
        return true;
      }
    }
    return false;
  }

  private isComplete(state: WorkflowRunState): boolean {
    return state.workflow.graph.nodes.every((node) => {
      const nodeState = this.requireNodeState(state, node.id);
      return nodeState.status === "succeeded" || nodeState.status === "skipped" || (isNodeFailure(nodeState.status) && node.on_error?.strategy === "continue");
    });
  }

  private timeoutFor(node: WorkflowNode): number {
    if (node.kind === "action" && node.action?.ref) {
      return this.registry.getAction(node.action.ref)?.manifest.timeoutMs ?? this.policy.defaultNodeTimeoutMs;
    }
    if (node.kind === "gate") {
      const gateRef = node.gate_ref;
      if (gateRef) {
        return this.registry.getGate(gateRef)?.manifest.timeoutMs ?? this.policy.defaultNodeTimeoutMs;
      }
    }
    return this.policy.defaultNodeTimeoutMs;
  }

  private retryDelay(attempts: number): number {
    const raw = this.policy.retry.initialDelayMs * Math.pow(this.policy.retry.backoffMultiplier, Math.max(0, attempts - 1));
    return Math.min(this.policy.retry.maxDelayMs, raw);
  }

  private async emit(state: WorkflowRunState, event: WorkflowEvent): Promise<void> {
    this.tracer.event(event.type, { run_id: event.run_id });
    await this.store.appendEvent(event);
    const updated = reduceEvent(state, event);
    await this.store.saveSnapshot(updated);
  }

  private async requireState(runId: string): Promise<WorkflowRunState> {
    const state = await this.store.loadSnapshot(runId);
    if (!state) throw new Error(`Unknown workflow run ${runId}`);
    return state;
  }

  private requireNode(workflow: WorkflowIR, nodeId: string): WorkflowNode {
    const node = workflow.graph.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    return node;
  }

  private requireNodeState(state: WorkflowRunState, nodeId: string): NodeRunState {
    const nodeState = state.node_states[nodeId];
    if (!nodeState) throw new Error(`Unknown node state ${nodeId}`);
    return nodeState;
  }
}

export function validateWorkflow(workflow: WorkflowIR): string[] {
  const errors: string[] = [];
  if (workflow.ir_version !== "workflow-ir/v1") errors.push("ir_version must be workflow-ir/v1");
  if (!workflow.workflow?.id) errors.push("workflow.id is required");
  if (!workflow.workflow?.version) errors.push("workflow.version is required");
  if (!workflow.workflow?.title) errors.push("workflow.title is required");
  const nodeIds = new Set<string>();
  for (const node of workflow.graph?.nodes ?? []) {
    if (!node.id) errors.push("graph.nodes[].id is required");
    if (nodeIds.has(node.id)) errors.push(`Duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    if (node.kind !== "action" && node.kind !== "gate") errors.push(`Unsupported node kind ${String(node.kind)}`);
  }
  for (const edge of workflow.graph?.edges ?? []) {
    if (!nodeIds.has(edge.from)) errors.push(`Edge ${edge.id} references unknown from node ${edge.from}`);
    if (!nodeIds.has(edge.to)) errors.push(`Edge ${edge.id} references unknown to node ${edge.to}`);
  }
  return errors;
}

export function replayEvents(events: WorkflowEvent[]): WorkflowRunState {
  const first = events[0];
  if (!first || first.type !== "run.started") throw new Error("Event log must start with run.started");
  return replayEventsWithWorkflow(first.workflow, events);
}

export function replayEventsWithWorkflow(workflow: WorkflowIR, events: WorkflowEvent[]): WorkflowRunState {
  const first = events[0];
  if (!first || first.type !== "run.started") throw new Error("Event log must start with run.started");
  let state = initialStateFromStarted(workflow, first);
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

export function createMergeGodValidationLaneAdapter(opts: {
  ref?: string;
  runCommand?: (cmd: string, ctx: AdapterContext) => { code: number; stdout: string; stderr: string };
} = {}): ActionAdapter {
  const ref = opts.ref ?? "merge-god.validation.run-lane";
  return {
    manifest: { ref, kind: "action", interruptible: false, idempotent: false },
    async execute(ctx) {
      const lane = stringValue(ctx.node.metadata?.["lane"]) ?? "default";
      const commands = recordValue(ctx.inputs["validation_lanes"]);
      const command = stringValue(commands[lane]) ?? stringValue(ctx.inputs["validation_command"]) ?? "true";
      const result = opts.runCommand ? opts.runCommand(command, ctx) : runShell(command);
      const outputs = {
        lane,
        command,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      if (result.code === 0) return { status: "succeeded", outputs };
      return {
        status: "failed",
        outputs,
        error: {
          code: "validation_failed",
          message: `Validation lane ${lane} failed with exit ${result.code}`,
          details: outputs,
        },
      };
    },
  };
}

export function createMergeGodFinalGateAdapter(ref = "merge-god.pr.final-gate"): ActionAdapter {
  return {
    manifest: { ref, kind: "action", interruptible: false, idempotent: true },
    async execute(ctx) {
      const failures = Object.values(ctx.state.node_states)
        .filter((node) => node.node_id !== ctx.node.id && (node.status === "failed" || node.status === "blocked" || node.status === "timed_out"))
        .map((node) => ({ node_id: node.node_id, status: node.status, error: node.error as unknown as JsonValue }));
      const mergeAllowed = failures.length === 0;
      return {
        status: "succeeded",
        outputs: {
          gate: mergeAllowed ? "passed" : "failed",
          merge_allowed: mergeAllowed,
          push_allowed: mergeAllowed,
          failed_nodes: failures as unknown as JsonValue,
          disposition_setting: ctx.inputs["disposition_setting"] ?? null,
        },
      };
    },
  };
}

export function createStaticGateAdapter(
  ref: string,
  decide: (ctx: AdapterContext, gate: GateDefinition) => GateDecision,
): GateAdapter {
  return {
    manifest: { ref, kind: "gate", interruptible: true, idempotent: true },
    async decide(ctx, gate) {
      return decide(ctx, gate);
    },
  };
}

function reduceEvent(state: WorkflowRunState, event: WorkflowEvent): WorkflowRunState {
  const next = clone(state);
  next.transition_count += event.type === "run.started" ? 0 : 1;
  next.updated_at = event.at;
  switch (event.type) {
    case "run.started":
      next.status = "running";
      break;
    case "run.pause_requested":
      next.pause_requested = true;
      break;
    case "run.paused":
      next.status = "paused";
      break;
    case "run.resumed":
      next.status = "running";
      next.pause_requested = false;
      break;
    case "run.cancel_requested":
      next.cancel_requested = true;
      break;
    case "run.cancelled":
      next.status = "cancelled";
      next.completed_at = event.at;
      break;
    case "run.completed":
      next.status = "completed";
      next.completed_at = event.at;
      break;
    case "run.failed":
      next.status = "failed";
      next.completed_at = event.at;
      break;
    case "run.timed_out":
      next.status = "timed_out";
      next.completed_at = event.at;
      break;
    case "node.ready":
      next.node_states[event.node_id]!.status = "ready";
      break;
    case "node.started":
      next.node_states[event.node_id]!.status = "running";
      next.node_states[event.node_id]!.attempts = event.attempt;
      next.node_states[event.node_id]!.started_at = event.at;
      break;
    case "node.succeeded":
      next.node_states[event.node_id]!.status = "succeeded";
      next.node_states[event.node_id]!.outputs = event.outputs;
      next.node_states[event.node_id]!.completed_at = event.at;
      break;
    case "node.skipped":
      next.node_states[event.node_id]!.status = "skipped";
      next.node_states[event.node_id]!.completed_at = event.at;
      break;
    case "node.failed":
      next.node_states[event.node_id]!.status = "failed";
      next.node_states[event.node_id]!.error = event.error;
      next.node_states[event.node_id]!.completed_at = event.at;
      break;
    case "node.blocked":
      next.node_states[event.node_id]!.status = "blocked";
      next.node_states[event.node_id]!.error = event.error;
      next.node_states[event.node_id]!.completed_at = event.at;
      break;
    case "node.timed_out":
      next.node_states[event.node_id]!.status = "timed_out";
      next.node_states[event.node_id]!.error = event.error;
      next.node_states[event.node_id]!.completed_at = event.at;
      break;
    case "gate.requested":
    case "gate.decided":
      break;
  }
  return next;
}

function initialStateFromStarted(workflow: WorkflowIR, event: Extract<WorkflowEvent, { type: "run.started" }>): WorkflowRunState {
  const nodeStates: Record<string, NodeRunState> = {};
  for (const node of workflow.graph.nodes) {
    nodeStates[node.id] = {
      node_id: node.id,
      status: "pending",
      attempts: 0,
      outputs: null,
      error: null,
      started_at: null,
      completed_at: null,
    };
  }
  return {
    run_id: event.run_id,
    workflow,
    status: "running",
    inputs: event.inputs,
    node_states: nodeStates,
    transition_count: 0,
    pause_requested: false,
    cancel_requested: false,
    created_at: event.at,
    updated_at: event.at,
    completed_at: null,
  };
}

function findGateDefinition(workflow: WorkflowIR, gateRef: string): GateDefinition | null {
  return workflow.gates?.definitions?.find((gate) => gate.id === gateRef) ?? null;
}

function mergePolicy(policy?: Partial<RuntimePolicy>): RuntimePolicy {
  return {
    ...DEFAULT_RUNTIME_POLICY,
    ...policy,
    retry: { ...DEFAULT_RUNTIME_POLICY.retry, ...(policy?.retry ?? {}) },
    pause: { ...DEFAULT_RUNTIME_POLICY.pause, ...(policy?.pause ?? {}) },
  };
}

function runShell(command: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function recordValue(v: JsonValue | undefined): JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
}

function stringValue(v: JsonValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function isNodeFailure(status: NodeStatus): boolean {
  return status === "failed" || status === "blocked" || status === "timed_out";
}

function isRunTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
