/**
 * Pure queue-context summary helpers for review-gate evidence comments.
 *
 * These functions summarize already-modeled queue context records. They do not
 * infer queues or mutate context; they only provide stable display defaults.
 */

import { recordShapeItem } from "./collection_access_model";
import {
  commitIdentifier,
  commitMessage,
} from "./commit_access_model";
import { recordLinkUrlCandidates } from "./link_url_model";
import { mergeCommitConflictFilesFromRecord } from "./queue_merge_commit_model";
import {
  evidenceRefCommitIdentifier,
  evidenceRefPrNumber,
  recordEvidenceRefs,
} from "./evidence_ref_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function normalizedToken(value: unknown): string {
  return toStr(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function firstPositiveInteger(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string") {
      const text = value.trim();
      if (/^\d+$/.test(text)) {
        const parsed = Number.parseInt(text, 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
      }
    }
  }
  return null;
}

function firstUrlPrNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const text = toStr(value).trim();
    const parsed = evidenceRefPrNumber(text);
    if (parsed !== null) return parsed;
  }
  return null;
}

function prNumberFromMergeCommitText(...values: unknown[]): number | null {
  for (const value of values) {
    const text = toStr(value).trim();
    const subject = text.split("\n")[0] ?? "";
    const match =
      subject.match(/^Merge\s+(?:(?:PR|pull request)\s*#?|(?:MR|merge request)\s*!?|request\s*!)(\d+)\b/i)
      ?? subject.match(/^Merged\s+(?:(?:PR|pull request)\s*#?|(?:MR|merge request)\s*!?)(\d+)\b/i);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }

    if (!/^Merge\b/i.test(subject)) continue;
    const trailer = text.match(/(?:^|\n)\s*See\s+merge\s+request\s+\S*!(\d+)\b/i);
    if (!trailer?.[1]) continue;
    const trailerNumber = Number.parseInt(trailer[1], 10);
    if (Number.isInteger(trailerNumber) && trailerNumber > 0) return trailerNumber;
  }
  return null;
}

function queueMergeCommitMessage(value: unknown): string {
  return commitMessage(value);
}

export const QUEUE_CONTEXT_SUMMARY_ROW_LIMIT = 8;
export const QUEUE_CONSTITUENT_STATUS_SUMMARY_DETAIL_LIMIT = 360;
export const QUEUE_CONSTITUENT_TITLE_DETAIL_LIMIT = 44;
const QUEUE_CONSTITUENT_TITLE_FIT_LIMITS = [44, 40, 36, 32, 28, 24, 16, 0];

export function queueConstituentPrNumber(value: unknown): number | null {
  const pr = recordValue(value);
  return firstPositiveInteger(
    pr["number"],
    pr["pr_number"],
    pr["prNumber"],
    pr["pull_number"],
    pr["pullNumber"],
    pr["merge_request_number"],
    pr["mergeRequestNumber"],
    pr["mr_number"],
    pr["mrNumber"],
    pr["merge_request_iid"],
    pr["mergeRequestIid"],
    pr["mr_iid"],
    pr["mrIid"],
    pr["pull_request_iid"],
    pr["pullRequestIid"],
    pr["iid"],
  ) ?? firstUrlPrNumber(
    pr["url"],
    pr["web_url"],
    pr["webUrl"],
    pr["html_url"],
    pr["htmlUrl"],
    pr["permalink"],
    ...recordLinkUrlCandidates(pr),
    ...recordEvidenceRefs(pr),
  );
}

function queueConstituentPrNumberLabel(value: unknown): string {
  const number = queueConstituentPrNumber(value);
  return number === null ? "unknown" : `#${number}`;
}

export function queueConstituentPrEvidenceRef(value: unknown): string {
  const number = queueConstituentPrNumber(value);
  return number === null ? "" : `pr:#${number}`;
}

function queueConstituentHeadSha(value: unknown): string {
  const pr = recordValue(value);
  const head = recordValue(pr["head"]);
  const headCommit = recordValue(pr["head_commit"] ?? pr["headCommit"]);
  return firstNonEmptyText(
    pr["head_sha"],
    pr["headSha"],
    pr["head_oid"],
    pr["headOid"],
    pr["head"],
    head["sha"],
    head["oid"],
    head["id"],
    headCommit["sha"],
    headCommit["oid"],
    headCommit["id"],
  );
}

function queueConstituentStatusValue(value: unknown): unknown {
  const pr = recordValue(value);
  return firstNonEmptyText(
    pr["status"],
    pr["state"],
    pr["queue_status"],
    pr["queueStatus"],
    pr["validation_status"],
    pr["validationStatus"],
    pr["conclusion"],
  );
}

function queueConstituentTitle(value: unknown): string {
  const pr = recordValue(value);
  return firstNonEmptyText(
    pr["title"],
    pr["name"],
    pr["summary"],
    pr["subject"],
    pr["label"],
  );
}

function abbreviateSummaryText(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  if (limit <= 3) return "...".slice(0, limit);
  return `${clean.slice(0, limit - 3).trimEnd()}...`;
}

function queueConstituentPrStatusSummaryItem(value: unknown, titleLimit = QUEUE_CONSTITUENT_TITLE_DETAIL_LIMIT): string {
  const pr = recordValue(value);
  const status = queueConstituentStatusLabel(queueConstituentStatusValue(pr));
  const title = titleLimit <= 0 ? "" : abbreviateSummaryText(queueConstituentTitle(pr), titleLimit);
  const headSha = queueConstituentHeadSha(pr);
  const suffixes = [
    status,
    title,
    headSha ? `head ${headSha.slice(0, 8)}` : "",
  ].filter((suffix) => suffix.length > 0);
  const numberLabel = queueConstituentPrNumberLabel(pr);
  return `${numberLabel}${suffixes.length > 0 ? ` (${suffixes.join(", ")})` : ""}`;
}

function queueConstituentStatusSummaryPriority(value: unknown): number {
  const pr = recordValue(value);
  const status = queueConstituentStatusLabel(queueConstituentStatusValue(pr));
  if (status === "blocked") return 0;
  if (status === "unknown") return 1;
  if (status === "validated") return 2;
  if (status === "merged_into_queue") return 3;
  return 4;
}

export function prioritizedQueueConstituentPrs(items: unknown[]): unknown[] {
  return items
    .map((item, index) => ({ item, index, priority: queueConstituentStatusSummaryPriority(item) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ item }) => item);
}

export function queueMergeCommitIdentifier(value: unknown): string {
  const commit = recordValue(value);
  const nested = recordValue(commit["commit"]);
  return commitIdentifier(commit) || firstNonEmptyText(
    ...recordEvidenceRefs(commit).map(evidenceRefCommitIdentifier),
    ...recordEvidenceRefs(nested).map(evidenceRefCommitIdentifier),
  );
}

export function queueMergeCommitEvidenceRef(value: unknown): string {
  const identifier = queueMergeCommitIdentifier(value);
  return identifier ? `commit:${identifier}` : "";
}

export function queueMergeCommitPrEvidenceRef(value: unknown): string {
  const prNumber = queueMergeCommitPrNumber(value);
  return prNumber === null ? "" : `pr:#${prNumber}`;
}

export function queueConstituentStatusLabel(value: unknown): string {
  const status = normalizedToken(value);
  if (
    status === "queued" ||
    status === "merged_into_queue" ||
    status === "validated" ||
    status === "blocked" ||
    status === "unknown"
  ) {
    return status;
  }
  if (/^(?:pass|passed|success|succeeded|ok)$/.test(status)) return "validated";
  if (/^(?:fail|failed|failure|error|errored|blocking)$/.test(status)) return "blocked";
  if (/^(?:pending|waiting|running|in_progress)$/.test(status)) return "queued";
  if (/^(?:merged|landed|integrated)$/.test(status)) return "merged_into_queue";
  return "unknown";
}

export interface QueueConflictFileSummary {
  count: number;
  detail: string;
}

export function queueStrategyLabel(value: unknown): string {
  const strategy = normalizedToken(value);
  if (
    strategy === "title_pr_list" ||
    strategy === "merge_commits" ||
    strategy === "manual" ||
    strategy === "unknown"
  ) {
    return strategy;
  }
  if (/^(?:title_prs|title_pr_numbers|title_list|title)$/.test(strategy)) return "title_pr_list";
  if (/^(?:merge_commit|commits|commit_history)$/.test(strategy)) return "merge_commits";
  return "unknown";
}

export function queueConstituentPrSummary(items: unknown[], limit = QUEUE_CONTEXT_SUMMARY_ROW_LIMIT): string {
  if (items.length === 0) return "unknown";

  const prioritizedItems = prioritizedQueueConstituentPrs(items).slice(0, limit);
  let bestDetail = "";
  let bestRenderedCount = -1;
  let bestTitleLimit = -1;

  for (const titleLimit of QUEUE_CONSTITUENT_TITLE_FIT_LIMITS) {
    const rendered = prioritizedItems.map((item) => queueConstituentPrStatusSummaryItem(item, titleLimit));
    for (let renderedCount = rendered.length; renderedCount >= 0; renderedCount -= 1) {
      const fitted = rendered.slice(0, renderedCount);
      if (items.length > renderedCount) fitted.push(`${items.length - renderedCount} more`);
      const detail = fitted.join("; ");
      if (detail.length > QUEUE_CONSTITUENT_STATUS_SUMMARY_DETAIL_LIMIT && renderedCount > 0) continue;
      if (renderedCount > bestRenderedCount || (renderedCount === bestRenderedCount && titleLimit > bestTitleLimit)) {
        bestDetail = detail;
        bestRenderedCount = renderedCount;
        bestTitleLimit = titleLimit;
      }
      break;
    }
  }

  return bestDetail || "unknown";
}

export function queueConstituentPrNumberSummary(items: unknown[], limit = QUEUE_CONTEXT_SUMMARY_ROW_LIMIT): string {
  const prioritizedItems = prioritizedQueueConstituentPrs(items).slice(0, limit);
  const rendered = prioritizedItems.map((item) => queueConstituentPrNumberLabel(item));
  if (items.length > limit) rendered.push(`${items.length - limit} more`);
  return rendered.join(", ") || "unknown";
}

function queueMergeCommitPrNumber(value: unknown): number | null {
  const commit = recordValue(value);
  const nested = recordValue(commit["commit"]);
  return firstPositiveInteger(
    commit["pr_number"],
    commit["prNumber"],
    commit["pull_number"],
    commit["pullNumber"],
    commit["merge_request_number"],
    commit["mergeRequestNumber"],
    commit["mr_number"],
    commit["mrNumber"],
    commit["merge_request_iid"],
    commit["mergeRequestIid"],
    commit["mr_iid"],
    commit["mrIid"],
    commit["pull_request_iid"],
    commit["pullRequestIid"],
    nested["pr_number"],
    nested["prNumber"],
    nested["pull_number"],
    nested["pullNumber"],
    nested["merge_request_number"],
    nested["mergeRequestNumber"],
    nested["mr_number"],
    nested["mrNumber"],
    nested["merge_request_iid"],
    nested["mergeRequestIid"],
    nested["mr_iid"],
    nested["mrIid"],
    nested["pull_request_iid"],
    nested["pullRequestIid"],
  ) ?? prNumberFromMergeCommitText(queueMergeCommitMessage(commit), queueMergeCommitMessage(nested)) ?? firstUrlPrNumber(
    commit["url"],
    commit["web_url"],
    commit["webUrl"],
    commit["html_url"],
    commit["htmlUrl"],
    commit["permalink"],
    commit["pr_url"],
    commit["prUrl"],
    commit["pull_request_url"],
    commit["pullRequestUrl"],
    commit["merge_request_url"],
    commit["mergeRequestUrl"],
    nested["url"],
    nested["web_url"],
    nested["webUrl"],
    nested["html_url"],
    nested["htmlUrl"],
    nested["permalink"],
    nested["pr_url"],
    nested["prUrl"],
    nested["pull_request_url"],
    nested["pullRequestUrl"],
    nested["merge_request_url"],
    nested["mergeRequestUrl"],
    ...recordLinkUrlCandidates(commit),
    ...recordLinkUrlCandidates(nested),
    ...recordEvidenceRefs(commit),
    ...recordEvidenceRefs(nested),
  );
}

export function queueMergeCommitSummary(items: unknown[], limit = QUEUE_CONTEXT_SUMMARY_ROW_LIMIT): string {
  const rendered = items.slice(0, limit).map((item) => {
    const commit = recordValue(item);
    const sha = queueMergeCommitIdentifier(commit);
    const prNumber = queueMergeCommitPrNumber(commit);
    const prLabel = prNumber === null ? "" : ` (#${prNumber})`;
    return `${sha.slice(0, 8) || "unknown"}${prLabel}`;
  });
  if (items.length > limit) rendered.push(`${items.length - limit} more`);
  return rendered.join(", ") || "none";
}

export function queueConflictFileSummary(items: unknown[], limit = QUEUE_CONTEXT_SUMMARY_ROW_LIMIT): QueueConflictFileSummary {
  const files = new Set<string>();
  for (const item of items) {
    for (const file of mergeCommitConflictFilesFromRecord(item)) {
      const fileName = toStr(file).trim();
      if (fileName) files.add(fileName);
    }
  }
  const sorted = [...files].sort();
  const rendered = sorted.slice(0, limit);
  if (sorted.length > limit) rendered.push(`${sorted.length - limit} more`);
  return { count: sorted.length, detail: rendered.join(", ") || "none" };
}
