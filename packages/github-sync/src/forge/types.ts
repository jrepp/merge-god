/**
 * The forge abstraction.
 *
 * A `Forge` normalizes pull-request / branch / CI data from a specific hosting
 * platform (GitHub, Gitea/Codeberg, GitLab) onto the shared model types in
 * `../models`. Consumers (merge-god, SyncEngine) depend only on this interface,
 * never on a concrete backend.
 *
 * Convention: "PR" means a normalized pull request / merge request. Numbers are
 * the forge's native identifier (GitLab MR iids vs database ids — backends map
 * appropriately).
 */

import type {
  Branch,
  CICheck,
  CommitInfoShape,
  FileChangeShape,
  PRStateFilter,
  PullRequest,
  RepoIdentity,
  ReviewCommentShape,
  PRCommentShape,
} from "../models";

/** Lightweight shapes for raw sub-resources (kept loose; forge-native). */
export type { CommitInfoShape, FileChangeShape, ReviewCommentShape, PRCommentShape };

export interface Forge {
  /** Which forge this is. */
  readonly kind: import("../models.js").ForgeKind;

  /** The resolved repository identity (owner/repo or namespace/project). */
  readonly identity: RepoIdentity;

  /** List PRs. `state` defaults to "open". May be paginated. */
  listPullRequests(state?: PRStateFilter): Promise<PullRequest[]>;

  /** Fetch a single PR by its forge number/iid, or null if not found. */
  getPullRequest(number: number): Promise<PullRequest | null>;

  /** PR numbers whose labels include any of `labels` (case-insensitive). */
  getPrsByLabels(labels: string[]): Promise<number[]>;

  /** The unified diff of a PR (`git diff`-compatible text). */
  getPrDiff(prNumber: number): Promise<string>;

  /** Issue/PR conversation comments (top-level thread). */
  getPrComments(prNumber: number): Promise<PRCommentShape[]>;

  /** Inline code-review comments (attached to diff positions). */
  getPrReviewComments(prNumber: number): Promise<ReviewCommentShape[]>;

  /** Commits included in the PR. */
  getPrCommits(prNumber: number): Promise<CommitInfoShape[]>;

  /** Files changed in the PR (with patch metadata). */
  getPrFiles(prNumber: number): Promise<FileChangeShape[]>;

  /** CI checks for the PR head commit. */
  getPrChecks(prNumber: number, headSha: string): Promise<CICheck[]>;

  /** Aggregate review decision: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | null. */
  getPrReviewDecision(prNumber: number): Promise<string | null>;

  /** Close the forge client (release any pooled connections). Optional. */
  close?(): Promise<void>;
}

/** Configuration for constructing a forge client. */
export interface ForgeConfig {
  /** Repository identity; usually obtained via `detectForge(remoteUrl)`. */
  identity: RepoIdentity;
  /** Auth token. If omitted, backends fall back to env vars (GITHUB_TOKEN, etc.). */
  token?: string;
  /** Override the API base URL (self-hosted Gitea/GitLab, GitHub Enterprise). */
  apiBaseUrl?: string;
  /** Extra request options / fetch impl (for tests). */
  fetch?: typeof fetch;
}

export class ForgeError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ForgeError";
    this.status = opts?.status;
  }
}
