/**
 * Standalone Agent Runner — run agent invocation from SQLite database only.
 *
 * Ported from run_agent_from_db.py. Demonstrates Process 3 isolation: reads
 * all necessary data from the SQLite database and invokes the agent without
 * needing any GitHub or git operations.
 *
 * Useful for:
 * 1. Testing agent behavior with cached PR data
 * 2. Debugging agent issues without API rate limits
 * 3. Replaying failed agent runs
 * 4. Validating agent prompts and responses
 *
 * Usage:
 *   tsx run_agent_from_db.ts <repo_name> <pr_number> [--mode for-review|for-landing]
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  PRAgent,
  PRProcessingCallbacks,
  createClaudeClient,
  createPRContextFromDict,
  getModelName,
  type AgentDatabase,
  type PRContext,
} from "./agents/__init__";
import { SyncStore } from "@merge-god/github-sync";
import { AppStore } from "./app_store";
import { runPiAgent, type WorkItem } from "./coordination";
import { agentAnnotationLabelsFromResult, applyAgentAnnotationLabels, buildPrPrompt } from "./pr-loop";
import { replayPrContextSummary, replayTrajectoryWorkItemFromContext } from "./pr_replay_model";
import { TrajectoryRuntime } from "./trajectory_runtime";
import type { CompatibilityTrajectoryIds } from "./trajectory";
import { initializeTelemetry, shutdownTelemetry } from "./telemetry";

export type AgentResumeMode = "auto" | "required" | "never";

function logJson(eventType: string, data: Record<string, unknown>): void {
  const logEntry = {
    timestamp: new Date().toISOString().replace("+00:00", "Z"),
    event: eventType,
    data,
  };
  console.log(JSON.stringify(logEntry));
}

function errorTypeName(e: unknown): string {
  if (e instanceof Error) return e.constructor.name;
  if (e && typeof e === "object" && "constructor" in e) {
    return (e as { constructor: { name: string } }).constructor.name;
  }
  return typeof e;
}

function adaptDatabase(db: AppStore): AgentDatabase {
  return {
    recordAgentAction(opts) {
      return db.recordAgentAction(
        opts.session_id,
        opts.action_number,
        opts.action_type,
        opts.target,
        opts.details,
        opts.status,
      );
    },
    updateAgentSession(opts) {
      db.updateAgentSession(
        opts.session_id,
        null,
        null,
        null,
        null,
        null,
        null,
        opts.actions_total,
      );
    },
    recordFileOperation(opts) {
      db.recordFileOperation(
        opts.session_id,
        opts.operation_type,
        opts.file_path,
        opts.action_id ?? null,
        opts.file_size ?? null,
        opts.lines_added ?? 0,
        0,
        opts.success,
        opts.error_message ?? null,
      );
    },
    recordAgentError(opts) {
      db.recordAgentError(
        opts.session_id,
        opts.error_type,
        opts.error_message,
        opts.error_details,
        opts.is_transient,
      );
    },
  };
}

function disableNotification(): boolean {
  return true;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function conciseOutput(value: string, maxLength = 8000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.floor(maxLength / 2))}\n...[truncated ${value.length - maxLength} chars]...\n${value.slice(-Math.ceil(maxLength / 2))}`;
}

export async function runAgentFromDb(
  dbPath: string,
  repoName: string,
  prNumber: number,
  mode: string = "for-landing",
  repoPath: string | null = null,
  runtime: "pi" | "claude" = "pi",
  timeoutSeconds = 3600,
  resumeMode: AgentResumeMode = "auto",
): Promise<boolean> {
  if (!repoName || typeof repoName !== "string") {
    logJson("agent_from_db", {
      action: "error",
      error: "repo_name must be a non-empty string",
    });
    return false;
  }

  if (typeof prNumber !== "number" || prNumber <= 0) {
    logJson("agent_from_db", {
      action: "error",
      error: `pr_number must be a positive integer, got: ${prNumber}`,
    });
    return false;
  }

  if (mode !== "for-review" && mode !== "for-landing") {
    logJson("agent_from_db", {
      action: "error",
      error: `mode must be 'for-review' or 'for-landing', got: ${mode}`,
    });
    return false;
  }

  logJson("agent_from_db", {
    action: "start",
    repo_name: repoName,
    pr_number: prNumber,
    mode,
    db_path: dbPath,
    runtime,
    timeout_seconds: timeoutSeconds,
    resume_mode: resumeMode,
  });

  const syncStore = new SyncStore(dbPath);
  const appStore = new AppStore(dbPath);
  const trajectoryRuntime = new TrajectoryRuntime(appStore);
  try {
    await syncStore.initialize();
  } catch (e) {
    logJson("agent_from_db", {
      action: "error",
      error: `Failed to initialize database: ${String(e)}`,
      hint: "Check database file exists and is not corrupted",
    });
    await syncStore.close();
    appStore.close();
    return false;
  }

  try {
    logJson("agent_from_db", {
      action: "loading_context",
      pr_number: prNumber,
    });

    let prDetails: Record<string, unknown>;
    let prContextDict: Record<string, unknown>;
    try {
      const prData = await syncStore.getPrContextForAgent(repoName, prNumber);
    if (!prData) {
      logJson("agent_from_db", {
        action: "error",
        error: `No PR context found in database for ${repoName} PR #${prNumber}`,
        hint: "Run pr-loop.py first to capture PR context, or use the sync script",
      });
      return false;
    }
    [prDetails, prContextDict] = prData;

    const contextSummary = replayPrContextSummary(prContextDict);

    logJson("agent_from_db", {
      action: "context_loaded",
      pr_number: prNumber,
      ...contextSummary,
    });
  } catch (e) {
    logJson("agent_from_db", {
      action: "error",
      error: `Failed to load PR context: ${String(e)}`,
    });
    return false;
  }

  logJson("agent_from_db", {
    action: "building_pr_context",
    pr_number: prNumber,
  });

  let prContext: PRContext;
  try {
    prContext = createPRContextFromDict(prDetails, prContextDict);

    if (!prContext.diff) {
      logJson("agent_from_db", {
        action: "warning",
        warning: "PR context has no diff - this may be an empty PR or incomplete data",
      });
    }

    logJson("agent_from_db", {
      action: "context_summary",
      pr_number: prNumber,
      diff_size: prContext.diff.length,
      comment_count: prContext.general_comments.length,
      review_comment_count: prContext.review_comments.length,
      commit_count: prContext.commits.length,
      file_count: prContext.changed_files.length,
      has_conflicts: prContext.has_conflicts,
      has_failing_ci: prContext.has_failing_ci,
    });
  } catch (e) {
    logJson("agent_from_db", {
      action: "error",
      error: `Failed to build PR context: ${String(e)}`,
      hint: "PR data in database may be incomplete or corrupted",
    });
    return false;
  }

  if (runtime === "pi") {
    const model = "pi";
    let trajectoryIds: CompatibilityTrajectoryIds | null = null;
    try {
      const trajectoryInput = {
        repo_name: repoName,
        repo_path: repoPath ?? process.cwd(),
        pr_number: prNumber,
        mode,
        title: stringValue(prDetails["title"]),
        url: stringValue(prContextDict["url"]),
        labels: stringArray(prDetails["labels"]),
        base_ref: stringValue(prDetails["baseRefName"]) ?? stringValue(prDetails["base_branch"]),
        head_ref: stringValue(prDetails["headRefName"]) ?? stringValue(prDetails["head_branch"]),
        current_sha: stringValue(prDetails["head_sha"]),
        model,
      };
      const workflow = resumeMode === "never"
        ? trajectoryRuntime.startPrAgentWorkflow(trajectoryInput)
        : resumeMode === "required"
          ? trajectoryRuntime.resumePrAgentWorkflow(trajectoryInput)
          : trajectoryRuntime.startOrResumePrAgentWorkflow(trajectoryInput);
      trajectoryIds = workflow.ids;
      logJson("agent_from_db", {
        action: workflow.resumed ? "trajectory_resumed" : "trajectory_created",
        run_id: trajectoryIds.run_id,
        workflow_id: workflow.workflow.id,
        work_item_id: trajectoryIds.work_item_id,
        activity_id: trajectoryIds.activity_id,
        resumed: workflow.resumed,
      });
    } catch (e) {
      if (resumeMode === "required") {
        logJson("agent_from_db", {
          action: "error",
          error: String(e),
          hint: "Run 'merge-god pr <number>' to start new work instead",
        });
        return false;
      }
      logJson("agent_from_db", {
        action: "warning",
        warning: `Failed to create trajectory record: ${String(e)}`,
        hint: "pi processing will continue without durable RFC-006 trajectory state",
      });
    }

    const prompt = buildPrPrompt(
      prDetails,
      prContextDict,
      stringValue(prContextDict["guidelines"]) ?? "",
      stringValue(prContextDict["commit_examples"]) ?? "",
      stringValue(prContextDict["merge_rules"]) ?? "",
    );
    const workItem: WorkItem = {
      kind: "pr",
      repo: repoName,
      repo_path: repoPath ?? process.cwd(),
      pr_number: prNumber,
      mode,
      title: stringValue(prDetails["title"]) ?? undefined,
      url: stringValue(prContextDict["url"]) ?? undefined,
      head_branch: stringValue(prDetails["headRefName"]) ?? undefined,
      base_branch: stringValue(prDetails["baseRefName"]) ?? undefined,
      prompt,
    };

    logJson("agent_from_db", {
      action: "pi_processing",
      pr_number: prNumber,
      mode,
      prompt_size: prompt.length,
      timeout_seconds: timeoutSeconds,
    });

    const startedAt = Date.now();
    const piResult = await runPiAgent(workItem, repoPath ?? process.cwd(), {
      timeout: timeoutSeconds,
      trajectory: trajectoryIds ? trajectoryRuntime.bridgeForPiAgent(trajectoryIds) : undefined,
      startupObserver: (startup) => logJson("pi_startup", { pr_number: prNumber, ...startup }),
    });
    const resultStatus = typeof piResult.result?.["status"] === "string" ? piResult.result["status"] : null;
    const success = piResult.returncode === 0 && resultStatus !== "failure";
    const summary = typeof piResult.result?.["summary"] === "string"
      ? piResult.result["summary"]
      : `pi exited with code ${piResult.returncode}`;
    const errorMessage = success
      ? null
      : (typeof piResult.result?.["error"] === "string" ? piResult.result["error"] : piResult.stderr);
    const annotationLabels = agentAnnotationLabelsFromResult(piResult.result);
    const annotationLabelsApplied = applyAgentAnnotationLabels(prNumber, annotationLabels);

    if (trajectoryIds) {
      try {
        trajectoryRuntime.completePrAgentWorkflow(
          trajectoryIds,
          {
            success,
            summary,
            error_message: errorMessage,
          },
        );
      } catch (e) {
        logJson("agent_from_db", {
          action: "warning",
          warning: `Failed to complete trajectory record: ${String(e)}`,
        });
      }
    }

    logJson("agent_from_db", {
      action: "complete",
      pr_number: prNumber,
      success,
      duration: (Date.now() - startedAt) / 1000,
      returncode: piResult.returncode,
      stdout: conciseOutput(piResult.stdout),
      stderr: conciseOutput(piResult.stderr, 2000),
      stdout_bytes: Buffer.byteLength(piResult.stdout),
      stderr_bytes: Buffer.byteLength(piResult.stderr),
      result: piResult.result,
      annotation_labels: annotationLabels,
      annotation_labels_applied: annotationLabelsApplied,
      mode,
      runtime,
    });

    return success;
  }

  logJson("agent_from_db", {
    action: "initializing_agent",
    pr_number: prNumber,
  });

  let client: ReturnType<typeof createClaudeClient>;
  let model: string;
  try {
    client = createClaudeClient();
    model = getModelName();

    logJson("agent_from_db", {
      action: "agent_initialized",
      model,
    });
  } catch (e) {
    logJson("agent_from_db", {
      action: "error",
      error: `Failed to initialize agent client: ${String(e)}`,
    });
    return false;
  }

  let sessionId: string | null = randomUUID();
  let trajectoryIds: CompatibilityTrajectoryIds | null = null;

  try {
    appStore.createAgentSession(repoName, prNumber, sessionId, mode, model, "1.0");
    logJson("agent_from_db", {
      action: "session_created",
      session_id: sessionId,
    });
  } catch (e) {
    logJson("agent_from_db", {
      action: "warning",
      warning: `Failed to create session record: ${String(e)}`,
      hint: "Session telemetry will not be recorded",
    });
    sessionId = null;
  }

  try {
    const workItem = replayTrajectoryWorkItemFromContext(prDetails, prContextDict);
    const trajectoryInput = {
      repo_name: repoName,
      repo_path: repoPath ?? process.cwd(),
      pr_number: prNumber,
      mode,
      ...workItem,
      session_id: sessionId,
      model,
    };
    const workflow = resumeMode === "never"
      ? trajectoryRuntime.startPrAgentWorkflow(trajectoryInput)
      : resumeMode === "required"
        ? trajectoryRuntime.resumePrAgentWorkflow(trajectoryInput)
        : trajectoryRuntime.startOrResumePrAgentWorkflow(trajectoryInput);
    trajectoryIds = workflow.ids;
    logJson("agent_from_db", {
      action: workflow.resumed ? "trajectory_resumed" : "trajectory_created",
      run_id: trajectoryIds.run_id,
      workflow_id: workflow.workflow.id,
      work_item_id: trajectoryIds.work_item_id,
      activity_id: trajectoryIds.activity_id,
      resumed: workflow.resumed,
    });
  } catch (e) {
    if (resumeMode === "required") {
      logJson("agent_from_db", {
        action: "error",
        error: String(e),
        hint: "Run 'merge-god pr <number>' to start new work instead",
      });
      return false;
    }
    logJson("agent_from_db", {
      action: "warning",
      warning: `Failed to create trajectory record: ${String(e)}`,
      hint: "Agent processing will continue without durable RFC-006 trajectory state",
    });
  }

  const agent = new PRAgent(client, {
    model,
    repo_path: repoPath ?? process.cwd(),
    database: adaptDatabase(appStore),
    session_id: sessionId,
  });

  const callbacks = new PRProcessingCallbacks(prNumber, logJson, disableNotification);

  logJson("agent_from_db", {
    action: "agent_processing",
    pr_number: prNumber,
    mode,
  });

  try {
    const result = await agent.processPrStreaming(prContext, mode, callbacks);

    if (sessionId) {
      try {
        appStore.updateAgentSession(
          sessionId,
          result.success ? "completed" : "failed",
          result.success,
          null,
          result.tasks.length,
          result.tasks.filter((t) => t.status === "completed").length,
          result.tasks.filter((t) => t.status === "failed").length,
          result.actions.length,
        );
      } catch (e) {
        logJson("agent_from_db", {
          action: "warning",
          warning: `Failed to update session record: ${String(e)}`,
        });
      }
    }

    if (trajectoryIds) {
      try {
        trajectoryRuntime.completePrAgentWorkflow(
          trajectoryIds,
          {
            success: result.success,
            summary: `Agent completed with ${result.actions.length} action(s)`,
            error_message: result.success ? null : "Agent reported failure",
          },
        );
      } catch (e) {
        logJson("agent_from_db", {
          action: "warning",
          warning: `Failed to complete trajectory record: ${String(e)}`,
        });
      }
    }

    logJson("agent_from_db", {
      action: "complete",
      pr_number: prNumber,
      session_id: sessionId,
      success: result.success,
      duration: result.duration,
      tasks_total: result.tasks.length,
      tasks_completed: result.tasks.filter((t) => t.status === "completed").length,
      tasks_failed: result.tasks.filter((t) => t.status === "failed").length,
      actions_taken: result.actions.length,
      mode,
    });

    return result.success;
  } catch (e) {
    if (sessionId) {
      try {
        appStore.updateAgentSession(sessionId, "failed", false, String(e));
        appStore.recordAgentError(sessionId, errorTypeName(e), String(e), null, false);
      } catch (dbError) {
        logJson("agent_from_db", {
          action: "warning",
          warning: `Failed to record error in session: ${String(dbError)}`,
        });
      }
    }

    if (trajectoryIds) {
      try {
        trajectoryRuntime.completePrAgentWorkflow(
          trajectoryIds,
          {
            success: false,
            summary: "Agent threw before completion",
            error_message: String(e),
          },
        );
      } catch (dbError) {
        logJson("agent_from_db", {
          action: "warning",
          warning: `Failed to complete trajectory after error: ${String(dbError)}`,
        });
      }
    }

    logJson("agent_from_db", {
      action: "exception",
      pr_number: prNumber,
      session_id: sessionId,
      error: String(e),
      error_type: errorTypeName(e),
    });
    return false;
  }
  } finally {
    await syncStore.close();
    appStore.close();
  }
}

const USAGE =
  "Usage: run_agent_from_db <repo_name> <pr_number> [--mode for-review|for-landing] [--runtime pi|claude] [--resume auto|required|never] [--timeout SECONDS] [--db PATH] [--repo-path PATH]";

export async function main(): Promise<boolean> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "for-landing" },
      runtime: { type: "string", default: "pi" },
      timeout: { type: "string", default: "3600" },
      resume: { type: "string", default: "auto" },
      db: { type: "string", default: "merge-god-state.db" },
      "repo-path": { type: "string" },
    },
  });

  const repoName = parsed.positionals[0];
  const prNumberRaw = parsed.positionals[1];

  if (!repoName) {
    console.error("Error: repo_name is required");
    console.error(USAGE);
    process.exit(2);
  }

  if (!prNumberRaw) {
    console.error("Error: pr_number is required");
    console.error(USAGE);
    process.exit(2);
  }

  const mode = parsed.values.mode ?? "for-landing";
  const runtimeRaw = parsed.values.runtime ?? "pi";
  const timeoutRaw = parsed.values.timeout ?? "3600";
  const resumeRaw = parsed.values.resume ?? "auto";
  const dbPath = parsed.values.db ?? "merge-god-state.db";
  const repoPath = parsed.values["repo-path"] ?? null;

  if (mode !== "for-review" && mode !== "for-landing") {
    logJson("error", {
      error: `Invalid mode: ${mode}`,
      hint: "Mode must be 'for-review' or 'for-landing'",
    });
    process.exit(2);
  }
  if (runtimeRaw !== "pi" && runtimeRaw !== "claude") {
    logJson("error", {
      error: `Invalid runtime: ${runtimeRaw}`,
      hint: "Runtime must be 'pi' or 'claude'",
    });
    process.exit(2);
  }
  if (resumeRaw !== "auto" && resumeRaw !== "required" && resumeRaw !== "never") {
    logJson("error", {
      error: `Invalid resume mode: ${resumeRaw}`,
      hint: "Resume mode must be 'auto', 'required', or 'never'",
    });
    process.exit(2);
  }
  const timeoutSeconds = Number.parseInt(timeoutRaw, 10);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    logJson("error", {
      error: `Invalid timeout: ${timeoutRaw}`,
      hint: "Timeout must be a positive number of seconds",
    });
    process.exit(2);
  }

  const prNumber = Number(prNumberRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    logJson("error", {
      error: `Invalid PR number: ${prNumberRaw}`,
      hint: "PR number must be a positive integer",
    });
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    logJson("error", {
      error: `Database not found: ${dbPath}`,
      hint: "Run 'merge-god scan' first to create and populate the database",
    });
    process.exit(1);
  }

  try {
    const conn = new DatabaseSync(dbPath);
    const row = conn.prepare("SELECT COUNT(*) AS count FROM pr_context").get() as
      | { count: number }
      | undefined;
    const count = row?.count ?? 0;
    conn.close();
    if (count === 0) {
      logJson("warning", {
        warning: "Database has no PR context data",
        hint: "Run pr-loop.py to populate the database with PR data",
      });
    }
  } catch (e) {
    logJson("warning", {
      warning: `Could not check database: ${String(e)}`,
      hint: "Database may be corrupted or incomplete",
    });
  }

  if (prNumber <= 0) {
    logJson("error", {
      error: `Invalid PR number: ${prNumber}`,
      hint: "PR number must be a positive integer",
    });
    process.exit(1);
  }

  return runAgentFromDb(dbPath, repoName, prNumber, mode, repoPath, runtimeRaw, timeoutSeconds, resumeRaw);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  initializeTelemetry(undefined, logJson);
  process.on("SIGINT", () => {
    logJson("shutdown", { reason: "keyboard_interrupt" });
    void shutdownTelemetry().finally(() => process.exit(130));
  });
  main()
    .then((success) => {
      void shutdownTelemetry().finally(() => process.exit(success ? 0 : 1));
    })
    .catch((e: unknown) => {
      logJson("fatal_error", {
        error: String(e),
        error_type: errorTypeName(e),
      });
      void shutdownTelemetry().finally(() => process.exit(1));
    });
}
