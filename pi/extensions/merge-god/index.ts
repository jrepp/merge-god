/**
 * merge-god pi extension.
 *
 * Connects the pi coding agent to the merge-god coordination API
 * (merge_god/coordination.py). merge-god publishes a work item — the gathered
 * prompt/context for a PR or issue — and these tools let the agent pull that
 * context and report results back, replacing the former `bob --json <prompt>`
 * subprocess contract.
 *
 * The coordination API URL is provided by merge-god via the MERGE_GOD_API
 * environment variable when it launches pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface WorkItem {
  kind?: string;
  repo?: string;
  repo_path?: string;
  pr_number?: number;
  issue_number?: number;
  mode?: string;
  title?: string;
  prompt: string;
  [key: string]: unknown;
}

interface CompleteInput {
  status?: string;
  summary?: string;
  merged?: boolean;
  commits?: string[];
  error?: string;
}

interface ApiResponse {
  ok: boolean;
  status: number;
  data: any;
}

function apiUrl(): string {
  const url = process.env.MERGE_GOD_API;
  if (!url) {
    throw new Error(
      "MERGE_GOD_API is not set. merge-god sets it when launching pi with this extension.",
    );
  }
  return url.replace(/\/+$/, "");
}

async function callApi(path: string, init?: RequestInit): Promise<ApiResponse> {
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function formatWorkItem(item: WorkItem): string {
  const lines: string[] = ["# merge-god work item", ""];
  const meta: string[] = [];
  if (item.repo) meta.push(`- **Repository:** ${item.repo}`);
  if (item.repo_path) meta.push(`- **Repo path:** ${item.repo_path}`);
  if (item.pr_number) meta.push(`- **PR:** #${item.pr_number}`);
  if (item.issue_number) meta.push(`- **Issue:** #${item.issue_number}`);
  if (item.mode) meta.push(`- **Mode:** ${item.mode}`);
  if (item.title) meta.push(`- **Title:** ${item.title}`);
  if (meta.length) {
    lines.push(...meta, "");
  }
  lines.push("## Prompt", "", item.prompt.trim() || "_(no prompt body)_");
  return lines.join("\n");
}

export default function mergeGodPiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "merge_god_context",
    label: "merge-god context",
    description:
      "Fetch the current merge-god work item (the PR/issue prompt and gathered context) from the merge-god coordination API. Call this first, before doing any work.",
    promptSnippet: "Load the current merge-god work item.",
    promptGuidelines: [
      "Call merge_god_context first to load the prompt/context for the work merge-god has assigned.",
      "Do the work in the repository with your file and shell tools, then report back with merge_god_complete.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      try {
        const { ok, status, data } = await callApi("/work");
        if (!ok || !data?.work) {
          return {
            content: [
              {
                type: "text",
                text: `No merge-god work item is currently available (HTTP ${status}).`,
              },
            ],
            details: { ok: false, status },
          };
        }
        const item = data.work as WorkItem;
        return {
          content: [{ type: "text", text: formatWorkItem(item) }],
          details: { ok: true, work_item: item },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_complete",
    label: "merge-god complete",
    description:
      "Report completion back to the merge-god coordination API. Call this once you have finished the work (or given up), with a status and a concise summary.",
    promptSnippet: "Report completion to merge-god.",
    promptGuidelines: [
      "Call merge_god_complete exactly once when done, with status 'success' or 'failure' and a concise summary.",
      "Include commit SHAs and whether the PR was merged when known.",
    ],
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["success", "failure"],
          description: "Whether the work succeeded.",
        },
        summary: {
          type: "string",
          description: "A concise summary of what was done.",
        },
        merged: {
          type: "boolean",
          description: "Whether the PR was merged (if applicable).",
        },
        commits: {
          type: "array",
          items: { type: "string" },
          description: "Commit SHAs produced, if any.",
        },
        error: {
          type: "string",
          description: "Error details, when status is 'failure'.",
        },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as CompleteInput;
      try {
        const { ok, status, data } = await callApi("/result", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const text = ok
          ? `Result recorded by merge-god (${input.status}): ${input.summary}`
          : `Failed to record result with merge-god (HTTP ${status}).`;
        return {
          content: [{ type: "text", text }],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "merge_god_health",
    label: "merge-god health",
    description: "Check that the merge-god coordination API is reachable. Useful for debugging connectivity.",
    promptSnippet: "Check merge-god coordination API health.",
    promptGuidelines: [
      "Use merge_god_health only to diagnose connectivity, not as part of normal PR processing.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      try {
        const { ok, status, data } = await callApi("/health");
        return {
          content: [
            { type: "text", text: ok ? `merge-god coordination API is healthy (HTTP ${status}).` : `Unhealthy (HTTP ${status}).` },
          ],
          details: { ok, status, data },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Cannot reach the merge-god coordination API: ${(err as Error).message}` },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  } as any);
}
