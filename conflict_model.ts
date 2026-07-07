/**
 * Pure merge-conflict evidence normalization.
 */

import { recordShapeItem } from "./collection_access_model";
import { recordConflictFiles } from "./conflict_file_access_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function normalizedBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const text = toStr(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(?:true|yes|y|1|conflict|conflicted|has_conflicts)$/.test(text)) return true;
  if (/^(?:false|no|n|0|clean|none|no_conflicts|not_conflicted)$/.test(text)) return false;
  return null;
}

function toNonNegativeInt(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : dflt;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function maxNonNegativeInt(record: Record<string, unknown>, keys: string[]): number {
  let max = 0;
  for (const key of keys) {
    max = Math.max(max, toNonNegativeInt(record[key]));
  }
  return max;
}

export interface NormalizedMergeConflictEvidence {
  count: number;
  listed_files: string[];
  listed_count: number;
  evidence_refs: string[];
}

export interface ActiveMergeConflictSummary {
  count: number;
  detail: string;
}

export type MergeConflictActivityStatus = "active" | "clean" | "unknown";

export function normalizeMergeConflictEvidence(conflicts: Record<string, unknown>): NormalizedMergeConflictEvidence {
  const record = recordValue(conflicts);
  const listed_files = uniqueStrings(recordConflictFiles(record)).sort();
  const count = Math.max(maxNonNegativeInt(record, ["conflict_count", "conflictCount"]), listed_files.length);
  const explicitRefs = recordEvidenceRefs(record);
  return {
    count,
    listed_files,
    listed_count: listed_files.length,
    evidence_refs: explicitRefs.length > 0 ? explicitRefs : ["git:merge-tree"],
  };
}

export function hasActiveMergeConflicts(conflicts: Record<string, unknown>): boolean {
  return mergeConflictActivityStatus(conflicts) === "active";
}

export function mergeConflictActivityStatus(conflicts: Record<string, unknown>): MergeConflictActivityStatus {
  const record = recordValue(conflicts);
  for (const key of ["has_conflicts", "hasConflicts", "conflicted", "has_merge_conflicts", "hasMergeConflicts"]) {
    const normalized = normalizedBoolean(record[key]);
    if (normalized === true) return "active";
    if (normalized === false) return "clean";
  }
  return "unknown";
}

export function mergeConflictSummary(conflicts: Record<string, unknown>): string {
  const { count } = normalizeMergeConflictEvidence(conflicts);
  return count > 0
    ? `Merge conflicts detected in ${count} file(s).`
    : "Merge conflicts detected, but the conflicting file count was unavailable.";
}

export const ACTIVE_MERGE_CONFLICT_SUMMARY_FILE_LIMIT = 8;

export function activeMergeConflictSummary(
  conflicts: Record<string, unknown>,
  limit = ACTIVE_MERGE_CONFLICT_SUMMARY_FILE_LIMIT,
): ActiveMergeConflictSummary {
  const normalized = normalizeMergeConflictEvidence(conflicts);
  const renderedFiles = normalized.listed_files.slice(0, limit);
  if (normalized.listed_files.length > limit) renderedFiles.push(`${normalized.listed_files.length - limit} more`);
  const fileDetail = renderedFiles.join(", ") || "none";
  const detail = normalized.listed_count > 0
    ? `${normalized.count} active conflict file(s): ${fileDetail}${normalized.count > normalized.listed_count ? ` (${normalized.listed_count} listed)` : ""}`
    : (normalized.count > 0
        ? `${normalized.count} active conflict file(s); file list unavailable.`
        : "Active merge conflicts detected; file count and file list unavailable.");
  return { count: normalized.count, detail };
}
