/**
 * Async subprocess adapter.
 */

import { spawn } from "node:child_process";

export type CommandTuple = [number, string, string];

export interface CommandRunner {
  run(cmd: string[], cwd?: string, timeout?: number, maxOutputSize?: number): Promise<CommandTuple>;
}

export interface CommandLogger {
  (eventType: string, data: Record<string, unknown>): void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createSpawnCommandRunner(log: CommandLogger = () => undefined): CommandRunner {
  return {
    run(cmd, cwd, timeout = 300, maxOutputSize = 50 * 1024 * 1024) {
      return new Promise<CommandTuple>((resolveCommand) => {
        const child = spawn(cmd[0] ?? "", cmd.slice(1), {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (result: CommandTuple): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveCommand(result);
        };

        const trimOutput = (value: string, streamName: "stdout" | "stderr"): string => {
          const size = Buffer.byteLength(value, "utf8");
          if (size <= maxOutputSize) return value;
          log("command_warning", {
            warning: `${streamName} truncated`,
            size,
            max_size: maxOutputSize,
            command: cmd[0] ?? "unknown",
          });
          return value.slice(0, Math.floor(maxOutputSize / 2)) + "\n... [truncated] ...";
        };

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish([-1, stdout, stderr || `Command timed out after ${timeout} seconds`]);
        }, timeout * 1000);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            finish([-1, "", `Command not found: ${cmd[0] ?? "unknown"}`]);
          } else {
            finish([-1, "", `Command failed: ${errMsg(error)}`]);
          }
        });

        child.on("close", (code) => {
          finish([code ?? -1, trimOutput(stdout, "stdout"), trimOutput(stderr, "stderr")]);
        });
      });
    },
  };
}
