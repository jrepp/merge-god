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

import { DatabaseSync } from "node:sqlite";

export class DatabaseError extends Error {}

/** Current time as an ISO-8601 UTC string (mirrors `datetime.now(UTC).isoformat()`). */
function nowIso(): string {
  return new Date().toISOString();
}

/** Encode a boolean as a SQLite integer (1/0). */
function b2i(value: boolean): number {
  return value ? 1 : 0;
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
}
