import { authorizeReportRun } from './render-client.ts';
import { Worker } from "bullmq";
import { EMAIL_QUEUE, getBlockingConnection, type EmailJobData } from "@openbooks/jobs";
import {
  deriveEmailDeliveryKey,
  reconcileDeliveryAttempts,
  sendVia,
} from "@openbooks/emails";
import {
  appendEmailAttemptEvent,
  claimEmailDeliveryLog,
  confirmEmailSentGuarded,
  markEmailFailed,
  markEmailSent,
  markEmailSuppressed,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from "../email-config.ts";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../db.ts";
import { isSandboxOrg } from "../sandbox/guard.ts";
import {
  markReportDeliveryFailed,
  markReportDeliverySent,
  markReportDeliveryStarted,
  markReportDeliverySuppressed,
} from "../report-delivery.ts";

/**
 * Consumes the `emails` queue: one job = one recipient.
 *
 * Delivery identity + uncertain-outcome reconciliation (#52): all attempts of
 * one logical delivery share a deterministic `delivery_key` and claim ONE
 * canonical email_log row whose meta.attempts forms the append-only lineage.
 *
 * - A prior unresolved attempt (timeout after transmission, confirmation lost)
 *   suppresses every later attempt: `reconcileDeliveryAttempts` refuses a
 *   blind re-send until an operator resolves the uncertainty — the queue may
 *   retry, but retries only record blocked-attempt evidence, never transmit.
 * - A prior confirmed acceptance closes the job with that provider message id
 *   without touching the wire again.
 *
 * A missing transport is recorded as `suppressed` and acked (no infinite
 * retry); definite send failures are recorded and rethrown so BullMQ retries
 * with backoff. Definite-failure row updates are status-guarded so they can
 * never overwrite `sent` or `uncertain`.
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
      // The delivery key is derived from durable inputs only — recomputing it
      // after any crash must produce the same identity (and therefore the same
      // canonical log row) instead of minting new mail.
      const deliveryKey = deriveEmailDeliveryKey({
        orgId: d.orgId,
        scope: reportDeliveryId ? `report:${reportDeliveryId}` : job.id ?? "",
        to: d.to,
      });

      // Hard sandbox block: a sandbox never sends email, regardless of any
      // provider config that survived the clone. Recorded as suppressed + acked.
      if (await isSandboxOrg(d.orgId)) {
        const claimed = await claimEmailDeliveryLog({
          orgId: d.orgId,
          jobId: job.id ?? null,
          deliveryKey,
          recipients: [d.to],
          subject: d.subject,
          categoryKey: d.meta?.category ?? null,
          meta: { ...d.meta, reason: "sandbox environment — email egress blocked" },
          status: "suppressed",
          errorMessage: "sandbox environment — email egress blocked",
        });
        await appendEmailAttemptEvent(d.orgId, claimed.id, {
          outcome: "suppressed",
          detail: "sandbox environment — email egress blocked",
        });
        await markEmailSuppressed(d.orgId, claimed.id, "sandbox environment — email egress blocked");
        if (reportDeliveryId) {
          await markReportDeliverySuppressed(d.orgId, reportDeliveryId, claimed.id, "sandbox environment — email egress blocked");
        }
        return { suppressed: true, sandbox: true };
      }

      const transport = await resolveOrgEmailTransport(d.orgId);
      if (!transport) {
        const claimed = await claimEmailDeliveryLog({
          orgId: d.orgId,
          jobId: job.id ?? null,
          deliveryKey,
          recipients: [d.to],
          subject: d.subject,
          categoryKey: d.meta?.category ?? null,
          meta: { ...d.meta, reason: "email provider not configured" },
          status: "suppressed",
          errorMessage: "email provider not configured",
        });
        await appendEmailAttemptEvent(d.orgId, claimed.id, {
          outcome: "suppressed",
          detail: "email provider not configured",
        });
        await markEmailSuppressed(d.orgId, claimed.id, "email provider not configured");
        if (reportDeliveryId) {
          await markReportDeliverySuppressed(d.orgId, reportDeliveryId, claimed.id, "email provider not configured");
        }
        return { suppressed: true };
      }

      const canonical = await claimEmailDeliveryLog({
        orgId: d.orgId,
        deliveryKey,
        jobId: job.id ?? null,
        provider: transport.provider,
        recipients: [d.to],
        fromAddr: transport.from,
        replyToAddr: transport.replyTo ?? null,
        subject: d.subject,
        categoryKey: d.meta?.category ?? null,
        meta: d.meta ?? {},
      });
      const nextAttemptNo = canonical.attempts.length + 1;

      // Reconciliation gate BEFORE any transmission: earlier attempts decide.
      const decision = reconcileDeliveryAttempts(canonical.attempts);
      if (decision.action === "complete") {
        // An earlier attempt was accepted by the provider; finish bookkeeping
        // without sending anything again.
        await appendEmailAttemptEvent(d.orgId, canonical.id, {
          outcome: "blocked",
          detail: `not resent — accepted on a previous attempt (${decision.providerMessageId})`,
        });
        await confirmEmailSentGuarded(d.orgId, canonical.id, decision.providerMessageId);
        if (reportDeliveryId) await markReportDeliverySent(d.orgId, reportDeliveryId, canonical.id, decision.providerMessageId);
        return { id: decision.providerMessageId, reconciled: true };
      }
      if (decision.action === "suppress") {
        await appendEmailAttemptEvent(d.orgId, canonical.id, {
          outcome: "blocked",
          detail: decision.reason,
        });
        if (reportDeliveryId) {
          const finalQueueAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          await markReportDeliveryFailed(d.orgId, reportDeliveryId, canonical.id, `delivery pending reconciliation: ${decision.reason}`, finalQueueAttempt);
        }
        throw new Error(`email delivery deferred by reconciliation: ${decision.reason}`);
      }

      await appendEmailAttemptEvent(d.orgId, canonical.id, {
        attempt: nextAttemptNo,
        outcome: "started",
        detail: `sending via ${transport.provider} with identity ${deliveryKey}`,
      });

      try {
        // Check current grants immediately before transmission. Keep this in
        // the attempt boundary so revoked access becomes durable not-sent
        // evidence, and accepted retries can reconcile without sending again.
        if (reportDeliveryId) {
          const run = (await db.execute<{ run_id: string; definition_id: string }>(sql`
            select r.id as run_id, r.definition_id
              from report_delivery_outbox delivery
              join report_runs r on r.id = delivery.run_id and r.org_id = delivery.org_id
             where delivery.id = ${reportDeliveryId} and delivery.org_id = ${d.orgId}
               and delivery.recipient = ${d.to}
          `)).rows[0];
          if (!run) throw new Error('Report delivery evidence not found');
          await authorizeReportRun(d.orgId, run.definition_id, run.run_id);
        }
        const outcome = await sendVia(transport, {
          to: d.to,
          subject: d.subject,
          html: d.html,
          text: d.text,
          attachments: d.attachments,
        }, { deliveryKey });
        if (outcome.kind === "sent") {
          await appendEmailAttemptEvent(d.orgId, canonical.id, {
            attempt: nextAttemptNo,
            outcome: "sent",
            detail: outcome.providerMessageId,
          });
          await markEmailSent(d.orgId, canonical.id, outcome.providerMessageId);
          if (reportDeliveryId) await markReportDeliverySent(d.orgId, reportDeliveryId, canonical.id, outcome.providerMessageId);
          return { id: outcome.providerMessageId };
        }
        // Unresolved acceptance state: park it explicitly. BullMQ will retry,
        // but the reconciliation gate above turns every subsequent attempt
        // into blocked evidence instead of another transmission.
        await appendEmailAttemptEvent(d.orgId, canonical.id, {
          attempt: nextAttemptNo,
          outcome: "uncertain",
          detail: outcome.reason,
        });
        await markEmailUncertain(d.orgId, canonical.id, outcome.reason);
        if (reportDeliveryId) {
          const finalQueueAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          await markReportDeliveryFailed(d.orgId, reportDeliveryId, canonical.id, outcome.reason, finalQueueAttempt);
        }
        throw new Error(outcome.reason);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const alreadyRecorded =
          e instanceof Error &&
          (message.startsWith("email delivery deferred by reconciliation") || /acceptance state unresolved/.test(message));
        if (!alreadyRecorded) {
          // Definite failure: record evidence, rethrow so BullMQ retries.
          await appendEmailAttemptEvent(d.orgId, canonical.id, {
            attempt: nextAttemptNo,
            outcome: "notSent",
            detail: message,
          });
          await markEmailFailed(d.orgId, canonical.id, message);
          if (reportDeliveryId) {
            const finalQueueAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
            await markReportDeliveryFailed(d.orgId, reportDeliveryId, canonical.id, message, finalQueueAttempt);
          }
        }
        throw e;
      }
      });
    },
    { connection: getBlockingConnection(), concurrency: 5 },
  );
}
