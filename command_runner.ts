/**
 * Async subprocess adapter.
 */

import { ExecutionPolicy, type OperationTrace } from "./execution_policy";

export type CommandTuple = [number, string, string];

export interface CommandRunner {
  run(cmd: string[], cwd?: string, timeout?: number, maxOutputSize?: number): Promise<CommandTuple>;
}

export interface CommandLogger {
  (eventType: string, data: Record<string, unknown>): void;
}

export function createSpawnCommandRunner(
  log: CommandLogger = () => undefined,
  policy = new ExecutionPolicy({ observer: (event: OperationTrace) => log("operation_trace", { ...event }) }),
): CommandRunner {
  return {
    async run(cmd, cwd, timeout = 300, maxOutputSize = 50 * 1024 * 1024) {
      const result = await policy.runCommand(cmd[0] ?? "", cmd.slice(1), {
        cwd,
        timeoutMs: timeout * 1000,
        maxBuffer: maxOutputSize + Math.floor(maxOutputSize / 2),
      });
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
      return [result.status, trimOutput(result.stdout, "stdout"), trimOutput(result.stderr, "stderr")];
    },
  };
}
