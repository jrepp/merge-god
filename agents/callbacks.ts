/**
 * Callback implementations for agent event handling.
 *
 * Ported from agents/callbacks.py. Provides callback implementations for
 * different contexts (logging, notifications, dashboard updates, etc.).
 *
 * Note: claude_agent.ts is not yet ported, so the {@link AgentAction} and
 * {@link AgentCallbacks} types are defined here and re-exported. Once
 * claude_agent.ts is ported, those definitions should move there and this
 * module should import them instead.
 */

import { appendFileSync } from "node:fs";

/**
 * Represents a single action taken by the agent.
 *
 * Mirrors the consumed fields of the AgentAction dataclass from
 * claude_agent.py.
 */
export interface AgentAction {
  type: string;
  target: string;
  details: Record<string, unknown>;
  status: string;
  timestamp: Date;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** Protocol for agent callbacks (mirrors the Python typing.Protocol). */
export interface AgentCallbacks {
  onThinking(content: string): void;
  onAction(action: AgentAction): void;
  onProgress(current: number, total: number): void;
  onError(error: Error): boolean;
}

/** Structured JSON logger callback signature. */
export type LogJsonFn = (event: string, data: Record<string, unknown>) => void;

/** Notification sender callback signature. */
export type SendNotificationFn = (
  title: string,
  body: string | null,
  channel: string,
  tags: string[] | null,
) => boolean;

/** A single action recorded by {@link LoggingCallbacks}. */
export interface LoggedEvent {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

/** Structural type of the dashboard monitor consumed by DashboardCallbacks. */
export interface DashboardMonitor {
  current_agent_invocation: {
    thinking_content?: string;
    actions: AgentAction[];
    progress: [number, number];
  } | null;
  logs: string[];
  current_action: string;
  status: string;
}

/** Synchronously block for `ms` milliseconds (mirrors Python time.sleep). */
function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Callbacks for PR processing events.
 *
 * Integrates with pr-loop's logging and notification systems.
 */
export class PRProcessingCallbacks implements AgentCallbacks {
  readonly pr_number: number;
  readonly log_json: LogJsonFn;
  readonly send_notification: SendNotificationFn | null;
  readonly max_retries: number;
  current_task: string | null;
  current_task_start: Date | null;
  action_count: number;
  retry_count: number;
  error_count: number;
  task_count: number;

  constructor(
    pr_number: number,
    log_json: LogJsonFn,
    send_notification: SendNotificationFn | null = null,
    max_retries: number = 3,
  ) {
    this.pr_number = pr_number;
    this.log_json = log_json;
    this.send_notification = send_notification;
    this.current_task = null;
    this.current_task_start = null;
    this.action_count = 0;
    this.max_retries = max_retries;
    this.retry_count = 0;
    this.error_count = 0;
    this.task_count = 0;
  }

  /** Called when the agent is thinking/planning. */
  onThinking(content: string): void {
    if (content.length > 50) {
      this.log_json("agent_thinking", {
        pr_number: this.pr_number,
        task: this.current_task,
        content: content.slice(0, 100) + "...",
        full_length: content.length,
      });
    }
  }

  /** Called when the agent takes an action. */
  onAction(action: AgentAction): void {
    this.action_count += 1;

    this.log_json("agent_action", {
      pr_number: this.pr_number,
      action_number: this.action_count,
      action_type: action.type,
      target: action.target,
      status: action.status,
      timestamp: action.timestamp.toISOString(),
    });

    if (action.type === "git_commit" || action.type === "gh_comment" || action.type === "merge_pr") {
      if (this.send_notification) {
        this.send_notification(
          `PR #${this.pr_number}: ${action.type}`,
          `Agent performed ${action.type} on ${action.target}`,
          "default",
          action.status === "completed" ? ["robot", "white_check_mark"] : ["robot", "warning"],
        );
      }
    }
  }

  /** Called with progress updates. */
  onProgress(current: number, total: number): void {
    const percentage = total > 0 ? (current / total) * 100 : 0;

    this.log_json("agent_progress", {
      pr_number: this.pr_number,
      current,
      total,
      percentage: Math.round(percentage * 10) / 10,
    });
  }

