import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  recordOutboxAttempt,
  runInSpan,
  startTelemetry,
  stopTelemetry,
  type TelemetryEnv,
} from "./telemetry.ts";
import { logTerminalFailure } from "./terminal-failure.ts";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

test("telemetry is disabled without a collector endpoint", async () => {
  assert.equal(await startTelemetry({}), false);
  assert.equal(await startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }), false);
  // Both signals explicitly off is also "nothing to do" even with an endpoint.
  assert.equal(
    await startTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
    }),
    false,
  );
});

test("configured telemetry exports real OTLP traces and metrics to the collector", async () => {
  const hits = { traces: 0, metrics: 0 };
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
    });
    request.on("end", () => {
      if (bytes > 0 && path.endsWith("/v1/traces")) hits.traces++;
      if (bytes > 0 && path.endsWith("/v1/metrics")) hits.metrics++;
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === "object", "collector did not start");
  const env: TelemetryEnv = {
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
    OTEL_SERVICE_NAME: "openbooks-telemetry-boot-test",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test",
    OTEL_METRIC_EXPORT_INTERVAL: "100",
  };

  try {
    assert.equal(await startTelemetry(env), true);
    // A second enabled call is idempotent: the API globals cannot be swapped.
    assert.equal(await startTelemetry(env), true);

    // Emissions after boot must reach the collector over real HTTP.
    await runInSpan("boot.evidence", { "openbooks.test": "boot" }, async () => undefined);
    recordOutboxAttempt("scheduler_outbox", "dunning", "succeeded", 4);
    logTerminalFailure({
      surface: "scheduler_outbox",
      kind: "dunning",
      id: "poison-1",
      orgId: null,
      attempts: 8,
      error: "terminal for the test",
      markedBy: "telemetry-boot-test",
      at: new Date(),
    });

    await stopTelemetry();

    const deadline = Date.now() + 10_000;
    while ((hits.traces === 0 || hits.metrics === 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(hits.traces >= 1, "no trace export reached the collector");
    assert.ok(hits.metrics >= 1, "no metric export reached the collector");
  } finally {
    await stopTelemetry();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the background processes are wired to boot and flush telemetry", () => {
  const worker = source("./worker/index.ts");
  assert.match(worker, /startTelemetry\(\)/);
  assert.match(worker, /stopTelemetry\(\)/);
  const instrumentation = source("../../web/instrumentation.node.ts");
  assert.match(instrumentation, /startTelemetry\(\)/);
});
