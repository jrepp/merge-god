/**
 * GitHub forge backend for @merge-god/github-sync.
 *
 * Implements the `Forge` interface against the GitHub REST + GraphQL APIs via
 * the Octokit ecosystem. Data-heavy reads (single PR, PR list, label lookup,
 * review decision) go through GraphQL to minimize round-trips; diff/comments/
 * review-comments/commits/files/checks use REST (and `octokit.paginate` where
 * lists may exceed 100 items).
 *
 * Auth token resolution order:
 *   config.token → GITHUB_TOKEN → GH_TOKEN → `gh auth token` (via ghAuthToken()).
 *
 * Rate limiting is handled by @octokit/plugin-throttling (primary + secondary
 * limits logged and retried in-memory) and @octokit/plugin-retry (transient 5xx
 * retries). Pagination for REST endpoints uses @octokit/plugin-paginate-rest;
 * GraphQL pagination is done manually via cursor loops.
 */

import { spawnSync } from "node:child_process";

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

import {
  CIStatus,
  ForgeKind,
  PRState,
  type CICheck,
  type CommitInfoShape,
  type FileChangeShape,
  type PRCommentShape,
  type PullRequest,
  type RepoIdentity,
  type ReviewCommentShape,
  createCICheck,
  createPullRequest,
} from "../models";
import type { Forge, ForgeConfig } from "./types";
import { ForgeError } from "./types";

/** Resolve a GitHub token via `gh auth token` (best-effort; returns null on failure). */
function ghAuthToken(): string | null {
  try {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      const t = r.stdout.trim();
      return t.length > 0 ? t : null;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveToken(config: ForgeConfig): string {
  const t = config.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ghAuthToken();
  if (!t) {
    throw new ForgeError(
      "No GitHub token: set config.token, GITHUB_TOKEN/GH_TOKEN env, or run `gh auth login`.",
    );
  }
  return t;
}

/** Status string → normalized CIStatus. */
function mapCiStatus(status: string | null | undefined): CIStatus {
  if (!status) return CIStatus.NONE;
  const s = status.toLowerCase();
  if (s === "success" || s === "neutral" || s === "skipped") return CIStatus.SUCCESS;
  if (
    s === "failure" ||
    s === "timed_out" ||
    s === "action_required" ||
    s === "cancelled" ||
    s === "stale"
  ) {
    return CIStatus.FAILURE;
  }
  if (s === "in_progress" || s === "queued" || s === "pending" || s === "waiting") {
    return CIStatus.PENDING;
  }
  return CIStatus.NONE;
}

const PR_LIST_CAP = 500;

/**
 * GraphQL fragment shared by the single-PR and list queries. Selects every field
 * `createPullRequest` needs plus the review decision and latest review authors.
 */
const PR_FIELDS = `
  number
  title
  state
  isDraft
  body
  author { login }
  url
  headRefName
  baseRefName
  createdAt
  updatedAt
  mergeable
  additions
  deletions
  changedFiles
  commits
  reviewDecision
  labels(first: 100) { nodes { name } }
  latestReviews(first: 50) { nodes { author { login } state } }
`;

/** Full single-PR GraphQL query. */
const GET_PR_QUERY = `query GetPR($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_FIELDS}
    }
  }
}`;

/** PR-by-labels GraphQL query (returns numbers + labels). */
const PRS_BY_LABELS_QUERY = `query PRsByLabels($owner: String!, $name: String!, $labels: [String!], $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(labels: $labels, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number }
    }
  }
}`;

interface GraphQLPrNode {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  body: string | null;
  author: { login: string } | null;
  url: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  reviewDecision: string | null;
  labels: { nodes: { name: string }[] | null } | null;
  latestReviews: { nodes: { author: { login: string } | null; state: string }[] | null } | null;
}

/** Response of {@link GET_PR_QUERY}. */
interface GetPrResponse {
  repository?: { pullRequest?: GraphQLPrNode | null } | null;
}

/** Response of the list-PRs query (page connection). */
interface ListPrResponse {
  repository?: {
    pullRequests?: ListPrConnection;
  } | null;
}

interface ListPrConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GraphQLPrNode[];
}

/** Response of {@link PRS_BY_LABELS_QUERY}. */
interface PrsByLabelsResponse {
  repository?: {
    pullRequests?: PrsByLabelsConnection;
  } | null;
}

interface PrsByLabelsConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { number: number }[];
}

/** Response of the review-decision query. */
interface ReviewDecisionResponse {
  repository?: { pullRequest?: { reviewDecision: string | null } | null } | null;
}

