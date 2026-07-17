import { Queue, type JobsOptions } from "bullmq";
import { getConnection } from "../connection";

export const AP_CAPTURE_QUEUE = "ap-capture";

export type ApCaptureJobData = {
  orgId: string;
  captureItemId: string;
  actorId?: string;
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
