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

  test("app_store imports successfully", async () => {
    const mod = await import("../app_store");
    assert.ok(mod.AppStore, "expected AppStore export");
    assert.ok(mod.DatabaseError, "expected DatabaseError export");
  });

  test("pr-loop imports successfully", async () => {
    const mod = await import("../pr-loop");
    assert.equal(typeof mod.validateGitRef, "function");
  });
});
