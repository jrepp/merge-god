/**
 * Pure planning policy for PRs carrying the repository's `duplicate` label.
 *
 * Git and GitHub collection live in analyze_duplicates.ts. This module only
 * decides what the collected evidence is strong enough to prove.
 */

export type DuplicateDisposition =
  | "already_landed"
  | "canonical_open"
  | "exact_open_duplicate"
  | "embark_candidate"
  | "unverified_duplicate"
  | "analysis_failed";

export interface DuplicateBaseMatch {
  commit: string;
  pr_number: number | null;
  pr_url: string | null;
}

export interface DuplicatePrEvidence {
  number: number;
  title: string;
  url: string;
  created_at: string;
  labels: string[];
  is_draft: boolean;
  head_oid: string;
  base_ref: string;
  patch_id: string | null;
  changed_files: string[];
  base_matches: DuplicateBaseMatch[];
  error: string | null;
}

export interface DuplicateResolution {
  pr_number: number;
  disposition: DuplicateDisposition;
  canonical_pr_number: number | null;
  canonical_pr_url: string | null;
  equivalent_open_pr_numbers: number[];
  embark_pr_numbers: number[];
  patch_id: string | null;
  safe_to_close: boolean;
  reason: string;
}

function normalizedLabels(candidate: DuplicatePrEvidence): Set<string> {
  return new Set(candidate.labels.map((label) => label.trim().toLowerCase()).filter(Boolean));
}

function isDuplicateCandidate(candidate: DuplicatePrEvidence): boolean {
  return normalizedLabels(candidate).has("duplicate");
}

function canonicalRank(candidate: DuplicatePrEvidence): [number, number, number, number, string] {
  const labels = normalizedLabels(candidate);
  return [
    labels.has("duplicate") ? 1 : 0,
    labels.has("for-review") || labels.has("for-landing") ? 0 : 1,
    candidate.is_draft ? 1 : 0,
    Date.parse(candidate.created_at) || 0,
    String(candidate.number).padStart(12, "0"),
  ];
}

