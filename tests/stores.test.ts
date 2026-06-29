/**
 * Unit tests for the new split store layer: the async `SyncStore`
 * (@merge-god/github-sync — PR/branch/context tables) and the sync `AppStore`
 * (./app_store — agent-session/processing/dashboard tables).
 *
 * Each test gets a fresh temp database (created in the OS tmpdir) via
 * beforeEach/afterEach. SyncStore methods are async (awaited); AppStore
 * methods are sync.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SyncStore, createPullRequest, createRepositoryState, addRepositoryState, createBranch, createBranchPRState, PRState, BranchStatus } from "@merge-god/github-sync";
import { AppStore } from "../app_store";

/** Small helper to build a minimal open PR model. */
function makePr(overrides: Partial<{ number: number; title: string; state: string; head_branch: string; author: string; labels: string[] }> = {}): ReturnType<typeof createPullRequest> {
  return createPullRequest({
    number: overrides.number ?? 1,
    title: overrides.title ?? "PR",
    state: (overrides.state === "closed" ? PRState.CLOSED : PRState.OPEN) as PRState,
    head_branch: overrides.head_branch ?? "feature",
    base_branch: "main",
    author: overrides.author ?? "testuser",
    url: `https://example.com/${overrides.number ?? 1}`,
    created_at: new Date(),
    updated_at: new Date(),
    labels: overrides.labels ?? [],
  });
}

