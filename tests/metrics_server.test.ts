import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MetricsRegistry,
  escapeMetricLabelValue,
  metricLabelKey,
  registerLoopMetrics,
  registerProcessMetrics,
  renderMetricLabels,
  renderPrometheusText,
  startMetricsServer,
} from "../metrics_server";

test("escapeMetricLabelValue escapes backslashes, newlines and quotes", () => {
  assert.equal(escapeMetricLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
});

test("metricLabelKey is stable across label insertion order", () => {
  assert.equal(metricLabelKey({ b: "2", a: "1" }), metricLabelKey({ a: "1", b: "2" }));
  assert.equal(metricLabelKey({ a: "1" }), "a=1");
  assert.equal(metricLabelKey({}), "");
});

test("metricLabelKey drops undefined labels", () => {
  assert.equal(metricLabelKey({ a: undefined, b: "x" }), "b=x");
});

test("renderMetricLabels renders escaped label sets", () => {
  assert.equal(renderMetricLabels({ result: "success" }), '{result="success"}');
  assert.equal(renderMetricLabels({}), "");
});

test("registry counters accumulate per label set", () => {
  const registry = new MetricsRegistry();
  registry.define("merge_god_prs_processed_total", "PRs processed", "counter");
  registry.inc("merge_god_prs_processed_total", { result: "success" });
  registry.inc("merge_god_prs_processed_total", { result: "success" });
  registry.inc("merge_god_prs_processed_total", { result: "failure" });
  assert.equal(registry.sample("merge_god_prs_processed_total", { result: "success" }), 2);
  assert.equal(registry.sample("merge_god_prs_processed_total", { result: "failure" }), 1);
  assert.equal(registry.sample("merge_god_prs_processed_total"), 0);
});

test("registry rejects type redefinition and undefined metrics", () => {
  const registry = new MetricsRegistry();
  registry.define("some_metric", "help", "counter");
  assert.throws(() => registry.define("some_metric", "help", "gauge"));
  assert.throws(() => registry.inc("missing_metric"));
});

test("renderPrometheusText emits HELP, TYPE and sorted samples", () => {
  const registry = new MetricsRegistry();
  registry.define("merge_god_queue_size", "Queue size", "gauge");
  registry.set("merge_god_queue_size", 3, { queue: "untagged" });
  registry.set("merge_god_queue_size", 1, { queue: "for-review" });
  const text = registry.render();
  const lines = text.split("\n");
  assert.equal(lines[0], "# HELP merge_god_queue_size Queue size");
  assert.equal(lines[1], "# TYPE merge_god_queue_size gauge");
  assert.ok(lines.includes('merge_god_queue_size{queue="for-review"} 1'));
  assert.ok(lines.includes('merge_god_queue_size{queue="untagged"} 3'));
  assert.ok(text.endsWith("\n"));
});

test("collectors run on every render", () => {
  const registry = new MetricsRegistry();
  registry.define("observed_value", "Observed", "gauge");
  let calls = 0;
  registry.addCollector((target) => {
    calls += 1;
    target.set("observed_value", calls);
  });
  registry.render();
  registry.render();
  assert.equal(calls, 2);
  assert.equal(registry.sample("observed_value"), 2);
});

test("registerLoopMetrics exposes the loop metric contract", () => {
  const registry = new MetricsRegistry();
  const loop = registerLoopMetrics(registry);
  loop.iterations();
  loop.iterations();
  loop.syncFailure();
  loop.prProcessed("success");
  loop.prProcessed("failure");
  loop.issueProcessed("skipped");
  loop.queueSize("for-landing", 4);
  loop.active(2, 1);
  const text = registry.render();
  assert.ok(text.includes("merge_god_loop_iterations_total 2"));
  assert.ok(text.includes("merge_god_repo_sync_failures_total 1"));
  assert.ok(text.includes('merge_god_prs_processed_total{result="success"} 1'));
  assert.ok(text.includes('merge_god_prs_processed_total{result="failure"} 1'));
  assert.ok(text.includes('merge_god_issues_processed_total{result="skipped"} 1'));
  assert.ok(text.includes('merge_god_queue_size{queue="for-landing"} 4'));
  assert.ok(text.includes("merge_god_active_prs 2"));
  assert.ok(text.includes("merge_god_active_issues 1"));
});

test("registerProcessMetrics publishes build info and live process gauges", () => {
  const registry = new MetricsRegistry();
  registerProcessMetrics(registry, { version: "test", startTime: Date.now() - 1000 });
  const text = registry.render();
  assert.ok(text.includes('merge_god_build_info{node_version="' + process.version + '",version="test"} 1'));
  const uptime = registry.sample("merge_god_process_uptime_seconds");
  assert.ok(uptime >= 1);
  assert.ok(registry.sample("merge_god_process_resident_memory_bytes") > 0);
});

test("renderPrometheusText replaces non-finite values with zero", () => {
  const registry = new MetricsRegistry();
  registry.define("weird_metric", "Weird", "gauge");
  registry.set("weird_metric", Number.NaN);
  const text = renderPrometheusText([[ "weird_metric", {
    help: "Weird",
    type: "gauge",
    samples: new Map([["", { labels: {}, value: Number.NaN }]]),
  }]]);
  assert.ok(text.includes("weird_metric 0"));
});

test("metrics server serves /metrics and /healthz on loopback", async () => {
  const registry = new MetricsRegistry();
  registerLoopMetrics(registry);
  registry.inc("merge_god_loop_iterations_total");
  const server = await startMetricsServer({
    registry,
    host: "127.0.0.1",
    port: 0,
    serviceName: "merge-god-pr-loop",
  });
  try {
    assert.equal(server.host, "127.0.0.1");
    assert.ok(server.port > 0);

    const metricsRes = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    assert.equal(metricsRes.status, 200);
    assert.ok(
      (metricsRes.headers.get("content-type") ?? "").startsWith("text/plain"),
    );
    const body = await metricsRes.text();
    assert.ok(body.includes("merge_god_loop_iterations_total 1"));

    const healthRes = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "merge-god-pr-loop");

    const missingRes = await fetch(`http://127.0.0.1:${server.port}/nope`);
    assert.equal(missingRes.status, 404);
  } finally {
    await server.stop();
  }
});

test("metrics server stop closes the socket", async () => {
  const registry = new MetricsRegistry();
  const server = await startMetricsServer({ registry, host: "127.0.0.1", port: 0 });
  await server.stop();
  await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/metrics`));
});
