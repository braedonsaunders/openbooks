/**
 * OpenBooks background worker — a standalone process (run: `tsx
 * engine/src/worker/index.ts`, or the `worker` compose service). Consumes the
 * BullMQ queues (emails, reports) and runs the report-schedule scanner. This is
 * the durable, horizontally-scalable home for scheduled work — reports today,
 * scripts/notifications next (add a queue + consumer here).
 */
import { closeJobConnections, markWorkerHeartbeat } from "@openbooks/jobs";
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
import { assertSafeRuntimeDatabaseRole } from "../db.ts";

async function main(): Promise<void> {
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
      await markWorkerHeartbeat();
    } catch (error) {
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
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeJobConnections();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[worker] startup failed:", error);
  process.exit(1);
});
