/** Deterministic remediation autonomy policy for PR work. */

import YAML from "yaml";

export type RemediationMode =
  | "observe-only"
  | "validate-only"
  | "mechanical-fixes"
  | "bounded-fixes"
  | "maintainer-approved";

export type RemediationModeSource =
  | "pr-label"
  | "work-item"
  | "repository-default"
  | "safe-fallback";

export interface RemediationBudget {
  mutating_allowed: boolean;
  max_fix_attempts: number;
  max_files_changed: number;
  max_changed_lines: number;
  max_duration_minutes: number;
  max_input_tokens: number;
}

export interface RemediationPolicyDecision {
  requested_mode: RemediationMode;
  requested_source: RemediationModeSource;
  repository_mode: RemediationMode;
  risk_ceiling: RemediationMode;
  global_ceiling: RemediationMode;
  effective_mode: RemediationMode;
  active_labels: string[];
  blocked: boolean;
  downgraded: boolean;
  reasons: string[];
  budget: RemediationBudget;
}

export interface ResolveRemediationPolicyOptions {
  labels?: unknown[];
  work_item_mode?: unknown;
  repository_mode?: unknown;
  risk_ceiling?: unknown;
  global_ceiling?: unknown;
  maintainer_approval_verified?: boolean;
}

export interface RemediationLabelDefinition {
  name: string;
  color: string;
  description: string;
}

const MODE_ORDER: RemediationMode[] = [
  "observe-only",
  "validate-only",
  "mechanical-fixes",
  "bounded-fixes",
  "maintainer-approved",
];

export const REMEDIATION_MODE_LABELS: Record<RemediationMode, RemediationLabelDefinition> = {
  "observe-only": {
    name: "remediation:observe-only",
    color: "6E7781",
    description: "Gather evidence only; do not run mutating remediation",
  },
  "validate-only": {
    name: "remediation:validate-only",
    color: "0E8A16",
    description: "Run validation and report fixes without changing the branch",
  },
  "mechanical-fixes": {
    name: "remediation:mechanical-fixes",
    color: "FBCA04",
    description: "Allow bounded generated, formatting, and mechanical fixes",
  },
  "bounded-fixes": {
    name: "remediation:bounded-fixes",
    color: "1D76DB",
    description: "Allow fixes that preserve the PR's retained scope",
  },
  "maintainer-approved": {
    name: "remediation:maintainer-approved",
    color: "5319E7",
    description: "Allow broader remediation after verified maintainer approval",
  },
};

const MODE_BUDGETS: Record<RemediationMode, RemediationBudget> = {
  "observe-only": {
    mutating_allowed: false,
    max_fix_attempts: 0,
    max_files_changed: 0,
    max_changed_lines: 0,
    max_duration_minutes: 10,
    max_input_tokens: 8_000,
  },
  "validate-only": {
    mutating_allowed: false,
    max_fix_attempts: 0,
    max_files_changed: 0,
    max_changed_lines: 0,
    max_duration_minutes: 20,
    max_input_tokens: 16_000,
  },
  "mechanical-fixes": {
    mutating_allowed: true,
    max_fix_attempts: 2,
    max_files_changed: 10,
    max_changed_lines: 500,
    max_duration_minutes: 30,
    max_input_tokens: 32_000,
  },
  "bounded-fixes": {
    mutating_allowed: true,
    max_fix_attempts: 3,
    max_files_changed: 25,
    max_changed_lines: 1_500,
    max_duration_minutes: 60,
    max_input_tokens: 64_000,
  },
  "maintainer-approved": {
    mutating_allowed: true,
    max_fix_attempts: 5,
    max_files_changed: 50,
    max_changed_lines: 5_000,
    max_duration_minutes: 120,
    max_input_tokens: 128_000,
  },
};

function normalizedToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s_]+/g, "-")
    : "";
}

