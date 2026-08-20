import { Worker } from "bullmq";
import { REPORTS_QUEUE, getBlockingConnection, type ReportJobData } from "@openbooks/jobs";
import { withBypassContext, withOrgContext } from "../db.ts";
import { dispatchReportDeliveries, processScheduledReportRun } from "../report-delivery.ts";
import { renderReportPdf } from "./render-client.ts";

/**
 * Redis only wakes the durable database run. Rendering, immutable artifact
 * evidence, and recipient outbox creation are committed before email dispatch.
 */
export function createReportsWorker(): Worker<ReportJobData> {
  return new Worker<ReportJobData>(
    REPORTS_QUEUE,
    async (job) => {
      const d = job.data;
      // The run belongs to one tenant and is claimed/rendered inside its scope;
      // draining the delivery outbox afterwards is org-spanning outbox work and
      // crosses its own explicit trusted boundary. A queue callback has neither
      // by default, and RLS would otherwise deny both silently.
      const result = await withOrgContext(d.orgId, () =>
        processScheduledReportRun(
          d.runId,
          (orgId, definitionId, runId) => renderReportPdf(orgId, definitionId, { ...d.params, runId }),
        ));
      await withBypassContext(() => dispatchReportDeliveries());
      return { runId: d.runId, ...result };
    },
    { connection: getBlockingConnection(), concurrency: 3 },
  );
}
