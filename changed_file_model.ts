/**
 * Pure changed-file access helpers.
 *
 * Forge APIs and cached records use different names for file paths, statuses,
 * and line counts. Prompt rendering should not depend on which adapter produced
 * the file record.
 */

import { recordShapeItem } from "./collection_access_model";

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

function nonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function firstNonNegativeInt(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const parsed = nonNegativeInt(record[key]);
    if (parsed !== null) return parsed;
  }
  return 0;
}

export function changedFilePath(value: unknown, fallback = ""): string {
  const file = recordValue(value);
  return firstNonEmptyText(
    file,
    ["filename", "fileName", "path", "new_path", "newPath", "file_path", "filePath", "name", "old_path", "oldPath"],
    fallback,
  );
}

export function changedFileStatus(value: unknown, fallback = "modified"): string {
  const file = recordValue(value);
  const status = firstNonEmptyText(file, ["status", "state", "change_type", "changeType", "type"], fallback)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (status === "add" || status === "added" || status === "new") return "added";
  if (status === "delete" || status === "deleted" || status === "removed" || status === "remove") return "removed";
  if (status === "rename" || status === "renamed" || status === "moved") return "renamed";
  if (status === "modify" || status === "modified" || status === "changed" || status === "update" || status === "updated") {
    return "modified";
  }
  return status || fallback;
}

export function changedFileAdditions(value: unknown): number {
  const file = recordValue(value);
  return firstNonNegativeInt(file, [
    "additions",
    "additions_count",
    "additionsCount",
    "lines_added",
    "linesAdded",
    "added_lines",
    "addedLines",
  ]);
}

export function changedFileDeletions(value: unknown): number {
  const file = recordValue(value);
  return firstNonNegativeInt(file, [
    "deletions",
    "deletions_count",
    "deletionsCount",
    "lines_deleted",
    "linesDeleted",
    "removed_lines",
    "removedLines",
  ]);
}
