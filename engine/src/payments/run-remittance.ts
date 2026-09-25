import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { probeEmailEnqueueAfterError, type EmailQueuedJobProbe } from "../delivery/email-enqueue-settlement.ts";
import { PaymentRunPostingClaimFencedError } from "../payments-core/payment-errors.ts";
import { type PostingClaim, assertPostingClaimLive } from "./run-claim.ts";

/**
 * Record an enqueue failure without overwriting a provider acceptance that
 * raced with a lost queue acknowledgement. The pending predicate is the
 * compare-and-set: sent and other terminal states remain authoritative.
 */
export async function markAutomaticRemittanceEnqueueFailed(
  orgId: string,
  remittanceId: string,
  actorId: string,
  error: string,
): Promise<void> {
  const outcome = await db.execute<{ status: string | null; written: number }>(sql`
    with updated as (
      update payment_remittances
         set status = 'failed', attempt_count = greatest(attempt_count, 1),
             last_attempt_at = now(), error = ${error.slice(0, 500)},
             updated_at = now(), updated_by = ${actorId}
       where id = ${remittanceId} and org_id = ${orgId} and status = 'pending'
      returning id
    ), target as (
      select status from payment_remittances
       where id = ${remittanceId} and org_id = ${orgId}
    )
    select (select status from target) as status,
           (select count(*) from updated)::int as written
  `);
  const result = outcome.rows?.[0];
  if ((result?.written ?? 0) === 0 && (result?.status === null || result?.status === "pending")) {
    throw new Error(`payment remittance ${remittanceId} enqueue failure was not recorded`);
  }
}

export async function settleAutomaticRemittanceEnqueueError(input: {
  orgId: string;
  remittanceId: string;
  actorId: string;
  error: unknown;
  data: import("@openbooks/jobs").EnqueueEmailData;
  jobId: string;
  probeQueuedJob?: EmailQueuedJobProbe;
}): Promise<"already-queued" | "not-queued" | "uncertain"> {
  const result = await probeEmailEnqueueAfterError({
    data: input.data,
    jobId: input.jobId,
    probeQueuedJob: input.probeQueuedJob,
  });
  if (result.outcome === "not-queued") {
    await markAutomaticRemittanceEnqueueFailed(
      input.orgId,
      input.remittanceId,
      input.actorId,
      input.error instanceof Error ? input.error.message : String(input.error),
    );
  }
  return result.outcome;
}
/**
 * Queue the payee's automatic remittance advice for one instruction the
 * worker just posted under its posting claim.
 *
 * Authority is re-proven at every step that writes: staging (the durable
 * remittance row) happens in one fenced transaction whose insert is
 * conditioned on the claim still being live. Enqueueing is outside that
 * transaction, and the email worker later records provider acceptance on the
 * remittance row; payment-run completion reconciles the resulting instruction
 * stamp under its own live claim. A worker superseded during staging therefore
 * leaves no evidence row behind, while a crash between staging and enqueue can
 * safely retry the same pending row and deterministic queue job. Network I/O
 * never holds payment row locks.
 */
