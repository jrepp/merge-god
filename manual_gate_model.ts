/**
 * Pure manual merge-gate parsing helpers.
 *
 * These helpers turn authoritative PR discussion text into merge blockers.
 * They do not call GitHub, inspect git state, mutate PR context, or render
 * comments.
 */

import type { MergeBlocker } from "@merge-god/github-sync";
import { recordShapeItem } from "./collection_access_model";
import { commentBody, commentEvidenceRef } from "./comment_access_model";
import { visibleCommentLines } from "./comment_visibility_model";
import { isReviewGateCacheBody } from "./review_gate_cache";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function commentTimestampMs(commentRaw: unknown): number | null {
  const comment = recordValue(commentRaw);
  for (const value of [
    comment["updated_at"],
    comment["updatedAt"],
    comment["submitted_at"],
    comment["submittedAt"],
    comment["created_at"],
    comment["createdAt"],
  ]) {
    const raw = toStr(value).trim();
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sortCommentsChronologically(comments: unknown[]): unknown[] {
  return comments
    .map((comment, index) => ({
      comment,
      index,
      timestamp: commentTimestampMs(comment),
    }))
    .sort((a, b) => {
      if (a.timestamp === null && b.timestamp !== null) return -1;
      if (a.timestamp !== null && b.timestamp === null) return 1;
      if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.comment);
}

function listLinePayload(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/^\[[ xX]\]\s*/i, "")
    .trim();
}

function cleanGateReason(value: string | undefined): string {
  return (value ?? "")
    .replace(/^[\s:;,\-\u2013\u2014]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function manualGateSummary(reason: string): string {
  if (!reason) return "Manual merge gate is blocked.";
  const punctuation = /[.!?]$/.test(reason) ? "" : ".";
  return `Manual merge gate is blocked: ${reason}${punctuation}`;
}

type ManualGateEvent =
  | { status: "blocked"; summary: string; evidence_ref: string }
  | { status: "cleared" };

const RELEASE_LINE_PATTERNS = [
  /^(?:merge-god|merge god)\s*[:\-]\s*(?:ready|unblocked|clear(?:ed)?|release(?:d)?|resume|ok\s+to\s+merge|merge\s+ok|approved\s+to\s+merge)\b/i,
  /^(?:manual\s+gate|human\s+gate|external\s+gate)\s*(?:[:\-]\s*)?(?:clear(?:ed)?|passed|approved|release(?:d)?)\b/i,
  /^(?:hold\s+cleared|merge\s+hold\s+cleared|ready\s+to\s+merge|ok\s+to\s+merge|merge\s+ok)\b/i,
  /^(?:remaining|current|final|release)\s+(?:rc\d+\s+)?(?:release\s+)?decision\s*[:\-]\s*(?:pass|passed|approved|approve|ready|clear(?:ed)?|ok\s+to\s+merge|merge\s+ok)\b/i,
];

const BLOCK_LINE_PATTERNS = [
  /^(?:merge-god|merge god)\s*[:\-]\s*(?:blocked|blocking|block|hold|manual\s+gate|human\s+gate|external\s+gate|do\s+not\s+merge|do-not-merge|needs\s+human|requires\s+human)\b(.*)$/i,
  /^(?:do\s+not\s+merge|do-not-merge|manual\s+gate|human\s+gate|external\s+gate|merge\s+hold|hold\s+merge)\b(.*)$/i,
  /^(?:remaining|current|final|release)\s+(?:rc\d+\s+)?(?:release\s+)?decision\s*[:\-]\s*(?:hold|held|blocked)\b(?:,\s*not\s+approve(?:d)?)?[.;:\s-]*(.*)$/i,
  /^(?:remaining|current|final|release)\s+(?:rc\d+\s+)?(?:release\s+)?decision\s*[:\-]\s*(?:do\s+not\s+approve|not\s+approve(?:d)?)\b[.;:\s-]*(.*)$/i,
];

function manualGateEventFromLine(line: string, evidenceRef: string): ManualGateEvent | null {
  const payload = listLinePayload(line);
  if (!payload) return null;
  if (RELEASE_LINE_PATTERNS.some((pattern) => pattern.test(payload))) {
    return { status: "cleared" };
  }
  for (const pattern of BLOCK_LINE_PATTERNS) {
    const match = pattern.exec(payload);
    if (!match) continue;
    return {
      status: "blocked",
      summary: manualGateSummary(cleanGateReason(match[1])),
      evidence_ref: evidenceRef,
    };
  }
  return null;
}

export function extractManualMergeGateBlockers(comments: unknown[]): MergeBlocker[] {
  const activeBlockers: MergeBlocker[] = [];
  for (const commentRaw of sortCommentsChronologically(comments)) {
    const body = commentBody(commentRaw);
    if (isReviewGateCacheBody(body)) continue;
    const evidenceRef = commentEvidenceRef(commentRaw, "github:pr-comment") ?? "github:pr-comment";
    for (const line of visibleCommentLines(body)) {
      const event = manualGateEventFromLine(line, evidenceRef);
      if (!event) continue;
      if (event.status === "cleared") {
        activeBlockers.length = 0;
        continue;
      }
      activeBlockers.push({
        kind: "external_gate",
        status: "blocked",
        summary: event.summary,
        evidence_refs: [event.evidence_ref],
      });
    }
  }
  return activeBlockers;
}
