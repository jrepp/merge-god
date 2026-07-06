/**
 * Pure queue membership parsing helpers.
 *
 * This module turns queue PR titles and already-fetched GitHub text records into
 * constituent PR hints. It has no network, filesystem, process, or persistence
 * side effects.
 */

import {
  cleanQueueValidationCommandPrefix,
  extractQueueValidationEvidence,
  looksLikeQueueValidationCommand,
  looksLikeQueueValidationStatus,
} from "./queue_validation_model";
import { visibleCommentLines } from "./comment_visibility_model";
import { isReviewGateCacheBody } from "./review_gate_cache";
import { prDetailsBody } from "./pr_details_access_model";
import { commentBody, commentEvidenceRef } from "./comment_access_model";
import { recordShapeItem } from "./collection_access_model";

export interface ConstituentHint {
  number: number;
  title: string | null;
  url: string | null;
  head_sha: string | null;
  evidence_refs: string[];
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function firstNonEmptyTextOrNull(...values: unknown[]): string | null {
  const text = firstNonEmptyText(...values);
  return text.length > 0 ? text : null;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function orderedConstituentEvidenceRefs(
  number: number,
  hintRefs: string[],
  scopedValidationRefs: string[],
): string[] {
  const prRef = `pr:#${number}`;
  return uniqueStrings([
    ...hintRefs.filter((ref) => ref !== prRef),
    ...scopedValidationRefs.filter((ref) => ref !== prRef),
    prRef,
  ]);
}

export function hasQueueVocabulary(title: string): boolean {
  return /\b(?:merge queue|queue|batch|stack)\b/i.test(title);
}

export function isExplicitQueueLikeTitle(title: string): boolean {
  return /\bmerge queue\b/i.test(title) ||
    /\bmerge batch\b/i.test(title) ||
    /\bmerge train\b/i.test(title) ||
    /\bmerge\s+(?:PRs|MRs|pull\s+requests|merge\s+requests)\b/i.test(title) ||
    /\b(?:queue|batch|stack|train)\s+(?:PRs?|MRs?|pull\s+requests?|merge\s+requests?)\b/i.test(title) ||
    /\b(?:PRs?|MRs?|pull\s+requests?|merge\s+requests?)\s+(?:queue|batch|stack|train)\b/i.test(title) ||
    /\bstacked?\s+(?:PRs?|MRs?|pull\s+requests?|merge\s+requests?)\b/i.test(title) ||
    /\b(?:PR|MR)\s+stack\b/i.test(title) ||
    /\bmanual queue\b/i.test(title);
}

const MAX_TITLE_PR_RANGE_SPAN = 50;
const MAX_TITLE_PR_LIST_ITEMS = 64;
const TITLE_PR_RANGE_SEPARATOR_PATTERN = "(?:[-\\u2013\\u2014]|\\.{2}|\\bto\\b|\\bthrough\\b)";

function addBoundedRange(startRaw: string | undefined, endRaw: string | undefined, numbers: number[]): void {
  const start = Number.parseInt(startRaw ?? "", 10);
  const end = Number.parseInt(endRaw ?? "", 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;
  if (start <= 0 || end <= start) return;
  if (end - start > MAX_TITLE_PR_RANGE_SPAN) return;
  for (let value = start; value <= end; value++) {
    numbers.push(value);
  }
}

function addBoundedPrNumberRanges(text: string, numbers: number[], allowBareRange = false): void {
  const markedRange = new RegExp(`\\b(?:pull\\s+requests?|merge\\s+requests?|pull|PRs?|MRs?)\\s*[#!]?(\\d+)\\s*${TITLE_PR_RANGE_SEPARATOR_PATTERN}\\s*(?:[#!]?(\\d+)|(?:pull\\s+requests?|merge\\s+requests?|pull|PRs?|MRs?)\\s*[#!]?(\\d+))\\b`, "gi");
  for (const match of text.matchAll(markedRange)) {
    addBoundedRange(match[1], match[2] ?? match[3], numbers);
  }
  const hashRange = new RegExp(`[#!](\\d+)\\s*${TITLE_PR_RANGE_SEPARATOR_PATTERN}\\s*[#!]?(\\d+)\\b`, "gi");
  for (const match of text.matchAll(hashRange)) {
    addBoundedRange(match[1], match[2], numbers);
  }
  if (!allowBareRange) return;
  const bareRange = new RegExp(`(?:^|[^\\d#])(\\d+)\\s*${TITLE_PR_RANGE_SEPARATOR_PATTERN}\\s*#?(\\d+)\\b`, "gi");
  for (const match of text.matchAll(bareRange)) {
    addBoundedRange(match[1], match[2], numbers);
  }
}

export function parsePrNumbersFromQueueTitle(title: string): number[] {
  const numbers: number[] = [];
  const queueLikeTitle = isExplicitQueueLikeTitle(title);
  const mergePrTitle = /\bmerge\b/i.test(title) && /\b(?:PRs?|MRs?|pull\s+requests?|merge\s+requests?)\b/i.test(title);
  if (!queueLikeTitle && !mergePrTitle) return [];

  if (queueLikeTitle) {
    addBoundedPrNumberRanges(title, numbers);
    for (const match of title.matchAll(/[#!](\d+)\b/g)) {
      const parsed = Number.parseInt(match[1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) numbers.push(parsed);
    }
  }

  for (const match of title.matchAll(/\b(?:PRs?|MRs?|pull\s+requests?|merge\s+requests?)\b/gi)) {
    const afterMarker = title.slice((match.index ?? 0) + match[0].length);
    const listMatch = afterMarker.match(
      new RegExp(
        `(?:\\s*(?:[#!]?\\d+)\\b\\s*(?:,|\\+|&|/|-|\\u2013|\\u2014|\\.{2}|\\bto\\b|\\bthrough\\b|\\band\\b)?){1,${MAX_TITLE_PR_LIST_ITEMS}}`,
        "i",
      ),
    );
    const listText = listMatch?.[0] ?? "";
    addBoundedPrNumberRanges(listText, numbers, true);
    for (const numberMatch of listText.matchAll(/[#!]?(\d+)\b/g)) {
      const parsed = Number.parseInt(numberMatch[1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) numbers.push(parsed);
    }
  }

  return uniqueNumbers(numbers);
}

const HEAD_SHA_HINT_PATTERN = /\b(?:head_sha|sha|head)(?:\s*[:=]|\s+)\s*`?([a-f0-9]{7,40})`?(?=\W|$)/ig;
const QUEUE_STATUS_SYMBOL_CLASS = "✅✓✔❌✗✖⛔🚫🚧⏳⌛❓";
const EDGE_QUEUE_STATUS_MARKER_PATTERN_SOURCE = String.raw`(?:[${QUEUE_STATUS_SYMBOL_CLASS}]|\(\s*[${QUEUE_STATUS_SYMBOL_CLASS}]\s*\)|\[\s*[${QUEUE_STATUS_SYMBOL_CLASS}]\s*\])`;
const LEADING_TITLE_SEPARATOR_PATTERN = /^[>)\]\s\-\u2013\u2014:,. ;]+/u;
const TRAILING_TITLE_SEPARATOR_PATTERN = /[\s\-\u2013\u2014:,. ;]+$/u;
const LEADING_QUEUE_STATUS_MARKER_PATTERN = new RegExp(`^${EDGE_QUEUE_STATUS_MARKER_PATTERN_SOURCE}\\s*`, "u");
const TRAILING_QUEUE_STATUS_MARKER_PATTERN = new RegExp(`\\s*${EDGE_QUEUE_STATUS_MARKER_PATTERN_SOURCE}\\s*$`, "u");
const QUEUE_STATUS_SYMBOL_PATTERN = new RegExp(`[${QUEUE_STATUS_SYMBOL_CLASS}]`, "u");

function stripLeadingTitleAdornments(value: string): string {
  let rest = value.trimStart();
  for (let index = 0; index < 4; index++) {
    const next = rest
      .replace(LEADING_TITLE_SEPARATOR_PATTERN, "")
      .replace(LEADING_QUEUE_STATUS_MARKER_PATTERN, "")
      .trimStart();
    if (next === rest) return rest;
    rest = next;
  }
  return rest;
}

function stripTrailingStatusAdornments(value: string): string {
  let rest = value.trimEnd();
  for (let index = 0; index < 4; index++) {
    const withoutStatus = rest.replace(TRAILING_QUEUE_STATUS_MARKER_PATTERN, "").trimEnd();
    if (withoutStatus === rest) return rest;
    rest = withoutStatus.replace(TRAILING_TITLE_SEPARATOR_PATTERN, "").trimEnd();
  }
  return rest;
}

function cleanHintTitle(value: string): string | null {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(HEAD_SHA_HINT_PATTERN, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .trim();
  const cleaned = stripTrailingStatusAdornments(stripLeadingTitleAdornments(normalized)).trim();
  return cleaned.length > 0 ? cleaned.slice(0, 240) : null;
}

function extractHeadSha(line: string): string | null {
  const match = [...line.matchAll(HEAD_SHA_HINT_PATTERN)][0];
  return match?.[1] ?? null;
}

function isHexSha(value: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(value.trim().replace(/^`|`$/g, ""));
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

interface ConstituentHintTableHeader {
  titleIndexes: number[];
}

function normalizedTableHeaderCell(cell: string): string {
  return cell.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function constituentHintTableHeader(cells: string[]): ConstituentHintTableHeader | null {
  const normalized = cells.map(normalizedTableHeaderCell);
  const hasConstituentColumn = normalized.some((cell) =>
    /^(?:pr|prs|mr|mrs|pull request|pull requests|merge request|merge requests|constituent|constituent pr|constituent prs|source pr|queue pr)$/.test(cell)
  );
  if (!hasConstituentColumn) return null;
  return {
    titleIndexes: normalized
      .map((cell, index) => ({
        cell,
        index,
      }))
      .filter(({ cell }) => /^(?:title|name|summary|subject|purpose|description)$/.test(cell))
      .map(({ index }) => index),
  };
}

interface ConstituentTableCellHint {
  number: number;
  url: string | null;
  title: string | null;
}

const CONSTITUENT_REF_LABEL_PATTERN = String.raw`(?:pull\s+requests?|merge\s+requests?|pull|PRs?|MRs?)`;
const CONSTITUENT_LINK_LEAD_IN_PATTERN = String.raw`(?:${CONSTITUENT_REF_LABEL_PATTERN}|constituents?|constituent\s+(?:PR|MR|pull\s+request|merge\s+request)|sources?(?:\s+(?:PR|MR|pull\s+request|merge\s+request))?|queue\s+(?:PR|MR|pull\s+request|merge\s+request))`;
const CONSTITUENT_REPO_QUALIFIED_REF_PREFIX_PATTERN = String.raw`(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+[#!]`;
const CONSTITUENT_TABLE_REF_PATTERN = String.raw`(?:${CONSTITUENT_REF_LABEL_PATTERN}\s*[:=]?\s*)?(?:${CONSTITUENT_REPO_QUALIFIED_REF_PREFIX_PATTERN})?[#!]?(\d+)`;
const CONSTITUENT_MARKED_OR_LABELLED_REF_PATTERN = String.raw`(?:(?:${CONSTITUENT_REF_LABEL_PATTERN}\s*[:=]?\s*[#!]?)|${CONSTITUENT_REPO_QUALIFIED_REF_PREFIX_PATTERN}|[#!])(\d+)`;
const CONSTITUENT_LINK_TOKEN_PATTERN = String.raw`(?:\[[^\]]*?\]\(https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)|<https?:\/\/[^>\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+\b[^>]*>|https?:\/\/\S+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+\b)`;
const QUEUE_MERGE_FORWARD_TARGET_PATTERN = /\b(?:into|onto|to)\s+(?:(?:this|the|current)\s+)?(?:merge\s+)?queue(?:\s+(?:branch|head))?\b/i;
const QUEUE_MERGE_FORWARD_STATUS_PATTERN = /\b(?:merged|merging|integrated|integrating|landed|landing)\b/i;
const CONSTITUENT_NUMBER_LIST_PATTERN = new RegExp(
  String.raw`(?:\s*(?:(?:,|\+|&|/|${TITLE_PR_RANGE_SEPARATOR_PATTERN}|\band\b)\s*)*[#!]?\d+\b){1,${MAX_TITLE_PR_LIST_ITEMS}}`,
  "i",
);

function parseLabelledConstituentNumberLists(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(new RegExp(`\\b${CONSTITUENT_REF_LABEL_PATTERN}\\b`, "gi"))) {
    const afterMarker = text.slice((match.index ?? 0) + match[0].length);
    const listText = afterMarker.match(CONSTITUENT_NUMBER_LIST_PATTERN)?.[0] ?? "";
    addBoundedPrNumberRanges(listText, numbers, true);
    for (const numberMatch of listText.matchAll(/[#!]?(\d+)\b/g)) {
      const parsed = Number.parseInt(numberMatch[1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) numbers.push(parsed);
    }
  }
  return numbers;
}

function parseConstituentNumbersFromListText(text: string): number[] {
  const numbers: number[] = [];
  addBoundedPrNumberRanges(text, numbers, true);
  for (const numberMatch of text.matchAll(/[#!]?(\d+)\b/g)) {
    const parsed = Number.parseInt(numberMatch[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) numbers.push(parsed);
  }
  return uniqueNumbers(numbers);
}

function parseLeadingMarkedConstituentNumberList(text: string): number[] {
  const status = text.match(QUEUE_MERGE_FORWARD_STATUS_PATTERN);
  const afterStatus = status ? text.slice((status.index ?? 0) + status[0].length) : text;
  const listText = afterStatus.match(CONSTITUENT_NUMBER_LIST_PATTERN)?.[0] ?? "";
  return parseConstituentNumbersFromListText(listText);
}

function parseQueueMergeSourceNumbers(text: string): number[] {
  const labelledNumbers = parseLabelledConstituentNumberLists(text);
  if (labelledNumbers.length > 0) return uniqueNumbers(labelledNumbers);
  return parseLeadingMarkedConstituentNumberList(text);
}

function parseQueueMergePostTargetNumbers(text: string): number[] {
  const listPrefix = text.match(/^\s*[:\-\u2013\u2014]\s*(.+)$/)?.[1] ?? "";
  if (!listPrefix) return [];
  const labelledNumbers = parseLabelledConstituentNumberLists(listPrefix);
  if (labelledNumbers.length > 0) return uniqueNumbers(labelledNumbers);
  return parseConstituentNumbersFromListText(listPrefix.match(CONSTITUENT_NUMBER_LIST_PATTERN)?.[0] ?? "");
}

export function parseMergedPrNumbersFromQueueProse(line: string): number[] {
  const status = line.match(QUEUE_MERGE_FORWARD_STATUS_PATTERN);
  if (!status) return [];
  const target = line.match(QUEUE_MERGE_FORWARD_TARGET_PATTERN);
  if (!target) return [];
  const targetIndex = target.index ?? 0;
  const statusIndex = status.index ?? 0;
  const beforeTarget = targetIndex > statusIndex
    ? line.slice(statusIndex, targetIndex)
    : "";
  const beforeTargetNumbers = parseQueueMergeSourceNumbers(beforeTarget);
  if (beforeTargetNumbers.length > 0) return beforeTargetNumbers;
  return parseQueueMergePostTargetNumbers(line.slice(targetIndex + target[0].length));
}

function markdownLabelPrNumber(label: string | undefined): number | null {
  const digits = label?.match(new RegExp(`(?:${CONSTITUENT_REF_LABEL_PATTERN}\\s*[:=]?\\s*[#!]?|${CONSTITUENT_REPO_QUALIFIED_REF_PREFIX_PATTERN}|[#!])(\\d+)\\b`, "i"))?.[1];
  const number = Number.parseInt(digits ?? "", 10);
  return Number.isInteger(number) ? number : null;
}

function markdownDescriptiveLinkTitle(label: string | undefined): string | null {
  return markdownLabelPrNumber(label) === null ? cleanHintTitle(label ?? "") : null;
}

function constituentHintFromTableCell(cell: string): ConstituentTableCellHint | null {
  const markdownLink = cell.match(/\[([^\]]*?)\]\((https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)[^)]*)\)(.*)$/i);
  if (markdownLink) {
    const number = Number.parseInt(markdownLink[3] ?? "", 10);
    const labelNumber = markdownLabelPrNumber(markdownLink[1]);
    if (
      !Number.isInteger(number) ||
      number <= 0 ||
      (labelNumber !== null && (labelNumber <= 0 || labelNumber !== number))
    ) {
      return null;
    }
    return {
      number,
      url: markdownLink[2] ?? null,
      title: cleanHintTitle(markdownLink[4] ?? "") ?? markdownDescriptiveLinkTitle(markdownLink[1]),
    };
  }

  const rawUrl = cell.match(/(https?:\/\/\S+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b)(.*)$/i);
  if (rawUrl?.[2]) {
    const number = Number.parseInt(rawUrl[2], 10);
    if (Number.isInteger(number) && number > 0) {
      return {
        number,
        url: rawUrl[1] ?? null,
        title: cleanHintTitle(rawUrl[3] ?? ""),
      };
    }
  }

  const plain = cell.match(new RegExp(`^${CONSTITUENT_TABLE_REF_PATTERN}\\b(?:(\\s*[-\\u2013\\u2014:]\\s*|\\s+)(.*))?$`, "i"));
  if (!plain?.[1]) return null;
  const number = Number.parseInt(plain[1], 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    number,
    url: null,
    title: cleanHintTitle(plain[3] ?? ""),
  };
}

function extractTableHeadSha(line: string, cells: string[]): string | null {
  const labelled = extractHeadSha(line);
  if (labelled) return labelled;
  return cells.find(isHexSha)?.replace(/^`|`$/g, "") ?? null;
}

function addConstituentHint(
  hints: Map<number, ConstituentHint>,
  number: number,
  patch: Partial<Omit<ConstituentHint, "number">>,
): void {
  if (!Number.isInteger(number) || number <= 0) return;
  const previous = hints.get(number) ?? {
    number,
    title: null,
    url: null,
    head_sha: null,
    evidence_refs: [`pr:#${number}`],
  };
  hints.set(number, {
    number,
    title: patch.title ?? previous.title,
    url: patch.url ?? previous.url,
    head_sha: patch.head_sha ?? previous.head_sha,
    evidence_refs: uniqueStrings([...previous.evidence_refs, ...(patch.evidence_refs ?? [])]),
  });
}

function extractConstituentHintFromTableRow(
  line: string,
  evidenceRef: string,
  hints: Map<number, ConstituentHint>,
  header: ConstituentHintTableHeader,
): boolean {
  const cells = parseMarkdownTableCells(line);
  if (!cells || isMarkdownTableSeparator(cells)) return false;
  const prEntry = cells
    .map((cell, index) => ({ hint: constituentHintFromTableCell(cell), index }))
    .find((entry) => entry.hint !== null);
  if (!prEntry?.hint) return false;

  const headSha = extractTableHeadSha(line, cells);
  const title = header.titleIndexes
    .filter((index) => index !== prEntry.index)
    .map((index) => cells[index] ?? "")
    .map(cleanHintTitle)
    .find((value): value is string => value !== null) ?? prEntry.hint.title;

  addConstituentHint(hints, prEntry.hint.number, {
    title,
    url: prEntry.hint.url,
    head_sha: headSha,
    evidence_refs: [evidenceRef],
  });
  return true;
}

function listLinePayload(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/^\[[ xX]\]\s*/i, "")
    .trim();
}

function constituentLinkPayloadPrefix(payload: string): string {
  return payload
    .replace(new RegExp(`^(?:${CONSTITUENT_LINK_LEAD_IN_PATTERN})\\s*[:=\\-\\u2013\\u2014]\\s*`, "i"), "")
    .trimStart();
}

function isConstituentLinkListSeparator(value: string): boolean {
  return /^\s*(?:[,;]|\+|&|\/|\band\b)\s*/i.test(value);
}

function stripConstituentLinkListSeparators(value: string): string {
  let rest = value;
  for (let index = 0; index < 4; index++) {
    const next = rest.replace(/^\s*(?:[,;]|\+|&|\/|\band\b)\s*/i, "");
    if (next === rest) return rest.trimStart();
    rest = next;
  }
  return rest.trimStart();
}

function stripLeadingConstituentLinkListItem(value: string): string | null {
  const token = new RegExp(`^${CONSTITUENT_LINK_TOKEN_PATTERN}`, "i").exec(value.trimStart())?.[0];
  if (!token) return null;
  const rest = value.trimStart().slice(token.length);
  if (rest.trim().length > 0 && !isConstituentLinkListSeparator(rest)) return null;
  return stripConstituentLinkListSeparators(rest);
}

function startsWithConstituentLinkPayload(payload: string, linkText: string): boolean {
  let rest = constituentLinkPayloadPrefix(payload);
  for (let index = 0; index < MAX_TITLE_PR_LIST_ITEMS; index++) {
    if (rest.startsWith(linkText) || rest.startsWith(`<${linkText}`)) return true;
    const next = stripLeadingConstituentLinkListItem(rest);
    if (next === null || next === rest) return false;
    rest = next;
  }
  return false;
}

function isOnlyConstituentLinkListRemainder(value: string): boolean {
  let rest = value.trim();
  if (rest.length === 0) return false;
  if (!isConstituentLinkListSeparator(rest)) return false;
  rest = stripConstituentLinkListSeparators(rest);
  for (let index = 0; index < MAX_TITLE_PR_LIST_ITEMS && rest.length > 0; index++) {
    const next = stripLeadingConstituentLinkListItem(rest);
    if (next === null || next === rest) return false;
    rest = next;
  }
  return rest.length === 0;
}

function markdownLinkHintTitle(after: string, label: string | undefined): string | null {
  if (isOnlyConstituentLinkListRemainder(after)) return markdownDescriptiveLinkTitle(label);
  return cleanHintTitle(after) ?? markdownDescriptiveLinkTitle(label);
}

function rawUrlHintTitle(after: string): string | null {
  const normalizedAfter = after.trimStart().replace(/^>\s*/, "");
  return isOnlyConstituentLinkListRemainder(normalizedAfter) ? null : cleanHintTitle(normalizedAfter);
}

function scopedValidationCommandCandidate(value: string): string {
  return cleanQueueValidationCommandPrefix(value)
    .replace(new RegExp(`^${CONSTITUENT_MARKED_OR_LABELLED_REF_PATTERN}\\b\\s+`, "i"), "")
    .trim();
}

function startsWithExplicitConstituentHint(payload: string): boolean {
  return new RegExp(`^${CONSTITUENT_MARKED_OR_LABELLED_REF_PATTERN}\\b(?:(\\s*[-\\u2013\\u2014:]\\s*|\\s+).*)?$`, "i").test(payload);
}

function isExplicitConstituentHintLine(line: string, payload: string): boolean {
  return startsWithExplicitConstituentHint(payload) && extractQueueValidationEvidence([{ body: line }]).length === 0;
}

function isGithubClosingReferenceLine(line: string): boolean {
  return new RegExp(
    String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?)\s+(?:${CONSTITUENT_REPO_QUALIFIED_REF_PREFIX_PATTERN}\d+|#|\[|https?:\/\/|<https?:\/\/)`,
    "i",
  ).test(listLinePayload(line));
}

function looksLikeValidationLine(line: string): boolean {
  const arrowResult = line.match(/(?:->|=>)\s*(.+)$/u)?.[1]?.trim();
  if (arrowResult && looksLikeQueueValidationStatus(arrowResult)) return true;
  const colonIndex = line.lastIndexOf(":");
  if (colonIndex >= 0) {
    const colonCommand = scopedValidationCommandCandidate(listLinePayload(line.slice(0, colonIndex)));
    const colonResult = line.slice(colonIndex + 1).trim();
    if (looksLikeQueueValidationCommand(colonCommand) && looksLikeQueueValidationStatus(colonResult)) return true;
  }
  if (/\[[ xX]\]\s+(?:(?:(?:PR|MR)\s*)?[#!]?\d+\s+)?`[^`]+`/.test(line)) return true;
  const checkboxCommand = line.match(/^\s*[-*]\s*\[[ xX]\]\s*(?:(?:(?:PR|MR)\s*)?[#!]?\d+\s+)?(.+)$/i)?.[1]?.trim();
  if (checkboxCommand && looksLikeQueueValidationCommand(cleanQueueValidationCommandPrefix(checkboxCommand))) return true;
  if (extractQueueValidationEvidence([{ body: line }]).length > 0) return true;
  const tableCells = line.includes("|")
    ? line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0)
    : [];
  if (
    tableCells.length >= 3 &&
    tableCells.some((cell) => /^(?:(?:PR|MR)\s*[#!]?\d+|[#!]\d+)$/i.test(cell) || /^\[(?:(?:PR\s*)#?|(?:MR\s*)!?|#|!)\d+\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)$/i.test(cell)) &&
    tableCells.some((cell) => looksLikeQueueValidationCommand(cell.replace(/^`|`$/g, ""))) &&
    tableCells.some((cell) => looksLikeQueueValidationStatus(cell))
  ) return true;
  return QUEUE_STATUS_SYMBOL_PATTERN.test(line);
}

function extractConstituentHintsFromText(
  text: string,
  evidenceRef: string,
  hints: Map<number, ConstituentHint>,
): void {
  let constituentTableHeaderActive: ConstituentHintTableHeader | null = null;
  for (const rawLine of visibleCommentLines(text)) {
    const line = rawLine.trim();
    if (!line) {
      constituentTableHeaderActive = null;
      continue;
    }
    const cells = parseMarkdownTableCells(line);
    if (cells) {
      if (isMarkdownTableSeparator(cells)) continue;
      const header = constituentHintTableHeader(cells);
      if (header) {
        constituentTableHeaderActive = header;
        continue;
      }
    } else {
      constituentTableHeaderActive = null;
    }
    const payload = listLinePayload(line);
    const headSha = extractHeadSha(line);
    const explicitConstituentHint = isExplicitConstituentHintLine(line, payload);
    const validationLine = looksLikeValidationLine(line) && !explicitConstituentHint;
    const closingReferenceLine = isGithubClosingReferenceLine(line);

    if (!validationLine && !closingReferenceLine) {
      if (cells) {
        if (constituentTableHeaderActive && extractConstituentHintFromTableRow(line, evidenceRef, hints, constituentTableHeaderActive)) continue;
        continue;
      }

      const consumedMarkdownLinkUrlSpans: Array<{ start: number; end: number }> = [];
      for (const match of line.matchAll(/\[([^\]]*?)\]\((https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)[^)]*)\)/gi)) {
        const url = match[2] ?? "";
        const urlStart = (match.index ?? 0) + match[0].indexOf(url);
        consumedMarkdownLinkUrlSpans.push({ start: urlStart, end: urlStart + url.length });
        if (!startsWithConstituentLinkPayload(payload, match[0])) {
          continue;
        }
        const number = markdownLabelPrNumber(match[1]);
        const linkedNumber = Number.parseInt(match[3] ?? "", 10);
        if (
          !Number.isInteger(linkedNumber) ||
          linkedNumber <= 0 ||
          (number !== null && (number <= 0 || number !== linkedNumber))
        ) {
          continue;
        }
        const after = line.slice((match.index ?? 0) + match[0].length);
        addConstituentHint(hints, number ?? linkedNumber, {
          title: markdownLinkHintTitle(after, match[1]),
          url: url || null,
          head_sha: headSha,
          evidence_refs: [evidenceRef],
        });
      }

      for (const match of line.matchAll(/https?:\/\/\S+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b/g)) {
        const urlStart = match.index ?? -1;
        if (consumedMarkdownLinkUrlSpans.some((span) => urlStart >= span.start && urlStart < span.end)) {
          continue;
        }
        if (!startsWithConstituentLinkPayload(payload, match[0])) {
          continue;
        }
        const number = Number.parseInt(match[1] ?? "", 10);
        const after = line.slice((match.index ?? 0) + match[0].length);
        addConstituentHint(hints, number, {
          url: match[0],
          title: rawUrlHintTitle(after),
          head_sha: headSha,
          evidence_refs: [evidenceRef],
        });
      }
    }

    const plainMatch = payload.match(new RegExp(`^${CONSTITUENT_MARKED_OR_LABELLED_REF_PATTERN}\\b(?:(\\s*[-\\u2013\\u2014:]\\s*|\\s+)(.*))?$`, "i"));
    if (plainMatch && !validationLine) {
      const number = Number.parseInt(plainMatch[1] ?? "", 10);
      addConstituentHint(hints, number, {
        title: cleanHintTitle(plainMatch[3] ?? ""),
        head_sha: headSha,
        evidence_refs: [evidenceRef],
      });
    }
  }
}

function addMergedConstituentRef(refsByNumber: Map<number, string[]>, number: number, evidenceRef: string): void {
  if (!Number.isInteger(number) || number <= 0) return;
  refsByNumber.set(number, uniqueStrings([...(refsByNumber.get(number) ?? []), evidenceRef]));
}

function extractMergedConstituentNumbersFromText(
  text: string,
  evidenceRef: string,
  refsByNumber: Map<number, string[]>,
): void {
  for (const rawLine of visibleCommentLines(text)) {
    for (const number of parseMergedPrNumbersFromQueueProse(rawLine.trim())) {
      addMergedConstituentRef(refsByNumber, number, evidenceRef);
    }
  }
}

export function extractConstituentHints(
  prDetails: Record<string, unknown>,
  comments: unknown[],
  reviewComments: unknown[] = [],
): Map<number, ConstituentHint> {
  const hints = new Map<number, ConstituentHint>();
  extractConstituentHintsFromText(prDetailsBody(recordShapeItem(prDetails) ?? {}), "github:pr-body", hints);
  for (const commentRaw of [...comments, ...reviewComments]) {
    const body = commentBody(commentRaw);
    if (isReviewGateCacheBody(body)) continue;
    const ref = commentEvidenceRef(commentRaw, "github:pr-comment") ?? "github:pr-comment";
    extractConstituentHintsFromText(body, ref, hints);
  }
  return hints;
}

export function extractMergedConstituentNumbers(
  prDetails: Record<string, unknown>,
  comments: unknown[],
  reviewComments: unknown[] = [],
): Map<number, string[]> {
  const refsByNumber = new Map<number, string[]>();
  extractMergedConstituentNumbersFromText(prDetailsBody(recordShapeItem(prDetails) ?? {}), "github:pr-body", refsByNumber);
  for (const commentRaw of [...comments, ...reviewComments]) {
    const body = commentBody(commentRaw);
    if (isReviewGateCacheBody(body)) continue;
    const ref = commentEvidenceRef(commentRaw, "github:pr-comment") ?? "github:pr-comment";
    extractMergedConstituentNumbersFromText(body, ref, refsByNumber);
  }
  return refsByNumber;
}
