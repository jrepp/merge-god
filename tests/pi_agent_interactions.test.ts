import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createAgentInteractionExecutor,
  createFetchCoordinationClient,
  formatWorkItem,
  planAgentInteraction,
  type CoordinationClient,
  type CoordinationRequest,
  type CoordinationResponse,
} from "../pi/agent_interactions";
import { PI_CONTEXT_VIEWS, PI_TOOL_NAMES } from "../pi/tool_contract";

function recordingClient(
  response: CoordinationResponse | ((request: CoordinationRequest) => CoordinationResponse),
): { client: CoordinationClient; requests: CoordinationRequest[] } {
  const requests: CoordinationRequest[] = [];
  return {
    requests,
    client: {
      async request(request) {
        requests.push(request);
        return typeof response === "function" ? response(request) : response;
      },
    },
  };
}

describe("functional Pi agent interactions", () => {
  test("plans every context view without performing I/O", () => {
    const paths = ["/work", "/trajectory/summary", "/trajectory", "/tooling", "/health"];
    for (const [index, view] of PI_CONTEXT_VIEWS.entries()) {
      const plan = planAgentInteraction(PI_TOOL_NAMES.context, { view });
      assert.equal(plan.kind, "context");
      assert.deepEqual(plan.request, { path: paths[index], method: "GET" });
    }
    const fallback = planAgentInteraction(PI_TOOL_NAMES.context, { view: "unknown" });
    assert.equal(fallback.kind, "context");
    assert.equal(fallback.view, "work");
  });

  test("plans activity routes and transforms child inputs immutably", () => {
    const params = { action: "create_child", activity_type: "ci_fix", summary: "fix CI" };
    const plan = planAgentInteraction(PI_TOOL_NAMES.activity, params);
    assert.equal(plan.kind, "activity");
    assert.deepEqual(plan.request, {
      path: "/trajectory/child-activity",
      method: "POST",
      body: { type: "ci_fix", summary: "fix CI" },
    });
    assert.deepEqual(params, { action: "create_child", activity_type: "ci_fix", summary: "fix CI" });

    const observe = planAgentInteraction(PI_TOOL_NAMES.activity, { action: "observe", summary: "progress" });
    assert.equal(observe.kind, "activity");
    assert.equal(observe.request?.path, "/observation");

    const invalid = planAgentInteraction(PI_TOOL_NAMES.activity, { action: "invented" });
    assert.equal(invalid.kind, "activity");
    assert.equal(invalid.request, null);
  });

  test("executes and interprets all four tools through one injected client", async () => {
    const fake = recordingClient((request) => {
      if (request.path === "/work") {
        return {
          ok: true,
          status: 200,
          data: { work: { repo: "owner/repo", pr_number: 42, prompt: "Fix the PR" } },
        };
      }
      if (request.path === "/follow-up-pr") {
        return { ok: true, status: 200, data: { follow_up_pr: { url: "https://example.test/pr/7" } } };
      }
      return { ok: true, status: 200, data: { ok: true } };
    });
    const execute = createAgentInteractionExecutor(fake.client);

    const context = await execute(PI_TOOL_NAMES.context, { view: "work" });
    assert.match(context.content[0]?.text ?? "", /Repository:\*\* owner\/repo/);
    assert.match(context.content[0]?.text ?? "", /Fix the PR/);

    const activity = await execute(PI_TOOL_NAMES.activity, { action: "heartbeat", phase: "testing" });
    assert.equal(activity.details["action"], "heartbeat");

    const followUp = await execute(PI_TOOL_NAMES.follow_up, { title: "Repair API" });
    assert.match(followUp.content[0]?.text ?? "", /https:\/\/example\.test\/pr\/7/);

    const complete = await execute(PI_TOOL_NAMES.complete, { status: "success", summary: "done" });
    assert.match(complete.content[0]?.text ?? "", /\(success\): done/);

    assert.deepEqual(fake.requests.map((request) => request.path), [
      "/work",
      "/trajectory/heartbeat",
      "/follow-up-pr",
      "/result",
    ]);
  });

  test("normalizes invalid actions and client failures without throwing", async () => {
    let calls = 0;
    const execute = createAgentInteractionExecutor({
      async request() {
        calls += 1;
        throw new Error("connection reset");
      },
    });
    const invalid = await execute(PI_TOOL_NAMES.activity, { action: "invented" });
    assert.equal(invalid.details["ok"], false);
    assert.match(invalid.content[0]?.text ?? "", /Unsupported activity action/);
    assert.equal(calls, 0);

    const failed = await execute(PI_TOOL_NAMES.complete, { status: "success", summary: "done" });
    assert.equal(failed.details["ok"], false);
    assert.match(failed.content[0]?.text ?? "", /connection reset/);
    assert.equal(calls, 1);
  });

  test("adapts fetch at the boundary and preserves malformed response evidence", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("not-json", { status: 502 });
    }) as typeof globalThis.fetch;
    const client = createFetchCoordinationClient({
      fetch: fetchImpl,
      baseUrl: () => "http://127.0.0.1:7780/",
    });
    const response = await client.request({
      path: "/result",
      method: "POST",
      body: { status: "failure" },
    });
    assert.deepEqual(response, { ok: false, status: 502, data: { raw: "not-json" } });
    assert.equal(calls[0]?.url, "http://127.0.0.1:7780/result");
    assert.equal(calls[0]?.init?.body, JSON.stringify({ status: "failure" }));
  });

  test("formats work items as a pure value transformation", () => {
    assert.equal(
      formatWorkItem({ repo: "owner/repo", issue_number: 9, title: "Repair", prompt: "" }),
      [
        "# merge-god work item",
        "",
        "- **Repository:** owner/repo",
        "- **Issue:** #9",
        "- **Title:** Repair",
        "",
        "## Prompt",
        "",
        "_(no prompt body)_",
      ].join("\n"),
    );
  });
});
