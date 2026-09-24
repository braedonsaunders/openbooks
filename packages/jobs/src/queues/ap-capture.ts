import { Queue, type JobsOptions } from "bullmq";
import { getConnection } from "../connection";

export const AP_CAPTURE_QUEUE = "ap-capture";

export type ApCaptureJobData = {
  orgId: string;
  captureItemId: string;
  actorId?: string;
  /**
   * The uploader's subsidiary scope at enqueue time (null = unrestricted).
   * The worker carries it into the auto-materialize decision so a match on
   * an out-of-scope purchase order stays in review instead of auto-creating
   * another entity's vendor bill. Jobs enqueued before this field existed
   * re-derive the scope from the actor at run time.
   */
  allowedSubsidiaryIds?: string[] | null;
};

/**
 * Deterministic queue identity for one reprocess generation of a capture
 * item. Same item + same attempt generation always yields the same id, so a
 * double-click or retried request dedupes in BullMQ instead of running
 * extraction twice; a later generation (the worker's claim increments
 * `attempts` on every run) yields a new id, so a legitimate reprocess after
 * a completed or failed run is never swallowed by a retained completed job.
 * Wall-clock values must never feed this: a Date.now() id (the pre-fix
 * shape) dedupes nothing.
 */
export function apCaptureReprocessJobId(captureItemId: string, attempts: number): string {
  if (!captureItemId.trim()) throw new Error("ap-capture reprocess job identity requires the capture item id");
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("ap-capture reprocess job identity requires the non-negative attempt generation");
  }
  return `ap-capture|${captureItemId}|reprocess|a${attempts}`;
}

let queue: Queue<ApCaptureJobData> | undefined;

export function getApCaptureQueue(): Queue<ApCaptureJobData> {
  queue ??= new Queue<ApCaptureJobData>(AP_CAPTURE_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 30 * 24 * 3_600 },
      removeOnFail: { age: 90 * 24 * 3_600 },
    },
  });
  return queue;
}

export async function enqueueApCapture(data: ApCaptureJobData, options?: JobsOptions) {
  return getApCaptureQueue().add("extract", data, {
    jobId: `ap-capture|${data.captureItemId}`,
    ...options,
  });
}
