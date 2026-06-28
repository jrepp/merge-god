/**
 * Detect the forge kind and owner/repo identity from a git remote URL.
 *
 * Supports SSH and HTTPS forms for GitHub, GitLab, Codeberg, and self-hosted
 * Gitea/GitLab. For ambiguous self-hosted hosts, pass an explicit `kind` hint.
 */

import { ForgeKind, type RepoIdentity } from "../models";

export interface DetectOptions {
  /** Force the forge kind when the host can't be inferred (self-hosted). */
  kind?: ForgeKind;
}

/**
 * Parse a remote URL into a RepoIdentity.
 *
 * Examples:
 *   git@github.com:owner/repo.git        -> { kind: GITHUB,  owner: "owner",  repo: "repo", slug: "owner/repo" }
 *   https://gitlab.com/group/sub/proj    -> { kind: GITLAB,  owner: "group",  repo: "proj", slug: "group/sub/proj" }
 *   git@codeberg.org:owner/repo.git      -> { kind: CODEBERG, owner: "owner", repo: "repo", slug: "owner/repo" }
 */
export function detectForge(remoteUrl: string, opts: DetectOptions = {}): RepoIdentity {
  const parsed = parseRemoteUrl(remoteUrl);
  const host = parsed.host.toLowerCase();
  const path = parsed.path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  if (!path) throw new Error(`Cannot parse repo path from remote URL: ${remoteUrl}`);

  const segments = path.split("/");
  const owner = segments[0] ?? "";
  const repo = segments[segments.length - 1] ?? "";
  const slug = path;

  if (!owner || !repo) throw new Error(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);

  const kind =
    opts.kind ??
    inferKindFromHost(host);

  return { kind, host, owner, repo, slug };
}

export function inferKindFromHost(host: string): ForgeKind {
  if (host === "github.com") return ForgeKind.GITHUB;
  if (host === "codeberg.org") return ForgeKind.CODEBERG;
  if (host === "gitlab.com") return ForgeKind.GITLAB;
  if (host.includes("gitlab")) return ForgeKind.GITLAB;
  if (host.includes("codeberg")) return ForgeKind.CODEBERG;
  if (host.includes("gitea")) return ForgeKind.GITEA;
  // Default: GitHub is the most common; caller should override for self-hosted.
  return ForgeKind.GITHUB;
}

function parseRemoteUrl(url: string): { host: string; path: string } {
  // SSH form: git@host:path
  const sshMatch = url.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (sshMatch) {
    return { host: sshMatch[1]!, path: sshMatch[2]! };
  }
  // HTTPS form: scheme://host/path
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    throw new Error(`Unrecognized remote URL format: ${url}`);
  }
}

/** Resolve the repo identity for a local checkout by reading `git remote get-url origin`. */
export async function detectForgeFromRepo(
  repoPath: string,
  opts: DetectOptions = {},
): Promise<RepoIdentity> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`Could not read origin remote URL in ${repoPath}`);
  }
  return detectForge(r.stdout.trim(), opts);
}
