/**
 * OpenTelemetry signals for the durable-work surfaces — spans around each unit
 * of background work, plus counters/histograms an operator can alert on.
 *
 * Disabled by default and free when disabled: every span/metric call goes
 * through the @opentelemetry/api no-op until `startTelemetry()` registers a
 * real SDK. Boot happens where the background processes are assembled (the
 * standalone worker's `main()` and Next's nodejs instrumentation) and only
 * when a shared or signal-specific OTLP endpoint is set, so enabling
 * observability is a deployment concern, never a code change. Any OTLP/HTTP
 * receiver (Grafana Agent/Alloy, Jaeger, Datadog OTel gateway, …) speaks the
 * same protocol; there is deliberately no vendor SDK here.
 *
 * Signals emitted under the scope "openbooks.engine":
 *
 *   span      scheduler.tick                     one full scheduler pass
 *   span      outbox.attempt                     per scheduler_outbox row attempt
 *   span      report_run.process                 per scheduled report run
 *   counter   openbooks.outbox.attempts          {openbooks.surface,
 *                                               openbooks.kind,
 *                                               openbooks.outcome}
 *   histogram openbooks.outbox.attempt_duration  ms; same attrs minus outcome
 *   counter   openbooks.terminal_failures        poison rows that reached their
 *                                                attempt ceiling; {surface, kind}
 *
 * `openbooks.terminal_failures` is the metric hook for the durable stamping in
 * terminal-failure.ts: it increments exactly once per confirmed poison row —
 * the same transition that writes `terminal_failed_at` and the structured
 * "scheduler.terminal_failure" log line — so an alert can page on any increase
 * instead of tailing logs or polling the partial-indexed SQL queries (see
 * terminal-failure.ts for those).
 */
import {
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Exception,
  type Histogram,
  type Span,
} from "@opentelemetry/api";

export const TELEMETRY_SCOPE = "openbooks.engine";

/** Common attribute keys so dashboards can group consistently across signals. */
export const ATTR_SURFACE = "openbooks.surface";
export const ATTR_KIND = "openbooks.kind";
export const ATTR_OUTCOME = "openbooks.outcome";
export const ATTR_ORG_ID = "openbooks.org_id";
export const ATTR_ROW_ID = "openbooks.row_id";
export const ATTR_RUN_ID = "openbooks.run_id";
export const ATTR_DEFINITION_ID = "openbooks.definition_id";

export type OutboxSurface = "scheduler_outbox" | "report_runs" | "posting_effects";

const tracer = trace.getTracer(TELEMETRY_SCOPE);

// Unlike the tracing API (which proxies and upgrades after an SDK registers),
// the metrics API resolves meters at call time, so instruments created at
// module load would be pinned to the no-op provider forever. Bind instruments
// to the current global provider and re-create them exactly when that provider
// instance changes (i.e. once, when startTelemetry() registers the SDK).
type Instruments = {
  attempts: Counter;
  duration: Histogram;
  terminalFailures: Counter;
};
let boundProvider: unknown;
let instruments: Instruments | null = null;

function metricsInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (!instruments || boundProvider !== provider) {
    boundProvider = provider;
    const meter = provider.getMeter(TELEMETRY_SCOPE);
    instruments = {
      attempts: meter.createCounter("openbooks.outbox.attempts", {
        description: "Durable-work attempts by surface, work kind, and outcome.",
        unit: "{attempt}",
      }),
      duration: meter.createHistogram("openbooks.outbox.attempt_duration", {
        description: "Wall-clock duration of durable-work attempts.",
        unit: "ms",
        advice: {
          explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
        },
      }),
      terminalFailures: meter.createCounter("openbooks.terminal_failures", {
        description:
          "Outbox rows whose final allowed attempt failed (poison rows). Alert on any increase; the stamped database row carries the details.",
        unit: "{failure}",
      }),
    };
  }
  return instruments;
}

