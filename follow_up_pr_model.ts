/**
 * Pure follow-up PR request normalization.
 */

import { prDetailsBaseBranch, prDetailsNumber } from "./pr_details_access_model";

export interface FollowUpWorkItem {
  kind?: string;
  pr_number?: number;
  issue_number?: number;
  base_branch?: string;
  baseRefName?: string;
  [key: string]: unknown;
}

export interface FollowUpPrInput {
  title: string;
  body?: string;
  branch?: string;
  base?: string;
  linked_pr_number?: number;
  commit_message?: string;
  draft?: boolean;
  labels?: string[];
  signal_refs: string[];
  grounding_refs: string[];
  validation_refs?: string[];
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = toText(record[key]);
    if (text) return text;
  }
  return "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((item): item is string => typeof item === "string"))
    : [];
}

export function linkedPrNumber(work: FollowUpWorkItem | null): number | null {
  return typeof work?.pr_number === "number" ? work.pr_number : null;
}

export function followUpBaseBranch(input: FollowUpPrInput, work: FollowUpWorkItem | null): string {
  return input.base?.trim() || prDetailsBaseBranch(work ?? {}, "main");
}

export function defaultFollowUpBranch(title: string, work: FollowUpWorkItem | null): string {
  const prefix = work?.pr_number
    ? `pr-${work.pr_number}`
    : work?.issue_number
      ? `issue-${work.issue_number}`
      : "work";
  return `merge-god/${prefix}-${slugify(title).slice(0, 48) || "follow-up"}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function describeWorkItem(work: FollowUpWorkItem | null): string {
  if (!work) return "a merge-god work item";
  if (work.pr_number) return `PR #${work.pr_number}`;
  if (work.issue_number) return `issue #${work.issue_number}`;
  return work.kind ? `merge-god ${work.kind} work` : "a merge-god work item";
}

export function buildFollowUpPrBody(input: FollowUpPrInput, work: FollowUpWorkItem | null): string {
  const linked = input.linked_pr_number ?? linkedPrNumber(work);
  const lines = [
    input.body?.trim() || `Opened by merge-god from ${describeWorkItem(work)}.`,
    "",
    "## merge-god remediation evidence",
    "",
    linked ? `Linked PR: #${linked}` : "Linked PR: none",
    "",
    "Signal:",
    ...input.signal_refs.map((ref) => `- ${ref}`),
    "",
    "Project grounding:",
    ...input.grounding_refs.map((ref) => `- ${ref}`),
  ];
  if (input.validation_refs && input.validation_refs.length > 0) {
    lines.push("", "Validation:", ...input.validation_refs.map((ref) => `- ${ref}`));
  }
  return lines.join("\n");
}

export function normalizeFollowUpPrInput(body: Record<string, unknown>): FollowUpPrInput {
  const title = toText(body["title"]);
  if (!title) throw new Error("title is required");
  const signalRefs = stringArray(body["signal_refs"]);
  const groundingRefs = stringArray(body["grounding_refs"]);
  const validationRefs = stringArray(body["validation_refs"]);
  if (signalRefs.length === 0) {
    throw new Error("signal_refs is required before opening an automated remediation PR");
  }
  if (groundingRefs.length === 0) {
    throw new Error("grounding_refs is required before opening an automated remediation PR");
  }

  const linkedPrNumberValue = prDetailsNumber({
    number: body["linked_pr_number"] ?? body["linkedPrNumber"] ?? body["pr_number"] ?? body["prNumber"],
  });

  return {
    title,
    body: typeof body["body"] === "string" ? body["body"] : undefined,
    branch: firstText(body, ["branch", "head_branch", "headBranch"]) || undefined,
    base: firstText(body, ["base", "base_branch", "baseBranch", "baseRefName"]) || undefined,
    linked_pr_number: linkedPrNumberValue ?? undefined,
    commit_message: firstText(body, ["commit_message", "commitMessage"]) || undefined,
    draft: typeof body["draft"] === "boolean" ? body["draft"] : undefined,
    labels: stringArray(body["labels"]),
    signal_refs: signalRefs,
    grounding_refs: groundingRefs,
    validation_refs: validationRefs.length > 0 ? validationRefs : undefined,
  };
}
