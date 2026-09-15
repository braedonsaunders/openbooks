import { Worker } from "bullmq";
import { BACKUP_QUEUE, getBlockingConnection, type BackupJobData } from "@openbooks/jobs";
import { executeBackupRun } from "../backup.ts";

/**
 * Execute one `backup` queue payload — the exact code the worker callback
 * runs, extracted (same function, no shadow) so tests can drive a real
 * payload through it against live Postgres without standing up Redis.
 */
export async function processBackupJobData(d: BackupJobData): Promise<unknown> {
  switch (d.op) {
    case "run":
      return await executeBackupRun(d.runId);
    default: {
      // Unknown kinds (a poisoned payload, or an op from a release this
      // worker no longer knows) must fail LOUD: falling through would
      // resolve the promise and BullMQ would mark the job complete,
      // silently dropping the work with no dead-letter trace. attempts: 1
      // sends it straight to the failed set, retained and operator-visible.
      const op = (d as { op?: unknown }).op;
      throw new Error(`unknown backup job op: ${typeof op === "string" && op ? op : "(missing)"}`);
    }
  }
}

/**
 * Consumes the `backup` queue: full-organization exports to S3 object storage.
 * Concurrency 1 — an export streams every tenant table through one snapshot
 * transaction; serializing avoids piling heavy reads onto the pool and
 * saturating object storage with parallel uploads.
 */
export function createBackupWorker(): Worker<BackupJobData> {
  return new Worker<BackupJobData>(
    BACKUP_QUEUE,
    async (job) => processBackupJobData(job.data),
    { connection: getBlockingConnection(), concurrency: 1 },
  );
}
