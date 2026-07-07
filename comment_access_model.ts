/**
 * Pure comment access helpers.
 *
 * GitHub API payloads and cached forge-neutral records may use different field
 * names for comment bodies and browser URLs. Queue evidence parsing should not
 * depend on which adapter produced the record.
 */

import { recordShapeItem } from "./collection_access_model";
import { recordEvidenceRefs } from "./evidence_ref_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function firstNonEmptyText(record: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const text = toStr(record[key]).trim();
    if (text.length > 0) return text;
  }
  return fallback;
}

export function commentBody(value: unknown, fallback = ""): string {
  const comment = recordValue(value);
  return firstNonEmptyText(
    comment,
    ["body", "body_text", "bodyText", "text", "content", "description", "message"],
    fallback,
  );
}

function positiveIntText(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!/^\d+$/.test(text)) return "";
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : "";
}

export function commentAuthorLogin(value: unknown, fallback = "unknown"): string {
  const comment = recordValue(value);
  const direct = firstNonEmptyText(
    comment,
    ["author_login", "authorLogin", "user_login", "userLogin", "login", "username", "name"],
  );
  if (direct.length > 0) return direct;

  const user = recordValue(comment["user"]);
  const userLogin = firstNonEmptyText(user, ["login", "username", "name"]);
  if (userLogin.length > 0) return userLogin;

  const author = recordValue(comment["author"]);
  return firstNonEmptyText(author, ["login", "username", "name"], fallback);
}

export function commentPath(value: unknown, fallback = ""): string {
  const comment = recordValue(value);
  return firstNonEmptyText(
    comment,
    ["path", "file_path", "filePath", "filename", "fileName", "new_path", "newPath", "old_path", "oldPath"],
    fallback,
  );
}

export function commentLine(value: unknown, fallback = ""): string {
  const comment = recordValue(value);
  for (const key of ["line", "original_line", "originalLine", "start_line", "startLine", "position"]) {
    const line = positiveIntText(comment[key]);
    if (line.length > 0) return line;
  }
  return fallback;
}

export function commentEvidenceRef(value: unknown, fallback: string | null = null): string | null {
  const comment = recordValue(value);
  return recordEvidenceRefs(comment)[0] ?? fallback;
}
