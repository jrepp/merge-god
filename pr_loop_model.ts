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
