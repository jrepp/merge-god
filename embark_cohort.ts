#!/usr/bin/env node
/** Operator CLI for approving, inspecting, and recovering embark cohorts. */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { AppStore } from "./app_store";
import {
  practitionerActivityLabel,
  practitionerItemStatusLabel,
  practitionerNextActionLabel,
  practitionerPhaseLabel,
  practitionerRunCallToAction,
  practitionerRunStatusLabel,
  practitionerWorkflowLabel,
} from "./practitioner_language_model";
import { TrajectoryRuntime } from "./trajectory_runtime";

function positiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function stateSummary(runtime: TrajectoryRuntime, runId: string): Record<string, unknown> {
  const state = runtime.getRunState(runId);
  if (!state) throw new Error(`run not found: ${runId}`);
  return {
    overview: {
      process: practitionerWorkflowLabel("embark_cohort"),
      status: practitionerRunStatusLabel(state.run.status),
      current_step: practitionerPhaseLabel(state.run.current_phase),
      required_action: practitionerRunCallToAction(state.work_items),
    },
    pull_requests: state.work_items.map((item) => ({
      number: item.number,
      status: practitionerItemStatusLabel(item.status),
      next_step: practitionerNextActionLabel(item.next_action),
    })),
    technical_details: {
      run: {
        run_id: state.run.run_id,
        status: state.run.status,
        current_phase: state.run.current_phase,
      },
      worksets: state.worksets.map((workset) => ({
        workset_id: workset.workset_id,
        kind: workset.kind,
        status: workset.status,
        approval_state: workset.approval_state,
        strategy: workset.strategy,
      })),
      items: state.work_items.map((item) => ({
        number: item.number,
        status: item.status,
        next_action: item.next_action,
        blockers: item.blockers,
      })),
      activities: state.activities.map((activity) => ({
        activity_id: activity.activity_id,
        parent_activity_id: activity.parent_activity_id,
        type: activity.type,
        description: practitionerActivityLabel(activity.type),
        status: activity.status,
        evidence_refs: activity.evidence_refs,
      })),
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      db: { type: "string", default: "merge-god-state.db" },
      run: { type: "string" },
      reason: { type: "string" },
      activity: { type: "string" },
      "failed-pr": { type: "string" },
      "validated-pr": { type: "string", multiple: true, default: [] },
      summary: { type: "string" },
      disposition: { type: "string" },
      "conflict-file": { type: "string", multiple: true, default: [] },
      "evidence-ref": { type: "string", multiple: true, default: [] },
      "repo-path": { type: "string" },
      timeout: { type: "string", default: "3600" },
      model: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const action = parsed.positionals[0];
  if (!action || !["status", "approve", "recover", "run"].includes(action)) {
    throw new Error("usage: embark_cohort.ts <status|approve|recover|run> --run RUN_ID [options]");
  }
  const runId = parsed.values.run;
  if (!runId) throw new Error("--run is required");

  const store = new AppStore(parsed.values.db ?? "merge-god-state.db");
  try {
    const runtime = new TrajectoryRuntime(store);
    if (action === "approve") {
      runtime.approveEmbarkCohort(runId, "operator-cli", parsed.values.reason);
    } else if (action === "recover") {
      const state = runtime.getRunState(runId);
      if (!state) throw new Error(`run not found: ${runId}`);
      const failedPrRaw = parsed.values["failed-pr"];
      if (!failedPrRaw) throw new Error("recover requires --failed-pr");
      const summary = parsed.values.summary?.trim();
      if (!summary) throw new Error("recover requires --summary");
      const failedActivityId = parsed.values.activity ?? [...state.activities]
        .reverse()
        .find((activity) =>
          activity.type === "merge_gate" && ["failed", "blocked"].includes(activity.status)
        )?.activity_id;
      if (!failedActivityId) throw new Error("recover requires --activity when no failed merge gate exists");
      runtime.recoverEmbarkCohort({
        run_id: runId,
        failed_activity_id: failedActivityId,
        validated_pr_numbers: (parsed.values["validated-pr"] ?? []).map((value) =>
          positiveInteger(value, "--validated-pr")
        ),
        failure: {
          pr_number: positiveInteger(failedPrRaw, "--failed-pr"),
          summary,
          disposition: parsed.values.disposition,
          conflict_files: parsed.values["conflict-file"] ?? [],
          evidence_refs: parsed.values["evidence-ref"] ?? [],
        },
        actor: "operator-cli",
      });
    } else if (action === "run") {
      const state = runtime.getRunState(runId);
      if (!state) throw new Error(`run not found: ${runId}`);
      const metadataWorkspace = state.run.metadata["embark_workspace"];
      const repoPath = parsed.values["repo-path"] ??
        (typeof metadataWorkspace === "string" ? metadataWorkspace : state.run.repo_path);
      if (!repoPath) throw new Error("run requires --repo-path when the cohort has no stored workspace");
      const timeout = positiveInteger(parsed.values.timeout ?? "3600", "--timeout");
      const result = await runtime.runNextActivityWithPi(runId, {
        repo_path: repoPath,
        timeout,
        model: parsed.values.model,
      });
      if (!result.claim) throw new Error("cohort has no ready activity to run");
    }
    console.log(JSON.stringify(stateSummary(runtime, runId), null, 2));
    return 0;
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
