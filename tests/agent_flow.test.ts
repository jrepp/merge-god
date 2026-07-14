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
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CoordinationServer,
  DEFAULT_INSTRUCTION,
  buildPiExtensionInjection,
  linkNodeModulesIntoWorktree,
  loadPiDotEnv,
  type CoordinationTrajectoryBridge,
  type PiAgentResult,
} from "../coordination";
import { PI_TOOL_NAMES, PI_TOOL_SURFACE } from "../pi/tool_contract";
import {
  evidenceSummaryFromPrContext,
  renderReviewGateStatusComment,
} from "../evidence_comment";
import { analyzeMergeBlockers, inferMergeQueueContext } from "../merge_pr_model";
import {
  agentAnnotationLabelsForCompletion,
  agentAnnotationLabelsFromResult,
  agentTokenUsageFromResult,
  classifyPrFailureState,
  inferredAgentAnnotationLabelsFromFailure,
  mergeGodRuntimeTelemetry,
  piAgentFailureReason,
} from "../pr-loop";
import { reviewGateStatusesFromContext } from "../review_gate_status";
import { GitOps } from "../git_ops";
import { PiAgentHarness } from "./helpers/pi_agent_harness";

class MockTrajectoryBridge implements CoordinationTrajectoryBridge {
  events: unknown[] = [];
  childActivityInputs: Array<{
    type: string;
    summary: string;
    model_tier?: string;
    model_reason?: string;
    prompt_runtime_ref?: string | null;
    context_pack_refs?: string[];
    evidence_refs?: string[];
    metadata?: Record<string, unknown>;
  }> = [];

  getState(): unknown {
    return { run: { run_id: "run-1", status: "executing" }, events: this.events };
  }

  appendEvent(input: unknown): unknown {
    this.events.push(input);
    return { event_id: `event-${this.events.length}` };
  }

  heartbeat(input: Record<string, unknown>): unknown {
    return { ok: true, phase: input["phase"] ?? null };
  }

  proposeNext(input: { next_action: string }): unknown {
    return { accepted: input.next_action === "continue", next_action: input.next_action };
  }

