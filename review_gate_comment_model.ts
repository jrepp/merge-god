/**
 * Pure review-gate cache comment planning.
 *
 * This module decides which existing PR comment can be updated and builds the
 * GitHub CLI request arguments. It does not fetch comments, render bodies, or
 * execute commands.
 */

import { recordShapeItem } from "./collection_access_model";
import { commentBody } from "./comment_access_model";
import { isReviewGateCacheBody } from "./review_gate_cache";

export type ReviewGateCommentMode = "create" | "edit";

export interface ReviewGateCommentCommandPlan {
  mode: ReviewGateCommentMode;
  existing_comment_id: number | null;
  args: string[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return recordShapeItem(value) ?? {};
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function firstNonEmptyText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = toStr(record[key]).trim();
    if (value.length > 0) return value;
  }
  return "";
}

export function reviewGateCommentId(value: unknown): number | null {
  const comment = recordValue(value);
  for (const key of ["id", "database_id", "databaseId", "comment_id", "commentId"]) {
    const value = comment[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

export function reviewGateCommentAuthorLogin(value: unknown): string {
  const comment = recordValue(value);
  const direct = firstNonEmptyText(comment, ["author_login", "authorLogin", "user_login", "userLogin", "login"]);
  if (direct.length > 0) return direct;

  for (const key of ["user", "author", "actor"]) {
    const nested = recordValue(comment[key]);
    const login = firstNonEmptyText(nested, ["login", "name", "username"]);
    if (login.length > 0) return login;
  }
  return "";
}

export function isReviewGateCacheComment(value: unknown): boolean {
  return isReviewGateCacheBody(commentBody(value));
}

export function findOwnedReviewGateCacheCommentId(comments: unknown[], ownerLogin: string | null = null): number | null {
  const normalizedOwner = (ownerLogin ?? "").trim();
  for (const comment of comments) {
    if (!isReviewGateCacheComment(comment)) continue;
    if (normalizedOwner.length > 0 && reviewGateCommentAuthorLogin(comment) !== normalizedOwner) continue;
    const id = reviewGateCommentId(comment);
    if (id !== null) return id;
  }
  return null;
}

export function planReviewGateCommentCommand(
  prNumber: number,
  body: string,
  existingCommentId: number | null,
): ReviewGateCommentCommandPlan {
  if (existingCommentId === null) {
    return {
      mode: "create",
      existing_comment_id: null,
      args: ["gh", "api", `repos/{owner}/{repo}/issues/${prNumber}/comments`, "-f", `body=${body}`],
    };
  }

  return {
    mode: "edit",
    existing_comment_id: existingCommentId,
    args: [
      "gh",
      "api",
      "-X",
      "PATCH",
      `repos/{owner}/{repo}/issues/comments/${existingCommentId}`,
      "-f",
      `body=${body}`,
    ],
  };
}
