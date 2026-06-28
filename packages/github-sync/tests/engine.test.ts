import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { SyncEngine, type SyncProgress, type SyncResult } from "../src/engine";
import { SyncStore } from "../src/store";
import { GitClient } from "../src/git-client";
import type {
  Forge,
  PRCommentShape,
  ReviewCommentShape,
  CommitInfoShape,
  FileChangeShape,
} from "../src/forge/types";
import {
  CIStatus,
  ForgeKind,
  PRState,
  type CICheck,
  type PRStateFilter,
  type PullRequest,
  type RepoIdentity,
} from "../src/models";

// --- FakeForge -------------------------------------------------------------

const FAKE_IDENTITY: RepoIdentity = {
  kind: ForgeKind.GITHUB,
  host: "github.com",
  owner: "owner",
  repo: "repo",
  slug: "owner/repo",
};

function makeOpenPr(): PullRequest {
  return {
    number: 101,
    title: "Add new feature",
    state: PRState.OPEN,
    head_branch: "feature-x",
    base_branch: "main",
    author: "alice",
    url: "https://github.com/owner/repo/pull/101",
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-02T00:00:00Z"),
    body: "This PR adds the feature.",
    draft: false,
    mergeable: true,
    labels: ["for-landing", "bug"],
    ci_checks: [],
    ci_summary: {},
    review_decision: null,
    approved_by: [],
    changes_requested_by: [],
    additions: 42,
    deletions: 3,
    changed_files: 2,
    commits: 1,
    has_conflicts: false,
    conflicting_files: [],
  };
}

function makeMergedPr(): PullRequest {
  return {
    number: 99,
    title: "Fix old bug",
    state: PRState.MERGED,
    head_branch: "fix-old-bug",
    base_branch: "main",
    author: "bob",
    url: "https://github.com/owner/repo/pull/99",
    created_at: new Date("2023-12-01T00:00:00Z"),
    updated_at: new Date("2023-12-05T00:00:00Z"),
    body: "Merged fix.",
    draft: false,
    mergeable: true,
    labels: [],
    ci_checks: [],
    ci_summary: {},
    review_decision: "APPROVED",
    approved_by: ["carol"],
    changes_requested_by: [],
    additions: 10,
    deletions: 1,
    changed_files: 1,
    commits: 2,
    has_conflicts: false,
    conflicting_files: [],
  };
}

class FakeForge implements Forge {
  readonly kind = ForgeKind.GITHUB;
  readonly identity = FAKE_IDENTITY;

  private readonly openPrs: PullRequest[];
  private readonly allPrs: PullRequest[];

  constructor() {
    const open = makeOpenPr();
    const merged = makeMergedPr();
    this.openPrs = [open];
    this.allPrs = [open, merged];
  }

  private findPr(number: number): PullRequest | null {
    return this.allPrs.find((p) => p.number === number) ?? null;
  }

  async listPullRequests(state: PRStateFilter = "open"): Promise<PullRequest[]> {
    if (state === "open") return this.openPrs;
    if (state === "all") return this.allPrs;
    return this.allPrs.filter((p) => p.state === PRState.CLOSED);
  }

  async getPullRequest(number: number): Promise<PullRequest | null> {
    return this.findPr(number);
  }

  async getPrsByLabels(labels: string[]): Promise<number[]> {
    const want = new Set(labels.map((l) => l.toLowerCase()));
    return this.allPrs
      .filter((p) => p.labels.some((l) => want.has(l.toLowerCase())))
      .map((p) => p.number);
  }

  async getPrDiff(prNumber: number): Promise<string> {
    return `diff --git a/file.txt b/file.txt\nindex 111..222 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-old\n+new\n for PR #${prNumber}\n`;
  }

