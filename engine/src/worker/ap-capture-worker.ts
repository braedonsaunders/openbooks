import { Worker } from "bullmq";
import {
  AP_CAPTURE_QUEUE,
  getBlockingConnection,
  type ApCaptureJobData,
} from "@openbooks/jobs";
import { processCaptureItem } from "../ap-capture-service.ts";

export function createApCaptureWorker(): Worker<ApCaptureJobData> {
  return new Worker<ApCaptureJobData>(
    AP_CAPTURE_QUEUE,
    async (job) => {
      await processCaptureItem(job.data);
      return { captureItemId: job.data.captureItemId };
    },
    { connection: getBlockingConnection(), concurrency: 3 },
  );
}
