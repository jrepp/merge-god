/**
 * Quick script to send approval to a waiting pr-loop process.
 *
 * Ported from send_approval.py. Finds the running pr-loop process by
 * scanning /proc, then writes a `{"approved": true}` JSON line to that
 * process's stdin (/proc/{pid}/fd/0).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Find the running pr-loop process.
 *
 * Mirrors psutil.process_iter(["pid", "name", "cmdline"]): iterates the numeric
 * entries under /proc, reads each cmdline file (NUL-separated argv joined by
 * spaces), and returns the first PID whose cmdline contains "pr-loop".
 * Processes that vanish or are inaccessible are skipped, matching
 * NoSuchProcess/AccessDenied handling. Returns null when no match is found.
 */
export function findPrLoopProcess(): number | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      const raw = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      cmdline = raw.replace(/\0+$/g, "").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (cmdline.includes("pr-loop.ts") || cmdline.includes("merge-god-pr-loop")) {
      return Number(entry);
    }
  }
  return null;
}

/**
 * Send approval JSON to a process's stdin.
 *
 * Writes `{"approved": true}\n` to /proc/{pid}/fd/0 (truncate + write, matching
 * Python's `open(path, "w")`). Prints a success message and returns true on
 * success; prints the failure to stderr and returns false otherwise.
 */
export function sendApproval(pid: number): boolean {
  try {
    const stdinPath = `/proc/${pid}/fd/0`;
    const approval = { approved: true };
    writeFileSync(stdinPath, JSON.stringify(approval) + "\n", "utf8");
    console.log(`✓ Sent approval to pr-loop (PID ${pid})`);
    return true;
  } catch (e) {
    console.error(`✗ Failed to send approval: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function main(): void {
  console.log("Looking for pr-loop process...");
  const pid = findPrLoopProcess();

  if (!pid) {
    console.error("✗ No pr-loop process found");
    process.exit(1);
  }

  console.log(`Found pr-loop process (PID ${pid})`);
  console.log("Sending approval...");

  if (sendApproval(pid)) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
