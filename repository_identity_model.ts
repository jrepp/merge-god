export interface RepositoryIdentity {
  host: string | null;
  name_with_owner: string;
}

function cleanRepoName(value: string): string {
  return value.replace(/\.git$/i, "").replace(/\/(?:pulls?|issues?)(?:\/.*)?$/i, "");
}

/** Parse a GitHub URL, clone URL, HOST/OWNER/REPO, or OWNER/REPO specifier. */
export function parseRepositoryIdentity(value: string): RepositoryIdentity | null {
  const input = value.trim().replace(/\/+$/, "");
  if (!input) return null;

  try {
    const url = new URL(input);
    const parts = cleanRepoName(url.pathname).split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return {
      host: url.hostname.toLowerCase(),
      name_with_owner: `${parts[0]}/${parts[1]}`,
    };
  } catch {
    // Continue with SCP-like and shorthand forms.
  }

  const scpMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(input);
  if (scpMatch) {
    const parts = cleanRepoName(scpMatch[2] ?? "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return {
        host: (scpMatch[1] ?? "").toLowerCase(),
        name_with_owner: `${parts[0]}/${parts[1]}`,
      };
    }
  }

  const parts = cleanRepoName(input).split("/").filter(Boolean);
  if (parts.length === 2) return { host: null, name_with_owner: `${parts[0]}/${parts[1]}` };
  if (parts.length >= 3 && parts[0]?.includes(".")) {
    return {
      host: parts[0].toLowerCase(),
      name_with_owner: `${parts[1]}/${parts[2]}`,
    };
  }
  return null;
}

export function repositoryIdentityMatches(actual: RepositoryIdentity, expected: RepositoryIdentity): boolean {
  if (actual.name_with_owner.toLowerCase() !== expected.name_with_owner.toLowerCase()) return false;
  return expected.host === null || actual.host?.toLowerCase() === expected.host.toLowerCase();
}
