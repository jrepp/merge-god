import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppStore } from "../../app_store";
import { findExtension, runPiAgent, type PiAgentResult } from "../../coordination";
import type { TrajectoryState } from "../../trajectory";
import { TrajectoryRuntime, type RuntimeStartResult } from "../../trajectory_runtime";

export type PiAgentScenario =
  | "success"
  | "agent_crash_before_session"
  | "agent_stall_before_session"
  | "agent_reported_failure"
  | "agent_crash_mid_turn"
  | "agent_timeout"
  | "tool_throw"
  | "tool_timeout"
  | "tool_missing_end"
  | "tool_duplicate_completion"
  | "tool_completion_before_start"
  | "coordination_disconnect"
  | "coordination_http_500"
  | "coordination_malformed_response";

export interface PiHarnessRun {
  scenario: PiAgentScenario;
  result: PiAgentResult;
  state: TrajectoryState;
  started: RuntimeStartResult;
  elapsed_ms: number;
  git_events: string[];
  git_metrics: string[];
  observations: string[];
}

export interface PiHarnessRunOptions {
  timeout_ms?: number;
  completion_grace_ms?: number;
}

const RUNNER_PATH = fileURLToPath(new URL("../fixtures/fake_pi_agent.mjs", import.meta.url));

export class PiAgentHarness {
  readonly temp_dir: string;
  readonly repo_dir: string;
  private readonly binDir: string;
  private readonly store: AppStore;
  private readonly runtime: TrajectoryRuntime;
  private runSequence = 0;

  constructor() {
    this.temp_dir = mkdtempSync(path.join(tmpdir(), "mg-pi-harness-"));
    this.binDir = path.join(this.temp_dir, "bin");
    this.repo_dir = path.join(this.temp_dir, "repo");
    mkdirSync(this.binDir);
    mkdirSync(this.repo_dir);
    writeFileSync(path.join(this.repo_dir, "README.md"), "# fake repo\n");
    writeFileSync(
      path.join(this.repo_dir, ".env"),
      "ZAI_API_KEY=fake-zai-key\nANTHROPIC_API_KEY=ignored\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "merge-god@example.test"],
      ["config", "user.name", "merge-god test"],
      ["add", "README.md"],
      ["commit", "-m", "Initial commit"],
    ]) {
      const result = spawnSync("git", args, { cwd: this.repo_dir, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
    }
    const piPath = path.join(this.binDir, "pi");
    writeFileSync(
      piPath,
      `#!/bin/sh\nexec node --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(RUNNER_PATH)} "$@"\n`,
    );
    chmodSync(piPath, 0o755);
    this.store = new AppStore(path.join(this.temp_dir, "trajectory.db"));
    this.runtime = new TrajectoryRuntime(this.store);
  }

  async run(scenario: PiAgentScenario, options: PiHarnessRunOptions = {}): Promise<PiHarnessRun> {
    const sequence = ++this.runSequence;
    const started = this.runtime.startPrAgentWorkflow({
      repo_name: "owner/repo",
      repo_path: this.repo_dir,
      pr_number: 1000 + sequence,
      mode: "for-review",
      title: `Pi harness ${scenario}`,
      labels: ["for-review"],
      model: "fake-pi",
    });
    const gitEvents: string[] = [];
    const gitMetrics: string[] = [];
    const observations: string[] = [];
    const startedAt = Date.now();
    const timeoutMs = options.timeout_ms ?? (
      scenario === "agent_timeout" || scenario === "agent_stall_before_session" || scenario === "tool_timeout"
        ? 750
        : 2000
    );
    const result = await runPiAgent(
      {
        kind: "trajectory_activity",
        repo: "owner/repo",
        repo_path: this.repo_dir,
        pr_number: 1000 + sequence,
        mode: "for-review",
        title: `Pi harness ${scenario}`,
        prompt: `Execute deterministic Pi harness scenario: ${scenario}.`,
        trajectory_refs: started.ids,
      },
      this.repo_dir,
      {
        extensionPath: findExtension(),
        extraEnv: {
          PATH: `${this.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          MERGE_GOD_FAULT_SCENARIO: scenario,
        },
        trajectory: this.runtime.bridgeForPiAgent(started.ids),
        gitObserver: {
          onEvent(event) {
            gitEvents.push(event.event);
          },
          onMetric(metric) {
            gitMetrics.push(metric.name);
          },
        },
        agentObserver(observation) {
          observations.push(observation.summary);
        },
        timeout: timeoutMs / 1000,
        completionGraceMs: options.completion_grace_ms ?? 250,
      },
    );
    const state = this.runtime.getRunState(started.ids.run_id);
    if (!state) throw new Error(`trajectory state missing for ${scenario}`);
    return {
      scenario,
      result,
      state,
      started,
      elapsed_ms: Date.now() - startedAt,
      git_events: gitEvents,
      git_metrics: gitMetrics,
      observations,
    };
  }

  close(): void {
    this.store.close();
    rmSync(this.temp_dir, { recursive: true, force: true });
  }
}
