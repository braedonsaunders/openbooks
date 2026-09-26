/**
 * Payment acceptance posting effect: close the provider attempt after its
 * receipt posts. Moved verbatim from payments/acceptance.ts — it touches
 * only payment_attempts,
 * payment_links and audit_log through db plus money.cmp, so the posting
 * orchestrator runs it as a post-commit effect without importing payments.
 * Runs inside the posting_effects claim; moved verbatim.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
/**
 * Close the provider attempt after its receipt posts. This is also invoked by
 * post-payment effects when a configured approval flow posts the receipt later.
 * Keyed on journal_entry_id being unset, so it closes whichever attempt
 * reserved this receipt exactly once regardless of the claim that started it.
 */
export async function finalizePaymentAcceptanceForDocument(
  paymentDocumentId: string,
): Promise<void> {
  const result = (await db.execute<{
      attempt_id: string;
      org_id: string;
      amount: string | null;
      surcharge_amount: string | null;
      link_id: string;
      invoice_id: string;
      invoice_number: string;
      open_balance: string;
      posted_entry_id: string;
    }>(sql`
    select attempt.id as attempt_id,
           attempt.org_id,
           attempt.amount,
           attempt.surcharge_amount,
           link.id as link_id,
           link.document_id as invoice_id,
           invoice.document_number as invoice_number,
           invoice.open_balance,
           payment.posted_entry_id
      from payment_attempts attempt
      join payment_links link
        on link.id = attempt.link_id and link.org_id = attempt.org_id
      join documents invoice
        on invoice.id = link.document_id and invoice.org_id = attempt.org_id
      join documents payment
        on payment.id = attempt.payment_document_id and payment.org_id = attempt.org_id
     where attempt.payment_document_id = ${paymentDocumentId}
       and attempt.journal_entry_id is null
       and payment.status = 'posted'
     for update of attempt
  `));
  const row = result.rows[0];
  if (!row) return;
  const closed = (await db.execute<{ id: string }>(sql`
    update payment_attempts
       set status = 'succeeded',
           journal_entry_id = ${row.posted_entry_id},
           updated_at = now()
     where id = ${row.attempt_id} and org_id = ${row.org_id} and journal_entry_id is null
     returning id
  `));
  if (!closed.rows[0]) return;
  if (cmp(row.open_balance ?? "0", "0") <= 0) {
    await db.execute(sql`
      update payment_links
         set status = 'paid',
             paid_payment_document_id = ${paymentDocumentId},
             paid_at = now(),
             updated_at = now()
       where id = ${row.link_id} and org_id = ${row.org_id} and status = 'active'
    `);
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${row.org_id}, 'payment_attempts', ${row.attempt_id}, 'post',
      ${JSON.stringify({
        after: {
          paymentDocumentId,
          invoice: row.invoice_number,
          amount: row.amount,
          surcharge: row.surcharge_amount,
        },
      })}::jsonb,
      null
    )
  `);
}
