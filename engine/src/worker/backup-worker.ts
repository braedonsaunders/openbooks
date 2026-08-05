import { Worker } from "bullmq";
import { BACKUP_QUEUE, getBlockingConnection, type BackupJobData } from "@openbooks/jobs";
import { executeBackupRun } from "../backup.ts";

/**
 * Consumes the `backup` queue: full-organization exports to S3 object storage.
 * Concurrency 1 — an export streams every tenant table through one snapshot
 * transaction; serializing avoids piling heavy reads onto the pool and
 * saturating object storage with parallel uploads.
 */
export function createBackupWorker(): Worker<BackupJobData> {
  return new Worker<BackupJobData>(
    BACKUP_QUEUE,
    async (job) => {
      const d = job.data;
      switch (d.op) {
        case "run":
          return await executeBackupRun(d.runId);
      }
    },
    { connection: getBlockingConnection(), concurrency: 1 },
  );
}
