import { sql } from "drizzle-orm";
import { lockAutopayEnrollmentAuthority } from "./autopay-enrollment.ts";
import { db, withOrg } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { AutopayError } from "./autopay-policy.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";

/** Autopay recovery metrics and the posting of collected receipts through the hosted-payment draft, apply and post path. */

export interface RecoverySliceMetrics {
  failedAttempts: number;
  invoices: number;
  recoveredInvoices: number;
  recoveredAmount: string;
  recoveryRate: number | null;
}

export interface RecoveryMetrics {
  attempts: number;
  invoicesWithFailures: number;
  recoveredInvoices: number;
  recoveredAmount: string;
  /** Recovered revenue split by invoice currency — the headline total is a
   *  single-currency sum only when one currency is present. */
  recoveredByCurrency: { currency: string; amount: string }[];
  recoveryRate: number | null;
  byDeclineClass: (RecoverySliceMetrics & { declineClass: string })[];
  byProvider: (RecoverySliceMetrics & { provider: string })[];
  churnPrevented: number;
  awaitingAuthentication: number;
}

function recoveryRate(recoveredInvoices: number, invoices: number): number | null {
  return invoices === 0 ? null : recoveredInvoices / invoices;
}

/**
 * Recovery facts for a window, read off stored attempts — never sampled or
 * extrapolated. `from` is inclusive, `to` exclusive. A failure counts in the
 * window it happened in; its recovery is a success at a later schedule
 * position, whenever it lands, so crossing recoveries are not lost at the
 * boundary. Positions — not timestamps — carry the causal order, because
 * attempts charged in one tick share the transaction's clock. Involuntary
 * churn prevented counts subscriptions the engine reactivated after a
 * collection succeeded.
 */
