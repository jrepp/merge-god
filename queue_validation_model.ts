/**
 * Pure queue validation evidence parsing.
 *
 * Converts operator/agent comments into scoped validation evidence that the
 * merge queue model can use to classify constituent PR state.
 */

import type { QueueValidationEvidence } from "@merge-god/github-sync";
import { recordShapeItem } from "./collection_access_model";
import { commentBody, commentEvidenceRef } from "./comment_access_model";
import { commentVisibilityEvents } from "./comment_visibility_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";
import { isReviewGateCacheBody } from "./review_gate_cache";

function recordValue(v: unknown): Record<string, unknown> {
  return recordShapeItem(v) ?? {};
}

function toStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

function firstNonEmptyTextOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return null;
}

function positiveIntegerScopeText(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return `#${value}`;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? `#${parsed}` : null;
}

function validationEvidenceScopeRaw(evidence: Record<string, unknown>): string {
  const explicitScope = firstNonEmptyTextOrNull(
    evidence["scope"],
    evidence["area"],
    evidence["package"],
    evidence["path"],
  );
  if (explicitScope !== null) return explicitScope;

  for (const key of [
    "pr",
    "pull_request",
    "pullRequest",
    "mr",
    "mr_number",
    "mrNumber",
    "mr_iid",
    "mrIid",
    "merge_request",
    "mergeRequest",
    "merge_request_number",
    "mergeRequestNumber",
    "constituent",
    "constituent_pr",
    "constituentPr",
    "pull_request_iid",
    "pullRequestIid",
    "merge_request_iid",
    "mergeRequestIid",
  ]) {
    const numericScope = positiveIntegerScopeText(evidence[key]);
    if (numericScope !== null) return numericScope;
    const text = firstNonEmptyTextOrNull(evidence[key]);
    if (text === null) continue;
    const normalized = normalizeValidationScopeValue(text);
    if (normalized !== null && /^#\d+$/.test(normalized)) return normalized;
  }

  return "";
}

const SCOPE_TOKEN_PATTERN = "[#@A-Za-z0-9_.:/-]+";
const STANDALONE_SCOPE_PREFIX_PATTERN = "(?:^|[\\s([{])scope\\s*[:=]\\s*";
const STATUS_SYMBOL_PATTERN = "[✅✓✔❌✗✖⛔🚫🚧⏳⌛❓🔴🟢]";
const STATUS_PREFIX_PATTERN = `(?:startup[_ -]?failure|timed[_ -]?out|action[_ -]?required|in[_ -]?progress|passed|pass|success|succeeded|ok|failed|fail|failure|error|errored|timeout|blocked|blocking|blocker|pending|waiting|running|queued|skipped|skip|unknown|inconclusive|manual|cancelled|canceled|neutral|stale|expired|${STATUS_SYMBOL_PATTERN})`;
const PR_URL_PATH_PATTERN = String.raw`\/(?:pulls?|(?:-\/)?merge_requests)\/`;
const REPO_QUALIFIED_REF_PATTERN = String.raw`(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+[#!]\d+`;
const PR_OR_MR_LABEL_PATTERN = String.raw`(?:(?:pull\s+request|merge\s+request|PR|MR)\s*[#!]?|[#!])\d+`;
const PR_SCOPE_TOKEN_PATTERN = String.raw`(?:\[${PR_OR_MR_LABEL_PATTERN}\]\(https?:\/\/[^)]*${PR_URL_PATH_PATTERN}\d+[^)]*\)|<https?:\/\/[^>\s]+${PR_URL_PATH_PATTERN}\d+\b[^>]*>|https?:\/\/[^)\s]+${PR_URL_PATH_PATTERN}\d+\b|${REPO_QUALIFIED_REF_PATTERN}|(?:pull\s+requests?|pull|PRs?|merge\s+requests?|MRs?)\s*[#!]?\d+|[#!]\d+)`;
const PR_SCOPE_RANGE_SEPARATOR_PATTERN = "(?:[-\\u2013\\u2014]|\\.{2}|\\bto\\b|\\bthrough\\b)";
const PR_SCOPE_RANGE_PATTERN = `${PR_SCOPE_TOKEN_PATTERN}\\s*${PR_SCOPE_RANGE_SEPARATOR_PATTERN}\\s*(?:${PR_SCOPE_TOKEN_PATTERN}|#?\\d+)`;

function stripMarkdownListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

function decodeBasicHtmlEntities(value: string): string {
  const fromEntityCodePoint = (codePoint: number): string => {
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "";
  };
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return fromEntityCodePoint(codePoint);
    })
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return fromEntityCodePoint(codePoint);
    });
}

function stripCodeMarkup(value: string): string {
  let current = value.trim();
  for (let index = 0; index < 3; index++) {
    const previous = current;
    const markdownCode = current.match(/^`([\s\S]*)`$/)?.[1];
    if (markdownCode !== undefined) current = markdownCode.trim();
    const htmlCode = current.match(/^<code\b[^>]*>([\s\S]*?)<\/code>$/i)?.[1];
    if (htmlCode !== undefined) current = decodeBasicHtmlEntities(htmlCode).trim();
    if (current === previous) break;
  }
  return decodeBasicHtmlEntities(current).trim();
}

