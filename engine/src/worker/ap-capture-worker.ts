import { Worker } from "bullmq";
import {
  AP_CAPTURE_QUEUE,
  getBlockingConnection,
  type ApCaptureJobData,
} from "@openbooks/jobs";
import { withOrgContext } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { db } from "../platform/db.ts";
import { processCaptureItem } from "../payables/ap-capture-service.ts";

/**
 * Resolve the job's subsidiary scope: the enqueue-time capture when present,
 * otherwise re-derived from the actor (jobs enqueued before the payload
 * carried a scope). A job with neither carries no restriction — capture
 * uploads without an attributable actor are system-driven.
 */
async function scopeForCaptureJob(
  orgId: string,
  data: Pick<ApCaptureJobData, "actorId" | "allowedSubsidiaryIds">,
): Promise<ReadonlySet<string> | null> {
  if (data.allowedSubsidiaryIds !== undefined) {
    return data.allowedSubsidiaryIds === null ? null : new Set(data.allowedSubsidiaryIds);
  }
  if (!data.actorId) return null;
  return actorAllowedSubsidiaryIds(db, orgId, data.actorId);
}

export function createApCaptureWorker(): Worker<ApCaptureJobData> {
  return new Worker<ApCaptureJobData>(
    AP_CAPTURE_QUEUE,
    async (job) => {
      // Queue callbacks carry no request store; the job's tenant is the scope.
      await withOrgContext(job.data.orgId, () =>
        (async () => {
          const allowedSubsidiaryIds = await scopeForCaptureJob(job.data.orgId, job.data);
          return processCaptureItem({ ...job.data, allowedSubsidiaryIds });
        })(),
      );
      return { captureItemId: job.data.captureItemId };
    },
    { connection: getBlockingConnection(), concurrency: 3 },
  );
}
