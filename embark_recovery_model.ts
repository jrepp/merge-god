/** Pure planning policy for recovering a failed embark cohort. */

import type { EmbarkMergeFailureEvidence } from "./trajectory";

export interface EmbarkRecoveryMember {
  pr_number: number;
  priority: number;
}

export interface EmbarkRecoveryPlanInput {
  members: EmbarkRecoveryMember[];
  validated_pr_numbers?: number[];
  failure: EmbarkMergeFailureEvidence;
}

export interface EmbarkRecoveryPlan {
  strategy: "split-and-replan" | "replan-failed-member";
  validated_pr_numbers: number[];
  failed_pr_number: number;
  deferred_pr_numbers: number[];
  conflict_files: string[];
  evidence_refs: string[];
  summary: string;
  disposition: string | null;
}

function uniquePositiveIntegers(values: number[], field: string): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${field} must contain positive integers`);
    }
    unique.add(value);
  }
  return [...unique];
}

function uniqueNonBlank(values: string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique];
}

export function planEmbarkRecovery(input: EmbarkRecoveryPlanInput): EmbarkRecoveryPlan {
  const orderedMembers = [...input.members]
    .map((member) => {
      if (!Number.isInteger(member.pr_number) || member.pr_number <= 0) {
        throw new TypeError("members must have positive PR numbers");
      }
      return member;
    })
    .sort((a, b) => a.priority - b.priority || a.pr_number - b.pr_number);
  const memberNumbers = new Set(orderedMembers.map((member) => member.pr_number));
  if (memberNumbers.size !== orderedMembers.length) {
    throw new TypeError("members must have unique PR numbers");
  }

  const failedPrNumber = input.failure.pr_number;
  if (!memberNumbers.has(failedPrNumber)) {
    throw new TypeError(`failed PR #${failedPrNumber} is not in the cohort`);
  }
  const summary = input.failure.summary.trim();
  if (!summary) throw new TypeError("merge failure summary is required");

  const conflictFiles = uniqueNonBlank(input.failure.conflict_files);
  const evidenceRefs = uniqueNonBlank(input.failure.evidence_refs);
  if (conflictFiles.length === 0 && evidenceRefs.length === 0) {
    throw new TypeError("merge failure requires conflict files or evidence refs");
  }

  const requestedValidated = new Set(
    uniquePositiveIntegers(input.validated_pr_numbers ?? [], "validated_pr_numbers"),
  );
  if (requestedValidated.has(failedPrNumber)) {
    throw new TypeError("failed PR cannot also be validated");
  }
  for (const number of requestedValidated) {
    if (!memberNumbers.has(number)) {
      throw new TypeError(`validated PR #${number} is not in the cohort`);
    }
  }
  const failedPriority = orderedMembers.find(
    (member) => member.pr_number === failedPrNumber,
  )!.priority;
  for (const member of orderedMembers) {
    if (requestedValidated.has(member.pr_number) && member.priority >= failedPriority) {
      throw new TypeError("validated PRs must precede the failed PR in cohort order");
    }
  }

  const validatedPrNumbers = orderedMembers
    .filter((member) => requestedValidated.has(member.pr_number))
    .map((member) => member.pr_number);
  const deferredPrNumbers = orderedMembers
    .filter(
      (member) =>
        member.pr_number !== failedPrNumber && !requestedValidated.has(member.pr_number),
    )
    .map((member) => member.pr_number);

  return {
    strategy: validatedPrNumbers.length > 0 ? "split-and-replan" : "replan-failed-member",
    validated_pr_numbers: validatedPrNumbers,
    failed_pr_number: failedPrNumber,
    deferred_pr_numbers: deferredPrNumbers,
    conflict_files: conflictFiles,
    evidence_refs: evidenceRefs,
    summary,
    disposition: input.failure.disposition?.trim() || null,
  };
}
