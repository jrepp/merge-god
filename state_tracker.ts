/**
 * State tracking: correlate local/remote branches with PRs into a unified
 * RepositoryState.
 *
 * Backed by the @merge-god/github-sync library (GitClient + Forge). This is a
 * thin adapter retained for the dashboard, which wants the in-memory
 * RepositoryState rather than the persisted SyncResult the SyncEngine produces.
 */

import {
  GitClient,
  GitClientError,
  createForgeFromRepo,
  type Forge,
  type Branch,
  type PullRequest,
  type RepositoryState,
  type BranchPRState,
  createRepositoryState,
  createBranchPRState,
  addRepositoryState,
} from "@merge-god/github-sync";

export class StateTrackerError extends Error {}

export class StateTracker {
  readonly repoPath: string;
  private git: GitClient;
  private forge: Forge | null = null;
  private _cachedState: RepositoryState | null = null;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = new GitClient(repoPath);
  }

  private async ensureForge(): Promise<Forge> {
    if (!this.forge) {
      const { forge } = await createForgeFromRepo(this.repoPath);
      this.forge = forge;
    }
    return this.forge;
  }

  async fetchAndUpdate(forceFetch = true): Promise<void> {
    if (forceFetch) {
      try {
        await this.git.fetch();
      } catch (e) {
        throw new StateTrackerError(
          `Failed to fetch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  async buildRepositoryState(opts: {
    fetchFirst?: boolean;
    includeClosedPRs?: boolean;
  } = {}): Promise<RepositoryState> {
    const { fetchFirst = true, includeClosedPRs = false } = opts;

    if (fetchFirst) await this.fetchAndUpdate();

    const defaultBranch = await this.git.getDefaultBranch();
    const repoState = createRepositoryState(this.repoPath, defaultBranch);

    const [localBranches, remoteBranches] = await this.git.getAllBranchesWithStatus();

    const forge = await this.ensureForge();
    const prs = await forge.listPullRequests(includeClosedPRs ? "all" : "open");

    this.correlate(repoState, localBranches, remoteBranches, prs);
    repoState.last_updated = new Date();
    this._cachedState = repoState;
    return repoState;
  }

  private correlate(
    repoState: RepositoryState,
    localBranches: Branch[],
    remoteBranches: Branch[],
    prs: PullRequest[],
  ): void {
    const remoteLookup = new Map(remoteBranches.map((b) => [b.name, b]));
    const prLookup = new Map(prs.map((p) => [p.head_branch, p]));
    const processed = new Set<string>();

    for (const lb of localBranches) {
      addRepositoryState(
        repoState,
        createBranchPRState({
          branch_name: lb.name,
          local_branch: lb,
          remote_branch: remoteLookup.get(lb.name) ?? null,
          pr: prLookup.get(lb.name) ?? null,
        }),
      );
      processed.add(lb.name);
    }
    for (const rb of remoteBranches) {
      if (processed.has(rb.name)) continue;
      addRepositoryState(
        repoState,
        createBranchPRState({
          branch_name: rb.name,
          local_branch: null,
          remote_branch: rb,
          pr: prLookup.get(rb.name) ?? null,
        }),
      );
      processed.add(rb.name);
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

  invalidateCache(): void {
    this._cachedState = null;
  }
}

export async function quickStatus(repoPath: string): Promise<Record<string, unknown>> {
  try {
    const tracker = new StateTracker(repoPath);
    const state = await tracker.buildRepositoryState({ fetchFirst: true });
    const withPrs = state.branch_pr_states.filter((s) => s.has_pr);
    return {
      repo_path: state.repo_path,
      default_branch: state.default_branch,
      total_branches: state.branch_pr_states.length,
      branches_with_prs: withPrs.length,
      last_updated: state.last_updated ? state.last_updated.toISOString() : null,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export type { BranchPRState };
export { GitClientError };
