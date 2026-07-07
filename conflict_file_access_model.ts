/**
 * Pure access helpers for conflict-file aliases.
 */

import { collectionItems, recordShapeItem } from "./collection_access_model";

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSingleValueArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : [value];
}

export function conflictFileName(value: unknown): string {
  const direct = toStr(value).trim();
  if (direct) return direct;
  const record = recordShapeItem(value);
  if (!record) return "";
  for (const key of ["path", "filename", "file", "name", "newPath", "new_path", "oldPath", "old_path"]) {
    const text = toStr(record[key]).trim();
    if (text) return text;
  }
  return "";
}

export function recordConflictFiles(value: unknown): string[] {
  const record = recordShapeItem(value) ?? {};
  return [
    ...collectionItems(record["conflict_files"]),
    ...collectionItems(record["conflictFiles"]),
    ...collectionItems(record["conflicting_files"]),
    ...collectionItems(record["conflictingFiles"]),
    ...asSingleValueArray(record["conflicting_file"]),
    ...asSingleValueArray(record["conflictingFile"]),
    ...asSingleValueArray(record["conflict_file"]),
    ...asSingleValueArray(record["conflictFile"]),
  ].map(conflictFileName).filter((file) => file.length > 0);
}
