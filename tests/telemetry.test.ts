import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildTelemetryConfig, parseOtelHeaders, sanitizeSpanAttributes } from "../telemetry";

describe("telemetry configuration", () => {
  test("stays disabled without telemetry environment", () => {
    const config = buildTelemetryConfig({}, { serviceName: "merge-god-test" });

    assert.equal(config.enabled, false);
    assert.equal(config.exporter, "none");
    assert.equal(config.source, "disabled");
    assert.equal(config.serviceName, "merge-god-test");
  });

  test("maps Opik environment to OTLP traces endpoint and headers", () => {
    const config = buildTelemetryConfig({
      OPIK_API_KEY: "opik-key",
      OPIK_WORKSPACE_NAME: "team",
      OPIK_PROJECT_NAME: "merge-god-prod",
    });

    assert.equal(config.enabled, true);
    assert.equal(config.exporter, "otlp");
    assert.equal(config.source, "opik");
    assert.equal(config.tracesUrl, "https://www.comet.com/opik/api/v1/private/otel/v1/traces");
    assert.equal(config.metricsUrl, "https://www.comet.com/opik/api/v1/private/otel/v1/metrics");
    assert.deepEqual(config.headers, {
      Authorization: "opik-key",
      "Comet-Workspace": "team",
      projectName: "merge-god-prod",
    });
  });

  test("honors generic OTLP endpoint and appends the traces path", () => {
    const config = buildTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20token,tenant=merge-god",
    });

    assert.equal(config.enabled, true);
    assert.equal(config.source, "otel");
    assert.equal(config.tracesUrl, "http://collector.test:4318/v1/traces");
    assert.equal(config.metricsUrl, "http://collector.test:4318/v1/metrics");
    assert.deepEqual(config.headers, {
      Authorization: "Bearer token",
      tenant: "merge-god",
    });
  });

  test("honors signal-specific OTLP endpoints and headers", () => {
    const config = buildTelemetryConfig({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.test/custom/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector.test/custom/metrics",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "trace-key=trace-value",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "metric-key=metric-value",
    });

    assert.equal(config.enabled, true);
    assert.equal(config.tracesUrl, "http://collector.test/custom/traces");
    assert.equal(config.metricsUrl, "http://collector.test/custom/metrics");
    assert.deepEqual(config.headers, {
      "trace-key": "trace-value",
      "metric-key": "metric-value",
    });
  });

  test("explicit false disables telemetry even when Opik is configured", () => {
    const config = buildTelemetryConfig({
      MERGE_GOD_TELEMETRY_ENABLED: "false",
      OPIK_API_KEY: "opik-key",
    });

    assert.equal(config.enabled, false);
    assert.equal(config.exporter, "none");
    assert.equal(config.source, "disabled");
  });

  test("parses OTEL header lists defensively", () => {
    assert.deepEqual(parseOtelHeaders("a=1,b=two%20words,missing,=bad,c="), {
      a: "1",
      b: "two words",
    });
  });

  test("sanitizes span attributes to OpenTelemetry-compatible values", () => {
    assert.deepEqual(
      sanitizeSpanAttributes({
        name: "merge",
        count: 2,
        ok: true,
        empty: null,
        tags: ["for-review", "ci"],
        detail: { pr: 123 },
      }),
      {
        name: "merge",
        count: 2,
        ok: true,
        tags: ["for-review", "ci"],
        detail: "{\"pr\":123}",
      },
    );
  });
});