/** Small async delay so successive snapshots get distinct (ms-resolution)
 * snapshot_time values. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let tempDir: string;
let dbPath: string;
let syncStore: SyncStore;
let appStore: AppStore;

beforeEach(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "mg-db-"));
  dbPath = path.join(tempDir, "test.db");
  syncStore = new SyncStore(dbPath);
  await syncStore.initialize();
  appStore = new AppStore(dbPath);
});

afterEach(async () => {
  try {
    appStore.close();
  } catch {
    // ignore double-close
  }
  try {
    await syncStore.close();
  } catch {
    // ignore double-close
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SyncStore", () => {
  test("initialize creates the schema", () => {
    assert.ok(existsSync(dbPath));

    const conn = new DatabaseSync(dbPath);
    try {
      const rows = conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[];
      const tables = rows.map((r) => r.name);
      const expected = [
        "activities",
        "activity_sessions",
        "branch_states",
        "context_captures",
        "context_packs",
        "evidence_artifacts",
        "guardrail_checks",
        "orchestration_runs",
        "pr_context",
        "pull_requests",
        "repositories",
        "schema_meta",
        "tool_invocations",
        "trajectory_events",
        "work_items",
        "worksets",
      ];
      for (const t of expected) {
        assert.ok(tables.includes(t), `expected table '${t}' to exist`);
      }
    } finally {
      conn.close();
    }
  });

  test("save and get repository", async () => {
    await syncStore.saveRepository("test-repo", "/path/to/repo", "main");
    const repo = await syncStore.getRepository("test-repo");
    assert.ok(repo !== null);
    assert.equal(repo!["name"], "test-repo");
    assert.equal(repo!["path"], "/path/to/repo");
    assert.equal(repo!["default_branch"], "main");
  });

  test("update repository upserts by name", async () => {
    await syncStore.saveRepository("test-repo", "/old/path", "master");
    await syncStore.saveRepository("test-repo", "/new/path", "main");
    const repo = await syncStore.getRepository("test-repo");
    assert.equal(repo!["path"], "/new/path");
    assert.equal(repo!["default_branch"], "main");
  });

  test("savePrSnapshot round-trips and getActivePrs filters", async () => {
    for (let i = 1; i <= 3; i++) {
      await syncStore.savePrSnapshot("test-repo", makePr({ number: i, title: `PR ${i}`, head_branch: `feature-${i}`, labels: ["for-review"] }));
    }
    await syncStore.savePrSnapshot("test-repo", makePr({ number: 4, title: "PR 4", state: "closed", head_branch: "feature-4" }));

    const active = await syncStore.getActivePrs("test-repo");
    assert.equal(active.length, 3);
    assert.equal(active[0]!["pr_number"], 1);
    assert.equal(active[2]!["pr_number"], 3);
  });

  test("getActivePrs round-trips labels", async () => {
    await syncStore.savePrSnapshot("test-repo", makePr({ number: 123, title: "Test PR", labels: ["for-review", "bug"] }));

    const active = await syncStore.getActivePrs("test-repo");
    assert.equal(active.length, 1);
    assert.deepEqual(active[0]!["labels"], ["for-review", "bug"]);
  });

  test("savePrContext + getLatestPrContext round-trips fields", async () => {
    const prDetails = { number: 42, title: "Ctx PR" };
    const prContext = {
      url: "https://example.com/42",
      diff: "diff --git a/f b/f",
      body: "the body",
      comments: [{ id: 1, body: "comment" }],
      review_comments: [{ id: 2, body: "review" }],
      commits: [{ sha: "abc" }],
      files: [{ path: "f" }],
      conflicts: { has_conflicts: true },
      ci_status: { failed: 1 },
      guidelines: "be nice",
      commit_examples: "fix: thing",
    };
    await syncStore.savePrContext("test-repo", 42, prDetails, prContext);

    const ctx = await syncStore.getLatestPrContext("test-repo", 42);
    assert.ok(ctx !== null);
    assert.equal(ctx!["repo_name"], "test-repo");
    assert.equal(ctx!["pr_number"], 42);
    assert.equal(ctx!["diff"], "diff --git a/f b/f");
    assert.equal(ctx!["body"], "the body");
    assert.equal(ctx!["guidelines"], "be nice");
    assert.equal(ctx!["commit_examples"], "fix: thing");
    assert.deepEqual(ctx!["comments"], [{ id: 1, body: "comment" }]);
    assert.deepEqual(ctx!["conflicts"], { has_conflicts: true });
  });

  test("savePrContext + getPrContextForAgent returns backfilled tuple", async () => {
    await syncStore.savePrSnapshot("test-repo", makePr({ number: 7, title: "Snap PR", head_branch: "feature", author: "alice", labels: ["for-landing"] }));

    await syncStore.savePrContext(
      "test-repo",
      7,
      { number: 7, title: "Snap PR" },
      {
        url: "https://example.com/7",
        diff: "DIFF",
        comments: [],
        review_comments: [],
        commits: [],
        files: [],
        conflicts: {},
        ci_status: {},
        guidelines: "",
        commit_examples: "",
      },
    );

    const tuple = await syncStore.getPrContextForAgent("test-repo", 7);
    assert.ok(tuple !== null);
    const [details, context] = tuple!;
    assert.equal(details["number"], 7);
    assert.equal(details["title"], "Snap PR");
    assert.equal(details["headRefName"], "feature");
    assert.equal(details["baseRefName"], "main");
    assert.equal((details["author"] as Record<string, unknown>)["login"], "alice");
    assert.equal(context["diff"], "DIFF");
    assert.equal(context["url"], "https://example.com/7");
  });

  test("getPrContextForAgent returns null when no context exists", async () => {
    const tuple = await syncStore.getPrContextForAgent("nope", 999);
    assert.equal(tuple, null);
  });

  test("getStatistics reports aggregates", async () => {
    await syncStore.saveRepository("test-repo", "/path/to/repo", "main");
    await syncStore.savePrSnapshot("test-repo", makePr({ number: 1, title: "PR" }));

    const stats = await syncStore.getStatistics();
    assert.equal(stats["repositories"], 1);
    assert.equal(stats["pr_snapshots"], 1);
    assert.ok((stats["database_size_bytes"] as number) > 0);
  });

  test("saveRepositoryState persists branches + PRs", async () => {
    const repoState = createRepositoryState("/path/to/repo", "main");
    const branch = createBranch({
      name: "feature",
      sha: "abc123",
      is_local: true,
      is_remote: true,
      status: BranchStatus.UP_TO_DATE,
      ahead_by: 1,
      behind_by: 0,
    });
    const branchState = createBranchPRState({
      branch_name: "feature",
      local_branch: branch,
      remote_branch: branch,
      pr: makePr({ number: 5, title: "Feature PR", head_branch: "feature" }),
    });
    addRepositoryState(repoState, branchState);

    await syncStore.saveRepositoryState("test-repo", repoState);

    const repo = await syncStore.getRepository("test-repo");
    assert.equal(repo!["default_branch"], "main");

    const snapshot = await syncStore.getLatestPrSnapshot("test-repo", 5);
    assert.ok(snapshot !== null);
    assert.equal(snapshot!["title"], "Feature PR");
  });

  test("multiple snapshots return latest", async () => {
    await syncStore.savePrSnapshot("test-repo", makePr({ number: 123, title: "v1" }));
    await sleep(2);
    await syncStore.savePrSnapshot("test-repo", makePr({ number: 123, title: "v2" }));

    const latest = await syncStore.getLatestPrSnapshot("test-repo", 123);
    assert.equal(latest!["title"], "v2");
  });

  test("savePrContext rejects invalid inputs", async () => {
    await assert.rejects(() => syncStore.savePrContext("", 1, {}, {}), TypeError);
    await assert.rejects(() => syncStore.savePrContext("test-repo", 0, {}, {}), TypeError);
  });
});

describe("AppStore", () => {
  test("createAgentSession + getAgentSessions + getSessionDetails", () => {
    appStore.createAgentSession("test-repo", 42, "sess-1", "for-landing", "claude-3", "1.0");

    const sessions = appStore.getAgentSessions("test-repo", 42);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!["session_id"], "sess-1");
    assert.equal(sessions[0]!["mode"], "for-landing");
    assert.equal(sessions[0]!["model"], "claude-3");

    const details = appStore.getSessionDetails("sess-1");
    assert.ok(details !== null);
    assert.equal(details!["session_id"], "sess-1");
    assert.ok(Array.isArray(details!["actions"]));
    assert.ok(Array.isArray(details!["turns"]));
    assert.ok(Array.isArray(details!["errors"]));
    assert.ok(Array.isArray(details!["file_operations"]));
  });

  test("getSessionDetails returns null for unknown session", () => {
    assert.equal(appStore.getSessionDetails("nope"), null);
  });

  test("updateAgentSession records completion + token accounting", () => {
    appStore.createAgentSession("test-repo", 1, "sess-2", "for-review", "m");
    appStore.updateAgentSession(
      "sess-2",
      "completed",
      true,
      null,
      3,
      2,
      1,
      5,
      100,
      200,
      4,
    );

    const details = appStore.getSessionDetails("sess-2");
    assert.equal(details!["status"], "completed");
    assert.equal(details!["success"], 1);
    assert.equal(details!["tasks_total"], 3);
    assert.equal(details!["tasks_completed"], 2);
    assert.equal(details!["tasks_failed"], 1);
    assert.equal(details!["actions_total"], 5);
    assert.equal(details!["input_tokens"], 100);
    assert.equal(details!["output_tokens"], 200);
    assert.equal(details!["total_tokens"], 300);
    assert.equal(details!["api_calls"], 4);
    assert.ok(details!["completed_at"] !== null);
    assert.ok(details!["duration_seconds"] !== null);
  });

  test("recordAgentAction returns an id", () => {
    appStore.createAgentSession("test-repo", 1, "sess-3", "for-review", "m");
    const id = appStore.recordAgentAction("sess-3", 1, "edit", "file.ts", { x: 1 });
    assert.ok(id > 0);

    const details = appStore.getSessionDetails("sess-3");
    const actions = details!["actions"] as Record<string, unknown>[];
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!["action_type"], "edit");
    assert.equal(actions[0]!["target"], "file.ts");
  });

  test("recordAgentTurn + recordAgentError + recordFileOperation", () => {
    appStore.createAgentSession("test-repo", 1, "sess-4", "for-review", "m");
    appStore.recordAgentTurn("sess-4", 1, "assistant", "text", "hello", 0, 10, 20);
    appStore.recordAgentError("sess-4", "ValueError", "bad", null, true, 1);
    appStore.recordFileOperation("sess-4", "write", "a.ts", null, 100, 5, 2, true);

    const details = appStore.getSessionDetails("sess-4");
    const turns = details!["turns"] as Record<string, unknown>[];
    const errors = details!["errors"] as Record<string, unknown>[];
    const fileOps = details!["file_operations"] as Record<string, unknown>[];
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!["content_preview"], "hello");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!["error_type"], "ValueError");
    assert.equal(fileOps.length, 1);
    assert.equal(fileOps[0]!["file_path"], "a.ts");
  });

  test("recordProcessingStart + Complete + getProcessingHistory", () => {
    const id = appStore.recordProcessingStart(
      "test-repo",
      42,
      "review",
      { mode: "for-review", commit: "abc123" },
    );
    assert.ok(id > 0);
    appStore.recordProcessingComplete(id, true, null);

    const history = appStore.getProcessingHistory("test-repo", 42);
    assert.equal(history.length, 1);
    const first = history[0]!;
    assert.equal(first["pr_number"], 42);
    assert.equal(first["action_type"], "review");
    assert.equal(first["success"], 1);
    assert.ok(first["completed_at"] !== null);
    assert.ok(first["duration_seconds"] !== null);
    assert.deepEqual((first["metadata"] as Record<string, unknown>)["mode"], "for-review");
  });

  test("processing failure is recorded", () => {
    const id = appStore.recordProcessingStart("test-repo", 456, "landing");
    appStore.recordProcessingComplete(id, false, "CI checks failed");

    const history = appStore.getProcessingHistory("test-repo", 456);
    assert.equal(history[0]!["success"], 0);
    assert.equal(history[0]!["error_message"], "CI checks failed");
  });

  test("processing history respects limit and orders recent first", async () => {
    for (let i = 0; i < 15; i++) {
      const id = appStore.recordProcessingStart("test-repo", i, "review");
      appStore.recordProcessingComplete(id, true);
      await sleep(2);
    }

    const history = appStore.getProcessingHistory("test-repo", null, 10);
    assert.equal(history.length, 10);
    assert.equal(history[0]!["pr_number"], 14);
  });

  test("saveDashboardState + getDashboardState round-trips", () => {
    const stats = { prs_processed: 10, successes: 8, failures: 2, iteration: 5 };
    const stateData = { queue: [1, 2], last_error: null };
    appStore.saveDashboardState("test-repo", "running", stats, 123, stateData);

    const state = appStore.getDashboardState("test-repo");
    assert.ok(state !== null);
    assert.equal(state!["status"], "running");
    assert.equal(state!["prs_processed"], 10);
    assert.equal(state!["successes"], 8);
    assert.equal(state!["current_pr_number"], 123);
    assert.deepEqual(
      (state!["state_data"] as Record<string, unknown>)["queue"],
      [1, 2],
    );
  });

  test("dashboard state upserts by repo name", () => {
    appStore.saveDashboardState("test-repo", "running", {
      prs_processed: 5,
      successes: 5,
      failures: 0,
      iteration: 1,
    });
    appStore.saveDashboardState("test-repo", "idle", {
      prs_processed: 10,
      successes: 9,
      failures: 1,
      iteration: 2,
    });

    const state = appStore.getDashboardState("test-repo");
    assert.equal(state!["status"], "idle");
    assert.equal(state!["prs_processed"], 10);
    assert.equal(state!["successes"], 9);
  });

  test("createCompatibilityTrajectoryForPr persists RFC-006 run state", () => {
    appStore.createAgentSession("test-repo", 42, "sess-trajectory", "for-review", "claude-test");

    const ids = appStore.createCompatibilityTrajectoryForPr({
      repo_name: "test-repo",
      repo_path: "/repo",
      pr_number: 42,
      mode: "for-review",
      title: "Trajectory PR",
      url: "https://example.com/pull/42",
      labels: ["for-review", "bug"],
      base_ref: "main",
      head_ref: "feature",
      current_sha: "abc123",
      session_id: "sess-trajectory",
      model: "claude-test",
    });

    assert.ok(ids.run_id);
    assert.ok(ids.workset_id);
    assert.ok(ids.work_item_id);
    assert.ok(ids.activity_id);
    assert.ok(ids.activity_session_id);

    const runs = appStore.getOrchestrationRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!["repo_name"], "test-repo");
    assert.equal(runs[0]!["status"], "executing");
    assert.deepEqual(runs[0]!["model_policy"], { model: "claude-test" });

    const state = appStore.getTrajectoryState(ids.run_id);
    assert.ok(state !== null);
    assert.equal(state!.worksets.length, 1);
    assert.equal(state!.worksets[0]!["kind"], "pr_queue");
    assert.equal(state!.work_items.length, 1);
    assert.equal(state!.work_items[0]!["number"], 42);
    assert.equal(state!.work_items[0]!["title"], "Trajectory PR");
    assert.deepEqual(state!.work_items[0]!["labels"], ["for-review", "bug"]);
    assert.equal(state!.activities.length, 1);
    assert.equal(state!.activities[0]!["type"], "review_workflow");
    assert.equal(state!.activity_sessions.length, 1);
    assert.equal(state!.activity_sessions[0]!["session_id"], "sess-trajectory");
    assert.equal(state!.events.length, 1);
    assert.equal(state!.events[0]!["event_type"], "compatibility_trajectory.started");
  });

  test("appendTrajectoryEvent and completeCompatibilityTrajectory update run state", () => {
    const ids = appStore.createCompatibilityTrajectoryForPr({
      repo_name: "test-repo",
      pr_number: 7,
      mode: "for-landing",
      title: "Landing PR",
    });

    const eventId = appStore.appendTrajectoryEvent(
      ids.run_id,
      "guardrail.checked",
      "test",
      { name: "label_contract", status: "passed" },
      {
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
      },
    );
    assert.ok(eventId);

    appStore.completeCompatibilityTrajectory(ids, true, "Validated by test", null);

    const state = appStore.getTrajectoryState(ids.run_id);
    assert.ok(state !== null);
    assert.equal(state!.run.status, "completed");
    assert.equal(state!.worksets[0]!["status"], "completed");
    assert.equal(state!.work_items[0]!["status"], "validated");
    assert.equal(state!.activities[0]!["status"], "succeeded");
    assert.deepEqual(
      state!.events.map((event) => event.event_type),
      [
        "compatibility_trajectory.started",
        "guardrail.checked",
        "compatibility_trajectory.completed",
      ],
    );
  });
});