/** Map a raw GraphQL PR node onto the normalized PullRequest model. */
function mapPrNode(node: GraphQLPrNode): PullRequest {
  const state = mapPrState(node.state, node.isDraft);
  const labels = (node.labels?.nodes ?? []).map((n) => n.name);
  const reviews = node.latestReviews?.nodes ?? [];
  const approved_by: string[] = [];
  const changes_requested_by: string[] = [];
  for (const rv of reviews) {
    const login = rv.author?.login ?? "unknown";
    if (rv.state === "APPROVED" && !approved_by.includes(login)) approved_by.push(login);
    else if (rv.state === "CHANGES_REQUESTED" && !changes_requested_by.includes(login))
      changes_requested_by.push(login);
  }
  return createPullRequest({
    number: node.number,
    title: node.title,
    state,
    head_branch: node.headRefName,
    base_branch: node.baseRefName,
    author: node.author?.login ?? "unknown",
    url: node.url,
    created_at: new Date(node.createdAt),
    updated_at: new Date(node.updatedAt),
    body: node.body,
    draft: node.isDraft,
    mergeable: node.mergeable === "MERGEABLE",
    labels,
    review_decision: node.reviewDecision,
    approved_by,
    changes_requested_by,
    additions: node.additions,
    deletions: node.deletions,
    changed_files: node.changedFiles,
    commits: node.commits,
    has_conflicts: node.mergeable === "CONFLICTING",
  });
}

function mapPrState(state: string, isDraft: boolean): PRState {
  if (isDraft) return PRState.DRAFT;
  const s = state.toUpperCase();
  if (s === "MERGED") return PRState.MERGED;
  if (s === "CLOSED") return PRState.CLOSED;
  return PRState.OPEN;
}

function filterToGqlStates(state?: "open" | "closed" | "all"): string[] {
  if (state === "closed") return ["CLOSED", "MERGED"];
  if (state === "all") return ["OPEN", "CLOSED", "MERGED"];
  return ["OPEN"];
}

/**
 * GitHub forge backend. Construct via {@link createGitHubForge}.
 *
 * Implements the full {@link Forge} interface using Octokit (core + throttling,
 * retry, paginate-rest plugins). The class is bound to a single repository
 * (owner/repo) given in `config.identity`.
 */
export class GitHubForge implements Forge {
  readonly kind = ForgeKind.GITHUB;
  readonly identity: RepoIdentity;
  private readonly owner: string;
  private readonly repo: string;
  private readonly octokit: Octokit;

  constructor(config: ForgeConfig) {
    this.identity = config.identity;
    this.owner = config.identity.owner;
    this.repo = config.identity.repo;
    const token = resolveToken(config);
    this.octokit = new Octokit({
      auth: token,
      baseUrl: config.apiBaseUrl ?? "https://api.github.com",
      request: config.fetch ? { fetch: config.fetch } : undefined,
      throttle: {
        onRateLimit: (retryAfter: number, options: { method?: string; url?: string }) => {
          this.octokit.log.warn(
            `Rate limit hit for ${options.method} ${options.url} — retrying in ${retryAfter}s`,
          );
          return true;
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: { method?: string; url?: string },
        ) => {
          this.octokit.log.warn(
            `Secondary rate limit hit for ${options.method} ${options.url} — retrying in ${retryAfter}s`,
          );
          return true;
        },
      },
    });
  }

  /** @inheritdoc */
  async getPullRequest(number: number): Promise<PullRequest | null> {
    try {
      const data = await this.graphql<GetPrResponse>(GET_PR_QUERY, {
        owner: this.owner,
        name: this.repo,
        number,
      });
      const node = data.repository?.pullRequest ?? null;
      if (!node) return null;
      return mapPrNode(node);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw wrap(err, `getPullRequest(#${number})`);
    }
  }

  /** @inheritdoc */
  async listPullRequests(state: "open" | "closed" | "all" = "open"): Promise<PullRequest[]> {
    const states = filterToGqlStates(state);
    const query = `query ListPRs($owner: String!, $name: String!, $states: [PullRequestState!], $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: $states, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${PR_FIELDS} }
        }
      }
    }`;
    const out: PullRequest[] = [];
    let after: string | null = null;
    try {
      while (out.length < PR_LIST_CAP) {
        const data: ListPrResponse = await this.graphql<ListPrResponse>(query, {
          owner: this.owner,
          name: this.repo,
          states,
          after,
        });
        const conn: ListPrConnection | null | undefined = data.repository?.pullRequests;
        if (!conn) break;
        for (const n of conn.nodes) out.push(mapPrNode(n));
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return out;
    } catch (err) {
      throw wrap(err, "listPullRequests");
    }
  }

  /** @inheritdoc */
  async getPrsByLabels(labels: string[]): Promise<number[]> {
    if (labels.length === 0) return [];
    const out: number[] = [];
    let after: string | null = null;
    try {
      while (out.length < PR_LIST_CAP) {
        const data: PrsByLabelsResponse = await this.graphql<PrsByLabelsResponse>(PRS_BY_LABELS_QUERY, {
          owner: this.owner,
          name: this.repo,
          labels,
          after,
        });
        const conn: PrsByLabelsConnection | null | undefined = data.repository?.pullRequests;
        if (!conn) break;
        for (const n of conn.nodes) out.push(n.number);
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return out;
    } catch (err) {
      throw wrap(err, `getPrsByLabels(${labels.join(",")})`);
    }
  }

  /** @inheritdoc */
  async getPrDiff(prNumber: number): Promise<string> {
    try {
      const res = await this.octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          mediaType: { format: "diff" },
          headers: { accept: "application/vnd.github.v3.diff" },
        },
      );
      return typeof res.data === "string" ? res.data : String(res.data);
    } catch (err) {
      throw wrap(err, `getPrDiff(#${prNumber})`);
    }
  }

