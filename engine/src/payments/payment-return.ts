import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";

/** Drain native receipt effects before a later return makes the posted
 * document unavailable to its retry action. Lease and terminal refusals
 * retain the original outbox ownership and operator remediation path. */
export async function completePaymentPostingEffectsForReturn(
  orgId: string,
  documentId: string,
  options: { requireEvidence?: boolean } = {},
): Promise<void> {
  const effect = (
    await db.execute<{ status: string }>(
      sql`select status from posting_effects
    where org_id = ${orgId} and document_id = ${documentId}`,
      "objects",
    )
  )[0];
  // Historical postings without an outbox retain the native void contract.
  if (!effect) {
    if (options.requireEvidence)
      throw new PaymentError(
        "Receipt posting-effects evidence is unavailable; reconcile its native posting before resuming the provider return.",
      );
    return;
  }
  if (effect.status === "succeeded") return;
  try {
    await runPostDocumentEffects(documentId, "approved");
  } catch (error) {
    throw new PaymentError(
      `Receipt posting effects could not complete: ${error instanceof Error ? error.message : "unknown effect refusal"}. Resolve the cause on the posted receipt; terminal failures require Retry posting effects with a review reason before resuming the provider return.`,
      { cause: error },
    );
  }
  const completed = (
    await db.execute<{ status: string }>(
      sql`select status from posting_effects
    where org_id = ${orgId} and document_id = ${documentId}`,
      "objects",
    )
  )[0];
  if (completed?.status !== "succeeded")
    throw new PaymentError(
      `Receipt posting effects are ${completed?.status ?? "unavailable"}; wait for their native completion before resuming the provider return. Terminal failures require Retry posting effects on the posted receipt with a review reason.`,
    );
}
/** Reverse a posted payment after a bank return and reopen its applications. */
export async function reversePaymentForReturn(
  paymentDocumentId: string,
  orgId: string,
  reason: string,
  actorId: string,
  reversalDate?: string,
): Promise<string> {
  const reversalId = await withOrg(orgId, async () => {
    const row = await db.execute<{ id: string; posted_entry_id: string; document_number: string }>(
      sql`
      select d.id, d.posted_entry_id, d.document_number
        from documents d
       where d.id = ${paymentDocumentId} and d.org_id = ${orgId}
         and d.kind in ('vendor_payment', 'customer_payment') and d.status = 'posted'
       for update
    `,
      "objects",
    );
    const payment = row[0];
    if (!payment?.posted_entry_id) throw new PaymentError("returned payment is not posted");
    await completePaymentPostingEffectsForReturn(orgId, payment.id);
    // The void-evidence CHECK caps void_reason at 500 chars, but bank return
    // reasons arrive unbounded (route text, file memos): a pasted reason
    // longer than the prefix leaves room for died at storage as a raw 500.
    // Fail closed here, naming the caller's limit, before any write.
    const reasonText = reason.trim() || payment.document_number;
    if (reasonText.length > 500 - "Bank return: ".length) {
      throw new PaymentError(
        "bank return reason must fit the void evidence (at most 487 characters)",
      );
    }
    const voidReason = `Bank return: ${reasonText}`;
    const reversalDay = reversalDate ?? (await businessToday(orgId));
    const stamped = await db.execute<never>(sql`
      update documents
         set void_reason = ${voidReason},
             void_requested_at = now(),
             void_requested_by = ${actorId},
             void_reversal_date = ${reversalDay},
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${payment.id} and org_id = ${orgId}
         and status = 'posted' and void_requested_at is null
    `);
    if ((stamped.rowCount ?? 0) !== 1) {
      // The conditional stamp above is the only writer of bank-return
      // evidence, so a zero row count means a pending manual void request
      // already holds the evidence columns. The bank return supersedes it
      // with its own evidence: the opening SELECT ... FOR UPDATE runs in
      // this same transaction, so the displaced request is re-read under the
      // row lock, overwritten, preserved alongside the bank evidence in the
      // audit trail, and its requester notified — never silently adopted.
      const pending = (
        await db.execute<{
          void_reason: string | null;
          void_requested_by: string | null;
          void_reversal_date: string | null;
          status: string;
        }>(
          sql`
        select void_reason, void_requested_by, void_reversal_date, status
          from documents where id = ${payment.id} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      if (!pending || pending.status !== "posted") {
        // Not a supersedeable pending request (already voided, or the
        // document moved on): completion returns the existing reversal for
        // an already-voided document and throws the precise state error
        // otherwise.
        const { completeRequestedDocumentVoid } = await import("../ledger/document-void.ts");
        const existing = await completeRequestedDocumentVoid(payment.id, orgId);
        if (!existing) throw new PaymentError("payment reversal could not be created");
        return existing;
      }
      await db.execute(sql`
        update documents
           set void_reason = ${voidReason},
               void_requested_at = now(),
               void_requested_by = ${actorId},
               void_reversal_date = ${reversalDay},
               updated_at = now(),
               updated_by = ${actorId}
         where id = ${payment.id} and org_id = ${orgId}
           and status = 'posted'
      `);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${orgId}, 'documents', ${payment.id}, 'update',
                ${JSON.stringify({
                  mode: "void_evidence_superseded",
                  source: "bank_return",
                  superseded: {
                    reason: pending.void_reason,
                    requestedBy: pending.void_requested_by,
                    reversalDate: pending.void_reversal_date,
                  },
                  after: { reason: voidReason, requestedBy: actorId, reversalDate: reversalDay },
                })}::jsonb, ${actorId}, 'bank_return')
      `);
      if (pending.void_requested_by && pending.void_requested_by !== actorId) {
        await db.execute(sql`
          insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
          values (${orgId}, ${pending.void_requested_by}, 'void_superseded',
                  'Void request superseded by bank return',
                  ${`Your void request for ${payment.document_number} (${pending.void_reason ?? "no reason recorded"}) was superseded by a bank return; the reversal now carries the bank evidence: ${voidReason}.`},
                  '/inbox', ${actorId}, ${actorId})
        `);
      }
    }
    const { completeRequestedDocumentVoid } = await import("../ledger/document-void.ts");
    return completeRequestedDocumentVoid(payment.id, orgId);
  });
  if (!reversalId) throw new PaymentError("payment reversal could not be created");
  return reversalId;
}
