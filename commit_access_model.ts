/**
 * Pure commit access helpers.
 *
 * Live forge payloads, cached records, and GraphQL edge wrappers expose commit
 * identifiers and messages under different names. Prompt and queue modeling
 * code should depend on this normalized shape instead of raw adapter fields.
 */

import { recordShapeItem } from "./collection_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function commitMessageFromRecord(record: Record<string, unknown>): string {
  const message = firstNonEmptyText(
    record["message"],
    record["commit_message"],
    record["commitMessage"],
    record["full_message"],
    record["fullMessage"],
  );
  if (message) return message;

  const headline = firstNonEmptyText(
    record["messageHeadline"],
    record["message_headline"],
    record["headline"],
    record["subject"],
    record["title"],
  );
  const body = firstNonEmptyText(record["messageBody"], record["message_body"], record["body"]);
  if (headline && body) return `${headline}\n\n${body}`;
  return headline || body;
}

export function commitMessage(value: unknown, fallback = ""): string {
  const commit = recordValue(value);
  const nested = recordValue(commit["commit"]);
  return commitMessageFromRecord(nested) || commitMessageFromRecord(commit) || fallback;
}

export function commitMessageHeadline(value: unknown, fallback = ""): string {
  const message = commitMessage(value);
  return (message.split("\n")[0] ?? "").trim() || fallback;
}

export function commitIdentifier(value: unknown, fallback = ""): string {
  const commit = recordValue(value);
  const nested = recordValue(commit["commit"]);
  return firstNonEmptyText(
    commit["sha"],
    commit["oid"],
    commit["id"],
    nested["sha"],
    nested["oid"],
    nested["id"],
    fallback,
  );
}
