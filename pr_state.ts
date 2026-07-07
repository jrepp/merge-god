/**
 * Pure PR processing-state label policy.
 *
 * Side-effectful callers create, add, and remove labels. This module only owns
 * the stable state vocabulary and deterministic label selection rules.
 */

export type PrProcessingState = "ready" | "processing" | "embarked" | "blocked" | "failed" | "complete";

export interface PrStateLabelDefinition {
  name: string;
  color: string;
  description: string;
}

export const PR_STATE_LABELS: Record<PrProcessingState, PrStateLabelDefinition> = {
  ready: {
    name: "merge:ready",
    color: "0E8A16",
    description: "merge-god may process or embark this PR",
  },
  processing: {
    name: "merge:processing",
    color: "1D76DB",
    description: "merge-god is actively processing this PR",
  },
  embarked: {
    name: "merge:embarked",
    color: "5319E7",
    description: "merge-god included this PR in an embark cohort",
  },
  blocked: {
    name: "merge:blocked",
    color: "D93F0B",
    description: "merge-god is blocked and needs human input or external state",
  },
  failed: {
    name: "merge:failed",
    color: "B60205",
    description: "merge-god processing failed",
  },
  complete: {
    name: "merge:complete",
    color: "0E8A16",
    description: "merge-god completed processing for this PR",
  },
};

export const ACTIVE_PR_PROCESSING_STATES: PrProcessingState[] = [
  "processing",
  "embarked",
  "blocked",
  "failed",
  "complete",
];

function normalizedLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function prStateLabel(state: PrProcessingState): PrStateLabelDefinition {
  return PR_STATE_LABELS[state];
}

export function prStateLabelNames(states: PrProcessingState[] = Object.keys(PR_STATE_LABELS) as PrProcessingState[]): string[] {
  return states.map((state) => prStateLabel(state).name);
}

export function isPrStateLabel(value: unknown): boolean {
  const label = normalizedLabel(value);
  return prStateLabelNames().includes(label);
}

export function activePrStateLabel(labels: unknown[]): string | null {
  const activeLabels = prStateLabelNames(ACTIVE_PR_PROCESSING_STATES);
  for (const labelRaw of labels) {
    const label = normalizedLabel(labelRaw);
    if (activeLabels.includes(label)) return label;
  }
  return null;
}

export function stalePrStateLabelNames(targetState: PrProcessingState): string[] {
  const targetLabel = prStateLabel(targetState).name;
  return prStateLabelNames().filter((label) => label !== targetLabel);
}

export interface PrAgentStateDecisionLike {
  success?: boolean;
  failure_state?: "blocked" | "failed" | null;
}

export function prStateFromAgentDecision(decision: PrAgentStateDecisionLike): PrProcessingState {
  if (decision.success) return "complete";
  return decision.failure_state ?? "failed";
}
