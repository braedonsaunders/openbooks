import {
  createQueuedBackupRun,
  markBackupEnqueueFailed,
} from "@openbooks/engine/backup/backup-queue";
import { s3Enabled } from "@openbooks/engine/platform/file-storage";
import { enqueueBackupRun } from "@openbooks/jobs";

export type ManualBackupQueueResult =
  | { kind: "storage_unavailable" }
  | { kind: "already_running" }
  | { kind: "queue_failed" }
  | { kind: "queued"; runId: string };

export async function queueManualBackup(
  orgId: string,
  actorId: string,
): Promise<ManualBackupQueueResult> {
  if (!s3Enabled) return { kind: "storage_unavailable" };

  let runId: string;
  try {
    runId = await createQueuedBackupRun(orgId, actorId);
  } catch (error) {
    const wrapped = error as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const code = wrapped.code ?? wrapped.cause?.code;
    const constraint = wrapped.constraint ?? wrapped.cause?.constraint;
    if (code === "23505" && constraint === "backup_runs_one_inflight_per_org") {
      return { kind: "already_running" };
    }
    throw error;
  }

  try {
    await enqueueBackupRun({ op: "run", runId, orgId }, { jobId: runId });
    return { kind: "queued", runId };
  } catch (error) {
    const message = ((error as Error).message || String(error)).slice(0, 2000);
    try {
      const outcome = await markBackupEnqueueFailed(orgId, runId, actorId, message);
      if (outcome === "accepted") return { kind: "queued", runId };
    } catch (cleanupError) {
      console.error(
        `[backup] run ${runId}: enqueue failure cleanup failed:`,
        (cleanupError as Error).message,
      );
    }
    return { kind: "queue_failed" };
  }
}
