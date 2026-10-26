import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { AutopayError, type ChargeFn, resolveAutopayPolicy } from "./autopay-policy.ts";
import {
  adapterCharge,
  type AutopayRunResult,
  emptyRunResult,
  type CollectionCandidate,
  errorMessage,
  mergeRunResult,
  committed,
  candidateFailed,
  refuseInsideTransaction,
} from "./autopay-collection-state.ts";
import { collectCandidate, resumeInterruptedAttempts } from "./autopay-attempts.ts";

/**
 * Autopay — stored payment methods and automatic collection of due invoices.
 *
 * A customer (or one subscription) enrolls with a default stored method. The
 * `autopay_collection` scheduler scan charges due invoices off-session: one
 * collection attempt per (invoice, retry position), committed before the
 * provider is called and charged under an idempotency key derived from that
 * position, so a retried tick reuses the attempt and its key instead of
 * charging twice. Success posts a customer_payment
 * receipt through the same draft → apply → post path hosted payment links
 * use, so application to the invoice is identical. Soft declines retry on the
 * dunning policy's offsets; hard declines stop; exhausting the schedule runs
 * the policy's final action (suspend or cancel the subscription), and a later
 * success reactivates.
 *
 * No card numbers are ever stored — only provider customer/method tokens
 * plus brand, last four and expiry for display.
 */

/**
 * Scheduler entry point: every production org with a live enrollment gets
 * one org-scoped run. Feature-off orgs keep their data and are skipped —
 * off means hidden and refused, never charged.
 */
