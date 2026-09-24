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
