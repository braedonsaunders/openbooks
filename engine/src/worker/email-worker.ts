import { authorizeReportRun } from './render-client.ts';
import { Worker } from "bullmq";
import { EMAIL_QUEUE, getBlockingConnection, resolveEmailDeliveryKey, type EmailJobData } from "@openbooks/jobs";
import {
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
  markDunningClaimFailed,
  markDunningClaimSent,
  markPaymentRemittanceAttempt,
  markPaymentRemittanceFailed,
  markPaymentRemittanceSent,
  resolveOrgEmailTransport,
} from "../delivery/email-config.ts";
import { sql } from "drizzle-orm";
import { deleteStoredEmailAttachments, loadEmailAttachments } from "../delivery/email-attachments.ts";
import { db, withOrgContext } from "../platform/db.ts";
import { isSandboxOrg } from "../organization/sandbox-guard.ts";
import {
  markReportDeliveryFailed,
  markReportDeliverySent,
  markReportDeliveryStarted,
  markReportDeliverySuppressed,
} from "../delivery/report-delivery.ts";

/**
 * A post-acceptance bookkeeping fault: the provider already accepted the
 * letter, so a failure settling the dunning claim, the payment remittance,
 * or the report delivery is a bookkeeping fault, never a send failure. The
 * worker logs it by name and rethrows it marked; the send-failure catch
 * below rethrows marked faults untouched (no notSent event, no failed
 * marks), so the BullMQ retry reconciles onto the recorded acceptance
 * without transmitting and re-attempts only the bookkeeping. If the fault
 * persists past exhaustion, the email_log acceptance stands as the durable
 * evidence and the owning runner reconciles from it — the letter is never
 * sent twice.
 */
