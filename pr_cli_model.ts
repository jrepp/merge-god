import { basename, resolve } from "node:path";

export type PrWorkflowAction = "pr" | "resume";

export interface ConfiguredCliRepository {
  path?: unknown;
  name?: unknown;
  repo?: unknown;
  enabled?: boolean;
}

export interface CliRepositoryTarget {
  path: string;
  name: string;
  expected_repo: string | null;
  source: "explicit" | "cwd" | "config";
}

export interface SelectCliRepositoryInput {
  cwd: string;
  git_root: string | null;
  explicit_path?: string | null;
  explicit_repo_name?: string | null;
  configured_repos?: ConfiguredCliRepository[];
}

function enabledConfiguredRepositories(repos: ConfiguredCliRepository[]): ConfiguredCliRepository[] {
  return repos.filter((repo) => repo.enabled ?? true);
}

function configuredRepositoryForPath(
  repos: ConfiguredCliRepository[],
  repoPath: string,
): ConfiguredCliRepository | null {
  return enabledConfiguredRepositories(repos).find((repo) =>
    typeof repo.path === "string" && resolve(repo.path) === repoPath
  ) ?? null;
}

function targetFromPath(
  repoPath: string,
  source: CliRepositoryTarget["source"],
  configured: ConfiguredCliRepository | null,
  explicitRepoName: string | null,
): CliRepositoryTarget {
  const configuredName = typeof configured?.name === "string" && configured.name.trim()
    ? configured.name.trim()
    : null;
  const expectedRepo = typeof configured?.repo === "string" && configured.repo.trim()
    ? configured.repo.trim()
    : null;
  return {
    path: repoPath,
    name: explicitRepoName?.trim() || configuredName || basename(repoPath),
    expected_repo: expectedRepo,
    source,
  };
}

/** Select one checkout with the least surprising precedence for one-PR work. */
export function selectCliRepository(input: SelectCliRepositoryInput): CliRepositoryTarget {
  const configuredRepos = input.configured_repos ?? [];
  const explicitRepoName = input.explicit_repo_name ?? null;
  if (input.explicit_path) {
    const repoPath = resolve(input.cwd, input.explicit_path);
    return targetFromPath(
      repoPath,
      "explicit",
      configuredRepositoryForPath(configuredRepos, repoPath),
      explicitRepoName,
    );
  }
  if (input.git_root) {
    const repoPath = resolve(input.git_root);
    return targetFromPath(
      repoPath,
      "cwd",
      configuredRepositoryForPath(configuredRepos, repoPath),
      explicitRepoName,
    );
  }
  const enabled = enabledConfiguredRepositories(configuredRepos);
  if (enabled.length !== 1) {
    throw new Error(
      `No current git checkout and ${enabled.length} enabled repositories are configured; pass --repo-path`,
    );
  }
  const configured = enabled[0]!;
  if (typeof configured.path !== "string" || !configured.path.trim()) {
    throw new Error("The enabled repository is missing repos[].path");
  }
  return targetFromPath(
    resolve(input.cwd, configured.path),
    "config",
    configured,
    explicitRepoName,
  );
}

export function parsePositivePrNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error("PR number must be a positive integer");
  return number;
}
