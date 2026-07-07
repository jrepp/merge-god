/**
 * Pure status-provenance ref helpers.
 *
 * Status provenance refs are durable comment, discussion, or forge note URLs
 * that prove a modeled constituent status. They are ranked separately from
 * lineage refs because compact evidence comments must keep the proof visible.
 */

import {
  recordEvidenceRefs,
  recordEvidenceUrlRefs,
} from "./evidence_ref_access_model";
import {
  queueConstituentPrNumber,
  queueConstituentStatusLabel,
} from "./queue_context_summary_model";
import { recordShapeItem } from "./collection_access_model";

interface ConstituentStatusProvenanceCandidate {
  ref: string;
  statusPriority: number;
  prNumber: number | null;
  constituentIndex: number;
  refIndex: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function constituentStatusValue(constituent: Record<string, unknown>): unknown {
  return constituent["status"] ??
    constituent["state"] ??
    constituent["queue_status"] ??
    constituent["queueStatus"] ??
    constituent["validation_status"] ??
    constituent["validationStatus"] ??
    constituent["conclusion"];
}

function constituentStatusPriority(constituent: Record<string, unknown>): number {
  const status = queueConstituentStatusLabel(constituentStatusValue(constituent));
  if (status === "blocked") return 0;
  if (status === "unknown") return 1;
  if (status === "validated") return 2;
  if (status === "merged_into_queue") return 3;
  return 4;
}

function compareConstituentStatusProvenance(
  a: ConstituentStatusProvenanceCandidate,
  b: ConstituentStatusProvenanceCandidate,
): number {
  const statusDelta = a.statusPriority - b.statusPriority;
  if (statusDelta !== 0) return statusDelta;
  if (a.statusPriority === 3) {
    const prDelta = (b.prNumber ?? -1) - (a.prNumber ?? -1);
    if (prDelta !== 0) return prDelta;
  }
  return a.constituentIndex - b.constituentIndex ||
    a.refIndex - b.refIndex ||
    a.ref.localeCompare(b.ref);
}

export function isStatusProvenanceRef(ref: string): boolean {
  const text = ref.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const url = new URL(text);
    const fragment = url.hash.slice(1);
    if (/^(?:issuecomment[-_]?\d+|discussion(?:[-_]?r)?[-_]?\d+|note[-_]?\d+)$/i.test(fragment)) {
      return true;
    }
    return /\/(?:issues|pulls)\/comments\/\d+\/?$/i.test(url.pathname) ||
      /\/merge_requests\/\d+\/notes\/\d+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function recordStatusProvenanceRefs(record: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of [...recordEvidenceRefs(record), ...recordEvidenceUrlRefs(record)]) {
    if (!isStatusProvenanceRef(ref) || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function constituentStatusProvenanceRefs(items: unknown[]): string[] {
  const byRef = new Map<string, ConstituentStatusProvenanceCandidate>();
  for (const [constituentIndex, item] of items.entries()) {
    const constituent = recordValue(item);
    const statusPriority = constituentStatusPriority(constituent);
    const prNumber = queueConstituentPrNumber(constituent);
    for (const [refIndex, ref] of recordStatusProvenanceRefs(constituent).entries()) {
      const candidate = { ref, statusPriority, prNumber, constituentIndex, refIndex };
      const current = byRef.get(ref);
      if (!current || compareConstituentStatusProvenance(candidate, current) < 0) {
        byRef.set(ref, candidate);
      }
    }
  }
  return [...byRef.values()].sort(compareConstituentStatusProvenance).map((candidate) => candidate.ref);
}
