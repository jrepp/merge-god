import {
  PI_CONTEXT_VIEWS,
  PI_TOOL_NAMES,
  type PiToolName,
} from "./tool_contract";

export interface CoordinationRequest {
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}

export interface CoordinationResponse {
  ok: boolean;
  status: number;
  data: any;
}

export interface CoordinationClient {
  request(input: CoordinationRequest): Promise<CoordinationResponse>;
}

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface WorkItem {
  repo?: string;
  repo_path?: string;
  pr_number?: number;
  issue_number?: number;
  mode?: string;
  title?: string;
  prompt: string;
}

export type PlannedAgentInteraction =
  | {
    kind: "context";
    tool_name: typeof PI_TOOL_NAMES.context;
    view: typeof PI_CONTEXT_VIEWS[number];
    request: CoordinationRequest;
  }
  | {
    kind: "activity";
    tool_name: typeof PI_TOOL_NAMES.activity;
    action: string;
    request: CoordinationRequest | null;
  }
  | {
    kind: "follow_up";
    tool_name: typeof PI_TOOL_NAMES.follow_up;
    title: string;
    request: CoordinationRequest;
  }
  | {
    kind: "complete";
    tool_name: typeof PI_TOOL_NAMES.complete;
    status: string;
    summary: string;
    request: CoordinationRequest;
  };

const CONTEXT_ROUTES: Record<typeof PI_CONTEXT_VIEWS[number], string> = {
  work: "/work",
  trajectory: "/trajectory/summary",
  trajectory_full: "/trajectory",
  tooling: "/tooling",
  health: "/health",
};

const ACTIVITY_ROUTES: Record<string, string> = {
  event: "/trajectory/event",
  observe: "/observation",
  heartbeat: "/trajectory/heartbeat",
  propose: "/trajectory/propose-next",
  create_child: "/trajectory/child-activity",
  close_activity: "/trajectory/close-activity",
};

function recordParams(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function planAgentInteraction(toolName: PiToolName, params: unknown): PlannedAgentInteraction {
  const input = recordParams(params);
  if (toolName === PI_TOOL_NAMES.context) {
    const requestedView = typeof input["view"] === "string" ? input["view"] : "work";
    const view = PI_CONTEXT_VIEWS.includes(requestedView as typeof PI_CONTEXT_VIEWS[number])
      ? requestedView as typeof PI_CONTEXT_VIEWS[number]
      : "work";
    return {
      kind: "context",
      tool_name: toolName,
      view,
      request: { path: CONTEXT_ROUTES[view], method: "GET" },
    };
  }
  if (toolName === PI_TOOL_NAMES.activity) {
    const action = typeof input["action"] === "string" ? input["action"] : "";
    const path = ACTIVITY_ROUTES[action];
    delete input["action"];
    if (action === "create_child") {
      input["type"] = input["activity_type"];
      delete input["activity_type"];
    }
    return {
      kind: "activity",
      tool_name: toolName,
      action,
      request: path ? { path, method: "POST", body: input } : null,
    };
  }
  if (toolName === PI_TOOL_NAMES.follow_up) {
    return {
      kind: "follow_up",
      tool_name: toolName,
      title: typeof input["title"] === "string" ? input["title"] : "follow-up remediation",
      request: { path: "/follow-up-pr", method: "POST", body: input },
    };
  }
  return {
    kind: "complete",
    tool_name: PI_TOOL_NAMES.complete,
    status: typeof input["status"] === "string" ? input["status"] : "failure",
    summary: typeof input["summary"] === "string" ? input["summary"] : "",
    request: { path: "/result", method: "POST", body: input },
  };
}

export function formatWorkItem(item: WorkItem): string {
  const lines: string[] = ["# merge-god work item", ""];
  const meta: string[] = [];
  if (item.repo) meta.push(`- **Repository:** ${item.repo}`);
  if (item.repo_path) meta.push(`- **Repo path:** ${item.repo_path}`);
  if (item.pr_number) meta.push(`- **PR:** #${item.pr_number}`);
  if (item.issue_number) meta.push(`- **Issue:** #${item.issue_number}`);
  if (item.mode) meta.push(`- **Mode:** ${item.mode}`);
  if (item.title) meta.push(`- **Title:** ${item.title}`);
  if (meta.length) lines.push(...meta, "");
  lines.push("## Prompt", "", item.prompt.trim() || "_(no prompt body)_");
  return lines.join("\n");
}

export function interpretAgentInteraction(
  plan: PlannedAgentInteraction,
  response: CoordinationResponse,
): AgentToolResult {
  const { ok, status, data } = response;
  if (plan.kind === "context") {
    const work = data?.work as WorkItem | undefined;
    if (!ok || (plan.view === "work" && !work)) {
      return textResult(`merge-god ${plan.view} is unavailable (HTTP ${status}).`, {
        ok: false,
        status,
        view: plan.view,
      });
    }
    const text = plan.view === "work" && work
      ? formatWorkItem(work)
      : JSON.stringify(
        plan.view === "trajectory" || plan.view === "trajectory_full"
          ? data.trajectory
          : plan.view === "tooling" ? data.tooling : data,
        null,
        2,
      );
    return textResult(text, { ok: true, status, view: plan.view, data });
  }
  if (plan.kind === "activity") {
    if (!plan.request) {
      return textResult(`Unsupported activity action: ${plan.action}`, {
        ok: false,
        action: plan.action,
      });
    }
    return textResult(
      ok
        ? `merge-god activity ${plan.action} recorded.`
        : `merge-god activity ${plan.action} failed (HTTP ${status}).`,
      { ok, status, action: plan.action, data },
    );
  }
  if (plan.kind === "follow_up") {
    const url = data?.follow_up_pr?.url;
    return textResult(
      ok
        ? `Follow-up remediation PR opened: ${url || plan.title}`
        : `Failed to open follow-up remediation PR (HTTP ${status}): ${data?.error ?? "unknown error"}`,
      { ok, status, data },
    );
  }
  return textResult(
    ok
      ? `Result recorded by merge-god (${plan.status}): ${plan.summary}`
      : `Failed to record result with merge-god (HTTP ${status}).`,
    { ok, status, data },
  );
}

export function interactionFailure(plan: PlannedAgentInteraction, error: unknown): AgentToolResult {
  const message = error instanceof Error ? error.message : String(error);
  if (plan.kind === "activity") {
    return textResult(`merge-god activity ${plan.action} failed: ${message}`, {
      ok: false,
      action: plan.action,
      error: String(error),
    });
  }
  return textResult(`Failed to reach the merge-god coordination API: ${message}`, {
    ok: false,
    error: String(error),
  });
}

export function createAgentInteractionExecutor(client: CoordinationClient) {
  return async (toolName: PiToolName, params: unknown): Promise<AgentToolResult> => {
    const plan = planAgentInteraction(toolName, params);
    if (plan.kind === "activity" && !plan.request) {
      return interpretAgentInteraction(plan, { ok: false, status: 0, data: null });
    }
    try {
      return interpretAgentInteraction(plan, await client.request(plan.request!));
    } catch (error) {
      return interactionFailure(plan, error);
    }
  };
}

export function createFetchCoordinationClient(input: {
  fetch: typeof globalThis.fetch;
  baseUrl: () => string;
}): CoordinationClient {
  return {
    async request(request) {
      const response = await input.fetch(`${input.baseUrl().replace(/\/+$/, "")}${request.path}`, {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const text = await response.text();
      let data: any = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      return { ok: response.ok, status: response.status, data };
    },
  };
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: "text", text }], details };
}