export async function queueAutomaticRemittance(
  runId: string,
  instructionId: string,
  orgId: string,
  userId: string,
  claim: PostingClaim,
): Promise<void> {
  const staged = await withOrgTransaction(orgId, async () => {
    await assertPostingClaimLive(runId, orgId, claim);
    const row = (await db.execute<{ id: string; amount: string; currency: string; payment_reference: string | null; document_number: string | null; payment_date: string; payee: string; email: string | null; auto_remittance: boolean; direction: string; org_name: string }>(sql`
      select i.id, i.amount, i.currency, i.payment_reference, d.document_number,
             coalesce(r.scheduled_for, d.document_date) as payment_date,
             p.display_name as payee, vr.eft_notification_email as email,
             bp.auto_remittance, r.direction, o.name as org_name
        from payment_instructions i
        join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
        join payment_bank_profiles bp on bp.id = r.payment_bank_profile_id and bp.org_id = i.org_id
        join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
        left join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
        left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
        join orgs o on o.id = i.org_id
       where i.id = ${instructionId} and i.org_id = ${orgId}
    `)).rows[0];
    if (!row?.auto_remittance || row.direction !== "outbound") return null;
    const already = (await db.execute<{
      id: string;
      status: "pending" | "sent";
      recipients: string[] | null;
    }>(sql`
      select id, status, recipients
        from payment_remittances
       where payment_instruction_id = ${instructionId}
         and org_id = ${orgId}
         and status in ('pending', 'sent')
       order by created_at desc, id desc
       limit 1
    `)).rows[0];
    if (already?.status === "sent") return null;
    // A pending row is the durable outbox identity. Reuse its original
    // recipients on recovery rather than creating a second advice for the
    // same instruction after a crash between staging and Redis enqueue.
    const recipients = already?.status === "pending"
      ? (Array.isArray(already.recipients) ? already.recipients : [])
      : row.email ? [row.email] : [];
    // The durable remittance row is staged only while this worker still owns
    // the run: the conditional insert proves the claim at write time, so a
    // superseded worker leaves no evidence rows behind either.
    if (already?.status === "pending") {
      return { remittanceId: already.id, recipients, instruction: row };
    }
    const remittance = (await db.execute<{ id: string }>(sql`
      insert into payment_remittances
        (org_id, payment_instruction_id, recipients, status, attempt_count, error, created_by, updated_by)
      select ${orgId}, ${instructionId}, ${JSON.stringify(recipients)}::jsonb,
             ${recipients.length ? "pending" : "failed"}, 0,
             ${recipients.length ? null : "counterparty has no remittance email address"},
             ${userId}, ${userId}
       where exists (
         select 1 from payment_runs r
          where r.id = ${runId} and r.org_id = ${orgId}
            and r.status = 'processing'
            and r.posting_claim_token = ${claim.token}
       )
      returning id
    `)).rows[0];
    if (!remittance) throw new PaymentRunPostingClaimFencedError(runId);
    return { remittanceId: remittance.id, recipients, instruction: row };
  });
  if (!staged) return;
  const { instruction } = staged;
  if (!staged.recipients.length) return;

  let emailData: import("@openbooks/jobs").EnqueueEmailData | null = null;
  const jobId = `payment-remittance|${staged.remittanceId}`;
  try {
    const [{ enqueueEmail }, { paymentRemittanceEmail }] = await Promise.all([
      import("@openbooks/jobs"),
      import("@openbooks/emails"),
    ]);
    const documents = (await db.execute<{ number: string; amount: string; discount: string; credit: string }>(sql`
      select d.document_number as number, ri.payment_amount as amount,
             ri.discount_amount as discount, ri.credit_amount as credit
        from payment_run_items ri join documents d on d.id = ri.source_document_id and d.org_id = ri.org_id
       where ri.payment_instruction_id = ${instructionId} and ri.org_id = ${orgId} and ri.kind in ('bill', 'expense', 'refund', 'receivable')
       order by d.document_number
    `));
    const message = paymentRemittanceEmail({
      orgName: instruction.org_name,
      payeeName: instruction.payee,
      paymentReference: instruction.payment_reference ?? instruction.document_number ?? instruction.id,
      paymentDate: instruction.payment_date,
      amount: instruction.amount,
      currency: instruction.currency,
      documents: documents.rows,
    });
    emailData = {
      orgId,
      to: staged.recipients,
      subject: message.subject,
      html: message.html,
      text: message.text,
      meta: {
        category: "payment_remittance",
        paymentRemittanceId: staged.remittanceId,
      },
    };
    await enqueueEmail(emailData, { jobId });
  } catch (error) {
    if (!emailData) {
      await markAutomaticRemittanceEnqueueFailed(
        orgId,
        staged.remittanceId,
        userId,
        error instanceof Error ? error.message : String(error),
      );
      console.error(`[payments] automatic remittance failed for instruction ${instructionId}:`, error);
      return;
    }
    const outcome = await settleAutomaticRemittanceEnqueueError({
      orgId,
      remittanceId: staged.remittanceId,
      actorId: userId,
      error,
      data: emailData,
      jobId,
    });
    if (outcome === "not-queued") {
      console.error(`[payments] automatic remittance failed for instruction ${instructionId}:`, error);
    } else if (outcome === "uncertain") {
      console.error(`[payments] automatic remittance enqueue remains uncertain for instruction ${instructionId}:`, error);
    }
    return;
  }

  // Enqueueing is not delivery confirmation. Leave the remittance pending;
  // the email worker owns the sent/failed transition after provider outcome.
}
