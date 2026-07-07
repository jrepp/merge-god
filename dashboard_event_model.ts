/**
 * Pure dashboard event projections.
 *
 * Dashboard handlers render log lines; this module normalizes event payload
 * shapes before those handlers touch them.
 */

export interface DashboardContextSummary {
  comments: number;
  reviewComments: number;
  commits: number;
  files: number;
  hasConflicts: boolean;
  ciFailed: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedBoolean(value: unknown): boolean {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return false;
  const token = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ["true", "yes", "y", "1", "conflicted", "has_conflicts"].includes(token);
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = toNonNegativeNumber(record[key]);
    if (value > 0) return value;
  }
  return 0;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && normalizedBoolean(record[key])) return true;
  }
  return false;
}

export function dashboardContextSummaryFromEvent(value: unknown): DashboardContextSummary {
  const event = asRecord(value);
  const summary = asRecord(event["context_summary"] ?? event["contextSummary"] ?? value);
  return {
    comments: firstNumber(summary, ["comments", "comment_count", "commentCount"]),
    reviewComments: firstNumber(summary, ["review_comments", "reviewComments", "review_comment_count", "reviewCommentCount"]),
    commits: firstNumber(summary, ["commits", "commit_count", "commitCount"]),
    files: firstNumber(summary, ["files", "file_count", "fileCount", "changed_files", "changedFiles"]),
    hasConflicts: firstBoolean(summary, ["has_conflicts", "hasConflicts", "conflicts", "merge_conflicts", "mergeConflicts"]),
    ciFailed: firstNumber(summary, ["ci_failed", "ciFailed", "failed", "failure"]),
  };
}
