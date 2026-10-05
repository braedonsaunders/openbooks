/** Order- and subscription-scoped revenue contracts (ASC 606 / IFRS 15).
 *
 * An invoice-scope contract covers one invoice. An order-scope contract covers
 * one sales order billed across several invoices; a subscription-scope
 * contract covers one subscription billed across its period invoices. Every
 * billing records a row in revenue_contract_billings and accumulates billed
 * consideration on the contract, so billed and recognized revenue present
 * net per contract: recognized in excess of billings is a contract asset
 * (unbilled receivable), billings in excess of recognized is a contract
 * liability (deferred revenue).
 *
 * Posted schedules are never rewritten: each billing prices its own lines,
 * and later billings only add consideration and obligations. Corrections
 * travel through the contract-modification workflow, never through replay.
 */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { add, cmp, neg } from "../money/money.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";

export type ContractScope = "invoice" | "order" | "subscription";

export type BillingSource =
  | { kind: "order"; id: string; number: string }
  | { kind: "subscription"; id: string; number: string };

export async function revenueContractsEnabled(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<boolean> {
  return orgFeatureEnabled(orgId, "revenueContracts", runner as SqlExecutor);
}

/**
 * When scoped contracts are created: on first billing (default), or as a
 * shell at sales-order issue when the org books contracts at booking
 * (Company Settings → Accounting → revenue → contract creation). Anything
 * unconfigured or unrecognized resolves to first billing: a shell that never
 * bills must never appear unasked.
 */
export async function contractCreationMode(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<"first_billing" | "booking"> {
  const row = (await (runner as SqlExecutor).execute<{ mode: string | null }>(sql`
    select settings->'revenue'->>'contractCreation' as mode from orgs where id = ${orgId}`)).rows[0];
  return row?.mode === "booking" ? "booking" : "first_billing";
}

export function revenueScopedContractPostingEffectKey(scope: ContractScope, sourceId: string): string {
  return `posting-effect:revenue-contract:${scope}:${sourceId}`;
}

/**
 * The commercial agreement one invoice bills: its sales order (follow the
 * 'bills' edge the conversion wrote) or its subscription (the period-invoice
 * link the billing run wrote). Null for standalone invoices. An invoice that
 * names two orders, or both an order and a subscription, is refused by name:
 * one billing document belongs to exactly one contract.
 */
export async function resolveBillingSource(
  runner: SqlExecutor,
  orgId: string,
  invoiceId: string,
): Promise<BillingSource | null> {
  const orders = (await runner.execute<{ id: string; document_number: string }>(sql`
    select source.id, source.document_number
      from document_links link
      join documents source
        on source.id = link.from_document_id and source.org_id = link.org_id
     where link.org_id = ${orgId} and link.to_document_id = ${invoiceId}
       and link.link_type = 'bills' and source.kind = 'sales_order'
     order by source.document_number`)).rows;
  const subscriptions = (await runner.execute<{ id: string; number: string }>(sql`
    select s.id,
           coalesce((select p.name from subscription_plans p where p.id = s.plan_id and p.org_id = s.org_id), s.id::text) as number
      from subscription_period_invoices spi
      join subscriptions s on s.id = spi.subscription_id and s.org_id = spi.org_id
     where spi.org_id = ${orgId} and spi.invoice_id = ${invoiceId}
     order by spi.period_starts_on`)).rows;
  if (orders.length > 1) {
    throw new RevenueRecognitionError(
      `Invoice bills ${orders.length} sales orders (${orders.map((o) => o.document_number).join(", ")}); bill each order on its own invoice so each contract holds one agreement`,
    );
  }
  if (orders.length === 1 && subscriptions.length > 0) {
    throw new RevenueRecognitionError(
      `Invoice bills sales order ${orders[0]!.document_number} and a subscription; bill the order and the subscription on separate invoices so each contract holds one agreement`,
    );
  }
  if (orders.length === 1) return { kind: "order", id: orders[0]!.id, number: orders[0]!.document_number };
  if (subscriptions.length > 1) {
    throw new RevenueRecognitionError(
      "Invoice bills several subscriptions; bill each subscription on its own invoice so each contract holds one agreement",
    );
  }
  if (subscriptions.length === 1) return { kind: "subscription", id: subscriptions[0]!.id, number: subscriptions[0]!.number };
  return null;
}

interface ScopedSubject {
  scope: ContractScope;
  customerId: string;
  subsidiaryId: string | null;
  currency: string | null;
  contractNumber: string;
  startsOn: string | null;
  idempotencyKey: string;
}

/** Load the commercial subject a scoped contract is created from. */
async function scopedSubject(
  runner: SqlExecutor,
  orgId: string,
  source: BillingSource,
): Promise<ScopedSubject> {
  if (source.kind === "order") {
    const row = (await runner.execute<{
      party_id: string | null; subsidiary_id: string | null; currency: string | null;
      document_number: string; document_date: string;
    }>(sql`
      select party_id, subsidiary_id, currency, document_number, document_date::text as document_date
        from documents where id = ${source.id} and org_id = ${orgId} and kind = 'sales_order'`)).rows[0];
    if (!row || !row.party_id) {
      throw new RevenueRecognitionError(
        `Sales order ${source.number} names no customer; assign the order's customer before billing it to a contract`,
      );
    }
    return {
      scope: "order",
      customerId: row.party_id,
      subsidiaryId: row.subsidiary_id,
      currency: row.currency,
      contractNumber: row.document_number,
      startsOn: row.document_date,
      idempotencyKey: revenueScopedContractPostingEffectKey("order", source.id),
    };
  }
  const row = (await runner.execute<{
    customer_id: string; start_on: string; currency: string | null;
  }>(sql`
    select s.customer_id, s.start_on::text as start_on, p.currency
      from subscriptions s
      left join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
     where s.id = ${source.id} and s.org_id = ${orgId}`)).rows[0];
  if (!row) {
    throw new RevenueRecognitionError(
      "The billed subscription no longer exists; rebill from the live subscription",
    );
  }
  return {
    scope: "subscription",
    customerId: row.customer_id,
    subsidiaryId: null,
    currency: row.currency,
    contractNumber: source.number,
    startsOn: row.start_on,
    idempotencyKey: revenueScopedContractPostingEffectKey("subscription", source.id),
  };
}

/**
 * Find the scoped contract for one billing source, creating it on first use.
 * The idempotency-key upsert is the concurrency authority: twin billings
 * converge on one contract row. A contract created for a different customer
 * or currency refuses by name — consideration in two currencies is two
 * contracts, never one blended total.
 */
export async function ensureScopedContract(
  runner: SqlExecutor,
  orgId: string,
  source: BillingSource,
  documentPartyId: string,
  documentCurrency: string | null,
  actorId: string | null,
  forBooking = false,
): Promise<{ id: string; created: boolean }> {
  const subject = await scopedSubject(runner, orgId, source);
  if (subject.customerId !== documentPartyId) {
    throw new RevenueRecognitionError(
      "This invoice names a different customer than the billed agreement; correct the invoice party to the agreement's customer or bill it on a separate invoice",
    );
  }
  if (subject.currency && documentCurrency && subject.currency !== documentCurrency) {
    throw new RevenueRecognitionError(
      `This agreement bills in ${subject.currency}; bill in ${subject.currency} or open a separate contract for the other currency`,
    );
  }
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into revenue_contracts
      (org_id, subsidiary_id, customer_id, contract_number, idempotency_key, status, starts_on,
       currency, total_transaction_price, total_consideration, scope,
       source_document_id, subscription_id, created_by, updated_by)
    values (${orgId}, ${subject.subsidiaryId}, ${subject.customerId}, ${subject.contractNumber},
            ${subject.idempotencyKey}, ${forBooking ? "draft" : "active"}, ${subject.startsOn},
            ${subject.currency}, '0', '0', ${subject.scope},
            ${source.kind === "order" ? source.id : null},
            ${source.kind === "subscription" ? source.id : null},
            ${actorId}, ${actorId})
    on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
    returning id`)).rows[0];
  if (inserted) return { id: inserted.id, created: true };
  const existing = (await runner.execute<{
    id: string; customer_id: string; currency: string | null; scope: string;
    source_document_id: string | null; subscription_id: string | null;
  }>(sql`
    select id, customer_id, currency, scope, source_document_id, subscription_id
      from revenue_contracts
     where org_id = ${orgId} and idempotency_key = ${subject.idempotencyKey}`)).rows[0];
  if (!existing) throw new Error("revenue contract idempotency winner was not visible");
  if (existing.scope !== subject.scope) {
    throw new RevenueRecognitionError(
      "This agreement already has a contract of a different scope; reconcile the contract before retrying",
    );
  }
  if (existing.customer_id !== documentPartyId) {
    throw new RevenueRecognitionError(
      "This invoice names a different customer than the billed agreement; correct the invoice party to the agreement's customer or bill it on a separate invoice",
    );
  }
  const existingCurrency = existing.currency ?? "";
  if ((documentCurrency ?? "") !== "" && existingCurrency !== "" && existingCurrency !== documentCurrency) {
    throw new RevenueRecognitionError(
      `This contract bills in ${existingCurrency}; bill in ${existingCurrency} or open a separate contract for the other currency`,
    );
  }
  return { id: existing.id, created: false };
}

/**
 * Create the order's contract shell when the org books contracts at booking.
 * A no-op unless scoped contracts are enabled and the org chose booking:
 * issue must never write revenue state for orgs on first-billing creation.
 */
export async function ensureBookingContract(
  orgId: string,
  salesOrderId: string,
  actorId: string | null,
): Promise<string | null> {
  if (!(await revenueContractsEnabled(db, orgId))) return null;
  if ((await contractCreationMode(db, orgId)) !== "booking") return null;
  const order = (await db.execute<{ document_number: string; party_id: string | null }>(sql`
    select document_number, party_id from documents
     where id = ${salesOrderId} and org_id = ${orgId} and kind = 'sales_order'`)).rows[0];
  if (!order) throw new Error("sales order disappeared while its revenue contract was being booked");
  if (!order.party_id) {
    throw new RevenueRecognitionError(
      `Sales order ${order.document_number} names no customer; assign the order's customer before issuing it to a contract`,
    );
  }
  return (await ensureScopedContract(
    db, orgId,
    { kind: "order", id: salesOrderId, number: order.document_number },
    order.party_id, null, actorId, true,
  )).id;
}

