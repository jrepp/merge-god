/**
 * Verifies that every core module imports cleanly and exposes its expected
 * public symbols. Each module is imported dynamically inside its own test so
 * that a failure is reported per-module rather than failing the whole file.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("module imports", () => {
  test("models (re-exported from the library) imports successfully", async () => {
    const mod = await import("../models");
    assert.ok(mod.createBranch, "expected createBranch export");
    assert.ok(mod.BranchStatus, "expected BranchStatus export");
    assert.ok(mod.PRState, "expected PRState export");
    assert.ok(mod.CIStatus, "expected CIStatus export");
  });

  test("@merge-god/github-sync imports successfully", async () => {
    const mod = await import("@merge-god/github-sync");
    assert.ok(mod.SyncStore, "expected SyncStore export");
    assert.ok(mod.SyncEngine, "expected SyncEngine export");
    assert.ok(mod.createForge, "expected createForge export");
    assert.ok(mod.GitClient, "expected GitClient export");
    assert.ok(mod.GitHubForge, "expected GitHubForge export");
  });

  test("@merge-god/workflow-ir-core imports successfully", async () => {
    const mod = await import("@merge-god/workflow-ir-core");
    assert.ok(mod.WorkflowRuntime, "expected WorkflowRuntime export");
    assert.ok(mod.AdapterRegistry, "expected AdapterRegistry export");
    assert.ok(mod.MemoryWorkflowStore, "expected MemoryWorkflowStore export");
    assert.ok(mod.createMergeGodValidationLaneAdapter, "expected merge-god validation adapter export");
    assert.ok(mod.createMergeGodFinalGateAdapter, "expected merge-god final-gate adapter export");
  });

  test("app_store imports successfully", async () => {
    const mod = await import("../app_store");
    assert.ok(mod.AppStore, "expected AppStore export");
    assert.ok(mod.DatabaseError, "expected DatabaseError export");
  });

  test("trajectory runtime imports successfully", async () => {
    const mod = await import("../trajectory_runtime");
    assert.ok(mod.TrajectoryRuntime, "expected TrajectoryRuntime export");
    assert.ok(mod.ONE_SHOT_PR_AGENT_WORKFLOW, "expected workflow definition export");
  });

  test("git ops imports successfully", async () => {
    const mod = await import("../git_ops");
    assert.equal(typeof mod.GitOps, "function");
    assert.equal(typeof mod.GitOpsError, "function");
  });

  test("pr-loop imports successfully", async () => {
    const mod = await import("../pr-loop");
    assert.equal(typeof mod.validateGitRef, "function");
  });
});
