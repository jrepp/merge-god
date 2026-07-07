/**
 * Async SQLite store for @merge-god/github-sync.
 *
 * Persists normalized, forge-neutral PR / branch / CI state to a local SQLite
 * database for offline processing. Backed by Node's built-in `node:sqlite`
 * (`DatabaseSync`), which is synchronous under the hood — every public method
 * is still exposed as a `Promise` so the library's public surface is async and
 * a future swap to `node:sqlite/...` worker or a real async driver (e.g.
 * `better-sqlite3` async wrappers, `sql.js`) would not break call sites.
 *
 * Schema mirrors the legacy merge-god `StateDatabase` and the Python
 * `github_sync.SyncStore` (table list, snapshot semantics, JSON
 * blob columns, snake_case column names) while being a fresh implementation
 * scoped to the github-sync library's needs.
 */

import { DatabaseSync } from "node:sqlite";

import {
  createDiffAvailability,
  getPRCiStatus,
  type PullRequest,
  type PRContext,
  type RepositoryState,
} from "./models";

/** Current schema version. Start at "2" (v1→v2 adds project_metadata). */
export const SCHEMA_VERSION = "2";

/** Exception raised for database operation errors. */
export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

/** Exception raised when a schema migration fails. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Pair of PR details + PR context, as returned by `getPrContextForAgent`. */
export type PrContextForAgent = [Record<string, unknown>, Record<string, unknown>];

/** Current time as an ISO-8601 UTC string. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Encode a boolean as a SQLite integer (1/0). */
function b2i(value: boolean): number {
  return value ? 1 : 0;
}

/** Parse a JSON object text, returning the fallback when empty or malformed. */
function loadJsonObject(
  raw: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** Parse a JSON array text, returning the fallback when empty or malformed. */
function loadJsonArray(
  raw: unknown,
  fallback: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (raw === null || raw === undefined) return fallback;
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed as Record<string, unknown>[];
  } catch {
    return fallback;
  }
}

function diffAvailabilityFromContext(ctx: Record<string, unknown>): PRContext["diff_availability"] {
  const diff = (ctx["diff"] as string | undefined) ?? "";
  const fallback = createDiffAvailability({
    available: diff.length > 0,
    source: diff.length > 0 ? "gh-pr-diff" : null,
    size: diff.length,
  }) as unknown as Record<string, unknown>;
  return loadJsonObject(ctx["diff_availability"], fallback) as unknown as PRContext["diff_availability"];
}

/** Coerce any value to a number, treating null/undefined as 0. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  return value as number;
}

/**
 * Async SQLite store for normalized forge data.
 *
 * One `DatabaseSync` is opened in the constructor and held for the lifetime of
 * the instance; call `close()` to release it. Foreign keys are disabled to
 * match Python's `sqlite3` default (the schema's `UNIQUE(repo_name, pr_number,
 * snapshot_time)` style references would be rejected under strict FK
 * enforcement).
 */
export class SyncStore {
  /** Path of the backing SQLite file. */
  readonly dbPath: string;
  private db: DatabaseSync;
  private initialized = false;

  /**
   * Open the backing database. The schema is NOT created here — call
   * `initialize()` (idempotent) before any other operation.
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = OFF;");
  }

  // ------------------------------------------------------------------
  // Schema + migrations
  // ------------------------------------------------------------------

  /**
   * Create the schema if absent, or run pending migrations. Idempotent.
   *
   * @throws {MigrationError} If the on-disk schema is newer than
   *   `SCHEMA_VERSION`, or a migration fails.
   * @throws {DatabaseError} If the underlying SQLite operation fails.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const currentVersion = this.readSchemaVersion();
      if (currentVersion === null) {
        this.createInitialSchema();
        this.writeSchemaVersion(SCHEMA_VERSION);
      } else if (currentVersion === SCHEMA_VERSION) {
        // Already up to date.
      } else if (this.compareVersions(currentVersion, SCHEMA_VERSION) < 0) {
        this.runMigrations(currentVersion, SCHEMA_VERSION);
      } else {
        throw new MigrationError(
          `Database schema version ${currentVersion} is newer than supported ` +
            `version ${SCHEMA_VERSION}. Please upgrade the library.`,
        );
      }
      this.initialized = true;
    } catch (e) {
      if (e instanceof MigrationError) throw e;
      throw new DatabaseError(`initialize() failed: ${(e as Error).message}`);
    }
  }

  /** Release the underlying database connection. */
  async close(): Promise<void> {
    this.db.close();
  }

