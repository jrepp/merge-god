/**
 * Pure PR label merge-gate helpers.
 *
 * Labels are current-state signals, unlike discussion comments. This module
 * converts only explicit hold/block labels into merge blockers and leaves
 * processing labels and merge-god state labels to orchestration.
 */

import type { MergeBlocker } from "@merge-god/github-sync";

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_:/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function labelEvidenceRef(label: string): string {
  const slug = normalizeLabel(label).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? `github:label:${slug}` : "github:label";
}

function isIgnoredMergeGodLabel(label: string): boolean {
  const normalized = normalizeLabel(label);
  return normalized === "for review" ||
    normalized === "for landing" ||
    normalized === "for impl" ||
    normalized === "merge ready" ||
    normalized === "merge processing" ||
    normalized === "merge embarked" ||
    normalized === "merge blocked" ||
    normalized === "merge failed" ||
    normalized === "merge complete";
}

export function isBlockingMergeLabel(label: string): boolean {
  const normalized = normalizeLabel(label);
  if (!normalized || isIgnoredMergeGodLabel(label)) return false;
  if (/\b(?:do not merge|dnm|do not land|do not submit)\b/.test(normalized)) return true;
  if (/\b(?:blocked|blocking|blocker)\b/.test(normalized)) return true;
  if (/\b(?:on hold|hold merge|merge hold)\b/.test(normalized)) return true;
  if (/\b(?:needs rebase|rebase required|must rebase|merge conflicts?|has conflicts?|conflicts?)\b/.test(normalized)) return true;
  if (/\b(?:ci failing|failing ci|tests? failing|failing tests?|checks? failing|failing checks?)\b/.test(normalized)) return true;
  if (/\b(?:manual|human|external)\s+(?:gate|approval|signoff|required)\b/.test(normalized)) return true;
  if (/\b(?:needs|requires|awaiting|waiting(?: on)?)\s+(?:human|approval|signoff|release|security|legal|product|dependency|dependencies|credentials?)\b/.test(normalized)) {
    return true;
  }
  return false;
}

export function extractLabelMergeGateBlockers(labels: string[]): MergeBlocker[] {
  const blockers: MergeBlocker[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || !isBlockingMergeLabel(trimmed)) continue;
    const key = normalizeLabel(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({
      kind: "external_gate",
      status: "blocked",
      summary: `Label '${trimmed}' marks this PR as blocked for landing.`,
      evidence_refs: [labelEvidenceRef(trimmed)],
    });
  }
  return blockers;
}
