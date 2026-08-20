import { Worker } from "bullmq";
import {
  AP_CAPTURE_QUEUE,
  getBlockingConnection,
  type ApCaptureJobData,
} from "@openbooks/jobs";
import { withOrgContext } from "../db.ts";
import { processCaptureItem } from "../ap-capture-service.ts";

export function createApCaptureWorker(): Worker<ApCaptureJobData> {
  return new Worker<ApCaptureJobData>(
    AP_CAPTURE_QUEUE,
    async (job) => {
      // Queue callbacks carry no request store; the job's tenant is the scope.
      await withOrgContext(job.data.orgId, () => processCaptureItem(job.data));
      return { captureItemId: job.data.captureItemId };
    },
    { connection: getBlockingConnection(), concurrency: 3 },
  );
}