/**
 * Run `fn` inside an active span so nested work joins the same trace. Errors
 * are recorded on the span (status + exception) and rethrown — telemetry never
 * swallows a failure.
 */
export async function runInSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Count one durable-work attempt and its duration, tagged by outcome. */
export function recordOutboxAttempt(
  surface: OutboxSurface,
  kind: string,
  outcome: "succeeded" | "failed",
  durationMs: number,
): void {
  const tags: Attributes = {
    [ATTR_SURFACE]: surface,
    [ATTR_KIND]: kind,
    [ATTR_OUTCOME]: outcome,
  };
  const { attempts, duration } = metricsInstruments();
  attempts.add(1, tags);
  duration.record(Math.max(0, durationMs), {
    [ATTR_SURFACE]: surface,
    [ATTR_KIND]: kind,
  });
}

/**
 * Metric side of the one-and-only terminal transition in terminal-failure.ts.
 * Called from `logTerminalFailure` so the structured log line, the durable row
 * stamp, and this counter can never drift apart.
 */
export function recordTerminalFailure(
  surface:
    | "scheduler_outbox"
    | "report_runs"
    | "report_delivery_outbox"
    | "posting_effects",
  kind?: string | null,
): void {
  metricsInstruments().terminalFailures.add(1, {
    [ATTR_SURFACE]: surface,
    ...(kind ? { [ATTR_KIND]: kind } : {}),
  });
}

export type TelemetryEnv = Record<string, string | undefined>;

export type OtlpSignal = "traces" | "metrics" | "logs";

const SIGNAL_ENDPOINT_VARIABLES = {
  traces: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  metrics: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  logs: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
} as const satisfies Record<OtlpSignal, string>;

function configuredEndpoint(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function splitUrlSuffix(value: string): [base: string, suffix: string] {
  const suffixIndex = value.search(/[?#]/);
  return suffixIndex === -1
    ? [value, ""]
    : [value.slice(0, suffixIndex), value.slice(suffixIndex)];
}

function ensureRootPath(value: string): string {
  const [base, suffix] = splitUrlSuffix(value);
  return /^https?:\/\/[^/]+$/i.test(base) ? `${base}/${suffix}` : value;
}

/**
 * Resolve an OTLP/HTTP signal URL exactly as specified by OpenTelemetry.
 * Signal-specific values win and are returned byte-for-byte unless they omit
 * a path, in which case the required root path is added. The shared value is a
 * base URL, so only its path receives the relative `v1/<signal>` path.
 */
export function resolveOtlpHttpEndpoint(
  env: TelemetryEnv,
  signal: OtlpSignal,
): string | undefined {
  const specific = env[SIGNAL_ENDPOINT_VARIABLES[signal]];
  if (configuredEndpoint(specific)) return ensureRootPath(specific);

  const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!configuredEndpoint(shared)) return undefined;
  const [base, suffix] = splitUrlSuffix(shared);
  return `${base.endsWith("/") ? base : `${base}/`}v1/${signal}${suffix}`;
}

/** Telemetry is configured when any shared or signal-specific endpoint exists. */
export function telemetryEnabled(env: TelemetryEnv = process.env): boolean {
  return (["traces", "metrics", "logs"] as const).some(
    (signal) => resolveOtlpHttpEndpoint(env, signal) !== undefined,
  );
}

function signalDisabled(env: TelemetryEnv, varName: "OTEL_TRACES_EXPORTER" | "OTEL_METRICS_EXPORTER"): boolean {
  return env[varName] === "none";
}

function enabledExportEndpoint(
  env: TelemetryEnv,
  signal: "traces" | "metrics",
): string | undefined {
  const exporterVariable = signal === "traces" ? "OTEL_TRACES_EXPORTER" : "OTEL_METRICS_EXPORTER";
  return signalDisabled(env, exporterVariable)
    ? undefined
    : resolveOtlpHttpEndpoint(env, signal);
}

/** Parse the standard OTEL_RESOURCE_ATTRIBUTES "k=v,k2=v2" list (URL-encoded). */
function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const attributes: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key || !value) continue;
    try {
      attributes[key] = decodeURIComponent(value);
    } catch {
      attributes[key] = value;
    }
  }
  return attributes;
}

