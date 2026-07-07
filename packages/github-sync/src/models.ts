/**
 * Normalized, forge-neutral data models for @merge-god/github-sync.
 *
 * These are the canonical representations of PR / branch / CI state across all
 * supported forges (GitHub, Gitea/Codeberg, GitLab). Each forge backend maps its
 * native response shapes onto these types so downstream consumers (merge-god)
 * deal with one model regardless of where the data came from.
 *
 * Field names are snake_case for wire/DB compatibility; factory functions are
 * camelCase.
 */

export enum ForgeKind {
  GITHUB = "github",
  GITEA = "gitea",
  CODEBERG = "codeberg",
  GITLAB = "gitlab",
}

export enum PRState {
  OPEN = "open",
  CLOSED = "closed",
  MERGED = "merged",
  DRAFT = "draft",
}

export enum CIStatus {
  SUCCESS = "success",
  FAILURE = "failure",
  PENDING = "pending",
  NONE = "none",
}

export enum BranchStatus {
  UP_TO_DATE = "up_to_date",
  AHEAD = "ahead",
  BEHIND = "behind",
  DIVERGED = "diverged",
  LOCAL_ONLY = "local_only",
  REMOTE_ONLY = "remote_only",
  UNKNOWN = "unknown",
}

export type PRStateFilter = "open" | "closed" | "all";