class PostAcceptanceBookkeepingError extends Error {
  readonly emailLogId: string;
  constructor(emailLogId: string, cause: unknown) {
    super(
      `email ${emailLogId} was accepted by the provider but post-acceptance bookkeeping failed — ` +
        `leaving the acceptance for reconciliation, never re-sending: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PostAcceptanceBookkeepingError";
    this.emailLogId = emailLogId;
  }
}

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
      const paymentRemittanceId = d.meta?.paymentRemittanceId;
      // A dunning letter's claim id travels in the outbox payload meta (the
      // runner stamps it at deferral). The runner leaves the claim 'staged';
      // the worker below is the only writer that settles it, from the
      // provider's verdict — acceptance moves staged→sent, an exhausted
      // rejection moves staged→failed, and uncertainty leaves it staged.
      const dunningClaimId =
        typeof d.meta?.dunningLogId === "string" && d.meta.dunningLogId.trim()
          ? d.meta.dunningLogId
          : null;
      // Each settle is a guarded staged-only UPDATE naming its row back. A
      // false return (row missing, already settled, or re-armed by a later
      // dunning tick) is logged as a failure — never thrown (the email_log
      // verdict above already stands) and never a silent success.
      const settleDunningClaim = async (outcome: "sent" | "failed", detail: string | null): Promise<void> => {
        if (!dunningClaimId) return;
        const settled =
          outcome === "sent"
            ? await markDunningClaimSent(d.orgId, dunningClaimId)
            : await markDunningClaimFailed(d.orgId, dunningClaimId, detail ?? "email delivery failed");
        if (!settled) {
          console.error(
            `[worker] dunning claim ${dunningClaimId} was not marked ${outcome} — confirming the row exists and is still staged before treating the verdict as recorded`,
          );
        }
      };
      const queueAttempt = job.attemptsMade + 1;
      // Staged attachment bytes are dropped once the delivery reaches a
      // terminal state. Best-effort by design: a failed delete must never
      // fail delivery bookkeeping, and a crash-orphaned blob is never
      // re-read because only live job payloads reference storage ids.
      const dropStagedAttachments = (): Promise<void> =>
        deleteStoredEmailAttachments(d.attachments).catch((error) => {
          console.error("[worker] email attachment cleanup failed:", error instanceof Error ? error.message : error);
        });
      if (reportDeliveryId) await markReportDeliveryStarted(d.orgId, reportDeliveryId, job.id ?? null);
      if (paymentRemittanceId) {
        await markPaymentRemittanceAttempt(d.orgId, paymentRemittanceId, queueAttempt);
      }
      // The delivery key arrives in the job data, derived at enqueue from
      // the caller's durable idempotency key — never from the BullMQ job id,
      // whose auto-increment counter restarts after a Redis reset and would
      // align new mail with old sent-log rows. Recomputing it after any
      // crash must produce the same identity (and therefore the same
      // canonical log row) instead of minting new mail.
      const deliveryKey = resolveEmailDeliveryKey(d, job.id ?? null);

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
        await dropStagedAttachments();
        if (paymentRemittanceId) {
          await markPaymentRemittanceFailed(
            d.orgId,
            paymentRemittanceId,
            "sandbox environment — email egress blocked",
            queueAttempt,
            true,
          );
        }
        if (reportDeliveryId) {
          await markReportDeliverySuppressed(d.orgId, reportDeliveryId, claimed.id, "sandbox environment — email egress blocked");
        }
        // A dunning claim stays staged here: the letter was never attempted,
        // so there is no verdict to settle — the evidence names the sandbox
        // block on the email_log row above, and the runner re-arms the claim
        // once delivery can really be attempted.
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
        await dropStagedAttachments();
        if (paymentRemittanceId) {
          await markPaymentRemittanceFailed(d.orgId, paymentRemittanceId, "email provider not configured", queueAttempt, true);
        }
        if (reportDeliveryId) {
          await markReportDeliverySuppressed(d.orgId, reportDeliveryId, claimed.id, "email provider not configured");
        }
        // As above: never attempted, so the dunning claim stays staged with
        // the cause named on the email_log row, not settled as a verdict.
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
        await dropStagedAttachments();
        // An earlier attempt was accepted by the provider: that acceptance
        // settles the dunning claim even though this execution sent nothing.
        await settleDunningClaim("sent", null);
        if (paymentRemittanceId) {
          await markPaymentRemittanceSent(d.orgId, paymentRemittanceId);
        }
        if (reportDeliveryId) await markReportDeliverySent(d.orgId, reportDeliveryId, canonical.id, decision.providerMessageId);
        return { id: decision.providerMessageId, reconciled: true };
      }
      if (decision.action === "suppress") {
        await appendEmailAttemptEvent(d.orgId, canonical.id, {
          outcome: "blocked",
          detail: decision.reason,
        });
        if (paymentRemittanceId) {
          await markPaymentRemittanceFailed(d.orgId, paymentRemittanceId, decision.reason, queueAttempt, true);
        }
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
        // Attachments arrive by reference and are fetched here, at send
        // time — the queue payload never carries file bytes.
        const attachments = await loadEmailAttachments(d.attachments);
        const outcome = await sendVia(transport, {
          to: d.to,
          subject: d.subject,
          html: d.html,
          text: d.text,
          attachments,
          ...(d.replyTo ? { replyTo: d.replyTo } : {}),
        }, { deliveryKey });
        if (outcome.kind === "sent") {
          await appendEmailAttemptEvent(d.orgId, canonical.id, {
            attempt: nextAttemptNo,
            outcome: "sent",
            detail: outcome.providerMessageId,
          });
          await markEmailSent(d.orgId, canonical.id, outcome.providerMessageId);
          await dropStagedAttachments();
          // The provider already accepted the letter: everything below is
          // bookkeeping, not the send. A fault here must never reach the
          // send-failure catch — that path means "the customer got nothing"
          // and would orphan the claim as staged until a later tick re-arms
          // it under a fresh delivery identity and sends the letter twice.
          try {
            // Provider acceptance moves the staged dunning claim to sent.
            await settleDunningClaim("sent", null);
            if (paymentRemittanceId) {
              await markPaymentRemittanceSent(d.orgId, paymentRemittanceId);
            }
            if (reportDeliveryId) await markReportDeliverySent(d.orgId, reportDeliveryId, canonical.id, outcome.providerMessageId);
          } catch (bookkeepingError) {
            console.error(
              `[worker] email ${canonical.id} was accepted by the provider but post-acceptance bookkeeping failed — leaving the acceptance for reconciliation, never re-sending:`,
              bookkeepingError instanceof Error ? bookkeepingError.message : bookkeepingError,
            );
            throw new PostAcceptanceBookkeepingError(canonical.id, bookkeepingError);
          }
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
        // Unresolved acceptance stays staged: re-arming now would defer a
        // second letter while the first may already have been accepted. The
        // detail is recorded on the email_log lineage above, and the
        // reconciliation gate turns retries into blocked evidence instead of
        // another transmission — the staged claim keeps blocking the runner
        // from enqueueing a duplicate in the meantime.
        if (paymentRemittanceId) {
          await markPaymentRemittanceFailed(d.orgId, paymentRemittanceId, outcome.reason, queueAttempt, true);
        }
        if (reportDeliveryId) {
          const finalQueueAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          await markReportDeliveryFailed(d.orgId, reportDeliveryId, canonical.id, outcome.reason, finalQueueAttempt);
        }
        throw new Error(outcome.reason);
      } catch (e) {
        // A post-acceptance bookkeeping fault is not a send failure — the
        // provider already accepted the letter — so recording notSent /
        // failed evidence here would orphan the claim and invite a duplicate
        // re-send. Rethrow untouched: the BullMQ retry reconciles onto the
        // recorded acceptance without transmitting.
        if (e instanceof PostAcceptanceBookkeepingError) throw e;
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
          if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
            await dropStagedAttachments();
          }
          // Rejection settles the dunning claim only once BullMQ's own
          // retries are exhausted: settling earlier would let the runner
          // re-arm (with a fresh delivery identity) while this delivery is
          // still retrying, sending the customer two letters for one rung.
          if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
            await settleDunningClaim("failed", message);
          }
          if (paymentRemittanceId) {
            await markPaymentRemittanceFailed(
              d.orgId,
              paymentRemittanceId,
              message,
              queueAttempt,
              queueAttempt >= (job.opts.attempts ?? 1),
            );
          }
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
