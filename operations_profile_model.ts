/**
 * Deterministic operations profiling for large pull-request inventories.
 *
 * This module only consumes shallow PR metadata. It performs no forge, git,
 * database, or model I/O so the same captured inventory can be replayed in
 * tests and compared across optimization iterations.
 */

import {
  prDetailsLabels,
  prDetailsNumber,
  prDetailsTitle,
  prDetailsUpdatedAt,
  prDetailsUrl,
} from "./pr_details_access_model";
import { categorizeOpenPrs, type ProcessingMode } from "./pr_loop_model";

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_CONTEXT_REMOTE_CALLS_PER_PR = 7;

export interface OperationsProfileOptions {
  now?: Date;
  deepening_limit?: number;
  discovery_page_size?: number;
  sample_limit?: number;
}

export interface OperationsProfileCandidate {
  pr_number: number;
  title: string;
  url: string;
  mode: ProcessingMode;
  labels: string[];
  updated_at: string | null;
  age_days: number | null;
}

export interface OperationsProfile {
  schema_version: 1;
  generated_at: string;
  inventory: {
    total: number;
    valid: number;
    invalid: number;
    age_unknown: number;
    age_buckets: {
      active_0_30_days: number;
      cooling_31_90_days: number;
      stale_91_365_days: number;
      archival_over_365_days: number;
    };
  };
  selection: {
    processable: number;
    for_review: number;
    for_landing: number;
    untagged: number;
    filtered_draft: number;
    filtered_wip: number;
    filtered_state: number;
    selected_for_deepening: number;
    deferred_processable: number;
  };
  acceleration: {
    shallow_index_bytes: number;
    shallow_index_estimated_tokens: number;
    discovery_pages: number;
    current_eager_full_context_calls: number;
    layered_full_context_calls: number;
    avoided_full_context_calls: number;
    avoided_full_context_percent: number;
  };
  candidates: OperationsProfileCandidate[];
}

function finiteNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parsedTimestamp(value: unknown): { iso: string; timestamp: number } | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { iso: value.toISOString(), timestamp: value.getTime() };
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? { iso: new Date(timestamp).toISOString(), timestamp } : null;
}

function processingMode(pr: Record<string, unknown>): ProcessingMode | null {
  const labels = prDetailsLabels(pr).map((label) => label.toLowerCase());
  if (labels.includes("for-review")) return "for-review";
  if (labels.includes("for-landing")) return "for-landing";
  return null;
}

function candidateFromPr(
  pr: Record<string, unknown>,
  nowTimestamp: number,
): OperationsProfileCandidate | null {
  const prNumber = prDetailsNumber(pr);
  const mode = processingMode(pr);
  if (prNumber === null || mode === null) return null;
  const updated = parsedTimestamp(prDetailsUpdatedAt(pr));
  return {
    pr_number: prNumber,
    title: prDetailsTitle(pr, "Unknown"),
    url: prDetailsUrl(pr),
    mode,
    labels: prDetailsLabels(pr),
    updated_at: updated?.iso ?? null,
    age_days: updated === null ? null : Math.max(0, Math.floor((nowTimestamp - updated.timestamp) / DAY_MS)),
  };
}

function compareCandidates(a: OperationsProfileCandidate, b: OperationsProfileCandidate): number {
  const modeRank = (mode: ProcessingMode): number => mode === "for-review" ? 0 : 1;
  const aTimestamp = a.updated_at === null ? Number.NEGATIVE_INFINITY : Date.parse(a.updated_at);
  const bTimestamp = b.updated_at === null ? Number.NEGATIVE_INFINITY : Date.parse(b.updated_at);
  return modeRank(a.mode) - modeRank(b.mode) || bTimestamp - aTimestamp || a.pr_number - b.pr_number;
}

function roundedPercent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export function buildOperationsProfile(
  pullRequests: unknown[],
  options: OperationsProfileOptions = {},
): OperationsProfile {
  const now = options.now ?? new Date();
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(nowTimestamp)) throw new TypeError("now must be a valid date");

  const deepeningLimit = finiteNonNegativeInteger(options.deepening_limit, 25);
  const discoveryPageSize = Math.max(1, finiteNonNegativeInteger(options.discovery_page_size, 100));
  const sampleLimit = finiteNonNegativeInteger(options.sample_limit, 25);
  const categorized = categorizeOpenPrs(pullRequests);
  const processablePrs = [
    ...categorized.categorized["for-review"],
    ...categorized.categorized["for-landing"],
  ];
  const allCandidates = processablePrs
    .map((pr) => candidateFromPr(pr, nowTimestamp))
    .filter((candidate): candidate is OperationsProfileCandidate => candidate !== null)
    .sort(compareCandidates);
  const selectedForDeepening = Math.min(deepeningLimit, allCandidates.length);

  const ageBuckets = {
    active_0_30_days: 0,
    cooling_31_90_days: 0,
    stale_91_365_days: 0,
    archival_over_365_days: 0,
  };
  let ageUnknown = 0;
  let valid = 0;
  const shallowIndex: Array<Record<string, unknown>> = [];

  for (const raw of pullRequests) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const pr = raw as Record<string, unknown>;
    const prNumber = prDetailsNumber(pr);
    if (prNumber === null) continue;
    valid += 1;
    const updated = parsedTimestamp(prDetailsUpdatedAt(pr));
    const ageDays = updated === null ? null : Math.max(0, Math.floor((nowTimestamp - updated.timestamp) / DAY_MS));
    if (ageDays === null) ageUnknown += 1;
    else if (ageDays <= 30) ageBuckets.active_0_30_days += 1;
    else if (ageDays <= 90) ageBuckets.cooling_31_90_days += 1;
    else if (ageDays <= 365) ageBuckets.stale_91_365_days += 1;
    else ageBuckets.archival_over_365_days += 1;

    shallowIndex.push({
      pr_number: prNumber,
      updated_at: updated?.iso ?? null,
      labels: prDetailsLabels(pr),
      mode: processingMode(pr),
    });
  }

  const shallowIndexBytes = Buffer.byteLength(JSON.stringify(shallowIndex), "utf8");
  const eagerCalls = allCandidates.length * FULL_CONTEXT_REMOTE_CALLS_PER_PR;
  const layeredCalls = selectedForDeepening * FULL_CONTEXT_REMOTE_CALLS_PER_PR;
  const avoidedCalls = eagerCalls - layeredCalls;

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    inventory: {
      total: pullRequests.length,
      valid,
      invalid: pullRequests.length - valid,
      age_unknown: ageUnknown,
      age_buckets: ageBuckets,
    },
    selection: {
      processable: allCandidates.length,
      for_review: categorized.categorized["for-review"].length,
      for_landing: categorized.categorized["for-landing"].length,
      untagged: categorized.categorized.untagged.length,
      filtered_draft: categorized.filtered_prs.draft.length,
      filtered_wip: categorized.filtered_prs.wip.length,
      filtered_state: categorized.filtered_prs.state.length,
      selected_for_deepening: selectedForDeepening,
      deferred_processable: allCandidates.length - selectedForDeepening,
    },
    acceleration: {
      shallow_index_bytes: shallowIndexBytes,
      shallow_index_estimated_tokens: Math.ceil(shallowIndexBytes / 4),
      discovery_pages: Math.ceil(pullRequests.length / discoveryPageSize),
      current_eager_full_context_calls: eagerCalls,
      layered_full_context_calls: layeredCalls,
      avoided_full_context_calls: avoidedCalls,
      avoided_full_context_percent: roundedPercent(avoidedCalls, eagerCalls),
    },
    candidates: allCandidates.slice(0, sampleLimit),
  };
}