export interface CICheck {
  name: string;
  status: CIStatus;
  conclusion: string | null;
  details_url: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export function createCICheck(opts: {
  name: string;
  status: CIStatus;
  conclusion?: string | null;
  details_url?: string | null;
  started_at?: Date | null;
  completed_at?: Date | null;
}): CICheck {
  return {
    name: opts.name,
    status: opts.status,
    conclusion: opts.conclusion ?? null,
    details_url: opts.details_url ?? null,
    started_at: opts.started_at ?? null,
    completed_at: opts.completed_at ?? null,
  };
}

export interface Branch {
  name: string;
  sha: string;
  is_local: boolean;
  is_remote: boolean;
  upstream: string | null;
  status: BranchStatus;
  ahead_by: number;
  behind_by: number;
  last_commit_date: Date | null;
  last_commit_author: string | null;
  last_commit_message: string | null;
}

export function createBranch(opts: {
  name: string;
  sha: string;
  is_local: boolean;
  is_remote: boolean;
  upstream?: string | null;
  status?: BranchStatus;
  ahead_by?: number;
  behind_by?: number;
  last_commit_date?: Date | null;
  last_commit_author?: string | null;
  last_commit_message?: string | null;
}): Branch {
  return {
    name: opts.name,
    sha: opts.sha,
    is_local: opts.is_local,
    is_remote: opts.is_remote,
    upstream: opts.upstream ?? null,
    status: opts.status ?? BranchStatus.UNKNOWN,
    ahead_by: opts.ahead_by ?? 0,
    behind_by: opts.behind_by ?? 0,
    last_commit_date: opts.last_commit_date ?? null,
    last_commit_author: opts.last_commit_author ?? null,
    last_commit_message: opts.last_commit_message ?? null,
  };
}

/**
 * Normalized pull request (merge request on GitLab). Carries the full set of
 * forge-derivable fields merge-god needs: CI, reviews, conflicts, diff stats.
 */
export interface PullRequest {
  number: number;
  title: string;
  state: PRState;
  head_branch: string;
  base_branch: string;
  author: string;
  url: string;
  created_at: Date;
  updated_at: Date;
  body: string | null;
  draft: boolean;
  mergeable: boolean;
  labels: string[];
  ci_checks: CICheck[];
  ci_summary: Record<string, number>;
  review_decision: string | null;
  approved_by: string[];
  changes_requested_by: string[];
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  has_conflicts: boolean;
  conflicting_files: string[];
}

export type DiffSource = "gh-pr-diff" | "local-git-diff" | "forge-file-patches";

export interface DiffAvailability {
  available: boolean;
  source: DiffSource | null;
  size: number;
  truncated: boolean;
  error: string | null;
}

export function createDiffAvailability(opts: {
  available: boolean;
  source?: DiffSource | null;
  size?: number;
  truncated?: boolean;
  error?: string | null;
}): DiffAvailability {
  return {
    available: opts.available,
    source: opts.source ?? null,
    size: opts.size ?? 0,
    truncated: opts.truncated ?? false,
    error: opts.error ?? null,
  };
}

export type MergeBlockerKind =
  | "draft"
  | "review_required"
  | "changes_requested"
  | "ci_failed"
  | "ci_pending"
  | "ci_missing"
  | "merge_conflicts"
  | "diff_unavailable"
  | "merge_state_blocked"
  | "external_gate"
  | "unknown";

export interface MergeBlocker {
  kind: MergeBlockerKind;
  status: "blocked" | "pending" | "unknown";
  summary: string;
  evidence_refs: string[];
}

export interface QueueConstituentPR {
  number: number;
  title: string | null;
  url: string | null;
  head_sha: string | null;
  status: "queued" | "merged_into_queue" | "validated" | "blocked" | "unknown";
  evidence_refs: string[];
}

export interface QueueMergeCommit {
  sha: string;
  pr_number: number | null;
  subject: string;
  conflict_files: string[];
  evidence_refs: string[];
}

export interface QueueValidationEvidence {
  command: string;
  status: "passed" | "failed" | "blocked" | "unknown";
  scope: string | null;
  evidence_ref: string | null;
}

export interface MergeQueueContext {
  is_queue: boolean;
  strategy: "title_pr_list" | "merge_commits" | "manual" | "unknown";
  constituent_prs: QueueConstituentPR[];
  merge_commits: QueueMergeCommit[];
  validation_evidence: QueueValidationEvidence[];
  unresolved_blockers: MergeBlocker[];
}

export function createPullRequest(opts: {
  number: number;
  title: string;
  state: PRState;
  head_branch: string;
  base_branch: string;
  author: string;
  url: string;
  created_at: Date;
  updated_at: Date;
  body?: string | null;
  draft?: boolean;
  mergeable?: boolean;
  labels?: string[];
  ci_checks?: CICheck[];
  ci_summary?: Record<string, number>;
  review_decision?: string | null;
  approved_by?: string[];
  changes_requested_by?: string[];
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  has_conflicts?: boolean;
  conflicting_files?: string[];
}): PullRequest {
  return {
    number: opts.number,
    title: opts.title,
    state: opts.state,
    head_branch: opts.head_branch,
    base_branch: opts.base_branch,
    author: opts.author,
    url: opts.url,
    created_at: opts.created_at,
    updated_at: opts.updated_at,
    body: opts.body ?? null,
    draft: opts.draft ?? false,
    mergeable: opts.mergeable ?? true,
    labels: opts.labels ?? [],
    ci_checks: opts.ci_checks ?? [],
    ci_summary: opts.ci_summary ?? {},
    review_decision: opts.review_decision ?? null,
    approved_by: opts.approved_by ?? [],
    changes_requested_by: opts.changes_requested_by ?? [],
    additions: opts.additions ?? 0,
    deletions: opts.deletions ?? 0,
    changed_files: opts.changed_files ?? 0,
    commits: opts.commits ?? 0,
    has_conflicts: opts.has_conflicts ?? false,
    conflicting_files: opts.conflicting_files ?? [],
  };
}

/** Aggregate CI status for a PR. */
export function getPRCiStatus(pr: PullRequest): CIStatus {
  if (pr.ci_checks.length === 0) return CIStatus.NONE;
  if (pr.ci_checks.some((c) => c.status === CIStatus.FAILURE)) return CIStatus.FAILURE;
  if (pr.ci_checks.some((c) => c.status === CIStatus.PENDING)) return CIStatus.PENDING;
  if (pr.ci_checks.every((c) => c.status === CIStatus.SUCCESS)) return CIStatus.SUCCESS;
  return CIStatus.NONE;
}

/** Determine processing mode from labels: "for-review" | "for-landing" | null. */
export function getProcessingMode(pr: PullRequest): string | null {
  const labelSet = new Set(pr.labels.map((l) => l.toLowerCase()));
  if (labelSet.has("for-review")) return "for-review";
  if (labelSet.has("for-landing")) return "for-landing";
  return null;
}

export function computeCiSummary(checks: CICheck[]): Record<string, number> {
  const summary: Record<string, number> = { total: checks.length, success: 0, failure: 0, pending: 0, none: 0 };
  for (const c of checks) {
    if (c.status === CIStatus.SUCCESS) summary.success! += 1;
    else if (c.status === CIStatus.FAILURE) summary.failure! += 1;
    else if (c.status === CIStatus.PENDING) summary.pending! += 1;
    else summary.none! += 1;
  }
  return summary;
}

/** Complete PR context captured for offline processing. */
export interface PRContext {
  repo_name: string;
  pr_number: number;
  pr_url: string;
  diff: string;
  body: string;
  comments: Record<string, unknown>[];
  review_comments: Record<string, unknown>[];
  commits: Record<string, unknown>[];
  files: Record<string, unknown>[];
  conflicts: Record<string, unknown>;
  ci_status: Record<string, unknown>;
  diff_availability: DiffAvailability;
  merge_blockers: MergeBlocker[];
  queue_context: MergeQueueContext | null;
  guidelines: string;
  commit_examples: string;
  captured_at: Date | null;
}

export function createPRContext(opts: {
  repo_name: string;
  pr_number: number;
  pr_url: string;
  diff: string;
  body: string;
  comments?: Record<string, unknown>[];
  review_comments?: Record<string, unknown>[];
  commits?: Record<string, unknown>[];
  files?: Record<string, unknown>[];
  conflicts?: Record<string, unknown>;
  ci_status?: Record<string, unknown>;
  diff_availability?: DiffAvailability;
  merge_blockers?: MergeBlocker[];
  queue_context?: MergeQueueContext | null;
  guidelines?: string;
  commit_examples?: string;
  captured_at?: Date | null;
}): PRContext {
  return {
    repo_name: opts.repo_name,
    pr_number: opts.pr_number,
    pr_url: opts.pr_url,
    diff: opts.diff,
    body: opts.body,
    comments: opts.comments ?? [],
    review_comments: opts.review_comments ?? [],
    commits: opts.commits ?? [],
    files: opts.files ?? [],
    conflicts: opts.conflicts ?? {},
    ci_status: opts.ci_status ?? {},
    diff_availability: opts.diff_availability ?? createDiffAvailability({
      available: opts.diff.length > 0,
      source: opts.diff.length > 0 ? "gh-pr-diff" : null,
      size: opts.diff.length,
    }),
    merge_blockers: opts.merge_blockers ?? [],
    queue_context: opts.queue_context ?? null,
    guidelines: opts.guidelines ?? "",
    commit_examples: opts.commit_examples ?? "",
    captured_at: opts.captured_at ?? null,
  };
}

export interface BranchPRState {
  branch_name: string;
  local_branch: Branch | null;
  remote_branch: Branch | null;
  branch_status: BranchStatus;
  pr: PullRequest | null;
  is_tracked: boolean;
  needs_push: boolean;
  needs_pull: boolean;
  has_pr: boolean;
  ci_status: CIStatus;
}

export function createBranchPRState(opts: {
  branch_name: string;
  local_branch?: Branch | null;
  remote_branch?: Branch | null;
  branch_status?: BranchStatus;
  pr?: PullRequest | null;
}): BranchPRState {
  const local_branch = opts.local_branch ?? null;
  const remote_branch = opts.remote_branch ?? null;
  const pr = opts.pr ?? null;

  let branch_status = opts.branch_status ?? BranchStatus.UNKNOWN;
  let is_tracked = false;
  let needs_push = false;
  let needs_pull = false;

  if (local_branch && remote_branch) {
    branch_status = local_branch.status;
    is_tracked = true;
    needs_push =
      local_branch.status === BranchStatus.AHEAD || local_branch.status === BranchStatus.DIVERGED;
    needs_pull =
      local_branch.status === BranchStatus.BEHIND || local_branch.status === BranchStatus.DIVERGED;
  } else if (local_branch) {
    branch_status = BranchStatus.LOCAL_ONLY;
  } else if (remote_branch) {
    branch_status = BranchStatus.REMOTE_ONLY;
  }

  return {
    branch_name: opts.branch_name,
    local_branch,
    remote_branch,
    branch_status,
    pr,
    is_tracked,
    needs_push,
    needs_pull,
    has_pr: pr !== null,
    ci_status: pr ? getPRCiStatus(pr) : CIStatus.NONE,
  };
}

export interface RepositoryState {
  repo_path: string;
  default_branch: string;
  branch_pr_states: BranchPRState[];
  _by_branch: Map<string, BranchPRState>;
  _by_pr_number: Map<number, BranchPRState>;
  last_updated: Date | null;
}

export function createRepositoryState(repo_path: string, default_branch: string): RepositoryState {
  return {
    repo_path,
    default_branch,
    branch_pr_states: [],
    _by_branch: new Map(),
    _by_pr_number: new Map(),
    last_updated: null,
  };
}

export function addRepositoryState(repo: RepositoryState, state: BranchPRState): void {
  repo.branch_pr_states.push(state);
  repo._by_branch.set(state.branch_name, state);
  if (state.pr) repo._by_pr_number.set(state.pr.number, state);
}

export function getRepositoryStateByBranch(
  repo: RepositoryState,
  branchName: string,
): BranchPRState | null {
  return repo._by_branch.get(branchName) ?? null;
}

export function getRepositoryStateByPR(
  repo: RepositoryState,
  prNumber: number,
): BranchPRState | null {
  return repo._by_pr_number.get(prNumber) ?? null;
}

export function getBranchesWithPRs(repo: RepositoryState): BranchPRState[] {
  return repo.branch_pr_states.filter((s) => s.has_pr);
}

export function getBranchesWithoutPRs(repo: RepositoryState): BranchPRState[] {
  return repo.branch_pr_states.filter((s) => !s.has_pr);
}

export function getBranchesNeedingSync(repo: RepositoryState): BranchPRState[] {
  return repo.branch_pr_states.filter((s) => s.needs_push || s.needs_pull);
}

export function getFailingCI(repo: RepositoryState): BranchPRState[] {
  return repo.branch_pr_states.filter((s) => s.ci_status === CIStatus.FAILURE);
}

export function branchPRStateSummary(state: BranchPRState): Record<string, unknown> {
  return {
    branch: state.branch_name,
    status: state.branch_status,
    has_pr: state.has_pr,
    pr_number: state.pr ? state.pr.number : null,
    pr_state: state.pr ? state.pr.state : null,
    ci_status: state.ci_status,
    ahead_by: state.local_branch ? state.local_branch.ahead_by : 0,
    behind_by: state.local_branch ? state.local_branch.behind_by : 0,
    needs_push: state.needs_push,
    needs_pull: state.needs_pull,
  };
}

export function repositoryStateSummary(repo: RepositoryState): Record<string, unknown> {
  const withPrs = repo.branch_pr_states.filter((s) => s.has_pr);
  return {
    repo_path: repo.repo_path,
    default_branch: repo.default_branch,
    total_branches: repo.branch_pr_states.length,
    branches_with_prs: withPrs.length,
    branches_without_prs: repo.branch_pr_states.length - withPrs.length,
    branches_needing_sync: repo.branch_pr_states.filter((s) => s.needs_push || s.needs_pull).length,
    failing_ci: repo.branch_pr_states.filter((s) => s.ci_status === CIStatus.FAILURE).length,
    last_updated: repo.last_updated ? repo.last_updated.toISOString() : null,
  };
}

/** Identity of a repository resolved from a git remote URL. */
export interface RepoIdentity {
  kind: ForgeKind;
  host: string;
  owner: string;
  repo: string;
  /** owner/repo (or namespace/project) — the canonical slug for the forge. */
  slug: string;
}

// --- Sub-resource shapes (forge-native fields, normalized loosely) -----------

export interface PRCommentShape {
  id: number;
  author: string;
  body: string;
  created_at: string;
  updated_at?: string;
}

export interface ReviewCommentShape {
  id: number;
  author: string;
  body: string;
  path: string;
  line?: number;
  created_at: string;
}

export interface CommitInfoShape {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface FileChangeShape {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
