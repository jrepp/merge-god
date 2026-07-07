/**
 * Pure PR loop planning helpers.
 *
 * The long-running loop owns side effects; this module owns deterministic
 * discovery policy such as label categorization and skip reasons.
 */

import {
  prDetailsHeadBranch,
  prDetailsIsDraft,
  prDetailsLabels,
  prDetailsNumber,
  prDetailsTitle,
  prDetailsUrl,
} from "./pr_details_access_model";
import { activePrStateLabel } from "./pr_state";
export {
  PR_STATE_LABELS,
  type PrProcessingState,
} from "./pr_state";

export interface CategorizedPRs {
  "for-review": Record<string, unknown>[];
  "for-landing": Record<string, unknown>[];
  "untagged": Record<string, unknown>[];
}

export type ProcessingMode = "for-review" | "for-landing";

export interface PlannedPr {
  pr: Record<string, unknown>;
  mode: ProcessingMode;
  priority: number;
  stack_dependency_numbers: number[];
  stack_dependent_numbers: number[];
}

export interface StackPlanEntry {
  pr_number: number;
  mode: ProcessingMode | null;
  head_ref: string | null;
  base_ref: string | null;
  depends_on: number[];
  dependents: number[];
}

export interface StackPlanBlockedItem {
  pr_number: number;
  reason: "stack_parent_without_processing_label" | "stack_dependency_cycle";
  depends_on_pr_number?: number;
  depends_on_head_ref?: string;
  cycle_pr_numbers?: number[];
}

export interface StackMergeOrderPlan {
  ordered: PlannedPr[];
  stacks: StackPlanEntry[];
  blocked: StackPlanBlockedItem[];
}

export interface ProcessingLabelSuggestion {
  pr_number: number;
  suggested_label: ProcessingMode;
  reason: string;
  command: string;
}

export interface FilteredPrSummary {
  draft: unknown[];
  wip: unknown[];
  invalid: unknown[];
  state: unknown[];
}

