/**
 * Pure cached collection-shape access helpers.
 *
 * Cached forge records may preserve GraphQL connection shapes. Keep that
 * normalization in one small model so PR/queue accessors do not drift.
 */

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function hasRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value as Record<string, unknown>).length > 0;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function collectionShapeItem(value: unknown): unknown | null {
  if (!hasValue(value)) return null;
  const record = asRecord(value);
  if (!hasRecordValue(record)) return value;
  const keys = Object.keys(record);
  const edgeOnly = keys.every((key) => key === "node" || key === "cursor" || key === "__typename");
  if (edgeOnly && Object.prototype.hasOwnProperty.call(record, "node")) {
    const node = record["node"];
    return hasValue(node) ? node : null;
  }
  return value;
}

export function recordShapeItem(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!hasRecordValue(record)) return null;
  const keys = Object.keys(record);
  const edgeOnly = keys.every((key) => key === "node" || key === "cursor" || key === "__typename");
  if (edgeOnly && Object.prototype.hasOwnProperty.call(record, "node")) {
    const node = asRecord(record["node"]);
    return hasRecordValue(node) ? node : null;
  }
  return record;
}

export function collectionItems(value: unknown): unknown[] {
  const direct = asArray(value)
    .map(collectionShapeItem)
    .filter(hasValue);
  if (direct.length > 0) return direct;

  const record = asRecord(value);
  const nodes = asArray(record["nodes"])
    .map(collectionShapeItem)
    .filter(hasValue);
  if (nodes.length > 0) return nodes;

  return asArray(record["edges"])
    .map((edge) => collectionShapeItem(asRecord(edge)["node"]))
    .filter(hasValue);
}

export function recordCollectionItems(value: unknown): Record<string, unknown>[] {
  const direct = asArray(value)
    .map(recordShapeItem)
    .filter((record): record is Record<string, unknown> => record !== null);
  if (direct.length > 0) return direct;

  const record = asRecord(value);
  const nodes = asArray(record["nodes"])
    .map(recordShapeItem)
    .filter((node): node is Record<string, unknown> => node !== null);
  if (nodes.length > 0) return nodes;

  return asArray(record["edges"])
    .map((edge) => recordShapeItem(asRecord(edge)["node"]))
    .filter((node): node is Record<string, unknown> => node !== null);
}

export function firstPresentRecordCollection(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown>[] {
  for (const key of keys) {
    const value = recordCollectionItems(record[key]);
    if (value.length > 0) return value;
  }
  return [];
}

export function firstPresentRecordCollectionBy(
  record: Record<string, unknown>,
  keys: string[],
  predicate: (items: Record<string, unknown>[]) => boolean,
): Record<string, unknown>[] {
  let fallback: Record<string, unknown>[] = [];
  for (const key of keys) {
    const value = firstPresentRecordCollection(record, [key]);
    if (value.length === 0) continue;
    if (fallback.length === 0) fallback = value;
    if (predicate(value)) return value;
  }
  return fallback;
}