function stripValidationStatusAffixes(value: string): string {
  return value
    .replace(new RegExp(`^\\s*${STATUS_PREFIX_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "iu"), "")
    .replace(new RegExp(`\\s+[-\\u2013\\u2014]\\s*${STATUS_PREFIX_PATTERN}\\s*$`, "iu"), "")
    .replace(new RegExp(`\\s*\\(${STATUS_PREFIX_PATTERN}\\)\\s*$`, "iu"), "")
    .replace(new RegExp(`\\s*${STATUS_SYMBOL_PATTERN}\\s*$`, "u"), "")
    .trim();
}

function normalizedPrScopeFromDigits(value: string | undefined): string | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? `#${parsed}` : null;
}

function markdownPrLabelDigits(label: string | undefined): string | undefined {
  return label?.match(new RegExp(`(?:(?:pull\\s+request|merge\\s+request|PR|MR)\\s*[#!]?|(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+[#!]|[#!])(\\d+)\\b`, "i"))?.[1];
}

function repoQualifiedScopeDigits(value: string): string | undefined {
  return value.match(new RegExp(`^\\s*${REPO_QUALIFIED_REF_PATTERN}\\b`, "i"))?.[0]?.match(/[#!](\d+)$/)?.[1];
}

function markdownPrScopeMatchFromParts(label: string | undefined, urlDigits: string | undefined): ValidationScopeMatch {
  const urlScope = normalizedPrScopeFromDigits(urlDigits);
  if (urlScope === null) return { matched: true, scope: null };
  const labelDigits = markdownPrLabelDigits(label);
  if (!labelDigits) return { matched: true, scope: urlScope };
  const labelScope = normalizedPrScopeFromDigits(labelDigits);
  return labelScope === urlScope ? { matched: true, scope: urlScope } : { matched: true, scope: null };
}

function normalizeValidationScopeValue(value: string): string | null {
  const raw = stripCodeMarkup(value);
  if (!raw || /^:?-{3,}:?$/.test(raw)) return null;
  const explicitScope = raw.match(/^scope\s*[:=]\s*(.+)$/i)?.[1]?.trim() ?? raw;
  const cleaned = explicitScope.replace(/[:;,]+$/, "").trim();
  if (/^(?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue)$/i.test(cleaned)) return null;
  if (distinctPrRefsInScopeCandidate(cleaned).size > 1) return null;
  const markdownPrScope = cleaned.match(/^\[([^\]]+)\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)[^)]*\)(?:\s|$)/i);
  if (markdownPrScope) return markdownPrScopeMatchFromParts(markdownPrScope[1], markdownPrScope[2]).scope;
  const autolinkPrUrlScope = cleaned.match(/^<https?:\/\/[^>\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b[^>]*>/i)?.[1];
  if (autolinkPrUrlScope) return normalizedPrScopeFromDigits(autolinkPrUrlScope);
  const rawPrUrlScope = cleaned.match(/^https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b/i)?.[1];
  if (rawPrUrlScope) return normalizedPrScopeFromDigits(rawPrUrlScope);
  const repoQualifiedScope = repoQualifiedScopeDigits(cleaned);
  if (repoQualifiedScope) return normalizedPrScopeFromDigits(repoQualifiedScope);
  const prScope = cleaned.match(/^(?:(?:pull\s+request|merge\s+request|PR|MR)\s*[:=]?\s*)?[#!]?(\d+)$/i)?.[1];
  if (prScope) return normalizedPrScopeFromDigits(prScope);
  const titledPrScope = cleaned.match(/^(?:(?:pull\s+request|merge\s+request|PR|MR)\s*[:=]?\s*)?[#!]?(\d+)\b/i)?.[1];
  if (titledPrScope) return normalizedPrScopeFromDigits(titledPrScope);
  return cleaned || null;
}

function codeSpannedScopeMatch(line: string): { value: string; endIndex: number } | null {
  const match = new RegExp(`${STANDALONE_SCOPE_PREFIX_PATTERN}\`([^\`]+)\``, "i").exec(line);
  if (!match?.[1] || match.index === undefined) return null;
  return { value: match[1], endIndex: match.index + match[0].length };
}

function htmlCodeSpannedScopeMatch(line: string): { value: string; endIndex: number } | null {
  const match = new RegExp(`${STANDALONE_SCOPE_PREFIX_PATTERN}<code\\b[^>]*>([\\s\\S]*?)<\\/code>`, "i").exec(line);
  if (!match?.[1] || match.index === undefined) return null;
  return { value: match[1], endIndex: match.index + match[0].length };
}

interface ValidationScopeMatch {
  matched: boolean;
  scope: string | null;
}

function hasMultiPrScopePrefix(line: string): boolean {
  return new RegExp(`^\\s*(?:\\[[ xX]\\]\\s*)?(?:scope\\s*[:=]\\s*)?(?:${PR_SCOPE_RANGE_PATTERN}|${PR_SCOPE_TOKEN_PATTERN}(?:\\s*(?:,|\\/|&|\\+|\\band\\b)\\s*${PR_SCOPE_TOKEN_PATTERN})+)`, "i").test(line);
}

function explicitValidationScopeMatch(line: string): ValidationScopeMatch {
  const cleanedLine = stripMarkdownListMarker(line);
  const statusTargetScope = statusTargetValidationScopeMatch(cleanedLine);
  if (statusTargetScope.matched) return statusTargetScope;
  const targetStatusScope = targetStatusValidationScopeMatch(cleanedLine);
  if (targetStatusScope.matched) return targetStatusScope;
  if (hasMultiPrScopePrefix(cleanedLine)) {
    return { matched: true, scope: null };
  }
  const explicitPullRequestScope = new RegExp(`${STANDALONE_SCOPE_PREFIX_PATTERN}(?:pull|merge)\\s+request\\s*[:=]?\\s*[#!]?(\\d+)\\b`, "i").exec(cleanedLine)?.[1];
  if (explicitPullRequestScope) return { matched: true, scope: normalizedPrScopeFromDigits(explicitPullRequestScope) };
  const explicitPrScope = new RegExp(`${STANDALONE_SCOPE_PREFIX_PATTERN}(?:(?:PR|MR)\\s*)?[#!]?(\\d+)\\b`, "i").exec(cleanedLine)?.[1];
  if (explicitPrScope) return { matched: true, scope: normalizedPrScopeFromDigits(explicitPrScope) };
  const codeScope = codeSpannedScopeMatch(cleanedLine);
  if (codeScope) return { matched: true, scope: normalizeValidationScopeValue(codeScope.value) };
  const htmlCodeScope = htmlCodeSpannedScopeMatch(cleanedLine);
  if (htmlCodeScope) return { matched: true, scope: normalizeValidationScopeValue(htmlCodeScope.value) };
  const explicitScope = new RegExp(`${STANDALONE_SCOPE_PREFIX_PATTERN}(${SCOPE_TOKEN_PATTERN})`, "i").exec(cleanedLine)?.[1];
  if (explicitScope) return { matched: true, scope: normalizeValidationScopeValue(explicitScope) };
  const markdownPrScope = cleanedLine.match(/\[([^\]]+)\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)[^)]*\)/i);
  if (markdownPrScope) return markdownPrScopeMatchFromParts(markdownPrScope[1], markdownPrScope[2]);
  const rawPrUrlScope = cleanedLine.match(/https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b/i)?.[1];
  if (rawPrUrlScope) return { matched: true, scope: normalizedPrScopeFromDigits(rawPrUrlScope) };
  const repoQualifiedScope = repoQualifiedScopeDigits(cleanedLine);
  if (repoQualifiedScope) return { matched: true, scope: normalizedPrScopeFromDigits(repoQualifiedScope) };
  const leadingPrScope = cleanedLine.match(/^\s*(?:\[[ xX]\]\s*)?(?:(?:pull\s+request|merge\s+request|pull|PR|MR)\s*[:=]?\s*[#!]?|[#!])(\d+)\b/i)?.[1];
  if (leadingPrScope) return { matched: true, scope: normalizedPrScopeFromDigits(leadingPrScope) };
  const prScope = cleanedLine.match(/\b(?:pull\s+request|merge\s+request|PR|MR)\s*[#!]?(\d+)\b/i)?.[1] ?? cleanedLine.match(/(?:^|\s)[#!](\d+)\b/)?.[1];
  return prScope ? { matched: true, scope: normalizedPrScopeFromDigits(prScope) } : { matched: false, scope: null };
}

function extractValidationScope(line: string): string | null {
  return explicitValidationScopeMatch(line).scope;
}

interface StatusTargetParts {
  target: string;
  command: string;
  status: QueueValidationEvidence["status"];
}

function statusTargetParts(line: string): StatusTargetParts | null {
  const prefix = new RegExp(`^\\s*(?:\\[[ xX]\\]\\s*)?${STATUS_PREFIX_PATTERN}\\s+(?:for|on)\\s+`, "iu").exec(line);
  if (!prefix) return null;
  const status = normalizeValidationStatus(prefix[0]);
  if (!status) return null;
  const remainder = line.slice(prefix[0].length);
  const separator = String.raw`\s*(?:[-:\u2013\u2014]\s*|\s+)`;
  const targetPatterns = [
    String.raw`(\[[^\]]+\]\(https?:\/\/[^)]*${PR_URL_PATH_PATTERN}\d+[^)]*\))${separator}(.+)$`,
    String.raw`(<https?:\/\/[^>\s]+${PR_URL_PATH_PATTERN}\d+\b[^>]*>)${separator}(.+)$`,
    String.raw`(https?:\/\/[^)\s]+${PR_URL_PATH_PATTERN}\d+\b[^)\s]*)${separator}(.+)$`,
    `(${PR_SCOPE_RANGE_PATTERN})${separator}(.+)$`,
    `(${PR_SCOPE_TOKEN_PATTERN}(?:\\s*(?:,|\\/|&|\\+|\\band\\b)\\s*${PR_SCOPE_TOKEN_PATTERN})*)${separator}(.+)$`,
    String.raw`((?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue))${separator}(.+)$`,
    String.raw`((?:(?:scope|area|package|path)\s*[:=]\s*)?(?:[#@A-Za-z0-9_.-]+\/[#@A-Za-z0-9_.\/@-]+|@[A-Za-z0-9_.-]+\/[#@A-Za-z0-9_.\/@-]+))${separator}(.+)$`,
  ];
  for (const pattern of targetPatterns) {
    const match = new RegExp(`^${pattern}`, "iu").exec(remainder);
    const target = match?.[1]?.trim() ?? "";
    const command = match?.[2]?.trim() ?? "";
    if (target && command) return { target, command, status };
  }
  return null;
}

function targetStatusParts(line: string): StatusTargetParts | null {
  const cleanedLine = stripMarkdownListMarker(line);
  const prefix = "^\\s*(?:\\[[ xX]\\]\\s*)?";
  const separator = String.raw`\s*(?:[-:\u2013\u2014]\s*|\s+)`;
  const targetPatterns = [
    String.raw`(\[[^\]]+\]\(https?:\/\/[^)]*${PR_URL_PATH_PATTERN}\d+[^)]*\))`,
    String.raw`(<https?:\/\/[^>\s]+${PR_URL_PATH_PATTERN}\d+\b[^>]*>)`,
    String.raw`(https?:\/\/[^)\s]+${PR_URL_PATH_PATTERN}\d+\b[^)\s]*)`,
    `(${PR_SCOPE_RANGE_PATTERN})`,
    `(${PR_SCOPE_TOKEN_PATTERN}(?:\\s*(?:,|\\/|&|\\+|\\band\\b)\\s*${PR_SCOPE_TOKEN_PATTERN})*)`,
    String.raw`((?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue))`,
    String.raw`((?:(?:scope|area|package|path)\s*[:=]\s*)?(?:[#@A-Za-z0-9_.-]+\/[#@A-Za-z0-9_.\/@-]+|@[A-Za-z0-9_.-]+\/[#@A-Za-z0-9_.\/@-]+))`,
  ];
  for (const targetPattern of targetPatterns) {
    const match = new RegExp(`${prefix}${targetPattern}\\s+(${STATUS_PREFIX_PATTERN})${separator}(.+)$`, "iu").exec(cleanedLine);
    const target = match?.[1]?.trim() ?? "";
    const statusRaw = match?.[2]?.trim() ?? "";
    const command = match?.[3]?.trim() ?? "";
    const status = normalizeValidationStatus(statusRaw);
    if (target && status && command) return { target, command, status };
  }
  return null;
}

function validationScopeFromStatusTarget(rawTarget: string): ValidationScopeMatch {
  if (!rawTarget) return { matched: false, scope: null };

  const target = stripCodeMarkup(rawTarget).replace(/[:;,]+$/, "").trim();
  if (!target) return { matched: true, scope: null };
  if (/^(?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue)$/i.test(target)) {
    return { matched: true, scope: null };
  }
  if (distinctPrRefsInScopeCandidate(target).size > 1) {
    return { matched: true, scope: null };
  }

  const normalized = normalizeValidationScopeValue(target);
  if (normalized === null) return { matched: true, scope: null };

  const explicitPathTarget = /^(?:scope|area|package|path)\s*[:=]\s*/i.test(target);
  const pathLikeTarget = normalized.includes("/") || normalized.startsWith("@");
  const prLikeTarget = /^(?:pull\s+requests?|merge\s+requests?|pull|PRs?|MRs?)\b/i.test(target) ||
    /^[#!]\d+\b/.test(target) ||
    new RegExp(`^${REPO_QUALIFIED_REF_PATTERN}\\b`, "i").test(target) ||
    /https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+\b/i.test(target) ||
    /\[[^\]]+\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)/i.test(target);

  return explicitPathTarget || pathLikeTarget || prLikeTarget || /^#\d+$/.test(normalized)
    ? { matched: true, scope: normalized }
    : { matched: false, scope: null };
}

function statusTargetValidationScopeMatch(line: string): ValidationScopeMatch {
  return validationScopeFromStatusTarget(statusTargetParts(line)?.target ?? "");
}

function targetStatusValidationScopeMatch(line: string): ValidationScopeMatch {
  return validationScopeFromStatusTarget(targetStatusParts(line)?.target ?? "");
}

function stripMarkdownSectionMarkup(line: string): string {
  let current = stripMarkdownListMarker(line)
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .trim();
  for (let index = 0; index < 3; index++) {
    const previous = current;
    current = current
      .replace(/^\*\*([\s\S]+)\*\*$/, "$1")
      .replace(/^__([\s\S]+)__$/, "$1")
      .trim();
    if (current === previous) break;
  }
  return current;
}

function distinctPrRefsInScopeCandidate(value: string): Set<number> {
  const refs = new Set<number>();
  for (const match of value.matchAll(new RegExp(`\\b(?:pull\\s+requests?|merge\\s+requests?|pull|PRs?|MRs?)\\s*[#!]?(\\d+)\\s*${PR_SCOPE_RANGE_SEPARATOR_PATTERN}\\s*(?:[#!]?(\\d+)|(?:pull\\s+requests?|merge\\s+requests?|pull|PRs?|MRs?)\\s*[#!]?(\\d+))\\b`, "gi"))) {
    const start = Number.parseInt(match[1] ?? "", 10);
    const end = Number.parseInt(match[2] ?? match[3] ?? "", 10);
    if (Number.isInteger(start) && start > 0) refs.add(start);
    if (Number.isInteger(end) && end > 0) refs.add(end);
  }
  for (const match of value.matchAll(new RegExp(`[#!](\\d+)\\s*${PR_SCOPE_RANGE_SEPARATOR_PATTERN}\\s*[#!]?(\\d+)\\b`, "gi"))) {
    const start = Number.parseInt(match[1] ?? "", 10);
    const end = Number.parseInt(match[2] ?? "", 10);
    if (Number.isInteger(start) && start > 0) refs.add(start);
    if (Number.isInteger(end) && end > 0) refs.add(end);
  }
  for (const match of value.matchAll(/https?:\/\/[^)\s>]+\/(?:pulls?|(?:-\/)?merge_requests)\/(\d+)\b/gi)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) refs.add(parsed);
  }
  for (const match of value.matchAll(new RegExp(`${REPO_QUALIFIED_REF_PATTERN}\\b`, "gi"))) {
    const parsed = Number.parseInt(match[0].match(/[#!](\d+)$/)?.[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) refs.add(parsed);
  }
  for (const match of value.matchAll(/\b(?:pull\s+request|merge\s+request|PR|MR)\s*[#!]?(\d+)\b/gi)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) refs.add(parsed);
  }
  for (const match of value.matchAll(/[#!](\d+)\b/g)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) refs.add(parsed);
  }
  return refs;
}

function sectionValidationScopeMatch(line: string): ValidationScopeMatch {
  const markdownHeading = /^\s*#{1,6}\s+/.test(line);
  const emphasizedHeading = /^\s*(?:\*\*[\s\S]+\*\*|__[\s\S]+__)\s*$/.test(line);
  if (!markdownHeading && !emphasizedHeading) return { matched: false, scope: null };
  let candidate = stripMarkdownSectionMarkup(line);
  const validationFor = candidate.match(/^(?:validation|checks?|results?)\s+for\s+(.+)$/i)?.[1]?.trim();
  if (validationFor) candidate = validationFor;
  const normalizedCandidate = stripCodeMarkup(candidate).replace(/[:;,]+$/, "").trim();
  if (/^(?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue)$/i.test(normalizedCandidate)) {
    return { matched: true, scope: null };
  }
  if (distinctPrRefsInScopeCandidate(normalizedCandidate).size > 1) {
    return { matched: true, scope: null };
  }
  const scope = normalizeValidationScopeValue(normalizedCandidate);
  if (scope && /^#\d+$/.test(scope)) return { matched: true, scope };
  const explicitPathScopeHeading = /^(?:scope|area|package|path)\s*[:=]\s*/i.test(normalizedCandidate);
  const pathLikeScopeHeading = typeof scope === "string" &&
    !/\s/.test(scope) &&
    (scope.includes("/") || scope.startsWith("@"));
  if (scope && (explicitPathScopeHeading || pathLikeScopeHeading)) return { matched: true, scope };
  return { matched: true, scope: null };
}

function normalizeValidationStatus(line: string): QueueValidationEvidence["status"] | null {
  const lower = line.toLowerCase().replace(/_/g, " ");
  if (/\b(?:blocked|blocking|blocker|hold|held)\b/.test(lower) || /[⛔🚫🚧]/u.test(line)) return "blocked";
  if (/\b(?:failed|failure|fail|red|error|errored|timed[ -]?out|timeout)\b/.test(lower) || /[❌✗✖🔴]/u.test(line)) return "failed";
  if (/\b(?:passed|pass|success|succeeded|green|ok)\b/.test(lower) || /[✅✓✔🟢]/u.test(line)) return "passed";
  if (/\b(?:pending|waiting|running|in[ -]?progress|queued|skipped|skip|unknown|inconclusive|manual|action[ -]?required|cancelled|canceled|neutral|stale|expired)\b/.test(lower) || /[⏳⌛❓]/u.test(line)) return "unknown";
  const checkbox = line.match(/\[([ xX])\]/);
  if (checkbox?.[1]?.toLowerCase() === "x") return "passed";
  if (checkbox?.[1] === " ") return "unknown";
  return null;
}

export function looksLikeQueueValidationStatus(value: string): boolean {
  return normalizeValidationStatus(value) !== null;
}

export function normalizeQueueValidationEvidenceStatus(status: unknown): QueueValidationEvidence["status"] {
  return normalizeValidationStatus(toStr(status)) ?? "unknown";
}

export function normalizeQueueValidationEvidenceItems(items: unknown[]): QueueValidationEvidence[] {
  return items.map((item) => {
    const evidence = recordValue(item);
    const commandRaw = firstNonEmptyTextOrNull(
      evidence["command"],
      evidence["cmd"],
      evidence["check"],
      evidence["validation"],
      evidence["test"],
    ) ?? "";
    const inlineFields = inlineValidationFields(commandRaw);
    const explicitCommandStatus = normalizeValidationStatus(explicitValidationResultSegment(commandRaw) ?? "");
    const explicitCommandPrefixStatus = explicitValidationStatusPrefix(commandRaw);
    const explicitCommandTargetStatus = targetStatusParts(commandRaw)?.status ?? null;
    const statusRaw = firstNonEmptyTextOrNull(
      evidence["status"],
      evidence["result"],
      evidence["outcome"],
      evidence["state"],
      evidence["conclusion"],
    ) ?? "";
    const status = normalizeValidationStatus(statusRaw) ??
      inlineFields?.status ??
      explicitCommandStatus ??
      explicitCommandPrefixStatus ??
      explicitCommandTargetStatus ??
      "unknown";
    const scopeRaw = validationEvidenceScopeRaw(evidence);
    const commandScope = explicitValidationScopeMatch(commandRaw);
    const scope = scopeRaw.trim().length > 0
      ? normalizeQueueValidationEvidenceScope(scopeRaw)
      : inlineFields?.scopeMatched === true
        ? inlineFields.scope
        : commandScope.matched
          ? commandScope.scope
        : null;
    const evidenceRef = recordEvidenceRefs(evidence)[0] ?? null;
    return {
      command: normalizeQueueValidationEvidenceCommand(commandRaw),
      status,
      scope,
      evidence_ref: evidenceRef,
    };
  });
}

export function queueValidationStatusRank(status: unknown): number {
  const normalized = normalizeQueueValidationEvidenceStatus(status);
  if (normalized === "failed" || normalized === "blocked") return 0;
  if (normalized === "unknown") return 1;
  return 2;
}

export function isBlockingQueueValidationStatus(status: unknown): boolean {
  return queueValidationStatusRank(status) === 0;
}

export function isInconclusiveQueueValidationStatus(status: unknown): boolean {
  return normalizeQueueValidationEvidenceStatus(status) === "unknown";
}

export function isNonPassingQueueValidationStatus(status: unknown): boolean {
  return queueValidationStatusRank(status) < 2;
}

function explicitValidationResultSegment(line: string): string | null {
  const arrowResult = line.match(/(?:->|=>)\s*(.+)$/u)?.[1]?.trim();
  if (arrowResult) return arrowResult;
  const lastColon = line.lastIndexOf(":");
  if (lastColon < 0) return null;
  const candidate = line.slice(lastColon + 1).trim();
  return candidate.length > 0 ? candidate : null;
}

function normalizeValidationLineStatus(line: string): QueueValidationEvidence["status"] | null {
  const explicitSegment = explicitValidationResultSegment(line);
  if (explicitSegment) {
    const explicitStatus = normalizeValidationStatus(explicitSegment);
    if (explicitStatus) return explicitStatus;
  }
  return normalizeValidationStatus(line);
}

function explicitValidationStatusPrefix(line: string): QueueValidationEvidence["status"] | null {
  const cleanedLine = stripMarkdownListMarker(line);
  const match = new RegExp(`^\\s*(?:\\[[ xX]\\]\\s*)?(${STATUS_PREFIX_PATTERN})\\s*(?:[-:\\u2013\\u2014]\\s*)?(.+)$`, "iu").exec(cleanedLine);
  const statusPrefix = match?.[1] ?? "";
  const remainder = match?.[2]?.trim() ?? "";
  const status = normalizeValidationStatus(statusPrefix);
  if (!status || !remainder) return null;
  const command = cleanQueueValidationCommandPrefix(statusTargetParts(cleanedLine)?.command ?? remainder);
  return looksLikeQueueValidationCommand(command) ? status : null;
}

function parseTableCells(line: string): string[] | null {
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

function isTableSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

interface ValidationTableHeader {
  commandIndex: number;
  statusIndex: number;
  scopeIndex: number | null;
  commandRequiresRunner: boolean;
}

interface InlineValidationFields {
  command: string;
  status: QueueValidationEvidence["status"];
  scope: string | null;
  scopeMatched: boolean;
}

interface NamedValidationSummary {
  command: string;
  status: QueueValidationEvidence["status"];
}

const NARRATIVE_VALIDATION_IDENTITY_ALIASES = new Map<string, string>([
  ["fresh edit", "edit lpar"],
  ["fresh live edit", "edit lpar"],
]);

function inlineFieldMap(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  const text = stripMarkdownListMarker(line);
  const fieldPattern = /(?:^|[;,|])\s*([A-Za-z][A-Za-z _-]{0,32})\s*[:=]\s*/g;
  const matches = [...text.matchAll(fieldPattern)];
  for (const [index, match] of matches.entries()) {
    const key = match[1]?.toLowerCase().replace(/[\s_-]+/g, "_");
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = matches[index + 1]?.index ?? text.length;
    const value = text.slice(valueStart, valueEnd).replace(/[;,]\s*$/, "").trim();
    if (!key || value === undefined) continue;
    fields.set(key, value);
  }
  return fields;
}

function inlineCommandFieldValue(line: string): string | null {
  const fields = inlineFieldMap(line);
  if (
    !["result", "status", "outcome", "state", "conclusion"].some((key) => fields.has(key))
  ) return null;
  return fields.get("command") ?? fields.get("cmd") ?? fields.get("check") ?? fields.get("validation") ?? null;
}

function validationTableHeader(cells: string[]): ValidationTableHeader | null {
  const normalized = cells.map((cell) => cell.toLowerCase().replace(/\s+/g, " ").trim());
  const commandIndex = normalized.findIndex((cell) => /^(?:command|cmd|check|validation|test|validation command|check command)$/.test(cell));
  const statusIndex = normalized.findIndex((cell) => /^(?:status|result|outcome|state|conclusion)$/.test(cell));
  if (statusIndex < 0) return null;
  if (commandIndex >= 0) {
    const scopeIndex = normalized.findIndex((cell) => /^(?:scope|area|package|path|pr|pull request|mr|merge request|constituent|constituent pr)$/.test(cell));
    return {
      commandIndex,
      statusIndex,
      scopeIndex: scopeIndex >= 0 ? scopeIndex : null,
      commandRequiresRunner: true,
    };
  }

  const narrativeIndex = normalized.findIndex((cell) =>
    /^(?:area|flow|scenario|gate|evidence|validation evidence|check evidence|test evidence|coverage|focus)$/.test(cell)
  );
  if (narrativeIndex < 0) return null;
  const scopeIndex = normalized.findIndex((cell) => /^(?:scope|package|path|pr|pull request|mr|merge request|constituent|constituent pr)$/.test(cell));
  return {
    commandIndex: narrativeIndex,
    statusIndex,
    scopeIndex: scopeIndex >= 0 ? scopeIndex : null,
    commandRequiresRunner: false,
  };
}

function normalizeValidationScopeCellMatch(value: string): ValidationScopeMatch {
  const normalized = normalizeValidationScopeValue(value);
  const stripped = stripCodeMarkup(value).replace(/[:;,]+$/, "").trim();
  if (!stripped) return { matched: true, scope: null };
  if (normalized !== null) return { matched: true, scope: normalized };
  if (/^(?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue)$/i.test(stripped)) {
    return { matched: true, scope: null };
  }
  return { matched: false, scope: null };
}

function normalizeValidationScopeCell(value: string): string | null {
  return normalizeValidationScopeCellMatch(value).scope;
}

export function normalizeQueueValidationEvidenceScope(scope: string | null | undefined): string | null {
  return normalizeValidationScopeValue(scope ?? "");
}

function extractHeaderTableValidationEvidence(
  cells: string[],
  header: ValidationTableHeader,
  line: string,
  evidenceRef: string | null,
  fallbackScope: string | null,
): QueueValidationEvidence | null {
  const command = stripCodeMarkup(cells[header.commandIndex] ?? "");
  const statusCell = cells[header.statusIndex] ?? "";
  const status = normalizeValidationStatus(statusCell);
  const lineScope = explicitValidationScopeMatch(line);
  const tableScope = header.scopeIndex === null
    ? lineScope
    : normalizeValidationScopeCellMatch(cells[header.scopeIndex] ?? "");
  const scope = tableScope.matched ? tableScope.scope : fallbackScope;
  if (!command || !status || (header.commandRequiresRunner && !looksLikeQueueValidationCommand(command))) return null;
  return {
    command: command.slice(0, 240),
    status,
    scope,
    evidence_ref: evidenceRef,
  };
}

function cleanTableCommandCell(value: string): string {
  return stripCodeMarkup(value);
}

function headerlessScopeFromCells(cells: string[], commandIndex: number, statusIndex: number): ValidationScopeMatch {
  for (const [index, cell] of cells.entries()) {
    if (index === commandIndex || index === statusIndex) continue;
    if (!cell || /^:?-{3,}:?$/.test(cell)) continue;
    if (looksLikeQueueValidationCommand(cleanTableCommandCell(cell))) continue;
    if (normalizeValidationStatus(cell) !== null) continue;
    const scope = normalizeValidationScopeCellMatch(cell);
    if (scope.matched) return scope;
  }
  return { matched: false, scope: null };
}

function headerlessTableValidation(
  cells: string[],
): { command: string; status: QueueValidationEvidence["status"]; scope: string | null; scopeMatched: boolean } | null {
  const cellInfo = cells.map((cell, index) => {
    const command = cleanTableCommandCell(cell);
    const commandLike = looksLikeQueueValidationCommand(command);
    return {
      cell,
      command,
      commandLike,
      index,
      status: commandLike ? null : normalizeValidationStatus(cell),
    };
  });
  const commands = cellInfo.filter((cell) => cell.commandLike);
  const statuses = cellInfo.filter((cell) => cell.status !== null);

  for (const statusCell of [...statuses].reverse()) {
    const commandCell = [...commands].reverse().find((cell) => cell.index < statusCell.index);
    if (!commandCell || !statusCell.status) continue;
    const scope = headerlessScopeFromCells(cells, commandCell.index, statusCell.index);
    return {
      command: commandCell.command.slice(0, 240),
      status: statusCell.status,
      scope: scope.scope,
      scopeMatched: scope.matched,
    };
  }

  for (const statusCell of statuses) {
    const commandCell = commands.find((cell) => cell.index > statusCell.index);
    if (!commandCell || !statusCell.status) continue;
    const scope = headerlessScopeFromCells(cells, commandCell.index, statusCell.index);
    return {
      command: commandCell.command.slice(0, 240),
      status: statusCell.status,
      scope: scope.scope,
      scopeMatched: scope.matched,
    };
  }

  return null;
}

function extractTableValidationCommand(line: string): string | null {
  const cells = parseTableCells(line);
  if (!cells) return null;
  return headerlessTableValidation(cells)?.command ?? null;
}

function inlineValidationFields(line: string): InlineValidationFields | null {
  const fields = inlineFieldMap(line);
  const commandRaw = fields.get("command") ?? fields.get("cmd") ?? fields.get("check") ?? fields.get("validation");
  const statusRaw = fields.get("result") ?? fields.get("status") ?? fields.get("outcome") ?? fields.get("state") ?? fields.get("conclusion");
  if (!commandRaw || !statusRaw) return null;

  const command = cleanQueueValidationCommandPrefix(commandRaw);
  const status = normalizeValidationStatus(statusRaw);
  if (!command || !status || !looksLikeQueueValidationCommand(command)) return null;

  const scopeRaw = fields.get("scope") ??
    fields.get("area") ??
    fields.get("package") ??
    fields.get("path") ??
    fields.get("pr") ??
    fields.get("pull_request") ??
    fields.get("mr") ??
    fields.get("merge_request") ??
    fields.get("constituent") ??
    fields.get("constituent_pr");
  const scopeMatched = scopeRaw !== undefined;
  return {
    command: command.slice(0, 240),
    status,
    scope: scopeMatched ? normalizeValidationScopeCell(scopeRaw) : null,
    scopeMatched,
  };
}

function inlineValidationFieldsFromCells(cells: string[]): InlineValidationFields | null {
  const hasInlineFieldCell = cells.some((cell) =>
    /^\s*(?:[-*+]|\d+[.)])?\s*(?:scope|area|package|path|pr|pull request|mr|merge request|constituent|constituent pr|command|cmd|check|validation|result|status|outcome|state|conclusion)\s*[:=]/i.test(cell)
  );
  return hasInlineFieldCell ? inlineValidationFields(cells.join("; ")) : null;
}

function normalizeNamedValidationLabel(value: string): string | null {
  const label = stripMarkdownSectionMarkup(stripMarkdownListMarker(value))
    .replace(/\s+/g, " ")
    .replace(/[:;,\-\u2013\u2014]+$/, "")
    .trim();
  if (!label) return null;
  if (/[`|]|\[[^\]]+\]\(|(?:->|=>)/u.test(label)) return null;
  if (distinctPrRefsInScopeCandidate(label).size > 0) return null;
  if (/^(?:validation|checks?|tests?|suite|storybook|e2e|lint|typecheck|build|regression|gate)$/i.test(label)) return null;
  if (!/\b(?:validation|checks?|tests?|suite|storybook|e2e|lint|typecheck|build|regression|gate)\b/i.test(label)) return null;
  if (looksLikeQueueValidationCommand(label)) return null;
  return label.slice(0, 240);
}

function namedValidationSummaryFromLine(line: string): NamedValidationSummary | null {
  const cleanedLine = stripMarkdownListMarker(line);
  const statusWord = String.raw`(?:passed|pass|success|succeeded|ok|failed|fail|failure|error|errored|blocked|blocking|hold|held)`;
  const labelStatus = new RegExp(
    String.raw`^\s*(.+?)\s+(${statusWord})\b(?:\s+(?:from|with|on|across|locally|in|after)\b[^:.]*)?(?:[:.]|$)`,
    "iu",
  ).exec(cleanedLine);
  if (labelStatus?.[1] && labelStatus[2]) {
    const command = normalizeNamedValidationLabel(labelStatus[1]);
    const status = normalizeValidationStatus(labelStatus[2]);
    if (command && status) return { command, status };
  }

  const labelColon = cleanedLine.match(/^\s*([^:]{1,180}?)\s*:\s*(.+)$/u);
  if (!labelColon?.[1] || !labelColon[2]) return null;
  const command = normalizeNamedValidationLabel(labelColon[1]);
  if (!command) return null;
  const status = new RegExp(String.raw`\b(${statusWord})\b`, "iu").exec(labelColon[2])?.[1];
  const normalizedStatus = normalizeValidationStatus(status ?? "");
  return normalizedStatus ? { command, status: normalizedStatus } : null;
}

export function cleanQueueValidationCommandPrefix(value: string): string {
  const inlineCommand = inlineCommandFieldValue(value);
  if (inlineCommand !== null && inlineCommand !== value) {
    return cleanQueueValidationCommandPrefix(inlineCommand);
  }
  const statusTargetCommand = statusTargetParts(stripMarkdownListMarker(value))?.command;
  if (statusTargetCommand) return cleanQueueValidationCommandPrefix(statusTargetCommand);
  const targetStatusCommand = targetStatusParts(stripMarkdownListMarker(value))?.command;
  if (targetStatusCommand) return cleanQueueValidationCommandPrefix(targetStatusCommand);
  const withoutScopePrefix = stripValidationStatusAffixes(stripCodeMarkup(value)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*\[[ xX]\]\s*/i, "")
    .replace(new RegExp(`^\\s*${STATUS_PREFIX_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "iu"), "")
    .replace(/^\s*\|\s*(?:command|cmd|check|validation)\s*[:=]\s*/i, "")
    .replace(/\s*\|\s*(?:result|status|outcome|state|conclusion)\s*$/i, "")
    .replace(new RegExp(`\\s*(?:->|=>|:)\\s*${STATUS_PREFIX_PATTERN}\\.?\\s*$`, "iu"), "")
    .replace(new RegExp(`^\\s*(?:for|on)\\s+${PR_SCOPE_RANGE_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(new RegExp(`^\\s*(?:for|on)\\s+${PR_SCOPE_TOKEN_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(/^\s*(?:for|on)\s+(?:queue|queue-wide|queue_wide|all|global|whole-queue|whole_queue)\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*(?:for|on)\s+[#@A-Za-z0-9_.-]+\/[#@A-Za-z0-9_.\/@-]+\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(new RegExp(`^\\s*${PR_SCOPE_RANGE_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(new RegExp(`^\\s*${PR_SCOPE_TOKEN_PATTERN}(?:\\s*(?:,|\\/|&|\\+|\\band\\b)\\s*${PR_SCOPE_TOKEN_PATTERN})+\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(new RegExp(`^\\s*${PR_SCOPE_TOKEN_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*|\\s+)`, "i"), "")
    .replace(new RegExp(`^\\s*scope\\s*[:=]\\s*${PR_SCOPE_RANGE_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(new RegExp(`^\\s*scope\\s*[:=]\\s*${PR_SCOPE_TOKEN_PATTERN}(?:\\s*(?:,|\\/|&|\\+|\\band\\b)\\s*${PR_SCOPE_TOKEN_PATTERN})+\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(new RegExp(`^\\s*scope\\s*[:=]\\s*${PR_SCOPE_TOKEN_PATTERN}\\s*(?:[-:\\u2013\\u2014]\\s*|\\s+)`, "i"), "")
    .replace(/^\s*scope\s*[:=]\s*\[[^\]]+\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*scope\s*[:=]\s*\[(?:(?:PR\s*)#?|(?:MR\s*)!?|#|!)\d+\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*scope\s*[:=]\s*<https?:\/\/[^>\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+\b[^>]*>\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*scope\s*[:=]\s*`[^`]+`\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*scope\s*[:=]\s*<code\b[^>]*>[\s\S]*?<\/code>\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*scope\s*[:=]\s*(?:pull|merge)\s+request\s*[:=]?\s*[#!]?\d+\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(new RegExp(`^\\s*scope\\s*[:=]\\s*(?:(?:(?:PR|MR)\\s*)?[#!]?\\d+|${SCOPE_TOKEN_PATTERN})\\s*(?:[-:\\u2013\\u2014]\\s*)?`, "i"), "")
    .replace(/^\s*\[[^\]]+\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*\[(?:(?:PR|MR)\s*[#!]?\d+|[#!]\d+)\]\(https?:\/\/[^)]*\/(?:pulls?|(?:-\/)?merge_requests)\/\d+[^)]*\)\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*<https?:\/\/[^>\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+\b[^>]*>\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*https?:\/\/[^)\s]+\/(?:pulls?|(?:-\/)?merge_requests)\/\d+\b\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*(?:constituent|source|queue)\s+(?:(?:pull\s+request|merge\s+request|pull|PR|MR)\s*)?[:=]?\s*[#!]?\d+\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*(?:pull\s+request|merge\s+request|pull|PR|MR)\s*[:=]\s*[#!]?\d+\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*(?:pull\s+request|merge\s+request|pull|PR|MR)\s+[#!]?\d+\s*(?:[-:\u2013\u2014]\s*)?/i, "")
    .replace(/^\s*(?:(?:PR|MR)\s*[#!]?\d+|[#!]\d+)\s*(?:[-:\u2013\u2014]\s*)/i, "")
    .replace(/^\s*(?:(?:PR|MR)\s*[#!]?\d+|[#!]\d+)\s+/i, "")
    .replace(/^\s*\[[ xX]\]\s*/i, "")
    .trim());
  return stripCodeMarkup(withoutScopePrefix);
}

export function looksLikeQueueValidationCommand(command: string): boolean {
  return /^(?:\d+\s+)?(?:npm|pnpm|yarn|bun|npx|node|deno|make|just|go|cargo|pytest|python3?|ruby|bundle|gradle|mvn|bazel|docker|kubectl|helm)\b/i.test(cleanQueueValidationCommandPrefix(command));
}

export function normalizeQueueValidationEvidenceCommand(command: unknown): string {
  const normalized = cleanQueueValidationCommandPrefix(toStr(command)).trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function extractCheckboxValidationCommand(line: string): string | null {
  const cleanedLine = cleanQueueValidationCommandPrefix(stripMarkdownListMarker(line));
  const checkboxCommand = cleanedLine.match(/^\s*\[[ xX]\]\s*(.+)$/i)?.[1]?.trim() ?? cleanedLine;
  if (!checkboxCommand || !looksLikeQueueValidationCommand(checkboxCommand)) return null;
  return cleanQueueValidationCommandPrefix(checkboxCommand).slice(0, 240);
}

function extractStatusFirstValidationCommand(line: string): string | null {
  const cleanedLine = stripMarkdownListMarker(line);
  const match = new RegExp(`^\\s*(?:\\[[ xX]\\]\\s*)?(${STATUS_PREFIX_PATTERN})\\s*(?:[-:\\u2013\\u2014]\\s*)?(.+)$`, "iu").exec(cleanedLine);
  const statusPrefix = match?.[1] ?? "";
  const remainder = match?.[2]?.trim() ?? "";
  if (!normalizeValidationStatus(statusPrefix) || !remainder) return null;
  const command = cleanQueueValidationCommandPrefix(remainder);
  if (!looksLikeQueueValidationCommand(command)) return null;
  return command.slice(0, 240);
}

function extractValidationCommand(line: string): string | null {
  const cleanedLine = stripMarkdownListMarker(line);
  const targetStatusCommand = targetStatusParts(cleanedLine)?.command;
  if (targetStatusCommand) {
    const command = cleanQueueValidationCommandPrefix(targetStatusCommand);
    if (looksLikeQueueValidationCommand(command)) return command.slice(0, 240);
  }
  const codeScope = codeSpannedScopeMatch(cleanedLine);
  const htmlCodeScope = htmlCodeSpannedScopeMatch(cleanedLine);
  const scopedCodeEnd = Math.max(codeScope?.endIndex ?? -1, htmlCodeScope?.endIndex ?? -1);
  const backtickCommand = [...cleanedLine.matchAll(/`([^`]+)`/g)]
    .find((match) => scopedCodeEnd < 0 || (match.index ?? 0) >= scopedCodeEnd)?.[1]
    ?.trim();
  if (backtickCommand && looksLikeQueueValidationCommand(backtickCommand)) return backtickCommand;

  const htmlCodeCommand = [...cleanedLine.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
    .find((match) => scopedCodeEnd < 0 || (match.index ?? 0) >= scopedCodeEnd)?.[1]
    ?.trim();
  if (htmlCodeCommand && looksLikeQueueValidationCommand(stripCodeMarkup(htmlCodeCommand))) {
    return stripCodeMarkup(htmlCodeCommand);
  }

  const tableCommand = extractTableValidationCommand(cleanedLine);
  if (tableCommand) return tableCommand;

  const statusFirstCommand = extractStatusFirstValidationCommand(cleanedLine);
  if (statusFirstCommand) return statusFirstCommand;

  const commandBeforeStatus = cleanedLine.match(
    /^\s*(?:\[[ xX]\]\s*)?(.+?)\s*(?:->|=>|:)\s*(?:\b(?:passed|pass|success|succeeded|ok|failed|fail|failure|error|errored|startup[_ -]?failure|timed[_ -]?out|timeout|blocked|blocking|pending|waiting|running|in[_ -]?progress|queued|skipped|skip|unknown|inconclusive|manual|action[_ -]?required|cancelled|canceled|neutral|stale|expired)\b|[✅✓✔❌✗✖⛔🚫🚧⏳⌛❓])/iu,
  )?.[1]?.trim();
  if (!commandBeforeStatus) return extractCheckboxValidationCommand(cleanedLine);
  const command = cleanQueueValidationCommandPrefix(commandBeforeStatus);
  return looksLikeQueueValidationCommand(command) ? command.slice(0, 240) : null;
}

export function extractQueueValidationEvidence(comments: unknown[]): QueueValidationEvidence[] {
  const evidence: QueueValidationEvidence[] = [];
  for (const commentRaw of comments) {
    const body = commentBody(commentRaw);
    if (isReviewGateCacheBody(body)) continue;
    const url = commentEvidenceRef(commentRaw, "github:pr-comment");
    let tableHeader: ValidationTableHeader | null = null;
    let sectionScope: string | null = null;
    for (const event of commentVisibilityEvents(body)) {
      if (!event.visible) {
        tableHeader = null;
        continue;
      }
      const line = event.line;

      const cells = parseTableCells(line);
      if (cells) {
        if (isTableSeparator(cells)) continue;
        const header = validationTableHeader(cells);
        if (header) {
          tableHeader = header;
          continue;
        }
        if (tableHeader) {
          const tableEvidence = extractHeaderTableValidationEvidence(cells, tableHeader, line, url, sectionScope);
          if (tableEvidence) {
            evidence.push(tableEvidence);
            continue;
          }
        }
      } else {
        tableHeader = null;
      }

      const headerlessValidation = cells ? headerlessTableValidation(cells) : null;
      const inlineFields = cells ? inlineValidationFieldsFromCells(cells) : inlineValidationFields(line);
      const namedSummary = cells ? null : namedValidationSummaryFromLine(line);
      const command = headerlessValidation?.command ?? inlineFields?.command ?? namedSummary?.command ?? extractValidationCommand(line);
      const statusRaw = headerlessValidation?.status ?? inlineFields?.status ?? namedSummary?.status ?? normalizeValidationLineStatus(line);
      if (!command || !statusRaw) {
        const sectionScopeMatch = sectionValidationScopeMatch(line);
        if (sectionScopeMatch.matched) sectionScope = sectionScopeMatch.scope;
        continue;
      }
      const lineScope = explicitValidationScopeMatch(line);
      const hasExplicitScope = headerlessValidation?.scopeMatched === true || inlineFields?.scopeMatched === true || lineScope.matched;
      evidence.push({
        command,
        status: statusRaw,
        scope: hasExplicitScope ? (headerlessValidation?.scope ?? inlineFields?.scope ?? lineScope.scope) : sectionScope,
        evidence_ref: url,
      });
    }
  }
  return evidence;
}

function normalizedValidationCommandIdentity(command: string): string {
  const normalized = normalizeQueueValidationEvidenceCommand(command).trim().replace(/\s+/g, " ");
  if (looksLikeQueueValidationCommand(normalized)) return normalized;
  let narrative = normalized
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9#@.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let index = 0; index < 4; index++) {
    const previous = narrative;
    narrative = narrative
      .replace(/\s+\b(?:validation|validations|evidence|result|results|checks?|tests?|suites?|scenarios?|flows?|workflows?|prompts?|runs?|gates?|final|proposed|property|properties|rename)\b$/i, "")
      .trim();
    if (narrative === previous) break;
  }
  return NARRATIVE_VALIDATION_IDENTITY_ALIASES.get(narrative) ?? (narrative || normalized);
}

function normalizedValidationScopeIdentity(scope: string | null | undefined): string {
  const normalized = normalizeQueueValidationEvidenceScope(scope);
  return normalized ?? "";
}

function isQueueWideComprehensiveValidationPass(entry: QueueValidationEvidenceEntry): boolean {
  if (normalizeQueueValidationEvidenceStatus(entry.evidence.status) !== "passed") return false;
  if (normalizedValidationScopeIdentity(entry.evidence.scope) !== "") return false;
  const command = normalizeQueueValidationEvidenceCommand(entry.evidence.command).toLowerCase();
  const identity = normalizedValidationCommandIdentity(entry.evidence.command);
  const searchable = `${identity} ${command}`;
  return /\b(?:full|complete|final|required|rc\d+)\b/i.test(searchable) &&
    /\b(?:suite|validation|check|checks|test|tests|deterministic|regression|ci)\b/i.test(searchable);
}

function isQueueWideValidation(entry: QueueValidationEvidenceEntry): boolean {
  return normalizedValidationScopeIdentity(entry.evidence.scope) === "";
}

export function queueValidationEvidenceIdentityKey(
  scope: string | null | undefined,
  command: string,
): string {
  return `${normalizedValidationScopeIdentity(scope)}\u0000${normalizedValidationCommandIdentity(command)}`;
}

export interface QueueValidationEvidenceEntry {
  evidence: QueueValidationEvidence;
  index: number;
}

export interface QueueValidationEvidencePartition {
  active: QueueValidationEvidenceEntry[];
  superseded: QueueValidationEvidenceEntry[];
}

function normalizeQueueValidationEvidence(evidence: QueueValidationEvidence): QueueValidationEvidence {
  return normalizeQueueValidationEvidenceItems([evidence])[0] ?? {
    command: "",
    status: "unknown",
    scope: null,
    evidence_ref: null,
  };
}

export function partitionQueueValidationEvidence(
  validationEvidence: QueueValidationEvidence[],
): QueueValidationEvidencePartition {
  const entries = validationEvidence.map((evidence, index) => ({
    evidence: normalizeQueueValidationEvidence(evidence),
    index,
  }));
  const latestByKey = new Map<string, QueueValidationEvidenceEntry>();
  entries.forEach(({ evidence: normalizedEvidence, index }) => {
    latestByKey.set(queueValidationEvidenceIdentityKey(normalizedEvidence.scope, normalizedEvidence.command), {
      evidence: normalizedEvidence,
      index,
    });
  });
  const activeIndexes = new Set([...latestByKey.values()].map((entry) => entry.index));
  const comprehensivePassIndexes = [...latestByKey.values()]
    .filter((entry) => activeIndexes.has(entry.index) && isQueueWideComprehensiveValidationPass(entry))
    .map((entry) => entry.index);
  for (const entry of latestByKey.values()) {
    if (
      activeIndexes.has(entry.index) &&
      isQueueWideValidation(entry) &&
      comprehensivePassIndexes.some((index) => index > entry.index)
    ) {
      activeIndexes.delete(entry.index);
    }
  }
  return {
    active: entries
      .filter((entry) => activeIndexes.has(entry.index))
      .sort((a, b) => a.index - b.index),
    superseded: entries
      .filter((entry) => !activeIndexes.has(entry.index)),
  };
}

export function prioritizedQueueValidationEvidence(
  entries: QueueValidationEvidenceEntry[],
): QueueValidationEvidenceEntry[] {
  return [...entries].sort((a, b) => {
    const statusRank = queueValidationStatusRank(a.evidence.status) -
      queueValidationStatusRank(b.evidence.status);
    if (statusRank !== 0) return statusRank;
    if (queueValidationStatusRank(a.evidence.status) === 2) {
      const comprehensiveRank = Number(isQueueWideComprehensiveValidationPass(b)) -
        Number(isQueueWideComprehensiveValidationPass(a));
      if (comprehensiveRank !== 0) return comprehensiveRank;
    }
    return a.index - b.index;
  });
}

export function activeQueueValidationEvidence(
  validationEvidence: QueueValidationEvidence[],
): QueueValidationEvidence[] {
  return partitionQueueValidationEvidence(validationEvidence).active.map((entry) => entry.evidence);
}

function prNumberFromValidationScope(scope: string | null): number | null {
  const normalized = normalizeQueueValidationEvidenceScope(scope);
  const match = normalized?.match(/^#(\d+)$/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function validationEvidenceByPrNumber(
  validationEvidence: QueueValidationEvidence[],
): Map<number, QueueValidationEvidence[]> {
  const byPr = new Map<number, QueueValidationEvidence[]>();
  for (const evidence of validationEvidence) {
    const prNumber = prNumberFromValidationScope(evidence.scope);
    if (!prNumber) continue;
    byPr.set(prNumber, [...(byPr.get(prNumber) ?? []), evidence]);
  }
  return byPr;
}
