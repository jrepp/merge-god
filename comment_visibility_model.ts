/**
 * Pure helpers for deciding which PR comment lines are authoritative text.
 *
 * Queue evidence and manual membership hints both ignore copied logs, hidden
 * metadata, quoted text, and manually crossed-out stale rows.
 */

export interface CommentVisibilityEvent {
  line: string;
  visible: boolean;
}

function isFenceDelimiter(line: string): boolean {
  return /^(?: {0,3})(?:```|~~~)/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isIndentedCodeLine(line: string): boolean {
  if (/^\s*\|/.test(line)) return false;
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) return false;
  return /^(?: {4,}|\t)\S/.test(line);
}

function stripHtmlCommentSegments(line: string, inComment: boolean): { line: string; inComment: boolean } {
  let rest = line;
  let rendered = "";
  let inside = inComment;

  while (rest.length > 0) {
    if (inside) {
      const closeIndex = rest.indexOf("-->");
      if (closeIndex < 0) return { line: rendered, inComment: true };
      rest = rest.slice(closeIndex + 3);
      inside = false;
      continue;
    }

    const openIndex = rest.indexOf("<!--");
    if (openIndex < 0) {
      rendered += rest;
      break;
    }
    rendered += rest.slice(0, openIndex);
    rest = rest.slice(openIndex + 4);
    inside = true;
  }

  return { line: rendered, inComment: inside };
}

function nextHiddenHtmlTag(line: string, startIndex: number): { index: number; endIndex: number; closing: boolean } | null {
  const tagPattern = /<\/?(?:details|pre)\b[^>]*>/gi;
  tagPattern.lastIndex = startIndex;
  const match = tagPattern.exec(line);
  if (!match) return null;
  return {
    index: match.index,
    endIndex: match.index + match[0].length,
    closing: /^<\//.test(match[0]),
  };
}

function stripHiddenHtmlSegments(line: string, depth: number): { line: string; depth: number; touched: boolean } {
  let rendered = "";
  let cursor = 0;
  let hiddenDepth = depth;
  let touched = false;

  while (cursor < line.length) {
    const tag = nextHiddenHtmlTag(line, cursor);
    if (!tag) {
      if (hiddenDepth === 0) rendered += line.slice(cursor);
      break;
    }

    touched = true;
    if (hiddenDepth === 0) rendered += line.slice(cursor, tag.index);
    hiddenDepth = tag.closing ? Math.max(0, hiddenDepth - 1) : hiddenDepth + 1;
    cursor = tag.endIndex;
  }

  return { line: rendered, depth: hiddenDepth, touched };
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

function isStruckThroughText(value: string): boolean {
  const trimmed = value.trim();
  return /^~~.+~~$/.test(trimmed) || /^<(del|s|strike)\b[^>]*>.+<\/\1>$/i.test(trimmed);
}

function isFullyStruckThroughLine(line: string): boolean {
  const cleaned = line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/^\[[ xX]\]\s*/i, "")
    .trim();
  if (isStruckThroughText(cleaned)) return true;
  const cells = parseTableCells(cleaned);
  if (!cells) return false;
  const meaningfulCells = cells.filter((cell) => !/^:?-{3,}:?$/.test(cell));
  return meaningfulCells.length > 0 && meaningfulCells.every(isStruckThroughText);
}

export function commentVisibilityEvents(text: string): CommentVisibilityEvent[] {
  const events: CommentVisibilityEvent[] = [];
  let inFence = false;
  let htmlBlockDepth = 0;
  let inHtmlComment = false;

  for (const rawLine of text.split("\n")) {
    const htmlComment = stripHtmlCommentSegments(rawLine, inHtmlComment);
    inHtmlComment = htmlComment.inComment;
    const hiddenHtml = stripHiddenHtmlSegments(htmlComment.line, htmlBlockDepth);
    htmlBlockDepth = hiddenHtml.depth;
    const line = hiddenHtml.line;
    if (line.trim().length === 0) {
      events.push({ line: hiddenHtml.touched ? rawLine : line, visible: false });
      continue;
    }

    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      events.push({ line, visible: false });
      continue;
    }
    if (inFence || isIndentedCodeLine(line) || isBlockquoteLine(line) || isFullyStruckThroughLine(line)) {
      events.push({ line, visible: false });
      continue;
    }

    events.push({ line, visible: true });
  }

  return events;
}

export function visibleCommentLines(text: string): string[] {
  return commentVisibilityEvents(text)
    .filter((event) => event.visible)
    .map((event) => event.line);
}