export function normalizeRemediationMode(value: unknown): RemediationMode | null {
  const token = normalizedToken(value);
  const aliases: Record<string, RemediationMode> = {
    observe: "observe-only",
    "observe-only": "observe-only",
    validate: "validate-only",
    "validate-only": "validate-only",
    mechanical: "mechanical-fixes",
    "mechanical-fixes": "mechanical-fixes",
    bounded: "bounded-fixes",
    "bounded-fixes": "bounded-fixes",
    "maintainer-approved": "maintainer-approved",
  };
  return aliases[token] ?? null;
}

export function remediationModeLabel(mode: RemediationMode): RemediationLabelDefinition {
  return REMEDIATION_MODE_LABELS[mode];
}

export function remediationModeLabelNames(): string[] {
  return MODE_ORDER.map((mode) => remediationModeLabel(mode).name);
}

export function remediationModeFromLabel(value: unknown): RemediationMode | null {
  const label = normalizedToken(value);
  for (const mode of MODE_ORDER) {
    if (label === remediationModeLabel(mode).name) return mode;
  }
  return null;
}

function modeRank(mode: RemediationMode): number {
  return MODE_ORDER.indexOf(mode);
}

function minimumMode(modes: RemediationMode[]): RemediationMode {
  return modes.reduce((minimum, mode) => modeRank(mode) < modeRank(minimum) ? mode : minimum);
}

function modeOrFallback(value: unknown, fallback: RemediationMode): RemediationMode {
  return normalizeRemediationMode(value) ?? fallback;
}

export function remediationBudget(mode: RemediationMode): RemediationBudget {
  return { ...MODE_BUDGETS[mode] };
}

export function remediationModeAllowsMutation(mode: unknown): boolean {
  const normalized = normalizeRemediationMode(mode);
  return normalized === null ? false : MODE_BUDGETS[normalized].mutating_allowed;
}

export function repositoryRemediationModeFromPolicy(policyText: string): RemediationMode | null {
  const trimmed = policyText.trim();
  if (!trimmed) return null;
  const fenced = /```ya?ml\s*\n([\s\S]*?)\n```/i.exec(trimmed)?.[1] ?? trimmed;
  try {
    const parsed = YAML.parse(fenced) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const remediation = (parsed as Record<string, unknown>)["remediation"];
    if (typeof remediation !== "object" || remediation === null || Array.isArray(remediation)) return null;
    const record = remediation as Record<string, unknown>;
    return normalizeRemediationMode(record["mode"] ?? record["threshold"]);
  } catch {
    return null;
  }
}

