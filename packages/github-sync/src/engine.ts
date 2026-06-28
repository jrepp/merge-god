/**
 * Sync engine for @merge-god/github-sync.
 *
 * The {@link SyncEngine} coordinates a local {@link GitClient} and a remote
 * {@link Forge} against a {@link SyncStore}, building normalized
 * `RepositoryState` / `PRContext` snapshots. It is forge-neutral: it depends
 * only on the `Forge` interface, never on a concrete backend.
 *
 * NOTE: there is no `./forge` factory barrel yet. The engine therefore requires
 * a `Forge` to be supplied either per-call (in `opts.forge`) or once at
 * construction (in `options.forge`). If neither is present for a sync, it
 * throws a clear `"forge required"` error rather than importing a non-existent
 * module and breaking tsc.
 */

import {
  addRepositoryState,
  createBranchPRState,
  createPRContext,
  createRepositoryState,
  getPRCiStatus,
  type Branch,
  type PRContext,
  type PullRequest,
  type RepositoryState,
} from "./models";
import { detectForgeFromRepo } from "./forge/detect";
import type { Forge } from "./forge/types";
import { GitClient } from "./git-client";
import { SyncStore } from "./store";

/** Outcome of a single sync operation. Data fields are snake_case for DB/wire. */
export interface SyncResult {
  success: boolean;
  repo_name: string;
  prs_synced: number;
  branches_synced: number;
  contexts_synced: number;
  duration_seconds: number;
  error_message: string | null;
}

/** Progress event emitted by streaming sync methods. */
export interface SyncProgress {
  stage: string;
  percent: number;
}

/**
 * Persistence target for the engine. The {@link SyncStore} class in `./store`
 * satisfies this contract; it is re-stated here only as documentation of the
 * methods the engine actually calls.
 */

export interface SyncEngineOptions {
  git?: GitClient;
  forge?: Forge;
}

/** Coordinating sync orchestrator. */
export class SyncEngine {
  private readonly store: SyncStore;
  private readonly defaultGit?: GitClient;
  private readonly defaultForge?: Forge;

  /** @param store - Persistence target for repository / PR state. */
  constructor(store: SyncStore, options?: SyncEngineOptions) {
    this.store = store;
    this.defaultGit = options?.git;
    this.defaultForge = options?.forge;
  }

  /**
   * Sync a single repository: forge identity, branches, and open PRs. Optionally
   * capture full per-PR context.
   */
  async syncRepository(
    repoPath: string,
    opts: {
      includeContext?: boolean;
      fetchFirst?: boolean;
      labels?: string[];
      forge?: Forge;
      git?: GitClient;
    } = {},
  ): Promise<SyncResult> {
    const started = Date.now();
    const { includeContext = false, fetchFirst = true, labels } = opts;

    const makeError = (message: string): SyncResult => ({
      success: false,
      repo_name: repoPath,
      prs_synced: 0,
      branches_synced: 0,
      contexts_synced: 0,
      duration_seconds: (Date.now() - started) / 1000,
      error_message: message,
    });

    try {
      const git = opts.git ?? this.defaultGit ?? new GitClient(repoPath);
      const forge = opts.forge ?? this.defaultForge;
      if (!forge) {
        return makeError("forge required");
      }

      if (fetchFirst) {
        await git.fetch();
      }

      const defaultBranch = await git.getDefaultBranch();
      const [localBranches, remoteBranches] = await git.getAllBranchesWithStatus();

      const prs = labels && labels.length > 0
        ? await this.prsByLabels(forge, labels)
        : await forge.listPullRequests("open");

      const repoState = createRepositoryState(repoPath, defaultBranch);
      this.correlateBranchesAndPrs(repoState, localBranches, remoteBranches, prs);
      repoState.last_updated = new Date();

      const repoName = forge.identity.slug;

      await this.store.saveRepository(repoName, repoPath, defaultBranch);
      await this.store.saveRepositoryState(repoName, repoState);

      let contexts_synced = 0;
      if (includeContext) {
        for (const pr of prs) {
          await this.capturePrContext(forge, repoName, pr);
          contexts_synced += 1;
        }
      }

      const result: SyncResult = {
        success: true,
        repo_name: repoName,
        prs_synced: prs.length,
        branches_synced: localBranches.length + remoteBranches.length,
        contexts_synced,
        duration_seconds: (Date.now() - started) / 1000,
        error_message: null,
      };

      await this.recordSync(repoName, result);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const result = makeError(message);
      await this.recordSyncSafe(repoPath, result);
      return result;
    }
  }

