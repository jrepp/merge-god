/**
 * Gitea / Codeberg forge backend.
 *
 * Codeberg runs Gitea under the hood, so the REST API is identical. The only
 * observable difference is `identity.kind` (`ForgeKind.GITEA` vs
 * `ForgeKind.CODEBERG`), which is set from `config.identity.kind` and otherwise
 * ignored. Both backends are produced by {@link createGiteaForge}.
 */

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

const PAGE_SIZE = 50;

/** Resolve an auth token: config → env vars → `gh auth token` CLI. */
async function ghAuthToken(): Promise<string | undefined> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return undefined;
}

interface GiteaLabel {
  name?: string;
}

interface GiteaUser {
  login?: string;
}

interface GiteaPull {
  number?: number;
  index?: number;
  title?: string;
  state?: string;
  merged?: boolean;
  labels?: GiteaLabel[];
  user?: GiteaUser;
  html_url?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  body?: string;
  draft?: boolean;
  mergeable?: boolean;
  base?: { ref?: string };
  head?: { ref?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
}

interface GiteaComment {
  id?: number;
  body?: string;
  user?: GiteaUser;
  created_at?: string;
  updated_at?: string;
}

interface GiteaReviewComment {
  id?: number;
  body?: string;
  user?: GiteaUser;
  path?: string;
  line?: number;
  created_at?: string;
}

interface GiteaCommit {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
}

interface GiteaFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

interface GiteaStatus {
  state?: string;
  description?: string | null;
  target_url?: string | null;
  context?: string;
  created_at?: string;
}

interface GiteaReview {
  user?: GiteaUser;
  state?: string;
}

/**
 * Gitea/Codeberg forge client. Implements {@link Forge} over the Gitea REST
 * API v1 (`{apiBaseUrl ?? "https://codeberg.org"}/api/v1`).
 */
export class GiteaForge {
  readonly kind: ForgeKind;
  readonly identity: RepoIdentity;
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ForgeConfig) {
    this.kind = config.identity.kind;
    this.identity = config.identity;
    this.baseUrl = (config.apiBaseUrl ?? "https://codeberg.org").replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.token = config.token;
  }

  private async resolveToken(): Promise<string | undefined> {
    if (this.token !== undefined) return this.token;
    const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (env) return env;
    return ghAuthToken();
  }

