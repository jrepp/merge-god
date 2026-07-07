/**
 * Pure Markdown table rendering helpers.
 *
 * GitHub comments use these helpers for cache rows that may contain arbitrary
 * forge data, command text, paths, or user-facing explanations.
 */

function escapeMarkdownTableCellChar(char: string): string {
  if (char === "&") return "&amp;";
  if (char === "<") return "&lt;";
  if (char === ">") return "&gt;";
  if (char === "|") return "\\|";
  if (char === "`") return "&#96;";
  if (char === "@") return "&#64;";
  return char;
}

export function sanitizeMarkdownTableCell(value: unknown, maxLength: number): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  const raw = typeof value === "string" ? value : String(value ?? "");
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const escapedParts = [...clean].map(escapeMarkdownTableCellChar);
  const fullLength = escapedParts.reduce((sum, part) => sum + part.length, 0);
  if (fullLength <= limit) return escapedParts.join("");
  if (limit <= 3) return "...".slice(0, limit);

  const bodyLimit = limit - 3;
  let rendered = "";
  for (const escaped of escapedParts) {
    if (rendered.length + escaped.length > bodyLimit) {
      break;
    }
    rendered += escaped;
  }
  return `${rendered}...`;
}