  /**
   * Streaming variant of {@link syncRepository}. Yields {@link SyncProgress}
   * events as each stage completes, then a final {@link SyncResult}.
   */
  async *syncRepositoryStream(
    repoPath: string,
    opts: {
      includeContext?: boolean;
      fetchFirst?: boolean;
      labels?: string[];
      forge?: Forge;
      git?: GitClient;
    } = {},
  ): AsyncIterable<SyncProgress | SyncResult> {
    const { includeContext = false, fetchFirst = true, labels } = opts;
    const started = Date.now();

    const fail = (message: string): SyncResult => ({
      success: false,
      repo_name: repoPath,
      prs_synced: 0,
      branches_synced: 0,
      contexts_synced: 0,
      duration_seconds: (Date.now() - started) / 1000,
      error_message: message,
    });

    try {
      const git = opts.git ?? this.defaultGit ?? new GitClient(repoPath);
      const forge = opts.forge ?? this.defaultForge;
      if (!forge) {
        yield fail("forge required");
        return;
      }

      if (fetchFirst) {
        yield { stage: "fetch", percent: 10 };
        await git.fetch();
      }

      yield { stage: "branches", percent: 30 };
      const defaultBranch = await git.getDefaultBranch();
      const [localBranches, remoteBranches] = await git.getAllBranchesWithStatus();

      yield { stage: "pull_requests", percent: 50 };
      const prs = labels && labels.length > 0
        ? await this.prsByLabels(forge, labels)
        : await forge.listPullRequests("open");

      yield { stage: "correlate", percent: 70 };
      const repoState = createRepositoryState(repoPath, defaultBranch);
      this.correlateBranchesAndPrs(repoState, localBranches, remoteBranches, prs);
      repoState.last_updated = new Date();

      const repoName = forge.identity.slug;

      await this.store.saveRepository(repoName, repoPath, defaultBranch);
      await this.store.saveRepositoryState(repoName, repoState);

      let contexts_synced = 0;
      if (includeContext) {
        const total = prs.length;
        for (let i = 0; i < prs.length; i++) {
          const pr = prs[i]!;
          await this.capturePrContext(forge, repoName, pr);
          contexts_synced += 1;
          yield {
            stage: "context",
            percent: total > 0 ? 70 + Math.round(((i + 1) / total) * 25) : 95,
          };
        }
      }

      const result: SyncResult = {
        success: true,
        repo_name: repoName,
        prs_synced: prs.length,
        branches_synced: localBranches.length + remoteBranches.length,
        contexts_synced,
        duration_seconds: (Date.now() - started) / 1000,
        error_message: null,
      };

      yield { stage: "record", percent: 99 };
      await this.recordSync(repoName, result);
      yield { stage: "done", percent: 100 };
      yield result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const result = fail(message);
      await this.recordSyncSafe(repoPath, result);
      yield result;
    }
  }

  /**
   * Fetch one PR (by forge number) and capture its full offline-processing
   * context into the store.
   */
  async syncSinglePr(repoPath: string, prNumber: number): Promise<SyncResult> {
    const started = Date.now();

    const fail = (message: string): SyncResult => ({
      success: false,
      repo_name: repoPath,
      prs_synced: 0,
      branches_synced: 0,
      contexts_synced: 0,
      duration_seconds: (Date.now() - started) / 1000,
      error_message: message,
    });

    try {
      const forge = this.defaultForge;
      if (!forge) {
        return fail("forge required");
      }

      const pr = await forge.getPullRequest(prNumber);
      if (!pr) {
        return fail(`PR ${prNumber} not found`);
      }

      const repoName = forge.identity.slug;
      await this.capturePrContext(forge, repoName, pr);

      const result: SyncResult = {
        success: true,
        repo_name: repoName,
        prs_synced: 1,
        branches_synced: 0,
        contexts_synced: 1,
        duration_seconds: (Date.now() - started) / 1000,
        error_message: null,
      };

      await this.recordSync(repoName, result);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const result = fail(message);
      await this.recordSyncSafe(repoPath, result);
      return result;
    }
  }

  /** Aggregate sync status (optionally filtered to one repo). */
  async getSyncStatus(repoName?: string): Promise<Record<string, unknown>> {
    const history = await this.store.getSyncHistory(repoName);
    const total = history.length;
    const successes = history.filter((h) => h.success === true || h.success === 1).length;
    return {
      repo_name: repoName ?? null,
      total_syncs: total,
      successful_syncs: successes,
      failed_syncs: total - successes,
      last_sync: total > 0 ? history[0] ?? null : null,
      history,
    };
  }

