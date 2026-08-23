/**
 * OpenBooks background worker — a standalone process (run: `tsx
 * engine/src/worker/index.ts`, or the `worker` compose service). Consumes the
 * BullMQ queues (emails, reports) and runs the report-schedule scanner. This is
 * the durable, horizontally-scalable home for scheduled work — reports today,
 * scripts/notifications next (add a queue + consumer here).
 */
import { closeJobConnections, markWorkerHeartbeat } from "@openbooks/jobs";
import { writeFile, unlink } from "node:fs/promises";
import { createEmailWorker } from "./email-worker.ts";
import { createReportsWorker } from "./reports-worker.ts";
import { createCloseDeliveryWorker } from "./close-delivery-worker.ts";
import { createMigrationWorker, startMirrorScheduler } from "./migration-worker.ts";
import { createSandboxWorker } from "./sandbox-worker.ts";
import { createScriptsWorker } from "./scripts-worker.ts";
import { startReportScheduler } from "./scheduler.ts";
import { startSandboxScheduler } from "./sandbox-scheduler.ts";
import { startOverheadScheduler } from "./overhead-scheduler.ts";
import { createApCaptureWorker } from "./ap-capture-worker.ts";
import { createBackupWorker } from "./backup-worker.ts";
import { startBackupScheduler } from "./backup-scheduler.ts";
import { assertSafeRuntimeDatabaseRole, pool } from "../db.ts";
import { assertS3Ready, s3Enabled } from "../file-storage.ts";
import { startTelemetry, stopTelemetry } from "../telemetry.ts";

const ALIVE_FILE = process.env.OPENBOOKS_WORKER_ALIVE_FILE || "/tmp/openbooks-worker-alive";
const READY_FILE = process.env.OPENBOOKS_WORKER_READY_FILE || "/tmp/openbooks-worker-ready";

async function within<T>(operation: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("worker dependency check timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkObjectStorage(): Promise<void> {
  const required = process.env.OPENBOOKS_REQUIRE_S3_HEALTH === "1";
  if (!s3Enabled) {
    if (required) throw new Error("required object storage is not configured");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await assertS3Ready(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // OTel traces/metrics when OTEL_EXPORTER_OTLP_ENDPOINT is configured; a free
  // no-op otherwise (see telemetry.ts). First, so boot itself is observable.
  await startTelemetry();
  await assertSafeRuntimeDatabaseRole();
  const workers = [
    createEmailWorker(),
    createReportsWorker(),
    createCloseDeliveryWorker(),
    createMigrationWorker(),
    createSandboxWorker(),
    createScriptsWorker(),
    createApCaptureWorker(),
    createBackupWorker(),
  ];
  startReportScheduler();
  startSandboxScheduler();
  startMirrorScheduler();
  startOverheadScheduler();
  startBackupScheduler();

  for (const w of workers) {
    w.on("failed", (job, err) => console.error(`[worker] ${w.name} job ${job?.id} failed:`, err?.message));
  }
  console.log("[worker] online — queues: emails, reports, migration, sandbox, scripts, ap-capture, backup; report + sandbox + backup schedulers ticking");

  const heartbeat = async () => {
    try {
      // Separate process liveness from dependency readiness so a provider
      // outage removes this pod from work without triggering restart storms.
      await writeFile(ALIVE_FILE, new Date().toISOString(), { mode: 0o600 });
      await Promise.all([
        within(markWorkerHeartbeat()),
        within(pool.query("select 1")),
        within(checkObjectStorage()),
      ]);
      await writeFile(READY_FILE, new Date().toISOString(), { mode: 0o600 });
    } catch (error) {
      await unlink(READY_FILE).catch(() => {});
      console.error("[worker] heartbeat failed:", error instanceof Error ? error.message : error);
    }
  };
  void heartbeat();
  const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    console.log(`[worker] ${signal} — draining…`);
    await Promise.allSettled([...workers.map((w) => w.close()), closeJobConnections(), stopTelemetry()]);
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[worker] startup failed:", error);
  process.exit(1);
});