  /**
   * Called on error.
   *
   * Implements retry logic for transient errors with exponential backoff.
   * Returns true to continue/retry, false to abort.
   */
  onError(error: Error): boolean {
    this.error_count += 1;
    const errorType = error.constructor.name;
    const errorMsg = String(error);

    const transientErrors = [
      "RateLimitError",
      "APIConnectionError",
      "APITimeoutError",
      "ServiceUnavailableError",
      "InternalServerError",
      "ConnectionError",
      "Timeout",
    ];

    const isTransient = transientErrors.some((err) => errorType.includes(err));
    const shouldRetry = isTransient && this.retry_count < this.max_retries;

    this.log_json("agent_error", {
      pr_number: this.pr_number,
      task: this.current_task,
      error: errorMsg,
      error_type: errorType,
      action_count: this.action_count,
      error_count: this.error_count,
      retry_count: this.retry_count,
      is_transient: isTransient,
      will_retry: shouldRetry,
    });

    if (shouldRetry) {
      this.retry_count += 1;
      const backoffDelay = Math.min(2 ** this.retry_count, 32);

      this.log_json("agent_retry", {
        pr_number: this.pr_number,
        task: this.current_task,
        retry_attempt: this.retry_count,
        max_retries: this.max_retries,
        backoff_seconds: backoffDelay,
      });

      if (this.send_notification) {
        this.send_notification(
          `PR #${this.pr_number}: Retrying after error`,
          `Attempt ${this.retry_count}/${this.max_retries}, waiting ${backoffDelay}s`,
          "default",
          ["warning", "arrows_counterclockwise"],
        );
      }

      sleepSync(backoffDelay * 1000);
      return true;
    }

    this.log_json("agent_abort", {
      pr_number: this.pr_number,
      task: this.current_task,
      reason: isTransient ? "max_retries_exceeded" : "permanent_error",
      total_errors: this.error_count,
      total_retries: this.retry_count,
    });

    if (this.send_notification) {
      const reason = isTransient
        ? `Max retries (${this.max_retries}) exceeded`
        : "Permanent error";
      this.send_notification(
        `PR #${this.pr_number}: Agent Aborted`,
        `${reason}: ${errorMsg.slice(0, 100)}`,
        "high",
        ["x", "warning"],
      );
    }

    return false;
  }
}

/**
 * Callbacks for dashboard monitoring.
 *
 * Integrates with dashboard's RepoMonitor to show real-time agent activity in
 * the TUI.
 */
export class DashboardCallbacks implements AgentCallbacks {
  readonly monitor: DashboardMonitor;

  constructor(monitor: DashboardMonitor) {
    this.monitor = monitor;
  }

  /** Update dashboard with agent thinking. */
  onThinking(content: string): void {
    if (this.monitor.current_agent_invocation) {
      this.monitor.current_agent_invocation.thinking_content = content.slice(0, 200);
    }

    this.monitor.logs.push(`🤖 Thinking: ${content.slice(0, 60)}...`);
  }

  /** Update dashboard with agent action. */
  onAction(action: AgentAction): void {
    if (this.monitor.current_agent_invocation) {
      this.monitor.current_agent_invocation.actions.push(action);
    }

    const actionEmoji: Record<string, string> = {
      read_file: "📖",
      edit_file: "✏️",
      run_tests: "🧪",
      git_commit: "💾",
      gh_comment: "💬",
    };
    const statusEmoji: Record<string, string> = {
      executing: "⏳",
      completed: "✅",
      failed: "❌",
    };

    const ae = actionEmoji[action.type] ?? "⚙️";
    const se = statusEmoji[action.status] ?? "❓";

    this.monitor.logs.push(`${ae} ${se} ${action.type}: ${action.target.slice(0, 40)}`);
  }

  /** Update dashboard with progress. */
  onProgress(current: number, total: number): void {
    if (this.monitor.current_agent_invocation) {
      this.monitor.current_agent_invocation.progress = [current, total];
    }

    const percentage = total > 0 ? (current / total) * 100 : 0;
    this.monitor.current_action = `Progress: ${current}/${total} (${percentage.toFixed(0)}%)`;
  }

  /** Handle error in dashboard. Always aborts. */
  onError(error: Error): boolean {
    const msg = String(error);
    this.monitor.logs.push(`❌ Error: ${msg.slice(0, 60)}...`);

    this.monitor.status = "error";
    this.monitor.current_action = `Error: ${msg.slice(0, 40)}...`;

    return false;
  }
}

/**
 * Composite callback that forwards to multiple callback implementations.
 *
 * Useful when you want both logging AND dashboard updates.
 */
export class CompositeCallbacks implements AgentCallbacks {
  readonly callbacks: AgentCallbacks[];

  constructor(...callbacks: AgentCallbacks[]) {
    this.callbacks = callbacks;
  }

  onThinking(content: string): void {
    for (const callback of this.callbacks) {
      callback.onThinking(content);
    }
  }

  onAction(action: AgentAction): void {
    for (const callback of this.callbacks) {
      callback.onAction(action);
    }
  }

  onProgress(current: number, total: number): void {
    for (const callback of this.callbacks) {
      callback.onProgress(current, total);
    }
  }

  /** Return true only if ALL callbacks say continue. */
  onError(error: Error): boolean {
    const results = this.callbacks.map((callback) => callback.onError(error));
    return results.every((r) => r);
  }
}

/** Simple logging-only callbacks for testing and debugging. */
export class LoggingCallbacks implements AgentCallbacks {
  readonly log_file: string | null;
  readonly events: LoggedEvent[];

  constructor(log_file: string | null = null) {
    this.log_file = log_file;
    this.events = [];
  }

  /** Log an event. */
  private log(event_type: string, data: Record<string, unknown>): void {
    const event: LoggedEvent = {
      timestamp: new Date().toISOString(),
      type: event_type,
      data,
    };
    this.events.push(event);

    console.log(`[${event_type}] ${JSON.stringify(data)}`);

    if (this.log_file) {
      appendFileSync(this.log_file, JSON.stringify(event) + "\n", "utf8");
    }
  }

  onThinking(content: string): void {
    this.log("thinking", { content: content.slice(0, 100) });
  }

  onAction(action: AgentAction): void {
    this.log("action", {
      type: action.type,
      target: action.target,
      status: action.status,
    });
  }

  onProgress(current: number, total: number): void {
    this.log("progress", { current, total });
  }

  onError(error: Error): boolean {
    this.log("error", { error: String(error), type: error.constructor.name });
    return false;
  }
}
