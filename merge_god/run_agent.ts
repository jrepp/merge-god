/**
 * Standalone Agent Runner — run agent invocation from SQLite database only.
 *
 * Ported from merge_god/run_agent.py. Demonstrates Process 3 isolation: reads
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
 *   tsx merge_god/run_agent.ts <repo_name> <pr_number> [--mode for-review|for-landing]
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
} from "../agents/__init__";
import { SyncStore } from "@merge-god/github-sync";
import { AppStore } from "../app_store";
import { replayPrContextSummary, replayTrajectoryWorkItemFromContext } from "../pr_replay_model";
import { TrajectoryRuntime } from "../trajectory_runtime";
import type { CompatibilityTrajectoryIds } from "../trajectory";
import { initializeTelemetry, shutdownTelemetry } from "../telemetry";

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

function noNotification(
  _title: string,
  _body: string | null,
  _channel: string,
  _tags: string[] | null,
): boolean {
  return false;
}

export async function runAgentFromDb(
  dbPath: string,
  repoName: string,
  prNumber: number,
  mode: string = "for-landing",
  repoPath: string | null = null,
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

  const generatedSessionId = randomUUID();
  let sessionId: string | null = null;
  let trajectoryIds: CompatibilityTrajectoryIds | null = null;

  try {
    appStore.createAgentSession(repoName, prNumber, generatedSessionId, mode, model, "1.0");
    sessionId = generatedSessionId;
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
  }

  try {
    const workItem = replayTrajectoryWorkItemFromContext(prDetails, prContextDict);
    const workflow = trajectoryRuntime.startPrAgentWorkflow({
      repo_name: repoName,
      repo_path: repoPath ?? process.cwd(),
      pr_number: prNumber,
      mode,
      ...workItem,
      session_id: sessionId,
      model,
    });
    trajectoryIds = workflow.ids;
    logJson("agent_from_db", {
      action: "trajectory_created",
      run_id: trajectoryIds.run_id,
      workflow_id: workflow.workflow.id,
      work_item_id: trajectoryIds.work_item_id,
      activity_id: trajectoryIds.activity_id,
    });
  } catch (e) {
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

  const callbacks = new PRProcessingCallbacks(prNumber, logJson, noNotification);

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
  "Usage: run_agent <repo_name> <pr_number> [--mode for-review|for-landing] [--db PATH] [--repo-path PATH]";

export async function main(): Promise<boolean> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "for-landing" },
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
  const dbPath = parsed.values.db ?? "merge-god-state.db";
  const repoPath = parsed.values["repo-path"] ?? null;

  if (mode !== "for-review" && mode !== "for-landing") {
    logJson("error", {
      error: `Invalid mode: ${mode}`,
      hint: "Mode must be 'for-review' or 'for-landing'",
    });
    process.exit(2);
  }

  const prNumber = Number(prNumberRaw);
  if (!Number.isInteger(prNumber)) {
    logJson("error", {
      error: `Invalid PR number: ${prNumberRaw}`,
      hint: "PR number must be a positive integer",
    });
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    logJson("error", {
      error: `Database not found: ${dbPath}`,
      hint: "Run pr-loop.py first to create and populate the database",
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

  return runAgentFromDb(dbPath, repoName, prNumber, mode, repoPath);
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