export async function runAutopayCollection(asOf?: string): Promise<AutopayRunResult> {
  const orgRows =
    // bypass: scheduler-tick — the unscoped run lists every production organization with a live autopay enrollment.
    (
      await withBypass(async () => {
        return await db.execute<{ orgId: string }>(sql`
        select distinct enrollment.org_id as "orgId"
          from autopay_enrollments enrollment
          join orgs organization on organization.id = enrollment.org_id
         where enrollment.status = 'active' and organization.env_kind = 'production'
      `);
      })
    ).rows;
  const result = emptyRunResult();
  for (const { orgId } of orgRows) {
    const one = await runAutopayCollectionForOrg(orgId, asOf ? { asOf } : undefined).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[autopay] org ${orgId} collection failed: ${message}`);
        return { ...emptyRunResult(), orgErrors: [{ orgId, error: message.slice(0, 1000) }] };
      },
    );
    mergeRunResult(result, one);
  }
  return result;
}

export async function runAutopayCollectionForOrg(
  orgId: string,
  opts?: { asOf?: string; charge?: ChargeFn },
): Promise<AutopayRunResult> {
  if (!orgId.trim()) throw new AutopayError("orgId is required for an org-scoped collection run");
  refuseInsideTransaction();
  const result = emptyRunResult();
  // Deliberately NOT one transaction: every attempt commits on its own, so
  // one invoice's failure can never roll back another invoice's charge
  // evidence. The scans below are plain tenant-scoped reads.
  return withOrgContext(orgId, async () => {
    if (!(await orgFeatureEnabled(orgId, "autopay"))) return result;
    const today = opts?.asOf ?? (await businessToday(orgId));
    const charge = opts?.charge ?? ((provider, req) => adapterCharge(orgId, provider, req));

    await committed(orgId, result, (local) => reconcileProcessingAttempts(orgId, local));
    const policy = await resolveAutopayPolicy(orgId).catch((error: unknown) => {
      result.orgErrors.push({ orgId, error: errorMessage(error) });
      return null;
    });
    if (!policy) return result;

    // Attempts a previous run committed but never finished come first: they
    // resolve under the idempotency key they were sent with, never a new one.
    await resumeInterruptedAttempts(orgId, today, policy, charge, result);

    // Initial charges: due invoices (or issued ones for charge-on-issue
    // enrollments) with a live enrollment and method, and no attempt yet.
    const initials = await db.execute<CollectionCandidate>(
      sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId"
        from documents d
        join autopay_enrollments e
          on e.org_id = d.org_id and e.party_id = d.party_id and e.status = 'active'
        join customer_payment_methods m
          on m.id = coalesce(e.payment_method_id,
                       (select id from customer_payment_methods dd
                         where dd.org_id = e.org_id and dd.party_id = e.party_id
                           and dd.status = 'active' and dd.is_default limit 1))
         and m.org_id = e.org_id and m.status = 'active'
        left join subscription_period_invoices spi
          on spi.org_id = e.org_id and spi.subscription_id = e.subscription_id and spi.invoice_id = d.id
       where d.org_id = ${orgId} and d.kind = 'customer_invoice'
         and (e.subscription_id is null or spi.invoice_id is not null)
         and (d.due_date <= ${today}::date or (e.charge_on_issue and d.document_date <= ${today}::date))
         and not exists (
           select 1 from collection_attempts a
            where a.org_id = d.org_id and a.invoice_id = d.id and a.retry_position = 0
         )
       order by d.id
    `,
      "objects",
    );
    for (const candidate of initials) {
      result.scanned += 1;
      await collectCandidate(orgId, candidate, 0, today, policy, charge, result).catch(
        candidateFailed(result, candidate.invoiceId),
      );
    }

    // Consolidated invoices: the header names the payer, so a payer-level
    // enrollment matches above — but a subscription enrollment (anchored on
    // the service party) does not. A subscription behind any of the
    // invoice's source drafts authorizes collection; the charge still hits
    // the header payer, on the enrollment's method when it belongs to the
    // payer, else the payer's default method. Invoices an above enrollment
    // already covers stay out, so one invoice never collects twice.
    const consolidated = await db.execute<CollectionCandidate>(
      sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId"
        from documents d
        join subscription_period_invoices spi
          on spi.org_id = d.org_id
         and spi.invoice_id = any(
               select (jsonb_array_elements_text(d.custom -> 'sourceDraftIds'))::uuid)
        join autopay_enrollments e
          on e.org_id = d.org_id and e.subscription_id = spi.subscription_id and e.status = 'active'
        join customer_payment_methods m
          on m.id = coalesce(
               (select mm.id from customer_payment_methods mm
                 where mm.id = e.payment_method_id and mm.org_id = e.org_id
                   and mm.party_id = d.party_id and mm.status = 'active'),
               (select dd.id from customer_payment_methods dd
                 where dd.org_id = e.org_id and dd.party_id = d.party_id
                   and dd.status = 'active' and dd.is_default limit 1))
         and m.org_id = e.org_id and m.status = 'active'
       where d.org_id = ${orgId} and d.kind = 'customer_invoice'
         and d.custom ->> 'consolidationStatus' = 'consolidated'
         and (d.due_date <= ${today}::date or (e.charge_on_issue and d.document_date <= ${today}::date))
         and not exists (
           select 1 from collection_attempts a
            where a.org_id = d.org_id and a.invoice_id = d.id and a.retry_position = 0
         )
         and not exists (
           select 1 from autopay_enrollments e0
            where e0.org_id = d.org_id and e0.party_id = d.party_id and e0.status = 'active'
              and coalesce(e0.payment_method_id,
                    (select dd.id from customer_payment_methods dd
                      where dd.org_id = e0.org_id and dd.party_id = e0.party_id
                        and dd.status = 'active' and dd.is_default limit 1)) is not null
         )
       order by d.id
    `,
      "objects",
    );
    for (const candidate of consolidated) {
      result.scanned += 1;
      await collectCandidate(orgId, candidate, 0, today, policy, charge, result).catch(
        candidateFailed(result, candidate.invoiceId),
      );
    }

    // Enrolled consolidated invoices with no usable payer method stay
    // uncollected by name: the operator adds a payment method for the payer
    // instead of discovering the gap from an unpaid invoice.
    const methodless = await db.execute<{
      invoiceId: string;
      documentNumber: string;
      payerId: string;
    }>(
      sql`
      select d.id as "invoiceId", d.document_number as "documentNumber", d.party_id as "payerId"
        from documents d
       where d.org_id = ${orgId} and d.kind = 'customer_invoice'
         and d.custom ->> 'consolidationStatus' = 'consolidated'
         and (d.due_date is null or d.due_date <= ${today}::date)
         and not exists (
           select 1 from collection_attempts a
            where a.org_id = d.org_id and a.invoice_id = d.id and a.retry_position = 0
         )
         and exists (
           select 1 from subscription_period_invoices spi
             join autopay_enrollments e
               on e.org_id = spi.org_id and e.subscription_id = spi.subscription_id and e.status = 'active'
            where spi.org_id = d.org_id
              and spi.invoice_id = any(
                    select (jsonb_array_elements_text(d.custom -> 'sourceDraftIds'))::uuid)
         )
         and not exists (
           select 1 from customer_payment_methods m
            where m.org_id = d.org_id and m.party_id = d.party_id and m.status = 'active'
         )
       order by d.id
    `,
      "objects",
    );
    for (const row of methodless) {
      result.skipped += 1;
      result.notices.push({
        invoiceId: row.invoiceId,
        attemptId: null,
        status: "skipped",
        detail: `consolidated invoice ${row.documentNumber} has an enrolled subscription but its payer has no active payment method; add one for the payer before autopay can collect`,
      });
    }

    // Retries: soft-declined attempts whose next retry day arrived.
    const retries = await db.execute<CollectionCandidate>(
      sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId",
             a.retry_position as "failedPosition", a.decline_code as "declineCode"
        from collection_attempts a
        join documents d on d.id = a.invoice_id and d.org_id = a.org_id
        join autopay_enrollments e on e.id = a.enrollment_id and e.org_id = a.org_id and e.status = 'active'
        join customer_payment_methods m on m.id = a.payment_method_id and m.org_id = a.org_id and m.status = 'active'
       where a.org_id = ${orgId} and a.status = 'failed' and a.decline_kind in ('soft', 'insufficient_funds')
         and a.next_retry_on is not null and a.next_retry_on <= ${today}::date
         and not exists (
           select 1 from collection_attempts later
            where later.org_id = a.org_id and later.invoice_id = a.invoice_id
              and later.retry_position = a.retry_position + 1
         )
       order by a.invoice_id
    `,
      "objects",
    );
    for (const candidate of retries) {
      result.scanned += 1;
      const position = (candidate.failedPosition ?? 0) + 1;
      await collectCandidate(orgId, candidate, position, today, policy, charge, result).catch(
        candidateFailed(result, candidate.invoiceId),
      );
    }
    return result;
  });
}

/**
 * Reconcile in-flight attempts at tick start: a gated receipt that posted
 * since (approval flow posts later) closes its attempt and reactivates.
 */
async function reconcileProcessingAttempts(orgId: string, result: AutopayRunResult): Promise<void> {
  const rows = await db.execute<{ id: string; invoice_id: string }>(
    sql`
    select a.id, a.invoice_id
      from collection_attempts a
      join documents payment on payment.id = a.receipt_document_id and payment.org_id = a.org_id
     where a.org_id = ${orgId} and a.status = 'processing'
       and a.receipt_document_id is not null and payment.status = 'posted'
  `,
    "objects",
  );
  for (const row of rows) {
    await db.execute(sql`
      update collection_attempts set status = 'succeeded', updated_at = now()
       where id = ${row.id} and org_id = ${orgId} and status = 'processing'
    `);
    result.succeeded += 1;
    result.notices.push({
      invoiceId: row.invoice_id,
      attemptId: row.id,
      status: "succeeded",
      detail: "approved receipt posted; collection closed",
    });
  }
}
