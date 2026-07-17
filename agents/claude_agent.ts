/**
 * Claude Agent SDK integration for PR processing.
 *
 * Ported from agents/claude_agent.py. Wraps the Anthropic Messages API
 * (`@anthropic-ai/sdk`) with streaming + tool-use to process pull requests:
 * task decomposition, streaming updates, and an agentic tool-use loop.
 */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fsp, type Stats } from "node:fs";
import path from "node:path";

import { agentGateSummarySection } from "../agent_gate_summary_model";
import type { AgentAction, AgentCallbacks } from "./callbacks";
import { prAgentContextFromDict } from "../pr_agent_context_model";
import {
  recordAgentRun,
  recordPromptRendered,
  sanitizeSpanAttributes,
  withTelemetrySpan,
} from "../telemetry";
import { ExecutionPolicy } from "../execution_policy";

type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;
type ToolUseBlock = Anthropic.ToolUseBlock;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type ContentBlock = Anthropic.ContentBlock;

/** Bedrock support is not wired into the TypeScript port. */
export const BEDROCK_AVAILABLE = false;

/**
 * Create a Claude client based on environment configuration.
 *
 * Automatically detects if using Bedrock or direct API based on
 * CLAUDE_CODE_USE_BEDROCK environment variable. The Bedrock branch is not yet
 * supported in the TypeScript port and throws a clear error.
 */
export function createClaudeClient(): Anthropic {
  const useBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1";

  if (useBedrock) {
    throw new Error("Bedrock runtime not yet supported in the TypeScript port");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable not set. " +
        "Either set this variable or use Bedrock with CLAUDE_CODE_USE_BEDROCK=1",
    );
  }

  return new Anthropic({ apiKey });
}

/** Get the Claude model name from environment or default. */
export function getModelName(): string {
  const model = process.env.ANTHROPIC_MODEL;
  if (model) {
    return model;
  }

  const useBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1";
  if (useBedrock) {
    return "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
  }
  return "claude-sonnet-4-5-20250929";
}

export type { AgentAction, AgentCallbacks };

/** Represents a discrete task in PR processing. */
export interface AgentTask {
  id: string;
  description: string;
  prompt_template: string;
  required_context: string[];
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  actions: AgentAction[];
  result: Record<string, unknown> | null;
  error: string | null;
}

/** Construct an {@link AgentTask}, mirroring the Python dataclass defaults. */
export function createAgentTask(opts: {
  id: string;
  description: string;
  prompt_template: string;
  required_context: string[];
  status?: string;
  started_at?: Date | null;
  completed_at?: Date | null;
  actions?: AgentAction[];
  result?: Record<string, unknown> | null;
  error?: string | null;
}): AgentTask {
  return {
    id: opts.id,
    description: opts.description,
    prompt_template: opts.prompt_template,
    required_context: opts.required_context,
    status: opts.status ?? "pending",
    started_at: opts.started_at ?? null,
    completed_at: opts.completed_at ?? null,
    actions: opts.actions ?? [],
    result: opts.result ?? null,
    error: opts.error ?? null,
  };
}

/** Event emitted during agent execution. */
export interface AgentEvent {
  type: string;
  content?: string | null;
  action?: AgentAction | null;
  progress?: [number, number] | null;
  error?: Error | null;
}

/** Construct an {@link AgentEvent}. */
export function createAgentEvent(opts: {
  type: string;
  content?: string | null;
  action?: AgentAction | null;
  progress?: [number, number] | null;
  error?: Error | null;
}): AgentEvent {
  return {
    type: opts.type,
    content: opts.content ?? null,
    action: opts.action ?? null,
    progress: opts.progress ?? null,
    error: opts.error ?? null,
  };
}

/** Context for PR processing. */
export interface PRContext {
  pr_number: number;
  title: string;
  body: string | null;
  head_branch: string;
  base_branch: string;
  author: string;
  url: string;

  has_conflicts: boolean;
  conflicting_files: string[];
  has_failing_ci: boolean;
  failing_checks: Record<string, unknown>[];

  review_comments: Record<string, unknown>[];
  general_comments: Record<string, unknown>[];

  merge_blockers: Record<string, unknown>[];
  queue_context: Record<string, unknown> | null;

  changed_files: Record<string, unknown>[];
  diff: string;

  commits: Record<string, unknown>[];

  guidelines: string;
  commit_examples: string;
  merge_rules: string;

  labels: string[];
  ci_checks: Record<string, unknown>;
  review_decision: string | null;
}

/** Construct a {@link PRContext} from explicit fields. */
export function createPRContext(opts: PRContext): PRContext {
  return { ...opts };
}

/** Create a {@link PRContext} from pr-loop data structures (mirrors from_dict). */
export function createPRContextFromDict(
  prDetails: Record<string, unknown>,
  prContext: Record<string, unknown>,
): PRContext {
  return createPRContext(prAgentContextFromDict(prDetails, prContext));
}

/** Result of PR processing. */
export interface ProcessingResult {
  success: boolean;
  tasks: AgentTask[];
  actions: AgentAction[];
  duration: number;
  error: string | null;
}

/** Construct a {@link ProcessingResult}. */
export function createProcessingResult(opts: {
  success: boolean;
  tasks: AgentTask[];
  actions: AgentAction[];
  duration: number;
  error?: string | null;
}): ProcessingResult {
  return {
    success: opts.success,
    tasks: opts.tasks,
    actions: opts.actions,
    duration: opts.duration,
    error: opts.error ?? null,
  };
}

/** Check if all tasks completed successfully. */
export function allTasksSuccessful(result: ProcessingResult): boolean {
  return result.tasks.every((task) => task.status === "completed");
}

