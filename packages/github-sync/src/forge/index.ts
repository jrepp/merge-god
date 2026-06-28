/**
 * Forge factory + re-exports.
 *
 * `createForge(config)` dispatches to the right backend by `identity.kind`.
 * `createForgeFromRepo(repoPath)` resolves the identity from a local checkout's
 * `origin` remote and constructs the backend. Codeberg is Gitea-compatible, so
 * it routes to the Gitea backend (only `identity.kind` differs).
 */

import { ForgeKind, type RepoIdentity } from "../models";
import { createGitHubForge } from "./github";
import { createGiteaForge } from "./gitea";
import { createGitLabForge } from "./gitlab";
import { detectForgeFromRepo, type DetectOptions } from "./detect";
import type { Forge, ForgeConfig } from "./types";
import { ForgeError } from "./types";

export type { Forge, ForgeConfig } from "./types";
export { ForgeError } from "./types";
export { detectForge, detectForgeFromRepo, inferKindFromHost, type DetectOptions } from "./detect";
export { GitHubForge, createGitHubForge } from "./github";
export { GiteaForge, createGiteaForge } from "./gitea";
export { GitLabForge, createGitLabForge } from "./gitlab";

/** Construct a forge client for an already-resolved repository identity. */
export function createForge(config: ForgeConfig): Forge {
  switch (config.identity.kind) {
    case ForgeKind.GITHUB:
      return createGitHubForge(config);
    case ForgeKind.GITEA:
    case ForgeKind.CODEBERG:
      return createGiteaForge(config);
    case ForgeKind.GITLAB:
      return createGitLabForge(config);
    default:
      throw new ForgeError(`Unsupported forge kind: ${config.identity.kind}`);
  }
}

export interface CreateForgeFromRepoOptions extends DetectOptions {
  token?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

/** Detect the forge from a local repo's origin remote and construct the client. */
export async function createForgeFromRepo(
  repoPath: string,
  opts: CreateForgeFromRepoOptions = {},
): Promise<{ forge: Forge; identity: RepoIdentity }> {
  const identity = await detectForgeFromRepo(repoPath, opts.kind ? { kind: opts.kind } : {});
  const forge = createForge({
    identity,
    token: opts.token,
    apiBaseUrl: opts.apiBaseUrl,
    fetch: opts.fetch,
  });
  return { forge, identity };
}
