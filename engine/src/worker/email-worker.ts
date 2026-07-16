import { Worker } from "bullmq";
import { EMAIL_QUEUE, getBlockingConnection, type EmailJobData } from "@openbooks/jobs";
import { sendVia } from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  resolveOrgEmailTransport,
} from "../email-config.ts";

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
      const transport = await resolveOrgEmailTransport(d.orgId);
      if (!transport) {
        await insertEmailLog({
          orgId: d.orgId,
          jobId: job.id ?? null,
          recipients: [d.to],
          subject: d.subject,
          status: "suppressed",
          categoryKey: d.meta?.category ?? null,
          meta: { ...d.meta, reason: "email provider not configured" },
        });
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
        await markEmailSent(logId, id);
        return { id };
      } catch (e) {
        await markEmailFailed(logId, e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    { connection: getBlockingConnection(), concurrency: 5 },
  );
}