let bootPromise: Promise<boolean> | null = null;
const shutdowns: Array<() => Promise<void>> = [];

/**
 * Register the OTLP/HTTP SDK once per process when configured. Returns whether
 * anything was registered. Disabled calls are free and leave no state; a
 * second enabled call is a no-op (the API globals cannot be swapped), and a
 * failed boot is logged loudly but never fatal — losing telemetry must not
 * take accounting down with it.
 */
export function startTelemetry(env: TelemetryEnv = process.env): Promise<boolean> {
  if (!telemetryEnabled(env)) return Promise.resolve(false);
  if (!enabledExportEndpoint(env, "traces") && !enabledExportEndpoint(env, "metrics")) {
    return Promise.resolve(false);
  }
  bootPromise ??= boot(env).catch((error) => {
    console.error(
      JSON.stringify({
        event: "telemetry.start_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  });
  return bootPromise;
}

/** Parse the standard OTEL_EXPORTER_OTLP_HEADERS "k=v,k2=v2" list (URL-encoded). */
function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key || !value) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

async function boot(env: TelemetryEnv): Promise<boolean> {
  const tracesEndpoint = enabledExportEndpoint(env, "traces");
  const metricsEndpoint = enabledExportEndpoint(env, "metrics");
  const tracesOn = tracesEndpoint !== undefined;
  const metricsOn = metricsEndpoint !== undefined;

  const [{ resourceFromAttributes }, traceSdk, metricsSdk, tracesExporter, metricsExporter] =
    await Promise.all([
      import("@opentelemetry/resources"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
    ]);

  const interval = Number.parseInt(env.OTEL_METRIC_EXPORT_INTERVAL ?? "", 10);
  const resource = resourceFromAttributes({
    "service.name": env.OTEL_SERVICE_NAME || "openbooks",
    ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
  });
  // Exporter config is passed explicitly (not through process.env) so boot
  // honors exactly the environment this call was given.
  const exporterDefaults = { headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) };

  if (tracesOn) {
    // v2 SDKs dropped provider.register(): globals are set through the API.
    const provider = new traceSdk.BasicTracerProvider({
      resource,
      spanProcessors: [
        new traceSdk.BatchSpanProcessor(
          new tracesExporter.OTLPTraceExporter({
            ...exporterDefaults,
            url: tracesEndpoint,
          }),
        ),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    shutdowns.push(() => provider.shutdown());
  }

  if (metricsOn) {
    const provider = new metricsSdk.MeterProvider({
      resource,
      readers: [
        new metricsSdk.PeriodicExportingMetricReader({
          exporter: new metricsExporter.OTLPMetricExporter({
            ...exporterDefaults,
            url: metricsEndpoint,
          }),
          exportIntervalMillis: Number.isFinite(interval) && interval > 0 ? interval : 60_000,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(provider);
    shutdowns.push(() => provider.shutdown());
  }

  console.log(
    JSON.stringify({
      event: "telemetry.started",
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      signals: [
        ...(tracesOn ? ["traces"] : []),
        ...(metricsOn ? ["metrics"] : []),
      ].join(","),
    }),
  );
  return true;
}

/**
 * Flush and shut down every registered provider. Safe to call multiple times
 * and safe to call when telemetry was never enabled.
 */
export async function stopTelemetry(): Promise<void> {
  await bootPromise?.catch(() => {});
  await Promise.allSettled(
    shutdowns.splice(0).map((shutdown) =>
      shutdown().catch((error) => {
        console.error(
          JSON.stringify({
            event: "telemetry.shutdown_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    ),
  );
}
