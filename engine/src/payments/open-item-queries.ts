import { sql } from "drizzle-orm";
import { db, orgContext } from "../platform/db.ts";
import { cmp, sum, toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { type OpenItemSide, type OpenItem } from "./payment-contracts.ts";
import { paymentBookId } from "./payment-accounts.ts";

/** Restrict a payment read to the caller's subsidiary scope (null = every subsidiary). */
export function paymentSubsidiaryScope(
  column: ReturnType<typeof sql>,
  allowed?: ReadonlySet<string> | null,
) {
  if (allowed == null) return sql``;
  if (allowed.size === 0) return sql` and false`;
  return sql` and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])`;
}

type OpenItemRow = {
  line_id: string;
  amount: string;
  due_date: string | null;
  memo: string | null;
  entry_id: string;
  entry_number: string;
  posting_date: string;
  document_id: string | null;
  document_number: string | null;
  document_kind: string | null;
  reference_number: string | null;
  applied: string;
  currency: string;
  fx_rate: string;
  transaction_amount: string;
  transaction_applied: string;
  reserved_run_id: string | null;
  reserved_run_number: string | null;
  reserved_run_status: string | null;
  account_id: string;
  account_number: string | null;
  account_name: string;
  party_id: string;
  party_name: string | null;
  subsidiary_id: string | null;
};

/**
 * The one definition of a settleable open item: an is_open_item line on a
 * live posted entry in the payment book, on the side's sign, with its live
 * applications and any foreign payment-run reservation. `filter` narrows the
 * set (party, currency, scope); `limit` bounds cross-party discovery.
 */
async function selectOpenItemRows(
  tenantId: string,
  side: OpenItemSide,
  filter: ReturnType<typeof sql>,
  opts: {
    paymentDocumentId?: string | null;
    limit?: number;
    priority?: ReturnType<typeof sql>;
  } = {},
): Promise<OpenItemRow[]> {
  const bookId = await paymentBookId(tenantId);
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const orgFilter = sql`jl.org_id = ${tenantId} and je.book_id = ${bookId} and`;
  return await db.execute<OpenItemRow>(
    sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.account_id, acct.number as account_number, acct.name as account_name,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           jl.party_id, party.display_name as party_name, jl.subsidiary_id,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied,
           reservation.run_id as reserved_run_id, reservation.run_number as reserved_run_number,
           reservation.run_status as reserved_run_status
      from journal_lines jl
      -- Live entries only: a reversed entry no longer carries a settleable open item.
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      join accounts acct on acct.id = jl.account_id and acct.org_id = jl.org_id
      left join parties party on party.id = jl.party_id and party.org_id = jl.org_id
      left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
      left join lateral (
        select sum(a.amount) as applied, sum(a.target_transaction_amount) as transaction_applied
          from applications a
         where a.to_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
      -- A live run's reservation (other than the viewed payment's own run):
      -- the item stays listed so the operator sees why it is not payable here.
      left join lateral (
        select run.id as run_id, run.run_number, run.status as run_status
          from payment_run_items item
          join payment_runs run on run.id = item.payment_run_id and run.org_id = item.org_id
          left join payment_instructions instruction
            on instruction.id = item.payment_instruction_id and instruction.org_id = item.org_id
         where item.org_id = jl.org_id and item.source_open_line_id = jl.id and item.status = 'selected'
           and (${opts.paymentDocumentId ?? null}::uuid is null
                or instruction.payment_document_id is distinct from ${opts.paymentDocumentId ?? null}::uuid)
         limit 1
      ) reservation on true
     where ${orgFilter} jl.is_open_item and ${signFilter} and ${filter}
     order by ${opts.priority ? sql`${opts.priority}, ` : sql``}jl.due_date nulls last, je.posting_date, je.entry_number, jl.id
     ${opts.limit !== undefined ? sql`limit ${opts.limit}` : sql``}
  `,
    "objects",
  );
}

function openItemFromRow(row: OpenItemRow): OpenItem {
  return {
    lineId: row.line_id,
    entryId: row.entry_id,
    entryNumber: row.entry_number,
    postingDate: row.posting_date,
    dueDate: row.due_date,
    documentId: row.document_id,
    documentNumber: row.document_number,
    documentKind: row.document_kind,
    referenceNumber: row.reference_number,
    memo: row.memo,
    accountId: row.account_id,
    accountNumber: row.account_number,
    accountName: row.account_name,
    amount: row.amount,
    applied: row.applied,
    open: sum([row.amount, negStr(String(row.applied))]),
    currency: row.currency,
    fxRate: row.fx_rate,
    transactionAmount: row.transaction_amount,
    transactionApplied: row.transaction_applied,
    transactionOpen: sum([row.transaction_amount, negStr(String(row.transaction_applied))]),
    reservedByRun: row.reserved_run_id
      ? {
          runId: row.reserved_run_id,
          runNumber: row.reserved_run_number ?? "",
          runStatus: row.reserved_run_status ?? "",
        }
      : null,
  };
}

/**
 * Open AP (credit) or AR (debit) journal lines for a party: is_open_item
 * lines on posted entries, with applied-to-date sums and remaining balance.
 */
export async function openItemsForParty(
  partyId: string,
  side: OpenItemSide,
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
  opts: { paymentDocumentId?: string | null } = {},
): Promise<OpenItem[]> {
  const tenantId = orgId ?? orgContext.getStore()?.orgId;
  if (!tenantId) throw new PaymentError("organization is required to select payment open items");
  const rows = await selectOpenItemRows(
    tenantId,
    side,
    sql`jl.party_id = ${partyId} ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, allowedSubsidiaryIds)}`,
    opts,
  );
  return rows.map(openItemFromRow).filter((i) => cmp(i.open, "0") > 0);
}

/** An open item found by amount across parties, with the party and entity it settles under. */
export interface SettlementOpenItem extends OpenItem {
  partyId: string;
  partyName: string | null;
  subsidiaryId: string | null;
}

/**
 * Open items of any party that a receipt or payment of `targetTransactionAmount`
 * may settle, for matching a bank line to the documents it pays: the line's
 * transaction currency (and, when asked, every other currency a settlement
 * rate can convert to, listed last), inside the caller's scope and (when given) one legal
 * entity, with a remaining transaction balance above zero. Items reserved by
 * a payment run are excluded — that run pays them. Bounded by `limit`: items
 * whose balance equals the amount first, then those at or below it (which
 * combine into an exact or overpaying settlement), then larger balances the
 * line can pay in part; earliest due first within each.
 */
export async function openItemsForSettlement(opts: {
  orgId: string;
  side: OpenItemSide;
  currency: string;
  targetTransactionAmount: string;
  /** Also list items in other transaction currencies, after every item in `currency`. */
  includeOtherCurrencies?: boolean;
  subsidiaryId: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  limit: number;
}): Promise<SettlementOpenItem[]> {
  const rows = await selectOpenItemRows(
    opts.orgId,
    opts.side,
    sql`jl.party_id is not null ${opts.includeOtherCurrencies ? sql`` : sql`and jl.currency = ${opts.currency}`}
      and abs(jl.txn_amount) - coalesce(ap.transaction_applied, 0) > 0
      and reservation.run_id is null
      ${opts.subsidiaryId ? sql`and jl.subsidiary_id = ${opts.subsidiaryId}` : sql``}
      ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, opts.allowedSubsidiaryIds)}`,
    {
      limit: opts.limit,
      priority: sql`case
        when jl.currency <> ${opts.currency} then 3
        when abs(jl.txn_amount) - coalesce(ap.transaction_applied, 0) = ${opts.targetTransactionAmount}::numeric then 0
        when abs(jl.txn_amount) - coalesce(ap.transaction_applied, 0) < ${opts.targetTransactionAmount}::numeric then 1
        else 2 end`,
    },
  );
  return rows
    .map((row) => ({
      ...openItemFromRow(row),
      partyId: row.party_id,
      partyName: row.party_name,
      subsidiaryId: row.subsidiary_id,
    }))
    .filter((item) => cmp(item.open, "0") > 0);
}

/** One tenant-owned spot observation usable as settlement-rate evidence. */
export interface SettlementRateObservation extends Record<string, unknown> {
  id: string;
  toCurrency: string;
  /** Target-currency units per one unit of `from`. */
  rate: string;
  asOf: string;
  source: string;
}

/**
 * The organization's spot observations from one currency into others, dated
 * on or before the settlement date, newest first, at most `perCurrency` per
 * target: the evidence a cross-currency application cites as `provider`.
 */
export async function settlementRateObservations(
  orgId: string,
  from: string,
  targets: readonly string[],
  onDate: string,
  perCurrency = 10,
): Promise<SettlementRateObservation[]> {
  if (targets.length === 0) return [];
  return await db.execute<SettlementRateObservation>(
    sql`
    select id, to_currency as "toCurrency", rate::text, as_of::text as "asOf", source
      from (
        select r.*,
               row_number() over (partition by r.to_currency order by r.as_of desc, r.imported_at desc nulls last, r.created_at desc) as ordinal
          from fx_rates r
         where r.org_id = ${orgId}
           and r.from_currency = ${from}
           and r.to_currency in ${[...targets]}
           and r.rate_type = 'spot'
           and r.as_of <= ${onDate}::date
      ) ranked
     where ordinal <= ${perCurrency}
     order by "toCurrency", "asOf" desc
  `,
    "objects",
  );
}

function negStr(a: string): string {
  return toUnits(a) === 0n ? "0" : a.startsWith("-") ? a.slice(1) : `-${a}`;
}

/**
 * Posted, still-open credit-memo lines available as application sources for a
 * party: the mirror of openItemsForParty, which lists only debit items a
 * payment can extinguish. Credits carry the opposite sign (AR: amount < 0,
 * AP: amount > 0) and are consumed from the from_line side of applications.
 * Only lines with remaining open balance are returned. With
 * `includeUnappliedPayments`, a receipt's unapplied credit and a vendor
 * payment's prepayment are listed too: the cash those payments moved beyond
 * what they applied, which the standalone application path settles.
 */
export async function creditItemsForParty(
  partyId: string,
  side: OpenItemSide = "ar",
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
  options: { includeUnappliedPayments?: boolean } = {},
): Promise<OpenItem[]> {
  const tenantId = orgId ?? orgContext.getStore()?.orgId;
  if (!tenantId) throw new PaymentError("organization is required to select credit open items");
  const bookId = await paymentBookId(tenantId);
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const sourceKinds = options.includeUnappliedPayments
    ? [creditKind, side === "ap" ? "vendor_payment" : "customer_payment"]
    : [creditKind];
  const signFilter = side === "ap" ? sql`jl.amount > 0` : sql`jl.amount < 0`;
  const r = await db.execute<{
    line_id: string;
    amount: string;
    due_date: string | null;
    memo: string | null;
    entry_id: string;
    entry_number: string;
    posting_date: string;
    document_id: string | null;
    document_number: string | null;
    document_kind: string | null;
    reference_number: string | null;
    applied: string;
    currency: string;
    fx_rate: string;
    transaction_amount: string;
    transaction_applied: string;
    reserved_run_id: string | null;
    reserved_run_number: string | null;
    reserved_run_status: string | null;
    account_id: string;
    account_number: string | null;
    account_name: string;
  }>(
    sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.account_id, acct.number as account_number, acct.name as account_name,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied,
           reservation.run_id as reserved_run_id, reservation.run_number as reserved_run_number,
           reservation.run_status as reserved_run_status
      from journal_lines jl
      -- Live entries only: a voided credit is never offered for application.
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      join documents d on d.id = je.source_document_id and d.org_id = je.org_id and d.kind in ${sourceKinds}
      join accounts acct on acct.id = jl.account_id and acct.org_id = jl.org_id
      left join lateral (
        select sum(a.source_amount) as applied, sum(a.source_transaction_amount) as transaction_applied
          from applications a
         where a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
      -- A credit a live payment run has reserved is that run's to apply.
      left join lateral (
        select run.id as run_id, run.run_number, run.status as run_status
          from payment_run_items item
          join payment_runs run on run.id = item.payment_run_id and run.org_id = item.org_id
         where item.org_id = jl.org_id and item.source_open_line_id = jl.id and item.status = 'selected'
         limit 1
      ) reservation on true
     where jl.org_id = ${tenantId} and je.book_id = ${bookId} and jl.party_id = ${partyId}
       and jl.is_open_item and ${signFilter}
       ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, allowedSubsidiaryIds)}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `,
    "objects",
  );
  return r
    .map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      referenceNumber: row.reference_number,
      memo: row.memo,
      accountId: row.account_id,
      accountNumber: row.account_number,
      accountName: row.account_name,
      amount: row.amount,
      applied: row.applied,
      open: sum([row.amount, negStr(String(row.applied))]),
      currency: row.currency,
      fxRate: row.fx_rate,
      transactionAmount: row.transaction_amount,
      transactionApplied: row.transaction_applied,
      transactionOpen: sum([row.transaction_amount, negStr(String(row.transaction_applied))]),
      reservedByRun: row.reserved_run_id
        ? {
            runId: row.reserved_run_id,
            runNumber: row.reserved_run_number ?? "",
            runStatus: row.reserved_run_status ?? "",
          }
        : null,
    }))
    .filter((i) => cmp(i.open, "0") > 0);
}
