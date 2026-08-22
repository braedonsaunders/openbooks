import { Worker } from "bullmq";
import { EMAIL_QUEUE, getBlockingConnection, type EmailJobData } from "@openbooks/jobs";
import { sendVia } from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  resolveOrgEmailTransport,
} from "../email-config.ts";
import { withOrgContext } from "../db.ts";
import { isSandboxOrg } from "../sandbox/guard.ts";
import {
  markReportDeliveryFailed,
  markReportDeliverySent,
  markReportDeliveryStarted,
  markReportDeliverySuppressed,
} from "../report-delivery.ts";

/**
 * Consumes the `emails` queue: one job = one recipient. Resolves the org's
 * provider transport, records an email_log row, sends, and stamps sent/failed.
 * A missing transport is recorded as `suppressed` and acked (no infinite retry);
 * a send error is recorded and rethrown so BullMQ retries with backoff.
 */
export function createEmailWorker(): Worker<EmailJobData> {
  return new Worker<EmailJobData>(
    EMAIL_QUEUE,
    async (job) => {
      const d = job.data;
      // Every read and write below (transport config, email_log, delivery
      // outbox) belongs to the job's tenant. A queue callback carries no request
      // store, so this scope is what makes those queries legal at all.
      return await withOrgContext(d.orgId, async () => {
      const reportDeliveryId = d.meta?.reportDeliveryId;
      if (reportDeliveryId) await markReportDeliveryStarted(d.orgId, reportDeliveryId, job.id ?? null);
      // Hard sandbox block: a sandbox never sends email, regardless of any
      // provider config that survived the clone. Recorded as suppressed + acked.
      if (await isSandboxOrg(d.orgId)) {
        const logId = await insertEmailLog({
          orgId: d.orgId,
          jobId: job.id ?? null,
          recipients: [d.to],
          subject: d.subject,
          status: "suppressed",
          categoryKey: d.meta?.category ?? null,
          meta: { ...d.meta, reason: "sandbox environment — email egress blocked" },
        });
        if (reportDeliveryId) {
          await markReportDeliverySuppressed(d.orgId, reportDeliveryId, logId, "sandbox environment — email egress blocked");
        }
        return { suppressed: true, sandbox: true };
      }
      const transport = await resolveOrgEmailTransport(d.orgId);
      if (!transport) {
        const logId = await insertEmailLog({
          orgId: d.orgId,
          jobId: job.id ?? null,
          recipients: [d.to],
          subject: d.subject,
          status: "suppressed",
          categoryKey: d.meta?.category ?? null,
          meta: { ...d.meta, reason: "email provider not configured" },
        });
        if (reportDeliveryId) {
          await markReportDeliverySuppressed(d.orgId, reportDeliveryId, logId, "email provider not configured");
        }
        return { suppressed: true };
      }
      const logId = await insertEmailLog({
        orgId: d.orgId,
        jobId: job.id ?? null,
        provider: transport.provider,
        recipients: [d.to],
        fromAddr: transport.from,
        replyToAddr: transport.replyTo ?? null,
        subject: d.subject,
        status: "queued",
        categoryKey: d.meta?.category ?? null,
        meta: d.meta ?? {},
      });
      try {
        const { id } = await sendVia(transport, {
          to: d.to,
          subject: d.subject,
          html: d.html,
          text: d.text,
          attachments: d.attachments,
        });
        await markEmailSent(d.orgId, logId, id);
        if (reportDeliveryId) await markReportDeliverySent(d.orgId, reportDeliveryId, logId, id);
        return { id };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await markEmailFailed(d.orgId, logId, message);
        if (reportDeliveryId) {
          const finalQueueAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          await markReportDeliveryFailed(d.orgId, reportDeliveryId, logId, message, finalQueueAttempt);
        }
        throw e;
      }
      });
    },
    { connection: getBlockingConnection(), concurrency: 5 },
  );
}