/** Get list of failed tasks. */
export function getFailedTasks(result: ProcessingResult): AgentTask[] {
  return result.tasks.filter((task) => task.status === "failed");
}

/** Result of a tool execution. */
export interface ToolResult {
  success: boolean;
  output?: string | null;
  error?: string | null;
  data?: Record<string, unknown> | null;
}

/** Construct a {@link ToolResult}. */
export function createToolResult(opts: {
  success: boolean;
  output?: string | null;
  error?: string | null;
  data?: Record<string, unknown> | null;
}): ToolResult {
  return {
    success: opts.success,
    output: opts.output ?? null,
    error: opts.error ?? null,
    data: opts.data ?? null,
  };
}

/** Convert a {@link ToolResult} to Claude API tool-result content blocks. */
function toolResultToContent(result: ToolResult): Array<{ type: "text"; text: string }> {
  if (result.success) {
    return [{ type: "text", text: result.output ?? "Operation completed successfully" }];
  }
  return [{ type: "text", text: `Error: ${result.error ?? ""}` }];
}

/** Structural interface for the optional agent database (mirrors Python duck-typing). */
export interface AgentDatabase {
  recordAgentAction(opts: {
    session_id: string;
    action_number: number;
    action_type: string;
    target: string;
    details: Record<string, unknown>;
    status: string;
  }): number;
  updateAgentSession(opts: { session_id: string; actions_total: number }): void;
  recordFileOperation(opts: {
    session_id: string;
    action_id: number | null;
    operation_type: string;
    file_path: string;
    file_size?: number | null;
    lines_added?: number;
    success: boolean;
    error_message?: string | null;
  }): void;
  recordAgentError(opts: {
    session_id: string;
    error_type: string;
    error_message: string;
    error_details: string;
    is_transient: boolean;
  }): void;
}

/**
 * Agent for processing pull requests using the Anthropic Messages API.
 *
 * Replaces a subprocess-based agent invocation with a structured, observable,
 * and recoverable agent system driven by a streaming tool-use loop.
 */
export class PRAgent {
  /** Development best practices for this repository. */
  static readonly DEV_GUIDELINES = `## Repository Development Best Practices

### Code Quality Tools

This repository uses the following tools to maintain code quality:

1. **TypeScript** - Static type checker
   - Run type checks: \`npm run typecheck\`
   - Equivalent command: \`npx tsc --noEmit\`
   - Helps catch type errors before runtime

2. **Pre-commit hooks** - Automated checks before commits
   - Install: \`pre-commit install\`
   - Run manually: \`pre-commit run --all-files\`
   - Includes file checks and markdown linting

3. **Node test runner** - Test framework
   - Run tests: \`npm test\` or \`npx tsx merge-god.ts test\`
   - Run specific test: \`node --import tsx --test tests/stores.test.ts\`

### Code Standards

- **TypeScript**: strict mode with \`noUncheckedIndexedAccess\`
- **Runtime**: Node.js 22+
- **Modules**: ESM with extensionless TypeScript imports
- **Data names**: keep database/API properties snake_case; use camelCase for functions

### Before Committing

Always run these checks before committing code:

\`\`\`bash
# Type check and test
npm run ci

# Optional markdown checks
npm run markdownlint

# Or use pre-commit to run all checks
pre-commit run --all-files
\`\`\`

### CI/Testing Commands

- \`merge-god test\` - Run full test suite
- \`merge-god test --type isolation\` - Run process isolation tests
- \`merge-god test --type db\` - Run database tests
- \`merge-god validate\` - Validate process flow
`;

  client: Anthropic;
  model: string;
  repo_path: string | null;
  database: AgentDatabase | null;
  session_id: string | null;
  conversation_history: MessageParam[];
  actions_taken: AgentAction[];
  is_bedrock: boolean;
  action_counter: number;
  turn_counter: number;

  constructor(
    client: Anthropic,
    opts: {
      model?: string;
      repo_path?: string | null;
      database?: AgentDatabase | null;
      session_id?: string | null;
    } = {},
  ) {
    this.client = client;
    this.model = opts.model ?? "claude-sonnet-4-5-20250929";
    this.repo_path = opts.repo_path ?? null;
    this.database = opts.database ?? null;
    this.session_id = opts.session_id ?? null;
    this.conversation_history = [];
    this.actions_taken = [];
    this.is_bedrock = false;
    this.action_counter = 0;
    this.turn_counter = 0;
  }

