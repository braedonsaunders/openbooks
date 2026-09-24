import { sql } from "drizzle-orm";
import { cmp, neg, add } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Single source of truth for AR customer-credit exposure measurement.
 *
 * Two writers consume it: sales-order issuance (engine/src/sales) and
 * customer-invoice posting (engine/src/ledger). Both measure the same way
 * so an approval at issue time and the refusal at posting time can never
 * disagree about what the customer owes:
 *
 * - exposure is denominated in customer_roles.currency; balances in any
 *   other currency are ignored by the sums and caught by the mixed-currency
 *   probe instead of being converted;
 * - an open sales order counts at its committed remainder (order total less
 *   posted, same-party, same-currency billing linked from it), never at its
 *   full total once partially billed;
 * - billing relieves an order only when the posted invoice carries the
 *   source order's own party. A conversion child relabelled to another
 *   party (or legacy billing written that way) must not release the source
 *   commitment: the order keeps its full remainder while the stray invoice
 *   counts — if at all — against its own party. That fails closed: the
 *   customer can look over-limit, never under;
 * - posted customer invoices count at open_balance, so only an applied
 *   payment/credit that reduces the maintained balance reduces exposure.
 *
 * The helpers below measure; they never refuse. Each caller raises its own
 * layer's refusal (SalesOrderIssueError, PostingError) from the numbers.
 * Callers must hold the customer_roles row lock this module takes while
 * using a measurement: that row is the per-customer serialization point, so
 * a second writer re-reads the first writer's committed documents.
 */

export interface CustomerRoleCreditRow extends Record<string, unknown> {
  id: string;
  credit_limit: string | null;
  currency: string | null;
  is_on_hold: boolean;
  hold_reason: string | null;
}