  /** Read the on-disk schema version, or null if unset. */
  private readSchemaVersion(): string | null {
    const row = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as Record<string, unknown> | undefined;
    const v = row ? row["value"] : null;
    return v === null || v === undefined ? null : String(v);
  }

  /** Persist the schema version (and timestamp). */
  private writeSchemaVersion(version: string): void {
    this.db
      .prepare(
        `
        INSERT INTO schema_meta (key, value, updated_at)
        VALUES ('version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      )
      .run(version, nowIso());
  }

  /** Compare dotted numeric version strings; returns -1, 0, or 1. */
  private compareVersions(a: string, b: string): number {
    const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
    const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return 0;
  }

  /** Create all tables at the latest schema (fresh database). */
  private createInitialSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          default_branch TEXT,
          last_updated TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          head_branch TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          author TEXT,
          url TEXT,
          draft INTEGER DEFAULT 0,
          ci_status TEXT,
          labels TEXT,
          snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(repo_name, pr_number, snapshot_time)
      );

      CREATE TABLE IF NOT EXISTS pr_context (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          pr_data TEXT,
          captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(repo_name, pr_number, captured_at)
      );

      CREATE TABLE IF NOT EXISTS branch_states (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          is_local INTEGER DEFAULT 0,
          is_remote INTEGER DEFAULT 0,
          ahead_by INTEGER DEFAULT 0,
          behind_by INTEGER DEFAULT 0,
          has_pr INTEGER DEFAULT 0,
          pr_number INTEGER,
          needs_sync INTEGER DEFAULT 0,
          snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(repo_name, branch_name, snapshot_time)
      );

      CREATE TABLE IF NOT EXISTS sync_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_name TEXT NOT NULL,
          sync_type TEXT NOT NULL,
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          success INTEGER DEFAULT 0,
          prs_synced INTEGER DEFAULT 0,
          branches_synced INTEGER DEFAULT 0,
          error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS project_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          project_id TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO project_metadata (id, metadata) VALUES (1, '{}');

      CREATE INDEX IF NOT EXISTS idx_pr_repo_number
      ON pull_requests(repo_name, pr_number);

      CREATE INDEX IF NOT EXISTS idx_branch_repo
      ON branch_states(repo_name, branch_name);

      CREATE INDEX IF NOT EXISTS idx_pr_context_repo_pr
      ON pr_context(repo_name, pr_number, captured_at DESC);
    `);
  }

