/**
 * Agent Results Evaluation Script.
 *
 * Comprehensive evaluation of agent session performance and quality. Ported
 * from evaluate_agent_results.py. Renders a rich-style report (tables, trees,
 * panels) using chalk + console.log instead of the Python `rich` library.
 *
 * Usage:
 *   # Evaluate latest session
 *   tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --latest
 *
 *   # Evaluate specific session
 *   tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --session abc123
 *
 *   # Compare multiple sessions
 *   tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --compare
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { AppStore } from "./app_store";

/** Left-pad a number to 2 digits with leading zeros. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format an ISO timestamp as "YYYY-MM-DD HH:MM:SS" (UTC, mirroring Python strftime). */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** Format an ISO timestamp as "MM/DD HH:MM" (UTC). */
function formatShortDateTime(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return (
    `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

/** Format an ISO timestamp as "HH:MM:SS" (UTC). */
function formatTime(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Format a duration (in seconds) in human-readable form. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "N/A";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Format a monetary cost with 4 decimal places. */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "N/A";
  return `$${cost.toFixed(4)}`;
}

/** Format an integer token count with thousands separators; falsy values render "N/A". */
function formatTokens(n: unknown): string {
  if (!n) return "N/A";
  return new Intl.NumberFormat("en-US").format(n as number);
}

/** Coerce an unknown DB value to its truthy boolean (handles 0/1 ints from SQLite). */
function truthy(v: unknown): boolean {
  return Boolean(v);
}

/** Coerce an unknown DB numeric value to a number, defaulting to 0. */
function num(v: unknown): number {
  return (v as number | null | undefined) ?? 0;
}

/** Coerce an unknown DB string value to a string, defaulting to "". */
function str(v: unknown): string {
  return (v as string | null | undefined) ?? "";
}

/** Cell color style options (mirrors rich column `style`). */
type CellStyle = "cyan" | "white" | "green" | "red" | "dim" | null;

/** Column alignment. */
type Align = "left" | "right" | "center";

/** Column specification for the table renderer. */
interface Column {
  header: string;
  align?: Align;
  style?: CellStyle;
}

/** Apply a chalk color style to a cell string. */
function styleCell(text: string, style: CellStyle): string {
  switch (style) {
    case "cyan":
      return chalk.cyan(text);
    case "white":
      return chalk.white(text);
    case "green":
      return chalk.green(text);
    case "red":
      return chalk.red(text);
    case "dim":
      return chalk.dim(text);
    default:
      return text;
  }
}

/**
 * Render a simple aligned text table (rich Table replacement).
 *
 * Column widths are computed from the plain (uncolored) cell values so that
 * ANSI color codes do not skew alignment. The column `style` is applied to each
 * cell at render time.
 */
function renderTable(
  title: string,
  columns: Column[],
  rows: string[][],
  showHeader: boolean = true,
): void {
  console.log();
  console.log(chalk.bold(title));

  const widths = columns.map((col, i) => {
    let w = col.header.length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const sep = "  ";

  const pad = (cell: string, i: number): string => {
    const align = columns[i]?.align ?? "left";
    const w = widths[i]!;
    if (align === "right") return cell.padStart(w);
    if (align === "center") {
      const total = w - cell.length;
      if (total <= 0) return cell;
      const left = Math.floor(total / 2);
      return " ".repeat(left) + cell + " ".repeat(total - left);
    }
    return cell.padEnd(w);
  };

  const colorize = (cell: string, i: number): string =>
    styleCell(cell, columns[i]?.style ?? null);

  if (showHeader) {
    console.log(columns.map((c, i) => chalk.bold(pad(c.header, i))).join(sep));
    const lineLen =
      widths.reduce((a, w) => a + w, 0) + sep.length * Math.max(columns.length - 1, 0);
    console.log(chalk.dim("-".repeat(lineLen)));
  }

  for (const row of rows) {
    console.log(columns.map((_, i) => colorize(pad(row[i] ?? "", i), i)).join(sep));
  }
}

/** Evaluation metrics returned by `evaluateSession`. */
export interface SessionEvaluation {
  session_id: string;
  success: boolean;
  completion_rate: number;
  total_tokens: number | null;
  estimated_cost: number | null;
  duration_seconds: number | null;
  error_count: number;
}

/**
 * Evaluate a single agent session and print a full report.
 *
 * Returns the evaluation metrics object, or an empty object when the session
 * cannot be found.
 */
export function evaluateSession(
  db: AppStore,
  sessionId: string,
  verbose: boolean = false,
): SessionEvaluation | Record<string, never> {
  void verbose;
  const session = db.getSessionDetails(sessionId);
  if (!session) {
    console.log(chalk.red(`✗ Session not found: ${sessionId}`));
    return {};
  }

  console.log(`\n${chalk.bold.cyan(`Session Evaluation: ${sessionId.slice(0, 8)}...`)}`);

  const infoRows: string[][] = [
    ["Repository", str(session["repo_name"])],
    ["PR Number", String(session["pr_number"])],
    ["Mode", str(session["mode"])],
    ["Status", str(session["status"])],
    ["Success", truthy(session["success"]) ? "✅ Yes" : "❌ No"],
    ["Model", str(session["model"]) || "N/A"],
    ["Started", formatDateTime(session["started_at"] as string | null | undefined)],
    ["Completed", formatDateTime(session["completed_at"] as string | null | undefined)],
    ["Duration", formatDuration(session["duration_seconds"] as number | null | undefined)],
  ];
  renderTable(
    "Session Information",
    [
      { header: "Field", style: "cyan" },
      { header: "Value", style: "white" },
    ],
    infoRows,
    false,
  );

  const totalTasks = num(session["tasks_total"]);
  const completedTasks = num(session["tasks_completed"]);
  const failedTasks = num(session["tasks_failed"]);

  let completionRate = 0;
  let failureRate = 0;
  if (totalTasks > 0) {
    completionRate = (completedTasks / totalTasks) * 100;
    failureRate = (failedTasks / totalTasks) * 100;
  }

  renderTable(
    "Task Metrics",
    [
      { header: "Metric", style: "cyan" },
      { header: "Count", align: "right", style: "white" },
      { header: "Percentage", align: "right", style: "white" },
    ],
    [
      ["Total Tasks", String(totalTasks), "100%"],
      ["Completed", String(completedTasks), `${completionRate.toFixed(1)}%`],
      ["Failed", String(failedTasks), `${failureRate.toFixed(1)}%`],
    ],
    true,
  );

  renderTable(
    "Token Usage & Cost",
    [
      { header: "Metric", style: "cyan" },
      { header: "Value", align: "right", style: "white" },
    ],
    [
      ["Input Tokens", formatTokens(session["input_tokens"])],
      ["Output Tokens", formatTokens(session["output_tokens"])],
      ["Total Tokens", formatTokens(session["total_tokens"])],
      ["Estimated Cost", formatCost(session["estimated_cost"] as number | null | undefined)],
      ["API Calls", formatTokens(session["api_calls"])],
    ],
    true,
  );

  const actions = (session["actions"] as unknown[] | undefined) ?? [];
  if (actions.length > 0) {
    interface ActionStat {
      count: number;
      success: number;
      durations: number[];
    }
    const actionStats = new Map<string, ActionStat>();
    for (const action of actions as Record<string, unknown>[]) {
      const actionType = str(action["action_type"]);
      let stats = actionStats.get(actionType);
      if (!stats) {
        stats = { count: 0, success: 0, durations: [] };
        actionStats.set(actionType, stats);
      }
      stats.count += 1;
      if (truthy(action["success"])) stats.success += 1;
      if (action["duration_ms"] !== null && action["duration_ms"] !== undefined) {
        stats.durations.push(num(action["duration_ms"]));
      }
    }

    const actionRows: string[][] = [];
    for (const actionType of Array.from(actionStats.keys()).sort()) {
      const stats = actionStats.get(actionType)!;
      const successRate = (stats.success / stats.count) * 100;
      const avgDuration =
        stats.durations.length > 0
          ? stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length
          : 0;
      actionRows.push([
        actionType,
        String(stats.count),
        `${successRate.toFixed(1)}%`,
        avgDuration > 0 ? `${avgDuration.toFixed(0)}ms` : "N/A",
      ]);
    }

    renderTable(
      "Action Summary",
      [
        { header: "Action Type", style: "cyan" },
        { header: "Count", align: "right" },
        { header: "Success Rate", align: "right" },
        { header: "Avg Duration", align: "right" },
      ],
      actionRows,
      true,
    );
  }

  const fileOps = (session["file_operations"] as unknown[] | undefined) ?? [];
  if (fileOps.length > 0) {
    interface OpStat {
      count: number;
      added: number;
      removed: number;
    }
    const opStats = new Map<string, OpStat>();
    for (const op of fileOps as Record<string, unknown>[]) {
      const opType = str(op["operation_type"]);
      let stats = opStats.get(opType);
      if (!stats) {
        stats = { count: 0, added: 0, removed: 0 };
        opStats.set(opType, stats);
      }
      stats.count += 1;
      stats.added += num(op["lines_added"]);
      stats.removed += num(op["lines_removed"]);
    }

    const fileRows: string[][] = [];
    for (const opType of Array.from(opStats.keys()).sort()) {
      const stats = opStats.get(opType)!;
      fileRows.push([
        opType,
        String(stats.count),
        stats.added > 0 ? `+${stats.added}` : "0",
        stats.removed > 0 ? `-${stats.removed}` : "0",
      ]);
    }

    renderTable(
      "File Operations",
      [
        { header: "Operation", style: "cyan" },
        { header: "Count", align: "right" },
        { header: "Lines Added", align: "right", style: "green" },
        { header: "Lines Removed", align: "right", style: "red" },
      ],
      fileRows,
      true,
    );
  }

  const errors = (session["errors"] as unknown[] | undefined) ?? [];
  if (errors.length > 0) {
    console.log(`\n${chalk.bold.red(`Errors Encountered: ${errors.length}`)}`);
    console.log(chalk.red("Error Details"));
    for (const error of errors as Record<string, unknown>[]) {
      const time = formatTime(error["occurred_at"] as string | null | undefined);
      console.log(`  ${chalk.red(`${str(error["error_type"])} at ${time}`)}`);
      console.log(`    ${chalk.dim(str(error["error_message"]))}`);
      if (truthy(error["is_transient"])) {
        console.log(
          `    ${chalk.yellow(`Transient (retried ${error["retry_count"]} times)`)}`,
        );
      }
    }
  }

  console.log(`\n${chalk.bold("Overall Evaluation:")}`);

  const evaluation: SessionEvaluation = {
    session_id: sessionId,
    success: truthy(session["success"]),
    completion_rate: completionRate,
    total_tokens: (session["total_tokens"] as number | null | undefined) ?? null,
    estimated_cost: (session["estimated_cost"] as number | null | undefined) ?? null,
    duration_seconds: (session["duration_seconds"] as number | null | undefined) ?? null,
    error_count: errors.length,
  };

  const criteria: string[] = [];
  if (truthy(session["success"])) {
    criteria.push("✅ Session completed successfully");
  } else {
    criteria.push("❌ Session failed");
  }

  if (completionRate >= 90) {
    criteria.push("✅ High task completion rate (≥90%)");
  } else if (completionRate >= 75) {
    criteria.push("⚠️  Moderate task completion rate (75-90%)");
  } else {
    criteria.push("❌ Low task completion rate (<75%)");
  }

  const duration = num(session["duration_seconds"]);
  if (str(session["mode"]) === "for-landing") {
    if (duration < 600) {
      criteria.push("✅ Good duration for landing mode (<10m)");
    } else {
      criteria.push("⚠️  Slow duration for landing mode (>10m)");
    }
  } else if (duration < 1200) {
    criteria.push("✅ Good duration for review mode (<20m)");
  } else {
    criteria.push("⚠️  Slow duration for review mode (>20m)");
  }

  if (errors.length === 0) {
    criteria.push("✅ No errors encountered");
  } else if (errors.length <= 3) {
    criteria.push("⚠️  Few errors encountered (≤3)");
  } else {
    criteria.push("❌ Many errors encountered (>3)");
  }

  const cost = num(session["estimated_cost"]);
  if (cost < 0.5) {
    criteria.push("✅ Low cost (<$0.50)");
  } else if (cost < 1.0) {
    criteria.push("⚠️  Moderate cost ($0.50-$1.00)");
  } else {
    criteria.push("⚠️  High cost (>$1.00)");
  }

  for (const criterion of criteria) {
    console.log(`  ${criterion}`);
  }

  let gradePoints = 0;
  if (truthy(session["success"])) gradePoints += 25;
  if (completionRate >= 90) gradePoints += 25;
  else if (completionRate >= 75) gradePoints += 15;
  if (errors.length === 0) gradePoints += 25;
  else if (errors.length <= 3) gradePoints += 15;
  if (duration < 600) gradePoints += 25;
  else if (duration < 1200) gradePoints += 15;

  console.log(`\n${chalk.bold(`Overall Grade: ${gradePoints}/100`)}`);

  if (gradePoints >= 90) {
    console.log(chalk.green("✅ Excellent - Agent performed very well"));
  } else if (gradePoints >= 75) {
    console.log(chalk.yellow("⚠️  Good - Agent performed adequately with minor issues"));
  } else if (gradePoints >= 50) {
    console.log(chalk.yellow("⚠️  Fair - Agent struggled but completed some tasks"));
  } else {
    console.log(chalk.red("❌ Poor - Agent failed to complete the task"));
  }

  return evaluation;
}

/** Compare multiple sessions for the same PR and print a summary. */
export function compareSessions(
  db: AppStore,
  repoName: string,
  prNumber: number,
  limit: number = 5,
): void {
  const sessions = db.getAgentSessions(repoName, prNumber, limit);

  if (sessions.length === 0) {
    console.log(chalk.yellow("No sessions found to compare"));
    return;
  }

  console.log(`\n${chalk.bold.cyan(`Session Comparison: ${repoName} PR #${prNumber}`)}`);

  const rows: string[][] = sessions.map((session) => {
    const statusIcon = truthy(session["success"]) ? "✅" : "❌";
    const taskStr = `${num(session["tasks_completed"])}/${num(session["tasks_total"])}`;
    const durationStr = formatDuration(
      session["duration_seconds"] as number | null | undefined,
    );
    const tokensStr = formatTokens(session["total_tokens"]);
    const costStr = formatCost(session["estimated_cost"] as number | null | undefined);
    const startedStr = formatShortDateTime(
      session["started_at"] as string | null | undefined,
    );
    return [
      str(session["session_id"]).slice(0, 8) + "...",
      str(session["mode"]),
      statusIcon,
      taskStr,
      durationStr,
      tokensStr,
      costStr,
      startedStr,
    ];
  });

  renderTable(
    `Recent Sessions (${sessions.length} total)`,
    [
      { header: "Session", style: "dim" },
      { header: "Mode", style: "cyan" },
      { header: "Status", align: "center" },
      { header: "Tasks", align: "right" },
      { header: "Duration", align: "right" },
      { header: "Tokens", align: "right" },
      { header: "Cost", align: "right" },
      { header: "Started", style: "dim" },
    ],
    rows,
    true,
  );

  const successful = sessions.filter((s) => truthy(s["success"])).length;
  const successRate = (successful / sessions.length) * 100;

  const withDuration = sessions.filter((s) => truthy(s["duration_seconds"]));
  const avgDuration =
    withDuration.length > 0
      ? withDuration.reduce(
          (a, s) => a + num(s["duration_seconds"]),
          0,
        ) / withDuration.length
      : 0;

  const withCost = sessions.filter((s) => truthy(s["estimated_cost"]));
  const avgCost =
    withCost.length > 0
      ? withCost.reduce(
          (a, s) => a + num(s["estimated_cost"]),
          0,
        ) / withCost.length
      : 0;

  console.log(`\n${chalk.bold("Statistics:")}`);
  console.log(`  Success Rate: ${successRate.toFixed(1)}% (${successful}/${sessions.length})`);
  console.log(`  Avg Duration: ${formatDuration(avgDuration)}`);
  console.log(`  Avg Cost: ${formatCost(avgCost)}`);
}

/** Print command-line usage information. */
function printHelp(): void {
  console.log(`Usage: tsx evaluate_agent_results.ts [options]

Evaluate agent session results from the merge-god state database.

Required options:
  --repo <name>      Repository name
  --pr <number>      PR number

Modes (one required):
  --latest           Evaluate the latest session
  --session <id>     Evaluate a specific session ID
  --compare          Compare multiple sessions

Other options:
  --db <path>        Path to database (default: merge-god-state.db)
  --limit <n>        Number of sessions to compare (default: 5)
  --verbose          Show detailed output (error stack traces)
  --help             Show this help message

Examples:
  # Evaluate latest session
  tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --latest

  # Evaluate specific session
  tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --session abc123

  # Compare multiple sessions
  tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --compare

  # Verbose output with all details
  tsx evaluate_agent_results.ts --repo "prism merge" --pr 134 --latest --verbose
`);
}

/** Main entry point. @returns Process exit code (0 success, 1 failure). */
export function main(): number {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        db: { type: "string", default: "merge-god-state.db" },
        repo: { type: "string" },
        pr: { type: "string" },
        session: { type: "string" },
        latest: { type: "boolean", default: false },
        compare: { type: "boolean", default: false },
        limit: { type: "string", default: "5" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    console.error("Run with --help for usage information.");
    return 1;
  }

  if (values.help) {
    printHelp();
    return 0;
  }

  const dbPath = values.db ?? "merge-god-state.db";
  const repo = values.repo;
  const prRaw = values.pr;

  if (!repo || prRaw === undefined) {
    console.error("Error: --repo and --pr are required");
    console.error("Run with --help for usage information.");
    return 1;
  }

  const pr = Number.parseInt(prRaw, 10);
  if (!Number.isInteger(pr)) {
    console.error(`Error: --pr must be an integer (got "${prRaw}")`);
    return 1;
  }

  const limit = Number.parseInt(values.limit ?? "5", 10);

  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found: ${dbPath}`);
    return 1;
  }

  const db = new AppStore(dbPath);

  try {
    if (values.compare) {
      compareSessions(db, repo, pr, limit);
    } else if (values.latest || values.session) {
      let sessionId: string;
      if (values.latest) {
        const sessions = db.getAgentSessions(repo, pr, 1);
        if (sessions.length === 0) {
          console.log(chalk.red(`No sessions found for ${repo} PR #${pr}`));
          return 1;
        }
        sessionId = str(sessions[0]!["session_id"]);
      } else {
        sessionId = values.session!;
      }
      evaluateSession(db, sessionId, values.verbose);
    } else {
      console.log(chalk.yellow("Please specify --latest, --session, or --compare"));
      printHelp();
      return 1;
    }

    return 0;
  } catch (e) {
    console.log(chalk.red(`Error: ${e instanceof Error ? e.message : String(e)}`));
    if (values.verbose) {
      console.error(e instanceof Error ? e.stack : String(e));
    }
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