  /**
   * Process a PR with streaming updates and structured actions.
   *
   * This is the main entry point that replaces the subprocess-based agent
   * invocation.
   */
  async processPrStreaming(
    prContext: PRContext,
    mode: string,
    callbacks: AgentCallbacks,
  ): Promise<ProcessingResult> {
    return withTelemetrySpan(
      "merge_god.claude_agent.process_pr",
      {
        "merge_god.operation": "claude_agent.process_pr",
        "merge_god.agent_kind": "claude",
        "merge_god.pr_number": prContext.pr_number,
        "merge_god.mode": mode,
        "merge_god.repo_path": this.repo_path ?? "",
        "merge_god.model": this.model,
      },
      async (span) => {
    const startTime = new Date();

    const tasks = this.decomposePrTasks(prContext, mode);
    span.setAttribute("merge_god.task_count", tasks.length);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      try {
        callbacks.onProgress(i, tasks.length);

        task.started_at = new Date();
        task.status = "running";

        for await (const event of this.executeTaskStreaming(task, prContext)) {
          if (event.type === "thinking" && event.content != null) {
            callbacks.onThinking(event.content);
          } else if (event.type === "action" && event.action != null) {
            callbacks.onAction(event.action);
            task.actions.push(event.action);
          } else if (event.type === "error" && event.error != null) {
            if (!callbacks.onError(event.error)) {
              task.status = "failed";
              task.error = String(event.error);
              break;
            }
          }
        }

        if (task.status === "running") {
          task.status = "completed";
          task.completed_at = new Date();
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        task.status = "failed";
        task.error = String(err);
        task.completed_at = new Date();

        if (!callbacks.onError(err)) {
          break;
        }
      }
    }

    const duration = (Date.now() - startTime.getTime()) / 1000;
    const allSuccessful = tasks.every((task) => task.status === "completed");

    const result = createProcessingResult({
      success: allSuccessful,
      tasks,
      actions: this.actions_taken,
      duration,
      error: allSuccessful ? null : "Some tasks failed",
    });
    span.setAttributes(sanitizeSpanAttributes({
      "merge_god.success": result.success,
      "merge_god.result_status": result.success ? "success" : "failure",
      "merge_god.result_summary": result.success ? "All tasks completed" : result.error,
      "merge_god.duration_seconds": result.duration,
      "merge_god.actions_total": result.actions.length,
      "merge_god.tasks_failed": result.tasks.filter((task) => task.status === "failed").length,
    }));
    recordAgentRun("claude", result.success, result.duration, {
      "merge_god.pr_number": prContext.pr_number,
      "merge_god.mode": mode,
      "merge_god.model": this.model,
    });
    return result;
      },
    );
  }

  /** Break down PR processing into discrete, manageable tasks. */
  decomposePrTasks(prContext: PRContext, mode: string): AgentTask[] {
    const tasks: AgentTask[] = [];

    tasks.push(
      createAgentTask({
        id: "analyze",
        description: `Analyze PR #${prContext.pr_number} and identify issues`,
        prompt_template: "analyze_pr",
        required_context: ["pr_details", "diff", "ci_status"],
      }),
    );

    if (prContext.has_conflicts) {
      tasks.push(
        createAgentTask({
          id: "resolve_conflicts",
          description: `Resolve ${prContext.conflicting_files.length} merge conflicts`,
          prompt_template: "resolve_conflicts",
          required_context: ["conflicting_files", "base_branch", "diff"],
        }),
      );
    }

    if (prContext.review_comments.length > 0) {
      tasks.push(
        createAgentTask({
          id: "address_reviews",
          description: `Address ${prContext.review_comments.length} review comments`,
          prompt_template: "address_reviews",
          required_context: ["review_comments", "changed_files"],
        }),
      );
    }

    if (prContext.has_failing_ci) {
      tasks.push(
        createAgentTask({
          id: "fix_ci",
          description: `Fix ${prContext.failing_checks.length} failing CI checks`,
          prompt_template: "fix_ci",
          required_context: ["failing_checks", "changed_files"],
        }),
      );
    }

    if (mode === "for-review") {
      tasks.push(
        createAgentTask({
          id: "code_review",
          description: "Conduct comprehensive code review and improvements",
          prompt_template: "code_review",
          required_context: ["full_diff", "guidelines", "changed_files"],
        }),
      );
    }

    tasks.push(
      createAgentTask({
        id: "validate",
        description: "Run tests and validate all changes",
        prompt_template: "validate",
        required_context: ["changed_files"],
      }),
    );

    return tasks;
  }

  /**
   * Execute a single task with streaming updates.
   *
   * Implements an agentic loop with tool calling: the assistant stream is
   * consumed for live "thinking" text, then tool_use blocks are read from the
   * final message, executed, and their results fed back until the assistant
   * stops requesting tools or the iteration cap is reached.
   */
  async *executeTaskStreaming(
    task: AgentTask,
    prContext: PRContext,
  ): AsyncGenerator<AgentEvent> {
    const prompt = this.buildTaskPrompt(task, prContext);
    const tools = this.getToolsForTask(task);

    this.conversation_history.push({
      role: "user",
      content: prompt,
    });

    const maxIterations = 25;
    let iteration = 0;

    try {
      while (iteration < maxIterations) {
        iteration += 1;

        const stream = this.client.messages.stream({
          model: this.model,
          max_tokens: 4096,
          messages: this.conversation_history,
          tools: tools.length > 0 ? tools : undefined,
        });

        const textContent: string[] = [];

        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              textContent.push(delta.text);
              yield createAgentEvent({ type: "thinking", content: delta.text });
            }
          }
        }

        const finalMessage = await stream.finalMessage();

        this.conversation_history.push({
          role: "assistant",
          content: finalMessage.content as ContentBlock[],
        });

        const toolUses = finalMessage.content.filter(
          (block): block is ToolUseBlock => block.type === "tool_use",
        );

        if (toolUses.length === 0) {
          break;
        }

        const toolResults: ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          const inputRecord = asRecord(toolUse.input);

          const action: AgentAction = {
            type: toolUse.name,
            target: strVal(inputRecord["target"]),
            details: inputRecord,
            status: "executing",
            timestamp: new Date(),
          };

          yield createAgentEvent({ type: "action", action });

          let actionId: number | null = null;
          if (this.database && this.session_id) {
            try {
              this.action_counter += 1;
              actionId = this.database.recordAgentAction({
                session_id: this.session_id,
                action_number: this.action_counter,
                action_type: action.type,
                target: action.target,
                details: action.details,
                status: "executing",
              });
            } catch {
              // Don't fail on telemetry errors
            }
          }

          const toolResult = await this.executeTool(action, actionId);

          action.status = toolResult.success ? "completed" : "failed";
          action.result = toolResult.data ?? null;
          action.error = toolResult.error ?? null;
          this.actions_taken.push(action);

