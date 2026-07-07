import {
  metrics,
  trace,
  SpanStatusCode,
  type Span,
  type SpanAttributes,
  type SpanAttributeValue,
  type MetricAttributes,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export type TelemetryExporter = "none" | "console" | "otlp";

export interface TelemetryConfig {
  enabled: boolean;
  exporter: TelemetryExporter;
  serviceName: string;
  serviceVersion?: string;
  tracesUrl?: string;
  metricsUrl?: string;
  headers: Record<string, string>;
  environment?: string;
  source: "disabled" | "explicit" | "otel" | "opik" | "console";
}

export interface TelemetryRuntime {
  config: TelemetryConfig;
  shutdown(): Promise<void>;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_SERVICE_NAME = "merge-god";
const DEFAULT_OPIK_TRACES_URL = "https://www.comet.com/opik/api/v1/private/otel/v1/traces";
const DEFAULT_OPIK_METRICS_URL = "https://www.comet.com/opik/api/v1/private/otel/v1/metrics";

let runtime: TelemetryRuntime | null = null;
let promptRenderedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;
let promptSizeHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null;
let agentRunCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;
let agentDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null;

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = envText(env, name);
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

export function parseOtelHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const rawValue = pair.slice(idx + 1).trim();
    if (!key || !rawValue) continue;
    try {
      headers[key] = decodeURIComponent(rawValue);
    } catch {
      headers[key] = rawValue;
    }
  }
  return headers;
}

function asTracesUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

function asMetricsUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/v1/metrics") ? normalized : `${normalized}/v1/metrics`;
}

function opikHeaders(env: NodeJS.ProcessEnv, serviceName: string): Record<string, string> {
  const apiKey = envText(env, "OPIK_API_KEY");
  if (!apiKey) return {};
  const workspace =
    envText(env, "OPIK_WORKSPACE_NAME") ??
    envText(env, "OPIK_COMET_WORKSPACE") ??
    envText(env, "COMET_WORKSPACE") ??
    "default";
  const projectName = envText(env, "OPIK_PROJECT_NAME") ?? serviceName;
  return {
    Authorization: apiKey,
    "Comet-Workspace": workspace,
    projectName,
  };
}

export function buildTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { serviceName?: string; serviceVersion?: string } = {},
): TelemetryConfig {
  const explicitEnabled = envBool(env, "MERGE_GOD_TELEMETRY_ENABLED");
  const serviceName =
    envText(env, "OTEL_SERVICE_NAME") ??
    envText(env, "MERGE_GOD_TELEMETRY_SERVICE_NAME") ??
    defaults.serviceName ??
    DEFAULT_SERVICE_NAME;
  const serviceVersion =
    envText(env, "MERGE_GOD_TELEMETRY_SERVICE_VERSION") ??
    envText(env, "npm_package_version") ??
    defaults.serviceVersion;
  const environment =
    envText(env, "MERGE_GOD_TELEMETRY_ENVIRONMENT") ??
    envText(env, "OTEL_RESOURCE_ATTRIBUTES")?.match(/(?:^|,)deployment\.environment=([^,]+)/)?.[1];

  if (explicitEnabled === false) {
    return {
      enabled: false,
      exporter: "none",
      serviceName,
      serviceVersion,
      headers: {},
      environment,
      source: "disabled",
    };
  }

  const requestedExporter = envText(env, "MERGE_GOD_TELEMETRY_EXPORTER")?.toLowerCase();
  if (requestedExporter === "console") {
    return {
      enabled: true,
      exporter: "console",
      serviceName,
      serviceVersion,
      headers: {},
      environment,
      source: "console",
    };
  }

  const tracesEndpoint =
    envText(env, "MERGE_GOD_OTEL_TRACES_ENDPOINT") ??
    envText(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  const metricsEndpoint =
    envText(env, "MERGE_GOD_OTEL_METRICS_ENDPOINT") ??
    envText(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT");
  const otlpEndpoint = envText(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const opikEndpoint = envText(env, "OPIK_OTEL_TRACES_ENDPOINT");
  const opikMetricsEndpoint = envText(env, "OPIK_OTEL_METRICS_ENDPOINT");
  const hasOpik = Boolean(envText(env, "OPIK_API_KEY"));

  const tracesUrl = tracesEndpoint
    ?? (otlpEndpoint ? asTracesUrl(otlpEndpoint) : undefined)
    ?? (hasOpik ? opikEndpoint ?? DEFAULT_OPIK_TRACES_URL : undefined);
  const metricsUrl = metricsEndpoint
    ?? (otlpEndpoint ? asMetricsUrl(otlpEndpoint) : undefined)
    ?? (hasOpik ? opikMetricsEndpoint ?? DEFAULT_OPIK_METRICS_URL : undefined);
  const otelHeaders = {
    ...parseOtelHeaders(envText(env, "OTEL_EXPORTER_OTLP_HEADERS")),
    ...parseOtelHeaders(envText(env, "OTEL_EXPORTER_OTLP_TRACES_HEADERS")),
    ...parseOtelHeaders(envText(env, "OTEL_EXPORTER_OTLP_METRICS_HEADERS")),
  };
  const headers = hasOpik ? { ...opikHeaders(env, serviceName), ...otelHeaders } : otelHeaders;

  const enabled = explicitEnabled === true || Boolean(tracesUrl || metricsUrl);
  return {
    enabled,
    exporter: enabled && (tracesUrl || metricsUrl) ? "otlp" : "none",
    serviceName,
    serviceVersion,
    tracesUrl,
    metricsUrl,
    headers,
    environment,
    source: hasOpik ? "opik" : tracesUrl || metricsUrl ? "otel" : explicitEnabled === true ? "explicit" : "disabled",
  };
}

export function initializeTelemetry(
  config: TelemetryConfig = buildTelemetryConfig(),
  log: (eventType: string, data: Record<string, unknown>) => void = () => undefined,
): TelemetryRuntime {
  if (runtime) return runtime;

  if (!config.enabled || config.exporter === "none") {
    runtime = {
      config,
      async shutdown() {
        return undefined;
      },
    };
    log("telemetry", {
      action: "disabled",
      source: config.source,
      service_name: config.serviceName,
    });
    return runtime;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion ? { [ATTR_SERVICE_VERSION]: config.serviceVersion } : {}),
    ...(config.environment ? { "deployment.environment": config.environment } : {}),
  });
  const spanProcessors =
    config.exporter === "console"
      ? [new SimpleSpanProcessor(new ConsoleSpanExporter())]
      : [
          new BatchSpanProcessor(
            new OTLPTraceExporter({
              url: config.tracesUrl,
              headers: config.headers,
            }),
          ),
        ];
  const metricReaders =
    config.exporter === "console"
      ? [
          new PeriodicExportingMetricReader({
            exporter: new ConsoleMetricExporter(),
            exportIntervalMillis: 10_000,
          }),
        ]
      : config.metricsUrl
        ? [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                url: config.metricsUrl,
                headers: config.headers,
              }),
              exportIntervalMillis: 30_000,
            }),
          ]
        : undefined;

  const sdk = new NodeSDK({ resource, spanProcessors, metricReaders });
  sdk.start();

  runtime = {
    config,
    async shutdown() {
      await sdk.shutdown();
    },
  };
  log("telemetry", {
    action: "enabled",
    exporter: config.exporter,
    source: config.source,
    service_name: config.serviceName,
    traces_url: config.tracesUrl,
    metrics_url: config.metricsUrl,
    has_headers: Object.keys(config.headers).length > 0,
  });
  return runtime;
}

