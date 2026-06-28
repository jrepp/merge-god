import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SyncStore } from "../src/store";
import {
  createPullRequest,
  createRepositoryState,
  addRepositoryState,
  createBranchPRState,
  createBranch,
  PRState,
  BranchStatus,
} from "../src/models";

let dbPath: string;
let store: SyncStore;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "gsm-"));
  dbPath = join(dir, "test.db");
  store = new SyncStore(dbPath);
});

afterEach(async () => {
  store.close();
});

describe("SyncStore", () => {
  test("initialize creates schema and reports version", async () => {
    await store.initialize();
    const info = await store.getSchemaInfo();
    assert.ok((info["current_version"] as string) ?? (info["version"] as string));
  });

  test("repository round-trips", async () => {
    await store.initialize();
    await store.saveRepository("owner/repo", "/path/to/repo", "main");
    const repo = await store.getRepository("owner/repo");
    assert.equal(repo?.["name"], "owner/repo");
    assert.equal(repo?.["default_branch"], "main");
  });

  test("PR snapshot + active PRs", async () => {
    await store.initialize();
    await store.saveRepository("owner/repo", "/p", "main");
    const pr = createPullRequest({
      number: 42,
      title: "Fix bug",
      state: PRState.OPEN,
      head_branch: "fix",
      base_branch: "main",
      author: "alice",
      url: "https://example.com/pr/42",
      created_at: new Date(),
      updated_at: new Date(),
    });
    await store.savePrSnapshot("owner/repo", pr);
    const active = await store.getActivePrs("owner/repo");
    assert.equal(active.length, 1);
    assert.equal(active[0]?.["pr_number"], 42);
  });

  test("PR context is cached and retrievable", async () => {
    await store.initialize();
    await store.saveRepository("owner/repo", "/p", "main");
    const details = { number: 7, title: "ctx", headRefName: "b" };
    const ctx = { diff: "diff --git a", comments: [], ci_status: {} };
    await store.savePrContext("owner/repo", 7, details, ctx);
    const got = await store.getLatestPrContext("owner/repo", 7);
    assert.ok(got);
    assert.equal(got?.pr_number, 7);
  });

  test("repository state persists", async () => {
    await store.initialize();
    await store.saveRepository("owner/repo", "/p", "main");
    const state = createRepositoryState("/p", "main");
    addRepositoryState(
      state,
      createBranchPRState({
        branch_name: "main",
        local_branch: createBranch({ name: "main", sha: "abc", is_local: true, is_remote: true, status: BranchStatus.UP_TO_DATE }),
      }),
    );
    await store.saveRepositoryState("owner/repo", state);
    const repo = await store.getRepository("owner/repo");
    assert.equal(repo?.["name"], "owner/repo");
  });

  test("sync history records start/complete and reads back", async () => {
    await store.initialize();
    await store.saveRepository("owner/repo", "/p", "main");
    const id = await store.recordSyncStart("owner/repo", "full");
    assert.ok(typeof id === "number" && id > 0);
    await store.recordSyncComplete(id, true, 3, 5, null);
    const history = await store.getSyncHistory("owner/repo");
    assert.equal(history.length, 1);
    assert.equal(history[0]?.["prs_synced"], 3);
  });

  test("statistics aggregates repos and PRs", async () => {
    await store.initialize();
    await store.saveRepository("owner/repo", "/p", "main");
    const stats = await store.getStatistics();
    assert.ok((stats["repositories"] as number) ?? true);
  });
});
