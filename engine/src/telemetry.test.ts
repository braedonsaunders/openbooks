import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { metrics, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_KIND,
  ATTR_OUTCOME,
  ATTR_SURFACE,
  recordOutboxAttempt,
  resolveOtlpHttpEndpoint,
  runInSpan,
  TELEMETRY_SCOPE,
  telemetryEnabled,
} from "./telemetry.ts";
import {
  EMAIL_DELIVERY_WORKER_IDENTITY,
  logTerminalFailure,
  SCHEDULER_OUTBOX_WORKER_IDENTITY,
  TERMINAL_FAILURE_LOG_EVENT,
} from "./terminal-failure.ts";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

test("a signal-specific endpoint alone enables telemetry and is used verbatim", () => {
  const cases = [
    ["traces", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
    ["metrics", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"],
    ["logs", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"],
  ] as const;

  for (const [signal, variable] of cases) {
    const exactEndpoint = `https://${signal}.collector.example/custom/path/`;
    const env = { [variable]: exactEndpoint };
    assert.equal(telemetryEnabled(env), true, `${variable} must enable telemetry`);
    assert.equal(resolveOtlpHttpEndpoint(env, signal), exactEndpoint);
    for (const [otherSignal] of cases) {
      if (otherSignal !== signal) {
        assert.equal(resolveOtlpHttpEndpoint(env, otherSignal), undefined);
      }
    }
  }
});

test("a shared endpoint alone composes the standard path for every signal", () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/tenant/" };
  assert.equal(telemetryEnabled(env), true);
  assert.equal(resolveOtlpHttpEndpoint(env, "traces"), "https://collector.example/tenant/v1/traces");
  assert.equal(resolveOtlpHttpEndpoint(env, "metrics"), "https://collector.example/tenant/v1/metrics");
  assert.equal(resolveOtlpHttpEndpoint(env, "logs"), "https://collector.example/tenant/v1/logs");
});

test("a signal-specific endpoint takes precedence over the shared endpoint", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://shared.collector.example/base",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.collector.example/exact/",
  };
  assert.equal(telemetryEnabled(env), true);
  assert.equal(
    resolveOtlpHttpEndpoint(env, "metrics"),
    "https://metrics.collector.example/exact/",
  );
  assert.equal(
    resolveOtlpHttpEndpoint(env, "traces"),
    "https://shared.collector.example/base/v1/traces",
  );
});

test("telemetry is disabled when no endpoint is configured", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "   ",
  };
  assert.equal(telemetryEnabled(env), false);
  assert.equal(resolveOtlpHttpEndpoint(env, "traces"), undefined);
  assert.equal(resolveOtlpHttpEndpoint(env, "metrics"), undefined);
  assert.equal(resolveOtlpHttpEndpoint(env, "logs"), undefined);
});

// The in-process SDK stand-in for startTelemetry(): the same globals the boot
// registers, but exporting into memory. Instruments bind to the current global
// meter provider and re-bind if it changes, so import order stays irrelevant.
const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }),
);
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const meterProvider = new MeterProvider({
  readers: [
    // Long interval: collections happen only via forceFlush in collectMetrics().
    new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 }),
  ],
});
metrics.setGlobalMeterProvider(meterProvider);

/** Flush and return exactly the metrics collected since the previous call. */
async function collectMetrics(): Promise<MetricData[]> {
  await meterProvider.forceFlush();
  const snapshot = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  metricExporter.reset();
  return snapshot;
}

function findMetric(
  name: string,
  collected: MetricData[],
): MetricData {
  const metric = collected.find((candidate) => candidate.descriptor.name === name);
  assert.ok(metric, `${name} was not exported under ${TELEMETRY_SCOPE}`);
  return metric;
}

function sumPoints(points: Array<DataPoint<number>>, wanted: Record<string, string>): number {
  return points
    .filter((point) =>
      Object.entries(wanted).every(([key, value]) => point.attributes[key] === value),
    )
    .reduce((total, point) => total + Number(point.value), 0);
}

function counterPoints(name: string, collected: MetricData[]): Array<DataPoint<number>> {
  const metric = findMetric(name, collected);
  assert.equal(metric.dataPointType, DataPointType.SUM, `${name} must be a counter`);
  return metric.dataPoints;
}

function histogramPoints(name: string, collected: MetricData[]): Array<DataPoint<Histogram>> {
  const metric = findMetric(name, collected);
  assert.equal(metric.dataPointType, DataPointType.HISTOGRAM, `${name} must be a histogram`);
  return metric.dataPoints as Array<DataPoint<Histogram>>;
}

test("runInSpan completes a span carrying its attributes", async () => {
  const result = await runInSpan("test.success", { "openbooks.test": "ok" }, async () => 7);
  assert.equal(result, 7);
  const span = spanExporter.getFinishedSpans().find((candidate) => candidate.name === "test.success");
  assert.ok(span, "success span was not exported");
  assert.equal(span.attributes["openbooks.test"], "ok");
  assert.equal(span.status.code, 0 /* UNSET */);
  assert.ok(span.endTime[0] > 0, "span was never ended");
});