/** Lock the active customer role row for a credit evaluation. */
export async function lockCustomerRole(
  tx: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<CustomerRoleCreditRow | undefined> {
  return (
    await tx.execute<CustomerRoleCreditRow>(sql`
      select id, credit_limit, currency, is_on_hold, hold_reason
        from customer_roles
       where org_id = ${orgId}
         and party_id = ${partyId}
         and is_active
       for update
    `)
  ).rows[0];
}

export interface MixedCurrencyExposure extends Record<string, unknown> {
  kind: string;
  currency: string;
}

/**
 * Fail-closed probe: the first open sales-order remainder or open invoice
 * balance held in a currency other than the role currency. A limit enforced
 * in one currency cannot see exposure in another, so any such balance
 * refuses the evaluation instead of being silently ignored.
 */
export async function findMixedCurrencyExposure(
  tx: SqlExecutor,
  orgId: string,
  partyId: string,
  roleCurrency: string,
): Promise<MixedCurrencyExposure | undefined> {
  return (
    await tx.execute<MixedCurrencyExposure>(sql`
      select exposure.kind, exposure.currency
        from documents exposure
       where exposure.org_id = ${orgId}
         and exposure.party_id = ${partyId}
         and exposure.currency <> ${roleCurrency}
         and (
           (
             exposure.kind = 'sales_order'
             and exposure.status in ('pending_approval', 'approved')
             and greatest(
               exposure.total - coalesce((
                 select sum(billed.total)
                   from document_links link
                   join documents billed
                     on billed.id = link.to_document_id
                    and billed.org_id = link.org_id
                    and billed.kind = 'customer_invoice'
                    and billed.status = 'posted'
                   and billed.currency = exposure.currency
                   and billed.party_id = exposure.party_id
                  where link.org_id = exposure.org_id
                    and link.from_document_id = exposure.id
               ), 0),
               0
             ) > 0
           )
           or (
             exposure.kind = 'customer_invoice'
             and exposure.status = 'posted'
             and coalesce(exposure.open_balance, 0) > 0
           )
         )
       order by exposure.kind, exposure.id
       limit 1
    `)
  ).rows[0];
}

export interface CustomerExposure {
  openOrderExposure: string;
  unpaidInvoiceExposure: string;
}

/** Committed order remainder plus open invoice balances, in role currency. */
export async function measureCustomerExposure(
  tx: SqlExecutor,
  orgId: string,
  partyId: string,
  roleCurrency: string,
): Promise<CustomerExposure> {
  const exposure = (
    await tx.execute<{
      open_order_exposure: string;
      unpaid_invoice_exposure: string;
    }>(sql`
      select
        coalesce((
          select sum(
            greatest(
              issued.total - coalesce((
                select sum(billed.total)
                  from document_links link
                  join documents billed
                    on billed.id = link.to_document_id
                   and billed.org_id = link.org_id
                   and billed.kind = 'customer_invoice'
                   and billed.status = 'posted'
                   and billed.currency = ${roleCurrency}
                   and billed.party_id = issued.party_id
                 where link.org_id = issued.org_id
                   and link.from_document_id = issued.id
              ), 0),
              0
            )
          )
            from documents issued
           where issued.org_id = ${orgId}
             and issued.party_id = ${partyId}
             and issued.kind = 'sales_order'
             and issued.status in ('pending_approval', 'approved')
             and issued.currency = ${roleCurrency}
        ), 0)::text as open_order_exposure,
        coalesce((
          select sum(invoice.open_balance)
            from documents invoice
           where invoice.org_id = ${orgId}
             and invoice.party_id = ${partyId}
             and invoice.kind = 'customer_invoice'
             and invoice.status = 'posted'
             and invoice.currency = ${roleCurrency}
             and coalesce(invoice.open_balance, 0) > 0
        ), 0)::text as unpaid_invoice_exposure
    `)
  ).rows[0]!;
  return {
    openOrderExposure: exposure.open_order_exposure,
    unpaidInvoiceExposure: exposure.unpaid_invoice_exposure,
  };
}

/**
 * Posting-time relief for an order-converted invoice: the linked open-order
 * remainder the receivable replaces, capped at the invoice total so a
 * partial billing relieves only what it bills. Posting swaps commitment for
 * receivable in one instant; without this the invoice would count twice
 * (once in the order book, once as new exposure) and every converted
 * invoice would refuse against the order it settles.
 */
export async function measureLinkedOrderRelief(
  tx: SqlExecutor,
  orgId: string,
  partyId: string,
  roleCurrency: string,
  invoiceId: string,
  invoiceTotal: string,
): Promise<string> {
  const linked = (
    await tx.execute<{ relief: string }>(sql`
      select coalesce(sum(
        greatest(
          issued.total - coalesce((
            select sum(billed.total)
              from document_links link
              join documents billed
                on billed.id = link.to_document_id
               and billed.org_id = link.org_id
               and billed.kind = 'customer_invoice'
               and billed.status = 'posted'
               and billed.currency = ${roleCurrency}
               and billed.party_id = issued.party_id
             where link.org_id = issued.org_id
               and link.from_document_id = issued.id
          ), 0),
          0
        )
      ), 0)::text as relief
        from documents issued
       where issued.org_id = ${orgId}
         and issued.party_id = ${partyId}
         and issued.kind = 'sales_order'
         and issued.status in ('pending_approval', 'approved')
         and issued.currency = ${roleCurrency}
         and exists (
           select 1 from document_links line
            where line.org_id = ${orgId}
              and line.from_document_id = issued.id
              and line.to_document_id = ${invoiceId}
         )
    `)
  ).rows[0]!.relief;
  return cmp(invoiceTotal, linked) <= 0 ? invoiceTotal : linked;
}

export function resultingExposureAfterPosting(
  exposure: CustomerExposure,
  invoiceTotal: string,
  relief: string,
): string {
  return add(add(add(exposure.openOrderExposure, exposure.unpaidInvoiceExposure), invoiceTotal), neg(relief));
}