  createChildActivity(input: MockTrajectoryBridge["childActivityInputs"][number]): unknown {
    this.childActivityInputs.push(input);
    return { accepted: input.type === "ci_fix", child_activity_id: "child-1" };
  }
}

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
    const bridge = new MockTrajectoryBridge();
    const s = new CoordinationServer("127.0.0.1", 0, bridge);
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
      assert.equal(bridge.events.length, 1);

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
        body: JSON.stringify({
          type: "ci_fix",
          summary: "fix failing check",
          model_tier: "fast",
          model_reason: "Small scoped CI fix can use fast model quality.",
        }),
      });
      const childBody = (await childRes.json()) as {
        ok: boolean;
        activity: { accepted: boolean; child_activity_id: string };
      };
      assert.equal(childRes.status, 200);
      assert.equal(childBody.activity.accepted, true);
      assert.equal(childBody.activity.child_activity_id, "child-1");
      assert.deepEqual(bridge.childActivityInputs, [
        {
          type: "ci_fix",
          summary: "fix failing check",
          model_tier: "fast",
          model_reason: "Small scoped CI fix can use fast model quality.",
          prompt_runtime_ref: null,
          context_pack_refs: [],
          evidence_refs: [],
          metadata: {},
        },
      ]);
    } finally {
      await s.stop();
    }
  });

  test("trajectory child activity endpoint rejects missing model quality", async () => {
    const bridge = new MockTrajectoryBridge();
    const s = new CoordinationServer("127.0.0.1", 0, bridge);
    await s.start();
    try {
      const res = await fetch(`${s.baseUrl}/trajectory/child-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "ci_fix", summary: "fix failing check" }),
      });
      const body = (await res.json()) as { ok: boolean; error: string };

      assert.equal(res.status, 400);
      assert.equal(body.ok, false);
      assert.match(body.error, /model_tier/);
      assert.deepEqual(bridge.childActivityInputs, []);
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

  test("captures the injected Pi tool surface and paired call reliability", async () => {
    const bridge = new MockTrajectoryBridge();
    const s = new CoordinationServer("127.0.0.1", 0, bridge);
    s.setAgentTraceContext({
      trace_id: "1".repeat(32),
      parent_span_id: "2".repeat(16),
      traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
      run_id: "run-1",
      activity_id: "activity-1",
    }, "/extension/index.ts");
    await s.start();
    try {
      const surfaceRes = await fetch(`${s.baseUrl}/tool-surface`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tools: [{
            name: PI_TOOL_NAMES.context,
            label: "merge-god context",
            description: "Load context",
            parameter_schema: { type: "object", properties: {} },
            prompt_guideline_count: 1,
          }],
        }),
      });
      assert.equal(surfaceRes.status, 200);

      for (const payload of [
        {
          phase: "started",
          call_id: "call-1",
          tool_name: PI_TOOL_NAMES.context,
          started_at: "2026-07-13T12:00:00.000Z",
          input_keys: [],
        },
        {
          phase: "completed",
          call_id: "call-1",
          tool_name: PI_TOOL_NAMES.context,
          started_at: "2026-07-13T12:00:00.000Z",
          duration_ms: 12,
          success: true,
        },
      ]) {
        const res = await fetch(`${s.baseUrl}/tool-call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 200);
      }
      const incompleteRes = await fetch(`${s.baseUrl}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phase: "started",
          call_id: "call-2",
          tool_name: PI_TOOL_NAMES.context,
          started_at: new Date().toISOString(),
          input_keys: [],
        }),
      });
      assert.equal(incompleteRes.status, 200);
      await s.finalizeToolCalls();

      const toolingRes = await fetch(`${s.baseUrl}/tooling`);
      const body = (await toolingRes.json()) as {
        tooling: {
          surface: Array<{ name: string }>;
          calls: Array<{ status: string; duration_ms: number }>;
          reliability: { completion_ratio: number; succeeded: number; failed: number; incomplete: number };
        };
      };
      assert.deepEqual(body.tooling.surface.map((tool) => tool.name), [PI_TOOL_NAMES.context]);
      assert.equal(body.tooling.calls.length, 2);
      assert.equal(body.tooling.calls[0]?.status, "succeeded");
      assert.equal(body.tooling.calls[0]?.duration_ms, 12);
      assert.equal(body.tooling.calls[1]?.status, "incomplete");
      assert.equal(body.tooling.reliability.completion_ratio, 0.5);
      assert.equal(body.tooling.reliability.succeeded, 1);
      assert.equal(body.tooling.reliability.failed, 0);
      assert.equal(body.tooling.reliability.incomplete, 1);
      assert.deepEqual(
        bridge.events.map((event) => (event as { event_type: string }).event_type),
        [
          "pi.tool_surface.registered",
          "pi.tool_call.started",
          "pi.tool_call.completed",
          "pi.tool_call.started",
          "pi.tool_call.incomplete",
        ],
      );
    } finally {
      await s.stop();
    }
  });
});

describe("PR context inference", () => {
  test("infers merge queue lineage from title and merge commits", () => {
    const blockers = [
      {
        kind: "review_required" as const,
        status: "blocked" as const,
        summary: "GitHub requires review before this PR can merge.",
        evidence_refs: ["github:reviewDecision"],
      },
    ];
    const context = inferMergeQueueContext(
      { title: "Merge queue: PRs 178, 179, 180" },
      {
        commits: [
          {
            sha: "abc1234",
            commit: {
              message: "Merge PR #178\n\n# Conflicts:\n#\tapps/chat/src/ChatApp.tsx",
            },
          },
          {
            sha: "def5678",
            commit: {
              message: "Merge origin/main into PR 183 merge queue\n\n# Conflicts:\n#\tapps/chat/src/useBridge.ts",
            },
          },
        ],
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-1",
            body: [
              "- `npm run typecheck` -> passed.",
              "- #178 `npm test -- bridge` -> failed.",
              "- `npm run lint -- apps/chat` -> blocked (scope: apps/chat)",
            ].join("\n"),
          },
        ],
      },
      blockers,
    );

    assert.ok(context !== null);
    assert.equal(context!.is_queue, true);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [178, "blocked"],
        [179, "queued"],
        [180, "queued"],
      ],
    );
    assert.equal(context!.merge_commits.length, 2);
    assert.deepEqual(context!.merge_commits[0]!.conflict_files, ["apps/chat/src/ChatApp.tsx"]);
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm run typecheck",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-1",
      },
      {
        command: "npm test -- bridge",
        status: "failed",
        scope: "#178",
        evidence_ref: "https://example.test/pull/183#issuecomment-1",
      },
      {
        command: "npm run lint -- apps/chat",
        status: "blocked",
        scope: "apps/chat",
        evidence_ref: "https://example.test/pull/183#issuecomment-1",
      },
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      ...blockers,
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #178 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/183#issuecomment-1"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope apps/chat has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/183#issuecomment-1"],
      },
    ]);
  });

  test("promotes path-scoped and queue-wide validation evidence into blockers", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- `npm run typecheck` -> inconclusive",
              "- scope: packages/api npm run lint -- api -> failed",
              "- scope: packages/ui `npm run test -- ui` -> pending",
              "- #201 `npm run test -- foo` -> passed",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue-wide validation has 1 inconclusive validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue validation scope packages/ui has 1 inconclusive validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/203#issuecomment-validation"],
      },
    ]);
    assert.deepEqual(
      context!.validation_evidence.find((item) => item.scope === "packages/api"),
      {
        command: "npm run lint -- api",
        status: "failed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
    );
  });

  test("enriches queue constituents from PR body and comment evidence", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue",
        body: [
          "Queue contains:",
          "- [#178](https://github.example.test/org/repo/pull/178) - Add bridge support head:abc123def",
          "- #179: Stabilize renderer @team",
          "- [PR #181](https://github.example.test/org/repo/pull/181) Payment retry head=1234567",
          "- PR #182 Observability cleanup sha=7654321",
        ].join("\n"),
      },
      {
        commits: [
          {
            sha: "abc1234",
            commit: { message: "Merge PR #178" },
          },
        ],
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-2",
            body: [
              "- #180: Follow-up validation sha:def456789",
              "- https://github.example.test/org/repo/pull/183 - Docs queue note head:fedcba9",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.url, pr.head_sha, pr.status]),
      [
        [178, "Add bridge support", "https://github.example.test/org/repo/pull/178", "abc123def", "merged_into_queue"],
        [179, "Stabilize renderer @team", null, null, "queued"],
        [180, "Follow-up validation", null, "def456789", "queued"],
        [181, "Payment retry", "https://github.example.test/org/repo/pull/181", "1234567", "queued"],
        [182, "Observability cleanup", null, "7654321", "queued"],
        [183, "Docs queue note", "https://github.example.test/org/repo/pull/183", "fedcba9", "queued"],
      ],
    );
    assert.deepEqual(context!.constituent_prs.find((pr) => pr.number === 180)!.evidence_refs, [
      "https://example.test/pull/183#issuecomment-2",
      "pr:#180",
    ]);
    assert.deepEqual(context!.constituent_prs.find((pr) => pr.number === 183)!.evidence_refs, [
      "https://example.test/pull/183#issuecomment-2",
      "pr:#183",
    ]);
  });

  test("derives manual queue strategy and constituent status from scoped validation", () => {
    const context = inferMergeQueueContext(
      {
        title: "Merge queue",
        body: [
          "Manual queue:",
          "- #178: Add bridge support",
          "- #179: Stabilize renderer",
          "- #180: Refresh snapshots",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/183#issuecomment-validation",
            body: [
              "- #178 `npm test -- bridge` -> passed.",
              "- #179 `npm test -- renderer` -> failed.",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [178, "validated"],
        [179, "blocked"],
        [180, "queued"],
      ],
    );
    assert.deepEqual(context!.constituent_prs.find((pr) => pr.number === 178)!.evidence_refs, [
      "github:pr-body",
      "https://example.test/pull/183#issuecomment-validation",
      "pr:#178",
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "ci_failed",
        status: "blocked",
        summary: "Queue constituent PR #179 has 1 failed or blocked validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/183#issuecomment-validation"],
      },
    ]);
  });

  test("uses body hints for stack and batch queue titles without merge commits", () => {
    const context = inferMergeQueueContext(
      {
        title: "Stack validation lane",
        body: [
          "Stack constituents:",
          "- [ ] #184: Add account settings head=abc1840",
          "- PR #185 Billing cleanup sha=abc1850",
        ].join("\n"),
      },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/186#issuecomment-validation",
            body: "- #184 `npm run test -- account` -> passed",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "manual");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.title, pr.head_sha, pr.status]),
      [
        [184, "Add account settings", "abc1840", "validated"],
        [185, "Billing cleanup", "abc1850", "queued"],
      ],
    );
    assert.deepEqual(context!.constituent_prs.find((pr) => pr.number === 184)!.evidence_refs, [
      "github:pr-body",
      "https://example.test/pull/186#issuecomment-validation",
      "pr:#184",
    ]);
  });

  test("ignores incidental title numbers when inferring queue constituents", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue 2026-07-01 batch 14: PRs 178, 179 and #180" },
      {
        commits: [
          {
            sha: "abc1234",
            commit: { message: "Merge PR #178" },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => pr.number),
      [178, 179, 180],
    );
  });

  test("recognizes standard GitHub merge commit subjects", () => {
    const context = inferMergeQueueContext(
      { title: "Merge queue" },
      {
        commits: [
          {
            sha: "abc1234",
            commit: {
              message: [
                "Merge pull request #181 from owner/feature",
                "",
                "# Conflicts:",
                "#\tpackages/api/src/index.ts",
                "#\tpackages/api/src/routes.ts",
                "",
                "# Please enter a commit message to explain why this merge is necessary.",
              ].join("\n"),
            },
          },
        ],
        comments: [],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [[181, "merged_into_queue"]],
    );
    assert.equal(context!.merge_commits[0]!.pr_number, 181);
    assert.deepEqual(context!.merge_commits[0]!.conflict_files, [
      "packages/api/src/index.ts",
      "packages/api/src/routes.ts",
    ]);
  });

  test("recognizes merge batch titles and richer validation evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #201 and #202" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/203#issuecomment-validation",
            body: [
              "- [x] #201 `npm run test -- foo`",
              "- #202 npm run lint -> failed",
            ].join("\n"),
          },
        ],
        review_comments: [
          {
            html_url: "https://example.test/pull/203#discussion_r1",
            body: "- PR #202 `npm run typecheck` => blocked",
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.equal(context!.strategy, "title_pr_list");
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [201, "validated"],
        [202, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm run test -- foo",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run lint",
        status: "failed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run typecheck",
        status: "blocked",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#discussion_r1",
      },
    ]);
    assert.deepEqual(context!.constituent_prs.find((pr) => pr.number === 202)!.evidence_refs, [
      "https://example.test/pull/203#issuecomment-validation",
      "https://example.test/pull/203#discussion_r1",
      "pr:#202",
    ]);
  });

  test("recognizes emoji and markdown table validation evidence", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #203 and #204" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/205#issuecomment-table",
            body: [
              "| Scope | Command | Result |",
              "| --- | --- | --- |",
              "| #203 | npm run test -- api | ✅ |",
              "| PR #204 | npm run test -- ui | ❌ failed |",
              "| scope: packages/api | npm run lint -- api | 🚧 |",
              "- #203 npm run typecheck:api => ✔",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [203, "validated"],
        [204, "blocked"],
      ],
    );
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm run test -- api",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/205#issuecomment-table",
      },
      {
        command: "npm run test -- ui",
        status: "failed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/205#issuecomment-table",
      },
      {
        command: "npm run lint -- api",
        status: "blocked",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/205#issuecomment-table",
      },
      {
        command: "npm run typecheck:api",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/205#issuecomment-table",
      },
    ]);
  });

  test("marks constituents unknown when scoped validation outcome is unknown", () => {
    const context = inferMergeQueueContext(
      { title: "Merge PRs #205 and #206" },
      {
        commits: [],
        comments: [
          {
            html_url: "https://example.test/pull/207#issuecomment-unknown",
            body: [
              "- [ ] #205 `npm run smoke -- waiting`",
              "- #205 `npm run unit` -> passed",
              "- #206 `npm run test -- api` -> passed",
              "- #207 `npm run e2e` -> skipped",
            ].join("\n"),
          },
        ],
      },
    );

    assert.ok(context !== null);
    assert.deepEqual(
      context!.constituent_prs.map((pr) => [pr.number, pr.status]),
      [
        [205, "unknown"],
        [206, "validated"],
        [207, "unknown"],
      ],
    );
    assert.deepEqual(context!.validation_evidence, [
      {
        command: "npm run smoke -- waiting",
        status: "unknown",
        scope: "#205",
        evidence_ref: "https://example.test/pull/207#issuecomment-unknown",
      },
      {
        command: "npm run unit",
        status: "passed",
        scope: "#205",
        evidence_ref: "https://example.test/pull/207#issuecomment-unknown",
      },
      {
        command: "npm run test -- api",
        status: "passed",
        scope: "#206",
        evidence_ref: "https://example.test/pull/207#issuecomment-unknown",
      },
      {
        command: "npm run e2e",
        status: "unknown",
        scope: "#207",
        evidence_ref: "https://example.test/pull/207#issuecomment-unknown",
      },
    ]);
    assert.deepEqual(context!.unresolved_blockers, [
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue constituent PR #205 has 1 inconclusive validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/207#issuecomment-unknown"],
      },
      {
        kind: "unknown",
        status: "unknown",
        summary: "Queue constituent PR #207 has 1 inconclusive validation evidence item(s).",
        evidence_refs: ["https://example.test/pull/207#issuecomment-unknown"],
      },
    ]);
  });

  test("does not treat a single incidental PR reference as a queue", () => {
    const context = inferMergeQueueContext(
      { title: "Fix flaky test mentioned in PR 201" },
      {
        commits: [],
        comments: [],
      },
    );

    assert.equal(context, null);
  });

  test("analyzes review, CI, diff, and merge-state blockers", () => {
    const blockers = analyzeMergeBlockers(
      {
        isDraft: true,
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BLOCKED",
      },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 0, failed: 0, pending: 0 },
        diff_availability: {
          available: false,
          source: "gh-pr-diff",
          size: 0,
          truncated: true,
          error: "diff exceeded the maximum number of lines",
        },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => blocker.kind),
      ["draft", "review_required", "merge_state_blocked", "ci_missing", "diff_unavailable"],
    );
    assert.equal(blockers.find((blocker) => blocker.kind === "diff_unavailable")?.status, "blocked");
    assert.equal(blockers.find((blocker) => blocker.kind === "draft")?.summary, "GitHub reports this PR is still marked as draft.");
  });

  test("analyzes unclassified CI checks as unknown blockers", () => {
    const blockers = analyzeMergeBlockers(
      {},
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, passed: 0, failed: 0, pending: 0, unknown: 1 },
        diff_availability: { available: true, source: "gh-pr-diff", size: 42, truncated: false, error: null },
      },
    );

    assert.deepEqual(
      blockers.map((blocker) => [blocker.kind, blocker.status, blocker.summary]),
      [["unknown", "unknown", "1 CI check(s) could not be classified."]],
    );
  });

  test("preserves non-clean GitHub merge states as blocker evidence", () => {
    const baseContext = {
      conflicts: { has_conflicts: false, conflicting_files: [] },
      ci_status: { total_checks: 1, failed: 0, pending: 0 },
      diff_availability: { available: true, source: "gh-pr-diff", size: 42, truncated: false, error: null },
    };

    assert.deepEqual(
      analyzeMergeBlockers({ mergeStateStatus: "DIRTY" }, baseContext).map((blocker) => [
        blocker.kind,
        blocker.status,
        blocker.summary,
      ]),
      [["merge_state_blocked", "blocked", "GitHub reports the PR merge state as DIRTY."]],
    );
    assert.deepEqual(
      analyzeMergeBlockers({ mergeStateStatus: "BEHIND" }, baseContext).map((blocker) => [
        blocker.kind,
        blocker.status,
        blocker.summary,
      ]),
      [["merge_state_blocked", "pending", "GitHub reports the PR merge state as BEHIND."]],
    );
    assert.deepEqual(
      analyzeMergeBlockers({ mergeStateStatus: "UNKNOWN" }, baseContext).map((blocker) => [
        blocker.kind,
        blocker.status,
        blocker.summary,
      ]),
      [["merge_state_blocked", "unknown", "GitHub reports the PR merge state as UNKNOWN."]],
    );
    assert.deepEqual(
      analyzeMergeBlockers({ mergeStateStatus: "CLEAN", mergeable: false }, baseContext).map((blocker) => [
        blocker.kind,
        blocker.status,
        blocker.summary,
      ]),
      [["merge_state_blocked", "blocked", "GitHub reports this PR is not mergeable."]],
    );
  });
});

describe("agent flow: runPiAgent result contract", () => {
  test("keeps Pi startup instruction compact and delegates detail to explicit tools", () => {
    assert.deepEqual(PI_TOOL_SURFACE, ["mg_context", "mg_activity", "mg_follow_up", "mg_complete"]);
    assert.ok(DEFAULT_INSTRUCTION.length < 500);
    assert.match(DEFAULT_INSTRUCTION, new RegExp(PI_TOOL_NAMES.context));
    assert.match(DEFAULT_INSTRUCTION, new RegExp(PI_TOOL_NAMES.activity));
    assert.doesNotMatch(DEFAULT_INSTRUCTION, /merge_god_trajectory_state|merge_god_debug_snapshot/);
    const injection = buildPiExtensionInjection({
      extension_path: "/tmp/merge-god-extension.ts",
      api_url: "http://127.0.0.1:1234",
      instruction: DEFAULT_INSTRUCTION,
      trace_context: {
        trace_id: "1".repeat(32),
        parent_span_id: "2".repeat(16),
        traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
      },
    });
    assert.deepEqual(injection.expected_tools, PI_TOOL_SURFACE);
    assert.deepEqual(injection.cli_args.slice(0, 6), [
      "--print", "--mode", "json", "--no-session", "--extension", "/tmp/merge-god-extension.ts",
    ]);
    assert.equal(injection.environment["MERGE_GOD_API"], "http://127.0.0.1:1234");
  });

  test("PiAgentResult carries the four fields (returncode/stdout/stderr/result)", () => {
    // Shape contract: runPiAgent returns an object (the TS analogue of Python's
    // `(returncode, stdout, stderr, result)` 4-tuple). A result is recorded by
    // the agent only if it calls mg_complete; otherwise it is null.
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

  test("piAgentFailureReason prefers completion errors for copyable failure logs", () => {
    assert.equal(
      piAgentFailureReason(
        0,
        { status: "failure", summary: "could not land", error: "merge conflict remained" },
        "ignored stderr",
        "ignored stdout",
      ),
      "merge conflict remained",
    );
    assert.equal(
      piAgentFailureReason(1, null, "fatal: missing credential\nretry failed", ""),
      "pi exited 1: fatal: missing credential retry failed",
    );
    assert.equal(piAgentFailureReason(1, null, "", ""), "pi exited 1");
  });

  test("classifyPrFailureState separates blocked failures from ordinary failures", () => {
    assert.equal(classifyPrFailureState("needs credentials before continuing"), "blocked");
    assert.equal(classifyPrFailureState("test suite failed"), "failed");
    assert.equal(classifyPrFailureState("", { error: "manual approval required" }), "blocked");
  });

  test("reviewGateStatusesFromContext projects modeled blockers into gate rows", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, passed: 1 },
        merge_blockers: [
          {
            kind: "merge_state_blocked",
            status: "pending",
            summary: "GitHub reports the PR merge state as BEHIND.",
            evidence_refs: ["github:mergeStateStatus"],
          },
        ],
      },
      "",
    );

    assert.deepEqual(
      gates.map((gate) => [gate.rule, gate.status]),
      [
        ["context-gathered", "pass"],
        ["modeled-blockers", "pending"],
        ["merge-conflicts", "pass"],
        ["ci-status", "pass"],
        ["review-decision", "pass"],
        ["repo-merge-rules", "skipped"],
      ],
    );
    assert.equal(
      gates.find((gate) => gate.rule === "modeled-blockers")?.explanation,
      "merge_state_blocked: GitHub reports the PR merge state as BEHIND.",
    );
  });

  test("reviewGateStatusesFromContext includes queue unresolved blockers", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue constituent PR #179 has 1 failed or blocked validation evidence item(s).",
              evidence_refs: ["https://example.test/comment"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue constituent PR #179 has 1 failed or blocked validation evidence item(s).",
      },
    );
  });

  test("reviewGateStatusesFromContext prioritizes severe blocker explanations", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: Array.from({ length: 6 }, (_, index) => ({
          kind: "merge_state_blocked",
          status: "pending",
          summary: `Pending blocker ${index + 1}.`,
          evidence_refs: [`pending:${index + 1}`],
        })),
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
              evidence_refs: ["https://example.test/comment"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: [
          "ci_failed: Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
          "merge_state_blocked: Pending blocker 1.",
          "merge_state_blocked: Pending blocker 2.",
          "merge_state_blocked: Pending blocker 3.",
          "merge_state_blocked: Pending blocker 4.",
        ].join("; "),
      },
    );
  });

  test("reviewGateStatusesFromContext treats unknown queue validation as non-passing", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            {
              kind: "unknown",
              status: "unknown",
              summary: "Queue constituent PR #205 has 1 inconclusive validation evidence item(s).",
              evidence_refs: ["https://example.test/comment"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "unknown",
        explanation: "unknown: Queue constituent PR #205 has 1 inconclusive validation evidence item(s).",
      },
    );
  });

  test("reviewGateStatusesFromContext gives blocked queue validation precedence", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
        queue_context: {
          is_queue: true,
          unresolved_blockers: [
            {
              kind: "unknown",
              status: "unknown",
              summary: "Queue constituent PR #205 has 1 inconclusive validation evidence item(s).",
              evidence_refs: ["https://example.test/comment"],
            },
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).",
              evidence_refs: ["https://example.test/comment"],
            },
          ],
        },
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "modeled-blockers"),
      {
        rule: "modeled-blockers",
        status: "blocked",
        explanation: "ci_failed: Queue validation scope packages/api has 1 failed or blocked validation evidence item(s).; unknown: Queue constituent PR #205 has 1 inconclusive validation evidence item(s).",
      },
    );
  });

  test("reviewGateStatusesFromContext treats required review as blocking", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "REVIEW_REQUIRED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "review-decision"),
      {
        rule: "review-decision",
        status: "blocked",
        explanation: "GitHub requires review before this PR can merge.",
      },
    );
  });

  test("reviewGateStatusesFromContext treats unknown CI as non-passing", () => {
    const gates = reviewGateStatusesFromContext(
      { reviewDecision: "APPROVED" },
      {
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 1, passed: 0 },
        merge_blockers: [],
      },
      "",
    );

    assert.deepEqual(
      gates.find((gate) => gate.rule === "ci-status"),
      {
        rule: "ci-status",
        status: "unknown",
        explanation: "0 failed, 0 pending, 1 unknown, 0 passed out of 1 check(s).",
      },
    );
  });

  test("renderReviewGateStatusComment sanitizes non-authoritative gate cache rows", () => {
    const rendered = renderReviewGateStatusComment(
      [
        {
          rule: "merge | gate <script>",
          status: "pwned",
          explanation: "needs @ops `approval` | <img src=x onerror=alert(1)>",
        },
      ],
      "2026-06-30T00:00:00.000Z",
    );
    assert.match(rendered, /merge-god-review-gate-cache:v1/);
    assert.match(rendered, /\*\*Required action:\*\*/);
    assert.match(rendered, /reviewer summary/);
    assert.match(rendered, /merge \\| gate &lt;script&gt;/);
    assert.match(rendered, /\| unknown \|/);
    assert.match(rendered, /needs &#64;ops &#96;approval&#96; \\| &lt;img/);
    assert.doesNotMatch(rendered, /<script>|@ops|\(at\)ops|`approval`/);
  });

  test("renderReviewGateStatusComment includes merge queue evidence summary", () => {
    const queueContext = inferMergeQueueContext(
      {
        title: "Merge queue: PRs #178 and #179",
        body: "- #178 Add bridge support\n- #179 Renderer cleanup @team",
      },
      {
        commits: [
          {
            sha: "abcdef123456",
            commit: {
              message: "Merge PR #178\n\n# Conflicts:\n#\tapps/chat/src/ChatApp.tsx",
            },
          },
        ],
        comments: [
          {
            html_url: "https://example.test/comment",
            body: [
              "- #178 `npm run typecheck` -> passed",
              "- #178 `npm run lint` -> passed",
              "- #178 `npm run test -- api` -> passed",
              "- #179 `npm run test -- ui` -> pending",
              "- #179 `npm run build` -> passed",
              "- #179 `npm run e2e` -> blocked",
              "- #179 `npm run smoke` -> passed",
              "- #179 `npm run audit` -> passed",
            ].join("\n"),
          },
        ],
      },
      [
        {
          kind: "review_required",
          status: "blocked",
          summary: "GitHub requires review before this PR can merge.",
          evidence_refs: ["aaa:queue-unresolved-review", "github:reviewDecision"],
        },
      ],
    );
    assert.ok(queueContext !== null);

    const evidence = evidenceSummaryFromPrContext({
      ci_status: {
        total_checks: 4,
        passed: 1,
        failed: 1,
        pending: 1,
        unknown: 1,
        skipped: 0,
        failed_checks: [
          {
            name: "build | deploy @ops",
            conclusion: "FAILURE",
            details_url: "https://example.test/checks/1",
          },
        ],
        pending_checks: [
          {
            name: "deploy preview @ops",
            status: "IN_PROGRESS",
            details_url: "https://example.test/checks/deploy",
          },
        ],
        unknown_checks: [
          {
            name: "manual gate @ops",
            state: "ACTION_REQUIRED",
            details_url: "https://example.test/checks/manual",
          },
        ],
      },
      diff_availability: {
        available: false,
        source: "gh-pr-diff",
        size: 0,
        truncated: true,
        error: "diff exceeded maximum lines for @team",
      },
      merge_blockers: [
        {
          kind: "review_required",
          status: "blocked",
          summary: "GitHub requires review before this PR can merge.",
          evidence_refs: ["github:reviewDecision", "comment:@ops|gate"],
        },
      ],
      queue_context: queueContext,
    });

    const rendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "pass", explanation: "context captured" }],
      "2026-06-30T00:00:00.000Z",
      evidence,
    );

    assert.match(rendered, /## Evidence summary/);
    assert.match(rendered, /CI checks \| blocked \| 1 failed, 1 pending, 1 unknown, 1 passed, 0 skipped out of 4 check\(s\)\. Failed: build \\\| deploy &#64;ops \(FAILURE, https:\/\/example.test\/checks\/1\) Pending: deploy preview &#64;ops \(IN_PROGRESS, https:\/\/example.test\/checks\/deploy\) Unknown: manual gate &#64;ops \(ACTION_REQUIRED, https:\/\/example.test\/checks\/manual\)/);
    assert.match(rendered, /Diff availability \| blocked/);
    assert.match(rendered, /diff exceeded maximum lines for &#64;team/);
    assert.match(rendered, /review_required \| blocked/);
    assert.match(rendered, /Evidence refs \| 11 \|/);
    assert.match(rendered, /gh:pr-diff/);
    assert.doesNotMatch(rendered, /aaa:queue-unresolved-review/);
    assert.match(rendered, /https:\/\/example.test\/checks\/1/);
    assert.match(rendered, /comment:&#64;ops\\\|gate/);
    assert.match(rendered, /github:reviewDecision/);
    assert.match(rendered, /## Merge queue evidence/);
    assert.match(rendered, /Constituent PRs \| 2 \| #179, #178/);
    assert.match(rendered, /Constituent status \| 2 \| #179 \(blocked, Renderer cleanup &#64;team\); #178 \(validated, Add bridge support\)/);
    assert.match(rendered, /abcdef12 \(#178\)/);
    assert.match(rendered, /Conflict files \| 1 \| apps\/chat\/src\/ChatApp.tsx/);
    assert.match(rendered, /passed \[#178\]: npm run typecheck/);
    assert.match(rendered, /Validation evidence \| 8 \| .*2 more/);
    assert.match(rendered, /Unresolved blockers \| 1 \| ci_failed \(blocked\): Queue constituent PR #179 has 1 failed or blocked validation evidence item\(s\)\./);
    assert.doesNotMatch(rendered, /npm run smoke/);
    assert.doesNotMatch(rendered, /npm run audit/);
    assert.doesNotMatch(rendered, /@team/);
    assert.doesNotMatch(rendered, /@ops/);
  });

  test("renderReviewGateStatusComment shows omitted queue rows when summaries are capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "pass", explanation: "context captured" }],
      "2026-06-30T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: Array.from({ length: 10 }, (_, index) => {
            const number = index + 1;
            return {
              number,
              title: `PR ${number}`,
              url: null,
              head_sha: null,
              status: "queued",
              evidence_refs: [],
            };
          }),
          merge_commits: Array.from({ length: 10 }, (_, index) => {
            const number = index + 1;
            return {
              sha: `abcde${String(number).padStart(3, "0")}`,
              pr_number: number,
              subject: `Merge PR #${number}`,
              conflict_files: [],
              evidence_refs: [],
            };
          }),
          validation_evidence: [],
          unresolved_blockers: [],
        },
      }),
    );

    assert.match(rendered, /Constituent PRs \| 10 \| #1, #2, #3, #4, #5, #6, #7, #8, 2 more/);
    assert.match(rendered, /Constituent status \| 10 \| #1 \(queued, PR 1\).*2 more/);
    assert.match(rendered, /Merge commits \| 10 \| abcde001 \(#1\).*abcde008 \(#8\), 2 more/);
    assert.doesNotMatch(rendered, /#9 \(queued/);
    assert.doesNotMatch(rendered, /abcde009/);
  });

  test("renderReviewGateStatusComment prioritizes non-passing validation evidence when capped", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "context-gathered", status: "pass", explanation: "context captured" }],
      "2026-06-30T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [],
          merge_commits: [],
          validation_evidence: [
            { command: "npm run pass-1", status: "passed", scope: "#1", evidence_ref: "comment:1" },
            { command: "npm run pass-2", status: "passed", scope: "#1", evidence_ref: "comment:2" },
            { command: "npm run pass-3", status: "passed", scope: "#1", evidence_ref: "comment:3" },
            { command: "npm run pass-4", status: "passed", scope: "#1", evidence_ref: "comment:4" },
            { command: "npm run pass-5", status: "passed", scope: "#1", evidence_ref: "comment:5" },
            { command: "npm run pass-6", status: "passed", scope: "#1", evidence_ref: "comment:6" },
            { command: "npm run pass-7", status: "passed", scope: "#1", evidence_ref: "comment:7" },
            { command: "npm run lint -- api", status: "blocked", scope: "packages/api", evidence_ref: "comment:blocked" },
            { command: "npm run smoke", status: "unknown", scope: null, evidence_ref: "comment:unknown" },
          ],
          unresolved_blockers: [],
        },
      }),
    );

    assert.match(rendered, /Validation evidence \| 9 \| blocked \[packages\/api\]: npm run lint -- api; unknown: npm run smoke; passed \[#1\]: npm run pass-1/);
    assert.match(rendered, /3 more/);
    assert.doesNotMatch(rendered, /npm run pass-7/);
  });

  test("renderReviewGateStatusComment summarizes CI counts when failed check names are absent", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "pending", explanation: "pending checks" }],
      "2026-06-30T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 4,
          passed: 2,
          failed: 0,
          pending: 1,
          skipped: 1,
          failed_checks: [],
        },
      }),
    );

    assert.match(rendered, /CI checks \| pending \| 0 failed, 1 pending, 0 unknown, 2 passed, 1 skipped out of 4 check\(s\)\./);
  });

  test("renderReviewGateStatusComment shows pending check details when available", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "pending", explanation: "pending checks" }],
      "2026-06-30T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 2,
          passed: 1,
          failed: 0,
          pending: 1,
          skipped: 0,
          failed_checks: [],
          pending_checks: [
            {
              name: "deploy preview @ops",
              status: "IN_PROGRESS",
              details_url: "https://example.test/checks/deploy",
            },
          ],
        },
      }),
    );

    assert.match(rendered, /CI checks \| pending \| 0 failed, 1 pending, 0 unknown, 1 passed, 0 skipped out of 2 check\(s\)\. Pending: deploy preview &#64;ops \(IN_PROGRESS, https:\/\/example.test\/checks\/deploy\)/);
    assert.match(rendered, /Evidence refs \| 1 \| https:\/\/example.test\/checks\/deploy/);
    assert.doesNotMatch(rendered, /@ops/);
  });

  test("renderReviewGateStatusComment shows unknown check details when available", () => {
    const rendered = renderReviewGateStatusComment(
      [{ rule: "ci-status", status: "unknown", explanation: "unknown check state" }],
      "2026-06-30T00:00:00.000Z",
      evidenceSummaryFromPrContext({
        ci_status: {
          total_checks: 1,
          passed: 0,
          failed: 0,
          pending: 0,
          unknown: 1,
          skipped: 0,
          failed_checks: [],
          pending_checks: [],
          unknown_checks: [
            {
              name: "manual approval @ops",
              state: "ACTION_REQUIRED",
              status: "",
              conclusion: "",
              details_url: "https://example.test/checks/manual",
            },
          ],
        },
      }),
    );

    assert.match(rendered, /CI checks \| unknown \| 0 failed, 0 pending, 1 unknown, 0 passed, 0 skipped out of 1 check\(s\)\. Unknown: manual approval &#64;ops \(ACTION_REQUIRED, https:\/\/example.test\/checks\/manual\)/);
    assert.match(rendered, /Evidence refs \| 1 \| https:\/\/example.test\/checks\/manual/);
    assert.doesNotMatch(rendered, /@ops/);
  });

  test("agentTokenUsageFromResult extracts exact agent token usage when reported", () => {
    const usage = agentTokenUsageFromResult({
      status: "success",
      telemetry: {
        model: "claude-sonnet-4-5-20250929",
        usage: {
          input_tokens: 1200,
          output_tokens: 345,
          cache_read_input_tokens: 55,
          total_tokens: 1545,
          source: "pi-provider-usage",
        },
      },
    });

    assert.deepEqual(usage, {
      model: "claude-sonnet-4-5-20250929",
      input_tokens: 1200,
      output_tokens: 345,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 55,
      total_tokens: 1545,
      source: "pi-provider-usage",
    });

  });

  test("mergeGodRuntimeTelemetry reports merge-god identity independent of target repo cwd", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-target-repo-"));
    const originalCwd = process.cwd();
    try {
      writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      process.chdir(tempDir);

      const telemetry = mergeGodRuntimeTelemetry();

      assert.notEqual(telemetry.merge_god_release, "v9.9.9");
      assert.notEqual(telemetry.merge_god_release, "unknown");
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("agentAnnotationLabelsFromResult filters to allowlisted semantic labels", () => {
    assert.deepEqual(
      agentAnnotationLabelsFromResult({
        annotations: {
          labels: ["Large", "too large", "please-run-my-label", "unaligned", "needs ci"],
        },
        annotation_labels: ["docs-only", "needs-rebase", "not-allowed"],
      }),
      ["docs-only", "needs-rebase", "large", "too-large", "unaligned", "needs-ci"],
    );
  });

  test("inferredAgentAnnotationLabelsFromFailure turns gate failures into next-action labels", () => {
    assert.deepEqual(
      inferredAgentAnnotationLabelsFromFailure(
        { status: "failure", summary: "CI workflow failed after branch fell behind main" },
        "Required status checks failed",
      ),
      ["needs-ci", "needs-rebase"],
    );
    assert.deepEqual(
      inferredAgentAnnotationLabelsFromFailure(
        { error: "merge conflicts remain; this PR is too large and should be split" },
        null,
      ),
      ["needs-split", "needs-conflict-resolution"],
    );
    assert.deepEqual(
      inferredAgentAnnotationLabelsFromFailure(
        {
          status: "failure",
          summary: "Validation and tests passed after merging the base branch.",
          error: "GitHub base branch policy requires an eligible review approval.",
        },
        "GitHub base branch policy requires an eligible review approval.",
      ),
      ["needs-review"],
    );
  });

  test("agentAnnotationLabelsForCompletion combines explicit and inferred labels", () => {
    assert.deepEqual(
      agentAnnotationLabelsForCompletion(
        { annotations: { labels: ["high-risk"] }, error: "review approval required before merge" },
        "changes requested",
      ),
      ["high-risk", "needs-review"],
    );
  });

  test("agentAnnotationLabelsForCompletion does not infer failure labels from success summaries", () => {
    assert.deepEqual(
      agentAnnotationLabelsForCompletion(
        {
          status: "success",
          summary: "Local validation passed with npm run ci and GitHub checks passed before merge.",
          annotation_labels: ["low-risk"],
        },
        null,
      ),
      ["low-risk"],
    );
    assert.deepEqual(
      agentAnnotationLabelsForCompletion(
        {
          status: "success",
          summary: "Local validation and CI checks passed, but completion was not verified.",
          annotation_labels: ["low-risk"],
        },
        "GitHub reports the PR is OPEN and unmerged",
      ),
      ["low-risk"],
    );
  });

  test("loadPiDotEnv only loads pi runtime secrets", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-pi-env-"));
    try {
      writeFileSync(
        path.join(tempDir, ".env"),
        [
          "# local developer secrets",
          "ZAI_API_KEY='fake-zai-key'",
          "ANTHROPIC_API_KEY=ignored",
          "export ALSO_IGNORED=value",
        ].join("\n"),
      );

      assert.deepEqual(loadPiDotEnv(tempDir), {
        ZAI_API_KEY: "fake-zai-key",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("linkNodeModulesIntoWorktree reuses installed dependencies when available", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mg-pi-node-modules-"));
    const sourceRepo = path.join(tempDir, "repo");
    const worktree = path.join(tempDir, "worktree");
    try {
      mkdirSync(path.join(sourceRepo, "node_modules"), { recursive: true });
      mkdirSync(worktree);

      assert.equal(linkNodeModulesIntoWorktree(sourceRepo, worktree), true);
      assert.equal(lstatSync(path.join(worktree, "node_modules")).isSymbolicLink(), true);
      assert.equal(linkNodeModulesIntoWorktree(sourceRepo, worktree), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("detached agent worktrees can start from an explicit PR-head ref", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "mg-agent-worktree-ref-"));
    let worktree: ReturnType<GitOps["createDetachedWorktree"]> | null = null;
    try {
      for (const args of [
        ["init"],
        ["config", "user.email", "merge-god@example.test"],
        ["config", "user.name", "merge-god test"],
      ]) {
        assert.equal(spawnSync("git", args, { cwd: repoDir }).status, 0);
      }
      writeFileSync(path.join(repoDir, "state.txt"), "base\n");
      assert.equal(spawnSync("git", ["add", "state.txt"], { cwd: repoDir }).status, 0);
      assert.equal(spawnSync("git", ["commit", "-m", "base"], { cwd: repoDir }).status, 0);
      assert.equal(spawnSync("git", ["branch", "pr-head"], { cwd: repoDir }).status, 0);
      assert.equal(spawnSync("git", ["checkout", "pr-head"], { cwd: repoDir }).status, 0);
      writeFileSync(path.join(repoDir, "state.txt"), "pull request\n");
      assert.equal(spawnSync("git", ["commit", "-am", "pr head"], { cwd: repoDir }).status, 0);
      assert.equal(spawnSync("git", ["checkout", "-"], { cwd: repoDir }).status, 0);

      worktree = new GitOps(repoDir).createDetachedWorktree("pr-head");
      assert.equal(readFileSync(path.join(worktree.path, "state.txt"), "utf8"), "pull request\n");
    } finally {
      worktree?.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("runPiAgent launches pi extension tools that use coordination trajectory state", async () => {
    const harness = new PiAgentHarness();
    try {
      const run = await harness.run("success");
      const { result, state, started } = run;

      assert.equal(result.returncode, 0, result.stderr || result.stdout);
      assert.ok(run.elapsed_ms < 5000, "pi should stop promptly after mg_complete");
      assert.match(result.stdout, /"zaiApiKeyLoaded":true/);
      assert.doesNotMatch(result.stdout, /fake-zai-key/);
      assert.equal(result.result?.["status"], "success");
      assert.equal(result.result?.["summary"], "fake pi used merge-god coordination trajectory state");
      assert.deepEqual(result.result?.["annotations"], {
        labels: ["large", "embark-candidate"],
      });
      assert.deepEqual(result.result?.["telemetry"], {
        model: "fake-pi-model",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          source: "fake-pi-provider",
        },
      });
      assert.match(result.stdout, /"tool":"mg_context"/);
      assert.match(result.stdout, /"tool":"mg_activity"/);
      assert.ok(run.git_events.includes("git.worktree.created"));
      assert.ok(run.git_events.includes("git.worktree.removed"));
      assert.ok(run.git_metrics.includes("git.command.duration_ms"));
      assert.deepEqual(run.observations, ["fake pi has enough context to continue"]);
      assert.equal(result.tooling?.injection.surface_scope, "all-configured");
      assert.equal(result.tooling?.surface.length, 5);
      assert.ok(result.tooling?.surface.some((tool) => tool.name === "bash" && tool.active));
      assert.deepEqual(
        result.tooling?.surface.filter((tool) => tool.name.startsWith("mg_")).map((tool) => tool.name).sort(),
        [...PI_TOOL_SURFACE].sort(),
      );
      assert.equal(result.tooling?.turns.length, 1);
      assert.equal(result.tooling?.turns[0]?.status, "completed");
      assert.equal(result.tooling?.reliability.started, 9);
      assert.equal(result.tooling?.reliability.completed, 9);
      assert.equal(result.tooling?.reliability.failed, 0);
      assert.equal(result.tooling?.reliability.incomplete, 0);

      assert.ok(state.events.some((event) => event.event_type === "decision.made"));
      assert.ok(state.events.some((event) => event.event_type === "agent.observation"));
      assert.ok(state.events.some((event) => event.event_type === "activity.next_action.proposed"));
      assert.ok(state.events.some((event) => event.event_type === "activity.child_created"));
      assert.ok(state.events.some((event) => event.event_type === "activity.completed"));
      assert.ok(state.events.some((event) => event.event_type === "pi.agent_turn.started"));
      assert.ok(state.events.some((event) => event.event_type === "pi.agent_turn.completed"));
      assert.ok(state.events.some((event) => event.event_type === "pi.extension.injected"));
      assert.ok(state.events.some((event) => event.event_type === "pi.tool_surface.registered"));
      const completedToolEvents = state.events.filter((event) => event.event_type === "pi.tool_call.completed");
      assert.equal(completedToolEvents.length, 9);
      assert.equal(
        (completedToolEvents[0]?.payload["trace_context"] as Record<string, unknown>)?.["run_id"],
        started.ids.run_id,
      );
      assert.equal(completedToolEvents[0]?.payload["turn_id"], `${started.ids.activity_session_id}:turn:0`);
      assert.ok(state.hierarchy.some((node) => node.level === "agent_turn" && node.state === "closed"));
      assert.equal(state.hierarchy.filter((node) => node.level === "tool_call").length, 9);
      assert.ok(state.activities.some((activity) =>
        activity.parent_activity_id === started.ids.activity_id && activity.type === "ci_diagnosis"
      ));
      const workItem = state.work_items.find((item) => item.work_item_id === started.ids.work_item_id);
      assert.equal(workItem?.next_action, "resume_activity");
    } finally {
      harness.close();
    }
  });
});
