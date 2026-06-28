/**
 * GitLab forge backend.
 *
 * Implements {@link Forge} over the GitLab v4 REST API via `@gitbeaker/rest`.
 * The forge-native number for a PR (merge request) is the MR **iid** (not the
 * database id) — callers pass iids; this class maps them to MRs.
 */

import { Gitlab } from "@gitbeaker/rest";
import {
  CIStatus,
  ForgeKind,
  PRState,
  createCICheck,
  createPullRequest,
  type CICheck,
  type CommitInfoShape,
  type FileChangeShape,
  type PRCommentShape,
  type PRStateFilter,
  type PullRequest,
  type RepoIdentity,
  type ReviewCommentShape,
} from "../models";
import { ForgeError, type ForgeConfig } from "./types";

/** Extract HTTP status from a gitbeaker error (varies across versions). */
function errorStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; status?: number; cause?: { response?: { status?: number } } };
  return e?.response?.status ?? e?.status ?? e?.cause?.response?.status;
}

/** True if a gitbeaker error represents an HTTP 404. */
function isNotFound(err: unknown): boolean {
  return errorStatus(err) === 404;
}

/** Count added/removed lines in a unified-diff patch. */
function countDiffLines(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

interface GitLabNote {
  id?: number;
  body?: string;
  author?: { username?: string };
  created_at?: string;
  updated_at?: string;
  system?: boolean;
  position?: { new_path?: string; new_line?: number };
}

interface GitLabDiscussion {
  id?: string;
  notes?: GitLabNote[];
}

interface GitLabCommit {
  id?: string;
  short_id?: string;
  message?: string;
  author_name?: string;
  authored_date?: string;
}

interface GitLabChange {
  old_path?: string;
  new_path?: string;
  a_mode?: string;
  b_mode?: string;
  diff?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  additions?: number;
  deletions?: number;
}

interface GitLabPipeline {
  id?: number;
  sha?: string;
  status?: string;
  web_url?: string;
}

interface GitLabJob {
  id?: number;
  name?: string;
  status?: string;
  web_url?: string;
  started_at?: string;
  finished_at?: string;
}

interface GitLabMR {
  iid?: number;
  title?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  author?: { username?: string };
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  description?: string;
  work_in_progress?: boolean;
  merge_status?: string;
  labels?: string[];
}

/**
 * GitLab forge client. The forge number for a merge request is its **iid**.
 */
export class GitLabForge {
  readonly kind: ForgeKind;
  readonly identity: RepoIdentity;
  private readonly client: InstanceType<typeof Gitlab>;
  private readonly projectPath: string;
  private readonly apiBaseUrl: string;
  private readonly token: string;

  constructor(config: ForgeConfig) {
    this.kind = config.identity.kind;
    this.identity = config.identity;
    this.projectPath = config.identity.slug;
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
    this.token = config.token ?? "";
    this.client = new Gitlab({
      host: this.apiBaseUrl,
      token: this.token,
    });
  }

  /**
   * Raw GET against the GitLab v4 REST API for endpoints not exposed as
   * named resources by this version of `@gitbeaker/rest` (MR diffs, commits,
   * changes). 404 → null; other failures throw {@link ForgeError}.
   */
  private async rawGet<T>(path: string): Promise<T | null> {
    const url = `${this.apiBaseUrl}/projects/${encodeURIComponent(this.projectPath)}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers["PRIVATE-TOKEN"] = this.token;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      throw new ForgeError(`GitLab GET ${path} failed`, { cause: err });
    }
    if (res.status === 404) return null;
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      throw new ForgeError(`GitLab ${res.status} for ${path}: ${text.slice(0, 200)}`, {
        status: res.status,
      });
    }
    return (await res.json()) as T;
  }

  private mapState(mr: GitLabMR): PRState {
    const st = (mr.state ?? "").toLowerCase();
    if (st === "merged") return PRState.MERGED;
    if (st === "closed") return PRState.CLOSED;
    if (st === "opened" || st === "open") return PRState.OPEN;
    return PRState.OPEN;
  }

  private mapMR(mr: GitLabMR): PullRequest {
    return createPullRequest({
      number: mr.iid ?? 0,
      title: mr.title ?? "",
      state: this.mapState(mr),
      head_branch: mr.source_branch ?? "",
      base_branch: mr.target_branch ?? "",
      author: mr.author?.username ?? "",
      url: mr.web_url ?? "",
      created_at: mr.created_at ? new Date(mr.created_at) : new Date(0),
      updated_at: mr.updated_at ? new Date(mr.updated_at) : new Date(0),
      body: mr.description ?? null,
      draft: mr.work_in_progress ?? false,
      mergeable: (mr.merge_status ?? "").toLowerCase() === "can_be_merged",
      labels: mr.labels ?? [],
    });
  }

  async listPullRequests(state: PRStateFilter = "open"): Promise<PullRequest[]> {
    const opts: Record<string, unknown> = { projectId: this.projectPath };
    if (state === "open") opts.state = "opened";
    else if (state === "closed") opts.state = "closed";
    let raw: unknown;
    try {
      raw = await this.client.MergeRequests.all(opts as Parameters<typeof this.client.MergeRequests.all>[0]);
    } catch (err) {
      throw new ForgeError(`GitLab listPullRequests failed`, { cause: err });
    }
    const mrs = (raw as GitLabMR[]) ?? [];
    return mrs.map((m) => this.mapMR(m));
  }

  async getPullRequest(number: number): Promise<PullRequest | null> {
    let raw: unknown;
    try {
      raw = await this.client.MergeRequests.show(this.projectPath, number);
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e?.response?.status === 404) return null;
      throw new ForgeError(`GitLab getPullRequest ${number} failed`, {
        status: e?.response?.status,
        cause: err,
      });
    }
    return this.mapMR(raw as GitLabMR);
  }

  /**
   * Return the iids of merge requests matching any of `labels`.
   * Labels are matched case-insensitively by the GitLab API and joined with
   * commas for the `labels` query parameter.
   */
  async getPrsByLabels(labels: string[]): Promise<number[]> {
    if (labels.length === 0) return [];
    let raw: unknown;
    try {
      raw = await this.client.MergeRequests.all({
        projectId: this.projectPath,
        labels: labels.join(","),
      } as Parameters<typeof this.client.MergeRequests.all>[0]);
    } catch (err) {
      throw new ForgeError(`GitLab getPrsByLabels failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const mrs = (raw as GitLabMR[]) ?? [];
    return mrs.map((m) => m.iid ?? 0).filter((n) => n > 0);
  }

  /**
   * Build a unified-diff-compatible string for the MR by concatenating the
   * per-file diffs returned by `MergeRequestDiffs.all`. Returns "" if no
   * diffs are available.
   */
  async getPrDiff(prNumber: number): Promise<string> {
    let diffs: { diff?: string }[] | null;
    try {
      diffs = await this.rawGet<{ diff?: string }[]>(`/merge_requests/${prNumber}/diffs`);
    } catch (err) {
      throw new ForgeError(`GitLab getPrDiff ${prNumber} failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    if (!diffs || diffs.length === 0) return "";
    return diffs.map((d) => d.diff ?? "").filter((s) => s.length > 0).join("\n");
  }

  /**
   * Top-level MR thread comments. On GitLab, MR notes are accessed via
   * `MergeRequestNotes.all` (alias of issue notes for the MR conversation).
   */
  async getPrComments(prNumber: number): Promise<PRCommentShape[]> {
    let raw: unknown;
    try {
      raw = await this.client.MergeRequestNotes.all(this.projectPath, prNumber);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw new ForgeError(`GitLab getPrComments ${prNumber} failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const notes = (raw as GitLabNote[]) ?? [];
    return notes
      .filter((n) => n.system === undefined || n.system === false)
      .map((n) => ({
        id: n.id ?? 0,
        author: n.author?.username ?? "",
        body: n.body ?? "",
        created_at: n.created_at ?? "",
        updated_at: n.updated_at,
      }));
  }

  /**
   * Inline code-review comments: discussions whose notes carry a `position`
   * (i.e. they are anchored to a diff). General (non-positional) notes are
   * skipped.
   */
  async getPrReviewComments(prNumber: number): Promise<ReviewCommentShape[]> {
    let raw: unknown;
    try {
      raw = await this.client.MergeRequestDiscussions.all(this.projectPath, prNumber);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw new ForgeError(`GitLab getPrReviewComments ${prNumber} failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const discussions = (raw as GitLabDiscussion[]) ?? [];
    const out: ReviewCommentShape[] = [];
    for (const d of discussions) {
      const notes = d.notes ?? [];
      for (const n of notes) {
        if (!n.position) continue;
        out.push({
          id: n.id ?? 0,
          author: n.author?.username ?? "",
          body: n.body ?? "",
          path: n.position?.new_path ?? "",
          line: n.position?.new_line,
          created_at: n.created_at ?? "",
        });
      }
    }
    return out;
  }

  /** Commits included in the merge request. */
  async getPrCommits(prNumber: number): Promise<CommitInfoShape[]> {
    let commits: GitLabCommit[] | null;
    try {
      commits = await this.rawGet<GitLabCommit[]>(`/merge_requests/${prNumber}/commits`);
    } catch (err) {
      throw new ForgeError(`GitLab getPrCommits ${prNumber} failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    return (commits ?? []).map((c) => ({
      sha: c.id ?? "",
      message: c.message ?? "",
      author: c.author_name ? c.author_name : "",
      date: c.authored_date ?? "",
    }));
  }

  /**
   * Files changed in the MR via `MergeRequestChanges.all`. GitLab does not
   * always provide line counts, so additions/deletions are derived from the
   * diff patch when absent.
   */
  async getPrFiles(prNumber: number): Promise<FileChangeShape[]> {
    let resp: { changes?: GitLabChange[] } | null;
    try {
      resp = await this.rawGet<{ changes?: GitLabChange[] }>(`/merge_requests/${prNumber}/changes`);
    } catch (err) {
      throw new ForgeError(`GitLab getPrFiles ${prNumber} failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const changes = resp?.changes ?? [];
    return changes.map((c) => {
      const patch = c.diff ?? "";
      const counts = countDiffLines(patch);
      const additions = typeof c.additions === "number" ? c.additions : counts.additions;
      const deletions = typeof c.deletions === "number" ? c.deletions : counts.deletions;
      return {
        filename: c.new_path ?? c.old_path ?? "",
        status: fileStatus(c),
        additions,
        deletions,
        changes: additions + deletions,
        patch,
      };
    });
  }

  /**
   * CI checks for the head commit. GitLab CI is exposed as pipelines + jobs;
   * the latest pipeline for `headSha` is used and its jobs mapped to
   * {@link CICheck}. Returns [] if there are no pipelines.
   */
  async getPrChecks(_prNumber: number, headSha: string): Promise<CICheck[]> {
    let pipelinesRaw: unknown;
    try {
      pipelinesRaw = await this.client.Pipelines.all(this.projectPath, { sha: headSha });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw new ForgeError(`GitLab getPrChecks pipelines failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const pipelines = (pipelinesRaw as GitLabPipeline[]) ?? [];
    if (pipelines.length === 0) return [];
    const latest = pipelines[0];
    const pipelineId = latest?.id;
    if (pipelineId === undefined) return [];

    let jobsRaw: unknown;
    try {
      jobsRaw = await this.client.Jobs.all(this.projectPath, { pipelineId });
    } catch (err) {
      throw new ForgeError(`GitLab getPrChecks jobs failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const jobs = (jobsRaw as GitLabJob[]) ?? [];
    const checks: CICheck[] = [];
    for (const j of jobs) {
      checks.push(
        createCICheck({
          name: j.name ?? "job",
          status: mapGitLabJobStatus(j.status),
          conclusion: j.status ?? null,
          details_url: j.web_url ?? null,
          started_at: j.started_at ? new Date(j.started_at) : null,
          completed_at: j.finished_at ? new Date(j.finished_at) : null,
        }),
      );
    }
    return checks;
  }

  /**
   * Coarse review decision for the MR. GitLab has no single approval-state
   * field; we infer it from `detailed_merge_status` /
   * `blocking_discussions_resolved`. "mergeable" → APPROVED; blocked by
   * unresolved discussions → CHANGES_REQUESTED; otherwise COMMENTED or null.
   */
  async getPrReviewDecision(prNumber: number): Promise<string | null> {
    let raw: unknown;
    try {
      raw = await this.client.MergeRequests.show(this.projectPath, prNumber);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new ForgeError(`GitLab getPrReviewDecision ${prNumber} failed`, {
        status: errorStatus(err),
        cause: err,
      });
    }
    const mr = raw as GitLabMR & {
      detailed_merge_status?: string;
      blocking_discussions_resolved?: boolean;
      has_conflicts?: boolean;
    };
    const detailed = (mr.detailed_merge_status ?? "").toLowerCase();
    if (detailed === "mergeable" || detailed === "can_be_merged") return "APPROVED";
    if (mr.blocking_discussions_resolved === false) return "CHANGES_REQUESTED";
    const blocked = [
      "discussion_status_unresolved",
      "blocked_status",
      "conflict",
    ].some((k) => detailed.includes(k));
    if (blocked) return "CHANGES_REQUESTED";
    if (mr.has_conflicts === true) return "CHANGES_REQUESTED";
    if (detailed === "") return null;
    return "COMMENTED";
  }
}

/** Map a GitLab pipeline job status onto {@link CIStatus}. */
function mapGitLabJobStatus(status: string | undefined): CIStatus {
  switch ((status ?? "").toLowerCase()) {
    case "success":
      return CIStatus.SUCCESS;
    case "failed":
    case "canceled":
      return CIStatus.FAILURE;
    case "running":
    case "pending":
    case "waiting":
    case "preparing":
    case "scheduled":
    case "manual":
    case "created":
      return CIStatus.PENDING;
    default:
      return CIStatus.NONE;
  }
}

/** Derive a GitHub-style file status from a GitLab change record. */
function fileStatus(c: GitLabChange): string {
  if (c.new_file) return "added";
  if (c.deleted_file) return "deleted";
  if (c.renamed_file) return "renamed";
  return "modified";
}

/** Construct a {@link GitLabForge} from a {@link ForgeConfig}. */
export function createGitLabForge(config: ForgeConfig): GitLabForge {
  return new GitLabForge(config);
}
