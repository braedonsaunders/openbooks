/**
 * OpenBooks background worker — a standalone process (run: `tsx
 * engine/src/worker/index.ts`, or the `worker` compose service). Consumes the
 * BullMQ queues (emails, reports) and runs the report-schedule scanner. This is
 * the durable, horizontally-scalable home for scheduled work — reports today,
 * scripts/notifications next (add a queue + consumer here).
 */
import { closeJobConnections } from "@openbooks/jobs";
import { createEmailWorker } from "./email-worker.ts";
import { createReportsWorker } from "./reports-worker.ts";
import { createMigrationWorker, startMirrorScheduler } from "./migration-worker.ts";
import { createSandboxWorker } from "./sandbox-worker.ts";
import { createScriptsWorker } from "./scripts-worker.ts";
import { startReportScheduler } from "./scheduler.ts";
import { startSandboxScheduler } from "./sandbox-scheduler.ts";
import { createApCaptureWorker } from "./ap-capture-worker.ts";

const workers = [
  createEmailWorker(),
  createReportsWorker(),
  createMigrationWorker(),
  createSandboxWorker(),
  createScriptsWorker(),
  createApCaptureWorker(),
];
startReportScheduler();
startSandboxScheduler();
startMirrorScheduler();

for (const w of workers) {
  w.on("failed", (job, err) => console.error(`[worker] ${w.name} job ${job?.id} failed:`, err?.message));
}
console.log("[worker] online — queues: emails, reports, migration, sandbox, scripts, ap-capture; report + sandbox schedulers ticking");

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} — draining…`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeJobConnections();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