/**
 * Record one posted billing against its contract and accumulate billed
 * consideration. Replaying a posted billing reconciles to its existing row
 * instead of recording twice: the document side is unique, so a second
 * attempt for the same document finds its row and changes nothing.
 */
export async function recordContractBilling(
  runner: SqlExecutor,
  orgId: string,
  contractId: string,
  documentId: string,
  amount: string,
  billedOn: string,
  actorId: string | null,
): Promise<{ billed: boolean }> {
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into revenue_contract_billings
      (org_id, contract_id, document_id, amount, billed_on, created_by, updated_by)
    values (${orgId}, ${contractId}, ${documentId}, ${amount}, ${billedOn}, ${actorId}, ${actorId})
    on conflict (org_id, document_id) do nothing
    returning id`)).rows[0];
  // The conflict above is expected and benign: a posted billing replays to
  // the row its first attempt wrote, and consideration must not grow twice.
  if (!inserted) {
    const prior = (await runner.execute<{ amount: string; contract_id: string }>(sql`
      select amount, contract_id from revenue_contract_billings
       where org_id = ${orgId} and document_id = ${documentId}`)).rows[0];
    if (!prior || prior.contract_id !== contractId || cmp(prior.amount, amount) !== 0) {
      throw new RevenueRecognitionError(
        "This billing was already recorded against a different contract or amount; reconcile the contract before retrying",
      );
    }
    return { billed: false };
  }
  const updated = (await runner.execute<{ id: string }>(sql`
    update revenue_contracts
       set total_consideration = total_consideration + ${amount},
           total_transaction_price = total_transaction_price + ${amount},
           modification_seq = modification_seq + 1,
           status = 'active',
           updated_by = ${actorId}, updated_at = now()
     where id = ${contractId} and org_id = ${orgId}
    returning id`)).rows;
  // Under row-level security an unscoped write silently matches nothing, so
  // a zero-row accumulation is raised, never reported as billed.
  if (updated.length !== 1) throw new Error("revenue contract consideration was not accumulated");
  return { billed: true };
}

export interface ContractPosition {
  /** Billed consideration to date (billings ledger, else accumulated consideration). */
  billed: string;
  /** Revenue recognized to date on the primary posting book. */
  recognized: string;
  /** Revenue still planned on the primary posting book. */
  remaining: string;
  /** billed − recognized: positive is a contract liability, negative a contract asset. */
  net: string;
  side: "liability" | "asset" | "settled";
}

/**
 * The contract's net position at period end on its primary posting book:
 * one signed figure per contract, never a per-obligation scatter. Recognized
 * in excess of billings is a contract asset (unbilled receivable); billings
 * in excess of recognized is a contract liability (deferred revenue).
 */
export async function contractPosition(
  runner: SqlExecutor,
  orgId: string,
  contractId: string,
): Promise<ContractPosition> {
  const billedRes = (await runner.execute<{ billed: string; consideration: string }>(sql`
    select coalesce((select sum(amount) from revenue_contract_billings
                      where org_id = ${orgId} and contract_id = ${contractId}), 0)::text as billed,
           coalesce((select total_consideration from revenue_contracts
                      where id = ${contractId} and org_id = ${orgId}), 0)::text as consideration`)).rows[0];
  const billed = cmp(billedRes?.billed ?? "0", "0") !== 0
    ? billedRes!.billed
    : (billedRes?.consideration ?? "0");
  const scheduleRes = (await runner.execute<{ recognized: string; planned: string }>(sql`
    select coalesce(sum(l.recognized_amount) filter (
             where l.journal_entry_id is not null and l.reversal_journal_entry_id is null), 0)::text as recognized,
           coalesce(sum(case
             when l.superseded_by_change_id is not null or l.reversal_journal_entry_id is not null then 0
             when l.journal_entry_id is not null then coalesce(l.recognized_amount, 0)
             else l.planned_amount end), 0)::text as planned
      from performance_obligations o
      join recognition_schedules s on s.obligation_id = o.id and s.org_id = o.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_primary
      join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
     where o.contract_id = ${contractId} and o.org_id = ${orgId}`)).rows[0];
  const recognized = scheduleRes?.recognized ?? "0";
  const planned = scheduleRes?.planned ?? "0";
  const netPosition = add(billed, neg(recognized));
  return {
    billed,
    recognized,
    remaining: add(planned, neg(recognized)),
    net: netPosition,
    side: cmp(netPosition, "0") > 0 ? "liability" : cmp(netPosition, "0") < 0 ? "asset" : "settled",
  };
}
