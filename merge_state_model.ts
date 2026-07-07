/**
 * Pure GitHub merge-state blocker projection.
 *
 * Merge-state values and the legacy `mergeable` flag are gathered from GitHub
 * payloads. This module keeps their blocker semantics independent of the larger
 * merge PR model.
 */

import {
  prDetailsMergeable,
  prDetailsMergeStateStatus,
} from "./pr_details_access_model";
import { recordShapeItem } from "./collection_access_model";

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function recordValue(v: unknown): Record<string, unknown> {
  return recordShapeItem(v) ?? {};
}

export interface MergeStateBlocker {
  kind: "merge_state_blocked";
  status: "blocked" | "pending" | "unknown";
  summary: string;
  evidence_refs: string[];
}

export type MergeStateStatusSignal = "clean" | "blocking" | "pending" | "unknown" | "unrecognized";

export function normalizeMergeStateStatus(value: unknown): string {
  return toStr(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function mergeStateStatusSignal(mergeStateStatus: string): MergeStateStatusSignal {
  if (mergeStateStatus === "CLEAN") return "clean";
  if (mergeStateStatus === "BLOCKED" || mergeStateStatus === "DIRTY") return "blocking";
  if (mergeStateStatus === "BEHIND" || mergeStateStatus === "UNSTABLE" || mergeStateStatus === "HAS_HOOKS") {
    return "pending";
  }
  if (mergeStateStatus === "" || mergeStateStatus === "UNKNOWN") return "unknown";
  return "unrecognized";
}

export function mergeStateStatusBlocker(mergeStateStatus: string): MergeStateBlocker | null {
  if (mergeStateStatus === "" || mergeStateStatus === "CLEAN") return null;

  if (mergeStateStatus === "BLOCKED" || mergeStateStatus === "DIRTY") {
    return {
      kind: "merge_state_blocked",
      status: "blocked",
      summary: `GitHub reports the PR merge state as ${mergeStateStatus}.`,
      evidence_refs: ["github:mergeStateStatus"],
    };
  }

  if (mergeStateStatus === "BEHIND" || mergeStateStatus === "UNSTABLE" || mergeStateStatus === "HAS_HOOKS") {
    return {
      kind: "merge_state_blocked",
      status: "pending",
      summary: `GitHub reports the PR merge state as ${mergeStateStatus}.`,
      evidence_refs: ["github:mergeStateStatus"],
    };
  }

  return {
    kind: "merge_state_blocked",
    status: "unknown",
    summary: `GitHub reports the PR merge state as ${mergeStateStatus}.`,
    evidence_refs: ["github:mergeStateStatus"],
  };
}

export function mergeableFlagBlocker(prDetails: Record<string, unknown>): MergeStateBlocker | null {
  return prDetailsMergeable(prDetails) === false
    ? {
        kind: "merge_state_blocked",
        status: "blocked",
        summary: "GitHub reports this PR is not mergeable.",
        evidence_refs: ["github:mergeable"],
      }
    : null;
}

export function mergeStateBlockerFromDetails(prDetailsRaw: unknown): MergeStateBlocker | null {
  const prDetails = recordValue(prDetailsRaw);
  return mergeStateStatusBlocker(mergeStateStatusFromDetails(prDetails)) ??
    mergeableFlagBlocker(prDetails);
}

function mergeStateStatusFromDetails(prDetails: Record<string, unknown>): string {
  let fallback = "";
  for (const key of ["mergeStateStatus", "merge_state_status"]) {
    const normalized = normalizeMergeStateStatus(prDetails[key]);
    if (normalized.length === 0) continue;
    if (fallback.length === 0) fallback = normalized;
    const signal = mergeStateStatusSignal(normalized);
    if (signal !== "unknown" && signal !== "unrecognized") return normalized;
  }
  return fallback || normalizeMergeStateStatus(prDetailsMergeStateStatus(prDetails));
}