  async getPrComments(prNumber: number): Promise<PRCommentShape[]> {
    return [
      {
        id: 1,
        author: "reviewer",
        body: `Looks good for PR #${prNumber}`,
        created_at: "2024-01-02T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      },
    ];
  }

  async getPrReviewComments(prNumber: number): Promise<ReviewCommentShape[]> {
    return [
      {
        id: 2,
        author: "reviewer",
        body: `Nit on PR #${prNumber}`,
        path: "file.txt",
        line: 5,
        created_at: "2024-01-02T00:00:00Z",
      },
    ];
  }

  async getPrCommits(prNumber: number): Promise<CommitInfoShape[]> {
    return [
      {
        sha: `deadbeef${prNumber}`,
        message: `Implement PR #${prNumber}`,
        author: "alice",
        date: "2024-01-01T00:00:00Z",
      },
    ];
  }

  async getPrFiles(prNumber: number): Promise<FileChangeShape[]> {
    return [
      {
        filename: "file.txt",
        status: "modified",
        additions: 10,
        deletions: 1,
        changes: 11,
        patch: `@@ -1,3 +1,3 @@ for PR #${prNumber}`,
      },
    ];
  }

  async getPrChecks(prNumber: number, headSha: string): Promise<CICheck[]> {
    return [
      {
        name: "CI",
        status: CIStatus.SUCCESS,
        conclusion: "success",
        details_url: `https://ci.example.com/${prNumber}/${headSha}`,
        started_at: new Date("2024-01-01T00:00:00Z"),
        completed_at: new Date("2024-01-01T00:01:00Z"),
      },
      {
        name: "Lint",
        status: CIStatus.FAILURE,
        conclusion: "failure",
        details_url: `https://ci.example.com/lint/${prNumber}/${headSha}`,
        started_at: new Date("2024-01-01T00:00:00Z"),
        completed_at: new Date("2024-01-01T00:00:30Z"),
      },
    ];
  }

  async getPrReviewDecision(prNumber: number): Promise<string | null> {
    const pr = this.findPr(prNumber);
    return pr ? (pr.review_decision ?? "COMMENTED") : null;
  }
}

// --- temp git repo helper --------------------------------------------------

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsm-repo-"));
  mkdirSync(dir, { recursive: true });
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? r.stdout}`);
    }
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
  return dir;
}

// --- test harness ----------------------------------------------------------

let dbDir: string;
let dbPath: string;
let store: SyncStore;
let repoPath: string;
let git: GitClient;
let forge: FakeForge;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "gsm-"));
  dbPath = join(dbDir, "test.db");
  store = new SyncStore(dbPath);
  repoPath = createTempGitRepo();
  git = new GitClient(repoPath);
  forge = new FakeForge();
});

afterEach(async () => {
  await store.close();
});

describe("SyncEngine (FakeForge integration)", () => {
  test("syncSinglePr captures context and persists it", async () => {
    await store.initialize();
    const engine = new SyncEngine(store, { forge, git });

    const result = await engine.syncSinglePr(repoPath, 101);

    assert.equal(result.success, true);
    assert.equal(result.contexts_synced, 1);
    assert.equal(result.repo_name, "owner/repo");
    assert.equal(result.error_message, null);

    const ctx = await store.getLatestPrContext("owner/repo", 101);
    assert.ok(ctx, "expected a stored context");
    assert.match(ctx!.diff, /diff --git/);
    assert.match(ctx!.diff, /PR #101/);
    assert.equal(ctx!.comments.length, 1);
    assert.equal(ctx!.review_comments.length, 1);
    assert.equal(ctx!.commits.length, 1);
    assert.equal(ctx!.files.length, 1);
  });

  test("syncRepository (fetchFirst:false) syncs PRs and branches", async () => {
    await store.initialize();
    const engine = new SyncEngine(store, { forge, git });

    const result = await engine.syncRepository(repoPath, { fetchFirst: false });

    assert.equal(result.success, true);
    assert.equal(result.prs_synced, 1); // open PRs only by default
    assert.ok(result.branches_synced > 0, "expected at least one branch synced");
    assert.equal(result.error_message, null);
    assert.equal(result.repo_name, "owner/repo");

    const active = await store.getActivePrs("owner/repo");
    assert.equal(active.length, 1);
    assert.equal(active[0]!["pr_number"], 101);
    assert.equal(active[0]!["state"], "open");

    const history = await store.getSyncHistory("owner/repo");
    assert.equal(history.length, 1);
    assert.equal(history[0]!["success"], 1);
  });

  test("syncRepository with includeContext persists PR context", async () => {
    await store.initialize();
    const engine = new SyncEngine(store, { forge, git });

    const result = await engine.syncRepository(repoPath, {
      fetchFirst: false,
      includeContext: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.contexts_synced, 1);

    const ctx = await store.getLatestPrContext("owner/repo", 101);
    assert.ok(ctx, "expected context captured during syncRepository");
    assert.match(ctx!.diff, /PR #101/);
  });

  test("syncRepositoryStream yields progress events and a final result", async () => {
    await store.initialize();
    const engine = new SyncEngine(store, { forge, git });

    const events: Array<SyncProgress | SyncResult> = [];
    for await (const ev of engine.syncRepositoryStream(repoPath, { fetchFirst: false })) {
      events.push(ev);
    }

    const progresses = events.filter(
      (e): e is SyncProgress => "stage" in e && "percent" in e,
    );
    const results = events.filter(
      (e): e is SyncResult => "success" in e && "prs_synced" in e,
    );

    assert.ok(progresses.length > 0, "expected at least one progress event");
    for (const p of progresses) {
      assert.equal(typeof p.stage, "string");
      assert.ok(p.percent >= 0 && p.percent <= 100);
    }
    assert.ok(results.length >= 1, "expected a final SyncResult");
    const finalResult = results[results.length - 1]!;
    assert.equal(finalResult.success, true);
    assert.equal(finalResult.prs_synced, 1);
  });

  test("getSyncStatus reports at least one sync after a syncRepository", async () => {
    await store.initialize();
    const engine = new SyncEngine(store, { forge, git });

    await engine.syncRepository(repoPath, { fetchFirst: false });
    const status = await engine.getSyncStatus();

    const total = status["total_syncs"] as number;
    assert.ok(total >= 1, `expected total_syncs >= 1, got ${total}`);
  });

  test("syncRepository without a forge returns failure mentioning forge", async () => {
    await store.initialize();
    const engine = new SyncEngine(store, { git });

    const result = await engine.syncRepository(repoPath, { fetchFirst: false });

    assert.equal(result.success, false);
    assert.ok(result.error_message, "expected an error_message");
    assert.match(result.error_message!, /forge/i);
  });
});