export interface CategorizeOpenPrsResult {
  categorized: CategorizedPRs;
  filtered_prs: FilteredPrSummary;
  events: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

export function categorizedPrNumbers(
  categorized: CategorizedPRs,
  categories: Array<keyof CategorizedPRs> = ["for-landing", "for-review"],
): number[] {
  const numbers = new Set<number>();
  for (const category of categories) {
    for (const pr of categorized[category] ?? []) {
      const number = prDetailsNumber(pr);
      if (number !== null) numbers.add(number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

function plannedModeRank(mode: ProcessingMode): number {
  return mode === "for-review" ? 0 : 1;
}

function orderedProcessablePrs(
  categorized: CategorizedPRs,
): { pr: Record<string, unknown>; mode: ProcessingMode; sourceIndex: number }[] {
  const items: { pr: Record<string, unknown>; mode: ProcessingMode; sourceIndex: number }[] = [];
  let sourceIndex = 0;
  for (const mode of ["for-review", "for-landing"] as const) {
    for (const pr of categorized[mode]) {
      items.push({ pr, mode, sourceIndex });
      sourceIndex++;
    }
  }
  return items;
}

function ensureNumberSet(map: Map<number, Set<number>>, key: number): Set<number> {
  let set = map.get(key);
  if (!set) {
    set = new Set<number>();
    map.set(key, set);
  }
  return set;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

function findDependencyCycle(
  remaining: Set<number>,
  dependencies: Map<number, Set<number>>,
  compareNumbers: (a: number, b: number) => number,
): number[] {
  const visited = new Set<number>();
  const stack: number[] = [];
  const stackIndex = new Map<number, number>();

  const visit = (number: number): number[] | null => {
    visited.add(number);
    stackIndex.set(number, stack.length);
    stack.push(number);

    const dependencyNumbers = [...(dependencies.get(number) ?? [])]
      .filter((dependency) => remaining.has(dependency))
      .sort(compareNumbers);
    for (const dependency of dependencyNumbers) {
      const dependencyStackIndex = stackIndex.get(dependency);
      if (dependencyStackIndex !== undefined) return sortedNumbers(stack.slice(dependencyStackIndex));
      if (!visited.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(number);
    return null;
  };

  for (const number of [...remaining].sort(compareNumbers)) {
    if (visited.has(number)) continue;
    const cycle = visit(number);
    if (cycle) return cycle;
  }
  return sortedNumbers(remaining);
}

export function suggestProcessingLabel(pr: Record<string, unknown>): ProcessingLabelSuggestion | null {
  const prNumber = prDetailsNumber(pr);
  if (prNumber === null) return null;
  const labels = labelNames(pr);
  if (labels.includes("for-review") || labels.includes("for-landing")) return null;
  const title = prDetailsTitle(pr).toLowerCase();
  const suggestedLabel: ProcessingMode =
    labels.some((label) => label.includes("review")) || /\breview\b/.test(title)
      ? "for-review"
      : "for-landing";
  return {
    pr_number: prNumber,
    suggested_label: suggestedLabel,
    reason:
      suggestedLabel === "for-review"
        ? "PR appears review-oriented and has no merge-god processing label."
        : "PR has no merge-god processing label; for-landing is the default landing workflow.",
    command: `gh pr edit ${prNumber} --add-label ${suggestedLabel}`,
  };
}

/**
 * Plan processing order for labeled PRs, honoring stacked-PR branch dependencies.
 *
 * A PR whose base ref is another open PR's head ref depends on that parent PR.
 * Processable parents are ordered before children, even across for-review /
 * for-landing mode buckets. If the parent is untagged, the child stays
 * processable but the plan reports the missing underlying set so operators can
 * create labels/cohorts before relying on the final merge order.
 */
export function planStackedPrMergeOrder(categorized: CategorizedPRs): StackMergeOrderPlan {
  const processable = orderedProcessablePrs(categorized);
  const allOpen = [...processable.map((item) => item.pr), ...categorized.untagged];
  const byHeadRef = new Map<string, Record<string, unknown>>();
  const processableNumber = new Map<number, { pr: Record<string, unknown>; mode: ProcessingMode; sourceIndex: number }>();

  for (const pr of allOpen) {
    const headRef = prDetailsHeadBranch(pr);
    if (headRef && !byHeadRef.has(headRef)) byHeadRef.set(headRef, pr);
  }

  for (const item of processable) {
    const number = prDetailsNumber(item.pr);
    if (number !== null) processableNumber.set(number, item);
  }

  const dependencies = new Map<number, Set<number>>();
  const dependents = new Map<number, Set<number>>();
  const blocked: StackPlanBlockedItem[] = [];

  for (const item of processable) {
    const childNumber = prDetailsNumber(item.pr);
    if (childNumber === null) continue;
    ensureNumberSet(dependencies, childNumber);
    ensureNumberSet(dependents, childNumber);

    const baseRef = typeof item.pr["baseRefName"] === "string" ? item.pr["baseRefName"] : "";
    const parent = baseRef ? byHeadRef.get(baseRef) : undefined;
    const parentNumber = parent ? prDetailsNumber(parent) : null;
    if (!parent || parentNumber === null || parentNumber === childNumber) continue;

    if (processableNumber.has(parentNumber)) {
      ensureNumberSet(dependencies, childNumber).add(parentNumber);
      ensureNumberSet(dependents, parentNumber).add(childNumber);
    } else {
      blocked.push({
        pr_number: childNumber,
        depends_on_pr_number: parentNumber,
        depends_on_head_ref: baseRef,
        reason: "stack_parent_without_processing_label",
      });
    }
  }

  const ordered: PlannedPr[] = [];
  const remaining = new Set(processable.map((item) => prDetailsNumber(item.pr)).filter((n): n is number => n !== null));
  const cycleReportedFor = new Set<number>();
  const itemPriority = (number: number): [number, number, number] => {
    const item = processableNumber.get(number);
    if (!item) return [1, Number.MAX_SAFE_INTEGER, number];
    return [plannedModeRank(item.mode), item.sourceIndex, number];
  };
  const compareNumbers = (a: number, b: number): number => {
    const ap = itemPriority(a);
    const bp = itemPriority(b);
    return ap[0] - bp[0] || ap[1] - bp[1] || ap[2] - bp[2];
  };

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((number) => [...(dependencies.get(number) ?? [])].every((dependency) => !remaining.has(dependency)))
      .sort(compareNumbers);
    const hasCycle = ready.length === 0;
    let next = ready[0] ?? [...remaining].sort(compareNumbers)[0]!;
    if (hasCycle) {
      const cyclePrNumbers = findDependencyCycle(remaining, dependencies, compareNumbers);
      const cycleRepresentative = [...cyclePrNumbers].sort(compareNumbers)[0] ?? next;
      next = cycleRepresentative;
      if (!cycleReportedFor.has(cycleRepresentative)) {
        for (const number of cyclePrNumbers) cycleReportedFor.add(number);
        blocked.push({
          pr_number: cycleRepresentative,
          reason: "stack_dependency_cycle",
          cycle_pr_numbers: cyclePrNumbers,
        });
      }
    }
    remaining.delete(next);
    const item = processableNumber.get(next);
    if (!item) continue;
    ordered.push({
      pr: item.pr,
      mode: item.mode,
      priority: ordered.length,
      stack_dependency_numbers: sortedNumbers(dependencies.get(next) ?? []),
      stack_dependent_numbers: sortedNumbers(dependents.get(next) ?? []),
    });
  }

  const stackedNumbers = new Set<number>();
  for (const [child, parents] of dependencies) {
    if (parents.size === 0) continue;
    stackedNumbers.add(child);
    for (const parent of parents) stackedNumbers.add(parent);
  }
  const orderIndex = new Map(ordered.map((item, index) => [prDetailsNumber(item.pr), index] as const));
  const stacks = [...stackedNumbers]
    .sort((a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER) || compareNumbers(a, b))
    .map((number) => {
      const item = processableNumber.get(number);
      return {
        pr_number: number,
        mode: item?.mode ?? null,
        head_ref: item ? prDetailsHeadBranch(item.pr) : null,
        base_ref: item && typeof item.pr["baseRefName"] === "string" ? item.pr["baseRefName"] : null,
        depends_on: sortedNumbers(dependencies.get(number) ?? []),
        dependents: sortedNumbers(dependents.get(number) ?? []),
      };
    });

  return { ordered, stacks, blocked };
}

function labelNames(pr: Record<string, unknown>): string[] {
  return prDetailsLabels(pr).map((label) => label.toLowerCase());
}

function findWipLabel(labels: string[]): string | null {
  for (const label of labels) {
    for (const wip of ["wip", "work-in-process", "work in process"]) {
      if (label.includes(wip)) return label;
    }
  }
  return null;
}

export function categorizeOpenPrs(allPrs: unknown[]): CategorizeOpenPrsResult {
  const categorized: CategorizedPRs = {
    "for-review": [],
    "for-landing": [],
    "untagged": [],
  };
  const filteredPrs: FilteredPrSummary = {
    draft: [],
    wip: [],
    invalid: [],
    state: [],
  };
  const events: Record<string, unknown>[] = [];

  for (const prRaw of allPrs) {
    if (typeof prRaw !== "object" || prRaw === null) continue;
    const pr = prRaw as Record<string, unknown>;
    const prNumber = prDetailsNumber(pr);
    const prTitle = prDetailsTitle(pr, "Unknown");

    if (prNumber === null || !prDetailsHeadBranch(pr) || !prDetailsUrl(pr)) {
      events.push({ action: "invalid_pr", pr });
      filteredPrs.invalid.push({ number: prNumber, title: prTitle, reason: "missing_fields" });
      continue;
    }

    if (prDetailsIsDraft(pr)) {
      filteredPrs.draft.push({ number: prNumber, title: prTitle });
      events.push({ action: "skip_draft", pr_number: prNumber, title: prTitle });
      continue;
    }

    const labels = labelNames(pr);
    const wipLabel = findWipLabel(labels);
    if (wipLabel) {
      filteredPrs.wip.push({ number: prNumber, title: prTitle, label: wipLabel });
      events.push({
        action: "skip_wip",
        pr_number: prNumber,
        title: prTitle,
        wip_label: wipLabel,
      });
      continue;
    }

    const stateLabel = activePrStateLabel(labels);
    if (stateLabel) {
      filteredPrs.state.push({ number: prNumber, title: prTitle, label: stateLabel });
      events.push({
        action: "skip_state",
        pr_number: prNumber,
        title: prTitle,
        state_label: stateLabel,
      });
      continue;
    }

    if (labels.includes("for-review")) {
      categorized["for-review"].push(pr);
      events.push({
        action: "categorized",
        pr_number: prNumber,
        title: prTitle,
        category: "for-review",
        labels,
      });
    } else if (labels.includes("for-landing")) {
      categorized["for-landing"].push(pr);
      events.push({
        action: "categorized",
        pr_number: prNumber,
        title: prTitle,
        category: "for-landing",
        labels,
      });
    } else {
      categorized.untagged.push(pr);
      events.push({
        action: "categorized",
        pr_number: prNumber,
        title: prTitle,
        category: "untagged",
        labels,
      });
    }
  }

  return {
    categorized,
    filtered_prs: filteredPrs,
    events,
    summary: {
      action: "complete",
      total: allPrs.length,
      for_review: categorized["for-review"].length,
      for_landing: categorized["for-landing"].length,
      untagged: categorized.untagged.length,
      filtered_draft: filteredPrs.draft.length,
      filtered_wip: filteredPrs.wip.length,
      filtered_invalid: filteredPrs.invalid.length,
      filtered_state: filteredPrs.state.length,
      filtered_prs: filteredPrs,
    },
  };
}