          if (this.database && this.session_id && actionId != null) {
            try {
              this.database.updateAgentSession({
                session_id: this.session_id,
                actions_total: this.action_counter,
              });
            } catch {
              // Don't fail on telemetry errors
            }
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: toolResultToContent(toolResult),
          });
        }

        this.conversation_history.push({
          role: "user",
          content: toolResults,
        });
      }

      if (iteration >= maxIterations) {
        yield createAgentEvent({
          type: "error",
          error: new Error(`Agent exceeded maximum iterations (${maxIterations})`),
        });
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      yield createAgentEvent({ type: "error", error: err });
    }
  }

  /** Build a focused prompt for a specific task. */
  buildTaskPrompt(task: AgentTask, prContext: PRContext): string {
    const baseContext = `# Task: ${task.description}

## PR Context
- **PR #${prContext.pr_number}**: ${prContext.title}
- **Branch**: ${prContext.head_branch} → ${prContext.base_branch}
- **Author**: ${prContext.author}
- **URL**: ${prContext.url}
`;
    const mergeRules = prContext.merge_rules
      ? `
## Merge Rules
${prContext.merge_rules}
`
      : "";
    const gateContext = agentGateSummarySection(prContext);

    if (task.id === "analyze") {
      return this.recordTaskPrompt(
        task,
        prContext,
        baseContext +
        gateContext +
        `
## Your Task
Analyze this PR and identify:
1. Any merge conflicts
2. Failing CI checks
3. Outstanding review comments
4. Potential issues or improvements

## PR Statistics
- Files changed: ${prContext.changed_files.length}
- Commits: ${prContext.commits.length}
- Review comments: ${prContext.review_comments.length}

## Current State
- Conflicts: ${prContext.has_conflicts ? "Yes" : "No"}
- Failing CI: ${prContext.has_failing_ci ? "Yes" : "No"}
- Review decision: ${prContext.review_decision ?? "Pending"}

Provide a structured analysis of what needs to be done.
`
      );
    }

    if (task.id === "resolve_conflicts") {
      const conflictingFilesStr = prContext.conflicting_files
        .map((f) => `- ${f}`)
        .join("\n");
      return this.recordTaskPrompt(
        task,
        prContext,
        baseContext +
        gateContext +
        `
## Your Task
Resolve merge conflicts in the following files:
${conflictingFilesStr}

## Tools Available
- read_file: Read the current state of conflicting files
- edit_file: Make changes to resolve conflicts
- git_commit: Commit the resolved conflicts

## Guidelines
1. Understand the changes in both branches
2. Preserve the intent of both changes where possible
3. Remove conflict markers (<<<<<<<, =======, >>>>>>>)
4. Test that the resolution makes sense
5. Commit with a clear message

Begin by reading the conflicting files to understand the conflicts.
`
      );
    }

    if (task.id === "address_reviews") {
      const reviewSummary = prContext.review_comments
        .slice(0, 5)
        .map((c) => {
          const user = strVal(asRecord(c["user"])["login"]);
          const cPath = optStrVal(c["path"]) ?? "";
          const lineVal = c["line"];
          const lineStr = lineVal == null ? "" : String(lineVal);
          const body = optStrVal(c["body"]) ?? "";
          return `**${user}** on ${cPath}:${lineStr}\n${body}`;
        })
        .join("\n\n");

      const more =
        prContext.review_comments.length > 5
          ? `... and ${prContext.review_comments.length - 5} more comments`
          : "";

      return this.recordTaskPrompt(
        task,
        prContext,
        baseContext +
        mergeRules +
        gateContext +
        `
## Your Task
Address the following code review comments:

${reviewSummary}

${more}

## Tools Available
- read_file: Read files that need changes
- edit_file: Make requested changes
- run_command: Run tests, linting, formatting
- git_commit: Commit the fixes

## Guidelines
1. Address each comment thoughtfully
2. After making changes, run quality checks:
   - \`npm run typecheck\` - TypeScript checks
   - \`npm test\` - Test suite
   - \`npm run ci\` - Full CI check
3. Test your changes to ensure nothing broke
4. Commit with messages referencing the review comments
5. Consider if additional improvements are needed

## Quality Workflow

For each change:
1. Make the requested change
2. Typecheck: \`npm run typecheck\`
3. Test: \`npm test\` (or \`node --import tsx --test <file>\`)
4. Run full CI: \`npm run ci\`
5. Commit with clear message

Work through the comments systematically.
`
      );
    }

    if (task.id === "fix_ci") {
      const failingChecksStr = prContext.failing_checks
        .map((c) => {
          const name = optStrVal(c["name"]) ?? "";
          const conclusion = optStrVal(c["conclusion"]) ?? "";
          return `- **${name}**: ${conclusion}`;
        })
        .join("\n");

      return this.recordTaskPrompt(
        task,
        prContext,
        baseContext +
        mergeRules +
        gateContext +
        `
## Your Task
Fix the following failing CI checks:

${failingChecksStr}

## Tools Available
- read_file: Read test files and source code
- edit_file: Fix issues causing failures
- run_command: Run tests, linting, type checking
- git_commit: Commit the fixes

## Guidelines
1. Understand what each check is testing
2. Fix the root cause, not just the symptom
3. Run quality checks before committing:
   - \`npm run typecheck\` - TypeScript checks
   - \`npm test\` - Test suite
   - \`npm run ci\` - Full CI check
4. Verify all tests pass after your changes
5. Commit with descriptive messages

## Common CI Failures

- **Type errors**: Run \`npm run typecheck\`
- **Test failures**: Run \`npm test\` or a specific \`node --import tsx --test <file>\` command
- **Markdown issues**: Run \`npm run markdownlint\`
- **Import errors**: Check for missing dependencies

Start by analyzing the failing checks.
`
      );
    }

    if (task.id === "code_review") {
      const changedFilesStr = prContext.changed_files
        .slice(0, 20)
        .map((f) => {
          const filename = optStrVal(f["filename"]) ?? "";
          const add = f["additions"];
          const del = f["deletions"];
          return `- ${filename} (+${add ?? 0}/-${del ?? 0})`;
        })
        .join("\n");

      const guidelines = prContext.guidelines || "Follow best practices for the codebase";

      return this.recordTaskPrompt(
        task,
        prContext,
        baseContext +
        mergeRules +
        gateContext +
        `
## Your Task
Conduct a comprehensive code review of the changes in this PR.

## Review Focus Areas
1. **Correctness**: Does the code do what it's supposed to?
2. **Security**: Any vulnerabilities (SQL injection, XSS, etc.)?
3. **Performance**: Any inefficient algorithms or queries?
4. **Best Practices**: Following language/framework conventions?
5. **Testing**: Are tests adequate?
6. **Documentation**: Are complex parts documented?
7. **Code Quality**: Run linting and type checking

## Changed Files
${changedFilesStr}

## Quality Checks to Run

Before finalizing any changes, follow the merge rules when present, including referenced Workflow-IR gates and remediation modes. Run local refs and remote Git refs pinned to immutable commit hashes; report unpinned or unsupported refs as skipped evidence. Then run these general quality tools:

\`\`\`bash
# Type check and test
npm run ci

# Optional markdown checks
npm run markdownlint
\`\`\`

## Guidelines
${guidelines}

${PRAgent.DEV_GUIDELINES}

## Tools Available
- read_file: Read source files to review
- edit_file: Make improvements
- run_command: Run linting, formatting, type checking, tests
- git_commit: Commit improvements

Review the code systematically and make targeted improvements.
`
      );
    }

    if (task.id === "validate") {
      return this.recordTaskPrompt(
        task,
        prContext,
        baseContext +
        mergeRules +
        gateContext +
        `
## Your Task
Final validation before marking PR ready:

1. Follow the merge rules when present, including referenced Workflow-IR gates and remediation modes. Run local refs and remote Git refs pinned to immutable commit hashes; report unpinned or unsupported refs as skipped evidence.
2. Collect as much validation evidence as feasible before making a final gate decision.
3. If a gate fails, attempt remediation only within the configured remediation mode and then rerun affected validation.
4. Run all general quality checks:
   - \`npm run typecheck\` - TypeScript checks
   - \`npm test\` - All tests
   - \`npm run ci\` - Full CI check
5. Verify all conflicts resolved
6. Check that all review comments addressed
7. Ensure CI checks will pass
8. Validate docs/site builds if documentation or site files changed

## Pre-merge Checklist

Run this validation sequence:

\`\`\`bash
# Type safety and tests
npm run ci                   # Should pass

# Markdown/docs (if changed)
npm run markdownlint         # Should pass
\`\`\`

## Tools Available
- run_command: Run tests, linting, type checking
- read_file: Check any files if needed

Perform final validation and report status. Only mark as ready if all checks pass.
`
      );
    }

    return this.recordTaskPrompt(task, prContext, baseContext);
  }

  private recordTaskPrompt(task: AgentTask, prContext: PRContext, prompt: string): string {
    recordPromptRendered(`claude_task.${task.id}`, prompt, {
      "merge_god.pr_number": prContext.pr_number,
      "merge_god.task_id": task.id,
      "merge_god.prompt_template": task.prompt_template,
      "merge_god.model": this.model,
    });
    return prompt;
  }

  /** Provide task-specific tools to the agent. */
  getToolsForTask(task: AgentTask): Tool[] {
    const commonTools: Tool[] = [
      {
        name: "read_file",
        description: "Read contents of a file from the repository",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to read",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "list_files",
        description: "List files in a directory",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path (default: repository root)",
            },
            pattern: {
              type: "string",
              description: "Optional glob pattern to filter files",
            },
          },
        },
      },
    ];

    const actionTools: Tool[] = [];

    if (
      task.id === "resolve_conflicts" ||
      task.id === "address_reviews" ||
      task.id === "fix_ci" ||
      task.id === "code_review"
    ) {
      actionTools.push(
        {
          name: "edit_file",
          description: "Edit a file in the repository",
          input_schema: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Path to the file to edit",
              },
              changes: {
                type: "array",
                description: "List of changes to make",
                items: {
                  type: "object",
                  properties: {
                    old: {
                      type: "string",
                      description: "Text to replace",
                    },
                    new: {
                      type: "string",
                      description: "Replacement text",
                    },
                  },
                  required: ["old", "new"],
                },
              },
            },
            required: ["path", "changes"],
          },
        },
        {
          name: "run_tests",
          description: "Run test suite or specific tests",
          input_schema: {
            type: "object",
            properties: {
              test_path: {
                type: "string",
                description: "Path to specific test file or directory (optional)",
              },
            },
          },
        },
        {
          name: "git_commit",
          description: "Create a git commit with changes",
          input_schema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "Commit message",
              },
              files: {
                type: "array",
                description: "Specific files to commit (optional, defaults to all changes)",
                items: { type: "string" },
              },
            },
            required: ["message"],
          },
        },
      );
    }

    return actionTools.length > 0 ? commonTools.concat(actionTools) : commonTools;
  }

  /** Execute a tool call made by the agent. */
  async executeTool(action: AgentAction, actionId: number | null = null): Promise<ToolResult> {
    try {
      if (action.type === "read_file") {
        const result = await this.toolReadFile(strVal(action.details["path"]));
        if (this.database && this.session_id && result.success) {
          try {
            this.database.recordFileOperation({
              session_id: this.session_id,
              action_id: actionId,
              operation_type: "read",
              file_path: strVal(action.details["path"]),
              file_size: result.data ? optNumVal(result.data["size"]) : null,
              success: true,
            });
          } catch {
            // Don't fail on telemetry errors
          }
        }
        return result;
      }

      if (action.type === "list_files") {
        return await this.toolListFiles(
          optStrVal(action.details["path"]) ?? ".",
          optStrVal(action.details["pattern"]),
        );
      }

      if (action.type === "edit_file") {
        const changes = Array.isArray(action.details["changes"])
          ? (action.details["changes"] as Array<Record<string, unknown>>)
          : [];
        const result = await this.toolEditFile(strVal(action.details["path"]), changes);
        if (this.database && this.session_id) {
          try {
            this.database.recordFileOperation({
              session_id: this.session_id,
              action_id: actionId,
              operation_type: "edit",
              file_path: strVal(action.details["path"]),
              lines_added:
                result.data && result.success ? numVal(result.data["changes"]) : 0,
              success: result.success,
              error_message: result.error ?? undefined,
            });
          } catch {
            // Don't fail on telemetry errors
          }
        }
        return result;
      }

      if (action.type === "run_tests") {
        return await this.toolRunTests(optStrVal(action.details["test_path"]));
      }

      if (action.type === "git_commit") {
        const files = Array.isArray(action.details["files"])
          ? (action.details["files"] as string[])
          : null;
        return await this.toolGitCommit(optStrVal(action.details["message"]), files);
      }

      return createToolResult({
        success: false,
        error: `Unknown tool: ${action.type}`,
      });
    } catch (e) {
      if (this.database && this.session_id) {
        try {
          this.database.recordAgentError({
            session_id: this.session_id,
            error_type: e instanceof Error ? e.constructor.name : "Error",
            error_message: String(e),
            error_details: `Tool: ${action.type}, Details: ${JSON.stringify(action.details)}`,
            is_transient: false,
          });
        } catch {
          // Don't fail on telemetry errors
        }
      }

      return createToolResult({
        success: false,
        error: `Tool execution failed: ${String(e)}`,
      });
    }
  }

  /** Read a file from the repository. */
  async toolReadFile(filePath: string): Promise<ToolResult> {
    if (!this.repo_path) {
      return createToolResult({
        success: false,
        error: "Repository path not configured. Cannot perform file operations.",
      });
    }

    const resolvedRepo = path.resolve(this.repo_path);
    const fullPath = path.resolve(this.repo_path, filePath);

    if (!isWithinRepo(fullPath, resolvedRepo)) {
      return createToolResult({
        success: false,
        error:
          `Access denied: '${filePath}' is outside repository bounds. ` +
          "Only files within the repository can be accessed.",
      });
    }

    let st: Stats;
    try {
      st = await fsp.stat(fullPath);
    } catch (e) {
      if (isEnoent(e)) {
        return createToolResult({
          success: false,
          error:
            `File not found: '${filePath}'. ` +
            "Check the path is correct and the file exists in the repository.",
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to read '${filePath}': ${String(e)}`,
      });
    }

    if (!st.isFile()) {
      return createToolResult({
        success: false,
        error:
          `Cannot read '${filePath}': path is a directory, not a file. ` +
          "Use list_files tool to view directory contents.",
      });
    }

    const maxSize = 10 * 1024 * 1024;
    if (st.size > maxSize) {
      return createToolResult({
        success: false,
        error:
          `File too large: '${filePath}' is ${(st.size / 1024 / 1024).toFixed(1)}MB. ` +
          `Maximum file size is ${maxSize / 1024 / 1024}MB.`,
      });
    }

    try {
      const buf = await fsp.readFile(fullPath);
      if (buf.includes(0)) {
        return createToolResult({
          success: false,
          error:
            `Cannot read '${filePath}': file appears to be binary. ` +
            "This tool only supports text files.",
        });
      }
      const content = buf.toString("utf8");
      return createToolResult({
        success: true,
        output: content,
        data: { path: filePath, size: content.length },
      });
    } catch (e) {
      if (isEacces(e)) {
        return createToolResult({
          success: false,
          error: `Permission denied: cannot read '${filePath}'. Check file permissions.`,
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to read '${filePath}': ${String(e)}`,
      });
    }
  }

  /** List files in a directory. */
  async toolListFiles(dirPath: string, pattern: string | null): Promise<ToolResult> {
    if (!this.repo_path) {
      return createToolResult({
        success: false,
        error: "Repository path not configured. Cannot perform file operations.",
      });
    }

    const resolvedRepo = path.resolve(this.repo_path);
    const fullPath = path.resolve(this.repo_path, dirPath);

    if (!isWithinRepo(fullPath, resolvedRepo)) {
      return createToolResult({
        success: false,
        error:
          `Access denied: '${dirPath}' is outside repository bounds. ` +
          "Only directories within the repository can be accessed.",
      });
    }

    let st: Stats;
    try {
      st = await fsp.stat(fullPath);
    } catch (e) {
      if (isEnoent(e)) {
        return createToolResult({
          success: false,
          error:
            `Directory not found: '${dirPath}'. ` +
            "Check the path is correct and the directory exists in the repository.",
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to list files in '${dirPath}': ${String(e)}`,
      });
    }

    if (!st.isDirectory()) {
      return createToolResult({
        success: false,
        error:
          `Cannot list '${dirPath}': path is a file, not a directory. ` +
          "Use read_file tool to read file contents.",
      });
    }

    try {
      const entries = await fsp.readdir(fullPath);
      const filtered = pattern ? entries.filter((n) => globMatch(pattern, n)) : entries;
      filtered.sort();

      const fileStrs = filtered.map((n) =>
        path.relative(resolvedRepo, path.join(fullPath, n)),
      );
      return createToolResult({
        success: true,
        output: fileStrs.join("\n"),
        data: { count: filtered.length },
      });
    } catch (e) {
      if (isEacces(e)) {
        return createToolResult({
          success: false,
          error: `Permission denied: cannot list '${dirPath}'. Check directory permissions.`,
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to list files in '${dirPath}': ${String(e)}`,
      });
    }
  }

  /** Edit a file with specified changes. */
  async toolEditFile(
    filePath: string,
    changes: Array<Record<string, unknown>>,
  ): Promise<ToolResult> {
    if (!this.repo_path) {
      return createToolResult({
        success: false,
        error: "Repository path not configured. Cannot perform file operations.",
      });
    }

    if (!Array.isArray(changes) || changes.length === 0) {
      return createToolResult({
        success: false,
        error: "Invalid changes parameter. Must provide a list of change objects.",
      });
    }

    const resolvedRepo = path.resolve(this.repo_path);
    const fullPath = path.resolve(this.repo_path, filePath);

    if (!isWithinRepo(fullPath, resolvedRepo)) {
      return createToolResult({
        success: false,
        error:
          `Access denied: '${filePath}' is outside repository bounds. ` +
          "Only files within the repository can be edited.",
      });
    }

    const rel = path.relative(resolvedRepo, fullPath);
    const parts = rel.split(path.sep);
    if (parts.length > 0 && parts[0] === ".git") {
      return createToolResult({
        success: false,
        error:
          "Access denied: cannot edit files in .git directory. " +
          "This would corrupt the git repository.",
      });
    }

    let st: Stats;
    try {
      st = await fsp.stat(fullPath);
    } catch (e) {
      if (isEnoent(e)) {
        return createToolResult({
          success: false,
          error:
            `File not found: '${filePath}'. ` +
            "File must exist before it can be edited. Use git to create new files.",
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to edit '${filePath}': ${String(e)}`,
      });
    }

    if (!st.isFile()) {
      return createToolResult({
        success: false,
        error: `Cannot edit '${filePath}': path is a directory, not a file.`,
      });
    }

    let content: string;
    try {
      const buf = await fsp.readFile(fullPath);
      if (buf.includes(0)) {
        return createToolResult({
          success: false,
          error:
            `Cannot edit '${filePath}': file appears to be binary. ` +
            "This tool only supports text files.",
        });
      }
      content = buf.toString("utf8");
    } catch (e) {
      if (isEacces(e)) {
        return createToolResult({
          success: false,
          error: `Permission denied: cannot edit '${filePath}'. Check file permissions.`,
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to edit '${filePath}': ${String(e)}`,
      });
    }

    const originalContent = content;
    let changesApplied = 0;

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!;
      const oldVal = change["old"];
      const newVal = change["new"];

      if (typeof oldVal !== "string" || oldVal === "") {
        return createToolResult({
          success: false,
          error: `Change #${i + 1}: 'old' field is required but missing or empty.`,
        });
      }

      if (newVal === undefined || newVal === null) {
        return createToolResult({
          success: false,
          error: `Change #${i + 1}: 'new' field is required but missing.`,
        });
      }

      const newStr = typeof newVal === "string" ? newVal : String(newVal);

      if (content.includes(oldVal)) {
        const occurrences = content.split(oldVal).length - 1;
        if (occurrences > 1) {
          return createToolResult({
            success: false,
            error:
              `Change #${i + 1}: Text appears ${occurrences} times in file. ` +
              "Provide more context in 'old' to make replacement unique, " +
              "or use multiple specific changes.",
          });
        }
        content = content.replace(oldVal, newStr);
        changesApplied += 1;
      } else {
        return createToolResult({
          success: false,
          error:
            `Change #${i + 1}: Could not find text to replace: '${oldVal.slice(0, 100)}...'. ` +
            "Text may have already been changed, or the context doesn't match. " +
            "Try reading the file first to see current contents.",
        });
      }
    }

    if (content === originalContent) {
      return createToolResult({
        success: false,
        error: "No changes were made to the file. Content is identical to original.",
      });
    }

    try {
      await fsp.writeFile(fullPath, content, "utf8");
    } catch (e) {
      if (isEacces(e)) {
        return createToolResult({
          success: false,
          error: `Permission denied: cannot edit '${filePath}'. Check file permissions.`,
        });
      }
      return createToolResult({
        success: false,
        error: `Failed to edit '${filePath}': ${String(e)}`,
      });
    }

    return createToolResult({
      success: true,
      output: `Successfully applied ${changesApplied} change(s) to ${filePath}`,
      data: { changes: changesApplied, path: filePath },
    });
  }

  /** Run test suite. */
  async toolRunTests(testPath: string | null): Promise<ToolResult> {
    if (!this.repo_path) {
      return createToolResult({
        success: false,
        error: "Repository path not configured. Cannot run tests.",
      });
    }

    try {
      if (testPath) {
        const resolvedRepo = path.resolve(this.repo_path);
        const fullTestPath = path.resolve(this.repo_path, testPath);
        if (!isWithinRepo(fullTestPath, resolvedRepo)) {
          return createToolResult({
            success: false,
            error: `Access denied: test path '${testPath}' is outside repository bounds.`,
          });
        }

        try {
          await fsp.access(fullTestPath);
        } catch {
          return createToolResult({
            success: false,
            error: `Test path not found: '${testPath}'. Check the path is correct.`,
          });
        }
      }

      const check = await runCommand("which", ["node"], this.repo_path, 30_000);
      if (check.notFound || check.code !== 0) {
        return createToolResult({
          success: false,
          error: "Test runner 'node' not found. Ensure Node.js is installed and in PATH.",
        });
      }

      const result = testPath
        ? await runCommand("node", ["--import", "tsx", "--test", testPath], this.repo_path, 300_000)
        : await runCommand("npm", ["test"], this.repo_path, 300_000);

      if (result.notFound) {
        return createToolResult({
          success: false,
          error: "Command not found. Ensure Node.js, npm, and project dependencies are installed.",
        });
      }

      if (result.timedOut) {
        return createToolResult({
          success: false,
          error:
            "Tests timed out after 5 minutes. " +
            "This may indicate hanging tests or an infinite loop. " +
            "Consider running specific test files instead of the entire suite.",
        });
      }

      if (result.code === 0) {
        return createToolResult({
          success: true,
          output: result.stdout,
          data: { exit_code: 0, test_path: testPath },
        });
      }

      const errorMsg = result.stderr ? result.stderr : result.stdout;
      return createToolResult({
        success: false,
        output: result.stdout,
        error:
          `Tests failed with exit code ${result.code}. ` +
          "Review the output to identify failing tests.",
        data: { exit_code: result.code ?? -1, stderr: errorMsg.slice(0, 500) },
      });
    } catch (e) {
      return createToolResult({
        success: false,
        error: `Failed to run tests: ${String(e)}`,
      });
    }
  }

  /** Create a git commit. */
  async toolGitCommit(message: string | null, files: string[] | null): Promise<ToolResult> {
    if (!this.repo_path) {
      return createToolResult({
        success: false,
        error: "Repository path not configured. Cannot perform git operations.",
      });
    }

    if (!message || !message.trim()) {
      return createToolResult({
        success: false,
        error: "Commit message cannot be empty. Provide a descriptive commit message.",
      });
    }

    try {
      const resolvedRepo = path.resolve(this.repo_path);

      const checkGit = await runCommand(
        "git",
        ["rev-parse", "--git-dir"],
        this.repo_path,
        30_000,
      );
      if (checkGit.notFound) {
        return createToolResult({
          success: false,
          error: "Git command not found. Ensure git is installed and in PATH.",
        });
      }
      if (checkGit.code !== 0) {
        return createToolResult({
          success: false,
          error: `Not a git repository: ${this.repo_path}. Cannot perform git operations.`,
        });
      }

      const status = await runCommand(
        "git",
        ["status", "--porcelain"],
        this.repo_path,
        30_000,
      );
      if (!status.stdout.trim()) {
        return createToolResult({
          success: false,
          error:
            "No changes to commit. Working tree is clean. " +
            "Make changes to files before creating a commit.",
        });
      }

      if (files && files.length > 0) {
        for (const file of files) {
          const filePath = path.resolve(this.repo_path, file);
          if (!isWithinRepo(filePath, resolvedRepo)) {
            return createToolResult({
              success: false,
              error: `Access denied: '${file}' is outside repository bounds.`,
            });
          }

          const rel = path.relative(resolvedRepo, filePath);
          const parts = rel.split(path.sep);
          if (parts.length > 0 && parts[0] === ".git") {
            return createToolResult({
              success: false,
              error: "Access denied: cannot add files from .git directory.",
            });
          }

          try {
            await fsp.access(filePath);
          } catch {
            return createToolResult({
              success: false,
              error:
                `File not found: '${file}'. ` +
                "Cannot add non-existent file to commit.",
            });
          }

          const addResult = await runCommand("git", ["add", file], this.repo_path, 30_000);
          if (addResult.code !== 0) {
            return createToolResult({
              success: false,
              error: `Failed to add '${file}': ${addResult.stderr || "Unknown error"}`,
            });
          }
        }
      } else {
        const addAll = await runCommand("git", ["add", "-A"], this.repo_path, 30_000);
        if (addAll.code !== 0) {
          return createToolResult({
            success: false,
            error: "Failed to stage changes. Check git status.",
          });
        }
      }

      const commitResult = await runCommand(
        "git",
        ["commit", "-m", message],
        this.repo_path,
        30_000,
      );

      if (commitResult.code === 0) {
        const msgPreview =
          message.length > 60 ? message.slice(0, 60) + "..." : message;
        return createToolResult({
          success: true,
          output: `Successfully created commit: ${msgPreview}`,
          data: { message, files: files && files.length > 0 ? files : "all changes" },
        });
      }

      const errorOutput = commitResult.stderr || "Unknown error";
      if (errorOutput.toLowerCase().includes("nothing to commit")) {
        return createToolResult({
          success: false,
          error: "No changes to commit. All changes may have been already committed.",
        });
      }
      if (errorOutput.toLowerCase().includes("hook")) {
        return createToolResult({
          success: false,
          error:
            `Git hook failed: ${errorOutput}. ` +
            "Fix the issues identified by the pre-commit hook.",
        });
      }
      return createToolResult({
        success: false,
        error: `Commit failed: ${errorOutput}`,
      });
    } catch (e) {
      return createToolResult({
        success: false,
        error: `Failed to create commit: ${String(e)}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new ExecutionPolicy().runCommand(cmd, args, { cwd, timeoutMs }).then((result) => ({
    code: result.status < 0 ? null : result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut ?? false,
    notFound: result.notFound ?? false,
  }));
}

function errCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

function isEnoent(e: unknown): boolean {
  return errCode(e) === "ENOENT";
}

function isEacces(e: unknown): boolean {
  return errCode(e) === "EACCES";
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function strVal(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}

function optStrVal(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numVal(v: unknown): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

function optNumVal(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function arrVal<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Return true if `target` is equal to or nested inside `repo`. */
function isWithinRepo(target: string, repo: string): boolean {
  const rel = path.relative(repo, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Simple single-segment wildcard match supporting `*` and `?`. */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(name);
}