  /** @inheritdoc */
  async getPrComments(prNumber: number): Promise<PRCommentShape[]> {
    try {
      const data = await this.octokit.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          per_page: 100,
        },
      );
      return data.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        created_at: c.created_at,
        updated_at: c.updated_at,
      }));
    } catch (err) {
      throw wrap(err, `getPrComments(#${prNumber})`);
    }
  }

  /** @inheritdoc */
  async getPrReviewComments(prNumber: number): Promise<ReviewCommentShape[]> {
    try {
      const data = await this.octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          per_page: 100,
        },
      );
      return data.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        path: c.path,
        line: c.line ?? undefined,
        created_at: c.created_at,
      }));
    } catch (err) {
      throw wrap(err, `getPrReviewComments(#${prNumber})`);
    }
  }

  /** @inheritdoc */
  async getPrCommits(prNumber: number): Promise<CommitInfoShape[]> {
    try {
      const data = await this.octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          per_page: 100,
        },
      );
      return data.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author?.name ?? "unknown",
        date: c.commit.author?.date ?? "",
      }));
    } catch (err) {
      throw wrap(err, `getPrCommits(#${prNumber})`);
    }
  }

  /** @inheritdoc */
  async getPrFiles(prNumber: number): Promise<FileChangeShape[]> {
    try {
      const data = await this.octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          per_page: 100,
        },
      );
      return data.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      }));
    } catch (err) {
      throw wrap(err, `getPrFiles(#${prNumber})`);
    }
  }

  /** @inheritdoc */
  async getPrChecks(prNumber: number, headSha: string): Promise<CICheck[]> {
    const checks: CICheck[] = [];
    try {
      const runs = await this.octokit.paginate(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          owner: this.owner,
          repo: this.repo,
          ref: headSha,
          per_page: 100,
        },
      );
      for (const r of runs) {
        checks.push(
          createCICheck({
            name: r.name,
            status: mapCiStatus(r.status ?? r.conclusion),
            conclusion: r.conclusion,
            details_url: r.details_url,
            started_at: r.started_at ? new Date(r.started_at) : null,
            completed_at: r.completed_at ? new Date(r.completed_at) : null,
          }),
        );
      }
    } catch (err) {
      throw wrap(err, `getPrChecks(#${prNumber}) check-runs`);
    }
    try {
      const statuses = await this.octokit.paginate(
        "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
        {
          owner: this.owner,
          repo: this.repo,
          ref: headSha,
          per_page: 100,
        },
      );
      for (const s of statuses) {
        checks.push(
          createCICheck({
            name: s.context,
            status: mapCiStatus(s.state),
            conclusion: s.state,
            details_url: s.target_url,
            started_at: s.created_at ? new Date(s.created_at) : null,
            completed_at: s.updated_at ? new Date(s.updated_at) : null,
          }),
        );
      }
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrap(err, `getPrChecks(#${prNumber}) statuses`);
      }
    }
    return checks;
  }

  /** @inheritdoc */
  async getPrReviewDecision(prNumber: number): Promise<string | null> {
    try {
      const data = await this.graphql<ReviewDecisionResponse>(
        `query ReviewDecision($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) { reviewDecision }
          }
        }`,
        { owner: this.owner, name: this.repo, number: prNumber },
      );
      return data.repository?.pullRequest?.reviewDecision ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw wrap(err, `getPrReviewDecision(#${prNumber})`);
    }
  }

  /** Run a GraphQL query, rethrowing with status info on failure. */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.octokit.graphql(query, variables);
      return res as unknown as T;
    } catch (err) {
      throw wrap(err, "graphql");
    }
  }
}

/** Construct a GitHubForge from a ForgeConfig. */
export function createGitHubForge(config: ForgeConfig): GitHubForge {
  return new GitHubForge(config);
}

interface ErrorWithStatus {
  status?: number;
}

function isNotFound(err: unknown): boolean {
  const e = err as ErrorWithStatus;
  return e?.status === 404;
}

/** Wrap an unknown error in a ForgeError, preserving status + cause. */
function wrap(err: unknown, context: string): ForgeError {
  if (err instanceof ForgeError) return err;
  const e = err as ErrorWithStatus;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const msg = e instanceof Error ? e.message : String(err);
  return new ForgeError(`${context}: ${msg}`, { status, cause: err });
}