export async function getRecoveryMetrics(
  orgId: string,
  window: { from: string; to: string },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<RecoveryMetrics> {
  return withOrg(orgId, async () => {
    const scopedAttempts = sql`
      select a.*
        from collection_attempts a
        join documents d on d.org_id = a.org_id and d.id = a.invoice_id
        join parties p on p.org_id = d.org_id and p.id = d.party_id
       where a.org_id = ${orgId}
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
    `;
    const totals = (
      await db.execute<{
        attempts: number;
        invoices: number;
        recovered: number;
        amount: string | null;
      }>(
        sql`
      with scoped_attempts as (${scopedAttempts}),
      failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position
          from scoped_attempts a
         where a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount
          from scoped_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select (select count(*)::integer from scoped_attempts
               where created_at >= ${window.from}::timestamptz and created_at < ${window.to}::timestamptz) as attempts,
             (select count(*)::integer from failed) as invoices,
             (select count(*)::integer from recovered) as recovered,
             (select coalesce(sum(amount), 0)::text from recovered) as amount
    `,
        "objects",
      )
    )[0];
    if (!totals) throw new AutopayError("recovery metrics could not be read; try again");
    const byClass = await db.execute<{
      declineClass: string;
      failedAttempts: number;
      invoices: number;
      recovered: number;
      amount: string | null;
    }>(
      sql`
      with scoped_attempts as (${scopedAttempts}),
      failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position,
               coalesce(a.decline_kind, 'soft') as decline_kind
          from scoped_attempts a
         where a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount
          from scoped_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select f.decline_kind as "declineClass",
             count(*)::integer as "failedAttempts",
             count(distinct f.invoice_id)::integer as invoices,
             count(r.invoice_id)::integer as recovered,
             coalesce(sum(r.amount), 0)::text as amount
        from failed f
        left join recovered r on r.invoice_id = f.invoice_id
       group by f.decline_kind
       order by f.decline_kind
    `,
      "objects",
    );
    const byProvider = await db.execute<{
      provider: string;
      failedAttempts: number;
      invoices: number;
      recovered: number;
      amount: string | null;
    }>(
      sql`
      with scoped_attempts as (${scopedAttempts}),
      failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position, a.provider
          from scoped_attempts a
         where a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount
          from scoped_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select f.provider,
             count(*)::integer as "failedAttempts",
             count(distinct f.invoice_id)::integer as invoices,
             count(r.invoice_id)::integer as recovered,
             coalesce(sum(r.amount), 0)::text as amount
        from failed f
        left join recovered r on r.invoice_id = f.invoice_id
       group by f.provider
       order by f.provider
    `,
      "objects",
    );
    const byCurrency = await db.execute<{ currency: string; amount: string | null }>(
      sql`
      with scoped_attempts as (${scopedAttempts}),
      failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position
          from scoped_attempts a
         where a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount, a.currency
          from scoped_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select r.currency, coalesce(sum(r.amount), 0)::text as amount
        from recovered r
       group by r.currency
       order by r.currency
    `,
      "objects",
    );
    const churn =
      (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::integer as n from audit_log al
        join subscriptions s on s.org_id = al.org_id and s.id = al.row_id
        join parties p on p.org_id = s.org_id and p.id = s.customer_id
       where al.org_id = ${orgId} and al.table_name = 'subscriptions'
         and al.changes ->> 'event' = 'autopay_reactivated'
         and al.at >= ${window.from}::timestamptz and al.at < ${window.to}::timestamptz
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
    `,
          "objects",
        )
      )[0]?.n ?? 0;
    const awaiting =
      (
        await db.execute<{ n: number }>(
          sql`
      with scoped_attempts as (${scopedAttempts})
      select count(*)::integer as n from scoped_attempts
       where status = 'failed'
         and decline_kind = 'needs_authentication' and next_retry_on is null
    `,
          "objects",
        )
      )[0]?.n ?? 0;
    return {
      attempts: totals.attempts,
      invoicesWithFailures: totals.invoices,
      recoveredInvoices: totals.recovered,
      recoveredAmount: totals.amount ?? "0",
      recoveredByCurrency: byCurrency.map((row) => ({
        currency: row.currency,
        amount: row.amount ?? "0",
      })),
      recoveryRate: recoveryRate(totals.recovered, totals.invoices),
      byDeclineClass: byClass.map((row) => ({
        declineClass: row.declineClass,
        failedAttempts: row.failedAttempts,
        invoices: row.invoices,
        recoveredInvoices: row.recovered,
        recoveredAmount: row.amount ?? "0",
        recoveryRate: recoveryRate(row.recovered, row.invoices),
      })),
      byProvider: byProvider.map((row) => ({
        provider: row.provider,
        failedAttempts: row.failedAttempts,
        invoices: row.invoices,
        recoveredInvoices: row.recovered,
        recoveredAmount: row.amount ?? "0",
        recoveryRate: recoveryRate(row.recovered, row.invoices),
      })),
      churnPrevented: churn,
      awaitingAuthentication: awaiting,
    };
  });
}

function attemptReference(attemptId: string): string {
  return `autopay:${attemptId}`;
}

/**
 * Post the customer_payment receipt for a collected attempt: draft with the
 * invoice application, submit through approvals, post with applications.
 * Crash recovery: a receipt already posted under this attempt's reference
 * (the post committed but the attempt update never did) is adopted instead
 * of minting a second receipt for the same collection.
 */
export async function postCollectionReceipt(
  orgId: string,
  attemptId: string,
): Promise<{ receiptId: string; status: "posted" | "pending_approval" }> {
  const rows = await db.execute<{
    attempt_id: string;
    invoice_id: string;
    party_id: string;
    subsidiary_id: string | null;
    currency: string;
    amount: string;
    bank_account_id: string | null;
    document_number: string;
    open_balance: string;
    receipt_id: string | null;
    enrollment_id: string;
  }>(
    sql`
    select a.id as "attempt_id", d.id as "invoice_id", d.party_id,
           d.subsidiary_id, d.currency, a.amount, c.default_bank_account_id as "bank_account_id",
           d.document_number, d.open_balance, a.receipt_document_id as "receipt_id", a.enrollment_id
      from collection_attempts a
      join documents d on d.id = a.invoice_id and d.org_id = a.org_id
      join customer_payment_methods m on m.id = a.payment_method_id and m.org_id = a.org_id
      join psp_provider_configs c on c.org_id = a.org_id and c.provider = a.provider
     where a.id = ${attemptId} and a.org_id = ${orgId}
     for update of a
  `,
    "objects",
  );
  const a = rows[0];
  if (!a) throw new AutopayError("collection attempt not found");
  if (a.receipt_id) {
    const existing = (
      await db.execute<{ status: string }>(
        sql`
      select status from documents where id = ${a.receipt_id} and org_id = ${orgId}
        and kind='customer_payment' and party_id=${a.party_id} and subsidiary_id=${a.subsidiary_id}
        and currency=${a.currency} and reference_number=${attemptReference(attemptId)}
    `,
        "objects",
      )
    )[0];
    if (!existing)
      throw new AutopayError(
        "The collection receipt does not match its invoice, legal entity, currency and collection reference. Review the native collection before retrying.",
      );
    if (existing?.status === "posted") {
      await db.execute(sql`
        update collection_attempts set status = 'succeeded', updated_at = now()
         where id = ${attemptId} and org_id = ${orgId} and status <> 'succeeded'
      `);
      return { receiptId: a.receipt_id, status: "posted" };
    }
  } else {
    // Adopt a receipt the interrupted tick posted but never linked.
    const adopted = (
      await db.execute<{ id: string }>(
        sql`
      select id from documents
       where org_id = ${orgId} and kind = 'customer_payment'
         and reference_number = ${attemptReference(attemptId)} and status = 'posted'
       limit 1
    `,
        "objects",
      )
    )[0];
    if (adopted) {
      await db.execute(sql`
        update collection_attempts
           set status = 'succeeded', receipt_document_id = ${adopted.id}, updated_at = now()
         where id = ${attemptId} and org_id = ${orgId}
      `);
      return { receiptId: adopted.id, status: "posted" };
    }
  }
  if (!a.bank_account_id) {
    throw new AutopayError(
      "the provider has no default bank account; set one in provider settings so autopay receipts can post",
    );
  }
  const bank = (
    await db.execute<{ id: string }>(
      sql`
    select id from accounts
     where org_id = ${orgId} and id = ${a.bank_account_id}
       and type = 'asset_bank' and is_active and not is_summary
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!bank)
    throw new AutopayError(
      "the provider bank account is not an active bank account; fix it in provider settings first",
    );
  // Autopay collects the invoice amount only — off-session surcharging is
  // restricted, so unlike hosted checkout there is no fee leg.
  const collected = a.amount;
  const openItems = await openItemsForParty(a.party_id, "ar", orgId);
  const item = openItems.find((i) => i.documentId === a.invoice_id);
  const invoicePortion = item
    ? cmp(collected, a.open_balance) < 0
      ? collected
      : a.open_balance
    : "0";
  if (cmp(invoicePortion, "0") <= 0) {
    throw new AutopayError(
      `invoice ${a.document_number} no longer owes anything; the collection needs operator review before a receipt can post`,
    );
  }
  const onAccountAmount = fromUnits(toUnits(collected) - toUnits(invoicePortion));
  const allocations = [sameCurrencyAllocation(item!.lineId, invoicePortion)];
  const { actorId, allowedSubsidiaryIds } = await lockAutopayEnrollmentAuthority(
    orgId,
    a.enrollment_id,
    a.subsidiary_id,
  );
  const payment = a.receipt_id
    ? { id: a.receipt_id }
    : await createPaymentDocument({
        orgId,
        kind: "customer_payment",
        createdBy: actorId,
        allowedSubsidiaryIds,
        partyId: a.party_id,
        bankAccountId: a.bank_account_id,
        documentDate: await businessToday(orgId),
        memo: `Autopay — ${a.document_number}`,
        subsidiaryId: a.subsidiary_id,
        currency: a.currency,
      });
  await db.execute(sql`
    update collection_attempts set receipt_document_id = ${payment.id}, updated_at = now()
     where id = ${attemptId} and org_id = ${orgId}
  `);
  const current = (
    await db.execute<{ status: string }>(
      sql`select status from documents where org_id=${orgId} and id=${payment.id}`,
      "objects",
    )
  )[0];
  if (!current)
    throw new AutopayError(
      "The collection's retained receipt is unavailable. Review that collection before retrying.",
    );
  if (current.status === "pending_approval")
    return { receiptId: payment.id, status: "pending_approval" };
  if (current.status !== "draft" && current.status !== "approved")
    throw new AutopayError(
      "The retained collection receipt cannot be posted. Review its lifecycle before retrying collection.",
    );
  if (current.status === "draft")
    await updateDraftPayment(
      payment.id,
      {
        allocations,
        referenceNumber: attemptReference(attemptId),
        feeAmount: "0",
        feeIncomeAccountId: null,
        onAccountAmount,
      },
      actorId,
      orgId,
      { allowedSubsidiaryIds },
    );
  if (current.status === "draft") {
    const submission = await submitAndReleaseIfUngated("customer_payment", payment.id, actorId);
    if (submission.flowError)
      throw new AutopayError(`receipt approval could not be routed: ${submission.flowError}`);
    if (submission.gated) {
      await db.execute(sql`
      update collection_attempts set status = 'processing', updated_at = now()
       where id = ${attemptId} and org_id = ${orgId}
    `);
      return { receiptId: payment.id, status: "pending_approval" };
    }
  }
  await postPaymentWithApplications(payment.id, undefined, actorId);
  const closed = await db.execute<{ id: string }>(
    sql`
    update collection_attempts
       set status = 'succeeded', updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status <> 'succeeded'
     returning id
  `,
    "objects",
  );
  if (!closed[0])
    throw new AutopayError("collection attempt changed underfoot; refusing to close over it");
  return { receiptId: payment.id, status: "posted" };
}
