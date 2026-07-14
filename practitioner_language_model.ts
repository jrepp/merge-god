/** Plain-language labels and calls to action for practitioner-facing surfaces. */

export interface PractitionerWorkItemLike {
  number: number;
  status: string;
  next_action?: string | null;
  blockers?: Array<Record<string, unknown>>;
}

export interface PractitionerGateLike {
  rule: string;
  status: string;
  explanation: string;
}

const WORKFLOW_LABELS: Record<string, string> = {
  embark_cohort: "Merge group",
  pr_queue: "PR queue",
  review_batch: "Review group",
  issue_batch: "Issue group",
  salvage_candidate_set: "Recovery group",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  created: "Not started",
  surveying: "Checking PRs",
  planning: "Planning",
  executing: "In progress",
  waiting: "Waiting for a maintainer",
  completed: "Complete",
  blocked: "Action required",
  failed: "Could not continue",
};

const PHASE_LABELS: Record<string, string> = {
  embark_cohort_ready: "Ready for approval",
  embark_validation: "Testing the PRs together",
  embark_replanning: "Choosing a safe next approach",
  embark_operator_handoff: "Waiting for a maintainer decision",
  queue_ready: "Ready to start",
  activity_claimed: "Starting the next step",
  agent_processing: "Agent working",
  blocked: "Blocked",
  completed: "Complete",
};

const ITEM_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  ready: "Ready",
  syncing: "Updating from the base branch",
  conflicted: "Has merge conflicts",
  validating: "Running checks",
  validated: "Checks passed",
  embarked: "In the merge group",
  running: "In progress",
  pushed: "Changes pushed",
  merged: "Merged",
  closed: "Closed",
  skipped: "Skipped",
  blocked: "Action required",
  failed: "Could not continue",
};

const NEXT_ACTION_LABELS: Record<string, string> = {
  validate_cohort: "Test the PRs together",
  replan: "Decide how to resolve the overlap",
  await_replan: "Wait for the blocked PR, then retry",
  operator_handoff: "Maintainer decision needed",
  claim_activity: "Start the next step",
  start_activity: "Continue the current step",
  inspect_failure: "Review the failure and choose a fix",
  request_context_refresh: "Reload the PR details",
  create_child_activity: "Add a focused follow-up step",
  mark_blocked: "Explain what is blocking progress",
  complete: "Finish this run",
};

const ACTIVITY_LABELS: Record<string, string> = {
  merge_gate: "Check whether the PRs can merge",
  embark_planning: "Choose the next safe merge plan",
  review_workflow: "Review the PR",
  conflict_resolution: "Resolve merge conflicts",
  ci_diagnosis: "Find why checks failed",
  ci_fix: "Fix failing checks",
  semantic_summary: "Summarize the result",
  operator_handoff: "Ask a maintainer to decide",
};

function fallbackLabel(value: string): string {
  const words = value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Unknown";
}

export function practitionerWorkflowLabel(value: string): string {
  return WORKFLOW_LABELS[value] ?? fallbackLabel(value);
}

export function practitionerRunStatusLabel(value: string): string {
  return RUN_STATUS_LABELS[value] ?? fallbackLabel(value);
}

export function practitionerPhaseLabel(value: string): string {
  return PHASE_LABELS[value] ?? fallbackLabel(value);
}

export function practitionerItemStatusLabel(value: string): string {
  return ITEM_STATUS_LABELS[value] ?? fallbackLabel(value);
}

export function practitionerNextActionLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return NEXT_ACTION_LABELS[value] ?? fallbackLabel(value);
}

export function practitionerActivityLabel(value: string): string {
  return ACTIVITY_LABELS[value] ?? fallbackLabel(value);
}

function blockerText(blocker: Record<string, unknown>): string {
  const summary = typeof blocker["summary"] === "string" ? blocker["summary"].trim() : "";
  if (summary) return summary;
  const files = Array.isArray(blocker["conflict_files"])
    ? blocker["conflict_files"].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  return files.length > 0 ? `Merge conflict in ${files.join(", ")}.` : "A merge check needs attention.";
}

export function practitionerRunCallToAction(items: PractitionerWorkItemLike[]): string {
  const blocked = items.find((item) => item.status === "blocked" || item.status === "failed");
  if (blocked) {
    const blocker = blocked.blockers?.[0];
    const detail = blocker ? blockerText(blocker) : "This PR could not continue.";
    return `PR #${blocked.number}: ${detail} Decide the intended result, update the PR, and rerun the merge group.`;
  }
  const waiting = items.find((item) => item.next_action === "await_replan");
  if (waiting) return `PR #${waiting.number}: wait for the earlier blocked PR to be updated, then retry the merge group.`;
  const handoff = items.find((item) => item.next_action === "operator_handoff");
  if (handoff) return `PR #${handoff.number}: review the passing result and choose whether to merge it separately.`;
  return "No reviewer action is needed right now.";
}

export function practitionerGateCallToAction(gates: PractitionerGateLike[]): string {
  const gate = gates.find((item) => ["blocked", "fail"].includes(item.status)) ??
    gates.find((item) => ["unknown", "pending"].includes(item.status));
  if (!gate) return "No reviewer action is needed. All reported checks passed.";
  const text = `${gate.rule} ${gate.explanation}`.toLowerCase();
  if (/needs[- ]?redesign|design|intended behavior|unaligned/.test(text)) {
    return "Decide the intended behavior, update the PR to match that decision, and rerun Merge God.";
  }
  if (/conflict|merge state|dirty|behind/.test(text)) {
    return "Resolve the listed merge conflict on the PR branch, push the update, and rerun Merge God.";
  }
  if (/review|approval/.test(text)) {
    return "Get the required review approval, then rerun Merge God.";
  }
  if (/\bci\b|check|test|build|lint/.test(text)) {
    return "Fix or rerun the failing checks until they pass, then rerun Merge God.";
  }
  if (/context|details|diff unavailable/.test(text)) {
    return "Retry Merge God so it can reload the missing PR details.";
  }
  if (gate.status === "pending") {
    return "Wait for the pending check to finish, then rerun Merge God if it passes or fix it if it fails.";
  }
  return "Address the blocked check described below, then rerun Merge God.";
}
