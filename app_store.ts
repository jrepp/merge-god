/**
 * AppStore — merge-god-specific (non-PR) SQLite persistence.
 *
 * Holds only merge-god-specific tables that are outside the @merge-god/github-sync
 * SyncStore scope: processing_history, dashboard_state, and the agent_* family.
 * PR/branch/context/sync tables live in SyncStore.
 *
 * Synchronous, backed by node:sqlite DatabaseSync. The connection is opened once
 * in the constructor and held for the lifetime of the instance; call `close()` to
 * release it.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  remediationModeAllowsMutation,
  resolveRemediationPolicy,
  type RemediationPolicyDecision,
} from "./remediation_policy_model";
import type {
  ActivityRecord,
  ActivityClaim,
  ActivitySessionRecord,
  ActivityType,
  ChildActivityInput,
  CompatibilityTrajectoryIds,
  CompatibilityTrajectoryInput,
  EmbarkCohortTrajectoryIds,
  EmbarkCohortTrajectoryInput,
  JsonObject,
  OrchestrationRunRecord,
  PrQueueTrajectoryIds,
  PrQueueTrajectoryInput,
  ProposedNextActionInput,
  TrajectoryEventRecord,
  TrajectoryCloseoutReport,
  TrajectoryHierarchyRecord,
  TrajectoryResumeState,
  TrajectoryState,
  WorkItemRecord,
  WorksetRecord,
} from "./trajectory";

export class DatabaseError extends Error {}

/** Current time as an ISO-8601 UTC string (mirrors `datetime.now(UTC).isoformat()`). */
function nowIso(): string {
  return new Date().toISOString();
}

