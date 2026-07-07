/**
 * Pure queue membership resolution helpers.
 *
 * This module takes already-parsed queue signals and active validation evidence
 * and decides which PRs are queue constituents. It does not parse comments,
 * inspect commits, or classify validation statuses.
 */

import type {
  QueueConstituentPR,
  QueueValidationEvidence,
} from "@merge-god/github-sync";

import type { ConstituentHint } from "./queue_membership_model";
import {
  orderedConstituentEvidenceRefs,
} from "./queue_membership_model";
import { queueConstituentStatus } from "./queue_blocker_model";
import {
  evidenceRefPrNumber,
  recordEvidenceRefs,
} from "./evidence_ref_access_model";
import { recordShapeItem } from "./collection_access_model";

export interface QueueMembershipInputs {
  titleNumbers: number[];
  mergedPrNumbers: number[];
  hintNumbers: number[];
  validationByPr: ReadonlyMap<number, QueueValidationEvidence[]>;
  explicitTitleIsQueue: boolean;
  mergeCommitCount: number;
}

export interface QueueMembershipResolution {
  declared_numbers: number[];
  validation_numbers: number[];
  all_pr_numbers: number[];
  is_queue: boolean;
}

export interface QueueConstituentBuildInputs {
  allPrNumbers: number[];
  constituentHints: ReadonlyMap<number, ConstituentHint>;
  validationByPr: ReadonlyMap<number, QueueValidationEvidence[]>;
  mergedPrNumbers: number[];
  mergedEvidenceByPr?: ReadonlyMap<number, string[]>;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function validationEvidenceRefs(item: QueueValidationEvidence): string[] {
  return recordEvidenceRefs(recordShapeItem(item) ?? {});
}

export function resolveQueueMembership(inputs: QueueMembershipInputs): QueueMembershipResolution {
  const declaredNumbers = uniqueNumbers([
    ...inputs.titleNumbers,
    ...inputs.mergedPrNumbers,
    ...inputs.hintNumbers,
  ]);
  const validationCanDefineMembership = declaredNumbers.length === 0 &&
    (inputs.explicitTitleIsQueue ||
      inputs.mergeCommitCount > 0);
  const validationNumbers = validationCanDefineMembership
    ? [...inputs.validationByPr.keys()]
    : [...inputs.validationByPr.entries()]
        .filter(([number, evidence]) =>
          evidence.some((item) => validationEvidenceRefs(item).some((ref) => evidenceRefPrNumber(ref) === number)),
        )
        .map(([number]) => number);
  const allPrNumbers = uniqueNumbers([...declaredNumbers, ...validationNumbers]);

  return {
    declared_numbers: declaredNumbers,
    validation_numbers: validationNumbers,
    all_pr_numbers: allPrNumbers,
    is_queue: inputs.explicitTitleIsQueue || allPrNumbers.length > 1 || inputs.mergeCommitCount > 1,
  };
}

export function buildQueueConstituentPrs(inputs: QueueConstituentBuildInputs): QueueConstituentPR[] {
  const mergedSet = new Set(inputs.mergedPrNumbers);
  return inputs.allPrNumbers.map((number) => {
    const hint = inputs.constituentHints.get(number);
    const scopedValidationRefs = (inputs.validationByPr.get(number) ?? [])
      .flatMap(validationEvidenceRefs);
    const mergedEvidenceRefs = inputs.mergedEvidenceByPr?.get(number) ?? [];
    return {
      number,
      title: hint?.title ?? null,
      url: hint?.url ?? null,
      head_sha: hint?.head_sha ?? null,
      status: queueConstituentStatus(number, mergedSet, inputs.validationByPr),
      evidence_refs: orderedConstituentEvidenceRefs(number, [...(hint?.evidence_refs ?? []), ...mergedEvidenceRefs], scopedValidationRefs),
    };
  });
}
