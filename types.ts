/**
 * Type definitions for merge-god.
 *
 * Ported from merge_god/types.py. Contains interfaces, enums, and type
 * structures used throughout the application to replace plain `any` dicts.
 */

// ============================================================================
// Enums
// ============================================================================

export enum ProcessingMode {
  FOR_REVIEW = "for-review",
  FOR_LANDING = "for-landing",
}

export enum AgentStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  ABORTED = "aborted",
}

export enum TaskStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum ActionType {
  READ_FILE = "read_file",
  EDIT_FILE = "edit_file",
  LIST_FILES = "list_files",
  RUN_TESTS = "run_tests",
  GIT_COMMIT = "git_commit",
}

export enum ProcessStatus {
  IDLE = "idle",
  RUNNING = "running",
  STOPPED = "stopped",
  ERROR = "error",
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface RepoConfig {
  name: string;
  path: string;
  enabled: boolean;
  tags?: string[];
  watch_issues?: boolean;
}

export interface Config {
  repos: RepoConfig[];
  default_mode?: string;
  model?: string;
  database_path?: string;
}

// ============================================================================
// PR Context Types
// ============================================================================

export interface PRComment {
  id: number;
  author: string;
  body: string;
  created_at: string;
  updated_at?: string;
}

export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line?: number;
  created_at: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface ConflictInfo {
  has_conflicts: boolean;
  conflicting_files: string[];
  conflict_count?: number;
  error?: string;
}

export interface CIStatusInfo {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failed_checks: string[];
}

export interface PRDetails {
  number: number;
  title: string;
  body?: string;
  headRefName: string;
  baseRefName: string;
  author: Record<string, string>;
  isDraft: boolean;
  labels: string[];
  statusCheckRollup?: Record<string, string>[];
}

export interface PRContextDict {
  url: string;
  comments: PRComment[];
  review_comments: ReviewComment[];
  commits: CommitInfo[];
  files: FileChange[];
  conflicts: ConflictInfo;
  ci_status: CIStatusInfo;
  diff: string;
  guidelines?: string;
  commit_examples?: string;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface ActionDetails {
  path?: string;
  pattern?: string;
  changes?: Record<string, string>[];
  message?: string;
  files?: string[];
  test_path?: string;
}

export interface ToolResult {
  success: boolean;
  data?: Record<string, string | number | string[]>;
  error?: string;
}

export interface AgentActionDict {
  type: string;
  details: ActionDetails;
  status: string;
  result?: ToolResult;
}

export interface SessionStats {
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;
  actions_total: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_cost?: number;
}

// ============================================================================
// Event/Log Types
// ============================================================================

export interface LogEvent {
  timestamp: string;
  event: string;
  data: Record<string, string | number | boolean | string[]>;
}

export interface ThinkingEvent {
  type: string; // "thinking"
  content: string;
}

export interface ActionEvent {
  type: string; // "action"
  action: AgentActionDict;
}

export interface ErrorEvent {
  type: string; // "error"
  error: string;
}

// ============================================================================
// Database Types
// ============================================================================

export interface PRSnapshot {
  id: number;
  repo_name: string;
  pr_number: number;
  title: string;
  state: string;
  head_branch: string;
  base_branch: string;
  author: string;
  url: string;
  snapshot_at: string;
  pr_data: string; // JSON
}

export interface AgentSessionRecord {
  id: number;
  repo_name: string;
  pr_number: number;
  session_id: string;
  mode: string;
  model: string;
  agent_version: string;
  status: string;
  started_at: string;
  completed_at?: string;
  success?: boolean;
  error_message?: string;
  tasks_total?: number;
  tasks_completed?: number;
  tasks_failed?: number;
  actions_total?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_cost?: number;
  duration_seconds?: number;
}

export interface FileOperationRecord {
  id: number;
  session_id: string;
  action_id?: number;
  operation_type: string;
  file_path: string;
  file_size?: number;
  lines_added?: number;
  lines_deleted?: number;
  success: boolean;
  error_message?: string;
  timestamp: string;
}

// ============================================================================
// Dashboard Types
// ============================================================================

export interface PRQueueItem {
  number: number;
  title: string;
  author: string;
  labels: string[];
  ci_failing: boolean;
  has_conflicts: boolean;
  draft: boolean;
}

export interface DashboardState {
  prs_processed: number;
  successes: number;
  failures: number;
  iteration: number;
}

export interface ProcessingHistoryItem {
  id: number;
  repo_name: string;
  pr_number: number;
  action_type: string;
  started_at: string;
  completed_at?: string;
  success?: boolean;
  error_message?: string;
  duration_seconds?: number;
}

// ============================================================================
// Validation Types
// ============================================================================

export interface ValidationResult {
  name: string;
  valid: boolean;
  errors: string[];
  note?: string;
  pr_count?: number;
}

export interface ProcessValidationResults {
  process_1: ValidationResult;
  process_2: ValidationResult;
  process_3: ValidationResult;
}

// ============================================================================
// Classes for Complex Structures
// ============================================================================

export interface GitHubCredentials {
  token: string;
  api_url: string;
}

export function createGitHubCredentials(token: string, api_url = "https://api.github.com"): GitHubCredentials {
  return { token, api_url };
}

export interface AgentConfig {
  model: string;
  mode: ProcessingMode;
  repo_path: string;
  session_id: string | null;
  max_retries: number;
  timeout_seconds: number;
}

export function createAgentConfig(opts: {
  model: string;
  mode: ProcessingMode;
  repo_path: string;
  session_id?: string | null;
  max_retries?: number;
  timeout_seconds?: number;
}): AgentConfig {
  return {
    model: opts.model,
    mode: opts.mode,
    repo_path: opts.repo_path,
    session_id: opts.session_id ?? null,
    max_retries: opts.max_retries ?? 3,
    timeout_seconds: opts.timeout_seconds ?? 300,
  };
}

export interface ProcessingMetrics {
  start_time: Date;
  end_time: Date | null;
  total_prs: number;
  processed_prs: number;
  successful: number;
  failed: number;
  skipped: number;
}

export function createProcessingMetrics(start_time: Date): ProcessingMetrics {
  return {
    start_time,
    end_time: null,
    total_prs: 0,
    processed_prs: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
  };
}

export function metricsDurationSeconds(m: ProcessingMetrics): number {
  const end = m.end_time ?? new Date();
  return (end.getTime() - m.start_time.getTime()) / 1000;
}

export function metricsSuccessRate(m: ProcessingMetrics): number {
  if (m.processed_prs === 0) return 0.0;
  return m.successful / m.processed_prs;
}