export function resolveRemediationPolicy(
  options: ResolveRemediationPolicyOptions = {},
): RemediationPolicyDecision {
  const repositoryMode = modeOrFallback(options.repository_mode, "bounded-fixes");
  const riskCeiling = modeOrFallback(options.risk_ceiling, "maintainer-approved");
  const globalCeiling = modeOrFallback(options.global_ceiling, "maintainer-approved");
  const labelEntries = (options.labels ?? [])
    .map((label) => ({ raw: typeof label === "string" ? label.trim() : "", mode: remediationModeFromLabel(label) }))
    .filter((entry): entry is { raw: string; mode: RemediationMode } => entry.raw.length > 0 && entry.mode !== null);
  const uniqueLabelModes = [...new Set(labelEntries.map((entry) => entry.mode))];
  const reasons: string[] = [];
  let blocked = false;

  let requestedMode: RemediationMode;
  let requestedSource: RemediationModeSource;
  if (uniqueLabelModes.length > 1) {
    requestedMode = "observe-only";
    requestedSource = "pr-label";
    blocked = true;
    reasons.push(`Conflicting remediation labels: ${labelEntries.map((entry) => entry.raw).join(", ")}.`);
  } else if (uniqueLabelModes[0]) {
    requestedMode = uniqueLabelModes[0];
    requestedSource = "pr-label";
  } else {
    const workItemMode = normalizeRemediationMode(options.work_item_mode);
    if (workItemMode) {
      requestedMode = workItemMode;
      requestedSource = "work-item";
    } else if (normalizeRemediationMode(options.repository_mode)) {
      requestedMode = repositoryMode;
      requestedSource = "repository-default";
    } else {
      requestedMode = "bounded-fixes";
      requestedSource = "safe-fallback";
      reasons.push("Repository remediation mode was missing or invalid; bounded-fixes fallback applied.");
    }
  }

  let effectiveMode = minimumMode([requestedMode, repositoryMode, riskCeiling, globalCeiling]);
  if (requestedMode === "maintainer-approved" && options.maintainer_approval_verified !== true) {
    effectiveMode = minimumMode([effectiveMode, "bounded-fixes"]);
    blocked = true;
    reasons.push("Maintainer-approved remediation requires verified label provenance from an authorized maintainer.");
  }
  if (modeRank(effectiveMode) < modeRank(requestedMode)) {
    reasons.push(`Requested ${requestedMode} was reduced to ${effectiveMode} by repository, risk, or global ceilings.`);
  }
  if (reasons.length === 0) reasons.push(`Effective remediation mode is ${effectiveMode}.`);

  return {
    requested_mode: requestedMode,
    requested_source: requestedSource,
    repository_mode: repositoryMode,
    risk_ceiling: riskCeiling,
    global_ceiling: globalCeiling,
    effective_mode: effectiveMode,
    active_labels: labelEntries.map((entry) => entry.raw),
    blocked,
    downgraded: modeRank(effectiveMode) < modeRank(requestedMode),
    reasons,
    budget: remediationBudget(effectiveMode),
  };
}

export function remediationPolicySummary(decision: RemediationPolicyDecision): string {
  const budget = decision.budget;
  const permission = budget.mutating_allowed ? "mutation allowed" : "read-only";
  return [
    `Requested ${decision.requested_mode} from ${decision.requested_source}; effective ${decision.effective_mode} (${permission}).`,
    `Budget: ${budget.max_fix_attempts} fix attempts, ${budget.max_files_changed} files, ${budget.max_changed_lines} changed lines, ${budget.max_duration_minutes} minutes, ${budget.max_input_tokens} input tokens.`,
    ...decision.reasons,
  ].join(" ");
}

export function remediationPolicyDecisionFromValue(value: unknown): RemediationPolicyDecision | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const effectiveMode = normalizeRemediationMode(record["effective_mode"]);
  const requestedMode = normalizeRemediationMode(record["requested_mode"]);
  if (!effectiveMode || !requestedMode) return null;
  const resolved = resolveRemediationPolicy({
    work_item_mode: requestedMode,
    repository_mode: record["repository_mode"],
    risk_ceiling: record["risk_ceiling"],
    global_ceiling: record["global_ceiling"],
    maintainer_approval_verified: requestedMode !== "maintainer-approved" || record["blocked"] !== true,
  });
  return {
    ...resolved,
    effective_mode: effectiveMode,
    requested_source: record["requested_source"] === "pr-label" ||
      record["requested_source"] === "work-item" ||
      record["requested_source"] === "repository-default" ||
      record["requested_source"] === "safe-fallback"
      ? record["requested_source"]
      : resolved.requested_source,
    active_labels: Array.isArray(record["active_labels"])
      ? record["active_labels"].filter((label): label is string => typeof label === "string")
      : resolved.active_labels,
    blocked: record["blocked"] === true,
    downgraded: record["downgraded"] === true,
    reasons: Array.isArray(record["reasons"])
      ? record["reasons"].filter((reason): reason is string => typeof reason === "string")
      : resolved.reasons,
    budget: typeof record["budget"] === "object" && record["budget"] !== null
      ? record["budget"] as unknown as RemediationBudget
      : remediationBudget(effectiveMode),
  };
}
