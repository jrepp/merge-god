/**
 * Loopback observability endpoint for merge-god long-running processes.
 *
 * Exposes Prometheus text-format metrics at /metrics and a JSON liveness
 * probe at /healthz. Intended to be bound to loopback (or a private
 * interface) and scraped by an internal Prometheus.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export type MetricLabels = Record<string, string | number | boolean | undefined>;

export type MetricType = "counter" | "gauge";

interface MetricSample {
  labels: MetricLabels;
  value: number;
}

interface MetricFamily {
  help: string;
  type: MetricType;
  samples: Map<string, MetricSample>;
}

export function escapeMetricLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function metricLabelKey(labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "";
  return entries.map(([name, value]) => `${name}=${String(value)}`).join(",");
}

export function renderMetricLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([name, value]) => `${name}="${escapeMetricLabelValue(String(value))}"`)
    .join(",");
  return `{${rendered}}`;
}

export function renderPrometheusText(families: Iterable<[string, MetricFamily]>): string {
  const lines: string[] = [];
  for (const [name, family] of families) {
    lines.push(`# HELP ${name} ${family.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
    lines.push(`# TYPE ${name} ${family.type}`);
    const samples = [...family.samples.values()].sort((a, b) =>
      metricLabelKey(a.labels) < metricLabelKey(b.labels) ? -1 : 1,
    );
    for (const sample of samples) {
      const value = Number.isFinite(sample.value) ? sample.value : 0;
      lines.push(`${name}${renderMetricLabels(sample.labels)} ${value}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export class MetricsRegistry {
  private readonly _families = new Map<string, MetricFamily>();
  private readonly _collectors = new Set<(registry: MetricsRegistry) => void>();

  define(name: string, help: string, type: MetricType): void {
    const existing = this._families.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(`metric ${name} already defined as ${existing.type}`);
      }
      return;
    }
    this._families.set(name, { help, type, samples: new Map() });
  }

  inc(name: string, labels: MetricLabels = {}, by = 1): void {
    const current = this.sample(name, labels);
    this.set(name, current + by, labels);
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    const family = this._families.get(name);
    if (!family) throw new Error(`metric ${name} is not defined`);
    family.samples.set(metricLabelKey(labels), { labels, value });
  }

  sample(name: string, labels: MetricLabels = {}): number {
    const family = this._families.get(name);
    if (!family) return 0;
    return family.samples.get(metricLabelKey(labels))?.value ?? 0;
  }

  addCollector(collector: (registry: MetricsRegistry) => void): () => void {
    this._collectors.add(collector);
    return () => this._collectors.delete(collector);
  }

  render(): string {
    for (const collector of this._collectors) {
      collector(this);
    }
    return renderPrometheusText(this._families.entries());
  }

  reset(): void {
    for (const family of this._families.values()) {
      family.samples.clear();
    }
  }
}

export interface ProcessMetricsOptions {
  version?: string;
  startTime?: number;
}

export function registerProcessMetrics(registry: MetricsRegistry, options: ProcessMetricsOptions = {}): void {
  const version = options.version ?? "unknown";
  const startTime = options.startTime ?? Date.now();
  registry.define("merge_god_build_info", "Build metadata; value is always 1", "gauge");
  registry.define("merge_god_process_uptime_seconds", "Seconds since the process started", "gauge");
  registry.define("merge_god_process_resident_memory_bytes", "Resident set size in bytes", "gauge");
  registry.define("merge_god_process_heap_used_bytes", "V8 heap used in bytes", "gauge");
  registry.define("merge_god_process_heap_total_bytes", "V8 heap total in bytes", "gauge");
  registry.set("merge_god_build_info", 1, { version, node_version: process.version });
  registry.addCollector((target) => {
    const memory = process.memoryUsage();
    target.set("merge_god_process_uptime_seconds", Math.max(0, (Date.now() - startTime) / 1000));
    target.set("merge_god_process_resident_memory_bytes", memory.rss);
    target.set("merge_god_process_heap_used_bytes", memory.heapUsed);
    target.set("merge_god_process_heap_total_bytes", memory.heapTotal);
  });
}

export interface LoopMetrics {
  iterations: () => void;
  syncFailure: () => void;
  prProcessed: (result: "success" | "failure" | "skipped") => void;
  issueProcessed: (result: "success" | "failure" | "skipped") => void;
  queueSize: (queue: "for-review" | "for-landing" | "untagged", size: number) => void;
  active: (prs: number, issues: number) => void;
  render: () => string;
}

export function registerLoopMetrics(registry: MetricsRegistry): LoopMetrics {
  registry.define("merge_god_loop_iterations_total", "Processing loop iterations started", "counter");
  registry.define("merge_god_repo_sync_failures_total", "Failed repository sync passes", "counter");
  registry.define(
    "merge_god_prs_processed_total",
    "PRs processed by outcome (success, failure, skipped)",
    "counter",
  );
  registry.define(
    "merge_god_issues_processed_total",
    "Issues processed by outcome (success, failure, skipped)",
    "counter",
  );
  registry.define(
    "merge_god_queue_size",
    "Open PRs observed per queue at the last categorization",
    "gauge",
  );
  registry.define("merge_god_active_prs", "PRs currently held by the loop", "gauge");
  registry.define("merge_god_active_issues", "Issues currently held by the loop", "gauge");
  return {
    iterations: () => registry.inc("merge_god_loop_iterations_total"),
    syncFailure: () => registry.inc("merge_god_repo_sync_failures_total"),
    prProcessed: (result) => registry.inc("merge_god_prs_processed_total", { result }),
    issueProcessed: (result) => registry.inc("merge_god_issues_processed_total", { result }),
    queueSize: (queue, size) => registry.set("merge_god_queue_size", size, { queue }),
    active: (prs, issues) => {
      registry.set("merge_god_active_prs", prs);
      registry.set("merge_god_active_issues", issues);
    },
    render: () => registry.render(),
  };
}

export interface MetricsServer {
  host: string;
  port: number;
  registry: MetricsRegistry;
  stop: () => Promise<void>;
}

export interface MetricsServerOptions {
  registry: MetricsRegistry;
  host?: string;
  port?: number;
  serviceName?: string;
}

export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const registry = options.registry;
  const serviceName = options.serviceName ?? "merge-god";
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/metrics" || url.startsWith("/metrics?"))) {
      let body: string;
      try {
        body = registry.render();
      } catch {
        body = "";
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        service: serviceName,
        uptime_seconds: Math.max(0, (Date.now() - startedAt) / 1000),
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        host: addr.address,
        port: addr.port,
        registry,
        stop: () =>
          new Promise((resolveStop, rejectStop) => {
            server.close((err) => (err ? rejectStop(err) : resolveStop()));
          }),
      });
    });
  });
}