test("runInSpan marks failed work and records the exception without swallowing it", async () => {
  await assert.rejects(
    runInSpan("test.failure", undefined, async () => {
      throw new Error("poison effect");
    }),
    /poison effect/,
  );
  const span = spanExporter.getFinishedSpans().find((candidate) => candidate.name === "test.failure");
  assert.ok(span, "failure span was not exported");
  assert.equal(span.status.code, 2 /* ERROR */);
  const exception = span.events.find((event) => event.name === "exception");
  assert.match(String(exception?.attributes?.["exception.message"]), /poison effect/);
});

test("every confirmed poison row bumps openbooks.terminal_failures exactly once per row", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    logTerminalFailure({
      surface: "scheduler_outbox",
      kind: "dunning",
      id: "row-1",
      orgId: null,
      attempts: 8,
      error: "obligation poisoned",
      markedBy: SCHEDULER_OUTBOX_WORKER_IDENTITY,
      at: new Date(),
    });
    logTerminalFailure({
      surface: "report_delivery_outbox",
      id: "row-2",
      orgId: null,
      attempts: 10,
      error: "smtp gave up",
      markedBy: EMAIL_DELIVERY_WORKER_IDENTITY,
      at: new Date(),
    });
  } finally {
    console.log = original;
  }
  assert.equal(lines.filter((line) => line.includes(TERMINAL_FAILURE_LOG_EVENT)).length, 2);

  const terminal = counterPoints("openbooks.terminal_failures", await collectMetrics());
  assert.equal(
    sumPoints(terminal, {
      [ATTR_SURFACE]: "scheduler_outbox",
      [ATTR_KIND]: "dunning",
    }),
    1,
    "a scheduler_outbox/dunning poison row must count exactly once",
  );

  // A surface without an outbox discriminator exports no kind tag at all
  // rather than a misleading null.
  const delivery = terminal.filter(
    (point) =>
      point.attributes[ATTR_SURFACE] === "report_delivery_outbox" &&
      point.attributes[ATTR_KIND] === undefined,
  );
  assert.equal(delivery.length, 1);
  assert.equal(Number(delivery[0].value), 1);
});

test("durable-work attempts are counted by outcome and measured by duration", async () => {
  recordOutboxAttempt("scheduler_outbox", "fx_providers", "succeeded", 12);
  recordOutboxAttempt("scheduler_outbox", "fx_providers", "failed", 2_500);
  recordOutboxAttempt("report_runs", "scheduled_report", "succeeded", 40_000);
  // A negative duration can only come from clock skew; clamping beats lying.
  recordOutboxAttempt("scheduler_outbox", "fx_providers", "failed", -5);

  const collected = await collectMetrics();

  const attempts = counterPoints("openbooks.outbox.attempts", collected);
  assert.equal(
    sumPoints(attempts, {
      [ATTR_SURFACE]: "scheduler_outbox",
      [ATTR_KIND]: "fx_providers",
      [ATTR_OUTCOME]: "succeeded",
    }),
    1,
  );
  assert.equal(
    sumPoints(attempts, {
      [ATTR_SURFACE]: "scheduler_outbox",
      [ATTR_KIND]: "fx_providers",
      [ATTR_OUTCOME]: "failed",
    }),
    2,
  );
  assert.equal(
    sumPoints(attempts, {
      [ATTR_SURFACE]: "report_runs",
      [ATTR_KIND]: "scheduled_report",
      [ATTR_OUTCOME]: "succeeded",
    }),
    1,
  );

  const durations = histogramPoints("openbooks.outbox.attempt_duration", collected);
  const fx = durations.find(
    (point) =>
      point.attributes[ATTR_SURFACE] === "scheduler_outbox" &&
      point.attributes[ATTR_KIND] === "fx_providers",
  );
  assert.ok(fx, "fx_providers duration point missing");
  assert.equal(fx.value.count, 3);
  assert.equal(fx.value.sum, 12 + 2_500 + 0);
  const report = durations.find(
    (point) =>
      point.attributes[ATTR_SURFACE] === "report_runs" &&
      point.attributes[ATTR_KIND] === "scheduled_report",
  );
  assert.ok(report, "scheduled_report duration point missing");
  assert.equal(report.value.sum, 40_000);
});

test("the durable-work surfaces stay wired to spans, outcome metrics, and the terminal counter", () => {
  const outbox = source("./scheduler-outbox.ts");
  assert.match(outbox, /runInSpan\(\s*"outbox\.attempt"/);
  assert.match(outbox, /recordOutboxAttempt\(\s*"scheduler_outbox",\s*row\.kind,\s*"succeeded"/);
  assert.match(outbox, /recordOutboxAttempt\(\s*"scheduler_outbox",\s*row\.kind,\s*"failed"/);

  const delivery = source("./report-delivery.ts");
  assert.match(delivery, /runInSpan\(\s*"report_run\.process"/);
  assert.match(delivery, /recordOutboxAttempt\(\s*"report_runs",\s*"scheduled_report",\s*"succeeded"/);

  const tick = source("./worker/scheduler.ts");
  assert.match(tick, /runInSpan\(\s*"scheduler\.tick"/);

  const surfacing = source("./terminal-failure.ts");
  assert.match(surfacing, /recordTerminalFailure\(fields\.surface,\s*fields\.kind\)/);
});