/** Encode a boolean as a SQLite integer (1/0). */
function b2i(value: boolean): number {
  return value ? 1 : 0;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonObject(value: unknown): JsonObject {
  if (typeof value !== "string" || value.length === 0) return {};
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {};
}

function parseJsonArray<T = unknown>(value: unknown): T[] {
  if (typeof value !== "string" || value.length === 0) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function remediationBlockers(decision: RemediationPolicyDecision): JsonObject[] {
  return decision.blocked
    ? [{
        kind: "remediation_policy",
        status: "blocked",
        summary: decision.reasons.join(" "),
      }]
    : [];
}

/**
 * SQLite store for merge-god-specific (non-PR) state: processing history,
 * dashboard state, and agent session/action/turn/error/file-operation tracking.
 */
export class AppStore {
  /** Path of the backing SQLite file. */
  readonly dbPath: string;
  private db: DatabaseSync;

  /**
   * Initialize the database connection and create the schema if absent.
   *
   * @param dbPath Path to the SQLite database file.
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    // node:sqlite defaults to foreign_keys=ON; match the original semantics
    // (the schema references columns that lack a UNIQUE constraint).
    this.db.exec("PRAGMA foreign_keys = OFF;");
    this.initialize();
  }

  /** Release the underlying database connection. */
  close(): void {
    this.db.close();
  }

  /** Create database schema (tables + indexes) if it doesn't exist. */
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processing_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          action_type TEXT NOT NULL,
          success INTEGER DEFAULT 0,
          error_message TEXT,
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          duration_seconds REAL,
          metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS dashboard_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL UNIQUE,
          status TEXT,
          current_pr_number INTEGER,
          prs_processed INTEGER DEFAULT 0,
          successes INTEGER DEFAULT 0,
          failures INTEGER DEFAULT 0,
          iteration INTEGER DEFAULT 0,
          last_update TIMESTAMP,
          state_data TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_processing_repo_pr
      ON processing_history(repo_name, pr_number, started_at DESC);

      CREATE TABLE IF NOT EXISTS agent_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL,
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          status TEXT NOT NULL,
          success INTEGER DEFAULT 0,
          error_message TEXT,
          tasks_total INTEGER DEFAULT 0,
          tasks_completed INTEGER DEFAULT 0,
          tasks_failed INTEGER DEFAULT 0,
          actions_total INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          estimated_cost REAL DEFAULT 0.0,
          duration_seconds REAL,
          api_calls INTEGER DEFAULT 0,
          model TEXT,
          agent_version TEXT,
          FOREIGN KEY (repo_name, pr_number) REFERENCES pull_requests(repo_name, pr_number)
      );

      CREATE TABLE IF NOT EXISTS agent_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          action_number INTEGER NOT NULL,
          action_type TEXT NOT NULL,
          target TEXT,
          status TEXT NOT NULL,
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          success INTEGER DEFAULT 0,
          error_message TEXT,
          details TEXT,
          result TEXT,
          duration_ms INTEGER,
          FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS agent_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          turn_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          content_type TEXT NOT NULL,
          content_preview TEXT,
          tool_uses INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          created_at TIMESTAMP NOT NULL,
          FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS agent_errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          error_type TEXT NOT NULL,
          error_message TEXT NOT NULL,
          error_details TEXT,
          occurred_at TIMESTAMP NOT NULL,
          is_transient INTEGER DEFAULT 0,
          retry_count INTEGER DEFAULT 0,
          FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_repo_pr
      ON agent_sessions(repo_name, pr_number, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
      ON agent_sessions(status, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_actions_session
      ON agent_actions(session_id, action_number);

      CREATE INDEX IF NOT EXISTS idx_agent_turns_session
      ON agent_turns(session_id, turn_number);

      CREATE INDEX IF NOT EXISTS idx_agent_errors_session
      ON agent_errors(session_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS agent_file_operations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          action_id INTEGER,
          operation_type TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          lines_added INTEGER DEFAULT 0,
          lines_removed INTEGER DEFAULT 0,
          success INTEGER DEFAULT 1,
          error_message TEXT,
          occurred_at TIMESTAMP NOT NULL,
          FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id),
          FOREIGN KEY (action_id) REFERENCES agent_actions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_file_ops_session
      ON agent_file_operations(session_id, occurred_at);

      CREATE INDEX IF NOT EXISTS idx_agent_file_ops_path
      ON agent_file_operations(file_path, operation_type);

      CREATE TABLE IF NOT EXISTS orchestration_runs (
          run_id TEXT PRIMARY KEY,
          repo_name TEXT NOT NULL,
          repo_path TEXT,
          base_branch TEXT,
          strategy_version TEXT NOT NULL,
          workflow_ir_refs TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          current_phase TEXT NOT NULL,
          started_at TIMESTAMP NOT NULL,
          heartbeat_at TIMESTAMP,
          completed_at TIMESTAMP,
          objective TEXT,
          operator_policy TEXT NOT NULL DEFAULT '{}',
          model_policy TEXT NOT NULL DEFAULT '{}',
          metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_repo_status
      ON orchestration_runs(repo_name, status, started_at DESC);

      CREATE TABLE IF NOT EXISTS worksets (
          workset_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          selection_reason TEXT,
          status TEXT NOT NULL,
          approval_state TEXT NOT NULL,
          strategy TEXT,
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_worksets_run_status
      ON worksets(run_id, status, created_at);

      CREATE TABLE IF NOT EXISTS work_items (
          work_item_id TEXT PRIMARY KEY,
          workset_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT NOT NULL,
          url TEXT,
          mode TEXT,
          labels TEXT NOT NULL DEFAULT '[]',
          base_ref TEXT,
          head_ref TEXT,
          start_sha TEXT,
          current_sha TEXT,
          status TEXT NOT NULL,
          disposition_setting TEXT,
          computed_disposition TEXT,
          priority INTEGER,
          model_tier TEXT,
          next_action TEXT,
          blockers TEXT NOT NULL DEFAULT '[]',
          risk_signals TEXT NOT NULL DEFAULT '{}',
          context_pack_refs TEXT NOT NULL DEFAULT '[]',
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (workset_id) REFERENCES worksets(workset_id)
      );

      CREATE INDEX IF NOT EXISTS idx_work_items_workset_status
      ON work_items(workset_id, status, priority);

      CREATE INDEX IF NOT EXISTS idx_work_items_source
      ON work_items(repo_name, source_kind, number);

      CREATE TABLE IF NOT EXISTS activities (
          activity_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workset_id TEXT,
          work_item_id TEXT,
          parent_activity_id TEXT,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          model_profile TEXT NOT NULL DEFAULT '{}',
          tool_policy TEXT NOT NULL DEFAULT '{}',
          prompt_runtime_ref TEXT,
          context_pack_refs TEXT NOT NULL DEFAULT '[]',
          output_summary_ref TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]',
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (workset_id) REFERENCES worksets(workset_id),
          FOREIGN KEY (work_item_id) REFERENCES work_items(work_item_id),
          FOREIGN KEY (parent_activity_id) REFERENCES activities(activity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_activities_run_status
      ON activities(run_id, status, created_at);

      CREATE INDEX IF NOT EXISTS idx_activities_work_item
      ON activities(work_item_id, type, status);

      CREATE TABLE IF NOT EXISTS activity_sessions (
          activity_session_id TEXT PRIMARY KEY,
          activity_id TEXT NOT NULL,
          session_id TEXT,
          model TEXT,
          prompt_runtime_ref TEXT,
          prompt_hash TEXT,
          tool_set TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          estimated_cost REAL DEFAULT 0.0,
          output_digest TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (activity_id) REFERENCES activities(activity_id),
          FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_activity_sessions_activity
      ON activity_sessions(activity_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_activity_sessions_session
      ON activity_sessions(session_id);

      CREATE TABLE IF NOT EXISTS trajectory_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          workset_id TEXT,
          work_item_id TEXT,
          activity_id TEXT,
          activity_session_id TEXT,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP NOT NULL,
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (workset_id) REFERENCES worksets(workset_id),
          FOREIGN KEY (work_item_id) REFERENCES work_items(work_item_id),
          FOREIGN KEY (activity_id) REFERENCES activities(activity_id),
          FOREIGN KEY (activity_session_id) REFERENCES activity_sessions(activity_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_trajectory_events_run
      ON trajectory_events(run_id, id);

      CREATE TABLE IF NOT EXISTS context_captures (
          context_capture_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          work_item_id TEXT,
          capture_reason TEXT NOT NULL,
          source_refs TEXT NOT NULL DEFAULT '{}',
          freshness TEXT NOT NULL DEFAULT '{}',
          content_digest TEXT,
          artifact_ref TEXT,
          captured_at TIMESTAMP NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (work_item_id) REFERENCES work_items(work_item_id)
      );

      CREATE TABLE IF NOT EXISTS context_packs (
          context_pack_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          work_item_id TEXT,
          activity_id TEXT,
          kind TEXT NOT NULL,
          version TEXT NOT NULL,
          schema_ref TEXT,
          content_digest TEXT,
          token_estimate INTEGER DEFAULT 0,
          freshness TEXT NOT NULL DEFAULT '{}',
          artifact_ref TEXT,
          source_entity_refs TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (work_item_id) REFERENCES work_items(work_item_id),
          FOREIGN KEY (activity_id) REFERENCES activities(activity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_context_packs_entity
      ON context_packs(run_id, work_item_id, kind, created_at DESC);

      CREATE TABLE IF NOT EXISTS guardrail_checks (
          guardrail_check_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workset_id TEXT,
          work_item_id TEXT,
          activity_id TEXT,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          policy_version TEXT,
          result TEXT NOT NULL DEFAULT '{}',
          evidence_refs TEXT NOT NULL DEFAULT '[]',
          checked_at TIMESTAMP NOT NULL,
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (workset_id) REFERENCES worksets(workset_id),
          FOREIGN KEY (work_item_id) REFERENCES work_items(work_item_id),
          FOREIGN KEY (activity_id) REFERENCES activities(activity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_guardrail_checks_entity
      ON guardrail_checks(run_id, work_item_id, activity_id, checked_at DESC);

      CREATE TABLE IF NOT EXISTS evidence_artifacts (
          evidence_artifact_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workset_id TEXT,
          work_item_id TEXT,
          activity_id TEXT,
          kind TEXT NOT NULL,
          summary TEXT,
          content_digest TEXT,
          artifact_ref TEXT,
          created_at TIMESTAMP NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (workset_id) REFERENCES worksets(workset_id),
          FOREIGN KEY (work_item_id) REFERENCES work_items(work_item_id),
          FOREIGN KEY (activity_id) REFERENCES activities(activity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_entity
      ON evidence_artifacts(run_id, work_item_id, activity_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS tool_invocations (
          tool_invocation_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          activity_id TEXT,
          activity_session_id TEXT,
          tool_ref TEXT NOT NULL,
          inputs TEXT NOT NULL DEFAULT '{}',
          outputs TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          artifact_refs TEXT NOT NULL DEFAULT '[]',
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id),
          FOREIGN KEY (activity_id) REFERENCES activities(activity_id),
          FOREIGN KEY (activity_session_id) REFERENCES activity_sessions(activity_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_invocations_activity
      ON tool_invocations(activity_id, started_at);
    `);
  }

  // ------------------------------------------------------------------
  // Processing History Operations
  // ------------------------------------------------------------------

  /**
   * Record the start of PR processing.
   * @returns The new processing record ID.
   */
  recordProcessingStart(
    repoName: string,
    prNumber: number,
    actionType: string,
    metadata: Record<string, unknown> | null = null,
  ): number {
    const result = this.db
      .prepare(
        `
        INSERT INTO processing_history (
            repo_name, pr_number, action_type, started_at, metadata
        ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(repoName, prNumber, actionType, nowIso(), metadata ? JSON.stringify(metadata) : null);
    return Number(result.lastInsertRowid);
  }

  /** Record the completion of PR processing. */
  recordProcessingComplete(
    recordId: number,
    success: boolean,
    errorMessage: string | null = null,
  ): void {
    const completedAt = nowIso();
    this.db
      .prepare(
        `
        UPDATE processing_history
        SET success = ?,
            error_message = ?,
            completed_at = ?,
            duration_seconds = (
                julianday(?) - julianday(started_at)
            ) * 86400
        WHERE id = ?
        `,
      )
      .run(b2i(success), errorMessage, completedAt, completedAt, recordId);
  }

  /** Get processing history for a repository or specific PR. */
  getProcessingHistory(
    repoName: string,
    prNumber: number | null = null,
    limit: number = 10,
  ): Record<string, unknown>[] {
    let sql: string;
    let rows: Record<string, unknown>[];
    if (prNumber !== null) {
      sql = `
        SELECT * FROM processing_history
        WHERE repo_name = ? AND pr_number = ?
        ORDER BY started_at DESC
        LIMIT ?
      `;
      rows = this.db.prepare(sql).all(repoName, prNumber, limit);
    } else {
      sql = `
        SELECT * FROM processing_history
        WHERE repo_name = ?
        ORDER BY started_at DESC
        LIMIT ?
      `;
      rows = this.db.prepare(sql).all(repoName, limit);
    }
    return rows.map((row) => {
      const data: Record<string, unknown> = { ...row };
      if (data["metadata"]) {
        data["metadata"] = JSON.parse(data["metadata"] as string);
      }
      return data;
    });
  }

  // ------------------------------------------------------------------
  // Dashboard State Operations
  // ------------------------------------------------------------------

  /** Save dashboard state for a repository. */
  saveDashboardState(
    repoName: string,
    status: string,
    stats: Record<string, unknown>,
    currentPrNumber: number | null = null,
    stateData: Record<string, unknown> | null = null,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO dashboard_state (
            repo_name, status, current_pr_number,
            prs_processed, successes, failures, iteration,
            last_update, state_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_name) DO UPDATE SET
            status = excluded.status,
            current_pr_number = excluded.current_pr_number,
            prs_processed = excluded.prs_processed,
            successes = excluded.successes,
            failures = excluded.failures,
            iteration = excluded.iteration,
            last_update = excluded.last_update,
            state_data = excluded.state_data
        `,
      )
      .run(
        repoName,
        status,
        currentPrNumber,
        (stats["prs_processed"] as number) ?? 0,
        (stats["successes"] as number) ?? 0,
        (stats["failures"] as number) ?? 0,
        (stats["iteration"] as number) ?? 0,
        nowIso(),
        stateData ? JSON.stringify(stateData) : null,
      );
  }

  /** Get dashboard state for a repository. */
  getDashboardState(repoName: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM dashboard_state WHERE repo_name = ?")
      .get(repoName);
    if (!row) return null;
    const data: Record<string, unknown> = { ...row };
    if (data["state_data"]) {
      data["state_data"] = JSON.parse(data["state_data"] as string);
    }
    return data;
  }

  // ------------------------------------------------------------------
  // Agent Session Operations
  // ------------------------------------------------------------------

  /** Create a new agent session record. */
  createAgentSession(
    repoName: string,
    prNumber: number,
    sessionId: string,
    mode: string,
    model: string,
    agentVersion: string = "1.0",
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO agent_sessions (
            repo_name, pr_number, session_id, mode, model, agent_version,
            started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(repoName, prNumber, sessionId, mode, model, agentVersion, nowIso(), "running");
  }

  /** Update agent session with progress/completion data. */
  updateAgentSession(
    sessionId: string,
    status: string | null = null,
    success: boolean | null = null,
    errorMessage: string | null = null,
    tasksTotal: number | null = null,
    tasksCompleted: number | null = null,
    tasksFailed: number | null = null,
    actionsTotal: number | null = null,
    inputTokens: number | null = null,
    outputTokens: number | null = null,
    apiCalls: number | null = null,
  ): void {
    const updates: string[] = [];
    const params: Array<string | number | null> = [];

    const completing = status === "completed" || status === "failed" || status === "aborted";

    if (status !== null) {
      updates.push("status = ?");
      params.push(status);
      if (completing) {
        updates.push("completed_at = ?");
        params.push(nowIso());
      }
    }

    if (success !== null) {
      updates.push("success = ?");
      params.push(b2i(success));
    }

    if (errorMessage !== null) {
      updates.push("error_message = ?");
      params.push(errorMessage);
    }

    if (tasksTotal !== null) {
      updates.push("tasks_total = ?");
      params.push(tasksTotal);
    }

    if (tasksCompleted !== null) {
      updates.push("tasks_completed = ?");
      params.push(tasksCompleted);
    }

    if (tasksFailed !== null) {
      updates.push("tasks_failed = ?");
      params.push(tasksFailed);
    }

    if (actionsTotal !== null) {
      updates.push("actions_total = ?");
      params.push(actionsTotal);
    }

    if (inputTokens !== null) {
      updates.push("input_tokens = ?");
      params.push(inputTokens);
    }

    if (outputTokens !== null) {
      updates.push("output_tokens = ?");
      params.push(outputTokens);
      if (inputTokens !== null) {
        updates.push("total_tokens = ?");
        params.push(inputTokens + outputTokens);
        updates.push("estimated_cost = ?");
        const cost = (inputTokens * 0.003) / 1000 + (outputTokens * 0.015) / 1000;
        params.push(cost);
      }
    }

    if (apiCalls !== null) {
      updates.push("api_calls = ?");
      params.push(apiCalls);
    }

    if (completing) {
      updates.push("duration_seconds = (julianday(?) - julianday(started_at)) * 86400");
      params.push(nowIso());
    }

    if (updates.length === 0) return;

    params.push(sessionId);

    const sql = `
      UPDATE agent_sessions
      SET ${updates.join(", ")}
      WHERE session_id = ?
    `;
    this.db.prepare(sql).run(...params);
  }

  /** Record an agent action. @returns The new action record ID. */
  recordAgentAction(
    sessionId: string,
    actionNumber: number,
    actionType: string,
    target: string = "",
    details: Record<string, unknown> | null = null,
    status: string = "started",
    success: boolean | null = null,
    errorMessage: string | null = null,
    result: Record<string, unknown> | null = null,
  ): number {
    const result0 = this.db
      .prepare(
        `
        INSERT INTO agent_actions (
            session_id, action_number, action_type, target, status,
            started_at, success, error_message, details, result
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        sessionId,
        actionNumber,
        actionType,
        target,
        status,
        nowIso(),
        success === null ? null : b2i(success),
        errorMessage,
        details ? JSON.stringify(details) : null,
        result ? JSON.stringify(result) : null,
      );
    return Number(result0.lastInsertRowid);
  }

  /** Record a conversation turn. */
  recordAgentTurn(
    sessionId: string,
    turnNumber: number,
    role: string,
    contentType: string,
    contentPreview: string | null = null,
    toolUses: number = 0,
    inputTokens: number = 0,
    outputTokens: number = 0,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO agent_turns (
            session_id, turn_number, role, content_type, content_preview,
            tool_uses, input_tokens, output_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        sessionId,
        turnNumber,
        role,
        contentType,
        contentPreview,
        toolUses,
        inputTokens,
        outputTokens,
        nowIso(),
      );
  }

  /** Record an agent error. */
  recordAgentError(
    sessionId: string,
    errorType: string,
    errorMessage: string,
    errorDetails: string | null = null,
    isTransient: boolean = false,
    retryCount: number = 0,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO agent_errors (
            session_id, error_type, error_message, error_details,
            is_transient, retry_count, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        sessionId,
        errorType,
        errorMessage,
        errorDetails,
        b2i(isTransient),
        retryCount,
        nowIso(),
      );
  }

  /** Record a file operation. */
  recordFileOperation(
    sessionId: string,
    operationType: string,
    filePath: string,
    actionId: number | null = null,
    fileSize: number | null = null,
    linesAdded: number = 0,
    linesRemoved: number = 0,
    success: boolean = true,
    errorMessage: string | null = null,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO agent_file_operations (
            session_id, action_id, operation_type, file_path, file_size,
            lines_added, lines_removed, success, error_message, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        sessionId,
        actionId,
        operationType,
        filePath,
        fileSize,
        linesAdded,
        linesRemoved,
        b2i(success),
        errorMessage,
        nowIso(),
      );
  }

  /** Get agent session history. */
  getAgentSessions(
    repoName: string | null = null,
    prNumber: number | null = null,
    limit: number = 10,
  ): Record<string, unknown>[] {
    let query = "SELECT * FROM agent_sessions";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (repoName) {
      conditions.push("repo_name = ?");
      params.push(repoName);
    }

    if (prNumber !== null) {
      conditions.push("pr_number = ?");
      params.push(prNumber);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY started_at DESC LIMIT ?";
    params.push(limit);

    return this.db.prepare(query).all(...params);
  }

  /** Get complete session details with actions, turns, errors, and file ops. */
  getSessionDetails(sessionId: string): Record<string, unknown> | null {
    const sessionRow = this.db
      .prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId);
    if (!sessionRow) return null;

    const session: Record<string, unknown> = { ...sessionRow };

    const actions = this.db
      .prepare(
        `
        SELECT * FROM agent_actions
        WHERE session_id = ?
        ORDER BY action_number
        `,
      )
      .all(sessionId);
    session["actions"] = actions;

    const turns = this.db
      .prepare(
        `
        SELECT * FROM agent_turns
        WHERE session_id = ?
        ORDER BY turn_number
        `,
      )
      .all(sessionId);
    session["turns"] = turns;

    const errors = this.db
      .prepare(
        `
        SELECT * FROM agent_errors
        WHERE session_id = ?
        ORDER BY occurred_at
        `,
      )
      .all(sessionId);
    session["errors"] = errors;

    const fileOps = this.db
      .prepare(
        `
        SELECT * FROM agent_file_operations
        WHERE session_id = ?
        ORDER BY occurred_at
        `,
      )
      .all(sessionId);
    session["file_operations"] = fileOps;

    return session;
  }

  // ------------------------------------------------------------------
  // RFC-006 Trajectory Operations
  // ------------------------------------------------------------------

  /** Create a durable PR queue run with one ready activity per work item. */
  createPrQueueTrajectory(input: PrQueueTrajectoryInput): PrQueueTrajectoryIds {
    if (!input.repo_name) throw new DatabaseError("repo_name is required");
    if (input.items.length === 0) throw new DatabaseError("at least one work item is required");

    const runId = randomUUID();
    const worksetId = randomUUID();
    const workItemIds: string[] = [];
    const activityIds: string[] = [];
    const now = nowIso();

    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `
          INSERT INTO orchestration_runs (
              run_id, repo_name, repo_path, base_branch, strategy_version,
              workflow_ir_refs, status, current_phase, started_at, heartbeat_at,
              objective, operator_policy, model_policy, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          runId,
          input.repo_name,
          input.repo_path ?? null,
          input.base_branch ?? null,
          "queue-runtime-v1",
          stringifyJson([]),
          "planning",
          "queue_ready",
          now,
          now,
          input.objective ?? `Process ${input.items.length} queued PR(s)`,
          stringifyJson({
            labels_required: ["for-review", "for-landing"],
            repository_remediation_mode: input.repository_remediation_mode ?? "bounded-fixes",
            global_remediation_ceiling: input.global_remediation_ceiling ?? "maintainer-approved",
          }),
          stringifyJson({}),
          stringifyJson({ runtime_path: "pr_queue" }),
        );

      this.db
        .prepare(
          `
          INSERT INTO worksets (
              workset_id, run_id, kind, selection_reason, status,
              approval_state, strategy, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          worksetId,
          runId,
          "pr_queue",
          "Queued PRs selected by deterministic label and priority policy",
          "ready",
          "not_required",
          input.strategy ?? "priority-order",
          now,
          now,
          stringifyJson({ item_count: input.items.length }),
        );

      for (let i = 0; i < input.items.length; i++) {
        const item = input.items[i]!;
        if (!Number.isInteger(item.number) || item.number <= 0) {
          throw new DatabaseError(`invalid PR number at queue index ${i}`);
        }
        const workItemId = randomUUID();
        const activityId = randomUUID();
        workItemIds.push(workItemId);
        activityIds.push(activityId);
        const activityType: ActivityType = item.mode === "for-review" ? "review_workflow" : "merge_gate";
        const remediationDecision = resolveRemediationPolicy({
          labels: item.labels,
          work_item_mode: item.disposition_setting,
          repository_mode: input.repository_remediation_mode,
          risk_ceiling: item.risk_remediation_ceiling,
          global_ceiling: input.global_remediation_ceiling,
          maintainer_approval_verified: item.maintainer_approval_verified,
        });

        this.db
          .prepare(
            `
            INSERT INTO work_items (
                work_item_id, workset_id, source_kind, repo_name, number, title,
                url, mode, labels, base_ref, head_ref, start_sha, current_sha,
                status, disposition_setting, priority, model_tier, next_action,
                blockers, risk_signals, context_pack_refs, created_at, updated_at, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            workItemId,
            worksetId,
            "pull_request",
            item.repo_name,
            item.number,
            item.title,
            item.url ?? null,
            item.mode ?? null,
            stringifyJson(item.labels ?? []),
            item.base_ref ?? input.base_branch ?? null,
            item.head_ref ?? null,
            item.current_sha ?? null,
            item.current_sha ?? null,
            "queued",
            remediationDecision.effective_mode,
            item.priority ?? i,
            item.model_tier ?? null,
            "claim_activity",
            stringifyJson(remediationBlockers(remediationDecision)),
            stringifyJson({
              label_contract_checked: true,
              remediation_policy: remediationDecision,
            }),
            stringifyJson([]),
            now,
            now,
            stringifyJson({ queue_index: i }),
          );

        this.db
          .prepare(
            `
            INSERT INTO activities (
                activity_id, run_id, workset_id, work_item_id, type, status,
                model_profile, tool_policy, prompt_runtime_ref,
                context_pack_refs, evidence_refs, created_at, updated_at, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            activityId,
            runId,
            worksetId,
            workItemId,
            activityType,
            "ready",
            stringifyJson({ model_tier: item.model_tier ?? null }),
            stringifyJson({
              remediation_mode: remediationDecision.effective_mode,
              mutating_allowed: remediationModeAllowsMutation(remediationDecision.effective_mode) && !remediationDecision.blocked,
              budget: remediationDecision.budget,
            }),
            null,
            stringifyJson([]),
            stringifyJson([]),
            now,
            now,
            stringifyJson({ mode: item.mode ?? null }),
          );
      }

      this.insertTrajectoryEvent({
        run_id: runId,
        workset_id: worksetId,
        event_type: "runtime.queue.created",
        actor: "merge-god",
        payload: {
          item_count: input.items.length,
          activity_count: activityIds.length,
          strategy: input.strategy ?? "priority-order",
        },
      });

      this.db.exec("COMMIT");
      return { run_id: runId, workset_id: worksetId, work_item_ids: workItemIds, activity_ids: activityIds };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to create PR queue trajectory: ${String(e)}`);
    }
  }

  /** Create a durable embark cohort run for grouped validation of ready PRs. */
  createEmbarkCohortTrajectory(input: EmbarkCohortTrajectoryInput): EmbarkCohortTrajectoryIds {
    if (!input.repo_name) throw new DatabaseError("repo_name is required");
    if (input.items.length < 2) throw new DatabaseError("an embark cohort requires at least two PRs");

    const runId = randomUUID();
    const worksetId = randomUUID();
    const groupActivityId = randomUUID();
    const cohortId = input.cohort_id ?? randomUUID();
    const workItemIds: string[] = [];
    const now = nowIso();
    const mergePlan = input.items.map((item, index) => ({
      order: index + 1,
      pr_number: item.number,
      head_ref: item.head_ref ?? null,
      expected_merge_commit: null,
    }));

    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `
          INSERT INTO orchestration_runs (
              run_id, repo_name, repo_path, base_branch, strategy_version,
              workflow_ir_refs, status, current_phase, started_at, heartbeat_at,
              objective, operator_policy, model_policy, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          runId,
          input.repo_name,
          input.repo_path ?? null,
          input.base_branch ?? null,
          "embark-runtime-v1",
          stringifyJson([]),
          "planning",
          "embark_cohort_ready",
          now,
          now,
          input.objective ?? `Validate ${input.items.length} ready PR(s) as one embark PR`,
          stringifyJson({
            labels_required: ["merge:ready"],
            advanced_strategy: "multi_pr_embark",
          }),
          stringifyJson({}),
          stringifyJson({
            runtime_path: "embark_cohort",
            strategy_family: "multi_pr_embark",
            cohort_id: cohortId,
            integration_branch: input.integration_branch ?? null,
            output_pr_number: input.output_pr_number ?? null,
            output_pr_url: input.output_pr_url ?? null,
            validation_commands: input.validation_commands ?? [],
          }),
        );

      this.db
        .prepare(
          `
          INSERT INTO worksets (
              workset_id, run_id, kind, selection_reason, status,
              approval_state, strategy, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          worksetId,
          runId,
          "embark_cohort",
          "Ready PRs selected for grouped merge-commit validation",
          "ready",
          "pending",
          "multi-pr-merge-commit-validation",
          now,
          now,
          stringifyJson({
            cohort_id: cohortId,
            item_count: input.items.length,
            merge_plan: mergePlan,
            integration_branch: input.integration_branch ?? null,
            output_pr_number: input.output_pr_number ?? null,
            output_pr_url: input.output_pr_url ?? null,
          }),
        );

      for (let i = 0; i < input.items.length; i++) {
        const item = input.items[i]!;
        if (!Number.isInteger(item.number) || item.number <= 0) {
          throw new DatabaseError(`invalid PR number at embark index ${i}`);
        }
        const workItemId = randomUUID();
        workItemIds.push(workItemId);
        this.db
          .prepare(
            `
            INSERT INTO work_items (
                work_item_id, workset_id, source_kind, repo_name, number, title,
                url, mode, labels, base_ref, head_ref, start_sha, current_sha,
                status, disposition_setting, priority, model_tier, next_action,
                blockers, risk_signals, context_pack_refs, created_at, updated_at, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            workItemId,
            worksetId,
            "pull_request",
            item.repo_name,
            item.number,
            item.title,
            item.url ?? null,
            item.mode ?? null,
            stringifyJson(item.labels ?? []),
            item.base_ref ?? input.base_branch ?? null,
            item.head_ref ?? null,
            item.current_sha ?? null,
            item.current_sha ?? null,
            "embarked",
            item.disposition_setting ?? null,
            item.priority ?? i,
            item.model_tier ?? null,
            "validate_cohort",
            stringifyJson([]),
            stringifyJson({ embark_ready: true }),
            stringifyJson([]),
            now,
            now,
            stringifyJson({
              cohort_id: cohortId,
              merge_order: i + 1,
              expected_merge_commit: null,
              source_state: "ready",
            }),
          );
      }

      this.db
        .prepare(
          `
          INSERT INTO activities (
              activity_id, run_id, workset_id, work_item_id, type, status,
              model_profile, tool_policy, prompt_runtime_ref,
              context_pack_refs, evidence_refs, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          groupActivityId,
          runId,
          worksetId,
          null,
          "merge_gate",
          "ready",
          stringifyJson({}),
          stringifyJson({
            mutating_allowed: false,
            grouped_validation: true,
          }),
          null,
          stringifyJson([]),
          stringifyJson([]),
          now,
          now,
          stringifyJson({
            cohort_id: cohortId,
            merge_plan: mergePlan,
            validation_commands: input.validation_commands ?? [],
            integration_branch: input.integration_branch ?? null,
            output_pr_number: input.output_pr_number ?? null,
            output_pr_url: input.output_pr_url ?? null,
          }),
        );

      this.insertTrajectoryEvent({
        run_id: runId,
        workset_id: worksetId,
        activity_id: groupActivityId,
        event_type: "runtime.embark_cohort.created",
        actor: "merge-god",
        payload: {
          cohort_id: cohortId,
          item_count: input.items.length,
          merge_plan: mergePlan,
          integration_branch: input.integration_branch ?? null,
          output_pr_number: input.output_pr_number ?? null,
          output_pr_url: input.output_pr_url ?? null,
          validation_commands: input.validation_commands ?? [],
        },
      });

      this.db.exec("COMMIT");
      return { run_id: runId, workset_id: worksetId, work_item_ids: workItemIds, group_activity_id: groupActivityId };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to create embark cohort trajectory: ${String(e)}`);
    }
  }

  /** Claim the next ready activity for a run according to work item priority. */
  claimNextActivity(runId: string): ActivityClaim | null {
    const now = nowIso();
    try {
      this.db.exec("BEGIN");
      const row = this.db
        .prepare(
          `
          SELECT
              a.*,
              wi.priority AS work_item_priority,
              wi.created_at AS work_item_created_at
          FROM activities a
          LEFT JOIN work_items wi ON wi.work_item_id = a.work_item_id
          WHERE a.run_id = ? AND a.status = 'ready'
          ORDER BY COALESCE(wi.priority, 999999), wi.created_at, a.created_at, a.activity_id
          LIMIT 1
          `,
        )
        .get(runId) as Record<string, unknown> | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const activityId = String(row["activity_id"]);
      const worksetId = strOrNull(row["workset_id"]);
      const workItemId = strOrNull(row["work_item_id"]);
      this.db
        .prepare("UPDATE activities SET status = 'claimed', updated_at = ? WHERE activity_id = ?")
        .run(now, activityId);
      if (workItemId) {
        this.db
          .prepare("UPDATE work_items SET status = 'running', next_action = 'start_activity', updated_at = ? WHERE work_item_id = ?")
          .run(now, workItemId);
      }
      this.db
        .prepare("UPDATE orchestration_runs SET status = 'executing', current_phase = 'activity_claimed', heartbeat_at = ? WHERE run_id = ?")
        .run(now, runId);
      this.insertTrajectoryEvent({
        run_id: runId,
        workset_id: worksetId,
        work_item_id: workItemId,
        activity_id: activityId,
        event_type: "activity.claimed",
        actor: "merge-god",
        payload: { activity_id: activityId, work_item_id: workItemId },
      });
      this.db.exec("COMMIT");

      const state = this.getTrajectoryState(runId);
      const activity = state?.activities.find((a) => a.activity_id === activityId);
      const workItem = workItemId ? state?.work_items.find((item) => item.work_item_id === workItemId) ?? null : null;
      if (!activity) throw new DatabaseError(`claimed activity not found after update: ${activityId}`);
      return {
        ids: {
          run_id: runId,
          workset_id: worksetId ?? "",
          work_item_id: workItemId ?? "",
          activity_id: activityId,
          activity_session_id: null,
        },
        activity,
        work_item: workItem,
      };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to claim next activity: ${String(e)}`);
    }
  }

  /** Start a claimed activity by binding a concrete model/tool session. */
  startClaimedActivity(
    ids: CompatibilityTrajectoryIds,
    sessionId: string | null,
    model: string | null = null,
  ): CompatibilityTrajectoryIds {
    const activitySessionId = randomUUID();
    const now = nowIso();
    try {
      this.db.exec("BEGIN");
      this.db
        .prepare("UPDATE activities SET status = 'running', updated_at = ? WHERE activity_id = ? AND status = 'claimed'")
        .run(now, ids.activity_id);
      this.db
        .prepare(
          `
          INSERT INTO activity_sessions (
              activity_session_id, activity_id, session_id, model, status,
              started_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(activitySessionId, ids.activity_id, sessionId, model, "running", now, stringifyJson({ runtime_path: "queue" }));
      this.insertTrajectoryEvent({
        run_id: ids.run_id,
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: activitySessionId,
        event_type: "activity.started",
        actor: "merge-god",
        payload: { session_id: sessionId, model },
      });
      this.db.exec("COMMIT");
      return { ...ids, activity_session_id: activitySessionId };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to start claimed activity: ${String(e)}`);
    }
  }

  /** Complete one queued activity and advance run/workset terminal state when exhausted. */
  completeActivity(
    ids: CompatibilityTrajectoryIds,
    success: boolean,
    summary: string | null = null,
    errorMessage: string | null = null,
  ): void {
    const now = nowIso();
    const activityStatus = success ? "succeeded" : "failed";

    try {
      this.db.exec("BEGIN");
      if (ids.activity_session_id) {
        this.db
          .prepare("UPDATE activity_sessions SET status = ?, completed_at = ?, metadata = ? WHERE activity_session_id = ?")
          .run(activityStatus, now, stringifyJson({ summary, error_message: errorMessage }), ids.activity_session_id);
      }
      this.db
        .prepare("UPDATE activities SET status = ?, output_summary_ref = ?, completed_at = ?, updated_at = ? WHERE activity_id = ?")
        .run(activityStatus, summary, now, now, ids.activity_id);
      if (ids.work_item_id) {
        const pendingForItem = this.db
          .prepare("SELECT COUNT(*) AS count FROM activities WHERE work_item_id = ? AND status IN ('ready', 'claimed', 'running')")
          .get(ids.work_item_id) as { count: number } | undefined;
        const activeForItem = this.db
          .prepare("SELECT COUNT(*) AS count FROM activities WHERE work_item_id = ? AND status IN ('claimed', 'running')")
          .get(ids.work_item_id) as { count: number } | undefined;
        const failedForItem = this.db
          .prepare("SELECT COUNT(*) AS count FROM activities WHERE work_item_id = ? AND status = 'failed'")
          .get(ids.work_item_id) as { count: number } | undefined;
        const itemHasFailure = !success || (failedForItem?.count ?? 0) > 0;
        const itemHasPending = (pendingForItem?.count ?? 0) > 0;
        const workItemStatus = itemHasFailure ? "failed" : (itemHasPending ? "running" : "validated");
        const nextAction = itemHasFailure
          ? "inspect_failure"
          : itemHasPending
            ? (activeForItem?.count ?? 0) > 0 ? "resume_activity" : "claim_activity"
            : "operator_handoff";
        this.db
          .prepare("UPDATE work_items SET status = ?, next_action = ?, updated_at = ? WHERE work_item_id = ?")
          .run(workItemStatus, nextAction, now, ids.work_item_id);
      }
      this.insertTrajectoryEvent({
        run_id: ids.run_id,
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: ids.activity_session_id,
        event_type: "activity.completed",
        actor: "merge-god",
        payload: { success, summary, error_message: errorMessage },
      });

      const pending = this.db
        .prepare("SELECT COUNT(*) AS count FROM activities WHERE run_id = ? AND status IN ('ready', 'claimed', 'running')")
        .get(ids.run_id) as { count: number } | undefined;
      if ((pending?.count ?? 0) === 0) {
        const failed = this.db
          .prepare("SELECT COUNT(*) AS count FROM activities WHERE run_id = ? AND status = 'failed'")
          .get(ids.run_id) as { count: number } | undefined;
        const hasFailures = (failed?.count ?? 0) > 0;
        this.db
          .prepare("UPDATE worksets SET status = ?, updated_at = ? WHERE workset_id = ?")
          .run(hasFailures ? "blocked" : "completed", now, ids.workset_id);
        this.db
          .prepare("UPDATE orchestration_runs SET status = ?, current_phase = ?, heartbeat_at = ?, completed_at = ? WHERE run_id = ?")
          .run(hasFailures ? "blocked" : "completed", hasFailures ? "blocked" : "completed", now, now, ids.run_id);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to complete activity: ${String(e)}`);
    }
  }

  /** Record a model-proposed next action for the current work item/activity. */
  proposeNextAction(ids: CompatibilityTrajectoryIds, input: ProposedNextActionInput): void {
    const now = nowIso();
    try {
      this.db.exec("BEGIN");
      if (ids.work_item_id) {
        this.db
          .prepare(
            `
            UPDATE work_items
            SET next_action = ?,
                blockers = ?,
                updated_at = ?
            WHERE work_item_id = ?
            `,
          )
          .run(
            input.next_action,
            stringifyJson(input.blockers ?? []),
            now,
            ids.work_item_id,
          );
      }
      if ((input.evidence_refs ?? []).length > 0) {
        this.db
          .prepare("UPDATE activities SET evidence_refs = ?, updated_at = ? WHERE activity_id = ?")
          .run(stringifyJson(input.evidence_refs ?? []), now, ids.activity_id);
      }
      this.insertTrajectoryEvent({
        run_id: ids.run_id,
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: ids.activity_session_id,
        event_type: "activity.next_action.proposed",
        actor: "pi-agent",
        payload: {
          next_action: input.next_action,
          rationale: input.rationale,
          blockers: input.blockers ?? [],
          evidence_refs: input.evidence_refs ?? [],
        },
      });
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to record proposed next action: ${String(e)}`);
    }
  }

  /** Create a ready child activity under an existing activity. */
  createChildActivity(ids: CompatibilityTrajectoryIds, input: ChildActivityInput): string {
    const now = nowIso();
    const activityId = randomUUID();
    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `
          INSERT INTO activities (
              activity_id, run_id, workset_id, work_item_id, parent_activity_id,
              type, status, model_profile, tool_policy, prompt_runtime_ref,
              context_pack_refs, evidence_refs, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          activityId,
          ids.run_id,
          ids.workset_id || null,
          ids.work_item_id || null,
          ids.activity_id,
          input.type,
          "ready",
          stringifyJson({
            model_tier: input.model_tier,
            model_reason: input.model_reason,
          }),
          stringifyJson({ inherited_from: ids.activity_id }),
          input.prompt_runtime_ref ?? null,
          stringifyJson(input.context_pack_refs ?? []),
          stringifyJson(input.evidence_refs ?? []),
          now,
          now,
          stringifyJson({ summary: input.summary, ...(input.metadata ?? {}) }),
        );
      this.insertTrajectoryEvent({
        run_id: ids.run_id,
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: ids.activity_session_id,
        event_type: "activity.child_created",
        actor: "pi-agent",
        payload: {
          child_activity_id: activityId,
          type: input.type,
          summary: input.summary,
          model_tier: input.model_tier,
          model_reason: input.model_reason,
        },
      });
      this.db.exec("COMMIT");
      return activityId;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to create child activity: ${String(e)}`);
    }
  }

  /** Find the newest unfinished one-shot PR trajectory that can be resumed. */
  findResumableCompatibilityTrajectory(
    repoName: string,
    prNumber: number,
  ): CompatibilityTrajectoryIds | null {
    const row = this.db.prepare(
      `SELECT r.run_id, ws.workset_id, wi.work_item_id, a.activity_id,
              (SELECT activity_session_id FROM activity_sessions s
               WHERE s.activity_id = a.activity_id AND s.completed_at IS NULL
               ORDER BY s.started_at DESC LIMIT 1) AS activity_session_id
       FROM orchestration_runs r
       JOIN worksets ws ON ws.run_id = r.run_id
       JOIN work_items wi ON wi.workset_id = ws.workset_id
       JOIN activities a ON a.run_id = r.run_id AND a.work_item_id = wi.work_item_id
       WHERE r.repo_name = ? AND wi.number = ? AND r.strategy_version = 'compatibility-v1'
         AND r.status IN ('created', 'surveying', 'planning', 'executing', 'waiting')
         AND a.parent_activity_id IS NULL
         AND a.status IN ('created', 'ready', 'claimed', 'running')
       ORDER BY r.started_at DESC, a.created_at
       LIMIT 1`,
    ).get(repoName, prNumber) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      run_id: String(row["run_id"]),
      workset_id: String(row["workset_id"]),
      work_item_id: String(row["work_item_id"]),
      activity_id: String(row["activity_id"]),
      activity_session_id: strOrNull(row["activity_session_id"]),
    };
  }

  resumeCompatibilityTrajectory(
    ids: CompatibilityTrajectoryIds,
    sessionId: string,
    model: string | null = null,
  ): CompatibilityTrajectoryIds {
    const state = this.getTrajectoryState(ids.run_id);
    if (!state?.resume.resumable) throw new DatabaseError(`Trajectory ${ids.run_id} is not resumable`);
    const now = nowIso();
    const activitySessionId = randomUUID();
    const priorSessionId = ids.activity_session_id;
    try {
      this.db.exec("BEGIN");
      this.db.prepare(
        `UPDATE activity_sessions
         SET status = 'interrupted', completed_at = ?, metadata = ?
         WHERE activity_id = ? AND completed_at IS NULL`,
      ).run(now, stringifyJson({ resume_reason: "replacement_session" }), ids.activity_id);
      for (const turnId of state.resume.open_agent_turn_ids) {
        const turn = state.hierarchy.find((record) => record.level === "agent_turn" && record.id === turnId);
        this.insertTrajectoryEvent({
          run_id: ids.run_id,
          workset_id: ids.workset_id,
          work_item_id: ids.work_item_id,
          activity_id: ids.activity_id,
          activity_session_id: priorSessionId,
          event_type: "pi.agent_turn.interrupted",
          actor: "merge-god",
          payload: {
            turn_id: turnId,
            turn_index: turn?.metadata["turn_index"] ?? null,
            reason: "trajectory_resumed",
          },
        });
      }
      for (const callId of state.resume.open_tool_call_ids) {
        const toolCall = state.hierarchy.find((record) => record.level === "tool_call" && record.id === callId);
        this.insertTrajectoryEvent({
          run_id: ids.run_id,
          workset_id: ids.workset_id,
          work_item_id: ids.work_item_id,
          activity_id: ids.activity_id,
          activity_session_id: priorSessionId,
          event_type: "pi.tool_call.incomplete",
          actor: "merge-god",
          payload: {
            call_id: callId,
            turn_id: toolCall?.parent_level === "agent_turn" ? toolCall.parent_id : null,
            tool_name: toolCall?.metadata["tool_name"] ?? null,
            status: "incomplete",
            reason: "trajectory_resumed",
          },
        });
      }
      this.db.prepare(
        `INSERT INTO activity_sessions (
           activity_session_id, activity_id, session_id, model, status, started_at, metadata
         ) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      ).run(
        activitySessionId,
        ids.activity_id,
        sessionId,
        model,
        now,
        stringifyJson({ compatibility_path: true, resumed_from_session_id: priorSessionId }),
      );
      this.db.prepare("UPDATE activities SET status = 'running', completed_at = NULL, updated_at = ? WHERE activity_id = ?")
        .run(now, ids.activity_id);
      this.db.prepare("UPDATE work_items SET status = 'running', next_action = 'resume_agent', updated_at = ? WHERE work_item_id = ?")
        .run(now, ids.work_item_id);
      this.db.prepare("UPDATE worksets SET status = 'active', updated_at = ? WHERE workset_id = ?")
        .run(now, ids.workset_id);
      this.db.prepare(
        "UPDATE orchestration_runs SET status = 'executing', current_phase = 'agent_resumed', heartbeat_at = ?, completed_at = NULL WHERE run_id = ?",
      ).run(now, ids.run_id);
      this.insertTrajectoryEvent({
        run_id: ids.run_id,
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: activitySessionId,
        event_type: "compatibility_trajectory.resumed",
        actor: "merge-god",
        payload: { prior_activity_session_id: priorSessionId, session_id: sessionId, model },
      });
      this.db.exec("COMMIT");
      return { ...ids, activity_session_id: activitySessionId };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to resume compatibility trajectory: ${String(e)}`);
    }
  }

  /** Create a minimal durable trajectory around the current one-shot PR path. */
  createCompatibilityTrajectoryForPr(
    input: CompatibilityTrajectoryInput,
  ): CompatibilityTrajectoryIds {
    if (!input.repo_name) throw new DatabaseError("repo_name is required");
    if (!Number.isInteger(input.pr_number) || input.pr_number <= 0) {
      throw new DatabaseError("pr_number must be a positive integer");
    }

    const runId = randomUUID();
    const worksetId = randomUUID();
    const workItemId = randomUUID();
    const activityId = randomUUID();
    const activitySessionId = input.session_id || input.model ? randomUUID() : null;
    const now = nowIso();
    const title = input.title ?? `PR #${input.pr_number}`;
    const activityType: ActivityType = input.mode === "for-review" ? "review_workflow" : "merge_gate";
    const remediationDecision = resolveRemediationPolicy({
      labels: input.labels,
      work_item_mode: input.disposition_setting,
      repository_mode: input.repository_remediation_mode,
      risk_ceiling: input.risk_remediation_ceiling,
      global_ceiling: input.global_remediation_ceiling,
      maintainer_approval_verified: input.maintainer_approval_verified,
    });

    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `
          INSERT INTO orchestration_runs (
              run_id, repo_name, repo_path, base_branch, strategy_version,
              workflow_ir_refs, status, current_phase, started_at, heartbeat_at,
              objective, operator_policy, model_policy, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          runId,
          input.repo_name,
          input.repo_path ?? null,
          input.base_ref ?? null,
          "compatibility-v1",
          stringifyJson([]),
          "executing",
          "agent_processing",
          now,
          now,
          `Process ${input.repo_name} PR #${input.pr_number}`,
          stringifyJson({
            mode: input.mode,
            remediation_policy: remediationDecision,
          }),
          stringifyJson({ model: input.model ?? null }),
          stringifyJson({ compatibility_path: "run_agent_from_db" }),
        );

      this.db
        .prepare(
          `
          INSERT INTO worksets (
              workset_id, run_id, kind, selection_reason, status,
              approval_state, strategy, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          worksetId,
          runId,
          "pr_queue",
          "Compatibility workset for a single PR agent invocation",
          "active",
          "not_required",
          "one-shot-pr-agent",
          now,
          now,
          stringifyJson({ source: "compatibility" }),
        );

      this.db
        .prepare(
          `
          INSERT INTO work_items (
              work_item_id, workset_id, source_kind, repo_name, number, title,
              url, mode, labels, base_ref, head_ref, start_sha, current_sha,
              status, disposition_setting, priority, model_tier, next_action, blockers,
              risk_signals, context_pack_refs, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          workItemId,
          worksetId,
          "pull_request",
          input.repo_name,
          input.pr_number,
          title,
          input.url ?? null,
          input.mode,
          stringifyJson(input.labels ?? []),
          input.base_ref ?? null,
          input.head_ref ?? null,
          input.current_sha ?? null,
          input.current_sha ?? null,
          "running",
          remediationDecision.effective_mode,
          0,
          input.model ?? null,
          "run_agent",
          stringifyJson(remediationBlockers(remediationDecision)),
          stringifyJson({
            compatibility_path: true,
            remediation_policy: remediationDecision,
          }),
          stringifyJson([]),
          now,
          now,
          stringifyJson({ source: "run_agent_from_db" }),
        );

      this.db
        .prepare(
          `
          INSERT INTO activities (
              activity_id, run_id, workset_id, work_item_id, type, status,
              model_profile, tool_policy, prompt_runtime_ref,
              context_pack_refs, evidence_refs, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          activityId,
          runId,
          worksetId,
          workItemId,
          activityType,
          "running",
          stringifyJson({ model: input.model ?? null }),
          stringifyJson({
            compatibility_path: true,
            remediation_mode: remediationDecision.effective_mode,
            mutating_allowed: remediationModeAllowsMutation(remediationDecision.effective_mode) && !remediationDecision.blocked,
            budget: remediationDecision.budget,
          }),
          null,
          stringifyJson([]),
          stringifyJson([]),
          now,
          now,
          stringifyJson({ mode: input.mode }),
        );

      if (activitySessionId) {
        this.db
          .prepare(
            `
            INSERT INTO activity_sessions (
                activity_session_id, activity_id, session_id, model, status,
                started_at, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            activitySessionId,
            activityId,
            input.session_id ?? null,
            input.model ?? null,
            "running",
            now,
            stringifyJson({ compatibility_path: true }),
          );
      }

      this.insertTrajectoryEvent({
        run_id: runId,
        workset_id: worksetId,
        work_item_id: workItemId,
        activity_id: activityId,
        activity_session_id: activitySessionId,
        event_type: "compatibility_trajectory.started",
        actor: "merge-god",
        payload: {
          repo_name: input.repo_name,
          pr_number: input.pr_number,
          mode: input.mode,
          session_id: input.session_id ?? null,
        },
      });

      this.db.exec("COMMIT");
      return {
        run_id: runId,
        workset_id: worksetId,
        work_item_id: workItemId,
        activity_id: activityId,
        activity_session_id: activitySessionId,
      };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to create compatibility trajectory: ${String(e)}`);
    }
  }

  /** Mark a compatibility trajectory complete and append its terminal event. */
  completeCompatibilityTrajectory(
    ids: CompatibilityTrajectoryIds,
    success: boolean,
    summary: string | null = null,
    errorMessage: string | null = null,
  ): void {
    const now = nowIso();
    const runStatus = success ? "completed" : "failed";
    const activityStatus = success ? "succeeded" : "failed";
    const workItemStatus = success ? "validated" : "failed";

    if (success) {
      const state = this.getTrajectoryState(ids.run_id);
      const openChildren = state?.activities.filter((activity) =>
        activity.activity_id !== ids.activity_id &&
        !["succeeded", "failed", "blocked", "canceled"].includes(activity.status)
      ) ?? [];
      if (openChildren.length > 0) {
        throw new DatabaseError(
          `Cannot complete trajectory ${ids.run_id}; child activities remain open: ${openChildren.map((activity) => activity.activity_id).join(", ")}`,
        );
      }
      if ((state?.resume.open_agent_turn_ids.length ?? 0) > 0 || (state?.resume.open_tool_call_ids.length ?? 0) > 0) {
        throw new DatabaseError(
          `Cannot complete trajectory ${ids.run_id}; agent turns or tool calls remain open`,
        );
      }
    }

    try {
      this.db.exec("BEGIN");
      if (!success) {
        this.db
          .prepare(
            `UPDATE activity_sessions
             SET status = 'canceled', completed_at = COALESCE(completed_at, ?)
             WHERE activity_id IN (
               SELECT activity_id FROM activities
               WHERE run_id = ? AND activity_id != ?
             ) AND completed_at IS NULL`,
          )
          .run(now, ids.run_id, ids.activity_id);
        this.db
          .prepare(
            `UPDATE activities
             SET status = 'canceled', completed_at = COALESCE(completed_at, ?), updated_at = ?
             WHERE run_id = ? AND activity_id != ?
               AND status NOT IN ('succeeded', 'failed', 'blocked', 'canceled')`,
          )
          .run(now, now, ids.run_id, ids.activity_id);
      }
      this.db
        .prepare(
          `
          UPDATE activity_sessions
          SET status = ?, completed_at = ?, metadata = ?
          WHERE activity_session_id = ?
          `,
        )
        .run(
          runStatus,
          now,
          stringifyJson({ summary, error_message: errorMessage }),
          ids.activity_session_id ?? "",
        );

      this.db
        .prepare(
          `
          UPDATE activities
          SET status = ?, output_summary_ref = ?, completed_at = ?, updated_at = ?
          WHERE activity_id = ?
          `,
        )
        .run(activityStatus, summary, now, now, ids.activity_id);

      this.db
        .prepare(
          `
          UPDATE work_items
          SET status = ?, next_action = ?, updated_at = ?
          WHERE work_item_id = ?
          `,
        )
        .run(workItemStatus, success ? "operator_handoff" : "inspect_failure", now, ids.work_item_id);

      this.db
        .prepare(
          `
          UPDATE worksets
          SET status = ?, updated_at = ?
          WHERE workset_id = ?
          `,
        )
        .run(success ? "completed" : "blocked", now, ids.workset_id);

      this.db
        .prepare(
          `
          UPDATE orchestration_runs
          SET status = ?, current_phase = ?, heartbeat_at = ?, completed_at = ?
          WHERE run_id = ?
          `,
        )
        .run(
          runStatus,
          success ? "completed" : "failed",
          now,
          now,
          ids.run_id,
        );

      this.insertTrajectoryEvent({
        run_id: ids.run_id,
        workset_id: ids.workset_id,
        work_item_id: ids.work_item_id,
        activity_id: ids.activity_id,
        activity_session_id: ids.activity_session_id,
        event_type: "compatibility_trajectory.completed",
        actor: "merge-god",
        payload: {
          success,
          summary,
          error_message: errorMessage,
          closeout: {
            run: runStatus,
            workset: success ? "completed" : "blocked",
            work_item: workItemStatus,
            activity: activityStatus,
            activity_session: runStatus,
            descendants: success ? "already_terminal" : "canceled_if_open",
          },
        },
      });

      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; surface the original error below
      }
      throw new DatabaseError(`Failed to complete compatibility trajectory: ${String(e)}`);
    }
  }

  getTrajectoryCloseoutReport(runId: string): TrajectoryCloseoutReport {
    const state = this.getTrajectoryState(runId);
    if (!state) throw new DatabaseError(`Trajectory run not found: ${runId}`);
    const openWorksetIds = state.worksets
      .filter((item) => !["completed", "blocked"].includes(item.status))
      .map((item) => item.workset_id);
    const openWorkItemIds = state.work_items
      .filter((item) => !["validated", "merged", "closed", "skipped", "blocked", "failed"].includes(item.status))
      .map((item) => item.work_item_id);
    const openActivityIds = state.activities
      .filter((item) => !["succeeded", "failed", "blocked", "canceled"].includes(item.status))
      .map((item) => item.activity_id);
    const openActivitySessionIds = state.activity_sessions
      .filter((item) => item.completed_at === null)
      .map((item) => item.activity_session_id);
    const openAgentTurnIds = state.hierarchy
      .filter((item) => item.level === "agent_turn" && item.state === "open")
      .map((item) => item.id);
    const openToolCallIds = state.hierarchy
      .filter((item) => item.level === "tool_call" && item.state === "open")
      .map((item) => item.id);
    const runOpen = !["completed", "blocked", "failed"].includes(state.run.status);
    return {
      run_id: runId,
      complete: !runOpen && openWorksetIds.length === 0 && openWorkItemIds.length === 0 &&
        openActivityIds.length === 0 && openActivitySessionIds.length === 0 &&
        openAgentTurnIds.length === 0 && openToolCallIds.length === 0,
      open_workset_ids: openWorksetIds,
      open_work_item_ids: openWorkItemIds,
      open_activity_ids: openActivityIds,
      open_activity_session_ids: openActivitySessionIds,
      open_agent_turn_ids: openAgentTurnIds,
      open_tool_call_ids: openToolCallIds,
    };
  }

  /** Append a structured trajectory event for a run. */
  appendTrajectoryEvent(
    runId: string,
    eventType: string,
    actor: string,
    payload: JsonObject = {},
    refs: {
      workset_id?: string | null;
      work_item_id?: string | null;
      activity_id?: string | null;
      activity_session_id?: string | null;
    } = {},
  ): string {
    return this.insertTrajectoryEvent({
      run_id: runId,
      workset_id: refs.workset_id ?? null,
      work_item_id: refs.work_item_id ?? null,
      activity_id: refs.activity_id ?? null,
      activity_session_id: refs.activity_session_id ?? null,
      event_type: eventType,
      actor,
      payload,
    });
  }

  /** List recent orchestration runs. */
  getOrchestrationRuns(limit: number = 20): OrchestrationRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseOrchestrationRun(row));
  }

  /** Load the most relevant trajectory for a repository, preferring active runs. */
  getLatestTrajectoryStateForRepo(repoName: string, repoPath: string | null = null): TrajectoryState | null {
    const params: string[] = [repoName];
    let repoPredicate = "repo_name = ?";
    if (repoPath) {
      repoPredicate = `(${repoPredicate} OR repo_path = ?)`;
      params.push(repoPath);
    }

    const row = this.db
      .prepare(
        `
        SELECT run_id
        FROM orchestration_runs
        WHERE ${repoPredicate}
        ORDER BY
          CASE status
            WHEN 'executing' THEN 0
            WHEN 'planning' THEN 1
            WHEN 'surveying' THEN 1
            WHEN 'waiting' THEN 2
            WHEN 'created' THEN 3
            WHEN 'blocked' THEN 4
            WHEN 'failed' THEN 5
            WHEN 'completed' THEN 6
            ELSE 7
          END,
          COALESCE(heartbeat_at, started_at) DESC,
          started_at DESC
        LIMIT 1
        `,
      )
      .get(...params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.getTrajectoryState(String(row["run_id"]));
  }

  /** Load one run with its worksets, work items, activities, sessions, and events. */
  getTrajectoryState(runId: string): TrajectoryState | null {
    const runRow = this.db
      .prepare("SELECT * FROM orchestration_runs WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!runRow) return null;

    const worksets = this.db
      .prepare("SELECT * FROM worksets WHERE run_id = ? ORDER BY created_at, workset_id")
      .all(runId) as Record<string, unknown>[];
    const worksetIds = worksets.map((row) => String(row["workset_id"]));
    const worksetMarks = worksetIds.map(() => "?").join(",");

    const workItems = worksetIds.length > 0
      ? this.db
        .prepare(`SELECT * FROM work_items WHERE workset_id IN (${worksetMarks}) ORDER BY priority, created_at`)
        .all(...worksetIds) as Record<string, unknown>[]
      : [];

    const activities = this.db
      .prepare("SELECT * FROM activities WHERE run_id = ? ORDER BY created_at, activity_id")
      .all(runId) as Record<string, unknown>[];
    const activityIds = activities.map((row) => String(row["activity_id"]));
    const activityMarks = activityIds.map(() => "?").join(",");
    const activitySessions = activityIds.length > 0
      ? this.db
        .prepare(`SELECT * FROM activity_sessions WHERE activity_id IN (${activityMarks}) ORDER BY started_at`)
        .all(...activityIds) as Record<string, unknown>[]
      : [];

    const events = this.db
      .prepare("SELECT * FROM trajectory_events WHERE run_id = ? ORDER BY id")
      .all(runId) as Record<string, unknown>[];

    const run = this.parseOrchestrationRun(runRow);
    const parsedWorksets = worksets.map((row) => this.parseWorkset(row));
    const parsedWorkItems = workItems.map((row) => this.parseWorkItem(row));
    const parsedActivities = activities.map((row) => this.parseActivity(row));
    const parsedSessions = activitySessions.map((row) => this.parseActivitySession(row));
    const parsedEvents = events.map((row) => this.parseTrajectoryEvent(row));
    const hierarchy = this.buildTrajectoryHierarchy(
      run,
      parsedWorksets,
      parsedWorkItems,
      parsedActivities,
      parsedSessions,
      parsedEvents,
    );
    return {
      run,
      worksets: parsedWorksets,
      work_items: parsedWorkItems,
      activities: parsedActivities,
      activity_sessions: parsedSessions,
      events: parsedEvents,
      hierarchy,
      resume: this.buildTrajectoryResumeState(run.run_id, hierarchy, parsedEvents),
    };
  }

  private buildTrajectoryHierarchy(
    run: OrchestrationRunRecord,
    worksets: WorksetRecord[],
    workItems: WorkItemRecord[],
    activities: ActivityRecord[],
    sessions: ActivitySessionRecord[],
    events: TrajectoryEventRecord[],
  ): TrajectoryHierarchyRecord[] {
    const hierarchy: TrajectoryHierarchyRecord[] = [{
      level: "run",
      id: run.run_id,
      parent_level: null,
      parent_id: null,
      state: ["completed"].includes(run.status) ? "closed"
        : run.status === "blocked" ? "blocked"
        : run.status === "failed" ? "failed"
        : "open",
      raw_status: run.status,
      opened_at: run.started_at,
      closed_at: run.completed_at,
      metadata: { current_phase: run.current_phase },
    }];
    for (const workset of worksets) {
      hierarchy.push({
        level: "workset",
        id: workset.workset_id,
        parent_level: "run",
        parent_id: run.run_id,
        state: workset.status === "completed" ? "closed" : workset.status === "blocked" ? "blocked" : "open",
        raw_status: workset.status,
        opened_at: workset.created_at,
        closed_at: ["completed", "blocked"].includes(workset.status) ? workset.updated_at : null,
        metadata: {},
      });
    }
    for (const item of workItems) {
      const state = ["validated", "merged", "closed", "skipped"].includes(item.status) ? "closed"
        : item.status === "blocked" ? "blocked"
        : item.status === "failed" ? "failed"
        : "open";
      hierarchy.push({
        level: "work_item",
        id: item.work_item_id,
        parent_level: "workset",
        parent_id: item.workset_id,
        state,
        raw_status: item.status,
        opened_at: item.created_at,
        closed_at: state === "open" ? null : item.updated_at,
        metadata: { number: item.number, next_action: item.next_action },
      });
    }
    for (const activity of activities) {
      const state = activity.status === "succeeded" ? "closed"
        : activity.status === "blocked" ? "blocked"
        : activity.status === "failed" ? "failed"
        : activity.status === "canceled" ? "canceled"
        : "open";
      hierarchy.push({
        level: "activity",
        id: activity.activity_id,
        parent_level: activity.parent_activity_id ? "activity" : activity.work_item_id ? "work_item" : "run",
        parent_id: activity.parent_activity_id ?? activity.work_item_id ?? run.run_id,
        state,
        raw_status: activity.status,
        opened_at: activity.created_at,
        closed_at: activity.completed_at,
        metadata: { type: activity.type },
      });
    }
    for (const session of sessions) {
      const normalized = session.status.toLowerCase();
      const state = session.completed_at === null ? "open"
        : normalized.includes("fail") || normalized === "interrupted" ? "failed"
        : normalized.includes("block") ? "blocked"
        : normalized.includes("cancel") ? "canceled"
        : "closed";
      hierarchy.push({
        level: "activity_session",
        id: session.activity_session_id,
        parent_level: "activity",
        parent_id: session.activity_id,
        state,
        raw_status: session.status,
        opened_at: session.started_at,
        closed_at: session.completed_at,
        metadata: { session_id: session.session_id, model: session.model },
      });
    }

    const turnNodes = new Map<string, TrajectoryHierarchyRecord>();
    const toolNodes = new Map<string, TrajectoryHierarchyRecord>();
    for (const event of events) {
      const turnId = typeof event.payload["turn_id"] === "string" ? event.payload["turn_id"] : null;
      if (turnId && event.event_type.startsWith("pi.agent_turn.")) {
        const completed = event.event_type.endsWith("completed") || event.event_type.endsWith("interrupted");
        turnNodes.set(turnId, {
          level: "agent_turn",
          id: turnId,
          parent_level: "activity_session",
          parent_id: event.activity_session_id,
          state: event.event_type.endsWith("interrupted") ? "failed" : completed ? "closed" : "open",
          raw_status: event.event_type.slice("pi.agent_turn.".length),
          opened_at: turnNodes.get(turnId)?.opened_at ?? event.created_at,
          closed_at: completed ? event.created_at : null,
          metadata: { turn_index: event.payload["turn_index"] ?? null },
        });
      }
      const callId = typeof event.payload["call_id"] === "string" ? event.payload["call_id"] : null;
      if (callId && event.event_type.startsWith("pi.tool_call.")) {
        const suffix = event.event_type.slice("pi.tool_call.".length);
        const completed = suffix === "completed" || suffix === "incomplete";
        toolNodes.set(callId, {
          level: "tool_call",
          id: callId,
          parent_level: turnId ? "agent_turn" : "activity_session",
          parent_id: turnId ?? event.activity_session_id,
          state: suffix === "incomplete" || event.payload["status"] === "failed" ? "failed" : completed ? "closed" : "open",
          raw_status: String(event.payload["status"] ?? suffix),
          opened_at: toolNodes.get(callId)?.opened_at ?? event.created_at,
          closed_at: completed ? event.created_at : null,
          metadata: { tool_name: event.payload["tool_name"] ?? null },
        });
      }
    }
    hierarchy.push(...turnNodes.values(), ...toolNodes.values());
    return hierarchy;
  }

  private buildTrajectoryResumeState(
    runId: string,
    hierarchy: TrajectoryHierarchyRecord[],
    events: TrajectoryEventRecord[],
  ): TrajectoryResumeState {
    const openIds = (level: TrajectoryHierarchyRecord["level"]): string[] => hierarchy
      .filter((node) => node.level === level && node.state === "open")
      .map((node) => node.id);
    const openActivities = openIds("activity");
    const activeActivity = hierarchy.some((node) =>
      node.level === "activity" && node.state === "open" && ["created", "claimed", "running"].includes(node.raw_status)
    );
    const readyActivity = hierarchy.some((node) =>
      node.level === "activity" && node.state === "open" && node.raw_status === "ready"
    );
    const openRun = hierarchy.some((node) => node.level === "run" && node.state === "open");
    return {
      resumable: openRun && (openActivities.length > 0 || readyActivity),
      next_action: activeActivity ? "resume_activity" : readyActivity ? "claim_activity" : null,
      open_run_id: openRun ? runId : null,
      open_workset_ids: openIds("workset"),
      open_work_item_ids: openIds("work_item"),
      open_activity_ids: openActivities,
      open_activity_session_ids: openIds("activity_session"),
      open_agent_turn_ids: openIds("agent_turn"),
      open_tool_call_ids: openIds("tool_call"),
      last_event_id: events.at(-1)?.event_id ?? null,
    };
  }

  private insertTrajectoryEvent(input: {
    run_id: string;
    workset_id?: string | null;
    work_item_id?: string | null;
    activity_id?: string | null;
    activity_session_id?: string | null;
    event_type: string;
    actor: string;
    payload: JsonObject;
  }): string {
    const eventId = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO trajectory_events (
            event_id, run_id, workset_id, work_item_id, activity_id,
            activity_session_id, event_type, actor, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        eventId,
        input.run_id,
        input.workset_id ?? null,
        input.work_item_id ?? null,
        input.activity_id ?? null,
        input.activity_session_id ?? null,
        input.event_type,
        input.actor,
        stringifyJson(input.payload),
        nowIso(),
      );
    return eventId;
  }

  private parseOrchestrationRun(row: Record<string, unknown>): OrchestrationRunRecord {
    return {
      run_id: String(row["run_id"]),
      repo_name: String(row["repo_name"]),
      repo_path: strOrNull(row["repo_path"]),
      base_branch: strOrNull(row["base_branch"]),
      strategy_version: String(row["strategy_version"]),
      workflow_ir_refs: parseJsonArray<string>(row["workflow_ir_refs"]),
      status: row["status"] as OrchestrationRunRecord["status"],
      current_phase: String(row["current_phase"]),
      started_at: String(row["started_at"]),
      heartbeat_at: strOrNull(row["heartbeat_at"]),
      completed_at: strOrNull(row["completed_at"]),
      objective: strOrNull(row["objective"]),
      operator_policy: parseJsonObject(row["operator_policy"]),
      model_policy: parseJsonObject(row["model_policy"]),
      metadata: parseJsonObject(row["metadata"]),
    };
  }

  private parseWorkset(row: Record<string, unknown>): WorksetRecord {
    return {
      workset_id: String(row["workset_id"]),
      run_id: String(row["run_id"]),
      kind: row["kind"] as WorksetRecord["kind"],
      selection_reason: strOrNull(row["selection_reason"]),
      status: row["status"] as WorksetRecord["status"],
      approval_state: row["approval_state"] as WorksetRecord["approval_state"],
      strategy: strOrNull(row["strategy"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      metadata: parseJsonObject(row["metadata"]),
    };
  }

  private parseWorkItem(row: Record<string, unknown>): WorkItemRecord {
    return {
      work_item_id: String(row["work_item_id"]),
      workset_id: String(row["workset_id"]),
      source_kind: row["source_kind"] as WorkItemRecord["source_kind"],
      repo_name: String(row["repo_name"]),
      number: Number(row["number"]),
      title: String(row["title"]),
      url: strOrNull(row["url"]),
      mode: strOrNull(row["mode"]),
      labels: parseJsonArray<string>(row["labels"]),
      base_ref: strOrNull(row["base_ref"]),
      head_ref: strOrNull(row["head_ref"]),
      start_sha: strOrNull(row["start_sha"]),
      current_sha: strOrNull(row["current_sha"]),
      status: row["status"] as WorkItemRecord["status"],
      disposition_setting: strOrNull(row["disposition_setting"]),
      computed_disposition: strOrNull(row["computed_disposition"]),
      priority: numOrNull(row["priority"]),
      model_tier: strOrNull(row["model_tier"]),
      next_action: strOrNull(row["next_action"]),
      blockers: parseJsonArray<JsonObject>(row["blockers"]),
      risk_signals: parseJsonObject(row["risk_signals"]),
      context_pack_refs: parseJsonArray<string>(row["context_pack_refs"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      metadata: parseJsonObject(row["metadata"]),
    };
  }

  private parseActivity(row: Record<string, unknown>): ActivityRecord {
    return {
      activity_id: String(row["activity_id"]),
      run_id: String(row["run_id"]),
      workset_id: strOrNull(row["workset_id"]),
      work_item_id: strOrNull(row["work_item_id"]),
      parent_activity_id: strOrNull(row["parent_activity_id"]),
      type: row["type"] as ActivityRecord["type"],
      status: row["status"] as ActivityRecord["status"],
      model_profile: parseJsonObject(row["model_profile"]),
      tool_policy: parseJsonObject(row["tool_policy"]),
      prompt_runtime_ref: strOrNull(row["prompt_runtime_ref"]),
      context_pack_refs: parseJsonArray<string>(row["context_pack_refs"]),
      output_summary_ref: strOrNull(row["output_summary_ref"]),
      evidence_refs: parseJsonArray<string>(row["evidence_refs"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      completed_at: strOrNull(row["completed_at"]),
      metadata: parseJsonObject(row["metadata"]),
    };
  }

  private parseActivitySession(row: Record<string, unknown>): ActivitySessionRecord {
    return {
      activity_session_id: String(row["activity_session_id"]),
      activity_id: String(row["activity_id"]),
      session_id: strOrNull(row["session_id"]),
      model: strOrNull(row["model"]),
      prompt_runtime_ref: strOrNull(row["prompt_runtime_ref"]),
      prompt_hash: strOrNull(row["prompt_hash"]),
      tool_set: parseJsonArray<string>(row["tool_set"]),
      status: String(row["status"]),
      started_at: String(row["started_at"]),
      completed_at: strOrNull(row["completed_at"]),
      input_tokens: Number(row["input_tokens"] ?? 0),
      output_tokens: Number(row["output_tokens"] ?? 0),
      total_tokens: Number(row["total_tokens"] ?? 0),
      estimated_cost: Number(row["estimated_cost"] ?? 0),
      output_digest: strOrNull(row["output_digest"]),
      metadata: parseJsonObject(row["metadata"]),
    };
  }

  private parseTrajectoryEvent(row: Record<string, unknown>): TrajectoryEventRecord {
    return {
      id: Number(row["id"]),
      event_id: String(row["event_id"]),
      run_id: String(row["run_id"]),
      workset_id: strOrNull(row["workset_id"]),
      work_item_id: strOrNull(row["work_item_id"]),
      activity_id: strOrNull(row["activity_id"]),
      activity_session_id: strOrNull(row["activity_session_id"]),
      event_type: String(row["event_type"]),
      actor: String(row["actor"]),
      payload: parseJsonObject(row["payload"]),
      created_at: String(row["created_at"]),
    };
  }
}
