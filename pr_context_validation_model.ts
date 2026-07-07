/**
 * Pure validation for cached PR context at the DB -> agent boundary.
 */

import {
  PR_CONTEXT_COMMENT_KEYS,
  PR_CONTEXT_COMMIT_KEYS,
  PR_CONTEXT_FILE_KEYS,
  PR_CONTEXT_REVIEW_COMMENT_KEYS,
  PR_CONTEXT_STATUS_CHECK_KEYS,
  prContextCiStatus,
  prContextConflicts,
  prContextDiffAvailability,
  prContextHasDiffTextField,
  prContextUrl,
} from "./pr_context_access_model";
import {
  prDetailsAuthorLogin,
  prDetailsBaseBranch,
  prDetailsHeadBranch,
  prDetailsLabels,
  prDetailsNumber,
  prDetailsTitle,
  prDetailsUrl,
} from "./pr_details_access_model";
import { recordShapeItem } from "./collection_access_model";

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function hasOwn(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function hasRecordValue(value: unknown): boolean {
  return recordShapeItem(value) !== null;
}

function hasMalformedCollection(record: Record<string, unknown>, keys: string[]): boolean {
  let hasMalformedValue = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      return false;
    }
    hasMalformedValue = true;
  }
  return hasMalformedValue;
}

function hasCollectionShape(record: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (Array.isArray(value)) return true;
    const collection = typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
    if (Array.isArray(collection["nodes"]) || Array.isArray(collection["edges"])) return true;
  }
  return false;
}

function hasContextUrl(prDetails: Record<string, unknown>, prContext: Record<string, unknown>): boolean {
  return prContextUrl(prContext, prDetailsUrl(prDetails)).trim().length > 0;
}

export function validateAgentReplayPrDetails(value: unknown): string[] {
  const errors: string[] = [];
  const prDetails = recordValue(value);

  if (prDetailsNumber(prDetails) === null) {
    errors.push("Missing required PR detail: positive PR number");
  }
  if (prDetailsTitle(prDetails).trim().length === 0) {
    errors.push("Missing required PR detail: title");
  }
  if (prDetailsHeadBranch(prDetails).trim().length === 0) {
    errors.push("Missing required PR detail: head branch");
  }
  if (prDetailsBaseBranch(prDetails, "").trim().length === 0) {
    errors.push("Missing required PR detail: base branch");
  }
  if (prDetailsAuthorLogin(prDetails, "").trim().length === 0) {
    errors.push("Missing required PR detail: author login");
  }
  if (
    hasMalformedCollection(prDetails, ["labels", "labelNames", "label_names"]) ||
    (hasOwn(prDetails, ["labels", "labelNames", "label_names"]) &&
      prDetailsLabels(prDetails).length === 0 &&
      !hasCollectionShape(prDetails, ["labels", "labelNames", "label_names"]))
  ) {
    errors.push("Malformed PR detail: labels must be strings, label records, or a label connection");
  }

  return errors;
}

export function validateAgentReplayPrContext(
  prDetailsValue: unknown,
  prContextValue: unknown,
): string[] {
  const errors: string[] = [];
  const prDetails = recordValue(prDetailsValue);
  const prContext = recordValue(prContextValue);

  if (!hasContextUrl(prDetails, prContext)) {
    errors.push("Missing required PR context: URL");
  }
  if (!prContextHasDiffTextField(prContext) && !hasRecordValue(prContextDiffAvailability(prContext))) {
    errors.push("Missing required PR context: diff or diff availability");
  }
  if (hasMalformedCollection(prContext, PR_CONTEXT_COMMENT_KEYS)) {
    errors.push("Malformed PR context: comments must be records or a comment connection");
  }
  if (hasMalformedCollection(prContext, PR_CONTEXT_REVIEW_COMMENT_KEYS)) {
    errors.push("Malformed PR context: review comments must be records or a review-comment connection");
  }
  if (hasMalformedCollection(prContext, PR_CONTEXT_COMMIT_KEYS)) {
    errors.push("Malformed PR context: commits must be records or a commit connection");
  }
  if (hasMalformedCollection(prContext, PR_CONTEXT_FILE_KEYS)) {
    errors.push("Malformed PR context: changed files must be records or a file connection");
  }
  if (hasMalformedCollection(prContext, PR_CONTEXT_STATUS_CHECK_KEYS)) {
    errors.push("Malformed PR context: CI status checks must be records or a status-check connection");
  }
  if (!hasRecordValue(prContextConflicts(prContext))) {
    errors.push("Missing required PR context: conflicts");
  }
  if (!hasRecordValue(prContextCiStatus(prContext))) {
    errors.push("Missing required PR context: CI status");
  }
  if (!hasOwn(prContext, ["guidelines"])) {
    errors.push("Missing required PR context: guidelines");
  }
  if (!hasOwn(prContext, ["commit_examples"])) {
    errors.push("Missing required PR context: commit examples");
  }

  return errors;
}

export function validateAgentReplayContext(
  prDetails: unknown,
  prContext: unknown,
): string[] {
  return [
    ...validateAgentReplayPrDetails(prDetails),
    ...validateAgentReplayPrContext(prDetails, prContext),
  ];
}
