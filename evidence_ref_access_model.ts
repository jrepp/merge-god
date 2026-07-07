/**
 * Pure evidence-reference access helpers for cached records.
 *
 * Records from GitHub, GraphQL edges, and persisted cache rows use several
 * shapes for durable refs. This module normalizes those aliases without deciding
 * where refs rank in a rendered evidence summary.
 */

import { recordLinkUrlCandidates } from "./link_url_model";
import { collectionItems, recordShapeItem } from "./collection_access_model";

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function evidenceRefValue(value: unknown): string {
  const text = toStr(value).trim();
  if (text.length > 0) return text;
  const record = recordShapeItem(value) ?? {};
  return firstNonEmptyText(
    record["ref"],
    record["value"],
    record["id"],
    record["href"],
    record["url"],
  );
}

function uniqueNonEmptyStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const value of values) {
    const ref = evidenceRefValue(value);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function recordEvidenceUrlRefs(recordRaw: Record<string, unknown>): string[] {
  const record = recordShapeItem(recordRaw) ?? {};
  return uniqueNonEmptyStrings([
    record["evidence_url"],
    record["evidenceUrl"],
    record["comment_url"],
    record["commentUrl"],
    record["discussion_url"],
    record["discussionUrl"],
    record["note_url"],
    record["noteUrl"],
    record["source_url"],
    record["sourceUrl"],
    record["target_url"],
    record["targetUrl"],
    record["details_url"],
    record["detailsUrl"],
    record["html_url"],
    record["htmlUrl"],
    record["web_url"],
    record["webUrl"],
    record["permalink"],
    record["pr_url"],
    record["prUrl"],
    record["pull_request_url"],
    record["pullRequestUrl"],
    record["merge_request_url"],
    record["mergeRequestUrl"],
    record["uri"],
    record["url"],
    ...recordLinkUrlCandidates(record),
  ]);
}

export function recordEvidenceRefs(recordRaw: Record<string, unknown>): string[] {
  const record = recordShapeItem(recordRaw) ?? {};
  const explicitRefs = uniqueNonEmptyStrings([
    record["evidence_ref"],
    record["evidenceRef"],
    record["comment_ref"],
    record["commentRef"],
    record["source_ref"],
    record["sourceRef"],
    ...collectionItems(record["evidence_refs"]),
    ...collectionItems(record["evidenceRefs"]),
    ...collectionItems(record["comment_refs"]),
    ...collectionItems(record["commentRefs"]),
    ...collectionItems(record["source_refs"]),
    ...collectionItems(record["sourceRefs"]),
  ]);
  if (explicitRefs.length > 0) return explicitRefs;

  return recordEvidenceUrlRefs(record);
}

export function evidenceRefPrNumber(ref: string | null | undefined): number | null {
  const text = ref ?? "";
  const match = text.match(/\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b/i) ??
    text.match(/\b(?:pr|pull[-_ ]request|mr|merge[-_ ]request):[#!]?(\d+)\b/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function evidenceRefCommitIdentifier(ref: string | null | undefined): string {
  const text = (ref ?? "").trim();
  const match = text.match(/^commit:(\S+)$/i);
  return match?.[1]?.trim() ?? "";
}
