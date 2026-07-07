/**
 * Pure queue merge-commit modeling helpers.
 *
 * These functions normalize already-fetched commit records into merge queue
 * lineage evidence. They do not read git state or call GitHub.
 */

import type { QueueMergeCommit } from "@merge-god/github-sync";
import { recordCollectionItems, recordShapeItem } from "./collection_access_model";
import { commentBody, commentEvidenceRef } from "./comment_access_model";
import { visibleCommentLines } from "./comment_visibility_model";
import {
  commitIdentifier,
  commitMessage,
} from "./commit_access_model";
import { recordConflictFiles } from "./conflict_file_access_model";
import {
  evidenceRefCommitIdentifier,
  evidenceRefPrNumber,
  recordEvidenceRefs,
} from "./evidence_ref_access_model";
import { recordLinkUrlCandidates } from "./link_url_model";
import {
  prContextComments,
  prContextCommits,
  prContextReviewComments,
} from "./pr_context_access_model";
import { prDetailsCommits } from "./pr_details_access_model";
import { isReviewGateCacheBody } from "./review_gate_cache";

export interface QueueMergeCommitModel {
  merge_commits: QueueMergeCommit[];
  merged_pr_numbers: number[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function toStr(value: unknown, dflt = ""): string {
  return typeof value === "string" ? value : dflt;
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
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!/^\d+$/.test(text)) continue;
    const parsed = Number.parseInt(text, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstRefPrNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = evidenceRefPrNumber(toStr(value).trim());
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseMarkdownTableCells(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const rawCells: string[] = [];
  let current = "";
  let inCodeSpan = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (char === "\\" && next === "|") {
      current += "|";
      index++;
      continue;
    }
    if (char === "`") {
      inCodeSpan = !inCodeSpan;
      current += char;
      continue;
    }
    if (char === "|" && !inCodeSpan) {
      rawCells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  rawCells.push(current);
  if (rawCells[0]?.trim() === "") rawCells.shift();
  if (rawCells[rawCells.length - 1]?.trim() === "") rawCells.pop();
  const cells = rawCells.map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

interface MergeCommitTableHeader {
  prIndex: number;
  commitIndex: number;
}

function normalizedTableHeaderCell(cell: string): string {
  return cell.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function mergeCommitTableHeader(cells: string[]): MergeCommitTableHeader | null {
  const normalized = cells.map(normalizedTableHeaderCell);
  const prIndex = normalized.findIndex((cell) =>
    /^(?:pr|prs|mr|mrs|pull request|pull requests|merge request|merge requests|constituent|constituent pr|constituent prs|source pr|queue pr)$/.test(cell)
  );
  const commitIndex = normalized.findIndex((cell) =>
    /^(?:merge commit|merge sha|commit|commit sha|sha|oid|hash)$/.test(cell)
  );
  return prIndex >= 0 && commitIndex >= 0 && prIndex !== commitIndex
    ? { prIndex, commitIndex }
    : null;
}

function prNumberFromMergeCommitTableCell(cell: string): number | null {
  return firstPositiveInteger(
    cell.match(/\b(?:pull\s+request|merge\s+request|PR|MR)\s*[#!]?(\d+)\b/i)?.[1],
    cell.match(/[#!](\d+)\b/)?.[1],
  ) ?? firstRefPrNumber(cell);
}

function commitIdentifierFromTableCell(cell: string): string {
  return firstNonEmptyText(
    cell.match(/\/commit\/([a-f0-9]{7,40})\b/i)?.[1],
    cell.match(/\b([a-f0-9]{7,40})\b/i)?.[1],
  );
}

function commitUrlFromTableCell(cell: string): string {
  return firstNonEmptyText(
    cell.match(/\[[^\]]*?\]\((https?:\/\/[^)\s]+\/commit\/[a-f0-9]{7,40}[^)]*)\)/i)?.[1],
    cell.match(/(https?:\/\/\S+\/commit\/[a-f0-9]{7,40}\b\S*)/i)?.[1],
  );
}

function queueMergeCommitCandidateFromTableRow(
  cells: string[],
  header: MergeCommitTableHeader,
  evidenceRef: string,
): Record<string, unknown> | null {
  const prNumber = prNumberFromMergeCommitTableCell(cells[header.prIndex] ?? "");
  const commitCell = cells[header.commitIndex] ?? "";
  const sha = commitIdentifierFromTableCell(commitCell);
  if (!prNumber || !sha) return null;
  const commitUrl = commitUrlFromTableCell(commitCell);
  return {
    sha,
    pr_number: prNumber,
    messageHeadline: `Merge PR #${prNumber}`,
    evidence_refs: uniqueStrings([evidenceRef, commitUrl]),
  };
}

export function queueMergeCommitCandidatesFromComments(comments: unknown[]): Record<string, unknown>[] {
  const commits: Record<string, unknown>[] = [];
  for (const commentRaw of comments) {
    const body = commentBody(commentRaw);
    if (isReviewGateCacheBody(body)) continue;
    const evidenceRef = commentEvidenceRef(commentRaw, "github:pr-comment") ?? "github:pr-comment";
    let tableHeader: MergeCommitTableHeader | null = null;
    for (const line of visibleCommentLines(body)) {
      const cells = parseMarkdownTableCells(line);
      if (!cells) {
        tableHeader = null;
        continue;
      }
      if (isMarkdownTableSeparator(cells)) continue;
      const header = mergeCommitTableHeader(cells);
      if (header) {
        tableHeader = header;
        continue;
      }
      if (!tableHeader) continue;
      const commit = queueMergeCommitCandidateFromTableRow(cells, tableHeader, evidenceRef);
      if (commit) commits.push(commit);
    }
  }
  return commits;
}

function looksLikeConflictFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:please|this|it looks|lines starting)\b/i.test(trimmed)) return false;
  return /[/\\]/.test(trimmed) || !/\s/.test(trimmed);
}

function prNumberFromSubjectMatch(match: RegExpMatchArray | null): number | null {
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function mergedPrNumberFromGitLabTrailer(message: string, subject: string): number | null {
  if (!/^Merge\b/i.test(subject)) return null;
  return prNumberFromSubjectMatch(message.match(/(?:^|\n)\s*See\s+merge\s+request\s+\S*!(\d+)\b/i));
}

function mergedPrNumberFromMessage(message: string, allowSquashSubject = false): number | null {
  const subject = message.split("\n")[0] ?? "";
  const mergeSubjectPrNumber = prNumberFromSubjectMatch(subject.match(/^Merge (?:PR|pull request)\s*#?(\d+)\b/i));
  if (mergeSubjectPrNumber !== null) return mergeSubjectPrNumber;

  const mergedSubjectPrNumber = prNumberFromSubjectMatch(subject.match(/^Merged (?:PR|pull request)\s*#?(\d+)\b/i));
  if (mergedSubjectPrNumber !== null) return mergedSubjectPrNumber;

  const mergeSubjectMrNumber = prNumberFromSubjectMatch(
    subject.match(/^Merge (?:(?:MR|merge request)\s*!?|request\s*!)(\d+)\b/i),
  );
  if (mergeSubjectMrNumber !== null) return mergeSubjectMrNumber;

  const mergedSubjectMrNumber = prNumberFromSubjectMatch(
    subject.match(/^Merged (?:MR|merge request)\s*!?(\d+)\b/i),
  );
  if (mergedSubjectMrNumber !== null) return mergedSubjectMrNumber;

  const gitLabTrailerPrNumber = mergedPrNumberFromGitLabTrailer(message, subject);
  if (gitLabTrailerPrNumber !== null) return gitLabTrailerPrNumber;

  if (!allowSquashSubject) return null;
  return prNumberFromSubjectMatch(subject.match(/\([#!](\d+)\)\s*$/));
}

function explicitMergedPrNumberFromRecord(commit: Record<string, unknown>): number | null {
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
  ) ?? firstRefPrNumber(
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeBaseBranchMergeSubject(subject: string, baseBranch: string): boolean {
  const branches = uniqueStrings([baseBranch, "main", "master", "develop"]).map(escapeRegExp);
  const branchAlternation = branches.join("|");
  return new RegExp(
    [
      `^Merge\\s+origin\\/(?:${branchAlternation})\\s+into\\b`,
      `^Merge\\s+remote-tracking\\s+branch\\s+['"]origin\\/(?:${branchAlternation})['"]\\s+into\\b`,
      `^Merge\\s+branch\\s+['"](?:${branchAlternation})['"]\\s+into\\b`,
      `^Merge\\s+branch\\s+['"](?:${branchAlternation})['"]\\s+of\\s+\\S+\\s+into\\b`,
    ].join("|"),
    "i",
  ).test(subject);
}

function conflictFileFromCommitMessageLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const commented = trimmed.match(/^#\s+(.+)$/)?.[1]?.trim();
  if (commented) return looksLikeConflictFilePath(commented) ? commented : null;

  const bulleted = trimmed.match(/^[-*]\s+(.+)$/)?.[1]?.trim();
  const indented = line.match(/^\s+(.+)$/)?.[1]?.trim();
  const file = bulleted ?? indented ?? null;
  return file && !/^Conflicts:\s*$/i.test(file) && looksLikeConflictFilePath(file) ? file : null;
}

export function extractConflictFilesFromCommitMessage(message: string): string[] {
  const files: string[] = [];
  let inConflictBlock = false;
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    if (/^(?:#\s*)?Conflicts:\s*$/i.test(trimmed)) {
      inConflictBlock = true;
      continue;
    }
    if (!inConflictBlock) continue;
    if (!trimmed) continue;
    const file = conflictFileFromCommitMessageLine(line);
    if (!file) break;
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

export function mergeCommitConflictFilesFromRecord(value: unknown): string[] {
  const commit = recordValue(value);
  const nested = recordValue(commit["commit"]);
  return uniqueStrings([
    ...recordConflictFiles(commit),
    ...recordConflictFiles(nested),
    ...extractConflictFilesFromCommitMessage(commitMessage(commit)),
  ]);
}

export function commitRecords(value: unknown): Record<string, unknown>[] {
  return recordCollectionItems(value);
}

export function queueMergeCommitCandidates(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): Record<string, unknown>[] {
  const contextCommits = prContextCommits(prContext).map(recordValue);
  if (contextCommits.length > 0) return contextCommits;
  const commentCommits = queueMergeCommitCandidatesFromComments([
    ...prContextComments(prContext),
    ...prContextReviewComments(prContext),
  ]);
  return commentCommits.length > 0 ? commentCommits : prDetailsCommits(prDetails).map(recordValue);
}

export function modelQueueMergeCommits(
  commits: Record<string, unknown>[],
  options: {
    baseBranch?: string;
    allowSquashSubjects?: boolean;
  } = {},
): QueueMergeCommitModel {
  const baseBranch = options.baseBranch ?? "main";
  const allowSquashSubjects = options.allowSquashSubjects ?? false;
  const mergeCommits: QueueMergeCommit[] = [];
  const mergedPrNumbers: number[] = [];

  for (const commit of commits) {
    const normalizedCommit = recordValue(commit);
    const message = commitMessage(normalizedCommit);
    const subject = message.split("\n")[0] ?? "";
    const mergedPrNumber = mergedPrNumberFromMessage(message, allowSquashSubjects) ??
      explicitMergedPrNumberFromRecord(normalizedCommit);
    const baseBranchMerge = looksLikeBaseBranchMergeSubject(subject, baseBranch);
    if (!mergedPrNumber && !baseBranchMerge) continue;
    if (mergedPrNumber) mergedPrNumbers.push(mergedPrNumber);
    const nestedCommit = recordValue(normalizedCommit["commit"]);
    const sha = commitIdentifier(normalizedCommit) || firstNonEmptyText(
      ...recordEvidenceRefs(normalizedCommit).map(evidenceRefCommitIdentifier),
      ...recordEvidenceRefs(nestedCommit).map(evidenceRefCommitIdentifier),
    );
    mergeCommits.push({
      sha,
      pr_number: mergedPrNumber,
      subject,
      conflict_files: mergeCommitConflictFilesFromRecord(normalizedCommit),
      evidence_refs: uniqueStrings([
        ...recordEvidenceRefs(normalizedCommit),
        ...recordEvidenceRefs(nestedCommit),
        sha ? `commit:${sha}` : "",
      ]),
    });
  }

  return {
    merge_commits: mergeCommits,
    merged_pr_numbers: mergedPrNumbers,
  };
}