  private async request<T>(
    path: string,
    opts: { accept?: string; query?: Record<string, string | number | undefined> } = {},
  ): Promise<{ status: number; data: T | null }> {
    const token = await this.resolveToken();
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {};
    if (opts.accept) headers["Accept"] = opts.accept;
    else headers["Accept"] = "application/json";
    if (token) headers["Authorization"] = `token ${token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers });
    } catch (err) {
      throw new ForgeError(`Gitea request failed: ${path}`, { cause: err });
    }
    if (res.status === 404) return { status: res.status, data: null };
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      throw new ForgeError(`Gitea ${res.status} for ${path}: ${text.slice(0, 200)}`, {
        status: res.status,
      });
    }
    if (opts.accept === "text/plain") {
      const text = await res.text();
      return { status: res.status, data: text as unknown as T };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const json = (await res.json()) as T;
      return { status: res.status, data: json };
    }
    const text = await res.text();
    return { status: res.status, data: (text || null) as unknown as T };
  }

  private repoPath(): string {
    return `/api/v1/repos/${this.identity.slug}`;
  }

  private mapState(pull: GiteaPull): PRState {
    if (pull.merged) return PRState.MERGED;
    const st = (pull.state ?? "open").toLowerCase();
    return st === "closed" ? PRState.CLOSED : PRState.OPEN;
  }

  private mapPullRequest(pull: GiteaPull): PullRequest {
    const number = pull.number ?? pull.index ?? 0;
    const state = this.mapState(pull);
    return createPullRequest({
      number,
      title: pull.title ?? "",
      state,
      head_branch: pull.head?.ref ?? "",
      base_branch: pull.base?.ref ?? "",
      author: pull.user?.login ?? "",
      url: pull.html_url ?? pull.url ?? "",
      created_at: pull.created_at ? new Date(pull.created_at) : new Date(0),
      updated_at: pull.updated_at ? new Date(pull.updated_at) : new Date(0),
      body: pull.body ?? null,
      draft: pull.draft ?? false,
      mergeable: pull.mergeable ?? true,
      labels: (pull.labels ?? []).map((l) => l.name ?? "").filter((s) => s !== ""),
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changed_files: pull.changed_files ?? 0,
      commits: pull.commits ?? 0,
    });
  }

  async listPullRequests(state: PRStateFilter = "open"): Promise<PullRequest[]> {
    const results: PullRequest[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.request<GiteaPull[]>(
        `${this.repoPath()}/pulls`,
        { query: { state, type: "pulls", page, limit: PAGE_SIZE } },
      );
      const pulls = data ?? [];
      for (const p of pulls) results.push(this.mapPullRequest(p));
      if (pulls.length < PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  async getPullRequest(number: number): Promise<PullRequest | null> {
    const { data } = await this.request<GiteaPull>(`${this.repoPath()}/pulls/${number}`);
    if (data === null) return null;
    return this.mapPullRequest(data);
  }

  async getPrsByLabels(labels: string[]): Promise<number[]> {
    if (labels.length === 0) return [];
    const labelQuery = labels.join(",");
    const results: number[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.request<GiteaPull[]>(`${this.repoPath()}/issues`, {
        query: { labels: labelQuery, type: "pulls", page, limit: PAGE_SIZE },
      });
      const pulls = data ?? [];
      for (const p of pulls) results.push(p.number ?? p.index ?? 0);
      if (pulls.length < PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  async getPrDiff(prNumber: number): Promise<string> {
    const { data, status } = await this.request<string>(
      `${this.repoPath()}/pulls/${prNumber}.diff`,
      { accept: "text/plain" },
    );
    if (data === null) {
      throw new ForgeError(`Gitea diff not found for PR ${prNumber}`, { status });
    }
    return data;
  }

  async getPrComments(prNumber: number): Promise<PRCommentShape[]> {
    const results: PRCommentShape[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.request<GiteaComment[]>(
        `${this.repoPath()}/issues/${prNumber}/comments`,
        { query: { page, limit: PAGE_SIZE } },
      );
      const comments = data ?? [];
      for (const c of comments) {
        results.push({
          id: c.id ?? 0,
          author: c.user?.login ?? "",
          body: c.body ?? "",
          created_at: c.created_at ?? "",
          updated_at: c.updated_at,
        });
      }
      if (comments.length < PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  async getPrReviewComments(prNumber: number): Promise<ReviewCommentShape[]> {
    const results: ReviewCommentShape[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.request<GiteaReviewComment[]>(
        `${this.repoPath()}/pulls/${prNumber}/comments`,
        { query: { page, limit: PAGE_SIZE } },
      );
      const comments = data ?? [];
      for (const c of comments) {
        results.push({
          id: c.id ?? 0,
          author: c.user?.login ?? "",
          body: c.body ?? "",
          path: c.path ?? "",
          line: c.line,
          created_at: c.created_at ?? "",
        });
      }
      if (comments.length < PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  async getPrCommits(prNumber: number): Promise<CommitInfoShape[]> {
    const { data } = await this.request<GiteaCommit[]>(`${this.repoPath()}/pulls/${prNumber}/commits`);
    const commits = data ?? [];
    return commits.map((c) => ({
      sha: c.sha ?? "",
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? "",
      date: c.commit?.author?.date ?? "",
    }));
  }

  async getPrFiles(prNumber: number): Promise<FileChangeShape[]> {
    const { data } = await this.request<GiteaFile[]>(`${this.repoPath()}/pulls/${prNumber}/files`);
    const files = data ?? [];
    return files.map((f) => ({
      filename: f.filename ?? "",
      status: f.status ?? "",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changes: f.changes ?? 0,
      patch: f.patch,
    }));
  }

  async getPrChecks(prNumber: number, headSha: string): Promise<CICheck[]> {
    void prNumber;
    const { data } = await this.request<GiteaStatus[]>(
      `${this.repoPath()}/commits/${headSha}/statuses`,
    );
    const statuses = data ?? [];
    const checks: CICheck[] = [];
    for (const s of statuses) {
      checks.push(
        createCICheck({
          name: s.context ?? "check",
          status: mapGiteaStatusState(s.state),
          conclusion: s.description ?? null,
          details_url: s.target_url ?? null,
          started_at: s.created_at ? new Date(s.created_at) : null,
          completed_at: s.created_at ? new Date(s.created_at) : null,
        }),
      );
    }
    return checks;
  }

  async getPrReviewDecision(prNumber: number): Promise<string | null> {
    const { data } = await this.request<GiteaReview[]>(
      `${this.repoPath()}/pulls/${prNumber}/reviews`,
    );
    const reviews = data ?? [];
    if (reviews.length === 0) return null;
    const latest = reviews[reviews.length - 1];
    const state = (latest?.state ?? "").toLowerCase();
    if (state === "approved") return "APPROVED";
    if (state === "changes_requested") return "CHANGES_REQUESTED";
    if (state === "commented") return "COMMENTED";
    return null;
  }
}

function mapGiteaStatusState(state: string | undefined): CIStatus {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return CIStatus.SUCCESS;
    case "error":
    case "failure":
      return CIStatus.FAILURE;
    case "pending":
    case "warning":
      return CIStatus.PENDING;
    default:
      return CIStatus.NONE;
  }
}

/** Construct a {@link GiteaForge} from a {@link ForgeConfig}. */
export function createGiteaForge(config: ForgeConfig): GiteaForge {
  return new GiteaForge(config);
}