  /**
   * Resolve the {@link RepoIdentity} for a local checkout without performing a
   * full sync. Uses `detectForgeFromRepo`.
   */
  async resolveIdentity(repoPath: string) {
    return detectForgeFromRepo(repoPath);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Match local branches → remote branches → PRs by head-branch name. Mirrors
   * `StateTracker._correlateBranchesAndPrs` in the root merge-god codebase.
   */
  private correlateBranchesAndPrs(
    repoState: RepositoryState,
    localBranches: Branch[],
    remoteBranches: Branch[],
    prs: PullRequest[],
  ): void {
    const remoteLookup = new Map<string, Branch>(
      remoteBranches.map((b) => [b.name, b]),
    );
    const prLookup = new Map<string, PullRequest>(prs.map((p) => [p.head_branch, p]));
    const processed = new Set<string>();

    for (const localBranch of localBranches) {
      const branchName = localBranch.name;
      const remoteBranch = remoteLookup.get(branchName) ?? null;
      const pr = prLookup.get(branchName) ?? null;

      addRepositoryState(
        repoState,
        createBranchPRState({
          branch_name: branchName,
          local_branch: localBranch,
          remote_branch: remoteBranch,
          pr,
        }),
      );
      processed.add(branchName);
    }

    for (const remoteBranch of remoteBranches) {
      const branchName = remoteBranch.name;
      if (processed.has(branchName)) continue;

      const pr = prLookup.get(branchName) ?? null;

      addRepositoryState(
        repoState,
        createBranchPRState({
          branch_name: branchName,
          local_branch: null,
          remote_branch: remoteBranch,
          pr,
        }),
      );
      processed.add(branchName);
    }

    for (const pr of prs) {
      if (!processed.has(pr.head_branch)) {
        addRepositoryState(
          repoState,
          createBranchPRState({
            branch_name: pr.head_branch,
            local_branch: null,
            remote_branch: null,
            pr,
          }),
        );
      }
    }
  }

  /** Expand a labels filter into concrete {@link PullRequest} objects. */
  private async prsByLabels(forge: Forge, labels: string[]): Promise<PullRequest[]> {
    const numbers = await forge.getPrsByLabels(labels);
    const prs: PullRequest[] = [];
    for (const n of numbers) {
      const pr = await forge.getPullRequest(n);
      if (pr) prs.push(pr);
    }
    return prs;
  }

  /**
   * Gather a PR's full context (diff, comments, reviews, commits, files, CI,
   * review decision) and persist it via {@link SyncStore.savePrContext}.
   */
  private async capturePrContext(forge: Forge, repoName: string, pr: PullRequest): Promise<void> {
    const headSha = pr.head_branch;

    const [diff, comments, reviewComments, commits, files, checks, reviewDecision] =
      await Promise.all([
        forge.getPrDiff(pr.number),
        forge.getPrComments(pr.number),
        forge.getPrReviewComments(pr.number),
        forge.getPrCommits(pr.number),
        forge.getPrFiles(pr.number),
        forge.getPrChecks(pr.number, headSha),
        forge.getPrReviewDecision(pr.number),
      ]);

    const ciChecks = checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
    const prWithCi: PullRequest = { ...pr, ci_checks: checks };
    const ci_status: Record<string, unknown> = {
      status: getPRCiStatus(prWithCi),
      review_decision: reviewDecision,
      summary: { total: ciChecks.length },
      checks: ciChecks,
    };

    const context = createPRContext({
      repo_name: repoName,
      pr_number: pr.number,
      pr_url: pr.url,
      diff,
      body: pr.body ?? "",
      comments: comments as unknown as Record<string, unknown>[],
      review_comments: reviewComments as unknown as Record<string, unknown>[],
      commits: commits as unknown as Record<string, unknown>[],
      files: files as unknown as Record<string, unknown>[],
      conflicts: { has_conflicts: pr.has_conflicts, conflicting_files: pr.conflicting_files },
      ci_status,
    });

    await this.store.savePrContext(
      repoName,
      pr.number,
      pr as unknown as Record<string, unknown>,
      context as unknown as Record<string, unknown>,
    );
  }

  /** Record a sync outcome via recordSyncStart/Complete. */
  private async recordSync(repoName: string, result: SyncResult): Promise<void> {
    const recordId = await this.store.recordSyncStart(repoName, "full");
    await this.store.recordSyncComplete(
      recordId,
      result.success,
      result.prs_synced,
      result.branches_synced,
      result.error_message ?? undefined,
    );
  }

  /** Best-effort recordSync; swallows store errors so the sync result still returns. */
  private async recordSyncSafe(repoName: string, result: SyncResult): Promise<void> {
    try {
      await this.recordSync(repoName, result);
    } catch {
      // swallow — the original sync error is already in `result`.
    }
  }
}