function compareCanonicalCandidates(a: DuplicatePrEvidence, b: DuplicatePrEvidence): number {
  const ar = canonicalRank(a);
  const br = canonicalRank(b);
  for (let index = 0; index < ar.length; index++) {
    const av = ar[index]!;
    const bv = br[index]!;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function firstCanonicalBaseMatch(candidate: DuplicatePrEvidence): DuplicateBaseMatch | null {
  const first = candidate.base_matches[0];
  if (!first) return null;
  const associatedPrNumbers = new Set(
    candidate.base_matches
      .map((match) => match.pr_number)
      .filter((number): number is number => number !== null),
  );
  if (
    associatedPrNumbers.size === 1 &&
    candidate.base_matches.every((match) => match.pr_number !== null)
  ) {
    const prNumber = [...associatedPrNumbers][0]!;
    return candidate.base_matches.find((match) => match.pr_number === prNumber) ?? first;
  }
  return { commit: first.commit, pr_number: null, pr_url: null };
}

function overlapsChangedFiles(a: DuplicatePrEvidence, b: DuplicatePrEvidence): boolean {
  if (a.number === b.number || a.patch_id === b.patch_id) return false;
  const aFiles = new Set(a.changed_files);
  return b.changed_files.some((file) => aFiles.has(file));
}

/**
 * Plan dispositions only for explicitly duplicate-labeled PRs.
 *
 * Exact patch containment on the base branch is the only automatically
 * closable outcome. Open/open equivalence is useful for queue ordering, but
 * remains deferred until the canonical PR actually lands.
 */
export function planDuplicateResolutions(candidates: DuplicatePrEvidence[]): DuplicateResolution[] {
  const byPatchId = new Map<string, DuplicatePrEvidence[]>();
  for (const candidate of candidates) {
    if (!candidate.patch_id) continue;
    const existing = byPatchId.get(candidate.patch_id) ?? [];
    existing.push(candidate);
    byPatchId.set(candidate.patch_id, existing);
  }

  return candidates
    .filter(isDuplicateCandidate)
    .sort((a, b) => a.number - b.number)
    .map((candidate) => {
      const equivalentOpen = candidate.patch_id
        ? [...(byPatchId.get(candidate.patch_id) ?? [])].sort(compareCanonicalCandidates)
        : [];
      const equivalentNumbers = equivalentOpen.map((item) => item.number);

      if (candidate.error || !candidate.patch_id) {
        return {
          pr_number: candidate.number,
          disposition: "analysis_failed",
          canonical_pr_number: null,
          canonical_pr_url: null,
          equivalent_open_pr_numbers: equivalentNumbers,
          embark_pr_numbers: [],
          patch_id: candidate.patch_id,
          safe_to_close: false,
          reason: candidate.error ?? "No stable patch identity could be calculated.",
        };
      }

      const baseMatch = firstCanonicalBaseMatch(candidate);
      if (baseMatch) {
        return {
          pr_number: candidate.number,
          disposition: "already_landed",
          canonical_pr_number: baseMatch.pr_number,
          canonical_pr_url: baseMatch.pr_url,
          equivalent_open_pr_numbers: equivalentNumbers,
          embark_pr_numbers: [],
          patch_id: candidate.patch_id,
          safe_to_close: true,
          reason: baseMatch.pr_number === null
            ? `Every retained patch is already present on ${candidate.base_ref} at ${baseMatch.commit}.`
            : `Every retained patch is already present on ${candidate.base_ref} via PR #${baseMatch.pr_number}.`,
        };
      }

      const canonical = equivalentOpen[0];
      if (canonical && equivalentOpen.length > 1) {
        const isCanonical = canonical.number === candidate.number;
        return {
          pr_number: candidate.number,
          disposition: isCanonical ? "canonical_open" : "exact_open_duplicate",
          canonical_pr_number: canonical.number,
          canonical_pr_url: canonical.url,
          equivalent_open_pr_numbers: equivalentNumbers,
          embark_pr_numbers: [],
          patch_id: candidate.patch_id,
          safe_to_close: false,
          reason: isCanonical
            ? "This is the preferred open representative of an exact patch-equivalent cluster; land it before closing peers."
            : `This patch is exactly represented by open PR #${canonical.number}; defer closure until that PR lands.`,
        };
      }

      const embarkPeers = candidates
        .filter((peer) => overlapsChangedFiles(candidate, peer))
        .sort(compareCanonicalCandidates);
      if (embarkPeers.length > 0) {
        const embarkPrNumbers = [candidate.number, ...embarkPeers.map((peer) => peer.number)]
          .filter((number, index, values) => values.indexOf(number) === index)
          .sort((a, b) => a - b);
        return {
          pr_number: candidate.number,
          disposition: "embark_candidate",
          canonical_pr_number: null,
          canonical_pr_url: null,
          equivalent_open_pr_numbers: equivalentNumbers,
          embark_pr_numbers: embarkPrNumbers,
          patch_id: candidate.patch_id,
          safe_to_close: false,
          reason: `This patch differs but overlaps changed files with ${embarkPeers.map((peer) => `PR #${peer.number}`).join(", ")}; compare retained scope, attempt an isolated merge-commit cohort in both orders, and validate the combined result.`,
        };
      }

      return {
        pr_number: candidate.number,
        disposition: "unverified_duplicate",
        canonical_pr_number: null,
        canonical_pr_url: null,
        equivalent_open_pr_numbers: equivalentNumbers,
        embark_pr_numbers: [],
        patch_id: candidate.patch_id,
        safe_to_close: false,
        reason: "The duplicate label has no exact patch-equivalence or base-containment proof; compare retained scope and synthesize unique work.",
      };
    });
}

export function renderDuplicateCloseComment(resolution: DuplicateResolution): string {
  if (resolution.disposition !== "already_landed" || !resolution.safe_to_close) {
    throw new Error(`PR #${resolution.pr_number} is not proven safe to close`);
  }
  const canonical = resolution.canonical_pr_url
    ? `[PR #${resolution.canonical_pr_number}](${resolution.canonical_pr_url})`
    : resolution.canonical_pr_number !== null
      ? `PR #${resolution.canonical_pr_number}`
      : "the base branch";
  return [
    `Closing as an exact duplicate already represented by ${canonical}.`,
    "",
    `Evidence: stable patch ID \`${resolution.patch_id}\`; every retained commit patch is present on the target base branch.`,
    "",
    "No branch history was rewritten. If this PR contains intent not represented by the patch, reopen it and describe that retained scope.",
  ].join("\n");
}