export function getTelemetryRuntime(): TelemetryRuntime | null {
  return runtime;
}

export async function shutdownTelemetry(): Promise<void> {
  const current = runtime;
  runtime = null;
  await current?.shutdown();
}

export function telemetryTracer() {
  return trace.getTracer("merge-god");
}

export function telemetryMeter() {
  return metrics.getMeter("merge-god");
}

export function sanitizeSpanAttributes(input: Record<string, unknown>): SpanAttributes {
  const attrs: SpanAttributes = {};
  for (const [key, value] of Object.entries(input)) {
    const sanitized = sanitizeSpanAttributeValue(value);
    if (sanitized !== undefined) attrs[key] = sanitized;
  }
  return attrs;
}

function sanitizeSpanAttributeValue(value: unknown): SpanAttributeValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.every((item): item is string => typeof item === "string")) return value;
    if (value.every((item): item is number => typeof item === "number")) return value;
    if (value.every((item): item is boolean => typeof item === "boolean")) return value;
    return JSON.stringify(value);
  }
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
}

export function addTelemetryEvent(name: string, attributes: Record<string, unknown> = {}): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.addEvent(name, sanitizeSpanAttributes(attributes));
}

function metricAttributes(input: Record<string, unknown>): MetricAttributes {
  return sanitizeSpanAttributes(input) as MetricAttributes;
}

function meterInstruments() {
  const meter = telemetryMeter();
  promptRenderedCounter ??= meter.createCounter("merge_god.prompt.rendered", {
    description: "Prompt render or submission count",
    unit: "1",
  });
  promptSizeHistogram ??= meter.createHistogram("merge_god.prompt.size", {
    description: "Rendered prompt size in characters",
    unit: "By",
  });
  agentRunCounter ??= meter.createCounter("merge_god.agent.run", {
    description: "Agent run count by result",
    unit: "1",
  });
  agentDurationHistogram ??= meter.createHistogram("merge_god.agent.duration", {
    description: "Agent run duration in seconds",
    unit: "s",
  });
  return {
    promptRenderedCounter,
    promptSizeHistogram,
    agentRunCounter,
    agentDurationHistogram,
  };
}

export function recordPromptRendered(
  promptKind: string,
  prompt: string,
  attributes: Record<string, unknown> = {},
): void {
  const attrs = metricAttributes({
    "merge_god.prompt_kind": promptKind,
    ...attributes,
  });
  const instruments = meterInstruments();
  instruments.promptRenderedCounter.add(1, attrs);
  instruments.promptSizeHistogram.record(prompt.length, attrs);
  addTelemetryEvent("merge_god.prompt_rendered", {
    prompt_kind: promptKind,
    prompt_size: prompt.length,
    ...attributes,
  });
}

export function recordAgentRun(
  agentKind: string,
  success: boolean,
  durationSeconds: number,
  attributes: Record<string, unknown> = {},
): void {
  const attrs = metricAttributes({
    "merge_god.agent_kind": agentKind,
    "merge_god.result_status": success ? "success" : "failure",
    ...attributes,
  });
  const instruments = meterInstruments();
  instruments.agentRunCounter.add(1, attrs);
  instruments.agentDurationHistogram.record(durationSeconds, attrs);
  addTelemetryEvent("merge_god.agent_run_recorded", {
    agent_kind: agentKind,
    success,
    duration_seconds: durationSeconds,
    ...attributes,
  });
}

export async function withTelemetrySpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return telemetryTracer().startActiveSpan(name, { attributes: sanitizeSpanAttributes(attributes) }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.recordException(e instanceof Error ? e : new Error(String(e)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}