  /**
   * Run migrations from `fromVersion` up to `toVersion`.
   *
   * @throws {MigrationError} If a required migration is missing or fails.
   */
  private runMigrations(fromVersion: string, toVersion: string): void {
    type MigrationFn = () => void;
    const migrations: Record<string, MigrationFn> = {
      "2": () => this.migrateV1ToV2(),
    };

    // Walk each integer step from from+1..to inclusive.
    const from = Number.parseInt(fromVersion, 10);
    const to = Number.parseInt(toVersion, 10);
    for (let v = from + 1; v <= to; v++) {
      const key = String(v);
      const fn = migrations[key];
      if (!fn) {
        throw new MigrationError(`Missing migration for version ${key}`);
      }
      try {
        fn();
        this.writeSchemaVersion(key);
      } catch (e) {
        throw new MigrationError(
          `Migration to version ${key} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  /** v1 → v2: add project_metadata table. */
  private migrateV1ToV2(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          project_id TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO project_metadata (id, metadata) VALUES (1, '{}');
    `);
  }

  // ------------------------------------------------------------------
  // Repository operations
  // ------------------------------------------------------------------

  /** Save or update repository metadata. */
  async saveRepository(
    name: string,
    path: string,
    defaultBranch: string | null = null,
  ): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO repositories (name, path, default_branch, last_updated)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            path = excluded.path,
            default_branch = excluded.default_branch,
            last_updated = excluded.last_updated
        `,
      )
      .run(name, path, defaultBranch, nowIso());
  }

  /** Get repository metadata by name, or null if absent. */
  async getRepository(name: string): Promise<Record<string, unknown> | null> {
    const row = this.db
      .prepare("SELECT * FROM repositories WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  }

  /** Get all known repositories, ordered by name. */
  async getAllRepositories(): Promise<Record<string, unknown>[]> {
    const rows = this.db
      .prepare("SELECT * FROM repositories ORDER BY name")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({ ...row }));
  }

  // ------------------------------------------------------------------
  // Project metadata operations
  // ------------------------------------------------------------------

  /**
   * Get project metadata including project_id and the flexible metadata blob.
   * Returns `{project_id: null, metadata: {}, ...}` when no row exists yet.
   */
  async getProjectMetadata(): Promise<Record<string, unknown>> {
    const row = this.db
      .prepare(
        "SELECT project_id, metadata, created_at, updated_at FROM project_metadata WHERE id = 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        project_id: null,
        metadata: {},
        created_at: null,
        updated_at: null,
      };
    }
    return {
      project_id: row["project_id"] ?? null,
      metadata: loadJsonObject(row["metadata"], {}),
      created_at: row["created_at"] ?? null,
      updated_at: row["updated_at"] ?? null,
    };
  }

  /**
   * Set project ID and/or metadata.
   *
   * @param projectId Optional project identifier; when null the existing
   *   project_id is preserved.
   * @param metadata Optional metadata object (stored as JSON). When `merge` is
   *   true the object is merged into the existing metadata; when false it
   *   replaces it.
   */
  async setProjectMetadata(
    projectId: string | null = null,
    metadata: Record<string, unknown> | null = null,
    merge: boolean = true,
  ): Promise<void> {
    let finalMetadata: Record<string, unknown> = {};
    if (merge && metadata !== null) {
      const existing = (await this.getProjectMetadata())["metadata"] as
        | Record<string, unknown>
        | undefined;
      finalMetadata = { ...(existing ?? {}), ...metadata };
    } else if (metadata !== null) {
      finalMetadata = metadata;
    } else {
      const existing = (await this.getProjectMetadata())["metadata"] as
        | Record<string, unknown>
        | undefined;
      finalMetadata = existing ?? {};
    }

    if (projectId !== null) {
      this.db
        .prepare(
          `
          INSERT INTO project_metadata (id, project_id, metadata, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
              project_id = excluded.project_id,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `,
        )
        .run(projectId, JSON.stringify(finalMetadata), nowIso());
    } else {
      this.db
        .prepare(
          `
          INSERT INTO project_metadata (id, metadata, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `,
        )
        .run(JSON.stringify(finalMetadata), nowIso());
    }
  }

  /** Update a single metadata key (merges with existing). */
  async updateProjectMetadata(
    key: string,
    value: unknown,
  ): Promise<void> {
    const bag: Record<string, unknown> = {};
    bag[key] = value;
    await this.setProjectMetadata(null, bag, true);
  }

  /**
   * Delete a single key from project metadata.
   * @returns True if the key existed and was deleted.
   */
  async deleteProjectMetadataKey(key: string): Promise<boolean> {
    const meta = await this.getProjectMetadata();
    const metadata = meta["metadata"] as Record<string, unknown>;
    if (!(key in metadata)) return false;
    delete metadata[key];
    this.db
      .prepare(
        `
        UPDATE project_metadata
        SET metadata = ?, updated_at = ?
        WHERE id = 1
        `,
      )
      .run(JSON.stringify(metadata), nowIso());
    return true;
  }

  // ------------------------------------------------------------------
  // Pull request snapshot operations
  // ------------------------------------------------------------------

  /** Save a snapshot of a normalized PR's state. */
  async savePrSnapshot(repoName: string, pr: PullRequest): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO pull_requests (
            repo_name, pr_number, title, state, head_branch, base_branch,
            author, url, draft, ci_status, labels, snapshot_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        repoName,
        pr.number,
        pr.title,
        pr.state,
        pr.head_branch,
        pr.base_branch,
        pr.author,
        pr.url,
        b2i(pr.draft),
        getPRCiStatus(pr),
        JSON.stringify(pr.labels),
        nowIso(),
      );
  }

  /** Get the latest snapshot of a specific PR, or null. */
  async getLatestPrSnapshot(
    repoName: string,
    prNumber: number,
  ): Promise<Record<string, unknown> | null> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM pull_requests
        WHERE repo_name = ? AND pr_number = ?
        ORDER BY snapshot_time DESC
        LIMIT 1
        `,
      )
      .get(repoName, prNumber) as Record<string, unknown> | undefined;
    if (!row) return null;
    const data: Record<string, unknown> = { ...row };
    data["labels"] = loadJsonArray(data["labels"], []);
    return data;
  }

  /** Get all active (open) PRs for a repository — latest snapshot per PR. */
  async getActivePrs(repoName: string): Promise<Record<string, unknown>[]> {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM pull_requests p1
        WHERE repo_name = ?
        AND state = 'open'
        AND snapshot_time = (
            SELECT MAX(snapshot_time)
            FROM pull_requests p2
            WHERE p2.repo_name = p1.repo_name
            AND p2.pr_number = p1.pr_number
        )
        ORDER BY pr_number
        `,
      )
      .all(repoName) as Record<string, unknown>[];
    return rows.map((row) => {
      const data: Record<string, unknown> = { ...row };
      data["labels"] = loadJsonArray(data["labels"], []);
      return data;
    });
  }

  /**
   * Get all PR snapshots (latest snapshot per PR), optionally filtered by repo.
   */
  async getAllPrs(
    repoName: string | null = null,
    limit: number = 100,
  ): Promise<Record<string, unknown>[]> {
    let sql: string;
    let params: Array<string | number>;
    if (repoName !== null) {
      sql = `
        SELECT repo_name, pr_number, title, state, head_branch, base_branch,
               author, url, draft, ci_status, labels,
               MAX(snapshot_time) AS snapshot_time
        FROM pull_requests
        WHERE repo_name = ?
        GROUP BY repo_name, pr_number
        ORDER BY pr_number DESC
        LIMIT ?
      `;
      params = [repoName, limit];
    } else {
      sql = `
        SELECT repo_name, pr_number, title, state, head_branch, base_branch,
               author, url, draft, ci_status, labels,
               MAX(snapshot_time) AS snapshot_time
        FROM pull_requests
        GROUP BY repo_name, pr_number
        ORDER BY snapshot_time DESC
        LIMIT ?
      `;
      params = [limit];
    }
    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => {
      const data: Record<string, unknown> = { ...row };
      data["labels"] = loadJsonArray(data["labels"], []);
      return data;
    });
  }

  // ------------------------------------------------------------------
  // PR context operations
  // ------------------------------------------------------------------

  /**
   * Save complete PR context for offline agent invocation.
   *
   * The full PR details + PR context objects are stored as a single JSON blob
   * (`pr_data`) so the normalized shape round-trips losslessly regardless of
   * forge-specific extras. The diff is truncated at 10 MiB to bound DB growth.
   *
   * @throws {TypeError} If inputs are missing/invalid.
   * @throws {DatabaseError} If the save fails.
   */
  async savePrContext(
    repoName: string,
    prNumber: number,
    prDetails: Record<string, unknown>,
    prContext: Record<string, unknown>,
  ): Promise<void> {
    if (!repoName || typeof repoName !== "string") {
      throw new TypeError("repo_name must be a non-empty string");
    }
    if (typeof prNumber !== "number" || prNumber <= 0) {
      throw new TypeError("pr_number must be a positive integer");
    }
    if (typeof prDetails !== "object" || prDetails === null) {
      throw new TypeError("pr_details must be an object");
    }
    if (typeof prContext !== "object" || prContext === null) {
      throw new TypeError("pr_context must be an object");
    }

    const maxDiffSize = 10 * 1024 * 1024;
    const normalized: Record<string, unknown> = { ...prContext };
    const diff = normalized["diff"];
    if (typeof diff === "string" && diff.length > maxDiffSize) {
      normalized["diff"] =
        diff.slice(0, maxDiffSize) +
        `\n\n... [Diff truncated - original size: ${diff.length} bytes]`;
    }

    const payload = JSON.stringify({ pr_details: prDetails, pr_context: normalized });
    try {
      this.db
        .prepare(
          `
          INSERT INTO pr_context (repo_name, pr_number, pr_data, captured_at)
          VALUES (?, ?, ?, ?)
          `,
        )
        .run(repoName, prNumber, payload, nowIso());
    } catch (e) {
      throw new DatabaseError(`Failed to save PR context: ${(e as Error).message}`);
    }
  }

  /**
   * Get the latest complete PR context, parsed back into a `PRContext`-shaped
   * object (merged with the saved PR details), or null if none exists.
   *
   * @throws {TypeError} If inputs are invalid.
   * @throws {DatabaseError} If retrieval fails.
   */
  async getLatestPrContext(
    repoName: string,
    prNumber: number,
  ): Promise<PRContext | null> {
    if (!repoName || typeof repoName !== "string") {
      throw new TypeError("repo_name must be a non-empty string");
    }
    if (typeof prNumber !== "number" || prNumber <= 0) {
      throw new TypeError("pr_number must be a positive integer");
    }

    try {
      const row = this.db
        .prepare(
          `
          SELECT * FROM pr_context
          WHERE repo_name = ? AND pr_number = ?
          ORDER BY captured_at DESC
          LIMIT 1
          `,
        )
        .get(repoName, prNumber) as Record<string, unknown> | undefined;
      if (!row) return null;

      const parsed = loadJsonObject(row["pr_data"], {});
      const ctx = (parsed["pr_context"] as Record<string, unknown> | undefined) ?? {};
      const capturedRaw = row["captured_at"];
      let capturedAt: Date | null = null;
      if (typeof capturedRaw === "string") {
        try {
          capturedAt = new Date(capturedRaw);
        } catch {
          capturedAt = null;
        }
      }
      return {
        repo_name: repoName,
        pr_number: prNumber,
        pr_url: (ctx["pr_url"] as string | undefined) ?? "",
        diff: (ctx["diff"] as string | undefined) ?? "",
        body: (ctx["body"] as string | undefined) ?? "",
        comments: loadJsonArray(ctx["comments"], []),
        review_comments: loadJsonArray(ctx["review_comments"], []),
        commits: loadJsonArray(ctx["commits"], []),
        files: loadJsonArray(ctx["files"], []),
        conflicts: loadJsonObject(ctx["conflicts"], {}),
        ci_status: loadJsonObject(ctx["ci_status"], {}),
        diff_availability: diffAvailabilityFromContext(ctx),
        merge_blockers: loadJsonArray(ctx["merge_blockers"], []) as unknown as PRContext["merge_blockers"],
        queue_context: (ctx["queue_context"] as PRContext["queue_context"] | undefined) ?? null,
        guidelines: (ctx["guidelines"] as string | undefined) ?? "",
        commit_examples: (ctx["commit_examples"] as string | undefined) ?? "",
        captured_at: capturedAt,
      };
    } catch (e) {
      throw new DatabaseError(
        `Failed to retrieve PR context: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Get all latest PR contexts, optionally filtered by repo. One row per PR
   * (the most recently captured context).
   */
  async getAllPrContexts(repoName: string | null = null): Promise<PRContext[]> {
    let sql: string;
    let params: string[];
    if (repoName !== null) {
      sql = `
        SELECT * FROM pr_context pc1
        WHERE repo_name = ?
        AND captured_at = (
            SELECT MAX(captured_at)
            FROM pr_context pc2
            WHERE pc2.repo_name = pc1.repo_name
            AND pc2.pr_number = pc1.pr_number
        )
        ORDER BY pr_number
      `;
      params = [repoName];
    } else {
      sql = `
        SELECT * FROM pr_context pc1
        WHERE captured_at = (
            SELECT MAX(captured_at)
            FROM pr_context pc2
            WHERE pc2.repo_name = pc1.repo_name
            AND pc2.pr_number = pc1.pr_number
        )
        ORDER BY repo_name, pr_number
      `;
      params = [];
    }
    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];

    const results: PRContext[] = [];
    for (const row of rows) {
      const parsed = loadJsonObject(row["pr_data"], {});
      const ctx = (parsed["pr_context"] as Record<string, unknown> | undefined) ?? {};
      const capturedRaw = row["captured_at"];
      let capturedAt: Date | null = null;
      if (typeof capturedRaw === "string") {
        try {
          capturedAt = new Date(capturedRaw);
        } catch {
          capturedAt = null;
        }
      }
      results.push({
        repo_name: (row["repo_name"] as string) ?? "",
        pr_number: toNumber(row["pr_number"]),
        pr_url: (ctx["pr_url"] as string | undefined) ?? "",
        diff: (ctx["diff"] as string | undefined) ?? "",
        body: (ctx["body"] as string | undefined) ?? "",
        comments: loadJsonArray(ctx["comments"], []),
        review_comments: loadJsonArray(ctx["review_comments"], []),
        commits: loadJsonArray(ctx["commits"], []),
        files: loadJsonArray(ctx["files"], []),
        conflicts: loadJsonObject(ctx["conflicts"], {}),
        ci_status: loadJsonObject(ctx["ci_status"], {}),
        diff_availability: diffAvailabilityFromContext(ctx),
        merge_blockers: loadJsonArray(ctx["merge_blockers"], []) as unknown as PRContext["merge_blockers"],
        queue_context: (ctx["queue_context"] as PRContext["queue_context"] | undefined) ?? null,
        guidelines: (ctx["guidelines"] as string | undefined) ?? "",
        commit_examples: (ctx["commit_examples"] as string | undefined) ?? "",
        captured_at: capturedAt,
      });
    }
    return results;
  }

  /**
   * Get PR details + context in the shape merge-god's agent expects. Falls back
   * to the latest PR snapshot when the stored `pr_details` blob is missing core
   * fields.
   *
   * @returns Tuple of `[prDetails, prContext]`, or null if no context exists.
   * @throws {DatabaseError} If retrieval fails.
   */
  async getPrContextForAgent(
    repoName: string,
    prNumber: number,
  ): Promise<PrContextForAgent | null> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM pr_context
        WHERE repo_name = ? AND pr_number = ?
        ORDER BY captured_at DESC
        LIMIT 1
        `,
      )
      .get(repoName, prNumber) as Record<string, unknown> | undefined;
    if (!row) return null;

    const parsed = loadJsonObject(row["pr_data"], {});
    const savedDetails = (parsed["pr_details"] as Record<string, unknown> | undefined) ?? {};
    const savedContext = (parsed["pr_context"] as Record<string, unknown> | undefined) ?? {};

    // Backfill/normalize pr_details against the latest snapshot row.
    const snapshot = await this.getLatestPrSnapshot(repoName, prNumber);
    const prDetails: Record<string, unknown> = {
      number: savedDetails["number"] ?? snapshot?.["pr_number"] ?? prNumber,
      title: savedDetails["title"] ?? snapshot?.["title"] ?? "",
      body: savedDetails["body"] ?? "",
      headRefName:
        savedDetails["headRefName"] ??
        savedDetails["head_branch"] ??
        snapshot?.["head_branch"] ??
        "",
      baseRefName:
        savedDetails["baseRefName"] ??
        savedDetails["base_branch"] ??
        snapshot?.["base_branch"] ??
        "",
      author:
        savedDetails["author"] ??
        (snapshot?.["author"]
          ? { login: snapshot["author"] as string }
          : { login: "unknown" }),
      labels: savedDetails["labels"] ?? snapshot?.["labels"] ?? [],
      reviewDecision: savedDetails["reviewDecision"] ?? null,
    };

    const prContext: Record<string, unknown> = {
      url: savedContext["url"] ?? savedContext["pr_url"] ?? "",
      diff: savedContext["diff"] ?? "",
      comments: savedContext["comments"] ?? [],
      review_comments: savedContext["review_comments"] ?? [],
      commits: savedContext["commits"] ?? [],
      files: savedContext["files"] ?? [],
      conflicts: savedContext["conflicts"] ?? {},
      ci_status: savedContext["ci_status"] ?? {},
      guidelines: savedContext["guidelines"] ?? "",
      commit_examples: savedContext["commit_examples"] ?? "",
    };

    return [prDetails, prContext];
  }

  // ------------------------------------------------------------------
  // Branch state operations
  // ------------------------------------------------------------------

  /** Save a single branch state snapshot. */
  async saveBranchState(
    repoName: string,
    branchName: string,
    isLocal: boolean = false,
    isRemote: boolean = false,
    aheadBy: number = 0,
    behindBy: number = 0,
    hasPr: boolean = false,
    prNumber: number | null = null,
    needsSync: boolean = false,
  ): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO branch_states (
            repo_name, branch_name, is_local, is_remote,
            ahead_by, behind_by, has_pr, pr_number, needs_sync, snapshot_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        repoName,
        branchName,
        b2i(isLocal),
        b2i(isRemote),
        aheadBy,
        behindBy,
        b2i(hasPr),
        prNumber,
        b2i(needsSync),
        nowIso(),
      );
  }

  /** Save a full repository state snapshot (repository + branches + PRs). */
  async saveRepositoryState(
    repoName: string,
    repoState: RepositoryState,
  ): Promise<void> {
    const snapshotTime = nowIso();

    const repoStmt = this.db.prepare(
      `
      INSERT INTO repositories (name, path, default_branch, last_updated)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
          path = excluded.path,
          default_branch = excluded.default_branch,
          last_updated = excluded.last_updated
      `,
    );
    const branchStmt = this.db.prepare(
      `
      INSERT INTO branch_states (
          repo_name, branch_name, is_local, is_remote,
          ahead_by, behind_by, has_pr, pr_number, needs_sync, snapshot_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const prStmt = this.db.prepare(
      `
      INSERT INTO pull_requests (
          repo_name, pr_number, title, state, head_branch, base_branch,
          author, url, draft, ci_status, labels, snapshot_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    repoStmt.run(repoName, repoState.repo_path, repoState.default_branch, snapshotTime);

    for (const branchState of repoState.branch_pr_states) {
      const localBranch = branchState.local_branch;
      branchStmt.run(
        repoName,
        branchState.branch_name,
        b2i(Boolean(localBranch)),
        b2i(Boolean(branchState.remote_branch)),
        localBranch ? localBranch.ahead_by : 0,
        localBranch ? localBranch.behind_by : 0,
        b2i(branchState.has_pr),
        branchState.pr ? branchState.pr.number : null,
        b2i(branchState.needs_push || branchState.needs_pull),
        snapshotTime,
      );

      const pr = branchState.pr;
      if (pr) {
        prStmt.run(
          repoName,
          pr.number,
          pr.title,
          pr.state,
          pr.head_branch,
          pr.base_branch,
          pr.author,
          pr.url,
          b2i(pr.draft),
          getPRCiStatus(pr),
          JSON.stringify(pr.labels),
          snapshotTime,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Sync history operations
  // ------------------------------------------------------------------

  /**
   * Record the start of a sync operation.
   * @returns The new sync_history row id.
   */
  async recordSyncStart(
    repoName: string,
    syncType: string = "full",
  ): Promise<number> {
    const result = this.db
      .prepare(
        `
        INSERT INTO sync_history (repo_name, sync_type, started_at)
        VALUES (?, ?, ?)
        `,
      )
      .run(repoName, syncType, nowIso());
    return Number(result.lastInsertRowid);
  }

  /** Record the completion of a sync operation. */
  async recordSyncComplete(
    recordId: number,
    success: boolean,
    prsSynced: number | null = null,
    branchesSynced: number | null = null,
    errorMessage: string | null = null,
  ): Promise<void> {
    this.db
      .prepare(
        `
        UPDATE sync_history
        SET completed_at = ?,
            success = ?,
            error_message = ?,
            prs_synced = ?,
            branches_synced = ?
        WHERE id = ?
        `,
      )
      .run(
        nowIso(),
        b2i(success),
        errorMessage,
        prsSynced ?? 0,
        branchesSynced ?? 0,
        recordId,
      );
  }

  /** Read recent sync_history rows (newest first), optionally filtered by repo. */
  async getSyncHistory(
    repoName?: string | null,
    limit = 50,
  ): Promise<Record<string, unknown>[]> {
    if (repoName) {
      return this.db
        .prepare(
          `SELECT id, repo_name, sync_type, started_at, completed_at, success, prs_synced, branches_synced, error_message
           FROM sync_history WHERE repo_name = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(repoName, limit) as Record<string, unknown>[];
    }
    return this.db
      .prepare(
        `SELECT id, repo_name, sync_type, started_at, completed_at, success, prs_synced, branches_synced, error_message
         FROM sync_history ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
  }

  // ------------------------------------------------------------------
  // Maintenance / introspection
  // ------------------------------------------------------------------

  /**
   * Remove snapshots older than `days` days from `pull_requests`,
   * `branch_states`, and `pr_context`.
   * @returns Total number of records deleted.
   */
  async cleanupOldSnapshots(days: number = 30): Promise<number> {
    const cutoff = Date.now() / 1000 - days * 86400;
    const prResult = this.db
      .prepare(
        `DELETE FROM pull_requests WHERE snapshot_time < datetime(?, 'unixepoch')`,
      )
      .run(cutoff);
    const branchResult = this.db
      .prepare(
        `DELETE FROM branch_states WHERE snapshot_time < datetime(?, 'unixepoch')`,
      )
      .run(cutoff);
    const contextResult = this.db
      .prepare(
        `DELETE FROM pr_context WHERE captured_at < datetime(?, 'unixepoch')`,
      )
      .run(cutoff);
    return (
      Number(prResult.changes) +
      Number(branchResult.changes) +
      Number(contextResult.changes)
    );
  }

  /** Get overall database statistics. */
  async getStatistics(): Promise<Record<string, unknown>> {
    const stats: Record<string, unknown> = {};

    stats["schema_version"] = this.readSchemaVersion();

    const projectRow = this.db
      .prepare("SELECT project_id FROM project_metadata WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    stats["project_id"] = projectRow ? projectRow["project_id"] : null;

    const repoRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM repositories")
      .get() as Record<string, unknown>;
    stats["repositories"] = repoRow["count"];

    const prRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM pull_requests")
      .get() as Record<string, unknown>;
    stats["pr_snapshots"] = prRow["count"];

    const ctxRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM pr_context")
      .get() as Record<string, unknown>;
    stats["pr_contexts"] = ctxRow["count"];

    const branchRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM branch_states")
      .get() as Record<string, unknown>;
    stats["branch_snapshots"] = branchRow["count"];

    const successRow = this.db
      .prepare(
        `
        SELECT
            SUM(success) AS successes,
            COUNT(*) AS total
        FROM sync_history
        WHERE completed_at IS NOT NULL
        `,
      )
      .get() as Record<string, unknown>;
    const total = toNumber(successRow["total"]);
    if (total > 0) {
      const successes = toNumber(successRow["successes"]);
      stats["sync_success_rate"] = Math.round((successes / total) * 10000) / 100;
    } else {
      stats["sync_success_rate"] = 0.0;
    }

    const sizeRow = this.db
      .prepare(
        "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()",
      )
      .get() as Record<string, unknown>;
    stats["database_size_bytes"] = sizeRow["size"];

    return stats;
  }

  /** Get schema version + migration status. */
  async getSchemaInfo(): Promise<Record<string, unknown>> {
    const current = this.readSchemaVersion();
    const currentNum = current !== null ? this.compareVersions(current, SCHEMA_VERSION) : -1;
    return {
      current_version: current,
      latest_version: SCHEMA_VERSION,
      needs_migration: current === null ? false : currentNum < 0,
      is_newer: current !== null && currentNum > 0,
    };
  }
}
